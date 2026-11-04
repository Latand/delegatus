"use client";

import { useRef, useState } from "react";

import type { TelegramBotState } from "@/hooks/useTelegramBot";
import { type TFunction, useLocale } from "@/lib/i18n";
import { suggestChatAlias, type TelegramBotChatView, type TelegramBotRefusal, type TelegramBotReceiving, validChatAlias } from "@/lib/telegram/bot/contracts";

import { ActionButton } from "./TelegramControls";

/**
 * The bot's forms and its chat row, which the setup guide and the orchestrator's
 * reports draw as they are; the bot's settings themselves are the Telegram
 * section of the Settings window (`settings/TelegramSection.tsx`). The token
 * input is uncontrolled and cleared before the request starts, so the secret is
 * never React state and never rendered back.
 */

type Key = Parameters<TFunction>[0];

export const ERROR_KEYS: Record<string, Key> = {
  invalid_token: "telegram.bot.err.invalid_token",
  not_a_bot: "telegram.bot.err.not_a_bot",
  bot_already_connected: "telegram.bot.err.bot_already_connected",
  token_rejected: "telegram.bot.err.token_rejected",
  network_failed: "telegram.bot.err.network_failed",
  timed_out: "telegram.bot.err.network_failed",
  alias_invalid: "telegram.bot.err.alias_invalid",
  alias_taken: "telegram.bot.err.alias_taken",
  storage_unsafe: "telegram.bot.err.storage_unsafe",
  chat_reference_invalid: "telegram.bot.err.chat_reference_invalid",
  chat_unknown: "telegram.bot.err.chat_unknown",
  bot_not_in_chat: "telegram.bot.err.bot_not_in_chat",
  chat_not_allowed: "telegram.bot.err.chat_not_allowed",
  forbidden: "telegram.bot.err.forbidden",
  not_enough_rights: "telegram.bot.err.not_enough_rights",
  rate_limited: "telegram.bot.err.rate_limited",
  document_roots_invalid: "telegram.bot.err.document_roots_invalid",
  transport: "telegram.actionUnreachable",
};

export function receivingKey(receiving: TelegramBotReceiving): Key {
  return `telegram.bot.receiving.${receiving}` as Key;
}

export function formatTime(iso: string | null, locale?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale ?? [], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

const inputClass = "h-11 min-w-0 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8";
const roomyField = "min-h-9 min-w-0 rounded-control border border-border bg-well px-2.5 text-body text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-55 max-sm:min-h-11";
const roomyButton = "min-h-9 shrink-0 rounded-control border border-border bg-card px-3 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 max-sm:min-h-11 max-sm:text-body";

/**
 * A chat's posting switch and alias, shared by every surface that draws a chat.
 * Switching on a chat with no alias adopts the one suggested from its title, so
 * allowing a chat is one tap. The field appears once posting is on, to rename,
 * or while off when the title suggests nothing.
 */
export function useChatPosting(chat: TelegramBotChatView, onSave: (chatId: string, alias: string, postAllowed: boolean) => void) {
  const saved = chat.alias ?? "";
  const [alias, setAlias] = useState(saved);
  /* A save that came back renames the field (the render-time reset). */
  const [shownSaved, setShownSaved] = useState(saved);
  if (shownSaved !== saved) {
    setShownSaved(saved);
    setAlias(saved);
  }
  /* Set from the switch's pointerdown, which comes before the field's blur:
     that blur leaves the save to the switch, whose one request carries the
     field. A blur save first would disable the switch mid-tap. */
  const switching = useRef(false);
  const draft = alias.trim().toLowerCase();
  const suggestion = suggestChatAlias(chat.title);
  const posting = chat.postAllowed && saved !== "";
  const adopt = draft || suggestion;
  const showField = (chat.member || posting) && (posting || suggestion === "");
  const toggle = () => {
    if (posting) onSave(chat.chatId, validChatAlias(draft) ? draft : saved, false);
    else if (adopt !== "") onSave(chat.chatId, adopt, true);
  };
  const blur = () => {
    const toSwitch = switching.current;
    switching.current = false;
    /* A rename of a chat agents already post to; a chat that is off takes its alias from the switch. */
    if (!toSwitch && posting && draft !== saved) onSave(chat.chatId, draft, true);
  };
  const pressStart = () => { switching.current = true; };
  const fieldFocus = () => { switching.current = false; };
  return { alias, setAlias, draft, suggestion, posting, adopt, showField, toggle, blur, pressStart, fieldFocus };
}

/** Why a bot could not post: the chat row's words for a stored refusal. */
export function telegramRefusalLabel(t: TFunction, chat: TelegramBotChatView, refusal: TelegramBotRefusal): string {
  const bot = chat.bots?.find(bot => bot.username === refusal.bot.username);
  return bot?.status === "kicked" ? t("telegram.bot.removedFromChat")
    : refusal.code === "bot_not_in_chat" ? t("telegram.bot.notInChat")
    : refusal.code === "forbidden" || refusal.code === "not_enough_rights" ? t("telegram.bot.mayNotPost")
    : refusal.code === "token_rejected" ? t("telegram.bot.tokenRejected")
    : t(ERROR_KEYS[refusal.code] ?? "telegram.actionFailed");
}

/** One chat: title, type chip and the posting switch on one line. */
export function ChatRow({ chat, botSeesAll, busy, onSave, onAssign }: { onAssign?: (chatId: string, bot: string | null) => void; chat: TelegramBotChatView; botSeesAll: boolean; busy: boolean; onSave: (chatId: string, alias: string, postAllowed: boolean) => void }) {
  const { t } = useLocale();
  const { alias, setAlias, draft, suggestion, posting, adopt, showField, toggle, blur, pressStart, fieldFocus } = useChatPosting(chat, onSave);
  const lastPost = formatTime(chat.lastPostAt);
  const lastPostBy = chat.lastPostBy
    ? "unidentified" in chat.lastPostBy ? t("telegram.bot.unidentified") : chat.lastPostBy.title ?? chat.lastPostBy.conversationId
    : null;
  /* Only what differs from the bot-wide privacy state, with its reason. */
  const group = chat.type === "group" || chat.type === "supergroup";
  const visibility = !chat.member || !group ? null
    : chat.readdToApply ? t("telegram.bot.readd")
    : chat.seesAllMessages && !botSeesAll ? t("telegram.bot.seesAllAdmin")
    : null;
  const refusalLabel = (refusal: TelegramBotRefusal) => telegramRefusalLabel(t, chat, refusal);
  return (
    <li className={`flex flex-col gap-1 rounded-[9px] border border-border py-0.5 pl-2 pr-0.5 ${chat.member || posting ? "" : "opacity-60"}`}>
      <div className="flex min-w-0 items-center gap-1">
        <div className="flex min-h-[44px] min-w-0 flex-1 items-center gap-1 sm:min-h-[28px]">
          <span className="min-w-0 truncate text-[11.5px] font-semibold text-primary">{chat.title}</span>
          <span className="shrink-0 rounded-full bg-sunken px-1.5 py-px text-[9.5px] font-semibold text-muted">{t(`telegram.bot.type.${chat.type}` as Key)}</span>
          {chat.isForum ? <span className="shrink-0 rounded-full bg-sunken px-1.5 py-px text-[9.5px] font-semibold text-muted">{t("telegram.bot.forum")}</span> : null}
        </div>
        {chat.member || posting ? (
          <button
            type="button"
            role="switch"
            aria-checked={posting}
            aria-label={`${t("telegram.bot.mayPost")}: ${chat.title}`}
            disabled={busy || (!posting && adopt === "")}
            onPointerDown={pressStart}
            onClick={toggle}
            className="inline-flex h-11 w-12 shrink-0 items-center justify-center rounded-[7px] disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-7 sm:w-11"
          >
            <span
              aria-hidden
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${posting ? "bg-accent" : "bg-sunken shadow-[inset_0_0_0_1.5px_var(--color-border)]"}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${posting ? "translate-x-[18px]" : "translate-x-0.5"}`} />
            </span>
          </button>
        ) : null}
      </div>
      {showField ? (
        <label className="flex min-w-0 items-center gap-1.5 pr-1.5">
          <span className="shrink-0 text-[10px] font-semibold text-muted">{t("telegram.bot.aliasShort")}</span>
          <input
            type="text"
            value={alias}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            aria-label={`${t("telegram.bot.aliasLabel")}: ${chat.title}`}
            placeholder={suggestion || t("telegram.bot.aliasLabel")}
            onChange={(event) => setAlias(event.target.value)}
            onFocus={fieldFocus}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={blur}
            className={`${inputClass} w-full flex-1 font-mono`}
          />
        </label>
      ) : null}
      {showField && !posting && draft === "" ? <p className="pr-1.5 text-[10px] leading-snug text-muted">{t("telegram.bot.aliasHint")}</p> : null}
      {(chat.bots?.length ?? 0) > 1 ? (
        <div className="flex flex-wrap gap-x-2 gap-y-1 pr-1.5 text-[10px] text-secondary">
          {chat.bots!.map(bot => {
            const removed = bot.member === false || bot.status === "kicked" || bot.status === "left" || bot.reason === "bot_not_in_chat";
            const state = bot.canPost === true ? t("telegram.bot.mayPost")
              : bot.canPost === false ? removed ? t("telegram.bot.removedFromChat") : t("telegram.bot.mayNotPost")
              : t("telegram.bot.notChecked");
            return <span key={bot.username ?? bot.name} aria-label={`${bot.name}: ${state}`}
              title={`${bot.reason ? t(ERROR_KEYS[bot.reason] ?? "telegram.actionFailed") : state}${bot.checkedAt ? ` · ${formatTime(bot.checkedAt)}` : ""}`}>
              <span aria-hidden style={{ color: bot.canPost === true ? "var(--color-success)" : bot.canPost === false ? "var(--color-danger)" : "var(--color-muted)" }}>{bot.canPost === null ? "○" : "●"}</span> {bot.name} · <span data-telegram-bot-posting-state={bot.canPost === true ? "may-post" : removed ? "removed" : bot.canPost === false ? "cannot-post" : "not-checked"}>{state}</span>
            </span>;
          })}
        </div>
      ) : null}
      {chat.type !== "private" && (chat.bots?.filter(b => b.canPost === true).length ?? 0) >= 2 ? (
        <label className="flex items-center gap-1.5 pr-1.5 text-[10px] text-muted">
          {t("telegram.bot.postsAs")}
          <select aria-label={`${t("telegram.bot.postsAs")}: ${chat.title}`} className={`${inputClass} flex-1`} disabled={busy} value={chat.assignedBot ?? ""} onChange={e => onAssign?.(chat.chatId, e.target.value || null)}>
            <option value="">{t("telegram.bot.automatic")}</option>
            {chat.bots!.filter(b => b.canPost === true && b.username).map(b => <option key={b.username} value={b.username!}>{b.name}</option>)}
          </select>
        </label>
      ) : null}
      {chat.lastDelivery?.state === "refused" ? (
        <p data-telegram-delivery="refused" className="pr-1.5 text-[10px] font-semibold leading-snug text-warning">
          {t("telegram.bot.deliveryRefused", { time: formatTime(chat.lastDelivery.at) ?? "" })} {chat.lastDelivery.refusals.map(r => `${r.bot.name}: ${refusalLabel(r)}`).join("; ")}
        </p>
      ) : null}
      {visibility ? <p className="pr-1.5 text-[10px] leading-snug text-muted">{visibility}</p> : null}
      {chat.reports?.some((entry) => !entry.refused) ? (
        <p data-telegram-chat-reports="chosen" className="pr-1.5 text-[10px] font-semibold leading-snug text-accent">
          {t("telegram.bot.reports", { names: chat.reports.filter((entry) => !entry.refused).map((entry) => entry.name).join(", ") })}
        </p>
      ) : null}
      {chat.reports?.some((entry) => entry.refused) ? (
        <p data-telegram-chat-reports="refused" className="pr-1.5 text-[10px] font-semibold leading-snug text-warning">
          {t("telegram.bot.reportsRefused", { names: chat.reports.filter((entry) => entry.refused).map((entry) => entry.name).join(", ") })}
        </p>
      ) : null}
      {lastPost && lastPostBy ? (
        <p className="min-w-0 truncate pb-1 pr-1.5 text-[9.5px] font-semibold text-secondary">{t("telegram.bot.lastPost", { time: lastPost, by: lastPostBy })}{chat.lastDelivery?.state === "sent" && chat.lastDelivery.bot ? ` · ${t("telegram.bot.via", { bot: chat.lastDelivery.bot.name })}` : ""}</p>
      ) : null}
    </li>
  );
}

/**
 * Adds a chat by its id or @username (`docs/design/telegram-bot-account.md`,
 * "Chats added by id"). A post-only bot never hears of the groups it joins,
 * because another program owns its updates; the server checks the chat with
 * Telegram's `getChat`, allows posting in it, and reads nothing from it. Once
 * added, the operator may send one silent test post. `onAdded` hands the alias
 * to a picker that wants the new chat selected.
 */
export function AddChatForm({ state, onAdded, compact = false, roomy = false }: { state: TelegramBotState; onAdded?: (alias: string) => void; compact?: boolean;
  /** At the Settings window's sizes. */
  roomy?: boolean }) {
  const { t } = useLocale();
  const [value, setValue] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const title = (alias: string) => state.status?.chats.find((chat) => chat.alias === alias)?.title ?? alias;
  const submit = async () => {
    const reference = value.trim();
    if (state.busy || reference === "") return;
    setTested(null);
    const alias = await state.addChat(reference);
    if (alias === null) return;
    setValue("");
    setAdded(alias);
    onAdded?.(alias);
  };
  return (
    <div data-telegram-add-chat="" className="flex flex-col gap-1.5">
      {compact ? null : <p className={roomy ? "text-ui leading-snug text-muted" : "text-[10.5px] leading-snug text-muted"}>{t("telegram.bot.addHint")}</p>}
      <form
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        className="flex min-w-0 items-center gap-1.5"
      >
        <input
          type="text"
          value={value}
          disabled={state.busy}
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          data-telegram-add-chat-input=""
          aria-label={t("telegram.bot.addLabel")}
          placeholder={t("telegram.bot.addPlaceholder")}
          onChange={(event) => setValue(event.target.value)}
          className={roomy ? `${roomyField} flex-1 font-mono` : `${inputClass} flex-1 font-mono`}
        />
        <button
          type="submit"
          data-telegram-add-chat-submit=""
          disabled={state.busy || value.trim() === ""}
          className={roomy ? roomyButton : "h-11 shrink-0 rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"}
        >
          {t("telegram.bot.add")}
        </button>
      </form>
      {added ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p role="status" data-telegram-add-chat-added={added} className={`min-w-0 flex-1 font-semibold leading-snug text-success ${roomy ? "text-ui" : "text-[10.5px]"}`}>
            {tested === added ? t("telegram.bot.testSent", { title: title(added) }) : t("telegram.bot.added", { title: title(added), alias: added })}
          </p>
          {tested === added ? null : (
            <ActionButton
              label={t("telegram.bot.test")}
              disabled={state.busy}
              onClick={() => void state.testPost(added).then((sent) => { if (sent) setTested(added); })}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The token field. Uncontrolled, and emptied before the request starts. */
export function TokenForm({ busy, onConnect, roomy = false }: { busy: boolean; onConnect: (token: string) => void;
  /** At the Settings window's sizes. */
  roomy?: boolean }) {
  const { t } = useLocale();
  const tokenRef = useRef<HTMLInputElement>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const input = tokenRef.current;
        const token = input?.value.trim() ?? "";
        if (busy || !input || token === "") return;
        input.value = "";
        onConnect(token);
      }}
      className="flex flex-col gap-1.5"
    >
      <input
        ref={tokenRef}
        type="password"
        required
        autoComplete="off"
        spellCheck={false}
        aria-label={t("telegram.bot.tokenLabel")}
        placeholder={t("telegram.bot.tokenLabel")}
        className={roomy ? roomyField : inputClass}
      />
      <button
        type="submit"
        disabled={busy}
        className={roomy ? `${roomyButton} self-start` : "h-11 shrink-0 rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"}
      >
        {t("telegram.bot.connect")}
      </button>
    </form>
  );
}
