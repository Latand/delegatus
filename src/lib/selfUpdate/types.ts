/* The self-update Snapshot (#2007): what the Update surface renders, in both
   install modes. Shared by the server modules and the client surface, so this
   file imports nothing that only runs on one side. Every string the operator
   reads is composed on the client from these facts, in the operator's
   language; the only prose carried here is machine output (a git or build log
   line, an error a command printed). */

/** How this install updates itself, decided server-side (`mode.ts`).
    `managed`: the Docker install whose runtime host runs Viewer deployments.
    `checkout`: a git checkout started by `bin/cli.mjs`, which supervises the
    web process and the runtime host by recorded PID.
    `unsupported`: neither; the surface explains why and offers nothing it
    cannot carry out. */
export type InstallMode = "managed" | "checkout" | "unsupported";

export type UnsupportedReason =
  /** Deployments are off and no launcher record names this process. */
  | "no-launcher"
  /** No runtime host answered, so neither mode could be confirmed. */
  | "no-runtime-host"
  /** The launcher runs a packaged install, which its package manager updates. */
  | "not-a-checkout";

export interface Revision { version: string; sha: string; short: string; date: string }

export interface CommitLine { short: string; subject: string }

export interface DeltaGroup { type: string; items: string[]; more: number }

export interface DeltaSummary {
  commitCount: number;
  entryCount: number;
  /** Entries per changelog type, in first-seen order. */
  counts: { type: string; count: number }[];
  groups: DeltaGroup[];
}

export interface UpdateDelta { commits: CommitLine[]; summary: DeltaSummary }

export type Relation = "equal" | "behind" | "ahead" | "diverged";

export type CheckStateName = "idle" | "checking" | "up-to-date" | "update-available" | "failed";

export interface CheckState {
  state: CheckStateName;
  at: string | null;
  error: string | null;
  nextPollAt: string | null;
  relation: Relation | null;
  ahead: number;
  behind: number;
  delta: UpdateDelta | null;
}

/** Checkout mode builds in its own release directory; managed mode follows
    the phases the runtime host journals for one deployment. */
export type CheckoutStepName = "fetch" | "checkout" | "install" | "build" | "ready";
export type ManagedStepName = "admit" | "image" | "candidate" | "health" | "promote" | "handoff";
export type StepName = CheckoutStepName | ManagedStepName;

export const CHECKOUT_STEPS: readonly CheckoutStepName[] = ["fetch", "checkout", "install", "build", "ready"];
export const MANAGED_STEPS: readonly ManagedStepName[] = ["admit", "image", "candidate", "health", "promote", "handoff"];

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
  /** Checkout mode: the release directory this update builds in, never the
      directory a running process serves from. */
  releaseDir: string | null;
  /** Managed mode: the deployment this update is, and whether a failure was
      rolled back to the previous release. */
  deploymentId: string | null;
  rolledBack: boolean;
  steps: Step[];
  startedAt: string | null;
  finishedAt: string | null;
}

export type ProcessStateName = "stopped" | "stopping" | "starting" | "healthy" | "failed";

/** Why a process is not healthy, as facts the client words. */
export type ProcessError =
  | { kind: "exit"; code: number | null; signal: string | null; afterMs: number }
  | { kind: "timeout"; budgetMs: number }
  | { kind: "port-in-use"; port: number }
  | { kind: "gone"; pid: number }
  /** The new release did not start, so the launcher started the previous
      one again (checkout mode: the web process is the page itself). */
  | { kind: "fell-back"; revision: string | null; detail: string }
  | { kind: "message"; text: string };

export interface ProcessStatus {
  state: ProcessStateName;
  pid: number | null;
  port: number | null;
  socket: string | null;
  startedAt: string | null;
  lastHealthAt: string | null;
  lastHealthOk: boolean | null;
  error: ProcessError | null;
  /** Short SHA of the release this process was started from. */
  revision: string | null;
}

export interface ProcessView extends ProcessStatus { tail: string[] }

export type Busy = "update" | "restart-web" | "restart-runtime-host" | null;

export interface Snapshot {
  mode: InstallMode;
  unsupportedReason: UnsupportedReason | null;
  /** Checkout: the newest built release (what the next restart runs).
      Managed: the release the stable listener serves. */
  installed: Revision;
  /** What each live process actually serves (null when not running). */
  serving: { web: Revision | null; runtimeHost: Revision | null };
  available: Revision | null;
  check: CheckState;
  update: UpdateState;
  processes: { web: ProcessView; runtimeHost: ProcessView };
  busy: Busy;
  meta: {
    branch: string;
    remote: string;
    /** Checkout mode only: the checkout the releases are made from. */
    checkout: string | null;
    pollMinutes: number;
    serverTime: string;
  };
}

export const UNKNOWN_REVISION: Revision = { version: "", sha: "", short: "", date: "" };

export function pendingSteps(names: readonly StepName[]): Step[] {
  return names.map((name) => ({ name, state: "pending", startedAt: null, durationMs: null, exitCode: null, tail: [] }));
}

export function idleUpdate(names: readonly StepName[] = CHECKOUT_STEPS): UpdateState {
  return {
    state: "idle",
    target: null,
    targetShort: null,
    targetVersion: null,
    releaseDir: null,
    deploymentId: null,
    rolledBack: false,
    steps: pendingSteps(names),
    startedAt: null,
    finishedAt: null,
  };
}

export function stoppedProcess(): ProcessStatus {
  return { state: "stopped", pid: null, port: null, socket: null, startedAt: null, lastHealthAt: null, lastHealthOk: null, error: null, revision: null };
}

export function idleCheck(): CheckState {
  return { state: "idle", at: null, error: null, nextPollAt: null, relation: null, ahead: 0, behind: 0, delta: null };
}

/** Every SHA on the surface is spelled with 7 characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
