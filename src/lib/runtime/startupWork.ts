/** One shared pass budget; host rows and phases never renew it. */
export const STRUCTURED_STARTUP_PASS_DEADLINE_MS = 300_000;

/** Bound independent historical I/O and join every started operation before
 * propagating failure. Admission must never outlive an unobserved worker. */
export async function forEachStartupBatch<T>(
  items: Iterable<T>,
  visit: (item: T) => Promise<void>,
  assertActive: () => void = () => {},
): Promise<void> {
  const iterator = items[Symbol.iterator]();
  try {
    for (;;) {
      assertActive();
      const batch: T[] = [];
      const started = performance.now();
      let done = false;
      do {
        const next = iterator.next();
        if (next.done) { done = true; break; }
        batch.push(next.value);
      } while (batch.length < 16 && performance.now() - started < 8);
      const outcomes = await Promise.allSettled(batch.map(async item => visit(item)));
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      assertActive();
      if (done) return;
      // Resolved promises only drain microtasks; timers and sockets need a turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally { iterator.return?.(); }
}
