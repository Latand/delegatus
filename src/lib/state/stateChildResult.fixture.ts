import assert from "node:assert/strict";

/** Successful state admission may log after 50 ms, even without contention.
 * Keep every other diagnostic and every unsuccessful exit visible to callers. */
export function assertStateChildSuccess(code: number | null, stderr: string): void {
  const completed = new Set<string>();
  // Walk backwards so an in-flight record needs a later successful completion.
  const errors = stderr.split(/\r?\n/).filter(Boolean).reverse().filter(line => {
    const prefix = "[blocking-wait] ";
    if (!line.startsWith(prefix)) return true;
    try {
      const sample = JSON.parse(line.slice(prefix.length));
      if (!(sample?.site === "state-write-lock"
        && typeof sample.stateWait?.callSite === "string"
        && Number.isSafeInteger(sample.stateWait.pid) && sample.stateWait.pid > 0
        && typeof sample.synchronous === "boolean"
        && Number.isFinite(sample.durationMs) && sample.durationMs >= 50
        && !sample.refused)) return true;
      const key = JSON.stringify([sample.stateWait.pid, sample.stateWait.callSite, sample.subject, sample.operationId]);
      if (sample.stateWait.outcome === "success") { completed.add(key); return false; }
      return !(sample.stateWait.outcome === "waiting" && !sample.synchronous && completed.has(key));
    } catch { return true; }
  }).reverse();
  assert.deepEqual({ code, stderr: errors }, { code: 0, stderr: [] });
}
