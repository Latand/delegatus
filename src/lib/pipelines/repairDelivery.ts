import type { AgentRegistry } from "@/lib/agent/registry";
import { resolveSendReceipt, type SendSettlementPorts } from "@/lib/runtime/sendSettlement";
import type { PipelineRepairDelivery } from "./types";

/** Read and settle only this repair's durable send. Expiry may withdraw a
 * held reservation; the registry rechecks its identity and state under its
 * asynchronous writer admission before fencing it. Claimed work stays uncertain. */
export async function stageRepairDelivery(
  registry: AgentRegistry, conversationId: string, clientMessageId: string, deadline: number,
  ports: Omit<SendSettlementPorts, "registry"> = {},
): Promise<PipelineRepairDelivery> {
  const admission = registry.deliveryAdmissionForKey(conversationId, clientMessageId);
  if (admission.outcome !== "admitted") return { operationId: null,
    state: admission.outcome === "not-executed" ? "unreserved" : "unavailable",
    safeToReplace: admission.outcome === "not-executed" };
  if ((ports.now?.() ?? Date.now()) >= deadline && admission.state === "held") {
    await registry.deliveryWriteOrBusy({ label: "pipeline.repair-delivery-expiry", operationId: admission.operationId }, () =>
      registry.withdrawHeldDelivery(admission.deliveryId, admission.operationId, "pipeline repair delivery did not start before its deadline"));
  }
  const receipt = await resolveSendReceipt(admission.operationId, { ...ports, registry, absoluteDeadline: deadline });
  return { operationId: admission.operationId, state: receipt?.state ?? "unavailable",
    safeToReplace: receipt?.state === "failed" && receipt.duplicateRisk === false };
}
