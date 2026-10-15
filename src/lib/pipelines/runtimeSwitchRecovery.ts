import type { AgentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { structuredRecoveryPending } from "@/lib/runtime/structuredRecovery";
import { switchOperationKey } from "./runtimeSwitchFence";
import type { PipelineRuntimeSwitch } from "./types";

/** Retry has already withdrawn execution authority in the pipeline store.
 * Withdraw unclaimed reconfigures transactionally; an applying executor must
 * observe that fence and finish its own cleanup before host teardown starts. */
export async function retireRuntimeSwitchProducers(record: PipelineRuntimeSwitch, registry: AgentRegistry): Promise<string | null> {
  if (!record.retry) throw new Error("runtime switch retry must be persisted before retirement");
  const id = record.from.conversationId as ViewerConversationId;
  if (structuredRecoveryPending(id)) return "old conversation host recovery is still settling";
  const conversation = registry.conversation(id);
  if (conversation) {
    const key = switchOperationKey(record, "reconfigure");
    const result = await registry.deliveryWrite({ label: "delivery.reconfigure", operationId: key },
      () => registry.withdrawConversationReconfigure(id, key));
    if (!result.acquired) return "old reconfigure withdrawal awaits the registry writer";
    if (result.value.kind === "claimed") {
      const current = result.value.conversation;
      if (current.migration && registry.reconfigureOwnedCancellableSwitch(id)) {
        const cancelled = await registry.deliveryWrite({ label: "delivery.reconfigure", operationId: key },
          () => registry.cancelConversationSwitch(id, current.migration!.revision));
        if (!cancelled.acquired) return "old migration cancellation awaits the registry writer";
      } else return "old reconfigure executor is still settling";
    }
    const migration = registry.conversation(id)?.migration;
    if (migration && !["committed", "rolled-back", "failed-recoverable", "failed-terminal"].includes(migration.phase)) {
      return `old migration is still ${migration.phase}`;
    }
  }
  const snapshot = registry.readOnlySnapshot();
  const cleanup = Object.values(snapshot.pendingSuccessorCleanups).find(item => item.conversationId === id);
  if (cleanup) return `old migration successor cleanup is pending${cleanup.lastError ? `: ${cleanup.lastError}` : ""}`;
  if (record.launch?.conversationId && structuredRecoveryPending(record.launch.conversationId)) return "old successor recovery is still settling";
  const pending = Object.values(snapshot.receipts).find(receipt =>
    [id, record.launch?.conversationId].includes(receipt.conversationId)
    && receipt.purpose === "resume-successor" && !["completed", "failed", "conflicted"].includes(receipt.state));
  if (pending) return `old host recovery reservation is still ${pending.state}`;
  return null;
}
