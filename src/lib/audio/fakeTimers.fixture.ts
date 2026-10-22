import type { LaneTimers } from "./eventLane";

/**
 * A deterministic clock for the audio rules' tests: timers run only when the
 * test advances time, in due order, each at its own instant.
 */
export interface FakeTimers extends LaneTimers {
  advance(ms: number): void;
  pending(): number;
}

export function createFakeTimers(start = 1_000_000): FakeTimers {
  let now = start;
  let sequence = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    schedule(run, ms) {
      const id = ++sequence;
      due.set(id, { at: now + Math.max(0, ms), run });
      return id;
    },
    cancel(handle) {
      due.delete(handle as number);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let next: [number, { at: number; run: () => void }] | null = null;
        for (const entry of due) if (entry[1].at <= until && (!next || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[0] < next[0]))) next = entry;
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].run();
      }
      now = until;
    },
    pending: () => due.size,
  };
}
