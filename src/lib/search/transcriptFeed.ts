import {
  indexTranscriptSources,
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

interface TranscriptFeedState {
  generation?: number;
  pending?: ScheduledFeed;
  active?: Promise<void>;
  scheduled: boolean;
  idleWaiters: Array<() => void>;
}

const host = globalThis as typeof globalThis & {
  __llvTranscriptFeed?: TranscriptFeedState;
};

function state(): TranscriptFeedState {
  return host.__llvTranscriptFeed ??= { scheduled: false, idleWaiters: [] };
}

async function productionRun(
  sources: readonly TranscriptIndexSource[],
  complete: boolean,
  listedAt: number,
): Promise<void> {
  const generation = state().generation;
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
  current.generation = (current.generation ?? 0) + 1;
  current.pending = { feed: { ...feed, listedAt: feed.listedAt ?? Date.now() }, run: options.run ?? productionRun };
  if (current.active || current.scheduled) return;
  current.scheduled = true;
  setImmediate(() => start(current));
}

/** Test-only observation seam for focused fixture runs. */
export function waitForTranscriptIndexIdleForTests(): Promise<void> {
  const current = state();
  if (!current.scheduled && !current.active && !current.pending) return Promise.resolve();
  return new Promise((resolve) => current.idleWaiters.push(resolve));
}
