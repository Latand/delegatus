import { NextRequest } from "next/server";
import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { handleRuntimeRetry } from "@/lib/runtime/http";
import { journalVerdict, resolveOriginalSend, resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { agentRegistry } from "@/lib/agent/registry";
import { runtimeHostClient } from "@/lib/runtime/client";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { PrototypeError, PROTOTYPE_LIMITS } from "./input";
import { decisionLock, findPrototypeRound, mutatePrototypeRound } from "./store";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import { normalizePrototypeAnswers, recommendedAnswers } from "./questions";
import type { DecidePrototypeInput, PrototypeDecision, PrototypeDeliveryState, PrototypeReviewRound } from "./types";
import { prototypeWorld, type PrototypeWorld } from "./world";

/** The persisted delivery text: retries use these exact bytes. */
export function prototypeDecisionText(task: { id: string; text: string }, round: PrototypeReviewRound,
  decision: Pick<PrototypeDecision, "chosen" | "comment" | "answers" | "skipped">): string {
  const header = `Prototype review decision\nTask: ${task.id} — ${task.text.split("\n")[0]}`;
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
/** Seam at the existing send/receipt boundary, never at a text-only fake queue. */
export interface PrototypeDelivery {
  recover(decision: PrototypeDecision): Promise<PrototypeDeliveryResult | null>;
  send(request: NextRequest, decision: PrototypeDecision): Promise<PrototypeDeliveryResult>;
  retry(request: NextRequest, decision: PrototypeDecision): Promise<PrototypeDeliveryResult>;
}
export async function prototypeDeliveryResponse(response: Response): Promise<PrototypeDeliveryResult> {
  const body = await response.json();
  const state = body.receipt?.status === "delivered" || body.outcome === "delivered" ? "sent" : response.ok ? "pending"
    : body.admission === "refused" ? "failed" : "uncertain";
  return { state, ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}) };
}
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
  async send(request,decision) {
    return prototypeDeliveryResponse(await conversationHostPOST(new NextRequest(new URL("/api/conversation-host",request.url), {
      method: "POST", headers: request.headers, body: JSON.stringify({ conversationId: decision.delivery.conversationId,
        clientMessageId: decision.delivery.clientMessageId, text: decision.delivery.text, policy: "steer-or-queue", images: [] }),
    })));
  },
  async retry(request,decision) {
    return prototypeDeliveryResponse(await handleRuntimeRetry(new NextRequest(new URL(`/api/runtime/operations/${decision.delivery.operationId}`,request.url), {
      method: "POST", headers: request.headers,
    }),decision.delivery.operationId!));
  },
};
function recordDelivery(taskId: string,reviewId: string,result: PrototypeDeliveryResult) {
  return mutatePrototypeRound(taskId,reviewId,round => { Object.assign(round.decision!.delivery,result); return round.decision!; });
}
export async function refreshPrototypeDelivery(taskId: string,reviewId: string,delivery = prototypeDelivery): Promise<void> {
  const held = findPrototypeRound(taskId,reviewId)?.decision;
  if (!held?.delivery.conversationId || held.delivery.state === "sent") return;
  await withFileTransaction(decisionLock(reviewId),"prototype decision is busy",async () => {
    const decision = findPrototypeRound(taskId,reviewId)?.decision;
    if (!decision?.delivery.conversationId || decision.delivery.state === "sent") return;
    /* Under the decision's lock no send is in flight here. A message the send
       path never admitted was stopped between the saved decision and its
       admission: it is not on its way, and saying so is what offers the retry.
       The read itself sends nothing. */
    const recovered: PrototypeDeliveryResult = await delivery.recover(decision).then(result => result ?? { state: "failed" as const },() => ({ state: "uncertain" as const }));
    if (recovered.state !== decision.delivery.state || recovered.operationId !== decision.delivery.operationId) recordDelivery(taskId,reviewId,recovered);
  });
}
export async function decidePrototype(request: NextRequest,taskId: string,input: DecidePrototypeInput | { reviewId: string; retry: true },
  world: PrototypeWorld = prototypeWorld, delivery: PrototypeDelivery = prototypeDelivery): Promise<void> {
  const reviewId = input.reviewId;
  if (!/^pr_[a-f0-9]{32}$/.test(reviewId)) throw new PrototypeError("invalid review id");
  await withFileTransaction(decisionLock(reviewId),"prototype decision is busy",async () => {
    let decision = mutatePrototypeRound(taskId,reviewId,(round,task) => {
      if (!("retry" in input)) {
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
        if (round.decision) {
          if (round.decision.comment !== input.comment || JSON.stringify(round.decision.chosen) !== JSON.stringify([...input.chosen].sort((a,b) => a-b))
            || JSON.stringify(round.decision.answers) !== JSON.stringify(answers) || round.decision.skipped !== skipped) throw new PrototypeError("this round already has a decision",409);
          return round.decision;
        }
        const chosen = [...input.chosen].sort((a,b) => a-b);
        const recipient = world.orchestrator(task.project);
        const text = prototypeDecisionText(task, round, { chosen, comment: input.comment, answers, skipped });
        if (questionnaire && Buffer.byteLength(text) > MAX_STRUCTURED_TEXT_BYTES) throw new PrototypeError("the answer is too long to send; shorten the comment");
        round.decision = { chosen, ...(answers ? { answers } : {}), ...(skipped ? { skipped } : {}), comment: input.comment, at: new Date().toISOString(), delivery: {
          state: recipient ? "pending" : "no-orchestrator", conversationId: recipient, clientMessageId: `prototype-decision:${reviewId}`, text } };
      }
      if (!round.decision) throw new PrototypeError("save a decision before retrying");
      return round.decision;
    });
    if (decision.delivery.state === "sent") return;
    if (!decision.delivery.conversationId) {
      if (!("retry" in input)) return;
      const recipient = world.orchestrator(findPrototypeRound(taskId,reviewId)!.project);
      if (!recipient) return;
      decision = mutatePrototypeRound(taskId,reviewId,round => {
        round.decision!.delivery.conversationId = recipient; round.decision!.delivery.state = "pending"; return round.decision!;
      });
    }
    try {
      const recovered = await delivery.recover(decision);
      if (recovered) {
        recordDelivery(taskId,reviewId,recovered);
        if (!("retry" in input) || recovered.state !== "failed" || !recovered.operationId) return;
        decision.delivery.operationId = recovered.operationId;
        recordDelivery(taskId,reviewId,await delivery.retry(request,decision));
        return;
      }
      recordDelivery(taskId,reviewId,await delivery.send(request,decision));
    } catch { recordDelivery(taskId,reviewId,{ state: "uncertain" }); }
  });
}
