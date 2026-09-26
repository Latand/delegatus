/**
 * Public contracts for the Telegram bot account
 * (`docs/design/telegram-bot-account.md`).
 *
 * Everything in this file may cross the browser boundary or reach an agent
 * through the Viewer MCP, so nothing here can carry the bot token, the bot's
 * numeric id or a Telegram user id. The token lives only in the owner-only
 * `bot-token.json` and in the closure of the one transport built from it.
 */

/** How the update poller is doing, in one word. Every value has a sentence in
    {@link RECEIVING_NOTES} and a `telegram.bot.receiving.*` string. */
export type TelegramBotReceiving =
  | "polling"
  | "webhook_elsewhere"
  | "another_reader"
  | "token_rejected"
  | "network_error"
  | "stopped";

export const TELEGRAM_BOT_RECEIVING: readonly TelegramBotReceiving[] = [
  "polling", "webhook_elsewhere", "another_reader", "token_rejected", "network_error", "stopped",
];

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

/** What the bot's own membership in a chat is, as Telegram last reported it.
    `null` is a chat the bot has only seen a message from and not yet asked. */
export type TelegramBotMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

/** Refusals and failures the bot surfaces. The operator route, the agent route
    and the MCP tools share this one vocabulary. */
export type TelegramBotErrorCode =
  | "invalid_token"
  | "not_a_bot"
  | "bot_already_connected"
  | "bot_not_connected"
  | "token_rejected"
  | "chat_unknown"
  | "chat_not_allowed"
  | "bot_not_in_chat"
  | "alias_invalid"
  | "alias_taken"
  | "text_empty"
  | "text_too_long"
  | "format_invalid"
  | "forbidden"
  | "rate_limited"
  | "send_uncertain"
  | "send_partial"
  | "bad_request"
  | "network_failed"
  | "timed_out"
  | "telegram_failed"
  | "storage_unsafe";

/** The codes a caller may retry under a NEW clientRequestId. Everything else
    either needs the operator or would post twice. */
export const RETRYABLE_TELEGRAM_BOT_CODES: ReadonlySet<TelegramBotErrorCode> = new Set<TelegramBotErrorCode>([
  "rate_limited", "network_failed", "timed_out", "telegram_failed",
]);

/** Bot API tokens are `<numeric bot id>:<secret>`. Checked before any network
    call, so a pasted typo never leaves the machine. */
const BOT_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/;

export function validBotToken(value: unknown): value is string {
  return typeof value === "string" && BOT_TOKEN.test(value);
}

/** The public half of a token: the part before the colon. */
export function botIdFromToken(token: string): string {
  return token.slice(0, token.indexOf(":"));
}

/** How agents name a chat. Lowercase so two spellings can never be two chats,
    and never digits alone: a chat is also named by its numeric id, and an alias
    that looked like one would capture another chat's id. */
const CHAT_ALIAS = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validChatAlias(value: unknown): value is string {
  return typeof value === "string" && CHAT_ALIAS.test(value) && !/^\d+$/.test(value);
}

/** A suggestion built from the chat's title (`Team Reports!` → `team-reports`). */
export function suggestChatAlias(title: string): string {
  const slug = title.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return validChatAlias(slug) ? slug : "";
}

/** Chat ids are 64-bit and may be negative; kept as decimal strings. */
export function validTelegramChatId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value !== 0 ? String(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^-?[1-9]\d{0,19}$/.test(trimmed) ? trimmed : null;
}

/** The three limits the design states, sent in every tool answer and shown in
    the panel. Each rests on Telegram's own documentation; see the design's
    "Limits surfaced honestly". */
export const TELEGRAM_BOT_LIMITS: readonly string[] = [
  "A bot sees only messages sent after it joined a chat. Telegram holds undelivered updates for at most 24 hours, and Delegatus keeps what it received since the bot was connected.",
  "In groups, a bot with privacy mode on sees only commands, replies and messages meant for it. It sees everything when it is an admin, or when privacy mode is turned off in @BotFather and the bot is then re-added to the group. Bots never see messages from other bots.",
  "A bot cannot start a chat with a user who never wrote to it.",
];

export const RECEIVING_NOTES: Record<TelegramBotReceiving, string> = {
  polling: "Receiving messages.",
  webhook_elsewhere: "This bot delivers its updates to a webhook set by another program, so Delegatus can post but cannot read. Remove the webhook (deleteWebhook) to read here.",
  another_reader: "Another program is reading this bot's updates with the same token. Stop it, or give Delegatus its own bot.",
  token_rejected: "Telegram rejected the token. Paste a new one from @BotFather in the Telegram panel.",
  network_error: "Telegram cannot be reached right now; Delegatus keeps retrying.",
  stopped: "Not receiving: the bot is not connected in this Viewer.",
};

/** One chat as the operator panel sees it. */
export type TelegramBotChatView = {
  chatId: string;
  title: string;
  type: TelegramChatType;
  username: string | null;
  isForum: boolean;
  member: boolean;
  alias: string | null;
  /** The operator's switch, as stored. */
  postAllowed: boolean;
  /** Whether a post would actually be accepted: switch on, alias set, bot a member. */
  postable: boolean;
  seesAllMessages: boolean;
  /** Needs the bot re-added before a privacy change reaches this group. */
  readdToApply: boolean;
  lastMessageAt: string | null;
  lastPostAt: string | null;
  lastPostBy: { conversationId: string; title: string | null } | { unidentified: true } | null;
  storedMessages: number;
  /** The projects whose operator chose this chat for their orchestrator
      reports, by their name in report headers; `refused` when agents may not
      post in it now, so those reports reach the log only. Absent when none. */
  reports?: { name: string; refused?: true }[];
};

export type TelegramBotIdentity = {
  name: string;
  username: string | null;
  canReadAllGroupMessages: boolean;
  canJoinGroups: boolean;
};

/** The operator surface's whole payload. No token, no bot id. */
export type TelegramBotStatusPayload = {
  connected: boolean;
  bot: TelegramBotIdentity | null;
  receiving: TelegramBotReceiving;
  lastUpdateAt: string | null;
  lastCheckedAt: string | null;
  chats: TelegramBotChatView[];
  limits: readonly string[];
};

export const DISCONNECTED_BOT_STATUS: TelegramBotStatusPayload = {
  connected: false,
  bot: null,
  receiving: "stopped",
  lastUpdateAt: null,
  lastCheckedAt: null,
  chats: [],
  limits: TELEGRAM_BOT_LIMITS,
};

export type TelegramBotAttribution = { conversationId: string } | { unidentified: true };

/** One chat as an agent sees it (`telegram_bot_chats`). */
export type TelegramBotAgentChat = {
  /** The value the other tools accept: the alias when set, else the chat id. */
  chat: string;
  chatId: string;
  alias: string | null;
  title: string;
  type: TelegramChatType;
  isForum: boolean;
  member: boolean;
  postAllowed: boolean;
  postRefusal: string | null;
  seesAllMessages: boolean;
  visibilityNote: string;
  lastMessageAt: string | null;
  storedMessages: number;
};

export type TelegramBotChatsAnswer = {
  bot: {
    connected: boolean;
    name: string | null;
    username: string | null;
    receiving: TelegramBotReceiving;
    receivingNote: string | null;
    lastUpdateAt: string | null;
  };
  chats: TelegramBotAgentChat[];
  truncated?: number;
  note?: string;
  limits: readonly string[];
};

export type TelegramBotMessageView = {
  messageId: number;
  date: string;
  editedAt: string | null;
  direction: "in" | "out";
  from: { name: string; username: string | null } | null;
  kind: string;
  text: string | null;
  truncated: boolean;
  replyToMessageId: number | null;
  topicId: number | null;
  sentBy: TelegramBotAttribution | null;
};

export type TelegramBotMessagesAnswer = {
  chat: {
    chat: string;
    chatId: string;
    alias: string | null;
    title: string;
    type: TelegramChatType;
    seesAllMessages: boolean;
    visibilityNote: string;
  };
  messages: TelegramBotMessageView[];
  nextCursor: string | null;
  hasMore: boolean;
  storedSince: string | null;
  limits: readonly string[];
};

export type TelegramBotSendAnswer = {
  chat: string;
  chatId: string;
  messageIds: number[];
  sentAt: string;
  attributedTo: TelegramBotAttribution;
  parts: number;
  /** True when this clientRequestId had already posted: nothing was sent again. */
  alreadySent: boolean;
};

/** Bounds the tools clamp to. */
export const BOT_MESSAGES_LIMIT = { min: 1, max: 100, fallback: 20 } as const;
export const BOT_MESSAGES_MAX_CHARS = { min: 1, max: 4000, fallback: 1000 } as const;
export const BOT_TEXT_PART_CHARS = 4096;
export const BOT_TEXT_MAX_PARTS = 4;
export const BOT_CHATS_CAP = 200;
