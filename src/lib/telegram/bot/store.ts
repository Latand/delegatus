import fs from "node:fs";
import path from "node:path";

import { openCurrentDatabase } from "@/lib/state/currentDatabase";

import {
  validChatAlias,
  type TelegramBotAttribution,
  type TelegramBotMemberStatus,
  type TelegramBotMessageView,
  type TelegramBotReceiving,
  type TelegramChatType,
} from "./contracts";

/**
 * The bot's local record (`docs/design/telegram-bot-account.md`, Decisions 3
 * and 4): one SQLite file, `<state>/telegram/bot.sqlite`, 0600.
 *
 * A bot has no history method, so what it received is kept here — bounded per
 * chat to the newest {@link RETAIN_MESSAGES} and nothing older than
 * {@link RETAIN_DAYS} days. Every intake write is idempotent: Telegram's
 * confirmed offset is the only cursor, so a crash between a commit and the
 * next `getUpdates` redelivers a batch that lands on the same rows.
 */

export const RETAIN_MESSAGES = 2000;
export const RETAIN_DAYS = 30;

/* ---- the slice of the Bot API's objects this store reads ---------------- */

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
export type TgChat = { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string; is_forum?: boolean };
export type TgMessage = {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: { message_id: number };
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  [field: string]: unknown;
};
export type TgChatMemberUpdated = { chat: TgChat; date: number; new_chat_member: { status: string; user?: TgUser } };
export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
  my_chat_member?: TgChatMemberUpdated;
};

/* ---- rows --------------------------------------------------------------- */

export type BotRow = {
  name: string;
  username: string | null;
  canReadAllGroupMessages: boolean;
  canJoinGroups: boolean;
  /** When `can_read_all_group_messages` was last seen turning on. */
  readAllSince: string | null;
  connectedAt: string;
  receiving: TelegramBotReceiving;
  lastUpdateAt: string | null;
  lastCheckedAt: string | null;
};

export type ChatRow = {
  chatId: string;
  type: TelegramChatType;
  title: string;
  username: string | null;
  isForum: boolean;
  botStatus: TelegramBotMemberStatus | null;
  alias: string | null;
  postAllowed: boolean;
  firstSeenAt: string;
  lastMessageAt: string | null;
  lastPostAt: string | null;
  lastPostConversationId: string | null;
  lastPostUnidentified: boolean;
  storedMessages: number;
};

export type SendRow = {
  state: "pending" | "sent" | "failed";
  chatId: string;
  messageIds: number[];
  parts: number;
  sentAt: string | null;
  errorCode: string | null;
};

export type MessagePage = {
  messages: TelegramBotMessageView[];
  nextCursor: string | null;
  hasMore: boolean;
  storedSince: string | null;
};

export type ApplyResult = {
  /** Chats a message or membership change touched, for retention. */
  touched: string[];
  /** Non-private chats first seen without a membership event: their
      visibility is unknown until the bot's own member status is asked. */
  needsMembership: string[];
  maxUpdateId: number | null;
  lastUpdateAt: string | null;
};

const MEMBER_STATUSES: ReadonlySet<string> = new Set(["creator", "administrator", "member", "restricted", "left", "kicked"]);
const CHAT_TYPES: ReadonlySet<string> = new Set(["private", "group", "supergroup", "channel"]);
/** Fields whose presence names what a message without text is. */
const MESSAGE_KINDS = [
  "photo", "video", "animation", "document", "audio", "voice", "video_note", "sticker", "contact", "location",
  "venue", "poll", "dice", "story", "new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo",
  "pinned_message", "forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
  "migrate_to_chat_id", "migrate_from_chat_id", "group_chat_created", "supergroup_chat_created",
] as const;

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function chatTitle(chat: TgChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  return name || (chat.username ? `@${chat.username}` : "Untitled chat");
}

function userName(user: TgUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || (user.username ? `@${user.username}` : "Unknown");
}

function messageKind(message: TgMessage): string {
  if (typeof message.text === "string") return "text";
  for (const kind of MESSAGE_KINDS) if (message[kind] !== undefined) return kind;
  return "other";
}

function encodeCursor(date: number, messageId: number): string {
  return Buffer.from(JSON.stringify([date, messageId])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): [number, number] | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((value) => Number.isSafeInteger(value))) {
      return [parsed[0] as number, parsed[1] as number];
    }
  } catch { /* an unreadable cursor reads from the newest message */ }
  return null;
}

type SqlChat = {
  chat_id: string; type: string; title: string; username: string | null; is_forum: number; bot_status: string | null;
  alias: string | null; post_allowed: number; first_seen_at: string; last_message_at: string | null;
  last_post_at: string | null; last_post_conversation_id: string | null; last_post_unidentified: number; stored: number;
};

type SqlMessage = {
  chat_id: string; message_id: number; direction: "in" | "out"; date: number; edited_at: number | null;
  from_name: string | null; from_username: string | null; kind: string; text: string | null;
  reply_to_message_id: number | null; topic_id: number | null; sent_by_conversation_id: string | null; sent_by_unidentified: number;
};

function chatFromSql(row: SqlChat): ChatRow {
  return {
    chatId: row.chat_id,
    type: (CHAT_TYPES.has(row.type) ? row.type : "group") as TelegramChatType,
    title: row.title,
    username: row.username,
    isForum: row.is_forum === 1,
    botStatus: row.bot_status && MEMBER_STATUSES.has(row.bot_status) ? row.bot_status as TelegramBotMemberStatus : null,
    alias: row.alias,
    postAllowed: row.post_allowed === 1,
    firstSeenAt: row.first_seen_at,
    lastMessageAt: row.last_message_at,
    lastPostAt: row.last_post_at,
    lastPostConversationId: row.last_post_conversation_id,
    lastPostUnidentified: row.last_post_unidentified === 1,
    storedMessages: row.stored,
  };
}

const CHAT_SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS stored
  FROM chats c`;

export class TelegramBotStore {
  private readonly db: import("bun:sqlite").Database;

  constructor(readonly filename: string) {
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("the Telegram bot store requires the Bun runtime");
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    /* Created owner-only BEFORE SQLite opens it; the -wal and -shm files take
       the database file's mode. */
    fs.closeSync(fs.openSync(filename, "a", 0o600));
    fs.chmodSync(filename, 0o600);
    this.db = openCurrentDatabase(filename, () => {
      const db = new sqlite.Database(filename, { create: true, strict: true });
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS bot (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          name TEXT NOT NULL,
          username TEXT,
          can_read_all_group_messages INTEGER NOT NULL DEFAULT 0,
          can_join_groups INTEGER NOT NULL DEFAULT 0,
          read_all_since TEXT,
          connected_at TEXT NOT NULL,
          receiving TEXT NOT NULL DEFAULT 'stopped',
          last_update_at TEXT,
          last_checked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS chats (
          chat_id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          username TEXT,
          is_forum INTEGER NOT NULL DEFAULT 0,
          bot_status TEXT,
          alias TEXT UNIQUE,
          post_allowed INTEGER NOT NULL DEFAULT 0,
          first_seen_at TEXT NOT NULL,
          last_message_at TEXT,
          last_post_at TEXT,
          last_post_conversation_id TEXT,
          last_post_unidentified INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
          chat_id TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          direction TEXT NOT NULL,
          date INTEGER NOT NULL,
          edited_at INTEGER,
          from_name TEXT,
          from_username TEXT,
          kind TEXT NOT NULL,
          text TEXT,
          reply_to_message_id INTEGER,
          topic_id INTEGER,
          sent_by_conversation_id TEXT,
          sent_by_unidentified INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (chat_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS messages_newest ON messages(chat_id, date DESC, message_id DESC);
        CREATE TABLE IF NOT EXISTS sends (
          caller_key TEXT NOT NULL,
          client_request_id TEXT NOT NULL,
          state TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          message_ids TEXT NOT NULL DEFAULT '[]',
          parts INTEGER NOT NULL DEFAULT 0,
          sent_at TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (caller_key, client_request_id)
        );
      `);
      return db;
    });
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* the failed statement may have ended it */ }
      throw error;
    }
  }

  /* ---- the bot row ------------------------------------------------------ */

  bot(): BotRow | null {
    const row = this.db.query<{
      name: string; username: string | null; can_read_all_group_messages: number; can_join_groups: number; read_all_since: string | null;
      connected_at: string; receiving: string; last_update_at: string | null; last_checked_at: string | null;
    }, []>("SELECT * FROM bot WHERE id = 1").get();
    if (!row) return null;
    return {
      name: row.name,
      username: row.username,
      canReadAllGroupMessages: row.can_read_all_group_messages === 1,
      canJoinGroups: row.can_join_groups === 1,
      readAllSince: row.read_all_since,
      connectedAt: row.connected_at,
      receiving: row.receiving as TelegramBotReceiving,
      lastUpdateAt: row.last_update_at,
      lastCheckedAt: row.last_checked_at,
    };
  }

  /** Records what `getMe` answered. A privacy flag that just turned on stamps
      `read_all_since`, which is what "re-add the bot to apply" compares with. */
  saveIdentity(identity: { name: string; username: string | null; canReadAllGroupMessages: boolean; canJoinGroups: boolean }, now: Date): void {
    const at = now.toISOString();
    const previous = this.bot();
    const readAllSince = identity.canReadAllGroupMessages
      ? (previous?.canReadAllGroupMessages ? previous.readAllSince : previous ? at : null)
      : null;
    this.db.query(`
      INSERT INTO bot (id, name, username, can_read_all_group_messages, can_join_groups, read_all_since, connected_at, receiving, last_checked_at)
      VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, 'stopped', ?6)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username,
        can_read_all_group_messages = excluded.can_read_all_group_messages, can_join_groups = excluded.can_join_groups,
        read_all_since = ?5, last_checked_at = ?6
    `).run(identity.name, identity.username, identity.canReadAllGroupMessages ? 1 : 0, identity.canJoinGroups ? 1 : 0, readAllSince, at);
  }

  setReceiving(receiving: TelegramBotReceiving): void {
    this.db.query("UPDATE bot SET receiving = ?1 WHERE id = 1").run(receiving);
  }

  /* ---- intake ----------------------------------------------------------- */

  /**
   * Applies one `getUpdates` batch in one transaction. Redelivering the same
   * batch changes nothing.
   */
  applyUpdates(updates: readonly TgUpdate[], now: Date): ApplyResult {
    const touched = new Set<string>();
    const needsMembership = new Set<string>();
    let maxUpdateId: number | null = null;
    let lastUpdateAt: string | null = null;
    this.transaction(() => {
      for (const update of updates) {
        if (typeof update?.update_id === "number") maxUpdateId = Math.max(maxUpdateId ?? update.update_id, update.update_id);
        const fresh = update.message ?? update.channel_post;
        const edited = update.edited_message ?? update.edited_channel_post;
        if (fresh && fresh.chat) {
          this.upsertChat(fresh.chat, now, iso(fresh.date));
          if (fresh.chat.type === "private") this.setMemberStatus(String(fresh.chat.id), "member", true);
          this.insertIncoming(fresh);
          touched.add(String(fresh.chat.id));
          if (typeof fresh.migrate_to_chat_id === "number") {
            const target = String(fresh.migrate_to_chat_id);
            this.migrateChatRows(String(fresh.chat.id), target, "supergroup");
            touched.delete(String(fresh.chat.id));
            touched.add(target);
          }
          lastUpdateAt = now.toISOString();
        } else if (edited && edited.chat) {
          this.upsertChat(edited.chat, now, null);
          this.db.query(`
            UPDATE messages SET text = ?3, edited_at = ?4 WHERE chat_id = ?1 AND message_id = ?2
          `).run(String(edited.chat.id), edited.message_id, edited.text ?? edited.caption ?? null, edited.edit_date ?? edited.date);
          touched.add(String(edited.chat.id));
          lastUpdateAt = now.toISOString();
        } else if (update.my_chat_member?.chat) {
          const change = update.my_chat_member;
          this.upsertChat(change.chat, now, null);
          const status = change.new_chat_member?.status;
          if (typeof status === "string" && MEMBER_STATUSES.has(status)) {
            this.setMemberStatus(String(change.chat.id), status as TelegramBotMemberStatus, false);
          }
          touched.add(String(change.chat.id));
          lastUpdateAt = now.toISOString();
        }
      }
      if (lastUpdateAt) this.db.query("UPDATE bot SET last_update_at = ?1 WHERE id = 1").run(lastUpdateAt);
      for (const chatId of touched) {
        const row = this.db.query<{ type: string; bot_status: string | null }, [string]>("SELECT type, bot_status FROM chats WHERE chat_id = ?1").get(chatId);
        if (row && row.type !== "private" && row.bot_status === null) needsMembership.add(chatId);
      }
    });
    return { touched: [...touched], needsMembership: [...needsMembership], maxUpdateId, lastUpdateAt };
  }

  /** Inserts the chat or refreshes its facts. */
  private upsertChat(chat: TgChat, now: Date, messageAt: string | null): void {
    const chatId = String(chat.id);
    const type = CHAT_TYPES.has(chat.type) ? chat.type : "group";
    this.db.query(`
      INSERT INTO chats (chat_id, type, title, username, is_forum, first_seen_at, last_message_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(chat_id) DO UPDATE SET type = excluded.type, title = excluded.title, username = excluded.username,
        is_forum = excluded.is_forum,
        last_message_at = CASE
          WHEN excluded.last_message_at IS NULL THEN chats.last_message_at
          WHEN chats.last_message_at IS NULL OR excluded.last_message_at > chats.last_message_at THEN excluded.last_message_at
          ELSE chats.last_message_at END
    `).run(chatId, type, chatTitle(chat), chat.username ?? null, chat.is_forum ? 1 : 0, now.toISOString(), messageAt);
  }

  /** `onlyIfUnknown` keeps a private chat a user blocked the bot in `kicked`
      when an older message is redelivered. */
  setMemberStatus(chatId: string, status: TelegramBotMemberStatus, onlyIfUnknown: boolean): void {
    this.db.query(`UPDATE chats SET bot_status = ?2 WHERE chat_id = ?1${onlyIfUnknown ? " AND bot_status IS NULL" : ""}`).run(chatId, status);
  }

  private insertIncoming(message: TgMessage): void {
    const from = message.from
      ? { name: userName(message.from), username: message.from.username ?? null }
      : message.sender_chat && message.chat.type !== "channel"
        ? { name: chatTitle(message.sender_chat), username: message.sender_chat.username ?? null }
        : null;
    const topicId = message.is_topic_message && typeof message.message_thread_id === "number" ? message.message_thread_id : null;
    const replyTo = message.reply_to_message?.message_id ?? null;
    this.db.query(`
      INSERT OR IGNORE INTO messages (chat_id, message_id, direction, date, edited_at, from_name, from_username, kind, text, reply_to_message_id, topic_id)
      VALUES (?1, ?2, 'in', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).run(
      String(message.chat.id), message.message_id, message.date, message.edit_date ?? null,
      from?.name ?? null, from?.username ?? null, messageKind(message), message.text ?? message.caption ?? null,
      /* A topic message's reply points at the topic's opening message; that is
         the topic, not a reply. */
      replyTo !== null && replyTo === topicId ? null : replyTo,
      topicId,
    );
  }

  /** A group upgraded to a supergroup gets a new id; its alias, allowlist
      flag, messages and send history move with it. */
  migrateChat(fromChatId: string, toChatId: string): void {
    this.transaction(() => this.migrateChatRows(fromChatId, toChatId, "supergroup"));
  }

  private migrateChatRows(fromChatId: string, toChatId: string, type: TelegramChatType): void {
    if (fromChatId === toChatId) return;
    const source = this.db.query<SqlChat, [string]>(`${CHAT_SELECT} WHERE c.chat_id = ?1`).get(fromChatId);
    if (!source) return;
    const target = this.db.query<SqlChat, [string]>(`${CHAT_SELECT} WHERE c.chat_id = ?1`).get(toChatId);
    if (!target) {
      this.db.query("UPDATE chats SET chat_id = ?2, type = ?3 WHERE chat_id = ?1").run(fromChatId, toChatId, type);
    } else {
      this.db.query("UPDATE chats SET alias = NULL WHERE chat_id = ?1").run(fromChatId);
      this.db.query(`
        UPDATE chats SET
          alias = COALESCE(alias, ?2),
          post_allowed = CASE WHEN alias IS NULL THEN ?3 ELSE post_allowed END,
          last_post_at = COALESCE(last_post_at, ?4),
          last_post_conversation_id = COALESCE(last_post_conversation_id, ?5),
          bot_status = COALESCE(bot_status, ?6),
          first_seen_at = MIN(first_seen_at, ?7)
        WHERE chat_id = ?1
      `).run(toChatId, source.alias, source.post_allowed, source.last_post_at, source.last_post_conversation_id, source.bot_status, source.first_seen_at);
      this.db.query("DELETE FROM chats WHERE chat_id = ?1").run(fromChatId);
    }
    this.db.query("UPDATE OR IGNORE messages SET chat_id = ?2 WHERE chat_id = ?1").run(fromChatId, toChatId);
    this.db.query("DELETE FROM messages WHERE chat_id = ?1").run(fromChatId);
    this.db.query("UPDATE sends SET chat_id = ?2 WHERE chat_id = ?1").run(fromChatId, toChatId);
  }

  /** Keeps the newest {@link RETAIN_MESSAGES} of each chat and nothing older
      than {@link RETAIN_DAYS} days; send rows age out on the same horizon. */
  retain(chatIds: readonly string[], now: Date, bounds: { messages: number; days: number } = { messages: RETAIN_MESSAGES, days: RETAIN_DAYS }): void {
    const cutoff = Math.floor(now.getTime() / 1000) - bounds.days * 86_400;
    this.transaction(() => {
      const prune = this.db.query(`
        DELETE FROM messages WHERE chat_id = ?1 AND (date < ?2 OR message_id NOT IN (
          SELECT message_id FROM messages WHERE chat_id = ?1 ORDER BY date DESC, message_id DESC LIMIT ?3
        ))
      `);
      for (const chatId of chatIds) prune.run(chatId, cutoff, bounds.messages);
      this.db.query("DELETE FROM sends WHERE created_at < ?1").run(new Date(cutoff * 1000).toISOString());
    });
  }

  /* ---- chats ------------------------------------------------------------ */

  chats(): ChatRow[] {
    return this.db.query<SqlChat, []>(`${CHAT_SELECT} ORDER BY COALESCE(c.last_message_at, c.last_post_at, c.first_seen_at) DESC, c.chat_id`).all().map(chatFromSql);
  }

  chat(chatId: string): ChatRow | null {
    const row = this.db.query<SqlChat, [string]>(`${CHAT_SELECT} WHERE c.chat_id = ?1`).get(chatId);
    return row ? chatFromSql(row) : null;
  }

  /** Resolves what an agent named: an alias (case-insensitive) or a chat id. */
  resolveChat(reference: string): ChatRow | null {
    const trimmed = reference.trim();
    if (!trimmed) return null;
    const byAlias = this.db.query<SqlChat, [string]>(`${CHAT_SELECT} WHERE c.alias = ?1`).get(trimmed.toLowerCase());
    if (byAlias) return chatFromSql(byAlias);
    return this.chat(trimmed);
  }

  /** The operator's allowlist edit. An empty alias clears it, and posting is
      then off too: an alias is how agents name the chat. */
  setChatSettings(chatId: string, settings: { alias: string | null; postAllowed: boolean }): "ok" | "chat_unknown" | "alias_invalid" | "alias_taken" {
    const alias = settings.alias === null || settings.alias.trim() === "" ? null : settings.alias.trim().toLowerCase();
    if (alias !== null && !validChatAlias(alias)) return "alias_invalid";
    return this.transaction(() => {
      if (!this.chat(chatId)) return "chat_unknown";
      if (alias !== null) {
        const holder = this.db.query<{ chat_id: string }, [string]>("SELECT chat_id FROM chats WHERE alias = ?1").get(alias);
        if (holder && holder.chat_id !== chatId) return "alias_taken";
      }
      this.db.query("UPDATE chats SET alias = ?2, post_allowed = ?3 WHERE chat_id = ?1").run(chatId, alias, alias !== null && settings.postAllowed ? 1 : 0);
      return "ok";
    });
  }

  /* ---- messages --------------------------------------------------------- */

  messagesPage(chatId: string, options: { limit: number; cursor?: string; since?: number | null; maxChars: number }): MessagePage {
    const after = decodeCursor(options.cursor);
    const since = options.since ?? null;
    const rows = this.db.query<SqlMessage, [string, number, number, number, number]>(`
      SELECT * FROM messages
      WHERE chat_id = ?1
        AND (?2 = 0 OR date < ?3 OR (date = ?3 AND message_id < ?4))
        AND date >= ?5
      ORDER BY date DESC, message_id DESC
      LIMIT ${Math.max(1, Math.trunc(options.limit)) + 1}
    `).all(chatId, after ? 1 : 0, after?.[0] ?? 0, after?.[1] ?? 0, since ?? -1);
    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    const oldest = this.db.query<{ date: number | null }, [string]>("SELECT MIN(date) AS date FROM messages WHERE chat_id = ?1").get(chatId);
    const last = page.at(-1);
    return {
      messages: page.map((row) => {
        const text = row.text === null ? null : row.text.length > options.maxChars ? row.text.slice(0, options.maxChars) : row.text;
        const sentBy: TelegramBotAttribution | null = row.direction !== "out"
          ? null
          : row.sent_by_conversation_id ? { conversationId: row.sent_by_conversation_id } : { unidentified: true };
        return {
          messageId: row.message_id,
          date: iso(row.date),
          editedAt: row.edited_at === null ? null : iso(row.edited_at),
          direction: row.direction,
          from: row.direction === "out" || row.from_name === null ? null : { name: row.from_name, username: row.from_username },
          kind: row.kind,
          text,
          truncated: row.text !== null && text !== null && text.length < row.text.length,
          replyToMessageId: row.reply_to_message_id,
          topicId: row.topic_id,
          sentBy,
        };
      }),
      nextCursor: hasMore && last ? encodeCursor(last.date, last.message_id) : null,
      hasMore,
      storedSince: oldest?.date == null ? null : iso(oldest.date),
    };
  }

  /* ---- sends ------------------------------------------------------------ */

  /** Claims a send key. A new key, or one whose earlier attempt failed with
      nothing posted, comes back `claimed`; anything else answers what that
      earlier attempt left, so a partly posted send is never posted again. */
  claimSend(callerKey: string, clientRequestId: string, chatId: string, now: Date): { claimed: true } | { claimed: false; row: SendRow } {
    return this.transaction(() => {
      const existing = this.sendRow(callerKey, clientRequestId);
      if (existing && (existing.state !== "failed" || existing.messageIds.length > 0)) return { claimed: false as const, row: existing };
      this.db.query(`
        INSERT INTO sends (caller_key, client_request_id, state, chat_id, created_at) VALUES (?1, ?2, 'pending', ?3, ?4)
        ON CONFLICT(caller_key, client_request_id) DO UPDATE SET state = 'pending', chat_id = ?3, error_code = NULL, message_ids = '[]', parts = 0
      `).run(callerKey, clientRequestId, chatId, now.toISOString());
      return { claimed: true as const };
    });
  }

  sendRow(callerKey: string, clientRequestId: string): SendRow | null {
    const row = this.db.query<{ state: string; chat_id: string; message_ids: string; parts: number; sent_at: string | null; error_code: string | null }, [string, string]>(
      "SELECT state, chat_id, message_ids, parts, sent_at, error_code FROM sends WHERE caller_key = ?1 AND client_request_id = ?2",
    ).get(callerKey, clientRequestId);
    if (!row) return null;
    let messageIds: number[] = [];
    try { messageIds = (JSON.parse(row.message_ids) as unknown[]).filter((value): value is number => Number.isSafeInteger(value)); } catch { /* none */ }
    return { state: row.state as SendRow["state"], chatId: row.chat_id, messageIds, parts: row.parts, sentAt: row.sent_at, errorCode: row.error_code };
  }

  failSend(callerKey: string, clientRequestId: string, errorCode: string, sentMessageIds: readonly number[]): void {
    this.db.query("UPDATE sends SET state = 'failed', error_code = ?3, message_ids = ?4 WHERE caller_key = ?1 AND client_request_id = ?2")
      .run(callerKey, clientRequestId, errorCode, JSON.stringify(sentMessageIds));
  }

  /**
   * Settles a send and stores what went out, attributed. One transaction, so
   * the send row, the outgoing messages and the chat's last post agree.
   */
  completeSend(input: {
    callerKey: string;
    clientRequestId: string;
    chatId: string;
    conversationId: string | null;
    sent: Array<{ messageId: number; date: number; text: string; replyToMessageId: number | null; topicId: number | null }>;
    now: Date;
  }): void {
    const at = input.now.toISOString();
    this.transaction(() => {
      const insert = this.db.query(`
        INSERT OR REPLACE INTO messages (chat_id, message_id, direction, date, kind, text, reply_to_message_id, topic_id, sent_by_conversation_id, sent_by_unidentified)
        VALUES (?1, ?2, 'out', ?3, 'text', ?4, ?5, ?6, ?7, ?8)
      `);
      for (const message of input.sent) {
        insert.run(input.chatId, message.messageId, message.date, message.text, message.replyToMessageId, message.topicId, input.conversationId, input.conversationId ? 0 : 1);
      }
      this.db.query(`
        UPDATE chats SET last_post_at = ?2, last_post_conversation_id = ?3, last_post_unidentified = ?4 WHERE chat_id = ?1
      `).run(input.chatId, at, input.conversationId, input.conversationId ? 0 : 1);
      this.db.query(`
        UPDATE sends SET state = 'sent', chat_id = ?3, message_ids = ?4, parts = ?5, sent_at = ?6 WHERE caller_key = ?1 AND client_request_id = ?2
      `).run(input.callerKey, input.clientRequestId, input.chatId, JSON.stringify(input.sent.map((message) => message.messageId)), input.sent.length, at);
    });
  }
}
