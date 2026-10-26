import type { AgentRegistry, SpawnReceipt } from "./registry";
import { sessionKeyId } from "./sessionKey";

export async function recordActualSpawnAccountOffLoop(
  registry: AgentRegistry,
  receipt: SpawnReceipt,
  actualAccountId: string,
  agentPath: string | null,
): Promise<void> {
  if (!agentPath || receipt.accountId === actualAccountId) return;
  const observed = registry.spawnRecoverySnapshot([receipt.launchId]);
  const prior = observed.receipts[receipt.launchId];
  const priorEntry = prior?.key ? observed.entries[sessionKeyId(prior.key)] : null;
  const custody = (entry: typeof priorEntry) => JSON.stringify([entry?.claimEpoch, entry?.claimOwner,
    entry?.structuredHostOperationId, entry?.structuredHost?.writerClaimEpoch, entry?.structuredHost?.process]);
  const expectedCustody = custody(priorEntry);
  await registry.deliveryWriteBatchOrBusy({ label: "registry.spawn-actual-account", operationId: receipt.launchId }, () => {
    const snapshot = registry.spawnRecoverySnapshot([receipt.launchId]);
    const materialized = snapshot.receipts[receipt.launchId];
    if (!materialized?.key || materialized.artifactPath !== agentPath) return;
    const entry = snapshot.entries[sessionKeyId(materialized.key)];
    const conversation = registry.conversation(materialized.conversationId);
    if (!entry || !conversation || conversation.generations.at(-1)?.path !== agentPath
      || (typeof entry.structuredHostOperationId === "string" && entry.structuredHostOperationId !== receipt.launchId)
      || materialized.conversationId !== prior?.conversationId || custody(entry) !== expectedCustody) return;
    registry.reconcileConversations([{
      engine: materialized.engine,
      path: agentPath,
      accountId: actualAccountId,
      launchProfile: materialized.launchProfile,
      turn: {
        state: conversation.turn.state,
        source: conversation.turn.source,
        terminalAt: conversation.turn.terminalAt,
      },
      expectedTurnObservedAt: conversation.turn.observedAt,
      observedAt: new Date().toISOString(),
    }]);
    registry.upsert({ ...entry, accountId: actualAccountId });
  });
}
