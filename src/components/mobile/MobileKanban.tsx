"use client";

import { ArrowRight, Ban, Check, CircleCheck, EyeOff, Inbox, MessageSquare, Plus, TriangleAlert, UserRoundCheck } from "lucide-react";
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type TouchEvent as ReactTouchEvent,
} from "react";

import { clearedLine, needLabel } from "@/components/attention/decision";
import { sendDismissal } from "@/components/attention/dismissalOverlay";
import { EngineMark } from "@/components/EngineMark";
import { ChevronRight } from "@/components/icons";
import { KANBAN_STATUSES, type KanbanCard as KanbanCardModel } from "@/components/kanban/kanbanModel";
import { subjectOf } from "@/components/kanban/cardDismissal";
import { statusLabel, TASK_COLOR_HEX } from "@/components/kanban/KanbanCard";
import { pipelineTitle } from "@/components/kanban/PipelineSection";
import { useTaskMutations, type StatusMoveOutcome, type TaskMutationPorts } from "@/components/kanban/useTaskMutations";
import { PipelineBlock } from "@/components/pipelines/PipelineBlock";
import { TaskIcon } from "@/components/tasks/TaskIcon";
import { updateTask } from "@/components/tasks/taskApi";
import { blockAgeSeconds } from "@/components/pipelines/pipelineBlockModel";
import { humanizeDuration } from "@/components/turnDuration";
import { fileModelLabel } from "@/components/utils";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { BADGE_LABEL, statePhrase } from "./MobileBoard";
import { showReceipt } from "./MobileReceipt";
import type { MobileRowActionTarget } from "./MobileRowActions";
import { MobileSheet } from "./MobileSheet";
import { ROW_ACTION_TONE, type MobileRowAction } from "./MobileSwipeRow";
import { useMobileNav, useMobileNavStore, useSheetSelection } from "./mobileNav";
import { mobileRowState } from "./mobileBoardModel";
import { buildPhoneKanban, columnEmpty, nearestWithWork, type PhoneCard, type PhoneColumn } from "./phoneKanbanModel";
import { readPlace, usePhoneKanbanColumn, usePhoneKanbanDoneShown, writePlace } from "./phoneKanbanPlace";
import { LONG_PRESS_MS, SWIPE_LOCK_PX } from "./swipeIntent";
import { usePhoneBoardModel, type PhoneBoardInput, type TaskMutations } from "./usePhoneBoard";

/*
 * The phone's board as status columns (#2072 slice 4; docs/design/phone-kanban.md
 * §3.1-§3.4, §3.7-§3.9). The desktop's four columns, one at a time: a tab strip
 * with each column's count and its ●working and ⚠needs-you marks, and under it
 * a horizontal scroll-snap pager, one column per page, each page scrolling on
 * its own. The tabs follow the pager and the pager follows the tabs; the
 * column and every page's offset are kept per project for the session
 * (`phoneKanbanPlace`), so ‹ from a card lands where the operator left.
 *
 * The cards are the desktop's cards (`useBands` → `buildKanbanModel`, with the
 * seat taken out), read by `phoneKanbanModel`: what needs the operator first,
 * in the attention queue's order, then the desktop's order; Done windowed;
 * Inbox ending with Not on a task. A card is one button, and its pipeline is
 * the one pipeline block at card density. A long-press opens the card's
 * sheet: Move to, Hide from board, Open first agent — the moves ride the
 * desktop's optimistic, revision-guarded mutations and answer with a receipt
 * that carries Undo. Nothing on the board swipes sideways: the pager owns
 * that gesture (§3.8).
 */

const CARD = "flex w-full min-h-14 flex-col gap-1.5 rounded-[12px] bg-card px-3 py-2.5 text-left shadow-1 active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";
/* A card with a Dismiss or an Undo beside its body: the frame holds both, so
   the card's own button and the control never overlap (#699). */
const FRAME = "flex w-full min-w-0 items-stretch rounded-[12px] bg-card shadow-1";
const BODY = "flex min-h-14 min-w-0 flex-1 flex-col gap-1.5 rounded-[12px] py-2.5 pl-3 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";
const QUIET = "bg-quiet shadow-none ring-1 ring-inset ring-border";
const EDGE: Record<"warning" | "danger", string> = {
  warning: "shadow-[inset_3px_0_0_var(--color-warning),var(--shadow-1)]",
  danger: "shadow-[inset_3px_0_0_var(--color-danger),var(--shadow-1)]",
};
const BADGE_TONE: Record<"warning" | "danger", string> = {
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};
const STATUS_LABEL: Record<TaskStatus, MessageKey> = {
  inbox: "kanban.status.inbox",
  assigned: "kanban.status.assigned",
  blocked: "kanban.status.blocked",
  done: "kanban.status.done",
};
const STATUS_ICON: Record<TaskStatus, typeof Inbox> = { inbox: Inbox, assigned: UserRoundCheck, blocked: Ban, done: CircleCheck };
/** How long a click the browser makes after a long-press is swallowed. */
const SWALLOW_CLICK_MS = 600;
/** Two opens this close together are one press, shorter than any press. */
const DEDUPE_MS = 300;

export interface MobileKanbanProps extends PhoneBoardInput {
  /** The attention queue's order (`attentionKey`): the pin walks it as ⚠ does. */
  attention: readonly string[];
  /** The orchestrator card above the tabs; the dock takes its place later (§3.6). */
  seat?: ReactNode;
  mutationPorts?: TaskMutationPorts;
  /** The task mutations the phone's screens share; absent, the board keeps its own. */
  mutations?: TaskMutations;
  /** What a row no task owns offers on a long-press: the board rows' own actions. */
  rowActions?: (target: MobileRowActionTarget) => readonly MobileRowAction[];
  onOpenTask: (task: BoardTask) => void;
  onOpenConversation: (file: FileEntry) => void;
  onOpenPipeline: (pipeline: Pipeline) => void;
  onNewTask?: () => void;
  onTellOrchestrator?: () => void;
  /** The conversations the visible column draws, in order, for presence. */
  onShown?: (paths: readonly string[]) => void;
  /** Lanes whose close is on its way: a lane no task owns is gone on the tap. */
  closing?: readonly string[];
  /** The name a card's project reads by. The Overview spans every project
      (#2098), so each of its cards says whose it is; a project's own board
      passes nothing. Null for a project with no readable name: a card never
      shows a raw key. */
  projectLabel?: (project: string) => string | null;
  /** What an empty column says in place of its own copy, told whether another
      column has work: the Overview's permanent narrowing to live work
      (#1820), which no action undoes. */
  emptyCopy?: ((status: TaskStatus, elsewhere: boolean) => { title: string; body: string }) | null;
  /** How many tasks the board does not draw (hidden groups and empty tasks
      taken off it), for the ⋯ menu's Hidden tasks row. */
  onHiddenCount?: (count: number) => void;
}

function shortTitle(t: TFunction, item: PhoneCard): string {
  const title = item.kind === "pipeline" && item.shown ? pipelineTitle(t, item.shown.pipeline) : item.card.titlePending ? t("kanban.untitled") : item.card.title;
  return title.length > 48 ? `${title.slice(0, 46).trimEnd()}…` : title;
}

/** An age on a card, with a unit (§3.4: "4m", "1h 5m"); a day or more reads
    in days, as a task that has waited since yesterday does. */
function cardAge(t: TFunction, seconds: number): string {
  const total = Math.max(0, seconds);
  if (total >= 86_400) return t("mobile2.kanban.ageDays", { count: Math.floor(total / 86_400) });
  return humanizeDuration(blockAgeSeconds(total));
}

function ageText(t: TFunction, ms: number, nowMs: number): string {
  return cardAge(t, (nowMs - ms) / 1000);
}

/* ── Long-press ─────────────────────────────────────────────────────────── */

/**
 * A held finger (or a right click, or the keyboard's menu key) opens the
 * card's sheet, and the click the lift would leave behind is swallowed. A
 * finger that moves is the pager or the column scrolling: the press is off.
 */
function usePress(onLongPress: (() => void) | null) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const held = useRef(false);
  const openedAt = useRef(-Infinity);
  const swallowUntil = useRef(0);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  const open = (byFinger: boolean) => {
    /* One press opens one sheet: the browser's own long-press menu event
       arrives beside the timer, while the finger that opened it is down. No
       second press can come sooner than a press lasts. */
    if (!onLongPress || held.current || performance.now() - openedAt.current < DEDUPE_MS) return;
    openedAt.current = performance.now();
    cancel();
    start.current = null;
    held.current = byFinger;
    swallowUntil.current = performance.now() + SWALLOW_CLICK_MS;
    onLongPress();
  };
  if (!onLongPress) return {};
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      cancel();
      held.current = false;
      start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
      timer.current = setTimeout(() => {
        timer.current = null;
        if (start.current) open(true);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const from = start.current;
      if (!from || event.pointerId !== from.id) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > SWIPE_LOCK_PX) {
        cancel();
        start.current = null;
      }
    },
    onPointerUp: () => {
      cancel();
      start.current = null;
      /* However long the finger stayed down after the sheet opened, its lift
         still belongs to the press. */
      if (held.current) swallowUntil.current = performance.now() + SWALLOW_CLICK_MS;
      held.current = false;
    },
    onPointerCancel: () => {
      cancel();
      start.current = null;
      held.current = false;
    },
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (performance.now() >= swallowUntil.current) return;
      swallowUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      open(false);
    },
    onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => {
      if (event.cancelable && performance.now() < swallowUntil.current) event.preventDefault();
    },
  };
}

function Pressable({ onLongPress, children }: { onLongPress: (() => void) | null; children: ReactNode }) {
  const press = usePress(onLongPress);
  return <div className="select-none [-webkit-touch-callout:none]" {...press}>{children}</div>;
}

/* ── Cards ──────────────────────────────────────────────────────────────── */

function NeedBadge({ item }: { item: PhoneCard }) {
  const { t } = useLocale();
  const need = item.need;
  if (!need) return null;
  /* A lane's chip names its reason and the stage it stopped on
     (docs/design/needs-attention.md §4); a conversation's badge names its own. */
  if (need.kind === "pipeline") {
    return <span className="pstate-chip mt-px min-w-0 truncate" data-phone-card-badge="" data-pstate={need.pipeline.state}>{needLabel(t, need.reason)}</span>;
  }
  const badge = need.state.badge;
  if (!badge) return null;
  return (
    <span data-phone-card-badge="" className={`mt-px inline-flex h-5 shrink-0 items-center rounded-full px-[7px] text-caption font-semibold leading-none ${BADGE_TONE[need.state.edge ?? "warning"]}`}>
      {t(BADGE_LABEL[badge])}
    </span>
  );
}

/** The engine mark and the model, the way a board row names an agent. */
function Agent({ file }: { file: FileEntry }) {
  const model = fileModelLabel(file);
  return (
    <>
      <span data-mobile2-engine={file.engine} className="inline-flex shrink-0"><EngineMark engine={file.engine} size={16} /></span>
      {model ? <span className="shrink-0">{model}</span> : null}
    </>
  );
}

const Sep = () => <span aria-hidden className="shrink-0 opacity-60">·</span>;

/** What a conversation that asks says besides its badge: its question when
    it wrote one, else nothing — the badge already says the reason, once
    (P2-8). */
function askDetail(item: PhoneCard): string | null {
  if (item.need?.kind !== "conversation") return null;
  return item.need.member.file.pendingQuestion?.questions?.[0]?.question?.trim() || null;
}

/** What a conversation that asks nothing still has to say about itself: a
    stalled turn and a wall keep their words, in their tone, without the edge or
    the badge a reason gets (docs/design/needs-attention.md §3, reasons 4, 7). */
function quietState(t: TFunction, file: FileEntry | null, now: number): { text: string; tone: string; stalled: boolean } | null {
  if (!file) return null;
  const state = mobileRowState(file, now);
  if (state.key === "stalled") return { text: statePhrase(t, state, now), tone: "font-semibold text-danger", stalled: true };
  if (state.key === "limit") return { text: statePhrase(t, state, now), tone: "font-semibold text-warning", stalled: false };
  return null;
}

/** How long the conversation has asked, with a unit. */
function askAge(t: TFunction, item: PhoneCard): string | null {
  if (item.need?.kind !== "conversation" || item.need.state.seconds === null) return null;
  return cardAge(t, item.need.state.seconds);
}

/** A conversation that asks, on a task's card: who, what, and how long. */
function AskLine({ item }: { item: PhoneCard }) {
  const { t } = useLocale();
  if (item.need?.kind !== "conversation") return null;
  const detail = askDetail(item);
  const age = askAge(t, item);
  return (
    <span data-phone-card-ask="" className="flex min-w-0 items-center gap-[5px] text-label tabular-nums text-muted">
      <Agent file={item.need.member.file} />
      {detail ? <><Sep /><span className="min-w-0 truncate">{detail}</span></> : null}
      {age ? <><Sep /><span className="shrink-0">{age}</span></> : null}
    </span>
  );
}

/** A row no task owns (§3.2): the agent, what it asks when it asks, that it is
    on no task, and its age. One line; the badge says the state. */
function LooseLine({ item, now }: { item: PhoneCard; now: number }) {
  const { t } = useLocale();
  const file = item.need?.kind === "conversation" ? item.need.member.file : item.firstAgent;
  const detail = askDetail(item);
  const quiet = item.need ? null : quietState(t, file, now);
  const at = item.card.lastAgentWorkAtMs > 0 ? item.card.lastAgentWorkAtMs : file ? file.mtime * 1000 : 0;
  /* A stalled phrase already says how long it has been quiet. */
  const age = askAge(t, item) ?? (at > 0 && !quiet?.stalled ? ageText(t, at, now * 1000) : null);
  return (
    <span data-phone-card-meta="" className="flex min-w-0 items-center gap-[5px] text-label tabular-nums text-muted">
      {file ? <><Agent file={file} /><Sep /></> : null}
      {detail ? <><span className="min-w-0 truncate">{detail}</span><Sep /></> : null}
      {quiet ? <><span data-phone-card-state="" className={`min-w-0 truncate ${quiet.tone}`}>{quiet.text}</span><Sep /></> : null}
      <span className="shrink-0">{t("mobile2.kanban.notOnTask")}</span>
      {age ? <><Sep /><span className="shrink-0">{age}</span></> : null}
    </span>
  );
}

/** What agents do that the pipeline line does not already say (§3.4). */
function AgentsLine({ item, nowMs }: { item: PhoneCard; nowMs: number }) {
  const { t } = useLocale();
  const agents = item.agents;
  if (!agents) return null;
  return (
    <span data-phone-card-agents="" className="flex min-w-0 items-center gap-[5px] text-label tabular-nums text-muted">
      {agents.working ? (
        <>
          <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-success">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success motion-safe:animate-pulse" />
            {t("mobile2.kanban.working", { count: agents.working })}
          </span>
          <Sep />
        </>
      ) : null}
      <span className="shrink-0">{agents.conversations ? t("mobile2.kanban.agents", { count: agents.conversations }) : t("mobile2.kanban.noAgents")}</span>
      {agents.atMs > 0 ? <><Sep /><span className="shrink-0">{ageText(t, agents.atMs, nowMs)}</span></> : null}
    </span>
  );
}

function othersText(t: TFunction, item: PhoneCard): string | null {
  const parts = [
    item.others.needs ? t("mobile2.kanban.othersNeeds", { count: item.others.needs }) : null,
    item.others.running ? t("mobile2.kanban.othersRunning", { count: item.others.running }) : null,
    item.others.paused ? t("mobile2.kanban.othersPaused", { count: item.others.paused }) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Who cleared a card and how long ago: the muted line a cleared card keeps
    while what it cleared is still live. */
function ClearedLine({ item, nowMs }: { item: PhoneCard; nowMs: number }) {
  const { t } = useLocale();
  const cleared = item.cleared;
  if (!cleared) return null;
  return (
    <span data-phone-card-cleared={cleared.by.kind} className="min-w-0 truncate text-label text-muted">
      {clearedLine(t, cleared, nowMs / 1000)}
    </span>
  );
}

function CardView({ item, now, project, onOpen, onLongPress, onDismiss, onUndo }: {
  item: PhoneCard;
  /** Epoch seconds. */
  now: number;
  /** The card's project, on a board that spans several (#2098). */
  project: string | null;
  onOpen: (() => void) | null;
  onLongPress: (() => void) | null;
  /** Dismiss what the card asks (docs/design/needs-attention.md §5). */
  onDismiss: (() => void) | null;
  /** Bring back what the card shows as cleared. */
  onUndo: (() => void) | null;
}) {
  const { t } = useLocale();
  const { card } = item;
  const nowMs = now * 1000;
  const pending = item.kind === "task" && card.titlePending;
  const title = item.kind === "pipeline" && item.shown ? pipelineTitle(t, item.shown.pipeline) : pending ? t("kanban.untitled") : card.title;
  /* One coloured edge at most: the need's hue, else the task's colour label. */
  const colour = !item.edge && card.color ? { boxShadow: `inset 3px 0 0 ${TASK_COLOR_HEX[card.color]}, var(--shadow-1)` } : undefined;
  const loose = item.kind === "conversation" || item.kind === "flow";
  const label = [t(item.kind === "task" ? "mobile2.kanban.openTask" : "mobile2.kanban.openRow", { title }), project].filter(Boolean).join(", ");
  const body = (
    <>
      {project ? (
        /* Passive text: the card is one button (#699), so the project is said
           here and its board is one tap on the bar's title cell away. */
        <span data-phone-card-project={item.card.project} className="-mb-0.5 min-w-0 truncate text-label font-semibold leading-tight text-muted">
          {project}
        </span>
      ) : null}
      <span className="flex min-w-0 items-start gap-2">
        {/* The task's icon, as the desktop card resolves it (#2102), in the
            task's colour (#2190). It sits level with the first title line and
            the title wraps under itself; a task with no icon draws none, and
            its title keeps the card's edge. */}
        {item.kind === "task" ? (
          <TaskIcon
            icon={card.icon}
            title={pending ? "" : card.title}
            tint={card.color ? TASK_COLOR_HEX[card.color] : null}
            omitDefault
            className="mt-[calc((1.25em-16px)/2)] text-body"
          />
        ) : null}
        <span
          data-phone-card-title=""
          className={`min-w-0 flex-1 line-clamp-2 text-body leading-[1.25] [overflow-wrap:anywhere] ${pending ? "font-normal italic text-muted" : "font-semibold text-primary"}`}
        >
          {title}
        </span>
        <NeedBadge item={item} />
      </span>
      {item.shown && !loose ? (
        <PipelineBlock summary={item.shown} density="card" nowMs={nowMs} taskTitle={item.kind === "task" ? title : null} aside={othersText(t, item)} />
      ) : null}
      {loose ? <LooseLine item={item} now={now} /> : <AskLine item={item} />}
      <AgentsLine item={item} nowMs={nowMs} />
      <ClearedLine item={item} nowMs={nowMs} />
    </>
  );
  const tone = `${item.kind === "task" && item.finished && !item.need ? QUIET : ""} ${item.edge ? EDGE[item.edge] : ""}`;
  const aside = onDismiss || onUndo;
  const className = aside ? BODY : `${CARD} ${tone}`;
  const data = {
    "data-phone-card": item.key,
    "data-phone-card-kind": item.kind,
    "data-needs": item.need ? "1" : undefined,
    "data-edge": item.edge ?? (colour ? "colour" : undefined),
    "data-phone-card-agent": item.kind === "task" ? undefined : item.firstAgent?.path,
    "data-phone-card-pipeline": item.shown?.pipeline.id,
  };
  const face = onOpen ? (
    <button type="button" {...data} aria-label={label} className={className} style={aside ? undefined : colour} onClick={onOpen}>{body}</button>
  ) : (
    <div {...data} className={className} style={aside ? undefined : colour}>{body}</div>
  );
  return (
    <Pressable onLongPress={onLongPress}>
      {aside ? (
        <div data-phone-card-frame={item.key} className={`${FRAME} ${tone}`} style={colour}>
          {face}
          {onDismiss ? (
            <button
              type="button"
              data-phone-card-dismiss={item.key}
              aria-label={t("needs.dismissAria", { title })}
              title={t("needs.dismissHint")}
              className="grid h-11 w-11 shrink-0 place-items-center self-start rounded-[12px] text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
              onClick={onDismiss}
            >
              <Check className="h-[18px] w-[18px]" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              data-phone-card-undo={item.key}
              aria-label={t("needs.undoAria", { title })}
              className="inline-flex h-11 shrink-0 items-center self-end rounded-[12px] px-3 text-ui font-semibold text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
              onClick={onUndo ?? undefined}
            >
              {t("needs.undo")}
            </button>
          )}
        </div>
      ) : face}
    </Pressable>
  );
}

/* ── Tabs and columns ───────────────────────────────────────────────────── */

function TabMeta({ column }: { column: PhoneColumn }) {
  return (
    <span className="flex items-center gap-1.5 text-label leading-none tabular-nums text-muted">
      <span data-phone-tab-count={column.count}>{column.count}</span>
      {column.working ? (
        <span data-phone-tab-working={column.working} className="inline-flex items-center gap-[3px] font-semibold text-success">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
          {column.working}
        </span>
      ) : null}
      {column.needsYou ? (
        <span data-phone-tab-needs={column.needsYou} className="inline-flex items-center gap-[2px] font-bold text-warning">
          <TriangleAlert aria-hidden className="h-[11px] w-[11px]" />
          {column.needsYou}
        </span>
      ) : null}
    </span>
  );
}

function tabName(t: TFunction, column: PhoneColumn): string {
  return [
    t(STATUS_LABEL[column.status]),
    t("mobile2.kanban.tasks", { count: column.count }),
    column.working ? t("kanban.columnWorking", { count: column.working }) : null,
    column.needsYou ? t("kanban.columnNeeds", { count: column.needsYou }) : null,
  ].filter(Boolean).join(", ");
}

function EmptyColumn({ column, columns, copy, onJump, onNewTask, onTellOrchestrator }: {
  column: PhoneColumn;
  columns: Record<TaskStatus, PhoneColumn>;
  copy?: MobileKanbanProps["emptyCopy"];
  onJump: (status: TaskStatus) => void;
  onNewTask?: () => void;
  onTellOrchestrator?: () => void;
}) {
  const { t } = useLocale();
  const Icon = STATUS_ICON[column.status];
  const nearest = nearestWithWork(columns, column.status);
  const target = nearest ? columns[nearest] : null;
  const said = copy?.(column.status, target !== null) ?? null;
  const action = column.status === "inbox" && onNewTask
    ? { label: t("mobile2.kanban.newTask"), run: onNewTask, icon: <Plus className="h-4 w-4" aria-hidden /> }
    : column.status === "assigned" && onTellOrchestrator
      ? { label: t("mobile2.kanban.tellOrchestrator"), run: onTellOrchestrator, icon: <MessageSquare className="h-4 w-4" aria-hidden /> }
      : null;
  return (
    <div data-phone-kanban-empty={column.status} className="flex min-h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <span aria-hidden className="mb-1 grid h-12 w-12 place-items-center rounded-full bg-card text-muted shadow-1">
        <Icon className="h-[22px] w-[22px]" />
      </span>
      <span className="text-title font-semibold text-primary">{said?.title ?? t(`kanban.empty.${column.status}.title`)}</span>
      <span className="max-w-[300px] text-body text-secondary">{said?.body ?? t(`kanban.empty.${column.status}.body`)}</span>
      {action ? (
        <button
          type="button"
          data-phone-kanban-empty-action={column.status}
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent px-4 text-ui font-semibold text-white active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2"
          onClick={action.run}
        >
          {action.icon}
          {action.label}
        </button>
      ) : null}
      {target ? (
        /* The other tabs keep their counts; this row is where the work is. */
        <button
          type="button"
          data-phone-kanban-nearest={target.status}
          className="mt-3 inline-flex min-h-11 max-w-full items-center gap-[5px] rounded-full border border-border bg-card px-4 text-ui tabular-nums text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => onJump(target.status)}
        >
          <span className="shrink-0 font-semibold text-primary">{t(STATUS_LABEL[target.status])}</span>
          <Sep />
          <span className="shrink-0">{t("mobile2.kanban.tasks", { count: target.count })}</span>
          {target.working ? <><Sep /><span className="shrink-0 font-semibold text-success">{t("mobile2.kanban.working", { count: target.working })}</span></> : null}
          <ChevronRight aria-hidden className="ml-0.5 h-4 w-4 shrink-0 text-muted" />
        </button>
      ) : null}
    </div>
  );
}

/* ── The card sheet ─────────────────────────────────────────────────────── */

interface SheetRow {
  key: string;
  name: string;
  hint: string;
  icon: ReactNode;
  tone: MobileRowAction["tone"];
  run: () => void;
}

function CardSheet({ title, rows, onClose }: { title: string; rows: readonly SheetRow[]; onClose: () => void }) {
  return (
    <MobileSheet name="card" title={title} onClose={onClose}>
      <div data-phone-card-sheet="" className="flex flex-col py-1">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            data-phone-card-action={row.key}
            className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            onClick={() => {
              onClose();
              row.run();
            }}
          >
            <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${ROW_ACTION_TONE[row.tone]}`}>{row.icon}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`text-body font-semibold ${row.tone === "danger" ? "text-danger" : "text-primary"}`}>{row.name}</span>
              <span className="text-label text-muted">{row.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </MobileSheet>
  );
}

/* ── Hidden tasks ───────────────────────────────────────────────────────── */

/** How many hidden rows the sheet lists before «Show more». */
const HIDDEN_WINDOW = 40;

type HiddenRow =
  | { kind: "group"; key: string; card: KanbanCardModel }
  | { kind: "task"; key: string; task: BoardTask };

/**
 * What the board is not drawing (§3.2: ⋯ › Hidden tasks), the phone's form of
 * the desktop's hidden tray: task groups hidden from a card's sheet or by an
 * agent, then empty tasks taken off the board. Each row brings its task back
 * with Show; nothing here stops, deletes or sends anything. The Overview's
 * list spans every project, so it is windowed, and each row names its project
 * there.
 */
function HiddenSheet({ rows, nowMs, projectLabel, onShowGroup, onShowTask, onClose }: {
  rows: readonly HiddenRow[];
  nowMs: number;
  projectLabel?: (project: string) => string | null;
  onShowGroup: (card: KanbanCardModel) => void;
  onShowTask: (task: BoardTask) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [shown, setShown] = useState(HIDDEN_WINDOW);
  const visible = rows.slice(0, shown);
  const more = rows.length - visible.length;
  const titleOf = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
  return (
    <MobileSheet name="hidden" title={`${t("kanban.hiddenTitle")} · ${rows.length}`} onClose={onClose}>
      <div data-phone-hidden-sheet={rows.length} className="flex min-h-0 flex-col overflow-y-auto overscroll-y-contain py-1">
        {visible.map((row) => {
          const status = row.kind === "group" ? row.card.status : row.task.status;
          const title = row.kind === "group" ? (row.card.titlePending ? t("kanban.untitled") : row.card.title) : titleOf(row.task.text);
          const project = projectLabel?.(row.kind === "group" ? row.card.project : row.task.project) ?? null;
          let meta: string;
          if (row.kind === "group") {
            const hide = row.card.task?.groupHidden;
            const since = hide ? Date.parse(hide.at) : Number.NaN;
            /* On the board's clock, with a unit, as a card says its ages. */
            const age = Number.isFinite(since) ? (nowMs - since < 60_000 ? t("kanban.justNow") : cardAge(t, (nowMs - since) / 1000)) : "";
            meta = [
              row.card.working ? t("kanban.trayWorking", { count: row.card.working }) : null,
              t("kanban.trayConversations", { count: row.card.conversations }),
              hide ? t("kanban.trayGroupMeta", { who: t(hide.by === "agent" ? "kanban.hiddenBy.agent" : "kanban.hiddenBy.operator"), age }) : null,
            ].filter(Boolean).join(" · ");
          } else {
            meta = t("kanban.offBoardMeta");
          }
          return (
            <div key={row.key} data-phone-hidden-row={row.kind === "group" ? row.card.task?.id : row.task.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="line-clamp-2 text-body font-semibold leading-[1.25] text-primary [overflow-wrap:anywhere]">{title}</span>
                <span className="min-w-0 truncate text-label text-muted">
                  {[project, statusLabel(t, status), meta].filter(Boolean).join(" · ")}
                </span>
              </span>
              <button
                type="button"
                data-phone-hidden-show=""
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-border bg-card px-3.5 text-ui font-semibold text-accent active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => (row.kind === "group" ? onShowGroup(row.card) : onShowTask(row.task))}
              >
                {t("kanban.showOnBoard")}
              </button>
            </div>
          );
        })}
        {more > 0 ? (
          <button
            type="button"
            data-phone-hidden-more={more}
            className="mx-4 my-1 inline-flex min-h-11 items-center justify-center rounded-[12px] bg-quiet text-ui font-semibold text-secondary ring-1 ring-inset ring-border active:bg-sunken"
            onClick={() => setShown((count) => count + HIDDEN_WINDOW)}
          >
            {t("mobile2.kanban.showMore", { count: Math.min(HIDDEN_WINDOW, more) })}
          </button>
        ) : null}
        <p className="px-4 pb-2 pt-1.5 text-label text-muted">{rows.length ? t("kanban.trayNote") : t("mobile2.kanban.hiddenNothing")}</p>
      </div>
    </MobileSheet>
  );
}

/* ── The board ──────────────────────────────────────────────────────────── */

export function MobileKanban(props: MobileKanbanProps) {
  const { t } = useLocale();
  const { project, allTasks: storedTasks, now } = props;
  const nav = useMobileNavStore();
  const navState = useMobileNav();
  const ids = useId().replace(/:/g, "");

  /* The desktop's mutations: a move or a hide shows at once, is written with
     the task's revision as its guard, and a refusal puts the card back. The
     dashboard hands in the set the task screen shares, so a move made there
     is still drawn here after ‹. */
  const own = useTaskMutations(storedTasks, props.mutationPorts);
  const { controller, statuses, edits } = props.mutations ?? own;
  const { model, modelNow } = usePhoneBoardModel(props, { statuses, edits });
  const doneShown = usePhoneKanbanDoneShown(project);
  const phone = useMemo(
    () => buildPhoneKanban({ model, attention: props.attention, doneShown, closing: props.closing, now: modelNow }),
    [model, props.attention, doneShown, props.closing, modelNow],
  );
  const active = usePhoneKanbanColumn(project);
  const tasksById = useRef(new Map<string, BoardTask>());
  tasksById.current = new Map(storedTasks.map((task) => [task.id, task] as const));

  /* ── The pager ──────────────────────────────────────────────────────── */
  const pager = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<TaskStatus, HTMLElement>());
  /* A tab tap steers the pager; the columns it passes on the way are not
     choices, so the tabs wait for it to arrive. */
  const steering = useRef<{ to: TaskStatus; until: number } | null>(null);
  const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const place = useCallback((status: TaskStatus, smooth: boolean) => {
    const element = pager.current;
    if (!element) return;
    const left = KANBAN_STATUSES.indexOf(status) * element.clientWidth;
    if (smooth && typeof element.scrollTo === "function") element.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
    else element.scrollLeft = left;
  }, []);
  /* The board opens where the operator left it: the column, then each page's
     offset, before the first paint. */
  useLayoutEffect(() => {
    const saved = readPlace(project);
    place(saved.column, false);
    for (const status of KANBAN_STATUSES) {
      const page = pages.current.get(status);
      if (page) page.scrollTop = saved.offsets[status] ?? 0;
    }
  }, [project, place]);
  /* A new width (a rotation, the keyboard) keeps the column in view. */
  useEffect(() => {
    const element = pager.current;
    if (!element || typeof ResizeObserver !== "function") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      place(readPlace(project).column, false);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [project, place]);
  const choose = (status: TaskStatus) => {
    steering.current = { to: status, until: performance.now() + 900 };
    writePlace(project, { column: status });
    place(status, true);
  };
  const onPagerScroll = () => {
    const element = pager.current;
    if (!element || !element.clientWidth) return;
    const status = KANBAN_STATUSES[Math.round(element.scrollLeft / element.clientWidth)];
    if (!status) return;
    const steer = steering.current;
    if (steer) {
      if (status !== steer.to && performance.now() < steer.until) return;
      steering.current = null;
    }
    if (status !== readPlace(project).column) writePlace(project, { column: status });
  };
  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = KANBAN_STATUSES.indexOf(active);
    const next = event.key === "ArrowRight" ? KANBAN_STATUSES[index + 1]
      : event.key === "ArrowLeft" ? KANBAN_STATUSES[index - 1]
        : event.key === "Home" ? KANBAN_STATUSES[0]
          : event.key === "End" ? KANBAN_STATUSES[KANBAN_STATUSES.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    choose(next);
    document.getElementById(`${ids}-tab-${next}`)?.focus();
  };

  /* Presence: the conversations the column on screen draws, in its order. */
  const shownKey = useMemo(() => {
    const column = phone.columns[active];
    return [...column.pinned, ...column.cards, ...column.unlinked]
      .flatMap((item) => item.card.members.map((member) => member.file.path))
      .join("\n");
  }, [phone, active]);
  const onShown = props.onShown;
  useEffect(() => {
    onShown?.(shownKey ? shownKey.split("\n") : []);
  }, [shownKey, onShown]);

  /* ── Moves, hides and the card sheet ─────────────────────────────────── */
  const move = useCallback((item: PhoneCard, to: TaskStatus, receipt = true) => {
    const task = item.card.task ? tasksById.current.get(item.card.task.id) ?? item.card.task : null;
    const from = item.card.status;
    if (!task || from === to) return;
    const title = shortTitle(t, item);
    if (receipt) showReceipt(t("mobile2.kanban.moved", { column: t(STATUS_LABEL[to]) }), { kind: "undo", run: () => move({ ...item, card: { ...item.card, status: to } }, from, false) });
    void controller.move(task, to).then((outcome: StatusMoveOutcome) => {
      if (outcome.kind === "failed") showReceipt(t("kanban.moveFailed", { title, error: outcome.error }), null, { error: true });
      else if (outcome.kind === "conflict") showReceipt(t("kanban.movedElsewhere", { title, status: t(STATUS_LABEL[outcome.serverStatus]) }), null, { error: true });
    });
  }, [controller, t]);
  const hide = useCallback((item: PhoneCard) => {
    const raw = item.card.task ? tasksById.current.get(item.card.task.id) : undefined;
    if (!raw) return;
    const title = shortTitle(t, item);
    const unhide = () => {
      const current = tasksById.current.get(raw.id);
      if (current) void controller.edit(current, { field: "hide", value: false }).then((outcome) => {
        if (outcome.kind === "failed") showReceipt(t("kanban.showFailed", { title, error: outcome.error }), null, { error: true });
      });
    };
    showReceipt(
      item.card.working ? t("kanban.hiddenReceiptWorking", { title, count: item.card.working }) : t("kanban.hiddenReceipt", { title }),
      { kind: "undo", run: unhide },
    );
    void controller.edit(raw, { field: "hide", value: true, replaces: raw.groupHidden?.at ?? null }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      showReceipt(outcome.code === "TASK_HIDE_PROTECTED" ? t("kanban.hideProtected", { title }) : t("kanban.hideFailed", { title, error: outcome.error }), null, { error: true });
    });
  }, [controller, t]);

  /* Dismiss (docs/design/needs-attention.md §5): the reasons the card counts
     stop raising needs-you on the tap, and come back only when something
     newer asks. The receipt's Undo is the same request with `undo`. */
  const sendCardDismissal = useCallback((item: PhoneCard, undo: boolean) => {
    const needs = undo ? item.card.cleared.map((entry) => entry.need) : item.reasons;
    const subjects = needs.map(subjectOf);
    if (!subjects.length) return;
    const title = shortTitle(t, item);
    const target = item.card.task ? { kind: "task" as const, taskId: item.card.task.id, subjects } : { kind: "subjects" as const, subjects };
    if (!undo) {
      showReceipt(t("needs.dismissedReceipt", { title }), {
        kind: "undo",
        run: () => void sendDismissal(target, subjects, { undo: true, surface: "phone" }),
      });
    }
    void sendDismissal(target, subjects, { undo, surface: "phone" }).then((result) => {
      if (!result.ok) showReceipt(t(undo ? "needs.undoFailed" : "needs.dismissFailed", { title, error: result.error }), null, { error: true });
      /* A lane parked again after the card was drawn: that decision is new,
         and it stays flagged. */
      else if (result.outcome.changed?.length) showReceipt(t("needs.changedReceipt", { title }), null);
    });
  }, [t]);

  /* ⋯ › Hidden tasks: the hidden groups, newest hide first, then the empty
     tasks taken off the board. Show is the desktop tray's own write. */
  const hiddenRows = useMemo<HiddenRow[]>(() => [
    ...model.hiddenGroups.map((card) => ({ kind: "group" as const, key: card.id, card })),
    ...model.offBoard.map((task) => ({ kind: "task" as const, key: `off:${task.id}`, task })),
  ], [model]);
  const onHiddenCount = props.onHiddenCount;
  useEffect(() => {
    onHiddenCount?.(hiddenRows.length);
  }, [hiddenRows.length, onHiddenCount]);
  const showGroup = useCallback((card: KanbanCardModel) => {
    const raw = card.task ? tasksById.current.get(card.task.id) : undefined;
    if (!raw) return;
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    showReceipt(t("kanban.restoredReceipt", { title }));
    void controller.edit(raw, { field: "hide", value: false }).then((outcome) => {
      if (outcome.kind === "failed") showReceipt(t("kanban.showFailed", { title, error: outcome.error }), null, { error: true });
    });
  }, [controller, t]);
  const showTask = useCallback((task: BoardTask) => {
    const title = task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
    void updateTask(task.id, { board: "shown" }).then((error) => {
      if (error) showReceipt(t("kanban.showFailed", { title, error }), null, { error: true });
      else showReceipt(t("kanban.shownReceipt", { title }));
    });
  }, [t]);

  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const itemsByKey = useMemo(() => {
    const map = new Map<string, PhoneCard>();
    for (const status of KANBAN_STATUSES) {
      const column = phone.columns[status];
      for (const item of [...column.pinned, ...column.cards, ...column.unlinked]) map.set(item.key, item);
    }
    return map;
  }, [phone]);
  /* The card's own Dismiss: everything it counts, whatever kind of card it is. */
  const dismissRow = (item: PhoneCard): SheetRow[] => item.reasons.length ? [{
    key: "dismiss",
    name: t("needs.dismiss"),
    hint: t("needs.dismissRowHint"),
    icon: <Check className="h-4 w-4" aria-hidden />,
    tone: "accent",
    run: () => sendCardDismissal(item, false),
  }] : [];
  const sheetRows = (item: PhoneCard): SheetRow[] => {
    if (item.kind !== "task") {
      const target: MobileRowActionTarget | null = item.kind === "conversation" && item.firstAgent
        ? { kind: "conversation", row: { path: item.firstAgent.path, title: item.card.title } }
        : item.kind === "pipeline" && item.shown && item.need?.kind === "pipeline"
          ? { kind: "pipeline", row: { pipeline: item.shown.pipeline, task: item.card.title } }
          : null;
      /* A row's own Dismiss would clear one subject; the card's clears what
         the card counts, so it stands in for it. */
      return [...dismissRow(item), ...(target && props.rowActions ? props.rowActions(target) : [])
        .filter((action) => action.key !== "dismiss")
        .map((action) => ({ key: action.key, name: action.name, hint: action.hint, icon: action.icon, tone: action.tone, run: action.run }))];
    }
    /* Every pipeline finished: the move it is waiting for is Done (§3.4). */
    const order = item.finished ? (["done", ...KANBAN_STATUSES.filter((status) => status !== "done")] as TaskStatus[]) : [...KANBAN_STATUSES];
    const rows: SheetRow[] = order.filter((status) => status !== item.card.status).map((status) => {
      const Icon = STATUS_ICON[status];
      return {
        key: `move-${status}`,
        name: t("mobile2.kanban.moveTo", { column: t(STATUS_LABEL[status]) }),
        hint: t(`kanban.statusHint.${status}`),
        icon: <Icon className="h-4 w-4" aria-hidden />,
        tone: "accent",
        run: () => move(item, status),
      };
    });
    if (!item.card.holdsSeat) {
      rows.push({
        key: "hide",
        name: t("kanban.hideFromBoard"),
        hint: item.card.working ? t("kanban.hideWhyWorking", { count: item.card.working }) : t("kanban.hideWhy"),
        icon: <EyeOff className="h-4 w-4" aria-hidden />,
        tone: "neutral",
        run: () => hide(item),
      });
    }
    rows.push(...dismissRow(item));
    const first = item.firstAgent;
    if (first) {
      rows.push({
        key: "open-agent",
        name: t("mobile2.kanban.openFirstAgent"),
        hint: first.title || t("kanban.untitledConversation"),
        icon: <ArrowRight className="h-4 w-4" aria-hidden />,
        tone: "neutral",
        run: () => props.onOpenConversation(first),
      });
    }
    return rows;
  };
  const sheetItem = navState.sheet === "card" && sheetFor ? itemsByKey.get(sheetFor) ?? null : null;
  /* The sheet goes with its card: a card that left the board (moved away by
     another device, hidden) takes the sheet down rather than acting on it, and
     so does an entry that came back without its card (a reload, #2105). */
  useSheetSelection("card", sheetItem !== null);
  const openSheet = (item: PhoneCard) => {
    if (!sheetRows(item).length) return;
    setSheetFor(item.key);
    nav.openSheet("card");
  };

  const open = (item: PhoneCard): (() => void) | null => {
    if (item.kind === "task") {
      const task = item.card.task;
      return task ? () => props.onOpenTask(tasksById.current.get(task.id) ?? task) : null;
    }
    if (item.kind === "pipeline" && item.shown) {
      const pipeline = item.shown.pipeline;
      return () => props.onOpenPipeline(pipeline);
    }
    const file = item.firstAgent;
    return file ? () => props.onOpenConversation(file) : null;
  };
  const projectLabel = props.projectLabel;
  const cardOf = (item: PhoneCard) => (
    <CardView
      key={item.key}
      item={item}
      now={now}
      project={projectLabel?.(item.card.project) ?? null}
      onOpen={open(item)}
      onLongPress={() => openSheet(item)}
      onDismiss={item.reasons.length ? () => sendCardDismissal(item, false) : null}
      onUndo={item.cleared ? () => sendCardDismissal(item, true) : null}
    />
  );

  return (
    <div data-phone-kanban="" data-phone-kanban-active={active} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {props.seat ? <div className="shrink-0 pb-1 pt-1.5">{props.seat}</div> : null}
      <div
        role="tablist"
        aria-label={t("mobile2.kanban.columns")}
        data-phone-kanban-tabs=""
        className="grid shrink-0 grid-cols-4 gap-1 border-b border-border px-1.5 pt-1"
        onKeyDown={onTabKey}
      >
        {KANBAN_STATUSES.map((status) => {
          const column = phone.columns[status];
          const selected = status === active;
          return (
            <button
              key={status}
              id={`${ids}-tab-${status}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${ids}-panel-${status}`}
              aria-label={tabName(t, column)}
              tabIndex={selected ? 0 : -1}
              data-phone-kanban-tab={status}
              className={`relative flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-t-[10px] px-1 pb-2 pt-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${selected ? "bg-card" : "active:bg-sunken"}`}
              onClick={() => choose(status)}
            >
              <span data-phone-tab-label="" className={`whitespace-nowrap text-ui font-semibold leading-none ${selected ? "text-primary" : "text-secondary"}`}>
                {t(STATUS_LABEL[status])}
              </span>
              <TabMeta column={column} />
              {selected ? <span aria-hidden className="absolute inset-x-[20%] bottom-0 h-0.5 rounded-full bg-accent" /> : null}
            </button>
          );
        })}
      </div>
      <div
        ref={pager}
        data-phone-kanban-pager=""
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={onPagerScroll}
      >
        {KANBAN_STATUSES.map((status) => {
          const column = phone.columns[status];
          return (
            <section
              key={status}
              ref={(element) => {
                if (element) pages.current.set(status, element);
                else pages.current.delete(status);
              }}
              id={`${ids}-panel-${status}`}
              role="tabpanel"
              aria-labelledby={`${ids}-tab-${status}`}
              data-phone-kanban-column={status}
              className="h-full w-full min-w-full shrink-0 snap-start snap-always overflow-y-auto overflow-x-hidden overscroll-y-contain"
              onScroll={(event) => writePlace(project, { offsets: { [status]: event.currentTarget.scrollTop } })}
            >
              {columnEmpty(column) ? (
                <EmptyColumn column={column} columns={phone.columns} copy={props.emptyCopy} onJump={choose} onNewTask={props.onNewTask} onTellOrchestrator={props.onTellOrchestrator} />
              ) : (
                <div className="flex flex-col gap-2 px-3 pb-3 pt-2">
                  {column.pinned.map(cardOf)}
                  {column.cards.map(cardOf)}
                  {column.more > 0 ? (
                    <button
                      type="button"
                      data-phone-kanban-more={column.more}
                      className={`${CARD} ${QUIET} min-h-11 items-center justify-center text-ui font-semibold text-secondary`}
                      onClick={() => writePlace(project, { doneShown: doneShown + Math.min(20, column.more) })}
                    >
                      {t("mobile2.kanban.showMore", { count: Math.min(20, column.more) })}
                    </button>
                  ) : null}
                  {column.unlinked.length ? (
                    <>
                      <div data-phone-kanban-unlinked={column.unlinked.length} className="flex min-h-[34px] items-center px-1 pt-1.5 text-label font-semibold text-secondary">
                        {t("kanban.notOnTask", { count: column.unlinked.length })}
                      </div>
                      {column.unlinked.map(cardOf)}
                    </>
                  ) : null}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {sheetItem ? (
        <CardSheet
          title={t("kanban.cardActions", { title: shortTitle(t, sheetItem) })}
          rows={sheetRows(sheetItem)}
          onClose={() => nav.closeSheet()}
        />
      ) : null}
      {navState.sheet === "hidden" ? (
        <HiddenSheet
          rows={hiddenRows}
          nowMs={now * 1000}
          projectLabel={projectLabel}
          onShowGroup={showGroup}
          onShowTask={showTask}
          onClose={() => nav.closeSheet()}
        />
      ) : null}
    </div>
  );
}
