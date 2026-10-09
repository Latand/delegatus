import { agentRegistry } from "@/lib/agent/registry";
import { deliverConversationMessage } from "@/lib/delivery";
import { resolveOrchestratorRelay } from "@/lib/orchestrator/relay";
import { relayMessageText } from "@/lib/orchestrator/relayText";
import { sendReceiptFor } from "@/lib/runtime/sendSettlement";
import { enqueueStructuredMessage, type StructuredMessageRequest, type StructuredMessageResult } from "@/lib/runtime/structuredMessageDelivery";

/** A peer's legal presentation labels can exceed the durable origin grammar.
 * Freeze one marker-safe author for both the prelude and recovery binding. */
export function linkedSeatMessageAuthor(author: string): string {
  return author.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ")
    .replace(/^[/\\]+/, "").trim().slice(0, 120).trim() || "Shared project on linked machine";
}

type Enqueue = (request: StructuredMessageRequest) => Promise<StructuredMessageResult | null>;
let enqueue: Enqueue = enqueueStructuredMessage;
/** Harness replaces the runtime transport, retaining real registry admission. */
export function setLinkedSeatEnqueueForTests(value: Enqueue | null): void { enqueue = value ?? enqueueStructuredMessage; }

/** Called only after the peer token and shared-project intersection admit the
 * wire row. Authorship is frozen by the receiving install, never by headers. */
export async function deliverLinkedSeatMessage(project: string, text: string, sourceProject: string, clientMessageId: string): Promise<{
  st: "accepted" | "refused" | "retry"; code?: string; operationId?: string;
}> {
  const author = linkedSeatMessageAuthor(sourceProject);
  const payload = { text: relayMessageText(text, author), origin: { kind: "agent" as const, role: "orchestrator", project: author } };
  const admitted = resolveOrchestratorRelay(project, undefined, payload, text, clientMessageId);
  if (!admitted.ok) return { st: admitted.status >= 500 ? "retry" : "refused", code: admitted.code };
  if (admitted.terminalReceipt?.state === "failed") return { st: "refused", code: admitted.terminalReceipt.duplicateRisk ? "delivery_unverified" : "delivery_failed", operationId: admitted.operationId };
  // An earlier reservation already owns these words, including after rotation.
  if (admitted.operationId) return { st: "accepted", operationId: admitted.operationId };
  const conversation = agentRegistry().readOnlySnapshot().conversations[admitted.recipient];
  const path = conversation?.generations.at(-1)?.path ?? "";
  const request = { conversationId: admitted.recipient, path, text: admitted.text, origin: admitted.origin,
    clientMessageId, policy: "steer-or-queue" as const, images: [] };
  const structured = await enqueue(request);
  if (structured) {
    if (structured.ok) return { st: "accepted", operationId: structured.operationId };
    if (structured.operationId) {
      const receipt = sendReceiptFor(agentRegistry().readOnlySnapshot(), structured.operationId);
      if (receipt?.state === "failed") return { st: "refused", code: receipt.duplicateRisk ? "delivery_unverified" : "delivery_failed", operationId: structured.operationId };
      if (receipt) return { st: "accepted", operationId: structured.operationId };
      return { st: "retry" };
    }
    return { st: structured.status >= 500 ? "retry" : "refused", code: structured.code ?? "delivery_refused" };
  }
  const legacy = await deliverConversationMessage({ ...request, pid: null });
  if (legacy.ok) return { st: "accepted", operationId: legacy.operationId ?? undefined };
  return { st: "retry" };
}
