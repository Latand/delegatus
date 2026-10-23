import type { RuntimeEngine, RuntimeProviderRecoveryRef } from "@/lib/runtime/contracts";
import { durableStageTurnEvidence } from "./durableEvidence";
import { liveBackgroundTasks } from "./backgroundTasks";
import { classifyProviderCondition } from "./providerConditions";
import { pipelineAttemptMayBeWorking } from "./attemptWorking";
import type { Pipeline, PipelineStageAttempt, PipelineStageHostRef } from "./types";

type RecoveryTarget = { conversationId: string; sessionId: string; agentPath: string | null; engine: RuntimeEngine };

/** Terminal lanes and replaced attempts no longer own future work. Runtime
    idleness still has to be proved before any recorded host is stopped. */
export function pipelineAttemptReleased(pipeline: Pipeline, attempt: PipelineStageAttempt, latest: PipelineStageAttempt | undefined): boolean {
  // An adopted helper keeps its own live-work evidence until reconciliation
  // settles it. Merely appending one never supersedes the operational stage.
  return !attempt.historical && (pipeline.state === "completed" || pipeline.state === "closed"
    || (!!latest && !latest.historical && latest.n !== attempt.n));
}

// Dependency-free so the controller scope can share it without its imports.
export { pipelineAttemptMayBeWorking };

/** Fresh pipeline ownership for an engine-issued recovery. A ref never grants
    authority to a source owner, publication, or a different/current attempt. */
export function providerRecoveryAttempt(
  pipelines: readonly Pipeline[],
  ref: RuntimeProviderRecoveryRef,
  target: RecoveryTarget,
  resolveConversation: (id: string) => string = id => id,
): PipelineStageAttempt | null {
  const pipeline = pipelines.find(item => item.id === ref.pipelineId);
  if (!pipeline || pipeline.closedAt || pipeline.hiddenAt || pipeline.activationCloseRequested
    || pipeline.remoteAction?.state === "pending" || pipeline.closeTeardown && pipeline.closeTeardown.phase !== "settled"
    || (pipeline.controlGeneration ?? null) !== ref.controlGeneration
    || pipeline.cursor?.stageId !== ref.stageId || pipeline.cursor.state !== "running"
    || !pipeline.stages.some(stage => stage.id === ref.stageId && stage.kind === "run")) return null;
  const attempt = pipeline.runs.find(run => run.stageId === ref.stageId)?.attempts.at(-1);
  const wait = attempt?.providerWait;
  if (!attempt || !wait || attempt.n !== ref.attempt || attempt.historical || attempt.report || attempt.verdict
    || attempt.activation && attempt.activation.phase !== "settled" || wait.retryCancelled
    || wait.turnTs !== ref.turnTs || !Number.isFinite(ref.turnTs) || ref.turnTs <= 0
    || !attempt.startedAt || !Number.isFinite(Date.parse(attempt.startedAt)) || Date.parse(attempt.startedAt) > ref.turnTs
    || !["usage_limit", "auth_required", "transient"].includes(wait.condition.kind)
    || attempt.effectiveRole.engine !== target.engine || !attempt.conversationId
    || resolveConversation(attempt.conversationId) !== resolveConversation(target.conversationId)
    || attempt.sessionId !== target.sessionId || !target.agentPath || attempt.agentPath !== target.agentPath
    || attempt.paneId) return null;
  const running = pipeline.state === "running" && attempt.state === "running";
  const retry = wait.stageRetry;
  const parked = pipeline.state === "needs_decision" && attempt.state === "needs_decision" && retry
    && retry.controlGeneration === ref.controlGeneration
    && retry.detail === pipeline.stateDetail && retry.detail === attempt.error
    && (wait.condition.kind === "usage_limit" || retry.fallback === false);
  return running || parked ? attempt : null;
}

/** Native terminal evidence and complete prompt history must name this exact cut. */
export async function providerRecoveryTurnProven(attempt: PipelineStageAttempt, ref: RuntimeProviderRecoveryRef): Promise<boolean> {
  if (!attempt.agentPath) return false;
  const evidence = await durableStageTurnEvidence(attempt.effectiveRole.engine, attempt.agentPath,
    undefined, attempt.startedAt, undefined, ref.turnTs);
  const notice = evidence?.terminalProviderMessage;
  return evidence?.turn === "terminal" && evidence.promptHistoryComplete === true
    && !!notice && notice.ts === ref.turnTs
    && classifyProviderCondition(attempt.effectiveRole.engine, notice.errorClass, notice.text).kind === attempt.providerWait?.condition.kind
    && Array.isArray(evidence.prompts)
    && !(evidence.externalPromptAfterCut ?? evidence.prompts.some(prompt => prompt.origin === "external" && prompt.ts > ref.turnTs))
    && Array.isArray(evidence.backgroundTasks) && liveBackgroundTasks(evidence.backgroundTasks, Date.now()).length === 0;
}

/** Match each recorded identity independently: adoption and runtime succession
    can change one field while retaining the same host. */
export function pipelineHostHasLiveWork(
  pipelines: readonly Pipeline[],
  target: Pick<PipelineStageHostRef, "conversationId" | "agentPath" | "paneId" | "launchId"> & { sessionId?: string | null },
  resolveConversation: (id: string) => string = id => id,
  recoveryAttempt?: PipelineStageAttempt,
): boolean {
  const sameConversation = (id: string | null) => !!id && !!target.conversationId
    && resolveConversation(id) === resolveConversation(target.conversationId);
  const samePath = (value: string | null) => !!value && !!target.agentPath && value === target.agentPath;
  // Creating a successor does not keep a finished stage resident. Its live
  // runtime turn, accepted work, publication and any operational owner still
  // protect it independently. Proof is re-read on every actuation boundary.
  let releasedConversation = false, releasedPath = false;
  for (const pipeline of pipelines) {
    if (pipelinePublicationHoldsHost(pipeline)) continue;
    for (const run of pipeline.runs) {
      const latest = run.attempts.findLast(attempt => !attempt.historical);
      for (const attempt of run.attempts) {
        if (!pipelineAttemptReleased(pipeline, attempt, latest)
          || attempt.activation && attempt.activation.phase !== "settled") continue;
        releasedConversation ||= sameConversation(attempt.conversationId);
        releasedPath ||= samePath(attempt.agentPath);
      }
    }
  }
  for (const pipeline of pipelines) {
    const publishing = pipelinePublicationHoldsHost(pipeline);
    const sourceConversation = sameConversation(pipeline.srcConversationId), sourcePath = samePath(pipeline.srcPath);
    if ((publishing && (sourceConversation || sourcePath))
      || (!["completed", "closed"].includes(pipeline.state)
        && ((sourceConversation && !releasedConversation) || (sourcePath && !releasedPath)))) return true;
    for (const run of pipeline.runs) {
      const latest = run.attempts.findLast(attempt => !attempt.historical);
      for (const attempt of run.attempts) {
        const matches = sameConversation(attempt.conversationId) || samePath(attempt.agentPath)
          || (!!target.paneId && attempt.paneId === target.paneId)
          || (!!target.launchId && attempt.launchId === target.launchId)
          || (!!target.sessionId && attempt.sessionId === target.sessionId);
        if (!matches) continue;
        // The production callback supplies this object only after proving the cut
        // and re-reading the same pipeline snapshot. Publication keeps custody.
        if (!publishing && attempt === recoveryAttempt) continue;
        // Completion stamps can survive a restart/resume. A running owner still
        // holds the host, even with an older verdict on the same attempt.
        if (publishing || (!pipelineAttemptReleased(pipeline, attempt, latest) && pipelineAttemptMayBeWorking(attempt))
          || (attempt.activation && attempt.activation.phase !== "settled")) return true;
      }
    }
  }
  return false;
}

/** Publication keeps every matching host in custody until its receipt settles. */
export function pipelinePublicationHoldsHost(pipeline: Pipeline): boolean {
  const publication = pipeline.delivery?.operation;
  const result = publication?.result;
  return (publication !== undefined && (publication.state !== "settled" || !result
      || (result.ok !== true && result.ok !== false)
      || (result.ok === false && typeof result.error !== "string")
      || (result.ok === true && (typeof result.sha !== "string"
        || !["published", "unavailable"].includes(result.remote)
        || (result.uncertain !== undefined && result.uncertain !== false)))
      || (publication.executor !== undefined && publication.executor.finished !== true)))
      || pipeline.publicationAdmission?.state === "pending"
      || pipeline.remoteAction?.state === "pending"
      || pipeline.cursor?.state === "committing";
}
