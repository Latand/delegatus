"use client";

import { useRef, useState } from "react";

import type { TelegramBotState } from "@/hooks/useTelegramBot";
import { type TFunction, useLocale } from "@/lib/i18n";
import { suggestChatAlias, type TelegramBotChatView, type TelegramBotReceiving } from "@/lib/telegram/bot/contracts";

import { Trash2 } from "./icons";
import { ActionButton, ConfirmingAction } from "./TelegramControls";

/**
 * The Bot section of the Telegram panel
 * (`docs/design/telegram-bot-account.md`, Decision 8): paste a BotFather
 * token, see the bot and whether it is receiving, name the chats agents may
 * post to, and remove it. The token input is uncontrolled and cleared before
 * the request starts, so the secret is never React state and never rendered
 * back.
 */

type Key = Parameters<TFunction>[0];

const ERROR_KEYS: Record<string, Key> = {
  invalid_token: "telegram.bot.err.invalid_token",
  not_a_bot: "telegram.bot.err.not_a_bot",
  bot_already_connected: "telegram.bot.err.bot_already_connected",
  token_rejected: "telegram.bot.err.token_rejected",
  network_failed: "telegram.bot.err.network_failed",
  timed_out: "telegram.bot.err.network_failed",
  alias_invalid: "telegram.bot.err.alias_invalid",
  alias_taken: "telegram.bot.err.alias_taken",
  storage_unsafe: "telegram.bot.err.storage_unsafe",
  transport: "telegram.actionUnreachable",
};

function receivingKey(receiving: TelegramBotReceiving): Key {
  return `telegram.bot.receiving.${receiving}` as Key;
}

function receivingColor(receiving: TelegramBotReceiving): string {
  if (receiving === "polling") return "var(--color-success)";
  if (receiving === "token_rejected") return "var(--color-danger)";
  if (receiving === "stopped") return "transparent";
  return "var(--color-warning)";
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

const inputClass = "h-11 min-w-0 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8";

function ChatRow({ chat, busy, onSave }: { chat: TelegramBotChatView; busy: boolean; onSave: (chatId: string, alias: string, postAllowed: boolean) => void }) {
  const { t } = useLocale();
  const [alias, setAlias] = useState(chat.alias ?? "");
  const draft = alias.trim().toLowerCase();
  const saved = chat.alias ?? "";
  const lastPost = formatTime(chat.lastPostAt);
  const lastPostBy = chat.lastPostBy
    ? "unidentified" in chat.lastPostBy ? t("telegram.bot.unidentified") : chat.lastPostBy.title ?? chat.lastPostBy.conversationId
    : null;
  const posting = chat.postAllowed && saved !== "";
  return (
    <li className={`flex flex-col gap-1.5 rounded-[9px] border border-border px-2 py-1.5 ${chat.member ? "" : "opacity-60"}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="min-w-0 max-w-full truncate text-[11.5px] font-semibold text-primary">{chat.title}</span>
        <span className="shrink-0 rounded-full bg-sunken px-1.5 py-px text-[9.5px] font-semibold text-muted">{t(`telegram.bot.type.${chat.type}` as Key)}</span>
        {chat.isForum ? <span className="shrink-0 rounded-full bg-sunken px-1.5 py-px text-[9.5px] font-semibold text-muted">{t("telegram.bot.forum")}</span> : null}
      </div>
      <p className="text-[10px] leading-snug text-muted">
        {chat.readdToApply ? t("telegram.bot.readd") : chat.seesAllMessages ? t("telegram.bot.seesAll") : t("telegram.bot.seesMentions")}
      </p>
      {chat.member ? (
        <>
          <input
            type="text"
            value={alias}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            aria-label={`${t("telegram.bot.aliasLabel")}: ${chat.title}`}
            placeholder={suggestChatAlias(chat.title) || t("telegram.bot.aliasLabel")}
            onChange={(event) => setAlias(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={() => {
              if (draft !== saved) onSave(chat.chatId, draft, draft !== "" && chat.postAllowed);
            }}
            className={`${inputClass} w-full font-mono`}
          />
          {/* One target for the whole row: the track alone is too small to
              tap on a phone. */}
          <button
            type="button"
            role="switch"
            aria-checked={posting}
            disabled={busy || draft === ""}
            onClick={() => onSave(chat.chatId, draft, !posting)}
            className="flex min-h-[44px] w-full items-center gap-2 rounded-[7px] text-left disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
          >
            <span
              aria-hidden
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${posting ? "bg-accent" : "bg-sunken shadow-[inset_0_0_0_1.5px_var(--color-border)]"}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${posting ? "translate-x-[18px]" : "translate-x-0.5"}`} />
            </span>
            <span className="min-w-0 flex-1 text-[11px] font-semibold text-primary">{t("telegram.bot.mayPost")}</span>
          </button>
          {draft === "" ? <p className="text-[10px] leading-snug text-muted">{t("telegram.bot.aliasHint")}</p> : null}
        </>
      ) : null}
      {lastPost && lastPostBy ? (
        <p className="min-w-0 truncate text-[9.5px] font-semibold text-secondary">{t("telegram.bot.lastPost", { time: lastPost, by: lastPostBy })}</p>
      ) : null}
    </li>
  );
}

/** The token field. Uncontrolled, and emptied before the request starts. */
function TokenForm({ busy, onConnect }: { busy: boolean; onConnect: (token: string) => void }) {
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
        className={inputClass}
      />
      <button
        type="submit"
        disabled={busy}
        className="h-11 shrink-0 rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
      >
        {t("telegram.bot.connect")}
      </button>
    </form>
  );
}

export function TelegramBotSection({ state }: { state: TelegramBotState }) {
  const { t } = useLocale();
  const { status, busy, failure } = state;
  const connected = status?.connected === true;
  const receiving = status?.receiving ?? "stopped";
  const active = status?.chats.filter((chat) => chat.member) ?? [];
  const inactive = status?.chats.filter((chat) => !chat.member) ?? [];
  const save = (chatId: string, alias: string, postAllowed: boolean) => void state.setChat(chatId, alias, postAllowed);

  return (
    <section aria-label={t("telegram.bot.title")} className="flex flex-col gap-2 border-t border-border pt-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="text-[11.5px] font-bold text-primary">{t("telegram.bot.title")}</h3>
        <span className="min-w-0 truncate text-[9.5px] font-medium text-muted">{t("telegram.bot.caption")}</span>
      </div>

      {failure ? (
        <p role="alert" className="rounded-[6px] bg-danger-soft px-2 py-1 text-[10.5px] font-semibold leading-snug text-danger">
          {t(ERROR_KEYS[failure.code] ?? "telegram.actionFailed")}
        </p>
      ) : null}

      {!connected ? (
        <>
          <p className="text-[10.5px] leading-snug text-muted">{t("telegram.bot.connectHint")}</p>
          <TokenForm busy={busy} onConnect={(token) => void state.connect(token)} />
        </>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: receivingColor(receiving), boxShadow: receiving === "stopped" ? "inset 0 0 0 1.5px var(--color-border)" : "none" }}
            />
            <span className="min-w-0 truncate text-[11.5px] font-semibold text-primary">{status?.bot?.name}</span>
            {status?.bot?.username ? <span className="min-w-0 truncate font-mono text-[10px] text-muted">@{status.bot.username}</span> : null}
          </div>
          <p role="status" className={`text-[10.5px] font-semibold leading-snug ${receiving === "polling" ? "text-secondary" : receiving === "token_rejected" ? "text-danger" : "text-warning"}`}>
            {t(receivingKey(receiving))}
          </p>
          <p className="text-[10px] leading-snug text-muted">
            {status?.bot?.canReadAllGroupMessages ? t("telegram.bot.privacyOff") : t("telegram.bot.privacyOn")}
          </p>

          {receiving === "token_rejected" ? (
            <TokenForm busy={busy} onConnect={(token) => void state.connect(token)} />
          ) : null}

          <h4 className="text-[10.5px] font-bold uppercase tracking-wide text-muted">{t("telegram.bot.chats")}</h4>
          {active.length === 0 ? (
            <p className="text-[10.5px] leading-snug text-muted">{t("telegram.bot.noChats", { username: status?.bot?.username ?? "bot" })}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {active.map((chat) => <ChatRow key={`${chat.chatId}:${chat.alias ?? ""}`} chat={chat} busy={busy} onSave={save} />)}
            </ul>
          )}
          {inactive.length ? (
            <details className="text-[10.5px]">
              <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold text-muted sm:min-h-[28px]">{t("telegram.bot.inactive", { count: inactive.length })}</summary>
              <ul className="mt-1 flex flex-col gap-1.5">
                {inactive.map((chat) => <ChatRow key={`${chat.chatId}:${chat.alias ?? ""}`} chat={chat} busy={busy} onSave={save} />)}
              </ul>
            </details>
          ) : null}
        </>
      )}

      <details className="text-[10.5px]">
        <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold text-muted sm:min-h-[28px]">{t("telegram.bot.limitsTitle")}</summary>
        <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 leading-snug text-muted">
          <li>{t("telegram.bot.limit1")}</li>
          <li>{t("telegram.bot.limit2")}</li>
          <li>{t("telegram.bot.limit3")}</li>
        </ul>
      </details>

      {connected ? (
        <div className="flex flex-col gap-1 border-t border-border pt-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <ActionButton label={t("telegram.bot.refresh")} onClick={() => void state.refresh(true)} disabled={busy} />
            <ConfirmingAction
              label={t("telegram.bot.remove")}
              prompt={t("telegram.bot.removeConfirm")}
              onConfirm={() => void state.remove()}
              disabled={busy}
              icon={<Trash2 className="h-3 w-3" aria-hidden />}
            />
          </div>
          <p className="text-[9.5px] leading-snug text-muted">{t("telegram.bot.revokeHint")}</p>
        </div>
      ) : null}
    </section>
  );
}
