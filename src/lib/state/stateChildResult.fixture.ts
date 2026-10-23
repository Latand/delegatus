import assert from "node:assert/strict";
import { z } from "zod";

// Match the complete successful state-lock record emitted by blockingWaits.ts.
// Unknown fields (including an attached error) must remain visible.
const milliseconds = z.number().nonnegative();
const stateWait = z.strictObject({
  callSite: z.string().min(1),
  reason: z.enum(["sqlite", "lease"]),
  outcome: z.enum(["success", "waiting"]),
  attempts: z.number().int().nonnegative(),
  maxSliceMs: milliseconds,
  backoffMs: milliseconds,
  synchronousSleepMs: milliseconds,
  pid: z.number().int().positive(),
  processKind: z.enum(["worker", "mcp", "runtime-host", "viewer", "embedded"]),
  release: z.string().regex(/^[a-f0-9]{7,40}$/).nullable(),
  holder: z.strictObject({ kind: z.string().min(1), ageMs: milliseconds }).optional(),
});
const successfulWait = z.strictObject({
  site: z.literal("state-write-lock"),
  role: z.string().min(1).max(32),
  durationMs: milliseconds.min(50),
  synchronous: z.boolean(),
  subject: z.string().max(80).nullable(),
  label: z.string().max(80).nullable(),
  operationId: z.string().max(120).nullable(),
  at: z.iso.datetime({ precision: 3 }),
  stateWait,
});

// server.ts emits this sibling timing diagnostic after a two-second call.
// Every phase is required, in emitter order; trailing text is an error.
const mcpSlow = /^\[mcp slow\] pid=([1-9]\d*) role=(\S{1,32}) tool=([a-z][a-z0-9_]*) callerMs=(\d+) httpMs=(\d+) claimMs=(\d+) bindingMs=(\d+) completionMs=(\d+) serializationMs=(\d+) serviceTotalMs=(\d+) replayMs=(\d+)$/;

function isMcpTiming(line: string): boolean {
  const match = mcpSlow.exec(line);
  return match !== null && [match[1], ...match.slice(4)].every(value => Number.isSafeInteger(Number(value)))
    && Number(match[10]) >= 2_000;
}

/** Successful state admission may log after 50 ms, even without contention.
 * Allow only successful [blocking-wait] records and complete [mcp slow] timing
 * lines. Keep every other diagnostic and unsuccessful exit visible to callers. */
export function assertStateChildSuccess(code: number | null, stderr: string): void {
  const completed = new Set<string>();
  // Walk backwards so an in-flight record needs a later successful completion.
  const lines = stderr === "" ? [] : stderr.replace(/\r?\n$/, "").split(/\r?\n/);
  const errors = lines.reverse().filter(line => {
    if (isMcpTiming(line)) return false;
    const prefix = "[blocking-wait] ";
    if (!line.startsWith(prefix)) return true;
    try {
      const parsed = successfulWait.safeParse(JSON.parse(line.slice(prefix.length)));
      if (!parsed.success) return true;
      const sample = parsed.data;
      const key = JSON.stringify([sample.stateWait.pid, sample.stateWait.callSite, sample.subject, sample.operationId]);
      if (sample.stateWait.outcome === "success") { completed.add(key); return false; }
      return !(sample.stateWait.outcome === "waiting" && !sample.synchronous && completed.has(key));
    } catch { return true; }
  }).reverse();
  assert.deepEqual({ code, stderr: errors }, { code: 0, stderr: [] });
}
