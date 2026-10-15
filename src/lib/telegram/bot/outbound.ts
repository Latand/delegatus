import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { openCurrentDatabase } from "@/lib/state/currentDatabase";
import { stateLockAttempt, waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { TelegramPublishReceipt } from "@/lib/externalRelay/publish";

export interface PublicationTarget { relayId: string; apiBase: string; targetId: string; ownerId: string }
export interface OutboundMessage extends TelegramPublishReceipt {
  origin: "agent" | "operator" | "system" | "review" | "poll";
  conversationId: string | null;
  replyToMessageId: number | null;
  sendKey: string;
  target: PublicationTarget | null;
}
export interface OutboundRow { key: string; message: OutboundMessage; attempts: number }
export const outboundKey = (m: TelegramPublishReceipt) => JSON.stringify([m.botId, m.chatId, m.messageId]);
export const samePublicationTarget = (a: PublicationTarget | null, b: PublicationTarget | null) =>
  !!a && !!b && a.relayId === b.relayId && a.apiBase === b.apiBase && a.targetId === b.targetId && a.ownerId === b.ownerId;

/** Short connections, zero SQLite waits, and one async admission deadline.
 * This journal shares the bot database, so the confirmed receipt and the
 * publication obligation commit together. It never calls Telegram. */
export function outboundState<T>(filename: string, write: boolean, work: (db: Database) => T): Promise<T> {
  return withViewerOperation("telegram.outbound-state", () => waitForStateLock("telegram.outbound-state", () =>
    outboundAttempt(filename, write, work), { waitMs: 5000 }));
}
function outboundAttempt<T>(filename: string, write: boolean, work: (db: Database) => T): T {
  return stateLockAttempt("telegram.outbound-state", () => {
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("Telegram outbound custody requires the Bun runtime");
    const db = openCurrentDatabase(filename, () => new sqlite.Database(filename, { readonly: !write, strict: true }));
    try {
      db.exec("PRAGMA busy_timeout = 0");
      if (write) {
        db.exec("BEGIN IMMEDIATE");
        db.exec(`CREATE TABLE IF NOT EXISTS relay_outbound (
          key TEXT PRIMARY KEY, bot_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id INTEGER,
          date INTEGER NOT NULL, message_id INTEGER NOT NULL, value_json TEXT NOT NULL,
          is_question INTEGER NOT NULL, send_key TEXT NOT NULL,
          state TEXT NOT NULL, due INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`);
        db.exec("CREATE TABLE IF NOT EXISTS relay_owner_turns (scope TEXT PRIMARY KEY, request_id TEXT NOT NULL, at INTEGER NOT NULL, previous_at INTEGER NOT NULL)");
        db.exec("CREATE TABLE IF NOT EXISTS relay_owner_contexts (key TEXT PRIMARY KEY, at INTEGER NOT NULL, previous_at INTEGER NOT NULL)");
        db.exec("CREATE INDEX IF NOT EXISTS relay_owner_contexts_retention ON relay_owner_contexts(at, key)");
        db.exec("CREATE TABLE IF NOT EXISTS relay_publication_cooldowns (key TEXT PRIMARY KEY, until_ms INTEGER NOT NULL)");
        db.exec("CREATE INDEX IF NOT EXISTS relay_outbound_retention ON relay_outbound(date, key) WHERE state <> 'pending'");
        db.exec("CREATE INDEX IF NOT EXISTS relay_outbound_due ON relay_outbound(due, key) WHERE state = 'pending'");
        db.exec("CREATE INDEX IF NOT EXISTS relay_outbound_questions ON relay_outbound(bot_id, chat_id, topic_id, date DESC, message_id DESC) WHERE is_question = 1");
        db.exec("CREATE INDEX IF NOT EXISTS relay_outbound_group ON relay_outbound(bot_id, chat_id, topic_id, send_key, date DESC, message_id DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS relay_outbound_scope ON relay_outbound(bot_id, chat_id, topic_id, date DESC, message_id DESC)");
      }
      const result = work(db);
      if (write) db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally { db.close(); }
    });
}
function pruneOutbound(db: Database, before: number): void {
  db.query("DELETE FROM relay_outbound WHERE key IN (SELECT key FROM relay_outbound WHERE state <> 'pending' AND date < ? ORDER BY date, key LIMIT 64)").run(before);
}
const exists = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_outbound'").get();

export const isOutboundQuestion = (message: Pick<OutboundMessage, "origin" | "text">) => ["agent", "review", "poll"].includes(message.origin)
  && (/\?/.test(message.text) || /(?:^|\n)\s*\d+[a-z]?[).]\s+\S/u.test(message.text));

export async function recordOutbound(filename: string, message: OutboundMessage): Promise<void> {
  await outboundState(filename, true, db => {
    const key = outboundKey(message);
    const old = db.query<{ value_json: string }, [string]>("SELECT value_json FROM relay_outbound WHERE key=?").get(key);
    if (old && old.value_json !== JSON.stringify(message)) throw new Error("Telegram outbound receipt conflict");
    db.query(`INSERT OR IGNORE INTO relay_outbound
      (key, bot_id, chat_id, topic_id, date, message_id, value_json, state, is_question, send_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, message.botId, message.chatId, message.topicId, message.date, message.messageId,
        JSON.stringify(message), message.target ? "pending" : "unrouted", isOutboundQuestion(message) ? 1 : 0, message.sendKey);
    pruneOutbound(db, message.date - 30 * 86400);
    if (message.origin === "operator" || message.origin === "system") return;
    db.query(`INSERT OR REPLACE INTO messages
      (chat_id, message_id, direction, date, kind, text, reply_to_message_id, topic_id, sent_by_conversation_id, sent_by_unidentified)
      VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?)`)
      .run(message.chatId, message.messageId, message.date, message.origin === "poll" ? "poll" : "text", message.text,
        message.replyToMessageId, message.topicId, message.conversationId, message.conversationId ? 0 : 1);
  });
}
export async function pendingOutbound(filename: string, now: number): Promise<OutboundRow[]> {
  if (!fs.existsSync(filename)) return [];
  return outboundState(filename, false, db => exists(db) ? db.query<{ key: string; value_json: string; attempts: number }, [number]>(
    "SELECT key, value_json, attempts FROM relay_outbound WHERE state='pending' AND due<=? ORDER BY due, key LIMIT 16")
    .all(now).map(r => ({ key: r.key, message: JSON.parse(r.value_json), attempts: r.attempts })) : []);
}
export async function settleOutbound(filename: string, row: OutboundRow, published: boolean, now: number, delayMs?: number): Promise<void> {
  await outboundState(filename, true, db => {
    pruneOutbound(db, Math.floor(now / 1000) - 30 * 86400);
    db.query("UPDATE relay_outbound SET state=?, due=?, attempts=attempts+1 WHERE key=? AND state='pending' AND attempts=?")
      .run(published ? "published" : "pending", now + (delayMs ?? Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 9))), row.key, row.attempts);
  });
}

/** Only a confirmed publication reference may supply the scope. At most 32
 * receipts and 64 KiB of text leave this read, regardless of retained history. */
export async function scopedOutbound(filename: string, botId: string, chatId: string, topicId: number | null,
  before: number, messageId?: number): Promise<OutboundMessage[]> {
  if (!fs.existsSync(filename)) return [];
  return outboundState(filename, false, db => {
    if (!exists(db)) return [];
    const value = "CASE WHEN length(CAST(value_json AS BLOB)) <= 131072 THEN value_json ELSE NULL END AS value_json";
    const rows = messageId === undefined
      ? db.query<{ value_json: string | null }, [string, string, number | null, number, number]>(`SELECT ${value} FROM relay_outbound
        WHERE bot_id=? AND chat_id=? AND topic_id IS ? AND date<=? AND date>=?
        ORDER BY date DESC, message_id DESC LIMIT 32`).all(botId, chatId, topicId, before, before - 30 * 86400)
      : db.query<{ value_json: string | null }, [string, number | null, number, number]>(`SELECT ${value} FROM relay_outbound
        WHERE key=? AND topic_id IS ? AND date<=? AND date>=?`).all(JSON.stringify([botId, chatId, messageId]), topicId, before, before - 30 * 86400);
    // Reserve the latest question's send group before filling the rest from
    // recent history. Report traffic cannot evict its numbered options.
    const questions = messageId === undefined ? db.query<{ send_key: string }, [string, string, number | null, number, number]>(`SELECT send_key FROM relay_outbound
      WHERE bot_id=? AND chat_id=? AND topic_id IS ? AND is_question=1 AND date<=? AND date>=?
      ORDER BY date DESC, message_id DESC LIMIT 32`).all(botId, chatId, topicId, before, before - 30 * 86400) : [];
    const groups = [...new Set(questions.map(row => row.send_key))].slice(0, 2).map(sendKey =>
      db.query<{ value_json: string | null }, [string, string, number | null, string, number, number]>(`SELECT ${value} FROM relay_outbound
        WHERE bot_id=? AND chat_id=? AND topic_id IS ? AND send_key=? AND date<=? AND date>=?
        ORDER BY date DESC, message_id DESC LIMIT 32`).all(botId, chatId, topicId, sendKey, before, before - 30 * 86400));
    // One receipt from each group preserves ambiguity if their combined text
    // cannot fit; remaining rows favour the newest complete question.
    const group = [...groups.flatMap(rows => rows.slice(0, 1)), ...groups.flatMap(rows => rows.slice(1))];
    let bytes = 0;
    const seen = new Set<number>();
    const result: OutboundMessage[] = [];
    for (const row of [...group, ...rows]) {
      if (row.value_json === null) continue;
      const message = JSON.parse(row.value_json) as OutboundMessage;
      if (seen.has(message.messageId)) continue;
      seen.add(message.messageId);
      const size = Buffer.byteLength(message.text);
      if (bytes + size > 65536) continue;
      bytes += size;
      result.push(message);
      if (result.length === 32) break;
    }
    return result.sort((a, b) => a.date - b.date || a.messageId - b.messageId);
  });
}

const targetKey = (m: OutboundMessage) => JSON.stringify(m.target);
export async function publicationCooldown(filename: string, message: OutboundMessage): Promise<number> {
  return outboundState(filename, false, db => db.query<{ until_ms: number }, [string, string]>(
    "SELECT max(until_ms) AS until_ms FROM relay_publication_cooldowns WHERE key IN (?, ?)")
    .get(targetKey(message), `${targetKey(message)}:${message.chatId}`)?.until_ms ?? 0);
}
export async function holdPublications(filename: string, message: OutboundMessage, until: number, chatOnly = false): Promise<void> {
  await outboundState(filename, true, db => {
    const key = targetKey(message) + (chatOnly ? `:${message.chatId}` : "");
    db.query("INSERT INTO relay_publication_cooldowns VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until_ms=max(until_ms, excluded.until_ms)").run(key, until);
  });
}

/** Replays of one owner request use the same cutoff. An older request cannot
 * reopen questions already followed by a newer owner's turn. */
export async function ownerQuestionCutoff(filename: string, scope: string, requestId: string, at: number): Promise<number> {
  return outboundState(filename, true, db => {
    const key = JSON.stringify([scope, requestId]);
    const saved = db.query<{ previous_at: number }, [string]>("SELECT previous_at FROM relay_owner_contexts WHERE key=?").get(key);
    if (saved) return saved.previous_at;
    const old = db.query<{ request_id: string; at: number; previous_at: number }, [string]>("SELECT * FROM relay_owner_turns WHERE scope=?").get(scope);
    const cutoff = old?.request_id === requestId ? old.previous_at : old?.at ?? 0;
    db.query("INSERT INTO relay_owner_contexts VALUES (?, ?, ?)").run(key, at, cutoff);
    db.query("DELETE FROM relay_owner_contexts WHERE key IN (SELECT key FROM relay_owner_contexts WHERE at < ? ORDER BY at, key LIMIT 64)").run(at - 30 * 86400);
    if (!old || at > old.at) db.query("INSERT INTO relay_owner_turns VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET request_id=excluded.request_id, at=excluded.at, previous_at=excluded.previous_at")
      .run(scope, requestId, at, cutoff);
    return cutoff;
  });
}

/** Final emission guard: a zero-wait read may refuse, never sleep on the
 * Viewer loop. The durable worker retries that refusal asynchronously. */
export function outboundPostingAllowed(filename: string, message: OutboundMessage): boolean {
  return outboundAttempt(filename, false, db => {
    const row = db.query<{ type: string; alias: string | null; post_allowed: number; bot_status: string | null }, [string]>(
      "SELECT type, alias, post_allowed, bot_status FROM chats WHERE chat_id=?").get(message.chatId);
    if (!row) return false;
    if (row.type === "private" && message.chatId === message.target?.ownerId) return true;
    return !!row.alias && row.post_allowed === 1 && (row.type === "private"
      || (row.bot_status !== "left" && row.bot_status !== "kicked"));
  });
}
