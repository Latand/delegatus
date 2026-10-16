import { ExternalRelayError } from "./client";

export interface HistoryClock {
  now(): number;
  later(work: () => void, ms: number): () => void;
  afterPoll(work: () => void): () => void;
}
export const historyClock: HistoryClock = {
  now: () => performance.now(),
  later: (work, ms) => { const timer = setTimeout(work, ms); return () => clearTimeout(timer); },
  afterPoll: work => { const immediate = setImmediate(work); return () => clearImmediate(immediate); },
};

/** One total deadline, including DNS and body reads. A late timer gives ready
 * socket callbacks a poll turn before aborting. No remote data enters metrics. */
export async function withHistoryDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  metrics: { elapsedMs: number; loopGapMs: number },
  clock = historyClock,
  timeoutMs = 4000,
): Promise<T> {
  const start = clock.now();
  const deadlineAt = start + timeoutMs;
  let last = start, lastStallAt = -Infinity, finished = false;
  const controller = new AbortController();
  let cancelPulse = () => {}, cancelPoll = () => {};
  const observe = () => {
    const at = clock.now();
    const gap = Math.max(0, at - last - 100);
    metrics.loopGapMs = Math.max(metrics.loopGapMs, gap);
    if (gap > 100) lastStallAt = at;
    last = at;
  };
  const pulse = () => { observe(); cancelPulse = clock.later(pulse, 100); };
  cancelPulse = clock.later(pulse, 100);
  let cancelDeadline = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancelDeadline = clock.later(() => {
      // Attribute a stall only when it spans this deadline callback's event
      // loop turn. A recovered heartbeat from an earlier turn is historical.
      observe();
      const stalled = lastStallAt >= deadlineAt;
      const expire = () => {
        if (finished) return;
        const error = new ExternalRelayError(stalled ? "deadline_loop_stalled" : "deadline_exceeded");
        reject(error);
        controller.abort(error);
      };
      if (stalled) cancelPoll = clock.afterPoll(expire);
      else expire();
    }, timeoutMs);
  });
  try { return await Promise.race([work(controller.signal), deadline]); }
  finally {
    finished = true;
    metrics.elapsedMs = Math.max(0, clock.now() - start);
    // Include a stall immediately preceding a non-timeout failure as well.
    observe();
    cancelDeadline(); cancelPulse(); cancelPoll();
  }
}
