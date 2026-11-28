import { startupDiagnostic } from "../startupDiagnostics";
import { structuredHostsEnabled } from "./flags";

const startupStore = process as typeof process & {
  __llvStructuredHostStartupFailed?: boolean;
  __llvStructuredHostStartupProgress?: StructuredHostStartupStatus;
  __llvStructuredDeliveryControllerReady?: boolean;
};

export type StructuredHostStartupPhase =
  | "waiting for structured startup"
  | "probing runtime host generation"
  | "binding structured delivery controller"
  | "reading structured startup registry"
  | "recognizing interrupted hosts"
  | "reading startup memberships"
  | "refreshing transcripts"
  | "reading runtime startup signals"
  | "adopting Codex hosts"
  | "adopting Claude hosts"
  | "reconciling structured hosts"
  | "finalizing structured delivery"
  | "registering structured delivery hosts"
  | "reading fallback runtime snapshot"
  | "publishing historical host fallbacks"
  | "reconciling terminal delivery receipts"
  | "draining startup delivery queue"
  | "recovering orchestrator deliveries"
  | "recovering interrupted deliveries"
  | "kicking recovered deliveries"
  | "recovering pending spawns"
  | "ready";

export interface StructuredHostStartupProgress {
  recovery?: { examined: number; total: number; completed: number; deferred: number };
  membership?: { completed: number; remaining: number };
  phase: StructuredHostStartupPhase;
  completedHosts: number;
  totalHosts: number | null;
}

export interface StructuredHostStartupStatus extends StructuredHostStartupProgress {
  state: "pending" | "failed" | "ready";
  updatedAt: string;
  phaseStartedAt?: string;
  pid?: number;
  failureCategory?: string | null;
  failurePhase?: StructuredHostStartupPhase | null;
  remainingHosts: number | null;
  deadline: string | null;
  hostKey: string | null;
  nextRetryAt: string | null;
  retryDisposition: "scheduled" | "executing" | "stopped" | null;
}

function pendingStatus(): StructuredHostStartupStatus {
  return {
    state: "pending",
    phase: "waiting for structured startup",
    completedHosts: 0,
    totalHosts: null,
    remainingHosts: null,
    deadline: null,
    hostKey: null,
    nextRetryAt: null,
    retryDisposition: null,
    updatedAt: new Date().toISOString(),
  };
}

function setStatus(
  state: StructuredHostStartupStatus["state"],
  progress: StructuredHostStartupProgress,
): void {
  if (!Number.isSafeInteger(progress.completedHosts) || progress.completedHosts < 0) {
    throw new Error("structured host startup completed count is invalid");
  }
  if (progress.totalHosts !== null
    && (!Number.isSafeInteger(progress.totalHosts)
      || progress.totalHosts < progress.completedHosts)) {
    throw new Error("structured host startup total count is invalid");
  }
  if (progress.recovery) {
    const { examined, total, completed, deferred } = progress.recovery;
    if (![examined, total, completed, deferred].every(value => Number.isSafeInteger(value) && value >= 0)
      || examined > total || completed + deferred !== total) throw new Error("spawn recovery progress is invalid");
  }
  const previous = startupStore.__llvStructuredHostStartupProgress;
  const now = new Date().toISOString();
  const changed = previous?.phase !== progress.phase || previous.state !== state;
  if (changed) {
    // Fixed phase names and numeric timing only. No exception, host identity,
    // transcript, operation payload or account data enters this diagnostic.
    startupDiagnostic("error", "[structured hosts] startup progress", {
      pid: process.pid, phase: progress.phase, state,
      previousPhase: previous?.phase ?? null,
      previousPhaseMs: previous?.phaseStartedAt
        ? Math.max(0, Date.now() - Date.parse(previous.phaseStartedAt)) : null,
    });
  }
  startupStore.__llvStructuredHostStartupProgress = {
    ...progress,
    state,
    updatedAt: now,
    phaseStartedAt: changed ? now : previous?.phaseStartedAt ?? now,
    pid: process.pid,
    remainingHosts: progress.totalHosts === null ? null : progress.totalHosts - progress.completedHosts,
    failureCategory: state === "ready" ? null : previous?.failureCategory ?? null,
    failurePhase: state === "ready" ? null : previous?.failurePhase ?? null,
    deadline: state === "ready" ? null : previous?.deadline ?? null,
    hostKey: state === "ready" ? null : previous?.hostKey ?? null,
    nextRetryAt: state === "ready" ? null : previous?.nextRetryAt ?? null,
    retryDisposition: state === "ready" ? null : previous?.retryDisposition ?? null,
  };
}

export function markStructuredHostStartupProgress(progress: StructuredHostStartupProgress): void {
  setStatus(startupStore.__llvStructuredHostStartupFailed === true ? "failed" : "pending", progress);
}

export function markStructuredHostStartupFailed(
  category?: string,
  details?: { deadline: string | null; hostKey: string | null; nextRetryAt: string | null },
): void {
  startupStore.__llvStructuredHostStartupFailed = true;
  const current = startupStore.__llvStructuredHostStartupProgress ?? pendingStatus();
  setStatus("failed", current);
  Object.assign(startupStore.__llvStructuredHostStartupProgress!, {
    failurePhase: current.phase,
    deadline: details?.deadline ?? null,
    hostKey: details?.hostKey ?? null,
    nextRetryAt: details?.nextRetryAt ?? null,
    retryDisposition: details?.nextRetryAt ? "scheduled" : "stopped",
    ...(category ? { failureCategory: category } : {}),
  });
}

export function markStructuredHostStartupRetryStarted(): void {
  markStructuredHostStartupProgress({ phase: "probing runtime host generation", completedHosts: 0, totalHosts: null });
  const status = startupStore.__llvStructuredHostStartupProgress;
  if (status?.state === "failed") {
    status.nextRetryAt = null;
    status.retryDisposition = "executing";
  }
}

export function markStructuredHostStartupReady(): void {
  startupStore.__llvStructuredHostStartupFailed = false;
  const current = startupStore.__llvStructuredHostStartupProgress ?? pendingStatus();
  setStatus("ready", { phase: "ready", completedHosts: current.completedHosts, totalHosts: current.totalHosts, recovery: current.recovery });
}

/** A keyed session read proves delivery ownership only. It cannot complete
 * the adoption pass or clear its retry state. */
export function markStructuredRuntimeSessionRecovered(): void {
  if (startupStore.__llvStructuredHostStartupFailed === true) {
    console.error("[structured hosts] runtime session recovered; startup still incomplete", {
      source: "message-admission", phase: startupStore.__llvStructuredHostStartupProgress?.phase ?? null,
    });
  }
}

export function didStructuredHostStartupFail(): boolean {
  return startupStore.__llvStructuredHostStartupFailed === true;
}

/** Kept beside startup status so the deployment capability has a tiny
    process-shared answer and leaves the registry/controller graph unloaded.
    The controller flips this only at its atomic publication boundary. */
export function markStructuredDeliveryControllerReady(): void {
  startupStore.__llvStructuredDeliveryControllerReady = true;
}

export function markStructuredDeliveryControllerUnavailable(): void {
  startupStore.__llvStructuredDeliveryControllerReady = false;
}

export function structuredDeliveryControllerReadiness(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "ready" | "unavailable" | null {
  if (!structuredHostsEnabled(env)) return null;
  return startupStore.__llvStructuredDeliveryControllerReady === true ? "ready" : "unavailable";
}

/** Truthful readiness axis for operator surfaces: "ready" only after startup
    adoption succeeded, "failed" after it failed, "pending" before either, and
    null when structured hosting is disabled. Production #367 reported ready
    health while structured spawn admission was failing end to end. */
export function structuredStartupAxis(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "ready" | "failed" | "pending" | null {
  if (!structuredHostsEnabled(env)) return null;
  const failed = startupStore.__llvStructuredHostStartupFailed;
  if (failed === undefined) return "pending";
  return failed ? "failed" : "ready";
}

export function structuredStartupStatus(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StructuredHostStartupStatus | null {
  if (!structuredHostsEnabled(env)) return null;
  return { ...(startupStore.__llvStructuredHostStartupProgress ?? pendingStatus()) };
}
