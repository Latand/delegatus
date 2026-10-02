import { MIGRATION_DELIVERY_CANCELLATION_PREFIX } from "@/lib/accounts/migration/intentLiveness";
import type { RegistryFile } from "@/lib/agent/registry";

/** Positive recipient evidence for one admitted operation. Absence, unreadable
 * history and a different key prove nothing; this function never writes input. */
export async function confirmedSend(file: RegistryFile, operationId: string): Promise<boolean> {
  const owner = file.deliveryOperationOwners[operationId];
  if (!owner || (owner.command?.kind !== "send" && owner.command?.kind !== "steer")) return false;
  if (owner.terminalReason === "delivery-discarded"
    || owner.terminalReason?.startsWith(MIGRATION_DELIVERY_CANCELLATION_PREFIX)) return false;
  const delivery = file.heldDeliveries[owner.deliveryId];
  const conversation = file.conversations[owner.conversationId];
  // Use the generation the attempt actually targeted, including after reseating.
  const generation = delivery?.generationId
    ? conversation?.generations.find((candidate) => candidate.id === delivery.generationId)
    : conversation?.generations.at(-1);
  if (!conversation || !generation) return false;
  try {
    if (conversation.engine === "codex") {
      if (!delivery) return false;
      const { readCodexConfirmedDelivery } = await import("./codexAppServerHost");
      return Boolean(await readCodexConfirmedDelivery(generation.path, {
        id: operationId, text: delivery.text, contentDigest: owner.contentDigest ?? undefined,
      }));
    }
    if (conversation.engine !== "claude") return false;
    const { FileClaudeDeliveryLedger, readClaudeTranscriptUsers } = await import("./claudeStreamBrokerHost");
    const states = new FileClaudeDeliveryLedger().load(generation.id);
    const target = states.find((state) => state.entry.id === operationId);
    if (!target || target.entry.contentDigest !== owner.contentDigest) return false;
    // A durable echo names the exact operation and payload, even if its runtime
    // transition timed out before that echo arrived.
    if (target.delivered && target.engineMessageId) return true;
    const users = readClaudeTranscriptUsers(generation.path);
    const consumed = new Set(states.filter((state) => state.delivered && state.engineMessageId)
      .map((state) => state.engineMessageId));
    for (const state of states) {
      if (state.delivered) continue;
      const queuedAt = Date.parse(state.queuedAt ?? "");
      if (!Number.isFinite(queuedAt)) continue;
      const user = users.find((candidate) => candidate.uuid && !consumed.has(candidate.uuid)
        && candidate.contentDigest === state.entry.contentDigest
        && Number.isFinite(Date.parse(candidate.timestamp ?? ""))
        && Date.parse(candidate.timestamp!) >= queuedAt);
      if (!user) continue;
      consumed.add(user.uuid);
      if (state.entry.id === operationId) return true;
    }
  } catch {
    // A failed evidence read never becomes a safe resend or a delivered claim.
  }
  return false;
}
