/** One lock deadline spans queue opening and all checks in a helper invocation.
 * SQLite calls must use busy_timeout=0: backoff yields to timers and signals. */
export function admissionLockWait(timeoutMs = 30_000, say: (line: string) => void = console.error,
  clock = { now: () => performance.now(), sleep: (ms: number): Promise<unknown> => Bun.sleep(ms) }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("CPU admission lock timeout must be a positive number of milliseconds");
  let deadline: number | undefined;
  let started: number | undefined;
  return async function retry<T>(operation: () => T | Promise<T>): Promise<T> {
    let delay = 20;
    let retrying = false;
    for (;;) {
      if (retrying && deadline !== undefined && clock.now() >= deadline) {
        throw new Error(`CPU admission queue lock deadline exceeded after ${timeoutMs} ms; checks did not start`);
      }
      try {
        const result = await operation();
        if (started !== undefined) {
          say(`gate-slot: CPU admission queue lock acquired after ${Math.round(clock.now() - started)} ms`);
          started = undefined;
        }
        return result;
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
        retrying = true;
        const now = clock.now();
        deadline ??= now + timeoutMs;
        if (started === undefined) {
          started = now;
          say(`gate-slot: waiting for CPU admission queue SQLite lock (deadline ${timeoutMs} ms)`);
        }
        await clock.sleep(Math.min(delay, Math.max(0, deadline - now)));
        delay = Math.min(delay * 2, 250);
      }
    }
  };
}
