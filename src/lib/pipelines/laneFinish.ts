import { PIPELINE_MERGE_LIVE_STATES, pipelineActivitySettled, type Pipeline } from "./types";

export const FINISHED_LANE_RETENTION_DAYS = 7;
export const FINISHED_LANE_RETENTION_MS = FINISHED_LANE_RETENTION_DAYS * 86400000;

type TerminalTimes = Partial<Pick<Pipeline, "closedAt" | "runs" | "delivery">>;
export function latestTerminalTime(pipelines: readonly TerminalTimes[]): number {
  const times = pipelines.flatMap(owner => [owner.closedAt,
    ...(owner.runs ?? []).flatMap(run => run.attempts.map(attempt => attempt.completedAt)),
    ...(owner.delivery?.journal ?? []).filter(entry => entry.kind === "release").map(entry => entry.at),
  ]).map(date => date ? Date.parse(date) : Number.NaN).filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

/** An attempt parked for a decision, or one that was never launched, has no
 * completion of its own: parking leaves `completedAt` unset, and closing the
 * lane later does not stamp it. Inside a completed or closed lane with no
 * activation, no unresolved termination and no unconfirmed host, such an
 * attempt stopped before the close, so `closedAt` bounds it. Without this,
 * every lane closed while one attempt waited on a decision never finished,
 * and its scratch was held as live for good. A completed attempt still needs
 * its own parseable clock. */
function attemptEndKnown(attempt: Pipeline["runs"][number]["attempts"][number]): boolean {
  if (attempt.completedAt) return Number.isFinite(Date.parse(attempt.completedAt));
  return attempt.completedAt == null && (attempt.state === "needs_decision" || attempt.state === "pending");
}

/** A finished lane cannot still own a launch, delivery or merge. Read again
 * at dispatch: a merge retry or a future reopen invalidates this clock. */
export function laneFinish(pipeline: Pipeline, retentionMs = FINISHED_LANE_RETENTION_MS):
  { finished: false } | { finished: true; finishedAt: number; expiresAt: number } {
  if (!["completed", "closed"].includes(pipeline.state) || !pipeline.closedAt
    || !Number.isFinite(Date.parse(pipeline.closedAt)) || !pipelineActivitySettled(pipeline)
    || pipeline.closeReport?.stillRunning.length || pipeline.closeReport?.unconfirmed.length
    || pipeline.unconfirmedHosts?.length
    || pipeline.runs.some(run => run.attempts.some(attempt => attempt.activation || attempt.unresolvedTermination
      || ["spawning", "running", "reviewing", "committing"].includes(attempt.state)))
    || pipeline.merge && (PIPELINE_MERGE_LIVE_STATES.has(pipeline.merge.state) || pipeline.merge.state === "refreshing"))
    return { finished: false };
  const mergeTime = pipeline.merge ? Date.parse(pipeline.merge.updatedAt) : 0;
  // Every terminal event is part of the proof. Discarding an unknown clock
  // would silently move expiry back to an older close or release.
  if (!Number.isFinite(mergeTime)
    || pipeline.runs.some(run => run.attempts.some(attempt => !attemptEndKnown(attempt)))
    || pipeline.delivery?.journal.some(entry => entry.kind === "release" && (!entry.at || !Number.isFinite(Date.parse(entry.at)))))
    return { finished: false };
  const finishedAt = Math.max(latestTerminalTime([pipeline]), mergeTime);
  return { finished: true, finishedAt, expiresAt: finishedAt + retentionMs };
}
