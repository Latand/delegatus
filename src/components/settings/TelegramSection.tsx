"use client";

import { ChevronRight, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { KEYS_CHANGED_EVENT, openKeys } from "@/components/keys/openKeys";
import { ProjectReportsOverview } from "@/components/ProjectReportsOverview";
import { AddChatForm, ERROR_KEYS, formatTime as formatAt, receivingKey, telegramRefusalLabel, TokenForm, useChatPosting } from "@/components/TelegramBot";
import { useTelegramBot, type TelegramBotState } from "@/hooks/useTelegramBot";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { TelegramBotChatView, TelegramChatBot, TelegramPostingBot } from "@/lib/telegram/bot/contracts";

import { openSettings, type SettingsSub } from "./openSettings";
import { ActionsRow, BlockRow, BUTTON, ChoiceRow, ConfirmAction, DetailsRow, FIELD, FieldRow, FOCUS, Gone, LinkRow, Literal, Prose, RefusalLine, Rows, SectionHead, SwitchRow, TEXT_ACTION, TextRow, ValueRow, type RowDot } from "./settingsRows";
import { StatusDot, type DotTone } from "./StatusDot";

const AUTOMATIC = "";
/** A time in the interface's language, whatever the browser's. */
function useFormatTime() {
  const { locale } = useLocale();
  return (iso: string | null) => formatAt(iso, locale);
}
const isActive = (chat: TelegramBotChatView) => chat.member || (chat.postAllowed && chat.lastDelivery?.state === "refused");

const RECEIVING_TONE: Record<string, DotTone> = { polling: "ok", stopped: "off" };

export function receivingDot(t: TFunction, status: TelegramBotState["status"]): { tone: DotTone; word: string; note: string } {
  const receiving = status?.receiving ?? "stopped";
  return {
    tone: RECEIVING_TONE[receiving] ?? "warn",
    word: t(`settings.telegram.word.${receiving}` as MessageKey),
    note: t(`settings.telegram.note.${receiving}` as MessageKey),
  };
}

/** Who posts: the bot assigned, else the one the last post went through, else the first that may post. */
function sender(chat: TelegramBotChatView): TelegramChatBot | undefined {
  const bots = chat.bots ?? [];
  const assigned = bots.find((bot) => bot.assigned);
  if (assigned) return assigned;
  const sentBy = chat.lastDelivery?.state === "sent" ? chat.lastDelivery.bot : undefined;
  return (sentBy && bots.find((bot) => bot.name === sentBy.name && bot.username === sentBy.username)) || bots.find((bot) => bot.canPost === true);
}

function senderLine(t: TFunction, bot: TelegramChatBot | undefined): string | null {
  if (!bot) return null;
  return bot.clone ? t("settings.telegram.postsAsClone", { name: bot.name, relay: bot.clone.relay }) : t("settings.telegram.postsAsBot", { name: bot.name });
}

function chatDot(t: TFunction, chat: TelegramBotChatView, lastPost: string | null): RowDot & { word: string } {
  if (chat.lastDelivery?.state === "refused") {
    const first = chat.lastDelivery.refusals[0];
    return { tone: "warn", word: t("settings.telegram.chat.notDelivered"), note: first ? `${first.bot.name}: ${telegramRefusalLabel(t, chat, first)}` : t("settings.telegram.chat.notDelivered") };
  }
  if (chat.postAllowed && chat.alias) {
    return chat.member
      ? { tone: "ok", word: t("settings.telegram.chat.posting"), note: lastPost ? t("settings.telegram.note.lastPost", { time: lastPost }) : t("settings.telegram.note.noPost") }
      : { tone: "warn", word: t("settings.telegram.chat.notMember"), note: t("telegram.bot.notInChat") };
  }
  return chat.member
    ? { tone: "off", word: t("settings.telegram.chat.off"), note: t("settings.telegram.chat.offNote") }
    : { tone: "off", word: t("settings.telegram.chat.notMember"), note: t("telegram.bot.notInChat") };
}

const typeWord = (t: TFunction, chat: TelegramBotChatView) => `${t(`telegram.bot.type.${chat.type}` as MessageKey)}${chat.isForum ? ` · ${t("telegram.bot.forum")}` : ""}`;

interface SectionProps {
  sub: SettingsSub | null;
  go: (sub: SettingsSub) => void;
  back: () => void;
}

/**
 * «Telegram» in the Settings window: the bot, its chats, each project's reports
 * and the document folders, with a page per bot and per chat. The main bot's
 * token lives in «Keys»; a paired clone shows as a sender and stores no token
 * here. Everything the bot's panel did stays, on these pages.
 */
export function TelegramSection(props: SectionProps) {
  return <TelegramSectionView {...props} state={useTelegramBot(true)} />;
}

export function TelegramSectionView({ state, sub, go, back }: SectionProps & { state: TelegramBotState }) {
  const { t } = useLocale();
  /* A failure reads where its action was taken. */
  const [origin, setOrigin] = useState<string | null>(null);
  const place = sub ? `${sub.id}:${sub.arg ?? ""}` : "";
  const here = (run: () => void | Promise<unknown>) => { setOrigin(place); void run(); };
  const failure = state.failure && (origin === place || (origin === null && !sub))
    ? <RefusalLine attrs={{ "data-telegram-failure": state.failure.code }}>{t(ERROR_KEYS[state.failure.code] ?? "telegram.actionFailed")}</RefusalLine> : null;
  const { refresh } = state;
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; });
  useEffect(() => {
    const reread = () => { void refreshRef.current(); };
    window.addEventListener(KEYS_CHANGED_EVENT, reread);
    return () => window.removeEventListener(KEYS_CHANGED_EVENT, reread);
  }, []);
  const status = state.status;
  if (sub?.id === "bot") {
    const main = !sub.arg;
    const posting = status?.bots?.find((bot) => bot.username === sub.arg);
    /* A bot removed from under its own page: the section again. */
    if (status && (main ? !status.connected : !posting)) return <Gone back={back} />;
    return main ? <MainBotPage state={state} failure={failure} here={here} /> : posting ? <SendingBotPage bot={posting} state={state} failure={failure} here={here} /> : null;
  }
  if (sub?.id === "chat") {
    const chat = status?.chats.find((candidate) => candidate.chatId === sub.arg);
    if (status && !chat) return <Gone back={back} />;
    return chat ? <ChatPage key={chat.chatId} chat={chat} state={state} failure={failure} here={here} /> : null;
  }
  if (sub?.id === "add-bot") return <AddBotPage state={state} failure={failure} here={here} back={back} />;
  if (sub?.id === "add-chat") return <AddChatPage state={state} failure={failure} here={here} />;
  if (sub?.id === "folders") return <FoldersPage state={state} failure={failure} here={here} />;
  return <Overview state={state} failure={failure} go={go} />;
}

function BotRows({ state, go }: { state: TelegramBotState; go: SectionProps["go"] }) {
  const { t } = useLocale();
  const formatTime = useFormatTime();
  const status = state.status;
  const dot = receivingDot(t, status);
  const senders = status?.bots?.filter((bot) => !bot.receiving) ?? [];
  const checked = formatTime(status?.lastCheckedAt ?? status?.lastUpdateAt ?? null);
  const handle = status?.bot?.username ? `@${status.bot.username}` : null;
  return (
    <>
      <LinkRow
        attrs={{ "data-telegram-bot-row": "" }}
        sub="bot:"
        label={status?.bot?.name ?? ""}
        dot={{ tone: dot.tone, note: dot.note }}
        value={dot.word}
        hint={[handle, checked ? t("settings.telegram.checkedAt", { time: checked }) : null].filter(Boolean).join(" · ") || undefined}
        onOpen={() => go({ id: "bot", title: status?.bot?.name ?? t("telegram.bot.title") })}
      />
      {senders.map((bot) => {
        const rejected = bot.tokenState === "rejected";
        return (
          <LinkRow
            key={bot.username ?? bot.name}
            attrs={{ "data-telegram-sending-bot": bot.username ?? bot.name }}
            sub={`bot:${bot.username ?? ""}`}
            label={bot.name}
            dot={{ tone: rejected ? "warn" : "ok", note: t(rejected ? "settings.telegram.note.token_rejected" : "settings.telegram.note.sending") }}
            value={t(rejected ? "settings.telegram.word.token_rejected" : "settings.telegram.word.sending")}
            hint={bot.username ? `@${bot.username}` : undefined}
            onOpen={() => go({ id: "bot", arg: bot.username ?? undefined, title: bot.name })}
          />
        );
      })}
      {(status?.bots?.length ?? 1) < 9 ? <LinkRow attrs={{ "data-telegram-add-bot": "" }} sub="add-bot:" label={t("telegram.bot.addBot")} onOpen={() => go({ id: "add-bot", title: t("telegram.bot.addBot") })} /> : null}
    </>
  );
}

/** «Bot token» in «Keys»: the one place a surface asks for it. */
function TokenRow({ state }: { state: TelegramBotState }) {
  const { t } = useLocale();
  const connected = state.status?.connected === true;
  const rejected = state.status?.receiving === "token_rejected";
  return (
    <LinkRow
      attrs={{ "data-telegram-bot-token": connected ? rejected ? "rejected" : "saved" : "missing" }}
      label={t("settings.telegram.token")}
      dot={connected
        ? rejected ? { tone: "warn", note: t("settings.telegram.note.token_rejected") } : { tone: "ok", note: t("settings.telegram.token.savedNote") }
        : { tone: "off", note: t("settings.telegram.token.missingNote") }}
      value={t(connected ? rejected ? "settings.telegram.token.replace" : "settings.saved" : "settings.notSet")}
      hint={t("settings.opensKeys")}
      onOpen={() => openKeys("telegram")}
    />
  );
}

function ChatListRow({ chat, go }: { chat: TelegramBotChatView; go: SectionProps["go"] }) {
  const { t } = useLocale();
  const formatTime = useFormatTime();
  const lastPost = formatTime(chat.lastPostAt);
  const dot = chatDot(t, chat, lastPost);
  const line = chat.lastDelivery?.state === "refused" && lastPost ? t("settings.telegram.chat.lastPost", { time: lastPost }) : senderLine(t, sender(chat));
  return (
    <LinkRow
      attrs={{ "data-telegram-chat-row": chat.chatId }}
      sub={`chat:${chat.chatId}`}
      label={chat.title}
      dot={{ tone: dot.tone, note: dot.note }}
      value={dot.word}
      hint={[typeWord(t, chat), line].filter(Boolean).join(" · ")}
      onOpen={() => go({ id: "chat", arg: chat.chatId, title: t("settings.telegram.chatPage") })}
    />
  );
}

function Overview({ state, failure, go }: { state: TelegramBotState; failure: React.ReactNode; go: SectionProps["go"] }) {
  const { t } = useLocale();
  const status = state.status;
  const connected = status?.connected === true;
  const active = status?.chats.filter(isActive) ?? [];
  const inactive = status?.chats.filter((chat) => !isActive(chat)) ?? [];
  const [foldOpen, setFoldOpen] = useState(false);
  const Arrow = foldOpen ? ChevronUp : ChevronDown;
  const cloneOnly = !connected && (status?.chats.length ?? 0) > 0;
  return (
    <Rows data-telegram-settings="">
      {failure}
      {status ? (
        <>
          <SectionHead title={t("telegram.bot.title")} />
          {connected ? <BotRows state={state} go={go} /> : (
            <>
              <TokenRow state={state} />
              <TextRow tone="muted">{cloneOnly ? t("settings.telegram.cloneOnly") : <Prose text={t("telegram.bot.connectHint")} />}</TextRow>
            </>
          )}
          <SectionHead title={t("telegram.bot.chats")} count={status.chats.length || undefined} />
          {active.map((chat) => <ChatListRow key={chat.chatId} chat={chat} go={go} />)}
          {active.length === 0 ? <TextRow tone="muted">{connected ? <Prose text={t("telegram.bot.noChats", { username: status.bot?.username ?? "bot" })} /> : t("telegram.bot.noCloneChats")}</TextRow> : null}
          {inactive.length ? (
            <button type="button" data-telegram-inactive-fold="" data-settings-unit="" aria-expanded={foldOpen} onClick={() => setFoldOpen((was) => !was)} className={`flex min-h-10 w-full items-center gap-2 px-5 text-left text-body font-semibold text-secondary hover:bg-sunken settings-sheet:min-h-11 settings-sheet:px-4 ${FOCUS}`}>
              <span className="min-w-0 flex-1 truncate">{t("telegram.bot.inactive", { count: inactive.length })}</span>
              <Arrow data-settings-chevron="" className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </button>
          ) : null}
          {foldOpen ? inactive.map((chat) => <ChatListRow key={chat.chatId} chat={chat} go={go} />) : null}
          {connected ? <LinkRow attrs={{ "data-telegram-add-chat-row": "" }} sub="add-chat:" label={t("telegram.bot.addTitle")} onOpen={() => go({ id: "add-chat", title: t("telegram.bot.addTitle") })} /> : null}
          {connected ? <ProjectReportsOverview bot={state} /> : null}
          {connected ? (
            <>
              <SectionHead title={t("settings.telegram.files")} />
              <LinkRow
                attrs={{ "data-telegram-folders-row": "" }}
                sub="folders:"
                label={t("telegram.bot.documentsTitle")}
                value={String(status.documents?.roots.length ?? 0)}
                hint={t("settings.telegram.foldersHint")}
                onOpen={() => go({ id: "folders", title: t("telegram.bot.documentsTitle") })}
              />
            </>
          ) : null}
          <DetailsRow lines={[
            connected ? { label: t("telegram.bot.limitsTitle"), value: <Prose text={t(status.bot?.canReadAllGroupMessages ? "telegram.bot.privacyOff" : "telegram.bot.privacyOn")} /> } : null,
            { label: t("settings.telegram.detail.updates"), value: <Prose text={t("telegram.bot.limit1")} /> },
            { label: t("settings.telegram.detail.groups"), value: <Prose text={t("telegram.bot.limit2")} /> },
            { label: t("settings.telegram.detail.first"), value: <Prose text={t("telegram.bot.limit3")} /> },
            { label: t("settings.telegram.detail.token"), value: <Prose text={t("telegram.bot.revokeHint")} /> },
          ]} />
        </>
      ) : null}
    </Rows>
  );
}

function MainBotPage({ state, failure, here }: { state: TelegramBotState; failure: React.ReactNode; here: (run: () => void | Promise<unknown>) => void }) {
  const { t } = useLocale();
  const formatTime = useFormatTime();
  const status = state.status;
  const receiving = status?.receiving ?? "stopped";
  const dot = receivingDot(t, status);
  const checked = formatTime(status?.lastCheckedAt ?? null);
  const updated = formatTime(status?.lastUpdateAt ?? null);
  /* The chats this bot itself posts to: it is their sender and may post there. A rejected token posts nowhere. */
  const mine = (bot: TelegramChatBot | undefined) => Boolean(bot && !bot.clone && bot.canPost === true && bot.username === status?.bot?.username);
  const posts = receiving === "token_rejected" ? [] : status?.chats.filter((chat) => chat.postable && mine(sender(chat))).map((chat) => chat.title) ?? [];
  return (
    <Rows data-telegram-bot-page="">
      <LinkRow
        label={dot.word}
        dot={{ tone: dot.tone, note: dot.note }}
        hint={[status?.bot?.username ? `@${status.bot.username}` : null, updated ? t("settings.telegram.updatedAt", { time: updated }) : null].filter(Boolean).join(" · ") || undefined}
      />
      {/* The state row and the token row say a rejected token: no third line repeats it. */}
      {receiving === "polling" || receiving === "token_rejected"
        ? null
        : <TextRow tone="warning" role="status"><Prose text={t(receivingKey(receiving))} /></TextRow>}
      {posts.length || checked ? <TextRow tone="muted" attrs={{ "data-telegram-bot-posts": String(posts.length) }}>
        {[posts.length ? t("settings.telegram.postsIn", { chats: posts.join(", ") }) : null, checked ? t("settings.telegram.lastChecked", { time: checked }) : null].filter(Boolean).join(" ")}
      </TextRow> : null}
      <TokenRow state={state} />
      {failure}
      <ActionsRow foot note={<Prose text={t("telegram.bot.revokeHint")} />}>
        <button type="button" data-telegram-bot-refresh="" disabled={state.busy} className={BUTTON} onClick={() => here(() => state.refresh(true))}>{t("telegram.bot.refresh")}</button>
        <ConfirmAction label={t("telegram.bot.remove")} prompt={t("telegram.bot.removeConfirm")} disabled={state.busy} onConfirm={() => here(() => state.remove())} />
      </ActionsRow>
    </Rows>
  );
}

function SendingBotPage({ bot, state, failure, here }: { bot: TelegramPostingBot; state: TelegramBotState; failure: React.ReactNode; here: (run: () => void | Promise<unknown>) => void }) {
  const { t } = useLocale();
  const rejected = bot.tokenState === "rejected";
  return (
    <Rows data-telegram-sending-bot-page="">
      <LinkRow
        label={t(rejected ? "settings.telegram.word.token_rejected" : "settings.telegram.word.sending")}
        dot={{ tone: rejected ? "warn" : "ok", note: t(rejected ? "settings.telegram.note.token_rejected" : "settings.telegram.note.sending") }}
        hint={bot.username ? `@${bot.username}` : undefined}
      />
      {rejected ? <TextRow tone="warning" role="status">{t("telegram.bot.err.token_rejected")}</TextRow> : null}
      <TextRow tone="muted">{t("telegram.bot.sendingHint")}</TextRow>
      {failure}
      <ActionsRow foot note={<Prose text={t("telegram.bot.revokeHint")} />}>
        <ConfirmAction label={t("telegram.bot.removeSending")} prompt={t("telegram.bot.removeSendingConfirm")} disabled={state.busy} onConfirm={() => here(() => { if (bot.username) return state.removeBot?.(bot.username); })} />
      </ActionsRow>
    </Rows>
  );
}

function ChatPage({ chat, state, failure, here }: { chat: TelegramBotChatView; state: TelegramBotState; failure: React.ReactNode; here: (run: () => void | Promise<unknown>) => void }) {
  const { t } = useLocale();
  const formatTime = useFormatTime();
  const busy = state.busy || Boolean(state.pending?.has(chat.chatId));
  const save = (chatId: string, alias: string, postAllowed: boolean) => here(() => state.setChat(chatId, alias, postAllowed));
  const { alias, setAlias, draft, suggestion, posting, adopt, showField, toggle, blur, pressStart, fieldFocus } = useChatPosting(chat, save);
  const [tested, setTested] = useState(false);
  const botSeesAll = state.status?.bot?.canReadAllGroupMessages === true;
  const group = chat.type === "group" || chat.type === "supergroup";
  const visibility = !chat.member || !group ? null
    : chat.readdToApply ? t("telegram.bot.readd")
    : chat.seesAllMessages && !botSeesAll ? t("telegram.bot.seesAllAdmin")
    : null;
  const lastPost = formatTime(chat.lastPostAt);
  const lastPostBy = chat.lastPostBy
    ? "unidentified" in chat.lastPostBy ? t("telegram.bot.unidentified") : chat.lastPostBy.title ?? chat.lastPostBy.conversationId
    : null;
  const posters = chat.bots?.filter((bot) => bot.canPost === true) ?? [];
  const who = senderLine(t, sender(chat));
  const refused = chat.lastDelivery?.state === "refused" ? chat.lastDelivery : null;
  return (
    <Rows data-telegram-chat-page={chat.chatId}>
      {/* The back row names the page «Chat»: the chat's name reads whole here, however long. */}
      <ValueRow attrs={{ "data-telegram-chat-name": "" }} value={chat.title} hint={chat.member || posting ? typeWord(t, chat) : `${typeWord(t, chat)} · ${t("telegram.bot.notInChat")}`} />
      {chat.member || posting ? (
        <SwitchRow
          label={t("telegram.bot.mayPost")}
          enabled={posting}
          disabled={busy || (!posting && adopt === "")}
          onToggle={toggle}
          onPressStart={pressStart}
          switchAttrs={{ "data-telegram-chat-switch": "" }}
        />
      ) : null}
      {refused ? (
        <TextRow tone="warning" attrs={{ "data-telegram-delivery": "refused" }}>
          {t("telegram.bot.deliveryRefused", { time: formatTime(refused.at) ?? "" })} {refused.refusals.map((refusal) => `${refusal.bot.name}: ${telegramRefusalLabel(t, chat, refusal)}`).join("; ")}
        </TextRow>
      ) : null}
      {showField ? (
        <FieldRow label={t("telegram.bot.aliasLabel")} hint={!posting && draft === "" ? t("telegram.bot.aliasHint") : undefined}>
          <input
            type="text"
            value={alias}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            data-telegram-chat-alias=""
            aria-label={`${t("telegram.bot.aliasLabel")}: ${chat.title}`}
            placeholder={suggestion || t("telegram.bot.aliasLabel")}
            onChange={(event) => setAlias(event.target.value)}
            onFocus={fieldFocus}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            onBlur={blur}
            className={`${FIELD} font-mono`}
          />
        </FieldRow>
      ) : null}
      {chat.type !== "private" && posters.length >= 2 ? (
        <ChoiceRow
          label={t("telegram.bot.postsAs")}
          hint={!chat.assignedBot && who ? who : undefined}
          value={chat.assignedBot ?? AUTOMATIC}
          disabled={busy}
          onChange={(next) => here(() => state.assignBot?.(chat.chatId, next || null))}
          options={[{ value: AUTOMATIC, label: t("telegram.bot.automatic") }, ...posters.filter((bot) => bot.username).map((bot) => ({ value: bot.username!, label: bot.name }))]}
          selectAttrs={{ "data-telegram-posts-as": "" }}
        />
      ) : who ? <TextRow tone="muted" attrs={{ "data-telegram-posts-who": "" }}>{who}</TextRow> : null}
      {(chat.bots?.length ?? 0) > 1 ? chat.bots!.map((bot) => <ChatBotRow key={bot.username ?? bot.name} bot={bot} />) : null}
      {visibility ? <TextRow tone="muted">{visibility}</TextRow> : null}
      {chat.reports?.some((entry) => !entry.refused) ? <TextRow tone="muted" attrs={{ "data-telegram-chat-reports": "chosen" }}>{t("telegram.bot.reports", { names: chat.reports.filter((entry) => !entry.refused).map((entry) => entry.name).join(", ") })}</TextRow> : null}
      {chat.reports?.some((entry) => entry.refused) ? <TextRow tone="warning" attrs={{ "data-telegram-chat-reports": "refused" }}>{t("telegram.bot.reportsRefused", { names: chat.reports.filter((entry) => entry.refused).map((entry) => entry.name).join(", ") })}</TextRow> : null}
      {lastPost && lastPostBy ? <TextRow tone="muted">{t("telegram.bot.lastPost", { time: lastPost, by: lastPostBy })}{chat.lastDelivery?.state === "sent" && chat.lastDelivery.bot ? ` · ${t("telegram.bot.via", { bot: chat.lastDelivery.bot.name })}` : ""}</TextRow> : null}
      {failure}
      {posting && chat.alias ? (
        <ActionsRow>
          <button type="button" data-telegram-chat-test="" disabled={state.busy} className={BUTTON} onClick={() => { setTested(false); here(() => state.testPost(chat.alias!).then((sent) => { if (sent) setTested(true); })); }}>{t("telegram.bot.test")}</button>
          {tested ? <span role="status" className="text-ui font-semibold text-success">{t("telegram.bot.testSent", { title: chat.title })}</span> : null}
        </ActionsRow>
      ) : null}
      <DetailsRow lines={[
        { label: t("settings.telegram.detail.chat"), value: <Literal text={chat.chatId} /> },
        chat.username ? { label: t("settings.telegram.detail.username"), value: <Literal text={`@${chat.username}`} /> } : null,
        chat.alias ? { label: t("telegram.bot.aliasShort"), value: <Literal text={chat.alias} /> } : null,
      ]} />
    </Rows>
  );
}

function ChatBotRow({ bot }: { bot: TelegramChatBot }) {
  const { t } = useLocale();
  const formatTime = useFormatTime();
  const removed = bot.member === false || bot.status === "kicked" || bot.status === "left" || bot.reason === "bot_not_in_chat";
  const word = bot.canPost === true ? t("settings.telegram.bot.canPost")
    : bot.canPost === false ? removed ? t("telegram.bot.removedFromChat") : t("telegram.bot.mayNotPost")
    : t("telegram.bot.notChecked");
  const reason = bot.reason ? t(ERROR_KEYS[bot.reason] ?? "telegram.actionFailed") : word;
  const when = formatTime(bot.checkedAt);
  return (
    <LinkRow
      attrs={{ "data-telegram-chat-bot": bot.username ?? bot.name }}
      label={bot.clone ? t("settings.telegram.cloneName", { name: bot.name, relay: bot.clone.relay }) : bot.name}
      dot={{ tone: bot.canPost === true ? "ok" : bot.canPost === false ? "warn" : "off", note: `${reason}${when ? ` · ${when}` : ""}` }}
      value={<span data-telegram-bot-posting-state={bot.canPost === true ? "may-post" : removed ? "removed" : bot.canPost === false ? "cannot-post" : "not-checked"}>{word}</span>}
    />
  );
}

function AddBotPage({ state, failure, here, back }: { state: TelegramBotState; failure: React.ReactNode; here: (run: () => void | Promise<unknown>) => void; back: () => void }) {
  const { t } = useLocale();
  const count = state.status?.bots?.length ?? 0;
  const first = useRef(count);
  /* The bot is on the list: its token went in once and the page has done its work. */
  useEffect(() => { if (count > first.current) back(); }, [count, back]);
  return (
    <Rows data-telegram-add-bot-page="">
      <TextRow tone="muted">{t("telegram.bot.sendingHint")}</TextRow>
      <BlockRow><TokenForm roomy busy={state.busy} onConnect={(token) => here(() => state.addBot?.(token))} /></BlockRow>
      {failure}
    </Rows>
  );
}

function AddChatPage({ state, failure, here }: { state: TelegramBotState; failure: React.ReactNode; here: (run: () => void | Promise<unknown>) => void }) {
  /* The form calls the state's own `addChat`, which sets `failure`: the page only says that the failure is its own. */
  useEffect(() => { here(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <Rows data-telegram-add-chat-page=""><BlockRow><AddChatForm roomy state={state} /></BlockRow>{failure}</Rows>;
}

/** The folders agents may send files from, a row per folder. A list emptied, or never set, returns to the default. */
function FoldersPage({ state, failure, here }: { state: TelegramBotState; failure: React.ReactNode; here: (run: () => void | Promise<unknown>) => void }) {
  const { t } = useLocale();
  const documents = state.status?.documents;
  const custom = documents?.custom === true;
  const roots = documents?.roots ?? [];
  const [draft, setDraft] = useState("");
  /* The row closes on the press and lists the folder as saved; a refusal puts the typed path back (audit B39). */
  const add = () => {
    const path = draft.trim();
    if (!path || state.busy) return;
    setDraft("");
    here(async () => { if (!await state.setDocumentRoots(custom ? [...new Set([...roots, path])] : [path])) setDraft(path); });
  };
  return (
    <Rows data-telegram-document-roots="">
      <TextRow tone="muted">{t("settings.telegram.foldersIntro")}</TextRow>
      {roots.map((root) => (
        <ValueRow
          key={root}
          attrs={{ "data-telegram-document-root": root }}
          value={<Literal text={root} />}
          hint={custom ? undefined : t("telegram.bot.documentsDefault")}
          action={custom ? <button type="button" disabled={state.busy} data-telegram-document-root-remove="" className={TEXT_ACTION} onClick={() => here(() => state.setDocumentRoots(roots.filter((other) => other !== root)))}>{t("settings.telegram.removeFolder")}</button> : null}
        />
      ))}
      <BlockRow>
        <form className="flex min-w-0 items-center gap-2" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <input type="text" value={draft} disabled={state.busy} autoComplete="off" spellCheck={false} data-telegram-document-roots-input="" aria-label={t("settings.telegram.addFolder")} placeholder={t("settings.telegram.addFolderPlaceholder")} onChange={(event) => setDraft(event.target.value)} className={`${FIELD} flex-1 font-mono`} />
          <button type="submit" data-telegram-document-roots-save="" disabled={state.busy || draft.trim() === ""} className={`${BUTTON} shrink-0`}>{t("settings.telegram.addFolder")}</button>
        </form>
      </BlockRow>
      {failure}
      {custom ? <ActionsRow><button type="button" data-telegram-document-roots-default="" disabled={state.busy} className={BUTTON} onClick={() => here(() => state.setDocumentRoots([]))}>{t("settings.telegram.useDefaultFolder")}</button></ActionsRow> : null}
    </Rows>
  );
}

/** The rail panel's row for the bot: its state by a dot, and everything else in the window. */
export function TelegramBotRow({ state, onOpen }: { state: TelegramBotState; onOpen?: () => void }) {
  const { t } = useLocale();
  const status = state.status;
  const dot = receivingDot(t, status);
  const name = status?.connected ? status.bot?.name ?? t("telegram.bot.title") : t("telegram.bot.title");
  return (
    <section aria-label={t("telegram.bot.title")} data-telegram-bot-entry="" className="flex min-w-0 items-center gap-1 border-t border-border pt-2">
      {/* Its target is the button's height: 44 px on the phone, 24 on the desktop. */}
      {status?.connected ? <StatusDot tone={dot.tone} note={dot.note} label={name} hit="h-11 w-11 justify-center sm:h-6 sm:w-6" /> : null}
      <button type="button" data-telegram-bot-open="" className={`flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-[6px] text-left hover:bg-sunken sm:min-h-[28px] ${FOCUS}`} onClick={() => { onOpen?.(); openSettings("telegram"); }}>
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-primary">{name}</span>
        <span className="shrink-0 text-[10.5px] font-medium text-muted">{status?.connected ? dot.word : t("settings.notSet")}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      </button>
    </section>
  );
}
