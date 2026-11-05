import type { Pipeline } from "./types";

/** Closing withdraws untouched work; launch/activation evidence still belongs
 * to the existing host reconciliation paths. Also used when reading old lanes,
 * so their history needs no rewrite or invented run/start time. */
export function settleClosedPipelineAttempts(pipeline: Pipeline): void {
  if (pipeline.state !== "closed") return;
  for (const run of pipeline.runs) for (const attempt of run.attempts) {
    if (attempt.state !== "pending" || attempt.activation || attempt.launchId
      || attempt.conversationId || attempt.sessionId || attempt.agentPath || attempt.paneId
      || attempt.flowId || attempt.startedAt || attempt.completedAt || attempt.verdict) continue;
    attempt.state = "skipped";
    attempt.completedAt = pipeline.closedAt;
    attempt.error = "pipeline closed before this attempt started";
  }
}
