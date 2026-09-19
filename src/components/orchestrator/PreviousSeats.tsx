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
