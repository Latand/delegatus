import { expect, test } from "bun:test";

import { buildSeries, burndownForAccount, burndownSegments, computePace, GAP_S, idealRemaining, mergeSamples, WINDOW_SECONDS } from "./burndown";
import type { BurndownPayload, BurndownSeries, EngineBurndown } from "./types";

const start = 1_000_000;
const week = WINDOW_SECONDS.weekly;
const reset = start + week;

const emptyEngine = (): EngineBurndown => ({
  session: { windowStart: null, resetsAt: null, windowSeconds: WINDOW_SECONDS.session, samples: [] },
  weekly: { windowStart: null, resetsAt: null, windowSeconds: WINDOW_SECONDS.weekly, samples: [] },
});

const burndownPayload = (over: Partial<BurndownPayload> = {}): BurndownPayload => ({
  claude: emptyEngine(),
  codex: emptyEngine(),
  claudeAccountId: "claude-a",
  codexAccountId: "codex-a",
  historySince: null,
  ...over,
});

test("burndownForAccount returns the engine series when the account stamp matches", () => {
  const payload = burndownPayload();
  expect(burndownForAccount(payload, "claude", "claude-a")).toBe(payload.claude);
  expect(burndownForAccount(payload, "codex", "codex-a")).toBe(payload.codex);
});

test("burndownForAccount masks a response whose account stamp changed (post-switch race)", () => {
  const payload = burndownPayload();
  expect(burndownForAccount(payload, "claude", "claude-b")).toBeNull();
  expect(burndownForAccount(payload, "codex", "codex-b")).toBeNull();
});

test("burndownForAccount masks on a null payload or empty account id", () => {
  expect(burndownForAccount(null, "claude", "claude-a")).toBeNull();
  expect(burndownForAccount(burndownPayload({ claudeAccountId: null }), "claude", "claude-a")).toBeNull();
  expect(burndownForAccount(burndownPayload(), "claude", "")).toBeNull();
});

test("idealRemaining runs a straight 100→0 line across the window", () => {
  expect(idealRemaining(start, reset, start)).toBe(100);
  expect(idealRemaining(start, reset, reset)).toBe(0);
  expect(idealRemaining(start, reset, start + week / 2)).toBeCloseTo(50, 5);
});

test("idealRemaining clamps outside the window and guards a zero-length window", () => {
  expect(idealRemaining(start, reset, start - 999)).toBe(100);
  expect(idealRemaining(start, reset, reset + 999)).toBe(0);
  expect(idealRemaining(start, start, start)).toBe(0);
});

test("mergeSamples dedupes by second, keeping the last value, and sorts ascending", () => {
  const merged = mergeSamples(
    [{ t: 30, remaining: 90 }, { t: 10, remaining: 100 }],
    [{ t: 30, remaining: 80 }, { t: 20, remaining: 95 }],
  );
  expect(merged).toEqual([
    { t: 10, remaining: 100 },
    { t: 20, remaining: 95 },
    { t: 30, remaining: 80 },
  ]);
});

const series = (samples: BurndownSeries["samples"]): BurndownSeries => ({
  windowStart: start,
  resetsAt: reset,
  windowSeconds: week,
  samples,
});

test("computePace flags burning ahead of pace when the curve sits below the diagonal", () => {
  // Halfway through the window the ideal says 50% left; the user has 30%.
  const now = start + week / 2;
  const pace = computePace(series([{ t: start, remaining: 100 }, { t: now, remaining: 30 }]), now);
  expect(pace).not.toBeNull();
  expect(pace!.ideal).toBeCloseTo(50, 5);
  expect(pace!.actual).toBe(30);
  expect(pace!.delta).toBeCloseTo(-20, 5);
  // Consumed 70% over half a week → hits 0 well before the reset.
  expect(pace!.zeroCrossing).not.toBeNull();
  expect(pace!.zeroCrossing! - now).toBeCloseTo((30 / 70) * (week / 2), 0);
  expect(pace!.zeroCrossing!).toBeLessThan(reset);
});

test("computePace reports underuse when the curve sits above the diagonal", () => {
  const now = start + week / 2;
  const pace = computePace(series([{ t: start, remaining: 100 }, { t: now, remaining: 80 }]), now);
  expect(pace!.delta).toBeCloseTo(30, 5);
});

test("computePace returns null without a defined window or any samples", () => {
  expect(computePace({ windowStart: null, resetsAt: reset, windowSeconds: week, samples: [{ t: 1, remaining: 5 }] }, 1)).toBeNull();
  expect(computePace(series([]), start)).toBeNull();
});

test("computePace leaves zeroCrossing null when nothing has been consumed", () => {
  const pace = computePace(series([{ t: start, remaining: 100 }]), start);
  expect(pace!.zeroCrossing).toBeNull();
});

test("computePace suppresses the projection for a flat series", () => {
  const now = start + week / 2;
  const pace = computePace(series([{ t: start, remaining: 50 }, { t: now, remaining: 50 }]), now);
  expect(pace!.zeroCrossing).toBeNull();
});

test("computePace suppresses the projection when the quota is climbing (a refill)", () => {
  const now = start + week / 2;
  const pace = computePace(series([{ t: start, remaining: 30 }, { t: now, remaining: 60 }]), now);
  expect(pace!.zeroCrossing).toBeNull();
});

test("computePace suppresses the projection for a mid-window refill even when it ends below the start", () => {
  const third = week / 3;
  // 80 → 20 → 60: net drop is positive, but the 20 → 60 rise is a refill.
  const pace = computePace(
    series([
      { t: start, remaining: 80 },
      { t: start + third, remaining: 20 },
      { t: start + 2 * third, remaining: 60 },
    ]),
    start + 2 * third,
  );
  expect(pace!.zeroCrossing).toBeNull();
});

test("computePace tolerates sub-epsilon sampling jitter on a draining series", () => {
  const day = 86_400;
  const pace = computePace(
    series([
      { t: start, remaining: 60 },
      { t: start + day, remaining: 39.8 },
      { t: start + 2 * day, remaining: 40.1 }, // +0.3 rise, within jitter tolerance
      { t: start + 3 * day, remaining: 39.5 },
    ]),
    start + 3 * day,
  );
  expect(pace!.zeroCrossing).not.toBeNull();
});

test("computePace projects from the observed slope, not an assumed full start", () => {
  // Never hit 100%: 60% → 40% over a day → 2%/half-day, so ~20 half-days to 0.
  const day = 86_400;
  const pace = computePace(series([{ t: start, remaining: 60 }, { t: start + day, remaining: 40 }]), start + day);
  // 40% remaining at 20%/day → 2 more days.
  expect(pace!.zeroCrossing! - (start + day)).toBeCloseTo(2 * day, 0);
});

/* ---------------------------------------------------- burndownSegments */

const NOW = start + 3 * 86_400;
const winStart = NOW - 86_400;
const seriesOf = (samples: { t: number; remaining: number }[], over: Partial<BurndownSeries> = {}): BurndownSeries => ({
  windowStart: winStart,
  resetsAt: winStart + week,
  windowSeconds: week,
  samples,
  lastReading: samples[samples.length - 1] ?? null,
  ...over,
});

test("burndownSegments joins samples within the gap threshold into one solid run", () => {
  const out = burndownSegments(seriesOf([0, 300, 600, 900].map((d, i) => ({ t: NOW - 900 + d, remaining: 90 - i }))), NOW);
  expect(out.known.length).toBe(1);
  expect(out.known[0].length).toBe(4);
  expect(out.kind).toBe("partial"); // the first sample is late: the lead from the window's opening is dashed
});

test("burndownSegments draws a gap longer than the threshold dashed and keeps both runs solid", () => {
  const a = { t: winStart, remaining: 100 };
  const b = { t: winStart + 600, remaining: 98 };
  const c = { t: winStart + 600 + GAP_S + 1, remaining: 90 };
  const d = { t: NOW, remaining: 70 };
  const out = burndownSegments(seriesOf([a, b, c, d]), NOW);
  expect(out.known.map((run) => run.length)).toEqual([2, 1, 1]);
  expect(out.estimated).toContainEqual([b, c]);
  expect(out.estimated).toContainEqual([c, d]);
  expect(out.kind).toBe("partial");
  expect(out.levelEstimated).toBe(false);
  expect(out.level).toBe(70);
});

test("burndownSegments tolerates a gap of exactly the threshold", () => {
  const a = { t: NOW - GAP_S - 10, remaining: 80 };
  const b = { t: NOW - 10, remaining: 79 };
  const out = burndownSegments(seriesOf([a, b], { windowStart: a.t, resetsAt: a.t + week }), NOW);
  expect(out.known).toEqual([[a, b]]);
  expect(out.estimated).toEqual([]);
  expect(out.kind).toBe("fresh");
});

test("burndownSegments dashes a lead from the window's opening to a late first sample", () => {
  const first = { t: winStart + 2 * 3600, remaining: 90 };
  const last = { t: NOW, remaining: 60 };
  const out = burndownSegments(seriesOf([first, { t: NOW - 300, remaining: 61 }, last]), NOW);
  expect(out.estimated[0]).toEqual([{ t: winStart, remaining: 100 }, first]);
  expect(out.kind).toBe("partial");
});

test("burndownSegments continues a stale last reading flat to now and marks the level estimated", () => {
  const last = { t: NOW - 6 * 3600, remaining: 55 };
  const out = burndownSegments(seriesOf([{ t: winStart, remaining: 100 }, { t: winStart + 300, remaining: 99 }, last]), NOW);
  expect(out.estimated).toContainEqual([last, { t: NOW, remaining: 55 }]);
  expect(out.level).toBe(55);
  expect(out.levelEstimated).toBe(true);
  expect(out.lastObservedAt).toBe(last.t);
  expect(out.kind).toBe("stale");
});

test("burndownSegments with a fresh last sample adds nothing after it", () => {
  const out = burndownSegments(seriesOf([{ t: winStart, remaining: 100 }, { t: winStart + 600, remaining: 97 }, { t: winStart + 1200, remaining: 95 }], { windowStart: winStart }), winStart + 1300);
  expect(out.estimated).toEqual([]);
  expect(out.levelEstimated).toBe(false);
  expect(out.kind).toBe("fresh");
});

test("burndownSegments reports a reset since the last reading as an assumed-full dashed line", () => {
  const out = burndownSegments(seriesOf([], { lastReading: { t: winStart - 3600, remaining: 8 } }), NOW);
  expect(out.kind).toBe("reset");
  expect(out.estimated).toEqual([[{ t: winStart, remaining: 100 }, { t: NOW, remaining: 100 }]]);
  expect(out.level).toBe(100);
  expect(out.levelEstimated).toBe(true);
  expect(out.known).toEqual([]);
});

test("burndownSegments draws a never-observed account as a dashed 100% line with an unknown level", () => {
  const out = burndownSegments(seriesOf([], { lastReading: null }), NOW);
  expect(out.kind).toBe("none");
  expect(out.level).toBeNull();
  expect(out.estimated).toEqual([[{ t: winStart, remaining: 100 }, { t: NOW, remaining: 100 }]]);
  const unknownWindow = burndownSegments(seriesOf([], { windowStart: null, resetsAt: null, lastReading: null }), NOW);
  expect(unknownWindow.estimated).toEqual([[{ t: NOW - week, remaining: 100 }, { t: NOW, remaining: 100 }]]);
});

/* ---------------------------------------------------------- buildSeries */

const liveWindow = (usedPercent: number, extra: Partial<{ resetsAt: number | null; observedAt: number | null }> = {}) => ({ usedPercent, resetsAt: NOW + 5 * 86_400, ...extra });

test("buildSeries stamps the live point at its observation time, not at now", () => {
  const observedAt = NOW - 4 * 3600;
  const series = buildSeries([], [], liveWindow(40, { observedAt }), NOW, week, null);
  expect(series.samples).toEqual([{ t: observedAt, remaining: 60 }]);
  const viaLiveAt = buildSeries([], [], liveWindow(40), NOW, week, null, NOW - 7200);
  expect(viaLiveAt.samples).toEqual([{ t: NOW - 7200, remaining: 60 }]);
  expect(buildSeries([], [], liveWindow(40), NOW, week, null).samples).toEqual([{ t: NOW, remaining: 60 }]);
});

test("buildSeries never stamps a live point in the future", () => {
  const series = buildSeries([], [], liveWindow(40, { observedAt: NOW + 500 }), NOW, week, null);
  expect(series.samples[0].t).toBe(NOW);
});

test("buildSeries rolls a past reset forward, drops the old window's samples and keeps the last reading", () => {
  const oldReset = NOW - 3600;
  const old = { t: oldReset - 86_400, remaining: 12 };
  const series = buildSeries([old], [], liveWindow(88, { resetsAt: oldReset, observedAt: oldReset - 600 }), NOW, week, null);
  expect(series.resetsAt).toBe(oldReset + week);
  expect(series.windowStart).toBe(oldReset);
  expect(series.samples).toEqual([]);
  expect(series.lastReading).toEqual({ t: oldReset - 600, remaining: 12 });
});

test("buildSeries without a live reading charts the stored history and reports its newest sample", () => {
  const forward = [{ t: NOW - 7200, remaining: 70 }, { t: NOW - 3600, remaining: 65 }];
  const series = buildSeries(forward, [], null, NOW, week, NOW + 86_400);
  expect(series.samples).toEqual(forward);
  expect(series.lastReading).toEqual(forward[1]);
});
