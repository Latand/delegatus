import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";

export interface PublishedRelayReference {
  key: string;
  apiBase: string;
  targetId: string;
  messageKey: string;
  chatId: string;
  messageId: number;
  /** Absent on legacy mappings: it cannot prove a topic. */
  topicId?: number | null;
}
const key = (apiBase: string, targetId: string, messageKey: string) => createHash("sha256").update(JSON.stringify([apiBase, targetId, messageKey])).digest("hex");
const seed = { collection: "relay_published_references", schemaVersion: 1, migrationId: "relay-published-references-v1", key: (row: PublishedRelayReference) => row.key, loadRecords: (): PublishedRelayReference[] => [] };
const stores = new Map<string, SqliteStateCollection<PublishedRelayReference>>();
function collection(create = false) {
  const file = statePath("state.sqlite");
  const held = stores.get(file);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const opened = new SqliteStateCollection<PublishedRelayReference>(file, { collection: seed.collection, schemaVersion: 1,
    busyMessage: "relay publication references busy", key: seed.key, clone: structuredClone, strictDecode: true,
    decode: raw => {
      const row = raw as Partial<PublishedRelayReference> | null;
      return row && typeof row.key === "string" && typeof row.apiBase === "string" && typeof row.targetId === "string"
        && typeof row.messageKey === "string" && typeof row.chatId === "string" && Number.isSafeInteger(row.messageId)
        && (row.topicId === undefined || row.topicId === null || (Number.isSafeInteger(row.topicId) && row.topicId > 0)) ? row as PublishedRelayReference : null;
    } });
  stores.set(file, opened);
  return opened;
}

/** The publish endpoint returns the opaque reference used in later claims.
 * Keep its Telegram receipt; never infer a reference from message text. */
export function recordPublishedRelayReference(apiBase: string, route: string, method: string, outgoing: unknown, status: number, response: unknown): void {
  const match = /^\/targets\/([^/]+)\/messages$/.exec(route);
  if (!match || method !== "POST" || status !== 200) return;
  const body = outgoing as { chat_id?: number; message_id?: number; message_thread_id?: number } | null;
  const reply = response as { message_key?: string; replayed?: boolean } | null;
  if (!body || !Number.isSafeInteger(body.chat_id) || !body.chat_id || !Number.isSafeInteger(body.message_id) || body.message_id! <= 0
    || (body.message_thread_id !== undefined && (!Number.isSafeInteger(body.message_thread_id) || body.message_thread_id < 1))
    || !reply || typeof reply.message_key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(reply.message_key) || typeof reply.replayed !== "boolean") return;
  const targetId = decodeURIComponent(match[1]);
  const row = { key: key(apiBase, targetId, reply.message_key), apiBase, targetId, messageKey: reply.message_key, chatId: String(body.chat_id), messageId: body.message_id!, topicId: body.message_thread_id ?? null };
  collection(true)!.boundedPatch(2, tx => {
    const held = tx.get(row.key);
    if (held && (held.chatId !== row.chatId || held.messageId !== row.messageId || (held.topicId !== undefined && held.topicId !== row.topicId))) throw new Error("relay publication reference conflict");
    tx.put(row);
  });
}

export function publishedRelayReference(apiBase: string, targetId: string, messageKey: string): PublishedRelayReference | null {
  return collection()?.get(key(apiBase, targetId, messageKey)) ?? null;
}
