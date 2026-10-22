import type { RegistryFile } from "@/lib/agent/registry";
import { registryKeysMatching, registryKeysMatchingBounded } from "@/lib/agent/sqliteRegistryStore";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";

/** Optional recall never expands an unbounded history to infer human origin.
 * A relay needs evidence across conversations; over budget it stays unproven.
 * Ordinary native turns need only their own conversation's retained rows. */
export const MEMORY_DELIVERY_EVIDENCE_LIMIT = 256;
export function memoryDeliveryEvidence(file: RegistryFile, conversationId: string, relay: boolean) {
  return withViewerOperation("memory.delivery-evidence", () => performanceSpans.sync("memory.delivery-evidence", () => {
    const filters = relay ? [] : [{ field: "conversationId" as const, value: conversationId }];
    const ownerKeys = registryKeysMatchingBounded(file, "deliveryOperationOwners", filters, MEMORY_DELIVERY_EVIDENCE_LIMIT + 1);
    const deliveryKeys = registryKeysMatchingBounded(file, "heldDeliveries", filters, MEMORY_DELIVERY_EVIDENCE_LIMIT + 1);
    if (ownerKeys.length > MEMORY_DELIVERY_EVIDENCE_LIMIT || deliveryKeys.length > MEMORY_DELIVERY_EVIDENCE_LIMIT) return null;
    return { owners: ownerKeys.map(key => file.deliveryOperationOwners[key]!),
      deliveries: deliveryKeys.map(key => file.heldDeliveries[key]!) };
  }));
}

/** The owner key is the operation id. Hash keys before reading command bodies. */
export function memoryDeliveryForToken(file: RegistryFile, conversationId: string, token: string) {
  return withViewerOperation("memory.delivery-evidence", () => performanceSpans.sync("memory.delivery-evidence", () => {
    const key = registryKeysMatching(file, "deliveryOperationOwners", "conversationId", conversationId)
      .find(operationId => deliveryDedupToken(operationId) === token);
    return key ? file.deliveryOperationOwners[key] : undefined;
  }));
}
