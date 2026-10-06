import path from "node:path";
import { NextRequest } from "next/server";
import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { handleRuntimeRetry } from "@/lib/runtime/http";
import { journalVerdict, resolveOriginalSend, resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { agentRegistry } from "@/lib/agent/registry";
import { runtimeHostClient } from "@/lib/runtime/client";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { PrototypeError, PROTOTYPE_LIMITS } from "./input";
import { findPrototypeRound, mutatePrototypeRound, prototypeRoot } from "./store";
import type { DecidePrototypeInput, PrototypeDecision, PrototypeDeliveryState } from "./types";
import { prototypeWorld, type PrototypeWorld } from "./world";

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
  await withFileTransaction(path.join(prototypeRoot(),`${reviewId}.decision.lock`),"prototype decision is busy",async () => {
    const decision = findPrototypeRound(taskId,reviewId)?.decision;
    if (!decision?.delivery.conversationId || decision.delivery.state === "sent") return;
    const recovered: PrototypeDeliveryResult | null = await delivery.recover(decision).catch(() => ({ state: "uncertain" }));
    if (recovered && (recovered.state !== decision.delivery.state || recovered.operationId !== decision.delivery.operationId)) recordDelivery(taskId,reviewId,recovered);
  });
}
export async function decidePrototype(request: NextRequest,taskId: string,input: DecidePrototypeInput | { reviewId: string; retry: true },
  world: PrototypeWorld = prototypeWorld, delivery: PrototypeDelivery = prototypeDelivery): Promise<void> {
  const reviewId = input.reviewId;
  if (!/^pr_[a-f0-9]{32}$/.test(reviewId)) throw new PrototypeError("invalid review id");
  await withFileTransaction(path.join(prototypeRoot(),`${reviewId}.decision.lock`),"prototype decision is busy",async () => {
    let decision = mutatePrototypeRound(taskId,reviewId,(round,task) => {
      if (!("retry" in input)) {
        if (!Array.isArray(input.chosen) || !input.chosen.length || input.chosen.length > 9 || new Set(input.chosen).size !== input.chosen.length
          || input.chosen.some(n => !round.variants.some(v => v.number === n))) throw new PrototypeError("choose one or more declared variants");
        if (typeof input.comment !== "string" || input.comment.length > PROTOTYPE_LIMITS.comment) throw new PrototypeError("comment exceeds 20000 characters");
        if (round.decision) {
          if (round.decision.comment !== input.comment || JSON.stringify(round.decision.chosen) !== JSON.stringify([...input.chosen].sort((a,b) => a-b))) throw new PrototypeError("this round already has a decision",409);
          return round.decision;
        }
        const chosen = [...input.chosen].sort((a,b) => a-b);
        const recipient = world.orchestrator(task.project);
        const text = `Prototype review decision\nTask: ${task.id} — ${task.text.split("\n")[0]}\nChosen: ${round.variants.filter(v => chosen.includes(v.number)).map(v => `${v.number} — ${v.name}`).join(", ")}\n\nComment:\n${input.comment}\n\nEnd of prototype review decision.`;
        round.decision = { chosen, comment: input.comment, at: new Date().toISOString(), delivery: {
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
