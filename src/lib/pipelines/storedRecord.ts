import { isIssueDelivery } from "@/lib/forge/issueDelivery";
import { isHostTerminationProgress } from "./hostTerminationProof";
import { attemptAccountingSchema, laneClassSchema, repeatReasonSchema } from "./accounting";
import { isTaskSummaryContent } from "@/lib/tasks/summary";
import { isStagePromptContext } from "./prompts";
import { cloudStageConfigurationError, isCloudRuntime, isCloudStageAttempt } from "./cloudStage";
import { isPublicationRecovery } from "./publicationHistory";
import { pipelinePauseInputSchema } from "./pauseMetadata";
import path from "node:path";
import { isDismissedBy } from "@/lib/attention/dismissalTypes";
import { effortScale } from "@/lib/agent/efforts";
import { validAgentMemoryMax, normalizeAgentMemoryCap } from "@/lib/runtime/agentMemoryConfig";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { MAX_SCAFFOLD_LENGTH } from "@/lib/roles/limits";
import { MAX_FAIL_EDGE_ROUNDS, MAX_PIPELINE_GRAPH_EDITS, MAX_PIPELINE_STAGE_REPORTS, MAX_PIPELINE_STAGES, MAX_STAGE_OUTPUTS, MAX_STAGE_RESULT_CHARS } from "./limits";
import { isLegacyReviewLoopStage, legacyReviewLoopReachable, legacyReviewLoopShapeValid, MAX_LEGACY_REVIEW_CONVERSIONS } from "./legacyReviewShape";
import { normalizeStageOutputPath } from "./stageAccess";
import { MAX_DECISION_ANSWER_CHARS, PIPELINE_FAIL_EDGE_EXHAUSTIONS } from "./types";
import type { EffectivePipelineRole, Pipeline, PipelineCreationIntent, PipelineEdgeActivation, PipelineStage, PipelineTerminalReap, PipelineUnconfirmedHost } from "./types";
import { stageVerdictFrom } from "./verdict";

export const PIPELINES_SCHEMA_VERSION = 5;
export const PIPELINE_ROLE_IDS = ["orchestrator", "reviewer", "verifier", "builder", "architect", "cleaner", "prod-auditor", "deployer", "merger", "visual-critic"] as const;

export function isEffectiveRole(value: unknown): value is EffectivePipelineRole {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = value as Partial<EffectivePipelineRole>;
  if (role.engine !== "claude" && role.engine !== "codex") return false;
  if (role.serviceTier !== undefined && (role.engine !== "codex" || typeof role.serviceTier !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(role.serviceTier))) return false;
  if (role.preferredServiceTier !== undefined && (role.engine !== "codex" || typeof role.preferredServiceTier !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(role.preferredServiceTier))) return false;
  if (role.serviceTierSource !== undefined && role.serviceTierSource !== "explicit" && role.serviceTierSource !== "role-default") return false;
  if (role.model !== null && typeof role.model !== "string") return false;
  if (role.model && role.engine === "claude" && !normalizeClaudeLaunchModel(role.model)) return false;
  if (role.model && role.engine === "codex" && (role.model.length > 128 || !role.model.startsWith("gpt-") || /[\u0000-\u001f\u007f]/.test(role.model))) return false;
  if (role.effort !== null && (typeof role.effort !== "string" || !effortScale(role.engine, role.model)!.includes(role.effort))) return false;
  return (
    (role.roleId === null || PIPELINE_ROLE_IDS.includes(role.roleId as typeof PIPELINE_ROLE_IDS[number])) &&
    (role.access === "read-only" || role.access === "read-write") &&
    (role.promptScaffold === null || (typeof role.promptScaffold === "string" && role.promptScaffold.length <= MAX_SCAFFOLD_LENGTH))
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isVerdict(value: unknown): boolean {
  // Older persisted attempts may contain a bare severity such as "P1".
  // New completion input still requires finding text; only stored history uses this path.
  return value === null || stageVerdictFrom(value, { allowLegacySeverityOnly: true }) !== null;
}

function isReviewFlowSync(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sync = value as Record<string, unknown>;
  const hostClaim = sync.hostClaim as Record<string, unknown> | null | undefined;
  const hostClaimValid = hostClaim === undefined || hostClaim === null || (
    typeof hostClaim === "object"
    && !Array.isArray(hostClaim)
    && /^(?:claude|codex):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(hostClaim.sessionKey))
    && /^(?:default|unknown|managed:[0-9a-f]{12})$/.test(String(hostClaim.accountRef))
  );
  const flowStates = ["waiting_ready", "spawn_pending", "spawning", "reviewing", "relay_pending", "relaying", "fixing", "approved", "done_comment", "needs_decision", "paused", "closed"];
  return typeof sync.generation === "string"
    && (sync.sourceRevision === undefined || (Number.isInteger(sync.sourceRevision) && (sync.sourceRevision as number) >= 0))
    && Number.isInteger(sync.roundCount) && (sync.roundCount as number) >= 0
    && isNullableString(sync.implementerHeadSha)
    && isNullableString(sync.reviewerHeadSha)
    && (sync.verdict === null || ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(String(sync.verdict)))
    && flowStates.includes(String(sync.relayState))
    && (sync.terminalState === null || flowStates.includes(String(sync.terminalState)))
    && hostClaimValid
    && typeof sync.synchronizedAt === "string"
    && isNullableString(sync.sourceUpdatedAt)
    && (sync.lagMs === null || (typeof sync.lagMs === "number" && Number.isFinite(sync.lagMs) && sync.lagMs >= 0));
}

function isActivation(value: unknown): value is PipelineEdgeActivation | null {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activation = value as Partial<PipelineEdgeActivation>;
  return (
    typeof activation.stageId === "string" &&
    Number.isInteger(activation.attempt) &&
    (activation.attempt as number) >= 1 &&
    (activation.edge === "pass" || activation.edge === "fail") &&
    (activation.budgetSpent === undefined || (activation.budgetSpent === true && activation.edge === "fail"))
  );
}

function isVerdictRecovery(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recovery = value as Record<string, unknown>;
  return (
    ["pending", "recovered", "exhausted"].includes(String(recovery.state))
    && Number.isInteger(recovery.checks)
    && (recovery.checks as number) >= 0
    && Number.isInteger(recovery.maxChecks)
    && (recovery.maxChecks as number) >= 1
    && (recovery.checks as number) <= (recovery.maxChecks as number)
    && typeof recovery.startedAt === "string"
    && typeof recovery.lastCheckedAt === "string"
    && isNullableString(recovery.nextCheckAt)
    && typeof recovery.reason === "string"
    && recovery.reason.length > 0
    && recovery.reason.length <= 1_000
    && (recovery.messageTs === null
      || (typeof recovery.messageTs === "number" && Number.isFinite(recovery.messageTs) && recovery.messageTs >= 0))
  );
}

function isProviderCondition(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const condition = value as Record<string, unknown>;
  return ["usage_limit", "transient", "auth_required", "other", "host_death", "turn_cut"].includes(String(condition.kind))
    && isNullableString(condition.scope) && (condition.scope === null || String(condition.scope).length <= 64)
    && isNullableString(condition.resetLabel) && (condition.resetLabel === null || String(condition.resetLabel).length <= 160)
    && typeof condition.label === "string" && condition.label.length > 0 && condition.label.length <= 100;
}

/** Transcript evidence may use the filesystem's fractional millisecond mtime. */
function isEvidenceTimestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isProviderWait(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const wait = value as Record<string, unknown>;
  const dated = (time: unknown) => typeof time === "string" && Number.isFinite(Date.parse(time));
  return isProviderCondition(wait.condition) && typeof wait.text === "string" && wait.text.length <= 300
    && isNullableString(wait.accountId) && isEvidenceTimestamp(wait.turnTs)
    && Number.isSafeInteger(wait.tries) && Number(wait.tries) >= 0
    && dated(wait.startedAt) && dated(wait.resumeAt)
    && (wait.resetsAt === null || Number.isSafeInteger(wait.resetsAt) && Number(wait.resetsAt) > 0)
    && (wait.actionAt === undefined || dated(wait.actionAt))
    && (wait.continuationRequestedAt === undefined || dated(wait.continuationRequestedAt))
    && (wait.capacityProbes === undefined || Number.isSafeInteger(wait.capacityProbes) && Number(wait.capacityProbes) >= 0)
    && (wait.retryCancelled === undefined || typeof wait.retryCancelled === "boolean")
    && (wait.stageRetry === undefined || (
      wait.stageRetry !== null && typeof wait.stageRetry === "object" && !Array.isArray(wait.stageRetry)
      && isNullableString((wait.stageRetry as Record<string, unknown>).controlGeneration)
      && typeof (wait.stageRetry as Record<string, unknown>).detail === "string"
      && ((wait.stageRetry as Record<string, unknown>).fallback === undefined || typeof (wait.stageRetry as Record<string, unknown>).fallback === "boolean")
    ))
    && (wait.switchedAccountId === undefined || typeof wait.switchedAccountId === "string")
    && (wait.failedAccounts === undefined || isStringList(wait.failedAccounts) && wait.failedAccounts.length <= 32);
}

function isProviderRecoveries(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 8 && value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))
      && ["wait", "continue", "switch", "relaunch", "park"].includes(String(entry.action))
      && isProviderCondition(entry.condition) && typeof entry.summary === "string" && entry.summary.length <= 2000;
  });
}

function isRuntimeSwitches(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 8) return false;
  const textOrNull = (item: unknown) => item === null || typeof item === "string";
  const seat = (item: Record<string, unknown> | undefined) => !!item && ["claude", "codex"].includes(String(item.engine))
    && textOrNull(item.model) && textOrNull(item.effort) && textOrNull(item.serviceTier) && textOrNull(item.accountId);
  let open = 0;
  return value.every((item, index) => item && typeof item.id === "string" && item.id.length > 0 && Number.isSafeInteger(item.seq) && item.seq > 0
    && (!index || item.seq > value[index - 1].seq)
    && typeof item.requestedAt === "string" && Number.isFinite(Date.parse(item.requestedAt)) && isActor(item.actor)
    && ["fork", "handoff"].includes(item.mode)
    && (item.inPlace === undefined || item.inPlace === true && item.mode === "fork")
    && (item.cut === undefined || ["boundary", "none"].includes(item.cut))
    && (item.tierCut === undefined || ["cut", "armed", "none", "turn-ended", "cancelled", "host-gone", "unknown"].includes(item.tierCut))
    && (item.appliedServiceTier === undefined || item.appliedServiceTier === null || typeof item.appliedServiceTier === "string")
    && (item.cutTurnId === undefined || typeof item.cutTurnId === "string")
    && (item.turbo === undefined || typeof item.turbo === "string" && item.turbo.length <= 80)
    && ["requested", "cutting", "switching", "continuing", "committed", "rolled-back", "failed", "superseded"].includes(item.phase)
    && (!["requested", "cutting", "switching", "continuing"].includes(item.phase) || ++open <= 1)
    && seat(item.from) && seat(item.to)
    && typeof item.from.conversationId === "string" && textOrNull(item.from.launchId) && textOrNull(item.from.sessionId) && textOrNull(item.from.agentPath)
    && typeof item.to.accountId === "string" && typeof item.to.accountPinned === "boolean"
    && ["cutAt", "continuedAt", "settledAt", "stopDispatchedAt"].every(key => item[key] === undefined || typeof item[key] === "string" && Number.isFinite(Date.parse(item[key])))
    && (item.reconfigureNoop === undefined || typeof item.reconfigureNoop === "boolean")
    && (item.retry === undefined || item.retry && typeof item.retry.reason === "string" && item.retry.reason.length <= 2000
      && typeof item.retry.requestedAt === "string" && Number.isFinite(Date.parse(item.retry.requestedAt))
      && (item.retry.completedAt === undefined || typeof item.retry.completedAt === "string" && Number.isFinite(Date.parse(item.retry.completedAt)))
      && (item.retry.operatorStoppedAt === undefined || typeof item.retry.operatorStoppedAt === "string" && Number.isFinite(Date.parse(item.retry.operatorStoppedAt)))
      && (item.retry.pendingReason === undefined || typeof item.retry.pendingReason === "string" && item.retry.pendingReason.length <= 2000))
    && (item.rollback === undefined || typeof item.rollback === "boolean")
    && (item.continuationKey === undefined || typeof item.continuationKey === "string")
    && (item.continuationDispatch === undefined || typeof item.continuationDispatch.key === "string"
      && typeof item.continuationDispatch.at === "string" && Number.isFinite(Date.parse(item.continuationDispatch.at)))
    && (item.outcome === undefined || typeof item.outcome === "string")
    && (item.launch === undefined || typeof item.launch.clientAttemptId === "string" && textOrNull(item.launch.launchId) && textOrNull(item.launch.conversationId))
    && (item.handoff === undefined || typeof item.handoff.prompt === "string" && /^[a-f0-9]{64}$/.test(item.handoff.digest)
      && item.handoff.bytes === Buffer.byteLength(item.handoff.prompt) && item.handoff.bytes <= 32000));
}

function isStageSuspension(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const suspension = value as Record<string, unknown>;
  const dated = (time: unknown) => typeof time === "string" && Number.isFinite(Date.parse(time));
  return (suspension.reason === "pause" || suspension.reason === "account") && typeof suspension.detail === "string"
    && dated(suspension.requestedAt)
    && (suspension.stoppedAt === undefined || dated(suspension.stoppedAt))
    && (suspension.stopRevision === undefined || Number.isSafeInteger(suspension.stopRevision) && (suspension.stopRevision as number) >= 0)
    && (suspension.operatorStoppedAt === undefined || dated(suspension.operatorStoppedAt))
    && (suspension.retryRequestedAt === undefined || dated(suspension.retryRequestedAt))
    && (suspension.hold === undefined || isSuspensionHold(suspension.hold));
}

function isSuspensionHold(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hold = value as Record<string, unknown>;
  return typeof hold.accountId === "string" && hold.accountId.length > 0
    && (hold.resetsAt === null || Number.isSafeInteger(hold.resetsAt) && (hold.resetsAt as number) >= 0)
    && (hold.observedAt === null || typeof hold.observedAt === "string" && Number.isFinite(Date.parse(hold.observedAt)));
}

function isPublicationTextRepair(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as Record<string, unknown>;
  return typeof repair.sha === "string" && /^[0-9a-f]{40}$/i.test(repair.sha)
    && (repair.pullRequestHead === undefined || typeof repair.pullRequestHead === "string" && /^[0-9a-f]{40}$/i.test(repair.pullRequestHead))
    && typeof repair.stageId === "string" && typeof repair.detail === "string"
    && Number.isSafeInteger(repair.attempt) && (repair.attempt as number) >= 1
    && Number.isSafeInteger(repair.rounds) && (repair.rounds as number) >= 0
    && Number.isSafeInteger(repair.maxRounds) && (repair.maxRounds as number) >= (repair.rounds as number)
    && ["title", "body", "title/body"].includes(String(repair.part))
    && ["pending", "answered", "exhausted"].includes(String(repair.state))
    && (repair.reportSeq === null || Number.isSafeInteger(repair.reportSeq))
    && typeof repair.requestedAt === "string" && Number.isFinite(Date.parse(repair.requestedAt))
    && (repair.delivered === undefined || typeof repair.delivered === "boolean")
    && (repair.answeredAt === undefined || typeof repair.answeredAt === "string" && Number.isFinite(Date.parse(repair.answeredAt)));
}

function isTerminalOutputPublication(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const publication = value as Record<string, unknown>;
  return ["localSha", "pullRequestHead"].every(key => typeof publication[key] === "string"
    && /^[0-9a-f]{40}$/i.test(publication[key] as string));
}

function isSetupResult(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const setup = value as Record<string, unknown>;
  return Array.isArray(setup.command) && setup.command.length > 0 && setup.command.length <= 32
    && setup.command.every(arg => typeof arg === "string" && arg.length <= 2048)
    && typeof setup.cwd === "string" && typeof setup.hash === "string" && /^[a-f0-9]{64}$/.test(setup.hash)
    && ["running", "passed", "failed"].includes(String(setup.state))
    && typeof setup.startedAt === "string" && Number.isFinite(Date.parse(setup.startedAt))
    && isNullableString(setup.completedAt) && (setup.code === null || Number.isInteger(setup.code))
    && (setup.state !== "passed" || setup.code === 0 && typeof setup.completedAt === "string")
    && typeof setup.stdout === "string" && setup.stdout.length <= 16_000
    && typeof setup.stderr === "string" && setup.stderr.length <= 16_000;
}

function isAttempt(value: unknown, index: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return (
    (attempt.accounting === undefined || attemptAccountingSchema.safeParse(attempt.accounting).success
      && (attempt.n === 1 || (attempt.accounting as import("./accounting").AttemptAccounting).repeatReason !== null)) &&
    attempt.n === index + 1 && isSetupResult(attempt.setup) &&
    (attempt.cloud === undefined || isCloudStageAttempt(attempt.cloud)) &&
    (attempt.executionRuntime === undefined || ["local", "cloud", "cloud-then-local"].includes(String(attempt.executionRuntime))) &&
    (attempt.decisionAnswerId === undefined || (typeof attempt.decisionAnswerId === "string" && attempt.decisionAnswerId.length > 0 && attempt.decisionAnswerId.length <= 200)) &&
    (attempt.historical === undefined || typeof attempt.historical === "boolean") &&
    (attempt.legacyReview === undefined || (attempt.legacyReview === true && attempt.historical === true)) &&
    (attempt.acceptedForReview === undefined || attempt.acceptedForReview === true) &&
    ["pending", "spawning", "running", "reviewing", "committing", "passed", "failed", "needs_decision", "skipped"].includes(String(attempt.state)) &&
    isEffectiveRole(attempt.effectiveRole) &&
    isNullableString(attempt.launchId) &&
    isNullableString(attempt.conversationId) &&
    isNullableString(attempt.sessionId) &&
    isNullableString(attempt.agentPath) &&
    isNullableString(attempt.paneId) &&
    (attempt.accountId === undefined || isNullableString(attempt.accountId)) &&
    (attempt.usageLimitedAccounts === undefined || (
      Array.isArray(attempt.usageLimitedAccounts)
      && attempt.usageLimitedAccounts.every((limited) => (
        limited !== null
        && typeof limited === "object"
        && !Array.isArray(limited)
        && typeof limited.accountId === "string"
        && limited.accountId.length > 0
        && (limited.engine === undefined || limited.engine === "claude" || limited.engine === "codex")
        && (limited.resetsAt === null || (Number.isSafeInteger(limited.resetsAt) && limited.resetsAt >= 0))
        && (limited.limitedAt === undefined || limited.limitedAt === null || isEvidenceTimestamp(limited.limitedAt))
        && (limited.turnId === undefined || (typeof limited.turnId === "string" && limited.turnId.length > 0 && limited.turnId.length <= 100))
      ))
      && new Set(attempt.usageLimitedAccounts.map((limited) => `${limited.engine ?? ""}:${limited.accountId}`)).size === attempt.usageLimitedAccounts.length
    )) &&
    (attempt.providerFallbackRetries === undefined || Number.isSafeInteger(attempt.providerFallbackRetries) && Number(attempt.providerFallbackRetries) >= 0)
    && (attempt.providerRecoveryBudget === undefined || (
      attempt.providerRecoveryBudget !== null && typeof attempt.providerRecoveryBudget === "object"
      && !Array.isArray(attempt.providerRecoveryBudget)
      && Number.isSafeInteger((attempt.providerRecoveryBudget as Record<string, unknown>).tries)
      && Number((attempt.providerRecoveryBudget as Record<string, unknown>).tries) >= 0
      && ((attempt.providerRecoveryBudget as Record<string, unknown>).engine === undefined
        || ["claude", "codex", "copilot"].includes(String((attempt.providerRecoveryBudget as Record<string, unknown>).engine)))
      && ((attempt.providerRecoveryBudget as Record<string, unknown>).triedAccounts === undefined
        || isStringList((attempt.providerRecoveryBudget as Record<string, unknown>).triedAccounts))
      && ((attempt.providerRecoveryBudget as Record<string, unknown>).failedAccounts === undefined
        || isStringList((attempt.providerRecoveryBudget as Record<string, unknown>).failedAccounts))
      && typeof (attempt.providerRecoveryBudget as Record<string, unknown>).startedAt === "string"
      && Number.isFinite(Date.parse((attempt.providerRecoveryBudget as Record<string, unknown>).startedAt as string))
    )) &&
    isProviderWait(attempt.providerWait) &&
    isRestoreContinuation(attempt.restoreContinuation) &&
    isProviderRecoveries(attempt.providerRecoveries) &&
    isNullableString(attempt.flowId) &&
    (attempt.expectedReviewHeadSha === undefined || isNullableString(attempt.expectedReviewHeadSha)) &&
    (attempt.reviewHeadSha === undefined || isNullableString(attempt.reviewHeadSha)) &&
    (attempt.publicationIntegration === undefined || (
      attempt.publicationIntegration !== null && typeof attempt.publicationIntegration === "object"
      && !Array.isArray(attempt.publicationIntegration)
      && ["passedSha", "acceptedSha", "mainSha"].every((key) => typeof (attempt.publicationIntegration as Record<string, unknown>)[key] === "string"
        && /^[0-9a-f]{40}$/i.test((attempt.publicationIntegration as Record<string, string>)[key]))
    )) &&
    isPublicationTextRepair(attempt.publicationTextRepair) &&
    isTerminalOutputPublication(attempt.terminalOutputPublication) &&
    (attempt.publicationRepairFrom === undefined || (
      attempt.publicationRepairFrom !== null && typeof attempt.publicationRepairFrom === "object"
      && !Array.isArray(attempt.publicationRepairFrom)
      && typeof (attempt.publicationRepairFrom as Record<string, unknown>).stageId === "string"
      && ["attempt", "round"].every(key => Number.isSafeInteger((attempt.publicationRepairFrom as Record<string, unknown>)[key])
        && Number((attempt.publicationRepairFrom as Record<string, unknown>)[key]) > 0)
    )) &&
    (attempt.publicationRetry === undefined || (
      attempt.publicationRetry !== null && typeof attempt.publicationRetry === "object"
      && !Array.isArray(attempt.publicationRetry)
      && ["sha", "operationId", "retryAt"].every((key) => typeof (attempt.publicationRetry as Record<string, unknown>)[key] === "string")
      && Number.isSafeInteger((attempt.publicationRetry as Record<string, unknown>).failures)
    )) &&
    isReviewFlowSync(attempt.reviewFlowSync) &&
    isNullableString(attempt.startedAt) &&
    isNullableString(attempt.completedAt) &&
    (attempt.outputBaseHead === undefined || (typeof attempt.outputBaseHead === "string" && /^[0-9a-f]{40}$/i.test(attempt.outputBaseHead))) &&
    (attempt.input === undefined || isNullableString(attempt.input)) &&
    isActivation(attempt.activatedBy) &&
    isNullableString(attempt.output) &&
    isVerdict(attempt.verdict) &&
    isNullableString(attempt.error) &&
    (attempt.decisionRequested === undefined || typeof attempt.decisionRequested === "boolean") &&
    (attempt.budgetSpent === undefined || typeof attempt.budgetSpent === "boolean") &&
    (attempt.reviewedHead === undefined || isNullableString(attempt.reviewedHead)) &&
    isVerdictRecovery(attempt.verdictRecovery) &&
    isRuntimeSwitches(attempt.runtimeSwitches) &&
    isStageSuspension(attempt.suspension) &&
    (attempt.accountHolds === undefined || Array.isArray(attempt.accountHolds) && attempt.accountHolds.every(isSuspensionHold)) &&
    (attempt.runtimeEvidenceSince === undefined || typeof attempt.runtimeEvidenceSince === "string" && Number.isFinite(Date.parse(attempt.runtimeEvidenceSince))) &&
    (attempt.runtimeAccountPin === undefined || isNullableString(attempt.runtimeAccountPin)) &&
    (attempt.memoryCap === undefined || normalizeAgentMemoryCap(attempt.memoryCap) !== null) &&
    isAttemptDefinition(attempt.definition) &&
    isSpawnActivation(attempt.activation) &&
    isSpawnAdmissionBudget(attempt.spawnAdmissionBudget) &&
    isStageReport(attempt.report) &&
    isRetiredLaunches(attempt.retiredLaunches) &&
    isStartupOwnerWait(attempt.startupOwnerWait) &&
    isStartupOwnerWait(attempt.roleMemoryDispatchWait) &&
    isRoleMemoryDelivery(attempt.roleMemoryDelivery) &&
    (attempt.fencedMessageRetries === undefined || typeof attempt.fencedMessageRetries === "number"
      && Number.isSafeInteger(attempt.fencedMessageRetries) && attempt.fencedMessageRetries >= 0) &&
    isUnresolvedTermination(attempt.unresolvedTermination) &&
    isPriorWriterStop(attempt.priorWriterStop) &&
    (attempt.priorWriterStops === undefined || Array.isArray(attempt.priorWriterStops)
      && attempt.priorWriterStops.every(stop => stop !== undefined && isPriorWriterStop(stop))
      && new Set(attempt.priorWriterStops.map(stop => stop.conversationId)).size === attempt.priorWriterStops.length) &&
    isPermissionDenials(attempt.permissionDenials)
  );
}

function isRestoreContinuation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  return ["cutAt", "requestedAt", "deadline"].every(key => timestamp(record[key]))
    && ["conversationId", "transcriptPath"].every(key => typeof record[key] === "string" && record[key].length > 0)
    && (record.acceptedAt === undefined || timestamp(record.acceptedAt))
    && (record.promptBoundary === null || Number.isSafeInteger(record.promptBoundary) && Number(record.promptBoundary) >= 0)
    && Number.isSafeInteger(record.count) && Number(record.count) >= 1 && Number(record.count) <= 3
    && typeof record.clientMessageId === "string" && record.clientMessageId.length > 0 && record.clientMessageId.length <= 300;
}

function isRoleMemoryDelivery(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const delivery = value as Record<string, unknown>;
  return [delivery.launchId, delivery.conversationId, delivery.transcript].every(item => typeof item === "string" && item.length > 0)
    && (delivery.retryClaimId === null || typeof delivery.retryClaimId === "string" && delivery.retryClaimId.length > 0);
}

function isStartupOwnerWait(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const wait = value as Record<string, unknown>;
  return typeof wait.launchId === "string" && wait.launchId.length > 0
    && typeof wait.deadline === "string" && Number.isFinite(Date.parse(wait.deadline));
}

function isPriorWriterStop(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stop = value as Record<string, unknown>;
  return typeof stop.conversationId === "string" && stop.conversationId.length > 0
    && Number.isSafeInteger(stop.tries) && (stop.tries as number) >= 0
    && typeof stop.lastAt === "string" && Number.isFinite(Date.parse(stop.lastAt))
    && isNullableString(stop.error);
}

/** The automatic permission denials an attempt recorded (#2215). */
function isPermissionDenials(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((denial) => {
    if (!denial || typeof denial !== "object" || Array.isArray(denial)) return false;
    const entry = denial as Record<string, unknown>;
    return typeof entry.requestId === "string" && entry.requestId.length > 0
      && isNullableString(entry.tool) && isNullableString(entry.command)
      && isNullableString(entry.reason) && isNullableString(entry.reasonType)
      && (entry.mode === "unattended" || entry.mode === "timeout")
      && typeof entry.deniedAt === "string";
  });
}

function isSpawnAdmissionBudget(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const budget = value as Record<string, unknown>;
  const spent = budget.spent as Record<string, unknown> | undefined;
  return !!spent && ["host", "writer", "controller"].every(kind => typeof spent[kind] === "number"
    && Number.isFinite(spent[kind]) && Number(spent[kind]) >= 0 && Number(spent[kind]) <= 600_000)
    && ["host", "writer", "controller"].includes(String(budget.kind))
    && (budget.legacyLimitMs === undefined || typeof budget.legacyLimitMs === "number"
      && Number.isFinite(budget.legacyLimitMs) && budget.legacyLimitMs >= 0 && budget.legacyLimitMs <= 600_000)
    && (budget.inFlightKind === undefined || budget.inFlightKind === "host" || budget.inFlightKind === "writer")
    && ["waitingSince", "inFlightSince"].every(key => budget[key] === undefined
      || typeof budget[key] === "string" && Number.isFinite(Date.parse(budget[key] as string)))
    && ["lastFailure", "lastWriterFailure"].every(key => budget[key] === undefined
      || typeof budget[key] === "string" && (budget[key] as string).length <= 2_000);
}

function isSpawnActivation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activation = value as Record<string, unknown>;
  const input = activation.input as Record<string, unknown> | undefined;
  const owner = activation.owner as Record<string, unknown> | undefined;
  return typeof activation.id === "string" && activation.id.length > 0
    && ["reserved", "reserving", "dispatching", "settled"].includes(String(activation.phase))
    && typeof activation.clientAttemptId === "string" && activation.clientAttemptId.length > 0
    && typeof activation.startedAt === "string" && typeof activation.fence === "string"
    && (activation.admissionStartedAt === undefined || typeof activation.admissionStartedAt === "string" && Number.isFinite(Date.parse(activation.admissionStartedAt)))
    && (activation.replay === undefined || typeof activation.replay === "boolean")
    && (activation.prepareInput === undefined || typeof activation.prepareInput === "boolean")
    && (activation.cancelRequested === undefined || typeof activation.cancelRequested === "boolean")
    && (activation.closeRequested === undefined || typeof activation.closeRequested === "boolean")
    && (!owner || (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
      && isNullableString(owner.startIdentity) && isNullableString(owner.bootEpoch)))
    && !!input && isEffectiveRole(input.role) && typeof input.prompt === "string"
    && typeof input.cwd === "string" && typeof input.project === "string"
    && typeof input.clientAttemptId === "string" && typeof input.title === "string"
    && !!input.runtimeProfile && !!input.membership;
}

function isAttemptDefinition(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const definition = value as Record<string, unknown>;
  const role = definition.role;
  return (definition.runtime === undefined || definition.runtime === "local" || isCloudRuntime(definition.runtime))
    && validAgentMemoryMax(definition.agentMemoryMaxBytes)
    && typeof definition.boundAt === "string"
    && typeof definition.stageDigest === "string"
    && typeof definition.prompt === "string"
    && isNullableString(definition.account)
    && (role === null || Boolean(role && typeof role === "object" && !Array.isArray(role) && (PIPELINE_ROLE_IDS as readonly unknown[]).includes((role as { roleId?: unknown }).roleId)))
    && (definition.sandbox === null || definition.sandbox === "full" || definition.sandbox === "restricted")
    && (definition.outputs === null || (Array.isArray(definition.outputs) && definition.outputs.every((output) => typeof output === "string")));
}

const GRAPH_EDIT_ACTION_NAMES: readonly string[] = ["add-stage", "remove-stage", "reorder-stage", "set-edge", "override-stage"];

function isActor(value: unknown): boolean {
  const actor = value as Record<string, unknown> | null;
  return Boolean(actor && typeof actor === "object" && !Array.isArray(actor) && (actor.kind === "operator"
    || (actor.kind === "agent" && isNullableString(actor.role) && isNullableString(actor.conversationId))));
}

function isStageProvenance(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  const pullRequest = provenance.pullRequest as Record<string, unknown> | null;
  return (provenance.state === undefined || ["pending", "complete", "unknown"].includes(String(provenance.state)))
    && (provenance.pullRequestState === undefined || ["pending", "observed", "absent", "unknown"].includes(String(provenance.pullRequestState)))
    && isNullableString(provenance.head)
    && typeof provenance.branch === "string"
    && (provenance.uncommitted === null
      || (Array.isArray(provenance.uncommitted) && provenance.uncommitted.every((path) => typeof path === "string")))
    && (pullRequest === null || Boolean(pullRequest && typeof pullRequest === "object" && !Array.isArray(pullRequest)
      && typeof pullRequest.url === "string" && Number.isSafeInteger(pullRequest.number) && typeof pullRequest.state === "string"))
    && Array.isArray(provenance.outputs)
    && provenance.outputs.every((output) => Boolean(output && typeof output === "object" && !Array.isArray(output)
      && typeof (output as { path: unknown }).path === "string"
      && ((output as { present: unknown }).present === null || typeof (output as { present: unknown }).present === "boolean")));
}

/** A stage attempt's own completion report (graph slice 2). */
function isStageReport(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return Number.isSafeInteger(report.seq) && (report.seq as number) >= 1
    && typeof report.at === "string"
    && isActor(report.actor)
    && stageVerdictFrom(report.verdict, { allowLegacySeverityOnly: true }) !== null
    && isNullableString(report.summary)
    && (report.result === undefined || (typeof report.result === "string" && report.result.trim().length > 0 && report.result.length <= MAX_STAGE_RESULT_CHARS && !/[\r\n]/.test(report.result)))
    && (report.taskSummary === undefined || isTaskSummaryContent(report.taskSummary))
    && isStageProvenance(report.provenance)
    && (report.provenanceFence === undefined || (typeof report.provenanceFence === "string" && /^[0-9a-f]{64}$/.test(report.provenanceFence)))
    && Number.isSafeInteger(report.calls) && (report.calls as number) >= 1;
}

function isStageReportEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Number.isSafeInteger(entry.seq) && (entry.seq as number) >= 1
    && typeof entry.at === "string"
    && isActor(entry.actor)
    && typeof entry.stageId === "string"
    && Number.isSafeInteger(entry.attempt) && (entry.attempt as number) >= 1
    && ["pass", "fail", "needs_decision"].includes(String(entry.status))
    && Number.isSafeInteger(entry.findings) && (entry.findings as number) >= 0
    && (entry.replaces === null || (Number.isSafeInteger(entry.replaces) && (entry.replaces as number) >= 1))
    && (entry.provenanceState === undefined || ["pending", "complete", "unknown"].includes(String(entry.provenanceState)))
    && (entry.provenanceAt === undefined || typeof entry.provenanceAt === "string")
    && isNullableString(entry.summary);
}

function isGraphEdit(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  return Number.isSafeInteger(edit.seq) && (edit.seq as number) >= 1
    && typeof edit.at === "string"
    && isActor(edit.actor)
    && GRAPH_EDIT_ACTION_NAMES.includes(String(edit.action))
    && isNullableString(edit.stageId)
    && typeof edit.pipelineState === "string"
    && (edit.effect === "applied" || edit.effect === "pending-next-attempt")
    && (edit.appliesFromAttempt === null || (Number.isSafeInteger(edit.appliesFromAttempt) && (edit.appliesFromAttempt as number) >= 1))
    && typeof edit.summary === "string";
}

function isRetiredLaunches(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value)
    && value.length <= 50
    && value.every((retired) => retired !== null
      && typeof retired === "object"
      && !Array.isArray(retired)
      && typeof (retired as { launchId: unknown }).launchId === "string"
      && (retired as { launchId: string }).launchId.length > 0
      && isNullableString((retired as { conversationId: unknown }).conversationId)
      && typeof (retired as { error: unknown }).error === "string"
      && typeof (retired as { retiredAt: unknown }).retiredAt === "string");
}

function isUnresolvedTermination(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.error === "string"
    && typeof record.recordedAt === "string"
    && (record.sourceRevision === undefined || typeof record.sourceRevision === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.sourceRevision))
    && Array.isArray(record.survivors)
    && record.survivors.every((survivor) => survivor !== null
      && typeof survivor === "object"
      && Number.isSafeInteger((survivor as { pid: unknown }).pid)
      && isNullableString((survivor as { startIdentity: unknown }).startIdentity)
      && ((survivor as { bootEpoch: unknown }).bootEpoch === undefined
        || isNullableString((survivor as { bootEpoch: unknown }).bootEpoch)));
}

function isRun(value: unknown): value is Pipeline["runs"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as { stageId?: unknown; attempts?: unknown };
  return typeof run.stageId === "string" && Array.isArray(run.attempts) && run.attempts.every(isAttempt);
}

function isFailEdge(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edge = value as { to?: unknown; maxRounds?: unknown; onExhausted?: unknown };
  return (
    typeof edge.to === "string" &&
    Number.isInteger(edge.maxRounds) &&
    (edge.maxRounds as number) >= 1 &&
    (edge.maxRounds as number) <= MAX_FAIL_EDGE_ROUNDS &&
    (edge.onExhausted === undefined || (PIPELINE_FAIL_EDGE_EXHAUSTIONS as readonly unknown[]).includes(edge.onExhausted))
  );
}

function isCreationIntent(value: unknown): value is PipelineCreationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Partial<PipelineCreationIntent>;
  return intent.kind === "task-spawn"
    && typeof intent.taskId === "string" && Boolean(intent.taskId.trim())
    && typeof intent.launchId === "string" && Boolean(intent.launchId.trim());
}

function isUnconfirmedHost(value: unknown): value is PipelineUnconfirmedHost {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const host = value as Partial<PipelineUnconfirmedHost>;
  return typeof host.stageId === "string"
    && Number.isInteger(host.attempt)
    && isNullableString(host.conversationId)
    && isNullableString(host.agentPath)
    && (host.paneId === undefined || isNullableString(host.paneId))
    && isNullableString(host.operationId)
    && typeof host.detail === "string"
    && typeof host.at === "string";
}

function isCloseCustody(pipeline: Partial<Pipeline>): boolean {
  const plan = pipeline.closeTeardown;
  const report = pipeline.closeReport;
  if (plan === undefined && report === undefined) return true;
  if (!plan || !report || typeof plan !== "object" || typeof report !== "object") return false;
  const host = (item: unknown): boolean => {
    if (!item || typeof item !== "object") return false;
    const ref = item as Record<string, unknown>;
    return typeof ref.stageId === "string" && Number.isInteger(ref.attempt) && Number(ref.attempt) > 0
      && isNullableString(ref.conversationId) && isNullableString(ref.agentPath) && isNullableString(ref.paneId)
      && (ref.launchId === undefined || isNullableString(ref.launchId));
  };
  const owner = plan.owner;
  return typeof plan.id === "string" && !!plan.id && ["pending", "running", "settled"].includes(plan.phase)
    && (plan.hosts === undefined || (Array.isArray(plan.hosts) && plan.hosts.every((item) => item && host(item.target)
      && item.evidence && isEffectiveRole(item.evidence.effectiveRole) && isNullableString(item.evidence.startedAt)
      && typeof item.evidence.state === "string" && isNullableString(item.evidence.error)
      && isNullableString(item.evidence.completedAt) && isVerdict(item.evidence.verdict)
      && isUnresolvedTermination(item.evidence.unresolvedTermination))))
    && typeof plan.waitingForActivation === "boolean" && typeof plan.acknowledgeHosts === "boolean"
    && (owner === undefined || (owner && typeof owner === "object" && Number.isInteger(owner.pid) && owner.pid > 0 && isNullableString(owner.startIdentity) && isNullableString(owner.bootEpoch)))
    && (plan.flow === null || (typeof plan.flow === "object" && typeof plan.flow.id === "string"
      && typeof plan.flow.stageId === "string" && Number.isInteger(plan.flow.attempt)))
    && ["pending", "settled"].includes(report.status)
    && (plan.phase === "settled") === (report.status === "settled")
    && [report.pending, report.stopped, report.alreadyStopped, report.unconfirmed, report.acknowledged, report.stillRunning, report.notes]
      .every((items) => Array.isArray(items) && items.every(host))
    && report.unconfirmed.every((item) => isNullableString(item.operationId) && typeof item.detail === "string")
    && report.stillRunning.every((item) => typeof item.error === "string")
    && report.acknowledged.every((item) => typeof item.detail === "string")
    && report.notes.every((item) => typeof item.detail === "string")
    && Array.isArray(report.reviewers) && report.reviewers.every((item) => item && typeof item.stageId === "string"
      && Number.isInteger(item.attempt) && typeof item.flowId === "string" && Number.isInteger(item.round))
    && (report.worktree === null || (typeof report.worktree === "object" && typeof report.worktree.dir === "string"
      && Array.isArray(report.worktree.uncommitted) && report.worktree.uncommitted.every((item) => typeof item === "string")
      && typeof report.worktree.truncated === "boolean"))
    && (report.status !== "settled" || report.pending.length === 0);
}

function isTerminalReap(value: unknown): value is PipelineTerminalReap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reap = value as Partial<PipelineTerminalReap>;
  return (reap.attemptRounds === undefined || (reap.attemptRounds !== null && typeof reap.attemptRounds === "object" && !Array.isArray(reap.attemptRounds)
      && Object.values(reap.attemptRounds).every(round => Number.isInteger(round) && round >= 0)))
    && Number.isInteger(reap.rounds) && (reap.rounds as number) >= 0
    && Number.isInteger(reap.stopped) && (reap.stopped as number) >= 0
    && typeof reap.lastAt === "string"
    && (reap.settledAttempts === undefined
      || (Array.isArray(reap.settledAttempts) && reap.settledAttempts.every((key) => typeof key === "string")))
    && isNullableString(reap.settledAt);
}

function isStage(value: unknown): value is PipelineStage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stage = value as Partial<PipelineStage>;
  const role = (value as { role?: unknown }).role;
  if (!(
    typeof stage.id === "string" &&
    (stage.kind === "run" || isLegacyReviewLoopStage(stage)) &&
    typeof stage.prompt === "string" &&
    (stage.next === null || typeof stage.next === "string") &&
    isFailEdge(stage.onFail) &&
    (role === undefined || Boolean(role && typeof role === "object" && !Array.isArray(role) && (PIPELINE_ROLE_IDS as readonly unknown[]).includes((role as { roleId?: unknown }).roleId))) &&
    (stage.engine === undefined || stage.engine === "claude" || stage.engine === "codex") &&
    (stage.model === undefined || stage.model === null || typeof stage.model === "string") &&
    (stage.effort === undefined || stage.effort === null || typeof stage.effort === "string") &&
    (stage.serviceTier == null || typeof stage.serviceTier === "string") &&
    (stage.preferredServiceTier === undefined || (typeof stage.preferredServiceTier === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(stage.preferredServiceTier))) &&
    validAgentMemoryMax(stage.agentMemoryMaxBytes) &&
    (stage.access === undefined || stage.access === "read-only" || stage.access === "read-write") &&
    (stage.sandbox === undefined || stage.sandbox === "full" || stage.sandbox === "restricted") &&
    (stage.outputs === undefined || (
      stage.kind === "run" &&
      Array.isArray(stage.outputs) &&
      stage.outputs.length > 0 && stage.outputs.length <= MAX_STAGE_OUTPUTS &&
      stage.outputs.every((output, index) => normalizeStageOutputPath(output) === output && stage.outputs!.indexOf(output) === index)
    )) &&
    isEffectiveRole(stage.effectiveRole)
  )) return false;
  if (cloudStageConfigurationError(stage as PipelineStage)) return false;
  const effective = stage.effectiveRole;
  const referencedRoleId = role === undefined ? null : (role as { roleId: EffectivePipelineRole["roleId"] }).roleId;
  if (stage.outputs !== undefined && effective.access !== "read-only") return false;
  if (effective.roleId !== referencedRoleId) return false;
  if (isLegacyReviewLoopStage(stage) && !legacyReviewLoopShapeValid(stage as PipelineStage)) return false;
  if (stage.engine !== undefined && stage.engine !== effective.engine) return false;
  if (stage.model !== undefined && stage.model !== effective.model) return false;
  if (stage.effort !== undefined && stage.effort !== effective.effort) return false;
  if (stage.serviceTier != null && stage.serviceTier !== effective.serviceTier) return false;
  if (stage.preferredServiceTier !== undefined && stage.preferredServiceTier !== effective.preferredServiceTier) return false;
  if (stage.access !== undefined && stage.access !== effective.access) return false;
  if (referencedRoleId === null && effective.promptScaffold !== null) return false;
  if (referencedRoleId !== null && !effective.promptScaffold?.trim()) return false;
  return true;
}

/**
 * The v3 conversation-graph contract (#353). Verdict-keyed successors: each
 * stage has at most one pass edge (`next`) and one fail edge (`onFail`). The
 * pass graph must be acyclic (so every pass path terminates at `null`), edge
 * targets must exist, and every review-loop must be pass-reachable from a run
 * stage (it reviews a run's session). Run-stage fail edges may target any stage;
 * their cycles terminate at the per-edge round budget. Review-loop stages use
 * their bound flow for verdict recovery and cannot define `onFail`. Shared by
 * the store validator, the create-time normalizer, and the set-edge action so
 * every mutation path applies the same graph contract.
 */
export function pipelineGraphError(
  stages: ReadonlyArray<Pick<PipelineStage, "id" | "kind" | "next"> & { onFail?: Pipeline["stages"][number]["onFail"] }>,
  /** Decoding a stored record passes false: a legacy review-loop no run
      reaches still loads (retire-flows §3), and start refuses it. Every edit
      and every start keeps the rule. */
  options: { legacyReachability?: boolean } = {},
): string | null {
  const ids = new Set(stages.map((stage) => stage.id));
  const nextOf = new Map(stages.map((stage) => [stage.id, stage.next] as const));
  for (const stage of stages) {
    if (stage.next !== null && !ids.has(stage.next)) return `stage ${stage.id} next must reference an existing stage`;
    if (stage.next === stage.id) return `stage ${stage.id} pass edge may not target itself`;
    const onFail = stage.onFail ?? null;
    if (isLegacyReviewLoopStage(stage) && onFail) return `review-loop stage ${stage.id} does not support onFail`;
    if (onFail && !ids.has(onFail.to)) return `stage ${stage.id} onFail must reference an existing stage`;
    if (onFail && (!Number.isInteger(onFail.maxRounds) || onFail.maxRounds < 1 || onFail.maxRounds > MAX_FAIL_EDGE_ROUNDS)) {
      return `stage ${stage.id} onFail maxRounds must be an integer between 1 and ${MAX_FAIL_EDGE_ROUNDS}`;
    }
    if (onFail?.onExhausted !== undefined && !PIPELINE_FAIL_EDGE_EXHAUSTIONS.includes(onFail.onExhausted)) {
      return `stage ${stage.id} onFail onExhausted must be advance, stop-after-fix or park`;
    }
  }
  /* Out-degree-1 pass graph: walking `next` from any stage must terminate
     within |stages| hops, else a pass cycle exists. */
  for (const stage of stages) {
    let cursor: string | null = stage.next;
    for (let hops = 0; cursor !== null; hops += 1) {
      if (cursor === stage.id || hops > stages.length) return `pipeline pass edges form a cycle through stage ${stage.id}`;
      cursor = nextOf.get(cursor) ?? null;
    }
  }
  if (options.legacyReachability === false) return null;
  for (const stage of stages) {
    if (!isLegacyReviewLoopStage(stage)) continue;
    const reachable = legacyReviewLoopReachable(stages, stage.id);
    /* #1026: this used to say "review-loop stage requires a preceding run
       stage", which reads as an ordering rule and sent a caller reordering an
       array that was already in the right order. The defect is a missing pass
       edge: stages default to `next: null`, so nothing reaches the review-loop.
       Name the unreachable stage and the edge that would reach it. */
    if (!reachable) {
      const runStages = stages.filter((candidate) => candidate.kind === "run");
      if (runStages.length === 0) {
        return `review-loop stage ${stage.id} is unreachable: the pipeline has no run stage, and a review-loop reviews the session of a run stage that reaches it`;
      }
      const source = runStages.findLast((candidate) => candidate.next === null) ?? runStages.at(-1)!;
      return `review-loop stage ${stage.id} is unreachable: no run stage's next chain reaches it — set next: "${stage.id}" on run stage ${source.id}`;
    }
  }
  return null;
}

function isDelivery(value: unknown): value is NonNullable<Pipeline["delivery"]> {
  if (!value || typeof value !== "object") return false;
  const delivery = value as NonNullable<Pipeline["delivery"]>;
  const target = delivery.target;
  if (!target || typeof target.repository !== "string" || !target.repository || typeof target.remote !== "string"
    || typeof target.branch !== "string" || !target.branch.startsWith("refs/heads/")
    || !["owner", "comparison"].includes(delivery.disposition) || !["enabled", "disabled"].includes(delivery.publish)
    || typeof delivery.ownerId !== "string" || !delivery.ownerId || !Number.isSafeInteger(delivery.epoch) || delivery.epoch < 1
    || typeof delivery.active !== "boolean" || !Array.isArray(delivery.journal) || delivery.journal.length > 100) return false;
  if (delivery.disposition === "comparison" && (delivery.active || delivery.publish !== "disabled")) return false;
  if (delivery.active && delivery.publish !== "enabled") return false;
  const operation = delivery.operation;
  return !operation || (typeof operation.id === "string" && typeof operation.sha === "string"
    && Number.isSafeInteger(operation.epoch) && operation.epoch === delivery.epoch
    && (operation.fence === undefined || (typeof operation.fence === "string" && /^[0-9a-f]{64}$/.test(operation.fence)))
    && (operation.app403Deadline === undefined || typeof operation.app403Deadline === "string" && Number.isFinite(Date.parse(operation.app403Deadline)))
    && [operation.result?.failure?.observedAt, operation.executor?.result?.failure?.observedAt]
      .every(at => at === undefined || typeof at === "string" && Number.isFinite(Date.parse(at)))
    && ["pending", "running", "settled"].includes(operation.state));
}

/** #1938: the needs_review record and its continue-review grants. */
function isReviewPending(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  return (pending.terminalRecheck === undefined || pending.terminalRecheck === true)
    && typeof pending.stageId === "string" && pending.stageId.length > 0
    && Number.isSafeInteger(pending.attempt) && (pending.attempt as number) >= 0
    && typeof pending.fixStageId === "string" && pending.fixStageId.length > 0
    && Number.isSafeInteger(pending.fixAttempt) && (pending.fixAttempt as number) > 0
    && isNullableString(pending.reviewedHead)
    && typeof pending.currentHead === "string"
    && ["pass", "fail", "needs_decision"].includes(String(pending.verdict))
    && Number.isSafeInteger(pending.findings) && (pending.findings as number) >= 0
    && typeof pending.at === "string";
}

function isReviewGrant(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return typeof grant.clientRequestId === "string" && grant.clientRequestId.length > 0 && grant.clientRequestId.length <= 200
    && typeof grant.expectedRevision === "string" && /^[0-9a-f]{64}$/.test(grant.expectedRevision)
    && typeof grant.stageId === "string" && grant.stageId.length > 0
    && (grant.terminalAttempt === undefined || Number.isSafeInteger(grant.terminalAttempt) && (grant.terminalAttempt as number) > 0)
    && Number.isSafeInteger(grant.rounds) && (grant.rounds as number) >= 1 && (grant.rounds as number) <= MAX_FAIL_EDGE_ROUNDS
    && isNullableString(grant.reviewedHead)
    && typeof grant.currentHead === "string"
    && isActor(grant.actor) && typeof grant.at === "string";
}

function isReviewAcceptance(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const acceptance = value as Record<string, unknown>;
  return typeof acceptance.clientRequestId === "string" && acceptance.clientRequestId.length > 0 && acceptance.clientRequestId.length <= 200
    && typeof acceptance.expectedRevision === "string" && /^[0-9a-f]{64}$/.test(acceptance.expectedRevision)
    && typeof acceptance.stageId === "string" && acceptance.stageId.length > 0
    && Number.isSafeInteger(acceptance.attempt) && (acceptance.attempt as number) >= 0
    && typeof acceptance.fixStageId === "string" && acceptance.fixStageId.length > 0
    && Number.isSafeInteger(acceptance.fixAttempt) && (acceptance.fixAttempt as number) > 0
    && isNullableString(acceptance.reviewedHead)
    && typeof acceptance.currentHead === "string"
    && isActor(acceptance.actor) && typeof acceptance.at === "string";
}

/** An explicit legacy review-loop conversion and the definition it replaced. */
function isLegacyReviewConversion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const conversion = value as Record<string, unknown>;
  const original = conversion.original as Record<string, unknown> | null;
  const reverted = conversion.reverted as Record<string, unknown> | undefined;
  return typeof conversion.clientRequestId === "string" && conversion.clientRequestId.length > 0 && conversion.clientRequestId.length <= 200
    && typeof conversion.expectedRevision === "string" && /^[0-9a-f]{64}$/.test(conversion.expectedRevision)
    && typeof conversion.stageId === "string" && conversion.stageId.length > 0
    && typeof conversion.fixerStageId === "string" && conversion.fixerStageId.length > 0
    && typeof conversion.implementerStageId === "string" && conversion.implementerStageId.length > 0
    && Number.isSafeInteger(conversion.reviewLimit) && (conversion.reviewLimit as number) >= 1 && (conversion.reviewLimit as number) <= MAX_FAIL_EDGE_ROUNDS
    && ["request", "flow", "default"].includes(String(conversion.reviewLimitSource))
    && Boolean(original && typeof original === "object" && Array.isArray(original.stages) && original.stages.every(isStage)
      && isRun(original.run) && (original.run as { stageId: string }).stageId === conversion.stageId
      && (original.cursor === null || (typeof original.cursor === "object" && typeof (original.cursor as { stageId?: unknown }).stageId === "string"))
      && (original.stateDetail === undefined || isNullableString(original.stateDetail)))
    && typeof conversion.convertedGraphDigest === "string"
    && isActor(conversion.actor) && typeof conversion.at === "string"
    && (reverted === undefined || (Boolean(reverted) && typeof reverted === "object" && typeof reverted.clientRequestId === "string"
      && reverted.clientRequestId.length > 0 && isActor(reverted.actor) && typeof reverted.at === "string"));
}

function isDecisionAnswer(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  return typeof answer.clientRequestId === "string" && answer.clientRequestId.length > 0 && answer.clientRequestId.length <= 200
    && typeof answer.expectedRevision === "string" && /^[0-9a-f]{64}$/.test(answer.expectedRevision)
    && typeof answer.stageId === "string" && answer.stageId.length > 0
    && Number.isSafeInteger(answer.attempt) && (answer.attempt as number) > 0
    && Number.isSafeInteger(answer.nextAttempt) && (answer.nextAttempt as number) > (answer.attempt as number)
    && typeof answer.question === "string"
    && typeof answer.answer === "string" && answer.answer.trim().length > 0 && answer.answer.length <= MAX_DECISION_ANSWER_CHARS
    && isActor(answer.actor) && typeof answer.at === "string";
}

const MERGE_STATES = new Set(["refreshing", "queued", "checking", "waiting-checks", "updating", "merging", "merged", "blocked", "cancelled"]);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function isRefreshOf(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const refresh = value as Record<string, unknown>;
  return typeof refresh.pipelineId === "string" && !!refresh.pipelineId && typeof refresh.base === "string" && /^[0-9a-f]{40}$/i.test(refresh.base);
}

function isMergeRefresh(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const refresh = value as Record<string, unknown>;
  return (refresh.baseBranch === undefined || typeof refresh.baseBranch === "string" && !!refresh.baseBranch)
    && Number.isSafeInteger(refresh.attempt) && (refresh.attempt as number) >= 0
    && typeof refresh.base === "string" && /^[0-9a-f]{40}$/i.test(refresh.base)
    && typeof refresh.head === "string" && /^[0-9a-f]{40}$/i.test(refresh.head)
    && typeof refresh.key === "string" && !!refresh.key
    && typeof refresh.digest === "string" && /^[0-9a-f]{64}$/i.test(refresh.digest)
    && typeof refresh.requestedAt === "string" && Number.isFinite(Date.parse(refresh.requestedAt))
    && isNullableString(refresh.pipelineId);
}

/** The merge runner's record (#2187 §4.4). */
function isPipelineMerge(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const merge = value as Record<string, unknown>;
  return MERGE_STATES.has(String(merge.state))
    && (merge.effectUncertain === undefined || typeof merge.effectUncertain === "boolean")
    && (merge.refresh === undefined || isMergeRefresh(merge.refresh))
    && (merge.state !== "refreshing" || merge.refresh !== undefined)
    && (merge.by === null || merge.by === "auto-merge" || merge.by === "outside")
    && typeof merge.repository === "string" && merge.repository.length > 0
    && ((Number.isSafeInteger(merge.prNumber) && (merge.prNumber as number) > 0)
      || (merge.prNumber === null && merge.by === null && ["queued", "blocked", "cancelled"].includes(String(merge.state))))
    && typeof merge.policyChangedAt === "string"
    && typeof merge.reviewedHead === "string"
    && isStringList(merge.chain)
    && Array.isArray(merge.updates) && merge.updates.every((update) => Boolean(update) && typeof update === "object"
      && typeof (update as Record<string, unknown>).requestedAt === "string" && isNullableString((update as Record<string, unknown>).head)
      && [(update as Record<string, unknown>).commit, (update as Record<string, unknown>).base]
        .every(sha => sha === undefined || (typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha))))
    && isStringList(merge.seenChecks)
    && isNullableString(merge.head) && isNullableString(merge.headSeenAt)
    && (merge.lastChecks === null || isStringList(merge.lastChecks))
    && isNullableString(merge.readAt) && isNullableString(merge.nextReadAt)
    && (merge.readFailures === undefined || Number.isSafeInteger(merge.readFailures))
    && typeof merge.requestedAt === "string"
    && isNullableString(merge.mergedHead) && isNullableString(merge.mergeCommit)
    && (merge.method === null || merge.method === "squash" || merge.method === "merge" || merge.method === "rebase")
    && isNullableString(merge.mergedAt)
    && Number.isSafeInteger(merge.attempts)
    && isNullableString(merge.reason) && isNullableString(merge.blockedAt)
    && typeof merge.updatedAt === "string";
}

/** #2187 §5.3: one entry per task, each naming a task the pipeline links. */
function isTaskFinish(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finish = value as Record<string, unknown>;
  return typeof finish.taskId === "string" && finish.taskId.length > 0 && typeof finish.at === "string"
    && (finish.outcome === "moved" || finish.outcome === "already-done");
}

function isTaskFinishWait(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const wait = value as Record<string, unknown>;
  return typeof wait.taskId === "string" && wait.taskId.length > 0 && typeof wait.since === "string" && isStringList(wait.open);
}

/** Validation of a parsed record is total. A nested value of the wrong type
    can throw inside a shape check (for example String({toString: null})); that
    makes this record unreadable, while the JSON parser remains strict. */
export function isPipeline(value: unknown): value is Pipeline {
  try { return isPipelineShape(value); }
  catch { return false; }
}

/** Shared total validator for persisted projections that must match the
 * authoritative pipeline reader's admission contract. */
export function isStoredPipeline(value: unknown): value is Pipeline {
  return isPipeline(value);
}

export function isPipelineConversationSource(value: unknown): value is NonNullable<Pipeline["conversationSource"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return Object.keys(source).length === 4
    && typeof source.conversationId === "string" && /^conversation_[A-Za-z0-9_-]{1,180}$/.test(source.conversationId)
    && typeof source.branch === "string" && source.branch.length > 0 && source.branch.length <= 1024
    && !/[\s\x00-\x1f]/u.test(source.branch)
    && typeof source.head === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source.head)
    && typeof source.capturedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.capturedAt)
    && Number.isFinite(Date.parse(source.capturedAt)) && new Date(source.capturedAt).toISOString() === source.capturedAt;
}

/** Format five is the rollback reader for format six. New integration
 * records stay opaque until the implementation of their authority is present. */
export function needsIntegrationReader(value: unknown): boolean {
  if (PIPELINES_SCHEMA_VERSION >= 6 || !value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return "adoptedCreationRequest" in record || "adoptedCreationRequests" in record
    || !!record.merge && typeof record.merge === "object" && "integration" in record.merge;
}

function isPipelineShape(value: unknown): value is Pipeline {
  if (needsIntegrationReader(value)) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pipeline = value as Partial<Pipeline>;
  if (!(
    typeof pipeline.id === "string" &&
    (pipeline.proactiveTaskIds === undefined || Array.isArray(pipeline.proactiveTaskIds)
      && pipeline.proactiveTaskIds.length === 1 && pipeline.proactiveTaskIds.every(id => typeof id === "string" && !!id)) &&
    (pipeline.conversationSource === undefined || isPipelineConversationSource(pipeline.conversationSource)) &&
    isCloseCustody(pipeline) &&
    (pipeline.activationCloseRequested === undefined || typeof pipeline.activationCloseRequested === "boolean") &&
    (pipeline.delivery === undefined || (isDelivery(pipeline.delivery) && (!pipeline.delivery.active || pipeline.delivery.ownerId === pipeline.id))) &&
    isPublicationRecovery(pipeline.publicationRecovery) &&
    (pipeline.creationRequest === undefined || (typeof pipeline.creationRequest.key === "string" && !!pipeline.creationRequest.key && typeof pipeline.creationRequest.digest === "string")) &&
    (pipeline.refreshOf === undefined || isRefreshOf(pipeline.refreshOf)) &&
    typeof pipeline.task === "string" &&
    Array.isArray(pipeline.taskIds) &&
    pipeline.taskIds.every((taskId) => typeof taskId === "string") &&
    new Set(pipeline.taskIds).size === pipeline.taskIds.length &&
    (pipeline.creationIntent === undefined || isCreationIntent(pipeline.creationIntent)) &&
    (pipeline.spec === undefined || typeof pipeline.spec === "string") &&
    (pipeline.inputContext === undefined || isStagePromptContext(pipeline.inputContext)) &&
    typeof pipeline.project === "string" &&
    typeof pipeline.repoDir === "string" &&
    typeof pipeline.worktreeDir === "string" &&
    typeof pipeline.branch === "string" &&
    typeof pipeline.baseBranch === "string" &&
    typeof pipeline.baseRef === "string" &&
    (pipeline.baseRefPinned === undefined || typeof pipeline.baseRefPinned === "boolean") &&
    typeof pipeline.lastPassedCommit === "string" &&
    (pipeline.publication === undefined || pipeline.publication === "internal" || pipeline.publication === "remote-branch") &&
    (pipeline.publishedCommit === undefined || isNullableString(pipeline.publishedCommit)) &&
    (pipeline.publicationProducerRepairs === undefined
      || Number.isSafeInteger(pipeline.publicationProducerRepairs) && Number(pipeline.publicationProducerRepairs) >= 0) &&
    Array.isArray(pipeline.stages) &&
    pipeline.stages.every(isStage) &&
    Array.isArray(pipeline.runs) &&
    pipeline.runs.every(isRun) &&
    ["draft", "provisioning", "running", "needs_decision", "needs_review", "paused", "completed", "closed"].includes(String(pipeline.state)) &&
    (pipeline.pausedState === null || ["provisioning", "running", "needs_decision", "needs_review", "completed", "closed"].includes(String(pipeline.pausedState))) &&
    (pipeline.pausedAt === undefined || isNullableString(pipeline.pausedAt)) &&
    (pipeline.pause === undefined || (pipelinePauseInputSchema.safeParse(pipeline.pause).success
      && (pipeline.pause.actor === undefined || pipeline.pause.actor === null || isActor(pipeline.pause.actor)))) &&
    (pipeline.resumedAt === undefined || isNullableString(pipeline.resumedAt)) &&
    (pipeline.controlGeneration === undefined || (typeof pipeline.controlGeneration === "string" && pipeline.controlGeneration.length > 0)) &&
    isNullableString(pipeline.stateDetail) &&
    isNullableString(pipeline.srcPath) &&
    isNullableString(pipeline.srcConversationId) &&
    (pipeline.srcDeputyConversationId === undefined || isNullableString(pipeline.srcDeputyConversationId)) &&
    typeof pipeline.createdAt === "string" &&
    isNullableString(pipeline.closedAt) &&
    (pipeline.hiddenAt === undefined || isNullableString(pipeline.hiddenAt)) &&
    (pipeline.dismissedAt === undefined || isNullableString(pipeline.dismissedAt)) &&
    (pipeline.dismissedBy === undefined || pipeline.dismissedBy === null || isDismissedBy(pipeline.dismissedBy)) &&
    (pipeline.unconfirmedHosts === undefined
      || (Array.isArray(pipeline.unconfirmedHosts) && pipeline.unconfirmedHosts.every(isUnconfirmedHost))) &&
    (pipeline.hostTerminationProofs === undefined || isHostTerminationProgress(pipeline.hostTerminationProofs)) &&
    (pipeline.terminalReap === undefined || isTerminalReap(pipeline.terminalReap)) &&
    (pipeline.restored === undefined || typeof pipeline.restored === "boolean") &&
    (pipeline.decisionAnswers === undefined || (Array.isArray(pipeline.decisionAnswers) && pipeline.decisionAnswers.every(isDecisionAnswer))) &&
    (pipeline.reviewPending === undefined || isReviewPending(pipeline.reviewPending)) &&
    (pipeline.reviewGrants === undefined || (Array.isArray(pipeline.reviewGrants) && pipeline.reviewGrants.every(isReviewGrant))) &&
    (pipeline.reviewAcceptances === undefined || (Array.isArray(pipeline.reviewAcceptances) && pipeline.reviewAcceptances.every(isReviewAcceptance))) &&
    (pipeline.merge === undefined || isPipelineMerge(pipeline.merge)) &&
    (pipeline.issueDelivery === undefined || (Array.isArray(pipeline.issueDelivery) && pipeline.issueDelivery.every(isIssueDelivery))) &&
    (pipeline.finishesTaskIds === undefined || (isStringList(pipeline.finishesTaskIds) && new Set(pipeline.finishesTaskIds).size === pipeline.finishesTaskIds.length)) &&
    (pipeline.taskFinishes === undefined || (Array.isArray(pipeline.taskFinishes) && pipeline.taskFinishes.every(isTaskFinish))) &&
    (pipeline.taskFinishWaits === undefined || (Array.isArray(pipeline.taskFinishWaits) && pipeline.taskFinishWaits.every(isTaskFinishWait))) &&
    (pipeline.legacyReviewConversions === undefined || (Array.isArray(pipeline.legacyReviewConversions)
      && pipeline.legacyReviewConversions.length <= MAX_LEGACY_REVIEW_CONVERSIONS && pipeline.legacyReviewConversions.every(isLegacyReviewConversion))) &&
    (pipeline.graphEdits === undefined || (Array.isArray(pipeline.graphEdits) && pipeline.graphEdits.length <= MAX_PIPELINE_GRAPH_EDITS && pipeline.graphEdits.every(isGraphEdit))) &&
    (pipeline.publicationAdmission === undefined || (Boolean(pipeline.publicationAdmission && typeof pipeline.publicationAdmission === "object")
      && typeof pipeline.publicationAdmission.id === "string" && /^[0-9a-f]{40}$/i.test(pipeline.publicationAdmission.sha)
      && /^[0-9a-f]{64}$/.test(pipeline.publicationAdmission.fence) && ["pending", "settled"].includes(pipeline.publicationAdmission.state)
      && (pipeline.publicationAdmission.error === undefined || typeof pipeline.publicationAdmission.error === "string"))) &&
    (pipeline.remoteAction === undefined || (Boolean(pipeline.remoteAction && typeof pipeline.remoteAction === "object")
      && typeof pipeline.remoteAction.id === "string" && ["retry-stage", "takeover", "skip-stage"].includes(pipeline.remoteAction.action)
      && ["pending", "settled"].includes(pipeline.remoteAction.state) && typeof pipeline.remoteAction.fence === "string"
      && /^[0-9a-f]{64}$/.test(pipeline.remoteAction.fence)
      && typeof pipeline.remoteAction.at === "string" && (pipeline.remoteAction.actor === null || isActor(pipeline.remoteAction.actor))
      && (pipeline.remoteAction.settledAt === undefined || typeof pipeline.remoteAction.settledAt === "string")
      && (pipeline.remoteAction.error === undefined || typeof pipeline.remoteAction.error === "string")
      && (pipeline.remoteAction.retryReceipt === undefined || (Boolean(pipeline.remoteAction.retryReceipt)
        && typeof pipeline.remoteAction.retryReceipt.launchId === "string"
        && ["failed", "conflicted", "completed"].includes(pipeline.remoteAction.retryReceipt.state)
        && (pipeline.remoteAction.retryReceipt.claimId === undefined || typeof pipeline.remoteAction.retryReceipt.claimId === "string")))
      && (pipeline.remoteAction.action !== "takeover" || (Boolean(pipeline.remoteAction.takeover)
        && typeof pipeline.remoteAction.takeover?.expectedOwner === "string"
        && Number.isSafeInteger(pipeline.remoteAction.takeover?.expectedEpoch) && pipeline.remoteAction.takeover!.expectedEpoch > 0
        && typeof pipeline.remoteAction.takeover?.reason === "string" && pipeline.remoteAction.takeover.reason.length > 0)))) &&
    (pipeline.stageReports === undefined || (Array.isArray(pipeline.stageReports) && pipeline.stageReports.length <= MAX_PIPELINE_STAGE_REPORTS && pipeline.stageReports.every(isStageReportEntry))) &&
    (pipeline.taskClass === undefined || laneClassSchema.safeParse(pipeline.taskClass).success) &&
    (pipeline.pos === undefined || (
      typeof pipeline.pos === "object" && pipeline.pos !== null &&
      Number.isFinite(pipeline.pos.x) && Number.isFinite(pipeline.pos.y)
    ))
  )) return false;
  const stages = pipeline.stages as PipelineStage[];
  const runs = pipeline.runs as Pipeline["runs"];
  /* A draft is a scratchpad the operator assembles on the canvas (#136), so it
     may hold 0–8 stages (v2 legacy shells are seeded on migration, but a raw
     empty draft still loads and stays off the board projection). Closing or
     deleting that draft preserves its empty graph in the closed record
     (#1789). Every other state keeps the 1–8 invariant (#353: the minimum
     started graph is one implement conversation). */
  const minStages = pipeline.state === "draft" || pipeline.state === "closed" ? 0 : 1;
  if (stages.length < minStages || stages.length > MAX_PIPELINE_STAGES || runs.length !== stages.length) return false;
  const ids = stages.map((stage) => stage.id);
  if (new Set(ids).size !== ids.length) return false;
  if (pipelineGraphError(stages, { legacyReachability: false }) !== null) return false;
  if (runs.some((run, index) => run.stageId !== stages[index]!.id)) return false;
  const expectedWorktree = path.join(path.dirname(pipeline.repoDir!), `${path.basename(pipeline.repoDir!)}-pipeline-${pipeline.id}`);
  if (pipeline.worktreeDir !== expectedWorktree || pipeline.branch !== `pipeline/${slugify(pipeline.task!)}-${pipeline.id}`) return false;
  const cursor = pipeline.cursor;
  if (cursor !== null && (
    !cursor ||
    typeof cursor !== "object" ||
    !ids.includes(cursor.stageId) ||
    !["pending", "spawning", "running", "reviewing", "committing"].includes(cursor.state) ||
    (cursor.admittedAt !== undefined && !Number.isFinite(Date.parse(cursor.admittedAt))) ||
    (cursor.repeatReason !== undefined && !repeatReasonSchema.safeParse(cursor.repeatReason).success) ||
    !(cursor.input === undefined || isNullableString(cursor.input)) ||
    !isActivation(cursor.activatedBy) ||
    (cursor.activatedBy != null && !ids.includes(cursor.activatedBy.stageId))
  )) return false;
  if ((pipeline.state === "completed" || pipeline.state === "closed") && cursor !== null) return false;
  if (pipeline.state === "draft") {
    /* An empty draft has no stage to point the cursor at; once it holds stages the
       cursor rests on the first, pending (Start spawns from there). */
    if (stages.length === 0) {
      if (cursor !== null) return false;
    } else if (cursor?.stageId !== stages[0]!.id || cursor.state !== "pending") return false;
    if (runs.some((run) => run.attempts.length > 0)) return false;
    const baseEmpty = !pipeline.baseBranch && !pipeline.baseRef && !pipeline.lastPassedCommit;
    const basePinned = Boolean(
      pipeline.baseBranch &&
      /^[0-9a-f]{40}$/i.test(pipeline.baseRef!) &&
      pipeline.lastPassedCommit === pipeline.baseRef,
    );
    if ((!baseEmpty && !basePinned) || pipeline.closedAt) return false;
  }
  return true;
}


export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}
