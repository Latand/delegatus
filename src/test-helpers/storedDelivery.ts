import type { AgentRegistry } from "@/lib/agent/registry";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import { structuredContent } from "@/lib/runtime/structuredContent";

/**
 * Writes the delivered held-delivery record an older release left behind for a
 * message it typed into a terminal pane: text, the digest of the delivered
 * text, the sender's authorship, and a delivered settlement. Projection tests
 * read such stored records; no release writes them any more.
 */
export function seedStoredDeliveredMessage(
  registry: AgentRegistry,
  input: { conversationId: string; text: string; clientMessageId: string; origin?: MessageOrigin },
) {
  const conversationId = input.conversationId as `conversation_${string}`;
  const held = registry.holdDelivery(
    conversationId, input.text, input.clientMessageId, "text", [],
    structuredContent(input.text, []).contentDigest,
    input.origin ? { origin: input.origin } : {},
  );
  if (!held.generationId) throw new Error("stored delivery fixture was not assigned to a generation");
  const started = registry.beginDeliveryAttempt(held.id, held.generationId);
  if (!started) throw new Error("stored delivery fixture could not be claimed");
  registry.recordDeliveryOutcome(started.id, "delivered", null, "delivered");
  return registry.readOnlySnapshot().heldDeliveries[started.id]!;
}
