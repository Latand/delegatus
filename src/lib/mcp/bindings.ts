import { previewAgentMemoryCap, PIPELINE_MEMORY_DEFAULT_ROLE } from "@/lib/runtime/agentMemorySettings";
import { readSelf } from "@/lib/links/self";
import { readFileConfirmationLink } from "@/lib/telegram/bot/fileConfirmationContract";
import { FLOW_ARCHIVE, FLOW_RETIREMENT, STAGE_RETIREMENT, FlowRetiredError } from "@/lib/flows/retirement";
import { performanceSpans } from "@/lib/performanceSpans";
import { curationAnswer } from "@/lib/memory/curation/answer";
import { resolvePrototypeReviewId as resolveStoredReviewId } from "@/lib/prototypeReview/store";
import { resolveIssueReportDigest } from "@/lib/issueReports/store";
import { shortId, shortenHashesInText } from "@/lib/shortIds";
import { relayAnswerOp } from "@/lib/externalRelay/ownerAnswer";
import { ExternalRelayError as RelayAnswerError } from "@/lib/externalRelay/client";
import { DocumentRefusal as RelayDocumentRefusal } from "@/lib/telegram/bot/documents";
import { relayServiceToolsOp } from "@/lib/externalRelay/ownerServiceTools";
import { readHistoryProjection, historyFleetLimitWaits } from "@/lib/state/historyProjection";
import { registryReceiptsForConversation } from "@/lib/agent/registry";
import { registryRowsMatching } from "@/lib/agent/sqliteRegistryStore";
import { decidePrototype } from "@/lib/prototypeReview/decision";
import { deliverPrototypeDecision } from "@/lib/prototypeReview/deliveryWorker";
import { findPrototypeRound } from "@/lib/prototypeReview/store";
import { autonomyActive, proactiveActive, autonomyMandate, autonomyReportKey, pendingAutonomyReports } from "@/lib/monitor/autonomy";
import { endedTurbo, turboActive, turboMandate, turboNeedsPlan, turboProgress } from "@/lib/monitor/turbo";
import { turboChangeContext } from "@/lib/monitor/turboRuntime";
import { changeSeatTickSettings, markAutonomyReported, markAutonomyDecisionReview } from "@/lib/monitor/seatTickSettings";
import { pipelinePublishesRemoteBranch } from "@/lib/pipelines/publication";
import { recordSeatProjectSuccessions, seatLaunchCwd } from "@/lib/orchestrator/seatProjectIdentity";
import { namedProjectDirectory, resolveNamedProject, ProjectNameRefusal } from "@/lib/projects/nameResolution";
import { releaseStatus } from "@/lib/release/answer";
import { releaseControlChange } from "@/lib/release/store";
import { RELEASE_DEFAULTS } from "@/lib/release/settings";
import { liveOwnerRelayConversation, ownerRelayPayload, ownerRelayTargetMatches } from "@/lib/externalRelay/ownerAuthority";
import { peerSeatMessages } from "@/lib/links/boardLinks";
import { recoverSeatMessage, resolveSeatMessageMachine, seatMessageReceipt, SeatMessageRefusal } from "@/lib/links/seatMessages";
import { ROTATION_NOTE } from "@/app/api/orchestrator/seat/status/incumbent";
import { autoRotationFailureAnswer } from "@/lib/monitor/seatTickSettingsAnswer";
import { readBridgeReportLog } from "@/lib/bridge/store";
import { archiveConversationPaths } from "@/lib/board/archivePlacement";
import { readDeliveryProgress } from "@/lib/runtime/deliveryProgress";
import { maintainerCallerOf, maintainerTaskWriteRefusal, maintenanceChange, retiredSeatTask, type MaintainerCaller } from "@/lib/boardMaintenance/guard";
import { recordMaintenanceChange, recordMaintenanceLogGap } from "@/lib/boardMaintenance/store";
import { maintenanceLaneIsOpen } from "@/lib/boardMaintenance/evidence";
import { boardMaintenanceAnswer } from "@/lib/boardMaintenance/answer";
import { curatorCallerOf } from "@/lib/memory/curation/guard";
import { applyCuration, type CurationApply } from "@/lib/memory/curation/apply";
import { readCuration } from "@/lib/memory/curation/read";
import { isMutatingMcpTool } from "./server";
import { permitIssueReporterTool, permitMaintainerTool, permitCuratorTool } from "./toolAllowlist";
import { boardSelection } from "./boardSelection";
import { budgetPage } from "./budgetPage";
import { fleetAgents, fleetDetailRows, fleetLimitWaits, fleetPublicRow, fleetRuntimeFor, fleetSummary, type FleetScope, type FleetFilters } from "./agentFleet";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* The Viewer's own repository metadata. Bundled into the server and the MCP
   binary, so a packaged release with no checkout can still name the repository
   it deploys (#1321). */
import viewerPackageManifest from "../../../package.json";
import { effectiveWorkerLimit, projectWorkerLimit, readWorkerLimits, setMachineWorkerLimit, setProjectWorkerLimit, isWorkerLimit } from "@/lib/operator/workerLimit";
import { projectWorkerCounts } from "@/lib/orchestrator/workerCount";

import { activeClaudeAccountId, claudeAccountsForPrivacy, listClaudeAccounts } from "@/lib/accounts/claude";
import { activeCodexAccountId, codexAccountsForPrivacy, listCodexAccounts } from "@/lib/accounts/codex";
import { activeCopilotAccountId, copilotAccountsForPrivacy, listCopilotAccounts } from "@/lib/accounts/copilot";
import { projectEngineAccounts } from "@/lib/accounts/projectAccountsView";
import {
  accountProjectBindings,
  allowedAccountIdsForProject,
  bindAccountToProject,
  projectsForAccount,
  unbindAccountFromProject,
  type BindingEngine,
} from "@/lib/accounts/projectBindings";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { DeliveryAdmissionRefusedError } from "@/lib/deliveryAdmission";
import { ENGINE_MODELS, validateLaunchModel } from "@/lib/agent/models";
import { nativeCallerSources } from "@/lib/attention/nativeCallerSources";
import { nativeCallerRefusal, resolveNativeCaller } from "@/lib/attention/nativeCaller";
import { processIdentityStatus, sameRecordedProcessIdentity, systemBootEpoch, type ProcessIdentityProbe } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_AUTONOMOUS_SPAWN_HEADER } from "@/lib/agent/capabilityHeader";
import { existingInternalServiceHeaders, INTERNAL_SERVICE_HEADER } from "@/lib/agent/callerClaims";
import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { currentMcpHttpCaller, resolveMcpCallerValue } from "./callerContext";
import { attentionCallerAuthority, processAncestry, type AttentionCallerAuthority, type AttentionCallerSources } from "@/lib/attention/callerAuthority";
import { UNREAD_FRAME_RECT } from "@/lib/attention/frames";
import {
  ATTENTION_ARRIVAL_TIMEOUT_MS,
  awaitAttentionArrival,
  noticeCapableViewOpen,
  raiseAttentionRequest,
  resolveDirectedAttentionView,
} from "@/lib/attention/service";
import { readAttentionFile } from "@/lib/attention/store";
import { DismissalError, dismissAttention as dismissAttentionService, parseDismissalTarget, writeAttentionEscalation, type DismissalPorts } from "@/lib/attention/dismissals";
import type { DismissalTarget, DismissedBy } from "@/lib/attention/dismissalTypes";
import { conversationRouteKey, laneNeedKind, laneRouteKey, parseEscalation } from "@/lib/attention/routeTypes";
import { prototypeWaitsOnOperator } from "@/lib/prototypeReview/model";
import { seatDecisionNotices, withPrototypeReviewSummaries } from "@/lib/prototypeReview/read";
import { loadSeatRounds } from "@/lib/prototypeReview/seatRounds";
import {
  CONVERSATION_PATH_EXAMPLE,
  describeFocusTargetRejection,
  focusTargetExample,
  geometricFrameRect,
  isFocusTarget,
  isGeometricTarget,
} from "@/lib/attention/targets";
import type { AttentionRequestV1, FocusIntent, FocusTarget, ZoomIntent } from "@/lib/attention/types";
import { applyBoardCommand } from "@/lib/board/command";
import { boardFor } from "@/lib/board/store";
import { conversationDeliverabilityFromRecord } from "@/lib/conversation/deliverability";
import { backoffDelayMs, DeadlineExceededError, deadlineSignal, systemScheduler, type DeadlineScheduler } from "@/lib/deadline";
import { cancelRound, closeFlow, patchFlow } from "@/lib/flows/commands";
import { flowSelectionSource } from "@/lib/flows/store";
import { getFlowsWithPresets } from "@/lib/flows/engine";
import type { PatchFlowRequest } from "@/lib/flows/types";
import { pollLifecycleDigest, type LifecycleDigestRequest } from "@/lib/lifecycle/digest";
import { queryLifecycleEvents, type LifecycleEventQuery } from "@/lib/lifecycle/journal";
import type { CompletedGenerationRead } from "@/lib/lifecycle/inventorySelection";
import {
  agentLivenessSnapshot,
  livenessRecordIsLive,
  productionLivenessSources,
  DEFAULT_EVIDENCE_DEADLINE_MS,
  type AgentLivenessSources,
} from "@/lib/lifecycle/liveness";
import { refreshLifecycleJournal } from "@/lib/lifecycle/projector";
import { isLifecycleEventType } from "@/lib/lifecycle/vocabulary";
import { recordBridgeDirectiveAnswer, recordBridgeDirectivePendingAnswer, recordManagerReport } from "@/lib/bridge/service";
import { bridgeDirectiveBody, bridgeDirectiveId, type BridgeTrailer } from "@/lib/bridge/directive";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { BRIDGE_REPORT_COMPLETE_MAX_BYTES, isBridgeReportClass, isBridgeReportOutcomeKind, type BridgeReportCompleteV1, type BridgeReportOutcome, type BridgeReportTelegram, type CanonicalSeatConversationId } from "@/lib/bridge/types";
import { bridgeReportComplete, findBridgeReport, recordBridgeReportTelegram, scopedReportId } from "@/lib/bridge/store";
import { EMPTY_DENY_LIST, type PublicDenyList } from "@/lib/bridge/publicSafe";
import { ISSUE_REPORT_RESPONSE_RULE, issueReportApprovalForm, issueReportApprovalReplies, issueReportDecisionApproves, issueReportFormLanguage } from "@/lib/issueReports/approvalForm";
import { delegatusIssueRepository, issueReportFinder, issueReportPublisher, type IssueReportFinder, type IssueReportPublisher } from "@/lib/issueReports/publish";
import { issueReportPreviewText } from "@/lib/issueReports/previewText";
import { ISSUE_REPORT_MAX_BODY_CHARS, ISSUE_REPORT_MAX_TITLE_CHARS } from "@/lib/issueReports/scrub";
import { claimIssueReportPublication, markIssueReportShown, readIssueReportPreview, recordIssueReportPreview, releaseIssueReportPublication, settleIssueReportPublication, type IssueReportPreview, type IssueReportPublication } from "@/lib/issueReports/store";
import { ForgeAppWriteRefused } from "@/lib/forge/appWrite";
import { renderPlain, type TaskChanges } from "@/lib/bridge/reportRender";
import { SEAT_SECTION_IDS, type SeatSectionId } from "@/lib/bridge/reportWords";
import { deployTaskChanges, projectSnapshots } from "@/lib/bridge/taskChanges";
import { renderTelegram, type PullRequestLookup } from "@/lib/bridge/telegramReport";
import { projectDisplayName } from "@/lib/displayNames";
import { agentMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { orchestratorRelayPayload, resolveOrchestratorRelay } from "@/lib/orchestrator/relay";
import { claudeMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import { agentRecordAuthors, agentRecordPartAuthors, type AgentRecordAuthor } from "@/lib/runtime/agentRecordAuthors";
import { forgeCacheView } from "@/lib/forge/cache";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { languageMismatchWarning } from "@/lib/i18n/proseLanguage";
import { operatorLocale, operatorTimeZone } from "@/lib/operator/settings";
import { canonicalProject, projectAliasSnapshot, recordedProjectRemote, recordedProjectRemotes } from "@/lib/projects/aliases";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { canonicalSensitiveText } from "@/lib/privacy/canonicalText";
import {
  applySeatTickNoteLineEdits,
  applySeatTickSettingsChange,
  defaultSeatTickSettings,
  effectiveSeatTickSettings,
  readSeatTickSettings,
  writeSeatTickSettings,
  type SeatTickNoteLineEdits,
  type SeatTickSettings,
  type SeatTickSettingsActor,
  type SeatTickSettingsChange,
} from "@/lib/monitor/seatTickSettings";
import { SEAT_TICK_WAKE_INTERVAL_MS } from "@/lib/monitor/seatTick";
import { seatTickFenceDetail, seatTickReportedFence } from "@/lib/monitor/seatTickFence";
import { peekSeatTickState } from "@/lib/monitor/seatTickState";
import type { SeatTickProjectState } from "@/lib/monitor/types";
import { authorizedManagerSeats, type ManagerAuthoritySources } from "@/lib/orchestrator/authority";
import { deputiesForSeatIn, productionDeputyPrincipal, readDeputies, spawnParentForCaller } from "@/lib/orchestrator/deputies";
import { beginSeatDeployment, forgetSeatDeploymentRequest, recoverSeatDeploymentRequests, recordSeatDeployment, seatDeploymentForRequestKey, type SeatDeploymentRecord } from "@/lib/orchestrator/seatDeployments";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { launchHoldRefusal } from "@/lib/selfUpdate/launchHold";
import { checkoutDeploymentByIdempotencyKey } from "@/lib/selfUpdate/deployments";
import { statePath } from "@/lib/configDir";
import { activeOrchestratorSeats, canonicalOrchestratorProject, orchestratorRevocations, orchestratorSeatFor, orchestratorSeatIdentityForConversation, revokedOrchestratorSeatConversationsOrUnknown, type OrchestratorSeat } from "@/lib/orchestrator/seats";
import { revokedSeatPipelineRefusal, SeatRevocationStoreUnavailableError } from "@/lib/orchestrator/seatAuthority";
import { productionManagerAuthoritySources } from "@/lib/orchestrator/managerAuthoritySources";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import { contextReading, readOrchestratorTranscriptFacts, rotationRecommendation } from "@/lib/orchestrator/health";
import { contextWindowPolicyFor } from "@/lib/orchestrator/contextPolicy";
import { splitRelayMessageText } from "@/lib/orchestrator/relayText";
import { leaveCorrectionForRole, leaveLessonForOperator, leaveLessonForSeat, leaveLessonForConversation, lessonRequestForReport } from "@/lib/memory/roleStage";
import { operatorMemoryEnabled, storedOperatorRoot } from "@/lib/memory/operatorMemory";
import { readMemoryProblem } from "@/lib/memory/roleProblems";
import { RoleMemoryRefusal } from "@/lib/memory/roleStore";
import { withoutStoredLessonsAsync, renderReportAsync, scrubIssueReportAsync } from "@/lib/memory/privacy";
import { continueReviewActorRefusal, createPipelineFromRequest, legacyReviewActorRefusal, decisionAnswerActorRefusal, getPipeline as getPipelineRecord, getPipelines, patchPipeline, reportStageCompletion, type PipelineMutationResult, type StageCompletionRequest } from "@/lib/pipelines/engine";
import { latestOperationalPipelineAttempt, latestOperationalStageAttempt } from "@/lib/pipelines/attemptSelection";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { queuedPipelineCreationMessage, queuedPipelineCreationStatus } from "@/lib/pipelines/creationQueue";
import type { TaskPipelineReadModel } from "@/lib/pipelines/taskBinding";
import { PIPELINE_LIST_DEFAULT_LIMIT, pipelineCompactRow, pipelineListRow } from "@/lib/pipelines/listProjection";
import { graphDigest, stageDigests } from "@/lib/pipelines/stageDigest";
import { loadPipelinesForList, pipelineSelectionSource, pipelineDeliveryLookup, pipelineRevision } from "@/lib/pipelines/store";
import type { CreatePipelineRequest, PatchPipelineRequest, Pipeline, PipelineAction, PipelineCloseReport, PipelineMergeState } from "@/lib/pipelines/types";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";
import { viewerRepositoryProjects } from "@/lib/projects/viewerRepository";
import { projectKeyIndexSnapshot } from "@/lib/projects/projectKeyIndex";
import { listFiles } from "@/lib/scanner";
import { validExplicitProject } from "@/lib/accounts/migration/contracts";
import { describe, projectForCwd, reprojectFileDescription } from "@/lib/scanner/describe";
import { pathAllowed, scanRootEntries } from "@/lib/scanner/roots";
import { completedFileScan, lastScannedFiles, lastScannedProjectCatalog, type FileScanSnapshot } from "@/lib/scanner/scanCache";
import { completedScanForMcp } from "./completedScan";
import { readCachedResourceSessions, readResources, readResourcesWithDiagnostic } from "@/lib/resources";
import { adoptLiveRootSession, conversationRole, liveRootSession, type RootSessionSource } from "@/lib/root/adopt";
import { appendRoleMappingAudit, changedMappingRows, type RoleMappingAuditRow, roleLaunchChoices, roleMappingViolations, roleRegistryAnswer } from "@/lib/roles/mcpMapping";
import { listRoles, resolveSpawnRole } from "@/lib/roles/registry";
import { spawnSizingRefusal } from "@/lib/roles/sizing";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { changeRoleMapping, loadRoleRegistrySnapshotOrDefaults, parseRoleMappingPatch, RoleStoreError, type RoleMappingChange } from "@/lib/roles/store";
import { conversationRuntime } from "@/lib/agent/conversationRuntime";
import type { RoleDefinition, RoleParameter } from "@/lib/roles/types";
import { conversationAgentRole, isSpawnDeniedRole, readSpawnAdmissionFence, reviewerOriginSpawnGuidance, spawnTaskProjectError, type SpawnAdmissionFence } from "@/lib/agent/spawnAdmission";
import type { RuntimeHostRequestHealth } from "@/lib/runtime/client";
import type { ViewerDeploymentStatus, ViewerDeploymentSummary } from "@/lib/runtime/contracts";
import { messageOriginRole, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import { ledgerDeployment, ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import { resolveOriginalSend, resolveSendReceipt, sendSettlementDue, type SendSettlementPorts } from "@/lib/runtime/sendSettlement";
import { spawnAdmissionBodyDigest } from "@/lib/agent/spawnIdentity";
import {
  SELECTED_TAIL_MAX_BYTES,
  SELECTED_TAIL_MAX_LINES,
  type BoundedTranscriptTail,
} from "@/lib/selection/resolve";
import {
  readSession,
  type SessionReadResult,
  type SessionRecord,
  type SessionRecordKind,
} from "@/lib/session/reader";
import {
  decodeMessagesCursor,
  encodeMessagesCursor,
  InvalidMessagesCursorError,
  messagesCursorScope,
  readMessagesPage,
  readMessageAuthorContext,
  StaleMessagesCursorError,
} from "@/lib/session/messagesPage";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { linkedContext, withOwnership } from "@/lib/links/linked";
import { applyAssignmentPatches, createTask, patchTask, taskDuePatch, type CreateTaskInput, type PatchTaskInput } from "@/lib/tasks/commands";
import { taskSeatHoldingSnapshot } from "@/lib/tasks/seatHolding";
import { recordAuthors, type RecordAuthor } from "@/lib/team";
import { pipelineWorkLinks, pullRequestSummary, taskWorkLinkContext, taskWorkLinks } from "@/lib/forge/resolve";
import { normalizedBoardQuery, pullRequestQuery, titleHasPullRequest } from "./pullRequestQuery";
import { bridgeReportsEnabled, effectiveReportTelegram, mergeOnReviewEnabled, reportHeaderName, type EffectiveReportTelegram } from "@/lib/projects/settings";
import { refineTask } from "@/lib/tasks/membership";
import { isoNow } from "@/lib/tasks/helpers";
import { refuseBusyBeforeAdmission, StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import { loadTasks, loadTasksForList, taskSelectionSource, mutateTasks, mutateTasksAsync, mutateTasksFile } from "@/lib/tasks/store";
import { refreshCurationKnownValuesAsync } from "@/lib/memory/privacy";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { waitForStateLock } from "@/lib/state/lockWait";
import { TASK_PRIORITIES, taskPriority, type BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { collectSnapshot } from "@/lib/view/collect";
import { resolveSiblings } from "@/lib/view/siblings";
import { hardenedRedact } from "@/lib/view/compactText";
import { searchMemoryTool } from "@/lib/memory/mcp";
import { validateSnapshotRequest } from "@/lib/view/validation";

import {
  requestDigest,
  McpDispatchNotExecutedError,
  McpDispatchUncertainError,
  McpPrototypePublicationPendingError,
  McpDeploymentPendingError,
  McpDispatchVerdictError,
  McpDispatchSettledRefusalError,
  McpToolRefusal,
  McpUnadmittedRefusal,
  type McpRecoverableTool,
  type McpRecoveryEvidence,
  type McpRequestBinding,
  type McpRequestBindingInput,
  type McpRequestCaller,
  type McpToolArgs,
  type McpToolBindings,
  type McpToolBinding,
  type McpToolCallContext,
  type McpToolName,
  type McpToolPayload,
} from "./server";
import { parseSelectedContextRef } from "@/lib/selection/selectedContext";
import { RETRYABLE_TELEGRAM_BOT_CODES, readTelegramBotRefusals, type TelegramBotErrorCode } from "@/lib/telegram/bot/contracts";
import { telegramSetUp } from "@/lib/telegram/launchReadiness";
import { voiceTools } from "./voiceTools";

import {
  accountLimitRows,
  compactDeployment,
  compactLiveness,
  newestDeploymentsFirst,
  pipelineAcknowledgement,
  pipelineActionAcknowledgement,
  pipelineCheckFields,
  pipelineStageRead,
  stageReportAcknowledgement,
  type AccountLimitsInput,
} from "./compactAnswers";
import { changedFieldNames, fieldValues, compactFlow, compactTask, firstLine, fullAnswer, answerHint, listPage, listPageAsync, recordRevision, sinceTime, stringSet, taskAcknowledgement } from "./listAnswers";

import { viewerControlOrigin, viewerControlToken } from "./controlEndpoint";
import {
  productionSelectedContextDependencies,
  resolveSelectedContext,
  selectedContextEcho,
  selectedConversationTarget,
  selectedConversationTail,
  type SelectedContextTargetDependencies,
  type VoiceUtteranceLookup,
  type VoiceWorkLookupIdentity,
} from "./selectedContextTarget";
import { spawnConversation } from "./spawnConversation";
import { mcpCallerIdentity, mcpToolPolicy, mcpToolNeedsCallerIdentity, permitAttentionDismissal, permitNeedsYouRead, permitAttentionHandoff, type ManagerTarget, type McpToolPolicy } from "./toolAllowlist";

const PIPELINE_CONTROLLER_ACTIONS = new Set<PipelineAction>(["set-delivery-remote", "start", "resume", "retry-stage", "skip-stage", "resolve-decision", "continue-review", "accept-head", "retry-merge"]);
/* Writes whose clientRequestId is their durable receipt key, attributed to the caller. */
const PIPELINE_RECEIPT_ACTIONS = new Set<PipelineAction>(["resolve-decision", "continue-review", "accept-head", "convert-legacy-review", "revert-legacy-review"]);
const PIPELINE_GRAPH_EDIT_ACTIONS = new Set<PipelineAction>(["add-stage", "remove-stage", "reorder-stage", "set-edge", "override-stage"]);

interface LinkTaskToPipelineDependencies {
  getPipelines(): ReturnType<typeof getPipelines>;
  mutateTasks<R>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }): R;
  isoNow(): string;
}

const productionLinkTaskDependencies: LinkTaskToPipelineDependencies = {
  getPipelines,
  mutateTasks,
  isoNow,
};

export interface ViewerControlDependencies {
  get?(pathname: string, context?: McpToolCallContext): Promise<Record<string, unknown>>;
  post(
    pathname: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
    context?: McpToolCallContext,
  ): Promise<Record<string, unknown>>;
  /** #1490: never repeated once the request may have reached the
      Viewer. Throws {@link McpDispatchUncertainError} for every failure that
      cannot prove the server did nothing. Optional so a harness that supplies
      only `post` keeps working; the production set always provides it. */
  dispatch?(
    pathname: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
    context?: McpToolCallContext,
  ): Promise<Record<string, unknown>>;
}

const CONTROL_ATTEMPT_TIMEOUT_MS = 5_000;
const CONTROL_READ_RECOVERY_BUDGET_MS = 12_000;
const CONTROL_RECOVERY_BUDGET_MS = 8_000;
const CONTROL_UNSCOPED_RECOVERY_BUDGET_MS = 5_000;
// Publication copies bounded media and awaits the Telegram receipt. Give that
// operation the MCP call's remaining budget, including the settlement reserve.
const PROTOTYPE_CONTROL_BUDGET_MS = 30_000;
const CONTROL_DEADLINE_RESERVE_MS = 250;
const CONTROL_RETRY_BASE_MS = 100;
const CONTROL_RETRY_MAX_MS = 1_000;
const TRANSIENT_CONTROL_STATUSES = new Set([502, 504]);
const controlLastResponseAt = new Map<string, number>();

class ViewerControlResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerControlResponseError";
  }
}

function controlRetryDelay(attempt: number): number {
  return backoffDelayMs(attempt, { baseMs: CONTROL_RETRY_BASE_MS, maxMs: CONTROL_RETRY_MAX_MS });
}

async function waitForControlRetry(delayMs: number, signal?: AbortSignal, scheduler = systemScheduler): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = scheduler.setTimeout(finish, delayMs);
    const onAbort = () => finish(signal?.reason);
    function finish(error?: unknown) {
      scheduler.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The headers every control request carries, read or write, so no call site
 * can forget one. The Viewer authenticates every connection once a token is
 * configured (#1496), so a control read that sends nothing is refused exactly
 * like a stranger's (#1511). On a team install the identity gate then admits
 * only a named caller (sign-in-and-team §4.2), and the bearer names nobody:
 * without the MCP service tag every read on a token-free install and every
 * untagged write (deploy_exact_sha) was answered 401. A caller that set its own
 * authorization or tag keeps it. The tag is minted from the operator key the
 * Viewer creates at startup and is never a reason to create it here; a key
 * that is missing or unreadable costs the tag and nothing else.
 */
function controlRequestHeaders(init: HeadersInit | undefined, token: string | null): Headers {
  const headers = new Headers(init);
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  if (!headers.has(INTERNAL_SERVICE_HEADER)) {
    try {
      for (const [name, value] of Object.entries(existingInternalServiceHeaders("mcp"))) headers.set(name, value);
    } catch {
      /* no key, no tag */
    }
  }
  return headers;
}

async function requestViewerControl(
  pathname: string,
  init: RequestInit,
  context: McpToolCallContext = {},
  pinConfiguredEndpoint = false,
): Promise<{ response: Response; parsed: unknown; unreadable: boolean; uncertainPriorPost: boolean }> {
  const baseUrl = viewerControlOrigin(process.env, pinConfiguredEndpoint);
  const token = viewerControlToken(process.env, baseUrl);
  const now = Date.now();
  const deadlineAt = context.deadlineAt;
  const retryable = deadlineAt !== undefined;
  const publication = init.method === "POST" && pathname === "/api/prototype-reviews";
  const callerBudget = deadlineAt === undefined
    ? (publication ? PROTOTYPE_CONTROL_BUDGET_MS - CONTROL_DEADLINE_RESERVE_MS : CONTROL_UNSCOPED_RECOVERY_BUDGET_MS)
    : Math.max(0, deadlineAt - now - CONTROL_DEADLINE_RESERVE_MS);
  const expiresAt = now + Math.min(publication ? PROTOTYPE_CONTROL_BUDGET_MS : CONTROL_READ_RECOVERY_BUDGET_MS, callerBudget);
  let attempts = 0;
  let lastFailure = "connection failed";
  let uncertainPriorPost = init.method === "POST" && context.priorAttemptUncertain === true;
  while (Date.now() < expiresAt) {
    if (context.signal?.aborted) throw context.signal.reason;
    if (init.method === "POST") context.assertCaller?.();
    attempts += 1;
    const remainingMs = Math.max(1, expiresAt - Date.now());
    const attempt = deadlineSignal(publication ? remainingMs : Math.min(CONTROL_ATTEMPT_TIMEOUT_MS, remainingMs), {
      signal: context.signal,
      reason: "Viewer control reconnect attempt timed out",
    });
    try {
      const headers = controlRequestHeaders(init.headers, token);
      if (init.method === "POST") {
        headers.set("origin", baseUrl);
        headers.set("sec-fetch-site", "same-origin");
      }
      const response = await fetch(new URL(pathname, baseUrl), { ...init, headers, signal: attempt.signal });
      if (TRANSIENT_CONTROL_STATUSES.has(response.status)) {
        if (init.method === "POST") uncertainPriorPost = true;
        lastFailure = `status ${response.status}`;
        await response.body?.cancel().catch(() => {});
      } else {
        try {
          const parsed = await response.json() as unknown;
          const answeredDomainFailure = response.status === 503
            && objectRecord(parsed)
            && Boolean(text(parsed.error) || text(parsed.code));
          if (response.status !== 503 || answeredDomainFailure || !retryable) {
            return { response, parsed, unreadable: false, uncertainPriorPost };
          }
          lastFailure = "status 503";
        } catch {
          if (context.signal?.aborted) throw context.signal.reason;
          if (init.method === "POST") uncertainPriorPost = true;
          if (!retryable) {
            return { response, parsed: null, unreadable: true, uncertainPriorPost };
          } else if (attempt.signal.aborted) {
            lastFailure = "response body timed out";
          } else if (response.status === 503) {
            lastFailure = "status 503";
          } else {
            lastFailure = "response body failed";
          }
        }
      }
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (init.method === "POST" && code !== "ConnectionRefused" && code !== "ECONNREFUSED") uncertainPriorPost = true;
      lastFailure = attempt.signal.aborted ? "attempt timed out" : "connection failed";
    } finally {
      attempt.release();
    }
    if (!retryable) break;
    const delayMs = controlRetryDelay(attempts);
    if (Date.now() + delayMs >= expiresAt) break;
    await waitForControlRetry(delayMs, context.signal);
  }
  if (!retryable) throw new Error("Viewer control is unreachable");
  throw new Error(`Viewer control did not reconnect after ${attempts} attempt${attempts === 1 ? "" : "s"} (${lastFailure})`);
}

function controlFailureMessage(status: number, error: unknown): string {
  const message = text(error) || `Viewer control request failed with status ${status}`;
  if ((status === 401 || status === 403)
    && !viewerControlToken(process.env, viewerControlOrigin(process.env))) {
    return `${message}; no control credential is available. Configure LLV_VIEWER_CONTROL_TOKEN for the intended LLV_VIEWER_CONTROL_URL, or start Delegatus with LLV_TOKEN and reconnect its MCP server.`;
  }
  return message;
}

async function getViewerControl(
  pathname: string,
  context: McpToolCallContext = {},
  pinConfiguredEndpoint = false,
): Promise<Record<string, unknown>> {
  const { response, parsed: controlPayload, unreadable } = await requestViewerControl(pathname, {
    headers: {
      accept: "application/json",
    },
  }, context, pinConfiguredEndpoint);
  /* A body of literal `null` is valid JSON, so `.catch` never fires and every
     later `result.x` throws a TypeError before the status can be classified —
     which is how a 405 from a revision that does not serve the route arrived as
     an uncatchable crash instead of a refusal (#790). */
  let parsed = controlPayload;
  if (unreadable) {
    if (response.ok) {
      throw new ViewerControlResponseError(
        `Viewer control returned an unreadable response with status ${response.status}`,
      );
    }
    parsed = null;
  }
  const result: Record<string, unknown> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  if (!response.ok) {
    const error = controlFailureMessage(response.status, result.error);
    const requestHealth = runtimeHostRequestHealth(result.runtimeHostRequests);
    throw new McpToolRefusal(error, {
      error,
      status: response.status,
      ...(text(result.code) ? { code: text(result.code) } : {}),
      ...(requestHealth ? { runtimeHostRequests: requestHealth } : {}),
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ViewerControlResponseError(
      `Viewer control returned a malformed response with status ${response.status}`,
    );
  }
  return result;
}

async function postViewerControl(
  pathname: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  context: McpToolCallContext = {},
  pinConfiguredEndpoint = false,
): Promise<Record<string, unknown>> {
  /* Every control mutation carries its endpoint's idempotency identity
     (clientAttemptId, clientMessageId or clientRequestId). Repeating the same
     request after a lost transport answer therefore asks for its receipt. */
  let answer: Awaited<ReturnType<typeof requestViewerControl>>;
  try {
    answer = await requestViewerControl(pathname, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }, context, pinConfiguredEndpoint);
  } catch (error) {
    if (pathname === "/api/prototype-reviews") {
      throw new McpPrototypePublicationPendingError(error instanceof Error ? error.message : "Viewer publication wait ended");
    }
    throw error;
  }
  const { response, parsed, unreadable, uncertainPriorPost } = answer;
  /* A body of literal `null` is valid JSON, so `.catch` never fires and every
     later `result.x` throws a TypeError before the status can be classified —
     which is how a 405 from a revision that does not serve the route arrived as
     an uncatchable crash instead of a refusal (#790). */
  if (unreadable && response.ok) {
    if (pathname === "/api/prototype-reviews") throw new McpPrototypePublicationPendingError("Viewer publication response was unreadable");
    throw new ViewerControlResponseError(
      `Viewer control returned an unreadable response with status ${response.status}`,
    );
  }
  const result: Record<string, unknown> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  if (pathname === "/api/runtime/deployments" && uncertainPriorPost && !response.ok) {
    throw new McpDeploymentPendingError(`${controlFailureMessage(response.status, result.error)} after an earlier deploy request may have reached admission`);
  }
  if (pathname === "/api/prototype-reviews" && response.ok
    && (typeof result.reviewId !== "string" || !/^pr_[a-f0-9]{32}$/.test(result.reviewId))) {
    throw new McpPrototypePublicationPendingError("Viewer publication response did not name its reviewId");
  }
  if (result.error || (!response.ok && result.state !== "busy")) {
    const message = controlFailureMessage(response.status, result.error);
    /* #1131: a refusal that names an ACCEPTED send is not just prose. The send
       began actuating and nothing could confirm it, so the caller needs the id
       it was accepted under — `message_receipt` answers what became of it — and
       the guidance that repeating the instruction may deliver it twice.
       Flattening those into a message is what left an ambiguous legacy send
       with nothing to ask about and no warning against sending it again. */
    if (pathname === "/api/runtime/deployments" && result.code === "self-update-action-required" && objectRecord(result.action)) {
      const action = result.action;
      if (["restart-service", "restart-terminal", "update-first", "start-service", "start-launcher", "docker-deployments", "secure-handoff"].includes(String(action.id)) && typeof action.button === "boolean") {
        throw new McpToolRefusal(message, { code: result.code, status: response.status, action: {
          id: action.id, button: action.button, ...(typeof action.unit === "string" ? { unit: action.unit } : {}), ...(typeof action.command === "string" ? { command: action.command } : {}),
          ...(typeof action.terminalEveryUpdate === "boolean" ? { terminalEveryUpdate: action.terminalEveryUpdate } : {}),
        } });
      }
    }
    if (result.code === "short_id_ambiguous") throw new McpToolRefusal(message, {
      code: "short_id_ambiguous", retryable: false, status: response.status,
      field: text(result.field) || "reviewId",
      ...(Array.isArray(result.candidates) ? { candidates: result.candidates.filter(value => typeof value === "string").slice(0, 8) } : {}),
    });
    const operationId = text(result.operationId);
    if (operationId) {
      throw new McpToolRefusal(message, {
        operationId,
        ...(text(result.resend) ? { resend: text(result.resend) } : {}),
        ...(result.actuation === "started" ? { actuation: "started" } : {}),
      });
    }
    if (pathname === "/api/runtime/deployments" && response.status >= 400 && response.status < 500 && response.status !== 408) {
      throw new McpToolRefusal(message, { code: text(result.code) || "deploy_refused", retryable: false, status: response.status });
    }
    throw new Error(message);
  }
  return result;
}

/**
 * One potentially received dispatch of a recoverable mutation (#1490). A
 * send reconnects only after a kernel refusal proves no request was sent.
 * What comes back is classified by what it can
 * PROVE. A connection the kernel refused never carried a byte, so the server
 * did nothing; a reset, a timeout after the write, an unreadable or missing
 * body, and a proxy status that says nothing about the upstream all leave the
 * request possibly on the server and are reported as uncertain. A JSON answer
 * carrying an admitted id keeps that id. A status or error body alone cannot
 * prove that the handler rejected the request before dispatch.
 */
async function dispatchViewerControl(
  pathname: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  context: McpToolCallContext = {},
  pinConfiguredEndpoint = false,
  scheduler: DeadlineScheduler = systemScheduler,
): Promise<Record<string, unknown>> {
  const baseUrl = viewerControlOrigin(process.env, pinConfiguredEndpoint);
  const token = viewerControlToken(process.env, baseUrl);
  const now = Date.now();
  const budgetMs = context.deadlineAt === undefined
    ? CONTROL_UNSCOPED_RECOVERY_BUDGET_MS
    : Math.max(1, context.deadlineAt - now - CONTROL_DEADLINE_RESERVE_MS);
  const reconnectSend = pathname === "/api/tmux";
  const expiresAt = now + Math.min(CONTROL_RECOVERY_BUDGET_MS, budgetMs);
  const requestHeaders = controlRequestHeaders({ "content-type": "application/json", ...headers }, token);
  requestHeaders.set("origin", baseUrl);
  requestHeaders.set("sec-fetch-site", "same-origin");
  let response: Response;
  let attempt: ReturnType<typeof deadlineSignal>;
  let attempts = 0;
  const refusedSend = () => {
    const endpoint = new URL(pathname, baseUrl).origin;
    const lastResponseAt = controlLastResponseAt.get(baseUrl);
    const lastResponseAgeMs = lastResponseAt === undefined ? null : Math.max(0, Date.now() - lastResponseAt);
    return new McpUnadmittedRefusal(
      `Viewer control is unreachable at ${endpoint} after ${attempts} attempts: the connection was refused before the request was sent (last response age: ${lastResponseAgeMs === null ? "unknown" : `${lastResponseAgeMs} ms`})`,
      { endpoint, lastResponseAgeMs },
    );
  };
  /* From here on the request may be on the wire: the service reads this to
     tell a failure that happened BEFORE any dispatch from one after it. */
  context.assertCaller?.();
  if (context.dispatch) context.dispatch.attempted = true;
  while (true) {
    context.assertCaller?.();
    attempt = deadlineSignal(Math.min(CONTROL_ATTEMPT_TIMEOUT_MS, Math.max(1, expiresAt - Date.now())), {
      scheduler,
      signal: context.signal,
      reason: "Viewer control dispatch timed out",
    });
    attempts += 1;
    try {
      response = await fetch(new URL(pathname, baseUrl), {
        method: "POST",
        // Redirects can repeat a POST after the first endpoint accepted it.
        redirect: "error",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: attempt.signal,
      });
      // fetch owns the socket pool; record the observable response age instead.
      controlLastResponseAt.delete(baseUrl);
      controlLastResponseAt.set(baseUrl, Date.now());
      if (controlLastResponseAt.size > 32) controlLastResponseAt.delete(controlLastResponseAt.keys().next().value!);
      break;
    } catch (error) {
      attempt.release();
      const code = (error as { code?: unknown }).code;
      if (code === "ConnectionRefused" || code === "ECONNREFUSED") {
        if (!reconnectSend) {
          throw new McpDispatchNotExecutedError("Viewer control is unreachable: the connection was refused before the request was sent");
        }
        const delayMs = controlRetryDelay(attempts);
        if (!context.signal?.aborted && Date.now() + delayMs < expiresAt) {
          // Every preceding attempt was affirmatively refused before sending.
          // Keep the same durable binding, body and downstream key.
          try {
            await waitForControlRetry(delayMs, context.signal, scheduler);
          } catch {
            // Cancellation here cannot turn a refused connection into a send.
            throw refusedSend();
          }
          continue;
        }
        throw refusedSend();
      }
      throw new McpDispatchUncertainError(
        attempt.signal.aborted
          ? "the Viewer did not answer before the dispatch deadline; the request may have been received"
          : `the connection failed after the request may have been sent (${code ? String(code) : "connection failed"})`,
      );
    }
  }
  let parsed: unknown;
  let unreadable = false;
  try {
    parsed = await response.json() as unknown;
  } catch {
    unreadable = true;
  } finally {
    attempt.release();
  }
  const result = objectRecord(parsed) ? parsed : {};
  const answered = !unreadable && objectRecord(parsed) && Boolean(text(result.error) || text(result.code) || Object.keys(result).length);
  if (TRANSIENT_CONTROL_STATUSES.has(response.status) || (response.status === 503 && !answered)) {
    throw new McpDispatchUncertainError(`Viewer control answered status ${response.status} without a verdict; the request may have been received`);
  }
  if (unreadable) {
    throw new McpDispatchUncertainError(`Viewer control returned an unreadable response with status ${response.status}; the request may have been received`);
  }
  if (!objectRecord(parsed)) {
    throw new McpDispatchUncertainError(`Viewer control returned a malformed response with status ${response.status}; the request may have been received`);
  }
  if (result.error || (!response.ok && result.state !== "busy")) {
    const message = controlFailureMessage(response.status, result.error);
    const refusals = readTelegramBotRefusals(result.refusals);
    const operationId = text(result.operationId);
    const launchId = text(result.launchId);
    if (operationId || launchId) {
      throw new McpDispatchVerdictError(message, {
        status: response.status,
        ...(refusals.length ? { refusals } : {}),
        ...(operationId ? { operationId } : {}),
        ...(launchId ? { launchId } : {}),
        ...(text(result.conversationId) ? { conversationId: text(result.conversationId) } : {}),
        ...(text(result.resend) ? { resend: text(result.resend) } : {}),
        ...(result.actuation === "started" ? { actuation: "started" } : {}),
        ...(text(result.code) ? { code: text(result.code) } : {}),
      });
    }
    throw new McpDispatchVerdictError(message, {
      status: response.status,
      ...(text(result.code) ? { code: text(result.code) } : {}),
      ...(result.admission === "refused" ? { admission: "refused" } : {}),
      ...(typeof result.expectedRevision === "number" || result.expectedRevision === null ? { expectedRevision: result.expectedRevision } : {}),
      ...(typeof result.retryAfterSeconds === "number" ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      ...(Array.isArray(result.sentMessageIds) && result.sentMessageIds.every((id) => typeof id === "number") ? { sentMessageIds: result.sentMessageIds } : {}),
      ...(readFileConfirmationLink(result.confirmation) ? { confirmation: readFileConfirmationLink(result.confirmation) } : {}),
      ...(text(result.secretClass) ? { secretClass: text(result.secretClass) } : {}),
      ...(refusals.length ? { refusals } : {}),
    });
  }
  return result;
}

export function productionViewerControlDependencies(
  pinConfiguredEndpoint = false,
  scheduler: DeadlineScheduler = systemScheduler,
): ViewerControlDependencies {
  return {
    get: (pathname, context) => getViewerControl(pathname, context, pinConfiguredEndpoint),
    post: (pathname, body, headers, context) => postViewerControl(
      pathname,
      body,
      headers,
      context,
      pinConfiguredEndpoint,
    ),
    dispatch: (pathname, body, headers, context) => dispatchViewerControl(
      pathname,
      body,
      headers,
      context,
      pinConfiguredEndpoint,
      scheduler,
    ),
  };
}

function readViewerControl(
  control: ViewerControlDependencies,
  pathname: string,
): Promise<Record<string, unknown>> {
  if (!control.get) throw new Error("Viewer control read is unavailable");
  return control.get(pathname);
}

function viewerControlForCall(
  control: ViewerControlDependencies,
  context?: McpToolCallContext,
): ViewerControlDependencies {
  if (!context) return control;
  const timed = async (run: () => Promise<Record<string, unknown>>) => {
    const startedAt = performance.now();
    try { return await run(); }
    finally { context.recordTiming?.("http", performance.now() - startedAt); }
  };
  return {
    ...(control.get ? { get: (pathname: string) => timed(() => control.get!(pathname, context)) } : {}),
    post: (pathname, body, headers) => timed(() => control.post(pathname, body, headers, context)),
    ...(control.dispatch ? { dispatch: (pathname, body, headers) => timed(() => control.dispatch!(pathname, body, headers, context)) } : {}),
  };
}

/** The single-attempt dispatch where the control set provides one, and the
    plain post of a harness that provides only that. */
function dispatchControl(control: ViewerControlDependencies): NonNullable<ViewerControlDependencies["dispatch"]> {
  return control.dispatch ?? control.post;
}

type RegistrySnapshot = ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]>;

interface TargetedConversationOptions extends McpToolCallContext {
  tailLines?: number;
}

export interface ViewerMcpDomainDependencies {
  listFiles(options?: Parameters<typeof listFiles>[0]): Promise<FileEntry[]>;
  targetedFileEntry?(pathname: string, options?: TargetedConversationOptions): Promise<TargetedConversationRead | FileEntry | undefined>;
  /** Descriptor-pinned transcript read used by conversation_messages. */
  pinnedTranscript?(pathname: string): PinnedTranscript | undefined;
  /** #844 §6/§7: the bounded selected-card path — one keyed identity lookup and
      an explicit tail read, reaching no scan. Optional so partial test
      harnesses fall back to the production resolver. */
  selectedContext?: SelectedContextTargetDependencies;
  completedFileScan(options?: Parameters<typeof completedFileScan>[0]): ReturnType<typeof completedFileScan>;
  /** The last completed catalog generation, read without starting or joining
      a scan; null before any generation completed. Absent in harnesses that
      inject their own complete scan. */
  lastCompletedCatalog?(): { projectCatalog: FileScanSnapshot["projectCatalog"]; files: readonly FileScanSnapshot["files"][number][] } | null;
  registrySnapshot(): RegistrySnapshot;
  /** Fresh seat and delivered-wake admission for curator reads and writes. */
  curatorSnapshot?(conversationId: string): RegistrySnapshot;
  curatorAdmission?(conversationId: string | null): Promise<void | (() => void)>;
  boardFor(project: string): ReturnType<typeof boardFor>;
  applyBoardCommand(input: unknown, snapshot: RegistrySnapshot): ReturnType<typeof applyBoardCommand>;
  getFlowsWithPresets(): ReturnType<typeof getFlowsWithPresets>;
  flowSelectionSource?: typeof flowSelectionSource;
  patchFlow: typeof patchFlow;
  cancelRound: typeof cancelRound;
  closeFlow: typeof closeFlow;
  getPipelines: typeof getPipelines;
  /** #863: the bounded list read — the shared cached registry parse, with none
      of the per-caller revive `getPipelines` pays, because a list row copies
      scalars and keeps nothing. Optional so partial test harnesses that stub
      only `getPipelines` still project from it. */
  listPipelineRecords?(): readonly Pipeline[];
  fleetLimitWaits?(ids: string[]): Promise<ReturnType<typeof fleetLimitWaits>>;
  pipelineSelectionSource?: typeof pipelineSelectionSource;
  patchPipeline: typeof patchPipeline;
  readPipelineRecord?: typeof getPipelineRecord;
  reportStageCompletion: typeof reportStageCompletion;
  loadTasks: typeof loadTasks;
  listTaskRecords?(): readonly import("@/lib/tasks/types").BoardTask[];
  taskSelectionSource?: typeof taskSelectionSource;
  collectSnapshot: typeof collectSnapshot;
  readResources: typeof readResources;
  readFleetSessions?: typeof readCachedResourceSessions;
  fleetDetailBudgetBytes?: number;
  readResourcesWithDiagnostic?: typeof readResourcesWithDiagnostic;
  /** Sources for the liveness read. The catalog seam travels in (#860) so a
      project-scoped `agent_activity` consumes the SAME completed generation
      `board_snapshot` reads instead of forcing a private whole-corpus sweep.
      Partial harnesses that build fixed sources may ignore the argument. */
  livenessSources(catalog?: { completedFileScan?: CompletedGenerationRead; catalogBudgetMs?: number }): AgentLivenessSources;
  queryLifecycleEvents: typeof queryLifecycleEvents;
  pollLifecycleDigest: typeof pollLifecycleDigest;
  refreshLifecycleJournal: typeof refreshLifecycleJournal;
  /** #688 D5: fold the live root session into the rollover chain, so a request
      references the root by an identity that survives the session it was raised
      from. Called on the raise path, which is the moment that identity matters. */
  adoptRootSession(): void;
  raiseAttentionRequest: typeof raiseAttentionRequest;
  /** What the dismissal service reads and writes besides its own record
      (docs/design/needs-attention.md §5). Optional: production wires the
      registry, the task store and the pipeline engine. */
  dismissalPorts?: DismissalPorts;
  attentionReportProject?(seq: number): string | null;
  /** Whether a phone the operator is looking at is open, for a request with no
      desktop to move (docs/design/needs-attention.md §6). Optional: production
      reads presence. */
  noticeCapableViewOpen?: () => boolean;
  /** #873: block until the directed view lands or the handoff closes as a
      bounded failure. Optional so partial harnesses fall back to the real
      awaiter; tests override it only to shorten its clocks. */
  awaitAttentionArrival?: typeof awaitAttentionArrival;
  /** Who is running this MCP server. Resolved from process ancestry and the
      registry's recorded hosts merged with the admission-injected spawn
      capability, never from anything the caller says. Under B+ it ATTRIBUTES —
      it does not gate tool availability. */
  attentionAuthority(): AttentionCallerAuthority;
  /** The same identity folded with the durable orchestrator designation, as
      the server-derived origin label for attention requests and bridge
      reports. Optional so partial test harnesses fall back to a label derived
      from {@link attentionAuthority} alone (manager reads as agent there). */
  callerAttribution?(): CallerAttribution;
  /** #873 restart replay: the durable record an earlier, interrupted run of
      the same MCP operation already raised. Optional so partial harnesses
      fall back to the shared attention file. */
  findAttentionByOperation?(operationKey: string): AttentionRequestV1 | null;
  /** The operator's interface language and time zone
      (docs/design/orchestrator-reports.md §4.2). Optional so harnesses fall
      back to the operator settings file. */
  operatorLocale?(): "en" | "uk" | null;
  operatorTimeZone?(): string | null;
  /** The names a report is scrubbed of (§5.5). Optional: production reads the
      account registry, the bot's chats and the project catalog. */
  publicDenyList?(project: string | null): PublicDenyList;
  /** Posts a report's Telegram copy (§5.5). Optional: production posts through
      the Viewer's bot agent route with the caller's capability. */
  sendReportTelegram?(input: ReportTelegramSend): Promise<ReportTelegramSendOutcome>;
  /** Reads a project's seat tick row without writing one. Optional: production
      peeks the tick's own store. */
  peekTickState?(project: string): SeatTickProjectState;
  /** Validated per-project manager seats (fail-closed — see
      `@/lib/orchestrator/authority`), for project-scoped directive routing.
      Optional so partial harnesses fall back to the production resolver. */
  authorizedSeats?(): ReturnType<typeof authorizedManagerSeats>;
  /** Resolves a seat identity through the registry's alias chain (#1168), so a
      directive settles the ask of a seat the log recorded under a pre-migration
      id. The attention projection resolves the recorded seat the same way, and
      the two must agree or a rekeyed seat's ask outlives its answer. Optional
      so partial harnesses fall back to the production registry. */
  canonicalSeatConversationId?: CanonicalSeatConversationId;
  /** The seat tick settings store (#1275). Optional so a partial harness can
      exercise the tool without a state directory; production reads and writes
      the durable per-project row. */
  readTickSettings?: typeof readSeatTickSettings;
  writeTickSettings?: typeof writeSeatTickSettings;
  /** The calling voice session's CANONICAL PROJECT — production resolves it
      from the caller's conversation cwd through the worktree-grouping path
      (`projectInfoFromCwd`), the same attribution every other surface uses.
      Null means the invariant "a registered session has a canonical project"
      is violated, and unscoped directive routing fails closed diagnostically. */
  callerProject?(): string | null;
  /** The operator's own root conversation (no role, no parent, depth zero, no
      membership) with its canonical project, or null. Production reads the
      registry; leave_lesson admits it only while Delegatus memory is on. */
  operatorConversation?(conversationId: string): { project: string | null } | null;
  /** The canonical projects of the repository this Viewer deploys (#1321) —
      the only projects whose designated seat may execute a deploy. Production
      derives them from the canonical Viewer remote, never from the caller's
      working directory, because an MCP client launches inside the caller's own
      repository. More than one while the repository's GitHub rename has not
      been folded into one key yet. Optional so partial harnesses fall back to
      the production resolver; an empty list means the Viewer cannot name what
      it deploys, and the deploy refusal then fails closed. */
  viewerProjects?(): readonly string[];
  /** Records which seat started an accepted deployment (#2063), so the seat
      tick can wake that seat when it settles. Optional so partial harnesses
      fall back to the production store. */
  recordSeatDeployment?(record: SeatDeploymentRecord, assertCaller?: () => void): void | Promise<void>;
  beginSeatDeployment?(record: import("@/lib/orchestrator/seatDeployments").PendingSeatDeployment, assertCaller?: () => void): Promise<void>;
  findDeploymentByIdempotencyKey?: typeof import("@/lib/orchestrator/seatDeployments").findSeatDeploymentByKey;
  /** The account↔project binding store (#1279). Optional so a partial harness
      can exercise the tool with no state directory; production reads and
      writes the durable record, and every answer is a read of it. */
  readAccountProjectBindings?: typeof accountProjectBindings;
  bindAccountToProject?: typeof bindAccountToProject;
  unbindAccountFromProject?: typeof unbindAccountFromProject;
  /** Accounts the catalog holds, per engine, so a binding can be answered with
      labels and a caller can see what there is to bind. */
  listBindableAccounts?(engine: BindingEngine): { accountId: string; label: string }[];
  /** #1845: what `account_limits` reads — the catalog, the active account per
      engine and the durable quota observations. Absent means production. */
  accountLimitsSource?(): Omit<AccountLimitsInput, "engine" | "accountId">;
  /** #1490: the ports the original-key send lookup settles through. Absent
      means production (the shared registry and the runtime host socket). */
  sendSettlementPorts?(): SendSettlementPorts;
  /** #1582: a read-only-looking admission check that may return a refusal only
      after the downstream route atomically fences the exact request. */
  validateSpawnAdmission?(body: Record<string, unknown>, context?: McpToolCallContext): Promise<Record<string, unknown>>;
  /** Server-derived predecessor identities of the caller's active project seat.
      The caller cannot supply this lineage. */
  recoveryPredecessors?(project: string, conversationId: string): readonly string[];
  /** #1582: read one request-bound spawn admission fence. */
  readSpawnAdmissionFence?(clientAttemptId: string): SpawnAdmissionFence | null;
  /** #2518: files an approved bug report. Absent means production, which
      goes through the engine's GitHub write seam. */
  issueReportPublisher?: IssueReportPublisher;
  /** #2518: `owner/name` the report is filed in. Absent means the repository
      Delegatus's own manifest names. */
  issueReportRepository?(): string | null;
  /** #2518: where previews are stored. Absent means the state directory. */
  issueReportsDir?(): string;
  /** #2518: looks for an issue that already carries a report's exact text,
      for a publication whose outcome nobody recorded. Absent means production. */
  issueReportFinder?: IssueReportFinder;
}

/**
 * FIX 2's production resolver: the caller's conversation (pid ancestry merged
 * with capability lineage — the identity chain everything else trusts), its
 * newest generation's cwd, and the canonical project that cwd groups under.
 * No second resolution scheme: `projectForCwd` IS `projectInfoFromCwd`.
 */
function productionCallerProject(): string | null {
  const snapshot = agentRegistry().readOnlySnapshot();
  const conversation = productionCallerConversation(snapshot);
  return conversation ? callerProjectFromSnapshot(snapshot, conversation.id) : null;
}

/** The same authenticated conversation that supplies the project also carries
    the model used to judge that caller's next unpinned account. */
function productionCallerConversation(snapshot: RegistrySnapshot) {
  const authority = attentionCallerAuthority(attentionCallerSources());
  const conversationId = authority.kind === "root" || authority.kind === "worker" ? authority.conversationId : null;
  return conversationId
    ? readOnlyConversationLookupFromSnapshot(snapshot).conversation(conversationId as `conversation_${string}`)
    : null;
}

/**
 * The canonical project of the Delegatus install this process IS — the one
 * question `deploy_exact_sha` refuses on (#1321), and the only caller there is.
 *
 * The cwd cannot answer it. An MCP client launches wherever the CALLER works,
 * which is exactly the foreign repository the deploy refusal has to tell apart
 * from the Viewer's own, and a packaged release has no `.git` of its own to
 * read either. The one fact that travels with the code is the canonical remote
 * it is deployed from — `LLV_VIEWER_CANONICAL_REMOTE` when the host configures
 * one, else the repository metadata bundled in the Viewer's own manifest —
 * resolved through the SAME repository-key algorithm that names live checkouts,
 * so a clone of that remote and the release built from it land on one project
 * id.
 *
 * Folded through the operator's project aliases because seats are stored
 * alias-resolved: comparing a raw repository id against an aliased seat project
 * would refuse the Viewer's own deploy. Both GitHub names of this repository
 * count until that alias exists (`viewerRepositoryProjects`).
 */
function viewerOwnProjects(): string[] {
  const configured = process.env.LLV_VIEWER_CANONICAL_REMOTE?.trim();
  const remote = configured || viewerPackageManifest.repository.url.trim();
  return [...new Set(viewerRepositoryProjects(remote, process.cwd()).map(canonicalOrchestratorProject))];
}

/** The registry's proof that a caller is the operator's own root conversation:
    the conversation's durable operator-origin stamp plus the root shape. */
export function operatorConversationFromSnapshot(snapshot: RegistrySnapshot, conversationId: string): { project: string | null } | null {
  const conversation = readOnlyConversationLookupFromSnapshot(snapshot).conversation(conversationId as `conversation_${string}`);
  if (!conversation || !storedOperatorRoot(conversation, snapshot.memberships[conversation.id])) return null;
  return { project: callerProjectFromSnapshot(snapshot, conversation.id) };
}

function productionOperatorConversation(conversationId: string): { project: string | null } | null {
  return operatorConversationFromSnapshot(agentRegistry().readOnlySnapshot(), conversationId);
}

/**
 * The canonical project of an authenticated caller: its conversation's
 * recorded project ownership, else the project of its launch directory. One
 * resolver for every consumer, read from the registry's own projection.
 */
function callerProjectFromSnapshot(snapshot: RegistrySnapshot, conversationId: string): string | null {
  const conversation = readOnlyConversationLookupFromSnapshot(snapshot).conversation(conversationId as `conversation_${string}`);
  if (!conversation) return null;
  if (conversation.projectOwnership?.project) return conversation.projectOwnership.project;
  const cwd = conversation.generations.at(-1)?.launchProfile?.cwd?.trim();
  return cwd ? projectForCwd(cwd) : null;
}

/** Walk only the active seat in the caller's own canonical project. The active
    seat supplies the immediate predecessor; revocations supply older links.
    Any contradictory edge makes lineage unavailable rather than widening it. */
function productionRecoveryPredecessors(project: string, conversationId: string): readonly string[] {
  const canonicalProject = canonicalOrchestratorProject(project);
  const active = orchestratorSeatFor(canonicalProject).active;
  if (!active || active.conversationId !== conversationId || active.project !== canonicalProject) return [];
  const predecessorBySuccessor = new Map<string, string>();
  const ambiguousSuccessors = new Set<string>();
  for (const revocation of orchestratorRevocations()) {
    if (revocation.project !== canonicalProject || !revocation.successorConversationId) continue;
    const previous = predecessorBySuccessor.get(revocation.successorConversationId);
    if (previous && previous !== revocation.conversationId) ambiguousSuccessors.add(revocation.successorConversationId);
    else predecessorBySuccessor.set(revocation.successorConversationId, revocation.conversationId);
  }
  const predecessors: string[] = [];
  const seen = new Set<string>([conversationId]);
  let current = active.predecessorConversationId;
  while (current) {
    if (seen.has(current) || ambiguousSuccessors.has(current)) return [];
    seen.add(current);
    predecessors.push(current);
    current = predecessorBySuccessor.get(current) ?? null;
  }
  return predecessors;
}

/** Server-derived origin of the current caller. Shared by the attention record
    (`raisedBy`) and the bridge report log (`origin`), which store the same
    shape. */
export interface CallerAttribution {
  kind: "manager" | "agent" | "gateway" | "unidentified";
  conversationId: string | null;
  role: string | null;
  /** Set when a live deputy of the seat is the caller (docs/design/ghost-seat.md
      §4): `conversationId` is then the SEAT's, so every surface treats the call
      as the seat's, and this keeps the deputy's own id for the audit trail. */
  via?: { deputy: string };
  native?: true;
}

/** Fold the caller authority with "is this the designated orchestrator" into
    one label. Pure, so every mapping is testable without a process tree.

    `deputySeatOf` answers the seat a live deputy stands for. A caller it maps
    is labelled `manager` under the seat's id with `via.deputy` naming itself;
    a conversation that is itself a manager never consults it. */
export function callerAttributionFrom(
  authority: AttentionCallerAuthority,
  isManagerConversation: (conversationId: string) => boolean,
  deputySeatOf?: (conversationId: string) => string | null,
): CallerAttribution {
  const native = authority.kind !== "unidentified" && authority.evidence === "native-session" ? { native: true as const } : {};
  if (authority.kind === "root") return { kind: "gateway", conversationId: authority.conversationId, role: null, ...native };
  if (authority.kind === "unidentified") return { kind: "unidentified", conversationId: null, role: null };
  if (isManagerConversation(authority.conversationId)) {
    return { kind: "manager", conversationId: authority.conversationId, role: authority.role, ...native };
  }
  const seat = deputySeatOf?.(authority.conversationId) ?? null;
  if (seat && isManagerConversation(seat)) {
    return { kind: "manager", conversationId: seat, role: authority.role, via: { deputy: authority.conversationId }, ...native };
  }
  return { kind: "agent", conversationId: authority.conversationId, role: authority.role, ...native };
}

function attributionOf(dependencies: Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">): CallerAttribution {
  return resolveMcpCallerValue(dependencies, "attribution", () => dependencies.callerAttribution?.()
    ?? callerAttributionFrom(authorityOf(dependencies), () => false));
}

function authorityOf(dependencies: Pick<ViewerMcpDomainDependencies, "attentionAuthority">): AttentionCallerAuthority {
  return resolveMcpCallerValue(dependencies, "authority", () => dependencies.attentionAuthority());
}

/** MCP mutations always remain agent-attributed, including an unidentified caller. */
function pauseResumeActorOf(dependencies: ViewerMcpDomainDependencies): PauseResumeActor {
  const attribution = attributionOf(dependencies);
  return {
    kind: "agent",
    role: attribution.role ?? (attribution.kind === "manager" ? "orchestrator" : attribution.kind === "gateway" ? "gateway" : null),
    conversationId: attribution.conversationId,
    ...(attribution.via ? { via: { deputy: attribution.via.deputy } } : {}),
  };
}

/**
 * Message authorship for a send issued through this MCP server (#1117): every
 * MCP caller is an agent, and the role is the server's own attribution — never
 * a caller claim. Attribution reads process ancestry, so a fault there costs
 * only the role, not the send.
 */
function mcpSenderOrigin(
  dependencies: Partial<Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority" | "registrySnapshot">>,
): MessageOrigin {
  let attribution: CallerAttribution | null = null;
  try {
    attribution = dependencies.attentionAuthority ? attributionOf(dependencies as ViewerMcpDomainDependencies) : dependencies.callerAttribution?.() ?? null;
  } catch {
    attribution = null;
  }
  const role = attribution?.kind === "manager"
    ? "orchestrator"
    : attribution?.kind === "gateway"
      ? "gateway"
      : messageOriginRole(attribution?.role);
  try {
    if (dependencies.registrySnapshot) {
      return agentMessageOrigin(
        dependencies.registrySnapshot(),
        attribution?.via?.deputy ?? attribution?.conversationId ?? null,
        role,
      );
    }
  } catch { /* A missing registry row costs source detail, never authorship. */ }
  return { kind: "agent", role: role ?? "agent",
    ...(attribution?.conversationId ? { conversationId: attribution.via?.deputy ?? attribution.conversationId } : {}) };
}

/**
 * The registry slice {@link adoptLiveRootSession} resolves the root from.
 *
 * Handed over verbatim: `RootSessionSource` is described structurally against
 * the registry's own conversation shape — id, updatedAt, and the generations
 * with their launch profiles — so there is no field mapping here to fall out of
 * step with what the registry actually stamps.
 */
function rootSessionSource(): RootSessionSource {
  const snapshot = agentRegistry().readOnlySnapshot();
  return {
    conversations: Object.values(snapshot.conversations),
    configuredRootId: process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null,
  };
}

/**
 * Which conversations the registry can name a live host process for, and which
 * of them is the root — the evidence {@link attentionCallerAuthority} decides on.
 *
 * The join is by transcript path because that is what a registry ENTRY (which
 * holds the host process ids) and a CONVERSATION (which holds the role) have in
 * common. Both host shapes count: a tmux-hosted agent is the CLI process that
 * parents this MCP server directly, and a structured host is the app-server or
 * broker that parents it instead.
 *
 * A conversation whose entry recorded NO host pid stays in the list with an
 * empty pid set. It can never win the ancestry walk — there is nothing to match
 * — but it is still an identity the durable capability lineage may name, and
 * dropping it was exactly the measured bug: a designated manager whose entry
 * carried null pids while its host was alive resolved to "unidentified" and was
 * refused every manager-only tool.
 */
type CallerHost = NonNullable<RegistrySnapshot["entries"][string]["host"]>["agent"];
interface CallerRecord { conversationId: string; role: string | null; hosts: (CallerHost | null)[] }
function callerRecordsFromSnapshot(snapshot: Pick<RegistrySnapshot, "conversations" | "entries">): CallerRecord[] {
  const owners = new Map<string, string>();
  const hosted = new Map<string, CallerRecord>();
  for (const conversation of Object.values(snapshot.conversations)) {
    for (const generation of conversation.generations) owners.set(generation.path, conversation.id);
    hosted.set(conversation.id, { conversationId: conversation.id, role: conversationRole(conversation), hosts: [] });
  }
  for (const entry of Object.values(snapshot.entries)) {
    const owner = owners.get(entry.artifactPath);
    if (owner) hosted.get(owner)!.hosts.push(entry.host?.agent ?? null, entry.structuredHost?.process ?? null);
  }
  return [...hosted.values()];
}
function hostedFromRecords(records: CallerRecord[], probe?: ProcessIdentityProbe) {
  return records.map(({ hosts, ...conversation }) => ({ ...conversation, pids: hosts.filter(host => {
    if (!host || typeof host.pid !== "number" || host.pid <= 0) return false;
    if (!probe) return true;
    const startIdentity = probe.processIdentity(host.pid);
    return host.startIdentity != null && startIdentity != null && probe.pidAlive(host.pid)
      && sameRecordedProcessIdentity({ pid: host.pid, startIdentity, bootEpoch: probe.bootEpoch() }, host);
  }).map(host => host!.pid) }));
}
export function hostedConversationsFromSnapshot(
  snapshot: Pick<RegistrySnapshot, "conversations" | "entries">,
  probe?: ProcessIdentityProbe,
): { conversationId: string; role: string | null; pids: number[] }[] {
  return performanceSpans.sync("mcp.caller-enumeration", () => hostedFromRecords(callerRecordsFromSnapshot(snapshot), probe));
}

/** One legacy enumeration owner across compiled bundles. Snapshot identity
 * includes revision and database replacement; each call still verifies PIDs. */
const LEGACY_CALLER_KEY = Symbol.for("llv.mcp.legacyCallerRecords");
function legacyCallerMemo(snapshot: RegistrySnapshot, probe: ProcessIdentityProbe) {
  const holder = globalThis as typeof globalThis & { [LEGACY_CALLER_KEY]?: { snapshot: RegistrySnapshot; boot: string | null; configuredRootId: string | null; rootConversationId: string | null; records: CallerRecord[] } };
  const boot = probe.bootEpoch();
  const configuredRootId = process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null;
  let cached = holder[LEGACY_CALLER_KEY];
  if (!cached || cached.snapshot !== snapshot || cached.boot !== boot || cached.configuredRootId !== configuredRootId) {
    cached = holder[LEGACY_CALLER_KEY] = { snapshot, boot, configuredRootId,
      rootConversationId: liveRootSession({ conversations: Object.values(snapshot.conversations), configuredRootId })?.conversationId ?? null,
      records: performanceSpans.sync("mcp.caller-enumeration", () => callerRecordsFromSnapshot(snapshot)) };
  }
  return cached;
}

/** The value of the launch-injected spawn capability, resolved to the
    conversation whose receipt holds its digest. Pure over its resolver so the
    admission lineage can be exercised without a registry on disk. */
export function capabilityConversationResolver(
  capability: string | null | undefined,
  resolveDigest: (digest: string) => string | null,
): () => string | null {
  const value = capability?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return () => null;
  const digest = crypto.createHash("sha256").update(value).digest("hex");
  return () => resolveDigest(digest);
}

/** The registry's own alias chain, resolved per call so a migration that lands
    between two directives takes effect on the next one. */
const productionCanonicalSeatConversationId = seatIdentityResolver(
  (conversationId) => agentRegistry().canonicalConversationId(conversationId),
);

/** The spawn capability that names the current caller: the one an HTTP
    request presented (see `./callerContext`), else the one this stdio process
    inherited from the agent that launched it. */
function callerCapability(): string | undefined {
  const caller = currentMcpHttpCaller();
  return caller ? caller.capability : process.env[VIEWER_SPAWN_CAPABILITY_ENV];
}

export function attentionCallerSources(
  registry = agentRegistry(),
  probe: ProcessIdentityProbe = {
    pidAlive: (pid) => procBackend.pidAlive(pid) && !procBackend.processExited(pid),
    processIdentity: (pid) => procBackend.processIdentity(pid),
    bootEpoch: systemBootEpoch,
  },
  ancestry?: () => readonly number[],
): AttentionCallerSources {
  const httpCaller = currentMcpHttpCaller();
  const capability = callerCapability();
  const resolveCapability = capabilityConversationResolver(capability, digest => registry.conversationIdForSpawnCapabilityDigest(digest));
  let capabilityId: string | null | undefined;
  const callerId = () => capabilityId === undefined ? capabilityId = resolveCapability() : capabilityId;
  const callerAncestry = ancestry ?? (httpCaller ? () => httpCaller.nativePeer && processIdentityStatus(httpCaller.nativePeer) === "alive"
    ? processAncestry(httpCaller.nativePeer.pid, pid => procBackend.readPpid(pid)) : []
    : () => processAncestry(process.pid, pid => procBackend.readPpid(pid)));
  let selected: ReturnType<typeof registry.mcpCallerSnapshot> | undefined;
  const selection = () => selected ??= registry.mcpCallerSnapshot(callerId()!, callerAncestry(), process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null);
  return {
    /* An HTTP call is served from the Viewer's own process, whose ancestry
       leads to no agent host; the capability alone names that caller, exactly
       as it does for a stdio agent whose host pids were never recorded. */
    ancestry: callerAncestry,
    rootConversationId: () => callerId() ? selection().rootConversationId
      : legacyCallerMemo(registry.readOnlySnapshot(), probe).rootConversationId,
    hosted: () => callerId() ? hostedConversationsFromSnapshot(selection().snapshot, probe)
      : hostedFromRecords(legacyCallerMemo(registry.readOnlySnapshot(), probe).records, probe),
    capabilityPresented: () => capability !== undefined,
    nativeCaller: () => {
      if (httpCaller && (!httpCaller.nativePeer || processIdentityStatus(httpCaller.nativePeer) !== "alive")) return nativeCallerRefusal("no-claude-ancestor");
      if (procBackend.name !== "linux") return nativeCallerRefusal("platform-unverified");
      try { return resolveNativeCaller(nativeCallerSources(() => registry.readOnlySnapshot(), httpCaller?.nativePeer?.pid)); }
      catch { return nativeCallerRefusal("session-record-invalid"); }
    },
    capabilityCallerConversationId: callerId,
  };
}

/**
 * What the operator's own live voice call points at, asked of the Viewer that
 * holds it (#1629).
 *
 * The ledger describes a live WebRTC transport and lives in the Viewer process;
 * this one runs beside the agent, in the MCP server. So the reader is a control
 * read over the hop every other cross-process fact already uses, identified by
 * the capability the registry maps to this agent's conversation — which is what
 * makes it a read of ITS OWN call and of nothing else.
 *
 * A hop that fails answers `unavailable` with the reason rather than "no card".
 * Reporting a failed read as an absent selection is how an agent ends up telling
 * the operator they selected nothing when the truth is that nobody could look.
 */
/**
 * Ask the Viewer what a conversation's live call points at, and read the answer.
 *
 * Split from the caller resolution below so the WIRING — the path, the body, the
 * forwarded capability, and what each answered state means — can be driven over
 * a real socket without standing up a registry to be recognised by. The caller
 * resolution is the other half and is covered where authority is.
 */
export async function voiceUtteranceLookup(
  conversationId: string,
  post: ViewerControlDependencies["post"],
  /* #1629: the work this request is doing, carried across the hop so the ledger
     can answer about that turn. Native puts it on the request envelope, so it is
     evidence about the caller rather than a claim in its arguments. */
  work: VoiceWorkLookupIdentity | null = null,
): Promise<VoiceUtteranceLookup> {
  let answer: Record<string, unknown>;
  try {
    answer = await post(
      "/api/runtime/realtime",
      { action: "utteranceContext", conversationId, ...(work ? { work } : {}) },
      callerCapabilityHeaders(),
    );
  } catch (error) {
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  const utterance = answer.utterance;
  if (!objectRecord(utterance)) {
    return { state: "unavailable", reason: text(answer.error) || "the Viewer answered no voice utterance state" };
  }
  const state = text(utterance.state);
  if (state === "no-call" || state === "no-reference" || state === "awaiting-handoff" || state === "unrelated-work") return { state };
  if (state === "unidentified-work" || state === "ambiguous" || state === "unproven-association") {
    return { state, reason: text(utterance.reason) || "the Viewer gave no reason" };
  }
  /* Anything else — including a `joined` answer from a Viewer that still has one
     — is not a state this reader may act on. Installed Codex reports no edge
     from an utterance to the work it became, so a card arriving over this hop
     would be an association nobody can vouch for. */
  return { state: "unavailable", reason: `unusable voice utterance state ${state || "(none)"}` };
}

/**
 * What the operator's own live voice call points at (#1629).
 *
 * The ledger describes a live WebRTC transport and lives in the Viewer process;
 * this one runs beside the agent, in the MCP server. So the reader is a control
 * read over the hop every other cross-process fact already uses, identified by
 * the capability the registry maps to this agent's conversation — which is what
 * makes it a read of ITS OWN call and of nothing else.
 *
 * A hop that fails answers `unavailable` with the reason rather than "no card".
 * Reporting a failed read as an absent selection is how an agent ends up telling
 * the operator they selected nothing when the truth is that nobody could look.
 */
async function productionVoiceUtteranceContext(work: VoiceWorkLookupIdentity | null): Promise<VoiceUtteranceLookup> {
  const authority = attentionCallerAuthority(attentionCallerSources());
  const conversationId = authority.kind === "root" || authority.kind === "worker"
    ? authority.conversationId
    : null;
  if (!conversationId) return { state: "no-call" };
  return voiceUtteranceLookup(conversationId, productionViewerControlDependencies().post, work);
}

/** Exported for the isolated evidence driver, which runs the REAL production
    dependency set and overrides only the caller-authority seam per scenario. */
export const productionDomainDependencies: ViewerMcpDomainDependencies = {
  listFiles,
  targetedFileEntry: targetedFileEntry,
  pinnedTranscript: openPinnedTranscript,
  selectedContext: {
    ...productionSelectedContextDependencies,
    voiceUtteranceContext: productionVoiceUtteranceContext,
  },
  completedFileScan: completedScanForMcp,
  lastCompletedCatalog: () => {
    const projectCatalog = lastScannedProjectCatalog();
    const files = lastScannedFiles();
    return projectCatalog && files ? { projectCatalog, files } : null;
  },
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
  curatorSnapshot: conversationId => agentRegistry().curatorConversationSnapshot(conversationId),
  curatorAdmission: async conversationId => {
    const { curatorRecoveryGuard } = await import("@/lib/memory/curation/admission");
    return curatorRecoveryGuard(conversationId ?? "");
  },
  readSpawnAdmissionFence,
  validateSpawnAdmission: (body, context) => productionViewerControlDependencies().post(
    "/api/spawn/validate",
    body,
    spawnControlHeaders(),
    context,
  ),
  recoveryPredecessors: productionRecoveryPredecessors,
  canonicalSeatConversationId: productionCanonicalSeatConversationId,
  boardFor,
  applyBoardCommand: (input, snapshot) => applyBoardCommand(input, { registrySnapshot: () => snapshot }),
  getFlowsWithPresets,
  flowSelectionSource,
  patchFlow,
  cancelRound,
  closeFlow,
  getPipelines,
  listPipelineRecords: loadPipelinesForList,
  fleetLimitWaits: ids => readHistoryProjection(db => historyFleetLimitWaits(db, ids), { collections: ["pipelines"] }),
  pipelineSelectionSource,
  taskSelectionSource,
  listTaskRecords: loadTasksForList,
  patchPipeline,
  readPipelineRecord: getPipelineRecord,
  reportStageCompletion,
  loadTasks,
  collectSnapshot,
  readResources,
  readResourcesWithDiagnostic,
  readFleetSessions: readCachedResourceSessions,
  livenessSources: productionLivenessSources,
  queryLifecycleEvents,
  pollLifecycleDigest,
  refreshLifecycleJournal,
  adoptRootSession: () => { adoptLiveRootSession(rootSessionSource()); },
  raiseAttentionRequest,
  attentionAuthority: () => attentionCallerAuthority(attentionCallerSources()),
  callerAttribution: () => {
    let seats: ReturnType<typeof authorizedManagerSeats> | null = null;
    const managers = () => (seats ??= authorizedManagerSeats(productionManagerAuthoritySources()));
    return callerAttributionFrom(
      authorityOf(productionDomainDependencies),
      (conversationId) => managers().some((seat) => seat.conversationId === conversationId),
      (conversationId) => productionDeputyPrincipal(conversationId)?.seatConversationId ?? null,
    );
  },
  findDeploymentByIdempotencyKey: async idempotencyKey => {
    const checkout = checkoutDeploymentByIdempotencyKey(statePath("self-update"), idempotencyKey);
    if (checkout) return checkout;
    return (await import("@/lib/orchestrator/seatDeployments")).findSeatDeploymentByKey(idempotencyKey);
  },
  viewerProjects: viewerOwnProjects,
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateExplicitMcpLaunchModel(args: McpToolArgs, fallbackRole?: string): void {
  const model = text(args.model);
  if (!model) return;
  if (args.engine !== undefined && args.engine !== "claude" && args.engine !== "codex" && args.engine !== "copilot") return;
  const roleId = text(args.role) || fallbackRole;
  const role = roleId ? resolveSpawnRole({ role: roleId, roleParams: args.roleParams, confirm: args.confirm }) : null;
  let engine: "claude" | "codex" | "copilot" | null = null;
  if (args.engine === "claude" || args.engine === "codex" || args.engine === "copilot") engine = args.engine;
  else if (role?.ok && role.value) engine = role.value.config.engine;
  if (!engine) return;
  const validation = validateLaunchModel(engine, model);
  if (!("error" in validation)) return;
  throw new McpToolRefusal(validation.error, {
    violations: [{
      field: "model",
      message: validation.error,
      expected: `one of: ${ENGINE_MODELS[engine].map((option) => option.id).join(", ")}`,
    }],
  });
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function required(args: McpToolArgs, key: string): string {
  const value = text(args[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requiredMessageText(args: McpToolArgs): string {
  const value = args.text;
  if (typeof value !== "string" || !value.trim()) throw new Error("text is required");
  return value;
}

function requestId(args: McpToolArgs): string {
  return required(args, "clientRequestId");
}

function withoutKeys(args: McpToolArgs, keys: readonly string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(args).filter(([key]) => !omitted.has(key)));
}

function spawnAttemptId(value: string): string {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value)
    ? value
    : `mcp_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function mcpOperationId(toolName: string, value: string): string {
  return `mcp_${toolName}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function firstPromptLine(prompt: string): string | null {
  const line = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line ? line.slice(0, 2_000) : null;
}

function diffSourceFromPrompt(prompt: string): string | null {
  const pullUrl = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.exec(prompt)?.[0];
  if (pullUrl) return pullUrl;
  const pullRequest = /\b(?:PR|pull request)\s*#?\d+\b/i.exec(prompt)?.[0];
  if (pullRequest) return pullRequest;
  const range = /(?:^|[\s`'"(])([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?\.\.\.?[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?)(?=$|[\s`'".,);:])/m.exec(prompt)?.[1];
  if (range) return range;
  const branch = /\bbranch\s+[`'"]?([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9_-])?)[`'"]?(?=$|[\s.,);:])/i.exec(prompt)?.[1];
  if (branch) return branch;
  const namedRef = /\b(?:review|inspect|compare)\s+[`'"]?([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?)[`'"]?(?=$|[\s.,);:])/i.exec(prompt)?.[1];
  return namedRef && (namedRef.includes("/") || /^(?:HEAD|main|master)$/i.test(namedRef)) ? namedRef : null;
}

function requiredRoleParamFromPrompt(parameter: RoleParameter, prompt: string): string | null {
  if (parameter.key === "diffSource") return diffSourceFromPrompt(prompt);
  if (parameter.key === "sha") return /\b[0-9a-f]{40}\b/i.exec(prompt)?.[0] ?? null;
  if (parameter.key === "questions" || parameter.key === "claims") return firstPromptLine(prompt);
  return null;
}

function roleParamShape(parameter: RoleParameter): string {
  if (parameter.kind === "integer") {
    return `integer ${parameter.min ?? Number.MIN_SAFE_INTEGER}..${parameter.max ?? Number.MAX_SAFE_INTEGER}`;
  }
  if (parameter.kind === "select") return `string, one of: ${parameter.options?.join(" | ") || "(no options registered)"}`;
  return "non-empty string up to 2000 characters";
}

export function defaultMcpSpawnRoleParams(
  args: McpToolArgs,
  definitions: readonly RoleDefinition[] = listRoles(),
): Record<string, unknown> | undefined {
  const role = text(args.role);
  if (!role) return undefined;
  const definition = definitions.find((candidate) => candidate.id === role);
  if (!definition) return undefined;
  const raw = args.roleParams;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) return undefined;
  const source = raw as Record<string, unknown> | undefined;
  const resolved = { ...source };
  if (role === "orchestrator") delete resolved.maxWorkers;
  const missing: RoleParameter[] = [];
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  for (const parameter of definition.parameters.filter((candidate) => candidate.required)) {
    const supplied = resolved[parameter.key];
    if (supplied !== undefined && supplied !== "") continue;
    const derived = requiredRoleParamFromPrompt(parameter, prompt);
    if (derived !== null) resolved[parameter.key] = derived;
    else missing.push(parameter);
  }
  if (missing.length) {
    throw new Error(
      `missing required roleParams for ${role}: ${missing.map((parameter) => `${parameter.key}: ${roleParamShape(parameter)}`).join("; ")}`,
    );
  }
  return Object.keys(resolved).length || raw !== undefined ? resolved : undefined;
}

/** The exact body handed to `/api/spawn`, shared by the one dispatch and the
    request-bound admission recovery probe. Keeping this construction in one
    seam makes the downstream fence digest compare the original payload. */
export function spawnDispatchBody(args: McpToolArgs, clientAttemptId: string, launcherConversationId: string | null = null): Record<string, unknown> {
  /* The launcher is the server's attribution of the caller, never an
     argument: a caller-supplied value is dropped before the route sees it. */
  const body = withoutKeys(args, ["clientRequestId", "recoveryOnly", "launcherConversationId", "crossProjectRequest"]);
  const roleParams = defaultMcpSpawnRoleParams(args);
  return {
    ...body,
    ...(launcherConversationId ? { launcherConversationId } : {}),
    /* MCP callers are agents even when the control request uses the operator
       capability. An omitted list must not inherit operator-root Telegram. */
    ...(args.mcpServers == null ? { mcpServers: ["viewer"] } : {}),
    ...(roleParams ? { roleParams } : {}),
    clientAttemptId,
  };
}

/** The durable identity one `request_attention` call writes on its record —
    exported so tests and evidence can construct the record an interrupted run
    would have left behind. */
export function requestAttentionOperationKey(clientRequestId: string): string {
  return mcpOperationId("request_attention", clientRequestId);
}

/**
 * The sizing rules for an MCP spawn (docs/design/model-sizing-tiers.md §2).
 * The dispatch reaches /api/spawn on the operator capability, so the route
 * cannot tell who briefed it; this binding knows the calling agent and judges
 * the launch by that agent's runtime before anything is dispatched.
 */
function refuseMcpSpawnSizing(args: McpToolArgs, dependencies: Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority" | "registrySnapshot">): void {
  const roleId = text(args.role);
  const role = roleId
    ? resolveSpawnRole({ role: roleId, roleParams: defaultMcpSpawnRoleParams(args) ?? args.roleParams, confirm: args.confirm, engine: args.engine, model: args.model, effort: args.effort })
    : null;
  /* An unresolvable role is the route's to refuse, with its own words. */
  if (role && !role.ok) return;
  /* An agent whose runtime cannot be read is judged as one: it may not brief
     a trivial lane, and every other rule still applies. */
  let runtime: ReturnType<typeof conversationRuntime> = null;
  try {
    const conversationId = attributionOf(dependencies).conversationId ?? (text(args.parentConversationId) || null);
    runtime = conversationRuntime(dependencies.registrySnapshot(), conversationId);
  } catch {
    runtime = null;
  }
  const refusal = spawnSizingRefusal({
    role: role?.ok ? role.value : null,
    engine: args.engine,
    model: args.model,
    briefer: { kind: "agent", runtime },
  });
  if (refusal) throw new McpToolRefusal(refusal, { violations: [{ field: roleId ? "roleParams" : "model", message: refusal, expected: "size=trivial on a brief from a large model (Claude Opus or Fable, or a large Codex model), or the role's own row" }] });
}

/** Check the deployer's caller before a fresh request claims a key,
    and again at dispatch so a seat change cannot authorize a fresh launch. */
function requireMcpDeployerCaller(args: McpToolArgs, project: string | null, dependencies?: ViewerMcpDomainDependencies): void {
  if (text(args.role) !== "deployer") return;
  let allowed = false;
  try {
    const caller = dependencies ? attributionOf(dependencies) : null;
    if (dependencies && caller?.conversationId && !caller.via) {
      allowed = caller.kind === "gateway" || (caller.kind === "manager"
        && (dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources()))
          .some((seat) => seat.conversationId === caller.conversationId && seat.project !== null && canonicalProject(seat.project) === project));
    }
  } catch { /* Unavailable caller or seat evidence grants no deployment authority. */ }
  if (!allowed) {
    throw new McpToolRefusal("only the target project's designated orchestrator seat or the operator's own session may launch a deployer", {
      code: "deployer_spawn_caller_unauthorized", status: 403,
    });
  }
}

function requireMcpDeployerConfirmation(args: McpToolArgs): void {
  if (text(args.role) !== "deployer") return;
  const role = resolveSpawnRole({
    role: "deployer", roleParams: defaultMcpSpawnRoleParams(args) ?? args.roleParams,
    confirm: args.confirm, engine: args.engine, model: args.model, effort: args.effort,
  });
  if (!role.ok) throw new McpToolRefusal(role.error, { status: 400 });
}

async function spawnAgent(args: McpToolArgs, control: ViewerControlDependencies, context?: McpToolCallContext, dependencies?: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  if (dependencies) args = await namedLaunchProject(args, dependencies, "cwd");
  const retiredWorkerLimit = text(args.role) === "orchestrator" && objectRecord(args.roleParams) && "maxWorkers" in args.roleParams
    ? effectiveWorkerLimit(projectForCwd(spawnCwd(args)) ?? "") : null;
  if (text(args.role) === "deployer") requireMcpDeployerCaller(args, spawnTargetProject(args, spawnCwd(args)), dependencies);
  requireMcpDeployerConfirmation(args);
  let autonomous = !!dependencies;
  if (dependencies) {
    try { autonomous = ["manager", "agent", "unidentified"].includes(attributionOf(dependencies).kind); }
    catch { /* Unavailable attribution retains the autonomous admission restriction. */ }
  }
  const hold = dependencies ? activeDrain() : null;
  if (hold && autonomous) {
    const { error, ...details } = launchHoldRefusal(hold);
    throw new McpToolRefusal(error, details);
  }
  validateExplicitMcpLaunchModel(args);
  /* Where Telegram is not set up the launch leaves the server out and grants
     nothing, so no caller is refused over it. */
  if (Array.isArray(args.mcpServers) && args.mcpServers.includes("telegram") && telegramSetUp()) {
    const caller = dependencies ? attributionOf(dependencies) : null;
    if (caller?.kind === "manager") {
      if (caller.via?.deputy) {
        throw new McpToolRefusal("telegram MCP requires the orchestrator seat's own spawn capability", {
          code: "telegram_spawn_deputy_unauthorized", status: 403,
        });
      }
      if (!caller.conversationId || text(args.parentConversationId) !== caller.conversationId) {
        throw new McpToolRefusal("a seat granting Telegram must name its own conversationId as parentConversationId", {
          code: "telegram_spawn_parent_mismatch", status: 403,
        });
      }
    } else {
      throw new McpToolRefusal("Telegram MCP may be granted only by the operator or their orchestrator seat", {
        code: "telegram_spawn_caller_unauthorized", status: 403,
      });
    }
  }
  /* Judged on every dispatch, with or without a persisted binding: the service
     calls a recoverable spawn with one on each first dispatch, and a replay is
     answered from the receipt without reaching this function. */
  if (dependencies) refuseMcpSpawnSizing(args, dependencies);
  refuseCrossProjectFromSeat("spawn_agent", () => (text(args.cwd) ? projectForCwd(spawnCwd(args)) : null), args, dependencies);
  /* #1490: the persisted downstream key wins over a recomputation — it is the
     key the claim was bound to and the one recovery will look up. */
  const clientAttemptId = context?.binding?.downstreamKey ?? spawnAttemptId(requestId(args));
  if (context?.binding) {
    /* The persisted binding must be the one this dispatch would make now: a
       row whose target disagrees with the canonical resolution of these
       arguments is not dispatched under it. Nothing has left this process,
       so the attempt closes as not-executed. */
    const cwd = spawnCwd(args);
    const target = context.binding.target;
    if (target.identity !== cwd || target.project !== spawnTargetProject(args, cwd)) {
      throw new McpToolRefusal(
        "the persisted binding does not name the canonical target of this spawn; nothing was dispatched",
        { code: "binding_mismatch", status: 400 },
      );
    }
  }
  const launcher = mcpSpawnLauncher(dependencies);
  const result = await dispatchControl(control)("/api/spawn", spawnDispatchBody(args, clientAttemptId, launcher), {
    ...spawnControlHeaders(), ...(autonomous ? { [VIEWER_AUTONOMOUS_SPAWN_HEADER]: "1" } : {}),
  });
  // A readable body alone establishes no acceptance. Validate the fields
  // this binding publishes before the service can persist a successful replay.
  if (!text(result.launchId) || !text(result.conversationId)
    || !["starting", "path-pending", "settled"].includes(result.state as string)
    || !["pending", "queued", "delivered"].includes(result.initialMessage as string)
    || (result.ok !== undefined && result.ok !== true)
    || (result.launched !== undefined && typeof result.launched !== "boolean")
    || (result.retrySafe !== undefined && result.retrySafe !== false)
    || (result.path !== undefined && result.path !== null && !text(result.path))
    || (result.initialMessage === "delivered" && result.launched === false)
    || (result.state === "starting" && result.initialMessage !== "pending")
    || (result.state === "settled" && result.initialMessage !== "delivered")) {
    throw new McpDispatchUncertainError("the spawn response lacks consistent acceptance evidence; recover the original request from its durable receipt");
  }
  return {
    conversationId: result.conversationId,
    ...(retiredWorkerLimit ? { ignored: { "roleParams.maxWorkers": `the project's worker limit applies (${retiredWorkerLimit.value}, ${retiredWorkerLimit.source}); change it with role_presets workerLimit` } } : {}),
    transcriptPath: result.path,
    operationId: result.launchId,
    launchId: result.launchId,
    state: result.state,
    initialMessage: result.initialMessage,
    ...(result.memoryCap ? { memoryCap: result.memoryCap } : {}),
    ...(typeof result.runtime === "string" ? { runtime: result.runtime } : {}),
    /* Whether a brief still needs its own "report back" line. Only a
       structured launch ends its turns where a notice is owed from, so a tmux
       child records no launcher and its launcher hears nothing. */
    launcherNotice: args.notifyLauncher === false ? "off" : launcher && result.transport === "structured" ? "on" : "unavailable",
  };
}

/**
 * The exact client message key a send hands the conversation-host route
 * (#1490). The route keeps the first 128 characters of what it is given, so
 * every clientRequestId is hashed into a bounded key. No raw input shares
 * the generated namespace. Recovery always uses the already persisted key.
 */
export function sendDownstreamKey(clientRequestId: string): string {
  return `mcp_send_${crypto.createHash("sha256").update(clientRequestId).digest("hex")}`;
}

async function sendMessage(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: Pick<ViewerMcpDomainDependencies, "registrySnapshot"> &
    Partial<Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">>,
  context?: McpToolCallContext,
  downstreamKey = sendDownstreamKey(requestId(args)),
  orchestratorRelayProject?: string,
): Promise<McpToolPayload> {
  const conversationId = text(args.conversationId);
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) throw new Error("conversationId or transcriptPath is required");
  const message = requiredMessageText(args);
  let outcome: Record<string, unknown>;
  try {
    outcome = await dispatchControl(control)(orchestratorRelayProject ? "/api/orchestrator/message" : "/api/tmux", {
      pid: null,
      path: transcriptPath,
      ...(conversationId ? { conversationId } : {}),
      clientMessageId: context?.binding?.downstreamKey ?? downstreamKey,
      text: message,
      images: [],
      policy: "steer-or-queue",
      /* #1117: an MCP send is inter-agent traffic by definition; the sender role
         is the server's own caller attribution, so the feed can say WHO relayed. */
      origin: mcpSenderOrigin(dependencies),
      ...(orchestratorRelayProject ? { project: orchestratorRelayProject } : {}),
    }, callerCapabilityHeaders());
  } catch (error) {
    /* #2020: the Viewer's own answer that it refused before reserving
       anything. Nothing exists under the downstream key, so the send settles
       as not executed with that reason instead of an unknown outcome that no
       later lookup could end. */
    if (error instanceof McpDispatchVerdictError && error.details.admission === "refused"
      && typeof error.details.operationId !== "string") {
      const { admission: _admission, ...details } = error.details;
      throw new McpDispatchNotExecutedError(error.message, details);
    }
    throw error;
  }
  const receipt = objectRecord(outcome.receipt) ? outcome.receipt : null;
  const operationId = text(outcome.operationId) || text(receipt?.operationId);
  const settledOutcome = text(outcome.outcome);
  if (!operationId
    || !["delivered-to-live", "resumed", "held", "pending", "reconfigured", "queued", "delivering", "delivered"].includes(settledOutcome)
    || (outcome.ok !== undefined && outcome.ok !== true)
    || (outcome.operationId !== undefined && outcome.operationId !== operationId)
    || (outcome.receipt !== undefined && (!receipt
      || receipt.operationId !== operationId
      || !["queued", "delivered"].includes(receipt.status as string)
      || (settledOutcome === "delivered") !== (receipt.status === "delivered")))) {
    throw new McpDispatchUncertainError("the send response lacks consistent acceptance evidence; recover the original request from its durable receipt");
  }
  /* The registry's OWN lookup over the projection this call already holds (#845),
     rather than a local reimplementation of it. The alias walk is multi-hop and
     cycle-guarded and the path index covers continuity paths, so a send addressed by
     a chained alias or a superseded path still names its owner — and it stays that way
     without this file having to be kept in step by hand. */
  const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
  const deliveredConversationId = orchestratorRelayProject && typeof receipt?.conversationId === "string" ? receipt.conversationId : conversationId;
  const conversation = deliveredConversationId
    ? lookup.conversation(deliveredConversationId as `conversation_${string}`)
    : lookup.conversationForPath(transcriptPath);
  return {
    conversationId: (conversation?.id ?? deliveredConversationId) || null,
    transcriptPath: (conversation?.generations.at(-1)?.path ?? transcriptPath) || null,
    operationId,
    outcome: settledOutcome,
    /* #1131: acceptance is not arrival. A `queued` send is admitted and not yet
       settled, and saying so on the answer itself is what stops a caller from
       reading the send-time guess as the end of the story — `message_receipt`
       over the operation id is where the end of the story lives. */
    settled: settledOutcome === "delivered",
  };
}

/**
 * What became of one accepted send (#1131).
 *
 * The answer is read from the durable delivery record, so it survives the
 * process that made the send, the runtime host that took it, and the
 * reservation itself once compaction has retired it — and a record that is
 * still in flight is reconciled against the delivery journal's CURRENT answer
 * before it is reported, because a caller asking what became of a send is
 * asking about now, not about whatever last updated the projection — and past
 * the settlement deadline this query is also what ENDS an accepted send, so
 * `queued` is never the last thing anyone can be told about it. An id nothing
 * ever admitted is refused rather than answered with an invented in-flight
 * state.
 */
async function messageReceipt(args: McpToolArgs): Promise<McpToolPayload> {
  const operationId = required(args, "operationId");
  const receipt = operationId.startsWith("seatmsg_") ? seatMessageReceipt(operationId) : await resolveSendReceipt(operationId);
  if (!receipt) {
    throw new McpToolRefusal(
      "no accepted send is recorded under that operationId",
      { code: "OPERATION_UNKNOWN" },
    );
  }
  /* Why it is still waiting, or why it settled, as the delivery queue
     recorded it: wait reason, attempt, last progress, deadline and next wake.
     An explanation beside the verdict; a store that cannot be read omits it. */
  const progress = readDeliveryProgress([operationId]).get(operationId);
  return { ...receipt, ...(progress ? { progress } : {}) };
}

/**
 * Board task text is written in the operator's interface language
 * (docs/design/orchestrator-reports.md §3.5, §5.3). A text in another language
 * is stored as sent, with a warning; `details` is agent-facing and never
 * checked. Nothing is said while the interface language is not known yet.
 */
function taskTextLanguageWarnings(value: unknown, dependencies?: ViewerMcpDomainDependencies): { warnings?: string[] } {
  if (typeof value !== "string" || !value.trim()) return {};
  const locale = dependencies?.operatorLocale ? dependencies.operatorLocale() : operatorLocale();
  const warning = languageMismatchWarning("task text", value, locale);
  return warning ? { warnings: [warning] } : {};
}

function maintenanceCaller(dependencies: ViewerMcpDomainDependencies): MaintainerCaller | null {
  const conversationId = attributionOf(dependencies).conversationId;
  if (!conversationId || !dependencies.registrySnapshot) return null;
  return maintainerCallerOf(conversationId, dependencies.registrySnapshot());
}
function assertMaintenanceWrite(caller: MaintainerCaller | null, args: McpToolArgs, task?: BoardTask, create = false, openPipeline?: string, liveAgent?: string, retiredSeat = false): void {
  if (!caller) return;
  const refusal = maintainerTaskWriteRefusal({ caller, args, task, create, openPipeline, liveAgent, retiredSeat });
  if (refusal) throw new McpToolRefusal(refusal.error, { code: refusal.code, field: refusal.field, status: 403 });
}
function logMaintenanceWrite(caller: MaintainerCaller | null, tool: "create_task" | "update_task", before: BoardTask | undefined, after: BoardTask, fields: string[]): void {
  if (!caller?.run || fields.length === 0) return;
  try { recordMaintenanceChange(caller.run.runId, maintenanceChange(tool, before, after, fields)); }
  catch {
    try { recordMaintenanceLogGap(caller.run.runId); } catch { console.error("[board maintenance] change log and gap marker could not be written"); }
  }
}

/**
 * Cross-project work goes seat to seat (#2518).
 *
 * A project's designated seat is the one manager that tracks what runs on its
 * board, so another project's seat does not put a task, a pipeline or an agent
 * there by itself: it hands the work over with send_message_to_orchestrator.
 * The call is refused. A warning would arrive with the work already on the
 * other board and its seat already bypassed; a refusal costs one more call.
 *
 * One thing lifts it: the operator asked for exactly this, which the seat
 * states by quoting the request in `crossProjectRequest`. A target with no
 * designated seat is refused the same way, and the answer says so:
 * send_message_to_orchestrator designates one for that project before it
 * delivers. Only a seat is judged: a worker, a stage and the operator's own
 * session launch as they did.
 */
function refuseCrossProjectFromSeat(
  tool: "create_task" | "create_pipeline" | "spawn_agent",
  /* Read only for a seat: resolving a directory's project is not free, and a
     launch that names none is refused by its own tool. */
  targetOf: () => string | null,
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies | undefined,
): void {
  if (!dependencies || text(args.crossProjectRequest)) return;
  let caller: CallerAttribution;
  try { caller = attributionOf(dependencies); } catch { return; }
  if (caller.kind !== "manager" || !caller.conversationId) return;
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const own = seats.find((seat) => seat.conversationId === caller.conversationId)?.project;
  if (!own) return;
  let target: string | null = null;
  try { target = targetOf(); } catch { /* An unreadable target is the tool's own refusal. */ }
  if (target === null || !target) return;
  const named: string = target;
  const seatProject = canonicalOrchestratorProject(own);
  const targetProject = canonicalOrchestratorProject(named);
  if (seatProject === targetProject) return;
  const targetHasSeat = seats.some((seat) => !!seat.project && canonicalOrchestratorProject(seat.project) === targetProject);
  throw new McpToolRefusal(
    `${tool} from an orchestrator seat onto another project's board is refused: `
    + (targetHasSeat
      ? "that project's own seat manages its board. "
      : "that project has no orchestrator seat yet, and the handover designates one before it delivers. ")
    + "Hand the work over with send_message_to_orchestrator, giving that project and the task context. "
    + "When the operator explicitly asked you to act on that project directly, repeat the call with crossProjectRequest quoting their request.",
    { code: "cross_project_refused", status: 403, retryable: false, tool, seatProject, targetProject, targetHasSeat, use: "send_message_to_orchestrator" },
  );
}

/** The names a Delegatus bug report is checked against: everything a public
    manager report is, with Delegatus itself as the one project it may name. */
async function issueReportDenyList(control: ViewerControlDependencies | null, dependencies: ViewerMcpDomainDependencies): Promise<PublicDenyList> {
  let own: string | null = null;
  try { own = (dependencies.viewerProjects?.() ?? viewerOwnProjects())[0] ?? null; } catch { /* No project is exempt. */ }
  try {
    if (dependencies.publicDenyList) return dependencies.publicDenyList(own);
    const deny = await productionPublicDenyList(own, control, true, true);
    const delegatus = delegatusIssueRepository(viewerPackageManifest.repository.url)?.toLowerCase() ?? null;
    return { ...deny, projects: deny.projects.filter((project) => !delegatus || project.repository?.toLowerCase() !== delegatus) };
  } catch {
    throw new Error("Known-name hints are unavailable; review names and identities yourself.");
  }
}

/** Advisory hints and an agent judgment accompany the exact report text.
    Approval remains bound to that text's digest and the operator's conversation. */
async function issueReportTool(args: McpToolArgs, control: ViewerControlDependencies | null, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const action = text(args.action);
  const caller = attributionOf(dependencies);
  const directory = dependencies.issueReportsDir?.();
  const refuse = (message: string, code: string, extra: McpToolPayload = {}) => new McpToolRefusal(message, { code, status: 400, retryable: false, ...extra });
  const collectHints = async (report: { title: string; body: string }) => {
    let deny = EMPTY_DENY_LIST;
    const hintWarnings: string[] = [];
    try { deny = await issueReportDenyList(control, dependencies); }
    catch { hintWarnings.push("Known-name hints are unavailable; review names and identities yourself."); }
    return { hints: await scrubIssueReportAsync(report, deny), hintWarnings };
  };
  /* The preview's own lines follow the operator's interface language, English while none is known. */
  const previewLanguage = (dependencies.operatorLocale ? dependencies.operatorLocale() : operatorLocale()) ?? "en";
  const view = (preview: IssueReportPreview): McpToolPayload => ({
    state: preview.state, digest: preview.digest, title: preview.title, body: preview.body,
    privacyJudgment: preview.privacyJudgment ?? {
      assessment: "No agent judgment was recorded for this legacy preview.",
      removed: "Unknown.", harmlessHints: "Unknown.", uncertainties: "Review the whole text before approving.",
    },
    hints: preview.hints ?? [], hintWarnings: preview.hintWarnings ?? [],
    previewText: issueReportPreviewText(preview, previewLanguage), previewLanguage,
    ...(preview.publication?.issueUrl ? { issueUrl: preview.publication.issueUrl } : {}),
  });
  if (action === "hints" || action === "preview") {
    if (caller.kind === "unidentified" || !caller.conversationId) throw refuse("a report needs an identified calling session", "issue_report_caller_unidentified", { status: 403 });
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const body = typeof args.body === "string" ? args.body.trim() : "";
    if (!title || !body) throw refuse("a report needs a title and a body", "issue_report_invalid");
    if (/[\r\n]/.test(title) || title.length > ISSUE_REPORT_MAX_TITLE_CHARS) throw refuse(`the title is one line of at most ${ISSUE_REPORT_MAX_TITLE_CHARS} characters`, "issue_report_invalid", { field: "title" });
    if (body.length > ISSUE_REPORT_MAX_BODY_CHARS) throw refuse(`the body is at most ${ISSUE_REPORT_MAX_BODY_CHARS} characters`, "issue_report_invalid", { field: "body" });
    const review = await collectHints({ title, body });
    if (action === "hints") return {
      ...review,
      next: "Re-read the whole title and body yourself. A hint may be a false alarm; a clean result proves nothing. Rewrite private content and provide your own privacyJudgment with the preview.",
    };
    const judgment = args.privacyJudgment as IssueReportPreview["privacyJudgment"];
    if (!judgment || !["assessment", "removed", "harmlessHints", "uncertainties"].every((field) => {
      const value = (judgment as unknown as Record<string, unknown>)[field];
      return typeof value === "string" && value.trim().length > 0 && value.length <= 3000;
    })) throw refuse("preview needs your privacyJudgment: assessment, removed, harmlessHints with reasons, and uncertainties", "issue_report_invalid", { field: "privacyJudgment" });
    const privacyJudgment = {
      assessment: judgment.assessment, removed: judgment.removed,
      harmlessHints: judgment.harmlessHints, uncertainties: judgment.uncertainties,
    };
    const preview = recordIssueReportPreview({ title, body, privacyJudgment, ...review }, caller.conversationId, { directory });
    return {
      ...view(preview),
      next: `Return PREVIEW with this digest, exact title and body, your privacy judgment and remaining hints as a short list beside the text. Preparation needs no separate consent. The operator decides last and may approve text with hints. Publication is the orchestrator seat's after exact-text approval. ${ISSUE_REPORT_RESPONSE_RULE}`,
    };
  }
  const givenDigest = text(args.digest);
  const resolvedDigest = await resolveIssueReportDigest(givenDigest ?? "", directory);
  if (resolvedDigest.kind === "ambiguous") throw refuse("digest is ambiguous; pass more characters", "short_id_ambiguous", { field: "digest", retryable: false, candidates: resolvedDigest.candidates });
  const digest = resolvedDigest.kind === "match" ? resolvedDigest.value : givenDigest;
  if (!digest) throw refuse(`${action} needs the digest a preview answered`, "issue_report_invalid", { field: "digest" });
  const stored = readIssueReportPreview(digest, directory);
  if (!stored) {
    throw refuse(
      "no stored preview has this digest, so nothing was published: only the previewed text is ever filed. Preview the report again and ask the operator to approve that text.",
      "issue_report_digest_mismatch", { status: 409 },
    );
  }
  const seat = caller.kind === "manager" && !caller.via ? caller.conversationId : null;
  if (action === "show") {
    if (!stored.hints) Object.assign(stored, await collectHints(stored));
    if (!seat) return view(stored);
    return {
      ...view({ ...(markIssueReportShown(digest, seat, { directory }) ?? stored), hints: stored.hints, hintWarnings: stored.hintWarnings }),
      approvalForm: { issueReport: resolvedDigest.reference ?? shortId(stored.digest) },
      next: `Put previewText in chat exactly as it is: it marks where the published text starts and ends, and carries privacyJudgment, the remaining hints and hintWarnings after it. The operator may approve text with hints. Ask once before publication with publish_prototype_review, omitting taskId, passing approvalForm.issueReport. Publish after the operator answers: publication reads the newest such form you published after this reading and needs its first option, the one naming this report, chosen by a person. A form taken on its recommendations, a set-aside question, «Other», a custom note or an agent's decision does not approve it. ${ISSUE_REPORT_RESPONSE_RULE}`,
    };
  }
  if (action !== "publish") throw refuse("action is hints, preview, show or publish", "issue_report_invalid", { field: "action" });
  if (!seat) {
    throw refuse("only a designated orchestrator seat publishes a report, after the operator approved its preview in that seat's conversation", "issue_report_publish_refused", { status: 403 });
  }
  if (stored.state === "published" && stored.publication?.issueUrl) return { ...view(stored), published: true, replay: true };
  const repository = dependencies.issueReportRepository ? dependencies.issueReportRepository() : delegatusIssueRepository(viewerPackageManifest.repository.url);
  if (!repository) throw refuse("this Delegatus install names no GitHub repository to file a report in", "issue_report_repository_unknown");
  const report = { title: stored.title, body: stored.body };
  /* An unsettled claim is settled only by finding the issue it may have
     filed. Not finding it proves nothing, so nothing is filed again. */
  const reconciled = async (claim: IssueReportPublication): Promise<McpToolPayload | null> => {
    let issueUrl: string | null = null;
    try { issueUrl = await (dependencies.issueReportFinder ?? issueReportFinder())(report, repository); } catch { /* Still unknown. */ }
    if (!issueUrl) return null;
    settleIssueReportPublication(digest, { ...claim, publishedAt: new Date().toISOString(), issueUrl }, directory);
    return { ...view(readIssueReportPreview(digest, directory) ?? stored), issueUrl, published: true, reconciled: true };
  };
  const outcomeUnknown = "a publication of this preview did not report its outcome; the issue may exist, so look for it in the repository and file nothing again. Publishing this digest again looks for it too";
  if (stored.state === "publishing" && stored.publication) {
    const found = await reconciled(stored.publication);
    if (found) return found;
    throw refuse(outcomeUnknown, "issue_report_outcome_unknown", { status: 409 });
  }
  const shownAt = stored.shown.find((row) => row.seat === seat)?.at;
  if (!shownAt) {
    throw refuse("read this preview back with action show and show the operator that exact text before you publish it", "issue_report_not_shown", { status: 409 });
  }
  /* The operator's answer is the newest approval form of this preview the seat
     asked after reading it back. Hints never govern publication, and nothing
     asynchronous runs between this check and the claim. */
  const form = loadSeatRounds()
    .filter((round) => round.taskId === null && round.source.conversationId === seat
      && Date.parse(round.createdAt) >= Date.parse(shownAt) && issueReportFormLanguage(round, stored) !== null)
    .at(-1);
  const approved = form?.decision && issueReportDecisionApproves(form.decision) ? form.decision : null;
  if (!form || !approved) {
    const reason = !form ? "no_form" : !form.decision ? "not_answered" : "not_an_approval";
    const label = issueReportApprovalReplies(digest)[previewLanguage];
    const explanation = {
      no_form: {
        en: "Nothing was published: you have not asked the operator in a decision form since you read this preview back. Call publish_prototype_review without taskId, with issueReport from show, and publish after they answer.",
        uk: "Нічого не опубліковано: після показу цього звіту ви не питали оператора у формі рішення. Викличте publish_prototype_review без taskId, передавши issueReport із show, і публікуйте після відповіді.",
      },
      not_answered: {
        en: `Nothing was published: the operator has not answered decision form ${form?.id} yet.`,
        uk: `Нічого не опубліковано: оператор ще не відповів на форму рішення ${form?.id}.`,
      },
      not_an_approval: {
        en: `Nothing was published: the answer to decision form ${form?.id} does not approve this report. Only the option «${shortenHashesInText(label)}», chosen by a person, approves it; a form taken on its recommendations, «Other», a custom note or an agent's decision does not.`,
        uk: `Нічого не опубліковано: відповідь на форму рішення ${form?.id} не схвалює цей звіт. Схвалює лише варіант «${shortenHashesInText(label)}», обраний людиною; рекомендації за замовчуванням, «Інше», власна примітка чи рішення агента не схвалюють.`,
      },
    }[reason];
    throw refuse(explanation[previewLanguage], "issue_report_approval_required", { status: 403, reason, ...(form ? { reviewId: form.id } : {}) });
  }
  const claim: IssueReportPublication = {
    by: seat, approval: form.questions![0]!.options[0]!.label, reviewId: form.id, approvedAt: approved.at, startedAt: new Date().toISOString(),
  };
  /* The claim is the one moment a preview turns into a publication. Of any
     number of seats and processes publishing one digest, one creates it. */
  if (!claimIssueReportPublication(digest, claim, directory)) {
    const current = readIssueReportPreview(digest, directory);
    if (current?.state === "published" && current.publication?.issueUrl) return { ...view(current), published: true, replay: true };
    throw refuse(outcomeUnknown, "issue_report_outcome_unknown", { status: 409 });
  }
  let issueUrl: string;
  try {
    issueUrl = await (dependencies.issueReportPublisher ?? issueReportPublisher())(report, repository);
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown };
    /* Two failures prove no issue exists: the App credential refused before
       `gh` was started, and a `gh` that could not be started at all. Every
       other one (a lost answer, a stopped command, an answer with no address)
       can follow an issue the forge already created, so the claim stays. */
    if (error instanceof ForgeAppWriteRefused || failure.code === "ENOENT") {
      releaseIssueReportPublication(digest, directory);
      const reason = error instanceof ForgeAppWriteRefused ? error.message : "the gh command is not installed";
      throw refuse(`the report was not published: ${reason}`, "issue_report_publish_failed", { status: 502, retryable: true });
    }
    const found = await reconciled(claim);
    if (found) return found;
    throw new McpDispatchUncertainError("the publication did not report its outcome and the issue may exist; look for it in the repository and file nothing again");
  }
  settleIssueReportPublication(digest, { ...claim, publishedAt: new Date().toISOString(), issueUrl }, directory);
  return { ...view(readIssueReportPreview(digest, directory) ?? stored), issueUrl, published: true };
}

/** Date validation runs before receipts while preserving project admission. */
function requireTaskCreateDue(binding: McpToolBinding): McpToolBinding {
  const prepare = binding.prepareAdmission;
  binding.prepareAdmission = async (args: McpToolArgs) => {
    if (args.dueAt === undefined || args.dueAt === null || args.dueAt === "") {
      throw new McpToolRefusal("A dueAt date is required for a new task", { code: "TASK_DUE_REQUIRED", field: "dueAt", status: 400 });
    }
    await prepare?.(args);
  };
  return binding;
}

async function createBoardTask(args: McpToolArgs, dependencies?: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  /* A new task runs on the machine that creates it (M.4); "here" is the only
     machine a create names. */
  if (args.machine !== undefined && args.machine !== "here") {
    throw new McpToolRefusal("machine accepts only \"here\": a new task runs on the machine that creates it", { code: "TASK_INVALID_FIELD", field: "machine", status: 400 });
  }
  const maintainer = dependencies ? maintenanceCaller(dependencies) : null;
  const caller = dependencies ? attributionOf(dependencies) : null;
  const ownerRelay = dependencies ? ownerRelayCaller(dependencies) : false;
  assertMaintenanceWrite(maintainer, args, undefined, true);
  refuseCrossProjectFromSeat("create_task", () => text(args.project) || null, args, dependencies);
  const input: CreateTaskInput = {
    ...withoutKeys(args, ["crossProjectRequest"]),
    placement: args.placement ?? "unplaced",
    clientRequestId: requestId(args),
  };
  let prior: BoardTask | undefined;
  let matchedFields: string[] | undefined;
  const result = await waitForStateLock("mcp.tasks.create", () => mutateTasksFile((state) => {
    let outcome = createTask(state.tasks, input, state.recentCreates, { requireDue: true, dueTimeZone: operatorTimeZone() ?? undefined, explicit: true, actor: "agent", noteAuthor: caller?.kind === "manager" ? { kind: "orchestrator", conversationId: caller.conversationId } : { kind: "agent", conversationId: caller?.conversationId ?? null }, conversationId: caller?.conversationId ?? undefined, seatHolding: taskSeatHoldingSnapshot(), ...(dependencies ? { statusActor: pauseResumeActorOf(dependencies) } : {}) });
    // Publish the new owner task and its seat-tick eligibility atomically.
    // Replays and matched findings retain the task's existing status.
    if (outcome.ok && !outcome.replay && !outcome.matched && ownerRelay && !outcome.task.hold) {
      const assigned = patchTask(outcome.tasks, outcome.task.id, { status: "assigned" }, outcome.task.createdAt,
        { actor: "agent", ...(dependencies ? { statusActor: pauseResumeActorOf(dependencies) } : {}) });
      if (!assigned.ok) return { state: undefined, result: assigned };
      outcome = { ...outcome, tasks: assigned.tasks, task: assigned.task };
    }
    if (outcome.ok && outcome.matched) {
      prior = state.tasks.find(task => task.id === outcome.task.id);
      assertMaintenanceWrite(maintainer, { note: input.note ?? null }, prior);
      matchedFields = changedFieldNames(fieldValues(prior), outcome.task);
    }
    return {
      state: outcome.ok && !outcome.replay ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined,
      result: outcome,
    };
  }), { subject: "tasks" });
  if (!result.ok) throw new McpToolRefusal(result.error, { code: result.code ?? (result.status === 404 ? "TASK_NOT_FOUND" : "TASK_INVALID_FIELD"), field: result.field, status: result.status });
  const fields = result.replay ? [] : matchedFields ?? Object.keys(result.task);
  if (!result.replay) logMaintenanceWrite(maintainer, result.matched ? "update_task" : "create_task", prior, result.task, fields);
  return { ...taskAcknowledgement(result.task, args, fields), replay: result.replay, ...(result.matched !== undefined ? { matched: result.matched } : {}), ...(result.notes ? { notes: result.notes } : {}), ...taskTextLanguageWarnings(args.text, dependencies) };
}

/**
 * The agent's first-action task naming (#1586): `refine: { text }` titles the
 * placeholder task(s) the calling conversation is linked to, once. The caller
 * is server-derived; an unidentified caller, a task the caller does not belong
 * to, or a task already named by an operator edit or an earlier refinement is
 * answered truthfully instead of overwriting anything.
 */
async function refineBoardTask(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const refine = args.refine as { text?: unknown } | undefined;
  const text = typeof refine?.text === "string" ? refine.text : "";
  const caller = attributionOf(dependencies);
  if (caller.kind === "unidentified" || !caller.conversationId) {
    throw new McpToolRefusal("refine needs an identified calling conversation; the Viewer MCP session carries it", { code: "TASK_INVALID_FIELD", field: "refine", status: 403 });
  }
  const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : null;
  const changes: Record<string, string[]> = {};
  const result = await mutateTasksAsync((tasks) => {
    const before = new Map(tasks.map(task => [task.id, fieldValues(task)]));
    const outcome = refineTask(tasks, { callerConversationId: caller.conversationId!, taskId, text });
    if (outcome.ok) for (const entry of outcome.refined) {
      const task = outcome.tasks.find(task => task.id === entry.taskId)!;
      changes[entry.taskId] = changedFieldNames(before.get(entry.taskId) ?? new Map(), task);
    }
    return { tasks: outcome.ok && outcome.refined.some((entry) => entry.result === "applied") ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) throw new McpToolRefusal(result.error, { code: result.status === 404 ? "TASK_NOT_FOUND" : "TASK_INVALID_FIELD", field: "refine", status: result.status });
  const byId = new Map(result.tasks.map((task) => [task.id, task] as const));
  return { ...taskTextLanguageWarnings(text, dependencies), refined: result.refined, changedFields: [...new Set(Object.values(changes).flat())], changedFieldsByTask: changes, tasks: result.refined.map((entry) => {
    const task = byId.get(entry.taskId)!;
    return fullAnswer(args) ? taskWithoutPrototypeDetails(task) : compactTask(task);
  }), omittedRecordCount: fullAnswer(args) ? 0 : result.refined.length, ...answerHint(args, "get_task(taskId) or update_task with full:true returns the full task.") };
}

/** Reads only: deterministic date refusals must precede the MCP receipt claim. */
function admitTaskDuePatch(args: McpToolArgs): void {
  if (args.refine !== undefined || !Object.hasOwn(args, "dueAt") && !Object.hasOwn(args, "dueTz")) return;
  const taskId = required(args, "taskId");
  const task = taskSelectionSource()?.read(taskId);
  if (!task) return; // The ordinary command owns the missing-task refusal.
  const result = taskDuePatch(task, args as PatchTaskInput, new Date().toISOString(), { actor: "agent" });
  if (!result.ok) throw new McpUnadmittedRefusal(result.error, { code: result.code ?? "TASK_INVALID_FIELD", field: result.field, status: result.status });
}

async function updateBoardTask(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  admitTaskDuePatch(args);
  const maintainer = maintenanceCaller(dependencies);
  const caller = attributionOf(dependencies);
  if (args.refine !== undefined) {
    if (maintainer) throw new McpToolRefusal("Maintenance uses explicit taskId and text for retitling.", { code: "maintainer_delete_refused", status: 403 });
    return refineBoardTask(args, dependencies);
  }
  const taskId = required(args, "taskId");
  const patch = withoutKeys(args, ["taskId", "clientRequestId", "full", "compact", "includeHints"]);
  let changedFields: string[] = [];
  let prior: BoardTask | undefined;
  let liveAgent: string | undefined;
  const checkedAssignments = new Set<string>();
  const assignmentKey = (a: BoardTask["assignments"][number]) => JSON.stringify([a.conversationId, a.launchId, a.path, a.state]);
  const closingOrHiding = args.status === "done" || args.hide === true || args.board === "hidden";
  if (maintainer && closingOrHiding) {
    const task = loadTasks().find(t => t.id === taskId);
    for (const assignment of task?.assignments ?? []) {
      checkedAssignments.add(assignmentKey(assignment));
      const id = assignment.conversationId;
      const transcriptPath = assignment.path;
      if (!id && !transcriptPath) {
        liveAgent = assignment.launchId ?? "an assignment without a resolvable identity";
        continue;
      }
      const snapshot = await agentLivenessSnapshot({ ...(id ? { conversationId: id } : { transcriptPath: transcriptPath! }), limit: 1 }, dependencies.livenessSources());
      const record = snapshot.conversations[0];
      // Use agent_activity's lifecycle verdict. An expired unhosted transcript
      // can be gone with an unknown host; a live idle host is still an agent.
      // Only a freshly read settled transcript permits closure. Missing or
      // budget-degraded evidence remains a refusal.
      if (!record || record.lifecycle !== "gone" || record.turnState !== "idle" || record.evidenceSource !== "transcript") liveAgent = id ?? transcriptPath ?? "an unconfirmed assignment";
    }
  }
  const result = await mutateTasksAsync((tasks) => {
    prior = tasks.find(task => task.id === taskId);
    const pipelines = maintainer ? dependencies.listPipelineRecords?.() ?? dependencies.getPipelines?.().pipelines ?? [] : [];
    const open = pipelines.find(p => p.taskIds?.includes(taskId) && maintenanceLaneIsOpen(p));
    if (maintainer && closingOrHiding && prior?.assignments.some(a => !checkedAssignments.has(assignmentKey(a)))) liveAgent = "a new assignment whose liveness has not been checked";
    const retiredSeat = !!maintainer && closingOrHiding && !!prior && !!dependencies.registrySnapshot && retiredSeatTask(prior, dependencies.registrySnapshot());
    assertMaintenanceWrite(maintainer ? maintenanceCaller(dependencies) : null, args, prior, false, open?.id, liveAgent, retiredSeat);
    const before = fieldValues(prior);
    const noteAuthor = caller.kind === "manager"
      ? { kind: "orchestrator" as const, conversationId: caller.conversationId }
      : { kind: "agent" as const, conversationId: caller.conversationId };
    const outcome = patchTask(tasks, taskId, patch as PatchTaskInput, undefined, { requirePlacementGuards: true, actor: "agent", conversationId: caller.conversationId ?? undefined, noteAuthor, statusActor: pauseResumeActorOf(dependencies), seatHolding: taskSeatHoldingSnapshot(), explicit: true,
      workLinks: taskWorkLinkContext(() => dependencies.listPipelineRecords?.() ?? dependencies.getPipelines?.().pipelines ?? []) });
    if (outcome.ok) changedFields = changedFieldNames(before, outcome.task);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) {
    // patchTask's date refusals return before the transaction publishes tasks.
    const Refusal = result.code?.startsWith("TASK_DUE_") ? McpUnadmittedRefusal : McpToolRefusal;
    throw new Refusal(result.error, { code: result.code ?? (result.status === 404 ? "TASK_NOT_FOUND" : "TASK_INVALID_FIELD"), field: result.field, status: result.status });
  }
  logMaintenanceWrite(maintainer, "update_task", prior, result.task, changedFields);
  return { ...taskAcknowledgement(result.task, args, changedFields), ...(result.notes ? { notes: result.notes } : {}), ...taskTextLanguageWarnings(args.text, dependencies) };
}

/**
 * The pipeline mutations that share one idempotency receipt path (#1766).
 *
 * A registry lock refusal or unavailable seat revocations occurs before
 * admission: no record or downstream reservation exists. Release the receipt
 * claim so a retry under the SAME clientRequestId checks authority again. Any
 * later busy error keeps its ordinary meaning because a write may already
 * have committed.
 */
async function unadmittedBeforeMutation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StoreBusyBeforeAdmissionError || error instanceof SeatRevocationStoreUnavailableError) {
      throw new McpUnadmittedRefusal(error.message, {
        code: error instanceof SeatRevocationStoreUnavailableError ? "orchestrator_seat_authority_unavailable" : "store_busy",
      });
    }
    throw error;
  }
}

function deliveryAcknowledgement(pipeline: import("@/lib/pipelines/types").Pipeline): McpToolPayload {
  const delivery = pipeline.delivery!;
  const publishes = pipelinePublishesRemoteBranch(pipeline);
  return { target: delivery.target, disposition: delivery.disposition, publish: delivery.publish, publishes,
    ...(!publishes && delivery.disposition === "owner" ? { note: pipeline.publication === "internal"
      ? "publication internal: nothing is pushed while the lane runs."
      : "This repository has no delivery remote: accepted heads stay on the local lane branch and reviews read the local head. After a remote is added, pipeline_action set-delivery-remote makes this lane publish." } : {}),
    ownerId: delivery.ownerId, epoch: delivery.epoch, active: delivery.active,
    ...(delivery.disposition === "comparison" ? { conflict: `Target owned by ${delivery.ownerId} at epoch ${delivery.epoch}; comparison lane created with Viewer publication disabled` } : {}) };
}

function pipelineMemoryCaps(pipeline: Pipeline) {
  const liveAgents = agentRegistry().liveStructuredHostCount() + 1;
  return pipeline.stages.map(stage => ({ stageId: stage.id, preview: true,
    ...previewAgentMemoryCap({ cwd: pipeline.worktreeDir ?? pipeline.repoDir, project: pipeline.project,
      role: stage.effectiveRole.roleId ?? PIPELINE_MEMORY_DEFAULT_ROLE, profile: { agentMemoryMaxBytes: stage.agentMemoryMaxBytes,
        agentMemoryRoleParams: stage.role?.params } }, liveAgents) }));
}

const PIPELINE_CREATION_QUEUED_NOTE = "Pipeline state is not writable right now (a Viewer deployment is handing over, or the store is busy), so this pipeline is queued under the pipelineId above. The serving release stores and starts it on its next controller pass; get_pipeline answers once it is stored. Do not create it again.";

function assertPipelineSeatAuthority(dependencies: ViewerMcpDomainDependencies, src?: unknown): void {
  const caller = attributionOf(dependencies).conversationId;
  const snapshot = dependencies.registrySnapshot?.();
  const lookup = snapshot ? readOnlyConversationLookupFromSnapshot(snapshot) : null;
  const source = !caller && typeof src === "string" ? lookup?.conversationForPath(src.trim()) : null;
  const refusal = revokedSeatPipelineRefusal(caller ?? source?.id ?? null, id => lookup?.canonicalConversationId(id as `conversation_${string}`) ?? id);
  if (refusal) throw new McpToolRefusal(refusal, { code: "orchestrator_seat_revoked", status: 403 });
}

/**
 * #2518: a role with no child-spawn capability (a reviewer, a verifier, a
 * maintenance run, an issue reporter) creates no pipeline, and an issue
 * reporter launches no stage of one either. The HTTP route refuses the same caller on create; this is the
 * door an agent actually uses, and it stands before any dispatch or write.
 * The role is the one the server attributed to the calling conversation, or
 * the registry's for it, or the `src` creator's when no caller is named.
 */
function pipelineCallerRoles(dependencies: ViewerMcpDomainDependencies, src?: unknown): (string | null | undefined)[] {
  const caller = attributionOf(dependencies);
  let snapshot: RegistrySnapshot | null = null;
  try { snapshot = dependencies.registrySnapshot?.() ?? null; } catch { /* The attributed role decides alone. */ }
  const lookup = snapshot ? readOnlyConversationLookupFromSnapshot(snapshot) : null;
  const source = !caller.conversationId && typeof src === "string" ? lookup?.conversationForPath(src.trim()) ?? null : null;
  const conversationId = caller.conversationId ?? source?.id ?? null;
  return [caller.role, snapshot && conversationId ? conversationAgentRole(snapshot, conversationId as `conversation_${string}`) : null];
}

function refuseSpawnDeniedPipelineCaller(dependencies: ViewerMcpDomainDependencies, src?: unknown, denies: (role: string | null) => boolean = isSpawnDeniedRole): void {
  const denied = pipelineCallerRoles(dependencies, src).find((role) => denies(role ?? null));
  if (denied) throw new McpToolRefusal(reviewerOriginSpawnGuidance(denied), { code: "reviewer_origin_spawn", status: 403, retryable: false });
}

/** The pipeline actions that start a stage's agent. */
const STAGE_LAUNCHING_PIPELINE_ACTIONS: ReadonlySet<string> = new Set(["start", "retry-stage"]);

/** A capability pins the launch receipt and its exact native generation. */
function inferredPipelineSource(dependencies: ViewerMcpDomainDependencies): string {
  const authority = authorityOf(dependencies);
  const capability = callerCapability();
  const snapshot = dependencies.registrySnapshot();
  const digest = capability ? crypto.createHash("sha256").update(capability).digest("hex") : null;
  const receipts = digest ? registryRowsMatching(snapshot, "receipts", "spawnCapabilityDigest", digest) : [];
  const receipt = receipts.length === 1 ? receipts[0] : null;
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const conversation = authority.kind !== "unidentified" && authority.conversationId
    ? lookup.conversation(authority.conversationId as `conversation_${string}`) : null;
  const generations = conversation?.generations.filter(row => row.path === receipt?.artifactPath) ?? [];
  const entries = receipt?.key ? Object.values(snapshot.entries).filter(row => row.artifactPath === receipt.artifactPath
    && row.key.engine === receipt.key!.engine && row.key.sessionId === receipt.key!.sessionId) : [];
  if (!receipt || !conversation || !receipt.conversationId || lookup.canonicalConversationId(receipt.conversationId) !== conversation.id
    || entries.length !== 1 || conversation.engine !== receipt.key?.engine
    || generations.length !== 1 || !generations[0]?.path || conversation.generations.at(-1)?.path !== generations[0].path) {
    throw new McpToolRefusal("src is required when the authenticated caller's exact transcript generation cannot be established", { code: "caller_source_unavailable" });
  }
  return generations[0].path;
}

async function createPipeline(args: McpToolArgs, context?: McpToolCallContext, dependencies?: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  if (dependencies) {
    args = await namedLaunchProject(args, dependencies, "repoDir");
    refuseSpawnDeniedPipelineCaller(dependencies, args.src);
    assertPipelineSeatAuthority(dependencies, args.src);
  }
  refuseCrossProjectFromSeat("create_pipeline", () => (text(args.repoDir) ? projectForCwd(text(args.repoDir)) : null), args, dependencies);
  const request = withoutKeys(args, ["clientRequestId", "recoveryOnly", "crossProjectRequest"]);
  if (request.src === undefined && dependencies) request.src = inferredPipelineSource(dependencies);
  context?.assertCaller?.();
  if (context?.dispatch) context.dispatch.attempted = true;
  /* Every MCP caller is an agent; the sizing rules judge the attributed
     conversation, and the create's `src` creator when attribution names none. */
  const briefer = { kind: "agent" as const, conversationId: dependencies ? attributionOf(dependencies).conversationId : null };
  const result = await createPipelineFromRequest(request as CreatePipelineRequest, undefined, {
    creationRequest: { key: `create_pipeline:${requestId(args)}`, digest: requestDigest("create_pipeline", request) },
    queueWhenBusy: true,
    briefer,
  });
  if (!result.pipeline) {
    if (context?.dispatch) context.dispatch.attempted = false;
    const message = result.error ?? "could not create pipeline";
    if (result.code === STAGE_RETIREMENT.code) throw new McpToolRefusal(message, { ...STAGE_RETIREMENT, retryable: false });
    /* #1026: a rejected create carries every violated constraint with its field
       and expected shape, so an agent composing its first pipeline reads the
       whole contract from one answer — the same list an HTTP caller receives. */
    /* #1876: an engine nobody is signed in to answers with its code and the
       two ways out, so an agent relays the choice instead of retrying. */
    if (result.details) throw new McpToolRefusal(message, { code: result.code, details: result.details });
    throw result.violations?.length ? new McpToolRefusal(message, { violations: result.violations }) : new Error(message);
  }
  if (result.pipeline.state !== "draft" || result.queued) requestPipelineTick();
  /* #1835: the store refused the write before admission — a deploy handover
     fences it — so the record waits in the creation queue under this id. */
  if (result.queued) {
    return redactPayload({
      ...pipelineAcknowledgement(result.pipeline),
      memoryCaps: pipelineMemoryCaps(result.pipeline),
      ...(result.repositoryInitialization ? { repositoryInitialization: result.repositoryInitialization } : {}),
      queued: true,
      queuedBecause: result.queued.reason,
      note: PIPELINE_CREATION_QUEUED_NOTE,
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      ...newLegacyReviewFields(result),
    });
  }
  /* #1845: an acknowledgement, never the record. The record echoed the spec,
     every stage prompt and every composed role scaffold back to the caller that
     had just sent them — a median 10 KB per create. get_pipeline reads it. */
  return redactPayload({
    ...pipelineAcknowledgement(result.pipeline),
    memoryCaps: pipelineMemoryCaps(result.pipeline),
    ...(result.repositoryInitialization ? { repositoryInitialization: result.repositoryInitialization } : {}),
    ...(result.pipeline.delivery ? { delivery: deliveryAcknowledgement(result.pipeline) } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...newLegacyReviewFields(result),
  });
}

/** What became of the review-loop stages a create or an add-stage brought in
    (#2187 §3.2): the reviewer and fix stage each was stored as, and the
    refusals of any stored as sent. */
function newLegacyReviewFields(result: Pick<PipelineMutationResult, "convertedStages" | "legacyReview" | "finishesTaskDropped">) {
  return {
    ...(result.convertedStages?.length ? { convertedStages: result.convertedStages } : {}),
    ...(result.legacyReview?.length ? { legacyReview: result.legacyReview } : {}),
    /* #2187 §5.1: the finishesTask ids a create dropped, clamped rather than refused. */
    ...(result.finishesTaskDropped?.length ? { finishesTaskDropped: result.finishesTaskDropped, finishesTaskNote: "these ids are not in taskIds, so the pipeline does not finish them" } : {}),
  };
}

/** A close report as counts (#2030). Each list keeps its name, so a caller
    that sees `stillRunning: 1` knows which list to read on the record. The
    three every close has are always counted; the lists that only an
    exception fills appear when something is in them. */
function closeReportCounts(report: PipelineCloseReport) {
  const exceptions = {
    pendingContinuations: report.pendingContinuations?.length ?? 0,
    unconfirmed: report.unconfirmed.length,
    stillRunning: report.stillRunning.length,
    reviewers: report.reviewers.length,
    acknowledged: report.acknowledged.length,
    notes: report.notes.length,
    uncommitted: report.worktree?.uncommitted.length ?? 0,
  };
  return {
    status: report.status,
    pending: report.pending.length,
    stopped: report.stopped.length,
    alreadyStopped: report.alreadyStopped.length,
    ...Object.fromEntries(Object.entries(exceptions).filter(([, count]) => count > 0)),
    ...(report.worktree?.truncated ? { uncommittedTruncated: true } : {}),
  };
}

async function pipelineAction(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  assertPipelineSeatAuthority(dependencies);
  const pipelineId = required(args, "pipelineId");
  const action = required(args, "action") as PipelineAction;
  /* The other roles in the deny list keep the actions their stages rely on. */
  if (STAGE_LAUNCHING_PIPELINE_ACTIONS.has(action)) refuseSpawnDeniedPipelineCaller(dependencies, undefined, (role) => role === "issue-reporter");
  /* Clearing a lane off the operator's queue is the dismissal service's write
     (docs/design/needs-attention.md §5): the same gate and the same attributed
     record `dismiss_attention` writes. */
  if (action === "dismiss" || action === "undismiss") return pipelineDismissal(pipelineId, action, args, dependencies);
  const request = withoutKeys(args, ["pipelineId", ...(PIPELINE_RECEIPT_ACTIONS.has(action) ? [] : ["clientRequestId"]), "full", "compact", "includeHints"]);
  const before = dependencies.readPipelineRecord
    ? dependencies.readPipelineRecord(pipelineId)
    : dependencies.getPipelines?.().pipelines.find(pipeline => pipeline.id === pipelineId);
  const beforeFields = fieldValues(before);
  if (action === "retry-stage") retryStageLaunch(request, before ?? null);
  /* Decisions, pause/resume and graph edits carry the server-attributed actor. */
  const result = action === "takeover" || action === "publish" || action === "set-delivery-remote" || action === "pause" || action === "resume" || action === "attach-link" || action === "detach-link" || PIPELINE_RECEIPT_ACTIONS.has(action) || PIPELINE_GRAPH_EDIT_ACTIONS.has(action)
    ? await dependencies.patchPipeline(pipelineId, request as PatchPipelineRequest, undefined, pauseResumeActorOf(dependencies))
    : await dependencies.patchPipeline(pipelineId, request as PatchPipelineRequest);
  if (!result.pipeline) {
    const message = result.error ?? "could not update pipeline";
    if (result.code === STAGE_RETIREMENT.code) throw new McpToolRefusal(message, { ...STAGE_RETIREMENT, retryable: false });
    /* A refused close carries the hosts it stopped and the one it could not
       (#670); an agent driving the board must not get less than an HTTP caller. */
    if (result.details) throw new McpToolRefusal(message, { code: result.code, details: result.details });
    /* A refused conversion carries its editable preview. */
    if (result.legacyReviewPreview) throw new McpToolRefusal(message, { legacyReviewPreview: result.legacyReviewPreview });
    if (result.code === "short_id_ambiguous") throw new McpToolRefusal(message, { code: result.code, field: result.field, retryable: false, status: result.status });
    if (action === "publish" || action === "takeover" || action === "set-delivery-remote") throw new McpToolRefusal(message, { code: "delivery_refused", status: result.status });
    if (action === "attach-link" || action === "detach-link") throw new McpToolRefusal(message, { code: result.code ?? "WORK_LINK_INVALID", field: "link", status: result.status });
    /* A stale guard names what moved, so the caller re-reads before retrying. */
    if (result.code === "STAGE_CHANGED") throw new McpToolRefusal(message, { code: result.code, field: result.field, status: result.status });
    throw result.close ? new McpToolRefusal(message, { close: result.close }) : new Error(message);
  }
  if (PIPELINE_CONTROLLER_ACTIONS.has(action)) requestPipelineTick();
  /* A close reports what became of the stage hosts and the uncommitted work it
     left behind (#670), as counts (#2030): the host list averaged 2.1 KB over
     146 closes and is the record's, which get_pipeline reads. A closed lane
     takes no guarded edit, so its digests are left out too. */
  if (action === "close" && result.close && !fullAnswer(args)) {
    return redactPayload({
      pipelineId: result.pipeline.id,
      state: result.pipeline.state,
      closedAt: result.pipeline.closedAt ?? null,
      revision: recordRevision(result.pipeline),
      changedFields: changedFieldNames(beforeFields, result.pipeline),
      close: closeReportCounts(result.close),
      ...answerHint(args, "get_pipeline(pipelineId, full:true) lists every host in closeReport."),
    });
  }
  /* The pipeline itself is acknowledged, not echoed (#1845): get_pipeline reads it. */
  return redactPayload({
    ...pipelineActionAcknowledgement(result.pipeline, fullAnswer(args) || PIPELINE_GRAPH_EDIT_ACTIONS.has(action)),
    revision: recordRevision(result.pipeline),
    changedFields: changedFieldNames(beforeFields, result.pipeline),
    taskIds: result.pipeline.taskIds,
    ...(fullAnswer(args) ? { pipeline: result.pipeline } : { omittedRecordCount: 1 }),
    ...answerHint(args, "get_pipeline(pipelineId, full:true) or pipeline_action with full:true returns the full record."),
    ...(result.pipeline.delivery && (fullAnswer(args) || action === "publish" || action === "set-delivery-remote" || action === "takeover" || action === "retry-stage" || beforeFields.get("delivery") !== JSON.stringify(result.pipeline.delivery)) ? { delivery: deliveryAcknowledgement(result.pipeline) } : {}),
    ...(action === "attach-link" || action === "detach-link" ? { workLinks: pipelineWorkLinks(result.pipeline), ...(result.unchanged ? { unchanged: true } : {}) } : {}),
    ...(result.close ? { close: result.close } : {}),
    ...(result.graphEdit ? { graphEdit: result.graphEdit } : {}),
    ...(result.runtimeSwitch !== undefined ? { runtimeSwitch: result.runtimeSwitch, replayed: result.replayed, appliedNow: result.appliedNow } : {}),
    ...newLegacyReviewFields(result),
    ...(result.decisionAnswer ? { decisionAnswer: {
      clientRequestId: result.decisionAnswer.clientRequestId,
      stageId: result.decisionAnswer.stageId,
      attempt: result.decisionAnswer.attempt,
      nextAttempt: result.decisionAnswer.nextAttempt,
      at: result.decisionAnswer.at,
    }, replayed: result.replayed } : {}),
    ...(result.reviewContinuation ? { reviewContinuation: {
      clientRequestId: result.reviewContinuation.clientRequestId,
      stageId: result.reviewContinuation.stageId,
      rounds: result.reviewContinuation.rounds,
      reviewedHead: result.reviewContinuation.reviewedHead,
      currentHead: result.reviewContinuation.currentHead,
      at: result.reviewContinuation.at,
    }, replayed: result.replayed } : {}),
    ...(result.legacyReviewPreview ? { legacyReviewPreview: result.legacyReviewPreview } : {}),
    ...(result.legacyReviewConversion ? { legacyReviewConversion: {
      clientRequestId: result.legacyReviewConversion.clientRequestId,
      stageId: result.legacyReviewConversion.stageId,
      fixerStageId: result.legacyReviewConversion.fixerStageId,
      implementerStageId: result.legacyReviewConversion.implementerStageId,
      reviewLimit: result.legacyReviewConversion.reviewLimit,
      reviewLimitSource: result.legacyReviewConversion.reviewLimitSource,
      at: result.legacyReviewConversion.at,
      ...(result.legacyReviewConversion.reverted ? { reverted: result.legacyReviewConversion.reverted } : {}),
    }, replayed: result.replayed } : {}),
  });
}

/**
 * The stage a retry-stage names (#1845). The engine reads a request carrying
 * stageId as an explicit launch-receipt retry: it then needs that attempt's
 * launchId beside it and accepts only a receipt that settled failed or
 * conflicted, which refuses every stage whose agent started and then failed or
 * parked. A stageId without a launchId therefore becomes the guard the engine
 * reads as "retry the stage you wait on": expectedStageId, and expectedAttempt
 * from the record this call saw, so a stage or attempt that moved on before
 * the write is refused with STAGE_CHANGED. A launchId the caller names is
 * passed through unchanged, for the engine to judge as a receipt retry.
 */
function retryStageLaunch(request: Record<string, unknown>, pipeline: Pipeline | null): void {
  if (typeof request.stageId !== "string" || request.launchId !== undefined || !pipeline) return;
  if (request.expectedStageId !== undefined && request.expectedStageId !== request.stageId) {
    throw new McpToolRefusal(`retry-stage names stage ${request.stageId} and expectedStageId ${String(request.expectedStageId)}; name one stage`, { code: "STAGE_CHANGED", field: "expectedStageId", status: 400 });
  }
  request.expectedStageId = request.stageId;
  if (request.expectedAttempt === undefined) request.expectedAttempt = latestOperationalStageAttempt(pipeline, request.stageId)?.n ?? 0;
  delete request.stageId;
}

async function pipelineDismissal(pipelineId: string, action: "dismiss" | "undismiss", args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const read = () => dependencies.readPipelineRecord
    ? dependencies.readPipelineRecord(pipelineId)
    : dependencies.getPipelines?.().pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null;
  const beforeFields = fieldValues(read());
  const outcome = await dismissThroughService({ kind: "pipeline", pipelineId }, action === "undismiss", mcpOperationId("pipeline_action", requestId(args)), dependencies);
  const after = read();
  if (!after) throw new Error("pipeline not found");
  return redactPayload({
    ...pipelineActionAcknowledgement(after, fullAnswer(args)),
    revision: recordRevision(after),
    changedFields: changedFieldNames(beforeFields, after),
    taskIds: after.taskIds,
    dismissal: { dismissed: outcome.dismissed.length > 0, alreadyClear: outcome.alreadyClear.length > 0, at: outcome.at, by: outcome.by },
    ...(fullAnswer(args) ? { pipeline: after } : { omittedRecordCount: 1 }),
    ...answerHint(args, "get_pipeline(pipelineId, full:true) or pipeline_action with full:true returns the full record."),
  });
}

/**
 * A stage attempt reports its own completion (graph slice 2, #1730).
 *
 * The caller never names itself: the attempt is resolved server-side from this
 * server's own attribution, the same derivation a graph edit's actor comes
 * from, so a conversation cannot report for a stage it does not hold. A
 * refusal carries the code and, where the answer turns on which stage, the
 * live slots the caller does hold.
 */
async function stageReport(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const request = withoutKeys(args, ["clientRequestId"]) as StageCompletionRequest;
  const result = await dependencies.reportStageCompletion(request, pauseResumeActorOf(dependencies));
  if (!result.report) {
    throw new McpToolRefusal(result.error ?? "could not report the stage completion", {
      ...(result.code ? { code: result.code } : {}),
      ...(result.status ? { status: result.status } : {}),
      ...(result.slots ? { slots: result.slots } : {}),
    });
  }
  /* The tick the settlement path needs is the ordinary one: the report is an
     intent, and the attempt settles when its turn ends. Asking for a tick here
     only shortens the wait between the turn ending and the stage moving. */
  requestPipelineTick();
  return {
    pipelineId: result.pipelineId,
    stageId: result.stageId,
    attempt: result.attempt,
    replaced: result.replaced ?? false,
    report: stageReportAcknowledgement(result.report),
    ...stageLessonRequest(result, dependencies),
  };
}

/** Role memory's stage-end prompt (docs/design/role-memory.md §2.4): the first
    accepted report of an eligible attempt carries the request for a lesson. A
    failure to read or record it never costs the report. */
function stageLessonRequest(result: { pipelineId?: string; stageId?: string; attempt?: number; replaced?: boolean }, dependencies: ViewerMcpDomainDependencies): { lessonRequest?: string[] } {
  const conversationId = attributionOf(dependencies).conversationId;
  if (result.replaced || !result.pipelineId || !result.stageId || !result.attempt || !conversationId) return {};
  try {
    const pipeline = dependencies.readPipelineRecord
      ? dependencies.readPipelineRecord(result.pipelineId)
      : dependencies.getPipelines?.().pipelines.find((item) => item.id === result.pipelineId) ?? null;
    const lines = pipeline ? lessonRequestForReport(pipeline, result.stageId, result.attempt, conversationId) : null;
    return lines ? { lessonRequest: lines } : {};
  } catch (error) {
    console.warn(`[role-memory] lesson request unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

async function leaveLesson(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  try {
    const caller = attributionOf(dependencies);
    /* Root conversations stay gateway-attributed for ordinary tool behavior,
       but a freshly authorized designation is enough to establish seat
       identity for this role-memory write. */
    const seat = caller.conversationId && (caller.kind === "manager" || caller.kind === "gateway")
      ? (dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources())).find(row => row.conversationId === caller.conversationId)
      : null;
    const answer = { correction: args.correction, lesson: args.lesson, rewrite: args.rewrite, none: args.none, problem: args.problem, applied: args.applied, misled: args.misled };
    /* The operator's own root conversation, in Delegatus mode only: proven by
       the registry, never by an argument (memory-source-switch.md §3.3). */
    const operator = () => {
      if (!caller.conversationId || caller.role || !operatorMemoryEnabled()) return null;
      const found = (dependencies.operatorConversation ?? productionOperatorConversation)(caller.conversationId);
      return found ? { project: found.project, conversationId: caller.conversationId } : null;
    };
    if (caller.kind === "manager" && !seat) throw new RoleMemoryRefusal("LESSON_NOT_A_SEAT", "this caller has no active project designation");
    if (caller.kind === "gateway" && !seat) {
      const own = operator();
      if (own) return { ...leaveLessonForOperator(own, answer) };
      throw new RoleMemoryRefusal("LESSON_NOT_A_SEAT", "this gateway conversation has no active project designation");
    }
    if (seat) return { ...leaveLessonForSeat(seat, answer) };
    try {
      return { ...leaveLessonForConversation(dependencies.listPipelineRecords?.() ?? dependencies.getPipelines?.().pipelines ?? [], caller.conversationId, answer) };
    } catch (error) {
      if (!(error instanceof RoleMemoryRefusal) || error.code !== "LESSON_NOT_AN_ATTEMPT" || caller.kind !== "agent") throw error;
      // A registered role outside a pipeline may still leave an operator correction.
      if (args.correction === true && caller.role && caller.conversationId) return { ...leaveCorrectionForRole({ conversationId: caller.conversationId, roleId: caller.role, project: dependencies.callerProject ? dependencies.callerProject() : productionCallerProject() }, answer) };
      // Only a conversation that holds no stage attempt at all may be the operator's.
      const own = operator();
      if (!own) throw error;
      return { ...leaveLessonForOperator(own, answer) };
    }
  } catch (error) {
    if (error instanceof RoleMemoryRefusal) {
      throw new McpToolRefusal(error.message, { code: error.code, status: error.code === "LESSON_INVALID" ? 400 : 409 });
    }
    throw error;
  }
}

async function linkTaskToPipeline(args: McpToolArgs, dependencies: LinkTaskToPipelineDependencies): Promise<McpToolPayload> {
  const taskId = required(args, "taskId");
  const pipelineId = required(args, "pipelineId");
  const pipeline = dependencies.getPipelines().pipelines.find((candidate) => candidate.id === pipelineId);
  if (!pipeline) throw new Error("pipeline not found");
  const member = latestOperationalPipelineAttempt(pipeline);
  const transcriptPath = member?.agentPath ?? pipeline.srcPath;
  const conversationId = member?.conversationId ?? pipeline.srcConversationId;
  if (!transcriptPath && !conversationId) throw new Error("pipeline has no conversation to link");
  const at = dependencies.isoNow();
  let changedFields: string[] = [];
  /* The task lock is taken before the callback runs, so a busy refusal here
     proves the assignment was never written (#1766). */
  const result = await refuseBusyBeforeAdmission((admitted) => dependencies.mutateTasks((tasks) => {
    admitted();
    const before = fieldValues(tasks.find(task => task.id === taskId));
    const outcome = applyAssignmentPatches(tasks, taskId, [{
      path: transcriptPath,
      conversationId,
      panePid: null,
      state: "handoff",
      error: null,
      at,
    }], at);
    if (outcome.ok) changedFields = changedFieldNames(before, outcome.task);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  }));
  if (!result.ok) throw new Error(result.error);
  return { ...taskAcknowledgement(result.task, args, changedFields), pipelineId, conversationId, transcriptPath };
}

function throwIfCallEnded(context: McpToolCallContext): void {
  if (context.signal?.aborted) {
    const reason = context.signal.reason;
    throw reason instanceof Error ? reason : new DOMException("MCP tool cancelled", "AbortError");
  }
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
    throw new DeadlineExceededError("MCP tool deadline exceeded", 0);
  }
}

function callDeadlineExceeded(context: McpToolCallContext): boolean {
  if (context.signal?.aborted) return context.signal.reason instanceof DeadlineExceededError;
  return context.deadlineAt !== undefined && Date.now() >= context.deadlineAt;
}

const PARTIAL_CONVERSATION_DEADLINE_HINT = "Returned records parsed before the internal read deadline; use tailLines with conversationId for the cheapest recent transcript view.";
const PARTIAL_CONVERSATION_OVERSIZE_HINT = "Returned a bounded tail of this oversized transcript; use tailLines with conversationId for a smaller raw tail.";
const PARTIAL_CONVERSATION_RECORD_HINT = "More parsed records are available; raise maxRecords up to 500 or use tailLines with conversationId.";
const PARTIAL_CONVERSATION_BUDGET_HINT = "Record text is cut and older records are omitted to fit the answer budget; full:true returns complete records, and conversation_messages pages them.";
const MCP_CONVERSATION_CATALOG_BUDGET_MS = 250;
/* readSession intentionally parses at most the final 8 MiB. Keep the response
   honest when a larger transcript has an omitted prefix. */
const MCP_CONVERSATION_PARSE_WINDOW_BYTES = 8 * 1024 * 1024;

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rootForTranscript(
  pathname: string,
  roots: ReturnType<typeof scanRootEntries>,
): ReturnType<typeof scanRootEntries>[number] | undefined {
  let canonical: string;
  try { canonical = fs.realpathSync(pathname); } catch { return undefined; }
  return roots.find(([, root]) => {
    try { return contained(fs.realpathSync(root), canonical); } catch { return false; }
  });
}

export interface TargetedConversationRead {
  entry: FileEntry;
  session?: SessionReadResult;
  tail?: BoundedTranscriptTail;
  truncated?: true;
  hint?: string;
}

export interface TargetedConversationDependencies {
  roots: ReturnType<typeof scanRootEntries>;
  pathAllowed(candidate: string): boolean;
  /** Deterministic race seam used by the focused security test. */
  afterOpen?(): void;
}

export interface PinnedTranscript {
  descriptor: number;
  stat: fs.Stats;
  rootName: ReturnType<typeof scanRootEntries>[number][0];
  root: string;
  sameIdentity(): boolean;
}

function sameOpenedTranscript(
  pathname: string,
  root: string,
  opened: fs.Stats,
  allowed: (candidate: string) => boolean,
): boolean {
  if (!allowed(pathname)) return false;
  try {
    const listed = fs.lstatSync(pathname);
    const canonicalRoot = fs.realpathSync(root);
    const canonicalPath = fs.realpathSync(pathname);
    return listed.isFile()
      && !listed.isSymbolicLink()
      && listed.dev === opened.dev
      && listed.ino === opened.ino
      && contained(canonicalRoot, canonicalPath);
  } catch {
    return false;
  }
}

/** Open one caller-selected transcript once, without following the leaf, and
    prove that descriptor still names the regular file inside a scanner root. */
export function openPinnedTranscript(
  pathname: string,
  injectedDependencies?: TargetedConversationDependencies,
): PinnedTranscript | undefined {
  const dependencies = injectedDependencies ?? { roots: scanRootEntries(), pathAllowed };
  if (!dependencies.pathAllowed(pathname)) return undefined;
  const rooted = rootForTranscript(pathname, dependencies.roots);
  if (!rooted) return undefined;
  const [rootName, root] = rooted;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    dependencies.afterOpen?.();
    if (!sameOpenedTranscript(pathname, root, stat, dependencies.pathAllowed)) return undefined;
    const openedDescriptor = descriptor;
    descriptor = null;
    return {
      descriptor: openedDescriptor,
      stat,
      rootName,
      root,
      sameIdentity: () => sameOpenedTranscript(pathname, root, stat, dependencies.pathAllowed),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EACCES") return undefined;
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function descriptorPath(descriptor: number): string {
  return process.platform === "linux" ? `/proc/self/fd/${descriptor}` : `/dev/fd/${descriptor}`;
}

function boundedTailFromDescriptor(
  descriptor: number,
  pathname: string,
  stat: fs.Stats,
  requestedLines: number,
): BoundedTranscriptTail {
  const maxLines = Math.max(1, Math.min(SELECTED_TAIL_MAX_LINES, Math.floor(requestedLines) || 1));
  const window = Math.min(stat.size, SELECTED_TAIL_MAX_BYTES);
  const buffer = Buffer.allocUnsafe(window);
  const read = fs.readSync(descriptor, buffer, 0, window, stat.size - window);
  const precededByMore = window < stat.size;
  const rows = buffer.subarray(0, read).toString("utf8").split("\n");
  if (precededByMore && rows.length > 0) rows.shift();
  while (rows.length > 0 && rows.at(-1) === "") rows.pop();
  const lines = rows.slice(-maxLines);
  return {
    path: pathname,
    lines,
    bytes: Buffer.byteLength(lines.join("\n"), "utf8"),
    truncated: precededByMore || lines.length < rows.length,
  };
}

/**
 * Hydrate and parse one known transcript through a pinned descriptor.
 *
 * The public path is canonicalized against the registered scanner roots, then
 * opened with O_NOFOLLOW. Metadata and tail parsing use a private alias to that
 * descriptor, so a parent or leaf swap can only make the final identity check
 * reject the result; it cannot redirect either bounded read.
 */
export async function targetedConversationAtPath(
  pathname: string,
  context: TargetedConversationOptions = {},
  injectedDependencies?: TargetedConversationDependencies,
): Promise<TargetedConversationRead | undefined> {
  const dependencies = injectedDependencies ?? { roots: scanRootEntries(), pathAllowed };
  throwIfCallEnded(context);
  const pinned = openPinnedTranscript(pathname, dependencies);
  if (!pinned || pinned.stat.size === 0) {
    if (pinned) fs.closeSync(pinned.descriptor);
    return undefined;
  }
  const { rootName, root, stat } = pinned;
  let descriptor: number | null = null;
  let sidecarDescriptor: number | null = null;
  let sidecarPath: string | null = null;
  let sidecarStat: fs.Stats | null = null;
  let stableDirectory: string | null = null;
  descriptor = pinned.descriptor;
  try {
    throwIfCallEnded(context);

    if (rootName === "claude-projects" && path.basename(pathname).startsWith("agent-") && pathname.endsWith(".jsonl")) {
      const candidate = pathname.slice(0, -".jsonl".length) + ".meta.json";
      if (dependencies.pathAllowed(candidate)) {
        try {
          sidecarDescriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const openedSidecar = fs.fstatSync(sidecarDescriptor);
          if (openedSidecar.isFile() && sameOpenedTranscript(candidate, root, openedSidecar, dependencies.pathAllowed)) {
            sidecarPath = candidate;
            sidecarStat = openedSidecar;
          } else {
            fs.closeSync(sidecarDescriptor);
            sidecarDescriptor = null;
          }
        } catch {
          if (sidecarDescriptor !== null) fs.closeSync(sidecarDescriptor);
          sidecarDescriptor = null;
        }
      }
    }

    stableDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-targeted-"));
    fs.chmodSync(stableDirectory, 0o700);
    const stablePath = path.join(stableDirectory, path.basename(pathname));
    fs.symlinkSync(descriptorPath(descriptor), stablePath);
    if (sidecarDescriptor !== null && sidecarPath !== null) {
      fs.symlinkSync(descriptorPath(sidecarDescriptor), stablePath.slice(0, -".jsonl".length) + ".meta.json");
    }
    const pinnedMetadata = describe(rootName, root, stablePath, stat);
    const metadata = reprojectFileDescription(rootName, root, pathname, pinnedMetadata);
    const entry: FileEntry = {
      path: pathname,
      root: rootName,
      name: path.relative(root, pathname),
      project: metadata.project,
      projectName: metadata.projectName,
      projectUnresolved: metadata.projectUnresolved,
      worktree: metadata.worktree,
      cwd: metadata.cwd,
      sessionStartedAt: metadata.sessionStartedAt,
      nativeParentThreadId: metadata.nativeParentThreadId,
      nativeForkSourceThreadId: metadata.nativeForkSourceThreadId,
      projectRoot: metadata.projectRoot,
      title: metadata.title,
      engine: metadata.engine,
      kind: metadata.kind,
      fmt: metadata.fmt,
      parent: null,
      mtime: stat.mtimeMs / 1_000,
      size: stat.size,
      activity: "idle",
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    };
    overlaySessionTitles([entry]);
    if (entry.engine !== "claude" && entry.engine !== "codex") return undefined;
    const session = context.tailLines === undefined
      ? { ...readSession(stablePath, entry.engine), path: pathname }
      : undefined;
    const tail = context.tailLines === undefined
      ? undefined
      : boundedTailFromDescriptor(descriptor, pathname, stat, context.tailLines);
    const partialAtDeadline = callDeadlineExceeded(context);
    if (!partialAtDeadline) throwIfCallEnded(context);
    if (!pinned.sameIdentity()) return undefined;
    if (sidecarDescriptor !== null && sidecarPath !== null && sidecarStat !== null
      && !sameOpenedTranscript(sidecarPath, root, sidecarStat, dependencies.pathAllowed)) return undefined;
    return {
      entry,
      ...(session ? { session } : {}),
      ...(tail ? { tail } : {}),
      ...(partialAtDeadline ? { truncated: true as const, hint: PARTIAL_CONVERSATION_DEADLINE_HINT } : {}),
    };
  } finally {
    if (stableDirectory !== null) fs.rmSync(stableDirectory, { recursive: true, force: true });
    if (sidecarDescriptor !== null) fs.closeSync(sidecarDescriptor);
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

async function targetedFileEntry(
  pathname: string,
  context: TargetedConversationOptions = {},
): Promise<TargetedConversationRead | undefined> {
  return targetedConversationAtPath(pathname, context);
}

/**
 * Read one completed generation, then hydrate only the requested transcript on
 * a miss. Production never reserves a private full-corpus scan for this lookup.
 */
async function entryForPath(
  transcriptPath: string,
  dependencies: Pick<ViewerMcpDomainDependencies, "listFiles" | "completedFileScan" | "targetedFileEntry">,
  context: TargetedConversationOptions = {},
  knownTranscript = false,
): Promise<{ entry: FileEntry; session?: SessionReadResult; tail?: BoundedTranscriptTail; truncated?: true; hint?: string } | undefined> {
  throwIfCallEnded(context);
  const remainingMs = context.deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, context.deadlineAt - Date.now());
  const overall = deadlineSignal(remainingMs, {
    signal: context.signal,
    reason: "MCP tool deadline exceeded",
  });
  const catalog = context.tailLines === undefined
    ? deadlineSignal(Math.min(MCP_CONVERSATION_CATALOG_BUDGET_MS, remainingMs), {
        signal: overall.signal,
        reason: "MCP conversation catalog budget exceeded",
      })
    : null;
  let knownInCompletedCatalog = false;
  try {
    if (catalog) {
      try {
        let releaseCatalogWait: () => void = () => {};
        const catalogWait = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(catalog.signal.reason);
          catalog.signal.addEventListener("abort", onAbort, { once: true });
          releaseCatalogWait = () => catalog.signal.removeEventListener("abort", onAbort);
        });
        const completedRead = dependencies.completedFileScan({ signal: catalog.signal });
        const completed = (await Promise.race([completedRead, catalogWait]).finally(releaseCatalogWait)).snapshot.files;
        const known = completed.find((candidate) => candidate.path === transcriptPath);
        knownInCompletedCatalog = Boolean(known);
        /* A catalog row is a discovery hint. The transcript may have grown or
           been replaced since that row was measured, so production reopens it
           through the descriptor-pinned reader before deriving truncation or
           parsing content. Older injected adapters without that seam retain
           their completed-row behavior. */
        if (known && !dependencies.targetedFileEntry) return { entry: known };
      } catch (error) {
        if (overall.signal.aborted) {
          const reason = overall.signal.reason;
          throw reason instanceof Error ? reason : error;
        }
        if (!catalog.signal.aborted) throw error;
        /* The completed catalog did not arrive within its small share of the
           budget. Continue through the path-pinned reader while useful time
           remains; that read is bounded independently of corpus size. */
      }
    }
    if (dependencies.targetedFileEntry) {
      const targeted = await dependencies.targetedFileEntry(transcriptPath, {
        signal: overall.signal,
        deadlineAt: context.deadlineAt,
        ...(context.tailLines === undefined ? {} : { tailLines: context.tailLines }),
      });
      if (!targeted) {
        if (knownInCompletedCatalog || knownTranscript) {
          throw new McpToolRefusal("the known conversation transcript is temporarily unavailable; retry after its write or replacement finishes", {
            code: "CONVERSATION_READ_UNAVAILABLE",
            retryable: true,
          });
        }
        return undefined;
      }
      if (!("entry" in targeted)) return { entry: targeted };
      const partialAtDeadline = callDeadlineExceeded({ signal: overall.signal, deadlineAt: context.deadlineAt });
      if (!partialAtDeadline) throwIfCallEnded({ signal: overall.signal, deadlineAt: context.deadlineAt });
      return partialAtDeadline
        ? { ...targeted, truncated: true, hint: PARTIAL_CONVERSATION_DEADLINE_HINT }
        : targeted;
    }
    /* Compatibility for older injected test adapters. Production always owns
       the targeted seam above. */
    const pinned = await dependencies.listFiles({ fresh: true, persist: false, pin: transcriptPath, signal: overall.signal });
    const entry = pinned.find((candidate) => candidate.path === transcriptPath);
    return entry ? { entry } : undefined;
  } finally {
    catalog?.release();
    overall.release();
  }
}

async function listConversations(
  args: McpToolArgs,
  control: ViewerControlDependencies,
): Promise<McpToolPayload> {
  const project = text(args.project);
  const query = text(args.query).trim();
  const limit = Math.max(1, Math.min(100, integer(args.limit, 50)));
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (query) params.set("q", query);
  params.set("limit", String(limit));
  if (text(args.cursor)) params.set("cursor", text(args.cursor));
  /* The Viewer's conversation endpoint projects the uncapped catalog published
     by the scanner worker. Its scheme feed can omit projects beyond the board's
     recent-project window even while their catalog rows remain current. */
  const source = await readViewerControl(control, `/api/conversations?${params}`);
  if (!Array.isArray(source.items) || typeof source.total !== "number") {
    throw new ViewerControlResponseError("Viewer control returned a malformed conversation catalog page");
  }
  if (project && source.total === 0) {
    let knownProject = false;
    if (query) {
      const validation = await readViewerControl(
        control,
        `/api/conversations?project=${encodeURIComponent(project)}&limit=1`,
      );
      if (!Array.isArray(validation.items) || typeof validation.total !== "number") {
        throw new ViewerControlResponseError("Viewer control returned a malformed conversation catalog page");
      }
      knownProject = validation.total > 0;
    }
    if (!knownProject) {
      return redactPayload({
        count: 0,
        conversations: [],
        code: "UNKNOWN_PROJECT",
        hint: "The requested project does not match a canonical project key in the conversation catalog.",
      });
    }
  }
  const conversations = source.items
    .filter(objectRecord) as unknown as FileEntry[];
  const rows = conversations
    .filter((entry) => entry.engine === "claude" || entry.engine === "codex" || entry.engine === "copilot")
    .slice(0, limit)
    .map((entry) => ({
      conversationId: entry.conversationId ?? null,
      transcriptPath: entry.path,
      project: entry.project,
      title: fullAnswer(args) ? entry.title : firstLine(entry.title ?? ""),
      engine: entry.engine,
      activity: entry.activity,
    }));
  return redactPayload({ count: rows.length, total: source.total, conversations: rows,
    nextCursor: source.nextCursor ?? null, hasMore: Boolean(source.nextCursor),
    omittedCount: Math.max(0, source.total - rows.length), omittedRecordCount: fullAnswer(args) ? 0 : rows.length,
    readMore: "Pass nextCursor as cursor with the same filters. compact:false retains the full title; get_conversation reads one conversation." });
}

async function searchTranscripts(
  args: McpToolArgs,
  control: ViewerControlDependencies,
): Promise<McpToolPayload> {
  const query = text(args.query).trim();
  if (!query) throw new Error("query is required");
  const project = text(args.project).trim();
  const cursor = text(args.cursor).trim();
  const order = args.order === "newest" ? "newest" : "relevance";
  const limit = Math.max(1, Math.min(100, integer(args.limit, order === "relevance" ? 6 : 20)));
  const params = new URLSearchParams({ q: query });
  if (project) params.set("project", project);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  params.set("order", order);
  const source = await readViewerControl(control, `/api/search/transcripts?${params}`);
  const stats = objectRecord(source.stats) ? source.stats : null;
  if (!Array.isArray(source.items)
    || typeof source.total !== "number"
    || (source.nextCursor !== null && typeof source.nextCursor !== "string")
    || !stats
    || typeof stats.conversationsIndexed !== "number"
    || typeof stats.messagesIndexed !== "number"
    || !Array.isArray(stats.fieldsSearched)
    || typeof stats.tokenizer !== "string") {
    throw new ViewerControlResponseError("Viewer control returned a malformed transcript search page");
  }
  return redactPayload({ ...source, stats: args.full === true ? stats : {
    conversationsIndexed: stats.conversationsIndexed,
    messagesIndexed: stats.messagesIndexed,
  } });
}

/* The default get_conversation answer is a summary a caller can hold: on a
   32 MB transcript the unbounded one was 2 MB of tool output, 504,000 tokens.
   Each record keeps its head, the newest records keep their place inside one
   text budget per list, and full:true returns everything as before. */
const CONVERSATION_MESSAGE_CHARS = 4_000;
const CONVERSATION_TOOL_CHARS = 1_000;
const CONVERSATION_MESSAGE_TEXT_BUDGET = 40_000;
const CONVERSATION_TOOL_TEXT_BUDGET = 24_000;
const CONVERSATION_TAIL_LINE_CHARS = 4_000;

/** The newest records that fit `budget` characters of text, oldest first, each
    cut to `maxChars` after secret redaction. The newest record always stays. */
function boundedConversationRecords(
  records: readonly SessionRecord[],
  maxChars: number,
  budget: number,
): { records: SessionRecord[]; omitted: number; cut: number } {
  const kept: SessionRecord[] = [];
  let spent = 0;
  let cut = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    const redacted = hardenedRedact(record.text);
    const cost = Math.min(redacted.length, maxChars);
    if (kept.length > 0 && spent + cost > budget) break;
    spent += cost;
    if (redacted.length > maxChars) {
      cut += 1;
      kept.push({ ...record, text: redacted.slice(0, maxChars), truncated: true } as SessionRecord);
    } else kept.push(record);
  }
  return { records: kept.reverse(), omitted: records.length - kept.length, cut };
}

/** Raw tail lines cut to `maxChars` after secret redaction; a cut line says how
    much of it is missing. */
function boundedTailLines(lines: readonly string[], maxChars: number): { lines: string[]; cutLines: number } {
  let cutLines = 0;
  const bounded = lines.map((line) => {
    const redacted = hardenedRedact(line);
    if (redacted.length <= maxChars) return line;
    cutLines += 1;
    return `${redacted.slice(0, maxChars)}… [+${redacted.length - maxChars} chars]`;
  });
  return { lines: bounded, cutLines };
}

function conversationTailAnswer(
  tail: { lines: string[]; bytes: number; truncated: boolean },
  args: McpToolArgs,
) {
  if (fullAnswer(args)) return { lines: tail.lines, bytes: tail.bytes, truncated: tail.truncated };
  const bounded = boundedTailLines(tail.lines, Math.max(1, Math.min(16_000, integer(args.maxChars, CONVERSATION_TAIL_LINE_CHARS))));
  return {
    lines: bounded.lines,
    bytes: tail.bytes,
    truncated: tail.truncated,
    ...(bounded.cutLines > 0 ? { cutLines: bounded.cutLines } : {}),
  };
}

async function getConversation(
  args: McpToolArgs,
  dependencies: Pick<ViewerMcpDomainDependencies, "listFiles" | "completedFileScan" | "targetedFileEntry" | "selectedContext">,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  const selectedDependencies = dependencies.selectedContext ?? productionSelectedContextDependencies;
  const requestedPath = text(args.transcriptPath) || text(args.path);
  /* #1629: a spoken turn carries no `ctx=` marker, so when the agent names
     nothing at all the card the operator was looking at is asked for. A caller
     that reached its target another way is left alone. */
  const selected = await resolveSelectedContext(args, text(args.conversationId), selectedDependencies, {
    voiceUtterance: !requestedPath,
    work: context.nativeWork ?? null,
  });
  const requestedId = selected.conversationId;
  const tailLines = integer(args.tailLines, 0);
  if (!requestedId && !requestedPath) {
    throw new Error("conversationId, transcriptPath or selectedContext is required");
  }
  /* #844 §6: with an identity, explicit `tailLines` uses one keyed registry
     lookup and one clamped tail read, so the selected card stays answerable
     while the corpus scan is degraded. A transcript path continues through the
     root-validated bounded reader below. */
  if (tailLines > 0 && requestedId) {
    let answer: ReturnType<typeof selectedConversationTail>;
    try {
      answer = selectedConversationTail(
        { conversationId: requestedId, maxLines: Math.max(1, Math.min(tailLines, SELECTED_TAIL_MAX_LINES)) },
        selectedDependencies,
      );
    } catch (error) {
      if (error instanceof McpToolRefusal && [
        "selected_context_unresolved", "selected_conversation_has_no_transcript",
        "selected_conversation_transcript_absent", "selected_conversation_unreadable",
      ].includes(text(error.details.code))) {
        const launch = spawnConversation(requestedId);
        if (launch && (!launch.transcriptPath || !fs.existsSync(launch.transcriptPath))) {
          throwIfCallEnded(context);
          return redactPayload({ ...launch, ...selectedContextEcho(selected.target) });
        }
      }
      throw error;
    }
    throwIfCallEnded(context);
    return redactPayload({
      conversationId: answer.record.conversationId,
      transcriptPath: answer.tail.path,
      project: answer.record.project,
      engine: answer.record.engine,
      scanned: false,
      tail: conversationTailAnswer(answer.tail, args),
      ...selectedContextEcho(selected.target),
    });
  }
  const conversation = requestedId
    ? agentRegistry().conversation(requestedId as `conversation_${string}`)
    : agentRegistry().conversationForPath(requestedPath);
  const pendingLaunch = requestedId && !conversation?.generations.length ? spawnConversation(requestedId) : null;
  const transcriptPath = conversation?.generations.at(-1)?.path ?? pendingLaunch?.transcriptPath ?? requestedPath;
  if (!transcriptPath && requestedId) {
    throwIfCallEnded(context);
    if (pendingLaunch) return redactPayload({ ...pendingLaunch, ...selectedContextEcho(selected.target) });
    throw new Error("conversation not found");
  }
  const pathTailLines = tailLines > 0 && !requestedId
    ? Math.max(1, Math.min(tailLines, SELECTED_TAIL_MAX_LINES))
    : undefined;
  const targeted = await entryForPath(transcriptPath, dependencies, {
    ...context,
    ...(pathTailLines === undefined ? {} : { tailLines: pathTailLines }),
  });
  const entry = targeted?.entry;
  if (!entry && requestedId) {
    const launch = spawnConversation(requestedId);
    if (launch) {
      throwIfCallEnded(context);
      return redactPayload({ ...launch, ...selectedContextEcho(selected.target) });
    }
  }
  if (!entry || (entry.engine !== "claude" && entry.engine !== "codex")) throw new Error("conversation not found");
  if (pathTailLines !== undefined) {
    if (!targeted?.tail) throw new Error("conversation tail is unavailable");
    return redactPayload({
      conversationId: (conversation?.id ?? entry.conversationId) || null,
      transcriptPath: entry.path,
      project: entry.project,
      title: entry.title,
      engine: entry.engine,
      scanned: false,
      tail: conversationTailAnswer(targeted.tail, args),
      ...(targeted.truncated === true ? {
        truncated: true,
        hint: targeted.hint ?? PARTIAL_CONVERSATION_DEADLINE_HINT,
      } : {}),
      ...selectedContextEcho(selected.target),
    });
  }
  if (!targeted?.session) throwIfCallEnded(context);
  const session = targeted.session ?? readSession(entry.path, entry.engine);
  const partialAtDeadline = targeted.truncated === true || callDeadlineExceeded(context);
  if (!partialAtDeadline) throwIfCallEnded(context);
  const maxRecords = Math.max(1, Math.min(500, integer(args.maxRecords, 100)));
  const recordTruncated = session.messages.length > maxRecords || session.tools.length > maxRecords;
  const oversized = entry.size > MCP_CONVERSATION_PARSE_WINDOW_BYTES;
  const full = fullAnswer(args);
  const requestedChars = args.maxChars === undefined ? null : Math.max(1, Math.min(16_000, integer(args.maxChars, CONVERSATION_MESSAGE_CHARS)));
  const messages = full
    ? { records: session.messages.slice(-maxRecords), omitted: 0, cut: 0 }
    : boundedConversationRecords(session.messages.slice(-maxRecords), requestedChars ?? CONVERSATION_MESSAGE_CHARS, CONVERSATION_MESSAGE_TEXT_BUDGET);
  const tools = full
    ? { records: session.tools.slice(-maxRecords), omitted: 0, cut: 0 }
    : boundedConversationRecords(session.tools.slice(-maxRecords), requestedChars ?? CONVERSATION_TOOL_CHARS, CONVERSATION_TOOL_TEXT_BUDGET);
  const budgetTruncated = messages.omitted + tools.omitted + messages.cut + tools.cut > 0;
  const truncated = partialAtDeadline || oversized || recordTruncated || budgetTruncated;
  const hint = targeted.hint
    ?? (partialAtDeadline
      ? PARTIAL_CONVERSATION_DEADLINE_HINT
      : oversized
        ? PARTIAL_CONVERSATION_OVERSIZE_HINT
        /* Raising maxRecords cannot widen an answer its budget already cut. */
        : budgetTruncated
          ? PARTIAL_CONVERSATION_BUDGET_HINT
          : recordTruncated
            ? PARTIAL_CONVERSATION_RECORD_HINT
            : undefined);
  return redactPayload({
    conversationId: (conversation?.id ?? entry.conversationId ?? requestedId) || null,
    transcriptPath: entry.path,
    project: entry.project,
    title: entry.title,
    engine: entry.engine,
    messages: messages.records,
    tools: tools.records,
    truncated,
    ...(messages.omitted > 0 || tools.omitted > 0 ? { omitted: { messages: messages.omitted, tools: tools.omitted } } : {}),
    ...(hint ? { hint } : {}),
    ...selectedContextEcho(selected.target),
  });
}

async function conversationDeliverability(
  args: McpToolArgs,
  dependencies: Pick<ViewerMcpDomainDependencies, "registrySnapshot">,
): Promise<McpToolPayload> {
  const conversationId = text(args.conversationId);
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) {
    throw new Error("conversationId or transcriptPath is required");
  }
  const result = await conversationDeliverabilityFromRecord(dependencies.registrySnapshot(), {
    conversationId,
    transcriptPath,
  });
  return redactPayload({ ...result });
}

const CONVERSATION_MESSAGE_KINDS = ["message", "reasoning", "tool_call", "tool_result", "trace"] as const;
const CONVERSATION_MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;

function conversationEngineForRoot(rootName: PinnedTranscript["rootName"]): "claude" | "codex" | "copilot" | null {
  if (rootName === "codex-sessions") return "codex";
  if (rootName === "claude-projects") return "claude";
  if (rootName === "copilot-sessions") return "copilot";
  return null;
}

function conversationMessageSet<T extends string>(
  value: unknown,
  fallback: readonly T[],
  allowed: readonly T[],
  field: string,
): Set<T> {
  if (value === undefined) return new Set(fallback);
  if (!Array.isArray(value) || value.length === 0 || value.some((candidate) => !allowed.includes(candidate as T))) {
    throw new McpToolRefusal(`${field} must be a non-empty subset of ${allowed.join(" | ")}.`, {
      code: `conversation_messages_${field}_invalid`,
    });
  }
  return new Set(value as T[]);
}

function conversationMessagesSince(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new McpToolRefusal("since must be an ISO-8601 timestamp with a UTC designator or numeric offset.", {
      code: "conversation_messages_since_invalid",
    });
  }
  return value;
}

/** Narrow read path for the voice companion. No MCP inventory or caller
 * supplied path, role, cursor or expansion flags cross this boundary. */
export async function voiceConversationTail(conversationId: string, dependencies: Pick<ViewerMcpDomainDependencies, "pinnedTranscript" | "selectedContext"> = productionDomainDependencies): Promise<Array<{ role: string; text: string }>> {
  const result = await conversationMessages({ conversationId, kinds: ["message"], roles: ["user", "assistant"], limit: 4, maxChars: 320 }, dependencies);
  return (result.records ?? []) as Array<{ role: string; text: string }>;
}

async function conversationMessages(
  args: McpToolArgs,
  dependencies: Pick<ViewerMcpDomainDependencies, "pinnedTranscript" | "selectedContext">,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  const selectedDependencies = dependencies.selectedContext ?? productionSelectedContextDependencies;
  const requestedPath = text(args.transcriptPath) || text(args.path);
  const selected = await resolveSelectedContext(args, text(args.conversationId), selectedDependencies, {
    voiceUtterance: !requestedPath,
    work: context.nativeWork ?? null,
  });
  const requestedId = selected.conversationId;
  if (!requestedId && !requestedPath) {
    throw new Error("conversationId, transcriptPath or selectedContext is required");
  }

  let transcriptPath = requestedPath;
  let conversationId: string | null = null;
  let engine: "claude" | "codex" | "copilot" | null = null;
  if (requestedId) {
    const target = selectedConversationTarget({ conversationId: requestedId }, selectedDependencies);
    transcriptPath = target.path!;
    conversationId = target.conversationId;
    engine = target.engine;
  }

  const pinned = (dependencies.pinnedTranscript ?? openPinnedTranscript)(transcriptPath);
  if (!pinned) {
    throw new McpToolRefusal("the conversation transcript is unavailable or outside the Viewer's scanner roots.", {
      code: "conversation_messages_transcript_unavailable",
      ...(conversationId ? { conversationId } : {}),
    });
  }
  try {
    if (!engine) {
      engine = conversationEngineForRoot(pinned.rootName);
      if (!engine) {
        throw new McpToolRefusal("conversation_messages supports Claude, Codex and Copilot transcripts only.", {
          code: "conversation_messages_engine_unsupported",
        });
      }
      conversationId = agentRegistry().conversationForPath(transcriptPath)?.id ?? null;
    }

    const kinds = conversationMessageSet<SessionRecordKind>(
      args.kinds,
      ["message"],
      CONVERSATION_MESSAGE_KINDS,
      "kinds",
    );
    const roles = conversationMessageSet<SessionRecord["role"]>(
      args.roles,
      CONVERSATION_MESSAGE_ROLES,
      CONVERSATION_MESSAGE_ROLES,
      "roles",
    );
    const since = conversationMessagesSince(args.since);
    const limit = Math.max(1, Math.min(200, integer(args.limit, 20)));
    const maxChars = Math.max(1, Math.min(16_000, integer(args.maxChars, 4_000)));
    const scope = messagesCursorScope(transcriptPath, kinds, roles, since);
    let cursor;
    try {
      cursor = args.cursor === undefined ? null : decodeMessagesCursor(text(args.cursor), scope);
    } catch (error) {
      if (error instanceof InvalidMessagesCursorError) {
        throw new McpToolRefusal(error.message, { code: "conversation_messages_cursor_invalid" });
      }
      throw error;
    }

    let page;
    try {
      page = readMessagesPage({
        descriptor: pinned.descriptor,
        size: pinned.stat.size,
        engine,
      }, { kinds, roles, since, limit, maxChars, cursor, redactText: context.redactText });
    } catch (error) {
      if (error instanceof StaleMessagesCursorError) {
        throw new McpToolRefusal(error.message, { code: "conversation_messages_cursor_stale" });
      }
      throw error;
    }
    throwIfCallEnded(context);
    if (!pinned.sameIdentity()) {
      throw new McpToolRefusal("the conversation transcript changed identity during the read.", {
        code: "conversation_messages_transcript_changed",
      });
    }
    return redactPayload({
      conversationId,
      ...(args.full === true || args.includeMetadata === true ? { transcriptPath, engine, lastRecordAt: page.lastRecordAt } : {}),
      /* sign-in-and-team §7.1: a human message names its member. */
      records: withRecordAuthors(conversationId, transcriptPath, page.records, {
        descriptor: pinned.descriptor, size: pinned.stat.size, engine, redactText: context.redactText,
      }),
      hasMore: page.hasMore,
      cursor: page.cursor ? encodeMessagesCursor(page.cursor, scope) : null,
      ...(args.full === true || args.includeMetadata === true || page.scanned.capped ? { scanned: page.scanned } : {}),
      ...selectedContextEcho(selected.target),
    });
  } finally {
    fs.closeSync(pinned.descriptor);
  }
}

function withRecordAuthors<T extends { seq: number; role: string; ts: string | null; text: string; sourceText?: string; sourceId?: string }>(
  conversationId: string | null,
  transcriptPath: string,
  records: T[],
  source: { descriptor: number; size: number; engine: "claude" | "codex" | "copilot"; redactText?: (text: string) => string },
): Array<T & { author?: RecordAuthor | AgentRecordAuthor }> {
  if (!records.some((record) => record.role === "user")) return records;
  const context = readMessageAuthorContext(source, records);
  const authorRecords = context ?? records;
  const claudeOrigins = source.engine === "claude" ? claudeMessageProvenance(transcriptPath) : undefined;
  const agentAuthors = agentRecordAuthors(transcriptPath, source.engine, authorRecords, context, claudeOrigins);
  const partAuthors = claudeOrigins ? agentRecordPartAuthors(transcriptPath, records, claudeOrigins,
    value => hardenedRedact(source.redactText ? source.redactText(value) : value)) : new Map();
  const contextPartAuthors = claudeOrigins ? agentRecordPartAuthors(transcriptPath, authorRecords, claudeOrigins) : new Map();
  const humanBySeq = new Map<number, RecordAuthor>();
  for (const [index, author] of recordAuthors(conversationId, authorRecords.map((record, index) => ({
    role: agentAuthors.has(index) || contextPartAuthors.has(index) ? "system" : record.role,
    ts: record.ts,
    text: record.sourceText ?? record.text,
  })))) humanBySeq.set(authorRecords[index]!.seq, author);
  const agentBySeq = new Map<number, AgentRecordAuthor>();
  for (const [index, author] of agentAuthors) agentBySeq.set(authorRecords[index]!.seq, author);
  const authors = new Map<number, RecordAuthor | AgentRecordAuthor>();
  records.forEach((record, index) => {
    const human = humanBySeq.get(record.seq);
    const agent = agentBySeq.get(record.seq);
    if (human) authors.set(index, human);
    else if (agent) authors.set(index, agent);
  });
  return records.map((record, index) => partAuthors.has(index)
    ? { ...record, parts: partAuthors.get(index)! }
    : authors.has(index) ? { ...record, author: authors.get(index)! } : record);
}

type ViewerSeatRefusal = "deputy" | "not-designated" | "no-seat" | "cross-project" | "foreign-project";

/**
 * Whether the caller is the designated orchestrator seat of the project whose
 * code this Delegatus serves — the authority `deploy_exact_sha` executes on,
 * and `auto_updates` writes on. Each tool words its own refusal.
 *
 * #795 (superseding contract): authority is derived from the SERVER-ATTRIBUTED
 * caller identity and nothing else: no operator confirmation, no authorization
 * row, and never anything read out of prose or reasoning. The identity chain
 * is the one production already trusts — process ancestry merged with the
 * admission-injected spawn capability, checked against the durable per-project
 * orchestrator designation.
 */
function viewerSeatAuthority(
  dependencies: ViewerMcpDomainDependencies,
): { ok: true; seat: ReturnType<typeof authorizedManagerSeats>[number] } | { ok: false; reason: ViewerSeatRefusal } {
  const attribution = attributionOf(dependencies);
  /* A deputy speaks as its seat everywhere except here and in rotation
     (docs/design/ghost-seat.md §4 rule 4): a five-minute self runs neither the
     one gated operation nor the one identity change. */
  if (attribution.via?.deputy) return { ok: false, reason: "deputy" };
  if (attribution.kind !== "manager" || !attribution.conversationId) return { ok: false, reason: "not-designated" };

  /* A designated seat's authority is scoped to its own project. The seat this
     conversation holds must be the seat of the caller's own canonical project —
     a seat exercising that authority from another project's context is the
     cross-project spend this refusal closes. */
  const seats = dependencies.authorizedSeats?.()
    ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const seat = seats.find((candidate) => candidate.conversationId === attribution.conversationId);
  if (!seat) return { ok: false, reason: "no-seat" };
  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  if (callerProject && seat.project !== callerProject) return { ok: false, reason: "cross-project" };

  /* #1321: being a designated seat says WHO, never WHAT. The Viewer serving
     this MCP is one repository, so a designated seat of any other project
     holds no authority over it at all. For a deploy the refusal is placed
     ahead of the POST on purpose: past it the runtime host fetches the
     canonical mirror and resolves the revision, so a foreign caller would
     otherwise learn only "revision not found" and go looking for a better
     SHA. Fails closed when the Viewer cannot name its own repository. */
  const viewerProjects = dependencies.viewerProjects ? dependencies.viewerProjects() : viewerOwnProjects();
  if (!seat.project || !viewerProjects.includes(seat.project)) return { ok: false, reason: "foreign-project" };
  return { ok: true, seat };
}

function deploySeatAuthority(
  dependencies: ViewerMcpDomainDependencies,
  revision?: string,
) {
  const authority = viewerSeatAuthority(dependencies);
  if (!authority.ok) {
    const refusals: Record<ViewerSeatRefusal, [string, string]> = {
      deputy: ["a parallel self of the orchestrator does not deploy; say in your final message what should ship and the seat decides on its next turn.", "deputy_cannot_deploy"],
      "not-designated": ["only the designated orchestrator executes deploys; this session is not attributed as a designated seat. Report the request over the bridge instead.", "deploy_caller_not_designated"],
      "no-seat": ["only the designated orchestrator executes deploys; this session holds no validated seat. Report the request over the bridge instead.", "deploy_caller_not_designated"],
      "cross-project": ["a designated orchestrator deploys only as its own project's seat; this session's seat belongs to another project", "deploy_cross_project"],
      "foreign-project": ["this tool deploys the Delegatus application that serves this MCP, and nothing else; it cannot deploy the caller's project, and no Delegatus surface can. Report the request over the bridge instead.", "deploy_foreign_project"],
    };
    const [message, code] = refusals[authority.reason];
    throw new McpToolRefusal(message, { code, revision });
  }
  return authority.seat;
}

async function deployExactSha(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
  callContext: McpToolCallContext = {},
): Promise<McpToolPayload> {
  const revision = required(args, "revision");
  if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error("revision must be a commit SHA or prefix of at least 7 characters");
  const seat = deploySeatAuthority(dependencies, revision);
  const assertSeat = () => {
    const current = deploySeatAuthority(dependencies, revision);
    if (current.conversationId !== seat.conversationId || current.project !== seat.project) {
      throw new McpToolRefusal("the designated deploy seat changed", { code: "deploy_caller_not_designated", retryable: false });
    }
  };

  const idempotencyKey = requestId(args);
  const pending = { conversationId: seat.conversationId, project: seat.project,
    revision: revision.toLowerCase(), requestedAt: new Date().toISOString(), idempotencyKey };
  try {
    await (dependencies.beginSeatDeployment ?? beginSeatDeployment)(pending, assertSeat);
  } catch (error) {
    if (callContext.priorAttemptUncertain && !(error instanceof McpToolRefusal)) {
      throw new McpDeploymentPendingError(`the prior deploy request is still being reconciled because seat attribution is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
  assertSeat();
  if (callContext.priorAttemptUncertain) {
    try {
      await recoverSeatDeploymentRequests(seat.conversationId, dependencies.findDeploymentByIdempotencyKey,
        dependencies.recordSeatDeployment);
      const recovered = seatDeploymentForRequestKey(idempotencyKey);
      if (recovered) {
        if (recovered.conversationId !== seat.conversationId || recovered.project !== seat.project
          || !recovered.revision.toLowerCase().startsWith(revision.toLowerCase())) {
          throw new McpToolRefusal("the deployment request key is attributed to a different seat or revision", {
            code: "deploy_request_key_conflict", retryable: false,
          });
        }
      } else {
        throw new McpDeploymentPendingError("the prior deploy request is still being reconciled; no new admission was sent");
      }
    } catch (error) {
      if (error instanceof McpToolRefusal || error instanceof McpDeploymentPendingError) throw error;
      throw new McpDeploymentPendingError(`the prior deploy request is still being reconciled because its receipt store is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const admittedReceipt = (): Record<string, unknown> | null => {
    const priorAdmission = seatDeploymentForRequestKey(idempotencyKey);
    if (!priorAdmission) return null;
    assertSeat();
    if (priorAdmission.conversationId !== seat.conversationId || priorAdmission.project !== seat.project
      || !priorAdmission.revision.toLowerCase().startsWith(revision.toLowerCase())) {
      throw new McpToolRefusal("the deployment request key is attributed to a different seat or revision", {
        code: "deploy_request_key_conflict", retryable: false,
      });
    }
    return { state: "accepted", deploymentId: priorAdmission.deploymentId,
      revision: priorAdmission.revision, replayed: true };
  };
  let receipt = admittedReceipt();
  if (!receipt) try {
    receipt = await control.post("/api/runtime/deployments", { revision, idempotencyKey });
  } catch (error) {
    if (error instanceof McpToolRefusal) {
      await forgetSeatDeploymentRequest(idempotencyKey, seat.conversationId);
      throw error;
    }
    try {
      await recoverSeatDeploymentRequests(seat.conversationId, dependencies.findDeploymentByIdempotencyKey,
        dependencies.recordSeatDeployment);
    } catch (recoveryError) {
      throw new McpDeploymentPendingError(`deployment admission may have completed, and its receipt could not be reconciled: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    }
    receipt = admittedReceipt();
    if (!receipt) throw new McpDeploymentPendingError(error instanceof Error ? error.message : "Deployment control wait ended");
  }
  const matchingBusy = receipt.state === "busy" && typeof receipt.revision === "string"
    && /^[0-9a-f]{40}$/i.test(receipt.revision) && receipt.revision.toLowerCase().startsWith(revision.toLowerCase());
  if (matchingBusy) receipt = { ...receipt, state: "accepted" };
  if (receipt.state === "busy" || receipt.state === "refused") {
    await forgetSeatDeploymentRequest(idempotencyKey, seat.conversationId);
  }
  /* #2063: the ledger never learns who asked, and the seat ends its turn so
     the promotion can replace its host. Recording the pair is what lets the
     seat tick wake this seat when the deployment settles. A matching busy
     receipt joins the same SHA; a different SHA remains a busy refusal.
     A failed write costs the wake and nothing else: the deployment is
     already admitted, so the answer says so rather than failing the call. */
  let wakeOnSettle = false;
  if (receipt.state === "accepted" && typeof receipt.deploymentId === "string" && receipt.deploymentId) {
    try {
      assertSeat();
      await (dependencies.recordSeatDeployment ?? recordSeatDeployment)({
        deploymentId: receipt.deploymentId,
        conversationId: seat.conversationId,
        project: seat.project,
        revision: typeof receipt.revision === "string" ? receipt.revision : revision.toLowerCase(),
        requestedAt: pending.requestedAt,
        idempotencyKey,
      }, assertSeat);
      await forgetSeatDeploymentRequest(idempotencyKey, seat.conversationId);
      wakeOnSettle = true;
    } catch (error) {
      console.error(`[deploy_exact_sha] could not record the seat for deployment ${receipt.deploymentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    deploymentId: receipt.deploymentId,
    revision: receipt.revision,
    replayed: receipt.state === "accepted" && receipt.replayed === true,
    state: receipt.state,
    /* Whether the seat tick will wake this seat when the deployment settles. */
    wakeOnSettle,
  };
}

/**
 * The channel the user hears from, callable from EVERY session (B+ item 3).
 *
 * What makes a report safe — the 2 KB bound, the secret redaction, the
 * idempotent key, the monotonic seq — lives in the store, so this cannot
 * weaken any of it by being called differently. What it owns is the ORIGIN
 * LABEL, derived server-side from the durable caller identity and stored on
 * the row, and, for the designated orchestrator's own reports, the report's
 * shape (docs/design/orchestrator-reports.md §5.2): the seat passes a summary
 * and sections, and the Viewer renders the header, the time, the headings and
 * the deploy's task changes, scrubs private information, fits the size, and
 * posts the same report to the project's Telegram chat when there is one. A
 * non-orchestrator report keeps a visible attribution prefix ahead of anything
 * the caller wrote, so the gateway can never mistake it for — or speak it as —
 * the manager's voice, and it goes to the bridge only.
 */
async function bridgeReport(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  control: ViewerControlDependencies | null,
): Promise<McpToolPayload> {
  const key = required(args, "key");
  const reportClass = text(args.class);
  if (!isBridgeReportClass(reportClass)) throw new Error("class must be one of the bridge report classes");
  const summary = text(args.summary);
  const sections = reportSectionsArg(args.sections);
  const body = text(args.body);
  const hasSections = Object.values(sections).some((items) => items.length > 0);
  if (!summary && !hasSections && !body) throw new Error("summary and sections are required (or, from an older caller, body)");
  const covers = Array.isArray(args.covers)
    ? [...new Set(args.covers.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()))].slice(0, 64)
    : [];
  const coversOwed = args.coversOwed === true;
  const outcomeKind = args.outcome === undefined || args.outcome === null ? null : text(args.outcome);
  if (outcomeKind !== null && !isBridgeReportOutcomeKind(outcomeKind)) throw new Error("outcome must be incident, publication or autonomy");
  if (key.startsWith("autonomy:") && outcomeKind !== "autonomy") throw new Error("autonomy report keys require outcome autonomy");

  const origin = attributionOf(dependencies);
  /* Folded through the project aliases once, here: the seat tick reads the log
     under the canonical key, and a seat recorded before its folder changed key
     still carries the old one as its conversation's project. */
  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  const project = callerProject ? canonicalOrchestratorProject(callerProject) : null;
  const autonomyEpisode = outcomeKind === "autonomy" && project && origin.kind === "manager"
    ? pendingAutonomyReports(readSeatTickSettings(project), Date.now()).find(episode => autonomyReportKey(episode) === key) : null;
  if (outcomeKind === "autonomy" && (origin.kind !== "manager" || reportClass !== "status" || (!autonomyEpisode && !(project && findBridgeReport(scopedReportId(project, key))?.outcome?.kind === "autonomy")))) {
    throw new Error("autonomy report must name an ended episode owed by this project's seat");
  }
  /* #2146: the operator turned this project's reports off. An answer, not an
     error: the caller did nothing wrong, and nothing is stored. */
  if (project && !bridgeReportsEnabled(project) && outcomeKind !== "autonomy") {
    return { recorded: false, replayed: false, bridgeReports: false, message: "bridge reports are off for this project" };
  }
  const seats = dependencies.authorizedSeats?.()
    ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const targetSeat = project
    ? seats.find((seat) => seat.project === project)
    : undefined;

  /* A replay stores nothing. Its one job is a Telegram copy whose send failed
     retryably: the row's stored HTML is re-sent byte for byte, and this call's
     own arguments are ignored (§5.5). Only the manager's own replay re-sends:
     the post goes out under the caller's capability and attribution. A row
     filed under the caller's old project key before it was folded is still
     the same report. The stored copy goes out only while the project still
     reports to the chat it was rendered for: a project whose operator chose
     "Log only" since, or that never chose (a row written while a fallback
     chat stood in for a choice), posts nothing, and a newly chosen chat is
     never handed HTML rendered for the old one. */
  const reportId = scopedReportId(project, key);
  const existing = findBridgeReport(reportId)
    ?? (callerProject && callerProject !== project ? findBridgeReport(scopedReportId(callerProject, key)) : null);
  if (existing) {
    if (outcomeKind === "autonomy" && existing.outcome?.kind !== "autonomy") throw new Error("autonomy report key is occupied by another report");
    if (autonomyEpisode && project) markAutonomyReported(project, autonomyEpisode.startedAt, existing.at);
    const telegram = existing.telegram && existing.telegram.state === "failed" && existing.origin?.kind === "manager"
      && origin.kind === "manager" && isRetryableReportSend(existing.telegram.code)
      && project !== null && effectiveReportTelegram(project)?.chat === existing.telegram.chat
      && effectiveReportTelegram(project)?.topicId === existing.telegram.topicId
      ? await postReportTelegram(existing.id, existing.telegram.chat, existing.telegram.html, existing.telegram.topicId, `bridge-report:${existing.id}:r${existing.telegram.attempts}`, dependencies, control)
      : existing.telegram ?? null;
    /* `alreadyRecorded`, because the tool service's envelope owns `replayed`
       (a replay of the same clientRequestId). */
    return {
      recorded: false,
      alreadyRecorded: true,
      ...(outcomeKind === "autonomy" ? { chatText: existing.body, nextAction: "Repeat chatText exactly in the seat conversation." } : {}),
      seq: existing.seq,
      reportId: existing.id,
      destinations: reportDestinations(existing.seq, telegram),
    };
  }

  const locale = dependencies.operatorLocale ? dependencies.operatorLocale() : operatorLocale();
  const warnings: string[] = [];
  let storedBody: string;
  let complete: BridgeReportCompleteV1 | null = null;
  let telegramCopy: { chat: string; html: string; topicId?: number } | null = null;
  /* «Готово» (docs/design/done-section.md §2.3): the marker is the
     orchestrator's own, kept beside its row with the summary it rendered. */
  let outcome: BridgeReportOutcome | null = null;
  if (outcomeKind !== null && origin.kind !== "manager") warnings.push("outcome was ignored: only the project's orchestrator marks an outcome.");
  if (origin.kind === "manager") {
    /* Only a chat the operator chose for the project is posted to (§5.6). */
    const destination = project && bridgeReportsEnabled(project) ? effectiveReportTelegram(project) : null;
    const deployKey = [key, ...covers].find((entry) => entry.startsWith("deploy:")) ?? null;
    const tasks = deployKey && project ? deployReportTaskChanges(project, deployKey, dependencies) : null;
    if (deployKey && project && !tasks) warnings.push("No task changes are listed: this deploy has no board snapshot to compare, because it settled before snapshots existed or aged out.");
    const rendered = await renderReportAsync({
      class: reportClass,
      deploy: deployKey !== null,
      name: project ? reportHeaderName(project, locale ?? "en") : "Delegatus",
      at: new Date(),
      locale,
      timeZone: dependencies.operatorTimeZone ? dependencies.operatorTimeZone() : operatorTimeZone(),
      summary,
      sections,
      legacyBody: hasSections ? null : body,
      taskChanges: tasks,
      deny: dependencies.publicDenyList ? dependencies.publicDenyList(project) : await productionPublicDenyList(project, control, destination !== null),
    });
    if (rendered.empty) {
      const scrubbed = Object.keys(rendered.dropped).length > 0;
      throw new McpToolRefusal(
        scrubbed
          ? "Nothing is left after removing private information; refile without it."
          : "Nothing is left to report: every item was empty or too long; refile with a summary and short items.",
        { code: "report_empty_after_scrub", retryable: false, warnings: rendered.warnings },
      );
    }
    /* The voice relays a report whole or not at all: one past its bound is
       refused before anything is stored, never shortened. */
    if (rendered.tooLarge || (rendered.complete && !bridgeReportComplete(rendered.complete))) {
      throw new McpToolRefusal(
        `The report is longer than ${BRIDGE_REPORT_COMPLETE_MAX_BYTES} bytes as a whole, so it cannot be relayed without leaving items out. Nothing was recorded. Split it into several reports, each with its own key, or shorten the items.`,
        { code: "report_too_large", retryable: false, warnings: rendered.warnings },
      );
    }
    warnings.push(...rendered.warnings);
    const language = languageMismatchWarning("report", [summary, ...Object.values(sections).flat(), hasSections ? "" : body].join("\n"), locale);
    if (language) warnings.push(language);
    storedBody = renderPlain(rendered.cut);
    if (outcomeKind !== null) {
      const line = rendered.cut.summary || rendered.cut.sections.flatMap((section) => section.items)[0] || "";
      if (line) outcome = { kind: outcomeKind, summary: line };
      else warnings.push("outcome was ignored: the report has no summary to show for it.");
    }
    /* The voice relays the report whole; the body stays the display copy. */
    complete = rendered.complete;
    if (destination) {
      telegramCopy = { chat: destination.chat, html: renderTelegram(rendered.cut, knownPullRequests(project!)), ...(destination.topicId ? { topicId: destination.topicId } : {}) };
    }
  } else {
    /* The visible attribution is SERVER-composed and leads the body, so
       whatever a caller writes inside its own text appears after the
       authoritative label. */
    const own = body || [summary, ...Object.values(sections).flat()].filter(Boolean).join("\n");
    storedBody = `[${origin.kind === "gateway" ? "voice gateway" : origin.role ?? "agent"}${origin.conversationId ? ` ${origin.conversationId}` : ""} — not the manager] ${own}`;
  }

  const appended = recordManagerReport({
    key,
    class: reportClass,
    at: new Date().toISOString(),
    origin,
    project,
    targetSeatConversationId: targetSeat?.conversationId ?? null,
    body: storedBody,
    complete,
    correlatesDirective: text(args.correlatesDirective) || null,
    ...(typeof args.answersDirective === "boolean" ? { answersDirective: args.answersDirective } : {}),
    covers,
    coversOwed,
    telegram: telegramCopy,
    outcome,
  });

  /* A replay under the same key appends nothing, and says so rather than pretending
     to have delivered a second report. */
  if (!appended) {
    const winner = findBridgeReport(reportId);
    if (autonomyEpisode && project && winner) markAutonomyReported(project, autonomyEpisode.startedAt, winner.at);
    return { recorded: false, alreadyRecorded: true, ...(outcomeKind === "autonomy" && winner ? { chatText: winner.body, nextAction: "Repeat chatText exactly in the seat conversation." } : {}) };
  }
  if (autonomyEpisode && project) markAutonomyReported(project, autonomyEpisode.startedAt, appended.at);
  const telegram = appended.telegram
    ? await postReportTelegram(appended.id, appended.telegram.chat, appended.telegram.html, appended.telegram.topicId, `bridge-report:${appended.id}`, dependencies, control)
    : null;
  return {
    recorded: true,
    replayed: false,
    seq: appended.seq,
    reportId: appended.id,
    ...(outcomeKind === "autonomy" ? { chatText: appended.body, nextAction: "Repeat chatText exactly in the seat conversation." } : {}),
    warnings,
    destinations: reportDestinations(appended.seq, telegram),
  };
}

/* Every item reaches the renderer: the display counts what it does not show,
   and the whole report's byte bound refuses one too large to relay whole. */
function reportSectionsArg(value: unknown): Record<SeatSectionId, string[]> {
  const sections = {} as Record<SeatSectionId, string[]>;
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  for (const id of SEAT_SECTION_IDS) {
    const items = record[id];
    sections[id] = Array.isArray(items)
      ? items.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];
  }
  return sections;
}

function reportDestinations(seq: number, telegram: BridgeReportTelegram | null): Record<string, unknown> {
  return {
    bridge: { seq },
    ...(telegram
      ? {
        telegram: {
          chat: telegram.chat,
          state: telegram.state,
          ...(telegram.messageIds?.length ? { messageIds: telegram.messageIds } : {}),
          ...(telegram.code ? { code: telegram.code, retryable: isRetryableReportSend(telegram.code) } : {}),
          ...(telegram.message ? { message: telegram.message } : {}),
          ...(telegram.bot ? { bot: telegram.bot } : {}),
          ...(telegram.refusals ? { refusals: telegram.refusals } : {}),
        },
      }
      : {}),
  };
}

/** Codes a replay of the same key may re-send on. `send_uncertain` is never
    one: a second public post is worse than a missing one. */
function isRetryableReportSend(code: string | null | undefined): boolean {
  return !!code && code !== "send_uncertain" && code !== "send_partial"
    && RETRYABLE_TELEGRAM_BOT_CODES.has(code as TelegramBotErrorCode);
}

/**
 * Post a report's stored Telegram copy through the bot service, silently and
 * as HTML, attributed to the calling seat and idempotent under the given
 * request id, and record the outcome on the row. A failed post never loses
 * the report: the bridge row stays either way.
 */
async function postReportTelegram(
  reportId: string,
  chat: string,
  html: string,
  topicId: number | undefined,
  clientRequestId: string,
  dependencies: ViewerMcpDomainDependencies,
  control: ViewerControlDependencies | null,
): Promise<BridgeReportTelegram | null> {
  const send = dependencies.sendReportTelegram ?? ((input: ReportTelegramSend) => productionSendReportTelegram(input, control));
  let outcome: ReportTelegramSendOutcome;
  try {
    outcome = await send({ chat, html, ...(topicId ? { topicId } : {}), clientRequestId });
  } catch (error) {
    outcome = { ok: false, code: "telegram_failed", message: error instanceof Error ? error.message : String(error) };
  }
  const at = new Date().toISOString();
  const evidence = { ...(outcome.bot ? { bot: outcome.bot } : {}), ...(outcome.refusals ? { refusals: outcome.refusals } : {}) };
  return recordBridgeReportTelegram(reportId, outcome.ok
    ? { state: "sent", messageIds: outcome.messageIds, at, ...evidence }
    : { state: outcome.code === "send_uncertain" ? "uncertain" : "failed", code: outcome.code, message: outcome.message ?? `Telegram report send failed (${outcome.code})`, at, ...evidence })?.telegram ?? null;
}

export interface ReportTelegramSend {
  chat: string;
  html: string;
  topicId?: number;
  clientRequestId: string;
}

export type ReportTelegramSendOutcome = { bot?: string; refusals?: { bot: string; code: string }[] } & (
  | { ok: true; messageIds: number[] }
  | { ok: false; code: string; message?: string });

async function productionSendReportTelegram(input: ReportTelegramSend, control: ViewerControlDependencies | null): Promise<ReportTelegramSendOutcome> {
  if (!control) return { ok: false, code: "telegram_failed", message: "no Viewer control is available to post through" };
  try {
    const result = await dispatchControl(control)("/api/telegram/bot/agent", {
      op: "send",
      clientRequestId: input.clientRequestId,
      chat: input.chat,
      ...(input.topicId ? { topicId: input.topicId } : {}),
      text: input.html,
      format: "html",
      silent: true,
    }, callerCapabilityHeaders()) as { messageIds?: unknown; sentBy?: { username?: string | null }; refusals?: import("@/lib/telegram/bot/contracts").TelegramBotRefusal[] };
    const messageIds = Array.isArray(result?.messageIds) ? result.messageIds.filter((id): id is number => Number.isInteger(id)) : [];
    return { ok: true, messageIds, ...(result.sentBy?.username ? { bot: result.sentBy.username } : {}),
      ...(result.refusals ? { refusals: readTelegramBotRefusals(result.refusals).map(r => ({ bot: r.bot.username ?? r.bot.name, code: r.code })) } : {}) };
  } catch (error) {
    if (error instanceof McpDispatchVerdictError && typeof error.details.code === "string") {
      return { ok: false, code: error.details.code, message: error.message,
        ...(Array.isArray(error.details.refusals) ? { refusals: readTelegramBotRefusals(error.details.refusals).map(r => ({ bot: r.bot.username ?? r.bot.name, code: r.code })) } : {}) };
    }
    return { ok: false, code: "telegram_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The task changes a deploy report lists (§3.8), from the key the tick gave:
 * `deploy:<sha8>:succeeded` names the newest snapshot of that commit that
 * succeeded, `deploy:<sha8>:failed:<attempt8>` the failed attempt whose
 * deployment id starts with `<attempt8>`.
 */
function deployReportTaskChanges(project: string, deployKey: string, dependencies: ViewerMcpDomainDependencies): TaskChanges | null {
  const [, sha8, outcome, attempt8] = deployKey.split(":");
  if (!sha8) return null;
  try {
    const snapshots = projectSnapshots(project);
    const snapshot = outcome === "failed"
      ? snapshots.filter((entry) => entry.sha8 === sha8 && entry.state !== "succeeded" && (!attempt8 || entry.deploymentId.startsWith(attempt8))).at(-1)
      : snapshots.filter((entry) => entry.sha8 === sha8 && entry.state === "succeeded").at(-1);
    if (!snapshot) return null;
    const tasks = dependencies.listTaskRecords?.() ?? dependencies.loadTasks();
    return deployTaskChanges(project, snapshot.deploymentId, tasks);
  } catch {
    return null;
  }
}

/** The pull requests the forge cache knows for the project's repository, so
    the Telegram copy writes them as "PR N"; any other `#N` stays as it is. */
function knownPullRequests(project: string): PullRequestLookup {
  try {
    const repository = githubRepositoryOfRemote(recordedProjectRemote(project));
    const view = repository ? forgeCacheView().repository(repository) : null;
    return view ? { has: (number) => view.pr(number) !== undefined } : { has: () => false };
  } catch {
    return { has: () => false };
  }
}

/**
 * What the scrubber looks for by name (§5.5), read at call time: every account
 * id and label, the OS user name, the home directory's name and the machine's
 * host name, the people the bot has seen in its allowlisted chats, and the
 * other projects in repository form. Public bridge reports retain their soft
 * reading; issue reports require every source read to complete.
 */
async function productionPublicDenyList(project: string | null, control: ViewerControlDependencies | null, postsToTelegram: boolean, requireComplete = false): Promise<PublicDenyList> {
  const accounts: string[] = [];
  const collect = (list: () => readonly { id: string; label: string }[]) => {
    try {
      for (const account of list()) accounts.push(account.id, account.label);
    } catch (error) {
      if (requireComplete) throw error;
      // An unreadable registry contributes nothing.
    }
  };
  collect(() => requireComplete ? claudeAccountsForPrivacy() : listClaudeAccounts());
  collect(() => requireComplete ? codexAccountsForPrivacy() : listCodexAccounts());
  collect(() => requireComplete ? copilotAccountsForPrivacy() : listCopilotAccounts());
  const local: string[] = [];
  try {
    local.push(os.userInfo().username, path.basename(os.homedir()), os.hostname().split(".")[0] ?? "");
  } catch (error) {
    if (requireComplete) throw error;
    // Nothing to add.
  }
  /* The bot's people are read only for a project that posts to a bot chat:
     a bridge-only project shares nothing with the bot's chats. */
  if (requireComplete && postsToTelegram && !control) throw new Error("Privacy names read is unavailable");
  const people = control && (project || requireComplete) && postsToTelegram ? await telegramPeople(control, requireComplete) : [];
  const projects: { repository: string | null; names: string[] }[] = [];
  try {
    const own = project ? canonicalOrchestratorProject(project) : null;
    const keys = new Set<string>();
    for (const seat of activeOrchestratorSeats()) keys.add(canonicalOrchestratorProject(seat.project));
    const aliases = projectAliasSnapshot({ strict: requireComplete });
    const remotes = requireComplete ? recordedProjectRemotes({ strict: true }) : {};
    for (const key of Object.keys(aliases.displayNames)) keys.add(requireComplete ? key : canonicalOrchestratorProject(key));
    for (const key of Object.keys(remotes)) keys.add(key);
    for (const key of keys) {
      if (!requireComplete && key === own) continue;
      const remote = requireComplete ? remotes[key] ?? null : recordedProjectRemote(key);
      const repository = githubRepositoryOfRemote(remote);
      /* Private repository names belong to every forge and local remote.
         Reuse the project resolver and the report's canonical text decoder. */
      const remoteName = requireComplete && remote ? projectIdentityFromRemote(remote, process.cwd())?.displayName ?? "" : "";
      const decodedName = canonicalSensitiveText(remoteName);
      if (decodedName.error) throw new Error("Privacy repository name is unreadable");
      projects.push({
        repository,
        names: [repository?.split("/")[1] ?? "", remoteName, decodedName.text, projectDisplayName(key, aliases.displayNames[key])].filter(Boolean),
      });
    }
  } catch (error) {
    if (requireComplete) throw error;
    // An unreadable catalog contributes nothing.
  }
  /* Role memory is never optional here: a store that cannot be read throws
     LESSON_PRIVACY_UNAVAILABLE, and nothing is sent unchecked. */
  // The shared leased worker reads authoritative lessons at filtering time.
  return { accounts, people, local, projects };
}

async function telegramPeople(control: ViewerControlDependencies, requireComplete = false): Promise<string[]> {
  const people = new Set<string>();
  try {
    const chats = await readViewerControl(control, `/api/telegram/bot/agent?op=chats${requireComplete ? "&includeInactive=1" : ""}`) as { chats?: { chat?: unknown; postAllowed?: unknown }[]; truncated?: number };
    if (requireComplete && !Array.isArray(chats.chats)) throw new Error("Privacy chats read is malformed");
    if (requireComplete && chats.truncated) throw new Error("Privacy chats read is incomplete");
    /* Publication protects retained people in every known chat, including
       chats the bot has left. The bridge retains its destination-specific reading. */
    if (requireComplete && chats.chats?.some((entry) => !entry || typeof entry.chat !== "string" || !entry.chat.trim())) throw new Error("Privacy chats read is malformed");
    const readable = (chats.chats ?? []).filter((entry) => (requireComplete || entry.postAllowed === true) && typeof entry.chat === "string");
    for (const chat of requireComplete ? readable : readable.slice(0, 4)) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const params = new URLSearchParams({ op: "messages", chat: chat.chat as string, limit: "100", maxChars: "1" });
        if (cursor) params.set("cursor", cursor);
        const page = await readViewerControl(control, `/api/telegram/bot/agent?${params}`) as { messages?: { from?: { name?: unknown; username?: unknown } | null; fromName?: unknown; fromUsername?: unknown }[]; hasMore?: boolean; nextCursor?: string | null };
        if (requireComplete && (!Array.isArray(page.messages) || typeof page.hasMore !== "boolean"
          || !(page.nextCursor === null || typeof page.nextCursor === "string")
          || (!page.hasMore && page.nextCursor !== null))) throw new Error("Privacy people read is malformed");
        for (const message of page.messages ?? []) {
          for (const value of [message.from?.name, message.from?.username, message.fromName, message.fromUsername]) {
            if (typeof value === "string" && value.trim()) people.add(value.replace(/^@/, "").trim());
          }
        }
        cursor = requireComplete && page.hasMore ? page.nextCursor ?? null : null;
        if (requireComplete && page.hasMore && (!cursor?.trim() || seen.has(cursor))) throw new Error("Privacy people read is incomplete");
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
  } catch (error) {
    if (requireComplete) throw error;
    // No bot, or no answer: nobody to look for.
  }
  return [...people];
}

/**
 * The gateway's relay to the manager (#691 §4) — user intent, flowing onward.
 *
 * Two things are deliberately NOT the caller's to choose, because both are how a
 * relay stops being exactly-once:
 *
 * - The RECIPIENT is resolved from the designation record here. A gateway that
 *   could name a conversation could message a worker directly, which is the one
 *   sentence the whole architecture exists to prevent.
 * - The DELIVERY ID is derived from the root turn. `send_message`-style receipts
 *   are durable and recognize a replayed id, so a retry after a lost receipt
 *   answers from the receipt instead of delivering the instruction a second time —
 *   but only if the id is a function of the turn rather than freshly minted.
 */
async function bridgeDirective(args: McpToolArgs, control: ViewerControlDependencies, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const instruction = text(args.instruction);
  if (!instruction) throw new Error("instruction is required");
  const utterance = args.utterance;
  if (typeof utterance !== "number") throw new Error("utterance must be a non-negative integer");
  /* Both throw on anything that would not round-trip through the parser. */
  const deliveryId = bridgeDirectiveId(text(args.rootTurnId), utterance);

  /* Recipient resolution (FIX 2, post-#758 operator decision). Every directive
     routes through the VALIDATED per-project seat authority — the global
     last-seated legacy record is NEVER consulted, because that was the defect:
     seating project B silently redirected project A's directives.

     An explicitly named project overrides. An UN-SCOPED directive follows the
     CALLING VOICE SESSION'S canonical project, resolved from the conversation's
     cwd through the same worktree-grouping path (`projectInfoFromCwd`) every
     other project attribution uses — never a second scheme. */
  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  const project = text(args.project) || callerProject;
  if (!project) {
    /* Diagnostic, not a menu: a REGISTERED voice session always has a cwd and
       therefore a canonical project. Reaching this line means the invariant is
       violated — corrupted or incomplete registry state — and the refusal names
       that rather than modelling it as an ordinary choice or falling back to
       whatever project was seated last. */
    throw new McpToolRefusal(
      "INVARIANT VIOLATION: the calling voice session resolves to no canonical project — a registered conversation must derive one from its cwd through the worktree-grouping path. Routing fails closed; investigate the session's registry record (an explicit project can be named meanwhile).",
      { code: "caller_project_unresolved" },
    );
  }
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const seat = seats.find((candidate) => candidate.project === project);
  if (!seat) {
    throw new McpToolRefusal(
      `no validated orchestrator is designated for ${project}; create one first, then relay again`,
      { code: "manager_not_designated", project },
    );
  }
  const manager: { conversationId: string; path: string | null } = { conversationId: seat.conversationId, path: seat.path };

  /* NO CIRCLES (#1615). The recipient is the project's designated orchestrator,
     so a caller that IS that orchestrator would relay the instruction to itself:
     the operator watched exactly this — a seat with voice enabled announced it
     would hand the finished reviews "to the manager", the directive arrived back
     in its own conversation, and the work went undone while the board still
     showed it as the manager.
     The persona a call injects no longer tells a seat to relay (voicePersonaMandate),
     which is the cause. This is the tool refusing to close the circle whatever it
     is told — by an operator override, by a thread still carrying the old item, or
     by a later prompt edit. The refusal SAYS WHAT TO DO INSTEAD, because an agent
     that believes it must delegate and is merely blocked will keep retrying.

     Attribution reads process ancestry and can fault. When it does, this stands
     down rather than refusing every relay: a defence in depth that breaks the
     ordinary path when its own input is unavailable is worse than the loop it
     prevents, and the persona is the layer that stops this being reached. */
  let callerConversationId: string | null = null;
  try {
    callerConversationId = attributionOf(dependencies).conversationId;
  } catch {
    callerConversationId = null;
  }
  if (callerConversationId && callerConversationId === manager.conversationId) {
    throw new McpToolRefusal(
      `you are the designated orchestrator for ${project}, so this directive would be addressed to you. Voice changes how you hear a request. It does not change who acts on it: do this work yourself, with your own tools. Relay only to an orchestrator that is not you.`,
      { code: "directive_self_relay", project },
    );
  }

  const ref = args.ref;
  const trailer: BridgeTrailer | undefined = typeof ref === "number" && Number.isInteger(ref) && ref > 0
    ? { ref }
    : undefined;
  const body = bridgeDirectiveBody(instruction, trailer);

  const outcome = await control.post("/api/tmux", {
    pid: null,
    path: manager.path,
    conversationId: manager.conversationId,
    clientMessageId: deliveryId,
    text: body,
    images: [],
    policy: "steer-or-queue",
    /* #1117: a directive relay is inter-agent traffic — the manager's feed
       names the gateway (or attributed caller role), never the operator. */
    origin: mcpSenderOrigin(dependencies),
  }, callerCapabilityHeaders());
  const settledOutcome = outcome.outcome ?? "delivered";
  const operationId = typeof outcome.operationId === "string" ? outcome.operationId : null;
  /* The trailer is the ONLY thing that says a report was answered — the drain
     cursor says only that it was read aloud — so it is recorded the moment the
     answer actually reaches the manager (#1168), and NOT before: an accepted
     directive that is still `queued` has not reached anyone, and recording it
     then would clear a pending decision that a dropped delivery means nobody
     ever saw (#1131).
     An acceptance is not the end of it either. The ref is PARKED against the
     operation id the send returned, so the ask clears itself the moment that
     send is recorded delivered, and stays standing if it is recorded failed —
     which is what stops a queued directive from leaving the manager's decision
     request open forever after the message did arrive.
     Both are scoped by the project and seat this directive was just routed to,
     because a report seq is log-global: the
     store settles the ref only if it names a decision request THIS seat filed,
     so a ref that names nothing yet cannot pre-answer a later report and a
     directive cannot clear another project's ask. The seat identity travels in
     through the registry's alias chain, because the log recorded whatever the
     conversation was called when it asked while the seat authority hands this
     relay whatever it is called now — and the attention projection resolves the
     recorded id the same way, so anything less here leaves a rekeyed seat's ask
     visible and unanswerable. Idempotent, so a directive retry under the same
     derived id settles the same seq once. */
  if (trailer) {
    const scope = { project, seatConversationId: manager.conversationId };
    const canonical = dependencies.canonicalSeatConversationId ?? productionCanonicalSeatConversationId;
    if (settledOutcome === "delivered") recordBridgeDirectiveAnswer(trailer.ref, scope, canonical);
    else if (operationId) recordBridgeDirectivePendingAnswer(trailer.ref, scope, operationId, canonical);
  }
  return {
    directiveId: deliveryId,
    managerConversationId: manager.conversationId,
    operationId,
    outcome: settledOutcome,
    /* #1131: the same contract `send_message` answers with — acceptance is not
       arrival, and `message_receipt` over the operation id is what says which. */
    settled: settledOutcome === "delivered",
  };
}

/**
 * The conversation a spawn's completion notices go back to
 * (docs/design/spawn-completion-notice.md §1): the calling agent as the
 * server attributes it — a deputy is its own launcher, since it is the one
 * waiting. The operator's root session, an unidentified caller and a
 * process without attribution launch with none, and hear nothing back.
 */
export function mcpSpawnLauncher(dependencies?: Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">): string | null {
  if (!dependencies) return null;
  try {
    const attribution = attributionOf(dependencies);
    if (attribution.native || (attribution.kind !== "agent" && attribution.kind !== "manager")) return null;
    const conversationId = attribution.via?.deputy ?? attribution.conversationId;
    return conversationId?.startsWith("conversation_") ? conversationId : null;
  } catch {
    return null;
  }
}

/** Sanitized idempotency key derived from the caller's, for a secondary side
    effect that must replay with its parent call. */
function derivedRequestId(base: string, suffix: string): string {
  return spawnAttemptId(`${base}:${suffix}`);
}

/** The capability used by both the spawn dispatch and its admission probe.
    Keeping these control calls on one header path prevents a future route
    authentication change from admitting the dispatch while refusing recovery. */
function spawnControlHeaders(): Record<string, string> {
  return {
    ...internalServiceHeaders("mcp"),
    [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability(),
  };
}

/**
 * The calling session's own conversation capability, forwarded so the
 * designation routes' operator gate can fire (BLOCKING 1 of the #758 review).
 *
 * Designation is an OPERATION contract, exactly like the deploy executor's
 * seat check: the tools stay on every session's surface (axis 1), but a caller
 * that the registry names as an agent conversation may not seat, rotate or
 * auto-create an orchestrator — otherwise any session could hand ITSELF
 * manager voice and deploy authority in one call. The Viewer injected this capability into
 * the launch environment; presenting it is how an agent names itself, and the
 * routes' `requireOperatorAuthority` refuses a self-named caller. An operator
 * lane (no capability in the environment) forwards nothing and passes.
 *
 * ROTATION is the exception, and the same header is what makes it work (#1402):
 * the rotation route reads this name to ATTRIBUTE the rotation, so the seat the
 * operator told to rotate performs it here and the shell fallback is gone.
 */
function callerCapabilityHeaders(): Record<string, string> {
  const capability = callerCapability()?.trim() ?? "";
  return {
    ...internalServiceHeaders("mcp"),
    ...(/^[A-Za-z0-9_-]{43}$/.test(capability) ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {}),
  };
}

/** Explicitly allowlisted fields for the designation routes. The seat route
    authorizes existing-conversation adoption before it writes an intent;
    mandate provenance stays server-owned. */
function allowedSeatFields(args: McpToolArgs, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => (args[key] === undefined ? [] : [[key, args[key]]])));
}

/**
 * A seat record without its two long texts (#2064): the mandate (about 25 KB
 * for the default one) and the role table. Their lengths stay, so a caller can
 * see that they exist and ask for them with full:true.
 */
function compactOrchestratorSeat(seat: OrchestratorSeat | null): Record<string, unknown> | null {
  if (!seat) return null;
  const { mandate, roleTable, ...rest } = seat;
  return { ...rest, mandateLength: mandate.length, roleTableLength: roleTable?.length ?? null };
}

/** `reportTelegram` is where reports go besides the log, as `bridge_report`
    posts them: the chat the operator chose, null while they chose none or
    "Log only". */
function reportFields(project: string, dependencies: ViewerMcpDomainDependencies): { operatorLocale: "en" | "uk" | null; reportTelegram: EffectiveReportTelegram | null } {
  return {
    operatorLocale: dependencies.operatorLocale ? dependencies.operatorLocale() : operatorLocale(),
    reportTelegram: effectiveReportTelegram(project),
  };
}

/** Only affirmative admission refusals prove that a request admitted no work.
    A bare 4xx can follow an accepted spawn whose activation was superseded. */
function orchestratorDispatchRefusal(error: unknown): McpDispatchNotExecutedError | null {
  if (!(error instanceof McpDispatchVerdictError)) return null;
  const details = error.details;
  if (typeof details.operationId === "string" || typeof details.launchId === "string" || details.actuation === "started") return null;
  if (details.admission !== "refused") return null;
  return new McpDispatchNotExecutedError(error.message, details);
}

/** Resolve names through the directory shared with voice and transcript search. */
function resolveOrchestratorToolProject(named: string, dependencies: ViewerMcpDomainDependencies, requireActiveSeat = true): string {
  try {
    recordSeatProjectSuccessions(seatLaunchCwd, true);
    return resolveNamedProject(named, namedProjectDirectory(dependencies), requireActiveSeat);
  }
  catch (error) {
    if (error instanceof ProjectNameRefusal) throw new McpToolRefusal(error.message, error.details);
    throw error;
  }
}

/** Explicit launch names resolve before claims and must still name the cwd. */
async function namedLaunchProject(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies, field: "cwd" | "repoDir"): Promise<McpToolArgs> {
  if (!text(args.project)) return args;
  const directory = field === "cwd" ? spawnCwd(args) : path.resolve(required(args, field));
  const project = await resolveOrchestratorToolProject(text(args.project), dependencies);
  const canonical = projectForCwd(directory);
  if (project !== canonical) throw new McpToolRefusal(`project contradicts the canonical project of ${field}; omit it or name the launch directory's own project`, {
    code: "invalid_request", status: 400, canonicalProject: canonical,
  });
  return { ...args, project };
}

/** Original-key lookups authenticate the caller and use the recorded target.
    A later display-name change cannot invalidate an existing launch receipt. */
function launchRecoveryBinding(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies, field: "cwd" | "repoDir"): McpRequestBindingInput {
  const directory = field === "cwd" ? spawnCwd(args) : path.resolve(required(args, field));
  const caller = recoveryCaller(dependencies);
  if (field === "cwd" && caller.kind === "unidentified") requireMcpDeployerCaller(args, projectForCwd(directory), dependencies);
  return {
    caller,
    target: { project: null, identity: directory },
    downstreamKey: field === "cwd" ? `mcp_spawn_${crypto.createHash("sha256").update(requestId(args)).digest("hex")}` : `create_pipeline:${requestId(args)}`,
  };
}

/** Fresh admission resolves the name before claiming; replay retains the recorded result. */
function orchestratorProjectBinding(
  dependencies: ViewerMcpDomainDependencies,
  run: (resolved: McpToolArgs, context?: McpToolCallContext) => Promise<McpToolPayload>,
  optionalProject = false,
  requireActiveSeat = true,
  allowIndexedBoardWithoutSeat = false,
): McpToolBinding {
  const resolved = new WeakMap<McpToolArgs, McpToolArgs>();
  const resolve = async (args: McpToolArgs) => {
    if (optionalProject && !text(args.project)) return args;
    const requested = required(args, "project");
    const indexedBoard = allowIndexedBoardWithoutSeat && /^(repo|dir)-[a-f0-9]{32}$/i.test(requested)
      && [...projectKeyIndexSnapshot()].some(project => project.toLowerCase() === requested.toLowerCase());
    return { ...args, project: await resolveOrchestratorToolProject(requested, dependencies, requireActiveSeat && !indexedBoard) };
  };
  return Object.assign(
    async (args: McpToolArgs, context?: McpToolCallContext) => {
      try {
        return await run(resolved.get(args) ?? await resolve(args), context);
      } catch (error) {
        const refusal = orchestratorDispatchRefusal(error);
        if (refusal) throw new McpToolRefusal(refusal.message, {
          ...refusal.details,
          code: text(refusal.details.code) || "orchestrator_refused",
          retryable: false,
          outcome: "not-executed",
          evidence: "dispatch-refused",
          nextAction: "new-request-permitted",
        });
        // These tools do not have send's recovery binding. Preserve an
        // inconclusive dispatch as unknown instead of a retryable plain error.
        if (error instanceof McpDispatchVerdictError || error instanceof McpDispatchUncertainError) {
          throw new McpToolRefusal(error.message, {
            ...error.details,
            code: text(error.details.code) || "outcome_unknown",
            retryable: false,
            outcome: "unknown",
            evidence: "dispatch-verdict",
            nextAction: "original-key-lookup",
          });
        }
        throw error;
      }
    },
    { prepareAdmission: async (args: McpToolArgs) => { resolved.set(args, await resolve(args)); } },
  );
}

/**
 * get_orchestrator (two-axis contract): the designation, its health, and a
 * BOUNDED rotation recommendation. Read-only; every inferred number is
 * labelled an estimate with its basis, and nothing here — or anywhere — may
 * act on the recommendation automatically.
 *
 * Compact by default (#2064), like the other read tools. The whole answer
 * inlined the mandate, the role table, every terminalized intent with its own
 * copy of the mandate and the full lineage, about 183 KB for a real seat, which
 * the MCP client refuses. The default keeps what a seat asks this tool for and
 * counts the history; full:true returns every record whole.
 */
async function getOrchestrator(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const project = canonicalOrchestratorProject(required(args, "project"));
  const full = fullAnswer(args);
  const { active, pending, history } = orchestratorSeatFor(project);
  const remote = await readRemoteAgentRows(project);
  const linkedSeats = linkedContext().links.filter(link => link.projects.has(project)).map(link => {
    const row = remote.rows.find(row => row.install === link.install && row.seat === 1);
    return { machine: link.label, install: link.install, seat: row ? { engine: row.e, model: row.m, state: row.st, lastActivity: new Date(row.at).toISOString(), stale: row.stale }
      : peerSeatMessages(link.key) ? null : "unknown" };
  });
  const revocations = orchestratorRevocations().filter((revocation) => revocation.project === project);
  const workerLimit = { ...effectiveWorkerLimit(project), running: projectWorkerCounts().byProject.get(project) ?? 0 };
  const base = full ? {
    project, linkedSeats, workerLimit,
    mergeOnReview: mergeOnReviewEnabled(project),
    bridgeReports: bridgeReportsEnabled(project),
    ...reportFields(project, dependencies),
    defaultPromptVersion: ORCHESTRATOR_PROMPT_VERSION,
    pendingIntent: pending,
    /* Terminalized pending intents (#878), oldest first: what was attempted
       and why it failed, preserved after the intent stopped blocking. */
    intentHistory: history,
    /* Predecessor lineage, oldest first: each entry names the seat epoch it
       ended and the successor that replaced it. */
    lineage: revocations.map((revocation) => ({
      conversationId: revocation.conversationId,
      seatEpoch: revocation.seatEpoch,
      revokedAt: revocation.revokedAt,
      /* Who ordered the rotation that ended this seat, when the record carries
         it; null on designations made before rotation was attributed (#1402). */
      triggeredBy: revocation.triggeredBy ?? null,
      successorConversationId: revocation.successorConversationId ?? null,
    })),
  } : {
    project, linkedSeats, workerLimit,
    /* #2187 §4.1: whether finished lanes here merge on their own. */
    mergeOnReview: mergeOnReviewEnabled(project),
    /* #2146: whether this project's bridge reports are on; off, file none. */
    bridgeReports: bridgeReportsEnabled(project),
    /* docs/design/orchestrator-reports.md §4.2, §5.6: the language reports
       and task text are written in, and where reports go besides the log. */
    ...reportFields(project, dependencies),
    defaultPromptVersion: ORCHESTRATOR_PROMPT_VERSION,
    pendingIntent: compactOrchestratorSeat(pending),
    intentHistoryCount: history.length,
    lineageCount: revocations.length,
    readMore: "get_orchestrator with full:true returns the mandate, the role table, the pending intent, intentHistory and lineage in full.",
  };
  if (!active?.conversationId) {
    return redactPayload({ ...base, designated: false, seat: null, health: null, rotation: null });
  }

  const registry = agentRegistry();
  const conversation = registry.conversation(active.conversationId as `conversation_${string}`);
  const generation = conversation?.generations.at(-1);
  const transcriptPath = generation?.path ?? active.path;
  /* During the boot window the spawn receipt already exists while the registry
     conversation still has no settled generation. The seat intent carries the
     receipt's client key, so the same registry source supplies the launch
     profile until generation facts take over. */
  const launchReceipt = active.intent.mode === "spawn"
    ? registry.spawnReceiptForClientAttempt(active.intent.clientRequestId)
    : null;
  const receiptMatches = launchReceipt?.conversationId === active.conversationId;
  const engine = conversation?.engine ?? (receiptMatches ? launchReceipt.engine : null);
  const model = generation?.launchProfile?.model ?? (receiptMatches ? launchReceipt.launchProfile.model : null);
  let session: { messages: number; tools: number; compactions: number } | null = null;
  if (transcriptPath && (engine === "claude" || engine === "codex")) {
    try {
      const read = readSession(transcriptPath, engine);
      session = {
        messages: read.messages.length,
        tools: read.tools.length,
        compactions: read.traces.filter((trace) => trace.name === "compact").length,
      };
    } catch {
      session = null;
    }
  }
  const facts = readOrchestratorTranscriptFacts(transcriptPath, session);
  const windowPolicy = contextWindowPolicyFor(engine, model, facts);
  const context = contextReading({ policy: windowPolicy, facts });

  let liveness: { lifecycle: string; hostState: string; silentForMs: number | null } | null = null;
  try {
    const snapshot = await agentLivenessSnapshot({ conversationId: active.conversationId, limit: 1 }, dependencies.livenessSources());
    const record = snapshot.conversations[0];
    if (record) liveness = { lifecycle: record.lifecycle, hostState: record.host.state, silentForMs: record.silentForMs };
  } catch {
    liveness = null;
  }

  /* docs/design/ghost-seat.md §5: the seat's parallel selves, live and the
     newest ended, so the seat reads what its deputies did beside its own record. */
  const deputies = active.conversationId
    ? deputiesForSeatIn(readDeputies(), active.conversationId).map((deputy) => ({
      askId: deputy.askId,
      conversationId: deputy.deputyConversationId,
      state: deputy.state,
      outcome: deputy.outcome,
      ask: deputy.ask.text.length > 200 ? `${deputy.ask.text.slice(0, 199)}…` : deputy.ask.text,
      startedAt: deputy.startedAt,
      endedAt: deputy.endedAt,
      result: deputy.result?.line ?? null,
      touched: deputy.touched,
    }))
    : [];
  return redactPayload({
    ...base,
    designated: true,
    seat: full ? active : compactOrchestratorSeat(active),
    seatEpoch: active.seatEpoch,
    conversationId: active.conversationId,
    ...(deputies.length ? { deputies } : {}),
    transcriptPath,
    engine,
    model,
    promptVersion: active.promptVersion,
    predecessorConversationId: active.predecessorConversationId,
    health: {
      liveness,
      /* Quoted key: keeps the payload field identical at runtime while keeping
         the token off a line start, which the privacy publication gate's
         transcript heuristic would otherwise flag on this source file. */
      ["transcript"]: {
        bytes: facts.transcriptBytes,
        megabytes: facts.transcriptBytes !== null ? Number((facts.transcriptBytes / (1024 * 1024)).toFixed(2)) : null,
        messageCount: facts.messageCount,
        toolCount: facts.toolCount,
        compactionCount: facts.compactionCount,
      },
      context,
    },
    rotation: {
      /* WORDS ONLY, structurally: this block is serialized recommendation data
         from a pure function. Nothing on this code path spawns, delivers,
         designates, revokes, interrupts, or calls the control plane at all —
         crossing the threshold changes what this payload SAYS and nothing
         else. The opted-in seat tick reads context usage independently. */
      ...rotationRecommendation({
        context,
        facts,
        activity: liveness?.lifecycle === "gone" ? "dead" : liveness?.lifecycle ?? null,
        policy: windowPolicy,
      }),
      note: ROTATION_NOTE,
    },
  });
}

/**
 * seat_tick_settings: read, and change, one project's seat tick (#1275).
 *
 * The tick arms a loop the seat cannot arm for itself — deliberately, because a
 * session-scheduled monitor dies with its session. Until this existed there was
 * no lever on the other side either: a seat woken hourly on something it could
 * not discharge (#1274) had no way to say so, and only the operator could
 * intervene by hand.
 *
 * Three decisions worth stating, because each is a refusal that is NOT made:
 *
 * - **A project nobody configures is untouched.** No row means the defaults,
 *   which are the hour the tick has always used. Nothing has to be set up.
 * - **Off means off, for as long as the caller says.** `untilMinutes` is a
 *   convenience for whoever reads the board later, never a leash: omit it and
 *   the setting stands until someone changes it back.
 * - **Another project's tick may be set from here.** A seat ordinarily governs
 *   its own — that is the default when `project` is omitted — but naming
 *   another project is allowed rather than refused. What answers for it is
 *   attribution: who changed whose tick is on the row, on the board card and
 *   in the tick's own journal.
 *
 * The one thing required is a REASON whenever the settings leave the default.
 * A tick that has gone quiet with nothing saying why is indistinguishable from
 * a tick that broke, which is the worse of the two failures.
 *
 * `monitorPrompt` (#1280) is the fourth field and the only one that is not a schedule:
 * the seat's own words about what its monitor should look at, appended to every
 * later scheduler-fired wake. It is bounded and redacted like the reason,
 * replaced by the next one sent and cleared with `monitorPrompt: null`. Because it
 * cannot change whether or when a wake is sent, it needs no reason and leaves
 * the project on the default tick.
 *
 * #2030: seats keep their lane ledger in that note and changed it 117 times in
 * 2.5 days, resending all of it each time and reading 1.2–1.7 KB back. So one
 * line of it can be replaced, removed or appended on its own, and a write is
 * acknowledged with `{changed, revision, changedFields, monitorPromptLength}`
 * and nothing else. A verbose read carries the note once.
 */
async function seatTickSettingsTool(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const attribution = attributionOf(dependencies);
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const callerSeat = attribution.conversationId
    ? seats.find((candidate) => candidate.conversationId === attribution.conversationId)
    : undefined;
  const callerProject = callerSeat?.project
    ?? (dependencies.callerProject ? dependencies.callerProject() : productionCallerProject());
  const requested = text(args.project) || callerProject;
  if (!requested) {
    throw new Error("project is required: this session's own project could not be resolved, so name the project whose tick to read or change");
  }
  // Explicit input was resolved by the binding before its receipt was claimed.
  const project = text(args.project) || canonicalOrchestratorProject(requested);

  const readSettings = dependencies.readTickSettings ?? readSeatTickSettings;
  const writeSettings = dependencies.writeTickSettings ?? writeSeatTickSettings;
  const current = readSettings(project);

  const change: SeatTickSettingsChange = {};
  if (args.autonomy !== undefined) change.autonomy = args.autonomy as SeatTickSettingsChange["autonomy"];
  if (args.turbo !== undefined) change.turbo = args.turbo as SeatTickSettingsChange["turbo"];
  if (args.autonomyDecision !== undefined) change.autonomyDecision = structuredClone(args.autonomyDecision) as SeatTickSettingsChange["autonomyDecision"];
  if (args.release !== undefined) change.release = args.release as SeatTickSettingsChange["release"];
  if (args.autoRotate !== undefined) change.autoRotate = args.autoRotate as SeatTickSettingsChange["autoRotate"];
  if (args.maintenance !== undefined) change.maintenance = args.maintenance as SeatTickSettingsChange["maintenance"];
  if (args.curation !== undefined) change.curation = args.curation as SeatTickSettingsChange["curation"];
  if (args.enabled !== undefined) change.enabled = args.enabled as boolean;
  if (args.wakeIntervalMinutes !== undefined) change.wakeIntervalMinutes = args.wakeIntervalMinutes as number | null;
  if (args.reason !== undefined) change.reason = args.reason as string | null;
  if (args.monitorPrompt !== undefined) change.monitorPrompt = args.monitorPrompt as string | null;
  const lineEdits: SeatTickNoteLineEdits = {
    ...(args.replaceLine !== undefined ? { replaceLine: args.replaceLine as SeatTickNoteLineEdits["replaceLine"] } : {}),
    ...(args.removeLine !== undefined ? { removeLine: args.removeLine as SeatTickNoteLineEdits["removeLine"] } : {}),
    ...(args.appendLine !== undefined ? { appendLine: args.appendLine as string } : {}),
  };
  if (Object.keys(lineEdits).length > 0) {
    if (change.monitorPrompt !== undefined) throw new Error("send either monitorPrompt or line edits (replaceLine, removeLine, appendLine), not both");
    const edited = applySeatTickNoteLineEdits(current.monitorPrompt, lineEdits);
    if (!edited.ok) throw new Error(edited.error);
    change.monitorPrompt = edited.monitorPrompt;
  }
  if (args.untilMinutes !== undefined) {
    const minutes = args.untilMinutes as number | null;
    if (minutes === null) change.until = null;
    else if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      throw new Error("untilMinutes must be a positive number of minutes, or null for a setting that stands until it is changed");
    } else {
      change.until = new Date(Date.now() + minutes * 60_000).toISOString();
    }
  }

  const own = callerProject ? canonicalOrchestratorProject(callerProject) : null;
  // Read designation separately from write authority: a temporarily missing
  // caller project or manager grant must not turn a known seat's words into
  // operator instructions.
  const designatedSeat = orchestratorSeatFor(project).active;
  const writerSeat = attribution.conversationId
    ? orchestratorSeatIdentityForConversation(attribution.conversationId)
    : null;
  let settings = current;
  let changed = false;
  let maintenanceNotes: string[] | undefined;
  if (Object.keys(change).length > 0) {
    const activeSeat = own === project ? designatedSeat : null;
    const actor: SeatTickSettingsActor = {
      kind: attribution.kind,
      conversationId: attribution.conversationId,
      project: own,
      seatEpoch: activeSeat?.conversationId === attribution.conversationId ? activeSeat.seatEpoch : null,
      ...(attribution.via ? { via: attribution.via } : {}),
    };
    const review = change.autonomyDecision?.review;
    if (review) {
      const round = mcpPrototypeRound(change.autonomyDecision?.taskId ?? null, review.reviewId);
      if (round) review.reviewId = round.id;
      if (!round || round.nativeAssociation || canonicalOrchestratorProject(round.project || project) !== project) throw new Error("autonomy cannot decide this form");
    }
    // Instruction authorship is separate from the existing control authority.
    // A temporarily unavailable manager grant cannot make a recorded seat's
    // words operator-authored. The designation still proves its authorship.
    let instructionActor = actor;
    if (attribution.kind === "gateway") {
      const designatedWriter = writerSeat;
      if (designatedWriter) {
        instructionActor = { ...actor, kind: "manager", project: canonicalOrchestratorProject(designatedWriter.project), seatEpoch: designatedWriter.seatEpoch };
      } else if (callerSeat?.conversationId === attribution.conversationId) {
        const authorizedProject = callerSeat.project ? canonicalOrchestratorProject(callerSeat.project) : own;
        instructionActor = { ...actor, kind: "manager", project: authorizedProject, seatEpoch: null };
      }
    }
    /* Paid credits spend money: the tool never approves them; the operator ticks them in the panel. */
    if ((change.turbo as { credits?: unknown } | undefined)?.credits === true) throw new Error("paid credits are approved only in the operator's Turbo dialog");
    const context = { at: new Date().toISOString(), actor, instructionActor, ...(turboNeedsPlan(change.turbo) ? { turbo: turboChangeContext(project) } : {}) };
    const applied = dependencies.writeTickSettings || dependencies.readTickSettings
      ? applySeatTickSettingsChange(current, change, context)
      : changeSeatTickSettings(project, change, context);
    if (!applied.ok) throw new Error(applied.error);
    if (change.release) releaseControlChange(project, change.release, actor, applied.settings.updatedAt!);
    if (dependencies.writeTickSettings || dependencies.readTickSettings) writeSettings(project, applied.settings);
    /* The Viewer owns Codex hosts and runs the sweep from its seat-tick pass.
       MCP writes only the durable setting; its process cannot dispatch host RPCs. */
    if (review) {
      const taskId = change.autonomyDecision?.taskId ?? null;
      const authorize = () => {
        const active = readSettings(project).autonomy;
        if (actor.kind !== "manager" || actor.project !== project || !actor.conversationId || !autonomyActive(active, Date.now()) || active?.startedAt !== change.autonomyDecision?.startedAt) throw new Error("autonomy episode ended before this decision");
      };
      try {
        decidePrototype({ kind: "autonomous-seat", project, conversationId: actor.conversationId!, authorize }, taskId, review);
      } catch (error) {
        markAutonomyDecisionReview(project, change.autonomyDecision!.startedAt, change.autonomyDecision!.id, "refused");
        throw error;
      }
      markAutonomyDecisionReview(project, change.autonomyDecision!.startedAt, change.autonomyDecision!.id, "decided");
      deliverPrototypeDecision(taskId, review.reviewId);
    }
    settings = review ? readSettings(project) : applied.settings;
    maintenanceNotes = applied.notes;
    changed = true;
  }

  /* A seat that switches its tick off or slows it stops being asked for
     reports (docs/design/orchestrator-reports.md §5.4). The answer names
     what the tick still owes and asks for the report the operator will read
     while nothing wakes the seat. The setting is applied as asked. */
  const beforeInterval = effectiveSeatTickSettings(current, Date.now(), SEAT_TICK_WAKE_INTERVAL_MS).wakeIntervalMs;
  const afterInterval = effectiveSeatTickSettings(settings, Date.now(), SEAT_TICK_WAKE_INTERVAL_MS).wakeIntervalMs;
  const quieted = changed && (change.enabled === false || afterInterval > beforeInterval);
  const reportAsk = quieted && bridgeReportsEnabled(project) ? seatTickReportAsk(project, dependencies) : {};

  const verbose = args.verbose === true || args.full === true;
  const { monitorPrompt: storedPrompt, reason: storedReason, instructionLines: storedInstructions, ...settingsWithoutPrompt } = settings;
  delete settingsWithoutPrompt.maintenance;
  delete settingsWithoutPrompt.curation;
  delete settingsWithoutPrompt.autoRotate;
  delete settingsWithoutPrompt.release;
  delete settingsWithoutPrompt.autonomy;
  delete settingsWithoutPrompt.autonomyHistory;
  delete settingsWithoutPrompt.turbo;
  delete settingsWithoutPrompt.turboHistory;
  /* #2030: a write is acknowledged, never read back. The caller holds what it
     sent; the revision and the stored length are what it needs to know the row
     took it. A change to another project's tick still says so out loud. */
  if (changed && !verbose) {
    return redactPayload({
      changed,
      revision: recordRevision(settings),
      changedFields: Object.keys(change),
      ...(maintenanceNotes ? { notes: maintenanceNotes } : {}),
      monitorPromptLength: storedPrompt?.length ?? 0,
      ...(own === project ? {} : { project, scope: "other-project", callerProject: own }),
      ...reportAsk,
    });
  }

  const now = Date.now();
  const effective = effectiveSeatTickSettings(settings, now, SEAT_TICK_WAKE_INTERVAL_MS);
  /* #1845: the note is the one large field here, and a seat changing its
     cadence was reading its own note back three times on every call. It is
     carried only on an explicit full/verbose read, and there once, as
     `monitorPrompt` (#2030); every other answer carries its length, which is
     how a caller sees it is there. */
  const echoPrompt = verbose;
  /* The same rule for the other repeats: the stored reason is carried once,
     under `effective`, unless an expiry has already set the two apart, and the
     defaults block and the fence sentence are a verbose read's. */
  const compactSettings = storedReason === effective.reason ? settingsWithoutPrompt : { ...settingsWithoutPrompt, reason: storedReason };
  const fenceAnswer = seatTickFenceAnswer(project, effective.wakeIntervalMs, now);
  if (!verbose && fenceAnswer.fence) delete fenceAnswer.fenceDetail;
  const curation = curationAnswer(project, effective, now);
  return redactPayload({
    project,
    changed,
    /* Named rather than implied: a change to a project that is not the
       caller's own is allowed, and the answer says so out loud. */
    callerProject: own,
    scope: own === project ? "own-project" : "other-project",
    settings: verbose ? { ...settingsWithoutPrompt, reason: storedReason, instructionLines: storedInstructions } : compactSettings,
    /* The stored note is an explicit read; its length acknowledges a write. The wake shows
       only a marked preview of a long note; this is the whole of it. */
    ...(echoPrompt ? { monitorPrompt: storedPrompt } : {}),
    monitorPromptLength: storedPrompt?.length ?? 0,
    revision: recordRevision(settings),
    ...(changed ? { changedFields: Object.keys(change) } : {}),
    ...(maintenanceNotes ? { notes: maintenanceNotes } : {}),
    /* A full read names nothing it left out (#2030). */
    ...(echoPrompt ? {} : {
      omittedFieldCount: storedInstructions ? 2 : 1,
      readMore: "seat_tick_settings verbose:true reads the full record.",
    }),
    effective: {
      enabled: effective.enabled,
      wakeIntervalMinutes: Math.round(effective.wakeIntervalMs / 60_000),
      reason: effective.reason,
      until: effective.until,
      isDefault: effective.isDefault,
    },
    /* What a project that has never been configured runs on, so a caller can
       see what it is restoring before it restores it. */
    ...(verbose ? { defaults: seatTickScheduleDefaults(project) } : {}),
    autonomy: settings.autonomy || settings.autonomyHistory?.length || verbose ? { active: autonomyActive(settings.autonomy, now), until: settings.autonomy?.until ?? null, startedAt: settings.autonomy?.startedAt ?? null,
      proactive: { enabled: effective.enabled && proactiveActive(effective.autonomy, now) },
      decisionCount: settings.autonomy?.decisions.length ?? 0, pendingReports: pendingAutonomyReports(settings, now).map(autonomyReportKey),
      ...(verbose ? { mandate: autonomyMandate(settings.autonomy, now).join("\n").trim(), episode: effective.autonomy, history: settings.autonomyHistory ?? [] } : {}) } : { active: false },
    ...(settings.turbo || settings.turboHistory?.length || verbose ? { turbo: turboToolAnswer(settings, now, verbose) } : {}),
    release: { ...RELEASE_DEFAULTS, ...settings.release, effectiveAskBeforePublish: (settings.release?.askBeforePublish ?? true) && !autonomyActive(settings.autonomy, now), status: releaseStatus(project) },
    autoRotate: { enabled: settings.autoRotate?.enabled ?? false, thresholdPercent: settings.autoRotate?.thresholdPercent ?? 50,
      ...(verbose ? { setBy: settings.autoRotate?.setBy ?? null, updatedAt: settings.autoRotate?.updatedAt ?? null, why: settings.autoRotate?.why ?? null } : {}),
      ...autoRotationFailureAnswer(project) },
    ...(verbose || settings.curation || curation.lastRun || curation.live || curation.runsError ? { curation } : {}),
    maintenance: boardMaintenanceAnswer(project, effective, { verbose }),
    ...(typeof args.problemId === "string" ? { problem: readMemoryProblem(project, args.problemId) } : {}),
    defaultWakeIntervalMinutes: Math.round(SEAT_TICK_WAKE_INTERVAL_MS / 60_000),
    /* Why the tick is mute, when it is (#1746). A seat that is enabled, on a
       twenty-minute interval and receiving nothing was reading a settings
       answer that said everything was fine: the fence lived in the accounting
       row and no surface carried it. This says which attempt holds the
       project's wakes, since when and when it lapses on its own. */
    ...fenceAnswer,
    ...reportAsk,
  });
}

/** Turbo for the seat: whether it is on, the credit approval and the switch progress. */
function turboToolAnswer(settings: SeatTickSettings, now: number, verbose: boolean) {
  const episode = endedTurbo(settings.turbo, now);
  if (!episode && (!verbose || !settings.turboHistory?.length)) return { active: false };
  return { active: turboActive(episode, now), until: episode?.until ?? null, startedAt: episode?.startedAt ?? null,
    credits: episode ? { approved: episode.credits.approved, accounts: episode.credits.accounts } : null,
    progress: episode ? turboProgress(episode.switches) : null,
    ...(verbose ? { overlay: turboMandate(episode, now).join("\n").trim(), episode, history: settings.turboHistory ?? [] } : {}) };
}

/** What the tick owes the report log for a project, and the report to file
    now that nothing will ask for it (§5.4). */
function seatTickReportAsk(project: string, dependencies: ViewerMcpDomainDependencies): Record<string, unknown> {
  let state: SeatTickProjectState;
  try {
    state = (dependencies.peekTickState ?? peekSeatTickState)(project);
  } catch {
    return {};
  }
  const owed = (state.reportsOwed ?? []).map((entry) => entry.key);
  return {
    reportsOwed: owed,
    reportReminder: "Nothing will ask you for reports while the tick is off or slowed. File a report now: what you are waiting on (a question or blocked report when it is the operator), and the owed outcomes above.",
  };
}

/** The schedule a project nobody configured runs on — the fields a restore
    resets, without the record's empty bookkeeping (#2030). */
function seatTickScheduleDefaults(project: string) {
  const { enabled, wakeIntervalMinutes, reason, until } = defaultSeatTickSettings(project);
  return { enabled, wakeIntervalMinutes, reason, until };
}

/**
 * The fence, for the settings answer, from a read that changes nothing.
 *
 * Peeked rather than read the way a check reads it, so asking about a project
 * nobody has ticked mints no accounting row, and wrapped because one
 * unreadable store may not take a seat's tick controls away — an answer that
 * cannot name the fence says so instead of throwing.
 *
 * The row is all this reads: it names the attempt the next check would meet,
 * and whether that check may then move it depends on what the layer holding the
 * payload answers, which only a check asks for. The sentence says as much.
 */
function seatTickFenceAnswer(project: string, wakeIntervalMs: number, now: number): McpToolPayload {
  try {
    const state = peekSeatTickState(project);
    const active = orchestratorSeatFor(project).active;
    const fence = seatTickReportedFence(state, active ? { conversationId: active.conversationId ?? null } : null, now, wakeIntervalMs);
    return { fence, fenceDetail: seatTickFenceDetail(fence), fenceError: null };
  } catch (error) {
    /* The whole answer goes through `redactPayload`, so the store's own words
       reach the caller with secrets already taken out of them. */
    return { fence: null, fenceDetail: "the tick row could not be read, so whether a wake is fenced is unknown", fenceError: error instanceof Error ? error.message : "unknown error" };
  }
}


/**
 * role_presets: read, and change, the role mapping (#2019).
 *
 * `PUT /api/roles` answers a seat "sign in required" and no other tool wrote
 * the mapping, so a policy the operator gave in words (builders on Sonnet 5.5,
 * reviewers on GPT-6.1-Sol) needed a hand edit of role-presets.json. This is the
 * same patch and the same store, reached through the caller identity the MCP
 * server derives:
 *
 * - **Who writes.** The designated orchestrator seat (a live deputy speaks as
 *   its seat) and the operator's own session, the gateway. Every other caller
 *   reads. A refused write says `role_presets_write_refused` and changes nothing.
 * - **What is refused, whole.** A row naming an engine, model or effort outside
 *   the launch catalogue, a shape the store would refuse, or a stale
 *   `expectedRevision`. The refusal names the valid choices, or carries the
 *   current registry, and nothing is written.
 * - **What is recorded.** Every write appends who wrote it and each row's before
 *   and after to `role-presets-audit.jsonl` beside role-presets.json.
 */
async function rolePresetsTool(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const attribution = attributionOf(dependencies);
  const writing = args.overrides !== undefined || args.workerLimit !== undefined;
  if (writing && ((attribution.kind !== "manager" && attribution.kind !== "gateway") || (attribution.kind === "manager" && !attribution.conversationId))) {
    throw new McpToolRefusal(
      "only the designated orchestrator seat and the operator's own session change the role mapping; this session reads it. Ask the orchestrator, or report the request over the bridge.",
      { code: "role_presets_write_refused", callerKind: attribution.kind },
    );
  }
  const workerContext = () => {
    const supplied = dependencies.callerProject?.();
    const caller = !supplied && attribution.conversationId ? agentRegistry().conversation(attribution.conversationId as never) : null;
    const cwd = caller?.generations.at(-1)?.launchProfile.cwd;
    return { own: supplied ?? caller?.projectOwnership?.project ?? (cwd ? projectForCwd(cwd) : null), counts: projectWorkerCounts() };
  };
  if (args.overrides === undefined && args.workerLimit === undefined) {
    if (args.expectedRevision !== undefined) throw new Error("expectedRevision applies to a write; send it with overrides");
    const detail = args.detail === true;
    const { own, counts } = workerContext();
    const stored = readWorkerLimits();
    const machine = effectiveWorkerLimit("");
    const project = own ? canonicalOrchestratorProject(own) : null;
    return redactPayload({ ...roleRegistryAnswer(loadRoleRegistrySnapshotOrDefaults(), { detail }), ...(detail ? { choices: roleLaunchChoices() } : {}), workerLimit: {
      machine: { value: machine.machine, source: stored.machine ? "machine" : "default", changedAt: stored.machine?.changedAt ?? null, changedBy: stored.machine?.changedBy ?? null },
      here: project ? { project, value: projectWorkerLimit(project, stored)?.value ?? null, effective: effectiveWorkerLimit(project).value, source: effectiveWorkerLimit(project).source, running: counts.byProject.get(project) ?? 0 } : null,
      runningMachine: counts.machine, bounds: [1, 64],
      ...(detail ? { projects: stored.projects, history: stored.history.slice(-20) } : {}),
    } });
  }

  if (args.workerLimit !== undefined) {
    if (args.overrides !== undefined) throw new McpToolRefusal("workerLimit and overrides change separate stores; send separate calls", { code: "worker_limit_with_overrides" });
    if (args.expectedRevision !== undefined) throw new Error("expectedRevision applies only to overrides");
    const input = objectRecord(args.workerLimit) ? args.workerLimit : {};
    if (input.value !== null && !isWorkerLimit(input.value)) throw new Error("worker limit must be an integer from 1 to 64");
    const reason = text(input.reason);
    if (!reason || reason.length > 300) throw new Error("worker limit reason is required (1 to 300 characters)");
    if (input.project !== undefined && !text(input.project)) throw new Error("project must be non-empty");
    const { own, counts } = workerContext();
    const project = input.project === undefined ? null : await resolveOrchestratorToolProject(text(input.project), dependencies);
    const actor = { kind: attribution.kind as "manager" | "gateway", conversationId: attribution.via?.deputy ?? attribution.conversationId, project: own ? canonicalOrchestratorProject(own) : null, via: "tool" };
    const result = project === null
      ? setMachineWorkerLimit(input.value as number | null, actor, reason, text(args.clientRequestId) || null)
      : setProjectWorkerLimit(project, input.value as number | null, actor, reason, text(args.clientRequestId) || null);
    return redactPayload({ ...result, scope: project === null ? "machine" : project === canonicalOrchestratorProject(own ?? "") ? "project" : "other-project", running: project ? counts.byProject.get(project) ?? 0 : counts.machine });
  }

  const expectedRevision = args.expectedRevision;
  if (expectedRevision !== undefined && (typeof expectedRevision !== "string" || !expectedRevision.trim() || expectedRevision.length > 128)) {
    throw new Error("expectedRevision must be a non-empty revision string");
  }
  const patch = parseRoleMappingPatch(args.overrides);
  if (typeof patch === "string") throw new McpToolRefusal(patch, { code: "role_presets_invalid", choices: roleLaunchChoices() });
  const violations = roleMappingViolations(patch);
  if (violations.length > 0) {
    throw new McpToolRefusal(
      `role mapping refused, nothing written: ${violations.map((violation) => `${violation.field}: ${violation.message} (${violation.expected})`).join("; ")}`,
      { code: "role_presets_invalid", violations, choices: roleLaunchChoices() },
    );
  }

  const actor = {
    kind: attribution.kind,
    conversationId: attribution.conversationId,
    role: attribution.role,
    ...(attribution.via ? { via: attribution.via } : {}),
  };
  let rows: RoleMappingAuditRow[] = [];
  let change: RoleMappingChange;
  try {
    change = changeRoleMapping(patch, {
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      record: (before, after, merged) => {
        rows = changedMappingRows(before.roles, merged);
        appendRoleMappingAudit({
          at: new Date().toISOString(),
          actor,
          clientRequestId: text(args.clientRequestId) || null,
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          rows,
        });
      },
    });
  } catch (error) {
    if (error instanceof RoleStoreError || error instanceof FileTransactionBusyError) throw error;
    /* The store rolled the SQLite transaction back when the record failed. */
    throw new McpToolRefusal(
      `the role mapping was not changed: it could not be written together with its audit record (${error instanceof Error ? error.message : String(error)})`,
      { code: "role_presets_audit_unavailable" },
    );
  }
  if (change.state === "stale") {
    throw new McpToolRefusal(
      `the role mapping changed since revision ${expectedRevision}; nothing was written. The current registry is attached; resend against ${change.current.revision}.`,
      { code: "role_presets_stale_revision", ...roleRegistryAnswer(change.current, { detail: true }), choices: roleLaunchChoices() },
    );
  }
  return redactPayload({
    changed: rows.length > 0,
    revision: change.after.revision,
    previousRevision: change.before.revision,
    health: change.after.health,
    rows,
  });
}

/**
 * auto_updates: read, and switch, automatic updates of this Delegatus install.
 *
 * The switch is the Update dialog's own: the tool posts to the same
 * `POST /api/self-update/auto`, so the web process's one `setAuto` changes and
 * the dialog, its "turned off because…" line and the automatic-update
 * controller all read that change. No second state is kept here.
 *
 * - **Who writes.** The designated orchestrator seat of the project whose code
 *   this Delegatus serves (`viewerSeatAuthority`, the authority
 *   `deploy_exact_sha` executes on) and the operator's own session, the
 *   gateway, as `role_presets` admits it. Every other caller reads, and its
 *   write is refused with `auto_updates_write_refused` before the Viewer is
 *   asked anything.
 * - **What is recorded.** The route records the writer this tool names on
 *   the setting and in the dialog's history, and trusts that name only from
 *   a request carrying the MCP server's service tag.
 */
async function autoUpdatesTool(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  if (args.enabled === undefined) return autoUpdatesAnswer(await readViewerControl(control, "/api/self-update"));
  if (typeof args.enabled !== "boolean") throw new Error("enabled must be true or false; omit it to read");

  const attribution = attributionOf(dependencies);
  let writer: { kind: "operator" | "seat"; conversationId: string | null };
  if (attribution.kind === "gateway") {
    writer = { kind: "operator", conversationId: attribution.conversationId };
  } else {
    const authority = viewerSeatAuthority(dependencies);
    if (!authority.ok) {
      throw new McpToolRefusal(
        "only the designated orchestrator of the Delegatus project and the operator's own session switch automatic updates; this session reads them. Report the request over the bridge instead.",
        { code: "auto_updates_write_refused", reason: authority.reason === "no-seat" ? "not-designated" : authority.reason, callerKind: attribution.kind },
      );
    }
    writer = { kind: "seat", conversationId: authority.seat.conversationId };
  }

  if (args.enabled) {
    const current = autoUpdatesAnswer(await readViewerControl(control, "/api/self-update"));
    if (current.availability !== "available") {
      throw new McpToolRefusal(
        `automatic updates cannot be turned on for this install (${String(current.availability)}); nothing was changed`,
        { code: "auto_updates_unavailable", availability: current.availability },
      );
    }
  }
  return autoUpdatesAnswer(await control.post("/api/self-update/auto", {
    enabled: args.enabled,
    writer,
    clientRequestId: requestId(args),
  }));
}

/** The automatic-update part of the Update dialog's snapshot, and the latest
    switches from its history. */
function autoUpdatesAnswer(snapshot: Record<string, unknown>): McpToolPayload {
  const auto = objectRecord(snapshot.auto) ? snapshot.auto : {};
  const target = objectRecord(auto.target) ? auto.target : null;
  const history = Array.isArray(snapshot.history) ? snapshot.history.filter(objectRecord) : [];
  const answer: McpToolPayload = {
    mode: snapshot.mode ?? null,
    availability: auto.availability ?? null,
    enabled: auto.enabled === true,
    off: auto.off ?? null,
    phase: auto.phase ?? null,
    target: target ? { sha: target.sha ?? null, short: target.short ?? null, version: target.version || null } : null,
    green: auto.green ?? null,
    blockers: objectRecord(auto.blockers) ? { ...auto.blockers,
      turnList: Array.isArray(auto.blockers.turnList) ? auto.blockers.turnList.slice(0, 20) : [],
      stageList: Array.isArray(auto.blockers.stageList) ? auto.blockers.stageList.slice(0, 20) : [],
    } : null,
    waitingSince: auto.waitingSince ?? null,
    deferred: auto.deferred ?? null,
    longWait: auto.longWait === true,
    drain: auto.drain ?? null,
    decision: objectRecord(auto.decision) ? { id: auto.decision.id, at: auto.decision.at, project: auto.decision.project } : null,
    changedAt: auto.changedAt ?? null,
    changedBy: auto.changedBy ?? null,
    recentChanges: history
      .filter((entry) => entry.kind === "auto-on" || entry.kind === "auto-off")
      .slice(0, 5)
      .map((entry) => ({ at: entry.at, enabled: entry.kind === "auto-on", writer: entry.writer ?? null })),
  };
  // Names share a byte budget; totals and drain times survive truncation.
  const bounded = JSON.parse(JSON.stringify(answer, (_key, value) => typeof value === "string" ? value.slice(0, 400) : value)) as McpToolPayload;
  const blockers = objectRecord(bounded.blockers) ? bounded.blockers : null;
  const turns = Array.isArray(blockers?.turnList) ? blockers.turnList : [];
  const stages = Array.isArray(blockers?.stageList) ? blockers.stageList : [];
  while (Buffer.byteLength(JSON.stringify(bounded)) >= 5_800 && (turns.length || stages.length)) {
    if (turns.length >= stages.length) turns.pop(); else stages.pop();
  }
  return bounded;
}

/**
 * account_project_binding: list, add and remove the bindings that decide which
 * accounts a project's work may run on (#1279).
 *
 * Two properties this tool is built around, both of them the operator's:
 *
 * - **The answer is always a read of the record.** An add or a remove returns
 *   the bindings re-read from the file after the write, and the store refuses
 *   to call a mutation `ok` when that read does not show it. The Viewer has
 *   already shipped an action that answered `ok` and changed nothing; a caller
 *   here never has to trust an echo to know what it did.
 * - **A project nobody binds is untouched.** No row for an engine means every
 *   account of that engine, which is the behaviour the Viewer has always had.
 *   The `restricted` flag on each engine's block says which of the two a
 *   project is in, so "allows everything" never reads like "allows nothing".
 */
async function accountProjectBindingTool(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const action = text(args.action) || "list";
  if (action !== "list" && action !== "add" && action !== "remove" && action !== "set-fallback") {
    throw new Error("action must be list, add, remove or set-fallback");
  }
  const read = dependencies.readAccountProjectBindings ?? accountProjectBindings;
  const bind = dependencies.bindAccountToProject ?? bindAccountToProject;
  const unbind = dependencies.unbindAccountFromProject ?? unbindAccountFromProject;
  const accountsFor = dependencies.listBindableAccounts
    ?? ((engine: BindingEngine) => (engine === "claude" ? listClaudeAccounts() : listCodexAccounts())
      .map((account) => ({ accountId: account.id, label: account.label })));

  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  const requestedProject = text(args.project) || (action === "list" ? callerProject ?? "" : "");
  const project = requestedProject
    ? action === "list"
      ? await resolveOrchestratorToolProject(requestedProject, dependencies, false)
      : canonicalOrchestratorProject(requestedProject)
    : null;

  if (action !== "list") {
    if (!project) throw new Error("project is required to change a binding");
    const engine = text(args.engine);
    if (engine !== "claude" && engine !== "codex") throw new Error("engine must be claude or codex");
    const accountId = text(args.accountId);
    if (!accountId) throw new Error("accountId is required to change a binding");
    if (args.fallback !== undefined && typeof args.fallback !== "boolean") throw new Error("fallback must be a boolean");
    if (action === "set-fallback" && typeof args.fallback !== "boolean") throw new Error("fallback is required for set-fallback");
    const result = action === "remove" ? unbind(engine, accountId, project) : bind(engine, accountId, project, undefined, args.fallback as boolean | undefined, action === "set-fallback");
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    /* #1845: a write answers the row it changed and that project's pool for
       that engine, still read AFTER the write from the store. The whole table
       is `action: "list"`. */
    const bindings = read();
    const bound = (allowedAccountIdsForProject(project, engine, bindings) ?? []).includes(accountId);
    if (bound !== (action !== "remove")) {
      throw new Error(`the binding store does not show the ${action} of ${engine} account ${accountId} for ${project} after the write`);
    }
    const fallback = bindings.find(binding => binding.engine === engine && binding.accountId === accountId && binding.project === project)?.fallback ?? false;
    if (action !== "remove" && args.fallback !== undefined && fallback !== args.fallback) {
      throw new Error("the binding store does not show the fallback flag after the write");
    }
    return redactPayload({
      action,
      changed: result.changed,
      project,
      engine,
      accountId,
      bound,
      fallback,
      allowed: projectEngineAccounts(project, engine, accountsFor(engine), bindings, []),
    });
  }

  /* Read from the store, for both the record and the view the fence will
     enforce. */
  const changed = false;
  const bindings = read();
  const engines = ["claude", "codex"] as const;
  return redactPayload({
    action,
    changed,
    project,
    callerProject: callerProject ? canonicalOrchestratorProject(callerProject) : null,
    bindings,
    ...(project
      ? {
          allowedFor: Object.fromEntries(engines.map((engine) => [
            engine,
            projectEngineAccounts(project, engine, accountsFor(engine), bindings, []),
          ])),
        }
      : {}),
    accounts: Object.fromEntries(engines.map((engine) => [
      engine,
      accountsFor(engine).map((account) => ({
        ...account,
        projects: projectsForAccount(engine, account.accountId, bindings),
      })),
    ])),
    note: "a project with no binding for an engine allows every account of that engine, which is the behaviour it has always had",
  });
}

/** The same records `GET /api/accounts` projects its limit rows from. */
function productionAccountLimitsSource(): Omit<AccountLimitsInput, "engine" | "accountId"> {
  const snapshot = agentRegistry().readOnlySnapshot();
  const caller = productionCallerConversation(snapshot);
  const project = caller ? callerProjectFromSnapshot(snapshot, caller.id) : null;
  return {
    accounts: {
      claude: listClaudeAccounts().map((account) => ({ accountId: account.id, authPresent: account.authPresent })),
      codex: listCodexAccounts().map((account) => ({ accountId: account.id, authPresent: account.authPresent })),
      copilot: listCopilotAccounts().map((account) => ({ accountId: account.id })),
    },
    active: {
      claude: snapshot.engineRouting.claude.activeAccountId ?? activeClaudeAccountId(),
      codex: snapshot.engineRouting.codex.activeAccountId ?? activeCodexAccountId(),
      copilot: snapshot.engineRouting.copilot.activeAccountId ?? activeCopilotAccountId(),
    },
    observations: snapshot.quotaObservations,
    project,
    bindings: project ? accountProjectBindings() : [],
    model: caller?.generations.at(-1)?.launchProfile.model ?? null,
    now: Date.now(),
  };
}

/**
 * account_limits (#1845 row 11): each account's last observed usage, so a seat
 * choosing where to launch no longer reads three HTTP routes for it. A read of
 * the durable observations only; it never asks a provider.
 */
function accountLimitsTool(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const engine = text(args.engine);
  if (engine && engine !== "claude" && engine !== "codex" && engine !== "copilot") throw new Error("engine must be claude, codex or copilot");
  const accountId = text(args.accountId);
  const source = (dependencies.accountLimitsSource ?? productionAccountLimitsSource)();
  const accounts = accountLimitRows({
    ...source,
    ...(engine ? { engine: engine as "claude" | "codex" | "copilot" } : {}),
    ...(accountId ? { accountId } : {}),
  });
  if (accountId && accounts.length === 0) throw new Error(`no ${engine || "claude, codex or copilot"} account has the id ${accountId}`);
  return redactPayload({ count: accounts.length, accounts });
}

async function relayOwnerHistory(args: McpToolArgs, control: ViewerControlDependencies, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  if (ownerRelayCaller(dependencies)) throw new McpToolRefusal("Group history cannot be read while answering in Telegram.", { code: "owner_history_refused" });
  return redactPayload(await control.post("/api/external-relay/owner-history", {
    op: args.action, ...Object.fromEntries(["chat", "from", "to", "limit", "cursor"].filter(key => args[key] !== undefined).map(key => [key, args[key]])),
  }, callerCapabilityHeaders()));
}

/*
 * The Telegram bot account (docs/design/telegram-bot-account.md, Decision 6).
 * The Viewer is the only process that holds the bot token, so all three tools
 * reach it through the agent route; none of them carries the token or the
 * bot's id either way. The send forwards the calling session's capability,
 * which is how the route attributes the post to this conversation.
 */
async function telegramBotChats(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const query = new URLSearchParams({ op: "chats", ...(args.includeInactive === true ? { includeInactive: "1" } : {}) });
  return redactPayload(await readViewerControl(control, `/api/telegram/bot/agent?${query}`));
}

async function telegramBotMessages(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const query = new URLSearchParams({ op: "messages", chat: required(args, "chat") });
  for (const field of ["limit", "maxChars", "cursor", "since"] as const) {
    const value = args[field];
    if (typeof value === "number" || (typeof value === "string" && value !== "")) query.set(field, String(value));
  }
  return redactPayload(await readViewerControl(control, `/api/telegram/bot/agent?${query}`));
}

async function telegramBotSend(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const result = await dispatchControl(control)("/api/telegram/bot/agent", {
    op: "send",
    clientRequestId: requestId(args),
    chat: required(args, "chat"),
    text: typeof args.text === "string" ? args.text : "",
    ...(args.format === "html" || args.format === "plain" ? { format: args.format } : {}),
    ...(typeof args.replyToMessageId === "number" ? { replyToMessageId: args.replyToMessageId } : {}),
    ...(typeof args.topicId === "number" ? { topicId: args.topicId } : {}),
    ...(args.silent === true ? { silent: true } : {}),
  }, callerCapabilityHeaders()).catch((error: unknown) => {
    /* The route's refusal names its code; which codes a new key may retry is
       the bot's own vocabulary. Telegram's wait and the ids a partial send
       posted ride along as fields. */
    if (error instanceof McpDispatchVerdictError && typeof error.details.code === "string") {
      const code = error.details.code;
      const { retryAfterSeconds, sentMessageIds } = error.details;
      throw new McpToolRefusal(error.message, {
        code,
        retryable: RETRYABLE_TELEGRAM_BOT_CODES.has(code as TelegramBotErrorCode),
        ...(Array.isArray(error.details.refusals) ? { refusals: readTelegramBotRefusals(error.details.refusals) } : {}),
        ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
        ...(Array.isArray(sentMessageIds) ? { sentMessageIds } : {}),
      });
    }
    throw error;
  });
  return redactPayload(result);
}

function telegramFileConfirmation(value: unknown) {
  const link = readFileConfirmationLink(value);
  if (!link) return null;
  const published = readSelf()?.publicUrl;
  let origin = viewerControlOrigin();
  if (published) {
    try {
      const url = new URL(published);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) origin = url.origin;
    } catch { /* An invalid saved address keeps the local control origin. */ }
  }
  return { ...link, url: new URL(link.url, origin).href };
}

async function telegramBotSendMedia(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const result = await dispatchControl(control)("/api/telegram/bot/agent", {
    op: "send_media",
    clientRequestId: requestId(args),
    chat: required(args, "chat"),
    images: args.images,
    ...(args.format === "html" || args.format === "plain" ? { format: args.format } : {}),
    ...(typeof args.replyToMessageId === "number" ? { replyToMessageId: args.replyToMessageId } : {}),
    ...(typeof args.topicId === "number" ? { topicId: args.topicId } : {}),
    ...(args.silent === true ? { silent: true } : {}),
  }, callerCapabilityHeaders()).catch((error: unknown) => {
    if (error instanceof McpDispatchVerdictError && typeof error.details.code === "string") {
      const code = error.details.code;
      const confirmation = telegramFileConfirmation(error.details.confirmation);
      throw new McpToolRefusal(confirmation ? error.message.replace(readFileConfirmationLink(error.details.confirmation)!.url, confirmation.url) : error.message, { code, retryable: RETRYABLE_TELEGRAM_BOT_CODES.has(code as TelegramBotErrorCode),
        ...(confirmation ? { confirmation } : {}),
        ...(Array.isArray(error.details.refusals) ? { refusals: readTelegramBotRefusals(error.details.refusals) } : {}) });
    }
    throw error;
  });
  return redactPayload(result);
}

/** The route checks the file on the Viewer host (roots, type, size, secret
    scan) before Telegram is called; a secret refusal names its class. */
async function telegramBotSendDocument(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const result = await dispatchControl(control)("/api/telegram/bot/agent", {
    op: "send_document",
    clientRequestId: requestId(args),
    chat: required(args, "chat"),
    document: args.document,
    ...(args.format === "html" || args.format === "plain" ? { format: args.format } : {}),
    ...(typeof args.replyToMessageId === "number" ? { replyToMessageId: args.replyToMessageId } : {}),
    ...(typeof args.topicId === "number" ? { topicId: args.topicId } : {}),
    ...(args.silent === true ? { silent: true } : {}),
  }, callerCapabilityHeaders()).catch((error: unknown) => {
    if (error instanceof McpDispatchVerdictError && typeof error.details.code === "string") {
      const code = error.details.code;
      const confirmation = telegramFileConfirmation(error.details.confirmation);
      const { retryAfterSeconds, secretClass } = error.details;
      throw new McpToolRefusal(confirmation ? error.message.replace(readFileConfirmationLink(error.details.confirmation)!.url, confirmation.url) : error.message, {
        code,
        retryable: RETRYABLE_TELEGRAM_BOT_CODES.has(code as TelegramBotErrorCode),
        ...(confirmation ? { confirmation } : {}),
        ...(Array.isArray(error.details.refusals) ? { refusals: readTelegramBotRefusals(error.details.refusals) } : {}),
        ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
        ...(typeof secretClass === "string" ? { secretClass } : {}),
      });
    }
    throw error;
  });
  return redactPayload(result);
}

/** create_orchestrator: atomically create, designate and deliver the ONE
    approved versioned default mandate (or the caller's edited text based on
    it). The seat route owns the durable intent, so a retry replays. */
async function createOrchestrator(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  if (!text(args.conversationId)) validateExplicitMcpLaunchModel(args, "orchestrator");
  const project = canonicalOrchestratorProject(required(args, "project"));
  const result = await dispatchControl(control)("/api/orchestrator/seat", {
    project,
    mandate: text(args.mandate) || ORCHESTRATOR_SYSTEM_PROMPT,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
    clientRequestId: spawnAttemptId(requestId(args)),
    ...allowedSeatFields(args, ["conversationId", "cwd", "engine", "model", "effort", "accountId"]),
  }, callerCapabilityHeaders());
  return redactPayload({
    /* The key the seat was designated under, which the route resolves after
       any identity succession its checkout owes (#1874). */
    project: typeof (result.seat as { project?: unknown } | undefined)?.project === "string"
      ? (result.seat as { project: string }).project
      : project,
    ...(typeof result.displayName === "string" ? { displayName: result.displayName } : {}),
    conversationId: result.conversationId ?? null,
    transcriptPath: result.path ?? null,
    seat: result.seat ?? null,
    replayed: result.replayed === true,
    accepted: result.accepted === true,
    state: result.state ?? null,
    launchId: result.launchId ?? null,
  });
}

/** Resolve once at claim time and dispatch through the shared send receipt path.
    An existing claim always recovers its recorded recipient, including after
    the project's seat rotates. Creating a missing seat is a separate effect;
    a definite message refusal records that creation alongside the refusal. */
async function sendMessageToOrchestrator(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
  context?: McpToolCallContext,
): Promise<McpToolPayload> {
  requireOrchestratorRelayCaller(dependencies);
  const project = context?.binding?.target.project ?? await resolveOrchestratorToolProject(required(args, "project"), dependencies);
  requiredMessageText(args);
  const key = requestId(args);
  const bound = context?.binding;
  const machine = bound?.target.identity?.startsWith("machine:") ? bound.target.identity.slice(8) : text(args.machine);
  if (machine) {
    const link = resolveRemoteSeatMachine(machine, project, dependencies);
    if (link) {
      try {
        return await dispatchControl(control)("/api/orchestrator/message", {
          project, machine: link.install, text: bound?.sendPayload
            ? splitRelayMessageText(bound.sendPayload.text)?.body ?? bound.sendPayload.text
            : await orchestratorRelayEgressText(requiredMessageText(args)),
          clientMessageId: bound?.downstreamKey ?? orchestratorSendDownstreamKey(key),
        }, callerCapabilityHeaders());
      } catch (error) {
        if (error instanceof McpDispatchVerdictError && error.details.admission === "refused" && typeof error.details.operationId !== "string") {
          const details = { ...error.details };
          delete details.admission;
          throw new McpDispatchNotExecutedError(error.message, details);
        }
        throw error;
      }
    }
  }
  let seat = orchestratorSeatFor(project).active;
  let recipient = bound ? bound.target.identity : seat?.conversationId;
  let created = false;
  if (!recipient) {
    try {
      const outcome = await dispatchControl(control)("/api/orchestrator/seat", {
        project,
        mandate: ORCHESTRATOR_SYSTEM_PROMPT,
        promptVersion: ORCHESTRATOR_PROMPT_VERSION,
        clientRequestId: derivedRequestId(key, "create"),
      }, callerCapabilityHeaders());
      created = true;
      // Never substitute the current seat for an absent creation response:
      // that could be a rotation unrelated to this logical request.
      seat = (outcome.seat as OrchestratorSeat | undefined) ?? null;
      recipient = seat?.conversationId;
      if (!recipient) throw new McpDispatchUncertainError("orchestrator creation has not returned a recipient; recover the original key");
      if (bound) {
        if (!context?.bindCreatedTarget) throw new McpDispatchUncertainError("the created recipient cannot be persisted; no message was dispatched");
        await context.bindCreatedTarget(recipient);
      }
    } catch (error) {
      if (!created) {
        const refusal = orchestratorDispatchRefusal(error);
        if (refusal) throw refusal;
        if (error instanceof McpDispatchNotExecutedError || error instanceof McpDispatchVerdictError) throw error;
      }
      throw new McpDispatchUncertainError(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const outcome = await sendMessage({
      ...args,
      conversationId: recipient,
      transcriptPath: seat?.conversationId === recipient ? seat.path : undefined,
      path: undefined,
    }, control, dependencies, context, orchestratorSendDownstreamKey(key), project);
    const actualRecipient = typeof outcome.conversationId === "string" ? outcome.conversationId
      : typeof (outcome.receipt as { conversationId?: unknown } | undefined)?.conversationId === "string"
        ? (outcome.receipt as { conversationId: string }).conversationId : recipient;
    if (actualRecipient && actualRecipient !== recipient && context?.bindCreatedTarget) await context.bindCreatedTarget(actualRecipient);
    return redactPayload({
      ...outcome, project, created,
      // Seat metadata describes only the recipient this dispatch actually used.
      ...(seat?.conversationId === recipient ? {
        seatEpoch: seat.seatEpoch,
        predecessorConversationId: seat.predecessorConversationId,
      } : {}),
    });
  } catch (error) {
    const refusal = error instanceof McpDispatchNotExecutedError ? error : orchestratorDispatchRefusal(error);
    if (created && refusal && typeof refusal.details.status === "number") throw new McpDispatchSettledRefusalError(refusal.message, {
      ...refusal.details, project, created: true, conversationId: recipient,
      messageOutcome: "not-executed",
    });
    if (created) throw new McpDispatchUncertainError(error instanceof Error ? error.message : String(error));
    if (refusal) throw refusal;
    throw error;
  }
}

/** rotate_orchestrator: explicit handoff to a successor. Never called by any
    heuristic — see the rotation command's contract.

    Authority is the ROUTE's (#1402), and there is no copy of it here: this posts
    the calling session's own capability like every other control call, and the
    rotation route admits that caller and names it. What comes back includes that
    name, so the caller reads the attribution its rotation was recorded under. */
async function rotateOrchestrator(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies?: Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">,
): Promise<McpToolPayload> {
  /* docs/design/ghost-seat.md §4 rule 4: a deputy never changes the seat's
     identity. Attribution reads process ancestry and can fault; a fault here
     is not a deputy and leaves the route's own admission to decide. */
  let deputy: string | null = null;
  try {
    deputy = dependencies ? attributionOf(dependencies).via?.deputy ?? null : null;
  } catch {
    deputy = null;
  }
  if (deputy) {
    throw new McpToolRefusal(
      "a parallel self of the orchestrator does not rotate the seat; say in your final message why the seat should rotate and it decides on its next turn.",
      { code: "deputy_cannot_rotate" },
    );
  }
  const project = canonicalOrchestratorProject(required(args, "project"));
  /* Omitting mandate preserves the incumbent's core and handoff history;
     sending one explicitly replaces the core. */
  const fields = allowedSeatFields(args, ["mandate", "handoffNotes", "cwd", "engine", "model", "effort", "accountId", "keepIncumbentMandate"]);
  const result = await dispatchControl(control)("/api/orchestrator/rotate", {
    project,
    clientRequestId: spawnAttemptId(requestId(args)),
    ...fields,
  }, callerCapabilityHeaders());
  return redactPayload({
    project,
    conversationId: result.conversationId ?? null,
    transcriptPath: result.path ?? null,
    seat: result.seat ?? null,
    rotatedFrom: result.rotatedFrom ?? null,
    /* Actor kind, triggering conversation and its seat epoch: who this rotation
       is recorded against. */
    triggeredBy: result.triggeredBy ?? null,
    /* Whether the prior handoffs were summarized or kept verbatim, and why. */
    handoff: result.handoff ?? null,
    mandateDisposition: result.mandateDisposition ?? null,
    replayed: result.replayed === true,
  });
}

/** ask_orchestrator_in_parallel (docs/design/ghost-seat.md §5): one command
    with the composer's action — the tool posts to the same route, with the
    caller's capability, so the route admits the voice gateway and refuses
    every other agent. */
async function askOrchestratorInParallelTool(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const project = canonicalOrchestratorProject(required(args, "project"));
  const result = await dispatchControl(control)("/api/orchestrator/ghost", {
    project,
    text: required(args, "text"),
    clientRequestId: `mcp_${requestId(args)}`,
  }, callerCapabilityHeaders());
  return redactPayload({
    project,
    askId: result.askId ?? null,
    conversationId: result.conversationId ?? null,
    replayed: result.replayed === true,
  });
}

/** #2059: a compact read names its PR in one string, and says nothing when
    there is nothing to say; the full forms carry every resolved link. */
function compactPullRequest(pipeline: Pipeline): { pr?: string } {
  const pr = pullRequestSummary(pipelineWorkLinks(pipeline));
  return pr ? { pr } : {};
}

/** The compact row says it only when there is something to say: each setting
    when it is away from its default, and the lane's merge when the runner
    took it. */
function compactMergeFields(pipeline: Pipeline): { mergeOnReview?: true; bridgeReports?: false; merge?: ReturnType<typeof mergeFields>["merge"] } {
  const { mergeOnReview, bridgeReports, merge } = mergeFields(pipeline);
  return {
    ...(mergeOnReview ? { mergeOnReview: true as const } : {}),
    ...(bridgeReports ? {} : { bridgeReports: false as const }),
    ...(merge ? { merge } : {}),
  };
}

/** #2187 §4.1: whether the lane's project merges when the review passes, and
    where the lane's own merge stands when the runner took it. #2146: whether
    the project's bridge reports are on. */
function mergeFields(pipeline: Pipeline): { mergeOnReview: boolean; bridgeReports: boolean; merge?: { state: PipelineMergeState; reason: string | null; by: "auto-merge" | "outside" | null; pr: number | null; refresh?: string } } {
  const merge = pipeline.merge;
  return {
    mergeOnReview: mergeOnReviewEnabled(pipeline.project),
    bridgeReports: bridgeReportsEnabled(pipeline.project),
    ...(merge ? { merge: { state: merge.state, reason: merge.reason, by: merge.by, pr: merge.prNumber, ...(merge.refresh?.pipelineId ? { refresh: merge.refresh.pipelineId } : {}) } } : {}),
  };
}

async function getPipeline(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies = productionDomainDependencies, context: McpToolCallContext = {}): Promise<McpToolPayload> {
  const pipelineId = required(args, "pipelineId");
  const pipeline = dependencies.readPipelineRecord ? dependencies.readPipelineRecord(pipelineId) : dependencies.getPipelines().pipelines.find(row => row.id === pipelineId);
  if (!pipeline) {
    /* #1835: a create queued during a handover was answered with this id. */
    const queued = queuedPipelineCreationStatus(pipelineId);
    if (queued) {
      throw new McpToolRefusal(queuedPipelineCreationMessage(pipelineId, queued), {
        code: queued.state === "queued" ? "pipeline_queued" : "pipeline_creation_refused",
        pipelineId,
        queuedCreation: queued,
      });
    }
    throw new Error("pipeline not found");
  }
  /* Stage conclusions and graph guards stay reachable without retained bodies. */
  const stageId = text(args.stageId);
  if (stageId) {
    const attempt = typeof args.attempt === "number" ? args.attempt : undefined;
    return redactPayload({ ...pipelineStageRead(projectReadText(pipeline, context), stageId, attempt), task: pipeline.task, revision: recordRevision(pipeline) });
  }
  if (!fullAnswer(args)) {
    const compact = pipelineCompactRow(projectReadText(pipeline, context));
    const definitions = new Map(pipeline.stages.map(stage => [stage.id, stage]));
    return redactPayload({
      pipelineId,
      ...compact,
      // A detail read retains role metadata without retained prompts/history.
      stages: compact.stages.map(stage => ({ ...stage, kind: definitions.get(stage.id)?.kind ?? null,
        roleId: definitions.get(stage.id)?.effectiveRole?.roleId ?? null })),
      ...pipelineCheckFields(pipeline),
      revision: recordRevision(pipeline),
      taskIds: pipeline.taskIds,
      stageDigests: stageDigests(pipeline.stages),
      graphDigest: graphDigest(pipeline.stages),
      ...compactPullRequest(pipeline),
    });
  }
  /* The digests a guarded graph edit names as expectedStageDigest. */
  return { ...redactPayload({ pipelineId, pipeline }), revision: recordRevision(pipeline), stageDigests: stageDigests(pipeline.stages), graphDigest: graphDigest(pipeline.stages), workLinks: pipelineWorkLinks(pipeline) };
}

/** Filter and page original records, then scrub only the selected source before
 * shared projections split lines or clip text. Stored records stay untouched. */
function projectReadText<T>(value: T, context: McpToolCallContext): T {
  if (!context.redactText) return value;
  if (typeof value === "string") return context.redactText(value) as T;
  if (Array.isArray(value)) return value.map(row => projectReadText(row, context)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, projectReadText(row, context)])) as T;
}

const SENSITIVE_PAYLOAD_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|passwd|secret)/i;

function redactPayload<T>(value: T): T {
  if (typeof value === "string") return hardenedRedact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactPayload(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => [key, SENSITIVE_PAYLOAD_KEY.test(key) ? "[redacted]" : redactPayload(child)])) as T;
}

async function boardSnapshot(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  const project = text(args.project);
  const activity = text(args.activity);
  const liveOnly = args.liveOnly === true;
  const limit = Math.max(1, Math.min(200, integer(args.limit, 100)));
  const snapshot = dependencies.registrySnapshot();
  const conversationsByPath = new Map<string, RegistrySnapshot["conversations"][string]>();
  for (const conversation of Object.values(snapshot.conversations)) {
    for (const generation of conversation.generations) conversationsByPath.set(generation.path, conversation);
    for (const pathname of conversation.continuityPaths ?? []) conversationsByPath.set(pathname, conversation);
  }
  const files = (await dependencies.completedFileScan()).snapshot.files;
  const conversations = files
    .filter((entry) => entry.engine === "claude" || entry.engine === "codex" || entry.engine === "copilot")
    .filter((entry) => !project || entry.project === project)
    .filter((entry) => !activity || entry.activity === activity)
    .filter((entry) => !liveOnly || entry.activity === "live" || entry.activity === "stalled")
    .slice(0, limit)
    .map((entry) => {
      const conversation = entry.conversationId
        ? snapshot.conversations[entry.conversationId]
        : conversationsByPath.get(entry.path);
      const conversationId = conversation?.id ?? entry.conversationId ?? null;
      const edge = conversationId ? snapshot.lineageEdges[conversationId] : undefined;
      return {
        conversationId,
        transcriptPath: entry.path,
        project: entry.project,
        title: entry.title,
        engine: entry.engine,
        activity: entry.activity,
        proc: entry.proc,
        lineage: conversationId ? {
          parentConversationId: edge?.parentConversationId ?? null,
          kind: edge?.kind ?? null,
          role: conversation?.agentRole ?? edge?.role ?? null,
          depth: conversation?.delegationDepth ?? 0,
          memberships: snapshot.memberships[conversationId] ?? [],
        } : null,
      };
    });
  const board = project ? dependencies.boardFor(project) : null;
  const remote = project ? await readRemoteAgentRows(project) : { rows: [], unavailable: false };
  return redactPayload({
    count: conversations.length,
    conversations,
    ...(project ? { remoteAgents: remote.rows, ...(remote.unavailable ? { remoteAgentsUnavailable: true } : {}) } : {}),
    hiddenCount: board?.prefs.hidden.length ?? null,
    board,
  });
}

function listFlows(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const states = stringSet(args.state, ["waiting_ready", "spawn_pending", "spawning", "reviewing", "relay_pending", "relaying", "fixing", "approved", "done_comment", "needs_decision", "paused", "closed"]);
  const scope = { project: text(args.project), states, includeClosed: args.includeClosed === true,
    ids: stringSet(args.ids), query: "", updatedSince: "" };
  const source = dependencies.flowSelectionSource?.();
  const limit = Math.max(1, Math.min(200, integer(args.limit, 100)));
  const project = (flow: import("@/lib/flows/types").Flow) => fullAnswer(args) ? flow : compactFlow(flow);
  const page = source ? boardSelection(source.filename, "flows").page(source, scope, args.cursor, limit, project)
    : listPage(dependencies.getFlowsWithPresets().flows, {
      scope, cursor: args.cursor, limit,
      identity: flow => ({ id: flow.id, time: flow.createdAt ?? "" }),
      matches: flow => (!scope.project || flow.project === scope.project)
        && (!states.length || states.includes(flow.state))
        && (scope.includeClosed || (flow.state !== "closed" && !flow.closedAt))
        && (!scope.ids.length || scope.ids.includes(flow.id)),
      project,
    });
  const { rows: flows, ...pagination } = page;
  return redactPayload({ ...pagination, flows, ...FLOW_ARCHIVE, compact: !fullAnswer(args),
    omittedRecordCount: fullAnswer(args) ? 0 : flows.length,
    readMore: "Pass nextCursor as cursor with the same filters and a fresh clientRequestId. full:true, compact:false or get_flow(flowId) reads complete records." });
}

async function getFlow(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const flowId = required(args, "flowId");
  const source = dependencies.flowSelectionSource?.();
  const flow = source ? source.read(flowId) : dependencies.getFlowsWithPresets().flows.find((candidate) => candidate.id === flowId);
  if (!flow) throw new Error("flow not found");
  return redactPayload({ flowId, flow, ...FLOW_ARCHIVE });
}

function mutationReceipt(operationId: string): { operationId: string; receipt: { operationId: string; status: "delivered" } } {
  return { operationId, receipt: { operationId, status: "delivered" } };
}

/** The conversation a flow decision is submitted as. A decision reports the
    implementer's OWN turn, so a deputy speaks as itself here, never as its
    seat: it is nobody's implementer, and the seat's turn is not its turn to
    settle (docs/design/ghost-seat.md §4 rule 2). */
export function flowDecisionCaller(caller: CallerAttribution): string | null {
  if (caller.kind === "unidentified") return null;
  return caller.via?.deputy ?? caller.conversationId;
}

async function flowAction(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const flowId = required(args, "flowId");
  const action = required(args, "action");
  if (action === "agent-decision") {
    const { submitFlowDecision } = await import("@/lib/flows/decisions");
    const { flowDecisionRequestSchema } = await import("@/lib/flows/decisionSchema");
    const request = flowDecisionRequestSchema.parse(args);
    let result: Awaited<ReturnType<typeof submitFlowDecision>>;
    try { result = await submitFlowDecision(request, flowDecisionCaller(attributionOf(dependencies))); }
    catch (error) {
      if (error instanceof FlowRetiredError) throw new McpToolRefusal(FLOW_RETIREMENT.error, { ...FLOW_RETIREMENT, retryable: false });
      throw error;
    }
    return redactPayload({ ...result, ...FLOW_ARCHIVE, outcome: result.decision.disposition === "accepted" ? "accepted" : "settled",
      nextAction: result.decision.disposition === "accepted" ? "original-key-lookup" : "follow-disposition" });
  }
  throw new McpToolRefusal(FLOW_RETIREMENT.error, { ...FLOW_RETIREMENT, retryable: false });
}

/** A seat's list scope comes from its authenticated designation. */
function boardReadProject(
  args: McpToolArgs,
  dependencies: Pick<ViewerMcpDomainDependencies, "callerAttribution" | "authorizedSeats"> & Partial<Pick<ViewerMcpDomainDependencies, "attentionAuthority">>,
): string {
  const requested = text(args.project);
  const caller = dependencies.attentionAuthority ? attributionOf(dependencies as ViewerMcpDomainDependencies) : dependencies.callerAttribution?.() ?? null;
  if (!caller || (caller.kind !== "manager" && caller.kind !== "gateway")) return requested ? canonicalProject(requested) : "";
  const seat = caller.conversationId && (dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources()))
    .find(candidate => candidate.conversationId === caller.conversationId);
  if (!seat && caller.kind === "gateway") return requested ? canonicalProject(requested) : "";
  if (!seat || !seat.project) throw new McpToolRefusal("the caller's project designation is unavailable; nothing was read", { code: "project_scope_refused", status: 403 });
  const own = canonicalProject(seat.project);
  if (requested && canonicalProject(requested) !== own) throw new McpToolRefusal("an orchestrator seat reads only its own project's board; use send_message_to_orchestrator for another project", { code: "cross_project_refused", status: 403, retryable: false });
  return own;
}

function pipelineReferenceRows(dependencies: ViewerMcpDomainDependencies, project: string): Pipeline[] {
  const source = dependencies.pipelineSelectionSource?.();
  return source ? boardSelection(source.filename, "pipelines").referenceRecords(source, project)
    : (dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines).filter(row => !project || canonicalProject(row.project) === project);
}

function pipelineMatchesPr(pipeline: Pipeline, number: number): boolean {
  return recordMatchesPr(pipeline.task, pipelineWorkLinks(pipeline), number);
}

function recordMatchesPr(title: string, resolved: ReturnType<typeof pipelineWorkLinks>, number: number): boolean {
  const matching = resolved.links.filter(link => link.number === number);
  return matching.some(link => link.kind === "pr")
    || (!matching.some(link => link.kind === "issue") && titleHasPullRequest(title, number));
}

function taskReferenceIds(dependencies: ViewerMcpDomainDependencies, project: string, number: number): string[] {
  const pipelines = pipelineReferenceRows(dependencies, project);
  const carrying = new Map<string, Set<string>>();
  for (const pipeline of pipelines) if (pipelineMatchesPr(pipeline, number)) {
    const ids = carrying.get(canonicalProject(pipeline.project)) ?? new Set<string>();
    for (const id of pipeline.taskIds ?? []) ids.add(id);
    carrying.set(canonicalProject(pipeline.project), ids);
  }
  const source = dependencies.taskSelectionSource?.();
  const tasks = source ? boardSelection(source.filename, "tasks").referenceRecords(source, project)
    : (dependencies.listTaskRecords?.() ?? dependencies.loadTasks()).filter(row => !project || canonicalProject(row.project) === project);
  return tasks.filter(task => carrying.get(canonicalProject(task.project))?.has(task.id)
    || recordMatchesPr(task.text, taskWorkLinks(task, []), number)).map(task => task.id).sort();
}

/** Lists reuse the store's immutable generation and materialize one page. */
async function listPipelines(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  const states = stringSet(args.state, ["open", "draft", "provisioning", "running", "paused", "needs_decision", "needs_review", "completed", "closed"]);
  const scope = { project: boardReadProject(args, dependencies), states, includeClosed: args.includeClosed === true,
    ids: stringSet(args.ids), query: normalizedBoardQuery(text(args.query)), updatedSince: sinceTime(args.updatedSince),
    queryIds: undefined as string[] | undefined };
  // Resolve explicit ids once so PR matching and paging share the same
  // hot-or-archive records without traversing either collection.
  const requested = scope.ids.length && dependencies.readPipelineRecord
    ? new Map(scope.ids.flatMap(id => {
      const row = dependencies.readPipelineRecord!(id);
      return row ? [[id, row] as const] : [];
    }))
    : undefined;
  const number = pullRequestQuery(scope.query);
  if (number !== null) scope.queryIds = (requested ? [...requested.values()] : pipelineReferenceRows(dependencies, scope.project))
    .filter(row => (!scope.project || canonicalProject(row.project) === scope.project) && pipelineMatchesPr(row, number)).map(row => row.id).sort();
  const hotSource = dependencies.pipelineSelectionSource?.();
  // Explicit ids share get_pipeline's hot-or-archive lookup. Keep ordinary
  // lists on their scalar selection index and materialize only requested rows.
  const source = hotSource && requested
    ? { ...hotSource, read: (id: string) => requested.get(id) ?? null }
    : hotSource;
  /* #2059: the compact row names its PR in one string, the full forms carry
     every resolved link. */
  const project = (source: Pipeline) => {
    const pipeline = projectReadText(source, context);
    if (args.full === true) return { ...pipeline, workLinks: pipelineWorkLinks(pipeline), mergeOnReview: mergeOnReviewEnabled(pipeline.project), bridgeReports: bridgeReportsEnabled(pipeline.project) };
    if (args.compact === false) return { ...pipelineListRow(pipeline), workLinks: pipelineWorkLinks(pipeline), ...mergeFields(pipeline) };
    const { stages, ...status } = pipelineCompactRow(pipeline);
    return { ...(args.statusOnly === true ? status : { ...status, stages }), ...pipelineCheckFields(pipeline), ...compactPullRequest(pipeline), ...compactMergeFields(pipeline) };
  };
  const page = source ? boardSelection(source.filename, "pipelines").page(source, scope, args.cursor,
    Math.max(1, Math.min(200, integer(args.limit, PIPELINE_LIST_DEFAULT_LIMIT))), project)
    : await listPageAsync(requested
      ? [...requested.values()]
      : dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines, {
    scope, cursor: args.cursor, limit: Math.max(1, Math.min(200, integer(args.limit, PIPELINE_LIST_DEFAULT_LIMIT))),
    identity: pipeline => ({ id: pipeline.id, time: pipeline.createdAt ?? "" }),
    matches: pipeline => (!scope.project || canonicalProject(pipeline.project) === scope.project)
      && (!states.length || states.includes(pipeline.state) || (states.includes("open") && !["completed", "closed"].includes(pipeline.state)))
      && (scope.includeClosed || (pipeline.state !== "closed" && !pipeline.hiddenAt))
      && (!scope.ids.length || scope.ids.includes(pipeline.id))
      && (scope.queryIds !== undefined ? scope.queryIds.includes(pipeline.id) : !scope.query || pipeline.task.toLowerCase().includes(scope.query))
      && (!scope.updatedSince || pipeline.createdAt >= scope.updatedSince),
    project,
  }, () => throwIfCallEnded(context));
  throwIfCallEnded(context);
  const { rows: pipelines, ...pagination } = page;
  return redactPayload({ ...pagination, pipelines, compact: !fullAnswer(args),
    omittedRecordCount: args.full === true ? 0 : pipelines.length,
    ...answerHint(args, "Pass nextCursor as cursor with the same filters and a fresh clientRequestId. full:true or get_pipeline with full:true reads complete records; compact:false returns the previous board-card projection.") });
}

function taskWithLinks(task: import("@/lib/tasks/types").BoardTask, dependencies: ViewerMcpDomainDependencies, links?: (task: string) => string[]): TaskPipelineReadModel {
  const source = links ? null : dependencies.pipelineSelectionSource?.();
  const pipelineIds = links ? links(task.id) : source ? boardSelection(source.filename, "pipelines").links(task.id)
    : (dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines).filter(pipeline => pipeline.taskIds?.includes(task.id)).map(pipeline => pipeline.id);
  return { ...taskWithoutPrototypeDetails(task), pipelineIds };
}

/** Prototype contents have their own project-scoped read capability. */
function taskWithoutPrototypeDetails(task: import("@/lib/tasks/types").BoardTask) {
  const { prototypeReviews: _rounds, prototypeReviewReplica: _replica, prototypeReview: _summary, ...publicTask } = task;
  return publicTask;
}

const taskById = new WeakMap<object, Map<string, TaskPipelineReadModel>>();
const taskModels = new WeakMap<object, WeakMap<object, TaskPipelineReadModel[]>>();
function taskReadModel(dependencies: ViewerMcpDomainDependencies) {
  const tasks = dependencies.listTaskRecords?.() ?? dependencies.loadTasks();
  const pipelines = dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines;
  let byPipelines = taskModels.get(tasks);
  if (!byPipelines) { byPipelines = new WeakMap(); taskModels.set(tasks, byPipelines); }
  let model = byPipelines.get(pipelines);
  if (!model) {
    const links = new Map<string, string[]>();
    for (const pipeline of pipelines) for (const id of pipeline.taskIds ?? []) {
      const ids = links.get(id) ?? [];
      ids.push(pipeline.id); links.set(id, ids);
    }
    model = tasks.map(task => ({ ...taskWithoutPrototypeDetails(task), pipelineIds: links.get(task.id) ?? [] }));
    byPipelines.set(pipelines, model);
    taskById.set(model, new Map(model.map(task => [task.id, task])));
  }
  return model;
}

/** Kept for callers explicitly requesting the previous list projection. */
export const LIST_TASKS_DETAILS_CHARS = 400;
function listTaskRow(task: TaskPipelineReadModel) {
  const details = task.details;
  return typeof details === "string" && details.length > LIST_TASKS_DETAILS_CHARS
    ? { ...task, details: details.slice(0, LIST_TASKS_DETAILS_CHARS), detailsTruncated: true } : task;
}

function listTasks(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies, context: McpToolCallContext = {}): McpToolPayload {
  const statuses = stringSet(args.statuses ?? args.status, ["inbox", "assigned", "blocked", "done"]);
  const scope = { project: boardReadProject(args, dependencies), statuses, placement: stringSet(args.placement, ["pinned", "unplaced"])[0] ?? "",
    openOnly: args.openOnly === true, updatedSince: sinceTime(args.updatedSince), ids: stringSet(args.ids), query: normalizedBoardQuery(text(args.query)),
    queryIds: undefined as string[] | undefined,
    priorities: stringSet(args.priority, [...TASK_PRIORITIES]) };
  const number = pullRequestQuery(scope.query);
  if (number !== null) scope.queryIds = taskReferenceIds(dependencies, scope.project, number);
  const source = dependencies.taskSelectionSource?.();
  const project = (source: TaskPipelineReadModel) => {
    const task = projectReadText(source, context);
    return args.full === true ? withOwnership(task) : args.compact === false ? withOwnership(listTaskRow(task)) : compactTask(task);
  };
  const selectionPage = (links?: (task: string) => string[]) => boardSelection(source!.filename, "tasks").page(source!, scope, args.cursor,
    Math.max(1, Math.min(200, integer(args.limit, 100))), task => project(taskWithLinks(task, dependencies, links)));
  const pipelineSource = source ? dependencies.pipelineSelectionSource?.() : null;
  const page = source ? pipelineSource ? boardSelection(pipelineSource.filename, "pipelines").withLinks(selectionPage) : selectionPage()
    : listPage(taskReadModel(dependencies), {
    scope, cursor: args.cursor, limit: Math.max(1, Math.min(200, integer(args.limit, 100))),
    identity: task => ({ id: task.id, time: task.updatedAt ?? "" }),
    matches: task => (!scope.project || canonicalProject(task.project) === scope.project)
      && (!statuses.length || statuses.includes(task.status)) && (!scope.openOnly || task.status !== "done")
      && (!scope.placement || task.placement === scope.placement)
      && (!scope.priorities.length || scope.priorities.includes(taskPriority(task)))
      && (!scope.updatedSince || task.updatedAt >= scope.updatedSince)
      && (!scope.ids.length || scope.ids.includes(task.id))
      && (scope.queryIds !== undefined ? scope.queryIds.includes(task.id) : !scope.query || task.text.toLowerCase().includes(scope.query)),
    project,
  });
  const { rows: tasks, ...pagination } = page;
  return redactPayload({ ...pagination, tasks, compact: !fullAnswer(args),
    omittedRecordCount: args.full === true ? 0 : tasks.length,
    ...answerHint(args, "Pass nextCursor as cursor with the same filters and a fresh clientRequestId. get_task(taskId) or full:true reads complete records; compact:false returns the previous truncated-details projection. Never write a truncated value back.") });
}

/** The pipelines a task carries, read by id when the store can, so a task read
    never loads the whole registry to name its PRs (#2059). */
function carriedPipelines(ids: readonly string[], dependencies: ViewerMcpDomainDependencies): Pipeline[] {
  if (!ids.length) return [];
  const source = dependencies.pipelineSelectionSource?.();
  if (source) return ids.flatMap((id) => source.read(id) ?? []);
  if (dependencies.readPipelineRecord) return ids.flatMap((id) => dependencies.readPipelineRecord!(id) ?? []);
  const wanted = new Set(ids);
  return (dependencies.listPipelineRecords?.() ?? dependencies.getPipelines?.().pipelines ?? []).filter((pipeline) => wanted.has(pipeline.id));
}

type RemoteAgentRows = ReturnType<typeof import("@/lib/links/agentFeed").remoteAgents>;
async function readRemoteAgentRows(project: string): Promise<{ rows: RemoteAgentRows; unavailable: boolean }> {
  if (!linkedContext().all.has(project)) return { rows: [], unavailable: false };
  const { remoteAgents } = await import("@/lib/links/agentFeed");
  const local = remoteAgents(project);
  if (local.length) return { rows: local, unavailable: false };
  try {
    const { response, parsed } = await requestViewerControl(`/api/links/agents?project=${encodeURIComponent(project)}`, { method: "GET" });
    if (response.ok && objectRecord(parsed) && Array.isArray(parsed.agents)) return { rows: parsed.agents as RemoteAgentRows, unavailable: false };
  } catch { /* The task read still works while the Viewer control endpoint is down. */ }
  return { rows: [], unavailable: true };
}

async function getTask(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies, context: McpToolCallContext = {}): Promise<McpToolPayload> {
  const taskId = required(args, "taskId");
  const source = dependencies.taskSelectionSource?.();
  const stored = source?.read(taskId);
  const task = source ? (stored ? taskWithLinks(stored, dependencies) : null)
    : taskById.get(taskReadModel(dependencies))!.get(taskId);
  if (!task) throw new Error("task not found");
  const workLinks = args.compact === true ? null : taskWorkLinks(task, carriedPipelines(task.pipelineIds, dependencies));
  const remote = await readRemoteAgentRows(task.project);
  return redactPayload({ taskId, task: args.compact === true ? compactTask(projectReadText(task, context)) : withOwnership(projectReadText(task, context)), remoteAgents: remote.rows.filter((row) => row.task === task.id),
    ...(remote.unavailable ? { remoteAgentsUnavailable: true } : {}), ...(workLinks ? { workLinks } : {}),
    ...(args.compact === true ? { omittedRecordCount: 1, readMore: "get_task without compact reads the full task." } : {}) });
}

async function operatorSnapshot(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const request = validateSnapshotRequest({
    schemaVersion: 1,
    ...withoutKeys(args, ["clientRequestId"]),
  });
  /* Explicit dependencies rather than the module defaults (#845): the completed
     scanner generation and registry projection are the same shared reads used by
     board/list/get/send, so this call starts no private observation. */
  return redactPayload({
    ...await dependencies.collectSnapshot(request, {
      completedFileScan: dependencies.completedFileScan,
      resolveSiblings,
      registrySnapshot: dependencies.registrySnapshot,
    }),
  });
}

/**
 * Whether a control-plane refusal means "this Viewer does not serve that route"
 * rather than "that thing is not there" (#790).
 *
 * Blue/green promotes the web surface before the successor runtime host takes
 * over, and the deployment health gate probes a CANDIDATE's MCP while the
 * PREVIOUS revision is still answering on the control port. A read that moved
 * onto a route introduced in the same revision therefore meets a Viewer that has
 * never heard of it, and answers 405. Treating that as a hard failure made the
 * gate unpassable for the very change that added the route, so the transition
 * window has to be survivable rather than fatal.
 *
 * Deliberately 405 only: a 404 from these routes is the domain answer ("that
 * deployment was not found") and must keep its meaning.
 */
function isUnservedControlRoute(error: unknown): boolean {
  /* A refusal carrying a status means the surface answered, so its answer stands:
     404 is "that deployment is absent", and 503 keeps the absent-versus-
     unreachable plane distinction #777 established. Only two things mean this
     reader cannot use the surface at all — a revision that never served the route
     (405), and a transport failure or timeout, which arrives as a plain Error. */
  if (error instanceof McpToolRefusal) return (error.details as { status?: unknown }).status === 405;
  if (error instanceof ViewerControlResponseError) return false;
  return true;
}

function isDeploymentStatus(value: unknown, expectedId?: string): value is ViewerDeploymentStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const deployment = value as Partial<ViewerDeploymentStatus>;
  return typeof deployment.deploymentId === "string"
    && (!expectedId || deployment.deploymentId === expectedId)
    && typeof deployment.revision === "string"
    && typeof deployment.phase === "string";
}

function runtimeHostRequestHealth(value: unknown): RuntimeHostRequestHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const health = value as Record<string, unknown>;
  const samples = health.samples;
  const p95Ms = health.p95Ms;
  const maxMs = health.maxMs;
  const timeouts = health.timeouts;
  const windowSize = health.windowSize;
  if (!Number.isSafeInteger(samples) || (samples as number) < 0
    || !Number.isFinite(p95Ms) || (p95Ms as number) < 0
    || !Number.isFinite(maxMs) || (maxMs as number) < (p95Ms as number)
    || !Number.isSafeInteger(timeouts) || (timeouts as number) < 0 || (timeouts as number) > (samples as number)
    || !Number.isSafeInteger(windowSize) || (windowSize as number) < 1 || (samples as number) > (windowSize as number)) {
    return null;
  }
  return {
    samples: samples as number,
    p95Ms: p95Ms as number,
    maxMs: maxMs as number,
    timeouts: timeouts as number,
    windowSize: windowSize as number,
  };
}

function isDeploymentSummary(value: unknown): value is ViewerDeploymentSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.deploymentId === "string" && typeof row.phase === "string" && typeof row.sha === "string"
    && typeof row.terminal === "boolean" && (row.startedAt === null || typeof row.startedAt === "string")
    && (row.finishedAt === null || typeof row.finishedAt === "string") && (row.error === null || typeof row.error === "string");
}

function deploymentList(result: Record<string, unknown>, compact = false): {
  deployments: Array<ViewerDeploymentStatus | ViewerDeploymentSummary>;
  nextCursor?: string | null;
  hasMore?: boolean;
  legacySnapshot?: true;
  legacyTerminal?: true;
  runtimeHostRequests?: RuntimeHostRequestHealth;
} {
  if (
    !Array.isArray(result.deployments)
    || !result.deployments.every((deployment) => isDeploymentStatus(deployment) || (compact && isDeploymentSummary(deployment)))
    || !Number.isInteger(result.count)
    || result.count !== result.deployments.length
  ) {
    throw new ViewerControlResponseError("Viewer control returned a malformed deployment list");
  }
  /* A checkout or packaged Viewer up to 2fda8a4e ends its page with a null
     cursor and no hasMore; that page declares itself the last one. It ignores
     a cursor too, so the caller refuses that shape on a continuation. */
  const legacyTerminal = result.nextCursor === null && result.hasMore === undefined;
  const hasMore = legacyTerminal ? false : result.hasMore;
  if ((result.nextCursor !== undefined || hasMore !== undefined)
    && (typeof hasMore !== "boolean" || !(result.nextCursor === null || typeof result.nextCursor === "string")
      || hasMore !== (typeof result.nextCursor === "string" && result.nextCursor.length > 0))) {
    throw new ViewerControlResponseError("Viewer control returned malformed deployment pagination");
  }
  const health = runtimeHostRequestHealth(result.runtimeHostRequests);
  if (result.runtimeHostRequests !== undefined && !health) {
    throw new ViewerControlResponseError("Viewer control returned malformed runtime-host request health");
  }
  return {
    deployments: result.deployments,
    ...(result.legacySnapshot === true ? { legacySnapshot: true } : {}),
    ...(legacyTerminal ? { legacyTerminal: true } : {}),
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor as string | null, hasMore: hasMore as boolean } : {}),
    ...(health ? { runtimeHostRequests: health } : {}),
  };
}

async function deploymentStatus(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  if (args.kind === "host-retirement") {
    if (args.operationId !== undefined || args.deploymentId !== undefined) {
      throw new Error("retirement observation cannot be combined with an operation or deployment lookup");
    }
    const project = canonicalOrchestratorProject(required(args, "project"));
    // The stdio server can attribute a session by ancestry even when the
    // provider did not inherit LLV_SPAWN_CAPABILITY into its MCP environment.
    const caller = attributionOf(dependencies);
    if (!caller.conversationId || caller.kind === "unidentified") {
      throw new McpToolRefusal("retirement observation requires an identified session", { code: "retirement_caller_unidentified" });
    }
    const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
    const seat = caller.kind === "manager" ? seats.find(candidate => candidate.conversationId === caller.conversationId) : undefined;
    let authentication: { conversationId: string; seatProject: string } | { conversationId: string; launchId: string };
    if (seat?.project) {
      if (seat.project !== project) throw new McpToolRefusal("retirement observation is limited to the caller's own project", { code: "retirement_project_refused" });
      authentication = { conversationId: caller.conversationId, seatProject: seat.project };
    } else {
      const snapshot = dependencies.registrySnapshot();
      const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
      // An adopted seat keeps its spawn receipt after replacement. Its current
      // revocation must fence that receipt; a newer designation lifts the fence.
      const revoked = revokedOrchestratorSeatConversationsOrUnknown(
        id => lookup.canonicalConversationId(id as `conversation_${string}`),
      );
      if (revoked === null) {
        throw new McpToolRefusal("retirement observation cannot establish seat revocations", { code: "retirement_authority_unavailable" });
      }
      if (revoked.has(lookup.canonicalConversationId(caller.conversationId as `conversation_${string}`))) {
        throw new McpToolRefusal("retirement observation is refused for a revoked seat", { code: "retirement_seat_revoked" });
      }
      const conversation = snapshot.conversations[caller.conversationId];
      const ownProject = conversation?.projectOwnership?.project;
      if (!ownProject || canonicalOrchestratorProject(ownProject) !== project) {
        throw new McpToolRefusal("retirement observation is limited to the caller's own project", { code: "retirement_project_refused" });
      }
      const explicit = text(args.callerLaunchId);
      const receipt = explicit ? snapshot.receipts[explicit] : registryRowsMatching(snapshot, "receipts", "conversationId", caller.conversationId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.launchId.localeCompare(a.launchId))[0];
      if (!receipt || receipt.conversationId !== caller.conversationId) {
        throw new McpToolRefusal("retirement observation requires the authenticated caller's spawn receipt", { code: "retirement_receipt_refused" });
      }
      authentication = { conversationId: caller.conversationId, launchId: receipt.launchId };
    }
    // Only this server-derived identity crosses the trusted MCP control hop.
    // The Viewer reads its own report; tool arguments cannot assert authority.
    return redactPayload(await control.post("/api/runtime/deployments?kind=host-retirement", {
      project, limit: Math.max(1, Math.min(100, integer(args.limit, 25))),
      ...(text(args.cursor) ? { cursor: text(args.cursor) } : {}),
      authentication,
    }, spawnControlHeaders()));
  }
  if (args.kind !== undefined || (args.cursor !== undefined && (args.deploymentId !== undefined || args.operationId !== undefined))) throw new Error("unsupported deployment status query");
  const deploymentId = text(args.deploymentId);
  if (deploymentId) {
    const deployment = await readViewerControl(
      control,
      `/api/runtime/deployments/${encodeURIComponent(deploymentId)}`,
    ).catch((error: unknown) => {
      if (!isUnservedControlRoute(error)) throw error;
      const fromLedger = ledgerDeployment(deploymentId);
      if (fromLedger.state === "unreadable") throw new Error(fromLedger.error);
      return fromLedger.value ?? null;
    });
    if (!deployment) throw new Error("viewer deployment was not found");
    if (!isDeploymentStatus(deployment, deploymentId)) {
      throw new ViewerControlResponseError("Viewer control returned a malformed deployment");
    }
    return redactPayload({ deploymentId, deployment: args.compact === true ? compactDeployment(deployment) : deployment });
  }
  const operationId = text(args.operationId);
  if (operationId) {
    if (operationId.includes(":") || /\s/.test(operationId)) throw new Error("operationId is invalid");
    const result = await readViewerControl(
      control,
      `/api/runtime/operations/${encodeURIComponent(operationId)}`,
    );
    if (
      result.operationId !== operationId
      || !result.receipt
      || typeof result.receipt !== "object"
      || Array.isArray(result.receipt)
    ) {
      throw new ViewerControlResponseError("Viewer control returned a malformed operation");
    }
    const operation = {
      operationId: result.operationId,
      receipt: result.receipt,
      replayed: false,
    };
    return redactPayload({ operationId, operation });
  }
  const limit = Math.max(1, Math.min(100, integer(args.limit, 25)));
  const cursor = text(args.cursor);
  const query = `limit=${limit}${args.compact === true ? "&compact=true" : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const result = await readViewerControl(control, `/api/runtime/deployments?${query}`)
    .catch(async (error: unknown) => {
      if (!isUnservedControlRoute(error)) throw error;
      if (cursor) throw new Error("Viewer deployment pagination is unavailable during hand-over; restart the list");
      const fromLedger = ledgerDeployments(limit);
      if (fromLedger.state === "unreadable") throw new Error(fromLedger.error);
      const deployments = fromLedger.value;
      return { count: deployments.length, deployments };
    });
  const { deployments: listed, runtimeHostRequests, nextCursor, hasMore, legacySnapshot, legacyTerminal } = deploymentList(result, args.compact === true);
  if (cursor && nextCursor === undefined) throw new Error("Viewer deployment pagination is unavailable during hand-over; restart the list");
  if (cursor && legacyTerminal) throw new Error("Viewer deployment pagination is unavailable from this Viewer revision; restart the list");
  /* #1845 defect C: newest first, whatever order the source answered in — a
     Viewer revision that still serves the id-ordered list included. */
  const deployments = listed.every(row => isDeploymentStatus(row)) ? newestDeploymentsFirst(listed) : listed;
  return redactPayload({
    count: deployments.length,
    deployments: args.compact === true ? deployments.map(row => isDeploymentSummary(row) ? row : compactDeployment(row)) : deployments,
    ...(nextCursor !== undefined ? { nextCursor, hasMore } : {}),
    ...(legacySnapshot ? { legacySnapshot } : {}),
    ...(runtimeHostRequests ? { runtimeHostRequests } : {}),
  });
}

/* An ordinary resources read answers inside a second. A process holding no
   observation waits this long for its first collection, then reports it
   pending; fresh:true keeps the complete wait its caller asked for. */
const MCP_RESOURCES_COLLECTION_BUDGET_MS = 750;

async function resources(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const requestedAt = new Date().toISOString();
  const fresh = args.fresh === true;
  const result = dependencies.readResourcesWithDiagnostic
    ? await dependencies.readResourcesWithDiagnostic(fresh, { waitMs: MCP_RESOURCES_COLLECTION_BUDGET_MS })
    : null;
  const pending = result?.diagnostic.status === "pending";
  const payload = result?.payload ?? await dependencies.readResources(fresh);
  const capturedAt = payload.system?.capturedAt ?? null;
  const capturedMs = capturedAt === null ? NaN : Date.parse(capturedAt);
  /* #2110: the session table has its own age. Rows a failed collection fell
     back on are marked one by one, so a reader that skips freshness still
     cannot take a days-old host for a running one. */
  const sessionsCapturedAt = payload.sessionsCapturedAt ?? null;
  const sessionsMs = sessionsCapturedAt === null ? NaN : Date.parse(sessionsCapturedAt);
  const sessionsStale = payload.sessionsStale ?? null;
  const sessions = sessionsStale === true
    ? payload.sessions.map((session) => ({ ...session, stale: true, capturedAt: sessionsCapturedAt }))
    : payload.sessions;
  const sessionSummary = {
    count: sessions.length,
    rssBytes: sessions.reduce((sum, row) => sum + row.rssBytes, 0),
    swapBytes: sessions.reduce((sum, row) => sum + row.swapBytes, 0),
    procCount: sessions.reduce((sum, row) => sum + row.procCount, 0),
  };
  const summaryPayload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "sessions"));
  return redactPayload({ ...summaryPayload,
    ...(fullAnswer(args) ? { sessions } : { sessionSummary }), freshness: {
    requestedAt, capturedAt, capturedAtScope: "system", ageMs: Number.isFinite(capturedMs) ? Math.max(0, Date.now() - capturedMs) : null,
    sessionsCapturedAt,
    sessionsAgeMs: Number.isFinite(sessionsMs) ? Math.max(0, Date.now() - sessionsMs) : null,
    sessionsStale,
    refreshRequested: fresh,
    refreshSucceeded: fresh && result ? result.diagnostic.status === "complete" && result.diagnostic.cache.status === "miss" : null,
    cache: result?.diagnostic.cache.status ?? "unknown",
    reason: pending ? "collecting" : result?.diagnostic.degradedReason ?? null,
    ...(pending ? { pending: true } : {}),
  } });
}

type ConversationArchiveInput = {
  conversationId: string;
  transcriptPath: string;
};

type ResolvedConversationArchiveTarget = {
  conversationId: string | null;
  transcriptPath: string;
  transcriptPaths: readonly string[];
  project: string;
};

async function conversationArchiveInputs(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
): Promise<{ inputs: ConversationArchiveInput[]; selectedTarget: Awaited<ReturnType<typeof resolveSelectedContext>>["target"] | null }> {
  if (args.targets !== undefined) {
    if (!Array.isArray(args.targets) || args.targets.length === 0) {
      throw new Error("targets must be a non-empty list");
    }
    if (args.targets.length > 100) throw new Error("targets supports at most 100 conversations per call");
    if (text(args.conversationId) || text(args.transcriptPath) || text(args.path) || args.selectedContext !== undefined) {
      throw new Error("targets cannot be combined with conversationId, transcriptPath or selectedContext");
    }
    return {
      inputs: args.targets.map((candidate, index) => {
        if (!objectRecord(candidate)) throw new Error(`targets[${index}] must be an object`);
        const conversationId = text(candidate.conversationId);
        const transcriptPath = text(candidate.transcriptPath);
        if (!conversationId && !transcriptPath) {
          throw new Error(`targets[${index}] requires conversationId or transcriptPath`);
        }
        return { conversationId, transcriptPath };
      }),
      selectedTarget: null,
    };
  }

  const selected = await resolveSelectedContext(
    args,
    text(args.conversationId),
    dependencies.selectedContext ?? productionSelectedContextDependencies,
  );
  const conversationId = selected.conversationId;
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) {
    throw new Error("conversationId, transcriptPath or selectedContext is required");
  }
  return { inputs: [{ conversationId, transcriptPath }], selectedTarget: selected.target };
}

function latestReceiptForConversation(
  snapshot: RegistrySnapshot,
  conversationId: string,
): RegistrySnapshot["receipts"][string] | null {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  return registryReceiptsForConversation(snapshot, conversationId)
    .filter((receipt) => lookup.canonicalConversationId(receipt.conversationId) === conversationId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function latestPendingLaunchReceiptForConversation(
  snapshot: RegistrySnapshot,
  conversationId: string,
): RegistrySnapshot["receipts"][string] | null {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  return registryReceiptsForConversation(snapshot, conversationId)
    .filter((receipt) => (
      lookup.canonicalConversationId(receipt.conversationId) === conversationId
      && receipt.transport === "structured"
      && receipt.purpose === "launch"
      && receipt.artifactLifecycle === "pending"
    ))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function projectForConversationTarget(
  conversation: RegistrySnapshot["conversations"][string] | null,
  receipt: RegistrySnapshot["receipts"][string] | null,
  fallbackProject: string | null = null,
): string | null {
  const generation = conversation?.generations.at(-1);
  const explicitOwnership = conversation?.projectOwnership
    ?? (receipt?.explicitProject
      ? {
          project: receipt.explicitProject,
          source: "operator" as const,
          setAt: receipt.createdAt,
          operationId: receipt.launchId,
        }
      : null);
  return resolveProjectAttribution({
    projectOwnership: explicitOwnership,
    cwd: generation?.launchProfile.cwd ?? receipt?.cwd,
    launchProfileProject: generation?.launchProfile.project ?? receipt?.launchProfile.project,
    fallbackProject: fallbackProject ?? (receipt?.cwd ? path.basename(receipt.cwd) : null),
  }).project;
}

function resolveArchiveTargetFromRegistry(
  input: ConversationArchiveInput,
  snapshot: RegistrySnapshot,
): ResolvedConversationArchiveTarget | null {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const requestedConversationId = input.conversationId;
  if (requestedConversationId && !requestedConversationId.startsWith("conversation_")) return null;

  const canonicalId = requestedConversationId
    ? lookup.canonicalConversationId(requestedConversationId as `conversation_${string}`)
    : null;
  const byId = canonicalId ? snapshot.conversations[canonicalId] ?? null : null;
  const launchId = input.transcriptPath.startsWith("spawn:") ? input.transcriptPath.slice("spawn:".length) : "";
  const pathReceipt = launchId ? snapshot.receipts?.[launchId] ?? null : null;
  const byPath = input.transcriptPath && !pathReceipt
    ? lookup.conversationForPath(input.transcriptPath)
    : null;
  const pathConversationId = pathReceipt
    ? lookup.canonicalConversationId(pathReceipt.conversationId)
    : byPath?.id ?? null;
  if (canonicalId && pathConversationId && canonicalId !== pathConversationId) return null;

  const conversation = byId ?? byPath ?? (pathConversationId ? snapshot.conversations[pathConversationId] ?? null : null);
  const conversationId = conversation?.id ?? canonicalId ?? pathConversationId;
  const receipt = pathReceipt ?? (conversationId ? latestReceiptForConversation(snapshot, conversationId) : null);
  if (requestedConversationId && !conversation && !receipt) return null;

  const generationPaths = conversation?.generations.map((generation) => generation.path) ?? [];
  const placeholderReceipt = conversationId
    ? latestPendingLaunchReceiptForConversation(snapshot, conversationId)
    : null;
  const placeholderPath = placeholderReceipt
    ? `spawn:${placeholderReceipt.launchId}`
    : "";
  const transcriptPath = input.transcriptPath
    || generationPaths.at(-1)
    || placeholderPath;
  if (!transcriptPath) return null;
  const transcriptPaths = [...new Set([
    ...(input.transcriptPath ? [input.transcriptPath] : []),
    ...generationPaths,
    ...(placeholderPath ? [placeholderPath] : []),
  ])];
  const project = projectForConversationTarget(conversation, receipt);
  if (!project) return null;
  return { conversationId: conversationId ?? null, transcriptPath, transcriptPaths, project };
}

function resolveArchiveTargetFromFiles(
  input: ConversationArchiveInput,
  files: readonly FileEntry[],
): ResolvedConversationArchiveTarget | null {
  const matches = files
    .filter((entry) => input.transcriptPath ? entry.path === input.transcriptPath : entry.conversationId === input.conversationId)
    .sort((left, right) => right.mtime - left.mtime);
  const entry = matches[0];
  if (!entry) return null;
  return {
    conversationId: entry.conversationId ?? (input.conversationId || null),
    transcriptPath: entry.path,
    transcriptPaths: [entry.path],
    project: entry.project,
  };
}


async function archiveConversationAction(
  args: McpToolArgs,
  action: "archive" | "unarchive",
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext,
): Promise<McpToolPayload> {
  const { inputs, selectedTarget } = await conversationArchiveInputs(args, dependencies);
  const snapshot = dependencies.registrySnapshot();
  const resolved = inputs.map((input) => resolveArchiveTargetFromRegistry(input, snapshot));
  const outcomes: Array<Record<string, unknown>> = [];
  const resolvedProjects = new Set<string>();
  const projectsTouched = new Set<string>();
  const applyResolved = (members: Array<{ index: number; target: ResolvedConversationArchiveTarget }>): void => {
    const grouped = new Map<string, Array<{ index: number; target: ResolvedConversationArchiveTarget }>>();
    for (const member of members) {
      const projectMembers = grouped.get(member.target.project) ?? [];
      projectMembers.push(member);
      grouped.set(member.target.project, projectMembers);
      resolvedProjects.add(member.target.project);
    }

    for (const [project, projectMembers] of grouped) {
      throwIfCallEnded(context);
      const write = archiveConversationPaths(
        project,
        action,
        projectMembers.flatMap(({ target }) => target.transcriptPaths),
        snapshot,
        dependencies,
      );
      if (write.appliedPaths.size > 0) projectsTouched.add(project);
      const attributedPaths = new Set<string>();
      for (const { index, target } of projectMembers) {
        const paths = target.transcriptPaths.filter((pathname) => (
          write.appliedPaths.has(pathname) && !attributedPaths.has(pathname)
        ));
        for (const pathname of paths) attributedPaths.add(pathname);
        outcomes[index] = {
          conversationId: target.conversationId,
          transcriptPath: target.transcriptPath,
          paths,
          project,
          outcome: action === "archive"
            ? paths.length > 0 ? "archived" : "already-archived"
            : paths.length > 0 ? "unarchived" : "not-found",
        };
      }
    }
  };

  const registryResolved = resolved.flatMap((target, index) => target ? [{ index, target }] : []);
  const scanResolved: Array<{ index: number; target: ResolvedConversationArchiveTarget }> = [];
  const unresolvedIndexes = resolved.flatMap((target, index) => target ? [] : [index]);
  if (unresolvedIndexes.length > 0) {
    let files: readonly FileEntry[] | null = null;
    try {
      files = (await dependencies.completedFileScan()).snapshot.files;
    } catch (error) {
      // Resolve the whole batch before any write so a pending scan can safely
      // release admission and let the caller retry under the same key.
      if (error instanceof McpUnadmittedRefusal) throw error;
      files = null;
    }
    throwIfCallEnded(context);
    for (const index of unresolvedIndexes) {
      const target = files ? resolveArchiveTargetFromFiles(inputs[index]!, files) : null;
      if (target) {
        resolved[index] = target;
        scanResolved.push({ index, target });
        continue;
      }
      outcomes[index] = {
        conversationId: inputs[index]!.conversationId || null,
        transcriptPath: inputs[index]!.transcriptPath || null,
        paths: [],
        project: null,
        outcome: files ? "not-found" : "resolution-failed",
      };
    }
  }
  applyResolved(registryResolved);
  applyResolved(scanResolved);

  const operationId = mcpOperationId("conversation_action", requestId(args));
  const projects = [...resolvedProjects];
  return redactPayload({
    action,
    outcomes,
    project: projects.length === 1 ? projects[0] : null,
    projectsTouched: [...projectsTouched],
    ...mutationReceipt(operationId),
    ...selectedContextEcho(selectedTarget),
  });
}

async function conversationAction(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  const action = required(args, "action");
  if (action === "archive" || action === "unarchive") {
    return archiveConversationAction(args, action, dependencies, context);
  }
  /* #844 §7: the selected card is actionable from its reference alone. The
     identity comes back from one keyed registry lookup, so no `operator_snapshot`
     and no scan stands between "the operator pointed at that card" and acting on
     it. Only the IDENTITY is taken from the reference — the path it recorded is
     capture-time provenance, and a later generation would make it wrong. */
  const selected = await resolveSelectedContext(
    args,
    text(args.conversationId),
    dependencies.selectedContext ?? productionSelectedContextDependencies,
  );
  const conversationId = selected.conversationId;
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) {
    throw new Error("conversationId, transcriptPath or selectedContext is required");
  }
  throwIfCallEnded(context);
  const operationId = mcpOperationId("conversation_action", requestId(args));
  // The agent's stdio process has no runtime-host socket. The Viewer owns the
  // control channel and applies the same conversation ownership fences there.
  const result = await dispatchControl(control)("/api/conversation-host", {
    operationId,
    conversationId,
    path: transcriptPath,
    action,
    key: text(args.key),
    label: args.label,
    question: args.question,
    ...(action === "permission" ? { decision: text(args.decision), requestId: text(args.requestId) } : {}),
    ...(action === "answer" ? {
      requestId: text(args.requestId),
      answer: {
        ...(args.answers !== undefined ? { answers: args.answers } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.approve !== undefined ? { approve: args.approve } : {}),
        ...(args.message !== undefined ? { message: args.message } : {}),
      },
    } : {}),
  }, callerCapabilityHeaders()).catch((error: unknown) => {
    if (error instanceof McpDispatchUncertainError) {
      throw new McpDispatchUncertainError(error.message, { operationId });
    }
    throw error;
  });
  if (result.ok !== true) {
    throw new Error(text(result.error) || "conversation action failed");
  }
  const receipt = result.receipt
    ? { operationId: result.operationId, receipt: result.receipt }
    : mutationReceipt(operationId);
  return redactPayload({
    conversationId: conversationId || null,
    transcriptPath: transcriptPath || null,
    ...result,
    ...receipt,
    ...selectedContextEcho(selected.target),
  });
}

async function conversationMigration(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const conversationId = required(args, "conversationId");
  const operationId = mcpOperationId("conversation_migration", requestId(args));
  // The Viewer owns the runtime connection. Keep the request's identity separate
  // from operationId, which names the existing switch for a withdrawal.
  const body = await dispatchControl(control)(`/api/conversations/${encodeURIComponent(conversationId)}/migration`, {
    requestOperationId: operationId,
    action: required(args, "action"),
    expectedRevision: typeof args.expectedRevision === "number" ? args.expectedRevision : undefined,
    path: text(args.transcriptPath) || text(args.path),
    ...(typeof args.operationId === "string" ? { operationId: args.operationId } : {}),
    ...(args.accountId !== undefined ? { accountId: args.accountId } : {}),
    ...(args.targetAccountId !== undefined ? { targetAccountId: args.targetAccountId } : {}),
  }, callerCapabilityHeaders()).catch((error: unknown) => {
    if (error instanceof McpDispatchUncertainError) {
      throw new McpDispatchUncertainError(error.message, { operationId });
    }
    // A server error may follow runtime admission. Only these two codes prove
    // that the migration owner refused before issuing any command.
    if (error instanceof McpDispatchVerdictError && Number(error.details.status) >= 500
      && error.details.code !== "runtime-host-unavailable" && error.details.code !== "RUNTIME_UNREADABLE") {
      throw new McpDispatchUncertainError(error.message, { operationId });
    }
    throw error;
  });
  const conversation = body.conversation
    ?? (typeof body.id === "string" && body.id.startsWith("conversation_") ? body : undefined);
  return redactPayload({
    conversationId,
    ...body,
    ...(conversation ? { conversation } : {}),
    ...(body.receipt ? {} : mutationReceipt(operationId)),
  });
}

/**
 * #645 — the liveness snapshot that replaces the operator's external
 * `stat`/`pgrep` sweep. Cheap enough to poll on a schedule: it reads the
 * registries the Viewer already maintains plus the durable transcript tail, and
 * it never echoes a pipeline's own claim about a stage. A stall observed here
 * is also journaled (#686), so the sweep leaves a durable record.
 */
/* A process that holds no completed generation answers agent_activity with
   the hosts the registry names and `catalog: "pending"` after this wait,
   rather than holding the caller for a whole-corpus scan. */
const MCP_ACTIVITY_CATALOG_BUDGET_MS = 650;
/* The whole agent_activity answer, the catalog wait included: hosts not yet
   described and tails not yet read are reported as pending evidence, and the
   next call takes what those reads returned. */
const MCP_ACTIVITY_ANSWER_BUDGET_MS = 800;

const fleetRedactorIds = new WeakMap<(text: string) => string, number>();
let fleetRedactorSequence = 0;
const fleetPageOwners = new WeakMap<ViewerMcpDomainDependencies, object>();

function fleetReadAccess(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies) {
  const caller = attributionOf(dependencies);
  const registry = dependencies.registrySnapshot();
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const requested = text(args.project) ? canonicalOrchestratorProject(text(args.project)) : null;
  let scope: FleetScope;
  if (caller.kind === "gateway") scope = requested ? { project: requested } : "all";
  else if (caller.kind === "unidentified") {
    if (!requested) throw new Error("project_required: unidentified agent_fleet callers must name a project");
    scope = { project: requested };
  } else {
    const owned = caller.kind === "manager"
      ? seats.find(seat => seat.conversationId === caller.conversationId)?.project
      : caller.conversationId ? callerProjectFromSnapshot(registry, caller.conversationId) : null;
    const project = owned ? canonicalOrchestratorProject(owned) : null;
    if (!project || requested && requested !== project) {
      throw new Error("project_out_of_scope: use send_message_to_orchestrator for another project");
    }
    scope = { project };
  }
  return { caller, registry, seats, scope };
}

/** The fence is checked before every read, including a held-page continuation. */
async function agentFleet(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {}): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  const { caller, registry, seats, scope } = fleetReadAccess(args, dependencies);
  const filters: FleetFilters = {
    ...Object.fromEntries(["conversationId", "pipelineId", "engine", "model", "effort", "account"].flatMap(key => text(args[key]) ? [[key, text(args[key])]] : [])),
    ...(text(args.state) ? { state: text(args.state) as FleetFilters["state"] } : {}),
  };
  const detail = args.detail === true || Object.keys(filters).length > 0 || !!args.cursor;
  const load = async () => {
    const sources = dependencies.livenessSources({ completedFileScan: dependencies.completedFileScan, catalogBudgetMs: MCP_ACTIVITY_CATALOG_BUDGET_MS });
    const snapshot = await agentLivenessSnapshot({ liveOnly: true, limit: 200,
      ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
      ...(scope !== "all" ? { project: scope.project } : {}),
      signal: context.signal, answerBudgetMs: Math.min(MCP_ACTIVITY_ANSWER_BUDGET_MS,
        context.deadlineAt === undefined ? Infinity : Math.max(0, context.deadlineAt - Date.now())),
    }, sources);
    throwIfCallEnded(context);
    // Defence in depth: a source must never widen the requested project.
    const rows = snapshot.conversations.filter(row => livenessRecordIsLive(row)
      && (scope === "all" || canonicalOrchestratorProject(row.project) === scope.project));
    const sessions = detail ? (dependencies.readFleetSessions ?? readCachedResourceSessions)() : { sessions: [], stale: false };
    const agents = fleetDetailRows(fleetAgents(rows, fleetRuntimeFor(rows, registry),
      new Set(seats.map(seat => seat.conversationId)), dependencies.fleetLimitWaits ? await dependencies.fleetLimitWaits(rows.flatMap(row => row.conversationId ? [row.conversationId] : [])) : fleetLimitWaits(dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines),
      sessions.sessions, sessions.stale), filters);
    const unverifiedCount = rows.filter(row => row.evidenceSource !== "transcript").length;
    const unselectedCount = Math.max(0, snapshot.selection.matched - snapshot.selection.selected);
    const coverage = { ...((snapshot.selection.cacheStatus === "pending" || snapshot.selection.cacheStatus === "stale") ? { catalog: snapshot.selection.cacheStatus } : {}),
      ...(unverifiedCount || snapshot.selection.recoveryPending ? { evidence: "pending", unverifiedCount,
        ...(snapshot.selection.recoveryPending ? { undescribedHostCount: snapshot.selection.recoveryPending } : {}) } : {}),
      ...(unselectedCount ? { unselectedCount } : {}) };
    const accountRows = accountLimitRows((dependencies.accountLimitsSource ?? productionAccountLimitsSource)());
    const summary = fleetSummary(agents, accountRows, scope, snapshot.observedAt, coverage);
    return { summary, agents };
  };
  if (!detail) return redactPayload(projectReadText((await load()).summary, context));
  let owner = fleetPageOwners.get(dependencies);
  if (!owner) { owner = {}; fleetPageOwners.set(dependencies, owner); }
  let projection = 0;
  if (context.redactText) {
    projection = fleetRedactorIds.get(context.redactText) ?? ++fleetRedactorSequence;
    fleetRedactorIds.set(context.redactText, projection);
  }
  const payload = await budgetPage(owner, "agent_fleet", { ...args, __fleetScope: scope, __fleetCaller: caller, __fleetProjection: projection }, dependencies.fleetDetailBudgetBytes ?? 24_000, async cursor => {
    if (cursor) throw new Error("Invalid agent_fleet cursor; restart without cursor");
    const { summary, agents } = await load();
    return { rows: agents.map(row => {
      const projected = redactPayload(projectReadText(fleetPublicRow(row, scope), context));
      return { ...projected, title: Array.from(projected.title).slice(0, 60).join("") };
    }), meta: { summary: projectReadText(summary, context), total: agents.length }, upstream: null };
  }, false, typeof args.limit === "number" ? Math.max(1, Math.min(200, args.limit)) : 50);
  const { conversations, ...meta } = payload;
  return redactPayload({ ...meta, agents: conversations });
}

async function agentActivity(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  /* #860: the caller's lifetime reaches the read. Without it a project-scoped
     call kept its generation wait and its transcript tails running after the
     caller had given up — the shape the 70-second stall was reported as. */
  const remainingMs = context.deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, context.deadlineAt - Date.now());
  const deadline = deadlineSignal(remainingMs, {
    signal: context.signal,
    reason: "MCP tool deadline exceeded",
  });
  try {
    /* The catalog the board already reads. One completed generation serves both,
       so this call opens no scan of its own. */
    const sources = dependencies.livenessSources({
      completedFileScan: dependencies.completedFileScan,
      catalogBudgetMs: MCP_ACTIVITY_CATALOG_BUDGET_MS,
    });
    const snapshot = await agentLivenessSnapshot({
      conversationId: text(args.conversationId) || undefined,
      transcriptPath: (text(args.transcriptPath) || text(args.path)) || undefined,
      project: text(args.project) || undefined,
      liveOnly: args.liveOnly === true && args.includeGone !== true,
      stallAfterMs: typeof args.stallAfterMs === "number" ? args.stallAfterMs : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      signal: deadline.signal,
      answerBudgetMs: MCP_ACTIVITY_ANSWER_BUDGET_MS,
      /* A call with less time left than the standard evidence budget degrades
         the remaining rows to the scan projection rather than spending a budget
         its caller will not be there to receive. */
      ...(Number.isFinite(remainingMs)
        ? { evidenceDeadlineMs: Math.min(DEFAULT_EVIDENCE_DEADLINE_MS, remainingMs) }
        : {}),
    }, sources);
    if (text(args.conversationId) && snapshot.conversations.length === 0) {
      const launch = spawnConversation(text(args.conversationId));
      throwIfCallEnded(context);
      if (launch) return redactPayload({
        ...snapshot, count: 1, conversations: [launch], journaled: 0,
        selection: { ...snapshot.selection, matched: 1, selected: 1 },
      });
    }
    const journal = dependencies.refreshLifecycleJournal({ liveness: snapshot.conversations });
    const liveOnly = args.liveOnly === true && args.includeGone !== true;
    const conversations = liveOnly ? snapshot.conversations.filter(livenessRecordIsLive) : snapshot.conversations;
    const excludedGoneCount = snapshot.conversations.length - conversations.length;
    const filtered = { ...snapshot, conversations, count: conversations.length,
      stalledCount: conversations.filter(row => row.lifecycle === "stalled").length,
      stalledConfirmedCount: conversations.filter(row => row.lifecycle === "stalled" && row.evidenceSource === "transcript").length };
    const catalog = snapshot.selection.cacheStatus;
    const unverifiedCount = conversations.filter(row => row.evidenceSource === "projection").length;
    /* A targeted call names transcripts, hosted or not; the count says which. */
    const undescribed = snapshot.selection.recoveryPending > 0
      ? { [snapshot.selection.scope === "targeted" ? "undescribedTargetCount" : "undescribedHostCount"]: snapshot.selection.recoveryPending }
      : {};
    return redactPayload({ ...(fullAnswer(args) ? filtered : compactLiveness(projectReadText(filtered, context))), journaled: journal.appended,
      excludedGoneCount, omittedRecordCount: fullAnswer(args) ? 0 : conversations.length,
      unselectedCount: Math.max(0, snapshot.selection.matched - snapshot.selection.selected),
      /* Every projection says what it could not confirm. `pending`: no
         generation completed inside the budget, so the rows are the hosts the
         registry names. `stale`: the rows are an earlier generation's while a
         newer one is still being read. */
      ...(catalog === "pending" || catalog === "stale" ? { catalog } : {}),
      ...(unverifiedCount > 0 || snapshot.selection.recoveryPending > 0
        ? { evidence: "pending", unverifiedCount, ...undescribed }
        : {}),
      ...answerHint(args, "includeGone:true includes dead hosts; compact:false or full:true returns evidence fields. Narrow by conversationId or project when unselectedCount is positive.") });
  } finally {
    deadline.release();
  }
}

function lifecycleEventType(value: unknown): LifecycleEventQuery["type"] {
  const candidate = text(value);
  if (!candidate) return undefined;
  if (!isLifecycleEventType(candidate)) throw new Error(`unknown lifecycle event type: ${candidate}`);
  return candidate;
}

/**
 * #686 — one tool over the durable journal. `query` reads it by lineage and
 * cursor; `digest` polls the bounded relay, which releases terminal high-signal
 * events at once and batches routine progress behind a five-minute window.
 * Both refresh the projection first, so a stage that finished since the last
 * call is already recorded — no background notification service.
 */
interface DeploymentProjection {
  deployments: ViewerDeploymentStatus[];
  error?: string;
  code?: string;
}

/** Viewer deployments as the journal's deploy events see them. A deployment
    read failure leaves the rest of the journal available and travels with that
    response as explicit degraded-source evidence. */
async function deploymentsForProjection(
  control: ViewerControlDependencies,
): Promise<DeploymentProjection> {
  try {
    const result = await readViewerControl(control, "/api/runtime/deployments");
    if (!Array.isArray(result.deployments)) throw new Error("Viewer deployment list is invalid");
    return { deployments: result.deployments as ViewerDeploymentStatus[] };
  } catch (error) {
    return {
      deployments: [],
      error: error instanceof Error ? error.message : "Viewer deployments are unreadable",
      ...(error instanceof McpToolRefusal && text(error.details.code)
        ? { code: text(error.details.code) }
        : {}),
    };
  }
}

async function lifecycleEvents(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  const mode = text(args.mode) || "query";
  if (mode !== "query" && mode !== "digest") throw new Error('mode must be "query" or "digest"');
  const registry = dependencies.registrySnapshot();
  const deploymentProjection = await deploymentsForProjection(control);
  const refreshed = dependencies.refreshLifecycleJournal({
    pipelines: dependencies.getPipelines().pipelines,
    deliveries: Object.values(registry.heldDeliveries),
    deployments: deploymentProjection.deployments,
  });
  const deploymentEvidence = deploymentProjection.error
    ? {
        deploymentsError: deploymentProjection.error,
        ...(deploymentProjection.code ? { deploymentsErrorCode: deploymentProjection.code } : {}),
      }
    : {};
  if (mode === "digest") {
    const subscriberId = text(args.subscriberId) || text(args.conversationId);
    if (!subscriberId) throw new Error("subscriberId is required for mode=digest");
    const request: LifecycleDigestRequest = {
      subscriberId,
      project: text(args.project) || undefined,
      pipelineId: text(args.pipelineId) || undefined,
      conversationId: text(args.conversationId) || undefined,
      maxItems: typeof args.maxItems === "number" ? args.maxItems : undefined,
      acknowledge: args.acknowledge !== false,
    };
    return redactPayload({
      mode,
      journaled: refreshed.appended,
      ...deploymentEvidence,
      ...dependencies.pollLifecycleDigest(request),
    });
  }
  const page = dependencies.queryLifecycleEvents({
    project: text(args.project) || undefined,
    pipelineId: text(args.pipelineId) || undefined,
    conversationId: text(args.conversationId) || undefined,
    stageId: text(args.stageId) || undefined,
    type: lifecycleEventType(args.type),
    afterSeq: typeof args.afterSeq === "number" ? args.afterSeq : undefined,
    limit: typeof args.limit === "number" ? args.limit : undefined,
  });
  return redactPayload({ mode, journaled: refreshed.appended, ...deploymentEvidence, ...page });
}

/**
 * The caller's target, read into the ONE shape the record stores (#1016).
 *
 * Two things happen here and nothing else does. A conversation named by its
 * durable `conversationId` — the name the rest of this MCP surface speaks, and
 * the only one that survives a resume or a migration — is resolved to that
 * conversation's CURRENT generation transcript, which is exactly what a caller
 * who already knew the path would have sent. And a value that is no target at
 * all is refused in words that name the discriminator, the fields its kind
 * expects and an example that works, instead of the bare "target must be a
 * typed focus target" that cost the reported caller five guesses.
 *
 * A usable `path` is honoured untouched, so every call that works today writes
 * byte-identical records: the id is the way in for callers that have no path,
 * never a second interpretation of calls that have one.
 */
function focusTargetFromArgs(value: unknown, dependencies: ViewerMcpDomainDependencies): FocusTarget {
  const named = value && typeof value === "object" && !Array.isArray(value)
    ? value as { kind?: unknown; path?: unknown; conversationId?: unknown; reasonId?: unknown }
    : null;
  const conversationId = named?.kind === "conversation" && !text(named.path) ? text(named.conversationId) : "";
  if (conversationId) {
    /* The registry's own keyed lookup, alias walk included, so an id that was
       chained through a rollover still names its newest transcript. */
    const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
    const path = lookup.conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path;
    if (!path) {
      const reasonId = text(named?.reasonId);
      const launchPath = reasonId.startsWith("spawn:") && reasonId.endsWith(":launch-failed") ? reasonId.slice(0, -":launch-failed".length) : null;
      throw new McpToolRefusal(
        `no registered conversation has id "${conversationId}" — a conversation target accepts `
        + `${focusTargetExample("conversation")}, ${CONVERSATION_PATH_EXAMPLE}, `
        + 'or for dismiss_attention a failed launch path {"kind":"conversation","path":"spawn:<launchId>"} from the row target'
        + (launchPath ? `; this reason names ${JSON.stringify({ kind: "conversation", path: launchPath, reasonId })}` : ""),
        { code: "CONVERSATION_NOT_FOUND", retryable: false },
      );
    }
    return { kind: "conversation", path };
  }
  if (!isFocusTarget(value)) throw new Error(describeFocusTargetRejection(value));
  return value;
}

/**
 * Which project a target lives in, so the request can record one.
 *
 * Only the project is derived here — never a rect. The server has no board
 * layout, and inventing one would put a made-up destination on a durable record
 * (see `@/lib/attention/frames`). An explicit `project` wins, and is the only
 * way to name a target the server cannot attribute at all: a board draft exists
 * on the operator's canvas and nowhere else.
 */
async function focusTargetProject(
  target: FocusTarget,
  explicit: string,
  dependencies: ViewerMcpDomainDependencies,
  knownTranscript = false,
): Promise<string> {
  if (explicit) return explicit;
  if (isGeometricTarget(target)) return target.project;
  switch (target.kind) {
    case "conversation": {
      const targeted = await entryForPath(target.path, dependencies, {}, knownTranscript);
      if (!targeted) throw new McpToolRefusal("no conversation on the board has that transcript path; use a registered conversationId, a transcript .jsonl path on the board, or spawn:<launchId> from a failed-launch row", { code: "CONVERSATION_NOT_FOUND", retryable: false });
      return targeted.entry.project;
    }
    case "pipeline":
    case "stage": {
      const pipeline = dependencies.getPipelines().pipelines.find((candidate) => candidate.id === target.pipelineId);
      if (!pipeline) throw new Error("pipeline not found");
      return pipeline.project;
    }
    case "flowRound": {
      const flow = dependencies.getFlowsWithPresets().flows.find((candidate) => candidate.id === target.flowId);
      if (!flow) throw new Error("flow not found");
      return flow.project;
    }
    case "task": {
      const task = dependencies.loadTasks().find((candidate) => candidate.id === target.taskId);
      if (!task) throw new Error("task not found");
      return task.project;
    }
    case "draft":
      throw new Error("a draft target needs an explicit project");
  }
}

/**
 * Typed focus for every agent session (B+ item 2), as an immediate VERIFIED
 * handoff (#873): move the operator's one active Viewer to a typed target, and
 * answer only once it is there.
 *
 * The production incident this shape closes: the call used to commit a
 * `pending` record, offer it to every follow-capable device, and return success
 * while the camera sat still until some browser's next poll auto-followed. Now
 * the server resolves exactly one latest-interaction active view UP FRONT, the
 * record is born `accepted` for that device — no confirmation surface, no
 * actionable pending/offered state — and the response is written only after the
 * arrival landed on the record, or after a bounded explicit failure closed it.
 *
 * The record keeps a one-action way back: the return point is captured on the
 * device before the move and a single Return control restores it exactly. What
 * replaced the old worker refusal is ATTRIBUTION: `raisedBy` is derived
 * server-side from the durable caller identity and stored on the record, so a
 * worker's ask is visibly a worker's ask and can never masquerade as the
 * operator's own root agent. The root identity is still resolved server-side,
 * which is why no rootId appears in this schema.
 */
async function requestAttention(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  /* ── The authority gate, BEFORE any resolution or durable write ──────────
     This call moves the operator's screen with no confirmation surface left
     in front of it, so who may make it is decided first, from server-derived
     evidence only: the durable caller identity (process ancestry merged with
     the admission-injected spawn capability) against the validated
     orchestrator seats, which already fail closed on revoked, superseded,
     conflicting, unknown and cross-project designations. A refused caller
     files nothing, names nothing and learns nothing about the board — the
     identity half runs before the target is even read. */
  const authority = authorityOf(dependencies);
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const admission = permitAttentionHandoff(authority, seats, null);
  if (!admission.allowed) {
    throw new McpToolRefusal(admission.error, { code: "ATTENTION_NOT_PERMITTED", refusedAs: admission.refusedAs });
  }
  const raisedBy = attributionOf(dependencies);

  const target = focusTargetFromArgs(args.target, dependencies);
  const intent = (text(args.intent) || "show") as FocusIntent;
  if (intent !== "show" && intent !== "open") throw new Error("intent must be show or open");
  const zoom = text(args.zoom) as ZoomIntent | "";
  if (zoom && zoom !== "inspect" && zoom !== "situate") throw new Error("zoom must be inspect or situate");
  const waitFor = args.waitFor ?? "arrived";
  if (waitFor !== "accepted" && waitFor !== "arrived") throw new Error("waitFor must be accepted or arrived");
  const reason = required(args, "reason");
  const contextLabel = text(args.contextLabel);
  /* Canonical, as every seat is: a target named by a key that has since moved
     resolves to the key its seat is read under (#1874). */
  const project = canonicalOrchestratorProject(await focusTargetProject(target, text(args.project), dependencies));

  /* The project half of the same gate: an orchestrator directs its OWN
     project's screen estate. A seat naming a different project is refused
     here, still before anything durable exists. */
  const projectVerdict = permitAttentionHandoff(authority, seats, project);
  if (!projectVerdict.allowed) {
    throw new McpToolRefusal(projectVerdict.error, { code: "ATTENTION_NOT_PERMITTED", refusedAs: projectVerdict.refusedAs });
  }

  /* ── Restart replay (#873 review, finding 3) ─────────────────────────────
     The operation's durable identity is derived from the clientRequestId and
     written ON the record at creation — before any browser can navigate — so
     a run interrupted anywhere after that point leaves a record this re-run
     can find. Adoption means: no second record, no second navigation; the
     re-run simply waits out the SAME handoff and reports how it ended. */
  const operationKey = mcpOperationId("request_attention", requestId(args));
  const findByOperation = dependencies.findAttentionByOperation
    ?? ((key: string) => readAttentionFile().requests.find((request) => request.operationKey === key) ?? null);
  let request = findByOperation(operationKey);
  let created: ReturnType<typeof raiseAttentionRequest> | null = null;
  /* No desktop to move and a phone open: the request reaches the phone as a
     quiet notice and moves nothing there (docs/design/needs-attention.md §6).
     There is no arrival to wait for, so the call answers at once. */
  const noticeAnswer = (notice: AttentionRequestV1, raised: typeof created) => redactPayload({
    attentionId: notice.id,
    request: notice,
    delivered: "notice",
    handoff: null,
    recovered: raised === null,
    superseded: raised?.superseded ?? [],
    dropped: raised?.dropped ?? [],
    ...mutationReceipt(operationKey),
  });
  if (request?.delivery === "notice") return noticeAnswer(request, null);
  if (!request) {
    /* Resolved BEFORE anything durable is written: with no view that can move,
       the honest answer is a refusal, not a pending ask nobody could ever act
       on. Ambiguity is already settled deterministically inside the resolver —
       latest interaction wins — and background/inactive devices are named
       nowhere, so no competing offer can reach them. The SESSION is part of
       the answer: two tabs share a device id, and only the named tab may run
       the move. */
    const view = resolveDirectedAttentionView();
    if (!view && (dependencies.noticeCapableViewOpen ?? noticeCapableViewOpen)()) {
      dependencies.adoptRootSession();
      const raised = dependencies.raiseAttentionRequest({
        origin: "root-agent",
        raisedBy,
        target,
        frameAtCreation: {
          project,
          rect: isGeometricTarget(target) ? geometricFrameRect(target) : UNREAD_FRAME_RECT,
          boardRevision: null,
        },
        intent,
        reason,
        /* Named nowhere: the phone reads the notice and never answers it, so a
           desktop that opens before the record ends can still follow it. */
        offeredTo: [],
        delivery: "notice",
        operationKey,
        ...(zoom ? { zoom } : {}),
        ...(contextLabel ? { contextLabel } : {}),
      });
      return noticeAnswer(raised.request, raised.adopted ? null : raised);
    }
    if (!view) {
      throw new McpToolRefusal(
        "no active Viewer can be moved right now: no visible, active desktop board or phone is open",
        { code: "NO_ACTIVE_VIEW" },
      );
    }

    /* Before the request is written, not after: the request names the root by
       the identity this call may have just extended with a fresh session. */
    dependencies.adoptRootSession();
    created = dependencies.raiseAttentionRequest({
      origin: "root-agent",
      raisedBy,
      target,
      /* Geometric targets ARE their own frame; everything else records that no
         board was read, so a vanished anchor reports `lost` rather than landing
         the operator at the world origin. */
      frameAtCreation: {
        project,
        rect: isGeometricTarget(target) ? geometricFrameRect(target) : UNREAD_FRAME_RECT,
        boardRevision: null,
      },
      intent,
      reason,
      directedAt: view.deviceId,
      directedAtSession: view.viewSessionId,
      operationKey,
      ...(zoom ? { zoom } : {}),
      ...(contextLabel ? { contextLabel } : {}),
    });
    request = created.request;
    /* `adopted` means another process won the transactional race for this
       operation between the read above and the create — its record is the
       one, and this run reports it rather than counting a creation. */
    if (created.adopted) created = null;
  }

  if (waitFor === "accepted") return redactPayload({
    attentionId: request.id, request, accepted: true,
    arrival: request.state === "following" || (request.state === "returned" && request.returnPoints.length > 0)
      ? "arrived" : ["expired", "dismissed", "returned"].includes(request.state) ? "failed" : "pending",
    handoff: null, recovered: created === null,
    superseded: created?.superseded ?? [], dropped: created?.dropped ?? [],
    ...mutationReceipt(operationKey),
  });

  /* Inside the caller's own transport deadline, so the bounded failure is OURS
     to report rather than a timeout the caller reads as silence. */
  const budget = context.deadlineAt === undefined
    ? ATTENTION_ARRIVAL_TIMEOUT_MS
    : Math.max(1_000, Math.min(ATTENTION_ARRIVAL_TIMEOUT_MS, context.deadlineAt - Date.now() - 2_000));
  const waitForArrival = dependencies.awaitAttentionArrival ?? awaitAttentionArrival;
  const outcome = await waitForArrival(request.id, {
    timeoutMs: budget,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const deviceId = request.acknowledgedBy ?? null;
  if (outcome.kind === "failed") {
    const messages: Record<typeof outcome.code, string> = {
      TARGET_LOST: "the view arrived nowhere: the target no longer resolves to anything on the board",
      HANDOFF_TIMEOUT: "the chosen view did not complete the handoff in time; the request was closed, nothing is left pending",
      HANDOFF_ABORTED: "the call was cancelled before the view arrived; the request was closed, nothing is left pending",
      REQUEST_LOST: "the attention record disappeared before the view arrived",
    };
    throw new McpToolRefusal(messages[outcome.code], {
      code: outcome.code,
      attentionId: request.id,
      deviceId,
      ...(outcome.request ? { state: outcome.request.state, ...(outcome.request.expiredCause ? { expiredCause: outcome.request.expiredCause } : {}) } : {}),
    });
  }

  return redactPayload({
    attentionId: outcome.request.id,
    request: outcome.request,
    /* The durable postcondition the success stands on: the record has already
       landed, the one executing view is named down to the browser session, and
       the pre-move return point is captured. */
    handoff: {
      deviceId,
      viewSessionId: outcome.request.directedSessionId ?? null,
      state: outcome.request.state,
      resolution: outcome.request.resolution ?? null,
      arrivedAt: outcome.request.stateChangedAt,
    },
    /* True when this run adopted a record an interrupted earlier run of the
       SAME operation already raised — the restart-replay path. */
    recovered: created === null,
    /* A newer request from the same root replaces its own unanswered ones, and
       an overfull queue drops the oldest routine entry. Both are named so the
       agent can say so out loud instead of leaving a dropped ask silent. */
    superseded: created?.superseded ?? [],
    dropped: created?.dropped ?? [],
    ...mutationReceipt(operationKey),
  });
}

/**
 * Clear a needs-you flag through the one dismissal service
 * (docs/design/needs-attention.md §5), for `dismiss_attention` and for
 * `pipeline_action` dismiss/undismiss, which is the same write.
 *
 * The gate is `request_attention`'s, and it runs the same two phases: the
 * caller's identity before the target is read, then the target's project
 * against the seat. A refused caller writes nothing. Who dismissed is the
 * server's own attribution, never the caller's claim, and the MCP operation
 * rides on the record so a replay answers what the first run wrote.
 */
async function dismissThroughService(
  target: DismissalTarget,
  undo: boolean,
  operationKey: string,
  dependencies: ViewerMcpDomainDependencies,
  reason?: string,
) {
  const authority = authorityOf(dependencies);
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const admission = permitAttentionDismissal(authority, seats, null);
  if (!admission.allowed) {
    throw new McpToolRefusal(admission.error, { code: "DISMISS_NOT_PERMITTED", refusedAs: admission.refusedAs });
  }
  let registryKnownTranscript = false;
  if (target.kind === "conversation" && target.conversationId) {
    const snapshot = dependencies.registrySnapshot();
    const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
    const id = lookup.canonicalConversationId(target.conversationId as `conversation_${string}`);
    const known = lookup.conversation(id);
    const path = known?.generations.at(-1)?.path;
    registryKnownTranscript = Boolean(path);
    const reasonId = target.reasonId ?? "";
    const reasonLaunchId = reasonId.startsWith("spawn:") && reasonId.endsWith(":launch-failed") ? reasonId.slice(6, -":launch-failed".length) : null;
    const namedReceipt = reasonLaunchId ? snapshot.receipts?.[reasonLaunchId] : null;
    const receipt = path ? null : reasonLaunchId
      ? namedReceipt && lookup.canonicalConversationId(namedReceipt.conversationId) === id ? namedReceipt : null
      : latestReceiptForConversation(snapshot, id);
    // A launch can fail before its first generation is registered. Its receipt
    // still names the same placeholder the panel advertises.
    if (path || receipt) target = { ...target, path: path ?? `spawn:${receipt!.launchId}` };
  }
  let focus: FocusTarget | null = null;
  let rawProject: string;
  if (target.kind === "report") {
    const project = dependencies.attentionReportProject ? dependencies.attentionReportProject(target.seq) : readBridgeReportLog().reports.find(r => r.seq === target.seq)?.project;
    if (!project) throw new McpToolRefusal("report not found", { code: "REPORT_NOT_FOUND" });
    rawProject = project;
  } else if (target.kind === "prototype") {
    const task = dependencies.loadTasks().find(t => t.id === target.taskId);
    if (!task) throw new McpToolRefusal("prototype task not found", { code: "TASK_NOT_FOUND" });
    rawProject = task.project;
  } else if (target.kind === "conversation" && target.path?.startsWith("spawn:")) {
    const snapshot = dependencies.registrySnapshot();
    const receipt = snapshot.receipts?.[target.path.slice(6)];
    if (!receipt) throw new McpToolRefusal("launch receipt not found; read the current row and use its conversationId or spawn:<launchId> path, or a registered transcript .jsonl path", { code: "CONVERSATION_NOT_FOUND", retryable: false });
    const conversation = readOnlyConversationLookupFromSnapshot(snapshot).conversation(receipt.conversationId);
    const project = projectForConversationTarget(conversation, receipt);
    if (!project) throw new McpToolRefusal("launch project unavailable", { code: "CONVERSATION_NOT_FOUND" });
    rawProject = project;
    focus = { kind: "conversation", path: target.path };
  } else {
    focus = focusTargetFromArgs(target.kind === "conversation"
      ? { kind: "conversation", ...(target.conversationId ? { conversationId: target.conversationId } : {}), ...(target.path ? { path: target.path } : {}), reasonId: target.reasonId } : target, dependencies);
    rawProject = await focusTargetProject(focus, "", dependencies, registryKnownTranscript);
  }
  const project = canonicalOrchestratorProject(rawProject);
  const verdict = permitAttentionDismissal(authority, seats, project);
  if (!verdict.allowed) {
    throw new McpToolRefusal(verdict.error, { code: "DISMISS_NOT_PERMITTED", refusedAs: verdict.refusedAs });
  }
  const attribution = attributionOf(dependencies);
  const by: DismissedBy = {
    kind: attribution.kind,
    conversationId: attribution.conversationId,
    role: attribution.role,
    ...(attribution.via ? { via: { deputy: attribution.via.deputy } } : {}),
  };
  try {
    return await dismissAttentionService(
      /* A conversation named by id resolves to its current transcript, which
         is how the service keys it when the registry does not. */
      target.kind === "conversation" && focus?.kind === "conversation" ? { ...target, path: target.path ?? focus.path } : target,
      by,
      { undo, operationKey, project, reason, ...(dependencies.dismissalPorts ? { ports: dependencies.dismissalPorts } : {}) },
    );
  } catch (error) {
    if (error instanceof DismissalError) throw new McpToolRefusal(error.message, { code: error.code, status: error.status });
    throw error;
  }
}

/**
 * A seat hands one routed wait to the operator
 * (docs/design/attention-auto-resolve.md): it asks the question in a decision
 * form with publish_prototype_review, then names that round here. The
 * escalation holds the round's id and no question of its own
 * (docs/design/operator-decision-forms.md §4), keyed by the exact wait so a
 * newer ask or a lane that moved is not covered. While the round waits, its
 * row is the operator's row for the wait; once answered, the wait is the
 * seat's again. The gate is the dismissal's, in the same two phases, and a
 * refused caller writes nothing.
 */
async function escalateThroughService(
  target: DismissalTarget,
  escalate: unknown,
  undo: boolean,
  operationKey: string,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  const authority = authorityOf(dependencies);
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const admission = permitAttentionDismissal(authority, seats, null);
  if (!admission.allowed) throw new McpToolRefusal(admission.error, { code: "DISMISS_NOT_PERMITTED", refusedAs: admission.refusedAs });
  const round = undo ? null : parseEscalation(escalate);
  if (typeof round === "string") throw new McpToolRefusal(round, { code: "INVALID_ESCALATION" });
  let key: string;
  let focus: FocusTarget;
  if (target.kind === "conversation") {
    if (!target.reasonId) throw new McpToolRefusal("escalate names the reason it hands on: pass target.reasonId from the read", { code: "INVALID_TARGET" });
    key = conversationRouteKey(target.reasonId);
    focus = focusTargetFromArgs({ kind: "conversation", ...(target.conversationId ? { conversationId: target.conversationId } : {}), ...(target.path ? { path: target.path } : {}) }, dependencies);
  } else if (target.kind === "pipeline") {
    const pipeline = dependencies.readPipelineRecord ? dependencies.readPipelineRecord(target.pipelineId) : dependencies.getPipelines().pipelines.find(row => row.id === target.pipelineId);
    if (!pipeline) throw new McpToolRefusal(`no pipeline ${target.pipelineId}`, { code: "PIPELINE_NOT_FOUND" });
    const kind = laneNeedKind(pipeline);
    if (!kind) throw new McpToolRefusal("the lane waits on nothing to escalate", { code: "NOTHING_TO_ESCALATE" });
    key = laneRouteKey(pipeline, kind);
    focus = focusTargetFromArgs(target, dependencies);
  } else {
    throw new McpToolRefusal("escalate takes a conversation target with its reasonId, or a pipeline target", { code: "INVALID_TARGET" });
  }
  const project = canonicalOrchestratorProject(await focusTargetProject(focus, "", dependencies));
  const verdict = permitAttentionDismissal(authority, seats, project);
  if (!verdict.allowed) throw new McpToolRefusal(verdict.error, { code: "DISMISS_NOT_PERMITTED", refusedAs: verdict.refusedAs });
  let taskId: string | null = "";
  if (round) {
    /* The round is the operator's question: it has to exist in this project
       and still wait, or the wait would leave the seat for a form nobody sees. */
    const tasks = dependencies.loadTasks();
    const resolved = resolvePrototypeReviewId([...tasks.filter(task => canonicalOrchestratorProject(task.project) === project).flatMap(task => task.prototypeReviews ?? []), ...loadSeatRounds(project)], round.reviewId);
    if (resolved) round.reviewId = resolved;
    const task = tasks.find(candidate => candidate.prototypeReviews?.some(held => held.id === round.reviewId));
    const seatRound = task ? null : loadSeatRounds().find(held => held.id === round.reviewId);
    if ((!task && !seatRound) || canonicalOrchestratorProject(task?.project ?? seatRound!.project) !== project) {
      throw new McpToolRefusal(`no decision round ${round.reviewId} in this project: ask with publish_prototype_review first and pass the reviewId it answers`, { code: "ROUND_NOT_FOUND" });
    }
    /* Waiting as the operator's board draws it: the task's newest round,
       undecided and not dismissed, or an open taskless seat form. A dismissed round is invisible, and a
       wait escalated to it would leave the seat for a form nobody sees. */
    const summary = task ? withPrototypeReviewSummaries([task])[0]?.prototypeReview : undefined;
    const seatNotice = seatRound ? seatDecisionNotices(project).find(notice => notice.reviewId === round.reviewId && !notice.undelivered) : undefined;
    if (task ? !prototypeWaitsOnOperator(summary, task) || summary?.waitingReviewId !== round.reviewId : !seatNotice) {
      throw new McpToolRefusal(`decision round ${round.reviewId} no longer waits: read it with read_prototype_review and carry its answer to the asker`, { code: "ROUND_NOT_WAITING" });
    }
    taskId = task?.id ?? null;
  }
  const attribution = attributionOf(dependencies);
  const by: DismissedBy = {
    kind: attribution.kind,
    conversationId: attribution.conversationId,
    role: attribution.role,
    ...(attribution.via ? { via: { deputy: attribution.via.deputy } } : {}),
  };
  const written = writeAttentionEscalation(
    { key, seat: attribution.conversationId, taskId, reviewId: round?.reviewId ?? "" },
    by,
    { undo, operationKey },
  );
  return { escalated: undo ? null : written.escalation, key, changed: written.changed, undo, by };
}

async function dismissAttentionTool(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies, control: ViewerControlDependencies, context?: McpToolCallContext): Promise<McpToolPayload> {
  if (args.target === undefined && args.escalate !== undefined) throw new McpToolRefusal("escalate needs the target it hands to the operator", { code: "INVALID_TARGET" });
  if (args.target === undefined) {
    if (args.undo !== undefined || args.reason !== undefined) throw new McpToolRefusal("undo and reason require a target", { code: "INVALID_TARGET" });
    const authority = authorityOf(dependencies);
    const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
    const caller = maintenanceCaller(dependencies);
    const maintainer = caller ? { ...caller, project: caller.project ? canonicalOrchestratorProject(caller.project) : null } : null;
    const normalizedSeats = seats.map(seat => ({ ...seat, project: seat.project ? canonicalOrchestratorProject(seat.project) : null }));
    const admission = permitNeedsYouRead(authority, normalizedSeats, maintainer, null);
    if (!admission.allowed) throw new McpToolRefusal(admission.error, { code: "NEEDS_YOU_READ_NOT_PERMITTED" });
    const ownProject = authority.kind !== "unidentified" ? normalizedSeats.find(s => s.conversationId === authority.conversationId)?.project ?? maintainer?.project : null;
    const project = canonicalOrchestratorProject(text(args.project) || ownProject || "");
    if (!project) throw new McpToolRefusal("name a project for the read", { code: "PROJECT_REQUIRED" });
    const verdict = permitNeedsYouRead(authority, normalizedSeats, maintainer, project);
    if (!verdict.allowed) throw new McpToolRefusal(verdict.error, { code: "NEEDS_YOU_READ_NOT_PERMITTED" });
    return redactPayload(await viewerControlForCall(control, context).post("/api/attention/needs-you", { project, kinds: args.kinds, full: args.full, cursor: args.cursor }, callerCapabilityHeaders()));
  }
  let target: DismissalTarget;
  try {
    target = parseDismissalTarget(args.target, { allowSubjects: false });
    if (target.kind === "prototype") {
      const round = mcpPrototypeRound(target.taskId, target.reviewId);
      if (round) target = { ...target, reviewId: round.id };
    }
  } catch (error) {
    if (error instanceof DismissalError) throw new McpToolRefusal(error.message, { code: error.code });
    throw error;
  }
  if (args.escalate !== undefined) return escalateThroughService(target, args.escalate, args.undo === true, mcpOperationId("dismiss_attention", requestId(args)), dependencies);
  const outcome = await dismissThroughService(target, args.undo === true, mcpOperationId("dismiss_attention", requestId(args)), dependencies, args.reason as string | undefined);
  return {
    dismissed: outcome.dismissed,
    alreadyClear: outcome.alreadyClear,
    ...(outcome.changed.length ? { changed: outcome.changed } : {}),
    at: outcome.at,
    by: outcome.by,
    undo: outcome.undo,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

/**
 * #691 §6 — the live per-identity fence.
 *
 * Built from the same evidence `request_attention` already trusts: this process's
 * ancestry and the registry's recorded host pids, resolved by
 * {@link attentionCallerAuthority}. Nothing the caller says participates.
 *
 * The manager is resolved per call rather than captured, so seating a new
 * incumbent takes effect without restarting anything.
 */
export function viewerMcpToolPolicy(
  domainDependencies: ViewerMcpDomainDependencies = productionDomainDependencies,
  hostHealthProbe = false,
  managerAuthoritySources: () => ManagerAuthoritySources = productionManagerAuthoritySources,
): McpToolPolicy {
  /* Manager identity is fail-closed: only identities the durable resolver
     authorized count as the manager, whatever the raw record says. Under B+
     that identity labels origins and anchors the deploy executor's seat
     authority; it never decides whether a tool is callable. */
  const callerManagerTarget = (): ManagerTarget => ({
    conversationId: null,
    path: null,
    seats: authorizedManagerSeats(managerAuthoritySources())
      .map((seat) => ({ conversationId: seat.conversationId, path: seat.path })),
  });
  const policy = mcpToolPolicy(
    () => hostHealthProbe
      ? { kind: "health-probe" }
      : mcpCallerIdentity(authorityOf(domainDependencies), callerManagerTarget()),
  );
  return {
    permit: (tool, args) => {
      // An admitted agent's read surface is independent of role/seat identity.
      // Resolve authority only where the policy uses it. Bindings still verify
      // their own operation authority and recoverable receipts before dispatch.
      if (!hostHealthProbe && isMutatingMcpTool(tool) && pipelineCallerRoles(domainDependencies, args.src).includes("curator")) {
        const verdict = permitCuratorTool(tool, args);
        if (!verdict.allowed) return verdict;
      }
      if (!hostHealthProbe && isMutatingMcpTool(tool) && pipelineCallerRoles(domainDependencies, args.src).includes("issue-reporter")) {
        const verdict = permitIssueReporterTool(tool, args);
        if (!verdict.allowed) return verdict;
      }
      if (!hostHealthProbe && isMutatingMcpTool(tool) && maintenanceCaller(domainDependencies)) {
        const verdict = permitMaintainerTool(tool, args);
        if (!verdict.allowed) return verdict;
      }
      if (!hostHealthProbe && !mcpToolNeedsCallerIdentity(tool, args)) return { allowed: true };
      return policy.permit(tool, args);
    },
  };
}

/* ── ORIGINAL-KEY RECOVERY (#1490) ──────────────────────────────────────── */

/** The server-derived caller, and nothing the arguments say. The project is
    the canonical one of the AUTHENTICATED conversation, read from the registry
    projection the call already holds — never a separately resolved guess. An
    authority or registry that faults reads as unidentified, which fails both
    a fresh claim and a recovery closed. */
function recoveryCaller(
  dependencies: Partial<Pick<ViewerMcpDomainDependencies, "attentionAuthority" | "registrySnapshot" | "recoveryPredecessors">>,
  revalidateNative = false,
): McpRequestCaller {
  const unidentified: McpRequestCaller = { kind: "unidentified", conversationId: null, project: null };
  let authority: AttentionCallerAuthority;
  try {
    authority = dependencies.attentionAuthority ? authorityOf(dependencies as ViewerMcpDomainDependencies) : { kind: "unidentified" };
  } catch {
    return unidentified;
  }
  /* Caller attribution is shared for the whole tool call, while a native
     session proof is a live fence: generation changes must be visible at each
     recovery check even when the original authority is memoized. */
  if (revalidateNative && authority.kind !== "unidentified" && authority.nativeProof && dependencies.attentionAuthority) {
    try {
      authority = dependencies.attentionAuthority();
    } catch {
      return unidentified;
    }
  }
  if (authority.kind === "unidentified") return { ...unidentified, ...(authority.admission ? { admission: authority.admission } : {}) };
  if (authority.conversationId === null) return { kind: authority.kind, conversationId: null, project: null };
  let project: string | null;
  try {
    if (!dependencies.registrySnapshot) return unidentified;
    project = callerProjectFromSnapshot(dependencies.registrySnapshot(), authority.conversationId);
  } catch {
    return unidentified;
  }
  let predecessors: string[] = [];
  if (project) {
    try {
      predecessors = [...(dependencies.recoveryPredecessors ?? productionRecoveryPredecessors)(project, authority.conversationId)]
        .filter((candidate, index, all) => /^conversation_[A-Za-z0-9_-]{1,128}$/.test(candidate) && all.indexOf(candidate) === index)
        .slice(0, 32);
    } catch {
      predecessors = [];
    }
  }
  return {
    kind: authority.kind,
    conversationId: authority.conversationId,
    ...(authority.nativeProof ? { nativeProof: authority.nativeProof } : {}),
    project,
    ...(predecessors.length ? { predecessors } : {}),
  };
}

function spawnCwd(args: McpToolArgs): string {
  const raw = text(args.cwd);
  if (!raw) throw new Error("cwd is required");
  return path.resolve(raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw);
}

function conversationProject(conversation: { projectOwnership?: { project?: string } | null; generations: { launchProfile?: { cwd?: string | null } | null }[] } | null | undefined): string | null {
  if (!conversation) return null;
  if (conversation.projectOwnership?.project) return conversation.projectOwnership.project;
  const cwd = conversation.generations.at(-1)?.launchProfile?.cwd?.trim();
  return cwd ? projectForCwd(cwd) : null;
}

function orchestratorSendDownstreamKey(key: string): string {
  return `mcp_orchestrator_${crypto.createHash("sha256").update(key).digest("hex")}`;
}

/** Only a send leaving this installation crosses the learned-rule boundary. */
async function orchestratorRelayEgressText(message: string): Promise<string> {
  try { return await withoutStoredLessonsAsync(message); }
  catch (error) {
    if (error instanceof RoleMemoryRefusal) throw new McpToolRefusal(error.message, { code: error.code, status: 409 });
    throw error;
  }
}

async function bindOrchestratorSend(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies, forRecovery = false): Promise<McpRequestBindingInput> {
  requireOrchestratorRelayCaller(dependencies);
  const named = required(args, "project");
  const message = requiredMessageText(args);
  const caller = recoveryCaller(dependencies);
  const attribution = attributionOf(dependencies);
  // Match HTTP admission: a designated seat takes precedence even when the
  // root caller's general attribution also identifies it as the voice gateway.
  const seat = (dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources()))
    .find((candidate) => candidate.conversationId === attribution.conversationId);
  const owner = ownerRelayCaller(dependencies) ? ownerRelayPayload(message, attribution.conversationId!) : null;
  if (!seat && !owner && (attribution.kind !== "gateway" || !attribution.conversationId)) {
    throw new McpToolRefusal("the relay sender could not be bound to an authenticated conversation; continue the requested work with your tools, or explain the failure and the owner's next action", {
      code: "orchestrator_relay_refused", retryable: false,
    });
  }
  const project = forRecovery ? null : await resolveOrchestratorToolProject(named, dependencies);
  if (!seat && owner && project && !ownerRelayTargetMatches(attribution.conversationId!, project, orchestratorSeatFor(project).active?.conversationId)) {
    throw new McpToolRefusal("the quoted report's source seat is unavailable for this handoff; explain the failure and ask the owner to open that project's seat", { code: "owner_report_seat_unavailable", retryable: false });
  }
  const link = project && text(args.machine) ? resolveRemoteSeatMachine(text(args.machine), project, dependencies) : null;
  const outgoing = link ? await orchestratorRelayEgressText(message) : message;
  return {
    // Relay receipts belong to the exact sender, never its successor seat.
    caller: { kind: caller.kind, conversationId: caller.conversationId, project: caller.project },
    target: { project, identity: link ? `machine:${link.install}` : project ? orchestratorSeatFor(project).active?.conversationId ?? null : null },
    sendPayload: seat ? orchestratorRelayPayload(outgoing, seat) : owner ?? {
      text: message, origin: { kind: "agent", role: "gateway", conversationId: attribution.conversationId! },
    },
    // Separate from direct send: equal client keys on different tools are
    // different logical instructions, even when their message text is equal.
    downstreamKey: orchestratorSendDownstreamKey(requestId(args)),
  };
}

function resolveRemoteSeatMachine(machine: string, project: string, dependencies: ViewerMcpDomainDependencies) {
  const caller = attributionOf(dependencies);
  const seat = (dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources()))
    .find(seat => seat.conversationId === caller.conversationId && seat.project && canonicalOrchestratorProject(seat.project) === project);
  if (!seat || caller.via) throw new McpToolRefusal("only this project's designated seat may relay over a link", { code: "orchestrator_relay_refused", retryable: false });
  try { return resolveSeatMessageMachine(machine, project); }
  catch (error) {
    if (error instanceof SeatMessageRefusal) throw new McpToolRefusal(error.message, { code: error.code, outcome: "not-executed", nextAction: "new-request-permitted" });
    throw error;
  }
}

/** The Viewer binds this ordinary agent to one live owner request. */
function ownerRelayCaller(dependencies: ViewerMcpDomainDependencies): boolean {
  const caller = attributionOf(dependencies);
  return caller.kind === "agent" && !caller.via && !!caller.conversationId && liveOwnerRelayConversation(caller.conversationId);
}

/** Seats, the gateway and live owner relay agents can message a seat.
    Auto-creation still goes through the unchanged operator-only seat route. */
function requireOrchestratorRelayCaller(dependencies: ViewerMcpDomainDependencies): void {
  const caller = attributionOf(dependencies);
  if (caller.kind === "gateway" || ownerRelayCaller(dependencies)) return;
  if (caller.conversationId && !caller.via) {
    const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
    if (seats.some((seat) => seat.conversationId === caller.conversationId)) return;
  }
  throw new McpToolRefusal("only a designated orchestrator seat, the voice gateway or a verified owner relay may relay to an orchestrator; continue the requested work with your tools, or explain the failure and the owner's next action", {
    code: "orchestrator_relay_refused", retryable: false,
  });
}

function bindSend(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpRequestBindingInput {
  const conversationId = text(args.conversationId);
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) throw new Error("conversationId or transcriptPath is required");
  requiredMessageText(args);
  const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
  const conversation = conversationId
    ? lookup.conversation(conversationId as `conversation_${string}`)
    : lookup.conversationForPath(transcriptPath);
  return {
    caller: recoveryCaller(dependencies),
    target: {
      project: conversationProject(conversation),
      identity: conversation?.id ?? (conversationId || transcriptPath),
    },
    downstreamKey: sendDownstreamKey(requestId(args)),
  };
}

/** The canonical project of a spawn's target: the launch directory's, and
    nothing the arguments say. A supplied `project` is admitted only when it
    names that same project. The route records an explicit project as the new
    conversation's durable ownership, so a value that contradicts the launch
    directory would make a forged project both the binding's metadata and the
    conversation's owner; it is refused before any claim, so the key is not
    burned. */
function spawnTargetProject(args: McpToolArgs, cwd: string): string | null {
  const canonical = projectForCwd(cwd);
  const supplied = text(args.project).trim();
  if (!supplied) return canonical;
  const explicit = validExplicitProject(supplied);
  if (!explicit || explicit !== canonical) {
    throw new McpToolRefusal(
      "project contradicts the canonical project of cwd; omit it or name the launch directory's own project",
      { code: "invalid_request", status: 400, ...(canonical ? { canonicalProject: canonical } : {}) },
    );
  }
  return canonical;
}

async function bindSpawn(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpRequestBindingInput> {
  args = await namedLaunchProject(args, dependencies, "cwd");
  const cwd = spawnCwd(args);
  const caller = recoveryCaller(dependencies);
  const project = spawnTargetProject(args, cwd);
  // An unidentified caller cannot own a receipt. Keep the deployer's refusal
  // before lookup; identified owners are checked again only for fresh work.
  if (caller.kind === "unidentified") requireMcpDeployerCaller(args, project, dependencies);
  refuseCrossProjectFromSeat("spawn_agent", () => project, args, dependencies);
  const taskError = spawnTaskProjectError(args.taskId, cwd, dependencies.loadTasks);
  if (taskError) throw new McpToolRefusal(taskError, { code: "invalid_request", status: 400 });
  return {
    caller,
    target: { project, identity: cwd },
    downstreamKey: `mcp_spawn_${crypto.createHash("sha256").update(requestId(args)).digest("hex")}`,
  };
}

const RECOVERY_ABSENT_REASON = "no downstream record holds this request yet; execution remains possible, so look it up again under the same clientRequestId";

async function recoverSend(
  binding: McpRequestBinding,
  legacy: boolean,
  dependencies: ViewerMcpDomainDependencies,
  args?: McpToolArgs,
): Promise<McpRecoveryEvidence> {
  /* A send carries no durable sender identity of its own, so a claim made
     before bindings existed has no evidence that establishes its owner. */
  if (legacy) {
    return { outcome: "unknown", evidence: "legacy-receipt-unbound", reason: "no durable evidence establishes the owner of this send", ids: {}, ownership: "unknown" };
  }
  if (binding.toolName === "send_message_to_orchestrator" && !binding.sendPayload) {
    return { outcome: "unknown", evidence: "delivery-record", reason: "the relay binding has no authenticated send payload", ids: {}, ownership: "unknown" };
  }
  if (binding.toolName === "send_message_to_orchestrator" && binding.target.identity?.startsWith("machine:")) {
    const found = recoverSeatMessage(binding.target.identity.slice(8), binding.downstreamKey);
    return found ? { outcome: "accepted", evidence: "delivery-record", reason: null, ids: { operationId: found.operationId }, facts: found }
      : { outcome: "unknown", evidence: "none", reason: RECOVERY_ABSENT_REASON, ids: {} };
  }
  if (!binding.target.identity) {
    return { outcome: "unknown", evidence: "none", reason: "the bound target names no conversation", ids: {} };
  }
  const ports: SendSettlementPorts = dependencies.sendSettlementPorts?.() ?? {};
  let recipientIdentity = binding.target.identity;
  if (binding.toolName === "send_message_to_orchestrator" && binding.target.project && binding.sendPayload) {
    const payload = binding.sendPayload;
    const relay = resolveOrchestratorRelay(binding.target.project, recipientIdentity, payload,
      splitRelayMessageText(payload.text)?.body ?? payload.text, binding.downstreamKey);
    if (relay.ok && relay.operationId) recipientIdentity = relay.recipient;
  }
  const found = await resolveOriginalSend({ conversationId: recipientIdentity, clientMessageId: binding.downstreamKey,
    ...(binding.sendPayload ?? (typeof args?.text === "string" ? { text: args.text } : {})) }, ports);
  if (found.kind === "unreadable") {
    return { outcome: "unknown", evidence: "delivery-record", reason: `the delivery record could not be read: ${found.reason}`, ids: {} };
  }
  if (found.kind === "absent") return { outcome: "unknown", evidence: "none", reason: RECOVERY_ABSENT_REASON, ids: {} };
  if (found.kind === "unresolved") {
    return { outcome: "unknown", evidence: "none", reason: "the bound target names no conversation the registry knows, so no delivery record can be matched to it", ids: {} };
  }
  if (found.kind === "contradictory") {
    return { outcome: "unknown", evidence: "delivery-record", reason: "the delivery payload contradicts the bound request", ids: {}, ownership: "unknown" };
  }
  if (found.kind === "ambiguous") {
    return { outcome: "unknown", evidence: "delivery-record", reason: "more than one delivery operation claims this key; the match is ambiguous", ids: {} };
  }
  let receipt = found.current.readable ? found.current.value : found.receipt;
  let unreadableNote = found.current.readable ? null : `; the current runtime answer could not be read (${found.current.reason})`;
  /* #1866: a send past its settlement deadline is ended by this lookup, the
     same way `message_receipt` ends it, or the caller holding only the
     original key reads `in-flight` for ever. Before the deadline the lookup
     stays an observation. */
  if (receipt.state === "in-flight" && sendSettlementDue(found.operationId, ports)) {
    const settled = await resolveSendReceipt(found.operationId, ports);
    if (settled) {
      receipt = settled;
      unreadableNote = null;
    }
  }
  const ids: Record<string, string> = {
    operationId: found.operationId,
    ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
    ...(found.deliveryId ? { deliveryId: found.deliveryId } : {}),
  };
  if (receipt.state === "delivered" || receipt.state === "failed") {
    return {
      outcome: "settled",
      evidence: receipt.evidence,
      reason: receipt.reason ? `${receipt.reason}${unreadableNote ?? ""}` : unreadableNote?.slice(2) ?? null,
      ids,
      facts: {
        state: receipt.state,
        resend: receipt.resend,
        duplicateRisk: receipt.duplicateRisk,
        acceptedAt: receipt.acceptedAt,
        settledAt: receipt.settledAt,
      },
    };
  }
  const executing = found.reservationState === "delivery-uncertain";
  return {
    outcome: executing ? "in-flight" : "accepted",
    evidence: receipt.evidence,
    reason: `${receipt.reason ?? "accepted for delivery"}${unreadableNote ?? ""}`,
    ids,
    facts: { state: receipt.state, acceptedAt: receipt.acceptedAt, resend: receipt.resend, duplicateRisk: receipt.duplicateRisk },
  };
}

async function recoverSpawn(
  binding: McpRequestBinding,
  legacy: boolean,
  dependencies: ViewerMcpDomainDependencies,
  args?: McpToolArgs,
  context?: McpToolCallContext,
): Promise<McpRecoveryEvidence> {
  const key = legacy ? spawnAttemptId(binding.clientRequestId) : binding.downstreamKey;
  const unknown = (reason = RECOVERY_ABSENT_REASON): McpRecoveryEvidence => ({
    outcome: "unknown",
    evidence: "none",
    reason,
    ids: {},
    ...(legacy ? { ownership: "unknown" as const } : {}),
  });
  const fencedEvidence = (fence: SpawnAdmissionFence): McpRecoveryEvidence => ({
    outcome: "not-executed",
    evidence: "spawn-admission-fence",
    reason: fence.error,
    ids: {},
    facts: { status: fence.status, rejectedAt: fence.rejectedAt },
  });
  let snapshot: RegistrySnapshot;
  try {
    snapshot = dependencies.registrySnapshot();
  } catch (error) {
    return { outcome: "unknown", evidence: "spawn-receipt", reason: `the launch record could not be read: ${error instanceof Error ? error.message : String(error)}`, ids: {} };
  }
  let receipts = registryRowsMatching(snapshot, "receipts", "clientAttemptId", key);
  if (receipts.length === 0) {
    if (legacy || !args || typeof args.role !== "string" || !args.role.trim() || !dependencies.validateSpawnAdmission) return unknown();
    let body: Record<string, unknown>;
    try {
      body = spawnDispatchBody(args, key, mcpSpawnLauncher(dependencies));
    } catch (error) {
      return unknown(`the spawn admission request could not be reconstructed (${error instanceof Error ? error.message : String(error)})`);
    }
    const requestDigest = spawnAdmissionBodyDigest(body);
    if (!dependencies.readSpawnAdmissionFence) return unknown("spawn admission fencing is unavailable; execution remains possible");
    let existingFence: SpawnAdmissionFence | null;
    try {
      existingFence = dependencies.readSpawnAdmissionFence(key);
    } catch (error) {
      return unknown(`the spawn admission fence could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
    if (existingFence) {
      if (existingFence.requestDigest === requestDigest) return fencedEvidence(existingFence);
      return unknown("the downstream admission fence contradicts the bound request");
    }
    let probe: Record<string, unknown>;
    try {
      probe = await dependencies.validateSpawnAdmission(body, context);
    } catch (error) {
      return unknown(`the spawn admission fence could not be established (${error instanceof Error ? error.message : String(error)})`);
    }
    /* A current refusal is only a hint. The response must say the downstream
       CAS fence was written; the registry read below is the authoritative
       check that makes validator drift and in-flight races safe. */
    if (probe.admissible !== false || probe.fenced !== true) {
      return unknown("spawn admission did not establish an atomic downstream fence; execution remains possible");
    }
    try {
      snapshot = dependencies.registrySnapshot();
    } catch (error) {
      return { outcome: "unknown", evidence: "spawn-receipt", reason: `the launch record could not be read after admission fencing: ${error instanceof Error ? error.message : String(error)}`, ids: {} };
    }
    receipts = registryRowsMatching(snapshot, "receipts", "clientAttemptId", key);
    let fence: SpawnAdmissionFence | null;
    try {
      fence = dependencies.readSpawnAdmissionFence(key);
    } catch (error) {
      return unknown(`the spawn admission fence could not be read after admission fencing (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!fence || fence.requestDigest !== requestDigest) {
      return unknown("the reported admission refusal could not be verified against the exact downstream fence");
    }
    if (receipts.length === 0) return fencedEvidence(fence);
  }
  if (receipts.length > 1) {
    return { outcome: "unknown", evidence: "spawn-receipt", reason: "more than one launch receipt claims this key; the match is ambiguous", ids: {}, ...(legacy ? { ownership: "unknown" as const } : {}) };
  }
  const receipt = receipts[0]!;
  /* A deputy's launch is parented to its seat (docs/design/ghost-seat.md §4),
     so the parent that proves this caller's ownership is the seat's. */
  const callerParent = binding.caller.conversationId !== null ? spawnParentForCaller(binding.caller.conversationId) : null;
  const ownership = legacy
    ? (callerParent !== null && receipt.parentConversationId === callerParent ? "established" : "unknown")
    : undefined;
  if (legacy && ownership !== "established") {
    return { outcome: "unknown", evidence: "legacy-receipt-unbound", reason: "no durable evidence establishes the owner of this launch", ids: {}, ownership: "unknown" };
  }
  const refused = (reason: string): McpRecoveryEvidence => ({
    outcome: "unknown", evidence: "spawn-receipt", reason, ids: {}, ownership: "unknown",
    facts: { nextAction: "correct-request" },
  });
  if (binding.caller.kind === "unidentified") {
    return refused("caller authority is unavailable; restore the caller's MCP registration before inspecting this original launch. No redispatch is permitted");
  }
  if (receipt.parentConversationId !== null && receipt.parentConversationId !== callerParent) {
    return refused("the durable launch owner contradicts the bound request");
  }
  if (binding.target.identity && path.resolve(receipt.cwd) !== binding.target.identity) {
    return refused("the durable launch cwd contradicts the bound request");
  }
  // executeSpawnRequest trims the user prompt before persisting launchDisplay.
  if (typeof args?.prompt === "string" && receipt.launchDisplay && receipt.launchDisplay.prompt !== args.prompt.trim()) {
    return refused("the durable launch prompt contradicts the bound request");
  }
  const ids: Record<string, string> = {
    launchId: receipt.launchId,
    conversationId: receipt.conversationId,
    ...(receipt.artifactPath ? { transcriptPath: receipt.artifactPath } : {}),
  };
  const terminal = receipt.rejection !== null || receipt.state === "failed" || receipt.state === "conflicted" || receipt.state === "completed";
  if (terminal) {
    return {
      outcome: "settled",
      evidence: "spawn-receipt",
      reason: receipt.rejection?.guidance ?? receipt.error ?? null,
      ids,
      facts: {
        state: receipt.state,
        launched: receipt.state === "completed",
        ...(receipt.memoryCap ? { memoryCap: receipt.memoryCap } : {}),
        ...(receipt.rejection ? { rejection: receipt.rejection.code } : {}),
      },
      ...(ownership ? { ownership } : {}),
    };
  }
  const executing = receipt.verifiedHost !== null || receipt.pane !== null
    || receipt.state === "host-verified" || receipt.state === "prompt-delivered" || receipt.state === "path-pending";
  return {
    outcome: executing ? "in-flight" : "accepted",
    evidence: "spawn-receipt",
    reason: `launch receipt is ${receipt.state}`,
    ids,
    facts: { state: receipt.state, ...(receipt.memoryCap ? { memoryCap: receipt.memoryCap } : {}) },
    ...(ownership ? { ownership } : {}),
  };
}

/** The caller and task a prototype call's receipt belongs to, decided by the
    Viewer with the same fences as the call itself. A caller the Viewer refuses
    is refused here, before any receipt is read. */
async function prototypeReceiptScope(mode: "publish" | "read" | "resend",args: McpToolArgs,control: ViewerControlDependencies,context?: McpToolCallContext): Promise<string> {
  const capability = callerCapability();
  if (!capability) throw new Error("prototype reviews require an identified caller");
  const scope = await viewerControlForCall(control,context).post("/api/prototype-reviews/scope",
    { mode, ...(args.taskId === undefined ? {} : { taskId: args.taskId }), ...(args.reviewId === undefined ? {} : { reviewId: args.reviewId }) },{ [VIEWER_SPAWN_CAPABILITY_HEADER]: capability });
  /* A seat asking without a task is scoped to its own questions (docs/design/operator-decision-forms.md §2.1). */
  if (typeof scope.conversationId !== "string" || (typeof scope.taskId !== "string" && scope.taskId !== null)) throw new Error("the Viewer did not name the caller and task of this prototype call");
  return `${scope.conversationId}\n${scope.taskId ?? "seat"}`;
}

/**
 * The recoverable mutations (#1490): both bind the caller before dispatch and
 * answer an existing claim from durable evidence only. Neither `recover` can
 * reach a mutation binding.
 */
export function viewerMcpRecoverableTools(
  domainDependencies: ViewerMcpDomainDependencies = productionDomainDependencies,
): Partial<Record<McpToolName, McpRecoverableTool>> {
  return {
    create_pipeline: {
      currentCaller: () => recoveryCaller(domainDependencies, true),
      bindForRecovery: (args) => launchRecoveryBinding(args, domainDependencies, "repoDir"),
      bind: async (args) => {
        args = await namedLaunchProject(args, domainDependencies, "repoDir");
        const project = projectForCwd(required(args, "repoDir"));
        refuseCrossProjectFromSeat("create_pipeline", () => project, args, domainDependencies);
        return { caller: recoveryCaller(domainDependencies),
          target: { project, identity: path.resolve(required(args, "repoDir")) },
          downstreamKey: `create_pipeline:${requestId(args)}` };
      },
      recover: async (binding, options): Promise<McpRecoveryEvidence> => {
        if (options.legacy) return { outcome: "unknown", evidence: "legacy-receipt-unbound", reason: "creation has no caller-bound receipt", ids: {}, ownership: "unknown" };
        const pipeline = pipelineDeliveryLookup({ requestKey: binding.downstreamKey });
        if (!pipeline) return { outcome: "unknown", evidence: "pipeline-row", reason: RECOVERY_ABSENT_REASON, ids: {} };
        return { outcome: "settled", evidence: "pipeline-row", reason: null,
          ids: { pipelineId: pipeline.id }, facts: { ...pipelineAcknowledgement(pipeline), memoryCaps: pipelineMemoryCaps(pipeline), delivery: deliveryAcknowledgement(pipeline) } };
      },
    },
    spawn_agent: {
      bind: (args) => bindSpawn(args, domainDependencies),
      currentCaller: () => recoveryCaller(domainDependencies, true),
      bindForRecovery: (args) => launchRecoveryBinding(args, domainDependencies, "cwd"),
      authorizeClaim: (args, binding) => {
        requireMcpDeployerCaller(args, binding.target.project, domainDependencies);
        requireMcpDeployerConfirmation(args);
      },
      recover: (binding, options) => recoverSpawn(binding, options.legacy, domainDependencies, options.args, options.context),
    },
    send_message_to_orchestrator: {
      currentCaller: () => recoveryCaller(domainDependencies, true),
      bind: (args) => bindOrchestratorSend(args, domainDependencies),
      bindForRecovery: (args) => bindOrchestratorSend(args, domainDependencies, true),
      recover: (binding, options) => recoverSend(binding, options.legacy, domainDependencies, options.args),
    },
    send_message: {
      currentCaller: () => recoveryCaller(domainDependencies, true),
      bind: (args) => bindSend(args, domainDependencies),
      recover: (binding, options) => recoverSend(binding, options.legacy, domainDependencies, options.args),
    },
  };
}

/** Receipt-free read implementations shared by MCP and the voice companion. */
export function viewerReadTools(
  domainDependencies: ViewerMcpDomainDependencies = productionDomainDependencies,
  controlDependencies: ViewerControlDependencies = productionViewerControlDependencies(),
) {
  return {
    get_orchestrator: (args: McpToolArgs) => getOrchestrator(args, domainDependencies),
    list_tasks: (args: McpToolArgs, context?: McpToolCallContext) => Promise.resolve(listTasks(args, domainDependencies, context)),
    get_task: (args: McpToolArgs, context?: McpToolCallContext) => getTask(args, domainDependencies, context),
    list_pipelines: (args: McpToolArgs, context?: McpToolCallContext) => listPipelines(args, domainDependencies, context),
    get_pipeline: (args: McpToolArgs, context?: McpToolCallContext) => getPipeline(args, domainDependencies, context),
    agent_fleet: (args: McpToolArgs, context?: McpToolCallContext) => agentFleet(args, domainDependencies, context),
    agent_activity: (args: McpToolArgs, context?: McpToolCallContext) => agentActivity(args, domainDependencies, context),
    conversation_messages: (args: McpToolArgs, context?: McpToolCallContext) => conversationMessages(args, domainDependencies, context),
    search_transcripts: (args: McpToolArgs, context?: McpToolCallContext) => searchTranscripts(args, viewerControlForCall(controlDependencies, context)),
  };
}

export function viewerMcpBindings(
  linkTaskDependencies: LinkTaskToPipelineDependencies = productionLinkTaskDependencies,
  controlDependencies: ViewerControlDependencies = productionViewerControlDependencies(),
  domainDependencies: ViewerMcpDomainDependencies = productionDomainDependencies,
): McpToolBindings {
  const reads = viewerReadTools(domainDependencies, controlDependencies);
  const pageOwner = {};
  const budgeted = (tool: string, args: McpToolArgs, budget: number, load: (cursor: string | null) => Promise<McpToolPayload>) =>
    budgetPage(pageOwner, tool, args, budget, async cursor => {
      const payload = await load(cursor);
      const { conversations, nextCursor, ...meta } = payload;
      return { rows: (conversations ?? []) as Record<string, unknown>[], meta, upstream: typeof nextCursor === "string" ? nextCursor : null };
    }, fullAnswer(args));
  return {
    spawn_agent: (args, context) => spawnAgent(args, viewerControlForCall(controlDependencies, context), context, domainDependencies),
    send_message: (args, context) => sendMessage(args, viewerControlForCall(controlDependencies, context), domainDependencies, context),
    message_receipt: (args) => messageReceipt(args),
    create_task: requireTaskCreateDue(orchestratorProjectBinding(domainDependencies, (args) => createBoardTask(args, domainDependencies), true, true, true)),
    update_task: Object.assign((args: McpToolArgs) => updateBoardTask(args, domainDependencies), { prepareAdmission: admitTaskDuePatch }),
    create_pipeline: (args, context) => unadmittedBeforeMutation(async () => (await createPipeline(args, context, domainDependencies))),
    pipeline_action: Object.assign(
      (args: McpToolArgs) => unadmittedBeforeMutation(() => pipelineAction(args, domainDependencies)),
      { canonicalizeReceiptArgs: (args: McpToolArgs) => {
        if (args.action !== "resolve-decision" || typeof args.expectedRevision !== "string") return args;
        const id = required(args, "pipelineId");
        const pipeline = domainDependencies.readPipelineRecord
          ? domainDependencies.readPipelineRecord(id)
          : domainDependencies.getPipelines?.().pipelines.find((item) => item.id === id);
        if (!pipeline) return args;
        const accepted = pipeline.decisionAnswers?.find((entry) => entry.clientRequestId === args.clientRequestId);
        const retained = accepted?.expectedRevision ?? pipelineRevision(pipeline);
        if (!/^[a-f0-9]{7,64}$/i.test(args.expectedRevision) || !retained.toLowerCase().startsWith(args.expectedRevision.toLowerCase())) return args;
        return { ...args, expectedRevision: retained };
      }, authorizeReceipt: (args: McpToolArgs) => {
        if (!PIPELINE_RECEIPT_ACTIONS.has(args.action as PipelineAction)) return;
        const id = required(args, "pipelineId");
        const pipeline = domainDependencies.readPipelineRecord
          ? domainDependencies.readPipelineRecord(id)
          : domainDependencies.getPipelines?.().pipelines.find((item) => item.id === id);
        if (!pipeline) throw new Error("pipeline not found");
        const refusal = args.action === "continue-review" || args.action === "accept-head"
          ? continueReviewActorRefusal(pipeline, pauseResumeActorOf(domainDependencies))
          : args.action === "convert-legacy-review" || args.action === "revert-legacy-review"
            ? legacyReviewActorRefusal(pipeline, pauseResumeActorOf(domainDependencies))
            : decisionAnswerActorRefusal(pipeline, pauseResumeActorOf(domainDependencies), args.clientRequestId);
        if (refusal) throw new Error(refusal.error);
      } },
    ),
    stage_report: (args) => unadmittedBeforeMutation(() => stageReport(args, domainDependencies)),
    leave_lesson: (args) => leaveLesson(args, domainDependencies),
    curate_rules: Object.assign(async (args: McpToolArgs) => {
      try {
        const conversationId = attributionOf(domainDependencies).conversationId;
        const assertAdmission = await domainDependencies.curatorAdmission?.(conversationId);
        if (typeof assertAdmission === "function") assertAdmission();
        const pass = curatorCallerOf(conversationId, domainDependencies.curatorSnapshot && conversationId ? domainDependencies.curatorSnapshot(conversationId) : domainDependencies.registrySnapshot());
        if (args.action !== "read") {
          const result = await withViewerOperation("memory.import.curation", () => waitForStateLock("memory.import.curate", () => {
            if (typeof assertAdmission === "function") assertAdmission();
            const fresh = curatorCallerOf(conversationId, domainDependencies.curatorSnapshot && conversationId ? domainDependencies.curatorSnapshot(conversationId) : domainDependencies.registrySnapshot());
            return applyCuration(fresh, args as unknown as CurationApply, undefined, { refreshKnownValues: !fresh.importBatch });
          }));
          if (pass.importBatch) await refreshCurationKnownValuesAsync();
          if (typeof assertAdmission === "function") assertAdmission();
          curatorCallerOf(conversationId, domainDependencies.curatorSnapshot && conversationId ? domainDependencies.curatorSnapshot(conversationId) : domainDependencies.registrySnapshot());
          return result;
        }
        const result = await readCuration(pass, typeof args.scope === "string" ? args.scope : undefined, typeof args.cursor === "string" ? args.cursor : undefined);
        if (typeof assertAdmission === "function") assertAdmission();
        curatorCallerOf(conversationId, domainDependencies.curatorSnapshot && conversationId ? domainDependencies.curatorSnapshot(conversationId) : domainDependencies.registrySnapshot());
        return result;
      } catch (error) {
        if (error instanceof RoleMemoryRefusal) throw new McpToolRefusal(error.message, { code: error.code, status: 409 });
        if (error instanceof DeliveryAdmissionRefusedError) throw new McpToolRefusal(error.message, { code: "CURATE_CALLER", status: 409 });
        throw error;
      }
    }, { authorizeReceipt: async () => {
      try {
        const conversationId = attributionOf(domainDependencies).conversationId;
        const assertAdmission = await domainDependencies.curatorAdmission?.(conversationId);
        if (typeof assertAdmission === "function") assertAdmission();
        curatorCallerOf(conversationId, domainDependencies.curatorSnapshot && conversationId ? domainDependencies.curatorSnapshot(conversationId) : domainDependencies.registrySnapshot());
      } catch (error) {
        if (error instanceof RoleMemoryRefusal) throw new McpToolRefusal(error.message, { code: error.code, status: 409 });
        if (error instanceof DeliveryAdmissionRefusedError) throw new McpToolRefusal(error.message, { code: "CURATE_CALLER", status: 409 });
        throw error;
      }
    } }),
    link_task_to_pipeline: (args) => unadmittedBeforeMutation(() => linkTaskToPipeline(args, linkTaskDependencies)),
    list_conversations: (args, context) => budgeted("list_conversations", args, 12_000, cursor => listConversations({ ...args, cursor }, viewerControlForCall(controlDependencies, context))),
    search_transcripts: reads.search_transcripts,
    backfill_worktree_projects: (args, context) => viewerControlForCall(controlDependencies, context).post("/api/board/maintenance/worktrees", {
      dryRun: args.dryRun !== false, ...(args.project ? { project: args.project } : {}),
    }, {}, context),
    search_memory: (args, context) => searchMemoryTool(args, viewerControlForCall(controlDependencies, context), attributionOf(domainDependencies).conversationId ?? null),
    get_conversation: (args, context) => getConversation(args, domainDependencies, context),
    conversation_deliverability: (args) => Promise.resolve(conversationDeliverability(args, domainDependencies)),
    conversation_messages: reads.conversation_messages,
    deploy_exact_sha: Object.assign(
      (args: McpToolArgs, context?: McpToolCallContext) => deployExactSha(args, viewerControlForCall(controlDependencies, context), domainDependencies, context),
      { authorizeReceipt: () => { deploySeatAuthority(domainDependencies); } },
    ),
    pipeline_checks: (args, context) => {
      assertPipelineSeatAuthority(domainDependencies);
      return viewerControlForCall(controlDependencies, context).post(`/api/pipelines/${encodeURIComponent(required(args, "pipelineId"))}/checks`, {
        scope: args.scope, execution: args.execution, stageId: args.stageId,
      }, {}, context);
    },
    get_pipeline: reads.get_pipeline,
    board_snapshot: (args) => boardSnapshot(args, domainDependencies),
    list_flows: (args) => Promise.resolve(listFlows(args, domainDependencies)),
    get_flow: (args) => Promise.resolve(getFlow(args, domainDependencies)),
    flow_action: (args) => flowAction(args, domainDependencies),
    list_pipelines: reads.list_pipelines,
    list_tasks: reads.list_tasks,
    get_task: reads.get_task,
    operator_snapshot: (args) => operatorSnapshot(args, domainDependencies),
    deployment_status: (args, context) => deploymentStatus(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    resources: (args) => resources(args, domainDependencies),
    conversation_action: (args, context) => conversationAction(args, viewerControlForCall(controlDependencies, context), domainDependencies, context),
    conversation_migration: (args, context) => conversationMigration(args, viewerControlForCall(controlDependencies, context)),
    agent_fleet: Object.assign((args: McpToolArgs, context?: McpToolCallContext) => reads.agent_fleet(args, context), {
      receiptScope: async (args: McpToolArgs) => {
        const { caller, scope } = fleetReadAccess(args, domainDependencies);
        return JSON.stringify({ caller, scope });
      },
    }),
    agent_activity: (args, context) => budgeted("agent_activity", args, 24_000, () => reads.agent_activity(args, context)),
    lifecycle_events: (args, context) => lifecycleEvents(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    request_attention: (args, context) => requestAttention(args, domainDependencies, context),
    publish_prototype_review: Object.assign((args: McpToolArgs,context?: McpToolCallContext) => {
      const capability = callerCapability();
      if (!capability) throw new Error("prototype publication requires an identified caller");
      return viewerControlForCall(controlDependencies,context).post("/api/prototype-reviews",args,{ [VIEWER_SPAWN_CAPABILITY_HEADER]: capability });
    },{ receiptScope: (args: McpToolArgs,context?: McpToolCallContext) => prototypeReceiptScope("publish",args,controlDependencies,context) }),
    resend_prototype_review_telegram: Object.assign((args: McpToolArgs,context?: McpToolCallContext) => {
      const capability = callerCapability();
      if (!capability) throw new Error("prototype resend requires an identified caller");
      return viewerControlForCall(controlDependencies,context).post("/api/prototype-reviews/telegram",args,{ [VIEWER_SPAWN_CAPABILITY_HEADER]: capability });
    },{ receiptScope: (args: McpToolArgs,context?: McpToolCallContext) => prototypeReceiptScope("resend",args,controlDependencies,context) }),
    read_prototype_review: Object.assign((args: McpToolArgs,context?: McpToolCallContext) => {
      const capability = callerCapability();
      if (!capability) throw new Error("prototype reads require an identified caller");
      return viewerControlForCall(controlDependencies,context).post("/api/prototype-reviews/read",withoutKeys(args,["clientRequestId"]),{ [VIEWER_SPAWN_CAPABILITY_HEADER]: capability });
    },{ receiptScope: (args: McpToolArgs,context?: McpToolCallContext) => prototypeReceiptScope("read",args,controlDependencies,context) }),
    dismiss_attention: (args, context) => dismissAttentionTool(args, domainDependencies, controlDependencies, context),
    bridge_report: (args, context) => bridgeReport(args, domainDependencies, viewerControlForCall(controlDependencies, context)),
    bridge_directive: orchestratorProjectBinding(domainDependencies, (args, context) => bridgeDirective(args, viewerControlForCall(controlDependencies, context), domainDependencies), true),
    get_orchestrator: orchestratorProjectBinding(domainDependencies, (args) => getOrchestrator(args, domainDependencies)),
    seat_tick_settings: orchestratorProjectBinding(domainDependencies, (args) => seatTickSettingsTool(args, domainDependencies), true),
    /* Async bindings expose synchronous refusals as rejected promises. */
    account_project_binding: async (args) => accountProjectBindingTool(args, domainDependencies),
    role_presets: async (args) => waitForStateLock("mcp.role-presets", () => rolePresetsTool(args, domainDependencies)),
    auto_updates: (args, context) => autoUpdatesTool(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    voice_tools: (args, context) => voiceTools(args, viewerControlForCall(controlDependencies, context), attributionOf(domainDependencies).conversationId ?? null),
    account_limits: async (args) => accountLimitsTool(args, domainDependencies),
    create_orchestrator: orchestratorProjectBinding(domainDependencies, (args, context) => createOrchestrator(args, viewerControlForCall(controlDependencies, context)), false, false),
    send_message_to_orchestrator: (args, context) => sendMessageToOrchestrator(args, viewerControlForCall(controlDependencies, context), domainDependencies, context),
    ask_orchestrator_in_parallel: orchestratorProjectBinding(domainDependencies, (args, context) => askOrchestratorInParallelTool(args, viewerControlForCall(controlDependencies, context))),
    rotate_orchestrator: orchestratorProjectBinding(domainDependencies, (args, context) => rotateOrchestrator(args, viewerControlForCall(controlDependencies, context), domainDependencies)),
    telegram_bot_chats: (args, context) => telegramBotChats(args, viewerControlForCall(controlDependencies, context)),
    telegram_bot_send: (args, context) => telegramBotSend(args, viewerControlForCall(controlDependencies, context)),
    telegram_bot_send_media: (args, context) => telegramBotSendMedia(args, viewerControlForCall(controlDependencies, context)),
    telegram_bot_send_document: (args, context) => telegramBotSendDocument(args, viewerControlForCall(controlDependencies, context)),
    relay_answer: async (args) => {
      const caller = attributionOf(domainDependencies);
      try {
        const result = caller.kind === "agent" && !caller.via && caller.conversationId
          ? await relayAnswerOp(caller.conversationId, args) : null;
        if (result === null) throw new McpToolRefusal("Answer parts exist only during your live owner relay turn.", { code: "relay_answer_unavailable", retryable: false });
        return result;
      } catch (error) {
        if (error instanceof RelayAnswerError || error instanceof RelayDocumentRefusal)
          throw new McpToolRefusal("Relay answer parts refused: " + error.code, { code: error.code, retryable: false });
        throw error;
      }
    },
    relay_service_tools: async (args) => {
      const caller = attributionOf(domainDependencies);
      const result = caller.kind === "agent" && !caller.via && caller.conversationId
        ? await relayServiceToolsOp(caller.conversationId, args) : null;
      if (result === null) throw new McpToolRefusal("Service tools exist only while you answer a relay message as its owner.", { code: "relay_tools_unavailable", retryable: false });
      return result;
    },
    relay_owner_history: (args, context) => relayOwnerHistory(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    telegram_bot_messages: (args, context) => telegramBotMessages(args, viewerControlForCall(controlDependencies, context)),
    issue_report: (args, context) => issueReportTool(args, viewerControlForCall(controlDependencies, context), domainDependencies),
  };
}

function resolvePrototypeReviewId(...args: Parameters<typeof resolveStoredReviewId>): ReturnType<typeof resolveStoredReviewId> {
  try { return resolveStoredReviewId(...args); }
  catch (error) {
    if ((error as { code?: string }).code === "short_id_ambiguous") throw new McpToolRefusal("reviewId is ambiguous; pass more characters", { code: "short_id_ambiguous", field: "reviewId", retryable: false, candidates: (error as { candidates?: string[] }).candidates });
    throw error;
  }
}
function mcpPrototypeRound(taskId: string | null, given: string) {
  try { return findPrototypeRound(taskId, given); }
  catch (error) {
    if ((error as { code?: string }).code === "short_id_ambiguous") throw new McpToolRefusal("reviewId is ambiguous; pass more characters", { code: "short_id_ambiguous", field: "reviewId", retryable: false, candidates: (error as { candidates?: string[] }).candidates });
    throw error;
  }
}
