import { createHash } from "node:crypto";
import { latestOperationalStageAttempt } from "./attemptSelection";
import type { Pipeline, PipelineStageAttempt } from "./types";

/** Explicit v1 inputs. Full-record revisions retain their existing meaning. */
function pick<T extends object>(record: T | null | undefined, keys: readonly (keyof T)[]) {
  return record == null ? null : Object.fromEntries(keys.map(key => [key, record[key] ?? null]));
}

function canonical(value: unknown): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

export function passedStagePublicationPark(pipeline: Pipeline, attempt: PipelineStageAttempt | null): boolean {
  const detail = pipeline.stateDetail;
  return pipeline.cursor?.state === "committing" && attempt !== null
    && (attempt.verdict?.status === "pass" || attempt.acceptedForReview === true)
    && (detail?.startsWith("publishing the passed stage:") === true
      || ((attempt.state === "passed" || attempt.state === "needs_decision") && (detail?.startsWith("the worktree moved to ") === true
        || detail?.startsWith("the accepted head cannot be verified before completion:") === true)));
}

/** Custody can refuse a pass before its head is accepted or completedAt is
 * recorded. A guarded answer may retire that attempt for a fresh repair, or
 * publish with acceptedSha accepts its reviewed clean head in place. */
export function passedStageCustodyPark(pipeline: Pipeline, attempt: PipelineStageAttempt | null): boolean {
  const detail = pipeline.stateDetail;
  return pipeline.cursor?.state === "committing" && attempt?.state === "needs_decision"
    && attempt.verdict?.status === "pass" && (detail?.startsWith("settling the stage push:") === true
      || detail?.startsWith("stage push refused:") === true);
}

const definitionKeys = ["id", "kind", "runtime", "role", "engine", "model", "effort", "serviceTier", "preferredServiceTier",
  "agentMemoryMaxBytes", "access", "sandbox", "outputs", "account", "prompt", "next", "onFail", "effectiveRole"] as const;
const producerKeys = ["n", "historical", "launchId", "conversationId", "sessionId", "agentPath", "paneId", "accountId",
  "hostEpoch", "startedAt", "completedAt", "runtimeEvidenceSince", "runtimeSwitches", "definition", "effectiveRole"] as const;

/** Computed only for the current settled decision, before any display projection.
 * The keep-list is versioned in docs/design/stage-decision-revision-contract.md.
 * It deliberately excludes terminal-reap progress and presentation metadata.
 * This identity conveys no caller permission; admission rechecks live authority.
 */
export function pipelineDecisionRevision(p: Pipeline): string | null {
  const stage = p.stages.find(stage => stage.id === p.cursor?.stageId);
  const a = stage && latestOperationalStageAttempt(p, stage.id);
  if (p.state !== "needs_decision" || stage?.kind !== "run" || !a) return null;
  const custody = passedStageCustodyPark(p, a);
  const publication = passedStagePublicationPark(p, a) || custody;
  if ((!a.completedAt && !custody) || (!publication && (a.state !== "needs_decision" || a.verdict?.status !== "needs_decision"))) return null;
  const repairStage = p.stages.find(stage => stage.id === a.publicationRepair?.stageId);
  const repair = repairStage && p.runs.find(run => run.stageId === repairStage.id)?.attempts
    .find(item => item.n === a.publicationRepair?.attempt && !item.historical);
  const recoveryKey = p.delivery?.operation?.sha ?? a.publicationRepair?.sha ?? p.lastPassedCommit;
  const projection = {
    domain: "pipeline.resolve-decision", v: 1,
    pipeline: {
      ...pick(p, ["id", "project", "task", "taskIds", "finishesTaskIds", "spec", "srcPath", "srcConversationId", "srcDeputyConversationId",
        "creationRequest", "proactiveTaskIds", "decisionAnswers", "repoDir", "worktreeDir", "branch", "baseBranch", "baseRef", "baseRefPinned",
        "lastPassedCommit", "publishedCommit", "publication", "refreshOf", "state", "pausedState", "pausedAt", "pause", "resumedAt", "controlGeneration",
        "closedAt", "hiddenAt", "activationCloseRequested", "remoteAction", "cursor", "publicationAdmission", "reviewPending", "reviewGrants",
        "reviewAcceptances", "legacyReviewConversions", "closeTeardown", "unconfirmedHosts", "pendingReviewFlowCleanup"]),
      inputContext: pick(p.inputContext, ["taskDetails", "skillPaths", "handoffDigest"]),
      workspace: pick(p.workspace, ["memberId", "workspaceId"]),
      graphEditSeq: p.graphEdits?.at(-1)?.seq ?? null,
      stateDetail: publication ? p.stateDetail : null,
      publicationRecovery: p.publicationRecovery?.[recoveryKey] ?? null,
      delivery: pick(p.delivery, ["target", "disposition", "publish", "ownerId", "epoch", "active", "releasedAt", "settledFailure", "operation"]),
    },
    stages: p.stages.map(stage => pick(stage, definitionKeys)),
    attempt: {
      ...pick(a, ["n", "historical", "legacyReview", "state", "input", "output", "verdict", "report", "startedAt", "completedAt", "error", "decisionRequested",
        "decisionAnswerId", "launchId", "conversationId", "sessionId", "agentPath", "paneId", "accountId", "hostEpoch", "runtimeEvidenceSince", "runtimeAccountPin",
        "executionRuntime", "cloud", "flowId", "definition", "effectiveRole", "activation", "suspension", "runtimeSwitches", "accountHolds", "usageLimitedAccounts",
        "providerWait", "restoreContinuation", "restartRecovery", "restartContext", "severedTurn", "roleMemoryDelivery", "roleMemoryDispatchWait", "startupOwnerWait",
        "unresolvedTermination", "priorWriterStop", "branchAdoption", "backgroundWait", "verdictRequest", "verdictRecovery", "activatedBy", "launchedBy", "budgetSpent",
        "reviewedHead", "expectedReviewHeadSha", "reviewHeadSha", "acceptedForReview", "publicationIntegration", "providerRecoveryBudget", "providerFallbackRetries",
        "spawnAdmissionBudget", "spawnCalls", "fencedMessageRetries", "excludedRecordedChecks", "memoryCap", "controllerWait", "memoryWait", "remoteHeadWait",
        "settlementPreparationWait", "settlementAdmissionRetry", "spawnInterruptionRetry", "stageCommitWait", "pullRequestInspection", "roleMemoryFailures",
        "commitRepair", "publicationRepair", "publicationRepairAbandonment", "publicationRetry", "publicationTextRepair", "terminalOutputPublication"]),
      runLength: p.runs.find(run => run.stageId === stage.id)!.attempts.length,
      setup: pick(a.setup, ["command", "cwd", "hash", "state", "startedAt", "completedAt", "code"]),
      reviewFlowSync: pick(a.reviewFlowSync, ["generation", "sourceRevision", "roundCount", "implementerHeadSha", "reviewerHeadSha", "verdict", "relayState", "terminalState", "hostClaim"]),
    },
    repairProducer: { stageId: repair ? repairStage!.id : stage.id, attempt: pick(repair ?? a, producerKeys) },
    reviewRuns: p.runs.map(run => ({ stageId: run.stageId, attempts: run.attempts.map(item => pick(item,
      ["n", "historical", "legacyReview", "activatedBy", "budgetSpent", "reviewedHead", "state", "completedAt", "verdict", "reviewHeadSha", "expectedReviewHeadSha", "acceptedForReview"])) })),
    custodyRuns: p.runs.map(run => ({ stageId: run.stageId, attempts: run.attempts.map(item => pick(item, ["n", "activation", "unresolvedTermination"])) })),
  };
  return createHash("sha256").update(JSON.stringify(canonical(projection))).digest("hex");
}
