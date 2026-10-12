import { ExternalRelayError, relayCall } from "./client";
import type { PairedRelay } from "./store";

export type RelayPublishBody = {
  chat_id: number;
  message_id: number;
  message_thread_id?: number;
  sent_at: string;
  text: string;
};
export type TelegramPublishReceipt = {
  botId: string; chatId: string; messageId: number; date: number;
  topicId: number | null; text: string;
};
const MARKER = "\n[truncated]";
/** Both limits apply to the encoded body, including JSON escaping. */
export function relayPublishBody(receipt: TelegramPublishReceipt): RelayPublishBody | null {
  const chat = Number(receipt.chatId);
  if (!Number.isSafeInteger(chat) || !chat || !Number.isSafeInteger(receipt.messageId)
    || receipt.messageId < 1 || receipt.messageId > 2147483647 || !Number.isSafeInteger(receipt.date)
    || Math.abs(receipt.date * 1000) > 8640000000000000
    || (receipt.topicId !== null && (!Number.isSafeInteger(receipt.topicId) || receipt.topicId < 1))
    || !receipt.text.trim()) return null;
  const body: RelayPublishBody = { chat_id: chat, message_id: receipt.messageId,
    ...(receipt.topicId === null ? {} : { message_thread_id: receipt.topicId }),
    sent_at: new Date(receipt.date * 1000).toISOString(), text: "" };
  const points = Array.from(receipt.text);
  let length = Math.min(points.length, 12000);
  do {
    body.text = length === points.length ? receipt.text : points.slice(0, length - MARKER.length).join("") + MARKER;
    if (Buffer.byteLength(JSON.stringify(body)) <= 65536) return body;
    length -= 256;
  } while (length > MARKER.length);
  return null;
}

export type RelayPublishResult = "published" | "unavailable" | "not_allowed" | "refused" | "unconfirmed";
type Runtime = { sleep?: (ms: number) => Promise<void> };
/** Retries preserve Telegram's identity, date and text, even after a lost response. */
export async function publishRelayMessage(relay: Pick<PairedRelay, "api_base" | "credential">,
  targetId: string, body: RelayPublishBody, runtime: Runtime = {}): Promise<RelayPublishResult> {
  const outgoing = Object.freeze({ ...body });
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); }));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await relayCall<{ message_key: string; replayed: boolean }>(relay.api_base,
        `/targets/${encodeURIComponent(targetId)}/messages`, "POST", outgoing, relay.credential);
      return response.status === 200 && typeof response.body?.message_key === "string"
        && typeof response.body.replayed === "boolean" ? "published" : "unconfirmed";
    } catch (error) {
      if (error instanceof ExternalRelayError) {
        if (error.status === 404) return "unavailable";
        if (error.status === 403) return "not_allowed";
        if (error.status && error.status !== 429 && error.status < 500) return "refused";
        if (error.status === 429) {
          const seconds = error.retryAfterSeconds;
          // No immediate retry when the service supplies an unusable delay.
          if (seconds === null || seconds <= 0 || seconds > 86400) return "unconfirmed";
          // Keep sibling publications behind the last refusal's delay too.
          await sleep(Math.ceil(seconds * 1000));
          if (attempt === 3) return "unconfirmed";
          continue;
        }
      }
      if (attempt < 3) await sleep(1000 * 2 ** attempt);
    }
  }
  return "unconfirmed";
}

export type RelayPublishTarget = { relay: PairedRelay; targetId: string };
/** Resolve the operator's target policy again before each queued publication. */
export function createRelayPublisher(resolve: (botId: string) => RelayPublishTarget | null,
  runtime: Runtime & { now?: () => number } = {}) {
  const queues = new Map<string, Promise<unknown>>();
  const cooldowns = new Map<string, number>();
  const now = runtime.now ?? Date.now;
  let pending = 0;
  return async (receipt: TelegramPublishReceipt): Promise<RelayPublishResult | "skipped"> => {
    const match = resolve(receipt.botId);
    const body = relayPublishBody(receipt);
    if (!match || !body || pending >= 128) return "skipped";
    const { relay, targetId } = match;
    const targetKey = `${relay.id}:${targetId}`;
    const chatKey = `${targetKey}:${receipt.chatId}`;
    const held = () => [targetKey, chatKey].some(key => (cooldowns.get(key) ?? 0) > now());
    if (held()) return "skipped";
    pending++;
    const previous = queues.get(relay.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (held()) return "skipped" as const;
      // Recheck after queueing: unpairing or changed routing cancels the send.
      const current = resolve(receipt.botId);
      if (!current || current.relay.id !== relay.id || current.targetId !== targetId
        || current.relay.credential !== relay.credential) return "skipped" as const;
      const outcome = await publishRelayMessage(relay, targetId, body, runtime);
      for (const [key, expiry] of cooldowns) if (expiry <= now()) cooldowns.delete(key);
      if (outcome === "unavailable" || outcome === "not_allowed") {
        cooldowns.set(outcome === "unavailable" ? targetKey : chatKey, now() + 300000);
      }
      return outcome;
    }).finally(() => {
      pending--;
      if (queues.get(relay.id) === next) queues.delete(relay.id);
    });
    queues.set(relay.id, next);
    return next;
  };
}
