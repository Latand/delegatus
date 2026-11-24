import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export interface FileLockHolder extends StateLockHolder {
  /** True when the contending lock file belongs to the waiting process. */
  sameProcess: boolean;
}

export interface BlockingWaitSample {
  /** Bounded caller coordinates for a slow registry or file-transaction wait, relative to source. */
  callSite?: string;
  /** Lock holder observed when a file-transaction wait first contended. */
  holder?: FileLockHolder;
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

const KNOWN_BLOCKING_WAIT_ROLES: ReadonlySet<string> = new Set([
  "viewer",
  "runtime-host",
  "mcp",
  "tool",
  "worker",
  "helper",
  "cli",
  "embedded",
  "test",
  "other-process",
  "unowned",
]);

/** Closed set of permitted wait labels for `file-transaction` blocking-wait
 * diagnostics (including explicit `withWaitCorrelation` labels). Untrusted
 * caller labels are never echoed verbatim into `[blocking-wait]` logs. */
export const KNOWN_FILE_TRANSACTION_WAIT_LABELS: ReadonlySet<string> = new Set([
  "file-transaction",
  "recorded-check.host-custody",
  "recorded-check.handoff",
  "recorded-check.acknowledgement",
  "recorded-check.observation",
  "attempt-temp.sweep",
  "attempt-evidence.copy",
  "attempt-temp.approved",
  "temporary-data.retention",
  "done.media",
  "report.media",
  "prototype.decision",
  "prototype.publication",
  "telegram.review-polls",
  "telegram.review-post",
  "operator.settings",
  "operator.worker-limit",
  "state.hot-authority",
  "state.retirement-guard",
  "state.disk-pressure",
  "state.disk-pressure-notices",
  "release.runs",
  "loop-profiler.store",
  "memory.import",
  "memory.source",
  "memory.settings",
  "memory.role-history",
  "metadata.collection",
  "account-guard.obligations",
  "account-credit-guard.obligations",
  "interruption.index",
  "interruption.evidence",
  "pipeline.initialize",
  "accounts.migration",
  "voice.settings",
  "voice-settings.write",
  "provider.settings",
  "keys.store",
  "voice-companion.state",
  "asks-you.settings",
  "attention.native-proof",
  "codex.subagent-boundary",
  "git.forge-credentials",
  "state.staged-recovery",
  "registry.staged-recovery",
  // Closed canonical file-transaction subjects also serve as fallback labels.
  "recorded-check-host-fences/<slot>",
  "recorded-check-observers/<slot>",
  "seat-quota-recovery/<entry>",
  "done-media/owner.lock",
  "report-media/owner",
  "prototype-reviews/<entry>",
  "prototype-reviews/<id>.polls.lock",
  "prototype-reviews/<id>.telegram.lock",
  "prototype-reviews/publication.lock",
  "telegram/<entry>",
  "codex-update/<entry>",
  "interruption-obligations",
  "attempt-temp.sqlite.sweep",
  "hot-state-authority.json",
  "lifecycle-journal.json",
  "operator-settings.json",
  "worker-limit.json",
  "project-settings.json",
  "tasks-row-preparation.json",
  "disk-pressure.json",
  "disk-pressure-notices.json",
  "release-runs.json",
  "structured-user-metadata-publication",
  ".delegatus-initialization",
  "import-job",
  "publication.lock",
  "openai-api-key",
  "voice-settings.json",
  "accounts.json",
  "asks-you-settings.json",
  "companion-state.json",
  "memory-settings.json",
  "role-memory-history.json",
  "provider-settings.json",
  "loop-profiler.json",
]);

export function sanitizeFileTransactionWaitLabel(rawLabel: unknown, fallback = "file-transaction"): string {
  const candidate = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (candidate && KNOWN_FILE_TRANSACTION_WAIT_LABELS.has(candidate)) return candidate;
  const safeFallback = fallback.trim();
  return KNOWN_FILE_TRANSACTION_WAIT_LABELS.has(safeFallback) ? safeFallback : "file-transaction";
}

/** Closed set of permitted operation-kind prefixes for `file-transaction`
 * blocking-wait correlation ids. Any suffix after the first `:` (such as an
 * engine or account id) is stripped; unknown kinds are dropped (`null`). */
export const KNOWN_FILE_TRANSACTION_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "account-removal",
  "account-switch",
  "account-migration",
  "delivery",
  "spawn",
  "pipeline",
  "recorded-check",
  "release",
  "state-recovery",
  "voice-settings",
  "quota",
  "memory",
]);

export function sanitizeFileTransactionOperationId(rawOperationId: unknown): string | null {
  if (typeof rawOperationId !== "string") return null;
  const trimmed = rawOperationId.trim();
  if (!trimmed) return null;
  const colonIndex = trimmed.indexOf(":");
  const kind = (colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed).trim();
  return KNOWN_FILE_TRANSACTION_OPERATION_KINDS.has(kind) ? kind : null;
}

const KNOWN_SRC_TOP_ENTRIES: ReadonlySet<string> = new Set([
  "app",
  "components",
  "hooks",
  "lib",
  "runtime-host",
  "styles",
  "test-helpers",
  "instrumentation.ts",
  "instrumentation.test.ts",
  "proxy.ts",
  "proxy.test.ts",
  "proxy.host.test.ts",
  "proxy.team.test.ts",
  "middleware.ts",
]);

const VERIFIED_SOURCE_ROOTS: readonly string[] = (() => {
  const roots = new Set<string>();
  const addRootFrom = (rawPath: string) => {
    const normalized = rawPath.replaceAll("\\", "/");
    const marker = Math.max(
      normalized.lastIndexOf("/src/"),
      normalized.lastIndexOf("/.next/server/"),
      normalized.lastIndexOf("/dist/"),
    );
    if (marker > 0) roots.add(normalized.slice(0, marker));
  };
  try {
    const raw = import.meta.url.startsWith("file://") ? fileURLToPath(import.meta.url) : import.meta.url;
    const resolved = path.resolve(raw);
    addRootFrom(resolved);
    try {
      addRootFrom(fs.realpathSync(resolved));
    } catch { /* realpath unavailable */ }
  } catch { /* fallback empty */ }
  return [...roots];
})();

export function normalizeBlockingWaitHolderKind(rawRole: unknown, fallback = "other-process"): string {
  const candidate = typeof rawRole === "string" ? rawRole.trim() : "";
  if (KNOWN_BLOCKING_WAIT_ROLES.has(candidate)) return candidate;
  const safeFallback = fallback.trim();
  return KNOWN_BLOCKING_WAIT_ROLES.has(safeFallback) ? safeFallback : "other-process";
}

export function blockingWaitRole(env: NodeJS.ProcessEnv = process.env): string {
  const owner = env.LLV_STATE_OWNER?.trim();
  return owner ? owner.slice(0, 32) : "unowned";
}

function relativeVerifiedCallSite(rawFramePath: string): string | null {
  if (!VERIFIED_SOURCE_ROOTS.length) return null;
  const split = rawFramePath.match(/^(.*\.[cm]?[jt]sx?)(:\d+:\d+)$/);
  if (!split) return null;
  let filePart = split[1]!;
  const coordSuffix = split[2]!;
  if (filePart.startsWith("file://")) {
    try {
      filePart = fileURLToPath(filePart);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(filePart)) return null;
  let resolvedFile: string;
  try {
    resolvedFile = fs.realpathSync(path.resolve(filePart));
  } catch {
    // Missing or unreadable source file: never emit an unverified lexical path.
    return null;
  }
  const normalized = resolvedFile.replaceAll("\\", "/");
  let rel: string | null = null;
  for (const verifiedRoot of VERIFIED_SOURCE_ROOTS) {
    if (normalized.startsWith(`${verifiedRoot}/`)) {
      rel = normalized.slice(verifiedRoot.length + 1);
      break;
    }
  }
  if (!rel || rel.includes("..")) return null;
  if (!/^(?:src|\.next\/server|dist)\/[A-Za-z0-9_./[\]-]+\.[cm]?[jt]sx?$/.test(rel)) {
    return null;
  }
  if (rel.startsWith("src/")) {
    const firstSegment = rel.slice("src/".length).split("/")[0] ?? "";
    if (!KNOWN_SRC_TOP_ENTRIES.has(firstSegment)) return null;
  }
  return `${rel}${coordSuffix}`;
}

function collectVerifiedCallSite(stack: string | undefined, fallback: "unresolved" | "external"): string {
  const locations: string[] = [];
  for (const frame of stack?.split("\n").slice(1) ?? []) {
    const rawLocation = frame.trim().match(/\(?((?:file:\/\/)?[^\s()]+?\.[cm]?[jt]sx?:\d+:\d+)\)?$/)?.[1];
    if (!rawLocation) continue;
    const location = relativeVerifiedCallSite(rawLocation);
    if (!location || /(?:blockingWaits|sqliteRegistryStore|agent\/registry|state\/fileTransaction)\.[cm]?[jt]sx?:/.test(location)) continue;
    locations.push(location);
    if (locations.length === 8) break;
  }
  // Bundled helpers share one chunk: retain the caller frames as well as the
  // first coordinate so that its minified name cannot hide the write's origin.
  return locations.length ? locations.join(" <- ").slice(0, 1_024) : fallback;
}

/** Keep source coordinates strictly relative to the verified project or build root,
 * never an absolute path, parent directory name, or external caller path.
 * Capture only on the slow path; ordinary registry writes allocate no stack. */
export function registryWaitCallSite(stack: string | undefined): string {
  return collectVerifiedCallSite(stack, "unresolved");
}

/** Repo-relative caller coordinates for file-transaction waits; frames outside
 * the verified project or build root are dropped and collapse to `"external"`. */
export function fileTransactionCallSite(stack: string | undefined): string {
  return collectVerifiedCallSite(stack, "external");
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
  callSite?: string;
  holder?: FileLockHolder;
  stateWait?: BlockingWaitSample["stateWait"];
}): void {
  if (!Number.isFinite(input.durationMs) || (input.durationMs <= 0 && !input.refused)) return;
  const deferred = input.stateWait?.outcome === "deferred";
  const context = input.correlation ?? currentWaitCorrelation();
  const resolvedCallSite = input.callSite
    ? input.callSite.slice(0, 1_024)
    : (input.site === "registry-lock" || input.site === "registry-revision-retry" || input.site === "registry-lock-async") && input.durationMs >= BLOCKING_WAIT_LOG_MS
      ? registryWaitCallSite(new Error().stack)
      : input.site === "file-transaction" && input.durationMs >= 50
        ? fileTransactionCallSite(new Error().stack)
        : undefined;
  const sample: BlockingWaitSample = {
    site: input.site,
    ...(resolvedCallSite ? { callSite: resolvedCallSite } : {}),
    ...(input.holder ? {
      holder: {
        kind: normalizeBlockingWaitHolderKind(input.holder.kind, "other-process"),
        ageMs: round(input.holder.ageMs),
        sameProcess: Boolean(input.holder.sameProcess),
      },
    } : {}),
    ...(input.stateWait ? { stateWait: input.stateWait } : {}),
    role: input.site === "file-transaction"
      ? normalizeBlockingWaitHolderKind(blockingWaitRole(), "unowned")
      : blockingWaitRole(),
    durationMs: round(input.durationMs),
    synchronous: input.synchronous,
    subject: input.subject ? input.subject.slice(0, 80) : null,
    label: input.site === "file-transaction"
      ? (context?.label ? sanitizeFileTransactionWaitLabel(context.label, "file-transaction") : null)
      : (context?.label ? context.label.slice(0, 80) : null),
    operationId: input.site === "file-transaction"
      ? sanitizeFileTransactionOperationId(context?.operationId)
      : (context?.operationId ? context.operationId.slice(0, 120) : null),
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
  const longest = [...samples]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, LONGEST_LIMIT)
    .map((sample) => ({
      ...sample,
      ...(sample.holder ? { holder: { ...sample.holder } } : {}),
      ...(sample.stateWait ? {
        stateWait: {
          ...sample.stateWait,
          ...(sample.stateWait.holder ? { holder: { ...sample.stateWait.holder } } : {}),
        },
      } : {}),
    }));
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
