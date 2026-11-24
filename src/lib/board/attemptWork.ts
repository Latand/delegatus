/**
 * The working time of a stage attempt, from the turn windows of its
 * transcript. Pure and browser-safe: the server reads the transcript
 * (`src/lib/scanner/transcriptWork.ts`), this decides what the windows prove
 * about one attempt. Waiting for a worker, parking, queueing and settlement
 * sit between turns, so they never count; a duration nothing evidences stays
 * unknown rather than becoming a guess.
 */

/** One turn: the initiating prompt to the terminal output. `end` is null while the turn was still open at the last record. */
export type WorkWindow = readonly [start: number, end: number | null];

export interface TranscriptWork {
  /** Chronological, disjoint turn windows of the whole transcript. */
  windows: readonly WorkWindow[];
  /** The newest record time in the transcript: the verified end of an open turn on a conversation that is not working now. */
  lastRecordAt: number | null;
  /** False when the transcript could not be read through (too large, changed or unreadable). */
  complete: boolean;
}

export type AttemptWork = { kind: "known"; ms: number } | { kind: "unknown" };

export interface WorkSpan { startedAtMs: number | null; endAtMs: number | null; live: boolean }

/** The windows clipped to the attempt's own span, with each open one ended at the clock (live) or its last record. */
export function attemptWorkWindows(span: WorkSpan, evidence: TranscriptWork | null | undefined, nowMs: number): Array<[number, number]> | null {
  if (!evidence || !evidence.complete || !evidence.windows.length) return null;
  const { startedAtMs: start } = span;
  if (start === null || !Number.isFinite(start) || start > nowMs) return null;
  const limit = Math.min(span.endAtMs ?? (span.live ? nowMs : Infinity), nowMs);
  if (!(limit >= start)) return null;
  const clipped: Array<[number, number]> = [];
  for (const [windowStart, windowEnd] of evidence.windows) {
    const end = windowEnd ?? (span.live ? nowMs : evidence.lastRecordAt);
    if (end === null || !Number.isFinite(windowStart) || !Number.isFinite(end)) continue;
    const from = Math.max(windowStart, start), to = Math.min(end, limit);
    if (to > from) clipped.push([from, to]);
  }
  return clipped;
}

/** The sum of the attempt's turn time; unknown without complete evidence and a verified start. */
export function attemptWork(span: WorkSpan, evidence: TranscriptWork | null | undefined, nowMs: number): AttemptWork {
  const clipped = attemptWorkWindows(span, evidence, nowMs);
  return clipped ? { kind: "known", ms: clipped.reduce((sum, [from, to]) => sum + (to - from), 0) } : { kind: "unknown" };
}

/** Windows closer than `gapMs` drawn as one, so a long attempt of many short turns stays a handful of marks. */
export function mergeWorkWindows(windows: readonly (readonly [number, number])[], gapMs: number): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [from, to] of windows) {
    const last = merged.at(-1);
    if (last && from - last[1] <= gapMs) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}
