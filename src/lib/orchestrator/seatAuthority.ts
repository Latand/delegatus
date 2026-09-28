import { orchestratorRevocations, orchestratorSeatFor, revokedOrchestratorSeatConversationsOrUnknown } from "./seats";

/** The revocation record could not be read before pipeline admission. */
export class SeatRevocationStoreUnavailableError extends Error {
  constructor() {
    super("orchestrator seat revocations are unavailable; retry the same request after the store recovers");
    this.name = "SeatRevocationStoreUnavailableError";
  }
}

/** Only a conversation that still has a standing seat revocation is fenced. */
export function revokedSeatPipelineRefusal(
  conversationId: string | null,
  resolveAlias: (id: string) => string = (id) => id,
): string | null {
  if (!conversationId) return null;
  const canonicalId = resolveAlias(conversationId);
  const revoked = revokedOrchestratorSeatConversationsOrUnknown(resolveAlias);
  if (revoked === null) throw new SeatRevocationStoreUnavailableError();
  if (!revoked.has(canonicalId)) return null;
  const revocation = orchestratorRevocations()
    .filter((entry) => resolveAlias(entry.conversationId) === canonicalId)
    .sort((left, right) => right.seatEpoch - left.seatEpoch)[0];
  const successor = revocation && (orchestratorSeatFor(revocation.project).active?.conversationId ?? revocation.successorConversationId);
  return `orchestrator seat ${conversationId} is revoked; current successor: ${successor ?? "unavailable"}`;
}
