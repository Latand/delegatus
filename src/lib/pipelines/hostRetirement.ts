import type { RuntimeEngine, RuntimeProviderRecoveryRef } from "@/lib/runtime/contracts";
import { durableStageTurnEvidence, stageTurnEvidenceCurrent, type StageTurnEvidence } from "./durableEvidence";
import { liveBackgroundTasks } from "./backgroundTasks";
import { classifyProviderCondition, CODEX_CYBERSECURITY_REFUSAL } from "./providerConditions";
import { pipelineAttemptMayBeWorking } from "./attemptWorking";
import type { Pipeline, PipelineStageAttempt, PipelineStageHostRef } from "./types";
import { recordedHostHeld } from "@/lib/recordedChecks/store";

type RecoveryTarget = { conversationId: string; sessionId: string; agentPath: string | null; engine: RuntimeEngine };

export type PipelineRetirementReason = "stage verdict" | "terminal lane";

export function pipelineLaneTerminal(pipeline: Pipeline): boolean {
  return pipeline.state === "completed" || pipeline.state === "closed" || pipeline.merge?.state === "merged";
}

/** Terminal lanes and replaced attempts no longer own future work. Runtime
    idleness still has to be proved before any recorded host is stopped. */
export function pipelineAttemptReleased(pipeline: Pipeline, attempt: PipelineStageAttempt, latest: PipelineStageAttempt | undefined): boolean {
  // An adopted helper keeps its own live-work evidence until reconciliation
  // settles it. Merely appending one never supersedes the operational stage.
  return !attempt.historical && (pipeline.state === "completed" || pipeline.state === "closed"
    || (!!latest && !latest.historical && latest.n !== attempt.n));
}

type HostIdentity = Pick<PipelineStageHostRef, "conversationId" | "agentPath" | "paneId" | "launchId"> & { sessionId?: string | null };

function parkedCodexRefusal(attempt: PipelineStageAttempt): boolean {
  const wait = attempt.providerWait;
  const recovery = attempt.providerRecoveries?.at(-1);
  return attempt.effectiveRole.engine === "codex" && Boolean(attempt.completedAt)
    && !attempt.report && !attempt.verdict && !wait?.stageRetry
    && wait?.condition.kind === "other" && wait.condition.label === CODEX_CYBERSECURITY_REFUSAL
    && recovery?.action === "park" && recovery.condition.label === CODEX_CYBERSECURITY_REFUSAL;
}

/** A repair may be reserved by a later stage and dispatched to an earlier
 * producer. A decision park keeps its ordinary idle interval until the engine
 * reserves a fresh attempt. Switch custody covers both endpoints until the
 * switch or its retry settles. */
export function pipelineRetirementOwnership(pipeline: Pipeline) {
  const publishing = pipelinePublicationHoldsHost(pipeline);
  const terminal = pipelineLaneTerminal(pipeline);
  const runs = pipeline.runs.map(run => ({ run, latest: run.attempts.findLast(attempt => !attempt.historical) }));
  const byStage = new Map(runs.map(({ run }) => [run.stageId, run]));
  const producers = new Set<PipelineStageAttempt>();
  if (!terminal) for (const { latest } of runs) {
    const repair = latest?.publicationRepair;
    if (!repair || repair.settledAt || repair.outcome) continue;
    const worker = byStage.get(repair.stageId)?.attempts.find(attempt => attempt.n === repair.attempt && !attempt.historical);
    if (worker) producers.add(worker);
  }

  const attempts = runs.flatMap(({ run, latest }) => run.attempts.map(attempt => {
    const switches = attempt.runtimeSwitches?.filter(record =>
      ["requested", "cutting", "switching", "continuing"].includes(record.phase) || record.retry && !record.retry.completedAt) ?? [];
    const identities: HostIdentity[] = [attempt];
    for (const record of switches) {
      identities.push({ ...record.from, paneId: null });
      if (record.launch) identities.push({ ...record.launch, paneId: null, agentPath: null });
    }
    const current = !terminal && attempt === latest;
    const pendingDispatch = switches.length > 0 || producers.has(attempt)
      || current && (attempt.commitRepair && !attempt.commitRepair.settledAt && !attempt.commitRepair.outcome
        || attempt.publicationTextRepair?.state === "pending");
    // A completed provider refusal can use the ordinary idle reap while the
    // lane waits for a decision. Live work and pending dispatch still fence it.
    const decision = current && (attempt.verdict?.status === "needs_decision"
      || attempt.state === "needs_decision" && !parkedCodexRefusal(attempt));
    const working = pipelineAttemptMayBeWorking(attempt);
    const fenced = Boolean(publishing || pendingDispatch || attempt.activation && attempt.activation.phase !== "settled");
    const reason: PipelineRetirementReason | null = fenced || decision || attempt.historical ? null
      : terminal ? "terminal lane" : attempt.verdict && !working ? "stage verdict" : null;
    const released = !fenced && (reason !== null || pipelineAttemptReleased(pipeline, attempt, latest));
    return {
      stageId: run.stageId, attempt, identities, reason, released, fenced,
      held: fenced || decision || !released && working,
      recoverable: !pendingDispatch && byStage.get(run.stageId) === run && attempt === run.attempts.at(-1) && !attempt.historical,
    };
  }));
  return { publishing, sourceHeld: publishing || !terminal, attempts };
}

// Dependency-free so the controller scope can share it without its imports.
export { pipelineAttemptMayBeWorking };

/** Retained provider parks have no stage verdict. The closing recovery entry
 * must still describe the current decision before a manual action can use it. */
export function parkedProviderError(pipeline: Pipeline, attempt: PipelineStageAttempt): string | null {
  const wait = attempt.providerWait;
  const recovery = attempt.providerRecoveries?.at(-1);
  const detail = attempt.error;
  if (pipeline.state !== "needs_decision" || pipeline.cursor?.state !== "running"
    || attempt.state !== "needs_decision" || !attempt.completedAt || attempt.historical || attempt.report || attempt.verdict
    || attempt.paneId || !attempt.agentPath || !attempt.conversationId || !attempt.sessionId
    || !wait || wait.retryCancelled || !Number.isFinite(wait.turnTs) || wait.turnTs <= 0
    || wait.condition.kind === "turn_cut" || wait.condition.kind === "host_death"
    || recovery?.action !== "park" || recovery.condition.kind !== wait.condition.kind
    || !recovery.summary.startsWith(`stage cut by ${wait.condition.label}`)
    || !detail || detail !== pipeline.stateDetail) return null;
  if (wait.stageRetry) return wait.stageRetry.controlGeneration === (pipeline.controlGeneration ?? null)
    && detail === wait.stageRetry.detail ? detail : null;
  return detail === recovery.summary ? detail : null;
}

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
    || attempt.effectiveRole.engine !== target.engine || !attempt.conversationId
    || resolveConversation(attempt.conversationId) !== resolveConversation(target.conversationId)
    || attempt.sessionId !== target.sessionId || !target.agentPath || attempt.agentPath !== target.agentPath
    || attempt.paneId) return null;
  const accountRecovery = ["usage_limit", "auth_required", "transient"].includes(wait.condition.kind);
  const running = accountRecovery && pipeline.state === "running" && attempt.state === "running";
  const retry = wait.stageRetry;
  const parked = accountRecovery && pipeline.state === "needs_decision" && attempt.state === "needs_decision" && retry
    && retry.controlGeneration === ref.controlGeneration
    && retry.detail === pipeline.stateDetail && retry.detail === attempt.error
    && (wait.condition.kind === "usage_limit" || retry.fallback === false);
  return running || parked || parkedProviderError(pipeline, attempt) ? attempt : null;
}

/** Native terminal evidence and complete prompt history must name this exact cut. */
export function providerRecoveryTurnMatches(attempt: PipelineStageAttempt, evidence: StageTurnEvidence | null, now: number): boolean {
  const cut = attempt.providerWait;
  const notice = evidence?.terminalProviderMessage;
  return evidence?.turn === "terminal" && evidence.promptHistoryComplete === true
    && !!cut && !!notice && notice.ts === cut.turnTs
    && classifyProviderCondition(attempt.effectiveRole.engine, notice.errorClass, notice.text).kind === cut.condition.kind
    && Array.isArray(evidence.prompts)
    && !(evidence.externalPromptAfterCut ?? evidence.prompts.some(prompt => prompt.origin === "external" && prompt.ts > cut.turnTs))
    && Array.isArray(evidence.backgroundTasks) && liveBackgroundTasks(evidence.backgroundTasks, now).length === 0;
}

export async function readProviderRecoveryTurnProof(attempt: PipelineStageAttempt, ref: RuntimeProviderRecoveryRef): Promise<(() => boolean) | null> {
  if (!attempt.agentPath) return null;
  const evidence = await durableStageTurnEvidence(attempt.effectiveRole.engine, attempt.agentPath,
    undefined, attempt.startedAt, undefined, ref.turnTs);
  return providerRecoveryTurnMatches(attempt, evidence, Date.now())
    ? () => stageTurnEvidenceCurrent(evidence) === true : null;
}

/** Match each recorded identity independently: adoption and runtime succession
    can change one field while retaining the same host. */
export function pipelineHostHasLiveWork(
  pipelines: readonly Pipeline[],
  target: HostIdentity,
  resolveConversation: (id: string) => string = id => id,
  recoveryAttempt?: PipelineStageAttempt,
): boolean {
  if (target.conversationId && recordedHostHeld(target.conversationId)) return true;
  const sameConversation = (id: string | null) => !!id && !!target.conversationId
    && resolveConversation(id) === resolveConversation(target.conversationId);
  const samePath = (value: string | null) => !!value && !!target.agentPath && value === target.agentPath;
  // Creating a successor does not keep a finished stage resident. Its live
  // runtime turn, accepted work, publication and any operational owner still
  // protect it independently. Proof is re-read on every actuation boundary.
  const ownership = pipelines.map(pipeline => ({ pipeline, ...pipelineRetirementOwnership(pipeline) }));
  const released = ownership.flatMap(lane => lane.attempts.filter(stage => stage.released).map(stage => stage.attempt));
  const releasedConversation = released.some(attempt => sameConversation(attempt.conversationId));
  const releasedPath = released.some(attempt => samePath(attempt.agentPath));
  for (const { pipeline, publishing, sourceHeld, attempts } of ownership) {
    const sourceConversation = sameConversation(pipeline.srcConversationId), sourcePath = samePath(pipeline.srcPath);
    if (sourceHeld && ((sourceConversation && (publishing || !releasedConversation))
      || (sourcePath && (publishing || !releasedPath)))) return true;
    if (attempts.some(stage => stage.held
      && (publishing || !stage.recoverable || stage.attempt !== recoveryAttempt)
      && stage.identities.some(host => sameConversation(host.conversationId) || samePath(host.agentPath)
        || !!target.paneId && host.paneId === target.paneId
        || !!target.launchId && host.launchId === target.launchId
        || !!target.sessionId && host.sessionId === target.sessionId))) return true;
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
