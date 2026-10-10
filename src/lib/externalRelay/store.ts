import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import type { ExternalRelayOwner, ExternalRelayTarget } from "./protocol";

export type RelayTargetSettings = {
  id: string;
  name: string;
  answered_by: "install" | "service";
  fallback: "service" | "none";
  enabled: boolean;
  engine: "claude" | "codex" | null;
  model: string | null;
  effort: string | null;
  project: string | null;
  concurrency: number;
  hardCapMinutes: number;
  /** Answers per member per hour in each chat (§B.8); absent is the default, null or 0 no limit. */
  memberLimitPerHour?: number | null;
  /** Absent is off; only the operator can enable full owner agent runs. */
  ownerTier?: boolean;
};
export type PairedRelay = {
  id: string;
  origin: string;
  api_base: string;
  name: string;
  description: string;
  credential: string;
  owner: ExternalRelayOwner;
  pairedAt: string;
  paused: boolean;
  limits: {
    max_response_bytes: number;
    max_wait_s: number;
    max_answer_chars: number;
  };
  targets: RelayTargetSettings[];
};
export type PendingRelay = {
  id: string;
  origin: string;
  api_base: string;
  name: string;
  description: string;
  limits: PairedRelay["limits"];
  pairing_id: string;
  poll_secret: string;
  code: string;
  verify_url: string | null;
  expires_at: string;
  poll_interval_s: number;
  owner?: ExternalRelayOwner;
  targets?: ExternalRelayTarget[];
};
export type RelayStore = {
  v: 1;
  installId: string;
  label: string;
  relays: PairedRelay[];
  pending: PendingRelay[];
};
export type RunRecord = {
  /** Present only on a full owner run, bound by the Viewer to its spawn receipt. */
  conversationId?: string;
  /** Durable custody survives a lost lease, cutoff, or Viewer restart. */
  ownerTurn?: { clientAttemptId: string; admissionComplete?: boolean; cancel?: "interrupt" | "kill"; confirmed?: boolean };
  requestId: string;
  leaseId: string;
  relayId: string;
  targetId: string;
  childPid: number | null;
  childIdentity: string | null;
  ownerPid: number;
  ownerIdentity: string | null;
  runDir: string;
  startedAt: string;
};
export type RunLedger = { v: 1; runs: RunRecord[] };
export const externalRelayFile = (name: "relays" | "runs") =>
  statePath(`external-relay/${name}.json`);
function read<T>(file: string, fallback: () => T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw error;
  }
}
export function writeRelayFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
// A pending pairing past its expiry can no longer be confirmed, so it and its
// poll secret leave the store on the next read or write, whether or not a
// check ever reached the service after it ran out.
const expired = (pending: PendingRelay, now: number) =>
  Date.parse(pending.expires_at) <= now;
function withoutExpired(store: RelayStore): RelayStore {
  const now = Date.now();
  return store.pending.some((item) => expired(item, now))
    ? { ...store, pending: store.pending.filter((item) => !expired(item, now)) }
    : store;
}
export function readRelayStore(): RelayStore {
  const store = readStoredRelays();
  return store.pending.some((item) => expired(item, Date.now()))
    ? updateRelayStore((current) => current)
    : store;
}
function readStoredRelays(): RelayStore {
  const file = externalRelayFile("relays");
  const existed = fs.existsSync(file);
  const store = read(file, () => ({
    v: 1 as const,
    installId: randomUUID(),
    label: "Delegatus",
    relays: [],
    pending: [],
  }));
  if (
    store.v !== 1 ||
    !Array.isArray(store.relays) ||
    !Array.isArray(store.pending)
  )
    throw new Error("invalid relay store");
  if (!existed) writeRelayFile(file, store);
  return store;
}
export function updateRelayStore(
  change: (store: RelayStore) => RelayStore,
): RelayStore {
  const file = externalRelayFile("relays");
  return withFileLock(file, () => {
    const next = withoutExpired(change(withoutExpired(readStoredRelays())));
    writeRelayFile(file, next);
    return next;
  });
}
export function readRunLedger(): RunLedger {
  const ledger = read(externalRelayFile("runs"), () => ({
    v: 1 as const,
    runs: [],
  }));
  if (ledger.v !== 1 || !Array.isArray(ledger.runs))
    throw new Error("invalid run ledger");
  return ledger;
}
export function updateRunLedger(
  change: (ledger: RunLedger) => RunLedger,
): RunLedger {
  const file = externalRelayFile("runs");
  return withFileLock(file, () => {
    const next = change(readRunLedger());
    writeRelayFile(file, next);
    return next;
  });
}
export function withFileLock<T>(file: string, action: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  const deadline = Date.now() + 5_000;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = fs.statSync(lock, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > 1_000) {
        try {
          const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as {
            pid?: number;
            identity?: string;
          };
          if (
            !owner.pid ||
            !owner.identity ||
            procBackend.processIdentity(owner.pid) !== owner.identity
          )
            fs.rmSync(lock, { force: true });
        } catch {
          fs.rmSync(lock, { force: true });
        }
      }
      if (Date.now() >= deadline) throw new Error("relay store is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    fs.writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        identity: procBackend.processIdentity(process.pid),
      }),
    );
    return action();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}
export function reserveRun(
  record: RunRecord,
  maxConcurrent?: number,
): "added" | "duplicate" | "full" {
  let outcome: "added" | "duplicate" | "full" = "full";
  updateRunLedger((ledger) => {
    if (ledger.runs.some((run) => run.requestId === record.requestId)) {
      outcome = "duplicate";
      return ledger;
    }
    if (
      maxConcurrent !== undefined &&
      ledger.runs.filter(
        (run) =>
          run.relayId === record.relayId && run.targetId === record.targetId,
      ).length >= maxConcurrent
    )
      return ledger;
    outcome = "added";
    return { ...ledger, runs: [...ledger.runs, record] };
  });
  return outcome;
}
export function changeRun(
  requestId: string,
  change: (record: RunRecord) => RunRecord,
): void {
  updateRunLedger((ledger) => ({
    ...ledger,
    runs: ledger.runs.map((run) =>
      run.requestId === requestId ? change(run) : run,
    ),
  }));
}
export function dropRun(requestId: string): void {
  updateRunLedger((ledger) => ({
    ...ledger,
    runs: ledger.runs.filter((run) => run.requestId !== requestId),
  }));
}
/** A target this install has not configured: no engine, so it is not
 * answered until the operator picks one (§B.9). */
export function newTargetSettings(
  target: ExternalRelayTarget,
): RelayTargetSettings {
  return {
    id: target.target_id,
    name: target.name,
    answered_by: target.answered_by,
    fallback: target.fallback,
    enabled: true,
    engine: null,
    model: null,
    effort: null,
    project: null,
    concurrency: 1,
    hardCapMinutes: 30,
  };
}
/**
 * The service's list, in its order, over the stored settings: a target it
 * still lists keeps the operator's settings and takes the service's name,
 * `answered_by` and `fallback`; a new one arrives unconfigured; one it no
 * longer lists is dropped.
 */
export function mergeRelayTargets(
  stored: RelayTargetSettings[],
  remote: ExternalRelayTarget[],
): RelayTargetSettings[] {
  const byId = new Map(stored.map((target) => [target.id, target]));
  return remote.map((target) => {
    const kept = byId.get(target.target_id);
    return kept
      ? {
          ...kept,
          name: target.name,
          answered_by: target.answered_by,
          fallback: target.fallback,
        }
      : newTargetSettings(target);
  });
}
export function publicRelay(
  relay: PairedRelay,
): Omit<PairedRelay, "credential"> {
  const { credential: _credential, ...publicRecord } = relay;
  return publicRecord;
}
export function publicPending(
  pending: PendingRelay,
): Omit<PendingRelay, "poll_secret"> {
  const { poll_secret: _secret, ...publicRecord } = pending;
  return publicRecord;
}
