import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { GreenVerdict } from "./green";
import { publishLauncherRequest, type LauncherRecord, type LauncherRole } from "./launcher";
import type { QuietBlockers } from "./quiet";
import type { Revision } from "./types";
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
  deferred?: { at: string; until: string; reason: "launch-hold-expired" } | null;
  drain: { id: string; target: Revision; since: string; overranAt: string | null; blockers: QuietBlockers | null; admitted?: boolean; acknowledgedAt?: string; force?: boolean;
    holdSince?: string;
    /** Keep the no-start age across completion; version fences the last stable probe. */
    window?: { since: string; version: string; work: string[]; starts?: string[] } } | null;
  rollback: { target: string | null } | null;
  pending: AutoPending | null;
  /** Written before asking the runtime host; an accepted id fences request
      replay even if the separate receipt or the host's lookup index is lost. */
  managedPending: { target: Revision; clientKey: string; at: string; from?: string | null; deploymentId?: string } | null;
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
  /** `choice` is the operator's answer to an overrun, once given: what the
      surface says in place of the decision it no longer offers. */
  drain?: { state: "draining" | "overran"; at: string; choice?: "deploy-now" | "keep-waiting" } | null;
  decision?: { id: string; at: string; project: string; blockers: QuietBlockers | null } | null;
  changedAt?: string | null;
  changedBy?: AutoWriter | null;
  deferred?: AutoState["deferred"];
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
  publishLauncherRequest(record.requestFile, { requestId: pending.requestId, role, requestedAt: pending.at, autoGateId: gateId });
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
