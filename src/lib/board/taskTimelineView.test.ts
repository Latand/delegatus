import { expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { DAY, HOUR, anchorShift, attemptSegment, clipSpan, compareTimelineRows, dueMark, pageTo, startWords, timelineDuration, timelineWindow } from "./taskTimelineView";

const NOW = Date.parse("2026-11-13T08:10:00Z");
const t = (locale: "en" | "uk") => ((key: string, params?: Record<string, string | number>) => translate(locale, key as never, params as never)) as never;

test("the window is one span wide, ends past now at the hour, and pages back by its own width", () => {
  const live = timelineWindow(NOW, 24, null);
  expect(live.end - live.start).toBe(24 * HOUR);
  expect(live.end).toBe(Date.parse("2026-11-13T14:00:00Z"));
  expect(live.paged).toBe(false);
  const page = pageTo(live.liveEnd, 24, Date.parse("2026-10-30T05:58:00Z"));
  const paged = timelineWindow(NOW, 24, page);
  expect(paged.paged).toBe(true);
  expect(paged.liveEnd).toBe(live.liveEnd);
  // The stage's start sits 5 % of a window from the left edge.
  expect((Date.parse("2026-10-30T05:58:00Z") - paged.start) / (24 * HOUR)).toBeCloseTo(0.05, 6);
  // A stage inside the live window pages nowhere: the window stays live.
  expect(timelineWindow(NOW, 24, pageTo(live.liveEnd, 24, NOW - HOUR)).paged).toBe(false);
});

test("segments: a start and an end run, a start alone ticks, no start draws nothing, never past the clock", () => {
  expect(attemptSegment({ startedAtMs: NOW - 2 * HOUR, endAtMs: NOW - HOUR }, NOW)).toEqual({ kind: "span", startMs: NOW - 2 * HOUR, endMs: NOW - HOUR });
  expect(attemptSegment({ startedAtMs: NOW - 2 * HOUR, endAtMs: NOW + HOUR }, NOW)).toEqual({ kind: "span", startMs: NOW - 2 * HOUR, endMs: NOW });
  expect(attemptSegment({ startedAtMs: NOW - 2 * HOUR, endAtMs: null }, NOW)).toEqual({ kind: "tick", startMs: NOW - 2 * HOUR });
  expect(attemptSegment({ startedAtMs: null, endAtMs: NOW }, NOW)).toBeNull();
  expect(attemptSegment({ startedAtMs: NOW + 1, endAtMs: null }, NOW)).toBeNull();
  expect(attemptSegment({ startedAtMs: NOW - HOUR, endAtMs: NOW - 2 * HOUR }, NOW)).toBeNull();
});

test("a span is clipped to the lane at both edges and keeps a visible minimum", () => {
  const view = timelineWindow(NOW, 24, null);
  expect(clipSpan(view.start - 5 * DAY, view.start - DAY, view, 800)).toBeNull();
  expect(clipSpan(view.end + HOUR, view.end + 2 * HOUR, view, 800)).toBeNull();
  const clipped = clipSpan(view.start - 14 * DAY, NOW, view, 800)!;
  expect(clipped.left).toBe(0);
  expect(clipped.left + clipped.width).toBeLessThanOrEqual(800);
  const thin = clipSpan(NOW - 60_000, NOW - 59_000, view, 800)!;
  expect(thin.width).toBeGreaterThanOrEqual(3);
  const edge = clipSpan(view.end - 1000, view.end + HOUR, view, 800)!;
  expect(edge.left + edge.width).toBeLessThanOrEqual(800);
});

test("the due date is a flag in the window, an edge marker outside it, red with its lateness when past", () => {
  const view = timelineWindow(NOW, 24, null);
  const inside = dueMark(new Date(NOW + 4 * HOUR).toISOString(), NOW, view, 800)!;
  expect(inside).toMatchObject({ place: "in", overdue: false, lateMs: 0 });
  expect("x" in inside && inside.x).toBeCloseTo((NOW + 4 * HOUR - view.start) / (24 * HOUR) * 800, 6);
  expect(dueMark(new Date(NOW + 74 * HOUR).toISOString(), NOW, view, 800)).toMatchObject({ place: "after", overdue: false });
  const late = dueMark(new Date(NOW - 96 * HOUR).toISOString(), NOW, view, 800)!;
  expect(late).toMatchObject({ place: "before", overdue: true, lateMs: 96 * HOUR });
  // Overdue by two hours is still inside a day's window, drawn red there.
  expect(dueMark(new Date(NOW - 2 * HOUR).toISOString(), NOW, view, 800)).toMatchObject({ place: "in", overdue: true, lateMs: 2 * HOUR });
  expect(dueMark(undefined, NOW, view, 800)).toBeNull();
  expect(dueMark("not a date", NOW, view, 800)).toBeNull();
});

test("the anchor keeps a text of any width inside the lane while its pole stays under it", () => {
  for (const [x, lane, text] of [[0, 410, 230], [205, 410, 230], [410, 410, 230], [390, 390, 230], [12, 795, 120]] as const) {
    const left = x - anchorShift(x, lane) / 100 * text;
    expect(left).toBeGreaterThanOrEqual(-1e-9);
    expect(left + text).toBeLessThanOrEqual(lane + 1e-9);
    expect(x).toBeGreaterThanOrEqual(left);
    expect(x).toBeLessThanOrEqual(left + text);
  }
});

test("durations of two days or more are written in days, in both languages", () => {
  expect(timelineDuration(340 * HOUR, "uk", t("uk"))).toBe("14 д");
  expect(timelineDuration(340 * HOUR, "en", t("en"))).toBe("14d");
  expect(timelineDuration(2 * DAY, "uk", t("uk"))).toBe("2 д");
  expect(timelineDuration(2 * DAY - 1000, "uk", t("uk"))).toBe("47 год 59 хв");
  expect(timelineDuration(66 * 60_000, "en", t("en"))).toBe("1h 6m");
});

test("a task's start reads as the time today and the date otherwise, whatever the window", () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(zone).toBeTruthy();
  const today = new Date(NOW); today.setHours(1, 5, 0, 0);
  expect(startWords(today.getTime(), NOW, "en")).toBe("01:05");
  const earlier = new Date(NOW); earlier.setDate(earlier.getDate() - 14); earlier.setHours(12, 0, 0, 0);
  const day = String(earlier.getDate()).padStart(2, "0"), month = String(earlier.getMonth() + 1).padStart(2, "0");
  expect(startWords(earlier.getTime(), NOW, "uk")).toBe(`${day}.${month}`);
  expect(startWords(earlier.getTime(), NOW, "en")).toBe(`${day}/${month}`);
});

test("rows order by due date, overdue first, no date last, then start and id", () => {
  const rows = [
    { id: "d", dueAt: undefined, startMs: 1 },
    { id: "c", dueAt: "2026-11-15T00:00:00Z", startMs: 5 },
    { id: "b", dueAt: "2026-11-15T00:00:00Z", startMs: 2 },
    { id: "a", dueAt: "2026-11-09T00:00:00Z", startMs: 9 },
    { id: "e", dueAt: "2026-11-15T00:00:00Z", startMs: 2 },
    { id: "f", dueAt: undefined, startMs: null },
  ];
  expect(rows.sort(compareTimelineRows).map(row => row.id)).toEqual(["a", "b", "e", "c", "d", "f"]);
});
