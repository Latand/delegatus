import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { nativeAssociationCurrent } from "@/lib/attention/nativeCallerSources";
import { NATIVE_ASSOCIATION_AUTHORIZATION_ERROR } from "@/lib/attention/nativeAssociationForm";
import { NextRequest } from "next/server";
import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { handleRuntimeRetry } from "@/lib/runtime/http";
import { SEND_DISCARDED_REASON, SEND_LOST_REASON, SEND_UNVERIFIED_REASON, SEND_UNRECORDED_REASON, SEND_UNSETTLEABLE_REASON, journalVerdict, resolveOriginalSend, resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { agentRegistry } from "@/lib/agent/registry";
import { taskFeedSource } from "@/lib/tasks/store";
import { findSeatRound } from "./seatRounds";
import { runtimeHostClient } from "@/lib/runtime/client";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { activeDeliveryActor, telegramOwnerActor, authenticatedOwner, teamActor } from "@/lib/team";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { ownerReviewDestination } from "@/lib/externalRelay/telegramPublication";
import { runsElsewhere } from "@/lib/links/linked";
import { prototypeReviewSummary } from "./model";
import { PrototypeError, PROTOTYPE_LIMITS } from "./input";
import { decisionLock, findPrototypeRound, mutatePrototypeRound, withPrototypeState } from "./store";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import { normalizePrototypeAnswers, recommendedAnswers } from "./questions";
import type { DecidePrototypeInput, PrototypeDecision, PrototypeDeliveryState, PrototypeReviewRound } from "./types";
import { prototypeWorld, type PrototypeWorld } from "./world";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { PROTOTYPE_DELIVERY_MAX_ATTEMPTS, prototypeDeliveryExhausted } from "./deliveryPolicy";
import { prototypeTextLength } from "./textLength";

export type PrototypeDeliveryContext = NextRequest | { kind: "operator-in-process"; telegramUserId?: string; authorize: () => void } | { kind: "autonomous-seat"; conversationId: string; project: string; authorize: () => void };
const inProcess = (request: PrototypeDeliveryContext): request is Extract<PrototypeDeliveryContext, { kind: string }> => "kind" in request && (request.kind === "operator-in-process" || request.kind === "autonomous-seat");

/** The persisted delivery text: retries use these exact bytes. A changed
    decision whose earlier message may already have reached the seat says it
    replaces that one. */
export function prototypeDecisionText(task: { id: string; text: string } | null, round: PrototypeReviewRound,
  decision: Pick<PrototypeDecision, "chosen" | "comment" | "answers" | "skipped" | "rejected" | "recommendedWithReservation">, amends?: { at: string }, actor: "operator" | "seat" = "operator"): string {
  const amendment = amends ? ` (amended)\nThis replaces the decision of ${amends.at} on the same round.` : "";
  const header = task && round.taskId !== null ? `Prototype review decision${amendment}\nTask: ${task.id} — ${task.text.split("\n")[0]}`
    : `${actor === "seat" ? "Seat" : "Operator"} decision${amendment}\nAsked: ${round.title}, ${round.createdAt.slice(11,16)} UTC`;
  const chosen = round.variants.filter(v => decision.chosen.includes(v.number)).map(v => `${v.number} — ${v.name}`).join(", ");
  const rejection = `Rejected: none of the variants fits. Publish a new prototype round${round.taskId === null ? "" : " on this task"} that applies the corrections below; build no variant of this round.`;
  const footer = `\n\n${decision.rejected ? "Corrections" : "Comment"}:\n${decision.comment}\n\nEnd of prototype review decision.`;
  if (!round.questions?.length) return decision.rejected ? `${header}\nRound: ${round.title}\n${rejection}${footer}` : `${header}\nChosen: ${chosen}${footer}`;
  const answers = round.questions.map((q, i) => {
    const answer = decision.answers!.find(a => a.questionId === q.id)!;
    if (answer.skipped) return `${i + 1}. ${q.text}${q.multiple ? " (several allowed)" : ""}\n   Skipped by the ${actor}: already decided or no longer relevant — do not ask again.`;
    const selected = answer.options.map(index => `   ${String.fromCharCode(97 + index)}) ${q.options[index]!.label}${q.options[index]!.recommended ? " (recommended)" : ""}`);
    if (answer.other && !answer.customText) selected.push("   Other: see the comment");
    if (answer.customText) selected.push(`   ${actor === "seat" ? "Seat's" : "Owner's"} custom note:\n${answer.customText}`);
    return `${i + 1}. ${q.text}${q.multiple ? " (several allowed)" : ""}\n${selected.join("\n")}`;
  }).join("\n");
  return `${header}\nRound: ${round.title}\n\nAnswers:${decision.recommendedWithReservation ? " recommended with reservation; resolve the owner's open point below." : decision.skipped ? " skipped, use your recommendations." : ""}\n${answers}${decision.rejected ? `\n\n${rejection}` : round.variants.length ? `\n\nChosen: ${chosen || "none"}` : ""}${footer}`;
}

/** The full owner reply stays on the round even when it exceeds a send envelope. */
function ownerDeliveryText(text: string, round: PrototypeReviewRound): string {
  if (Buffer.byteLength(text) <= MAX_STRUCTURED_TEXT_BYTES) return text;
  const tail = `\n\nOwner text continues. Read read_prototype_review${round.taskId ? ` with ${JSON.stringify({ taskId: round.taskId })}` : " without taskId"} and find round ${round.id} for the complete originalReply and custom answers before acting.`;
  const bytes = Buffer.from(text);
  let end = MAX_STRUCTURED_TEXT_BYTES - Buffer.byteLength(tail);
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + tail;
}

export interface PrototypeDeliveryResult { state: PrototypeDeliveryState; operationId?: string }
/** Seam at the existing send/receipt boundary, never at a text-only fake queue.
    No operator request is at hand when a delivery runs in the background, so
    the send names the person who decided as its trusted actor. */
export interface PrototypeDelivery {
  recover(decision: PrototypeDecision): Promise<PrototypeDeliveryResult | null>;
  send(decision: PrototypeDecision): Promise<PrototypeDeliveryResult>;
  retry(decision: PrototypeDecision): Promise<PrototypeDeliveryResult>;
  /** Fence and verify the old execution before following a replacement seat. */
  retire?(decision: PrototypeDecision): Promise<PrototypeDeliveryResult>;
}
export async function prototypeDeliveryResponse(response: Response): Promise<PrototypeDeliveryResult> {
  const body = await response.json();
  const state = body.receipt?.status === "delivered" || body.outcome === "delivered" ? "sent" : response.ok ? "pending"
    : body.admission === "refused" || body.code === "member_required" ? "failed" : "uncertain";
  return { state, ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}) };
}
/** An in-process request to the Viewer's own routes, from loopback. */
const viewerRequest = (pathname: string, body?: unknown) => new NextRequest(new URL(pathname, "http://localhost"), {
  method: "POST", headers: { host: "localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const journalRequiresVerification = (reason: string | null | undefined) =>
  reason === SEND_DISCARDED_REASON || reason === SEND_UNVERIFIED_REASON || reason === SEND_UNRECORDED_REASON || reason === SEND_UNSETTLEABLE_REASON;
export const prototypeDelivery: PrototypeDelivery = {
  async recover(decision) {
    const delivery = decision.delivery;
    let operationId = delivery.operationId;
    if (!operationId) {
      const original = await resolveOriginalSend({ conversationId: delivery.conversationId!, clientMessageId: delivery.clientMessageId, text: delivery.text, origin: decision.decidedBy?.kind === "agent" ? { kind: "agent", conversationId: decision.decidedBy.conversationId } : { kind: "operator" } });
      if (original.kind === "absent") {
        // The admission ledger also remembers compacted keys. Absence in the
        // active rows alone cannot authorize another send after retention.
        const admission = await withPrototypeState(() => agentRegistry().deliveryAdmissionForKey(delivery.conversationId!,delivery.clientMessageId));
        if (admission.outcome === "not-executed") return null;
        if (admission.outcome !== "admitted") return { state: "uncertain" };
        operationId = admission.operationId;
      } else if (original.kind === "found") operationId = original.operationId;
      else return { state: "uncertain" };
    }
    const receipt = await resolveSendReceipt(operationId);
    if (receipt?.state === "delivered") return { state: "sent",operationId };
    // An explicitly admitted retry has its own owner and outcome. Only that
    // durable link can follow a journal leaf past the original terminal row.
    if (receipt?.state === "failed") {
      if (receipt.reason === SEND_DISCARDED_REASON) return { state: "uncertain", operationId };
      const journal = await runtimeHostClient()?.operationStatus(operationId, { currentRetryLeaf: true }).catch(() => null);
      if (journal && journal.operationId !== operationId) {
        const linked = await withPrototypeState(() => {
          const owner = agentRegistry().deliverySnapshotForOperation(journal.operationId).deliveryOperationOwners[journal.operationId];
          return !!owner?.retryOfOperationId && owner.conversationId === delivery.conversationId && owner.clientMessageId === delivery.clientMessageId;
        });
        if (!linked) return { state: "uncertain", operationId };
        const retry = await resolveSendReceipt(journal.operationId);
        return { state: retry?.state === "delivered" ? "sent" : retry?.state === "in-flight" ? "pending" : retry?.resend === "safe" ? "failed" : "uncertain", operationId: journal.operationId };
      }
      // A terminal journal failure proves non-execution too. An open journal
      // cannot undo the durable reservation's terminal outcome.
      if (journalRequiresVerification(journal?.receipt.reason)) return { state: "uncertain", operationId };
      const verdict = journal && journalVerdict(journal.receipt.status, journal.receipt.reason);
      return { state: receipt.resend === "safe" || verdict?.disposition === "lost" ? "failed" : "uncertain", operationId };
    }
    return { state: receipt?.state === "in-flight" ? "pending" : "uncertain", operationId };
  },
  async retire(decision) {
    const operationId = decision.delivery.operationId!;
    const client = runtimeHostClient();
    if (!client) return { state: "uncertain", operationId };
    let journal = await client.operationStatus(operationId, { currentRetryLeaf: true });
    if (!journal) return { state: "uncertain", operationId };
    if (["pending", "queued"].includes(journal.receipt.status)) {
      try {
        journal = await client.transitionOperation(journal.operationId, "failed", { reason: SEND_LOST_REASON }, { fromStatuses: ["pending", "queued"] });
      } catch {
        journal = await client.operationStatus(operationId, { currentRetryLeaf: true });
      }
    }
    if (journalRequiresVerification(journal?.receipt.reason)) return { state: "uncertain", operationId };
    const verdict = journal && journalVerdict(journal.receipt.status, journal.receipt.reason);
    if (verdict?.state === "delivered") return { state: "sent", operationId: journal!.operationId };
    return { state: verdict?.disposition === "lost" ? "failed" : "uncertain", operationId: journal?.operationId ?? operationId };
  },
  async send(decision) {
    return prototypeDeliveryResponse(await conversationHostPOST(viewerRequest("/api/conversation-host", { conversationId: decision.delivery.conversationId,
      clientMessageId: decision.delivery.clientMessageId, text: decision.delivery.text, policy: "steer-or-queue", images: [] }),
    { actor: decision.decidedBy ?? { kind: "operator" } }));
  },
  async retry(decision) {
    const operationId = decision.delivery.operationId!;
    return prototypeDeliveryResponse(await handleRuntimeRetry(viewerRequest(`/api/runtime/operations/${operationId}`), operationId, undefined, () => {
      if (!prototypeAuthorCurrent(decision)) throw new PrototypeError("decision author is no longer authorized", 403);
    }));
  },
};

function prototypeAuthorCurrent(decision: PrototypeDecision): boolean {
  const actor = decision.decidedBy ?? { kind: "operator" as const };
  if (actor.kind === "agent") return true;
  if (!activeDeliveryActor(actor)) return false;
  if (!decision.telegramUserId) return true;
  const owner = telegramOwnerActor(decision.telegramUserId);
  return owner?.kind === actor.kind && (actor.kind !== "member" || owner.kind === "member" && owner.memberId === actor.memberId);
}

/** Refreshes a saved answer from its receipt; a read never sends or retries. */
export async function refreshPrototypeDelivery(taskId: string | null,reviewId: string,delivery = prototypeDelivery): Promise<void> {
  const held = findPrototypeRound(taskId,reviewId)?.decision;
  if (!held?.delivery.conversationId || held.delivery.state === "sent") return;
  await withFileTransaction(decisionLock(reviewId),"prototype decision is busy",async () => {
    const decision = findPrototypeRound(taskId,reviewId)?.decision;
    if (!decision?.delivery.conversationId || decision.delivery.state === "sent") return;
    if (decision.revision !== undefined && !decision.delivery.dispatchedAt && !decision.delivery.operationId) return;
    const key = decision.delivery.clientMessageId;
    const recovered: PrototypeDeliveryResult = await delivery.recover(decision).then(result => result ?? { state: "failed" as const },() => ({ state: "uncertain" as const }));
    if (recovered.state !== decision.delivery.state || recovered.operationId !== decision.delivery.operationId) {
      mutatePrototypeRound(taskId,reviewId,round => {
        if (round.decision?.delivery.clientMessageId === key) Object.assign(round.decision.delivery,recovered);
      });
    }
  });
}

const messageKey = (reviewId: string, revision: number) => revision === 1 ? `prototype-decision:${reviewId}` : `prototype-decision:${reviewId}:${revision}`;
function decidedBy(request: PrototypeDeliveryContext): NonNullable<PrototypeDecision["decidedBy"]> {
  if (inProcess(request)) {
    if (request.kind === "autonomous-seat") return { kind: "agent", conversationId: request.conversationId };
    if (request.telegramUserId !== undefined) {
      const actor = telegramOwnerActor(request.telegramUserId);
      if (!actor) throw new PrototypeError("verified Telegram owner is no longer an active member", 403);
      return actor;
    }
    return { kind: "operator" };
  }
  const actor = teamActor(request);
  return actor.kind === "member" ? { kind: "member", memberId: actor.memberId } : { kind: "operator" };
}
/**
 * Records the operator's decision and answers at once; the message to the
 * seat goes in the background (`deliveryWorker.ts`). Answers whether a
 * delivery attempt is owed now: a new or changed decision, or a retry. The
 * same decision again changes nothing. A changed decision replaces the earlier
 * one while that one was never handed to the send path, and otherwise goes as
 * an amendment under a key of its own.
 */
export function decidePrototype(request: PrototypeDeliveryContext,taskId: string | null,input: DecidePrototypeInput | { reviewId: string; retry: true },
  world: PrototypeWorld = prototypeWorld): boolean {
  const reviewId = input.reviewId;
  if (!/^pr_[a-f0-9]{32}$/.test(reviewId)) throw new PrototypeError("invalid review id");
  if (inProcess(request)) request.authorize();
  return mutatePrototypeRound(taskId,reviewId,(round,task) => {
    if (inProcess(request)) {
      request.authorize();
      if (request.kind === "autonomous-seat" && (round.nativeAssociation || canonicalOrchestratorProject(task?.project ?? round.project ?? "") !== request.project)) throw new PrototypeError("autonomy cannot decide this form", 403);
      if (task && (runsElsewhere(task) || (!round.decision && prototypeReviewSummary(task.prototypeReviews ?? [])?.waitingReviewId !== round.id))) {
        throw new PrototypeError("prototype round is no longer waiting", 409);
      }
    }
    let nativeAssociationApproval: PrototypeDecision["nativeAssociationApproval"];
    if (round.nativeAssociation) {
      if (inProcess(request)) nativeAssociationApproval = "paired-owner";
      else {
        if (!directOperatorActivityAuthority(request).ok || request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) || !authenticatedOwner(request, ownerReviewDestination().chatId)) {
          throw new PrototypeError(NATIVE_ASSOCIATION_AUTHORIZATION_ERROR, 403);
        }
        nativeAssociationApproval = "owner-session";
      }
    }
    if ("retry" in input) {
      if (!round.decision) throw new PrototypeError("save a decision before retrying");
      if (round.decision.delivery.state === "sent") return false;
      // The operator asked again: the backoff starts over and so does the wait before attention.
      delete round.decision.delivery.failures; delete round.decision.delivery.failingSince;
      delete round.decision.delivery.attempts; delete round.decision.delivery.exhaustedAt;
      round.decision.delivery.startedAt = new Date().toISOString();
      // An authenticated person explicitly adopts this exact saved reply. A
      // legacy operator record alone supplies no member identity for recovery.
      const actor = decidedBy(request);
      if ((!round.decision.decidedBy || round.decision.decidedBy.kind === "operator") && actor.kind === "member") {
        round.decision.decidedBy = actor;
        delete round.decision.telegramUserId;
      }
      return true;
    }
    if (input.reject !== undefined && input.reject !== true) throw new PrototypeError("invalid reject");
    const ownerReply = input.originalReply !== undefined;
    if (ownerReply && (typeof input.originalReply !== "string" || prototypeTextLength(input.originalReply) > PROTOTYPE_LIMITS.comment)) throw new PrototypeError("original reply exceeds 20000 characters");
    if (input.recommendedWithReservation !== undefined && (input.recommendedWithReservation !== true || !ownerReply || input.skip || typeof input.comment !== "string" || !input.comment.trim())) throw new PrototypeError("reservation requires the owner's note and explicit answers");
    if (input.reject && !round.variants.length) throw new PrototypeError("reject: this round has no variants to reject");
    if (input.reject && Array.isArray(input.chosen) && input.chosen.length) throw new PrototypeError("chosen: a rejection chooses no variant");
    if (input.reject && (typeof input.comment !== "string" || !input.comment.trim())) throw new PrototypeError("comment: write or dictate what to redo");
    if (!Array.isArray(input.chosen) || (!input.chosen.length && !round.questions?.length && !input.reject && !ownerReply) || input.chosen.length > 9 || new Set(input.chosen).size !== input.chosen.length
      || input.chosen.some(n => !round.variants.some(v => v.number === n))) throw new PrototypeError("choose one or more declared variants");
    if (typeof input.comment !== "string" || prototypeTextLength(input.comment) > PROTOTYPE_LIMITS.comment) throw new PrototypeError("comment exceeds 20000 characters");
    const questionnaire = Boolean(round.questions?.length);
    if (input.skip !== undefined && input.skip !== true) throw new PrototypeError("invalid skip");
    if (questionnaire ? (input.skip === true ? input.answers !== undefined : input.answers === undefined)
      : input.skip !== undefined || input.answers !== undefined) throw new PrototypeError("provide answers or skip for a questionnaire only");
    let answers: PrototypeDecision["answers"];
    try { if (questionnaire) answers = input.skip ? recommendedAnswers(round.questions!) : normalizePrototypeAnswers(round.questions!, input.answers, input.comment, ownerReply, ownerReply || inProcess(request) && request.kind === "autonomous-seat"); }
    catch (error) { throw new PrototypeError((error as Error).message); }
    const skipped = input.skip ? true : undefined;
    const chosen = [...input.chosen].sort((a,b) => a-b);
    if (round.nativeAssociation && !input.skip && !input.reject && !input.recommendedWithReservation
      && ["identity", "evidence"].every(id => {
        const answer = answers?.find(answer => answer.questionId === id);
        return answer && !answer.skipped && !answer.other && !answer.customText && answer.options.length === 1 && answer.options[0] === 1;
      }) && !nativeAssociationCurrent(round.nativeAssociation)) {
      throw new PrototypeError("This native session changed or ended. Nothing was approved; ask the live session to request a new association.", 409);
    }
    const prior = round.decision;
    /* The same answers from someone else are a decision of their own: a person
       who confirms what an agent chose becomes the one who decided it. */
    if (prior && JSON.stringify(prior.decidedBy ?? { kind: "operator" }) === JSON.stringify(decidedBy(request)) && prior.comment === input.comment && JSON.stringify(prior.chosen) === JSON.stringify(chosen)
      && JSON.stringify(prior.answers) === JSON.stringify(answers) && prior.skipped === skipped && prior.rejected === input.reject
      && prior.originalReply === input.originalReply && prior.recommendedWithReservation === input.recommendedWithReservation
      && prior.nativeAssociationApproval === nativeAssociationApproval) return false;
    if (prior && inProcess(request) && !round.nativeAssociation) throw new PrototypeError("prototype round is already decided", 409);
    /* A record written before revisions existed may have been handed over
       without a mark, unless it never had anyone to go to. */
    const handedOver = prior && (prior.revision === undefined ? prior.delivery.state !== "no-orchestrator" : prior.delivery.dispatchedAt !== undefined);
    const revision = prior ? (prior.revision ?? 1) + 1 : 1;
    const recipient = world.orchestrator(task?.project ?? round.project);
    const autonomous = inProcess(request) && request.kind === "autonomous-seat";
    let completeText = prototypeDecisionText(task, round, { chosen, comment: input.comment, answers, skipped, rejected: input.reject, recommendedWithReservation: input.recommendedWithReservation }, handedOver ? { at: prior.at } : undefined, autonomous ? "seat" : "operator");
    if (autonomous) completeText = `Autonomous seat decision. The operator can amend this form to undo.\n${completeText}`;
    const text = ownerReply ? ownerDeliveryText(completeText, round) : completeText;
    if (questionnaire && Buffer.byteLength(text) > MAX_STRUCTURED_TEXT_BYTES) throw new PrototypeError("the answer is too long to send; shorten the comment");
    round.decision = { chosen, ...(ownerReply ? { originalReply: input.originalReply } : {}), ...(input.recommendedWithReservation ? { recommendedWithReservation: true as const } : {}),
      ...(input.reject ? { rejected: true as const } : {}), ...(answers ? { answers } : {}), ...(skipped ? { skipped } : {}), comment: input.comment, at: new Date().toISOString(),
      decidedBy: decidedBy(request), ...(inProcess(request) && request.kind === "operator-in-process" && request.telegramUserId ? { telegramUserId: request.telegramUserId } : {}), ...(nativeAssociationApproval ? { nativeAssociationApproval } : {}), revision, delivery: {
        state: recipient ? "pending" : "no-orchestrator", conversationId: recipient, clientMessageId: messageKey(reviewId, revision), text } };
    return true;
  });
}

/** A delivery attempt's word on a decision that changed meanwhile is about a
    message nobody owes any more, so it is never written over the new one. */
class SupersededDecision extends Error {}
export interface PrototypeDeliveryPorts { delivery: PrototypeDelivery; world: PrototypeWorld; now: () => number }
/**
 * One attempt to deliver a saved decision, under the round's decision lock so
 * no other attempt, in this process or another, sends at the same time.
 * A message never handed to the send path goes at once, to the project's
 * current seat; one that was is recovered from its receipt, the admission
 * ledger and the journal first, and a failure the journal proves never ran is
 * sent again through the runtime's own retry under the same key. Answers the
 * decision as it now stands, or null when the round or its decision is gone.
 */
export async function attemptPrototypeDelivery(taskId: string | null, reviewId: string, ports: PrototypeDeliveryPorts): Promise<PrototypeDecision | null> {
  const roundAt = () => taskId === null ? findSeatRound(reviewId)
    : taskFeedSource()?.get(taskId)?.prototypeReviews?.find(round => round.id === reviewId);
  const current = () => withPrototypeState(() => roundAt()?.decision ?? null);
  try {
    return await withViewerOperation("prototype.delivery", () => withFileTransaction(decisionLock(reviewId), "prototype decision is busy", async () => {
      const round = await withPrototypeState(roundAt);
      let decision = round?.decision;
      if (!round || !decision || decision.delivery.state === "sent") return decision ?? null;
      const key = decision.delivery.clientMessageId;
      const at = () => new Date(ports.now()).toISOString();
      const update = (change: (held: PrototypeDecision) => void) => withPrototypeState(() => mutatePrototypeRound(taskId, reviewId, held => {
        if (held.decision?.delivery.clientMessageId !== key) throw new SupersededDecision();
        change(held.decision);
        return structuredClone(held.decision);
      }));
      const revalidate = async () => {
        const held = await current();
        if (held?.delivery.clientMessageId !== key) throw new SupersededDecision();
        return held;
      };
      const exhausted = prototypeDeliveryExhausted(decision, ports.now());
      if (exhausted && !decision.delivery.exhaustedAt) {
        decision = await update(held => { held.delivery.exhaustedAt = at(); });
      }
      const handedOver = decision.delivery.dispatchedAt !== undefined || decision.delivery.operationId !== undefined
        || (decision.revision === undefined && decision.delivery.state !== "no-orchestrator");
      if (!decision.delivery.conversationId) {
        const seat = await withPrototypeState(() => ports.world.orchestrator(round.project));
        if (!seat) return decision;
        decision = await update(held => { held.delivery.conversationId = seat; held.delivery.state = "pending"; });
      }
      let recovered = handedOver ? await ports.delivery.recover(decision).catch((): PrototypeDeliveryResult => ({ state: "uncertain" })) : null;
      // Re-read every captured decision and seat after asynchronous evidence.
      decision = await revalidate();
      let seat = await withPrototypeState(() => ports.world.orchestrator(round.project));
      if (recovered?.state === "failed" && recovered.operationId && seat && seat !== decision.delivery.conversationId) {
        decision = await update(held => { held.delivery.operationId = recovered!.operationId; });
        recovered = ports.delivery.retire ? await ports.delivery.retire(decision).catch((): PrototypeDeliveryResult => ({ state: "uncertain" })) : recovered;
        decision = await revalidate();
        seat = await withPrototypeState(() => ports.world.orchestrator(round.project));
        if (recovered.state === "failed" && seat && seat !== decision.delivery.conversationId) {
          decision = await update(held => {
            held.delivery.predecessors = [...held.delivery.predecessors ?? [], { conversationId: held.delivery.conversationId!, operationId: recovered!.operationId! }].slice(-PROTOTYPE_DELIVERY_MAX_ATTEMPTS);
            held.delivery.conversationId = seat;
            delete held.delivery.operationId;
          });
          recovered = null;
        }
      }
      const mayDispatch = () => withPrototypeState(() => prototypeAuthorCurrent(decision!));
      let result: PrototypeDeliveryResult;
      if (recovered === null || recovered.state === "failed" && recovered.operationId) {
        if (exhausted) {
          result = recovered ?? { state: decision.delivery.state };
        } else {
          if (!await mayDispatch()) result = { state: "failed" };
          else {
            decision = await update(held => {
              if (recovered === null && seat) held.delivery.conversationId = seat;
              if (recovered?.operationId) held.delivery.operationId = recovered.operationId;
              held.delivery.state = "pending";
              held.delivery.dispatchedAt ??= at();
              held.delivery.attempts = (held.delivery.attempts ?? 0) + 1;
            });
            // Dispatch authorization is checked again by the real ingress. The
            // retry path also checks the original member immediately before use.
            result = await (recovered === null ? ports.delivery.send(decision) : ports.delivery.retry(decision))
              .catch((): PrototypeDeliveryResult => ({ state: "uncertain" }));
          }
        }
      } else result = recovered;
      const failed = recovered?.state === "failed" || result.state === "failed" || result.state === "uncertain";
      return update(held => {
        held.delivery.state = result.state;
        if (result.operationId) held.delivery.operationId = result.operationId;
        if (result.state === "sent") {
          delete held.delivery.failures; delete held.delivery.failingSince; delete held.delivery.exhaustedAt;
        } else if (failed) {
          held.delivery.failures = (held.delivery.failures ?? 0) + 1;
          held.delivery.failingSince ??= at();
        }
        if (prototypeDeliveryExhausted(held, ports.now())) held.delivery.exhaustedAt ??= at();
      });
    }));
  } catch (error) {
    if (error instanceof SupersededDecision) return current();
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}
