import { hasInboundMedia, prepareInboundMedia, writeInboundAgentInput } from "./mediaInput";
import { isInboundImage } from "./mediaInputValidation";
import { validateAnswerComposition } from "./composition";
import { answerCapabilities, checkedAnswerV2, checkedRoundV2, withAnswerParts, answerFiles, type AnswerDrop } from "./answerV2";
import { stageGeneratedAttachments, uploadAnswerAttachments, type StagedAttachment } from "./attachments";
import { openOwnerAnswer } from "./ownerAnswer";
import { hydrateToolIndex } from "./toolIndex";
import { openOwnerServiceTools } from "./ownerServiceTools";
import { waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { resolveOwnerOutboundContext } from "./ownerOutboundContext";
import { capacityWaiters, olderCapacityWaiter, enterRelayHold, leaveRelayHold, releasingRelayHolds, type RelayHoldCause } from "./hold";
import { relayRequestDeadline } from "./deadline";
import { ownerRelayAuthorized, ownerRelayAuthorizedAsync, ownerRelayFailureReplyAuthorized } from "./ownerAuthority";
import { matchPrototypeAnswer } from "@/lib/prototypeReview/telegramAnswer";
import { runPrototypeAnswer } from "./prototypeAnswer";
import { resolveOwnerBridgeContext } from "./ownerBridgeContext";
import { runOwnerAgent, OwnerContinuationRefused, ownerContinuationPrompt, ownerInitialCursor, ownerRunPrompt, ownerFailureAnswer, type OwnerRunPorts } from "./ownerRun";
import { ownerTurnDiagnostic, type OwnerTurnDiagnostic } from "./diagnostic";
import { readRelaySwitches } from "./switches";
import { compactRequestSchema } from "./protocol";
import { runCompactRequest } from "./compact";
import { conversationAuthority, lookupChainConversationAsync, resolveChainConversationAsync, reserveChainConversationAsync, releaseConversationAsync, prepareConversationAccount, conversationCodexHome, sweepConversationsAsync, type RelayConversation } from "./conversations";
import { activeDrain } from "@/lib/selfUpdate/drain";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { procBackend } from "@/lib/proc";
import {
  runEphemeralAgent,
  EphemeralProfileError,
} from "@/lib/agent/ephemeral";
import type { HeadlessReviewRuntime } from "@/lib/agent/headless";
import { relayCall, ExternalRelayError } from "./client";
import { completeRelayRequest } from "./relayCompletion";
import { InlineRelayLeaseTransport, RelayLeaseTransport } from "./relayLeaseTransport";
import {
  answerSchema,
  replyAnswerSchema,
  roundSchema,
  type ExternalRelayDecision,
  handoffAnswerSchema,
  offersHandoff,
  requestSchema,
  type ExternalRelayCompletion,
  type ExternalRelayProgress,
} from "./protocol";
import { callableTools, RELAY_TOOL_ROUNDS, createToolLoop, toolSleep, type ToolLoopRuntime } from "./toolLoop";
import { answerPrompt, toolRoundPrompt, conversationTurnPrompt, conversationRoundPrompt } from "./prompt";
import { progressForEvent } from "./progress";
import { createRelaySteps } from "./progressSteps";
import { readRelayStepObservation } from "./stepObservation";
import { noteRelayProgress } from "./activity";
import { answerRecorder, countMemberAnswers, readAnswerRecord, type RelayAnswerDelivery } from "./answers";
import {
  answerProfileFor,
  ownerTierFor,
  exemptFromMemberLimit,
  memberLimitFor,
  RELAY_MEMBER_LIMIT_WINDOW_MS,
} from "./profile";
import {
  changeRunAsync,
  claimRelayRequestAsync,
  dropRunAsync,
  reserveRunAsync,
  RelayStoreBusy,
  readRunLedger,
  runHoldsCapacity,
  settleRelayRequestClaimAsync,
  type PairedRelay,
  type RelayTargetSettings,
} from "./store";

const globalRelay = globalThis as typeof globalThis & {
  __llvExternalRelayActive?: Map<string, number>;
  __llvExternalRelayInflight?: Set<string>;
};
const active = (globalRelay.__llvExternalRelayActive ??= new Map<string, number>());
const inflight = globalRelay.__llvExternalRelayInflight ??= new Set<string>();
export const relayRequestInFlight = (requestId: string): boolean => inflight.has(requestId);
export function externalRelayTempRoot(): string {
  const temporary = path.resolve(os.tmpdir());
  const home = path.resolve(os.homedir());
  return temporary === home || temporary.startsWith(home + path.sep)
    ? "/tmp"
    : temporary;
}
const countKey = (relayId: string, targetId: string) =>
  `${relayId}:${targetId}`;
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
export const memberLimitDetail = (limit: number) =>
  `This member reached ${limit} ${limit === 1 ? "answer" : "answers"} in the last hour in this chat.`;
const failed = (lease_id: string, reason: string): ExternalRelayCompletion => ({
  lease_id,
  outcome: "failed",
  reason,
  detail: null,
});
export { completeRelayRequest } from "./relayCompletion";
export async function runClaimedRequest(
  relay: PairedRelay,
  raw: unknown,
  onFreed?: () => void,
  runtime?: HeadlessReviewRuntime & ToolLoopRuntime & { timeoutMs?: number; ownerPorts?: OwnerRunPorts; onUnknownFeature?: () => Promise<unknown>; onLeaseReady?: () => void; leaseWorker?: boolean },
): Promise<ExternalRelayCompletion | null> {
  const deadline = relayRequestDeadline(raw);
  const claimId = raw && typeof raw === "object" ? (raw as Record<string, unknown>).request_id : null;
  if (deadline.fallback && typeof claimId === "string")
    console.info("External relay deadline", { request: claimId.slice(0, 8), fallback: deadline.fallback });
  if (readRelaySwitches().compact && raw && typeof raw === "object" && (raw as Record<string, unknown>).kind === "compact") {
    const compact = compactRequestSchema.safeParse(raw);
    if (compact.success) return runCompactRequest(relay, compact.data, onFreed, runtime);
    const invalid = raw as Record<string, unknown>;
    if (typeof invalid.request_id !== "string" || typeof invalid.lease_id !== "string") return null;
    return (await completeRelayRequest(relay, invalid.request_id, declined(invalid.lease_id, "invalid_request"), () => deadline.at,
      undefined, runtime?.onUnknownFeature)).body;
  }
  const parsed = requestSchema.safeParse(raw);
  const request = parsed.success ? parsed.data : null;
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
  if (inflight.has(requestId) || readRunLedger().runs.some((run) => run.requestId === requestId)) return null;
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
  let terminalCompletion: ExternalRelayCompletion | null = null;
  let claimSettled = false;
  let claimTerminal = false;
  const settleClaim = async (disposition: "terminal" | "release", until = deadline.at) => {
    await settleRelayRequestClaimAsync(requestId, leaseId, claimOwnerPid, claimOwnerIdentity, disposition,
      disposition === "terminal" ? terminalCompletion : null, until);
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
    input: rawRequest.input,
    ...(request?.features ? { features: request.features } : {}),
  });
  inflight.add(requestId);
  let diagnostic: OwnerTurnDiagnostic | undefined;
  const recordDiagnostic = (value: OwnerTurnDiagnostic) => {
    diagnostic ??= value;
    recorder?.diagnose(diagnostic);
  };
  let releaseRequested = false;
  let deliverySettled!: () => void;
  const released = new Promise<void>(resolve => { deliverySettled = resolve; });
  let allowOwnerReply: (() => boolean) | undefined;
  let failureReply = false;
  let leaseUnavailable = false;
  let admissionHeld = false;
  const admissionCutoff = () => admissionHeld ? deadline.declineAt : deadline.at;
  let rounds = 0;
  let ownerTools: ReturnType<typeof openOwnerServiceTools> | null = null;
  let loop: ReturnType<typeof createToolLoop> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let transport: RelayLeaseTransport | InlineRelayLeaseTransport | null = null;
  let pendingBeat: Promise<void> | null = null;
  let finishing: Promise<ExternalRelayCompletion | null> | null = null;
  let ownerParts: ReturnType<typeof openOwnerAnswer> | null = null;
  let stagedAttachments: StagedAttachment[] = [];
  let inbound: Awaited<ReturnType<typeof prepareInboundMedia>> | null = null;
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
    try {
      if (pendingBeat) {
        if (releaseRequested) void pendingBeat.catch(() => console.error("External relay heartbeat refresh failed during demotion"));
        else await pendingBeat;
      }
      if (caps?.rich && leaseUnavailable) return null;
      // Persist the local decision before any delivery wait: a restart must
      // leave the generated answer and early declines inspectable.
      if (body.outcome === "answered" && allowOwnerReply && !allowOwnerReply()) body = failed(body.lease_id, "cancelled");
      if (body.outcome === "answered" && caps?.rich && request) {
        try { validateAnswerComposition(body.answer, request, stagedAttachments.map(file => ({ attachment_id: file.id, kind: file.kind }))); }
        catch (error) { answerDrops.push({ part: "answer", reason: error instanceof ExternalRelayError ? error.code : "malformed" }); body = failed(body.lease_id, "invalid_answer"); }
      }
      recorder?.finish({
        outcome:
          body.outcome === "answered"
            ? "answered"
            : `${body.outcome}:${body.reason}`,
        answer:
          body.outcome === "answered"
            ? body.answer
            : body.outcome === "declined" && body.reason === "handoff"
              ? { action: "handoff", text: "", reply_to: null }
              : null,
        delivery: "unconfirmed",
        ...loopRecord(),
      });
      if (body.outcome === "answered" && body.answer.action === "reply" && caps?.media && request && stagedAttachments.length && !releaseRequested) {
        try {
          body.answer.attachments = await uploadAnswerAttachments(relay, request, stagedAttachments, deadline.at, callAbort.signal, answerDrops,
            { authorize: () => { if (leaseUnavailable || allowOwnerReply && !allowOwnerReply()) throw new Error("relay authorization revoked"); } });
        } catch (error) {
          if (leaseUnavailable || callAbort.signal.aborted || error instanceof ExternalRelayError && (error.status === 404 || error.status === 409 && error.code === "lease_lost")) {
            leaseUnavailable = true;
            recorder?.annotateV2({ outcome: "lease_lost", drops: answerDrops });
            return null;
          }
          answerDrops.push({part:"attachment",reason:"upload_failed"});
          if (allowOwnerReply && !allowOwnerReply()) body = failed(body.lease_id, "cancelled");
        }
        if (body.outcome === "answered" && !body.answer.text.trim() && !body.answer.attachments?.length) body = failed(body.lease_id, "invalid_answer");
      }
      if (body.outcome === "answered" && caps?.rich && request) {
        try { validateAnswerComposition(body.answer, request, stagedAttachments.map(file => ({ attachment_id: file.id, kind: file.kind })), body.answer.attachments ?? []); }
        catch (error) { answerDrops.push({ part: "answer", reason: error instanceof ExternalRelayError ? error.code : "malformed" }); body = failed(body.lease_id, "invalid_answer"); }
      }
      if (body.outcome === "answered" && body.answer.action === "reply" && caps?.rich && !body.answer.text.trim() && !body.answer.attachments?.length) body = failed(body.lease_id, "invalid_answer");
      if (caps?.rich) recorder?.annotateV2({ drops: answerDrops, attachments: stagedAttachments.map(({id,kind,filename,size,sha256}) => ({attachment_id:id,kind,filename,bytes:size,sha256})), ...(body.outcome === "answered" ? { answer: body.answer } : {outcome:`${body.outcome}:${body.reason}`}) });
      const deliveryStart = Date.now();
      const until = releaseRequested ? deliveryStart : deadline.at;
      if (body.outcome === "answered" && allowOwnerReply && !allowOwnerReply()) body = failed(body.lease_id, "cancelled");
      completionInFlight = true;
      let sent: Awaited<ReturnType<typeof completeRelayRequest>>;
      try {
        sent = transport
          ? await transport.complete(body, until, caps?.plainMax ?? 4000, failureReply ? "failure" : !!allowOwnerReply)
          : await completeRelayRequest(relay, requestId, body, () => until, allowOwnerReply, runtime?.onUnknownFeature, caps?.plainMax);
      } catch {
        console.error("External relay helper completion unavailable; using Viewer transport");
        sent = await completeRelayRequest(relay, requestId, body, () => until, allowOwnerReply, runtime?.onUnknownFeature, caps?.plainMax);
      } finally { completionInFlight = false; }
      const completion = sent.body;
      if (sent.delivery === "accepted") {
        completionAccepted = true;
        if (recorded && activeTarget && !activeCapacityFreed) { activeCapacityFreed = true; free(relay, activeTarget); }
        try { await releaseCapacity?.(); }
        catch { console.error("External relay completed capacity release pending"); retryCapacityRelease(); }
      }
      if (caps?.rich && sent.body !== body) recorder?.annotateV2({ drops: [...answerDrops, {part:"answer",reason:"service_downgrade"}] });
      claimTerminal = sent.delivery !== "refused";
      terminalCompletion = claimTerminal ? completion : null;
      try { await settleClaim(claimTerminal ? "terminal" : "release"); }
      catch (error) {
        if (!claimTerminal) throw error;
        console.error("External relay terminal claim settlement pending");
      }
      recorder?.recordDelivery({
        outcome: completion.outcome === "answered" ? "answered" : `${completion.outcome}:${completion.reason}`,
        delivery: sent.delivery,
      });
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
          try { await settleClaim("terminal", Date.now() + 5000); }
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
      ),
    );
  if (deadline.fallback === "past") return finish(declined(leaseId, "busy"));
  const target = relay.targets.find((item) => item.id === request.target_id);
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
  let capacityReleased = false;
  let duplicate = false;
  let run: ReturnType<typeof runEphemeralAgent> | null = null;
  let runFinished = false;
  const callAbort = new AbortController();
  const identityTimers: ReturnType<typeof setTimeout>[] = [];
  let owner: ReturnType<typeof ownerTierFor> = null;
  executionScope = true;
  releaseCapacity = async () => {
    if (!recorded || capacityReleased) return;
    const held = readRunLedger().runs.find(row => row.requestId === requestId);
    if (held?.ownerTurn?.cancel && !held.ownerTurn.confirmed) return;
    await changeRunAsync(requestId, row => {
      if (row.ownerTurn?.cancel && !row.ownerTurn.confirmed) return row;
      return { ...row, capacityReleased: true };
    }, Date.now() + 5000);
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
        if (!held || held.ownerTurn?.cancel && !held.ownerTurn.confirmed) return;
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
    const steps = createRelaySteps(relay.features);
    let progressSeq = 0;
    let stepLog: string | null = null;
    let pendingServiceTools = 0;
    const intervalMs = request.liveness.heartbeat_interval_s * 1000;
    let acked = false;
    let heartbeatBusy = false;
    const started = Date.now();
    const stallMs = request.liveness.stall_window_s * 1000;
    const cancelStalledRun = () => {
      if (!heartbeatBusy && !completionAccepted && !completionInFlight && !leaseUnavailable && Date.now() - heartbeatAt > stallMs) {
        leaseUnavailable = true;
        run?.cancel();
        callAbort.abort();
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
      const step = newestProgress?.kind === "step" ? newestProgress.label : null;
      if (frame.phase === "attempt") heartbeatBusy = true;
      else if (frame.phase === "acknowledged" || frame.phase === "failed" || frame.phase === "post_completion") heartbeatBusy = false;
      console.info("External relay heartbeat", { request: requestId.slice(0, 8), seq: frame.seq,
        phase: frame.phase, step, status: frame.status, ...(frame.code ? { code: frame.code } : {}) });
      if (frame.phase === "acknowledged") { acked = true; heartbeatAt = Date.now(); firstAcknowledged(); }
      else if (frame.phase === "failed") {
        if ((frame.status === 404 || frame.status === 409 && frame.code === "lease_lost") && !completionAccepted) {
          leaseUnavailable = true; run?.cancel(); callAbort.abort();
        }
        firstAcknowledged();
      }
      if (frame.phase === "failed" && frame.code === "unknown_feature")
        void runtime?.onUnknownFeature?.().finally(firstAcknowledged);
    };
    transport = runtime?.leaseWorker === false
      ? new InlineRelayLeaseTransport(relay, requestId, target.id, leaseId, intervalMs, onHeartbeat, initialProgress,
        () => { void runtime?.onUnknownFeature?.(); })
      : new RelayLeaseTransport(relay, requestId, target.id, leaseId, intervalMs, onHeartbeat, initialProgress,
        () => { void runtime?.onUnknownFeature?.(); });
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
      if (steps && !owner && !runFinished && stepLog) steps.observe(readRelayStepObservation(stepLog));
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
    const ownerMessage = ownerTierFor({ ownerTier: true }, request);
    const previousAnswer = ownerMessage ? readAnswerRecord(relay.id, target.id, requestId) : null;
    const replayReviewId = previousAnswer?.profile?.owner && previousAnswer.requester?.key === requester?.key
      && previousAnswer.chatKey === (request.chat?.key ?? null) ? previousAnswer.profile.prototype : undefined;
    const trigger = request.input.conversation.find(message => message.id === ownerMessage?.messageId);
    const parent = request.input.conversation.find(message => message.id === trigger?.reply_to && message.author.self);
    const prototype = ownerMessage ? matchPrototypeAnswer(ownerMessage.text, undefined, replayReviewId, undefined, parent?.text) : null;
    owner = prototype ? ownerMessage : ownerTierFor(target, request);
    if (owner && !prototype) {
      try { owner.localContext = await withViewerOperation("telegram.outbound-state", () =>
        waitForStateLock("relay.owner-context", () => resolveOwnerOutboundContext(request, owner!, relay), { waitMs: 5000 })); }
      catch { owner.localContext = null; }
      try { owner.bridgeReport = resolveOwnerBridgeContext(request, owner, relay.api_base); }
      catch { owner.bridgeReport = null; }
    }
    if (owner) allowOwnerReply = () => (failureReply ? ownerRelayFailureReplyAuthorized : ownerRelayAuthorized)(relay.id, target.id, requestId);
    const authority = conversationAuthority(request.input.requester, !!owner);
    const usesConversation = !prototype && readRelaySwitches().chain_conversations && request.chat && authority;
    let preResolvedConversation: RelayConversation | null = null;
    let preResolutionPending = false;
    if (usesConversation) {
      try { preResolvedConversation = await resolveChainConversationAsync(relay, target, request, authority!, admissionCutoff()); preResolutionPending = true; }
      catch (error) {
        if (!(error instanceof RelayStoreBusy)) throw error;
        preResolvedConversation = await lookupChainConversationAsync(relay, target, request, authority!);
      }
    }
    const selectAccount = () => prototype ? null : accountManager.resolveHeadlessSpawn(target.engine!,
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
    runDir = await fs.promises.mkdtemp(
      path.join(externalRelayTempRoot(), "llv-external-relay-"),
    );
    const ownerIdentity = procBackend.processIdentity(process.pid);
    if (!ownerIdentity) throw new Error("viewer process identity unavailable");
    const record = {
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
      ...(owner ? { ownerTurn: { clientAttemptId: `relay-owner-${requestId}`,
        request: { text: owner.text, requestText: owner.requestText },
        ...(owner.bridgeReport ? { bridgeReport: owner.bridgeReport } : {}),
        ...(prototype && target.ownerTier !== true ? { prototype: true as const } : {}) } } : {}),
    };
    let admissionDecline: ExternalRelayCompletion | null = null;
    let wakeHold: (() => void) | null = null;
    const releaseAdmission = async () => {
      if (conversation) { await releaseConversationAsync(conversation.id, {}, Date.now() + 5000); conversation = null; }
      if (recorded) { await dropRunAsync(requestId, Date.now() + 5000); free(relay, target); recorded = false; }
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
            const admission = await reserveRunAsync(record, target.concurrency, admissionCutoff());
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
    const lose = () => { leaseUnavailable = true; run?.cancel(); callAbort.abort(); };
    const lease = {
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
    if (hasInboundMedia(request)) {
      if (!await lease.ack()) return null;
      inbound = await prepareInboundMedia(relay, request, runDir, { signal: callAbort.signal, deadlineAt: deadline.at,
        authorize: () => { if (leaseUnavailable || releaseRequested || allowOwnerReply && !allowOwnerReply()) throw new ExternalRelayError("lease_lost", 409); } });
      callAbort.signal.throwIfAborted();
    }
    const hydrated = await hydrateToolIndex(relay, request, lease, runtime, deadline.at);
    request.input = hydrated.request.input;
    callAbort.signal.throwIfAborted();
    if (owner && !prototype && callableTools(request).length) ownerTools = openOwnerServiceTools(relay, target, request, hydrated.guidance, lease, runtime ?? {},
      () => ownerRelayAuthorizedAsync(relay.id, target.id, requestId));
    if (!owner && callableTools(request).length) loop = createToolLoop(relay, request, lease, runtime, (tool, done, failed) => {
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
    if (owner && !prototype && caps?.rich) ownerParts = openOwnerAnswer(relay.id, request, runDir, [relay.credential], () => !leaseUnavailable && !callAbort.signal.aborted && allowOwnerReply!(),callAbort.signal);
    let result: Awaited<ReturnType<typeof runEphemeralAgent>["done"]> | null = null;
    let completion: ExternalRelayDecision | null = null;
    for (rounds = 1; rounds <= (loop ? RELAY_TOOL_ROUNDS : 1); rounds++) {
      if (Date.now() >= deadline.at) return await finish(declined(leaseId, "busy"));
      const final = rounds === RELAY_TOOL_ROUNDS || !!loop && loop.callsLeft() === 0;
      runFinished = false;
      let previousImages = new Set<string>();
      if (caps?.generate && conversation?.sessionId) {
        try { previousImages = new Set(await withViewerOperation("relay.attachments", () => fs.promises.readdir(path.join(conversationCodexHome(conversation!), "generated_images", conversation!.sessionId!)))); } catch { /* New image directory. */ }
      }
      try {
        if (rounds === 1 && activeDrain()) {
          await releaseAdmission();
          if (!await admit()) return admissionDecline ? await finish(admissionDecline) : null;
        }
        const roundPrompt = loop ? toolRoundPrompt(request, rounds, { results: loop.results, callsLeft: loop.callsLeft(), final, actionSent: loop.actionSent }, target.engine) : answerPrompt(request, target.engine);
        const frame = roundPrompt.slice(roundPrompt.lastIndexOf("[Answer with one JSON object"));
        if (conversation && rounds === 1) turn = owner ? ownerContinuationPrompt(request, owner, target.hardCapMinutes, conversation) : conversationTurnPrompt(request, conversation, frame);
        const persistentPrompt = conversation ? rounds === 1 ? turn!.prompt : conversationRoundPrompt(loop!.results.filter((r) => r.round === rounds - 1), frame) : roundPrompt;
        if (conversation) {
          const promptBytes = Buffer.byteLength(owner ? conversation.conversationId ? turn!.prompt : ownerRunPrompt(request, owner, target.hardCapMinutes) : persistentPrompt);
          chain = rounds === 1 ? { continued: owner ? !!conversation.conversationId : !!conversation.sessionId, promptBytes }
            : { continued: chain!.continued, promptBytes: chain!.promptBytes + promptBytes };
        }
        if (conversation && owner && rounds === 1 && conversation.conversationId && turn) {
          await releaseConversationAsync(conversation.id, { state: "running", runningRequestId: requestId,
            pendingCursor: { operationId: `relay-owner-${requestId}`, seen: turn.seen, staticDigest: turn.digest } }, Date.now() + 5000);
        }
        const agentPrompt = (conversation ? persistentPrompt : roundPrompt) + (inbound?.prompt ? "\n" + inbound.prompt : "");
        const roundDirectory = loop ? path.join(runDir, `round-${rounds}`) : runDir;
        let inputFile: string | undefined;
        if (!owner && target.engine === "claude" && inbound?.files.length) {
          await fs.promises.mkdir(roundDirectory, { recursive: true, mode: 0o700 });
          callAbort.signal.throwIfAborted();
          inputFile = await writeInboundAgentInput(inbound.files, agentPrompt, roundDirectory, callAbort.signal,
            () => { if (leaseUnavailable || releaseRequested) throw new ExternalRelayError("lease_lost", 409); });
          callAbort.signal.throwIfAborted();
        }
        steps?.observe({});
        stepLog = path.join(loop ? path.join(runDir, `round-${rounds}`) : runDir, "stdout.log");
        run = prototype ? runPrototypeAnswer(prototype, owner!.messageId, () => {
          if (leaseUnavailable || callAbort.signal.aborted || !allowOwnerReply!()) throw new Error("owner relay authorization revoked");
        }, { telegramUserId: relay.owner.namespace === "telegram" ? relay.owner.id : undefined }) : owner ? runOwnerAgent({
          ...(conversation?.conversationId ? { continuation: { conversationId: conversation.conversationId, prompt: turn!.prompt } } : {}),
          authorize: () => { if (leaseUnavailable || callAbort.signal.aborted || !ownerRelayAuthorized(relay.id, target.id, requestId)) throw new Error("owner relay authorization revoked"); },
          credentials: [relay.credential],
          onDiagnostic: recordDiagnostic,
          rawDeadlineAt: rawRequest.deadline_at,
          inboundContext: inbound?.prompt,
          request, owner, target, deadline, accountId: selectedAccount().accountId,
          hardCapMs: Math.min(target.hardCapMinutes * 60_000, runtime?.timeoutMs ?? Infinity), ports: runtime?.ownerPorts,
          onConversation: async (conversationId, initialPrompt) => {
            await changeRunAsync(requestId, current => ({ ...current, conversationId }), Date.now() + 5000);
            if (conversation) {
              conversation.conversationId = conversationId;
              const cursor = initialPrompt ? ownerInitialCursor(request, owner!, target.hardCapMinutes) : null;
              if (cursor) turn = { prompt: "", ...cursor };
              const patch = { conversationId, state: "running" as const, runningRequestId: requestId,
                ...(initialPrompt && cursor ? { pendingCursor: { operationId: initialPrompt.operationId, seen: cursor.seen, staticDigest: cursor.digest } } : {}) };
              await releaseConversationAsync(conversation.id, patch, Date.now() + 5000);
              if (cursor) Object.assign(conversation, patch);
            }
            ownerTools?.bindConversation(conversationId);
            recorder?.bindConversation(conversationId);
          },
          ...(steps ? { onProgress: steps.observe } : {}),
        }) : runEphemeralAgent({
          ...(conversation ? { session: { mode: conversation.sessionId ? "resume" as const : "start" as const, id: conversation.sessionId ?? (target.engine === "claude" ? crypto.randomUUID() : null), cwd: conversation.cwd!, codexHome: conversationCodexHome(conversation) } } : {}),
          key: loop ? `external-relay:${requestId}:${rounds}` : `external-relay:${requestId}`,
          engine: target.engine,
          model: target.model,
          effort: target.effort,
          account: selectedAccount(),
          ["prompt"]: agentPrompt,
          ...(inputFile ? { inputFile } : {}),
          ...(inbound?.files.length ? { inputImages: inbound.files.filter(file => isInboundImage(file.mime_type)).map(file => file.path) } : {}),
          schema: withAnswerParts(loop ? (final ? (loop.sawUnknown ? replyAnswerSchema : loop.actionSent ? answerSchema : handoffAnswerSchema) : roundSchema(loop.tools, { handoff: !loop.actionSent }))
            : ownerTools ? (ownerTools.sawUnknown ? replyAnswerSchema : ownerTools.actionSent ? answerSchema : offersHandoff(request) ? handoffAnswerSchema : answerSchema)
              : offersHandoff(request) ? handoffAnswerSchema : answerSchema, caps!),
          runDir: loop ? path.join(runDir, `round-${rounds}`) : runDir,
          hardCapMs: target.hardCapMinutes * 60_000,
          webSearch: profile.webSearch,
          ...(caps?.generate ? { imageGeneration: { readableRoot: conversation?.cwd ?? path.join(loop ? path.join(runDir, `round-${rounds}`) : runDir, "cwd"), ...(inbound?.files.length ? { readableMediaRoot: path.dirname(inbound.files[0]!.path) } : {}) } } : {}),
          runtime,
          onEvent: (event) => {
            if (steps) return;
            const progress = progressForEvent(event);
            if (progress && request.answer.progress === "notes") {
              newestProgress = progress;
              noteRelayProgress(relay.id, target.id, progress);
              transport?.progress(progress);
            }
          },
        });
        void run.done.then(() => { runFinished = true; }, () => { runFinished = true; });
      } catch (error) {
        if (error instanceof EphemeralProfileError)
          return await finish(declined(leaseId, "profile_error"));
        throw error;
      }
      const launchedRun = run;
      if (!launchedRun) throw new Error("external relay launch unavailable");
      // Record launched children and authenticated owner controls. The profile
      // identifies prototype decisions that used no agent or account capacity.
      if ((launchedRun.pid || owner) && !recorder?.begun) recorder?.begin(target.engine, target.model, owner ? { ...profile, owner: true, ...(prototype ? { prototype: prototype.round.id } : {}) } : profile);
      await changeRunAsync(requestId, (current) => ({
        ...current,
        childPid: launchedRun.pid,
        childIdentity: launchedRun.identity,
      }), Date.now() + 5000);
      if (launchedRun.pid && !launchedRun.identity)
        for (const delay of [100, 500, 2000]) {
          const timer = setTimeout(() => {
            const identity = procBackend.processIdentity(launchedRun.pid!);
            if (identity && run === launchedRun)
              void changeRunAsync(requestId, (current) => ({
                ...current,
                childIdentity: identity,
              }), Date.now() + 5000).catch(() => console.error("External relay child identity persistence unavailable"));
          }, delay);
          timer.unref();
          identityTimers.push(timer);
        }
      if (leaseUnavailable) launchedRun.cancel();
      // The request deadline bounds admission and delivery retries. A run
      // already launched remains protected by its lease and configured cap.
      try { result = await launchedRun.done; }
      catch (error) {
        if (!(error instanceof OwnerContinuationRefused) || !conversation || !owner) throw error;
        run = null;
        if (error.reason === "unavailable") {
          if (conversation.conversationId) ownerTools?.unbindConversation(conversation.conversationId);
          Object.assign(conversation, { conversationId: null, seen: [], staticDigest: null });
          await releaseConversationAsync(conversation.id, { conversationId: null, seen: [], staticDigest: null, state: "running", runningRequestId: requestId }, Date.now() + 5000);
          await changeRunAsync(requestId, current => ({ ...current, conversationId: undefined,
            ownerTurn: { ...current.ownerTurn!, continuation: undefined, admissionComplete: false } }), Date.now() + 5000);
        } else {
          admissionHeld = true;
          await releaseAdmission();
          enterRelayHold({ requestId, relayId: relay.id, targetId: target.id, cause: "chat", deadline,
            release: () => { releaseRequested = true; wakeHold?.(); return released; } });
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, Math.max(0, Math.min(1000, deadline.declineAt - Date.now())));
            wakeHold = () => { clearTimeout(timer); resolve(); };
          });
          wakeHold = null;
          if (Date.now() >= deadline.declineAt) return await finish(declined(leaseId, "busy", null, "chat busy"));
          if (!await admit()) return admissionDecline ? await finish(admissionDecline) : null;
        }
        rounds--; continue;
      }
      ownerParts?.close();
      if (result.diagnostic) recordDiagnostic(result.diagnostic);
      if (ownerParts) { stagedAttachments = ownerParts.parts().attachments; answerDrops.push(...ownerParts.drops); }
      await ownerTools?.close(result.status);
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
      if (leaseUnavailable) return null;
      const decision = result?.status === "done"
        ? loop && !final ? checkedRoundV2(result.answer, request, caps!, { handoff: !loop.actionSent, ignore: !loop.sawUnknown }, answerDrops) : checkedAnswerV2(result.answer, request, caps!, { handoff: !loop?.actionSent && !ownerTools?.actionSent, ignore: !loop?.sawUnknown && !ownerTools?.sawUnknown, stagedAttachments: owner ? stagedAttachments.length : 0 }, answerDrops)
        : null;
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
      if (leaseUnavailable) return null;
      if (steps && decision && !("kind" in decision)) {
        steps.observe({ writingAnswer: true });
        if (steps.changeDue(Date.now())) {
          newestProgress = steps.beat(++progressSeq, Date.now(), true);
          if (newestProgress?.kind === "step") noteRelayProgress(relay.id, target.id, newestProgress);
          transport?.progress(newestProgress);
        }
      }
      if (!decision || !("kind" in decision)) { completion = decision; break; }
      await loop!.runCalls(decision.calls, rounds);
      if (leaseUnavailable) return null;
    }
    if (pendingBeat) await pendingBeat;
    cancelStalledRun();
    if (leaseUnavailable) return null;
    // A hand-off returns the request to the service, which answers it with
    // its own agent (§A.8); it carries no text from this install.
    failureReply = !!owner && !!diagnostic && result?.status !== "cancelled";
    if (failureReply) stagedAttachments = [];
    const body: ExternalRelayCompletion = completion?.action === "handoff"
      ? declined(leaseId, "handoff", null, HANDOFF_DETAIL)
      : completion
      ? {
          lease_id: leaseId,
          outcome: "answered" as const,
          answer: completion,
          duration_ms: Date.now() - started,
        }
      : owner && diagnostic && result?.status !== "cancelled" && allowOwnerReply?.()
      ? { lease_id: leaseId, outcome: "answered", answer: ownerFailureAnswer(request, owner, diagnostic, [relay.credential])!, duration_ms: Date.now() - started }
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
    if (leaseUnavailable || error instanceof ExternalRelayError && error.status === 409 && error.code === "lease_lost") {
      leaseUnavailable = true;
      recorder?.finish({ outcome: "lease_lost", answer: null, delivery: null });
      return null;
    }
    if (callAbort.signal.aborted) return null;
    if (run) {
      if (!runFinished) run.cancel();
      await run.done;
    }
    if (owner) {
      if (!diagnostic) {
        const value = ownerTurnDiagnostic("exception", error, [relay.credential]);
        recordDiagnostic(value);
        console.error("Owner relay turn failed", JSON.stringify({ requestId, diagnostic: value }));
      }
      failureReply = true;
      stagedAttachments = [];
      if (allowOwnerReply?.()) return await finish({ lease_id: leaseId, outcome: "answered",
        answer: ownerFailureAnswer(request, owner, diagnostic!, [relay.credential])!, duration_ms: Date.now() - deadline.receivedAt });
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
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      callAbort.abort();
      await ownerParts?.dispose();
      await inbound?.dispose();
      for (const file of generatedFiles) { try { await fs.promises.rm(file, {force:true}); } catch { console.error("Relay generated image cleanup failed"); } }
      await ownerTools?.dispose();
      let releasePin = true;
      if (conversation && owner) {
        try {
          const custody = readRunLedger().runs.find(r => r.requestId === requestId)?.ownerTurn;
          releasePin = !(custody?.cancel && !custody.confirmed);
        } catch { releasePin = false; } // Unreadable custody cannot admit a peer turn.
      }
      if (conversation && releasePin) {
        const compacted = conversationEvidence.compacted;
        await releaseConversationAsync(conversation.id, { state: conversationBroken ? "broken" : "idle", sessionId: conversation.sessionId,
          ...(conversationEvidence.sessionId || owner && conversation.conversationId && resultDelivered ? { accountId: conversation.accountId, turns: conversation.turns + 1, turnsSinceCompaction: compacted ? 0 : conversation.turnsSinceCompaction + 1,
            lastTurnAt: new Date().toISOString(), seen: compacted ? [] : turn?.seen ?? [], staticDigest: compacted ? null : turn?.digest ?? null,
            lastPromptTokens: conversationEvidence.promptTokens ?? null, compactions: conversation.compactions + (compacted ? 1 : 0), pendingCursor: undefined } : {}) }, Date.now() + 5000);
      }
      for (const timer of identityTimers) clearTimeout(timer);
      // The only way out without a completion is a lost lease.
      if (recorder && !duplicate && !recorder.finished)
        recorder.finish({ outcome: "lease_lost", answer: null, delivery: null, ...loopRecord() });
      try {
        const held = readRunLedger().runs.find(r => r.requestId === requestId);
        const custodyPending = !!held?.ownerTurn?.cancel && !held.ownerTurn.confirmed;
        if (recorded && !custodyPending && !(completionAccepted && !capacityReleased)) await dropRunAsync(requestId, Date.now() + 5000);
      } catch (error) {
        console.error("External relay run ledger cleanup failed", error instanceof Error ? error.name : "unknown");
      }
      try {
        const held = readRunLedger().runs.find(r => r.requestId === requestId);
        if (runDir && !(held?.ownerTurn?.cancel && !held.ownerTurn.confirmed)) await fs.promises.rm(runDir, { recursive: true, force: true });
      } catch (error) {
        console.error("External relay run directory cleanup failed", error instanceof Error ? error.name : "unknown");
      }
    } finally {
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
