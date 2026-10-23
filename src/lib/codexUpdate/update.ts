import fs from "node:fs";
import path from "node:path";
import { FileTransactionBusyError, withFileTransaction } from "@/lib/state/fileTransaction";
import { installedTarget, prepareSwitch, switchCli, updateDirectory, withCliSwitch } from "./installation";
import { writeJsonDurably } from "@/lib/state/durableJson";

export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export interface UpdateNotice { id: string; at: number; version: string; line: string; failed: boolean }
interface Candidate { version: string; target: string; from: string; fromVersion: string; compatibilityKey?: string; rollback?: true }
export interface UpdateState {
  nextCheck: number;
  pending: Candidate | null;
  previous: Candidate | null;
  notice: UpdateNotice | null;
  rejectedVersion: string | null;
}
export interface UpdatePorts {
  now(): number;
  latest(): Promise<string>;
  version(binary: string): Promise<string>;
  install(version: string, directory: string): Promise<string>;
  probe(version: string, binary: string): Promise<void>;
  idle(): Promise<boolean>;
  current(): boolean;
  compatibilityKey(): string;
  report(notice: UpdateNotice): Promise<void>;
  prune?(keep: string[]): Promise<void>;
}
export class CodexUpdateProbeFailure extends Error {
  constructor(readonly check: "app-server schema" | "native queue fixture", cause?: unknown) { super(check, { cause }); }
}
export class CodexUpdateReportPending extends Error {
  constructor(cause: unknown) { super("Codex update seat report pending recovery", { cause }); }
}

function readState(file: string): UpdateState {
  try {
    const row = JSON.parse(fs.readFileSync(file, "utf8")) as UpdateState;
    if (!Number.isFinite(row.nextCheck) || row.rejectedVersion !== null && typeof row.rejectedVersion !== "string"
      || ![row.pending, row.previous].every(candidate => candidate === null || typeof candidate?.version === "string"
        && typeof candidate.fromVersion === "string" && path.isAbsolute(candidate.target) && path.isAbsolute(candidate.from))
      || row.notice !== null && (typeof row.notice?.id !== "string" || typeof row.notice.line !== "string")) throw new Error("invalid updater state");
    return row;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { nextCheck: 0, pending: null, previous: null, notice: null, rejectedVersion: null };
  }
}
function save(file: string, state: UpdateState): void {
  writeJsonDurably(file, state, { space: 0 });
}
export function newer(candidate: string, installed: string): boolean {
  if (![candidate, installed].every(value => /^\d+\.\d+\.\d+$/.test(value))) throw new Error("invalid CLI version");
  const a = candidate.split(".").map(Number), b = installed.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Durable daily budget, candidate and report outbox survive process replacement.
 * Preparation never holds the launch lock. Only idle observation and rename do. */
export async function updateCodex(binary: string, ports: UpdatePorts, rollback = false): Promise<void> {
  const directory = updateDirectory(binary);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  await withFileTransaction(path.join(directory, "job"), "Codex update already running", async () => {
    const file = path.join(directory, "state.json"), state = readState(file);
    const publish = async () => {
      if (!state.notice) return;
      try { await ports.report(state.notice); }
      catch (error) { throw new CodexUpdateReportPending(error); }
      state.notice = null; save(file, state);
    };
    const notice = (version: string, line: string, failed: boolean) => {
      state.notice = { id: `${ports.now()}:${version}:${line}`, at: ports.now(), version, line: `Codex CLI ${version}: ${line}`, failed };
      save(file, state);
    };
    await publish();
    if (!ports.current()) return;
    if (!rollback && !state.pending && ports.now() < state.nextCheck) return;
    let version = state.pending?.version ?? "unknown", check = "installed location";
    let switched = false;
    const previous = state.previous;
    try {
      const from = installedTarget(binary);
      await ports.prune?.([from, state.pending?.target, state.previous?.target].filter((target): target is string => !!target));
      if (rollback) {
        if (!state.previous) throw new Error("no rollback version");
        if (from !== state.previous.from) throw new Error("installed CLI changed before rollback");
        if (await ports.version(state.previous.target) !== state.previous.version) throw new Error("rollback target changed");
        state.pending = { version: state.previous.version, target: state.previous.target, from, fromVersion: await ports.version(binary), rollback: true };
        version = state.pending.version;
        state.rejectedVersion = state.pending.fromVersion; save(file, state);
      } else if (!state.pending) {
        // Persist before the first network await; even a killed process spent this day's check.
        state.nextCheck = ports.now() + CHECK_INTERVAL_MS; save(file, state);
        check = "registry latest"; version = await ports.latest();
        check = "installed version";
        const installed = await ports.version(binary);
        if (!newer(version, installed) || version === state.rejectedVersion) return;
        check = "isolated install";
        const target = await ports.install(version, path.join(directory, "versions"));
        check = "candidate version";
        if (await ports.version(target) !== version) throw new Error("version mismatch");
        const compatibilityKey = ports.compatibilityKey();
        check = "compatibility probe"; await ports.probe(version, target);
        if (!ports.current()) return;
        state.pending = { version, target, from, fromVersion: installed, compatibilityKey }; save(file, state);
      }
      const candidate = state.pending!;
      if (!candidate.rollback && candidate.compatibilityKey !== ports.compatibilityKey()) {
        check = "compatibility probe";
        const compatibilityKey = ports.compatibilityKey();
        await ports.probe(candidate.version, candidate.target);
        if (!ports.current()) return;
        candidate.compatibilityKey = compatibilityKey; save(file, state);
      }
      check = "idle switch";
      await withCliSwitch(binary, async () => {
        // A crash after rename is reconciled from the executable itself.
        if (installedTarget(binary) !== candidate.target) {
          if (installedTarget(binary) !== candidate.from) throw new Error("installed CLI changed during update");
          // The persisted pending candidate already carries rollback custody.
          // Keep the prior rollback target while this candidate waits for idle.
          prepareSwitch(binary, candidate.target);
          if (!await ports.idle() || !ports.current()) return;
          // Nothing can yield between the final authority check and the rename.
          switchCli(binary, candidate.from, candidate.target);
        }
        switched = true;
        state.previous = { version: candidate.fromVersion, target: candidate.from, from: candidate.target, fromVersion: candidate.version };
        state.pending = null;
        notice(candidate.version, candidate.rollback ? "rolled back; rejected release held" : "updated", false);
      });
    } catch (error) {
      if (error instanceof FileTransactionBusyError && check === "idle switch") return;
      // A wrapper or a post-rename flush can throw after committing the link.
      // Keep its durable pending intent; never report that the old CLI stayed.
      if (state.pending) {
        try { switched ||= installedTarget(binary) === state.pending.target; }
        catch { throw new CodexUpdateReportPending(new Error("CLI switch outcome unreadable")); }
      }
      if (switched) throw new CodexUpdateReportPending(new Error("CLI switched; outcome persistence pending"));
      state.pending = null;
      state.previous = previous;
      state.nextCheck = ports.now() + CHECK_INTERVAL_MS;
      notice(version, `${error instanceof CodexUpdateProbeFailure ? error.check : check} failed; current CLI kept`, true);
    }
    await publish();
  });
}
