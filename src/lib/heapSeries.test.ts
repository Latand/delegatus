import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHeapSeriesRecorder, createHeapSeriesStore, readHeapSeries, sampleHeapSeries, HEAP_SERIES_INTERVAL_MS, HEAP_SERIES_MAX_ROWS, HEAP_SERIES_RETENTION_MS, type HeapSeriesRow } from "./heapSeries";
import { heapStats } from "bun:jsc";

const row = (at: number): HeapSeriesRow => ({ id: String(at), at, pid: 123, uptimeSeconds: 60, censusAt: new Date(at).toISOString(),
  heapSize: 100, extraMemorySize: 20, rss: 300, heapCapacity: null, heapTotal: null, external: null, arrayBuffers: null,
  memoryBreakdown: null, censusMs: 2, gc: { mode: "none", durationMs: 0 }, types: { Subprocess: 3 }, attribution: { processes: { running: 1, exited: 2 } } });

test("historical samples expose null for measurements that were never recorded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heap-series-legacy-"));
  const filename = path.join(root, "state.sqlite");
  const store = createHeapSeriesStore(filename);
  const at = Date.UTC(2026, 0, 1);
  const prior = row(at);
  delete prior.heapCapacity; delete prior.heapTotal; delete prior.external; delete prior.arrayBuffers; delete prior.memoryBreakdown;
  try {
    store.append(prior);
    expect(readHeapSeries(filename, at).samples).toEqual([row(at)]);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("new series samples persist the RSS breakdown and stay cheap on real sources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heap-series-memory-"));
  const filename = path.join(root, "state.sqlite");
  const store = createHeapSeriesStore(filename);
  try {
    const memoryUsage = process.memoryUsage(), heap = heapStats();
    const at = Date.UTC(2026, 0, 1);
    const durations: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const sample = await sampleHeapSeries({ at: new Date(at).toISOString(), heap, memoryUsage,
        objectTypeCounts: heap.objectTypeCounts, blockedMs: 1, gc: { mode: "none", durationMs: 0 }, attribution: {} });
      durations.push(performance.now() - started);
      expect(sample).toMatchObject({ heapCapacity: heap.heapCapacity, heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external, arrayBuffers: memoryUsage.arrayBuffers });
      expect(sample.memoryBreakdown).toMatchObject({ sqlite: { memoryUsedBytes: null, unavailableWorkers: 0 } });
      expect(sample.memoryBreakdown?.sqlite?.openConnections).toBeGreaterThan(0);
      expect(sample.memoryBreakdown?.memorySampleMs).toBeGreaterThanOrEqual(0);
      if (process.platform === "linux") {
        expect(sample.memoryBreakdown?.procStatus?.rssAnonBytes).toBeGreaterThan(0);
        expect(sample.memoryBreakdown?.smapsRollup?.anonymousBytes).toBeGreaterThan(0);
      }
      // Fixed storage identities keep the round trip independent of the clock.
      const stored = { ...sample, id: String(i), at: at + i };
      store.append(stored);
      expect(readHeapSeries(filename, at).samples.at(-1)).toEqual(stored);
    }
    console.info("heap series memory sample elapsed ms:", durations.map(ms => ms.toFixed(2)).join(", "));
    expect(Math.max(...durations)).toBeLessThan(1000);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("history survives reopening, expires rows and caps count even on frequent restarts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heap-series-"));
  const filename = path.join(root, "state.sqlite");
  const now = Date.now();
  let store = createHeapSeriesStore(filename);
  try {
    store.append(row(now - HEAP_SERIES_RETENTION_MS));
    for (let i = 0; i <= HEAP_SERIES_MAX_ROWS; i++) store.append(row(now + i));
    expect(readHeapSeries(filename, now).samples).toHaveLength(HEAP_SERIES_MAX_ROWS);
    expect(readHeapSeries(filename, now).samples[0]!.at).toBe(now + 1);
    store.close(); store = createHeapSeriesStore(filename);
    const samples = readHeapSeries(filename, now).samples;
    expect(samples.at(-1)).toEqual(row(now + HEAP_SERIES_MAX_ROWS));
    samples[0]!.heapSize = 0;
    expect(readHeapSeries(filename, now).samples[0]!.heapSize).toBe(100);
    store.append(row(now + HEAP_SERIES_RETENTION_MS + HEAP_SERIES_MAX_ROWS));
    expect(readHeapSeries(filename, now + HEAP_SERIES_RETENTION_MS + HEAP_SERIES_MAX_ROWS).samples).toHaveLength(1);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a read of absent history creates no database; oversized samples are refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heap-series-empty-"));
  const filename = path.join(root, "state.sqlite");
  expect(readHeapSeries(filename).samples).toEqual([]);
  expect(fs.existsSync(filename)).toBe(false);
  const store = createHeapSeriesStore(filename);
  try {
    expect(() => store.append({ ...row(Date.now()), attribution: "x".repeat(65_536) })).toThrow("budget");
    expect(readHeapSeries(filename).samples).toEqual([]);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("the autonomous recorder samples every ten minutes, retries errors and checks ownership after awaiting", async () => {
  const callbacks: (() => void)[] = [];
  const rows: HeapSeriesRow[] = [];
  let current = true, fail = true;
  const recorder = createHeapSeriesRecorder({
    schedule: (work, ms) => { expect(ms).toBe(HEAP_SERIES_INTERVAL_MS); callbacks.push(work); return {}; }, cancel: () => {},
    current: () => current,
    sample: async () => { if (fail) throw new Error("busy"); return row(Date.now()); }, append: value => rows.push(value),
  });
  const tick = async () => { callbacks.shift()!(); await Bun.sleep(1); };
  await tick(); expect(recorder.failures).toBe(1);
  fail = false;
  await tick(); expect(rows).toHaveLength(1);
  current = false;
  await tick(); expect(rows).toHaveLength(1);
  recorder.stop();
});

test("a release demoted during a sample writes nothing and stopping cancels the timer", async () => {
  const sample = Promise.withResolvers<HeapSeriesRow>();
  let tick: (() => void) | undefined, current = true, writes = 0, cancelled = false;
  const recorder = createHeapSeriesRecorder({
    current: () => current, sample: () => sample.promise, append: () => { writes++; },
    schedule: work => { tick = work; return {}; }, cancel: () => { cancelled = true; },
  });
  tick!();
  current = false;
  sample.resolve(row(Date.now()));
  await Bun.sleep(1);
  expect(writes).toBe(0);
  recorder.stop();
  expect(cancelled).toBe(true);
});
