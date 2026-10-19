import type { PublicationTarget } from "@/lib/telegram/bot/outbound";
import { relayCall } from "./client";
import { relayPublishBody } from "./publish";
import { withStoredBotToken } from "@/lib/telegram/bot/transport";
import { selectOwnerDestination } from "./ownerDestination";
import { createRelayPublisher, type TelegramPublishReceipt } from "./publish";
import { readRelayStore, type PairedRelay } from "./store";

export const ownerReviewDestination = () => selectOwnerDestination(readRelayStore().relays);

/** There is one connected bot in the Telegram store. The operator authorized
 * using it with the first target of their pairing, without a bot-id binding. */
export function createTelegramPublisher(readRelays: () => PairedRelay[], storedBotId: () => string | null) {
  return createRelayPublisher(botId => {
    if (storedBotId() !== botId) return null;
    const selected = selectOwnerDestination(readRelays());
    return selected.reason ? null : { relay: selected.relay, targetId: selected.targetId };
  });
}
/** Frozen at send admission, without retaining the credential in the journal. */
export function telegramPublicationTarget(botId: string): PublicationTarget | null {
  if (withStoredBotToken((_token, currentId) => currentId) !== botId) return null;
  const selected = selectOwnerDestination(readRelayStore().relays);
  return selected.reason ? null : { relayId: selected.relay.id, apiBase: selected.relay.api_base,
    targetId: selected.targetId, ownerId: selected.chatId };
}

/** One bounded idempotent attempt; the durable queue owns backoff and retry.
 * Recheck after DNS and immediately before emission as well as at admission. */
export async function publishDurableTelegramMessage(receipt: TelegramPublishReceipt, authorize: () => void) {
  const selected = selectOwnerDestination(readRelayStore().relays);
  const body = relayPublishBody(receipt);
  if (selected.reason || !body) return "skipped";
  const result = await relayCall(selected.relay.api_base, `/targets/${encodeURIComponent(selected.targetId)}/messages`,
    "POST", body, selected.relay.credential, { timeoutMs: 4000, signal: AbortSignal.timeout(5000),
      prepareBody: () => {
        authorize();
        const current = selectOwnerDestination(readRelayStore().relays);
        if (current.reason || current.relay.id !== selected.relay.id || current.targetId !== selected.targetId
          || current.relay.credential !== selected.relay.credential) throw Error("Telegram publication pairing changed");
        return body;
      } });
  const reply = result.body as { message_key?: string; replayed?: boolean } | null;
  return result.status === 200 && typeof reply?.message_key === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(reply.message_key)
    && typeof reply.replayed === "boolean" ? "published" : "unconfirmed";
}
