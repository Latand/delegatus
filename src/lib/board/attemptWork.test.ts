import { expect, test } from "bun:test";

import { attemptWork, attemptWorkWindows, mergeWorkWindows, type TranscriptWork } from "./attemptWork";

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 21, 9, 10);
const NOW = T0 + 26 * HOUR;
const work = (windows: TranscriptWork["windows"], lastRecordAt: number | null = null, complete = true): TranscriptWork => ({ windows, lastRecordAt, complete });

test("an attempt whose wall span is a day long but whose turns are short counts only the turns", () => {
  // Build 8: queued, parked and settled for 25 h around three turns of 20, 10 and 5 minutes.
  const attempt = { startedAtMs: T0, endAtMs: T0 + 25 * HOUR, live: false };
  const evidence = work([[T0 + 5 * MIN, T0 + 25 * MIN], [T0 + 10 * HOUR, T0 + 10 * HOUR + 10 * MIN], [T0 + 24 * HOUR, T0 + 24 * HOUR + 5 * MIN]]);
  expect(attemptWork(attempt, evidence, NOW)).toEqual({ kind: "known", ms: 35 * MIN });
});

test("an attempt with no turn data is unknown, never zero and never its wall span", () => {
  const attempt = { startedAtMs: T0, endAtMs: T0 + 25 * HOUR, live: false };
  for (const evidence of [undefined, null, work([]), work([[T0, T0 + MIN]], null, false)]) expect(attemptWork(attempt, evidence, NOW)).toEqual({ kind: "unknown" });
  expect(attemptWork({ ...attempt, startedAtMs: null }, work([[T0, T0 + MIN]]), NOW)).toEqual({ kind: "unknown" });
});

test("a transcript read through that holds no turn inside the attempt proves zero work", () => {
  const attempt = { startedAtMs: T0, endAtMs: T0 + HOUR, live: false };
  expect(attemptWork(attempt, work([[T0 + 3 * HOUR, T0 + 4 * HOUR]]), NOW)).toEqual({ kind: "known", ms: 0 });
});

test("turns are cut at the attempt's own start and end when one conversation holds several attempts", () => {
  const attempt = { startedAtMs: T0 + HOUR, endAtMs: T0 + 2 * HOUR, live: false };
  const evidence = work([[T0, T0 + HOUR + 10 * MIN], [T0 + HOUR + 50 * MIN, T0 + 3 * HOUR]]);
  expect(attemptWorkWindows(attempt, evidence, NOW)).toEqual([[T0 + HOUR, T0 + HOUR + 10 * MIN], [T0 + HOUR + 50 * MIN, T0 + 2 * HOUR]]);
  expect(attemptWork(attempt, evidence, NOW)).toEqual({ kind: "known", ms: 20 * MIN });
});

test("an open turn runs to the clock while the agent works and to its last record otherwise", () => {
  const evidence = work([[T0, T0 + 10 * MIN], [T0 + 2 * HOUR, null]], T0 + 2 * HOUR + 15 * MIN);
  expect(attemptWork({ startedAtMs: T0, endAtMs: null, live: true }, evidence, T0 + 3 * HOUR)).toEqual({ kind: "known", ms: 10 * MIN + HOUR });
  expect(attemptWork({ startedAtMs: T0, endAtMs: null, live: false }, evidence, T0 + 3 * HOUR)).toEqual({ kind: "known", ms: 25 * MIN });
  // An open turn with no verified last record contributes nothing: its end is not invented.
  expect(attemptWork({ startedAtMs: T0, endAtMs: null, live: false }, work([[T0 + 2 * HOUR, null]], null), T0 + 3 * HOUR)).toEqual({ kind: "known", ms: 0 });
});

test("nothing is counted past the clock or before a start that lies in the future", () => {
  const evidence = work([[T0, T0 + 5 * HOUR]]);
  expect(attemptWork({ startedAtMs: T0, endAtMs: T0 + 5 * HOUR, live: false }, evidence, T0 + HOUR)).toEqual({ kind: "known", ms: HOUR });
  expect(attemptWork({ startedAtMs: T0 + 2 * HOUR, endAtMs: null, live: true }, evidence, T0 + HOUR)).toEqual({ kind: "unknown" });
});

test("windows closer than the gap merge into one mark and distant ones stay apart", () => {
  expect(mergeWorkWindows([[0, 10], [11, 20], [100, 110]], 2)).toEqual([[0, 20], [100, 110]]);
  expect(mergeWorkWindows([], 2)).toEqual([]);
});
