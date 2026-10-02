import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { GreenVerdict } from "./green";
import type { LauncherRecord, LauncherRole } from "./launcher";
import type { QuietBlockers } from "./quiet";
import type { Revision } from "./types";
import { runGit } from "./git";
import { endRestartGate, restartGateFile } from "./restartGate";

export type AutoPhase = "idle" | "checks" | "not-green" | "building" | "waiting" | "deploying" | "restarting-web" | "restarting-host";
export interface AutoPending {
  role: LauncherRole;
  requestId: string;
  at: string;
  launcherPid: number;
  rollbackPointer: string | null;
  from: string | null;
  target: string;
}
/** Who switched automatic updates: the operator from the Update dialog or
    from their own agent session, or the designated orchestrator seat through
    the `auto_updates` MCP tool. `conversationId` names the session that
    called the tool, and is null for the dialog. */
export interface AutoWriter {
  kind: "operator" | "seat";
  conversationId: string | null;
  via: "dialog" | "mcp";
}
export const DIALOG_WRITER: AutoWriter = { kind: "operator", conversationId: null, via: "dialog" };
export interface AutoState {
  version: 1;
  enabled: boolean;
  changedAt: string | null;
  /** Who made the change at `changedAt`; null before the first recorded one. */
  changedBy: AutoWriter | null;
  off: { at: string; target: string; stage: "build" | "deploy" | "restart-web" | "restart-host"; reason: string } | null;
  green: Record<string, GreenVerdict>;
  waitingSince: string | null;
  waitingTarget: string | null;
  lastBlockers: QuietBlockers | null;
  quietSince: string | null;
  noticeAt: string | null;
  drain: { id: string; target: Revision; since: string; overranAt: string | null; blockers: QuietBlockers | null; admitted?: boolean; acknowledgedAt?: string; force?: boolean } | null;
  rollback: { target: string | null } | null;
  pending: AutoPending | null;
  /** Written before asking the runtime host; replay uses the same key after a web restart. */
  managedPending: { target: Revision; clientKey: string; at: string; from?: string | null } | null;
  rollbackPointer: string | null;
  rollbackCaptured: boolean;
}
export interface AutoView {
  availability: "available" | "no-release-target" | "packaged" | "launcher-upgrade" | "not-github" | "hand-managed" | "diverged";
  enabled: boolean;
  off: AutoState["off"];
  phase: AutoPhase;
  target: Revision | null;
  green: GreenVerdict | null;
  blockers: QuietBlockers | null;
  waitingSince: string | null;
  longWait: boolean;
  drain?: { state: "scheduled" | "draining" | "overran"; at: string; nextAt?: string } | null;
  decision?: { id: string; at: string; project: string; blockers: QuietBlockers | null } | null;
  changedAt?: string | null;
  changedBy?: AutoWriter | null;
}
export function initialAuto(): AutoState {
  return { version: 1, enabled: false, changedAt: null, changedBy: null, off: null, green: {}, waitingSince: null, waitingTarget: null, lastBlockers: null, quietSince: null, noticeAt: null, drain: null, pending: null, managedPending: null, rollbackPointer: null, rollbackCaptured: false, rollback: null };
}
export function readAuto(file: string): AutoState {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as AutoState;
    return value?.version === 1 && typeof value.enabled === "boolean" ? { ...initialAuto(), ...value } : initialAuto();
  } catch { return initialAuto(); }
}
export function writeAuto(file: string, value: AutoState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const { pending: _pending, rollbackPointer: _rollbackPointer, rollbackCaptured: _rollbackCaptured, ...setting } = value;
  try {
    writeFileSync(temporary, `${JSON.stringify(setting)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve the write failure */ }
    throw error;
  }
}
/** Persist the intent before the launcher sees the request. */
export function requestAutoRestart(record: LauncherRecord, role: LauncherRole, target: string, rollbackPointer: string | null, now: number, gateId: string, persist: (pending: AutoPending) => void): AutoPending {
  const pending: AutoPending = {
    role, requestId: randomUUID(), at: new Date(now).toISOString(), launcherPid: record.launcher.pid,
    rollbackPointer, from: role === "web" ? record.web.revision : record.runtimeHost.revision, target,
  };
  persist(pending);
  mkdirSync(dirname(record.requestFile), { recursive: true, mode: 0o700 });
  const temporary = `${record.requestFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ requestId: pending.requestId, role, requestedAt: pending.at, autoGateId: gateId })}\n`, { mode: 0o600 });
  renameSync(temporary, record.requestFile);
  return pending;
}
export function restorePointer(file: string, raw: string | null): void {
  if (raw === null) { rmSync(file, { force: true }); return; }
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, raw);
  renameSync(temporary, file);
}

export function cancelUntakenRequest(record: LauncherRecord, requestId: string): void {
  try {
    const request = JSON.parse(readFileSync(record.requestFile, "utf8")) as { requestId?: string; autoGateId?: string };
    if (request.requestId === requestId) {
      rmSync(record.requestFile, { force: true });
      if (request.autoGateId) endRestartGate(restartGateFile(record.requestFile), request.autoGateId);
    }
  } catch { /* the launcher already took it */ }
}

/** Imported only after the web process owns the release fence. */
export async function startSelfUpdateAuto(): Promise<void> {
  // A dynamic import avoids resolving the state directory while this module loads.
  const { selfUpdateService } = await import("./instance");
  selfUpdateService().startAuto();
}

/** Remove only registered release worktrees generated in this release root. */
export async function pruneReleaseWorktrees(record: LauncherRecord, rollbackPointer: string | null, run: typeof runGit = runGit): Promise<void> {
  if (!record.checkout) return;
  const listed = await run(["worktree", "list", "--porcelain"], record.checkout);
  if (listed.code !== 0) throw new Error("cannot list release worktrees");
  const root = resolve(record.releasesDir) + sep;
  const candidates = listed.stdout.split(/\n\n/).flatMap((block) => {
    const directory = /^worktree (.+)$/m.exec(block)?.[1];
    const sha = /^HEAD ([a-f0-9]{40})$/m.exec(block)?.[1];
    if (!directory || !sha || !resolve(directory).startsWith(root) || dirname(resolve(directory)) !== resolve(record.releasesDir)
      || !/^[a-f0-9]{12}$/.test(basename(directory))) return [];
    try { return [{ directory, sha, mtime: statSync(directory).mtimeMs }]; } catch { return []; }
  });
  let rollbackDir: string | null = null;
  try { rollbackDir = (JSON.parse(rollbackPointer ?? "null") as { dir?: string } | null)?.dir ?? null; } catch { /* checkout rollback */ }
  const current = [record.web.revision, record.runtimeHost.revision];
  let pointerDir: string | null = null;
  try { pointerDir = (JSON.parse(readFileSync(record.releasePointer, "utf8")) as { dir?: string }).dir ?? null; } catch { /* no pointer */ }
  const protectedDirs = new Set([pointerDir, rollbackDir].filter((part): part is string => !!part).map((part) => resolve(part)));
  const currentRelease = (candidate: { sha: string }) => current.some((revision) => revision && candidate.sha.startsWith(revision));
  const newestRemaining = candidates.filter((candidate) => !protectedDirs.has(resolve(candidate.directory)) && !currentRelease(candidate))
    .sort((a, b) => b.mtime - a.mtime)[0]?.directory;
  if (newestRemaining) protectedDirs.add(resolve(newestRemaining));
  for (const candidate of candidates) {
    if (protectedDirs.has(resolve(candidate.directory)) || currentRelease(candidate)) continue;
    const removed = await run(["worktree", "remove", "--force", candidate.directory], record.checkout);
    if (removed.code !== 0) throw new Error("cannot remove a release worktree");
  }
  const pruned = await run(["worktree", "prune"], record.checkout);
  if (pruned.code !== 0) throw new Error("cannot prune release worktree metadata");
}
