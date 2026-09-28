import { orchestratorRevocations, orchestratorSeatFor, revokedOrchestratorSeatConversationsOrUnknown } from "./seats";

/** Only a conversation that still has a standing seat revocation is fenced. */
export function revokedSeatPipelineRefusal(
  conversationId: string | null,
  resolveAlias: (id: string) => string = (id) => id,
): string | null {
  if (!conversationId) return null;
  const canonicalId = resolveAlias(conversationId);
  if (!revokedOrchestratorSeatConversationsOrUnknown(resolveAlias)?.has(canonicalId)) return null;
  const revocation = orchestratorRevocations()
    .filter((entry) => resolveAlias(entry.conversationId) === canonicalId)
    .sort((left, right) => right.seatEpoch - left.seatEpoch)[0];
  const successor = revocation && (orchestratorSeatFor(revocation.project).active?.conversationId ?? revocation.successorConversationId);
  return `orchestrator seat ${conversationId} is revoked; current successor: ${successor ?? "unavailable"}`;
}
