import { safeRelayHttpReason } from "./httpDiagnostics";
import { checkProviderOpens } from "./providerOpens";
import { deliverOwnerLateAnswer } from "./ownerLateDelivery";
import { actionOutcomeAnswer } from "./actionOutcome";
import { CloudFailure, cloudEnvironment, cloudTransport, runCloudRelay, type CloudTransport } from "./cloud";
import { scrubOwnerReply } from "./ownerOutput";
import { cloudOwnerDirectory, CloudOwnerDirectoryError } from "./ownerRun";
import { createOwnerRunDirectory, resolveOwnerRunDirectory } from "./runDirectory";
import { hasInboundMedia, prepareInboundMedia, writeInboundAgentInput } from "./mediaInput";
import { createToolResultMedia } from "./toolResultMedia";
import { isInboundImage, RELAY_HISTORY_MEDIA, validateMediaInput } from "./mediaInputValidation";
import { validateAnswerComposition } from "./composition";
import { answerCapabilities, checkedAnswerV2, checkedRoundV2, withAnswerParts, answerFiles, type AnswerDrop } from "./answerV2";
import { ownerAnswerFileInstructions, stageGeneratedAttachments, uploadAnswerAttachments, type StagedAttachment } from "./attachments";
import { openOwnerAnswer } from "./ownerAnswer";
import { hydrateToolIndex } from "./toolIndex";
import { openOwnerServiceTools } from "./ownerServiceTools";
import { waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { resolveOwnerOutboundContext } from "./ownerOutboundContext";
import { capacityWaiters, olderCapacityWaiter, enterRelayHold, leaveRelayHold, releasingRelayHolds, type RelayHoldCause } from "./hold";
import { relayRequestDeadline, remainingMs } from "./deadline";
import { ownerRelayAuthorized, liveOwnerRelayRequest, ownerRelayAuthorizedAsync, ownerRelayFailureReplyAuthorized, ownerRelayStatusReplyAuthorized, ownerRelayHandoffOutcome, ownerRelayIntentEnabled } from "./ownerAuthority";
import { ownerRequestTimeoutText } from "./requestTimeout";
import { matchPrototypeAnswer } from "@/lib/prototypeReview/telegramAnswer";
import { runPrototypeAnswer } from "./prototypeAnswer";
import { resolveOwnerBridgeContext } from "./ownerBridgeContext";
import { runOwnerAgent, ownerContinuationPrompt, prepareOwnerPrompt, ownerAnswer, ownerFailureAnswer, ownerFailureCustody, type OwnerRunPorts } from "./ownerRun";
import { ownerTurnDiagnostic, type OwnerTurnDiagnostic } from "./diagnostic";
import { readRelaySwitches } from "./switches";
import { compactRequestSchema, type ExternalRelayRequest } from "./protocol";
import { runCompactRequest } from "./compact";
import { conversationAuthority, lookupChainConversationAsync, resolveChainConversationAsync, reserveChainConversationAsync, releaseConversationAsync, prepareConversationAccount, conversationCodexHome, sweepConversationsAsync, type RelayConversation } from "./conversations";
import { activeDrain } from "@/lib/selfUpdate/drain";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { procBackend } from "@/lib/proc";
import {
  runEphemeralAgent,
  EphemeralProfileError,
  type EphemeralAgentRun,
  type EphemeralAgentResult,
} from "@/lib/agent/ephemeral";
import type { HeadlessReviewRuntime } from "@/lib/agent/headless";
import { ExternalRelayError } from "./client";
import { completeRelayRequest } from "./relayCompletion";
import { InlineRelayLeaseTransport, RelayLeaseTransport } from "./relayLeaseTransport";
import {
  answerSchema,
  checkedAnswer,
  guestAnswerSchema,
  replyAnswerSchema,
  roundSchema,
  type ExternalRelayDecision,
  handoffAnswerSchema,
  INVALID_REQUESTER_DETAIL,
  offersHandoff,
  requestSchema,
  type ExternalRelayCompletion,
  type ExternalRelayProgress,
} from "./protocol";
import { callableTools, RELAY_TOOL_ROUNDS, createToolLoop, toolSleep, type ToolLoopRuntime } from "./toolLoop";
import { json, answerPrompt, toolRoundPrompt, conversationTurnPrompt, conversationRoundPrompt } from "./prompt";
import { progressForEvent } from "./progress";
import { createRelaySteps } from "./progressSteps";
import { readRelayStepObservation } from "./stepObservation";
import { markRelayFailureNotice, noteRelayProgress, RELAY_FAILURE_NOTICE_OUTCOME, relayInflightRequests as inflight, relayUnrecordedAcceptances as unrecordedAcceptances } from "./activity";
export { relayRequestInFlight } from "./activity";
import { answerRecorder, countMemberAnswers, readAnswerRecord, type RelayAnswerDelivery } from "./answers";
import {
  answerProfileFor,
  ownerTierFor,
  ownerHandoffIntentPrompt,
  ownerHandoffIntentSchema,
  ownerReplyChain,
  type OwnerInstruction,
  ownerBindingRefusal,
  exemptFromMemberLimit,
  memberLimitFor,
  RELAY_MEMBER_LIMIT_WINDOW_MS,
} from "./profile";
import {
  changeRunAsync,
  claimRelayRequestAsync,
  reserveRelayActionVerificationAsync,
  dropRunAsync,
  reserveRunAsync,
  RelayStoreBusy,
  ownerRelayStoreDeadline,
  readRunLedger,
  runHoldsCapacity,
  ownerStopPending,
  settleRelayRequestClaimAsync,
  type RunRecord,
  type PairedRelay,
  type RelayTargetSettings,
} from "./store";

const globalRelay = globalThis as typeof globalThis & {
  __llvExternalRelayActive?: Map<string, number>;
};
const active = (globalRelay.__llvExternalRelayActive ??= new Map<string, number>());
/** Marks a retained run as delivered. Until the mark is durable this process
 * keeps delivery ownership, so orphan recovery cannot complete it again. */
async function recordAcceptedCompletion(requestId: string): Promise<void> {
  const write = () => changeRunAsync(requestId, row => ({ ...row, completionAccepted: true }), ownerRelayStoreDeadline());
  try { await write(); return; }
  catch { console.error("External relay accepted completion receipt pending"); }
  unrecordedAcceptances.add(requestId);
  void (async () => {
    for (let delay = 100; unrecordedAcceptances.has(requestId); delay = Math.min(delay * 2, 5000)) {
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref(); });
      try { await write(); unrecordedAcceptances.delete(requestId); }
      catch { /* Delivery ownership stays with this process. */ }
    }
  })();
}
export function externalRelayTempRoot(): string {
  const temporary = path.resolve(os.tmpdir());
  const home = path.resolve(os.homedir());
  return temporary === home || temporary.startsWith(home + path.sep)
    ? "/tmp"
    : temporary;
}
const countKey = (relayId: string, targetId: string) =>
  `${relayId}:${targetId}`;
/** Keep only the explicit reply chain needed to interpret this owner request. */
function retainOwnerReplyChain(request: ExternalRelayRequest, ownerMessageId: string): void {
  const retained = ownerReplyChain(request, ownerMessageId);
  request.input.conversation = request.input.conversation.filter(message => retained.has(message.id));
  const mediaRefs = new Set(request.input.conversation.flatMap(message => (message.media ?? []).map(media => media.ref)));
  request.input.documents = request.input.documents.filter(document =>
    document.message_id ? retained.has(document.message_id) : document.media_ref ? mediaRefs.has(document.media_ref) : retained.size === 1);
  request.input.short_term_memory = null;
}
export function runningCount(relayId: string, targetId: string): number {
  return active.get(countKey(relayId, targetId)) ?? 0;
}
export function advertisedSlots(
  relay: PairedRelay,
): { target_id: string; free: number }[] {
  const drainHeld = !!activeDrain();
  const held = readRunLedger().runs;
  return relay.targets
    .filter((target) => target.enabled && target.engine && target.model)
    .map((target) => {
      const running = runningCount(relay.id, target.id);
      const retained = held.filter(run => run.relayId === relay.id && run.targetId === target.id && runHoldsCapacity(run)).length;
      const waiting = capacityWaiters(relay.id, target.id);
      const free = drainHeld ? 0 : Math.max(0, target.concurrency - Math.max(running, retained) - waiting);
      if (free === 0) console.info("External relay target capacity", {
        target: target.id, free, concurrency: target.concurrency, running, retained, waiting, reason: drainHeld ? "drain" : "full",
      });
      return { target_id: target.id, free };
    });
}
function markActive(relay: PairedRelay, target: RelayTargetSettings): void {
  const key = countKey(relay.id, target.id);
  const count = active.get(key) ?? 0;
  active.set(key, count + 1);
}
function free(relay: PairedRelay, target: RelayTargetSettings) {
  const key = countKey(relay.id, target.id);
  active.set(key, Math.max(0, (active.get(key) ?? 1) - 1));
}
const declined = (
  lease_id: string,
  reason: string,
  retry_after_s: number | null = null,
  detail: string | null = null,
): ExternalRelayCompletion => ({
  lease_id,
  outcome: "declined",
  reason,
  detail,
  retry_after_s,
});
/** The line a hand-off carries (§A.8). It is the install's own words: nothing the model wrote. */
export const HANDOFF_DETAIL = "The agent handed this request to the service's own assistant.";
export const GUEST_CLOUD_MEDIA_HANDOFF_DETAIL = "This install cannot inspect guest history photos; the service's own assistant will answer.";
export const memberLimitDetail = (limit: number) =>
  `This member reached ${limit} ${limit === 1 ? "answer" : "answers"} in the last hour in this chat.`;
const failed = (lease_id: string, reason: string): ExternalRelayCompletion => ({
  lease_id,
  outcome: "failed",
  reason,
  detail: null,
});
export { completeRelayRequest } from "./relayCompletion";
const OWNER_INTENT_TIMEOUT_MS = 15_000;
type RelayRuntime = HeadlessReviewRuntime & ToolLoopRuntime & {
  timeoutMs?: number; ownerPorts?: OwnerRunPorts; cloudTransport?: CloudTransport; ownerIntentCommand?: string;
  onUnknownFeature?: () => Promise<unknown>; onLeaseReady?: () => void; leaseWorker?: boolean; ownerRecovery?: RunRecord;
};
export async function runClaimedRequest(
  relay: PairedRelay,
  raw: unknown,
  onFreed?: () => void,
  runtime?: RelayRuntime,
): Promise<ExternalRelayCompletion | null> {
  const serviceDeadline = relayRequestDeadline(raw);
  const recovery = runtime?.ownerRecovery;
  // Recovery has a fresh local admission window, but never reopens the service request.
  const deadline = recovery ? relayRequestDeadline(null) : serviceDeadline;
  const claimId = raw && typeof raw === "object" ? (raw as Record<string, unknown>).request_id : null;
  if (deadline.fallback && typeof claimId === "string")
    console.info("External relay deadline", { request: claimId.slice(0, 8), fallback: deadline.fallback });
  if (readRelaySwitches().compact && raw && typeof raw === "object" && (raw as Record<string, unknown>).kind === "compact") {
    const compact = compactRequestSchema.safeParse(raw);
    if (compact.success) return runCompactRequest(relay, compact.data, onFreed, runtime);
    const invalid = raw as Record<string, unknown>;
    if (typeof invalid.request_id !== "string" || typeof invalid.lease_id !== "string") return null;
    const recorder = answerRecorder({ requestId: invalid.request_id, relayId: relay.id, targetId: invalid.target_id,
      targetName: null, claimedAt: invalid.claimed_at, input: invalid.input });
    const body = declined(invalid.lease_id, "invalid_request");
    recorder?.finish({ outcome: "declined:invalid_request", answer: null, delivery: "unconfirmed" });
    const sent = await completeRelayRequest(relay, invalid.request_id, body, () => deadline.at,
      undefined, runtime?.onUnknownFeature, undefined, recorder?.recordCompletionRefusal);
    recorder?.recordDelivery({ outcome: "declined:invalid_request", delivery: sent.delivery });
    return sent.body;
  }
  const parsed = requestSchema.safeParse(raw);
  const refusalDetail = parsed.success
    ? ownerBindingRefusal(relay, parsed.data)
    : parsed.error.issues.find(issue => issue.message === INVALID_REQUESTER_DETAIL)?.message ?? null;
  const request = parsed.success && !refusalDetail ? parsed.data : null;
  const caps = request ? answerCapabilities(request, relay.targets.find(t => t.id === request.target_id)?.engine ?? "") : null;
  const rawId =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).request_id
      : null;
  const rawLease =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).lease_id
      : null;
  if (!request && (typeof rawId !== "string" || typeof rawLease !== "string"))
    return null;
  const requestId = request?.request_id ?? (rawId as string);
  const leaseId = request?.lease_id ?? (rawLease as string);
  let heartbeatAt = deadline.receivedAt;
  if (request) console.info("External relay claim received", { request: requestId.slice(0, 8), kind: request.kind });
  if (inflight.has(requestId) || !recovery && readRunLedger().runs.some((run) => run.requestId === requestId)) return null;
  const claimOwnerPid = process.pid;
  const claimOwnerIdentity = procBackend.processIdentity(claimOwnerPid);
  if (!claimOwnerIdentity) return null;
  let requestClaim: Awaited<ReturnType<typeof claimRelayRequestAsync>>;
  try {
    requestClaim = await claimRelayRequestAsync(requestId, leaseId, deadline.at);
  } catch (error) {
    if (!(error instanceof RelayStoreBusy)) throw error;
    // A claim-lock timeout gives this process no request custody. Let the
    // paired service's fixed deadline produce its timeout error; an unclaimed
    // busy completion could race a different process that later acquires it.
    return null;
  }
  if (requestClaim.kind === "duplicate") return null;
  if (requestClaim.kind === "terminal")
    return requestClaim.completion ? { ...requestClaim.completion, lease_id: leaseId } : null;
  if (recovery) await changeRunAsync(requestId, row => ({ ...row,
    ownerPid: claimOwnerPid, ownerIdentity: claimOwnerIdentity }), ownerRelayStoreDeadline());
  const terminal: { completion: ExternalRelayCompletion | null } = { completion: null };
  let claimSettled = false;
  let claimTerminal = false;
  const settleClaim = async (disposition: "terminal" | "release", until = ownerExecution ? Math.max(deadline.at, ownerRelayStoreDeadline()) : deadline.at) => {
    await settleRelayRequestClaimAsync(requestId, leaseId, claimOwnerPid, claimOwnerIdentity, disposition,
      disposition === "terminal" ? terminal.completion : null, until);
    claimSettled = true;
  };
  const rawRequest = raw as Record<string, unknown>;
  const targetId = request?.target_id ?? rawRequest.target_id;
  const recorder = answerRecorder({
    requestId,
    relayId: relay.id,
    targetId,
    targetName: relay.targets.find((item) => item.id === targetId)?.name ?? null,
    claimedAt: rawRequest.claimed_at,
    chatKey: request?.chat?.key ?? null,
    requester: request?.input.requester ?? null,
    input: refusalDetail ? null : rawRequest.input,
    ...(request?.features ? { features: request.features } : {}),
  });
  inflight.add(requestId);
  const ownerCredentials = [relay.credential, process.env.LLV_CODEX_CLOUD_TOKEN].filter((value): value is string => !!value);
  let diagnostic: OwnerTurnDiagnostic | undefined;
  const recordDiagnostic = (value: OwnerTurnDiagnostic) => {
    if (!diagnostic && value.promptBudget) {
      const actions = (loop?.results ?? ownerTools?.loop.results ?? []).filter(result => result.effect === "action");
      const confirmation = actions.findLast(result => result.status === "confirmation_pending");
      const priorAction = actions.some(result => result.execution_unknown || result.status === "outcome_unknown") ? "unknown"
        : confirmation ? confirmation.expires_in_s === 0 ? "confirmation_expired" : "confirmation_pending"
          : actions.some(result => result.status === "ok") ? "completed" : undefined;
      value = { ...value, promptBudget: { ...value.promptBudget, ...(priorAction ? { priorAction } : {}) } };
    }
    diagnostic ??= value;
    recorder?.diagnose(diagnostic);
  };
  // Guest failure details belong only to the request record, even after masking.
  const logDiagnostic = (label: string, value: OwnerTurnDiagnostic) => {
    console.error(label, JSON.stringify({ requestId, diagnostic: request?.delivery === "guest"
      ? { source: value.source } : value }));
  };
  let releaseRequested = false;
  let deliverySettled!: () => void;
  const released = new Promise<void>(resolve => { deliverySettled = resolve; });
  let allowOwnerReply: (() => boolean) | undefined;
  let failureReply = false;
  let ownerStatusReply: ExternalRelayCompletion | undefined;
  // True while the body to deliver is a failure or timeout notice composed by
  // this runner. It reaches the service as `answered`; local records name it.
  let failureNotice = false;
  const outcomeLabel = (value: ExternalRelayCompletion) => value.outcome !== "answered" ? `${value.outcome}:${value.reason}`
    : failureNotice ? RELAY_FAILURE_NOTICE_OUTCOME : "answered";
  // One journal line per request this process finished: fields only, no text.
  const journal: { outcome: string; delivery: RelayAnswerDelivery | null; written: boolean } = { outcome: "lease_lost", delivery: null, written: false };
  const journalFinished = () => {
    if (journal.written) return;
    journal.written = true;
    console.info("External relay request finished", JSON.stringify({ event: "relay_request_finished", requestId, relayId: relay.id,
      targetId: typeof targetId === "string" ? targetId : null, owner: ownerExecution, outcome: journal.outcome, delivery: journal.delivery,
      diagnosticSource: diagnostic?.source ?? null, durationMs: Date.now() - deadline.receivedAt, promptBytes: chain?.promptBytes ?? null }));
  };
  let leaseUnavailable = false;
  let ownerExecution = false;
  let executionDeadline = Infinity;
  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  const ownerPastWindow = () => ownerExecution && (!!recovery || leaseUnavailable || Date.now() >= serviceDeadline.at);
  let admissionHeld = false;
  const admissionCutoff = () => admissionHeld ? deadline.declineAt : deadline.at;
  let rounds = 0;
  let ownerTools: ReturnType<typeof openOwnerServiceTools> | null = null;
  let localOwnerConversationId: string | null = null;
  let loop: ReturnType<typeof createToolLoop> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let transport: RelayLeaseTransport | InlineRelayLeaseTransport | null = null;
  let completionDowngrade: string | undefined;
  let pendingBeat: Promise<void> | null = null;
  let finishing: Promise<ExternalRelayCompletion | null> | null = null;
  let ownerParts: ReturnType<typeof openOwnerAnswer> | null = null;
  let stagedAttachments: StagedAttachment[] = [];
  let inbound: Awaited<ReturnType<typeof prepareInboundMedia>> | null = null;
  let toolMedia: ReturnType<typeof createToolResultMedia> | null = null;
  const answerDrops: AnswerDrop[] = [];
  const generatedFiles: string[] = [];
  const generatedSources = new Map<string, Set<string>>();
  let chain: { continued: boolean; promptBytes: number } | undefined;
  let resultDelivered = false;
  let completionAccepted = false;
  let completionInFlight = false;
  let activeCapacityFreed = false;
  let activeTarget: RelayTargetSettings | null = null;
  let recorded = false;
  let capacityReleaseRetry: Promise<void> | null = null;
  let releaseCapacity: (() => Promise<void>) | null = null;
  let initialLeaseNotified = false;
  const notifyInitialLease = () => {
    if (initialLeaseNotified) return;
    initialLeaseNotified = true;
    runtime?.onLeaseReady?.();
  };
  let executionScope = false;
  const loopRecord = () => ({ ...(loop ? { rounds, toolCalls: loop.records } : ownerTools?.records.length ? { toolCalls: ownerTools.records } : {}), ...(chain ? { chain } : {}) });
  const finish = (body: ExternalRelayCompletion): Promise<ExternalRelayCompletion | null> => {
    if (finishing) return finishing;
    finishing = (async () => {
    leaveRelayHold(requestId);
    const actionAnswer = request && actionOutcomeAnswer(request, loop?.results ?? ownerTools?.loop.results ?? []);
    if (actionAnswer) {
      stagedAttachments = [];
      body = { lease_id: leaseId, outcome: "answered", answer: actionAnswer, duration_ms: Date.now() - deadline.receivedAt };
    }
    try {
      if (pendingBeat) {
        if (releaseRequested) void pendingBeat.catch(() => console.error("External relay heartbeat refresh failed during demotion"));
        else await pendingBeat;
      }
      if (caps?.rich && leaseUnavailable && !ownerExecution) return null;
      const explainExpiredHandoff = (): Extract<ExternalRelayCompletion, { outcome: "answered" }> | null => {
        if (!ownerPastWindow() || !owner || !request || body.outcome !== "declined" || body.reason !== "handoff") return null;
        // The service can no longer accept a handoff. Keep an explanation in
        // the same durable delivery path as every other late owner answer.
        stagedAttachments = [];
        const answer = ownerFailureAnswer(request, owner, ownerTurnDiagnostic("observation",
          "The service window closed before the handoff could be requested", ownerCredentials), ownerCredentials);
        return answer ? { lease_id: leaseId, outcome: "answered", answer, duration_ms: Date.now() - deadline.receivedAt } : null;
      };
      const expiredHandoff = explainExpiredHandoff();
      if (expiredHandoff) { body = expiredHandoff; failureNotice = true; }
      if (recovery && ownerExecution && owner && (body.outcome === "declined" || body.outcome === "failed")) {
        const cause = ownerTurnDiagnostic("launch", `Owner retry could not start: ${body.reason}`, ownerCredentials);
        recordDiagnostic(cause);
        failureReply = true;
        await changeRunAsync(requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, diagnostic: cause } }), ownerRelayStoreDeadline());
        const answer = ownerFailureAnswer(request!, owner, cause, ownerCredentials);
        if (answer) { body = { lease_id: leaseId, outcome: "answered", answer, duration_ms: Date.now() - deadline.receivedAt }; failureNotice = true; }
      }
      if (request?.delivery === "guest" && body.outcome === "answered") {
        const answer = checkedAnswer(body.answer, request, { handoff: false, ignore: false });
        body = answer && answer.action !== "handoff" ? { ...body, answer } : failed(leaseId, "invalid_answer");
      }
      // Persist the local decision before any delivery wait: a restart must
      // leave the generated answer and early declines inspectable.
      if (body.outcome === "answered" && allowOwnerReply && !allowOwnerReply()) body = failed(body.lease_id, "cancelled");
      if (body.outcome === "answered" && caps?.rich && request) {
        try { validateAnswerComposition(body.answer, request, stagedAttachments.map(file => ({ attachment_id: file.id, kind: file.kind }))); }
        catch (error) { answerDrops.push({ part: "answer", reason: error instanceof ExternalRelayError ? error.code : "malformed" }); body = failed(body.lease_id, "invalid_answer"); }
      }
      journal.outcome = outcomeLabel(body);
      journal.delivery = "unconfirmed";
      recorder?.finish({
        outcome: outcomeLabel(body),
        answer:
          body.outcome === "answered"
            ? body.answer
            : body.outcome === "declined" && body.reason === "handoff"
              ? { action: "handoff", text: "", reply_to: null }
              : null,
        delivery: "unconfirmed",
        ...loopRecord(),
      });
      if (!ownerPastWindow() && body.outcome === "answered" && body.answer.action === "reply" && caps?.media && request && stagedAttachments.length && !releaseRequested) {
        try {
          body.answer.attachments = await uploadAnswerAttachments(relay, request, stagedAttachments, deadline.at, callAbort.signal, answerDrops,
            { authorize: () => { if (leaseUnavailable || allowOwnerReply && !allowOwnerReply()) throw new Error("relay authorization revoked"); } });
        } catch (error) {
          if (!ownerPastWindow() && (leaseUnavailable || callAbort.signal.aborted || error instanceof ExternalRelayError && (error.status === 404 || error.status === 409 && error.code === "lease_lost"))) {
            leaseUnavailable = true;
            recorder?.annotateV2({ outcome: "lease_lost", drops: answerDrops });
            if (!ownerExecution) { journal.outcome = "lease_lost"; journal.delivery = null; return null; }
            answerDrops.push({part:"attachment",reason:"upload_failed"});
          } else {
            answerDrops.push({part:"attachment",reason:"upload_failed"});
            if (allowOwnerReply && !allowOwnerReply()) body = failed(body.lease_id, "cancelled");
          }
        }
        if (body.outcome === "answered" && !body.answer.text.trim() && !body.answer.attachments?.length) body = failed(body.lease_id, "invalid_answer");
      }
      if (ownerPastWindow() && body.outcome === "answered" && stagedAttachments.length) {
        body.answer.attachments = stagedAttachments.map(file => ({ attachment_id: file.id, kind: file.kind, caption: file.caption }));
      }
      if (body.outcome === "answered" && caps?.rich && request) {
        try { validateAnswerComposition(body.answer, request, stagedAttachments.map(file => ({ attachment_id: file.id, kind: file.kind })), body.answer.attachments ?? []); }
        catch (error) { answerDrops.push({ part: "answer", reason: error instanceof ExternalRelayError ? error.code : "malformed" }); body = failed(body.lease_id, "invalid_answer"); }
      }
      if (body.outcome === "answered" && body.answer.action === "reply" && caps?.rich && !body.answer.text.trim() && !body.answer.attachments?.length) body = failed(body.lease_id, "invalid_answer");
      if (caps?.rich) recorder?.annotateV2({ drops: answerDrops, attachments: stagedAttachments.map(({id,kind,filename,size,sha256}) => ({attachment_id:id,kind,filename,bytes:size,sha256})), ...(body.outcome === "answered" ? { answer: body.answer } : {outcome:`${body.outcome}:${body.reason}`}) });
      journal.outcome = outcomeLabel(body);
      const deliveryStart = Date.now();
      const until = releaseRequested ? deliveryStart : deadline.at;
      if (body.outcome === "answered" && allowOwnerReply && !allowOwnerReply()) body = failed(body.lease_id, "cancelled");
      if (ownerPastWindow() && body.outcome === "answered") {
        // Persist before sending: a restart can replay this idempotent delivery.
        await changeRunAsync(requestId, row => ({ ...row,
          ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...row.ownerTurn?.lateAnswer, body, files: stagedAttachments } } }), ownerRelayStoreDeadline());
      }
      const initiallyLate = ownerPastWindow();
      if (!initiallyLate && allowOwnerReply && recorded && body.outcome === "answered") {
        await changeRunAsync(requestId, row => ({ ...row,
          ownerTurn: { ...row.ownerTurn!, completionAttempt: { body, files: stagedAttachments } } }), ownerRelayStoreDeadline());
      }
      completionInFlight = true;
      let sent: Awaited<ReturnType<typeof completeRelayRequest>>;
      try {
        sent = initiallyLate && body.outcome === "answered"
          ? await deliverOwnerLateAnswer(relay, requestId, body, stagedAttachments, allowOwnerReply!)
          : transport
          ? await transport.complete(body, until, caps?.plainMax ?? 4000, ownerStatusReply ? "status" : failureReply ? "failure" : !!allowOwnerReply)
          : await completeRelayRequest(relay, requestId, body, () => until, allowOwnerReply, runtime?.onUnknownFeature, caps?.plainMax,
            recorder?.recordCompletionRefusal, undefined, refusal => { completionDowngrade = refusal.reason; });
      } catch {
        if (allowOwnerReply && body.outcome === "answered") {
          console.error("Owner relay completion acknowledgement unavailable; delivery retained");
          sent = { body, delivery: "unconfirmed" };
        } else {
          console.error("External relay helper completion unavailable; using Viewer transport");
          sent = await completeRelayRequest(relay, requestId, body, () => until, allowOwnerReply, runtime?.onUnknownFeature, caps?.plainMax,
            recorder?.recordCompletionRefusal, undefined, refusal => { completionDowngrade = refusal.reason; });
        }
      } finally { completionInFlight = false; }
      if (sent.delivery === "refused" && body.outcome === "declined" && body.reason === "handoff") {
        const explained = explainExpiredHandoff();
        if (explained) {
          body = explained;
          failureNotice = true;
          recorder?.annotateV2({ outcome: RELAY_FAILURE_NOTICE_OUTCOME, answer: explained.answer });
        }
      }
      if (!initiallyLate && body.outcome === "answered" && sent.delivery === "refused"
        && (ownerPastWindow() || sent.refusalCode === "lease_lost")
        && ownerExecution && allowOwnerReply?.()) {
        await changeRunAsync(requestId, row => ({ ...row,
          ownerTurn: { ...row.ownerTurn!, completionAttempt: undefined, lateAnswer: { ...row.ownerTurn?.lateAnswer, body, files: stagedAttachments } } }), ownerRelayStoreDeadline());
        sent = await deliverOwnerLateAnswer(relay, requestId, body, stagedAttachments, allowOwnerReply!);
      }
      if (!initiallyLate && allowOwnerReply && recorded && sent.delivery !== "unconfirmed") {
        await changeRunAsync(requestId, row => ({ ...row,
          ...(sent.delivery === "accepted" ? { completionAccepted: true as const } : {}),
          ownerTurn: { ...row.ownerTurn!, completionAttempt: undefined } }), ownerRelayStoreDeadline());
      }
      if (sent.tooLong) failureNotice = true;
      const completion = sent.body;
      if (sent.delivery === "accepted") {
        completionAccepted = true;
        if (ownerPastWindow()) {
          try { await changeRunAsync(requestId, row => ({ ...row, completionAccepted: true,
            ownerTurn: { ...row.ownerTurn!, lateAnswer: undefined } }), ownerRelayStoreDeadline()); }
          catch { await recordAcceptedCompletion(requestId); }
        }
        if (recorded && activeTarget && !activeCapacityFreed) { activeCapacityFreed = true; free(relay, activeTarget); }
        try { await releaseCapacity?.(); }
        catch { console.error("External relay completed capacity release pending"); retryCapacityRelease(); }
        // A retained row (an unconfirmed owner stop or a pending capacity
        // release) leaves recovery cleanup only, never a second completion.
        if (recorded && (cloud || !capacityReleased)) await recordAcceptedCompletion(requestId);
      }
      if (!ownerPastWindow() && caps?.rich && completionDowngrade) {
        recorder?.annotateV2({ drops: [...answerDrops, { part: "answer", reason: completionDowngrade }] });
      }
      if (initiallyLate && body.outcome === "answered" && sent.delivery !== "accepted") {
        await changeRunAsync(requestId, row => ({ ...row, ...(!ownerRunPending() && !ownerStopPending(row) ? { capacityReleased: true as const } : {}),
          ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...row.ownerTurn?.lateAnswer, body, files: stagedAttachments } } }), ownerRelayStoreDeadline());
      }
      if (allowOwnerReply && recorded && sent.delivery === "unconfirmed") {
        await changeRunAsync(requestId, row => ({ ...row,
          ...(!ownerRunPending() && !ownerStopPending(row) ? { capacityReleased: true as const } : {}) }), ownerRelayStoreDeadline());
      }
      claimTerminal = sent.delivery !== "refused";
      // An unknown acknowledgement still suppresses duplicate execution, but
      // cannot attest that the chat received the proposed answer.
      terminal.completion = claimTerminal && (sent.delivery === "accepted" || completion.outcome !== "answered") ? completion : null;
      try { await settleClaim(claimTerminal ? "terminal" : "release"); }
      catch (error) {
        if (!claimTerminal) throw error;
        console.error("External relay terminal claim settlement pending");
      }
      // A late owner answer under failure custody is replaced by the scrubbed
      // notice inside late delivery, so the delivered text is a notice too.
      if (initiallyLate && completion.outcome === "answered" && (failureReply || diagnostic)) failureNotice = true;
      journal.outcome = completion.outcome === "answered" && sent.delivery !== "accepted" ? `failed:delivery_${sent.delivery}` : outcomeLabel(completion);
      journal.delivery = sent.delivery;
      recorder?.recordDelivery({ outcome: journal.outcome, delivery: sent.delivery });
      if (failureNotice && completion.outcome === "answered") markRelayFailureNotice(completion);
      return completion;
    } finally {
      notifyInitialLease();
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (!claimSettled) {
        try { await settleClaim(claimTerminal ? "terminal" : "release", deadline.at); }
        catch { console.error("External relay request claim cleanup failed"); }
      }
      if (!claimSettled && claimTerminal) void (async () => {
        while (!claimSettled) {
          try { await settleClaim("terminal", ownerRelayStoreDeadline()); }
          catch (error) {
            if (!(error instanceof RelayStoreBusy)) {
              console.error("External relay terminal claim custody unavailable");
              return;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      })();
      if (!executionScope) inflight.delete(requestId);
      journalFinished();
      deliverySettled();
    }
    })();
    return finishing;
  };
  if (!request)
    return finish(
      declined(
        leaseId,
        raw && typeof raw === "object" &&
          typeof (raw as Record<string, unknown>).kind === "string" &&
          (raw as Record<string, unknown>).kind !== "answer"
          ? "unsupported_kind"
          : "invalid_request",
        null,
        refusalDetail,
      ),
    );
  if (deadline.fallback === "past") return finish(declined(leaseId, "busy"));
  const configuredTarget = relay.targets.find((item) => item.id === request.target_id);
  const cloud = configuredTarget?.engine === "codex-cloud";
  const target = configuredTarget ? { ...configuredTarget, engine: configuredTarget.engine === "codex-cloud" ? "codex" as const : configuredTarget.engine } : undefined;
  activeTarget = target ?? null;
  if (!target || !target.engine || !target.model)
    return finish(declined(leaseId, "not_configured"));
  if (relay.paused || !target.enabled)
    return finish(declined(leaseId, "disabled"));
  let conversation = null as RelayConversation | null;
  let conversationEvidence: { sessionId?: string | null; promptTokens?: number | null; compacted?: boolean } = {};
  let turn: ReturnType<typeof conversationTurnPrompt> | null = null;
  let conversationBroken = false;
  let runDir: string | null = null;
  let replacedRunDir: string | null = null;
  let ownerFileInstructions: string | undefined;
  let capacityReleased = false;
  let duplicate = false;
  let run: EphemeralAgentRun | null = null;
  let runFinished = false;
  let cloudUncertain = false;
  const callAbort = new AbortController();
  const identityTimers: ReturnType<typeof setTimeout>[] = [];
  let owner: ReturnType<typeof ownerTierFor> = null;
  // A refused cutoff write can leave cancel absent from the ledger. The
  // unsettled owner still owns its capacity, chain reservation and files.
  const ownerRunPending = () => cloudUncertain || !!owner && !!run && !runFinished;
  // A full owner turn (no prototype answer) answers at its execution cap with
  // the fixed status notice while its stop is still unconfirmed.
  let boundedOwnerTurn = false;
  const finishOwnerTimeout = async (startedAt: number): Promise<ExternalRelayCompletion | null> => {
    console.info("External relay owner execution cap reached", { request: requestId.slice(0, 8), elapsed_ms: Date.now() - deadline.receivedAt });
    callAbort.abort();
    failureNotice = true;
    ownerStatusReply = { lease_id: leaseId, outcome: "answered", duration_ms: Date.now() - startedAt,
      answer: { action: "reply", text: ownerRequestTimeoutText(caps!.plainMax), reply_to: owner!.messageId,
        ...(caps!.rich ? { format: "plain", buttons: [], attachments: [] } : {}) } };
    return await finish(ownerStatusReply);
  };
  executionScope = true;
  releaseCapacity = async () => {
    if (!recorded || capacityReleased || ownerRunPending()) return;
    const held = readRunLedger().runs.find(row => row.requestId === requestId);
    if (held && ownerStopPending(held)) return;
    if (!held?.capacityReleased) await changeRunAsync(requestId, row => {
      if (ownerRunPending() || ownerStopPending(row)) return row;
      return { ...row, capacityReleased: true };
    }, ownerRelayStoreDeadline());
    const current = readRunLedger().runs.find(row => row.requestId === requestId);
    if (current && !current.capacityReleased) return;
    capacityReleased = true;
    if (!activeCapacityFreed) { activeCapacityFreed = true; free(relay, target); }
    onFreed?.();
  };
  const retryCapacityRelease = () => {
    if (capacityReleaseRetry || !completionAccepted) return;
    capacityReleaseRetry = (async () => {
      let delay = 100;
      while (!capacityReleased) {
        let held: ReturnType<typeof readRunLedger>["runs"][number] | undefined;
        try { held = readRunLedger().runs.find(row => row.requestId === requestId); }
        catch {
          console.error("External relay completed capacity custody unreadable during retry");
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref(); });
          delay = Math.min(delay * 2, 5000);
          continue;
        }
        if (!held || ownerStopPending(held)) return;
        try { await releaseCapacity?.(); }
        catch { console.error("External relay completed capacity release retry pending"); }
        if (capacityReleased) return;
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref(); });
        delay = Math.min(delay * 2, 5000);
      }
    })().finally(() => { capacityReleaseRetry = null; });
  };
  try {
    let newestProgress: ExternalRelayProgress | null = null;
    const steps = request.delivery === "guest" ? null : createRelaySteps(relay.features);
    let progressSeq = 0;
    let stepLog: string | null = null;
    let pendingServiceTools = 0;
    let cloudFailed = false;
    const intervalMs = request.liveness.heartbeat_interval_s * 1000;
    let acked = false;
    let heartbeatBusy = false;
    const started = Date.now();
    const stallMs = request.liveness.stall_window_s * 1000;
    const cancelStalledRun = () => {
      if (ownerPastWindow()) return;
      if (!heartbeatBusy && !completionAccepted && !completionInFlight && !leaseUnavailable && Date.now() - heartbeatAt > stallMs) {
        leaseUnavailable = true;
        if (!ownerExecution) { run?.cancel(); callAbort.abort(); }
      }
    };
    // Lease HTTP traffic has its own process and event loop. Viewer stalls and
    // synchronous state work therefore cannot delay the heartbeat or answer POST.
    const initialProgress = steps?.beat(++progressSeq, Date.now(), true) ?? newestProgress;
    newestProgress = initialProgress;
    if (initialProgress?.kind === "step") noteRelayProgress(relay.id, target.id, initialProgress);
    let firstAcknowledged!: () => void;
    const firstAck = new Promise<void>(resolve => { firstAcknowledged = resolve; });
    const onHeartbeat = (frame: Parameters<ConstructorParameters<typeof RelayLeaseTransport>[5]>[0]) => {
      if (frame.phase === "attempt") heartbeatBusy = true;
      else if (frame.phase === "acknowledged" || frame.phase === "failed" || frame.phase === "post_completion") heartbeatBusy = false;
      console.info("External relay heartbeat", { path: "/requests/:request/heartbeat", seq: frame.seq,
        phase: frame.phase, status: frame.status, ...(frame.code ? { code: safeRelayHttpReason(frame.code) } : {}) });
      if (frame.phase === "acknowledged") { acked = true; heartbeatAt = Date.now(); firstAcknowledged(); }
      else if (frame.phase === "failed") {
        if (!ownerPastWindow() && (frame.status === 404 || frame.status === 409 && frame.code === "lease_lost") && !completionAccepted) {
          leaseUnavailable = true; if (!ownerExecution) { run?.cancel(); callAbort.abort(); }
        }
        firstAcknowledged();
      }
      if (frame.phase === "failed" && frame.code === "unknown_feature")
        void runtime?.onUnknownFeature?.().finally(firstAcknowledged);
    };
    transport = recovery ? null : runtime?.leaseWorker === false
      ? new InlineRelayLeaseTransport(relay, requestId, target.id, leaseId, intervalMs, onHeartbeat, initialProgress,
        () => { void runtime?.onUnknownFeature?.(); }, recorder?.recordCompletionRefusal, refusal => { completionDowngrade = refusal.reason; })
      : new RelayLeaseTransport(relay, requestId, target.id, leaseId, intervalMs, onHeartbeat, initialProgress,
        () => { void runtime?.onUnknownFeature?.(); }, undefined, recorder?.recordCompletionRefusal, refusal => { completionDowngrade = refusal.reason; });
    if (transport) {
      await transport.ready;
      const firstBeatDeadline = runtime?.leaseWorker === false ? null
        : setTimeout(firstAcknowledged, Math.max(1, Math.min(stallMs, deadline.at - Date.now())));
      firstBeatDeadline?.unref();
      await firstAck;
      if (firstBeatDeadline) clearTimeout(firstBeatDeadline);
      if (leaseUnavailable) {
        await transport.close(); transport = null;
        notifyInitialLease();
        return null;
      }
    } else {
      // Focused unit fixtures can keep lease I/O in process. The production
      // poller leaves leaseWorker unset and always uses the independent helper.
      acked = true;
      heartbeatAt = Date.now();
      firstAcknowledged();
    }
    notifyInitialLease();
    pendingBeat = Promise.resolve();
    heartbeatTimer = setInterval(() => {
      if (steps && !owner && (!cloud || cloudFailed) && !runFinished && stepLog) steps.observe(readRelayStepObservation(stepLog));
      cancelStalledRun();
      if (!leaseUnavailable && steps?.changeDue(Date.now())) {
        newestProgress = steps.beat(++progressSeq, Date.now(), true);
        if (newestProgress?.kind === "step") noteRelayProgress(relay.id, target.id, newestProgress);
        transport?.progress(newestProgress);
      }
    }, 1000);
    heartbeatTimer.unref();
    if (Date.now() >= deadline.at) return await finish(declined(leaseId, "busy"));
    // The member limit (§B.8): a member past it is declined, and the service's
    // fallback setting decides whether its own agent answers instead.
    const requester = request.input.requester;
    const limit = memberLimitFor(target);
    const memberDecline = (): ExternalRelayCompletion | null => {
      if (!requester || limit === null || exemptFromMemberLimit(requester)) return null;
      const now = Date.now();
      const used = countMemberAnswers({ relayId: relay.id, targetId: target.id, chatKey: request.chat?.key ?? null,
        requesterKey: requester.key, sinceMs: now - RELAY_MEMBER_LIMIT_WINDOW_MS });
      return used.count >= limit ? declined(leaseId, "member_limit", used.oldestMs === null ? null :
        Math.max(1, Math.ceil((used.oldestMs + RELAY_MEMBER_LIMIT_WINDOW_MS - now) / 1000)), memberLimitDetail(limit)) : null;
    };
    const earlyMemberDecline = memberDecline();
    if (earlyMemberDecline) return await finish(earlyMemberDecline);
    const profile = answerProfileFor(requester);
    // The paired service verifies owner identity independently of guest delivery.
    // Only that verified, non-anonymous author can enter the owner tier.
    const ownerMessage = ownerTierFor({ ownerTier: true }, request);
    const previousAnswer = ownerMessage ? readAnswerRecord(relay.id, target.id, requestId) : null;
    const replayReviewId = previousAnswer?.profile?.owner && previousAnswer.requester?.key === requester?.key
      && previousAnswer.chatKey === (request.chat?.key ?? null) ? previousAnswer.profile.prototype : undefined;
    const trigger = request.input.conversation.find(message => message.id === ownerMessage?.messageId);
    const parent = request.input.conversation.find(message => message.id === trigger?.reply_to && message.author.self);
    const prototype = ownerMessage ? matchPrototypeAnswer(ownerMessage.text, undefined, replayReviewId, undefined, parent?.text) : null;
    const guestOwner = request.delivery === "guest" ? ownerTierFor(target, request, { guestHandoff: true }) : null;
    let handoffOnly = recovery?.ownerTurn?.seatHandoff === true;
    if (recovery && request.delivery === "guest" && (!guestOwner || !handoffOnly)) return null;
    owner = request.delivery === "guest"
      ? handoffOnly ? guestOwner : null
      : prototype || target.ownerTier === true ? ownerMessage : null;
    const intentOwner = !recovery && !prototype ? guestOwner ?? (cloud ? owner : null) : null;
    const bindOwnerReply = () => {
      if (owner || request.delivery === "guest") delete profile.pageRead;
      boundedOwnerTurn = !!owner && !prototype;
      ownerExecution = boundedOwnerTurn;
      if (owner) allowOwnerReply = () => ownerStatusReply
        ? ownerRelayStatusReplyAuthorized(relay.id, target.id, requestId, ownerStatusReply, caps!.plainMax)
        : (failureReply ? ownerRelayFailureReplyAuthorized : ownerRelayAuthorized)(relay.id, target.id, requestId);
    };
    if (!intentOwner) bindOwnerReply();
    if (owner && recovery?.ownerTurn?.context) owner = recovery.ownerTurn.context;
    if (owner && !prototype && !recovery && request.delivery !== "guest") {
      try { owner.localContext = await withViewerOperation("telegram.outbound-state", () =>
        waitForStateLock("relay.owner-context", () => resolveOwnerOutboundContext(request, owner!, relay), { waitMs: 5000 })); }
      catch { owner.localContext = null; }
      try { owner.bridgeReport = resolveOwnerBridgeContext(request, owner, relay.api_base); }
      catch { owner.bridgeReport = null; }
    }
    // A verified owner may arrive through guest delivery. Keep that turn
    // request-local: the handoff sees the triggering owner message and its
    // media, never the guest's surrounding history or retained memory.
    if (owner && request.delivery === "guest") retainOwnerReplyChain(request, owner.messageId);
    // The local runner binds Viewer calls for owner chat turns and handoffs.
    // Legacy claims without chat scope can still use a bound Cloud repository.
    let repositoryBoundOwner = cloud && !!owner && !handoffOnly;
    let usingCloud = cloud && (!owner || repositoryBoundOwner && !!cloudEnvironment(configuredTarget!, true));
    if (!intentOwner && repositoryBoundOwner && !usingCloud && !prototype) cloudOwnerDirectory(target.project);
    const authority = conversationAuthority(request.input.requester, !!owner);
    const canUseConversation = () => request.delivery !== "guest" && !recovery && !usingCloud && !prototype && readRelaySwitches().chain_conversations && request.chat && authority;
    let usesConversation = !intentOwner && canUseConversation();
    let intentPending = !!intentOwner;
    let preResolvedConversation: RelayConversation | null = null;
    let preResolutionPending = false;
    if (usesConversation) {
      try { preResolvedConversation = await resolveChainConversationAsync(relay, target, request, authority!, admissionCutoff()); preResolutionPending = true; }
      catch (error) {
        if (!(error instanceof RelayStoreBusy)) throw error;
        preResolvedConversation = await lookupChainConversationAsync(relay, target, request, authority!);
      }
    }
    const selectAccount = () => intentPending || prototype || usingCloud || owner && (conversation ?? preResolvedConversation)?.conversationId ? null : accountManager.resolveHeadlessSpawn(target.engine!,
      conversation?.accountId ?? preResolvedConversation?.accountId ?? null,
      [], target.project, target.model);
    let selection = selectAccount();
    const selectedAccount = () => {
      if (!selection || selection.kind !== "available") throw new Error("relay account unavailable");
      return selection.account;
    };
    const capacityDecline = () => selection && selection.kind !== "available" ? declined(leaseId, "no_capacity",
      selection.kind === "exhausted" && selection.resetsAt ? Math.max(0, selection.resetsAt - Math.floor(Date.now() / 1000)) : null) : null;
    const earlyCapacityDecline = capacityDecline();
    if (earlyCapacityDecline) return await finish(earlyCapacityDecline);
    const createAnswerDirectory = () => fs.promises.mkdtemp(path.join(externalRelayTempRoot(), "llv-external-relay-"));
    runDir = recovery
      ? owner && !prototype ? await resolveOwnerRunDirectory(recovery.runDir) : recovery.runDir
      : intentOwner || owner && !prototype ? await createOwnerRunDirectory()
        : await createAnswerDirectory();
    const ownerIdentity = procBackend.processIdentity(process.pid);
    if (!ownerIdentity) throw new Error("viewer process identity unavailable");
    const ownerTurn = (instruction: OwnerInstruction): NonNullable<RunRecord["ownerTurn"]> => ({
      clientAttemptId: `relay-owner-${requestId}${recovery ? "-retry" : ""}`,
      ...(recovery ? { restartRetries: 1 as const } : {}),
      ...(handoffOnly ? { seatHandoff: true as const } : {}),
      rawRequest: raw, context: instruction, delivery: request.owner_delivery,
      request: { text: instruction.text, requestText: instruction.requestText },
      ...(instruction.bridgeReport ? { bridgeReport: instruction.bridgeReport } : {}),
      ...(prototype && target.ownerTier !== true ? { prototype: true as const } : {}),
    });
    const record: RunRecord = {
      requestId,
      leaseId,
      relayId: relay.id,
      targetId: target.id,
      childPid: null,
      childIdentity: null,
      ownerPid: process.pid,
      ownerIdentity,
      runDir,
      startedAt: new Date().toISOString(),
      ...(owner && !intentOwner ? { ownerTurn: ownerTurn(owner) } : {}),
    };
    let admissionDecline: ExternalRelayCompletion | null = null;
    let wakeHold: (() => void) | null = null;
    const releaseAdmission = async () => {
      if (conversation) { await releaseConversationAsync(conversation.id, {}, ownerRelayStoreDeadline(), requestId); conversation = null; }
      if (recorded) { await dropRunAsync(requestId, ownerRelayStoreDeadline()); free(relay, target); recorded = false; }
    };
    const admit = async (): Promise<boolean> => {
      let lastCause: RelayHoldCause | null = null;
      while (!leaseUnavailable) {
        if (Date.now() >= admissionCutoff()) {
          admissionDecline = declined(leaseId, "busy", null, lastCause === "chat" ? "chat busy" : null);
          return false;
        }
        let resolved: RelayConversation | null = null;
        let cause: RelayHoldCause | null = activeDrain() ? "drain" : null;
        if (usesConversation) {
          try {
            if (preResolutionPending) {
              resolved = preResolvedConversation;
              preResolvedConversation = null;
              preResolutionPending = false;
            } else resolved = await resolveChainConversationAsync(relay, target, request, authority!, Math.min(admissionCutoff(), deadline.declineAt));
          }
          catch (error) {
            if (!(error instanceof RelayStoreBusy)) throw error;
            cause ??= "capacity"; admissionHeld = true;
          }
        }
        cause ??= resolved?.state === "running" ? "chat" :
          olderCapacityWaiter(relay.id, target.id, requestId, deadline) ? "capacity" : null;
        if (releaseRequested || releasingRelayHolds()) { admissionDecline = declined(leaseId, "busy", null, cause === "chat" ? "chat busy" : null); releaseRequested = true; return false; }
        if (!cause) {
          try {
            const admission = await reserveRunAsync(record, target.concurrency, admissionCutoff(), !!recovery);
            if (admission === "duplicate") { duplicate = true; return false; }
            if (admission === "full") cause = "capacity";
            else {
              recorded = true; markActive(relay, target);
              if (usesConversation) {
                await sweepConversationsAsync([relay], Date.now(), admissionCutoff(), relay.id);
                const reserved = await reserveChainConversationAsync(relay, target, request, authority!, admissionCutoff());
                if (!reserved) { await releaseAdmission(); cause = "chat"; }
                else conversation = reserved;
              }
              if (Date.now() >= admissionCutoff()) {
                await releaseAdmission();
                admissionDecline = declined(leaseId, "busy", null, lastCause === "chat" ? "chat busy" : null);
                return false;
              }
            }
          } catch (error) {
            if (!(error instanceof RelayStoreBusy)) throw error;
            await releaseAdmission(); cause = "capacity"; admissionHeld = true;
          }
        }
        if (leaseUnavailable) return false;
        if (releaseRequested || releasingRelayHolds()) {
          releaseRequested = true;
          admissionDecline = declined(leaseId, "busy", null, cause === "chat" ? "chat busy" : null);
          return false;
        }
        if (!cause) {
          leaveRelayHold(requestId); steps?.observe({});
          admissionDecline = memberDecline();
          if (admissionDecline) return false;
          selection = selectAccount(); admissionDecline = capacityDecline();
          if (admissionDecline) return false;
          if (conversation && !owner && selection?.kind === "available") { prepareConversationAccount(conversation, selection.account); conversation.accountId = selection.account.accountId; }
          return true;
        }
        lastCause = cause;
        admissionHeld = true;
        enterRelayHold({ requestId, relayId: relay.id, targetId: target.id, cause, deadline,
          release: () => { releaseRequested = true; wakeHold?.(); return released; } });
        steps?.observe({ queued: true });
        if (Date.now() >= admissionCutoff()) { admissionDecline = declined(leaseId, "busy", null, cause === "chat" ? "chat busy" : null); return false; }
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wakeHold = null; resolve(); }, Math.min(1000, admissionCutoff() - Date.now()));
          timer.unref();
          wakeHold = () => { clearTimeout(timer); wakeHold = null; resolve(); };
        });
      }
      return false;
    };
    if (!await admit()) return admissionDecline ? await finish(admissionDecline) : null;
    if (Date.now() >= deadline.at || (admissionHeld && Date.now() >= deadline.declineAt)) {
      await releaseAdmission();
      return await finish(declined(leaseId, "busy"));
    }
    const lose = () => { if (ownerPastWindow()) return; leaseUnavailable = true; if (!ownerExecution) { run?.cancel(); callAbort.abort(); } };
    const lease = {
      deadlineAt: serviceDeadline.at,
      verificationBudget: (callId: string, until: number, consume: boolean | "send") => reserveRelayActionVerificationAsync(requestId, leaseId, callId, until, consume),
      signal: callAbort.signal, lose,
      ack: async () => {
        while (!acked && !leaseUnavailable) {
          if (pendingBeat) await pendingBeat;
          if (acked || leaseUnavailable) break;
          await toolSleep(1000, callAbort.signal);
        }
        return acked && !leaseUnavailable;
      },
    };
    if (intentOwner) {
      if (!await lease.ack()) return null;
      if (activeDrain()) {
        await releaseAdmission();
        if (!await admit()) return admissionDecline ? await finish(admissionDecline) : null;
      }
      const canRouteOwner = () => ownerRelayIntentEnabled(relay.id, target.id);
      const checkIntentLaunch = () => {
        callAbort.signal.throwIfAborted();
        if (leaseUnavailable || releaseRequested || activeDrain() || Date.now() >= admissionCutoff() || !canRouteOwner())
          throw new Error("relay owner intent admission expired");
      };
      try {
        const routingAccount = accountManager.resolveHeadlessSpawn(target.engine, null, [], target.project, target.model);
        if (routingAccount.kind === "available") {
          const probe = await runEphemeralAgent({ key: `relay-intent:${requestId}`, privateContext: true,
            engine: target.engine, model: target.model, effort: null, account: routingAccount.account,
            ["prompt"]: ownerHandoffIntentPrompt(request, intentOwner), schema: ownerHandoffIntentSchema,
            runDir: path.join(runDir, "intent"), hardCapMs: 60_000, authorizeLaunch: checkIntentLaunch,
            runtime: { command: runtime?.ownerIntentCommand, timeoutMs: Math.min(OWNER_INTENT_TIMEOUT_MS, runtime?.timeoutMs ?? Infinity, remainingMs(deadline)) },
          });
          run = probe;
          const cancelProbe = () => probe.cancel();
          callAbort.signal.addEventListener("abort", cancelProbe, { once: true });
          if (callAbort.signal.aborted) cancelProbe();
          try {
            await changeRunAsync(requestId, current => ({ ...current, childPid: probe.pid, childIdentity: probe.identity }), ownerRelayStoreDeadline());
            const verdict = await probe.done;
            const answer = verdict.answer as { seat_handoff?: unknown } | null;
            handoffOnly = verdict.status === "done" && answer?.seat_handoff === true && Object.keys(answer).length === 1;
          } finally {
            callAbort.signal.removeEventListener("abort", cancelProbe);
          }
          await changeRunAsync(requestId, current => ({ ...current, childPid: null, childIdentity: null }), ownerRelayStoreDeadline());
          run = null;
        }
      } catch (error) {
        if (run) throw error; // The normal stop path still owns the probe.
        console.info("External relay owner intent unavailable; using ordinary routing");
      }
      if (leaseUnavailable || callAbort.signal.aborted) return null;
      if (releaseRequested || Date.now() >= admissionCutoff()) return await finish(declined(leaseId, "busy"));
      handoffOnly = handoffOnly && canRouteOwner();
      if (guestOwner && handoffOnly) {
        record.ownerTurn = ownerTurn(guestOwner);
        await changeRunAsync(requestId, current => ({ ...current, ownerTurn: record.ownerTurn }), ownerRelayStoreDeadline());
        if (leaseUnavailable || callAbort.signal.aborted) return null;
        if (releaseRequested || Date.now() >= admissionCutoff()) return await finish(declined(leaseId, "busy"));
        if (!ownerRelayAuthorized(relay.id, target.id, requestId)) return await finish(declined(leaseId, "disabled"));
        owner = guestOwner;
        retainOwnerReplyChain(request, owner.messageId);
      } else if (guestOwner) {
        // The probe needs the native host mount. Ordinary answers keep their
        // separate temporary directory and receive the complete guest context.
        replacedRunDir = await createAnswerDirectory();
        record.runDir = replacedRunDir;
        await changeRunAsync(requestId, current => ({ ...current, runDir: record.runDir }), ownerRelayStoreDeadline());
        replacedRunDir = runDir;
        runDir = record.runDir;
      } else if (owner) {
        record.ownerTurn = ownerTurn(owner);
        await changeRunAsync(requestId, current => ({ ...current, ownerTurn: record.ownerTurn }), ownerRelayStoreDeadline());
      }
      bindOwnerReply();
      repositoryBoundOwner = cloud && !!owner && !handoffOnly;
      usingCloud = cloud && (!owner || repositoryBoundOwner && !!cloudEnvironment(configuredTarget!, true));
      if (repositoryBoundOwner && !usingCloud) cloudOwnerDirectory(target.project);
      usesConversation = canUseConversation();
      intentPending = false;
      if (usesConversation) {
        await releaseAdmission();
        if (!await admit()) return admissionDecline ? await finish(admissionDecline) : null;
      } else {
        selection = selectAccount();
        const unavailable = capacityDecline();
        if (unavailable) return await finish(unavailable);
      }
    }
    // Codex Cloud receives text-only turns through this transport. Guest
    // history photos belong to the hosted assistant in that case; handing the
    // request back keeps the client from claiming an answer without seeing them.
    if (usingCloud && hasInboundMedia(request)) {
      const ready = validateMediaInput(request).filter(media => media.availability === "ready");
      if (request.delivery === "guest" && ready.length) return await finish(declined(leaseId, "handoff", null, GUEST_CLOUD_MEDIA_HANDOFF_DETAIL));
      if (request.features?.includes(RELAY_HISTORY_MEDIA) && ready.some(media => isInboundImage(media.mime_type)))
        return await finish(declined(leaseId, "handoff", null, "This install cannot inspect history photos; the service's own assistant will answer."));
    }
    const hydrated = recovery ? { request, guidance: [] } : await hydrateToolIndex(relay, request, lease, runtime, deadline.at);
    request.input = hydrated.request.input;
    callAbort.signal.throwIfAborted();
    let result: EphemeralAgentResult | null = null;
    let completion: ExternalRelayDecision | null = null;
    const executionExpired = cloud && owner && !prototype ? new Promise<"expired">(resolve => {
      const budget = Math.min(target.hardCapMinutes * 60_000, runtime?.timeoutMs ?? Infinity);
      executionDeadline = Date.now() + budget;
      executionTimer = setTimeout(() => { run?.cancel(); resolve("expired"); }, budget);
      executionTimer.unref();
    }) : null;
    for (rounds = 1; rounds <= (loop ? RELAY_TOOL_ROUNDS : 1); rounds++) {
      if (executionExpired && Date.now() >= executionDeadline) return await finishOwnerTimeout(started);
      if (!ownerExecution && Date.now() >= deadline.at) return await finish(declined(leaseId, "busy"));
      let providerOpened = false;
      runFinished = false;
      let previousImages = new Set<string>();
      if (caps?.generate && conversation?.sessionId) {
        try { previousImages = new Set(await withViewerOperation("relay.attachments", () => fs.promises.readdir(path.join(conversationCodexHome(conversation!), "generated_images", conversation!.sessionId!)))); } catch { /* New image directory. */ }
      }
      if (rounds === 1 && activeDrain()) {
        await releaseAdmission();
        if (!await admit()) return admissionDecline ? await finish(admissionDecline) : null;
      }
      if (rounds === 1 && hasInboundMedia(request)) {
        if (!await lease.ack()) return null;
        await inbound?.dispose();
        inbound = await prepareInboundMedia(relay, request, runDir, { signal: callAbort.signal, deadlineAt: Math.min(deadline.at, serviceDeadline.at), skipRejected: true,
          ...(conversation && request.delivery !== "guest" ? { seenMessageIds: new Set(conversation.seen) } : {}),
          authorize: () => { if (leaseUnavailable || releaseRequested || owner && !ownerRelayAuthorized(relay.id, target.id, requestId)) throw new ExternalRelayError("lease_lost", 409); } });
        callAbort.signal.throwIfAborted();
        if (toolMedia) toolMedia.replaceInbound(inbound);
        // Rejected originals must not remain seed candidates or contribute a
        // stale extraction to the text answer.
        const refused = new Map(inbound.skipped.map(item => [item.ref, item.reason]));
        for (const message of request.input.conversation) for (const media of message.media ?? []) {
          const reason = refused.get(media.ref);
          if (reason) media.availability = reason === "too_large" ? "too_large" : "unsupported_type";
        }
        request.input.documents = request.input.documents.filter(document => !document.media_ref || !refused.has(document.media_ref));
        const trigger = request.input.conversation.find(message => message.id === request.input.respond_to);
        const triggerText = (trigger?.text ?? "").trim().replace(/^\[(?:Media attached; description unavailable|Document attached; filename=[^\r\n]+; mime_type=[^\r\n]+; byte_size=\d+)\]\s*$/gm, "").trim();
        if (inbound.skipped.length && !inbound.files.length && !request.input.request_text?.trim() && !triggerText) {
          const labels: Record<string, string> = { unsupported_media_type: "unsupported media type", too_large: "media too large",
            protected: "protected media", missing: "media unavailable", media_unavailable: "media unavailable" };
          const reasons = [...new Set(inbound.skipped.map(item => labels[item.reason] ?? "media unavailable"))];
          const text = `Media could not be read: ${reasons.join(", ")}. Send a JPEG/PNG image or a text request.`;
          const brief = reasons[0]!.replace("unsupported media type", "unsupported media");
          const notice = text.length <= request.answer.max_chars ? text : `${brief[0]!.toUpperCase()}${brief.slice(1)}.`;
          return await finish({ lease_id: leaseId, outcome: "answered", duration_ms: Date.now() - started,
            answer: { action: "reply", text: notice.slice(0, request.answer.max_chars), reply_to: request.input.respond_to, format: "plain" } });
        }
      }
      if (rounds === 1 && !toolMedia) {
        toolMedia = createToolResultMedia(relay, request, runDir, { signal: callAbort.signal, deadlineAt: Math.min(deadline.at, serviceDeadline.at),
          authorize: () => { if (leaseUnavailable || releaseRequested) throw new ExternalRelayError("lease_lost", 409); } }, inbound ?? undefined);
        if (owner && !prototype && callableTools(request).length) ownerTools = openOwnerServiceTools(relay, target, request, hydrated.guidance, lease, runtime ?? {},
          async () => {
            const registry = repositoryBoundOwner && localOwnerConversationId
              ? await (await import("@/lib/agent/registry")).prepareAgentRegistry() : null;
            if (!await ownerRelayAuthorizedAsync(relay.id, target.id, requestId)) return false;
            if (registry && localOwnerConversationId) {
              // Binding can precede continuation admission. A foreign conversation
              // must not borrow this request's tools while that admission awaits.
              const generation = registry.conversation(localOwnerConversationId as `conversation_${string}`)?.generations.at(-1);
              if (!generation?.launchProfile?.cwd) return false;
              try { cloudOwnerDirectory(target.project, generation.launchProfile.cwd); } catch { return false; }
            }
            return true;
          }, toolMedia);
        if (ownerTools && usingCloud) loop = ownerTools.loop;
        else if (!owner && request.delivery !== "guest" && (callableTools(request).length || profile.pageRead)) loop = createToolLoop(relay, request, lease, { ...runtime, pageRead: profile.pageRead, seedMediaRefs: toolMedia?.seedRefs, seedRefusal: toolMedia?.seedRefusal }, (tool, done, failed) => {
          if (!steps && request.answer.progress === "notes") {
            newestProgress = { kind: done ? "tool_done" : "tool_start", label: tool, tool,
              status: done ? (failed ? "failed" : "completed") : "running", at: new Date().toISOString() };
            noteRelayProgress(relay.id, target.id, newestProgress);
            transport?.progress(newestProgress);
          }
        }, steps ? pending => {
          pendingServiceTools += pending ? 1 : -1;
          // Service tools never read the Delegatus board; their names stay local.
          steps.observe({ currentTool: pendingServiceTools > 0 ? "relay_tool" : null });
        } : undefined);
        if (owner && !prototype && caps?.rich) {
          if (caps.media) ownerFileInstructions = await ownerAnswerFileInstructions(runDir);
          ownerParts = openOwnerAnswer(relay.id, request, runDir, ownerCredentials, () => (!leaseUnavailable || ownerExecution) && !callAbort.signal.aborted && ownerRelayAuthorized(relay.id, target.id, requestId),callAbort.signal,toolMedia ?? undefined);
        }
      }
      const final = rounds === RELAY_TOOL_ROUNDS || !!loop && loop.callsLeft() === 0;
      try {
        const roundPrompt = loop ? toolRoundPrompt(request, rounds, { results: loop.results, callsLeft: loop.callsLeft(), final, actionSent: loop.actionSent, pageRead: !owner && profile.pageRead }, target.engine) : answerPrompt(request, target.engine);
        const frame = roundPrompt.slice(roundPrompt.lastIndexOf("[Answer with one JSON object"));
        const ownerTarget = target;
        if (owner && !cloud) executionDeadline = Date.now() + target.hardCapMinutes * 60_000;
        const inboundRefs = new Set(inbound?.files.map(file => file.ref));
        const mediaMessageIds = request.input.conversation.filter(message => message.media?.some(media => inboundRefs.has(media.ref))).map(message => message.id);
        // The Cloud JSON tool loop cannot look up a catalogue through local MCP.
        const ownerAdditions = { mediaMessageIds, handoffOnly, requireToolTable: usingCloud, mandatory: [inbound?.prompt, usingCloud ? undefined : ownerFileInstructions,
          ...(usingCloud ? [rounds > 1 ? `<tool_results>\n${json(loop?.results ?? [])}\n</tool_results>` : "", frame] : []),
        ].filter(Boolean).join("\n") };
        // Prepare only the mode that will be sent. Cloud has no native cursor.
        let preparedOwner = owner && !prototype ? (conversation?.conversationId && !usingCloud
          ? ownerContinuationPrompt(request, owner, ownerTarget.hardCapMinutes, conversation, ownerAdditions)
          : prepareOwnerPrompt(request, owner, ownerTarget.hardCapMinutes, ownerAdditions)) : null;
        if (usingCloud && !cloudFailed && preparedOwner?.context !== undefined) {
          // A remote environment cannot read request-local context files.
          // No Cloud turn has started for this prompt; use the native fallback.
          cloudOwnerDirectory(target.project);
          selection = accountManager.resolveHeadlessSpawn(target.engine!, null, [], target.project, target.model);
          const unavailable = capacityDecline();
          if (unavailable) return await finish(unavailable);
          cloudFailed = true;
        }
        if (conversation && rounds === 1) turn = preparedOwner ?? conversationTurnPrompt(request, conversation, frame);
        const persistentPrompt = preparedOwner?.prompt ?? (conversation ? rounds === 1 ? turn!.prompt
          : conversationRoundPrompt(loop!.results.filter((r) => r.round === rounds - 1), frame) : roundPrompt);
        if (conversation) {
          const promptBytes = Buffer.byteLength(persistentPrompt);
          chain = rounds === 1 ? { continued: owner ? !!conversation.conversationId : !!conversation.sessionId, promptBytes }
            : { continued: chain!.continued, promptBytes: chain!.promptBytes + promptBytes };
        }
        if (conversation && owner && rounds === 1 && conversation.conversationId && turn) {
          await releaseConversationAsync(conversation.id, { state: "running", runningRequestId: requestId,
            pendingCursor: { operationId: `relay-owner-${requestId}`, seen: turn.seen, staticDigest: turn.digest } }, ownerRelayStoreDeadline(), requestId);
        }
        const turnInbound = !conversation || rounds === 1 ? inbound : null;
        const agentPrompt = persistentPrompt + (!owner && turnInbound?.prompt ? "\n" + turnInbound.prompt : "");
        const roundDirectory = loop ? path.join(runDir, `round-${rounds}`) : runDir;
        const inputFiles = [...(turnInbound?.files ?? []), ...(toolMedia?.files ?? [])];
        let inputFile: string | undefined;
        if (!owner && target.engine === "claude" && inputFiles.length) {
          await fs.promises.mkdir(roundDirectory, { recursive: true, mode: 0o700 });
          callAbort.signal.throwIfAborted();
          inputFile = await writeInboundAgentInput(inputFiles, agentPrompt, roundDirectory, callAbort.signal,
            () => { if (leaseUnavailable || releaseRequested) throw new ExternalRelayError("lease_lost", 409); });
          callAbort.signal.throwIfAborted();
        }
        steps?.observe({});
        stepLog = path.join(loop ? path.join(runDir, `round-${rounds}`) : runDir, "stdout.log");
        const schema = withAnswerParts(request.delivery === "guest" ? guestAnswerSchema : loop ? (final ? (loop.sawUnknown ? replyAnswerSchema : loop.actionSent || !offersHandoff(request) ? answerSchema : handoffAnswerSchema) : roundSchema(loop.tools, { handoff: !loop.actionSent && offersHandoff(request) }))
            : ownerTools ? (ownerTools.sawUnknown ? replyAnswerSchema : ownerTools.actionSent ? answerSchema : offersHandoff(request) ? handoffAnswerSchema : answerSchema)
              : offersHandoff(request) ? handoffAnswerSchema : answerSchema, caps!);
        const localEngine = target.engine, localModel = target.model, localRunDir = runDir;
        const localRun = () => {
          // A confirmed Cloud refusal may fall back to a native conversation;
          // recompute from unchanged inputs for that actual delivery mode.
          if (owner && cloudFailed) {
            const fallbackAdditions = { mediaMessageIds, handoffOnly, mandatory: [inbound?.prompt, ownerFileInstructions,
              rounds > 1 ? `<tool_results>\n${json(loop?.results ?? [])}\n</tool_results>` : ""].filter(Boolean).join("\n") };
            preparedOwner = conversation?.conversationId
              ? ownerContinuationPrompt(request, owner, ownerTarget.hardCapMinutes, conversation, fallbackAdditions)
              : prepareOwnerPrompt(request, owner, ownerTarget.hardCapMinutes, fallbackAdditions);
            turn = preparedOwner;
          }
          const continuing = !!conversation?.conversationId;
          return prototype ? runPrototypeAnswer(prototype, owner!.messageId, () => {
            if (leaseUnavailable || callAbort.signal.aborted || !ownerRelayAuthorized(relay.id, target.id, requestId)) throw new Error("owner relay authorization revoked");
          }, { telegramUserId: relay.owner.namespace === "telegram" ? relay.owner.id : undefined }) : owner ? runOwnerAgent({
            ...(conversation?.conversationId ? { continuation: { conversationId: conversation.conversationId, prompt: preparedOwner!.prompt } } : {}),
            authorize: () => { if (cloud && Date.now() >= executionDeadline || leaseUnavailable && !ownerExecution || callAbort.signal.aborted || !ownerRelayAuthorized(relay.id, target.id, requestId)) throw new Error("owner relay authorization revoked or execution deadline expired"); },
            credentials: ownerCredentials,
            conciseAfterHandoff: () => !!owner && (request.delivery === "guest"
              || ownerRelayHandoffOutcome(relay.id, target.id, requestId) !== null),
            onDiagnostic: recordDiagnostic,
            rawDeadlineAt: rawRequest.deadline_at,
            preparedPrompt: preparedOwner!,
            contextDirectory: localRunDir,
            handoffOnly,
            onPromptBytes: bytes => { if (chain) chain = { ...chain, promptBytes: chain.promptBytes + bytes - Buffer.byteLength(persistentPrompt) }; },
            request, owner, target: repositoryBoundOwner ? { ...ownerTarget, engine: "codex-cloud" } : ownerTarget,
            deadline, admissionDeadlineAt: executionDeadline, accountId: conversation?.conversationId ? null : selectedAccount().accountId,
            hardCapMs: Math.min(cloud ? Math.max(0, executionDeadline - Date.now()) : target.hardCapMinutes * 60_000, runtime?.timeoutMs ?? Infinity), ports: runtime?.ownerPorts,
            onConversation: async (conversationId, initialPrompt) => {
              localOwnerConversationId = conversationId;
              await changeRunAsync(requestId, current => ({ ...current, conversationId }), ownerRelayStoreDeadline());
              if (conversation) {
                conversation.conversationId = conversationId;
                const cursor = initialPrompt ? preparedOwner : null;
                if (cursor) turn = cursor;
                const patch = { conversationId, state: "running" as const, runningRequestId: requestId,
                  ...(initialPrompt && cursor ? { pendingCursor: { operationId: initialPrompt.operationId, seen: cursor.seen, staticDigest: cursor.digest } } : {}) };
                await releaseConversationAsync(conversation.id, patch, ownerRelayStoreDeadline(), requestId);
                if (cursor) Object.assign(conversation, patch);
              }
              ownerTools?.bindConversation(conversationId, continuing ? () => liveOwnerRelayRequest(conversationId)?.requestId === requestId : undefined);
              recorder?.bindConversation(conversationId);
            },
            ...(steps ? { onProgress: steps.observe } : {}),
          }) : runEphemeralAgent({
            ...(conversation ? { session: { mode: conversation.sessionId ? "resume" as const : "start" as const, id: conversation.sessionId ?? (localEngine === "claude" ? crypto.randomUUID() : null), cwd: conversation.cwd!, codexHome: conversationCodexHome(conversation) } } : {}),
            privateContext: request.delivery === "guest",
            key: loop ? `external-relay:${requestId}:${rounds}` : `external-relay:${requestId}`,
            engine: localEngine,
            model: localModel,
            effort: target.effort,
            account: selectedAccount(),
            ["prompt"]: agentPrompt,
            ...(inputFile ? { inputFile } : {}),
            ...(inputFiles.length ? { inputImages: inputFiles.filter(file => isInboundImage(file.mime_type)).map(file => file.path) } : {}),
            schema,
            runDir: loop ? path.join(localRunDir, `round-${rounds}`) : localRunDir,
            hardCapMs: target.hardCapMinutes * 60_000,
            webSearch: profile.webSearch,
            ...(caps?.generate ? { imageGeneration: { readableRoot: conversation?.cwd ?? path.join(loop ? path.join(localRunDir, `round-${rounds}`) : localRunDir, "cwd"), ...(inbound?.files.length ? { readableMediaRoot: path.dirname(inbound.files[0]!.path) } : {}) } } : {}),
            runtime,
            onEvent: (event) => {
              if (event.type === "provider_open" && !event.open.search) providerOpened = true;
              if (event.type === "note" && providerOpened && !owner) return;
              if (steps) return;
              const progress = progressForEvent(event);
              if (progress && request.answer.progress === "notes") {
                newestProgress = progress;
                noteRelayProgress(relay.id, target.id, progress);
                transport?.progress(progress);
              }
            },
          });
        };
        const pendingRun = usingCloud && !cloudFailed && !prototype ? runCloudRelay({
          ["prompt"]: agentPrompt,
          environmentId: cloudEnvironment(configuredTarget!, !!owner) ?? "",
          model: target.model,
          privateContext: request.delivery === "guest",
          schema, effort: target.effort, fullAccess: !!owner, timeoutMs: Math.min(owner ? Math.max(0, executionDeadline - Date.now()) : remainingMs(deadline), target.hardCapMinutes * 60_000, runtime?.timeoutMs ?? Infinity),
          transport: async input => {
            // A restart after this write cannot prove the remote turn stopped.
            cloudUncertain = true;
            await changeRunAsync(requestId, current => ({ ...current, cloudExecution: "uncertain" }), ownerRelayStoreDeadline());
            try {
              const text = await (runtime?.cloudTransport ?? cloudTransport)(input);
              await changeRunAsync(requestId, current => ({ ...current, cloudExecution: "completed" }), ownerRelayStoreDeadline());
              cloudUncertain = false;
              return text;
            } catch (error) {
              if (error instanceof CloudFailure && error.confirmed) {
                await changeRunAsync(requestId, current => ({ ...current, cloudExecution: undefined }), ownerRelayStoreDeadline());
                cloudUncertain = false;
              }
              throw error;
            }
          },
          authorize: () => { if ((leaseUnavailable && !owner) || callAbort.signal.aborted || (owner && (Date.now() >= executionDeadline || !ownerRelayAuthorized(relay.id, target.id, requestId)))) throw new Error("relay authorization revoked or execution deadline expired"); },
          onProgress: steps?.observe,
          ...(owner ? { decode: (text: string) => {
            let value: unknown;
            try { value = JSON.parse(text); } catch { return ownerAnswer(text, request, owner!, ownerCredentials); }
            return scrubOwnerReply(value, ownerCredentials);
          } } : {}),
          onFallback: () => { cloudFailed = true; console.info("External relay Cloud failure confirmed; trying local execution once"); },
          local: async () => {
            if (owner) {
              if (Date.now() >= executionDeadline) throw new Error("Owner execution deadline expired before local fallback");
              cloudOwnerDirectory(target.project);
            }
            selection = accountManager.resolveHeadlessSpawn(target.engine!, null, [], target.project, target.model);
            const local = await localRun();
            await changeRunAsync(requestId, current => ({ ...current, childPid: local.pid, childIdentity: local.identity }), ownerRelayStoreDeadline());
            return local;
          },
        }) : localRun();
        run = pendingRun instanceof Promise ? await pendingRun : pendingRun;
        const settledRun = () => {
          runFinished = true;
          // Settled stop custody releases execution independently of the
          // failure reply and its delivery acknowledgement.
          if (owner) {
            try {
              const custody = readRunLedger().runs.find(row => row.requestId === requestId)?.ownerTurn;
              if (custody?.quarantinedAt || custody?.confirmed) {
                void releaseCapacity?.().catch(() => console.error("Owner relay settled capacity release pending"));
                if (conversation && custody.quarantinedAt) void releaseConversationAsync(conversation.id, { state: "broken", pendingCursor: undefined }, ownerRelayStoreDeadline(), requestId)
                  .catch(() => console.error("Owner relay quarantined chain release pending"));
              }
            } catch { console.error("Owner relay settled capacity custody unreadable"); }
          }
        };
        void run.done.then(settledRun, settledRun);
      } catch (error) {
        if (error instanceof EphemeralProfileError)
          return await finish(declined(leaseId, "profile_error"));
        if (!diagnostic) {
          const value = ownerTurnDiagnostic("launch", error, ownerCredentials);
          recordDiagnostic(value);
          logDiagnostic("External relay agent launch failed", value);
        }
        throw error;
      }
      const launchedRun = run;
      if (!launchedRun) throw new Error("external relay launch unavailable");
      // Record launched children and authenticated owner controls. The profile
      // identifies prototype decisions that used no agent or account capacity.
      if ((launchedRun.pid || owner || usingCloud) && !recorder?.begun) recorder?.begin(configuredTarget!.engine!, target.model, owner ? { ...profile, owner: true, ...(prototype ? { prototype: prototype.round.id } : {}) } : profile);
      await changeRunAsync(requestId, (current) => ({
        ...current,
        childPid: launchedRun.pid,
        childIdentity: launchedRun.identity,
      }), ownerRelayStoreDeadline());
      if (launchedRun.pid && !launchedRun.identity)
        for (const delay of [100, 500, 2000]) {
          const timer = setTimeout(() => {
            const identity = procBackend.processIdentity(launchedRun.pid!);
            if (identity && run === launchedRun)
              void changeRunAsync(requestId, (current) => ({
                ...current,
                childIdentity: identity,
              }), ownerRelayStoreDeadline()).catch(() => console.error("External relay child identity persistence unavailable"));
          }, delay);
          timer.unref();
          identityTimers.push(timer);
        }
      if (leaseUnavailable && !ownerExecution) launchedRun.cancel();
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      const expired = executionExpired ? executionExpired.then((): Awaited<typeof launchedRun.done> =>
        ({ status: "timeout", answer: null, durationMs: Date.now() - started, code: null, signal: null }))
        : owner && !prototype ? new Promise<Awaited<typeof launchedRun.done>>(resolve => {
          requestTimer = setTimeout(() => {
            launchedRun.cancel();
            resolve({ status: "timeout", answer: null, durationMs: Date.now() - started, code: null, signal: null });
          }, target.hardCapMinutes * 60_000);
          requestTimer.unref();
        }) : null;
      try { result = await (expired ? Promise.race([launchedRun.done, expired]) : launchedRun.done); }
      finally { if (requestTimer) clearTimeout(requestTimer); }
      if (owner && !prototype && (cloud || result.status === "timeout") && Date.now() >= executionDeadline) return await finishOwnerTimeout(started);
      if (!usingCloud || cloudFailed || result.status !== "done") ownerParts?.close();
      if (result.diagnostic) recordDiagnostic(result.diagnostic);
      else if (result.status === "failed") {
        const value = { ...ownerTurnDiagnostic("observation", "Agent process failed", ownerCredentials),
          exitCode: result.code, signal: result.signal };
        recordDiagnostic(value);
        logDiagnostic("External relay agent failed", diagnostic ?? value);
      }
      if (ownerParts) { stagedAttachments = ownerParts.parts().attachments; answerDrops.push(...ownerParts.drops); }
      if (!usingCloud || cloudFailed || result.status !== "done") await ownerTools?.close(result.status);
      if (!owner && result.status === "done") {
        const refusal = await checkProviderOpens(result.providerOpens ?? [], rounds, {
          reader: runtime?.pageReader, signal: AbortSignal.any([callAbort.signal, AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline.at - Date.now())))]) });
        if (refusal) {
          result = { ...result, answer: null, status: "violation" };
          if (loop) {
            loop.results.push(refusal);
            loop.records.push({ round: rounds, tool: "web_search", page: false, status: refusal.status,
              code: refusal.refusal?.class ?? refusal.code ?? null, audience: null, truncated: false, replayed: false, withheld: false, local: true });
          }
          if (loop && !conversation && !final) continue;
          conversationBroken = !!conversation;
        }
      }
      if (conversation && !owner) {
        if (result.sessionId) conversation.sessionId = result.sessionId;
        else { conversationBroken = true; if (result.status === "done") result = { ...result, status: "failed" }; }
        if (result.status === "violation" || result.status === "failed") conversationBroken = true;
        conversationEvidence = { sessionId: conversation.sessionId, promptTokens: result.promptTokens ?? conversationEvidence.promptTokens, compacted: conversationEvidence.compacted || result.compacted };
      }
      if (owner && conversation && result.status !== "done") conversationBroken = true;
      resultDelivered = result.status === "done";
      if (pendingBeat) await pendingBeat;
      cancelStalledRun();
      if (leaseUnavailable && !ownerExecution) return null;
      if (request.delivery === "guest" && result.status === "done")
        result = { ...result, answer: scrubOwnerReply(result.answer, ownerCredentials) };
      const decision = result?.status === "done"
        ? loop && !final ? checkedRoundV2(result.answer, request, caps!, { handoff: !loop.actionSent, ignore: !loop.sawUnknown }, answerDrops) : checkedAnswerV2(result.answer, request, caps!, { handoff: !loop?.actionSent && !ownerTools?.actionSent, ignore: !loop?.sawUnknown && !ownerTools?.sawUnknown, stagedAttachments: owner ? stagedAttachments.length : 0 }, answerDrops)
        : null;
      if (usingCloud && !cloudFailed && (!decision || !("kind" in decision))) {
        ownerParts?.close();
        await ownerTools?.close(result.status);
      }
      if (caps?.generate && !owner && result?.imageHome && result.threadId) {
        const directory = path.join(result.imageHome, "generated_images", result.threadId);
        let names = new Set<string>();
        try { names = new Set((await withViewerOperation("relay.attachments", () => fs.promises.readdir(directory))).filter(name => !previousImages.has(name))); } catch { /* No generated files. */ }
        const owned = generatedSources.get(directory) ?? new Set<string>();
        for (const name of names) { generatedFiles.push(path.join(directory, name)); owned.add(name); }
        generatedSources.set(directory, owned);
        if (decision && !("kind" in decision) && decision.action === "reply") stagedAttachments = await stageGeneratedAttachments(answerFiles(decision), directory, names, runDir, caps, answerDrops, generatedSources,callAbort.signal);
      } else if (caps?.generate && !owner && decision && !("kind" in decision) && answerFiles(decision).length) {
        stagedAttachments = await stageGeneratedAttachments(answerFiles(decision), null, new Set(), runDir, caps, answerDrops, generatedSources,callAbort.signal);
      }
      if (leaseUnavailable && !ownerExecution) return null;
      if (steps && decision && !("kind" in decision)) {
        steps.observe({ writingAnswer: true });
        if (steps.changeDue(Date.now())) {
          newestProgress = steps.beat(++progressSeq, Date.now(), true);
          if (newestProgress?.kind === "step") noteRelayProgress(relay.id, target.id, newestProgress);
          transport?.progress(newestProgress);
        }
      }
      if (!decision || !("kind" in decision)) { completion = decision; break; }
      const tools = loop!.runCalls(decision.calls, rounds);
      if (executionExpired && await Promise.race([tools, executionExpired]) === "expired") return await finishOwnerTimeout(started);
      await tools;
      if (toolMedia) await toolMedia.collect(loop!.results);
      if (leaseUnavailable && !ownerExecution) return null;
      const actionAnswer = actionOutcomeAnswer(request, loop!.results);
      if (actionAnswer) { completion = actionAnswer; break; }
    }
    if (pendingBeat) await pendingBeat;
    cancelStalledRun();
    if (leaseUnavailable && !ownerExecution) return null;
    // A hand-off returns the request to the service, which answers it with
    // its own agent (§A.8); it carries no text from this install.
    failureReply = !!owner && !!diagnostic && result?.status !== "cancelled";
    if (failureReply) stagedAttachments = [];
    failureNotice = !completion && failureReply && !!allowOwnerReply?.();
    const body: ExternalRelayCompletion = completion?.action === "handoff"
      ? declined(leaseId, "handoff", null, HANDOFF_DETAIL)
      : completion
      ? {
          lease_id: leaseId,
          outcome: "answered" as const,
          answer: completion,
          duration_ms: Date.now() - started,
        }
      : owner && diagnostic && failureNotice
      ? { lease_id: leaseId, outcome: "answered", answer: ownerFailureAnswer(request, owner, diagnostic, ownerCredentials)!, duration_ms: Date.now() - started }
      : failed(
          leaseId,
          result?.status === "violation"
            ? "profile_violation"
            : result?.status === "timeout"
              ? "hard_cap"
              : result?.status === "done"
                ? "invalid_answer"
                : result?.status === "cancelled"
                  ? "cancelled"
                  : "agent_error",
        );
    return await finish(body);
  } catch (error) {
    if (cloudUncertain) {
      // No completion or retry can establish what the disconnected Cloud did.
      // The durable row fences redelivery, including after Viewer restart.
      console.error("External relay Cloud execution unconfirmed; request custody retained");
      recorder?.finish({ outcome: "execution_uncertain", answer: null, delivery: null, ...loopRecord() });
      journal.outcome = "execution_uncertain";
      return null;
    }
    if (!ownerExecution && (leaseUnavailable || error instanceof ExternalRelayError && error.status === 409 && error.code === "lease_lost")) {
      leaseUnavailable = true;
      recorder?.finish({ outcome: "lease_lost", answer: null, delivery: null });
      return null;
    }
    if (callAbort.signal.aborted) return null;
    if (cloud && boundedOwnerTurn && Date.now() >= executionDeadline) { run?.cancel(); return await finishOwnerTimeout(deadline.receivedAt); }
    if (error instanceof CloudOwnerDirectoryError && (!owner || !run)) return await finish({ lease_id: leaseId, outcome: "failed", reason: "configuration_error", detail: error.message });
    if (!diagnostic) {
      // Record, journal and hand the first failure to durable owner custody
      // before cancelling: the stop below may wait for host confirmation.
      const value = ownerTurnDiagnostic("exception", error, ownerCredentials);
      recordDiagnostic(value);
      logDiagnostic("Owner relay turn failed", value);
    }
    if (owner && diagnostic && run) {
      run.diagnose?.(diagnostic);
      // Durable custody keeps the reason and its reply even if host control
      // never confirms. Awaited before the stop: its synchronous cutoff write
      // must not contend with this write's file lock.
      const kept = request ? ownerFailureCustody(request, owner, diagnostic, deadline.at, ownerCredentials) : { diagnostic };
      try { await changeRunAsync(requestId, current => current.ownerTurn && !current.ownerTurn.diagnostic
        ? { ...current, ownerTurn: { ...current.ownerTurn, ...kept } } : current, ownerRelayStoreDeadline()); }
      catch { console.error("Owner relay diagnostic persistence unavailable; the stop cutoff retries it"); }
    }
    if (run) {
      if (!runFinished) run.cancel();
      // Stop recovery may outlast the request: the requester still gets the
      // status notice at the request bound while execution custody is retained.
      let boundTimer: ReturnType<typeof setTimeout> | undefined;
      const bound = boundedOwnerTurn ? new Promise<"expired">(resolve => {
        boundTimer = setTimeout(() => resolve("expired"), remainingMs(deadline)); boundTimer.unref();
      }) : null;
      try {
        const ended = run.done.then(() => "ended" as const, () => "ended" as const);
        if (await (bound ? Promise.race([ended, bound]) : ended) === "expired") return await finishOwnerTimeout(deadline.receivedAt);
      } finally { if (boundTimer) clearTimeout(boundTimer); }
    }
    if (owner) {
      failureReply = true;
      stagedAttachments = [];
      if (allowOwnerReply?.()) {
        failureNotice = true;
        return await finish({ lease_id: leaseId, outcome: "answered",
          answer: ownerFailureAnswer(request, owner, diagnostic!, ownerCredentials)!, duration_ms: Date.now() - deadline.receivedAt });
      }
    }
    return await finish(failed(leaseId, "agent_error"));
  } finally {
    try {
      if (!claimSettled) {
        try { await settleClaim(claimTerminal ? "terminal" : "release", deadline.at); }
        catch { console.error("External relay request claim cleanup failed"); }
      }
      leaveRelayHold(requestId);
      deliverySettled();
      if (executionTimer) clearTimeout(executionTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      callAbort.abort();
      if (ownerParts) {
        let keepFiles = true;
        try { const custody = readRunLedger().runs.find(row => row.requestId === requestId)?.ownerTurn;
          keepFiles = !!(custody?.lateAnswer || custody?.completionAttempt); }
        catch { console.error("Owner relay late answer custody unreadable; staged files preserved"); }
        await ownerParts.dispose(keepFiles);
      }
      await inbound?.dispose();
      await toolMedia?.dispose();
      for (const file of generatedFiles) { try { await fs.promises.rm(file, {force:true}); } catch { console.error("Relay generated image cleanup failed"); } }
      await ownerTools?.dispose();
      let releasePin = true;
      let quarantined = false;
      if (conversation && owner) {
        try {
          const held = readRunLedger().runs.find(r => r.requestId === requestId);
          releasePin = !ownerRunPending() && !(held && ownerStopPending(held));
          if (held?.ownerTurn?.quarantinedAt) { conversationBroken = true; quarantined = true; }
        } catch { releasePin = false; } // Unreadable custody cannot admit a peer turn.
      }
      if (conversation && releasePin) {
        const compacted = conversationEvidence.compacted;
        await releaseConversationAsync(conversation.id, { state: conversationBroken ? "broken" : "idle", sessionId: conversation.sessionId,
          ...(owner && resultDelivered && completionAccepted && terminal.completion?.outcome === "answered"
            && terminal.completion.answer.action === "reply" && conversation.conversationId
            ? { answerWitness: { conversationId: conversation.conversationId, inReplyTo: owner.messageId,
              textSha256: createHash("sha256").update(terminal.completion.answer.text).digest("hex") } } : {}),
          ...(quarantined ? { pendingCursor: undefined } : {}),
          ...(conversationEvidence.sessionId || owner && conversation.conversationId && resultDelivered ? { accountId: conversation.accountId, turns: conversation.turns + 1, turnsSinceCompaction: compacted ? 0 : conversation.turnsSinceCompaction + 1,
            lastTurnAt: new Date().toISOString(), seen: compacted ? [] : turn?.seen ?? [], staticDigest: compacted ? null : turn?.digest ?? null,
            lastPromptTokens: conversationEvidence.promptTokens ?? null, compactions: conversation.compactions + (compacted ? 1 : 0), pendingCursor: undefined } : {}) }, ownerRelayStoreDeadline(), requestId);
      }
      for (const timer of identityTimers) clearTimeout(timer);
      // The only way out without a completion is a lost lease.
      if (recorder && !duplicate && !recorder.finished)
        recorder.finish({ outcome: "lease_lost", answer: null, delivery: null, ...loopRecord() });
      if (!duplicate) journalFinished();
      try {
        const held = readRunLedger().runs.find(r => r.requestId === requestId);
        // Pending stops and released owner stops both keep their custody record.
        const custodyPending = !!held?.cloudExecution && (held.cloudExecution === "uncertain" || !held.completionAccepted) || !!held?.ownerTurn?.completionAttempt || !!held?.ownerTurn?.lateAnswer || ownerRunPending() || !!held && ownerStopPending(held) || !!held?.ownerTurn?.released;
        if (recorded && !custodyPending && !(completionAccepted && !capacityReleased)) await dropRunAsync(requestId, ownerRelayStoreDeadline());
      } catch (error) {
        console.error("External relay run ledger cleanup failed", error instanceof Error ? error.name : "unknown");
      }
      try {
        const held = readRunLedger().runs.find(r => r.requestId === requestId);
        if (runDir && !held?.ownerTurn?.completionAttempt && !held?.ownerTurn?.lateAnswer && !ownerRunPending() && !(held && ownerStopPending(held))) await fs.promises.rm(runDir, { recursive: true, force: true });
      } catch (error) {
        console.error("External relay run directory cleanup failed", error instanceof Error ? error.name : "unknown");
      }
    } finally {
      if (replacedRunDir) await fs.promises.rm(replacedRunDir, { recursive: true, force: true }).catch(() => console.error("Relay intent directory cleanup failed"));
      notifyInitialLease();
      await transport?.close();
      transport = null;
      inflight.delete(requestId);
      if (recorded && !capacityReleased && !completionAccepted && !activeCapacityFreed) {
        activeCapacityFreed = true;
        free(relay, target);
      }
      onFreed?.();
    }
  }
}
