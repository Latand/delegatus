import type { Pipeline } from "./types";

export type ClosedAttemptLaunchEvidence = "none" | "no-host" | "uncertain" | "launched";

/** Closing withdraws only work whose original registry requests prove no host
 * was admitted. Also used when reading old lanes, so history needs no rewrite
 * or invented run/start time. */
export function settleClosedPipelineAttempts(
  pipeline: Pipeline,
  launchEvidence: (pipeline: Pipeline, stageId: string, attempt: Pipeline["runs"][number]["attempts"][number]) => ClosedAttemptLaunchEvidence =
    (_pipeline, _stageId, attempt) => attempt.spawnCalls === 0 ? "none" : "uncertain",
): void {
  if (pipeline.state !== "closed") return;
  for (const run of pipeline.runs) for (const attempt of run.attempts) {
    if (attempt.state !== "pending" || attempt.activation || attempt.launchId
      || attempt.conversationId || attempt.sessionId || attempt.agentPath || attempt.paneId
      || attempt.flowId || attempt.completedAt || attempt.verdict
      || !["none", "no-host"].includes(launchEvidence(pipeline, run.stageId, attempt))) continue;
    attempt.state = "skipped";
    attempt.completedAt = pipeline.closedAt;
    attempt.error = "pipeline closed before this attempt started";
  }
}
