"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { BranchPane } from "@/components/BranchPane";
import { EngineMark } from "@/components/EngineMark";
import { AgentWindow, OPEN_AGENTS_SHORTCUT } from "@/components/kanban/AgentWindow";
import { useAgentWindowGeometry } from "@/components/kanban/agentWindowGeometry";
import { engineWord } from "@/components/kanban/identityMarks";
import { CloseGlyph } from "@/components/kanban/kanbanGlyphs";
import { cycleOpenAgent, type OpenAgent } from "@/components/kanban/openAgents";
import { MobileBarTitle, MobileShell, type MobileShellHost } from "@/components/mobile/MobileShell";
import { mobileRowState, type MobileRowDot } from "@/components/mobile/mobileBoardModel";
import { QuietFileRow } from "@/components/ProjectTrash";
import { RoleFrameMark } from "@/components/RoleFrameMark";
import { cleanTitle, fileModelLabel, fmtAge } from "@/components/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { relayChatsProject, shortChatKey, type RelayAnswerRow, type RelayChatRow, type RelayChatsPayload } from "@/lib/externalRelay/relayChats";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";

import { outcomeText, relayErrorText } from "./ExternalRelaySection";

/*
 * The relay's per-chat conversations (relay-slice3.md §4) and the single
 * answers this install kept (relay.md §B.9) in the operator's conversation
 * list. A paired service with either is one entry of the sidebar under its own
 * name; its leaf lists them the way a project's Conversations lists its own,
 * one row per chat and context and one per answered request, and a row opens
 * in the agent window, read only: only the relay writes in these sessions, so
 * the reader has no composer and nothing here resumes, forks or deletes them.
 */

const POLL_MS = 15_000;

/** The relay's chats, read on mount and every 15 s; null while unknown or when the route refuses this Viewer. */
export function useRelayChats(enabled = true): RelayChatsPayload | null {
  const [payload, setPayload] = useState<RelayChatsPayload | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const read = async () => {
      try {
        const response = await fetch("/api/external-relay/conversations");
        const value = response.ok ? await response.json() as RelayChatsPayload : null;
        if (active) setPayload(value && Array.isArray(value.relays) && Array.isArray(value.chats) ? { ...value, answers: Array.isArray(value.answers) ? value.answers : [] } : null);
      } catch {
        if (active) setPayload(null);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled]);
  return payload;
}

const answeredAt = (answer: RelayAnswerRow) => Date.parse(answer.finishedAt ?? answer.startedAt) / 1000;

/** One sidebar entry per relay service with a readable chat conversation or a kept answer. */
export function relayChatsCatalog(payload: RelayChatsPayload | null): ProjectCatalogEntry[] {
  if (!payload) return [];
  return payload.relays.flatMap((relay) => {
    const chats = payload.chats.filter((chat) => chat.relayId === relay.id && chat.file);
    const answers = (payload.answers ?? []).filter((answer) => answer.relayId === relay.id);
    if (!chats.length && !answers.length) return [];
    return [{
      project: relayChatsProject(relay.id),
      displayName: relay.name,
      conversations: chats.length + answers.length,
      smt: Math.max(...chats.map((chat) => chat.file!.mtime), ...answers.map(answeredAt)),
      recent: true,
    }];
  });
}

/** A chat's conversation in words: the chat, whose session it is, and the target that answers there. */
export function relayChatTitle(t: TFunction, chat: RelayChatRow): string {
  return [t("relayChats.chat", { chat: shortChatKey(chat.chatKey) }), t(chat.context === "owner" ? "relayChats.context.owner" : "relayChats.context.member"), chat.targetName].filter(Boolean).join(" · ");
}

const DOT_TONE: Record<string, string> = { success: "tone-success", warning: "tone-warning", danger: "tone-danger", accent: "tone-accent", neutral: "tone-neutral" };

/** The reader's header as the board draws it: mark, dot, title and close; then the state, its age, the engine, the model and «Read only». */
function ReaderHeader({ title, dot, live, state, at, engine, model, onLeave }: {
  title: string;
  dot: MobileRowDot;
  live: boolean;
  state: string;
  /** Seconds since the epoch. */
  at: number;
  engine: string | null;
  model: string | null;
  onLeave: () => void;
}) {
  const { t } = useLocale();
  const tone = DOT_TONE[dot] ?? "tone-neutral";
  const mark = engine === "claude" || engine === "codex" ? engine : null;
  return (
    <div className="conv-head">
      <div className="ch-row">
        <RoleFrameMark role="neutral" />
        <span className={`ch-dot ${tone}${live ? " live" : ""}`} aria-hidden="true" />
        <span className="ch-title" title={title}>{title}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn sm" data-reader-close="" aria-label={t("kanban.agentWindow.close")} title={t("kanban.agentWindow.close")} onClick={onLeave}>
          <CloseGlyph />
        </button>
      </div>
      <div className="ch-meta">
        <span className={`ch-state ${tone}`}>
          {state}
          <span className="num"> · {fmtAge(at)}</span>
        </span>
        {mark ? (
          <span className="ch-engine" data-engine={mark}>
            <EngineMark engine={mark} size={12} />
            <span>{engineWord(mark)}</span>
          </span>
        ) : null}
        {model ? <span className="ch-model"><span>{model}</span></span> : null}
        <span className="ch-model" data-relay-chat-read-only="">{t("relayChats.readOnly")}</span>
      </div>
    </div>
  );
}

/** The agent window's reader over a relay conversation: the reader's header, then the feed, with a read-only line where a composer would be. */
function RelayChatReader({ file, now, onLeave }: { file: FileEntry; now: number; onLeave: () => void }) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const row = mobileRowState(file, now);
  const title = cleanTitle(file.title, 90);
  const header = <ReaderHeader title={title} dot={row.dot} live={row.key === "working"} state={t(`kanban.memberState.${row.key}`)} at={file.mtime} engine={file.engine ?? null} model={file.model ? fileModelLabel(file) : null} onLeave={onLeave} />;
  const region = {
    "data-relay-chat-reader": file.path,
    "data-reader-path": file.path,
    "data-role-host": "reader",
    "data-role": "neutral",
    role: "region",
    "aria-label": t("kanban.readerAria", { title, state: t(`kanban.memberState.${row.key}`) }),
  };
  /* The phone's pane draws no header of its own (its screen's bar does), so
     the reader's header stands above it there. */
  const pane = <BranchPane file={file} tasks={[]} isRoot={false} readOnly chrome={{ header, className: phone ? "" : "reader conv", attributes: phone ? {} : { tabIndex: "-1", ...region } }} />;
  return phone ? <div className="reader conv" tabIndex={-1} {...region}>{header}{pane}</div> : pane;
}

/** A kept answer's outcome as a dot: at work, answered, handed back, declined, or failed. */
function answerDot(answer: Pick<RelayAnswerRow, "state" | "outcome">): MobileRowDot {
  if (answer.state === "running" || !answer.outcome) return "accent";
  if (answer.outcome === "answered") return "success";
  if (answer.outcome === "declined:handoff") return "neutral";
  return answer.outcome.startsWith("declined") ? "warning" : "danger";
}
const answerOutcome = (t: TFunction, answer: Pick<RelayAnswerRow, "state" | "outcome">) =>
  answer.state === "running" || !answer.outcome ? t("externalRelay.answers.running") : outcomeText(t, answer.outcome);
/* The list row's dot in the colours activityDot gives the chats' rows. */
const ROW_DOT: Record<MobileRowDot, string> = { accent: "animate-pulse bg-accent", success: "bg-success", neutral: "bg-strong", warning: "bg-warning", danger: "bg-danger" };
const answerKey = (answer: Pick<RelayAnswerRow, "targetId" | "requestId">) => `answer:${answer.targetId}:${answer.requestId}`;
/** An answer's name in a row and the window: the start of the message it answered, else the target it came through. */
const answerTitle = (t: TFunction, answer: RelayAnswerRow) => cleanTitle(answer.request, 90) || [t("relayChats.answers"), answer.targetName].filter(Boolean).join(" · ");

const DELIVERY_KEYS = {
  accepted: "externalRelay.answers.delivery.accepted",
  refused: "externalRelay.answers.delivery.refused",
  unconfirmed: "externalRelay.answers.delivery.unconfirmed",
} as const;
type AnswerRecord = Omit<RelayAnswerRow, "relayId" | "targetName" | "request" | "answer"> & {
  engine: string | null;
  model: string | null;
  answer: { action: string; text: string; reply_to: string | null } | null;
  input: unknown;
};
type ReceivedInput = {
  conversation?: { id?: unknown; author?: { key?: unknown; name?: unknown }; text?: unknown }[];
  respond_to?: unknown;
  request_text?: unknown;
  requester?: { key?: unknown; is_admin?: unknown; is_owner?: unknown; is_anonymous_admin?: unknown } | null;
  tools?: unknown[];
};
/** The message a received input answers, its author's name, and the request text, all as plain strings. */
function receivedMessage(input: unknown): { text: string; author: string | null } {
  const value = (input && typeof input === "object" ? input : {}) as ReceivedInput;
  const conversation = Array.isArray(value.conversation) ? value.conversation : [];
  const trigger = conversation.find((message) => message?.id === value.respond_to);
  const parts = [typeof trigger?.text === "string" ? trigger.text : null, typeof value.request_text === "string" ? value.request_text : null].filter(Boolean);
  return { text: parts.join("\n\n"), author: typeof trigger?.author?.name === "string" ? trigger.author.name : null };
}
const seconds = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);
const stamp = (value: string, locale: string) => new Date(value).toLocaleString(locale === "uk" ? "uk-UA" : "en-US");

/**
 * One kept answer read in the agent window (relay.md §B.9): the reader's
 * header, then when it came and how it went, who asked, the message, the
 * answer, and the input exactly as received under a fold. Nothing here writes;
 * everything the service or a chat participant wrote is plain text.
 */
function RelayAnswerReader({ relayId, answer, onLeave }: { relayId: string; answer: RelayAnswerRow; onLeave: () => void }) {
  const { t, locale } = useLocale();
  const [shown, setShown] = useState<AnswerRecord | "gone" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/external-relay/relays/${encodeURIComponent(relayId)}/targets/${encodeURIComponent(answer.targetId)}/answers/${encodeURIComponent(answer.requestId)}`;
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(url);
        const body = await response.json().catch(() => null) as { answer?: AnswerRecord; error?: string } | null;
        if (!active) return;
        if (response.ok && body?.answer) { setShown(body.answer); setError(null); }
        else if (response.status === 404) setShown("gone");
        else setError(body?.error ?? "unavailable");
      } catch {
        if (active) setError("unreachable");
      }
    })();
    return () => { active = false; };
  }, [url]);
  const title = answerTitle(t, answer);
  const record = shown && shown !== "gone" ? shown : null;
  const received = record ? receivedMessage(record.input) : null;
  const input = (record?.input && typeof record.input === "object" ? record.input : {}) as ReceivedInput;
  const requester = input.requester;
  const engine = record?.engine === "claude" || record?.engine === "codex" ? record.engine : null;
  const model = record?.model ? (engine ? ENGINE_MODELS[engine].find((item) => item.id === record.model)?.label : null) ?? record.model : null;
  const state = answerOutcome(t, record ?? answer);
  const term = "text-muted";
  const detail = "min-w-0 break-words text-primary";
  const block = "whitespace-pre-wrap break-words rounded-control bg-sunken px-2.5 py-1.5 text-primary";
  return (
    <div className="reader conv" tabIndex={-1} data-relay-answer-reader={answer.requestId} data-role-host="reader" data-role="neutral" role="region"
      aria-label={t("kanban.readerAria", { title, state })}>
      <ReaderHeader title={title} dot={answerDot(record ?? answer)} live={(record ?? answer).state === "running"} state={state}
        at={answeredAt(answer)} engine={record?.engine ?? null} model={model} onLeave={onLeave} />
      <div data-relay-answer-body="" className="min-h-0 flex-1 space-y-3 overflow-y-auto text-ui">
        {error ? <p role="alert" className="rounded-control bg-danger/10 px-2.5 py-1.5 text-danger">{relayErrorText(t, error)}</p> : null}
        {shown === "gone" ? <p data-relay-answer-gone="" className="text-muted">{t("externalRelay.answers.gone")}</p> : null}
        {!shown && !error ? <p className="text-muted">{t("common.loading")}</p> : null}
        {record && received ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className={term}>{t("externalRelay.answers.received")}</dt>
              <dd className={detail}>{stamp(record.startedAt, locale)}</dd>
              {record.durationMs !== null ? <><dt className={term}>{t("externalRelay.answers.took")}</dt><dd className={detail}>{t("externalRelay.answers.seconds", { seconds: seconds(record.durationMs) })}</dd></> : null}
              <dt className={term}>{t("externalRelay.answers.outcome")}</dt>
              <dd data-relay-answer-outcome={record.outcome ?? "running"} className={detail}>{state}</dd>
              {record.delivery ? <><dt className={term}>{t("externalRelay.answers.delivery")}</dt><dd className={detail}>{t(DELIVERY_KEYS[record.delivery])}</dd></> : null}
              {requester && typeof requester.is_admin === "boolean" ? <><dt className={term}>{t("externalRelay.answers.askedBy")}</dt><dd data-relay-answer-asked-by="" className={detail}>{[received.author, t(requester.is_admin === true ? "externalRelay.answers.role.admin" : "externalRelay.answers.role.member"), requester.is_owner === true ? t("externalRelay.answers.role.owner") : null, requester.is_anonymous_admin === true ? t("externalRelay.answers.role.anonymous") : null].filter(Boolean).join(" · ")}</dd></> : null}
              {Array.isArray(input.tools) && input.tools.length ? <><dt className={term}>{t("externalRelay.answers.tools")}</dt><dd className={detail}>{input.tools.length}</dd></> : null}
            </dl>
            <section className="space-y-1">
              <h3 className="text-caption font-semibold text-muted">{t("externalRelay.answers.request")}</h3>
              <p data-relay-answer-request="" className={block}>{received.text || t("externalRelay.none")}</p>
            </section>
            <section className="space-y-1">
              <h3 className="text-caption font-semibold text-muted">{t("externalRelay.answers.answer")}</h3>
              <p data-relay-answer-answer={record.answer?.action ?? "none"} className={block}>
                {record.answer?.action === "reply" ? record.answer.text : record.answer?.action === "handoff" ? t("externalRelay.answers.handedOff") : record.answer?.action === "ignore" ? t("externalRelay.answers.ignored") : t("externalRelay.answers.noAnswer")}
              </p>
            </section>
            <details className="space-y-1">
              <summary className="min-h-7 cursor-pointer content-center text-caption font-semibold text-muted max-sm:min-h-11">{t("externalRelay.answers.input")}</summary>
              <pre data-relay-answer-input="" className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-control bg-sunken p-2.5 font-mono text-[12px] text-primary">{JSON.stringify(record.input, null, 2)}</pre>
            </details>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A kept answer as one row of the list, beside the chats' rows and drawn like them: outcome dot, the message, then the outcome, target and age. */
function AnswerRow({ answer, onOpen }: { answer: RelayAnswerRow; onOpen: () => void }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const title = answerTitle(t, answer);
  const meta = [answerOutcome(t, answer), answer.targetName].filter(Boolean).join(" · ");
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[8px] border border-border bg-card px-3 py-1.5 shadow-1">
      <button type="button" onClick={onOpen} aria-label={t("trash.open", { title: cleanTitle(title, 60) })}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-[6px] text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${isMobile ? "min-h-11" : "h-full"}`}>
        <span data-relay-answer-dot={answerDot(answer)} className={`h-2 w-2 shrink-0 rounded-full ${ROW_DOT[answerDot(answer)]}`} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
          <span className="min-w-0 truncate text-[12.5px] font-semibold sm:flex-1" title={answer.request || undefined}>{title}</span>
          <span data-relay-answer-meta="" className="min-w-0 truncate text-[10.5px] font-semibold text-muted sm:max-w-[45%] sm:shrink-0">{isMobile ? `${meta} · ${fmtAge(answeredAt(answer))}` : meta}</span>
        </span>
        {isMobile ? null : <span className="shrink-0 text-[10.5px] font-semibold text-muted">{fmtAge(answeredAt(answer))}</span>}
      </button>
    </div>
  );
}

/**
 * The leaf of one relay service: its chats' conversations, newest first, and
 * the agent window over them. `payload` is the Viewer's one poll of the route.
 */
export function RelayChatsView({ relayId, payload, mobileShell = null }: { relayId: string; payload: RelayChatsPayload | null; mobileShell?: MobileShellHost | null }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const relay = payload?.relays.find((item) => item.id === relayId) ?? null;
  const chats = useMemo(() => (payload?.chats ?? [])
    .filter((chat) => chat.relayId === relayId && chat.file)
    .map((chat) => ({ chat, file: { ...chat.file!, title: relayChatTitle(t, chat) } })), [payload, relayId, t]);
  const answers = useMemo(() => (payload?.answers ?? []).filter((answer) => answer.relayId === relayId), [payload, relayId]);
  const [open, setOpen] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  useAgentWindowGeometry(rootRef);
  type Item = { file: FileEntry; answer?: never } | { answer: RelayAnswerRow; file?: never };
  const byId = useMemo(() => new Map<string, Item>([
    ...chats.map((item) => [item.chat.id, { file: item.file }] as const),
    ...answers.map((answer) => [answerKey(answer), { answer }] as const),
  ]), [chats, answers]);
  /* A chat the relay deleted (retention, unpair) or an answer past its days leaves the window too. */
  const openIds = open.filter((id) => byId.has(id));
  const currentId = current && byId.has(current) ? current : openIds[openIds.length - 1] ?? null;
  const agents: OpenAgent[] = openIds.map((id) => {
    const { file, answer } = byId.get(id)!;
    if (answer) {
      const running = answer.state === "running";
      return { key: id, name: answerTitle(t, answer), card: relay?.name ?? null, role: "neutral", tone: answerDot(answer), live: running, state: running ? "working" : "done" };
    }
    const row = mobileRowState(file, now);
    return { key: id, name: file.title, card: relay?.name ?? null, role: "neutral", tone: row.dot, live: row.key === "working", state: row.key };
  });
  const openItem = (id: string) => {
    setOpen((list) => list.includes(id) ? list : [...list, id]);
    setCurrent(id);
    setShown(true);
  };
  const openChat = (file: FileEntry) => {
    const id = chats.find((item) => item.file.path === file.path)?.chat.id;
    if (id) openItem(id);
  };
  const close = (id: string) => {
    const next = openIds.filter((item) => item !== id);
    setOpen(next);
    if (!next.length) setShown(false);
    if (currentId === id) setCurrent(next[Math.max(0, openIds.indexOf(id) - 1)] ?? next[0] ?? null);
  };
  const step = (direction: 1 | -1) => setCurrent(cycleOpenAgent(openIds, currentId, direction));
  const windowOpen = shown && currentId !== null;
  /* Esc leaves the window, Alt+J and Alt+K step round it, as on the board. */
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; });
  useEffect(() => {
    if (!windowOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); setShown(false); return; }
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code === OPEN_AGENTS_SHORTCUT.next) { event.preventDefault(); stepRef.current(1); }
      else if (event.code === OPEN_AGENTS_SHORTCUT.previous) { event.preventDefault(); stepRef.current(-1); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [windowOpen]);
  const shownItem = currentId ? byId.get(currentId) ?? null : null;
  const shownTitle = shownItem?.answer ? answerTitle(t, shownItem.answer) : shownItem?.file.title;
  const reader = !shownItem ? null : shownItem.answer
    ? <RelayAnswerReader key={currentId} relayId={relayId} answer={shownItem.answer} onLeave={() => setShown(false)} />
    : <RelayChatReader key={shownItem.file.path} file={shownItem.file} now={now} onLeave={() => setShown(false)} />;
  const total = chats.length + answers.length;
  const days = payload?.retentionDays ?? 30;
  const name = relay?.name ?? t("relayChats.heading");

  const list = (
    <div data-relay-chats-scroll="" className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-baseline gap-2">
          <h2 className="min-w-0 truncate text-[13.5px] font-semibold text-muted">{isMobile ? t("relayChats.heading") : `${name} · ${t("relayChats.heading")}`}</h2>
          {payload ? <span data-relay-chats-count="" className="text-[11px] font-bold tabular-nums text-muted">{total}</span> : null}
        </div>
        <p className="mb-3 mt-0.5 text-[12px] text-muted">{t("relayChats.hint")}</p>
        {chats.length ? (
          <div data-relay-chats-rows="" className="space-y-1.5">
            {chats.map(({ chat, file }) => (
              <div key={chat.id} data-relay-chat={chat.id} data-relay-chat-context={chat.context}>
                <QuietFileRow file={file} activeSubtree={false} deletable={false} onOpen={openChat} />
              </div>
            ))}
          </div>
        ) : null}
        {answers.length ? (
          <section data-relay-answers="" className={chats.length ? "mt-4" : undefined}>
            <div className="flex items-baseline gap-2">
              <h3 className="min-w-0 truncate text-[12.5px] font-semibold text-muted">{t("relayChats.answers")}</h3>
              <span data-relay-answers-count="" className="text-[11px] font-bold tabular-nums text-muted">{answers.length}</span>
            </div>
            <p className="mb-2 mt-0.5 text-[12px] text-muted">{t("externalRelay.answers.kept", { days })}</p>
            <div data-relay-answer-rows="" className="space-y-1.5">
              {answers.map((answer) => (
                <div key={answerKey(answer)} data-relay-answer={answer.requestId} data-relay-answer-target={answer.targetId}>
                  <AnswerRow answer={answer} onOpen={() => openItem(answerKey(answer))} />
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <p role="status" data-relay-chats-state={payload ? total ? "end" : "empty" : "loading"} className="mt-3 flex min-h-11 items-center justify-center text-center text-[12.5px] font-semibold text-muted">
          {!payload ? t("common.loading") : total ? t("list.endAll", { count: total }) : t("relayChats.empty", { days })}
        </p>
      </div>
    </div>
  );

  const agentWindow = !windowOpen || !reader ? null : isMobile ? (
    <div className="reader-screen" data-relay-chat-window={currentId} role="dialog" aria-modal="true" aria-label={shownTitle}>
      <div className="reader-host">{reader}</div>
    </div>
  ) : (
    <AgentWindow agents={agents} current={currentId} pending={false} onJump={(id) => setCurrent(id)} onStep={step} onClose={close} onCloseAll={() => { setOpen([]); setShown(false); }} onLeave={() => setShown(false)}>
      <div className="reader-slot" data-reader-slot={currentId!}>
        <div className="reader-host">{reader}</div>
      </div>
    </AgentWindow>
  );

  const body = (
    <div ref={rootRef} data-relay-chats={relayId} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {list}
      {/* The window is fixed over the page; its board wrapper is a flex item
          that would take half the column from the list while nothing is open. */}
      {agentWindow ? <div className="kb">{agentWindow}</div> : null}
    </div>
  );
  if (!isMobile) return body;
  return (
    <MobileShell
      screen="board"
      title={<MobileBarTitle>{name}</MobileBarTitle>}
      titleLabel={t("mobile2.bar.switchProject")}
      titleOpens={mobileShell ? "projects" : undefined}
      host={mobileShell}
      menu={false}
    >
      {body}
    </MobileShell>
  );
}
