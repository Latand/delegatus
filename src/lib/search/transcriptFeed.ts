import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import {
  ensureTranscriptSearchSchemaReadyOffThread,
  indexTranscriptSources,
  setTranscriptSearchMigrationRetryBackoffForTests,
  type SearchSchemaReadyResult,
  type TranscriptIndexSource,
} from "./transcriptSearch";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";

export interface TranscriptIndexFeed {
  sources: readonly TranscriptIndexSource[];
  complete: boolean;
  /** When the scan that listed `sources` began; the time the feed arrived
      when the scanner did not say. */
  listedAt?: number;
}

type TranscriptIndexRun = (
  sources: readonly TranscriptIndexSource[],
  complete: boolean,
  listedAt: number,
) => Promise<void>;

interface ScheduledFeed {
  feed: TranscriptIndexFeed;
  run: TranscriptIndexRun;
}

interface DeferredMigrationRetry {
  dbPath: string;
  feed: TranscriptIndexFeed;
  nextAttemptAt: number;
}

interface TranscriptFeedState {
  generation?: number;
  pending?: ScheduledFeed;
  active?: Promise<void>;
  scheduled: boolean;
  idleWaiters: Array<() => void>;
  deferredRetry?: DeferredMigrationRetry;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const host = globalThis as typeof globalThis & {
  __llvTranscriptFeed?: TranscriptFeedState;
};

function state(): TranscriptFeedState {
  return host.__llvTranscriptFeed ??= { scheduled: false, idleWaiters: [] };
}

function clearMigrationRetryTimer(current: TranscriptFeedState): void {
  if (current.retryTimer !== undefined) {
    clearTimeout(current.retryTimer);
    delete current.retryTimer;
  }
  delete current.deferredRetry;
}

function scheduleMigrationRetry(
  current: TranscriptFeedState,
  feed: TranscriptIndexFeed,
  schema: Extract<SearchSchemaReadyResult, { ready: false }>,
): void {
  const capturedDbPath = statePath("transcript-search.sqlite");
  const existing = current.deferredRetry;
  // Always keep the latest feed queued for the single shared retry deadline.
  current.deferredRetry = { dbPath: capturedDbPath, feed, nextAttemptAt: schema.nextAttemptAt };
  if (!schema.throttled) {
    console.error(
      `[transcript search] schema migration deferred (${schema.reason}); keeping existing reads and retrying off-thread in ${schema.retryAfterMs}ms`,
    );
  }
  const timerAlreadyCoversDeadline = current.retryTimer !== undefined
    && existing?.dbPath === capturedDbPath
    && existing.nextAttemptAt === schema.nextAttemptAt;
  if (timerAlreadyCoversDeadline) return;
  if (current.retryTimer !== undefined) {
    clearTimeout(current.retryTimer);
    delete current.retryTimer;
  }
  // Small +5ms cushion guarantees `Date.now() >= nextAttemptAt` when the timer wakes.
  const delayMs = Math.max(5, schema.nextAttemptAt - Date.now() + 5);
  const timer = setTimeout(() => {
    const latest = state();
    if (latest.retryTimer === timer) delete latest.retryTimer;
    const deferred = latest.deferredRetry;
    if (!deferred) return;
    delete latest.deferredRetry;
    if (statePath("transcript-search.sqlite") !== deferred.dbPath || !fs.existsSync(deferred.dbPath)) return;
    scheduleTranscriptIndex(deferred.feed, { force: true });
  }, delayMs);
  timer.unref?.();
  current.retryTimer = timer;
}

async function productionRun(
  sources: readonly TranscriptIndexSource[],
  complete: boolean,
  listedAt: number,
): Promise<void> {
  const current = state();
  const generation = current.generation;
  const schema = await withViewerOperation("transcript.index", () =>
    performanceSpans.wait("transcript.index", () => ensureTranscriptSearchSchemaReadyOffThread()));
  if (!schema.ready) {
    scheduleMigrationRetry(current, { sources, complete, listedAt }, schema);
    return;
  }
  clearMigrationRetryTimer(current);
  const indexed = await withViewerOperation("transcript.index", () =>
    performanceSpans.wait("transcript.index", () => indexTranscriptSources(sources, { complete })));
  try {
    const { refreshMemoryIndex } = await import("@/lib/memory/service");
    await refreshMemoryIndex();
  } catch {
    console.error("[memory search] refresh failed; the next scan retries");
  }
  /* The activity record reads the same inventory right after (its own
     failures never fail the index). */
  try {
    const { recordActivityFromIndexFeed } = await import("@/lib/activity/continuous");
    await recordActivityFromIndexFeed(sources, complete, listedAt);
  } catch (error) {
    console.error(`[activity] recording failed: ${error instanceof Error ? error.message : String(error)}; the next pass retries`);
  }
  if (indexed.failures.length) {
    throw new Error(`${indexed.failures.length} transcript file(s) could not be indexed`);
  }
  if (complete) {
    const { maybeCollectStructuredUserMetadata } = await import("@/lib/selection/structuredUserMetadataRetention");
    const { scanRootEntries } = await import("@/lib/scanner/roots");
    const { codexSessionRootInventory } = await import("@/lib/accounts/codex");
    const { join, dirname } = await import("node:path");
    const retentionRoots = () => {
      const codexRoots = codexSessionRootInventory().roots;
      return [...scanRootEntries().map(([, root]) => root),
        ...codexRoots.map(root => join(dirname(root), "archived_sessions"))].sort();
    };
    const rootsAtCensus = retentionRoots();
    await maybeCollectStructuredUserMetadata({ sources, complete, listedAt }, {
      roots: rootsAtCensus,
      rootsComplete: () => codexSessionRootInventory().complete,
      rootsCurrent: () => JSON.stringify(retentionRoots()) === JSON.stringify(rootsAtCensus),
      current: () => state().generation === generation,
    });
  }
}

function settleIdle(current: TranscriptFeedState): void {
  if (current.scheduled || current.active || current.pending) return;
  for (const resolve of current.idleWaiters.splice(0)) resolve();
}

async function drain(current: TranscriptFeedState): Promise<void> {
  while (current.pending) {
    const scheduled = current.pending;
    delete current.pending;
    try {
      await scheduled.run(scheduled.feed.sources, scheduled.feed.complete, scheduled.feed.listedAt ?? Date.now());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[transcript search] background indexing failed: ${detail}; a later scan will retry`);
    }
  }
}

function start(current: TranscriptFeedState): void {
  current.scheduled = false;
  if (current.active) return;
  const active = drain(current);
  current.active = active;
  void active.finally(() => {
    if (current.active === active) delete current.active;
    if (current.pending && !current.scheduled) {
      current.scheduled = true;
      setImmediate(() => start(current));
    } else {
      settleIdle(current);
    }
  });
}

/**
 * Publishes the latest complete scanner inventory to the durable body index.
 * Scheduling is synchronous and performs no transcript or SQLite reads; the
 * first file is opened on a later event-loop turn.
 */
export function scheduleTranscriptIndex(
  feed: TranscriptIndexFeed,
  options: { force?: boolean; run?: TranscriptIndexRun } = {},
): void {
  if (process.env.NODE_ENV === "test" && !options.force) return;
  const current = state();
  if (options.run) clearMigrationRetryTimer(current);
  current.generation = (current.generation ?? 0) + 1;
  current.pending = { feed: { ...feed, listedAt: feed.listedAt ?? Date.now() }, run: options.run ?? productionRun };
  if (current.active || current.scheduled) return;
  current.scheduled = true;
  setImmediate(() => start(current));
}

/** Test-only seam to tune or reset off-thread migration retry backoff. */
export function setTranscriptMigrationRetryBackoffForTests(baseMs: number | null): void {
  const current = state();
  clearMigrationRetryTimer(current);
  setTranscriptSearchMigrationRetryBackoffForTests(baseMs);
}

/** Test-only observation seam for focused fixture runs. */
export function waitForTranscriptIndexIdleForTests(): Promise<void> {
  const current = state();
  if (!current.scheduled && !current.active && !current.pending) return Promise.resolve();
  return new Promise((resolve) => current.idleWaiters.push(resolve));
}
