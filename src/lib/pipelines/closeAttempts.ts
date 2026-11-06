import { agentRegistry } from "@/lib/agent/registry";
import type { Pipeline } from "./types";

export type ClosedAttemptLaunchEvidence = "none" | "no-host" | "uncertain" | "launched";

/** A retained launch id needs positive proof from its own original request
 * family, even when an older close already reset the call count to zero. */
function originalLaunchNeverStarted(pipeline: Pipeline, stageId: string, attempt: Pipeline["runs"][number]["attempts"][number]): boolean {
  try {
    const registry = agentRegistry();
    const base = `pipeline_${pipeline.id}_${stageId}_${attempt.n}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
    const history = registry.pipelineSpawnHistory(base);
    return history.length > 0 && (!attempt.launchId || history.some(receipt => receipt.launchId === attempt.launchId))
      && history.every(receipt => receipt.engine === attempt.effectiveRole.engine && receipt.cwd === pipeline.worktreeDir
        && receipt.transport === "structured" && receipt.state === "failed" && receipt.membershipAdmitted === false
        && !receipt.key && !receipt.pane && !receipt.verifiedHost && !receipt.artifactPath);
  } catch { return false; }
}

/** Closing withdraws only work whose original registry requests prove no host
 * was admitted. Also used when reading old lanes, so history needs no rewrite
 * or invented run/start time. */
export function settleClosedPipelineAttempts(
  pipeline: Pipeline,
  launchEvidence: (pipeline: Pipeline, stageId: string, attempt: Pipeline["runs"][number]["attempts"][number]) => ClosedAttemptLaunchEvidence =
    (pipeline, stageId, attempt) => attempt.spawnCalls === 0 ? "none"
      : originalLaunchNeverStarted(pipeline, stageId, attempt) ? "no-host" : "uncertain",
): void {
  if (pipeline.state !== "closed") return;
  for (const run of pipeline.runs) for (const attempt of run.attempts) {
    if (attempt.state !== "pending" || attempt.activation
      || attempt.conversationId || attempt.sessionId || attempt.agentPath || attempt.paneId
      || attempt.flowId || attempt.completedAt || attempt.verdict
      || pipeline.closeReport?.pending.some(target => target.stageId === run.stageId && target.attempt === attempt.n)
      || (attempt.launchId ? !originalLaunchNeverStarted(pipeline, run.stageId, attempt)
        : !["none", "no-host"].includes(launchEvidence(pipeline, run.stageId, attempt)))) continue;
    attempt.state = "skipped";
    attempt.completedAt = pipeline.closedAt;
    attempt.error = "pipeline closed before this attempt started";
  }
}
