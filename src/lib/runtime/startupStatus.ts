import { structuredHostsEnabled } from "./flags";

const startupStore = process as typeof process & {
  __llvStructuredHostStartupFailed?: boolean;
  __llvStructuredHostStartupProgress?: StructuredHostStartupStatus;
  __llvStructuredDeliveryControllerReady?: boolean;
};

export type StructuredHostStartupPhase =
  | "waiting for structured startup"
  | "refreshing transcripts"
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
}

function pendingStatus(): StructuredHostStartupStatus {
  return {
    state: "pending",
    phase: "waiting for structured startup",
    completedHosts: 0,
    totalHosts: null,
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
  const previous = startupStore.__llvStructuredHostStartupProgress;
  const now = new Date().toISOString();
  const changed = previous?.phase !== progress.phase || previous.state !== state;
  if (changed) {
    // Fixed phase names and numeric timing only. No exception, host identity,
    // transcript, operation payload or account data enters this diagnostic.
    console.error("[structured hosts] startup progress", {
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
    failureCategory: state === "ready" ? null : previous?.failureCategory ?? null,
  };
}

export function markStructuredHostStartupProgress(progress: StructuredHostStartupProgress): void {
  setStatus(startupStore.__llvStructuredHostStartupFailed === true ? "failed" : "pending", progress);
}

export function markStructuredHostStartupFailed(category?: string): void {
  startupStore.__llvStructuredHostStartupFailed = true;
  const current = startupStore.__llvStructuredHostStartupProgress ?? pendingStatus();
  setStatus("failed", current);
  if (category) startupStore.__llvStructuredHostStartupProgress!.failureCategory = category;
}

export function markStructuredHostStartupReady(): void {
  startupStore.__llvStructuredHostStartupFailed = false;
  const current = startupStore.__llvStructuredHostStartupProgress ?? pendingStatus();
  setStatus("ready", { ...current, phase: "ready" });
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
