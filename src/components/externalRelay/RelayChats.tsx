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
import { mobileRowState } from "@/components/mobile/mobileBoardModel";
import { QuietFileRow } from "@/components/ProjectTrash";
import { RoleFrameMark } from "@/components/RoleFrameMark";
import { cleanTitle, fileModelLabel, fmtAge } from "@/components/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { relayChatsProject, shortChatKey, type RelayChatRow, type RelayChatsPayload } from "@/lib/externalRelay/relayChats";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";

/*
 * The relay's per-chat conversations (relay-slice3.md §4) in the operator's
 * conversation list. A paired service whose chats hold conversations is one
 * entry of the sidebar under its own name; its leaf lists them the way a
 * project's Conversations lists its own, one row per chat and context, and a
 * row opens the conversation in the agent window, read only: only the relay
 * writes in these sessions, so the reader has no composer and nothing here
 * resumes, forks or deletes them.
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
        if (active) setPayload(value && Array.isArray(value.relays) && Array.isArray(value.chats) ? value : null);
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

/** One sidebar entry per relay service whose chats hold a readable conversation. */
export function relayChatsCatalog(payload: RelayChatsPayload | null): ProjectCatalogEntry[] {
  if (!payload) return [];
  return payload.relays.flatMap((relay) => {
    const chats = payload.chats.filter((chat) => chat.relayId === relay.id && chat.file);
    if (!chats.length) return [];
    return [{
      project: relayChatsProject(relay.id),
      displayName: relay.name,
      conversations: chats.length,
      smt: Math.max(...chats.map((chat) => chat.file!.mtime)),
      recent: true,
    }];
  });
}

/** A chat's conversation in words: the chat, whose session it is, and the target that answers there. */
export function relayChatTitle(t: TFunction, chat: RelayChatRow): string {
  return [t("relayChats.chat", { chat: shortChatKey(chat.chatKey) }), t(chat.context === "owner" ? "relayChats.context.owner" : "relayChats.context.member"), chat.targetName].filter(Boolean).join(" · ");
}

const DOT_TONE: Record<string, string> = { success: "tone-success", warning: "tone-warning", danger: "tone-danger", accent: "tone-accent", neutral: "tone-neutral" };

/** The agent window's reader over a relay conversation: the reader's header, then the feed, with a read-only line where a composer would be. */
function RelayChatReader({ file, now, onLeave }: { file: FileEntry; now: number; onLeave: () => void }) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const row = mobileRowState(file, now);
  const tone = DOT_TONE[row.dot] ?? "tone-neutral";
  const engine = file.engine === "claude" || file.engine === "codex" ? file.engine : null;
  const title = cleanTitle(file.title, 90);
  const header = (
    <div className="conv-head">
      <div className="ch-row">
        <RoleFrameMark role="neutral" />
        <span className={`ch-dot ${tone}${row.key === "working" ? " live" : ""}`} aria-hidden="true" />
        <span className="ch-title" title={title}>{title}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn sm" data-reader-close="" aria-label={t("kanban.agentWindow.close")} title={t("kanban.agentWindow.close")} onClick={onLeave}>
          <CloseGlyph />
        </button>
      </div>
      <div className="ch-meta">
        <span className={`ch-state ${tone}`}>
          {t(`kanban.memberState.${row.key}`)}
          <span className="num"> · {fmtAge(file.mtime)}</span>
        </span>
        {engine ? (
          <span className="ch-engine" data-engine={engine}>
            <EngineMark engine={engine} size={12} />
            <span>{engineWord(engine)}</span>
          </span>
        ) : null}
        {file.model ? <span className="ch-model"><span>{fileModelLabel(file)}</span></span> : null}
        <span className="ch-model" data-relay-chat-read-only="">{t("relayChats.readOnly")}</span>
      </div>
    </div>
  );
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
  const byId = useMemo(() => new Map(chats.map((item) => [item.chat.id, item] as const)), [chats]);
  /* A chat the relay deleted (retention, unpair) leaves the window too. */
  const openIds = open.filter((id) => byId.has(id));
  const currentId = current && byId.has(current) ? current : openIds[openIds.length - 1] ?? null;
  const agents: OpenAgent[] = openIds.map((id) => {
    const { file } = byId.get(id)!;
    const row = mobileRowState(file, now);
    return { key: id, name: file.title, card: relay?.name ?? null, role: "neutral", tone: row.dot, live: row.key === "working", state: row.key };
  });
  const openChat = (file: FileEntry) => {
    const id = chats.find((item) => item.file.path === file.path)?.chat.id;
    if (!id) return;
    setOpen((list) => list.includes(id) ? list : [...list, id]);
    setCurrent(id);
    setShown(true);
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
  const shownFile = currentId ? byId.get(currentId)?.file ?? null : null;
  const reader = shownFile ? <RelayChatReader key={shownFile.path} file={shownFile} now={now} onLeave={() => setShown(false)} /> : null;
  const name = relay?.name ?? t("relayChats.heading");

  const list = (
    <div data-relay-chats-scroll="" className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-baseline gap-2">
          <h2 className="min-w-0 truncate text-[13.5px] font-semibold text-muted">{isMobile ? t("relayChats.heading") : `${name} · ${t("relayChats.heading")}`}</h2>
          {payload ? <span data-relay-chats-count="" className="text-[11px] font-bold tabular-nums text-muted">{chats.length}</span> : null}
        </div>
        <p className="mb-3 mt-0.5 text-[12px] text-muted">{t("relayChats.hint")}</p>
        <div data-relay-chats-rows="" className="space-y-1.5">
          {chats.map(({ chat, file }) => (
            <div key={chat.id} data-relay-chat={chat.id} data-relay-chat-context={chat.context}>
              <QuietFileRow file={file} activeSubtree={false} deletable={false} onOpen={openChat} />
            </div>
          ))}
        </div>
        <p role="status" data-relay-chats-state={payload ? chats.length ? "end" : "empty" : "loading"} className="mt-3 flex min-h-11 items-center justify-center text-center text-[12.5px] font-semibold text-muted">
          {!payload ? t("common.loading") : chats.length ? t("list.endAll", { count: chats.length }) : t("relayChats.empty")}
        </p>
      </div>
    </div>
  );

  const agentWindow = !windowOpen || !reader ? null : isMobile ? (
    <div className="reader-screen" data-relay-chat-window={currentId} role="dialog" aria-modal="true" aria-label={shownFile?.title}>
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
      <div className="kb">{agentWindow}</div>
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
