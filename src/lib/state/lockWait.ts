import { performanceSpans, performanceProcess } from "@/lib/performanceSpans";
import { AsyncLocalStorage } from "node:async_hooks";
import { accountMutationHeld, AccountCommitBusyError } from "@/lib/accounts/accountMutationContext";
import { recordBlockingWait, currentWaitCorrelation } from "@/lib/blockingWaits";
import { FileTransactionBusyError } from "./fileTransaction";
import { isMainThread } from "node:worker_threads";

/** Only acquisition failures carry this type. Never wrap an error raised after
 * an application callback entered: retrying it could repeat external effects. */
export class StateLockDeferredError extends FileTransactionBusyError {
  constructor(readonly callSite: string, readonly reason: "sqlite" | "lease" = "sqlite") {
    super(`state admission is busy at ${callSite}`);
    this.name = "StateLockDeferredError";
  }
}

export function stateDatabaseBusy(error: unknown): boolean {
  return /database is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(error instanceof Error ? error.message : String(error));
}

export function stateLockDeferral(error: unknown): StateLockDeferredError | null {
  // Store-specific wrappers preserve the typed pre-admission cause. Transaction
  // callbacks consume that type before returning an error to their caller.
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    if (error instanceof StateLockDeferredError) return error;
    error = error.cause;
  }
  return null;
}

type Wait = { start: number; deadline: number; attempts: number; maxSliceMs: number; backoffMs: number; synchronousSleepMs?: number; callSite: string; reason: string; subject?: string };
const admission = new AsyncLocalStorage<Wait>();
const active = new Set<Wait>();
export const STATE_LOCK_WAIT_MS = 30_000;
const totals = { completed: 0, refused: 0, totalMs: 0, maxMs: 0, buckets: [0, 0, 0, 0, 0] };

/** Fixed-size lifetime counters; the bounded recent sample ring is separate.
 * Histogram boundaries are 5, 50, 250 and 1000 milliseconds. */
export function stateLockWaitDiagnostics() {
  return { ...totals, buckets: [...totals.buckets], active: stateLockWaitsInFlight() };
}

export function stateLockProcessKind(): string {
  const entry = (process.argv[1] ?? "").replaceAll("\\", "/");
  if (!isMainThread) return "worker";
  if (/\/(?:dist\/mcp-server\.mjs|src\/lib\/mcp\/entry\.ts)$/.test(entry)) return "mcp";
  if (/\/runtime-host\/(?:main\.ts|main\.js)$/.test(entry)) return "runtime-host";
  if (/\/(?:server\.js|next-server|next)$/.test(entry)) return "viewer";
  return "embedded";
}

export function stateLockWaitsInFlight(): { callSite: string; ageMs: number; attempts: number }[] {
  return [...active].map(wait => ({ callSite: wait.callSite, ageMs: performance.now() - wait.start, attempts: wait.attempts }));
}

function record(wait: Wait, outcome: string, synchronous: boolean): void {
  const durationMs = performance.now() - wait.start;
  if (outcome !== "waiting") {
    totals.completed++;
    if (outcome !== "success") totals.refused++;
    totals.totalMs += durationMs;
    totals.maxMs = Math.max(totals.maxMs, durationMs);
    totals.buckets[durationMs < 5 ? 0 : durationMs < 50 ? 1 : durationMs < 250 ? 2 : durationMs < 1000 ? 3 : 4]!++;
  }
  const revision = performanceProcess.revision ?? process.env.LLV_HOT_STATE_RELEASE_REVISION;
  recordBlockingWait({ site: "state-write-lock", subject: wait.subject, synchronous,
    durationMs, refused: outcome !== "success" && outcome !== "waiting",
    correlation: currentWaitCorrelation() ?? { label: wait.callSite },
    stateWait: { callSite: wait.callSite, reason: wait.reason, outcome, attempts: wait.attempts,
      maxSliceMs: wait.maxSliceMs, backoffMs: wait.backoffMs, synchronousSleepMs: wait.synchronousSleepMs ?? 0, release: revision && /^[a-f0-9]{7,40}$/.test(revision) ? revision : null, pid: process.pid, processKind: stateLockProcessKind() },
  });
}

/** A single zero-timeout attempt, including connection setup. */
export function stateLockAttempt<T>(callSite: string, operation: () => T, subject?: string): T {
  // The standalone MCP server retains its synchronous contract. This test uses
  // its real entry point, never an owner environment inherited from the Viewer.
  if (!admission.getStore() && stateLockProcessKind() === "mcp" && !accountMutationHeld()) {
    const start = performance.now();
    const wait: Wait = { start, deadline: start + STATE_LOCK_WAIT_MS, attempts: 0, maxSliceMs: 0, backoffMs: 0, callSite, reason: "sqlite", subject };
    const cell = new Int32Array(new SharedArrayBuffer(4));
    let outcome = "error", reportedWaiting = false;
    try {
      return admission.run(wait, () => {
        for (;;) {
          wait.attempts++;
          const slice = performance.now();
          try { const result = stateLockAttempt(callSite, operation, subject); outcome = "success"; return result; }
          catch (error) {
            if (!(error instanceof StateLockDeferredError)) throw error;
            wait.callSite = error.callSite; wait.reason = error.reason;
            if (performance.now() >= wait.deadline) { outcome = "timeout"; throw new FileTransactionBusyError(`state admission timed out at ${wait.callSite}`); }
            if (!reportedWaiting && performance.now() - start >= 50) {
              reportedWaiting = true;
              wait.maxSliceMs = performance.now() - start;
              record(wait, "waiting", true);
            }
            const before = performance.now();
            performanceSpans.sync("state.write-wait", () => Atomics.wait(cell, 0, 0, Math.min(5, wait.deadline - performance.now())));
            wait.synchronousSleepMs = (wait.synchronousSleepMs ?? 0) + performance.now() - before;
          } finally { wait.maxSliceMs = Math.max(wait.maxSliceMs, performance.now() - slice); }
        }
      });
    } finally {
      wait.maxSliceMs = performance.now() - start;
      if (wait.attempts > 1 || outcome !== "success") record(wait, outcome, true);
    }
  }
  const start = performance.now();
  const context = admission.getStore();
  let refused = false;
  let outcome = "success";
  try { return performanceSpans.sync("state.write-wait", operation); }
  catch (error) {
    outcome = "error";
    if (!stateDatabaseBusy(error) && !(error instanceof StateLockDeferredError)) throw error;
    const deferred = error instanceof StateLockDeferredError ? error : new StateLockDeferredError(callSite);
    refused = true;
    if (!context) record({ start, deadline: start, attempts: 1, maxSliceMs: performance.now() - start, backoffMs: 0,
      callSite: deferred.callSite, reason: deferred.reason, subject }, "deferred", true);
    if (accountMutationHeld()) throw new AccountCommitBusyError("state writer is busy during account commit");
    throw deferred;
  } finally {
    if (context) context.maxSliceMs = Math.max(context.maxSliceMs, performance.now() - start);
    else if (!refused && performance.now() - start >= 50) record({ start, deadline: start, attempts: 1,
      maxSliceMs: performance.now() - start, backoffMs: 0, callSite, reason: "sqlite", subject }, outcome, true);
  }
}

/** The deadline includes nested admission and connection setup. No transaction
 * may be open when operation throws StateLockDeferredError. */
export async function waitForStateLock<T>(callSite: string, operation: () => T | Promise<T>, options: {
  waitMs?: number; signal?: AbortSignal; subject?: string;
} = {}): Promise<T> {
  const parent = admission.getStore();
  if (parent) return operation();
  const start = performance.now();
  const wait: Wait = { start, deadline: start + Math.max(0, options.waitMs ?? STATE_LOCK_WAIT_MS),
    attempts: 0, maxSliceMs: 0, backoffMs: 0, callSite, reason: "sqlite", subject: options.subject };
  active.add(wait);
  // Emit an in-flight observation even if the process never finishes its wait.
  const timer = setTimeout(() => { if (wait.attempts) record(wait, "waiting", false); }, 51);
  timer.unref();
  let outcome = "error";
  try {
    return await admission.run(wait, async () => {
      for (;;) {
        options.signal?.throwIfAborted();
        if (wait.attempts && performance.now() >= wait.deadline) { outcome = "timeout"; throw new FileTransactionBusyError(`state admission timed out at ${wait.callSite}`); }
        wait.attempts++;
        try { const value = await operation(); outcome = "success"; return value; }
        catch (error) {
          const deferred = stateLockDeferral(error);
          if (!deferred) throw error;
          wait.callSite = deferred.callSite; wait.reason = deferred.reason;
          if (performance.now() >= wait.deadline) { outcome = "timeout"; throw new FileTransactionBusyError(`state admission timed out at ${wait.callSite}`); }
          const backoff = Math.min(25, 2 ** Math.min(wait.attempts - 1, 5), wait.deadline - performance.now());
          const before = performance.now();
          await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, backoff)));
          wait.backoffMs += performance.now() - before;
        }
      }
    });
  } finally {
    clearTimeout(timer);
    active.delete(wait);
    if (options.signal?.aborted) outcome = "cancelled";
    record(wait, outcome, false);
  }
}
