import { AsyncLocalStorage } from "node:async_hooks";
import { startupDiagnostic } from "./startupDiagnostics";

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
  | "file-transaction"
  | "registry-lock"
  | "registry-revision-retry"
  | "registry-lock-async"
  | "state-lease"
  | "state-write-lock"
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

export interface StateLockHolder {
  /** A known local process kind, or other-process when it cannot be proven. */
  kind: string;
  ageMs: number;
}

export interface BlockingWaitSample {
  /** Bounded caller coordinates for a slow registry wait, relative to source. */
  callSite?: string;
  stateWait?: { callSite: string; reason: string; outcome: string; attempts: number; maxSliceMs: number; backoffMs: number; synchronousSleepMs: number; pid: number; processKind: string; release: string | null; holder?: StateLockHolder };
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
  /** The operation was refused. Retryable state admission uses deferred. */
  refused?: true;
  /** Admission can be retried; no application callback entered. */
  deferred?: true;
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
const defaultLogSink = (line: string) => startupDiagnostic("warn", line);
let logSink: (line: string) => void = defaultLogSink;

// One process owns a bounded window. Operation ids deliberately do not split
// groups: a busy caller can issue a fresh id on every retry.
const DEFERRAL_WINDOW_MS = 5_000;
const DEFERRAL_GROUP_LIMIT = 128;
type DeferralGroup = { sample: BlockingWaitSample; count: number; firstAt: string };
const deferrals = new Map<string, DeferralGroup>();
let deferralTimer: ReturnType<typeof setTimeout> | undefined;
let deferralDeadline = 0;

function writeWaitLog(value: unknown): void {
  try { logSink(`[blocking-wait] ${JSON.stringify(value)}`); }
  catch { /* a log that cannot be written never fails the caller */ }
}

function writeDeferral(group: DeferralGroup): void {
  writeWaitLog({ ...group.sample, count: group.count, suppressedCount: group.count - 1,
    firstAt: group.firstAt, windowMs: DEFERRAL_WINDOW_MS });
}

function flushDeferrals(): void {
  clearTimeout(deferralTimer);
  deferralTimer = undefined;
  const pending = [...deferrals.values()];
  deferrals.clear();
  for (const group of pending) writeDeferral(group);
}

// Unref keeps a CLI exit prompt; its last partial window still has a receipt.
process.on("beforeExit", flushDeferrals);
process.on("exit", flushDeferrals);

function deferWaitLog(sample: BlockingWaitSample): void {
  if (deferralTimer && performance.now() >= deferralDeadline) flushDeferrals();
  const key = JSON.stringify([sample.role, sample.subject, sample.label, sample.synchronous,
    sample.stateWait?.callSite, sample.stateWait?.reason]);
  const held = deferrals.get(key);
  if (held) { held.sample = sample; held.count++; }
  else {
    if (deferrals.size >= DEFERRAL_GROUP_LIMIT) {
      const oldest = deferrals.entries().next().value!;
      deferrals.delete(oldest[0]);
      writeDeferral(oldest[1]);
    }
    deferrals.set(key, { sample, count: 1, firstAt: sample.at });
  }
  if (!deferralTimer) {
    deferralDeadline = performance.now() + DEFERRAL_WINDOW_MS;
    deferralTimer = setTimeout(flushDeferrals, DEFERRAL_WINDOW_MS);
    deferralTimer.unref();
  }
}

function round(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

export function blockingWaitRole(env: NodeJS.ProcessEnv = process.env): string {
  const owner = env.LLV_STATE_OWNER?.trim();
  return owner ? owner.slice(0, 32) : "unowned";
}

/** Keep source coordinates, never the absolute path or function arguments.
 * Capture only on the slow path; ordinary registry writes allocate no stack. */
export function registryWaitCallSite(stack: string | undefined): string {
  const locations: string[] = [];
  for (const frame of stack?.split("\n").slice(1) ?? []) {
    const location = frame.match(/(?:^|\/)((?:src|\.next\/server|dist)\/[A-Za-z0-9_./[\]-]+\.[cm]?[jt]sx?:\d+:\d+)\)?$/)?.[1];
    if (!location || /(?:blockingWaits|sqliteRegistryStore|agent\/registry)\.[cm]?[jt]sx?:/.test(location)) continue;
    locations.push(location);
    if (locations.length === 8) break;
  }
  // Bundled helpers share one chunk: retain the caller frames as well as the
  // first coordinate so that its minified name cannot hide the write's origin.
  return locations.length ? locations.join(" <- ").slice(0, 1_024) : "unresolved";
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
 * nothing worth keeping, and the window is for the ones that did. Refusals
 * and deferrals are always sampled. Short state deferrals share a journal
 * summary; terminal refusals and threshold waits retain immediate evidence.
 */
export function recordBlockingWait(input: {
  site: BlockingWaitSite;
  durationMs: number;
  synchronous: boolean;
  subject?: string | null;
  correlation?: BlockingWaitCorrelation | null;
  refused?: boolean;
  stateWait?: BlockingWaitSample["stateWait"];
}): void {
  if (!Number.isFinite(input.durationMs) || (input.durationMs <= 0 && !input.refused)) return;
  const deferred = input.stateWait?.outcome === "deferred";
  const context = input.correlation ?? currentWaitCorrelation();
  const sample: BlockingWaitSample = {
    site: input.site,
    ...((input.site === "registry-lock" || input.site === "registry-revision-retry" || input.site === "registry-lock-async") && input.durationMs >= BLOCKING_WAIT_LOG_MS
      ? { callSite: registryWaitCallSite(new Error().stack) } : {}),
    ...(input.stateWait ? { stateWait: input.stateWait } : {}),
    role: blockingWaitRole(),
    durationMs: round(input.durationMs),
    synchronous: input.synchronous,
    subject: input.subject ? input.subject.slice(0, 80) : null,
    label: context?.label ? context.label.slice(0, 80) : null,
    operationId: context?.operationId ? context.operationId.slice(0, 120) : null,
    ...(deferred ? { deferred: true as const } : input.refused ? { refused: true as const } : {}),
    at: new Date().toISOString(),
  };
  samples.push(sample);
  if (samples.length > SAMPLE_LIMIT) samples.splice(0, samples.length - SAMPLE_LIMIT);
  if (sample.site === "state-write-lock" && sample.deferred && sample.durationMs < 50) {
    deferWaitLog(sample);
    return;
  }
  if (sample.durationMs >= (sample.site === "state-write-lock" || sample.site === "state-lease" || sample.site === "file-transaction" ? 50 : BLOCKING_WAIT_LOG_MS) || (sample.site === "state-write-lock" && sample.refused)) {
    writeWaitLog(sample);
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
  clearTimeout(deferralTimer);
  deferralTimer = undefined;
  deferrals.clear();
  samples.length = 0;
  logSink = sink ?? defaultLogSink;
}
