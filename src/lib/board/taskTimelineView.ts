import { humanizeDuration } from "@/components/turnDuration";
import type { Locale, TFunction } from "@/lib/i18n";
import { isOverdue } from "@/lib/tasks/helpers";

/**
 * Pure geometry and wording of the board chart's manager view
 * (docs/design/board-timeline-manager-view.md). The component draws what these
 * functions decide; nothing here reads the DOM, the clock or a store.
 */
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** A duration of this many days or more is written in days. */
export const DAY_WORDS_FROM_DAYS = 2;
/** A stage's start sits this share of a window from the left edge after paging to it. */
export const PAGE_MARGIN = 0.05;
/** The right-hand margin of the live window, as a share of it. */
export const LIVE_MARGIN = 0.22;

export interface TimelineView {
  /** The window's first instant. */
  start: number;
  /** The window's last instant. */
  end: number;
  /** The window's end when it follows the clock. */
  liveEnd: number;
  /** The window was paged back from the clock. */
  paged: boolean;
}

/** The visible window: `hours` wide, ending at the paged instant or at the clock plus a margin, rounded up to the hour. */
export function timelineWindow(nowMs: number, hours: number, pagedEnd: number | null): TimelineView {
  const span = hours * HOUR;
  const liveEnd = Math.ceil((nowMs + span * LIVE_MARGIN) / HOUR) * HOUR;
  const paged = pagedEnd !== null && Number.isFinite(pagedEnd) && pagedEnd < liveEnd;
  const end = paged ? pagedEnd : liveEnd;
  return { start: end - span, end, liveEnd, paged };
}

/** The window end that puts `stageStartMs` a small margin from the left edge; the clock's window when that reaches it. */
export function pageTo(liveEnd: number, hours: number, stageStartMs: number): number {
  return Math.min(liveEnd, stageStartMs + hours * HOUR * (1 - PAGE_MARGIN));
}

export interface SegmentInput { startedAtMs: number | null; endAtMs: number | null }
export type TimelineSegment =
  | { kind: "span"; startMs: number; endMs: number }
  /** Started, with no recorded end: only the start is known. */
  | { kind: "tick"; startMs: number };

/**
 * Where a stage actually ran, from the attempt's own times. A start and an end
 * make a span (never past the clock); a start alone makes a tick; no start
 * makes nothing, so an unknown time is never drawn as work.
 */
export function attemptSegment(attempt: SegmentInput, nowMs: number): TimelineSegment | null {
  const { startedAtMs: start, endAtMs: end } = attempt;
  if (start === null || !Number.isFinite(start) || start > nowMs) return null;
  if (end === null || !Number.isFinite(end)) return { kind: "tick", startMs: start };
  if (end < start) return null;
  return { kind: "span", startMs: start, endMs: Math.min(end, nowMs) };
}

export interface LaneBox { left: number; width: number }

/**
 * A span clipped to the lane `[0, laneWidth]`, at least `minWidth` wide; null
 * when it lies wholly before or after the window.
 */
export function clipSpan(startMs: number, endMs: number, view: TimelineView, laneWidth: number, minWidth = 3): LaneBox | null {
  const perMs = laneWidth / (view.end - view.start);
  const left = (startMs - view.start) * perMs, right = (endMs - view.start) * perMs;
  if (right < 0 || left > laneWidth) return null;
  const clippedRight = Math.min(laneWidth, Math.max(right, 0));
  const clippedLeft = Math.max(0, Math.min(left, clippedRight - minWidth));
  return { left: clippedLeft, width: Math.max(0, clippedRight - clippedLeft) };
}

/** Whether a span lies wholly before the window's left edge. */
export function endsBeforeView(endMs: number, view: TimelineView): boolean {
  return endMs < view.start;
}

export type DueMark =
  | { place: "in"; x: number; overdue: boolean; lateMs: number }
  | { place: "before" | "after"; overdue: boolean; lateMs: number };

/**
 * The board due date against the window: a flag position inside it, or the
 * side it lies on. `lateMs` is how late the task is as of the clock, 0 when it
 * is not overdue. Null when the task has no parseable date.
 */
export function dueMark(dueAt: string | undefined, nowMs: number, view: TimelineView, laneWidth: number): DueMark | null {
  const dueMs = dueAt ? Date.parse(dueAt) : NaN;
  if (!Number.isFinite(dueMs)) return null;
  const overdue = isOverdue(dueAt!, nowMs);
  const lateMs = overdue ? nowMs - dueMs : 0;
  if (dueMs < view.start) return { place: "before", overdue, lateMs };
  if (dueMs > view.end) return { place: "after", overdue, lateMs };
  return { place: "in", x: (dueMs - view.start) * laneWidth / (view.end - view.start), overdue, lateMs };
}

/**
 * The CSS shift that keeps a text of any width inside a lane while its pole
 * stays under it: at `x` of `laneWidth` the text moves left by that share of
 * its own width, so its left edge is `x·(1 − w/L)` and its right edge at most
 * `L`, for a text no wider than the lane.
 */
export function anchorShift(x: number, laneWidth: number): number {
  return laneWidth > 0 ? Math.max(0, Math.min(100, 100 * x / laneWidth)) : 0;
}

/** Two days or more in whole days, otherwise hours and minutes: the one rule for every duration the chart writes. */
export function timelineDuration(ms: number, locale: Locale, t: TFunction): string {
  const days = Math.floor(ms / DAY);
  return days >= DAY_WORDS_FROM_DAYS ? t("mobile2.kanban.ageDays", { count: days }) : humanizeDuration(ms / 1000, locale);
}

/**
 * When a task started, in words that do not depend on the window: the time for
 * a task begun today, the date otherwise. Both read in the viewer's zone.
 */
export function startWords(startMs: number, nowMs: number, locale: Locale): string {
  const intl = locale === "uk" ? "uk-UA" : "en-GB";
  const same = new Date(startMs).toDateString() === new Date(nowMs).toDateString();
  return same
    ? new Intl.DateTimeFormat(intl, { hour: "2-digit", minute: "2-digit", hour12: false }).format(startMs)
    : new Intl.DateTimeFormat(intl, { day: "2-digit", month: "2-digit" }).format(startMs);
}

export interface OrderInput { dueAt?: string; startMs: number | null; id: string }

/** Due date ascending (overdue first), no date last, then the earlier start, then the id. */
export function compareTimelineRows(a: OrderInput, b: OrderInput): number {
  const due = (value: OrderInput) => { const ms = value.dueAt ? Date.parse(value.dueAt) : NaN; return Number.isFinite(ms) ? ms : Infinity; };
  const da = due(a), db = due(b);
  if (da !== db) return da < db ? -1 : 1;
  const sa = a.startMs ?? Infinity, sb = b.startMs ?? Infinity;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
