"use client";

import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { EngineMark } from "@/components/EngineMark";
import { KanbanPopover } from "@/components/kanban/kanbanMenus";
import { MobileSheetRow } from "@/components/mobile/MobileSheet";
import { useLocale, type Locale, type TFunction } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import type { OrchestratorSeatStatus } from "./seatState";

/*
 * Previous seats (#1841): the seat head's one control for the seats that held
 * the project before this one, and for the notes every seat keeps in the task
 * its launch minted. The board draws no band for those tasks any more; this
 * popover is where they are read.
 */

/** One row of the popover: the live seat under «Current», or a previous one. */
export interface SeatListRow {
  conversationId: string;
  title: string | null;
  engine: string | null;
  heldFrom: string | null;
  /** Null for the live seat. */
  heldTo: string | null;
  taskId: string | null;
  /** Whether the seat's task carries notes, as the status read answered it: a
      seat with none draws no `Notes` control, on every surface. */
  hasNotes: boolean;
  current: boolean;
}

/** The rows the popover lists, the live seat first. Empty while the read is
    loading or failed, and then the control is not drawn.

    Every row names itself from the answer, which carries the seat task's title
    for the live seat as well as the retired ones: the phone's seat screens hold
    no task list and would otherwise leave the live seat unnamed. A task list
    the surface does carry wins, because an edit lands there first. */
export function seatListRows(status: OrchestratorSeatStatus | null, tasks: readonly Pick<BoardTask, "id" | "text" | "origin">[] = [], currentEngine: string | null = null): SeatListRow[] {
  if (!status) return [];
  const titleOf = (taskId: string | null) => {
    const task = taskId ? tasks.find((entry) => entry.id === taskId) : undefined;
    if (!task || task.origin?.refinement === "pending") return null;
    return task.text.split(/\r?\n/, 1)[0]?.trim() || null;
  };
  const rows: SeatListRow[] = [];
  const seat = status.seat;
  if (seat?.conversationId && status.exists) {
    const task = status.currentTask ?? null;
    rows.push({
      conversationId: seat.conversationId,
      title: titleOf(task?.taskId ?? null) ?? task?.title ?? null,
      engine: currentEngine ?? seat.engine ?? null,
      heldFrom: seat.activatedAt,
      heldTo: null,
      taskId: task?.taskId ?? null,
      hasNotes: task?.hasNotes ?? false,
      current: true,
    });
  }
  for (const previous of status.previous ?? []) {
    rows.push({ ...previous, title: titleOf(previous.taskId) ?? previous.title, current: false });
  }
  return rows;
}

/** A duration in its largest sensible unit: 42 min, 13 h, 3 d. */
export function seatDuration(t: TFunction, fromIso: string, toIso: string): string | null {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t("orchPanel.seatDurationMin", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("orchPanel.seatDurationHours", { count: hours });
  return t("orchPanel.seatDurationDays", { count: Math.round(hours / 24) });
}

/** The locale's short date and a 24 h clock; the year only when it is not this one. */
export function seatTime(locale: Locale, iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  /* Day, short month, the year when it differs, then a 24 h clock: 18 Sep 14:02. */
  const parts = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-US", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  const year = date.getFullYear() !== now.getFullYear() ? ` ${part("year")}` : "";
  return `${part("day")} ${part("month")}${year} ${part("hour")}:${part("minute")}`;
}

/** The row's second line: the span it held the seat for, as much as is known. */
export function seatSpan(t: TFunction, locale: Locale, row: Pick<SeatListRow, "heldFrom" | "heldTo">, now = new Date()): string {
  if (!row.heldTo) return row.heldFrom ? t("orchPanel.seatHeldSince", { from: seatTime(locale, row.heldFrom, now) }) : "";
  const to = seatTime(locale, row.heldTo, now);
  if (!row.heldFrom) return t("orchPanel.seatHeldUntil", { to });
  const duration = seatDuration(t, row.heldFrom, row.heldTo);
  return duration
    ? t("orchPanel.seatHeld", { from: seatTime(locale, row.heldFrom, now), to, duration })
    : t("orchPanel.seatHeldUntil", { to });
}

/* Notes a task list this page does not carry had to be fetched for; kept for
   the tab so reopening a row does not fetch again. */
const fetchedNotes = new Map<string, string>();

type NotesState = { kind: "ready"; text: string } | { kind: "loading" } | { kind: "failed" };

function useSeatNotes(taskId: string | null, tasks: readonly Pick<BoardTask, "id" | "details">[] | undefined, open: boolean): { state: NotesState | null; retry: () => void } {
  const local = taskId && tasks ? tasks.find((task) => task.id === taskId) : undefined;
  const [fetched, setFetched] = useState<NotesState | null>(() => (taskId && fetchedNotes.has(taskId) ? { kind: "ready", text: fetchedNotes.get(taskId)! } : null));
  const [attempt, setAttempt] = useState(0);
  const needsFetch = open && Boolean(taskId) && !local && !(taskId && fetchedNotes.has(taskId));
  useEffect(() => {
    if (!needsFetch || !taskId) return;
    const controller = new AbortController();
    setFetched({ kind: "loading" });
    fetch("/api/tasks", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { tasks?: Array<{ id?: string; details?: string }> };
        const text = body.tasks?.find((task) => task.id === taskId)?.details ?? "";
        fetchedNotes.set(taskId, text);
        setFetched({ kind: "ready", text });
      })
      .catch((cause: unknown) => {
        if ((cause as { name?: string }).name !== "AbortError") setFetched({ kind: "failed" });
      });
    return () => controller.abort();
  }, [needsFetch, taskId, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  if (!taskId) return { state: null, retry };
  if (local) return { state: { kind: "ready", text: local.details ?? "" }, retry };
  return { state: fetched, retry };
}

/**
 * Whether a row offers its notes. A task names it AND that task has notes —
 * never a guess: a surface that does not carry the task list reads the answer's
 * own `hasNotes`, so a seat with no notes draws no `Notes` button there either.
 * The freshest source wins: notes already fetched, then the page's task list,
 * then the status read.
 */
export function rowHasNotes(row: SeatListRow, tasks: readonly Pick<BoardTask, "id" | "details">[] | undefined): boolean {
  if (!row.taskId) return false;
  if (fetchedNotes.has(row.taskId)) return Boolean(fetchedNotes.get(row.taskId));
  const local = tasks?.find((task) => task.id === row.taskId);
  return local ? Boolean(local.details?.trim()) : row.hasNotes;
}

/**
 * The seat head's control and its popover. `compact` is the collapsed strip's
 * form: the icon and the count only.
 */
export function PreviousSeatsControl({ status, tasks, compact = false, currentEngine = null, onOpenConversation }: {
  status: OrchestratorSeatStatus | null;
  /** The live seat's engine, as its conversation reports it. */
  currentEngine?: string | null;
  /** The project's tasks as the page already carries them, for titles and notes. */
  tasks?: readonly Pick<BoardTask, "id" | "text" | "origin" | "details">[];
  compact?: boolean;
  /** Opens a conversation; the `#c=` link by default. */
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { t } = useLocale();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const rows = seatListRows(status, tasks, currentEngine);
  const previous = rows.filter((row) => !row.current).length;
  const current = rows.find((row) => row.current) ?? null;
  const notesOnly = previous === 0 && current !== null && rowHasNotes(current, tasks);
  if (previous === 0 && !notesOnly) return null;
  const label = notesOnly ? t("orchPanel.seatNotesOnly") : t("orchPanel.previousSeats");
  const aria = notesOnly ? label : t("orchPanel.previousSeatsAria", { count: previous });
  return (
    <>
      <button
        type="button"
        className="seat-prev"
        data-previous-seats={previous}
        aria-label={aria}
        title={aria}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          const target = event.currentTarget;
          setAnchor((open) => (open ? null : target));
        }}
      >
        <History aria-hidden />
        {compact ? null : <span className="word">{label}</span>}
        {notesOnly ? null : <span className="num">{previous}</span>}
      </button>
      {anchor ? (
        <PreviousSeatsPopover
          anchor={anchor}
          rows={rows}
          tasks={tasks}
          title={label}
          onClose={(refocus) => {
            setAnchor(null);
            if (refocus && anchor.isConnected) anchor.focus();
          }}
          onOpenConversation={onOpenConversation}
        />
      ) : null}
    </>
  );
}

export function PreviousSeatsPopover({ anchor, rows, tasks, title, onClose, onOpenConversation }: {
  anchor: HTMLElement;
  rows: readonly SeatListRow[];
  tasks?: readonly Pick<BoardTask, "id" | "details">[];
  title: string;
  onClose: (refocus: boolean) => void;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { t } = useLocale();
  const [openNotes, setOpenNotes] = useState<string | null>(null);
  /* Portalled to the board root: the page region is a size container, which
     would make a fixed popover inside it position against the region instead
     of the viewport. */
  const host = anchor.closest<HTMLElement>(".kb") ?? (typeof document === "undefined" ? null : document.body);
  if (!host) return null;
  const current = rows.filter((row) => row.current);
  const previous = rows.filter((row) => !row.current);
  const renderRow = (row: SeatListRow) => (
    <SeatRow
      key={row.conversationId}
      row={row}
      tasks={tasks}
      notesOpen={openNotes === row.conversationId}
      onToggleNotes={() => setOpenNotes((open) => (open === row.conversationId ? null : row.conversationId))}
      onOpen={() => {
        onClose(false);
        onOpenConversation?.(row.conversationId);
      }}
      openByLink={!onOpenConversation}
    />
  );
  return createPortal(
    <KanbanPopover anchor={anchor} within={anchor.closest<HTMLElement>(".seat")} label={title} onClose={onClose} className="seats-pop" initialFocus="a, button">
      <div data-previous-seats-popover="">
        {current.length ? (
          <>
            <div className="head">{t("orchPanel.seatCurrent")}</div>
            {current.map(renderRow)}
          </>
        ) : null}
        {previous.length ? (
          <>
            <div className="head">{t("orchPanel.previousSeats")}</div>
            {previous.map(renderRow)}
          </>
        ) : null}
      </div>
    </KanbanPopover>,
    host,
  );
}

function SeatRow({ row, tasks, notesOpen, onToggleNotes, onOpen, openByLink }: {
  row: SeatListRow;
  tasks?: readonly Pick<BoardTask, "id" | "details">[];
  notesOpen: boolean;
  onToggleNotes: () => void;
  onOpen: () => void;
  openByLink: boolean;
}) {
  const { t, locale } = useLocale();
  const notes = useSeatNotes(row.taskId, tasks, notesOpen);
  /* An on-demand read can land empty after the answer said the task had notes
     (it was edited in between). The control then stays for as long as its row
     is open and the row says there are none, instead of disappearing from
     under the panel it just opened. */
  const hasNotes = rowHasNotes(row, tasks) || notesOpen;
  const notesId = useRef(`seat-notes-${row.conversationId.replace(/[^a-zA-Z0-9_-]/g, "")}`).current;
  return (
    <div className="seat-row" data-seat-row={row.conversationId} data-seat-current={row.current ? "1" : "0"}>
      <div className="line">
        <a
          className="open"
          href={"#c=" + encodeURIComponent(row.conversationId)}
          onClick={(event) => {
            if (!openByLink) event.preventDefault();
            onOpen();
          }}
        >
          <span className="t1">
            {row.engine ? <EngineMark engine={row.engine} size={12} /> : null}
            <span className="title">{row.title ?? t("orchPanel.seatUntitled")}</span>
          </span>
          <span className="t2 num">{seatSpan(t, locale, row)}</span>
        </a>
        {hasNotes ? (
          <button type="button" className="notes-btn" aria-expanded={notesOpen} aria-controls={notesId} data-seat-notes-toggle="" onClick={onToggleNotes}>
            {t("orchPanel.seatNotes")}
            <ChevronRight aria-hidden />
          </button>
        ) : null}
      </div>
      {notesOpen ? (
        <div className="notes" id={notesId} data-seat-notes="">
          {notes.state?.kind === "failed" ? (
            <span role="alert">
              {t("orchPanel.seatNotesFailed")}{" "}
              <button type="button" className="notes-retry" onClick={notes.retry}>{t("orchPanel.seatNotesRetry")}</button>
            </span>
          ) : notes.state?.kind === "ready" ? (
            notes.state.text.trim() ? notes.state.text : <span className="empty" data-seat-notes-empty="">{t("orchPanel.seatNotesEmpty")}</span>
          ) : (
            <span role="status">{t("orchPanel.seatNotesLoading")}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ── The phone (390): a row in the seat sheet, a list screen, a notes screen ── */

/** The seat sheet's row, under the tick row and drawn the same way:
    «Previous seats 2 ›», or «Seat notes ›» while the live seat is the only one
    and keeps a task for its notes. Absent when there is neither. */
export function MobilePreviousSeatsRow({ status, onOpen }: { status: OrchestratorSeatStatus | null; onOpen: () => void }) {
  const { t } = useLocale();
  const rows = seatListRows(status);
  const count = rows.filter((row) => !row.current).length;
  const notesOnly = count === 0 && rows.some((row) => row.current && rowHasNotes(row, undefined));
  if (!count && !notesOnly) return null;
  const label = notesOnly ? t("orchPanel.seatNotesOnly") : t("orchPanel.previousSeats");
  return (
    <MobileSheetRow
      icon={<History className="h-[18px] w-[18px]" aria-hidden />}
      label={label}
      onSelect={onOpen}
      ariaLabel={notesOnly ? label : t("orchPanel.previousSeatsAria", { count })}
      attrs={{ "data-mobile-previous-seats": String(count) }}
      trailing={
        <>
          {notesOnly ? null : <span className="tabular-nums">{count}</span>}
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </>
      }
    />
  );
}

/**
 * The list screen the row opens, inside the seat sheet: the live seat under
 * «Current», then the previous ones, as the same two-line rows at 56 px, and
 * a row's notes as a sub-screen. `onBack` returns to the seat.
 */
export function MobilePreviousSeatsScreen({ status, currentEngine = null, onBack }: {
  status: OrchestratorSeatStatus | null;
  /** The live seat's engine, as its conversation reports it. */
  currentEngine?: string | null;
  onBack: () => void;
}) {
  const { t, locale } = useLocale();
  const [notesFor, setNotesFor] = useState<SeatListRow | null>(null);
  const rows = seatListRows(status, [], currentEngine);
  const current = rows.filter((row) => row.current);
  const previous = rows.filter((row) => !row.current);
  const back = (label: string, run: () => void) => (
    <button
      type="button"
      data-mobile-previous-back=""
      onClick={run}
      className="flex min-h-11 items-center gap-1 self-start text-ui font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden /> {label}
    </button>
  );
  if (notesFor) {
    return (
      <div className="flex flex-col gap-2" data-mobile-previous-notes={notesFor.conversationId}>
        {back(t(previous.length ? "orchPanel.previousSeats" : "orchPanel.seatNotesOnly"), () => setNotesFor(null))}
        <p className="truncate text-body font-semibold text-primary">{notesFor.title ?? t("orchPanel.seatUntitled")}</p>
        <MobileNotes taskId={notesFor.taskId} />
      </div>
    );
  }
  const renderRow = (row: SeatListRow) => (
    <div key={row.conversationId} className="flex min-h-14 items-center gap-2 border-t border-border first:border-t-0" data-seat-row={row.conversationId} data-seat-current={row.current ? "1" : "0"}>
      <a
        href={"#c=" + encodeURIComponent(row.conversationId)}
        className="flex min-h-14 min-w-0 flex-1 flex-col justify-center gap-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-ui font-semibold text-primary">
          {row.engine ? <EngineMark engine={row.engine} size={12} /> : null}
          <span className="truncate">{row.title ?? t("orchPanel.seatUntitled")}</span>
        </span>
        <span className="truncate text-caption tabular-nums text-muted">{seatSpan(t, locale, row)}</span>
      </a>
      {rowHasNotes(row, undefined) ? (
        <button
          type="button"
          data-seat-notes-toggle=""
          onClick={() => setNotesFor(row)}
          className="inline-flex min-h-11 shrink-0 items-center gap-0.5 px-1 text-label font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {t("orchPanel.seatNotes")}
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
      ) : null}
    </div>
  );
  return (
    <div className="flex flex-col" data-mobile-previous-list="">
      {/* Back to the seat sheet, named for it: «Current» here would read as
          a link to the live seat, which the list itself carries. */}
      {back(t("orchPanel.title"), onBack)}
      {current.length ? (
        <>
          <p className="pb-1 pt-2 text-label font-semibold text-muted">{t("orchPanel.seatCurrent")}</p>
          <div className="flex flex-col">{current.map(renderRow)}</div>
        </>
      ) : null}
      {previous.length ? (
        <>
          <p className="pb-1 pt-3 text-label font-semibold text-muted">{t("orchPanel.previousSeats")}</p>
          <div className="flex flex-col">{previous.map(renderRow)}</div>
        </>
      ) : null}
    </div>
  );
}

function MobileNotes({ taskId }: { taskId: string | null }) {
  const { t } = useLocale();
  const notes = useSeatNotes(taskId, undefined, true);
  return (
    <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-control border border-border bg-sunken p-2.5 text-caption leading-5 text-secondary [overflow-wrap:anywhere]" data-seat-notes="">
      {notes.state?.kind === "failed" ? (
        <span role="alert">
          {t("orchPanel.seatNotesFailed")}{" "}
          <button type="button" className="min-h-11 font-semibold text-accent" onClick={notes.retry}>{t("orchPanel.seatNotesRetry")}</button>
        </span>
      ) : notes.state?.kind === "ready" ? (
        notes.state.text.trim() ? notes.state.text : <span className="text-muted" data-seat-notes-empty="">{t("orchPanel.seatNotesEmpty")}</span>
      ) : (
        <span role="status">{t("orchPanel.seatNotesLoading")}</span>
      )}
    </div>
  );
}
