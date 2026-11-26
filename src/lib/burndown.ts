import { LIMITS_FRESHNESS_S } from "./rateLimit";
import type { BurndownPayload, BurndownSeries, EngineBurndown, LimitSample, LimitWindow } from "./types";

/** Standard window lengths in seconds. Codex transcripts can carry an exact
    `window_minutes`, which overrides these when present. */
export const WINDOW_SECONDS = { session: 5 * 3600, weekly: 7 * 24 * 3600 } as const;

export type WindowKey = keyof typeof WINDOW_SECONDS;

/** Ownership gate for the burndown chart, mirroring LimitsFooter's
    `limitsForActiveAccount`: a history request started for one account can
    resolve after the chart moved to another, so its series is used only when
    the payload's account stamp still matches the account being charted. A
    mismatch (or a null/empty stamp) masks the data instead of charting the
    wrong account. */
export function burndownForAccount(payload: BurndownPayload | null, engine: "claude" | "codex", accountId: string): EngineBurndown | null {
  if (!payload || !accountId) return null;
  const payloadAccountId = engine === "claude" ? payload.claudeAccountId : payload.codexAccountId;
  if (payloadAccountId !== accountId) return null;
  return engine === "claude" ? payload.claude : payload.codex;
}

/** Clamp a percentage into the drawable 0–100 range. */
export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Ideal even-pace remaining % at time `t`: 100 at `windowStart`, 0 at
    `resetsAt`. Spending exactly this fast lands on empty right at the reset. */
export function idealRemaining(windowStart: number, resetsAt: number, t: number): number {
  if (resetsAt <= windowStart) return 0;
  const frac = (resetsAt - t) / (resetsAt - windowStart);
  return clampPercent(frac * 100);
}

/** Merge two sample streams into one oldest-first series, collapsing points
    that share the same second (the live "now" point coincides with a forward
    sample, forward polls can coincide with a transcript event). */
export function mergeSamples(...streams: LimitSample[][]): LimitSample[] {
  const byT = new Map<number, number>();
  for (const stream of streams) {
    for (const sample of stream) {
      if (!Number.isFinite(sample.t) || !Number.isFinite(sample.remaining)) continue;
      byT.set(sample.t, clampPercent(sample.remaining));
    }
  }
  return [...byT.entries()].map(([t, remaining]) => ({ t, remaining })).sort((a, b) => a.t - b.t);
}

export interface PaceSummary {
  /** Where even pace says the user should be right now (% remaining). */
  ideal: number;
  /** Where the user actually is (latest sample, % remaining). */
  actual: number;
  /** actual − ideal. Positive = above the diagonal (underusing / safe);
      negative = below it (burning ahead of pace). */
  delta: number;
  /** Unix seconds the current slope projects quota to hit 0%, or null when the
      window is not depleting (flat or refilled) or the start is unknown. */
  zeroCrossing: number | null;
}

/** A consecutive rise beyond this (percentage points) counts as a refill rather
    than sampling jitter on an otherwise draining series. */
const REFILL_EPSILON = 0.5;

/** Projects when the quota hits 0% from the slope of the *observed* samples
    (first → latest of the window), not an assumed full start. Returns null when
    the series is flat, ends higher than it started, or contains any mid-series
    rise (a refill / window reset), so neither a steady 50%→50% nor an
    80→20→60 replenishment ever produces a bogus "empty by …" forecast. */
function projectZeroCrossing(samples: LimitSample[], actual: number): number | null {
  if (samples.length < 2) return null;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].remaining > samples[i - 1].remaining + REFILL_EPSILON) return null;
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  const drop = first.remaining - last.remaining; // positive = quota being spent
  if (dt <= 0 || drop <= 0) return null;
  return last.t + actual / (drop / dt);
}

/** Pace read for the current window: compares the latest actual sample against
    the ideal diagonal and projects the observed consumption slope to zero. */
export function computePace(series: BurndownSeries, now: number): PaceSummary | null {
  const { windowStart, resetsAt, samples } = series;
  if (windowStart === null || resetsAt === null || samples.length === 0) return null;
  const latest = samples[samples.length - 1];
  const actual = clampPercent(latest.remaining);
  const clampedNow = Math.min(Math.max(now, windowStart), resetsAt);
  const ideal = idealRemaining(windowStart, resetsAt, clampedNow);
  return { ideal, actual, delta: actual - ideal, zeroCrossing: projectZeroCrossing(samples, actual) };
}

/** Two observations further apart than this leave a gap the chart draws dashed.
    It is the age at which the footer marks a reading stale, four times the
    five-minute sample spacing. */
export const GAP_S = LIMITS_FRESHNESS_S;

/** Assemble one window's burndown from forward poll samples, an optional
    transcript backfill and the current live value, scoped to the current window.
    The live point sits at the moment it was observed (`live.observedAt`, else
    `liveAt`, else `now`) so a cached reading is never drawn as fresh. A reset
    moment already in the past rolls forward by whole windows: the reading then
    belongs to a window that has ended, and its samples drop out of the new one. */
export function buildSeries(
  forward: LimitSample[],
  backfill: LimitSample[],
  live: LimitWindow | null,
  now: number,
  windowSeconds: number,
  backfillResetsAt: number | null,
  liveAt: number | null = null,
): BurndownSeries {
  let resetsAt = live?.resetsAt ?? backfillResetsAt ?? null;
  if (resetsAt !== null && resetsAt <= now && windowSeconds > 0) {
    resetsAt += (Math.floor((now - resetsAt) / windowSeconds) + 1) * windowSeconds;
  }
  const windowStart = resetsAt !== null ? resetsAt - windowSeconds : null;
  const observedAt = live?.observedAt ?? liveAt ?? now;
  const livePoint: LimitSample[] = live && typeof live.usedPercent === "number" ? [{ t: Math.min(Math.round(observedAt), now), remaining: clampPercent(100 - live.usedPercent) }] : [];
  const merged = mergeSamples(forward, backfill, livePoint);
  // Strictly scope to the current window: a sample from before windowStart
  // belongs to the previous window, and after a rollover it would sit in the
  // series as a low pre-reset value ahead of the ~100% post-reset point. That
  // boundary rise reads as a refill and would suppress the pace projection for
  // the whole new window, so those pre-window samples are dropped here.
  const samples = windowStart !== null ? merged.filter((s) => s.t >= windowStart) : merged;
  return { windowStart, resetsAt, windowSeconds, samples, lastReading: merged[merged.length - 1] ?? null };
}

export type BurndownKind = "fresh" | "partial" | "stale" | "reset" | "none";

export interface BurndownSegments {
  /** Runs of observations no further apart than {@link GAP_S}, drawn solid. */
  known: LimitSample[][];
  /** Spans nobody observed, drawn dashed: a gap inside the history, a lead from
      the window's opening, a flat span from the last reading to now, or the
      whole window at full quota. */
  estimated: [LimitSample, LimitSample][];
  /** Remaining share the chart ends on, or null when nothing was ever read. */
  level: number | null;
  levelEstimated: boolean;
  lastObservedAt: number | null;
  kind: BurndownKind;
}

/** Splits a series into the part that was observed (solid) and the part the
    chart has to assume (dashed). The remaining share only falls inside a window,
    so a flat line from the last reading is the upper bound, never a forecast. */
export function burndownSegments(series: BurndownSeries, now: number): BurndownSegments {
  const { samples, windowStart, lastReading } = series;
  if (samples.length === 0) {
    const x0 = windowStart ?? now - series.windowSeconds;
    const full: [LimitSample, LimitSample] = [{ t: x0, remaining: 100 }, { t: Math.max(now, x0), remaining: 100 }];
    const resetSince = Boolean(lastReading && windowStart !== null && lastReading.t < windowStart);
    return {
      known: [],
      estimated: [full],
      level: resetSince ? 100 : null,
      levelEstimated: true,
      lastObservedAt: lastReading?.t ?? null,
      kind: resetSince ? "reset" : "none",
    };
  }
  const known: LimitSample[][] = [[samples[0]]];
  const estimated: [LimitSample, LimitSample][] = [];
  let partial = false;
  if (windowStart !== null && samples[0].t - windowStart > GAP_S) {
    estimated.push([{ t: windowStart, remaining: 100 }, samples[0]]);
    partial = true;
  }
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t - samples[i - 1].t > GAP_S) {
      estimated.push([samples[i - 1], samples[i]]);
      known.push([samples[i]]);
      partial = true;
    } else {
      known[known.length - 1].push(samples[i]);
    }
  }
  const last = samples[samples.length - 1];
  const stale = now - last.t > GAP_S;
  if (stale) estimated.push([last, { t: now, remaining: last.remaining }]);
  return {
    known,
    estimated,
    level: last.remaining,
    levelEstimated: stale,
    lastObservedAt: last.t,
    kind: stale ? "stale" : partial ? "partial" : "fresh",
  };
}
