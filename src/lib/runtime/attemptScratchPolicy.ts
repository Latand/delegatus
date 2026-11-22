import { laneFinish } from "@/lib/pipelines/laneFinish";
import type { Pipeline } from "@/lib/pipelines/types";

/** Scratch only. Evidence and other retained classes keep their own clocks.
 * Millisecond event clocks admit a root strictly after the 24-hour boundary. */
export const ATTEMPT_SCRATCH_RETENTION_MS = 24 * 60 * 60_000;
export const ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS = ATTEMPT_SCRATCH_RETENTION_MS + 1;
export const ATTEMPT_SCRATCH_AUDIT_INTERVAL_MS = 60 * 60_000;

export function attemptScratchAuditDue(until: number, now: number) {
  return until <= now || until - now > ATTEMPT_SCRATCH_AUDIT_INTERVAL_MS;
}

export function attemptScratchExpiry(pipeline: Pipeline, owner: { launchId: string; retainUntilClose: boolean; createdAt: number }): number | null {
  const terminalLane = pipeline.state === "closed" || pipeline.state === "completed";
  const finish = terminalLane ? laneFinish(pipeline, ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS) : null;
  if (finish && !finish.finished) return null;
  const run = pipeline.runs.find(run => run.attempts.some(attempt => attempt.launchId === owner.launchId));
  const current = run?.attempts.find(attempt => attempt.launchId === owner.launchId);
  if (current && (current.activation || current.unresolvedTermination || current.state === "running" || current.state === "spawning")) return null;
  // A comparison takeover can reactivate the publication cursor on an
  // already passed attempt. The cursor retains it until it advances again.
  if (!terminalLane && current && run?.stageId === pipeline.cursor?.stageId && run?.attempts.at(-1) === current) return null;
  if (!owner.retainUntilClose && !pipeline.activationCloseRequested && !pipeline.unconfirmedHosts?.length
    && pipeline.remoteAction?.state !== "pending") {
    const end = current
      ? (["passed", "failed", "skipped"].includes(current.state) ? current.completedAt : null)
      : pipeline.runs.flatMap(run => run.attempts.flatMap(attempt => attempt.retiredLaunches ?? []))
        .find(launch => launch.launchId === owner.launchId)?.retiredAt;
    const completed = end ? Date.parse(end) : NaN;
    if (Number.isFinite(completed) && completed >= owner.createdAt) return completed + ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS;
  }
  return finish?.finished ? finish.expiresAt : null;
}
