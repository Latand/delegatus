import fs from "node:fs";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { teamTelegramHook } from "@/lib/team";

import { ensureTelegramStateDir, UnsafeTelegramSessionError } from "../sessionStore";

import {
  BOT_CHATS_CAP,
  BOT_MESSAGES_LIMIT,
  BOT_MESSAGES_MAX_CHARS,
  BOT_TEXT_MAX_PARTS,
  BOT_TEXT_PART_CHARS,
  DISCONNECTED_BOT_STATUS,
  RECEIVING_NOTES,
  RETRYABLE_TELEGRAM_BOT_CODES,
  TELEGRAM_BOT_LIMITS,
  validBotToken,
  validTelegramChatId,
  type TelegramBotAgentChat,
  type TelegramBotAttribution,
  type TelegramBotChatView,
  type TelegramBotChatsAnswer,
  type TelegramBotErrorCode,
  type TelegramBotMemberStatus,
  type TelegramBotMessagesAnswer,
  type TelegramBotReceiving,
  type TelegramBotSendAnswer,
  type TelegramBotStatusPayload,
} from "./contracts";
import { TelegramBotStore, type BotRow, type ChatRow, type TgUpdate, type TgUser } from "./store";
import {
  createBotApiTransport,
  removeBotToken,
  saveBotToken,
  withStoredBotToken,
  type BotCallResult,
  type BotTransport,
} from "./transport";

/**
 * The Telegram bot account (`docs/design/telegram-bot-account.md`).
 *
 * One service per process, reached through {@link telegramBotService}: the
 * operator route (connect, refresh, allowlist, remove), the agent route the
 * three Viewer MCP tools call (chats, messages, send), and the update poller
 * the release that owns traffic starts. It never holds the token itself — only
 * the transport built from it, whose one member is `call`.
 */

export class TelegramBotError extends Error {
  constructor(
    readonly code: TelegramBotErrorCode,
    message: string,
    readonly extra: { retryAfterSeconds?: number; sentMessageIds?: number[] } = {},
  ) {
    super(message);
    this.name = "TelegramBotError";
  }

  get retryable(): boolean {
    return RETRYABLE_TELEGRAM_BOT_CODES.has(this.code);
  }
}

export interface TelegramBotDependencies {
  transportFor(token: string): BotTransport;
  openStore(): TelegramBotStore;
  removeStoreFiles(): void;
  saveToken(token: string, botId: string, now: Date): void;
  withStoredToken<T>(use: (token: string, botId: string) => T): T | null;
  removeToken(): void;
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  conversationTitle(conversationId: string): string | null;
  /** The team module's `/start <code>` hook: the reply to send, or null. */
  signInHook?(input: { from: TgUser | undefined; chatType: string; text: string | undefined }): string | null;
}

export type PollStep = { next: "continue"; delayMs: number } | { next: "stop" };

const GET_UPDATES_TIMEOUT_S = 50;
const ALLOWED_UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member"];
const ANOTHER_READER_DELAY_MS = 30_000;
const NETWORK_BACKOFF_MIN_MS = 5_000;
const NETWORK_BACKOFF_MAX_MS = 60_000;

type TgMe = { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string; can_join_groups?: boolean; can_read_all_group_messages?: boolean };
type TgSent = { message_id: number; date: number };

function clampInt(value: unknown, bounds: { min: number; max: number; fallback: number }): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(number)));
}

function isMember(chat: ChatRow): boolean {
  return chat.botStatus !== "left" && chat.botStatus !== "kicked";
}

/** What the bot can see in a chat, and why, in one sentence. */
export function chatVisibility(chat: ChatRow, bot: BotRow | null): { seesAllMessages: boolean; readdToApply: boolean; note: string } {
  if (!isMember(chat)) return { seesAllMessages: false, readdToApply: false, note: "The bot is no longer a member of this chat; it receives nothing here." };
  if (chat.type === "private") return { seesAllMessages: true, readdToApply: false, note: "Sees every message in this private chat." };
  if (chat.type === "channel") return { seesAllMessages: true, readdToApply: false, note: "Sees every post in this channel (a bot joins a channel only as an admin)." };
  if (chat.botStatus === "administrator" || chat.botStatus === "creator") {
    return { seesAllMessages: true, readdToApply: false, note: "Sees all messages: the bot is an admin here." };
  }
  if (bot?.canReadAllGroupMessages) {
    if (bot.readAllSince && chat.firstSeenAt < bot.readAllSince) {
      return {
        seesAllMessages: false,
        readdToApply: true,
        note: "Sees only commands, replies to it and messages meant for it: privacy mode was turned off after the bot joined, so re-add the bot to this group to apply it.",
      };
    }
    return { seesAllMessages: true, readdToApply: false, note: "Sees all messages: privacy mode is off." };
  }
  return { seesAllMessages: false, readdToApply: false, note: "Sees only commands, replies to it and messages meant for it: privacy mode is on." };
}

/** Why an agent may not post here, or null when it may. Allowlist first. */
function postRefusal(chat: ChatRow): { code: TelegramBotErrorCode; reason: string } | null {
  if (!chat.alias || !chat.postAllowed) {
    return {
      code: "chat_not_allowed",
      reason: `the operator has not allowed posting to ${chat.title}; ask them to allow it in the Telegram panel (a chat needs an alias and "Agents may post" switched on)`,
    };
  }
  if (!isMember(chat)) {
    return { code: "bot_not_in_chat", reason: `the bot is no longer a member of ${chat.title}; add it back to the chat to post there` };
  }
  return null;
}

/**
 * Splits plain text into Telegram-sized parts at paragraph, then line, then
 * character boundaries. HTML is never split, because a split can cut a tag.
 */
export function splitMessageText(text: string, format: "plain" | "html"): string[] {
  if (text.length <= BOT_TEXT_PART_CHARS) return [text];
  if (format === "html") {
    throw new TelegramBotError("text_too_long", `HTML text is limited to ${BOT_TEXT_PART_CHARS} characters; send plain text or split it`);
  }
  if (text.length > BOT_TEXT_PART_CHARS * BOT_TEXT_MAX_PARTS) {
    throw new TelegramBotError("text_too_long", `text is limited to ${BOT_TEXT_PART_CHARS * BOT_TEXT_MAX_PARTS} characters (${BOT_TEXT_MAX_PARTS} messages of ${BOT_TEXT_PART_CHARS}); shorten it`);
  }
  const parts: string[] = [];
  let rest = text;
  while (rest.length > BOT_TEXT_PART_CHARS) {
    const window = rest.slice(0, BOT_TEXT_PART_CHARS);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const cut = paragraph > BOT_TEXT_PART_CHARS / 4 ? paragraph + 2 : line > BOT_TEXT_PART_CHARS / 4 ? line + 1 : BOT_TEXT_PART_CHARS;
    parts.push(rest.slice(0, cut).replace(/\s+$/, ""));
    rest = rest.slice(cut);
  }
  if (rest.trim() !== "") parts.push(rest.replace(/\s+$/, ""));
  if (parts.length > BOT_TEXT_MAX_PARTS) {
    throw new TelegramBotError("text_too_long", `text does not fit in ${BOT_TEXT_MAX_PARTS} messages; shorten it`);
  }
  return parts;
}

/** Telegram's refusal of a send, as one of our codes. */
function sendFailure(result: Extract<BotCallResult, { ok: false }>, chat: ChatRow): TelegramBotError {
  const detail = result.description ? ` (Telegram: ${result.description})` : "";
  if (result.kind === "unreachable") return new TelegramBotError("network_failed", "Telegram could not be reached, so nothing was sent");
  /* A connection that failed after it opened may have carried the post. */
  if (result.kind === "network_failed") return new TelegramBotError("network_failed", "the connection to Telegram failed; the message may or may not have been posted");
  if (result.kind === "timed_out") return new TelegramBotError("timed_out", "Telegram did not answer in time; the message may or may not have been posted");
  if (result.status === 429) {
    return new TelegramBotError("rate_limited", `Telegram is rate-limiting this bot; retry after ${result.retryAfterSeconds ?? 1} s${detail}`, { retryAfterSeconds: result.retryAfterSeconds ?? 1 });
  }
  if (result.status === 401 || result.status === 404) return new TelegramBotError("token_rejected", "Telegram rejected the bot token; the operator must paste a new one in the Telegram panel");
  if (result.status === 403) {
    return new TelegramBotError("forbidden", `Telegram refused the post to ${chat.title}: the bot was blocked or removed, lacks the right to post, or the user never wrote to it${detail}`);
  }
  if (result.status === 400 && /parse entities|can't parse|unsupported start tag|unexpected end tag/i.test(result.description ?? "")) {
    return new TelegramBotError("format_invalid", `Telegram could not parse the HTML formatting${detail}`);
  }
  if (result.status !== null && result.status >= 500) return new TelegramBotError("telegram_failed", `Telegram failed to handle the request${detail}`);
  return new TelegramBotError("bad_request", `Telegram refused the message${detail}`);
}

export class TelegramBotService {
  private transportCache: BotTransport | null = null;
  private storeCache: TelegramBotStore | null = null;
  private poller: { controller: AbortController; done: Promise<void> } | null = null;
  /** Set when the poller stopped on a state only the operator can change;
      cleared by connect and refresh. */
  private parked = false;
  private offset: number | null = null;
  private backoffMs = NETWORK_BACKOFF_MIN_MS;

  constructor(private readonly deps: TelegramBotDependencies) {}

  /* ---- plumbing --------------------------------------------------------- */

  private storedBotId(): string | null {
    return this.deps.withStoredToken((_token, botId) => botId);
  }

  private transport(): BotTransport | null {
    if (this.transportCache) return this.transportCache;
    this.transportCache = this.deps.withStoredToken((token) => this.deps.transportFor(token));
    return this.transportCache;
  }

  /** Opened only once a token exists, so a build or a route import never
      creates the file (#1905). */
  private store(): TelegramBotStore {
    this.storeCache ??= this.deps.openStore();
    return this.storeCache;
  }

  private connectedStore(): TelegramBotStore {
    if (this.storedBotId() === null) {
      throw new TelegramBotError("bot_not_connected", "no Telegram bot is connected; the operator connects one in the Telegram panel");
    }
    return this.store();
  }

  private setReceiving(receiving: TelegramBotReceiving): void {
    try { this.storeCache?.setReceiving(receiving); } catch { /* status is advisory */ }
  }

  private lastPostBy(chat: ChatRow): TelegramBotChatView["lastPostBy"] {
    if (!chat.lastPostAt) return null;
    if (!chat.lastPostConversationId) return { unidentified: true };
    let title: string | null = null;
    try { title = this.deps.conversationTitle(chat.lastPostConversationId); } catch { /* title is decoration */ }
    return { conversationId: chat.lastPostConversationId, title };
  }

  /** The stored state while this process polls; otherwise only the states
      that outlive a poller, because nothing else here is reading. */
  private receiving(bot: BotRow | null): TelegramBotReceiving {
    if (this.poller) return !bot || bot.receiving === "stopped" ? "polling" : bot.receiving;
    return bot?.receiving === "webhook_elsewhere" || bot?.receiving === "token_rejected" ? bot.receiving : "stopped";
  }

  /* ---- the operator surface -------------------------------------------- */

  status(): TelegramBotStatusPayload {
    if (this.storedBotId() === null) return { ...DISCONNECTED_BOT_STATUS };
    const store = this.store();
    const bot = store.bot();
    return {
      connected: true,
      bot: bot ? { name: bot.name, username: bot.username, canReadAllGroupMessages: bot.canReadAllGroupMessages, canJoinGroups: bot.canJoinGroups } : null,
      receiving: this.receiving(bot),
      lastUpdateAt: bot?.lastUpdateAt ?? null,
      lastCheckedAt: bot?.lastCheckedAt ?? null,
      chats: store.chats().map((chat) => {
        const visibility = chatVisibility(chat, bot);
        return {
          chatId: chat.chatId,
          title: chat.title,
          type: chat.type,
          username: chat.username,
          isForum: chat.isForum,
          member: isMember(chat),
          alias: chat.alias,
          postAllowed: chat.postAllowed,
          postable: postRefusal(chat) === null,
          seesAllMessages: visibility.seesAllMessages,
          readdToApply: visibility.readdToApply,
          lastMessageAt: chat.lastMessageAt,
          lastPostAt: chat.lastPostAt,
          lastPostBy: this.lastPostBy(chat),
          storedMessages: chat.storedMessages,
        };
      }),
      limits: TELEGRAM_BOT_LIMITS,
    };
  }

  private async readIdentity(transport: BotTransport): Promise<TgMe> {
    const me = await transport.call<TgMe>("getMe", {});
    if (!me.ok) {
      if (me.kind === "http" && (me.status === 401 || me.status === 404)) {
        throw new TelegramBotError("token_rejected", "Telegram rejected this token; copy it again from @BotFather");
      }
      if (me.kind === "network_failed" || me.kind === "unreachable") throw new TelegramBotError("network_failed", "Telegram could not be reached");
      if (me.kind === "timed_out") throw new TelegramBotError("timed_out", "Telegram did not answer in time");
      throw new TelegramBotError("telegram_failed", "Telegram could not check this token");
    }
    if (!me.result || me.result.is_bot !== true || !Number.isSafeInteger(me.result.id)) {
      throw new TelegramBotError("not_a_bot", "this token does not belong to a bot");
    }
    return me.result;
  }

  private saveIdentity(store: TelegramBotStore, me: TgMe): void {
    store.saveIdentity({
      name: [me.first_name, me.last_name].filter(Boolean).join(" ") || "Bot",
      username: me.username ?? null,
      canReadAllGroupMessages: me.can_read_all_group_messages === true,
      canJoinGroups: me.can_join_groups === true,
    }, this.deps.now());
  }

  /** True when another program has pointed this bot at a webhook. Delegatus
      never deletes one: whatever set it would silently stop working. */
  private async webhookElsewhere(transport: BotTransport): Promise<boolean> {
    const info = await transport.call<{ url?: string }>("getWebhookInfo", {});
    return info.ok && typeof info.result?.url === "string" && info.result.url !== "";
  }

  async connect(token: unknown): Promise<TelegramBotStatusPayload> {
    if (!validBotToken(token)) {
      throw new TelegramBotError("invalid_token", "that is not a bot token; BotFather's tokens look like 123456789:AA… (digits, a colon, then letters)");
    }
    const transport = this.deps.transportFor(token);
    const me = await this.readIdentity(transport);
    const botId = String(me.id);
    const existing = this.storedBotId();
    if (existing !== null && existing !== botId) {
      throw new TelegramBotError("bot_already_connected", "a different bot is already connected; remove the current bot first");
    }
    await this.stopPoller();
    this.deps.saveToken(token, botId, this.deps.now());
    this.transportCache = transport;
    this.offset = null;
    this.parked = false;
    const store = this.store();
    this.saveIdentity(store, me);
    if (await this.webhookElsewhere(transport)) {
      store.setReceiving("webhook_elsewhere");
      this.parked = true;
    } else {
      this.ensurePoller();
    }
    return this.status();
  }

  async refresh(): Promise<TelegramBotStatusPayload> {
    const transport = this.transport();
    if (!transport) return this.status();
    const store = this.store();
    let me: TgMe;
    try {
      me = await this.readIdentity(transport);
    } catch (error) {
      if (error instanceof TelegramBotError && error.code === "token_rejected") {
        await this.stopPoller();
        store.setReceiving("token_rejected");
        this.parked = true;
        return this.status();
      }
      throw error;
    }
    this.saveIdentity(store, me);
    if (await this.webhookElsewhere(transport)) {
      await this.stopPoller();
      store.setReceiving("webhook_elsewhere");
      this.parked = true;
    } else {
      this.parked = false;
      if (!this.poller) this.ensurePoller();
    }
    return this.status();
  }

  setChat(chatId: unknown, alias: unknown, postAllowed: unknown): TelegramBotStatusPayload {
    const store = this.connectedStore();
    const id = validTelegramChatId(chatId);
    if (id === null) throw new TelegramBotError("chat_unknown", "no such chat");
    const outcome = store.setChatSettings(id, {
      alias: typeof alias === "string" ? alias : null,
      postAllowed: postAllowed === true,
    });
    if (outcome === "chat_unknown") throw new TelegramBotError("chat_unknown", "no such chat");
    if (outcome === "alias_invalid") throw new TelegramBotError("alias_invalid", "an alias is 1–32 lowercase letters, digits, - or _, starting with a letter or digit, and not digits alone");
    if (outcome === "alias_taken") throw new TelegramBotError("alias_taken", "another chat already has that alias");
    return this.status();
  }

  /** Local only: Telegram's `logOut` moves a bot to a local Bot API server,
      which is not what removing it here means. Revoking the token is done in
      @BotFather, and the panel says so. */
  async remove(): Promise<TelegramBotStatusPayload> {
    await this.stopPoller();
    this.storeCache?.close();
    this.storeCache = null;
    this.transportCache = null;
    this.offset = null;
    this.parked = false;
    this.deps.removeToken();
    this.deps.removeStoreFiles();
    return { ...DISCONNECTED_BOT_STATUS };
  }

  /* ---- the update poller ----------------------------------------------- */

  pollerRunning(): boolean {
    return this.poller !== null;
  }

  /** Starts the poller unless one runs, no bot is connected, or it parked on
      a state only the operator can change (a webhook, a rejected token). */
  ensurePoller(): void {
    if (this.poller || this.parked || this.storedBotId() === null) return;
    const controller = new AbortController();
    const done = this.runPoller(controller.signal).finally(() => {
      if (this.poller?.controller === controller) this.poller = null;
    });
    this.poller = { controller, done };
  }

  async stopPoller(): Promise<void> {
    const poller = this.poller;
    if (!poller) return;
    poller.controller.abort();
    await poller.done.catch(() => {});
  }

  private async runPoller(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let step: PollStep;
      try {
        step = await this.pollOnce(signal);
      } catch (error) {
        console.error("[telegram bot] poll failed", error instanceof Error ? error.name : "unknown");
        if (error instanceof UnsafeTelegramSessionError) {
          this.parked = true;
          return;
        }
        step = { next: "continue", delayMs: this.nextBackoff() };
      }
      if (step.next === "stop") {
        this.parked = true;
        return;
      }
      if (step.delayMs > 0 && !signal.aborted) await this.deps.sleep(step.delayMs, signal);
    }
  }

  private nextBackoff(): number {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(NETWORK_BACKOFF_MAX_MS, this.backoffMs * 2);
    return delay;
  }

  /**
   * One `getUpdates` round and what it means for the next one. Only after the
   * batch is committed does the offset move past it: Telegram's confirmed
   * offset is the cursor, and nothing else is persisted.
   */
  async pollOnce(signal: AbortSignal): Promise<PollStep> {
    const transport = this.transport();
    if (!transport) return { next: "stop" };
    const store = this.store();
    const result = await transport.call<TgUpdate[]>("getUpdates", {
      ...(this.offset !== null ? { offset: this.offset } : {}),
      timeout: GET_UPDATES_TIMEOUT_S,
      allowed_updates: ALLOWED_UPDATES,
    }, { signal, timeoutMs: (GET_UPDATES_TIMEOUT_S + 15) * 1000 });
    if (signal.aborted) return { next: "stop" };
    if (result.ok) {
      const now = this.deps.now();
      const updates = Array.isArray(result.result) ? result.result : [];
      const applied = store.applyUpdates(updates, now);
      if (applied.maxUpdateId !== null) this.offset = applied.maxUpdateId + 1;
      await this.answerSignIns(transport, updates, signal);
      const botId = Number(this.storedBotId());
      for (const chatId of applied.needsMembership) {
        const member = await transport.call<{ status?: string }>("getChatMember", { chat_id: Number(chatId), user_id: botId }, { signal });
        if (member.ok && typeof member.result?.status === "string") {
          store.setMemberStatus(chatId, member.result.status as TelegramBotMemberStatus, true);
        }
      }
      if (applied.touched.length) store.retain(applied.touched, now);
      store.setReceiving("polling");
      this.backoffMs = NETWORK_BACKOFF_MIN_MS;
      return { next: "continue", delayMs: 0 };
    }
    if (result.kind === "http" && result.status === 409) {
      if (await this.webhookElsewhere(transport)) {
        store.setReceiving("webhook_elsewhere");
        return { next: "stop" };
      }
      store.setReceiving("another_reader");
      return { next: "continue", delayMs: ANOTHER_READER_DELAY_MS };
    }
    if (result.kind === "http" && (result.status === 401 || result.status === 404)) {
      store.setReceiving("token_rejected");
      return { next: "stop" };
    }
    if (result.kind === "http" && result.status === 429) {
      store.setReceiving("polling");
      return { next: "continue", delayMs: Math.max(1, result.retryAfterSeconds ?? 1) * 1000 };
    }
    store.setReceiving("network_error");
    return { next: "continue", delayMs: this.nextBackoff() };
  }

  /**
   * Sign-in through the bot (sign-in-and-team §5.3). A private `/start <code>`
   * is handed to the team module — `from` and the text only —
   * and the bot answers in that chat with what happened. The message itself
   * was stored above like any other; a failed reply is only a reply.
   */
  private async answerSignIns(transport: BotTransport, updates: readonly TgUpdate[], signal: AbortSignal): Promise<void> {
    for (const update of updates) {
      const message = update.message;
      if (!message || message.chat.type !== "private" || !message.text?.startsWith("/start")) continue;
      const reply = this.deps.signInHook?.({ from: message.from, chatType: message.chat.type, text: message.text }) ?? null;
      if (!reply || signal.aborted) continue;
      try {
        await transport.call("sendMessage", { chat_id: message.chat.id, text: reply }, { signal });
      } catch {
        /* the sign-in page still shows the outcome */
      }
    }
  }

  /* ---- the agent surface ----------------------------------------------- */

  private agentChat(chat: ChatRow, bot: BotRow | null): TelegramBotAgentChat {
    const visibility = chatVisibility(chat, bot);
    const refusal = postRefusal(chat);
    return {
      chat: chat.alias ?? chat.chatId,
      chatId: chat.chatId,
      alias: chat.alias,
      title: chat.title,
      type: chat.type,
      isForum: chat.isForum,
      member: isMember(chat),
      postAllowed: refusal === null,
      postRefusal: refusal?.reason ?? null,
      seesAllMessages: visibility.seesAllMessages,
      visibilityNote: visibility.note,
      lastMessageAt: chat.lastMessageAt,
      storedMessages: chat.storedMessages,
    };
  }

  listChats(options: { includeInactive?: boolean } = {}): TelegramBotChatsAnswer {
    if (this.storedBotId() === null) {
      return {
        bot: { connected: false, name: null, username: null, receiving: "stopped", receivingNote: RECEIVING_NOTES.stopped, lastUpdateAt: null },
        chats: [],
        note: "No Telegram bot is connected. The operator connects one in Delegatus: footer → Telegram → Bot.",
        limits: TELEGRAM_BOT_LIMITS,
      };
    }
    const status = this.status();
    const store = this.store();
    const bot = store.bot();
    const all = store.chats().filter((chat) => options.includeInactive || isMember(chat));
    const chats = all.slice(0, BOT_CHATS_CAP).map((chat) => this.agentChat(chat, bot));
    return {
      bot: {
        connected: true,
        name: bot?.name ?? null,
        username: bot?.username ?? null,
        receiving: status.receiving,
        receivingNote: RECEIVING_NOTES[status.receiving],
        lastUpdateAt: bot?.lastUpdateAt ?? null,
      },
      chats,
      ...(all.length > chats.length ? { truncated: all.length - chats.length } : {}),
      ...(chats.length === 0
        ? { note: "The bot has not seen any chat yet. A chat appears once the bot is added to it or receives a message there; in a group with privacy mode on, mention the bot once (for example /start@botname)." }
        : {}),
      limits: TELEGRAM_BOT_LIMITS,
    };
  }

  private resolveChat(store: TelegramBotStore, reference: unknown): ChatRow {
    const chat = typeof reference === "string" ? store.resolveChat(reference) : null;
    if (!chat) {
      throw new TelegramBotError("chat_unknown", `no chat named ${typeof reference === "string" && reference.trim() ? JSON.stringify(reference.trim().slice(0, 64)) : "(empty)"}; list them with telegram_bot_chats`);
    }
    return chat;
  }

  readMessages(input: { chat: unknown; limit?: unknown; cursor?: unknown; since?: unknown; maxChars?: unknown }): TelegramBotMessagesAnswer {
    const store = this.connectedStore();
    const chat = this.resolveChat(store, input.chat);
    const bot = store.bot();
    const sinceMs = typeof input.since === "string" ? Date.parse(input.since) : Number.NaN;
    const page = store.messagesPage(chat.chatId, {
      limit: clampInt(input.limit, BOT_MESSAGES_LIMIT),
      cursor: typeof input.cursor === "string" ? input.cursor : undefined,
      since: Number.isFinite(sinceMs) ? Math.floor(sinceMs / 1000) : null,
      maxChars: clampInt(input.maxChars, BOT_MESSAGES_MAX_CHARS),
    });
    const visibility = chatVisibility(chat, bot);
    return {
      chat: {
        chat: chat.alias ?? chat.chatId,
        chatId: chat.chatId,
        alias: chat.alias,
        title: chat.title,
        type: chat.type,
        seesAllMessages: visibility.seesAllMessages,
        visibilityNote: visibility.note,
      },
      ...page,
      limits: TELEGRAM_BOT_LIMITS,
    };
  }

  /**
   * Posts to an allowlisted chat, attributed to the calling conversation that
   * the ROUTE resolved from the forwarded capability — never an argument.
   * Every allowlist refusal happens before the transport is touched.
   */
  async send(input: {
    conversationId: string | null;
    clientRequestId: unknown;
    chat: unknown;
    text: unknown;
    format?: unknown;
    replyToMessageId?: unknown;
    topicId?: unknown;
    silent?: unknown;
  }): Promise<TelegramBotSendAnswer> {
    const store = this.connectedStore();
    const chat = this.resolveChat(store, input.chat);
    const refusal = postRefusal(chat);
    if (refusal) throw new TelegramBotError(refusal.code, refusal.reason);
    if (typeof input.clientRequestId !== "string" || input.clientRequestId.trim() === "") {
      throw new TelegramBotError("bad_request", "clientRequestId is required");
    }
    if (typeof input.text !== "string" || input.text.trim() === "") throw new TelegramBotError("text_empty", "text is empty");
    const format = input.format === "html" ? "html" : "plain";
    const parts = splitMessageText(input.text, format);
    const replyTo = typeof input.replyToMessageId === "number" && Number.isSafeInteger(input.replyToMessageId) && input.replyToMessageId > 0 ? input.replyToMessageId : null;
    const topicId = typeof input.topicId === "number" && Number.isSafeInteger(input.topicId) && input.topicId > 0 ? input.topicId : null;
    const attributedTo: TelegramBotAttribution = input.conversationId ? { conversationId: input.conversationId } : { unidentified: true };
    const callerKey = input.conversationId ?? "unidentified";
    const clientRequestId = input.clientRequestId.trim();

    const claim = store.claimSend(callerKey, clientRequestId, chat.chatId, this.deps.now());
    if (!claim.claimed) {
      if (claim.row.state === "sent") {
        const current = store.chat(claim.row.chatId);
        return {
          chat: current?.alias ?? claim.row.chatId,
          chatId: claim.row.chatId,
          messageIds: claim.row.messageIds,
          sentAt: claim.row.sentAt ?? this.deps.now().toISOString(),
          attributedTo,
          parts: claim.row.parts,
          alreadySent: true,
        };
      }
      if (claim.row.state === "failed") {
        throw new TelegramBotError("send_partial", `an earlier send under this clientRequestId posted only part of its text (message ids ${claim.row.messageIds.join(", ")}); send only the remaining text, under a new clientRequestId`, { sentMessageIds: claim.row.messageIds });
      }
      throw new TelegramBotError("send_uncertain", "an earlier send under this clientRequestId never finished, so it may already be posted and the bot cannot check; send again under a new clientRequestId only if a duplicate is acceptable");
    }

    const transport = this.transport();
    if (!transport) throw new TelegramBotError("bot_not_connected", "no Telegram bot is connected; the operator connects one in the Telegram panel");
    let chatId = chat.chatId;
    let migrated = false;
    const sent: Array<{ messageId: number; date: number; text: string; replyToMessageId: number | null; topicId: number | null }> = [];
    for (let index = 0; index < parts.length; index += 1) {
      const text = parts[index]!;
      const partReply = index === 0 ? replyTo : null;
      const params = {
        chat_id: Number(chatId),
        text,
        ...(format === "html" ? { parse_mode: "HTML" } : {}),
        ...(partReply !== null ? { reply_parameters: { message_id: partReply, allow_sending_without_reply: true } } : {}),
        ...(topicId !== null ? { message_thread_id: topicId } : {}),
        ...(input.silent === true ? { disable_notification: true } : {}),
      };
      let result = await transport.call<TgSent>("sendMessage", params);
      if (!result.ok && result.migrateToChatId && !migrated) {
        migrated = true;
        store.migrateChat(chatId, result.migrateToChatId);
        chatId = result.migrateToChatId;
        result = await transport.call<TgSent>("sendMessage", { ...params, chat_id: Number(chatId) });
      }
      if (!result.ok) {
        const error = sendFailure(result, chat);
        if (sent.length) {
          store.completeSend({ callerKey, clientRequestId, chatId, conversationId: input.conversationId, sent, now: this.deps.now() });
          store.failSend(callerKey, clientRequestId, "send_partial", sent.map((message) => message.messageId));
          throw new TelegramBotError("send_partial", `parts 1–${sent.length} of ${parts.length} were posted (message ids ${sent.map((message) => message.messageId).join(", ")}); the rest failed: ${error.message}. Send only the remaining text, under a new clientRequestId`, { sentMessageIds: sent.map((message) => message.messageId) });
        }
        if (result.kind === "timed_out" || result.kind === "network_failed") {
          /* Telegram may have posted it. The row stays pending, so a retry
             under this key answers send_uncertain instead of posting twice. */
          const why = result.kind === "timed_out" ? "Telegram did not answer in time" : "the connection to Telegram failed mid-request";
          throw new TelegramBotError("send_uncertain", `${why}, so the message may already be posted and the bot cannot check; send again under a new clientRequestId only if a duplicate is acceptable`);
        }
        store.failSend(callerKey, clientRequestId, error.code, []);
        throw error;
      }
      sent.push({ messageId: result.result.message_id, date: result.result.date, text, replyToMessageId: partReply, topicId });
    }
    const now = this.deps.now();
    store.completeSend({ callerKey, clientRequestId, chatId, conversationId: input.conversationId, sent, now });
    const current = store.chat(chatId);
    return {
      chat: current?.alias ?? chatId,
      chatId,
      messageIds: sent.map((message) => message.messageId),
      sentAt: now.toISOString(),
      attributedTo,
      parts: sent.length,
      alreadySent: false,
    };
  }
}

/* ---- production wiring --------------------------------------------------- */

const STORE_FILE = "bot.sqlite";

/** The real token file and store. Tests replace the transport, the clock and
    the sleep, and keep the rest. */
export function productionTelegramBotDependencies(): TelegramBotDependencies {
  return {
    transportFor: (token) => createBotApiTransport(token),
    openStore: () => {
      const directory = ensureTelegramStateDir(true)!;
      return new TelegramBotStore(path.join(directory, STORE_FILE));
    },
    removeStoreFiles: () => {
      const directory = ensureTelegramStateDir(false);
      if (directory === null) return;
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.rmSync(path.join(directory, `${STORE_FILE}${suffix}`), { force: true }); } catch { /* best effort */ }
      }
    },
    saveToken: saveBotToken,
    withStoredToken: withStoredBotToken,
    removeToken: removeBotToken,
    now: () => new Date(),
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    }),
    signInHook: (input) => teamTelegramHook(input),
    conversationTitle: (conversationId) => {
      const conversation = agentRegistry().conversation(conversationId as Parameters<ReturnType<typeof agentRegistry>["conversation"]>[0]);
      const title = conversation?.generations.at(-1)?.launchProfile.title;
      return typeof title === "string" && title.trim() ? title : null;
    },
  };
}

/* One service per process: route bundles and instrumentation can load
   separate copies of this module (the reportRunner pattern). */
const host = globalThis as typeof globalThis & { __llvTelegramBotService?: TelegramBotService };

export function telegramBotService(): TelegramBotService {
  return host.__llvTelegramBotService ??= new TelegramBotService(productionTelegramBotDependencies());
}

/** Tests only; `null` drops the installed service. */
export function setTelegramBotServiceForTests(service: TelegramBotService | null): void {
  if (service) host.__llvTelegramBotService = service;
  else delete host.__llvTelegramBotService;
}

/** Started by the release that owns traffic and by the operator route. Does
    nothing without a stored token. */
export function ensureTelegramBotPoller(): void {
  telegramBotService().ensurePoller();
}
