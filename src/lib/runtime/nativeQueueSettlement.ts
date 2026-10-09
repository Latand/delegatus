import type { AgentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import type { DeliveryProgressSink } from "./deliveryProgress";
import type { NativeQueueRecord } from "./nativeQueueContracts";

/**
 * Settles the send behind a native queue entry once Codex proved it delivered
 * or the entry was removed (docs/design/delivery-progress-and-drain.md, C3,
 * A8): the reservation of an ordinary queue send the journal converted, or
 * the direct-admission row of a Queue-for-Codex hand-off. The write waits for
 * the registry lock off the loop; one the lock refused leaves the send open,
 * and the settlement sweep ends it from the journal, which already holds the
 * entry's ending.
 */
export async function settleNativeQueueEntry(
  registry: AgentRegistry,
  entry: Pick<NativeQueueRecord, "conversationId" | "entryId" | "state">,
  progress: Pick<DeliveryProgressSink, "settle"> | null = null,
): Promise<boolean> {
  const removed = entry.state === "removed";
  const state = removed ? "failed" : "delivered";
  const reason = removed ? "delivery-discarded" : null;
  const owner = registry.deliverySnapshotForOperation(entry.entryId).deliveryOperationOwners[entry.entryId];
  const correlation = { label: "delivery.native-settle", operationId: entry.entryId };
  const written = owner?.directAdmission
    ? await registry.deliveryWrite(correlation, () => registry.settleDirectAdmission(entry.entryId, state, reason, removed ? undefined : "delivered"))
    : await registry.deliveryWrite(correlation, () => registry.recordDeliveryOutcomeForOperation(
      entry.conversationId as ViewerConversationId, entry.entryId, state, reason));
  if (!written.acquired) return false;
  try { progress?.settle(entry.entryId, state, reason); }
  catch { /* A progress record never fails a settlement. */ }
  return true;
}
