import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Measured waits on shared state, with who waited and on whose behalf.
 *
 * Incident 2026-10-06 left two operator messages waiting 409 s and 515 s before
 * host dispatch, and the journal held only "[registry] mutation J retrying
 * after 4118ms": a minified name, no writer role, no operation. This records
 * each wait on a registry write lock, a lost registry revision, a state-store
 * lease, and the runtime snapshot's collection, serialization, transfer and
 * parse, with the process's writer role, the duration, whether the wait held
 * the event loop, and the operation it was correlated with. Nothing here ever
 * sees message content: a correlation is an operation id and a label.
 *
 * A wait at or above {@link BLOCKING_WAIT_LOG_MS} is also written to the log as
 * one `[blocking-wait]` JSON line, which is what the service journal keeps.
 */

export type BlockingWaitSite =
  | "registry-lock"
  | "registry-revision-retry"
  | "registry-lock-async"
  | "state-lease"
  | "snapshot-collect"
  | "snapshot-serialize"
  | "snapshot-transfer"
  | "snapshot-parse";

export interface BlockingWaitCorrelation {
  /** What the caller was doing, as a stable label (`delivery.transition`). */
  label: string;
  /** The delivery or runtime operation it was done for, when there is one. */
  operationId?: string | null;
}

export interface BlockingWaitSample {
  site: BlockingWaitSite;
  /** `LLV_STATE_OWNER` of this process, or `unowned`. */
  role: string;
  durationMs: number;
  /** True when the wait held this process's event loop. */
  synchronous: boolean;
  /** The store, collection or mutation the wait was on. */
  subject: string | null;
  label: string | null;
  operationId: string | null;
  at: string;
}

export interface BlockingWaitSiteStats {
  count: number;
  synchronousCount: number;
  totalMs: number;
  maxMs: number;
  p95Ms: number;
}

export interface BlockingWaitDiagnostics {
  role: string;
  sites: Partial<Record<BlockingWaitSite, BlockingWaitSiteStats>>;
  /** The longest recent waits, longest first. */
  longest: BlockingWaitSample[];
}

export const BLOCKING_WAIT_LOG_MS = 250;
const SAMPLE_LIMIT = 512;
const LONGEST_LIMIT = 20;

const correlation = new AsyncLocalStorage<BlockingWaitCorrelation>();
const samples: BlockingWaitSample[] = [];
let logSink: (line: string) => void = (line) => console.warn(line);

function round(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

export function blockingWaitRole(env: NodeJS.ProcessEnv = process.env): string {
  const owner = env.LLV_STATE_OWNER?.trim();
  return owner ? owner.slice(0, 32) : "unowned";
}

/** Runs `operation` with a correlation every wait inside it reports. */
export function withWaitCorrelation<T>(context: BlockingWaitCorrelation, operation: () => T): T {
  return correlation.run(context, operation);
}

export function currentWaitCorrelation(): BlockingWaitCorrelation | null {
  return correlation.getStore() ?? null;
}

/**
 * Records one wait. Waits of zero are dropped: an uncontended lock costs
 * nothing worth keeping, and the window is for the ones that did.
 */
export function recordBlockingWait(input: {
  site: BlockingWaitSite;
  durationMs: number;
  synchronous: boolean;
  subject?: string | null;
  correlation?: BlockingWaitCorrelation | null;
}): void {
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) return;
  const context = input.correlation ?? currentWaitCorrelation();
  const sample: BlockingWaitSample = {
    site: input.site,
    role: blockingWaitRole(),
    durationMs: round(input.durationMs),
    synchronous: input.synchronous,
    subject: input.subject ? input.subject.slice(0, 80) : null,
    label: context?.label ? context.label.slice(0, 80) : null,
    operationId: context?.operationId ? context.operationId.slice(0, 120) : null,
    at: new Date().toISOString(),
  };
  samples.push(sample);
  if (samples.length > SAMPLE_LIMIT) samples.splice(0, samples.length - SAMPLE_LIMIT);
  if (sample.durationMs >= BLOCKING_WAIT_LOG_MS) {
    try { logSink(`[blocking-wait] ${JSON.stringify(sample)}`); }
    catch { /* a log that cannot be written never fails the caller */ }
  }
}

/** Measures `operation` and records its duration under `site`. */
export function measureBlocking<T>(site: BlockingWaitSite, subject: string | null, operation: () => T): T {
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    recordBlockingWait({ site, subject, synchronous: true, durationMs: performance.now() - startedAt });
  }
}

export function blockingWaitDiagnostics(): BlockingWaitDiagnostics {
  const sites: BlockingWaitDiagnostics["sites"] = {};
  const bySite = new Map<BlockingWaitSite, number[]>();
  for (const sample of samples) {
    const stats = sites[sample.site] ??= { count: 0, synchronousCount: 0, totalMs: 0, maxMs: 0, p95Ms: 0 };
    stats.count += 1;
    if (sample.synchronous) stats.synchronousCount += 1;
    stats.totalMs = round(stats.totalMs + sample.durationMs);
    stats.maxMs = Math.max(stats.maxMs, sample.durationMs);
    const durations = bySite.get(sample.site) ?? [];
    durations.push(sample.durationMs);
    bySite.set(sample.site, durations);
  }
  for (const [site, durations] of bySite) {
    durations.sort((left, right) => left - right);
    sites[site]!.p95Ms = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
  }
  const longest = [...samples].sort((left, right) => right.durationMs - left.durationMs).slice(0, LONGEST_LIMIT);
  return { role: blockingWaitRole(), sites, longest };
}

/** Tests only. */
export function resetBlockingWaitsForTests(sink?: (line: string) => void): void {
  samples.length = 0;
  logSink = sink ?? ((line) => console.warn(line));
}
