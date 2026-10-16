import { PerformanceObserver } from "node:perf_hooks";

export const LOOP_HEAP_DETAIL_THRESHOLD_MS = 1000;
export const LOOP_HEAP_SAMPLE_INTERVAL_MS = 250;
const gcCapacity = 128;
type GcEntry = { startTime: number; duration: number };
type GcSubscription = { takeRecords(): readonly GcEntry[]; disconnect(): void };
export type GcSubscriber = (record: (entries: readonly GcEntry[]) => void) => {
  observer?: GcSubscription; unavailable?: string;
};

const observeGc: GcSubscriber = record => {
  if (!PerformanceObserver.supportedEntryTypes.includes("gc")) return { unavailable: "gc-entry-unsupported" };
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver(list => record(list.getEntries()));
    observer.observe({ entryTypes: ["gc"] });
    return { observer };
  } catch {
    observer?.disconnect();
    return { unavailable: "gc-observer-refused" };
  }
};

/** Two scalar heap readings are a proxy only. On Bun heapUsed describes the
 * last collection's survivors (block capacity before the first GC), including
 * their external storage. It misses
 * allocations since that collection and simultaneous allocation/reclamation.
 * Neither heapStats/heapSize (heap walks) nor forced GC belongs in the poll. Heap reads run at 250 ms cadence, with a fresh read on a gap. */
export function createLoopHeapSignals(readHeap = () => process.memoryUsage().heapUsed, subscribe: GcSubscriber = observeGc, now = () => performance.now()) {
  const read = () => {
    try { const value = readHeap(); return Number.isFinite(value) && value >= 0 ? value : null; }
    catch { return null; }
  };
  let previous = read(), sampledAt = now();
  let subscription: ReturnType<GcSubscriber> | undefined;
  let entries: GcEntry[] = [];
  let dropped = 0, generation = 0;
  const record = (batch: readonly GcEntry[]) => {
    for (const entry of batch) {
      if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 0) continue;
      if (entries.length === gcCapacity) { entries.shift(); dropped++; }
      // Retain only numeric timing, never runtime entry objects or metadata.
      entries.push({ startTime: entry.startTime, duration: entry.duration });
    }
  };
  return {
    start() {
      subscription?.observer?.disconnect();
      previous = read(); sampledAt = now(); entries = []; dropped = 0;
      const epoch = ++generation;
      subscription = subscribe(batch => { if (epoch === generation) record(batch); });
    },
    sample(from: number, to: number, gapMs: number) {
      const before = previous, beforeAt = sampledAt;
      if (gapMs > 500 || to - sampledAt >= LOOP_HEAP_SAMPLE_INTERVAL_MS) {
        previous = read(); sampledAt = to;
      }
      const current = previous;
      const observer = subscription?.observer;
      if (observer) record(observer.takeRecords());
      let count = 0, ms = 0, late = 0, coveredUntil = from;
      if (entries.length > 1) entries.sort((a, b) => a.startTime - b.startTime);
      for (const entry of entries) {
        const end = entry.startTime + entry.duration;
        if (end <= from) { late++; continue; }
        if (entry.startTime >= to) continue;
        count++;
        const clippedEnd = Math.min(to, end);
        ms += Math.max(0, clippedEnd - Math.max(coveredUntil, from, entry.startTime));
        coveredUntil = Math.max(coveredUntil, clippedEnd);
      }
      if (entries.length) entries = entries.filter(entry => entry.startTime + entry.duration > to);
      const lost = dropped; dropped = 0;
      // Ordinary polls advance scalars without allocating a diagnostic object.
      if (gapMs <= 500) return;
      return {
        gc: observer
          ? { source: "performance-observer", coverage: "observed-entries", count, ms, dropped: lost, late }
          : { source: "unavailable", count: null, ms: null, reason: subscription?.unavailable ?? "monitor-not-started" },
        heap: {
          source: "process.memoryUsage.heapUsed", sampleFrom: beforeAt, sampleTo: sampledAt,
          deltaBytes: before === null || current === null ? null : current - before,
          allocatedBytes: null, freedBytes: null,
          allocationUnavailable: "no-cheap-cumulative-counters",
          ...(before === null || current === null ? { unavailable: "heap-read-failed" } : {}),
          ...(gapMs > LOOP_HEAP_DETAIL_THRESHOLD_MS ? { beforeBytes: before, afterBytes: current } : {}),
        },
      };
    },
    stop() { generation++; subscription?.observer?.disconnect(); subscription = undefined; entries = []; dropped = 0; previous = null; },
  };
}
