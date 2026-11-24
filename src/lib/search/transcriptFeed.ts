import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import {
  ensureTranscriptSearchSchemaReadyOffThread,
  indexTranscriptSources,
  type TranscriptIndexSource,
} from "./transcriptSearch";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";

const DEFAULT_MIGRATION_RETRY_BASE_MS = 1_500;
const MAX_MIGRATION_RETRY_MS = 30_000;

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

interface TranscriptFeedState {
  generation?: number;
  pending?: ScheduledFeed;
  active?: Promise<void>;
  scheduled: boolean;
  idleWaiters: Array<() => void>;
  migrationBackoffMs?: number;
  migrationRetryBaseMs?: number;
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
}

function scheduleMigrationRetry(
  current: TranscriptFeedState,
  generation: number | undefined,
  feed: TranscriptIndexFeed,
  reason: string,
): void {
  const baseMs = current.migrationRetryBaseMs ?? DEFAULT_MIGRATION_RETRY_BASE_MS;
  const delayMs = current.migrationBackoffMs && current.migrationBackoffMs >= baseMs
    ? Math.min(MAX_MIGRATION_RETRY_MS, current.migrationBackoffMs * 2)
    : baseMs;
  current.migrationBackoffMs = delayMs;
  const capturedDbPath = statePath("transcript-search.sqlite");
  console.error(
    `[transcript search] schema migration deferred (${reason}); keeping existing reads and retrying off-thread in ${delayMs}ms`,
  );
  clearMigrationRetryTimer(current);
  const timer = setTimeout(() => {
    const latest = state();
    if (latest.retryTimer === timer) delete latest.retryTimer;
    if (latest.generation !== generation) return;
    if (statePath("transcript-search.sqlite") !== capturedDbPath || !fs.existsSync(capturedDbPath)) return;
    scheduleTranscriptIndex(feed, { force: true });
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
    scheduleMigrationRetry(current, generation, { sources, complete, listedAt }, schema.reason);
    return;
  }
  current.migrationBackoffMs = 0;
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
  clearMigrationRetryTimer(current);
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
  current.migrationBackoffMs = 0;
  if (baseMs === null) delete current.migrationRetryBaseMs;
  else current.migrationRetryBaseMs = Math.max(10, Math.floor(baseMs));
}

/** Test-only observation seam for focused fixture runs. */
export function waitForTranscriptIndexIdleForTests(): Promise<void> {
  const current = state();
  if (!current.scheduled && !current.active && !current.pending) return Promise.resolve();
  return new Promise((resolve) => current.idleWaiters.push(resolve));
}
