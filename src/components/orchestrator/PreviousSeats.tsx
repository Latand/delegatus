"use client";

import { History } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { EngineMark } from "@/components/EngineMark";
import { KanbanPopover } from "@/components/kanban/kanbanMenus";
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
  current: boolean;
}

/** The rows the popover lists, the live seat first. Empty while the read is
    loading or failed, and then the control is not drawn. */
export function seatListRows(status: OrchestratorSeatStatus | null, tasks: readonly Pick<BoardTask, "id" | "text" | "origin">[] = []): SeatListRow[] {
  if (!status) return [];
  const titleOf = (taskId: string | null) => {
    const task = taskId ? tasks.find((entry) => entry.id === taskId) : undefined;
    if (!task || task.origin?.refinement === "pending") return null;
    return task.text.split(/\r?\n/, 1)[0]?.trim() || null;
  };
  const rows: SeatListRow[] = [];
  const seat = status.seat;
  if (seat?.conversationId && status.exists) {
    const taskId = status.currentTaskId ?? null;
    rows.push({ conversationId: seat.conversationId, title: titleOf(taskId), engine: seat.engine ?? null, heldFrom: seat.activatedAt, heldTo: null, taskId, current: true });
  }
  for (const previous of status.previous ?? []) {
    rows.push({ ...previous, title: previous.title ?? titleOf(previous.taskId), current: false });
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
  return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date).replace(",", "");
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

/** Whether a row offers its notes: a task names it, and that task has notes
    or is not in the list this page carries (it is read on demand). */
function rowHasNotes(row: SeatListRow, tasks: readonly Pick<BoardTask, "id" | "details">[] | undefined): boolean {
  if (!row.taskId) return false;
  if (fetchedNotes.has(row.taskId)) return Boolean(fetchedNotes.get(row.taskId));
  const local = tasks?.find((task) => task.id === row.taskId);
  return local ? Boolean(local.details?.trim()) : true;
}

/**
 * The seat head's control and its popover. `compact` is the collapsed strip's
 * form: the icon and the count only.
 */
export function PreviousSeatsControl({ status, tasks, compact = false, onOpenConversation }: {
  status: OrchestratorSeatStatus | null;
  /** The project's tasks as the page already carries them, for titles and notes. */
  tasks?: readonly Pick<BoardTask, "id" | "text" | "origin" | "details">[];
  compact?: boolean;
  /** Opens a conversation; the `#c=` link by default. */
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { t } = useLocale();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const rows = seatListRows(status, tasks);
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
    <KanbanPopover anchor={anchor} label={title} onClose={onClose} className="seats-pop" initialFocus="a, button">
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
  const hasNotes = rowHasNotes(row, tasks);
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
            {t("orchPanel.seatNotes")} ›
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
            notes.state.text
          ) : (
            <span role="status">{t("orchPanel.seatNotesLoading")}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ── The phone (390): a row in the seat sheet, a list screen, a notes screen ── */

/** The seat sheet's row: «Previous seats 2 ›». Absent at zero. */
export function MobilePreviousSeatsRow({ status, onOpen }: { status: OrchestratorSeatStatus | null; onOpen: () => void }) {
  const { t } = useLocale();
  const count = status?.previous?.length ?? 0;
  if (!count) return null;
  return (
    <button
      type="button"
      data-mobile-previous-seats={count}
      aria-label={t("orchPanel.previousSeatsAria", { count })}
      onClick={onOpen}
      className="flex min-h-11 w-full shrink-0 items-center gap-3 rounded-control text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    >
      <History className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t("orchPanel.previousSeats")}</span>
      <span className="shrink-0 text-label font-semibold tabular-nums text-muted">{count}</span>
      <span className="shrink-0 text-muted" aria-hidden>›</span>
    </button>
  );
}

/**
 * The list screen the row opens, inside the seat sheet: the same two-line
 * rows at 56 px, and a row's notes as a sub-screen. `onBack` returns to the
 * seat.
 */
export function MobilePreviousSeatsScreen({ status, onBack }: { status: OrchestratorSeatStatus | null; onBack: () => void }) {
  const { t, locale } = useLocale();
  const [notesFor, setNotesFor] = useState<SeatListRow | null>(null);
  const rows = seatListRows(status).filter((row) => !row.current);
  const back = (label: string, run: () => void) => (
    <button
      type="button"
      data-mobile-previous-back=""
      onClick={run}
      className="flex min-h-11 items-center gap-1 self-start text-ui font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span aria-hidden>‹</span> {label}
    </button>
  );
  if (notesFor) {
    return (
      <div className="flex flex-col gap-2" data-mobile-previous-notes={notesFor.conversationId}>
        {back(t("orchPanel.previousSeats"), () => setNotesFor(null))}
        <p className="truncate text-body font-semibold text-primary">{notesFor.title ?? t("orchPanel.seatUntitled")}</p>
        <MobileNotes taskId={notesFor.taskId} />
      </div>
    );
  }
  return (
    <div className="flex flex-col" data-mobile-previous-list="">
      {back(t("orchPanel.seatCurrent"), onBack)}
      <p className="pb-1 pt-2 text-label font-semibold text-muted">{t("orchPanel.previousSeats")}</p>
      {rows.map((row) => (
        <div key={row.conversationId} className="flex min-h-14 items-center gap-2 border-t border-border first:border-t-0" data-seat-row={row.conversationId}>
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
          {row.taskId ? (
            <button
              type="button"
              data-seat-notes-toggle=""
              onClick={() => setNotesFor(row)}
              className="inline-flex min-h-11 shrink-0 items-center px-1 text-label font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t("orchPanel.seatNotes")} ›
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MobileNotes({ taskId }: { taskId: string | null }) {
  const { t } = useLocale();
  const notes = useSeatNotes(taskId, undefined, true);
  return (
    <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-control bg-sunken p-2.5 text-caption leading-5 text-secondary [overflow-wrap:anywhere]" data-seat-notes="">
      {notes.state?.kind === "failed" ? (
        <span role="alert">
          {t("orchPanel.seatNotesFailed")}{" "}
          <button type="button" className="min-h-11 font-semibold text-accent" onClick={notes.retry}>{t("orchPanel.seatNotesRetry")}</button>
        </span>
      ) : notes.state?.kind === "ready" ? (
        notes.state.text
      ) : (
        <span role="status">{t("orchPanel.seatNotesLoading")}</span>
      )}
    </div>
  );
}
