/* The Snapshot the page renders, the reducers that move it, and the change
   signal the SSE hub listens to. */
import type { ChangelogDelta, DeltaSummary } from "./changelog";
import type { CheckOutcome } from "./git";

export interface Revision { version: string; sha: string; short: string; date: string }

export interface CommitLine { short: string; subject: string }
export interface UpdateDelta { commits: CommitLine[]; changelog: ChangelogDelta; summary: DeltaSummary }

export type CheckStateName = "idle" | "checking" | "up-to-date" | "update-available" | "failed";
export interface CheckState {
  state: CheckStateName;
  at: string | null;
  error: string | null;
  nextPollAt: string | null;
  /* "Ahead of origin/main by 2", "Diverged from origin/main" or null. */
  note: string | null;
  behind: number;
  delta: UpdateDelta | null;
}

export type StepName = "fetch" | "checkout" | "install" | "build" | "ready";
export type StepStateName = "pending" | "running" | "done" | "failed";
export interface Step {
  name: StepName;
  state: StepStateName;
  startedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  tail: string[];
}

export interface UpdateState {
  state: "idle" | "running" | "done" | "failed";
  target: string | null;
  targetShort: string | null;
  targetVersion: string | null;
  /* The release directory this update checks out, installs and builds in:
     never the directory a running process serves from. */
  releaseDir: string | null;
  steps: Step[];
  startedAt: string | null;
  finishedAt: string | null;
}

export type ProcessStateName = "stopped" | "stopping" | "starting" | "healthy" | "failed";
export interface ProcessStatus {
  state: ProcessStateName;
  pid: number | null;
  port: number | null;
  socket: string | null;
  startedAt: string | null;
  lastHealthAt: string | null;
  lastHealthOk: boolean | null;
  error: string | null;
  /* Short SHA of the release this process was started from. */
  revision: string | null;
}

/* A status plus the last lines the process wrote, for the "Last output" disclosure. */
export interface ProcessView extends ProcessStatus { tail: string[] }

export type Busy = "update" | "restart-web" | "restart-runtime-host" | null;

export interface Snapshot {
  /* The newest built release: what the next start or restart runs. */
  installed: Revision;
  /* What each live process actually serves (null when it is not running). */
  serving: { web: Revision | null; runtimeHost: Revision | null };
  available: Revision | null;
  check: CheckState;
  update: UpdateState;
  processes: { web: ProcessView; runtimeHost: ProcessView };
  busy: Busy;
  meta: { branch: string; remote: string; checkout: string; pollMinutes: number; webPort: number; serverTime: string };
}

export const STEP_NAMES: readonly StepName[] = ["fetch", "checkout", "install", "build", "ready"];

export function pendingSteps(): Step[] {
  return STEP_NAMES.map((name) => ({ name, state: "pending", startedAt: null, durationMs: null, exitCode: null, tail: [] }));
}

export function idleUpdate(): UpdateState {
  return { state: "idle", target: null, targetShort: null, targetVersion: null, releaseDir: null, steps: pendingSteps(), startedAt: null, finishedAt: null };
}

export function stoppedProcess(): ProcessStatus {
  return { state: "stopped", pid: null, port: null, socket: null, startedAt: null, lastHealthAt: null, lastHealthOk: null, error: null, revision: null };
}

export interface CheckSlice { installed: Revision | null; available: Revision | null; check: CheckState }

export function initialCheck(): CheckSlice {
  return {
    installed: null,
    available: null,
    check: { state: "idle", at: null, error: null, nextPollAt: null, note: null, behind: 0, delta: null },
  };
}

/* Folds one check outcome into the slice. A failed check is its own state and
   keeps what the previous successful check found, so an outage never reads as
   "up to date" and never hides an update that was already seen. */
export function applyCheck(previous: CheckSlice, outcome: CheckOutcome, now: Date, pollMinutes: number, branch = "main"): CheckSlice {
  const at = now.toISOString();
  const nextPollAt = new Date(now.getTime() + pollMinutes * 60_000).toISOString();
  if (!outcome.ok) {
    return {
      installed: outcome.installed ?? previous.installed,
      available: previous.available,
      check: { ...previous.check, state: "failed", at, error: outcome.error, nextPollAt },
    };
  }
  const note = outcome.relation === "ahead"
    ? `Ahead of origin/${branch} by ${outcome.ahead}`
    : outcome.relation === "diverged" ? `Diverged from origin/${branch}` : null;
  const available = outcome.relation === "behind" || outcome.relation === "diverged" ? outcome.available : null;
  return {
    installed: outcome.installed,
    available,
    check: {
      state: available ? "update-available" : "up-to-date",
      at,
      error: null,
      nextPollAt,
      note,
      behind: outcome.behind,
      delta: available ? outcome.delta : null,
    },
  };
}

/* A change signal. Listeners are the SSE hub; emitters are the runner, the
   processes and the check. */
export class Changes {
  private readonly listeners = new Set<() => void>();
  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(): void {
    for (const listener of this.listeners) listener();
  }
}
