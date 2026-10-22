import assert from "node:assert/strict";

/** Successful state admission may log after 50 ms, even without contention.
 * Keep every other diagnostic and every unsuccessful exit visible to callers. */
export function assertStateChildSuccess(code: number | null, stderr: string): void {
  const errors = stderr.split(/\r?\n/).filter(Boolean).filter(line => {
    const prefix = "[blocking-wait] ";
    if (!line.startsWith(prefix)) return true;
    try {
      const sample = JSON.parse(line.slice(prefix.length));
      return !(sample?.site === "state-write-lock"
        && sample.stateWait?.outcome === "success"
        && typeof sample.stateWait.callSite === "string"
        && typeof sample.synchronous === "boolean"
        && Number.isFinite(sample.durationMs) && sample.durationMs >= 50
        && !sample.refused);
    } catch { return true; }
  });
  assert.deepEqual({ code, stderr: errors }, { code: 0, stderr: [] });
}
