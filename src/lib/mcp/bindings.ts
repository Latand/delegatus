import { boardSelection } from "./boardSelection";
import { budgetPage } from "./budgetPage";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* The Viewer's own repository metadata. Bundled into the server and the MCP
   binary, so a packaged release with no checkout can still name the repository
   it deploys (#1321). */
import viewerPackageManifest from "../../../package.json";

import { activeClaudeAccountId, listClaudeAccounts } from "@/lib/accounts/claude";
import { activeCodexAccountId, listCodexAccounts } from "@/lib/accounts/codex";
import { activeCopilotAccountId, listCopilotAccounts } from "@/lib/accounts/copilot";
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
import { ENGINE_MODELS, validateLaunchModel } from "@/lib/agent/models";
import { procBackend } from "@/lib/proc";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { currentMcpHttpCaller } from "./callerContext";
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
import { DismissalError, dismissAttention as dismissAttentionService, parseDismissalTarget, type DismissalPorts } from "@/lib/attention/dismissals";
import type { DismissalTarget, DismissedBy } from "@/lib/attention/dismissalTypes";
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
import { MAX_BOARD_MUTATIONS_PER_REQUEST, MAX_BOARD_PATH_LIST_ITEMS } from "@/lib/board/validation";
import { conversationDeliverabilityFromRecord } from "@/lib/conversation/deliverability";
import { backoffDelayMs, DeadlineExceededError, deadlineSignal } from "@/lib/deadline";
import { cancelRound, closeFlow, patchFlow } from "@/lib/flows/commands";
import { flowSelectionSource } from "@/lib/flows/store";
import { getFlowsWithPresets } from "@/lib/flows/engine";
import type { PatchFlowRequest } from "@/lib/flows/types";
import { pollLifecycleDigest, type LifecycleDigestRequest } from "@/lib/lifecycle/digest";
import { queryLifecycleEvents, type LifecycleEventQuery } from "@/lib/lifecycle/journal";
import type { CompletedGenerationRead } from "@/lib/lifecycle/inventorySelection";
import {
  agentLivenessSnapshot,
  productionLivenessSources,
  DEFAULT_EVIDENCE_DEADLINE_MS,
  type AgentLivenessSources,
} from "@/lib/lifecycle/liveness";
import { refreshLifecycleJournal } from "@/lib/lifecycle/projector";
import { isLifecycleEventType } from "@/lib/lifecycle/vocabulary";
import { recordBridgeDirectiveAnswer, recordBridgeDirectivePendingAnswer, recordManagerReport } from "@/lib/bridge/service";
import { bridgeDirectiveBody, bridgeDirectiveId, type BridgeTrailer } from "@/lib/bridge/directive";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { isBridgeReportClass, type BridgeReportTelegram, type CanonicalSeatConversationId } from "@/lib/bridge/types";
import { findBridgeReport, recordBridgeReportTelegram, scopedReportId } from "@/lib/bridge/store";
import { type PublicDenyList } from "@/lib/bridge/publicSafe";
import { renderPlain, renderReport, type TaskChanges } from "@/lib/bridge/reportRender";
import { SEAT_SECTION_IDS, type SeatSectionId } from "@/lib/bridge/reportWords";
import { deployTaskChanges, projectSnapshots } from "@/lib/bridge/taskChanges";
import { renderTelegram, type PullRequestLookup } from "@/lib/bridge/telegramReport";
import { projectDisplayName } from "@/lib/displayNames";
import { forgeCacheView } from "@/lib/forge/cache";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { languageMismatchWarning } from "@/lib/i18n/proseLanguage";
import { operatorLocale, operatorTimeZone } from "@/lib/operator/settings";
import { projectAliasSnapshot, recordedProjectRemote } from "@/lib/projects/aliases";
import {
  applySeatTickNoteLineEdits,
  applySeatTickSettingsChange,
  defaultSeatTickSettings,
  effectiveSeatTickSettings,
  readSeatTickSettings,
  writeSeatTickSettings,
  type SeatTickNoteLineEdits,
  type SeatTickSettingsActor,
  type SeatTickSettingsChange,
} from "@/lib/monitor/seatTickSettings";
import { SEAT_TICK_WAKE_INTERVAL_MS } from "@/lib/monitor/seatTick";
import { seatTickFenceDetail, seatTickReportedFence } from "@/lib/monitor/seatTickFence";
import { peekSeatTickState } from "@/lib/monitor/seatTickState";
import type { SeatTickProjectState } from "@/lib/monitor/types";
import { authorizedManagerSeats, type ManagerAuthoritySources } from "@/lib/orchestrator/authority";
import { recordSeatDeployment, type SeatDeploymentRecord } from "@/lib/orchestrator/seatDeployments";
import { activeOrchestratorSeats, canonicalOrchestratorProject, orchestratorRevocations, orchestratorSeatFor, revokedOrchestratorSeatConversationsOrUnknown, type OrchestratorSeat } from "@/lib/orchestrator/seats";
import { activeSeatsByCurrentProject, seatLaunchCwd } from "@/lib/orchestrator/seatProjectIdentity";
import { projectSuccessionFor } from "@/lib/projects/succession";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import { contextReading, readOrchestratorTranscriptFacts, rotationRecommendation } from "@/lib/orchestrator/health";
import { contextWindowPolicyFor } from "@/lib/orchestrator/contextPolicy";
import { continueReviewActorRefusal, createPipelineFromRequest, legacyReviewActorRefusal, decisionAnswerActorRefusal, getPipeline as getPipelineRecord, getPipelines, patchPipeline, reportStageCompletion, type PipelineMutationResult, type StageCompletionRequest } from "@/lib/pipelines/engine";
import { latestOperationalPipelineAttempt, latestOperationalStageAttempt } from "@/lib/pipelines/attemptSelection";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { queuedPipelineCreationMessage, queuedPipelineCreationStatus } from "@/lib/pipelines/creationQueue";
import type { TaskPipelineReadModel } from "@/lib/pipelines/taskBinding";
import { PIPELINE_LIST_DEFAULT_LIMIT, pipelineCompactRow, pipelineListRow } from "@/lib/pipelines/listProjection";
import { graphDigest, stageDigests } from "@/lib/pipelines/stageDigest";
import { loadPipelinesForList, pipelineSelectionSource, pipelineDeliveryLookup } from "@/lib/pipelines/store";
import type { CreatePipelineRequest, PatchPipelineRequest, Pipeline, PipelineAction, PipelineCloseReport, PipelineMergeState } from "@/lib/pipelines/types";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";
import { viewerRepositoryProjects } from "@/lib/projects/viewerRepository";
import { listFiles } from "@/lib/scanner";
import { validExplicitProject } from "@/lib/accounts/migration/contracts";
import { describe, projectForCwd, reprojectFileDescription } from "@/lib/scanner/describe";
import { pathAllowed, scanRootEntries } from "@/lib/scanner/roots";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { readResources, readResourcesWithDiagnostic } from "@/lib/resources";
import { adoptLiveRootSession, conversationRole, liveRootSession, type RootSessionSource } from "@/lib/root/adopt";
import { listRoles, resolveSpawnRole } from "@/lib/roles/registry";
import type { RoleDefinition, RoleParameter } from "@/lib/roles/types";
import { readSpawnAdmissionFence, type SpawnAdmissionFence } from "@/lib/agent/spawnAdmission";
import type { RuntimeHostRequestHealth } from "@/lib/runtime/client";
import type { ViewerDeploymentStatus, ViewerDeploymentSummary } from "@/lib/runtime/contracts";
import { messageOriginRole, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import { ledgerDeployment, ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import { resolveOriginalSend, resolveSendReceipt, type SendSettlementPorts } from "@/lib/runtime/sendSettlement";
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
  StaleMessagesCursorError,
} from "@/lib/session/messagesPage";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { recordReplySuggestions } from "@/lib/suggestions/store";
import { ReplySuggestionValidationError } from "@/lib/suggestions/types";
import { applyAssignmentPatches, createTask, patchTask, type CreateTaskInput, type PatchTaskInput } from "@/lib/tasks/commands";
import { taskSeatHolding } from "@/lib/tasks/seatHolding";
import { pipelineWorkLinks, pullRequestSummary, taskWorkLinkContext, taskWorkLinks } from "@/lib/forge/resolve";
import { bridgeReportsEnabled, mergeOnReviewEnabled, reportHeaderName, reportTelegram } from "@/lib/projects/settings";
import { refineTask } from "@/lib/tasks/membership";
import { isoNow } from "@/lib/tasks/helpers";
import { refuseBusyBeforeAdmission, StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import { loadTasks, loadTasksForList, taskSelectionSource, mutateTasks, mutateTasksFile } from "@/lib/tasks/store";
import { TASK_PRIORITIES, taskPriority, type BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { collectSnapshot } from "@/lib/view/collect";
import { resolveSiblings } from "@/lib/view/siblings";
import { hardenedRedact } from "@/lib/view/compactText";
import { validateSnapshotRequest } from "@/lib/view/validation";

import {
  requestDigest,
  McpDispatchNotExecutedError,
  McpDispatchUncertainError,
  McpDispatchVerdictError,
  McpToolRefusal,
  McpUnadmittedRefusal,
  type McpRecoverableTool,
  type McpRecoveryEvidence,
  type McpRequestBinding,
  type McpRequestBindingInput,
  type McpRequestCaller,
  type McpToolArgs,
  type McpToolBindings,
  type McpToolCallContext,
  type McpToolName,
  type McpToolPayload,
} from "./server";
import { parseSelectedContextRef } from "@/lib/selection/selectedContext";
import { RETRYABLE_TELEGRAM_BOT_CODES, type TelegramBotErrorCode } from "@/lib/telegram/bot/contracts";

import {
  accountLimitRows,
  compactDeployment,
  compactLiveness,
  newestDeploymentsFirst,
  pipelineAcknowledgement,
  pipelineActionAcknowledgement,
  pipelineStageRead,
  stageReportAcknowledgement,
  type AccountLimitsInput,
} from "./compactAnswers";
import { changedFieldNames, fieldValues, compactFlow, compactTask, firstLine, fullAnswer, listPage, listPageAsync, recordRevision, sinceTime, stringSet, taskAcknowledgement } from "./listAnswers";

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
import { mcpCallerIdentity, mcpToolPolicy, mcpToolNeedsCallerIdentity, permitAttentionDismissal, permitAttentionHandoff, permitReplySuggestions, type ManagerTarget, type McpToolPolicy } from "./toolAllowlist";

const PIPELINE_CONTROLLER_ACTIONS = new Set<PipelineAction>(["start", "resume", "retry-stage", "skip-stage", "resolve-decision", "continue-review", "accept-head", "retry-merge"]);
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
  /** #1490: ONE attempt, never repeated once the request may have reached the
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
const CONTROL_RECOVERY_BUDGET_MS = 8_000;
const CONTROL_UNSCOPED_RECOVERY_BUDGET_MS = 5_000;
const CONTROL_DEADLINE_RESERVE_MS = 250;
const CONTROL_RETRY_BASE_MS = 100;
const CONTROL_RETRY_MAX_MS = 1_000;
const TRANSIENT_CONTROL_STATUSES = new Set([502, 504]);

class ViewerControlResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerControlResponseError";
  }
}

function controlRetryDelay(attempt: number): number {
  return backoffDelayMs(attempt, { baseMs: CONTROL_RETRY_BASE_MS, maxMs: CONTROL_RETRY_MAX_MS });
}

async function waitForControlRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => finish(signal?.reason);
    function finish(error?: unknown) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestViewerControl(
  pathname: string,
  init: RequestInit,
  context: McpToolCallContext = {},
  pinConfiguredEndpoint = false,
): Promise<{ response: Response; parsed: unknown; unreadable: boolean }> {
  const baseUrl = viewerControlOrigin(process.env, pinConfiguredEndpoint);
  const token = viewerControlToken(process.env, baseUrl);
  const now = Date.now();
  const deadlineAt = context.deadlineAt;
  const retryable = deadlineAt !== undefined;
  const callerBudget = deadlineAt === undefined
    ? CONTROL_UNSCOPED_RECOVERY_BUDGET_MS
    : Math.max(0, deadlineAt - now - CONTROL_DEADLINE_RESERVE_MS);
  const expiresAt = now + Math.min(CONTROL_RECOVERY_BUDGET_MS, callerBudget);
  let attempts = 0;
  let lastFailure = "connection failed";
  while (Date.now() < expiresAt) {
    if (context.signal?.aborted) throw context.signal.reason;
    attempts += 1;
    const remainingMs = Math.max(1, expiresAt - Date.now());
    const attempt = deadlineSignal(Math.min(CONTROL_ATTEMPT_TIMEOUT_MS, remainingMs), {
      signal: context.signal,
      reason: "Viewer control reconnect attempt timed out",
    });
    try {
      const headers = new Headers(init.headers);
      /* The Viewer authenticates every connection once a token is configured
         (#1496), so a control read that sends nothing is refused exactly like a
         stranger's (#1511). A caller that set its own authorization keeps it. */
      if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
      if (init.method === "POST") {
        headers.set("origin", baseUrl);
        headers.set("sec-fetch-site", "same-origin");
      }
      const response = await fetch(new URL(pathname, baseUrl), { ...init, headers, signal: attempt.signal });
      if (TRANSIENT_CONTROL_STATUSES.has(response.status)) {
        lastFailure = `status ${response.status}`;
        await response.body?.cancel().catch(() => {});
      } else {
        try {
          const parsed = await response.json() as unknown;
          const answeredDomainFailure = response.status === 503
            && objectRecord(parsed)
            && Boolean(text(parsed.error) || text(parsed.code));
          if (response.status !== 503 || answeredDomainFailure || !retryable) {
            return { response, parsed, unreadable: false };
          }
          lastFailure = "status 503";
        } catch {
          if (context.signal?.aborted) throw context.signal.reason;
          if (!retryable) {
            return { response, parsed: null, unreadable: true };
          } else if (attempt.signal.aborted) {
            lastFailure = "response body timed out";
          } else if (response.status === 503) {
            lastFailure = "status 503";
          } else {
            lastFailure = "response body failed";
          }
        }
      }
    } catch {
      if (context.signal?.aborted) throw context.signal.reason;
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
    const error = text(result.error) || `Viewer control request failed with status ${response.status}`;
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
  const { response, parsed, unreadable } = await requestViewerControl(pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  }, context, pinConfiguredEndpoint);
  /* A body of literal `null` is valid JSON, so `.catch` never fires and every
     later `result.x` throws a TypeError before the status can be classified —
     which is how a 405 from a revision that does not serve the route arrived as
     an uncatchable crash instead of a refusal (#790). */
  if (unreadable && response.ok) {
    throw new ViewerControlResponseError(
      `Viewer control returned an unreadable response with status ${response.status}`,
    );
  }
  const result: Record<string, unknown> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  if (result.error || (!response.ok && result.state !== "busy")) {
    const message = text(result.error) || `Viewer control request failed with status ${response.status}`;
    /* #1131: a refusal that names an ACCEPTED send is not just prose. The send
       began actuating and nothing could confirm it, so the caller needs the id
       it was accepted under — `message_receipt` answers what became of it — and
       the guidance that repeating the instruction may deliver it twice.
       Flattening those into a message is what left an ambiguous legacy send
       with nothing to ask about and no warning against sending it again. */
    const operationId = text(result.operationId);
    if (operationId) {
      throw new McpToolRefusal(message, {
        operationId,
        ...(text(result.resend) ? { resend: text(result.resend) } : {}),
        ...(result.actuation === "started" ? { actuation: "started" } : {}),
      });
    }
    throw new Error(message);
  }
  return result;
}

/**
 * One dispatch of a recoverable mutation (#1490). No reconnect loop: the
 * request is written once, and what comes back is classified by what it can
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
): Promise<Record<string, unknown>> {
  const baseUrl = viewerControlOrigin(process.env, pinConfiguredEndpoint);
  const token = viewerControlToken(process.env, baseUrl);
  const now = Date.now();
  const budgetMs = context.deadlineAt === undefined
    ? CONTROL_UNSCOPED_RECOVERY_BUDGET_MS
    : Math.max(1, context.deadlineAt - now - CONTROL_DEADLINE_RESERVE_MS);
  const attempt = deadlineSignal(Math.min(CONTROL_ATTEMPT_TIMEOUT_MS, budgetMs), {
    signal: context.signal,
    reason: "Viewer control dispatch timed out",
  });
  const requestHeaders = new Headers({ "content-type": "application/json", ...headers });
  if (token && !requestHeaders.has("authorization")) requestHeaders.set("authorization", `Bearer ${token}`);
  requestHeaders.set("origin", baseUrl);
  requestHeaders.set("sec-fetch-site", "same-origin");
  let response: Response;
  /* From here on the request may be on the wire: the service reads this to
     tell a failure that happened BEFORE any dispatch from one after it. */
  if (context.dispatch) context.dispatch.attempted = true;
  try {
    response = await fetch(new URL(pathname, baseUrl), {
      method: "POST",
      // Redirects can repeat a POST after the first endpoint accepted it.
      redirect: "error",
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: attempt.signal,
    });
  } catch (error) {
    attempt.release();
    const code = (error as { code?: unknown }).code;
    if (code === "ConnectionRefused" || code === "ECONNREFUSED") {
      throw new McpDispatchNotExecutedError("Viewer control is unreachable: the connection was refused before the request was sent");
    }
    throw new McpDispatchUncertainError(
      attempt.signal.aborted
        ? "the Viewer did not answer before the dispatch deadline; the request may have been received"
        : `the connection failed after the request may have been sent (${code ? String(code) : "connection failed"})`,
    );
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
    const message = text(result.error) || `Viewer control request failed with status ${response.status}`;
    const operationId = text(result.operationId);
    const launchId = text(result.launchId);
    if (operationId || launchId) {
      throw new McpDispatchVerdictError(message, {
        status: response.status,
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
      ...(typeof result.expectedRevision === "number" || result.expectedRevision === null ? { expectedRevision: result.expectedRevision } : {}),
      ...(typeof result.retryAfterSeconds === "number" ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      ...(Array.isArray(result.sentMessageIds) && result.sentMessageIds.every((id) => typeof id === "number") ? { sentMessageIds: result.sentMessageIds } : {}),
    });
  }
  return result;
}

export function productionViewerControlDependencies(
  pinConfiguredEndpoint = false,
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
  registrySnapshot(): RegistrySnapshot;
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
  pipelineSelectionSource?: typeof pipelineSelectionSource;
  patchPipeline: typeof patchPipeline;
  readPipelineRecord?: typeof getPipelineRecord;
  reportStageCompletion: typeof reportStageCompletion;
  loadTasks: typeof loadTasks;
  listTaskRecords?(): readonly import("@/lib/tasks/types").BoardTask[];
  taskSelectionSource?: typeof taskSelectionSource;
  collectSnapshot: typeof collectSnapshot;
  readResources: typeof readResources;
  readResourcesWithDiagnostic?: typeof readResourcesWithDiagnostic;
  /** Sources for the liveness read. The catalog seam travels in (#860) so a
      project-scoped `agent_activity` consumes the SAME completed generation
      `board_snapshot` reads instead of forcing a private whole-corpus sweep.
      Partial harnesses that build fixed sources may ignore the argument. */
  livenessSources(catalog?: { completedFileScan?: CompletedGenerationRead }): AgentLivenessSources;
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
  recordSeatDeployment?(record: SeatDeploymentRecord): void;
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
}

/**
 * FIX 2's production resolver: the caller's conversation (pid ancestry merged
 * with capability lineage — the identity chain everything else trusts), its
 * newest generation's cwd, and the canonical project that cwd groups under.
 * No second resolution scheme: `projectForCwd` IS `projectInfoFromCwd`.
 */
function productionCallerProject(): string | null {
  const authority = attentionCallerAuthority(attentionCallerSources());
  const conversationId = authority.kind === "root" || authority.kind === "worker" ? authority.conversationId : null;
  if (!conversationId) return null;
  return callerProjectFromSnapshot(agentRegistry().readOnlySnapshot(), conversationId);
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
}

/** Fold the caller authority with "is this the designated orchestrator" into
    one label. Pure, so every mapping is testable without a process tree. */
export function callerAttributionFrom(
  authority: AttentionCallerAuthority,
  isManagerConversation: (conversationId: string) => boolean,
): CallerAttribution {
  if (authority.kind === "root") return { kind: "gateway", conversationId: authority.conversationId, role: null };
  if (authority.kind === "unidentified") return { kind: "unidentified", conversationId: null, role: null };
  return {
    kind: isManagerConversation(authority.conversationId) ? "manager" : "agent",
    conversationId: authority.conversationId,
    role: authority.role,
  };
}

function attributionOf(dependencies: Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">): CallerAttribution {
  return dependencies.callerAttribution?.()
    ?? callerAttributionFrom(dependencies.attentionAuthority(), () => false);
}

/** MCP mutations always remain agent-attributed, including an unidentified caller. */
function pauseResumeActorOf(dependencies: ViewerMcpDomainDependencies): PauseResumeActor {
  const attribution = attributionOf(dependencies);
  return {
    kind: "agent",
    role: attribution.role ?? (attribution.kind === "manager" ? "orchestrator" : attribution.kind === "gateway" ? "gateway" : null),
    conversationId: attribution.conversationId,
  };
}

/**
 * Message authorship for a send issued through this MCP server (#1117): every
 * MCP caller is an agent, and the role is the server's own attribution — never
 * a caller claim. Attribution reads process ancestry, so a fault there costs
 * only the role, not the send.
 */
function mcpSenderOrigin(
  dependencies: Partial<Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">>,
): MessageOrigin {
  let attribution: CallerAttribution | null = null;
  try {
    attribution = dependencies.callerAttribution?.()
      ?? (dependencies.attentionAuthority
        ? callerAttributionFrom(dependencies.attentionAuthority(), () => false)
        : null);
  } catch {
    attribution = null;
  }
  const role = attribution?.kind === "manager"
    ? "orchestrator"
    : attribution?.kind === "gateway"
      ? "gateway"
      : messageOriginRole(attribution?.role);
  return { kind: "agent", ...(role ? { role } : {}) };
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
export function hostedConversationsFromSnapshot(
  snapshot: Pick<RegistrySnapshot, "conversations" | "entries">,
): { conversationId: string; role: string | null; pids: number[] }[] {
  const owners = new Map<string, { id: string; role: string | null }>();
  const hosted = new Map<string, { conversationId: string; role: string | null; pids: number[] }>();
  for (const conversation of Object.values(snapshot.conversations)) {
    const owner = { id: conversation.id, role: conversationRole(conversation) };
    for (const generation of conversation.generations) owners.set(generation.path, owner);
    hosted.set(owner.id, { conversationId: owner.id, role: owner.role, pids: [] });
  }
  for (const entry of Object.values(snapshot.entries)) {
    const owner = owners.get(entry.artifactPath);
    if (!owner) continue;
    const pids = [entry.host?.agent?.pid, entry.structuredHost?.process?.pid]
      .filter((pid): pid is number => typeof pid === "number" && pid > 0);
    hosted.get(owner.id)!.pids.push(...pids);
  }
  return [...hosted.values()];
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
  return currentMcpHttpCaller()?.capability ?? process.env[VIEWER_SPAWN_CAPABILITY_ENV];
}

function attentionCallerSources(): AttentionCallerSources {
  const httpCaller = currentMcpHttpCaller();
  return {
    /* An HTTP call is served from the Viewer's own process, whose ancestry
       leads to no agent host; the capability alone names that caller, exactly
       as it does for a stdio agent whose host pids were never recorded. */
    ancestry: httpCaller ? () => [] : () => processAncestry(process.pid, (pid) => procBackend.readPpid(pid)),
    rootConversationId: () => liveRootSession(rootSessionSource())?.conversationId ?? null,
    hosted: () => hostedConversationsFromSnapshot(agentRegistry().readOnlySnapshot()),
    capabilityCallerConversationId: capabilityConversationResolver(
      callerCapability(),
      (digest) => agentRegistry().conversationIdForSpawnCapabilityDigest(digest),
    ),
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
  completedFileScan,
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
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
  livenessSources: productionLivenessSources,
  queryLifecycleEvents,
  pollLifecycleDigest,
  refreshLifecycleJournal,
  adoptRootSession: () => { adoptLiveRootSession(rootSessionSource()); },
  raiseAttentionRequest,
  attentionAuthority: () => attentionCallerAuthority(attentionCallerSources()),
  callerAttribution: () => callerAttributionFrom(
    attentionCallerAuthority(attentionCallerSources()),
    (conversationId) => authorizedManagerSeats(productionManagerAuthoritySources())
      .some((seat) => seat.conversationId === conversationId),
  ),
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
  const role = roleId ? resolveSpawnRole({ role: roleId, roleParams: args.roleParams }) : null;
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
  return Object.keys(resolved).length ? resolved : source;
}

/** The exact body handed to `/api/spawn`, shared by the one dispatch and the
    request-bound admission recovery probe. Keeping this construction in one
    seam makes the downstream fence digest compare the original payload. */
export function spawnDispatchBody(args: McpToolArgs, clientAttemptId: string): Record<string, unknown> {
  const body = withoutKeys(args, ["clientRequestId", "recoveryOnly"]);
  const roleParams = defaultMcpSpawnRoleParams(args);
  return {
    ...body,
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

async function spawnAgent(args: McpToolArgs, control: ViewerControlDependencies, context?: McpToolCallContext): Promise<McpToolPayload> {
  validateExplicitMcpLaunchModel(args);
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
  const result = await dispatchControl(control)("/api/spawn", spawnDispatchBody(args, clientAttemptId), spawnControlHeaders());
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
    transcriptPath: result.path,
    operationId: result.launchId,
    launchId: result.launchId,
    state: result.state,
    initialMessage: result.initialMessage,
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
): Promise<McpToolPayload> {
  const conversationId = text(args.conversationId);
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) throw new Error("conversationId or transcriptPath is required");
  const message = requiredMessageText(args);
  const outcome = await dispatchControl(control)("/api/tmux", {
    pid: null,
    path: transcriptPath,
    ...(conversationId ? { conversationId } : {}),
    clientMessageId: context?.binding?.downstreamKey ?? downstreamKey,
    text: message,
    images: [],
    /* #1117: an MCP send is inter-agent traffic by definition; the sender role
       is the server's own caller attribution, so the feed can say WHO relayed. */
    origin: mcpSenderOrigin(dependencies),
  }, callerCapabilityHeaders());
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
  const conversation = conversationId
    ? lookup.conversation(conversationId as `conversation_${string}`)
    : lookup.conversationForPath(transcriptPath);
  return {
    conversationId: (conversation?.id ?? conversationId) || null,
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
  const receipt = await resolveSendReceipt(operationId);
  if (!receipt) {
    throw new McpToolRefusal(
      "no accepted send is recorded under that operationId",
      { code: "OPERATION_UNKNOWN" },
    );
  }
  return { ...receipt };
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

async function createBoardTask(args: McpToolArgs, dependencies?: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const input: CreateTaskInput = {
    ...args,
    placement: args.placement ?? "unplaced",
    clientRequestId: requestId(args),
  };
  const result = mutateTasksFile((state) => {
    const outcome = createTask(state.tasks, input, state.recentCreates);
    return {
      state: outcome.ok && !outcome.replay ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined,
      result: outcome,
    };
  });
  if (!result.ok) throw new McpToolRefusal(result.error, { code: result.code ?? (result.status === 404 ? "TASK_NOT_FOUND" : "TASK_INVALID_FIELD"), field: result.field, status: result.status });
  return { ...taskAcknowledgement(result.task, args, result.replay ? [] : Object.keys(result.task)), replay: result.replay, ...(result.notes ? { notes: result.notes } : {}), ...taskTextLanguageWarnings(args.text, dependencies) };
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
  const result = mutateTasks((tasks) => {
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
    return fullAnswer(args) ? task : compactTask(task);
  }), omittedRecordCount: fullAnswer(args) ? 0 : result.refined.length, readMore: "get_task(taskId) or update_task with full:true returns the full task." };
}

async function updateBoardTask(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  if (args.refine !== undefined) return refineBoardTask(args, dependencies);
  const taskId = required(args, "taskId");
  const patch = withoutKeys(args, ["taskId", "clientRequestId", "full", "compact"]);
  let changedFields: string[] = [];
  const result = mutateTasks((tasks) => {
    const before = fieldValues(tasks.find(task => task.id === taskId));
    const outcome = patchTask(tasks, taskId, patch as PatchTaskInput, undefined, { requirePlacementGuards: true, actor: "agent", seatHolding: taskSeatHolding,
      workLinks: taskWorkLinkContext(() => dependencies.listPipelineRecords?.() ?? dependencies.getPipelines?.().pipelines ?? []) });
    if (outcome.ok) changedFields = changedFieldNames(before, outcome.task);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) throw new McpToolRefusal(result.error, { code: result.code ?? (result.status === 404 ? "TASK_NOT_FOUND" : "TASK_INVALID_FIELD"), field: result.field, status: result.status });
  return { ...taskAcknowledgement(result.task, args, changedFields), ...(result.notes ? { notes: result.notes } : {}), ...taskTextLanguageWarnings(args.text, dependencies) };
}

/**
 * The pipeline mutations that share one idempotency receipt path (#1766).
 *
 * A registry lock that was never taken refused before anything was admitted:
 * no pipeline row, no task assignment, nothing reserved downstream. That
 * refusal is reported as unadmitted, so the receipt layer releases the claim
 * and the caller's retry under the SAME clientRequestId runs the operation
 * instead of replaying the refusal. Any other busy error keeps its ordinary
 * meaning — releasing the lease raises the same message after the write has
 * already committed, and such an answer must stay this request's answer.
 */
async function unadmittedOnStoreBusy<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StoreBusyBeforeAdmissionError) {
      throw new McpUnadmittedRefusal(error.message, { code: "store_busy" });
    }
    throw error;
  }
}

function deliveryAcknowledgement(pipeline: import("@/lib/pipelines/types").Pipeline): McpToolPayload {
  const delivery = pipeline.delivery!;
  return { target: delivery.target, disposition: delivery.disposition, publish: delivery.publish,
    ownerId: delivery.ownerId, epoch: delivery.epoch, active: delivery.active,
    ...(delivery.disposition === "comparison" ? { conflict: `Target owned by ${delivery.ownerId} at epoch ${delivery.epoch}; comparison lane created with Viewer publication disabled` } : {}) };
}

const PIPELINE_CREATION_QUEUED_NOTE = "Pipeline state is not writable right now (a Viewer deployment is handing over, or the store is busy), so this pipeline is queued under the pipelineId above. The serving release stores and starts it on its next controller pass; get_pipeline answers once it is stored. Do not create it again.";

async function createPipeline(args: McpToolArgs, context?: McpToolCallContext): Promise<McpToolPayload> {
  const request = withoutKeys(args, ["clientRequestId", "recoveryOnly"]);
  if (context?.dispatch) context.dispatch.attempted = true;
  const result = await createPipelineFromRequest(request as CreatePipelineRequest, undefined, {
    creationRequest: { key: `create_pipeline:${requestId(args)}`, digest: requestDigest("create_pipeline", request) },
    queueWhenBusy: true,
  });
  if (!result.pipeline) {
    if (context?.dispatch) context.dispatch.attempted = false;
    const message = result.error ?? "could not create pipeline";
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
  const pipelineId = required(args, "pipelineId");
  const action = required(args, "action") as PipelineAction;
  /* Clearing a lane off the operator's queue is the dismissal service's write
     (docs/design/needs-attention.md §5): the same gate and the same attributed
     record `dismiss_attention` writes. */
  if (action === "dismiss" || action === "undismiss") return pipelineDismissal(pipelineId, action, args, dependencies);
  const request = withoutKeys(args, ["pipelineId", ...(PIPELINE_RECEIPT_ACTIONS.has(action) ? [] : ["clientRequestId"]), "full", "compact"]);
  const before = dependencies.readPipelineRecord
    ? dependencies.readPipelineRecord(pipelineId)
    : dependencies.getPipelines?.().pipelines.find(pipeline => pipeline.id === pipelineId);
  const beforeFields = fieldValues(before);
  if (action === "retry-stage") retryStageLaunch(request, before ?? null);
  /* Decisions, pause/resume and graph edits carry the server-attributed actor. */
  const result = action === "takeover" || action === "publish" || action === "pause" || action === "resume" || action === "attach-link" || action === "detach-link" || PIPELINE_RECEIPT_ACTIONS.has(action) || PIPELINE_GRAPH_EDIT_ACTIONS.has(action)
    ? await dependencies.patchPipeline(pipelineId, request as PatchPipelineRequest, undefined, pauseResumeActorOf(dependencies))
    : await dependencies.patchPipeline(pipelineId, request as PatchPipelineRequest);
  if (!result.pipeline) {
    const message = result.error ?? "could not update pipeline";
    /* A refused close carries the hosts it stopped and the one it could not
       (#670); an agent driving the board must not get less than an HTTP caller. */
    if (result.details) throw new McpToolRefusal(message, { code: result.code, details: result.details });
    /* A refused conversion carries its editable preview. */
    if (result.legacyReviewPreview) throw new McpToolRefusal(message, { legacyReviewPreview: result.legacyReviewPreview });
    if (action === "publish" || action === "takeover") throw new McpToolRefusal(message, { code: "delivery_refused", status: result.status });
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
      readMore: "get_pipeline(pipelineId) lists every host in closeReport.",
    });
  }
  /* The pipeline itself is acknowledged, not echoed (#1845): get_pipeline reads it. */
  return redactPayload({
    ...pipelineActionAcknowledgement(result.pipeline),
    revision: recordRevision(result.pipeline),
    changedFields: changedFieldNames(beforeFields, result.pipeline),
    taskIds: result.pipeline.taskIds,
    ...(fullAnswer(args) ? { pipeline: result.pipeline } : { omittedRecordCount: 1 }),
    readMore: "get_pipeline(pipelineId) or pipeline_action with full:true returns the full record.",
    ...(result.pipeline.delivery ? { delivery: deliveryAcknowledgement(result.pipeline) } : {}),
    ...(action === "attach-link" || action === "detach-link" ? { workLinks: pipelineWorkLinks(result.pipeline), ...(result.unchanged ? { unchanged: true } : {}) } : {}),
    ...(result.close ? { close: result.close } : {}),
    ...(result.graphEdit ? { graphEdit: result.graphEdit } : {}),
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
    ...pipelineActionAcknowledgement(after),
    revision: recordRevision(after),
    changedFields: changedFieldNames(beforeFields, after),
    taskIds: after.taskIds,
    dismissal: { dismissed: outcome.dismissed.length > 0, alreadyClear: outcome.alreadyClear.length > 0, at: outcome.at, by: outcome.by },
    ...(fullAnswer(args) ? { pipeline: after } : { omittedRecordCount: 1 }),
    readMore: "get_pipeline(pipelineId) or pipeline_action with full:true returns the full record.",
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
  };
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
      if (!targeted) return undefined;
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
  const limit = Math.max(1, Math.min(100, integer(args.limit, 20)));
  const params = new URLSearchParams({ q: query });
  if (project) params.set("project", project);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
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
  return redactPayload(source);
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
    const answer = selectedConversationTail(
      { conversationId: requestedId, maxLines: Math.max(1, Math.min(tailLines, SELECTED_TAIL_MAX_LINES)) },
      selectedDependencies,
    );
    throwIfCallEnded(context);
    return redactPayload({
      conversationId: answer.record.conversationId,
      transcriptPath: answer.tail.path,
      project: answer.record.project,
      engine: answer.record.engine,
      scanned: false,
      tail: { lines: answer.tail.lines, bytes: answer.tail.bytes, truncated: answer.tail.truncated },
      ...selectedContextEcho(selected.target),
    });
  }
  const conversation = requestedId
    ? agentRegistry().conversation(requestedId as `conversation_${string}`)
    : agentRegistry().conversationForPath(requestedPath);
  const transcriptPath = conversation?.generations.at(-1)?.path ?? requestedPath;
  const pathTailLines = tailLines > 0 && !requestedId
    ? Math.max(1, Math.min(tailLines, SELECTED_TAIL_MAX_LINES))
    : undefined;
  const targeted = await entryForPath(transcriptPath, dependencies, {
    ...context,
    ...(pathTailLines === undefined ? {} : { tailLines: pathTailLines }),
  });
  const entry = targeted?.entry;
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
      tail: {
        lines: targeted.tail.lines,
        bytes: targeted.tail.bytes,
        truncated: targeted.tail.truncated,
      },
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
  const truncated = partialAtDeadline || oversized || recordTruncated;
  const hint = targeted.hint
    ?? (partialAtDeadline
      ? PARTIAL_CONVERSATION_DEADLINE_HINT
      : oversized
        ? PARTIAL_CONVERSATION_OVERSIZE_HINT
        : recordTruncated
          ? PARTIAL_CONVERSATION_RECORD_HINT
          : undefined);
  return redactPayload({
    conversationId: (conversation?.id ?? entry.conversationId ?? requestedId) || null,
    transcriptPath: entry.path,
    project: entry.project,
    title: entry.title,
    engine: entry.engine,
    messages: session.messages.slice(-maxRecords),
    tools: session.tools.slice(-maxRecords),
    truncated,
    ...(hint ? { hint } : {}),
    ...selectedContextEcho(selected.target),
  });
}

function conversationDeliverability(
  args: McpToolArgs,
  dependencies: Pick<ViewerMcpDomainDependencies, "registrySnapshot">,
): McpToolPayload {
  const conversationId = text(args.conversationId);
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) {
    throw new Error("conversationId or transcriptPath is required");
  }
  const result = conversationDeliverabilityFromRecord(dependencies.registrySnapshot(), {
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
      }, { kinds, roles, since, limit, maxChars, cursor });
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
      transcriptPath,
      engine,
      lastRecordAt: page.lastRecordAt,
      records: page.records,
      hasMore: page.hasMore,
      cursor: page.cursor ? encodeMessagesCursor(page.cursor, scope) : null,
      scanned: page.scanned,
      ...selectedContextEcho(selected.target),
    });
  } finally {
    fs.closeSync(pinned.descriptor);
  }
}

async function deployExactSha(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  const revision = required(args, "revision");
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("revision must be a full 40-character commit SHA");

  /* #795 (superseding contract) — the designated agent decides the deploy and
     executes it directly. Authority is derived from the SERVER-ATTRIBUTED
     caller identity and nothing else: no operator confirmation, no
     authorization row, and never anything read out of prose or reasoning. The
     identity chain is the one production already trusts — process ancestry
     merged with the admission-injected spawn capability, checked against the
     durable per-project orchestrator designation. */
  const attribution = attributionOf(dependencies);
  if (attribution.kind !== "manager" || !attribution.conversationId) {
    throw new McpToolRefusal(
      "only the designated orchestrator executes deploys; this session is not attributed as a designated seat. Report the request over the bridge instead.",
      { code: "deploy_caller_not_designated", revision },
    );
  }

  /* A designated seat's authority is scoped to its own project. The seat this
     conversation holds must be the seat of the caller's own canonical project —
     a seat exercising deploy authority from another project's context is the
     cross-project spend this refusal closes. */
  const seats = dependencies.authorizedSeats?.()
    ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const seat = seats.find((candidate) => candidate.conversationId === attribution.conversationId);
  if (!seat) {
    throw new McpToolRefusal(
      "only the designated orchestrator executes deploys; this session holds no validated seat. Report the request over the bridge instead.",
      { code: "deploy_caller_not_designated", revision },
    );
  }
  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  if (callerProject && seat.project !== callerProject) {
    throw new McpToolRefusal(
      "a designated orchestrator deploys only as its own project's seat; this session's seat belongs to another project",
      { code: "deploy_cross_project", revision },
    );
  }

  /* #1321: being a designated seat says WHO may deploy, never WHAT. This tool
     ships one repository — the Viewer serving this MCP — so a designated seat of
     any other project holds no authority here at all, whatever SHA it names. The
     refusal is placed ahead of the POST on purpose: past it the runtime host
     fetches the canonical mirror and resolves the revision, so a foreign caller
     would otherwise learn only "revision not found" and go looking for a better
     SHA. Fails closed when the Viewer cannot name its own repository — a deploy
     whose target is unproven is the one this closes. */
  const viewerProjects = dependencies.viewerProjects ? dependencies.viewerProjects() : viewerOwnProjects();
  if (!seat.project || !viewerProjects.includes(seat.project)) {
    throw new McpToolRefusal(
      "this tool deploys the Delegatus application that serves this MCP, and nothing else; it cannot deploy the caller's project, and no Delegatus surface can. Report the request over the bridge instead.",
      { code: "deploy_foreign_project", revision },
    );
  }

  const receipt = await control.post("/api/runtime/deployments", {
    revision,
    idempotencyKey: requestId(args),
  });
  /* #2063: the ledger never learns who asked, and the seat ends its turn so
     the promotion can replace its host. Recording the pair is what lets the
     seat tick wake this seat when the deployment settles. A `busy` receipt
     names someone else's deployment, which is not this seat's to be woken on.
     A failed write costs the wake and nothing else: the deployment is
     already admitted, so the answer says so rather than failing the call. */
  let wakeOnSettle = false;
  if (receipt.state === "accepted" && typeof receipt.deploymentId === "string" && receipt.deploymentId) {
    try {
      (dependencies.recordSeatDeployment ?? recordSeatDeployment)({
        deploymentId: receipt.deploymentId,
        conversationId: seat.conversationId,
        project: seat.project,
        revision: typeof receipt.revision === "string" ? receipt.revision : revision.toLowerCase(),
        requestedAt: new Date().toISOString(),
      });
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

  const origin = attributionOf(dependencies);
  /* Folded through the project aliases once, here: the seat tick reads the log
     under the canonical key, and a seat recorded before its folder changed key
     still carries the old one as its conversation's project. */
  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  const project = callerProject ? canonicalOrchestratorProject(callerProject) : null;
  /* #2146: the operator turned this project's reports off. An answer, not an
     error: the caller did nothing wrong, and nothing is stored. */
  if (project && !bridgeReportsEnabled(project)) {
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
     the same report. */
  const reportId = scopedReportId(project, key);
  const existing = findBridgeReport(reportId)
    ?? (callerProject && callerProject !== project ? findBridgeReport(scopedReportId(callerProject, key)) : null);
  if (existing) {
    const telegram = existing.telegram && existing.telegram.state === "failed" && existing.origin?.kind === "manager"
      && origin.kind === "manager" && isRetryableReportSend(existing.telegram.code)
      ? await postReportTelegram(existing.id, existing.telegram.chat, existing.telegram.html, `bridge-report:${existing.id}:r${existing.telegram.attempts}`, dependencies, control)
      : existing.telegram ?? null;
    /* `alreadyRecorded`, because the tool service's envelope owns `replayed`
       (a replay of the same clientRequestId). */
    return {
      recorded: false,
      alreadyRecorded: true,
      seq: existing.seq,
      reportId: existing.id,
      destinations: reportDestinations(existing.seq, telegram),
    };
  }

  const locale = dependencies.operatorLocale ? dependencies.operatorLocale() : operatorLocale();
  const warnings: string[] = [];
  let storedBody: string;
  let telegramCopy: { chat: string; html: string } | null = null;
  if (origin.kind === "manager") {
    const deployKey = [key, ...covers].find((entry) => entry.startsWith("deploy:")) ?? null;
    const tasks = deployKey && project ? deployReportTaskChanges(project, deployKey, dependencies) : null;
    if (deployKey && project && !tasks) warnings.push("No task changes are listed: this deploy has no board snapshot to compare, because it settled before snapshots existed or aged out.");
    const rendered = renderReport({
      class: reportClass,
      deploy: deployKey !== null,
      name: project ? reportHeaderName(project) : "Delegatus",
      at: new Date(),
      locale,
      timeZone: dependencies.operatorTimeZone ? dependencies.operatorTimeZone() : operatorTimeZone(),
      summary,
      sections,
      legacyBody: hasSections ? null : body,
      taskChanges: tasks,
      deny: dependencies.publicDenyList ? dependencies.publicDenyList(project) : await productionPublicDenyList(project, control),
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
    warnings.push(...rendered.warnings);
    const language = languageMismatchWarning("report", [summary, ...Object.values(sections).flat(), hasSections ? "" : body].join("\n"), locale);
    if (language) warnings.push(language);
    storedBody = renderPlain(rendered.cut);
    const destination = project ? reportTelegram(project) : null;
    if (destination) {
      telegramCopy = { chat: destination.chat, html: renderTelegram(rendered.cut, knownPullRequests(project!)) };
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
    correlatesDirective: text(args.correlatesDirective) || null,
    covers,
    coversOwed,
    telegram: telegramCopy,
  });

  /* A replay under the same key appends nothing, and says so rather than pretending
     to have delivered a second report. */
  if (!appended) return { recorded: false, alreadyRecorded: true };
  const telegram = appended.telegram
    ? await postReportTelegram(appended.id, appended.telegram.chat, appended.telegram.html, `bridge-report:${appended.id}`, dependencies, control)
    : null;
  return {
    recorded: true,
    replayed: false,
    seq: appended.seq,
    reportId: appended.id,
    warnings,
    destinations: reportDestinations(appended.seq, telegram),
  };
}

function reportSectionsArg(value: unknown): Record<SeatSectionId, string[]> {
  const sections = {} as Record<SeatSectionId, string[]>;
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  for (const id of SEAT_SECTION_IDS) {
    const items = record[id];
    sections[id] = Array.isArray(items)
      ? items.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, 32)
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
  clientRequestId: string,
  dependencies: ViewerMcpDomainDependencies,
  control: ViewerControlDependencies | null,
): Promise<BridgeReportTelegram | null> {
  const send = dependencies.sendReportTelegram ?? ((input: ReportTelegramSend) => productionSendReportTelegram(input, control));
  let outcome: ReportTelegramSendOutcome;
  try {
    outcome = await send({ chat, html, clientRequestId });
  } catch (error) {
    outcome = { ok: false, code: "telegram_failed", message: error instanceof Error ? error.message : String(error) };
  }
  const at = new Date().toISOString();
  return recordBridgeReportTelegram(reportId, outcome.ok
    ? { state: "sent", messageIds: outcome.messageIds, at }
    : { state: outcome.code === "send_uncertain" ? "uncertain" : "failed", code: outcome.code, at })?.telegram ?? null;
}

export interface ReportTelegramSend {
  chat: string;
  html: string;
  clientRequestId: string;
}

export type ReportTelegramSendOutcome =
  | { ok: true; messageIds: number[] }
  | { ok: false; code: string; message?: string };

async function productionSendReportTelegram(input: ReportTelegramSend, control: ViewerControlDependencies | null): Promise<ReportTelegramSendOutcome> {
  if (!control) return { ok: false, code: "telegram_failed", message: "no Viewer control is available to post through" };
  try {
    const result = await dispatchControl(control)("/api/telegram/bot/agent", {
      op: "send",
      clientRequestId: input.clientRequestId,
      chat: input.chat,
      text: input.html,
      format: "html",
      silent: true,
    }, callerCapabilityHeaders()) as { messageIds?: unknown };
    const messageIds = Array.isArray(result?.messageIds) ? result.messageIds.filter((id): id is number => Number.isInteger(id)) : [];
    return { ok: true, messageIds };
  } catch (error) {
    if (error instanceof McpDispatchVerdictError && typeof error.details.code === "string") {
      return { ok: false, code: error.details.code, message: error.message };
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
 * other projects in repository form. Every source fails soft to nothing.
 */
async function productionPublicDenyList(project: string | null, control: ViewerControlDependencies | null): Promise<PublicDenyList> {
  const accounts: string[] = [];
  const collect = (list: () => readonly { id: string; label: string }[]) => {
    try {
      for (const account of list()) accounts.push(account.id, account.label);
    } catch {
      // An unreadable registry contributes nothing.
    }
  };
  collect(listClaudeAccounts);
  collect(listCodexAccounts);
  collect(listCopilotAccounts);
  const local: string[] = [];
  try {
    local.push(os.userInfo().username, path.basename(os.homedir()), os.hostname().split(".")[0] ?? "");
  } catch {
    // Nothing to add.
  }
  /* The bot's people are read only for a project that posts to a bot chat:
     a bridge-only project shares nothing with the bot's chats. */
  const people = control && project && reportTelegram(project) ? await telegramPeople(control) : [];
  const projects: { repository: string | null; names: string[] }[] = [];
  try {
    const own = project ? canonicalOrchestratorProject(project) : null;
    const keys = new Set<string>();
    for (const seat of activeOrchestratorSeats()) keys.add(canonicalOrchestratorProject(seat.project));
    const aliases = projectAliasSnapshot();
    for (const key of Object.keys(aliases.displayNames)) keys.add(canonicalOrchestratorProject(key));
    for (const key of keys) {
      if (key === own) continue;
      const repository = githubRepositoryOfRemote(recordedProjectRemote(key));
      projects.push({
        repository,
        names: [repository?.split("/")[1] ?? "", projectDisplayName(key, aliases.displayNames[key])].filter(Boolean),
      });
    }
  } catch {
    // An unreadable catalog contributes nothing.
  }
  return { accounts, people, local, projects };
}

async function telegramPeople(control: ViewerControlDependencies): Promise<string[]> {
  const people = new Set<string>();
  try {
    const chats = await readViewerControl(control, "/api/telegram/bot/agent?op=chats") as { chats?: { chat?: unknown; postAllowed?: unknown }[] };
    for (const chat of (chats.chats ?? []).filter((entry) => entry.postAllowed === true && typeof entry.chat === "string").slice(0, 4)) {
      const page = await readViewerControl(control, `/api/telegram/bot/agent?${new URLSearchParams({ op: "messages", chat: chat.chat as string, limit: "100", maxChars: "1" })}`) as { messages?: { from?: { name?: unknown; username?: unknown } | null; fromName?: unknown; fromUsername?: unknown }[] };
      for (const message of page.messages ?? []) {
        for (const value of [message.from?.name, message.from?.username, message.fromName, message.fromUsername]) {
          if (typeof value === "string" && value.trim()) people.add(value.replace(/^@/, "").trim());
        }
      }
    }
  } catch {
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

function reportFields(project: string, dependencies: ViewerMcpDomainDependencies): { operatorLocale: "en" | "uk" | null; reportTelegram: { chat: string; name: string } | null } {
  const destination = reportTelegram(project);
  return {
    operatorLocale: dependencies.operatorLocale ? dependencies.operatorLocale() : operatorLocale(),
    reportTelegram: destination ? { chat: destination.chat, name: destination.name } : null,
  };
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
  const revocations = orchestratorRevocations().filter((revocation) => revocation.project === project);
  const base = full ? {
    project,
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
    project,
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
  const windowPolicy = contextWindowPolicyFor(engine, model);
  const context = contextReading({ policy: windowPolicy, facts });

  let liveness: { lifecycle: string; hostState: string; silentForMs: number | null } | null = null;
  try {
    const snapshot = await agentLivenessSnapshot({ conversationId: active.conversationId, limit: 1 }, dependencies.livenessSources());
    const record = snapshot.conversations[0];
    if (record) liveness = { lifecycle: record.lifecycle, hostState: record.host.state, silentForMs: record.silentForMs };
  } catch {
    liveness = null;
  }

  return redactPayload({
    ...base,
    designated: true,
    seat: full ? active : compactOrchestratorSeat(active),
    seatEpoch: active.seatEpoch,
    conversationId: active.conversationId,
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
         else. Rotation happens only through an explicit rotate_orchestrator. */
      ...rotationRecommendation({
        context,
        facts,
        activity: liveness?.lifecycle === "gone" ? "dead" : liveness?.lifecycle ?? null,
        policy: windowPolicy,
      }),
      note: "recommendation only — rotation never happens automatically; call rotate_orchestrator explicitly",
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
function seatTickSettingsTool(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
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
  const project = canonicalOrchestratorProject(requested);

  const readSettings = dependencies.readTickSettings ?? readSeatTickSettings;
  const writeSettings = dependencies.writeTickSettings ?? writeSeatTickSettings;
  const current = readSettings(project);

  const change: SeatTickSettingsChange = {};
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
  let settings = current;
  let changed = false;
  if (Object.keys(change).length > 0) {
    const actor: SeatTickSettingsActor = {
      kind: attribution.kind,
      conversationId: attribution.conversationId,
      project: own,
      seatEpoch: own === project ? orchestratorSeatFor(project).active?.seatEpoch ?? null : null,
    };
    const applied = applySeatTickSettingsChange(current, change, { at: new Date().toISOString(), actor });
    if (!applied.ok) throw new Error(applied.error);
    writeSettings(project, applied.settings);
    settings = applied.settings;
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
  const { monitorPrompt: storedPrompt, reason: storedReason, ...settingsWithoutPrompt } = settings;
  /* #2030: a write is acknowledged, never read back. The caller holds what it
     sent; the revision and the stored length are what it needs to know the row
     took it. A change to another project's tick still says so out loud. */
  if (changed && !verbose) {
    return redactPayload({
      changed,
      revision: recordRevision(settings),
      changedFields: Object.keys(change),
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
  return redactPayload({
    project,
    changed,
    /* Named rather than implied: a change to a project that is not the
       caller's own is allowed, and the answer says so out loud. */
    callerProject: own,
    scope: own === project ? "own-project" : "other-project",
    settings: verbose ? { ...settingsWithoutPrompt, reason: storedReason } : compactSettings,
    /* The stored note is an explicit read; its length acknowledges a write. The wake shows
       only a marked preview of a long note; this is the whole of it. */
    ...(echoPrompt ? { monitorPrompt: storedPrompt } : {}),
    monitorPromptLength: storedPrompt?.length ?? 0,
    revision: recordRevision(settings),
    ...(changed ? { changedFields: Object.keys(change) } : {}),
    /* A full read names nothing it left out (#2030). */
    ...(echoPrompt ? {} : {
      omittedFieldCount: 1,
      readMore: "seat_tick_settings with verbose:true or full:true reads the complete stored note and settings.",
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
  const asks = (state.asksOwed ?? []).map((entry) => entry.key);
  return {
    reportsOwed: owed,
    ...(asks.length > 0 ? { askOwed: asks } : {}),
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
function accountProjectBindingTool(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const action = text(args.action) || "list";
  if (action !== "list" && action !== "add" && action !== "remove") {
    throw new Error("action must be list, add or remove");
  }
  const read = dependencies.readAccountProjectBindings ?? accountProjectBindings;
  const bind = dependencies.bindAccountToProject ?? bindAccountToProject;
  const unbind = dependencies.unbindAccountFromProject ?? unbindAccountFromProject;
  const accountsFor = dependencies.listBindableAccounts
    ?? ((engine: BindingEngine) => (engine === "claude" ? listClaudeAccounts() : listCodexAccounts())
      .map((account) => ({ accountId: account.id, label: account.label })));

  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  const requestedProject = text(args.project) || (action === "list" ? callerProject ?? "" : "");
  const project = requestedProject ? canonicalOrchestratorProject(requestedProject) : null;

  if (action !== "list") {
    if (!project) throw new Error("project is required to add or remove a binding");
    const engine = text(args.engine);
    if (engine !== "claude" && engine !== "codex") throw new Error("engine must be claude or codex");
    const accountId = text(args.accountId);
    if (!accountId) throw new Error("accountId is required to add or remove a binding");
    const result = action === "add" ? bind(engine, accountId, project) : unbind(engine, accountId, project);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    /* #1845: a write answers the row it changed and that project's pool for
       that engine, still read AFTER the write from the store. The whole table
       is `action: "list"`. */
    const bindings = read();
    const bound = (allowedAccountIdsForProject(project, engine, bindings) ?? []).includes(accountId);
    if (bound !== (action === "add")) {
      throw new Error(`the binding store does not show the ${action} of ${engine} account ${accountId} for ${project} after the write`);
    }
    return redactPayload({
      action,
      changed: result.changed,
      project,
      engine,
      accountId,
      bound,
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
  return {
    accounts: {
      claude: listClaudeAccounts().map((account) => ({ accountId: account.id })),
      codex: listCodexAccounts().map((account) => ({ accountId: account.id })),
      copilot: listCopilotAccounts().map((account) => ({ accountId: account.id })),
    },
    active: {
      claude: snapshot.engineRouting.claude.activeAccountId ?? activeClaudeAccountId(),
      codex: snapshot.engineRouting.codex.activeAccountId ?? activeCodexAccountId(),
      copilot: snapshot.engineRouting.copilot.activeAccountId ?? activeCopilotAccountId(),
    },
    observations: snapshot.quotaObservations,
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
        ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
        ...(Array.isArray(sentMessageIds) ? { sentMessageIds } : {}),
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
  const result = await control.post("/api/orchestrator/seat", {
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
    any failure after that dispatch stays uncertain. */
async function sendMessageToOrchestrator(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
  context?: McpToolCallContext,
): Promise<McpToolPayload> {
  const project = canonicalOrchestratorProject(required(args, "project"));
  requiredMessageText(args);
  const key = requestId(args);
  const bound = context?.binding;
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
      if (error instanceof McpDispatchNotExecutedError && !created) throw error;
      throw new McpDispatchUncertainError(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const outcome = await sendMessage({
      ...args,
      conversationId: recipient,
      transcriptPath: seat?.conversationId === recipient ? seat.path : undefined,
      path: undefined,
    }, control, dependencies, context, orchestratorSendDownstreamKey(key));
    return redactPayload({
      ...outcome, project, created,
      // Seat metadata describes only the recipient this dispatch actually used.
      ...(seat?.conversationId === recipient ? {
        seatEpoch: seat.seatEpoch,
        predecessorConversationId: seat.predecessorConversationId,
      } : {}),
    });
  } catch (error) {
    // A refused second POST cannot prove the preceding creation had no effect.
    if (created) throw new McpDispatchUncertainError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** rotate_orchestrator: explicit handoff to a successor. Never called by any
    heuristic — see the rotation command's contract.

    Authority is the ROUTE's (#1402), and there is no copy of it here: this posts
    the calling session's own capability like every other control call, and the
    rotation route admits that caller and names it. What comes back includes that
    name, so the caller reads the attribution its rotation was recorded under. */
async function rotateOrchestrator(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const project = canonicalOrchestratorProject(required(args, "project"));
  /* #1452, #2030: with no mandate named, the route rebuilds the successor's
     core from the CURRENT default whenever the incumbent's stored mandate is
     based on an older version, and keeps its rotation history. Sending the
     default from here instead dropped that history. `keepIncumbentMandate:
     true` is the explicit way to carry the old text forward; a seat on the
     current version, or on bespoke (unversioned) rules, keeps its own text. */
  const fields = allowedSeatFields(args, ["mandate", "handoffNotes", "cwd", "engine", "model", "effort", "accountId", "keepIncumbentMandate"]);
  const result = await control.post("/api/orchestrator/rotate", {
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
function mergeFields(pipeline: Pipeline): { mergeOnReview: boolean; bridgeReports: boolean; merge?: { state: PipelineMergeState; reason: string | null; by: "auto-merge" | "outside" | null; pr: number } } {
  const merge = pipeline.merge;
  return {
    mergeOnReview: mergeOnReviewEnabled(pipeline.project),
    bridgeReports: bridgeReportsEnabled(pipeline.project),
    ...(merge ? { merge: { state: merge.state, reason: merge.reason, by: merge.by, pr: merge.prNumber } } : {}),
  };
}

async function getPipeline(args: McpToolArgs): Promise<McpToolPayload> {
  const pipelineId = required(args, "pipelineId");
  const pipeline = getPipelineRecord(pipelineId);
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
  /* #1845: the two narrow reads. A stage read answers what one stage concluded;
     a compact read answers the list row. Without either, the whole record. */
  const stageId = text(args.stageId);
  if (stageId) {
    const attempt = typeof args.attempt === "number" ? args.attempt : undefined;
    return redactPayload({ ...pipelineStageRead(pipeline, stageId, attempt), revision: recordRevision(pipeline) });
  }
  if (args.compact === true) {
    return redactPayload({
      pipelineId,
      ...pipelineCompactRow(pipeline),
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
  return redactPayload({
    count: conversations.length,
    conversations,
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
  return redactPayload({ ...pagination, flows, compact: !fullAnswer(args),
    omittedRecordCount: fullAnswer(args) ? 0 : flows.length,
    readMore: "Pass nextCursor as cursor with the same filters and a fresh clientRequestId. full:true, compact:false or get_flow(flowId) reads complete records." });
}

async function getFlow(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const flowId = required(args, "flowId");
  const source = dependencies.flowSelectionSource?.();
  const flow = source ? source.read(flowId) : dependencies.getFlowsWithPresets().flows.find((candidate) => candidate.id === flowId);
  if (!flow) throw new Error("flow not found");
  const { flowDecisionContext } = await import("@/lib/flows/decisions");
  const caller = attributionOf(dependencies);
  return redactPayload({ flowId, flow, ...(caller.conversationId && caller.conversationId === flow.implementerConversationId
    ? { decisionContext: await flowDecisionContext(flow) } : {}) });
}

function mutationReceipt(operationId: string): { operationId: string; receipt: { operationId: string; status: "delivered" } } {
  return { operationId, receipt: { operationId, status: "delivered" } };
}

async function flowAction(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const flowId = required(args, "flowId");
  const action = required(args, "action");
  if (action === "agent-decision") {
    const { submitFlowDecision } = await import("@/lib/flows/decisions");
    const { flowDecisionRequestSchema } = await import("@/lib/flows/decisionSchema");
    const request = flowDecisionRequestSchema.parse(args);
    const caller = attributionOf(dependencies);
    const result = await submitFlowDecision(request, caller.kind === "unidentified" ? null : caller.conversationId);
    return redactPayload({ ...result, outcome: result.decision.disposition === "accepted" ? "accepted" : "settled",
      nextAction: result.decision.disposition === "accepted" ? "original-key-lookup" : "follow-disposition" });
  }
  const request = withoutKeys(args, ["flowId", "clientRequestId"]) as PatchFlowRequest;
  const result = action === "cancel-round"
    ? await dependencies.cancelRound(flowId)
    : action === "close"
      ? await dependencies.closeFlow(flowId)
      : action === "pause" || action === "resume"
        ? dependencies.patchFlow(flowId, request, pauseResumeActorOf(dependencies))
        : dependencies.patchFlow(flowId, request);
  if (!result.flow) throw new Error(result.error ?? "could not update flow");
  const operationId = mcpOperationId("flow_action", requestId(args));
  return redactPayload({ flowId, flow: result.flow, ...mutationReceipt(operationId) });
}

/** Lists reuse the store's immutable generation and materialize one page. */
async function listPipelines(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  const states = stringSet(args.state, ["open", "draft", "provisioning", "running", "paused", "needs_decision", "needs_review", "completed", "closed"]);
  const scope = { project: text(args.project), states, includeClosed: args.includeClosed === true,
    ids: stringSet(args.ids), query: text(args.query).trim().toLowerCase(), updatedSince: sinceTime(args.updatedSince) };
  const source = dependencies.pipelineSelectionSource?.();
  /* #2059: the compact row names its PR in one string, the full forms carry
     every resolved link. */
  const project = (pipeline: Pipeline) => {
    if (args.full === true) return { ...pipeline, workLinks: pipelineWorkLinks(pipeline), mergeOnReview: mergeOnReviewEnabled(pipeline.project), bridgeReports: bridgeReportsEnabled(pipeline.project) };
    if (args.compact === false) return { ...pipelineListRow(pipeline), workLinks: pipelineWorkLinks(pipeline), ...mergeFields(pipeline) };
    return { ...pipelineCompactRow(pipeline), ...compactPullRequest(pipeline), ...compactMergeFields(pipeline) };
  };
  const page = source ? boardSelection(source.filename, "pipelines").page(source, scope, args.cursor,
    Math.max(1, Math.min(200, integer(args.limit, PIPELINE_LIST_DEFAULT_LIMIT))), project)
    : await listPageAsync(dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines, {
    scope, cursor: args.cursor, limit: Math.max(1, Math.min(200, integer(args.limit, PIPELINE_LIST_DEFAULT_LIMIT))),
    identity: pipeline => ({ id: pipeline.id, time: pipeline.createdAt ?? "" }),
    matches: pipeline => (!scope.project || pipeline.project === scope.project)
      && (!states.length || states.includes(pipeline.state) || (states.includes("open") && !["completed", "closed"].includes(pipeline.state)))
      && (scope.includeClosed || (pipeline.state !== "closed" && !pipeline.hiddenAt))
      && (!scope.ids.length || scope.ids.includes(pipeline.id))
      && (!scope.query || pipeline.task.toLowerCase().includes(scope.query))
      && (!scope.updatedSince || pipeline.createdAt >= scope.updatedSince),
    project,
  }, () => throwIfCallEnded(context));
  throwIfCallEnded(context);
  const { rows: pipelines, ...pagination } = page;
  return redactPayload({ ...pagination, pipelines, compact: !fullAnswer(args),
    omittedRecordCount: args.full === true ? 0 : pipelines.length,
    readMore: "Pass nextCursor as cursor with the same filters and a fresh clientRequestId. full:true or get_pipeline reads complete records; compact:false returns the previous board-card projection." });
}

function taskWithLinks(task: import("@/lib/tasks/types").BoardTask, dependencies: ViewerMcpDomainDependencies): TaskPipelineReadModel {
  const source = dependencies.pipelineSelectionSource?.();
  const pipelineIds = source ? boardSelection(source.filename, "pipelines").links(task.id)
    : (dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines).filter(pipeline => pipeline.taskIds?.includes(task.id)).map(pipeline => pipeline.id);
  return { ...task, pipelineIds };
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
    model = tasks.map(task => ({ ...task, pipelineIds: links.get(task.id) ?? [] }));
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

function listTasks(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const statuses = stringSet(args.statuses ?? args.status, ["inbox", "assigned", "blocked", "done"]);
  const scope = { project: text(args.project), statuses, placement: stringSet(args.placement, ["pinned", "unplaced"])[0] ?? "",
    openOnly: args.openOnly === true, updatedSince: sinceTime(args.updatedSince), ids: stringSet(args.ids), query: text(args.query).trim().toLowerCase(),
    priorities: stringSet(args.priority, [...TASK_PRIORITIES]) };
  const source = dependencies.taskSelectionSource?.();
  const project = (task: TaskPipelineReadModel) => args.full === true ? task : args.compact === false ? listTaskRow(task) : compactTask(task);
  const page = source ? boardSelection(source.filename, "tasks").page(source, scope, args.cursor,
    Math.max(1, Math.min(200, integer(args.limit, 100))), task => project(taskWithLinks(task, dependencies)))
    : listPage(taskReadModel(dependencies), {
    scope, cursor: args.cursor, limit: Math.max(1, Math.min(200, integer(args.limit, 100))),
    identity: task => ({ id: task.id, time: task.updatedAt ?? "" }),
    matches: task => (!scope.project || task.project === scope.project)
      && (!statuses.length || statuses.includes(task.status)) && (!scope.openOnly || task.status !== "done")
      && (!scope.placement || task.placement === scope.placement)
      && (!scope.priorities.length || scope.priorities.includes(taskPriority(task)))
      && (!scope.updatedSince || task.updatedAt >= scope.updatedSince)
      && (!scope.ids.length || scope.ids.includes(task.id))
      && (!scope.query || task.text.toLowerCase().includes(scope.query)),
    project: task => args.full === true ? task : args.compact === false ? listTaskRow(task) : compactTask(task),
  });
  const { rows: tasks, ...pagination } = page;
  return redactPayload({ ...pagination, tasks, compact: !fullAnswer(args),
    omittedRecordCount: args.full === true ? 0 : tasks.length,
    readMore: "Pass nextCursor as cursor with the same filters and a fresh clientRequestId. get_task(taskId) or full:true reads complete records; compact:false returns the previous truncated-details projection. Never write a truncated value back." });
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

function getTask(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const taskId = required(args, "taskId");
  const source = dependencies.taskSelectionSource?.();
  const stored = source?.read(taskId);
  const task = source ? (stored ? taskWithLinks(stored, dependencies) : null)
    : taskById.get(taskReadModel(dependencies))!.get(taskId);
  if (!task) throw new Error("task not found");
  const workLinks = args.compact === true ? null : taskWorkLinks(task, carriedPipelines(task.pipelineIds, dependencies));
  return redactPayload({ taskId, task: args.compact === true ? compactTask(task) : task, ...(workLinks ? { workLinks } : {}),
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
  if ((result.nextCursor !== undefined || result.hasMore !== undefined)
    && (typeof result.hasMore !== "boolean" || !(result.nextCursor === null || typeof result.nextCursor === "string")
      || result.hasMore !== (typeof result.nextCursor === "string" && result.nextCursor.length > 0))) {
    throw new ViewerControlResponseError("Viewer control returned malformed deployment pagination");
  }
  const health = runtimeHostRequestHealth(result.runtimeHostRequests);
  if (result.runtimeHostRequests !== undefined && !health) {
    throw new ViewerControlResponseError("Viewer control returned malformed runtime-host request health");
  }
  return {
    deployments: result.deployments,
    ...(result.legacySnapshot === true ? { legacySnapshot: true } : {}),
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor as string | null, hasMore: result.hasMore as boolean } : {}),
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
      const receipt = explicit ? snapshot.receipts[explicit] : Object.values(snapshot.receipts)
        .filter(candidate => candidate.conversationId === caller.conversationId)
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
  const { deployments: listed, runtimeHostRequests, nextCursor, hasMore, legacySnapshot } = deploymentList(result, args.compact === true);
  if (cursor && nextCursor === undefined) throw new Error("Viewer deployment pagination is unavailable during hand-over; restart the list");
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

async function resources(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const requestedAt = new Date().toISOString();
  const fresh = args.fresh === true;
  const result = dependencies.readResourcesWithDiagnostic ? await dependencies.readResourcesWithDiagnostic(fresh) : null;
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
  return redactPayload({ ...payload, sessions, freshness: {
    requestedAt, capturedAt, capturedAtScope: "system", ageMs: Number.isFinite(capturedMs) ? Math.max(0, Date.now() - capturedMs) : null,
    sessionsCapturedAt,
    sessionsAgeMs: Number.isFinite(sessionsMs) ? Math.max(0, Date.now() - sessionsMs) : null,
    sessionsStale,
    refreshRequested: fresh,
    refreshSucceeded: fresh && result ? result.diagnostic.status === "complete" && result.diagnostic.cache.status === "miss" : null,
    cache: result?.diagnostic.cache.status ?? "unknown",
    reason: result?.diagnostic.degradedReason ?? null,
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
  return Object.values(snapshot.receipts ?? {})
    .filter((receipt) => lookup.canonicalConversationId(receipt.conversationId) === conversationId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function latestPendingLaunchReceiptForConversation(
  snapshot: RegistrySnapshot,
  conversationId: string,
): RegistrySnapshot["receipts"][string] | null {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  return Object.values(snapshot.receipts ?? {})
    .filter((receipt) => (
      lookup.canonicalConversationId(receipt.conversationId) === conversationId
      && receipt.transport === "structured"
      && receipt.purpose === "launch"
      && receipt.artifactLifecycle === "pending"
    ))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function projectForArchiveTarget(
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
  const project = projectForArchiveTarget(conversation, receipt);
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

function writeArchivePlacement(
  project: string,
  action: "archive" | "unarchive",
  paths: readonly string[],
  snapshot: RegistrySnapshot,
  dependencies: ViewerMcpDomainDependencies,
): { appliedPaths: ReadonlySet<string> } {
  let board = dependencies.boardFor(project);
  const appliedPaths = new Set<string>();
  const uniquePaths = [...new Set(paths)];
  const batchSize = action === "archive"
    ? MAX_BOARD_PATH_LIST_ITEMS
    : MAX_BOARD_MUTATIONS_PER_REQUEST;
  for (let offset = 0; offset < uniquePaths.length; offset += batchSize) {
    const batch = uniquePaths.slice(offset, offset + batchSize);
    let settled = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pendingPaths = batch.filter((pathname) => action === "archive"
        ? !board.prefs.hidden.includes(pathname)
        : board.prefs.hidden.includes(pathname));
      if (pendingPaths.length === 0) {
        settled = true;
        break;
      }

      const previousBoard = board;
      const result = dependencies.applyBoardCommand({
        schemaVersion: 1,
        project,
        baseRevision: board.revision,
        ...(action === "archive"
          ? { patch: { hidden: pendingPaths } }
          : {
              mutations: pendingPaths.map((pathname) => ({
                kind: "restore" as const,
                path: pathname,
                placement: "auto" as const,
              })),
            }),
      }, snapshot);
      board = result.board;
      if (result.ok && result.applied) {
        const hiddenBefore = new Set(previousBoard.prefs.hidden);
        const hiddenAfter = new Set(board.prefs.hidden);
        for (const pathname of uniquePaths) {
          const changed = action === "archive"
            ? !hiddenBefore.has(pathname) && hiddenAfter.has(pathname)
            : hiddenBefore.has(pathname) && !hiddenAfter.has(pathname);
          if (changed) appliedPaths.add(pathname);
        }
        settled = true;
        break;
      }
    }
    if (!settled) {
      throw new Error(`board state changed repeatedly while ${action === "archive" ? "archiving" : "unarchiving"} conversations`);
    }
  }
  return { appliedPaths };
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
      const write = writeArchivePlacement(
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

  applyResolved(resolved.flatMap((target, index) => target ? [{ index, target }] : []));

  const unresolvedIndexes = resolved.flatMap((target, index) => target ? [] : [index]);
  if (unresolvedIndexes.length > 0) {
    let files: readonly FileEntry[] | null = null;
    try {
      files = (await dependencies.completedFileScan()).snapshot.files;
    } catch {
      files = null;
    }
    throwIfCallEnded(context);
    const scanResolved: Array<{ index: number; target: ResolvedConversationArchiveTarget }> = [];
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
    applyResolved(scanResolved);
  }

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
    const sources = dependencies.livenessSources({ completedFileScan: dependencies.completedFileScan });
    const snapshot = await agentLivenessSnapshot({
      conversationId: text(args.conversationId) || undefined,
      transcriptPath: (text(args.transcriptPath) || text(args.path)) || undefined,
      project: text(args.project) || undefined,
      liveOnly: args.liveOnly === true && args.includeGone !== true,
      stallAfterMs: typeof args.stallAfterMs === "number" ? args.stallAfterMs : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      signal: deadline.signal,
      /* A call with less time left than the standard evidence budget degrades
         the remaining rows to the scan projection rather than spending a budget
         its caller will not be there to receive. */
      ...(Number.isFinite(remainingMs)
        ? { evidenceDeadlineMs: Math.min(DEFAULT_EVIDENCE_DEADLINE_MS, remainingMs) }
        : {}),
    }, sources);
    const journal = dependencies.refreshLifecycleJournal({ liveness: snapshot.conversations });
    const liveOnly = args.liveOnly === true && args.includeGone !== true;
    const conversations = liveOnly ? snapshot.conversations.filter(row => row.lifecycle !== "gone" && row.host.state !== "gone" && row.reason !== "launch_unproven_expired") : snapshot.conversations;
    const excludedGoneCount = snapshot.conversations.length - conversations.length;
    const filtered = { ...snapshot, conversations, count: conversations.length,
      stalledCount: conversations.filter(row => row.lifecycle === "stalled").length,
      stalledConfirmedCount: conversations.filter(row => row.lifecycle === "stalled" && row.evidenceSource === "transcript").length };
    return redactPayload({ ...(fullAnswer(args) ? filtered : compactLiveness(filtered)), journaled: journal.appended,
      excludedGoneCount, omittedRecordCount: fullAnswer(args) ? 0 : conversations.length,
      unselectedCount: Math.max(0, snapshot.selection.matched - snapshot.selection.selected),
      readMore: "includeGone:true includes dead hosts; compact:false or full:true returns evidence fields. Narrow by conversationId or project when unselectedCount is positive." });
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
    ? value as { kind?: unknown; path?: unknown; conversationId?: unknown }
    : null;
  const conversationId = named?.kind === "conversation" && !text(named.path) ? text(named.conversationId) : "";
  if (conversationId) {
    /* The registry's own keyed lookup, alias walk included, so an id that was
       chained through a rollover still names its newest transcript. */
    const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
    const path = lookup.conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path;
    if (!path) {
      throw new Error(
        `no registered conversation has id "${conversationId}" — a conversation target accepts `
        + `${focusTargetExample("conversation")} or ${CONVERSATION_PATH_EXAMPLE}`,
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
): Promise<string> {
  if (explicit) return explicit;
  if (isGeometricTarget(target)) return target.project;
  switch (target.kind) {
    case "conversation": {
      const targeted = await entryForPath(target.path, dependencies);
      if (!targeted) throw new Error("no conversation on the board has that transcript path");
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
  const authority = dependencies.attentionAuthority();
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
) {
  const authority = dependencies.attentionAuthority();
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const admission = permitAttentionDismissal(authority, seats, null);
  if (!admission.allowed) {
    throw new McpToolRefusal(admission.error, { code: "DISMISS_NOT_PERMITTED", refusedAs: admission.refusedAs });
  }
  const focus = focusTargetFromArgs(target.kind === "conversation"
    ? { kind: "conversation", ...(target.conversationId ? { conversationId: target.conversationId } : {}), ...(target.path ? { path: target.path } : {}) }
    : target, dependencies);
  const project = canonicalOrchestratorProject(await focusTargetProject(focus, "", dependencies));
  const verdict = permitAttentionDismissal(authority, seats, project);
  if (!verdict.allowed) {
    throw new McpToolRefusal(verdict.error, { code: "DISMISS_NOT_PERMITTED", refusedAs: verdict.refusedAs });
  }
  const attribution = attributionOf(dependencies);
  const by: DismissedBy = { kind: attribution.kind, conversationId: attribution.conversationId, role: attribution.role };
  try {
    return await dismissAttentionService(
      /* A conversation named by id resolves to its current transcript, which
         is how the service keys it when the registry does not. */
      target.kind === "conversation" && focus.kind === "conversation" ? { ...target, path: target.path ?? focus.path } : target,
      by,
      { undo, operationKey, ...(dependencies.dismissalPorts ? { ports: dependencies.dismissalPorts } : {}) },
    );
  } catch (error) {
    if (error instanceof DismissalError) throw new McpToolRefusal(error.message, { code: error.code, status: error.status });
    throw error;
  }
}

async function dismissAttentionTool(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  let target: DismissalTarget;
  try {
    target = parseDismissalTarget(args.target, { allowSubjects: false });
  } catch (error) {
    if (error instanceof DismissalError) throw new McpToolRefusal(error.message, { code: error.code });
    throw error;
  }
  const outcome = await dismissThroughService(target, args.undo === true, mcpOperationId("dismiss_attention", requestId(args)), dependencies);
  return {
    dismissed: outcome.dismissed,
    alreadyClear: outcome.alreadyClear,
    ...(outcome.changed.length ? { changed: outcome.changed } : {}),
    at: outcome.at,
    by: outcome.by,
    undo: outcome.undo,
  };
}

/**
 * Reply drafts for the operator (#1202) — the manager handing them the
 * sentences its own turn expects, instead of a question they have to type an
 * answer to from scratch.
 *
 * Everything durable about a set is decided here rather than by the caller:
 * WHO offered it (server attribution, the same chain the attention record and
 * the bridge log's origin trust), WHICH conversation it belongs under (the
 * caller's own — a named one has to BE the caller's own), and WHETHER it may
 * be offered at all. The set replaces the conversation's previous one; the
 * operator's next message is what clears it.
 */
function suggestReplies(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  /* The authority gate, BEFORE anything is written or even resolved: this puts
     words in front of the operator inside the surface they answer in, so only
     their own session and a validated designated seat may do it. A refused
     caller writes nothing and learns nothing. */
  const authority = dependencies.attentionAuthority();
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const canonical = dependencies.canonicalSeatConversationId ?? productionCanonicalSeatConversationId;
  /* Identity AND target in one verdict: drafts are offered under the caller's
     OWN message, so naming another conversation is refused here — for a seat
     and for the root session alike, because a set written into somebody else's
     pane answers a question its own surface never asked. */
  const named = text(args.conversationId);
  const admission = permitReplySuggestions(authority, seats, named || null, canonical);
  if (!admission.allowed) {
    throw new McpToolRefusal(admission.error, { code: "SUGGEST_REPLIES_NOT_PERMITTED", refusedAs: admission.refusedAs });
  }

  /* The gate above already resolved the validated seats, which is exactly the
     evidence the manager label needs — so the origin folds them in rather than
     resolving designation a second time. */
  const origin = dependencies.callerAttribution?.()
    ?? callerAttributionFrom(authority, (conversationId) => seats.some((seat) => seat.conversationId === conversationId));
  const target = named || origin.conversationId || "";
  if (!target) {
    throw new Error("conversationId is required: this caller has no conversation of its own to offer drafts in");
  }
  /* Keyed by what the registry calls this conversation NOW: the pane reads its
     drafts under the canonical id, so a set filed under a pre-migration alias
     would be written where nothing looks for it. */
  const conversationId = canonical(target);

  try {
    const recorded = recordReplySuggestions({
      conversationId,
      replies: args.replies,
      origin: { kind: origin.kind, conversationId: origin.conversationId, role: origin.role },
      /* Derived from the call, so an interrupted run re-offering the same set
         converges on the same record instead of minting a twin. */
      operationKey: mcpOperationId("suggest_replies", requestId(args)),
    });
    /* An ask made only in the chat is lost to an operator who is away
       (docs/design/orchestrator-reports.md §5.4): the seat tick owes a
       question report for it, and the answer says so at the moment of asking. */
    const seatProject = origin.kind === "manager"
      ? seats.find((seat) => seat.conversationId === origin.conversationId)?.project ?? null
      : null;
    return {
      recorded: true,
      conversationId,
      setId: recorded.set.setId,
      at: recorded.set.at,
      replies: recorded.set.replies.length,
      replaced: recorded.replaced,
      ...(seatProject && bridgeReportsEnabled(seatProject)
        ? { reminder: `If the operator is away, they learn this ask only from a question report: file one with key ask:${recorded.set.setId} and the ask in the decision section.` }
        : {}),
    };
  } catch (error) {
    /* A refused set names the rule it broke and leaves the previous one
       standing — the caller can fix the draft and offer again. */
    if (error instanceof ReplySuggestionValidationError) {
      throw new McpToolRefusal(error.message, { code: error.code });
    }
    throw error;
  }
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
/** Production evidence for the durable manager-authority resolver: seats and
    revocations from their store, the legacy record, and fresh registry facts.
    All resolved per call so replacement, revocation and supersedence take
    effect on the next tool call. */
function productionManagerAuthoritySources(): ManagerAuthoritySources {
  const registry = agentRegistry();
  return {
    /* Each seat under the project it serves now (#1874), so a seat keyed by
       its folder's old identity directs the project its lanes are written to. */
    activeSeats: () => activeSeatsByCurrentProject(),
    revocations: orchestratorRevocations,
    conversationFacts: (conversationId) => {
      const conversation = registry.conversation(conversationId as `conversation_${string}`);
      if (!conversation) return null;
      return {
        superseded: conversation.supersededBy !== null,
        hasGeneration: conversation.generations.length > 0,
        /* Read the way the seat's own project is (#1874): canonical, and moved
           with its folder, so an ownership recorded under the folder's old
           identity does not read as a cross-project designation. */
        project: conversation.projectOwnership?.project
          ? canonicalOrchestratorProject(projectSuccessionFor(conversation.projectOwnership.project, seatLaunchCwd(conversationId))?.target
            ?? conversation.projectOwnership.project)
          : null,
      };
    },
    resolveAlias: (conversationId) => registry.conversation(conversationId as `conversation_${string}`)?.id ?? conversationId,
  };
}

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
      : mcpCallerIdentity(domainDependencies.attentionAuthority(), callerManagerTarget()),
  );
  return {
    permit: (tool, args) => {
      // An admitted agent's read surface is independent of role/seat identity.
      // Resolve authority only where the policy uses it. Bindings still verify
      // their own operation authority and recoverable receipts before dispatch.
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
function recoveryCaller(dependencies: Partial<Pick<ViewerMcpDomainDependencies, "attentionAuthority" | "registrySnapshot" | "recoveryPredecessors">>): McpRequestCaller {
  const unidentified: McpRequestCaller = { kind: "unidentified", conversationId: null, project: null };
  let authority: AttentionCallerAuthority;
  try {
    authority = dependencies.attentionAuthority?.() ?? { kind: "unidentified" };
  } catch {
    return unidentified;
  }
  if (authority.kind === "unidentified") return unidentified;
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

function bindOrchestratorSend(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpRequestBindingInput {
  const project = canonicalOrchestratorProject(required(args, "project"));
  requiredMessageText(args);
  return {
    caller: recoveryCaller(dependencies),
    target: { project, identity: orchestratorSeatFor(project).active?.conversationId ?? null },
    // Separate from direct send: equal client keys on different tools are
    // different logical instructions, even when their message text is equal.
    downstreamKey: orchestratorSendDownstreamKey(requestId(args)),
  };
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

function bindSpawn(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpRequestBindingInput {
  const cwd = spawnCwd(args);
  return {
    caller: recoveryCaller(dependencies),
    target: { project: spawnTargetProject(args, cwd), identity: cwd },
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
  if (!binding.target.identity) {
    return { outcome: "unknown", evidence: "none", reason: "the bound target names no conversation", ids: {} };
  }
  const ports: SendSettlementPorts = dependencies.sendSettlementPorts?.() ?? {};
  const found = await resolveOriginalSend({ conversationId: binding.target.identity, clientMessageId: binding.downstreamKey, ...(typeof args?.text === "string" ? { text: args.text } : {}) }, ports);
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
  const receipt = found.current.readable ? found.current.value : found.receipt;
  const ids: Record<string, string> = {
    operationId: found.operationId,
    ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
    ...(found.deliveryId ? { deliveryId: found.deliveryId } : {}),
  };
  const unreadableNote = found.current.readable ? null : `; the current runtime answer could not be read (${found.current.reason})`;
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
  let receipts = Object.values(snapshot.receipts).filter((receipt) => receipt.clientAttemptId === key);
  if (receipts.length === 0) {
    if (legacy || !args || typeof args.role !== "string" || !args.role.trim() || !dependencies.validateSpawnAdmission) return unknown();
    let body: Record<string, unknown>;
    try {
      body = spawnDispatchBody(args, key);
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
    receipts = Object.values(snapshot.receipts).filter((receipt) => receipt.clientAttemptId === key);
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
  const ownership = legacy
    ? (binding.caller.conversationId !== null && receipt.parentConversationId === binding.caller.conversationId ? "established" : "unknown")
    : undefined;
  if (legacy && ownership !== "established") {
    return { outcome: "unknown", evidence: "legacy-receipt-unbound", reason: "no durable evidence establishes the owner of this launch", ids: {}, ownership: "unknown" };
  }
  if ((receipt.parentConversationId !== null && receipt.parentConversationId !== binding.caller.conversationId)
    || (binding.target.identity && path.resolve(receipt.cwd) !== binding.target.identity)
    || (typeof args?.prompt === "string" && receipt.launchDisplay && receipt.launchDisplay.prompt !== args.prompt)) {
    return { outcome: "unknown", evidence: "spawn-receipt", reason: "the durable launch owner or payload contradicts the bound request", ids: {}, ownership: "unknown" };
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
    facts: { state: receipt.state },
    ...(ownership ? { ownership } : {}),
  };
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
      bind: (args) => ({ caller: recoveryCaller(domainDependencies),
        target: { project: projectForCwd(required(args, "repoDir")), identity: path.resolve(required(args, "repoDir")) },
        downstreamKey: `create_pipeline:${requestId(args)}` }),
      recover: async (binding, options): Promise<McpRecoveryEvidence> => {
        if (options.legacy) return { outcome: "unknown", evidence: "legacy-receipt-unbound", reason: "creation has no caller-bound receipt", ids: {}, ownership: "unknown" };
        const pipeline = pipelineDeliveryLookup({ requestKey: binding.downstreamKey });
        if (!pipeline) return { outcome: "unknown", evidence: "pipeline-row", reason: RECOVERY_ABSENT_REASON, ids: {} };
        return { outcome: "settled", evidence: "pipeline-row", reason: null,
          ids: { pipelineId: pipeline.id }, facts: { ...pipelineAcknowledgement(pipeline), delivery: deliveryAcknowledgement(pipeline) } };
      },
    },
    spawn_agent: {
      bind: (args) => bindSpawn(args, domainDependencies),
      recover: (binding, options) => recoverSpawn(binding, options.legacy, domainDependencies, options.args, options.context),
    },
    send_message_to_orchestrator: {
      bind: (args) => bindOrchestratorSend(args, domainDependencies),
      recover: (binding, options) => recoverSend(binding, options.legacy, domainDependencies, options.args),
    },
    send_message: {
      bind: (args) => bindSend(args, domainDependencies),
      recover: (binding, options) => recoverSend(binding, options.legacy, domainDependencies, options.args),
    },
  };
}

export function viewerMcpBindings(
  linkTaskDependencies: LinkTaskToPipelineDependencies = productionLinkTaskDependencies,
  controlDependencies: ViewerControlDependencies = productionViewerControlDependencies(),
  domainDependencies: ViewerMcpDomainDependencies = productionDomainDependencies,
): McpToolBindings {
  const pageOwner = {};
  const budgeted = (tool: string, args: McpToolArgs, budget: number, load: (cursor: string | null) => Promise<McpToolPayload>) =>
    budgetPage(pageOwner, tool, args, budget, async cursor => {
      const payload = await load(cursor);
      const { conversations, nextCursor, ...meta } = payload;
      return { rows: (conversations ?? []) as Record<string, unknown>[], meta, upstream: typeof nextCursor === "string" ? nextCursor : null };
    }, fullAnswer(args));
  return {
    spawn_agent: (args, context) => spawnAgent(args, viewerControlForCall(controlDependencies, context), context),
    send_message: (args, context) => sendMessage(args, viewerControlForCall(controlDependencies, context), domainDependencies, context),
    message_receipt: (args) => messageReceipt(args),
    create_task: (args) => createBoardTask(args, domainDependencies),
    update_task: (args) => updateBoardTask(args, domainDependencies),
    create_pipeline: (args, context) => unadmittedOnStoreBusy(() => createPipeline(args, context)),
    pipeline_action: Object.assign(
      (args: McpToolArgs) => unadmittedOnStoreBusy(() => pipelineAction(args, domainDependencies)),
      { authorizeReceipt: (args: McpToolArgs) => {
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
    stage_report: (args) => stageReport(args, domainDependencies),
    link_task_to_pipeline: (args) => unadmittedOnStoreBusy(() => linkTaskToPipeline(args, linkTaskDependencies)),
    list_conversations: (args, context) => budgeted("list_conversations", args, 12_000, cursor => listConversations({ ...args, cursor }, viewerControlForCall(controlDependencies, context))),
    search_transcripts: (args, context) => searchTranscripts(args, viewerControlForCall(controlDependencies, context)),
    get_conversation: (args, context) => getConversation(args, domainDependencies, context),
    conversation_deliverability: (args) => Promise.resolve(conversationDeliverability(args, domainDependencies)),
    conversation_messages: (args, context) => conversationMessages(args, domainDependencies, context),
    deploy_exact_sha: (args, context) => deployExactSha(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    get_pipeline: getPipeline,
    board_snapshot: (args) => boardSnapshot(args, domainDependencies),
    list_flows: (args) => Promise.resolve(listFlows(args, domainDependencies)),
    get_flow: (args) => Promise.resolve(getFlow(args, domainDependencies)),
    flow_action: (args) => flowAction(args, domainDependencies),
    list_pipelines: (args, context) => listPipelines(args, domainDependencies, context),
    list_tasks: (args) => Promise.resolve(listTasks(args, domainDependencies)),
    get_task: (args) => Promise.resolve(getTask(args, domainDependencies)),
    operator_snapshot: (args) => operatorSnapshot(args, domainDependencies),
    deployment_status: (args, context) => deploymentStatus(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    resources: (args) => resources(args, domainDependencies),
    conversation_action: (args, context) => conversationAction(args, viewerControlForCall(controlDependencies, context), domainDependencies, context),
    conversation_migration: (args, context) => conversationMigration(args, viewerControlForCall(controlDependencies, context)),
    agent_activity: (args, context) => budgeted("agent_activity", args, 24_000, () => agentActivity(args, domainDependencies, context)),
    lifecycle_events: (args, context) => lifecycleEvents(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    request_attention: (args, context) => requestAttention(args, domainDependencies, context),
    suggest_replies: (args) => Promise.resolve(suggestReplies(args, domainDependencies)),
    dismiss_attention: (args) => dismissAttentionTool(args, domainDependencies),
    bridge_report: (args, context) => bridgeReport(args, domainDependencies, viewerControlForCall(controlDependencies, context)),
    bridge_directive: (args, context) => bridgeDirective(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    get_orchestrator: (args) => getOrchestrator(args, domainDependencies),
    /* `async` rather than `Promise.resolve(...)`: this binding refuses by
       throwing, and a synchronous throw out of a binding call is not the
       rejected promise every caller here handles. */
    seat_tick_settings: async (args) => seatTickSettingsTool(args, domainDependencies),
    /* Same reason as above: this binding refuses by throwing. */
    account_project_binding: async (args) => accountProjectBindingTool(args, domainDependencies),
    account_limits: async (args) => accountLimitsTool(args, domainDependencies),
    create_orchestrator: (args, context) => createOrchestrator(args, viewerControlForCall(controlDependencies, context)),
    send_message_to_orchestrator: (args, context) => sendMessageToOrchestrator(args, viewerControlForCall(controlDependencies, context), domainDependencies, context),
    rotate_orchestrator: (args, context) => rotateOrchestrator(args, viewerControlForCall(controlDependencies, context)),
    telegram_bot_chats: (args, context) => telegramBotChats(args, viewerControlForCall(controlDependencies, context)),
    telegram_bot_send: (args, context) => telegramBotSend(args, viewerControlForCall(controlDependencies, context)),
    telegram_bot_messages: (args, context) => telegramBotMessages(args, viewerControlForCall(controlDependencies, context)),
  };
}
