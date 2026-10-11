import { NextRequest } from "next/server";
import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { handleRuntimeRetry } from "@/lib/runtime/http";
import { journalVerdict, resolveOriginalSend, resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { agentRegistry } from "@/lib/agent/registry";
import { runtimeHostClient } from "@/lib/runtime/client";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { teamActor } from "@/lib/team";
import { PrototypeError, PROTOTYPE_LIMITS } from "./input";
import { decisionLock, findPrototypeRound, mutatePrototypeRound } from "./store";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import { normalizePrototypeAnswers, recommendedAnswers } from "./questions";
import type { DecidePrototypeInput, PrototypeDecision, PrototypeDeliveryState, PrototypeReviewRound } from "./types";
import { prototypeWorld, type PrototypeWorld } from "./world";

/** The persisted delivery text: retries use these exact bytes. A changed
    decision whose earlier message may already have reached the seat says it
    replaces that one. */
export function prototypeDecisionText(task: { id: string; text: string }, round: PrototypeReviewRound,
  decision: Pick<PrototypeDecision, "chosen" | "comment" | "answers" | "skipped">, amends?: { at: string }): string {
  const header = `Prototype review decision${amends ? ` (amended)\nThis replaces the decision of ${amends.at} on the same round.` : ""}\nTask: ${task.id} — ${task.text.split("\n")[0]}`;
  const chosen = round.variants.filter(v => decision.chosen.includes(v.number)).map(v => `${v.number} — ${v.name}`).join(", ");
  const footer = `\n\nComment:\n${decision.comment}\n\nEnd of prototype review decision.`;
  if (!round.questions?.length) return `${header}\nChosen: ${chosen}${footer}`;
  const answers = round.questions.map((q, i) => {
    const answer = decision.answers!.find(a => a.questionId === q.id)!;
    const selected = answer.options.map(index => `   ${String.fromCharCode(97 + index)}) ${q.options[index]!.label}${q.options[index]!.recommended ? " (recommended)" : ""}`);
    if (answer.other) selected.push("   Other: see the comment");
    return `${i + 1}. ${q.text}${q.multiple ? " (several allowed)" : ""}\n${selected.join("\n")}`;
  }).join("\n");
  return `${header}\nRound: ${round.title}\n\nAnswers:${decision.skipped ? " skipped, use your recommendations." : ""}\n${answers}${round.variants.length ? `\n\nChosen: ${chosen || "none"}` : ""}${footer}`;
}

export interface PrototypeDeliveryResult { state: PrototypeDeliveryState; operationId?: string }
/** Seam at the existing send/receipt boundary, never at a text-only fake queue.
    No operator request is at hand when a delivery runs in the background, so
    the send names the person who decided as its trusted actor. */
export interface PrototypeDelivery {
  recover(decision: PrototypeDecision): Promise<PrototypeDeliveryResult | null>;
  send(decision: PrototypeDecision): Promise<PrototypeDeliveryResult>;
  retry(decision: PrototypeDecision): Promise<PrototypeDeliveryResult>;
}
export async function prototypeDeliveryResponse(response: Response): Promise<PrototypeDeliveryResult> {
  const body = await response.json();
  const state = body.receipt?.status === "delivered" || body.outcome === "delivered" ? "sent" : response.ok ? "pending"
    : body.admission === "refused" ? "failed" : "uncertain";
  return { state, ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}) };
}
/** An in-process request to the Viewer's own routes, from loopback. */
const viewerRequest = (pathname: string, body?: unknown) => new NextRequest(new URL(pathname, "http://localhost"), {
  method: "POST", headers: { host: "localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export const prototypeDelivery: PrototypeDelivery = {
  async recover(decision) {
    const delivery = decision.delivery;
    let operationId = delivery.operationId;
    if (!operationId) {
      const original = await resolveOriginalSend({ conversationId: delivery.conversationId!, clientMessageId: delivery.clientMessageId, text: delivery.text, origin: { kind: "operator" } });
      if (original.kind === "absent") {
        // The admission ledger also remembers compacted keys. Absence in the
        // active rows alone cannot authorize another send after retention.
        const admission = agentRegistry().deliveryAdmissionForKey(delivery.conversationId!,delivery.clientMessageId);
        if (admission.outcome === "not-executed") return null;
        if (admission.outcome !== "admitted") return { state: "uncertain" };
        operationId = admission.operationId;
      } else if (original.kind === "found") operationId = original.operationId;
      else return { state: "uncertain" };
    }
    const receipt = await resolveSendReceipt(operationId);
    if (receipt?.state === "delivered") return { state: "sent",operationId };
    // A failed reservation can still have unknown disposition. The journal's
    // terminal failure proves it never actuated; the existing retry route
    // owns recovery and the single retry leaf.
    const journal = await runtimeHostClient()?.operationStatus(operationId,{ currentRetryLeaf: true }).catch(() => null);
    if (journal) {
      const verdict = journalVerdict(journal.receipt.status,journal.receipt.reason);
      if (verdict) return { state: verdict.state === "delivered" ? "sent" : verdict.disposition === "lost" ? "failed" : "uncertain",operationId: journal.operationId };
      return { state: "pending",operationId: journal.operationId };
    }
    return { state: receipt?.state === "in-flight" ? "pending" : receipt && !receipt.duplicateRisk ? "failed" : "uncertain",operationId };
  },
  async send(decision) {
    return prototypeDeliveryResponse(await conversationHostPOST(viewerRequest("/api/conversation-host", { conversationId: decision.delivery.conversationId,
      clientMessageId: decision.delivery.clientMessageId, text: decision.delivery.text, policy: "steer-or-queue", images: [] }),
    { actor: decision.decidedBy ?? { kind: "operator" } }));
  },
  async retry(decision) {
    const operationId = decision.delivery.operationId!;
    return prototypeDeliveryResponse(await handleRuntimeRetry(viewerRequest(`/api/runtime/operations/${operationId}`),operationId));
  },
};

const messageKey = (reviewId: string, revision: number) => revision === 1 ? `prototype-decision:${reviewId}` : `prototype-decision:${reviewId}:${revision}`;
function decidedBy(request: NextRequest): NonNullable<PrototypeDecision["decidedBy"]> {
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
export function decidePrototype(request: NextRequest,taskId: string,input: DecidePrototypeInput | { reviewId: string; retry: true },
  world: PrototypeWorld = prototypeWorld): boolean {
  const reviewId = input.reviewId;
  if (!/^pr_[a-f0-9]{32}$/.test(reviewId)) throw new PrototypeError("invalid review id");
  return mutatePrototypeRound(taskId,reviewId,(round,task) => {
    if ("retry" in input) {
      if (!round.decision) throw new PrototypeError("save a decision before retrying");
      // The operator asked again: the backoff starts over and so does the wait before attention.
      delete round.decision.delivery.failures; delete round.decision.delivery.failingSince;
      return round.decision.delivery.state !== "sent";
    }
    if (!Array.isArray(input.chosen) || (!input.chosen.length && !round.questions?.length) || input.chosen.length > 9 || new Set(input.chosen).size !== input.chosen.length
      || input.chosen.some(n => !round.variants.some(v => v.number === n))) throw new PrototypeError("choose one or more declared variants");
    if (typeof input.comment !== "string" || input.comment.length > PROTOTYPE_LIMITS.comment) throw new PrototypeError("comment exceeds 20000 characters");
    const questionnaire = Boolean(round.questions?.length);
    if (input.skip !== undefined && input.skip !== true) throw new PrototypeError("invalid skip");
    if (questionnaire ? (input.skip === true ? input.answers !== undefined : input.answers === undefined)
      : input.skip !== undefined || input.answers !== undefined) throw new PrototypeError("provide answers or skip for a questionnaire only");
    let answers: PrototypeDecision["answers"];
    try { if (questionnaire) answers = input.skip ? recommendedAnswers(round.questions!) : normalizePrototypeAnswers(round.questions!, input.answers, input.comment); }
    catch (error) { throw new PrototypeError((error as Error).message); }
    const skipped = input.skip ? true : undefined;
    const chosen = [...input.chosen].sort((a,b) => a-b);
    const prior = round.decision;
    if (prior && prior.comment === input.comment && JSON.stringify(prior.chosen) === JSON.stringify(chosen)
      && JSON.stringify(prior.answers) === JSON.stringify(answers) && prior.skipped === skipped) return false;
    /* A record written before revisions existed may have been handed over
       without a mark, unless it never had anyone to go to. */
    const handedOver = prior && (prior.revision === undefined ? prior.delivery.state !== "no-orchestrator" : prior.delivery.dispatchedAt !== undefined);
    const revision = prior ? (prior.revision ?? 1) + 1 : 1;
    const recipient = world.orchestrator(task.project);
    const text = prototypeDecisionText(task, round, { chosen, comment: input.comment, answers, skipped }, handedOver ? { at: prior.at } : undefined);
    if (questionnaire && Buffer.byteLength(text) > MAX_STRUCTURED_TEXT_BYTES) throw new PrototypeError("the answer is too long to send; shorten the comment");
    round.decision = { chosen, ...(answers ? { answers } : {}), ...(skipped ? { skipped } : {}), comment: input.comment, at: new Date().toISOString(),
      decidedBy: decidedBy(request), revision, delivery: {
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
export async function attemptPrototypeDelivery(taskId: string,reviewId: string,ports: PrototypeDeliveryPorts): Promise<PrototypeDecision | null> {
  const current = () => findPrototypeRound(taskId,reviewId)?.decision ?? null;
  try {
    return await withFileTransaction(decisionLock(reviewId),"prototype decision is busy",async () => {
      const round = findPrototypeRound(taskId,reviewId);
      let decision = round?.decision;
      if (!round || !decision || decision.delivery.state === "sent") return decision ?? null;
      const key = decision.delivery.clientMessageId;
      const at = () => new Date(ports.now()).toISOString();
      const update = (change: (held: PrototypeDecision) => void) => mutatePrototypeRound(taskId,reviewId,held => {
        if (held.decision?.delivery.clientMessageId !== key) throw new SupersededDecision();
        change(held.decision);
        return structuredClone(held.decision);
      });
      /* Only a message handed to the send path can have been admitted. A
         record written before the mark existed may have been, unless it never
         had anyone to go to. */
      const handedOver = decision.delivery.dispatchedAt !== undefined || decision.delivery.operationId !== undefined
        || (decision.revision === undefined && decision.delivery.state !== "no-orchestrator");
      const seat = ports.world.orchestrator(round.project);
      if (!decision.delivery.conversationId) {
        if (!seat) return decision;
        decision = update(held => { held.delivery.conversationId = seat; held.delivery.state = "pending"; });
      }
      const recovered = handedOver ? await ports.delivery.recover(decision).catch((): PrototypeDeliveryResult => ({ state: "uncertain" })) : null;
      let result: PrototypeDeliveryResult;
      if (recovered === null) {
        /* Nothing was admitted under this key, so the message goes now, to
           whoever holds the project's seat now: the seat named at decision
           time may have rotated during a deploy. */
        decision = update(held => {
          if (seat) held.delivery.conversationId = seat;
          held.delivery.state = "pending";
          held.delivery.dispatchedAt ??= at();
        });
        result = await ports.delivery.send(decision).catch((): PrototypeDeliveryResult => ({ state: "uncertain" }));
      } else if (recovered.state === "failed" && recovered.operationId) {
        const operationId = recovered.operationId;
        decision = update(held => { held.delivery.operationId = operationId; });
        result = await ports.delivery.retry(decision).catch((): PrototypeDeliveryResult => ({ state: "uncertain" }));
      } else result = recovered;
      /* An earlier attempt the journal shows failed is a failure even when the
         runtime admits its retry: the history of failures ends only when the
         message lands (or the operator asks again), so repeated admitted
         attempts that each fail back off and reach attention. */
      const failed = recovered?.state === "failed" || result.state === "failed" || result.state === "uncertain";
      return update(held => {
        held.delivery.state = result.state;
        if (result.operationId) held.delivery.operationId = result.operationId;
        if (result.state === "sent") { delete held.delivery.failures; delete held.delivery.failingSince; }
        else if (failed) {
          held.delivery.failures = (held.delivery.failures ?? 0) + 1;
          held.delivery.failingSince ??= at();
        }
      });
    });
  } catch (error) {
    if (error instanceof SupersededDecision) return current();
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}
