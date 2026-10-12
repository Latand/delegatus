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
const KEY = Symbol.for("delegatus.telegram.relay-publisher");
const shared = globalThis as typeof globalThis & { [KEY]?: ReturnType<typeof createRelayPublisher> };
export function publishConfirmedTelegramMessage(receipt: TelegramPublishReceipt) {
  shared[KEY] ??= createTelegramPublisher(() => readRelayStore().relays,
    () => withStoredBotToken((_token, currentId) => currentId));
  return shared[KEY](receipt);
}
