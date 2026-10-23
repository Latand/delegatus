import type { Database } from "bun:sqlite";
import { parseSqliteJson } from "@/lib/sqliteReadAttribution";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { TelegramBotRefusal, TelegramChatBot, TelegramLastDelivery, TelegramPostingBot } from "./contracts";
import { scrubTelegramDiagnostic } from "./diagnostics";
import { TelegramBotError, sendFailure } from "./errors";
import { outboundState, releaseUnsentClaim, type PublicationTarget } from "./outbound";
import type { ChatRow, TelegramBotStore } from "./store";
import type { BotCallResult, BotTransport } from "./transport";
import { cloneChatView, cloneInput, clonePayloadSupported, cloneTransport, type ClonePostingPort } from "./clone";
import type { CloneRoute } from "@/lib/externalRelay/cloneDirectory";

export type PostingBot = TelegramPostingBot & { id: string; transport: BotTransport; clone?: CloneRoute };
export type BotAttempt = TelegramBotRefusal & { botId: string };
export type Membership = Omit<TelegramChatBot, "name" | "username" | "assigned"> & { expiresAt: string; source: "check" | "refusal" | "update" };
export const publicBot = (b: Pick<PostingBot, "name" | "username">) => ({ name: b.name, username: b.username });
export const publicRefusals = (attempts: BotAttempt[]) => attempts.map(({ bot, code, reason, source, at }) => ({ bot, code, reason, source, at }));
const mayFallback = (r: BotCallResult, code: string) => !r.ok && (r.classified ? r.classified.fallback : r.kind === "http"
  && ["forbidden", "bot_not_in_chat", "not_enough_rights", "token_rejected"].includes(code));

export function botRows(db: Database): Array<{ bot_id: string; name: string; username: string | null; token_state: "ok" | "rejected" }> {
  return db.query<{ bot_id: string; name: string; username: string | null; token_state: "ok" | "rejected" }, []>(
    "SELECT bot_id, name, username, token_state FROM sending_bots ORDER BY connected_at, rowid").all();
}

/** One owner of bounded, per-pair in-flight checks. Nothing runs on the poll tick. */
export class BotSelector {
  readonly #checks = new Map<string, { transport: BotTransport; work: Promise<Membership | null> }>();
  constructor(private readonly store: TelegramBotStore, private readonly now: () => Date,
    private readonly bots: () => PostingBot[], private readonly clones?: ClonePostingPort) {}

  async check(bot: PostingBot, chat: ChatRow, force = false): Promise<Membership | null> {
    if (chat.type === "private") return null;
    const key = JSON.stringify([chat.chatId, bot.id]);
    const running = this.#checks.get(key);
    if (running?.transport === bot.transport) return running.work;
    const work = withViewerOperation("telegram.membership-check", async () => {
      const old = await this.membership(chat.chatId, bot.id);
      if (!force && old && Date.parse(old.expiresAt) > this.now().getTime()) return old;
      const result = await bot.transport.call<Record<string, unknown>>("getChatMember", {
        chat_id: Number(chat.chatId), user_id: Number(bot.id),
      }, { timeoutMs: 5000 });
      let status: Membership["status"] = null;
      let rights: Record<string, unknown> = {};
      let member: boolean | null = null;
      let reason: string | null = null;
      if (!result.ok) {
        const error = sendFailure(result, chat);
        if (error.code === "token_rejected") { await this.rejectToken(bot); return null; }
        if (!mayFallback(result, error.code)) return null;
        reason = error.code === "not_enough_rights" ? "not_enough_rights" : "bot_not_in_chat";
        member = error.code === "not_enough_rights" ? true : false;
        if (member) rights = { can_send_messages: false, can_send_photos: false, can_send_documents: false };
        if (/kicked/i.test(result.description ?? "")) status = "kicked";
      } else {
        const m = result.result;
        if (!m || !["creator", "administrator", "member", "restricted", "left", "kicked"].includes(String(m.status))) return null;
        status = m.status as Membership["status"];
        member = status !== "left" && status !== "kicked" && !(status === "restricted" && m.is_member === false);
        if (!member) reason = "bot_not_in_chat";
        else if (status === "creator" || (status === "administrator" && (chat.type !== "channel" || m.can_post_messages === true))) {
          rights = { can_send_messages: true, can_send_photos: true, can_send_documents: true,
            can_manage_topics: status === "creator" || m.can_manage_topics === true };
        } else if (chat.type === "channel") rights = { can_send_messages: false, can_send_photos: false, can_send_documents: false };
        else if (status === "restricted") rights = m;
        else {
          const full = await bot.transport.call<{ permissions?: Record<string, unknown> }>("getChat", { chat_id: Number(chat.chatId) }, { timeoutMs: 5000 });
          if (full.ok) rights = full.result?.permissions ?? {};
          else {
            const error = sendFailure(full, chat);
            if (error.code === "token_rejected") { await this.rejectToken(bot); return null; }
            if (!mayFallback(full, error.code)) return null;
            reason = error.code === "not_enough_rights" ? "not_enough_rights" : "bot_not_in_chat";
            member = error.code === "not_enough_rights";
            rights = { can_send_messages: false, can_send_photos: false, can_send_documents: false };
            status = /kicked/i.test(full.description ?? "") ? "kicked" : null;
          }
        }
      }
      const bool = (key: string): boolean | null => member === false ? false : typeof rights[key] === "boolean" ? rights[key] as boolean : null;
      const canPost = bool("can_send_messages");
      if (canPost === false && !reason) reason = "not_enough_rights";
      const at = this.now();
      const row: Membership = { source: "check", member, status, canPost, canSendPhotos: bool("can_send_photos"), canSendDocuments: bool("can_send_documents"),
        canManageTopics: bool("can_manage_topics"), reason, checkedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + ([canPost, bool("can_send_photos"), bool("can_send_documents")].includes(false) ? 10 * 60_000 : 6 * 3600_000)).toISOString() };
      await this.saveMembership(bot, chat, row);
      return row;
    });
    const check = { transport: bot.transport, work };
    this.#checks.set(key, check);
    try { return await work; } finally { if (this.#checks.get(key) === check) this.#checks.delete(key); }
  }

  async observeUpdate(bot: PostingBot, chat: ChatRow, update: Record<string, unknown>): Promise<void> {
    if (chat.type === "private") return;
    const status = update.status as Membership["status"];
    if (!status || !["creator", "administrator", "member", "restricted", "left", "kicked"].includes(status)) return;
    const member = status !== "kicked" && status !== "left" && !(status === "restricted" && update.is_member === false);
    const admin = status === "creator" || (status === "administrator" && (chat.type !== "channel" || update.can_post_messages === true));
    const permission = (key: string): boolean | null => !member ? false : admin ? true
      : chat.type === "channel" ? false : status === "restricted" && typeof update[key] === "boolean" ? update[key] as boolean : null;
    const at = this.now();
    const canPost = permission("can_send_messages");
    await this.saveMembership(bot, chat, { source: "update", member, status, canPost, canSendPhotos: permission("can_send_photos"), canSendDocuments: permission("can_send_documents"),
      canManageTopics: !member ? false : status === "creator" ? true : typeof update.can_manage_topics === "boolean" ? update.can_manage_topics as boolean : null,
      reason: !member ? "bot_not_in_chat" : canPost === false ? "not_enough_rights" : null,
      checkedAt: at.toISOString(), expiresAt: new Date(at.getTime() + (canPost === false ? 600_000 : canPost === null ? 0 : 6 * 3600_000)).toISOString() });
  }

  private membership(chatId: string, botId: string): Promise<Membership | null> {
    return outboundState(this.store.filename, false, db => {
      const row = db.query<{ value_json: string }, [string, string]>("SELECT value_json FROM chat_bots WHERE chat_id=? AND bot_id=?").get(chatId, botId);
      return row ? parseSqliteJson(row.value_json, db) as Membership : null;
    });
  }
  private async saveMembership(bot: PostingBot, chat: ChatRow, row: Membership): Promise<void> {
    await outboundState(this.store.filename, true, db => {
      if (!this.bots().some(b => b.id === bot.id && b.transport === bot.transport) || !db.query("SELECT 1 FROM chats WHERE chat_id=?").get(chat.chatId)) return;
      db.query("INSERT OR REPLACE INTO chat_bots(chat_id, bot_id, value_json) VALUES (?, ?, ?)").run(chat.chatId, bot.id, JSON.stringify(row));
      if (bot.receiving) db.query("UPDATE chats SET bot_status=? WHERE chat_id=?").run(row.status, chat.chatId);
    });
  }

  /** An explicit action checks a bounded page, oldest pairs first on refresh. */
  async refresh(bots: PostingBot[], limit: number, newestFirst = false): Promise<void> {
    const pairs = await outboundState(this.store.filename, false, db => {
      const rows: Array<{ chatId: string; botId: string; checkedAt: string | null; postedAt: string | null }> = [];
      for (const bot of bots) {
        rows.push(...db.query<{ chatId: string; checkedAt: string | null; postedAt: string | null }, [string, number]>(`
          SELECT c.chat_id AS chatId, json_extract(cb.value_json, '$.checkedAt') AS checkedAt, c.last_post_at AS postedAt
          FROM chats c LEFT JOIN chat_bots cb ON cb.chat_id=c.chat_id AND cb.bot_id=?
          WHERE c.post_allowed=1 AND c.type<>'private'
          ORDER BY ${newestFirst ? "c.last_post_at DESC, c.chat_id" : "checkedAt, c.chat_id"} LIMIT ?
        `).all(bot.id, limit).map(row => ({ ...row, botId: bot.id })));
      }
      return rows.sort((a, b) => newestFirst
        ? (b.postedAt ?? "").localeCompare(a.postedAt ?? "") || a.chatId.localeCompare(b.chatId) || a.botId.localeCompare(b.botId)
        : (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "") || a.chatId.localeCompare(b.chatId) || a.botId.localeCompare(b.botId)).slice(0, limit);
    });
    for (const pair of pairs) {
      const bot = bots.find(bot => bot.id === pair.botId);
      const chat = this.store.chat(pair.chatId);
      if (bot && chat && this.bots().some(current => current.id === bot.id)) await this.check(bot, chat, true);
    }
  }
  private async rejectToken(bot: PostingBot): Promise<void> {
    bot.tokenState = "rejected";
    await outboundState(this.store.filename, true, db => {
      if (!this.bots().some(current => current.id === bot.id && current.transport === bot.transport)) return;
      if (bot.receiving) db.query("UPDATE bot SET receiving='token_rejected' WHERE id=1").run();
      else db.query("UPDATE sending_bots SET token_state='rejected' WHERE bot_id=?").run(bot.id);
    });
  }

  /** Snapshots use the store's existing read connection; never call Telegram. */
  view(db: Database, chat: ChatRow, bots: PostingBot[]) {
    const saved = db.query<{ assigned_bot: string | null; last_delivery: string | null }, [string]>("SELECT assigned_bot, last_delivery FROM chats WHERE chat_id=?").get(chat.chatId)!;
    const rows = db.query<{ bot_id: string; value_json: string }, [string]>("SELECT bot_id, value_json FROM chat_bots WHERE chat_id=?").all(chat.chatId);
    const pairs = new Map(rows.map(r => [r.bot_id, parseSqliteJson(r.value_json, db) as Membership]));
    const views: TelegramChatBot[] = bots.filter(b => chat.type !== "private" || b.receiving).map(b => {
      const m = pairs.get(b.id);
      const fresh = m && Date.parse(m.expiresAt) > this.now().getTime();
      const privateMember = chat.botStatus !== "kicked" && chat.botStatus !== "left";
      return { ...publicBot(b), assigned: b.id === saved.assigned_bot,
        member: chat.type === "private" ? privateMember : fresh ? m.member : !m && b.receiving ? privateMember : null,
        status: m?.status ?? (b.receiving ? chat.botStatus : null),
        canPost: b.tokenState === "rejected" ? false : chat.type === "private" ? privateMember : fresh ? m.canPost : !m && b.receiving && !privateMember ? false : null,
        canSendPhotos: fresh ? m.canSendPhotos : null, canSendDocuments: fresh ? m.canSendDocuments : null,
        canManageTopics: fresh ? m.canManageTopics : null, reason: b.tokenState === "rejected" ? "token_rejected" : fresh ? m.reason : null, checkedAt: m?.checkedAt ?? null };
    });
    const clone = !saved.assigned_bot && chat.type !== "private" ? this.clones?.peek(chat.chatId) : null;
    if (clone) views.unshift(cloneChatView(clone));
    return { bots: views, assignedBot: bots.find(b => b.id === saved.assigned_bot)?.username ?? null,
      lastDelivery: saved.last_delivery ? parseSqliteJson(saved.last_delivery, db) as TelegramLastDelivery : null };
  }

  selection(chat: ChatRow, caller: string, key: string, capability: "canPost" | "canSendPhotos" | "canSendDocuments",
    target: (botId: string) => PublicationTarget | null, authorize: () => void) {
    chat = { ...chat };
    const connected = this.bots();
    let retryBot: string | null = null;
    let selected: PostingBot | null = null;
    let pinned = false;
    let publicationTarget: PublicationTarget | null = null;
    const attempts: BotAttempt[] = [];
    const available = (bot: PostingBot) => bot.clone ? this.clones?.valid(bot.clone, chat.chatId) === true : this.bots().some(b => b.id === bot.id);
    const assignedBot = () => outboundState(this.store.filename, false, db => db.query<{ assigned_bot: string | null }, [string]>("SELECT assigned_bot FROM chats WHERE chat_id=?").get(chat.chatId)?.assigned_bot);
    const authorizeClone = async () => {
      if (await assignedBot()) throw new TelegramBotError("chat_not_allowed", "a bot was assigned to this chat");
      authorize();
    };
    const fields = () => ({ ...(selected ? { sentBy: publicBot(selected) } : {}), ...(attempts.length ? { refusals: publicRefusals(attempts) } : {}) });
    const delivery = async (state: TelegramLastDelivery["state"]) => {
      try { await outboundState(this.store.filename, true, db => {
        db.query("UPDATE chats SET last_delivery=? WHERE chat_id=COALESCE((SELECT chat_id FROM sends WHERE caller_key=? AND client_request_id=?), ?)").run(JSON.stringify({ at: this.now().toISOString(), state,
          ...(selected ? { bot: publicBot(selected) } : {}), refusals: publicRefusals(attempts) }), caller, key, chat.chatId);
      }); } catch {
        throw new TelegramBotError("send_uncertain", "the delivery outcome could not be recorded; keep the same send key to avoid a duplicate");
      }
    };
    const record = async (bot: PostingBot, error: TelegramBotError, source: "send" | "check") => {
      const refusal: BotAttempt = { botId: bot.id, bot: publicBot(bot), code: error.code, reason: scrubTelegramDiagnostic(error.message), source, at: this.now().toISOString() };
      const previous = attempts.findIndex(a => a.botId === bot.id);
      if (previous < 0) attempts.push(refusal); else attempts[previous] = refusal;
      // The next bot is unreachable until this transaction has committed.
      await outboundState(this.store.filename, true, db => {
        db.query("UPDATE sends SET attempts=? WHERE caller_key=? AND client_request_id=? AND state='pending'")
          .run(JSON.stringify(attempts), caller, key);
      });
    };
    const refreshRefusal = async (bot: PostingBot, result: Extract<BotCallResult, { ok: false }>, error: TelegramBotError) => {
      if (error.code === "token_rejected") await this.rejectToken(bot);
      else if (chat.type !== "private") {
        const refreshed = await this.check(bot, chat, true);
        /* A closed forum topic says nothing about this bot's chat-wide rights.
           The forced check above owns that cache row, including when it found
           that chat-wide posting itself is unavailable. */
        if (/TOPIC_CLOSED/i.test(result.description ?? "")) return;
        if (!refreshed || refreshed[capability] !== false) {
          const at = this.now();
          await this.saveMembership(bot, chat, { source: "refusal", member: /kicked/i.test(result.description ?? "") ? false : refreshed?.member ?? (error.code === "not_enough_rights"),
            status: /kicked/i.test(result.description ?? "") ? "kicked" : refreshed?.status ?? null,
            canPost: capability === "canPost" ? false : refreshed?.canPost ?? null,
            canSendPhotos: capability === "canSendPhotos" ? false : refreshed?.canSendPhotos ?? null,
            canSendDocuments: capability === "canSendDocuments" ? false : refreshed?.canSendDocuments ?? null,
            canManageTopics: refreshed?.canManageTopics ?? null, reason: error.code, checkedAt: at.toISOString(),
            expiresAt: new Date(at.getTime() + 600_000).toISOString() });
        }
      }
    };
    const transport: BotTransport = { call: async <T,>(method: string, params: Record<string, unknown>, options?: Parameters<BotTransport["call"]>[2]): Promise<BotCallResult<T>> => {
      try {
      if (method === "sendRichMessage") capability = (params.rich_message as { media?: unknown[] } | undefined)?.media?.length ? "canSendPhotos" : "canPost";
      if (selected && !available(selected))
        throw new TelegramBotError("chat_not_allowed", "the selected bot was removed");
      if (pinned && selected) {
        authorize();
        if (!available(selected)) throw new TelegramBotError("chat_not_allowed", "the selected bot was removed");
        const result = await selected.transport.call<T>(method, params, options);
        if (!result.ok) {
          if (result.kind === "network_failed" || result.kind === "timed_out") await delivery("uncertain");
          else {
            const error = sendFailure(result, chat);
            await record(selected, error, "send");
            if (!selected.clone && mayFallback(result, error.code)) await refreshRefusal(selected, result, error);
            await delivery("refused");
          }
        }
        return result;
      }
      const assigned = await assignedBot();
      const bots = connected.filter(b => chat.type !== "private" || b.receiving);
      bots.sort((a, b) => Number(b.id === retryBot) - Number(a.id === retryBot) || Number(b.id === assigned) - Number(a.id === assigned));
      const candidates: Array<{ bot: PostingBot; checked?: boolean; membership?: Membership | null }> = bots.map(bot => ({ bot }));
      if (!assigned && method === "sendMessage" && chat.type !== "private" && this.clones) {
        const route = await this.clones.route(chat.chatId);
        if (route && !await assignedBot() && this.clones.valid(route, chat.chatId)
          && clonePayloadSupported(cloneInput(route, caller, key, params, options?.partIndex ?? 0))) {
          candidates.unshift({ bot: { id: route.id, name: route.name, username: null, receiving: false, tokenState: "ok", clone: route,
            transport: cloneTransport(this.clones, route, caller, key, authorizeClone) }, checked: true });
        }
      }
      for (const candidate of candidates) {
        const bot = candidate.bot;
        const membership = candidate.checked ? candidate.membership ?? null : bot.tokenState === "rejected" ? null : await this.check(bot, chat);
        if (!candidate.checked && chat.type !== "private" && bot.tokenState !== "rejected" && membership?.[capability] == null) {
          // Check only when reached; unknown pairs wait behind known members.
          candidates.push({ bot, checked: true, membership });
          continue;
        }
        if (bot.tokenState === "rejected" || membership?.[capability] === false) {
          const code = bot.tokenState === "rejected" ? "token_rejected" : membership?.member === false ? "bot_not_in_chat" : "not_enough_rights";
          await record(bot, new TelegramBotError(code, code === "bot_not_in_chat" ? "the bot is no longer in the chat" : code === "token_rejected" ? "Telegram rejected the bot token" : "the bot may not post this content here"), "check");
          continue;
        }
        authorize();
        if (!available(bot)) continue;
        selected = bot;
        try { publicationTarget = bot.clone ? null : target(bot.id); }
        catch (error) {
          await releaseUnsentClaim(this.store.filename, caller, key);
          throw error;
        }
        await outboundState(this.store.filename, true, db => {
          authorize();
          if (!available(bot)) throw new TelegramBotError("chat_not_allowed", "the selected bot was removed");
          db.query("UPDATE sends SET bot_id=?, bot_identity=? WHERE caller_key=? AND client_request_id=? AND state='pending'")
            .run(bot.id, JSON.stringify(publicBot(bot)), caller, key);
        });
        authorize();
        if (!available(bot)) throw new TelegramBotError("chat_not_allowed", "the selected bot was removed");
        retryBot = null;
        const result = await bot.transport.call<T>(method, params, options);
        if (result.ok) {
          pinned = true;
          const messages = Array.isArray(result.result) ? result.result : [result.result];
          if (!messages.length || messages.some(m => !m || !Number.isSafeInteger(m.message_id) || m.message_id <= 0 || !Number.isSafeInteger(m.date))) {
            await delivery("uncertain");
            return { ok: false, kind: "network_failed", status: null, description: null, retryAfterSeconds: null, migrateToChatId: null };
          }
          return result;
        }
        if (result.kind === "network_failed" || result.kind === "timed_out") {
          pinned = true;
          await delivery("uncertain");
          return result;
        }
        if (result.migrateToChatId) { retryBot = bot.id; return result; }
        const error = sendFailure(result, chat);
        if (!mayFallback(result, error.code)) {
          await record(bot, error, "send");
          await delivery("refused");
          // A caller may retry a rejected rich payload as bounded text. Keep
          // its bot first, while allowing fallback if that new call is refused.
          retryBot = bot.id;
          return result;
        }
        await record(bot, error, "send");
        if (!bot.clone) await refreshRefusal(bot, result, error);
      }
      const first = attempts[0];
      await delivery("refused");
      await outboundState(this.store.filename, true, db => {
        db.query("UPDATE sends SET state='failed', error_code=? WHERE caller_key=? AND client_request_id=? AND state='pending'").run(first?.code ?? "bot_not_in_chat", caller, key);
      });
      throw new TelegramBotError(first?.code ?? "bot_not_in_chat", first?.reason ?? "no connected bot can post here", { refusals: publicRefusals(attempts) });
      } catch (error) {
        if (pinned && (!(error instanceof TelegramBotError) || error.code !== "send_uncertain"))
          throw new TelegramBotError("send_uncertain", "the selected bot's send could not finish; keep the same send key to avoid a duplicate", { refusals: publicRefusals(attempts) });
        throw error;
      }
    } };
    return { transport, fields, delivery, migrate: (chatId: string) => { chat.chatId = chatId; }, get botId() { return selected?.id ?? null; }, get target() { return publicationTarget; } };
  }
}
