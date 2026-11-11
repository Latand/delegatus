import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createHeapDiagnostics, HEAP_SNAPSHOT_INTERVAL_MS, HEAP_SNAPSHOT_MAX_FILE_BYTES, HEAP_SNAPSHOT_FILE_BYTES_PER_OBJECT,
  HEAP_SNAPSHOT_MIN_FREE_DISK_BYTES, HEAP_STATS_CACHE_MS, servingHeapDiagnostics, type HeapDiagnosticsDeps,
} from "./heapDiagnostics";

const GIB = 1024 ** 3;
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "heap-diagnostics-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fixture(overrides: Partial<HeapDiagnosticsDeps> & { objectCount?: number } = {}) {
  const calls = { heapStats: 0, generate: 0 };
  const clock = { now: Date.now() };
  const directory = path.join(root, "heap-snapshots");
  const deps: HeapDiagnosticsDeps = {
    heapStats: () => {
      calls.heapStats++;
      return { heapSize: 1000, heapCapacity: 2000, extraMemorySize: 300, objectCount: overrides.objectCount ?? 3,
        protectedObjectCount: 1, globalObjectCount: 1, protectedGlobalObjectCount: 1,
        objectTypeCounts: { Object: 1, string: 7, Array: 2 }, protectedObjectTypeCounts: { Timeout: 1 } };
    },
    memoryUsage: () => ({ rss: 5000, heapUsed: 1000, heapTotal: 2000, external: 300, arrayBuffers: 10 }),
    generateSnapshot: () => { calls.generate++; return new TextEncoder().encode(`{"snapshot":${calls.generate}}`); },
    directory: () => directory,
    freeDiskBytes: () => 100 * GIB,
    availableMemoryBytes: () => 64 * GIB,
    now: () => clock.now,
    monotonicMs: () => 0,
    ...overrides,
  };
  const state = { stats: null, snapshotRunning: false, lastSnapshotAttemptAt: null };
  return { diagnostics: createHeapDiagnostics(deps, state), calls, clock, directory };
}
const files = (directory: string) => fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];

test("cheap mode returns the census and memory counters and writes no file", () => {
  const { diagnostics, calls, directory } = fixture();
  const answer = diagnostics.stats();
  expect(answer.status).toBe(200);
  expect(answer.body.heap).toMatchObject({ heapSize: 1000, extraMemorySize: 300, objectCount: 3 });
  expect(answer.body.memoryUsage).toEqual({ rss: 5000, heapUsed: 1000, heapTotal: 2000, external: 300, arrayBuffers: 10 });
  expect(Object.entries(answer.body.objectTypeCounts as object)).toEqual([["string", 7], ["Array", 2], ["Object", 1]]);
  expect(answer.body.protectedObjectTypeCounts).toEqual({ Timeout: 1 });
  expect(calls.generate).toBe(0);
  expect(fs.existsSync(directory)).toBe(false);
});

test("cheap mode walks the heap at most once per cache window", () => {
  const { diagnostics, calls, clock } = fixture();
  expect(diagnostics.stats().body.cached).toBe(false);
  clock.now += HEAP_STATS_CACHE_MS - 1;
  expect(diagnostics.stats().body).toMatchObject({ cached: true, ageMs: HEAP_STATS_CACHE_MS - 1 });
  expect(calls.heapStats).toBe(1);
  clock.now += 1;
  expect(diagnostics.stats().body.cached).toBe(false);
  expect(calls.heapStats).toBe(2);
});

test("snapshot mode writes one owner-only file under the given directory and answers its path and size", async () => {
  const { diagnostics, directory } = fixture();
  const answer = await diagnostics.snapshot();
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ written: true, format: "v8-heapsnapshot" });
  const file = answer.body.path as string;
  expect(path.dirname(file)).toBe(directory);
  expect(fs.readFileSync(file, "utf8")).toBe('{"snapshot":1}');
  expect(answer.body.bytes).toBe(fs.statSync(file).size);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  expect(JSON.stringify(answer.body)).not.toContain('{\\"snapshot\\"');
});

test("a second snapshot inside the hour is refused, including after a restart that lost the in-memory attempt", async () => {
  const first = fixture();
  expect((await first.diagnostics.snapshot()).status).toBe(200);
  first.clock.now += HEAP_SNAPSHOT_INTERVAL_MS - 1000;
  const again = await first.diagnostics.snapshot();
  expect(again.status).toBe(429);
  expect(again.body).toMatchObject({ written: false, refusal: "rate_limited" });
  // The file's own time may trail the attempt by the write's duration.
  expect(again.body.retryAfterMs).toBeGreaterThanOrEqual(1000);
  expect(again.body.retryAfterMs).toBeLessThan(2000);
  expect(first.calls.generate).toBe(1);

  // A fresh process sees only the file the previous one left.
  const stored = path.join(first.directory, files(first.directory)[0]!);
  const restarted = fixture();
  fs.utimesSync(stored, new Date(restarted.clock.now - 60_000), new Date(restarted.clock.now - 60_000));
  const refused = await restarted.diagnostics.snapshot();
  expect(refused.status).toBe(429);
  expect(restarted.calls.generate).toBe(0);
});

test("after the hour a new snapshot replaces the older one, so one file stays", async () => {
  const { diagnostics, clock, directory } = fixture();
  const first = await diagnostics.snapshot();
  fs.utimesSync(first.body.path as string, new Date(clock.now), new Date(clock.now));
  fs.writeFileSync(path.join(directory, "notes.txt"), "kept");
  clock.now += HEAP_SNAPSHOT_INTERVAL_MS;
  const second = await diagnostics.snapshot();
  expect(second.status).toBe(200);
  expect(second.body.removedOlder).toBe(1);
  expect(files(directory)).toEqual([path.basename(second.body.path as string), "notes.txt"].sort());
  expect(fs.readFileSync(second.body.path as string, "utf8")).toBe('{"snapshot":2}');
});

test("low free disk refuses before the heap is serialized", async () => {
  const { diagnostics, calls, directory } = fixture({ freeDiskBytes: () => HEAP_SNAPSHOT_MIN_FREE_DISK_BYTES - 1 });
  const answer = await diagnostics.snapshot();
  expect(answer.status).toBe(507);
  expect(answer.body).toMatchObject({ written: false, refusal: "insufficient_disk", requiredDiskBytes: HEAP_SNAPSHOT_MIN_FREE_DISK_BYTES });
  expect(calls.generate).toBe(0);
  expect(files(directory)).toEqual([]);
  const unknown = fixture({ freeDiskBytes: () => null });
  expect((await unknown.diagnostics.snapshot()).body.refusal).toBe("insufficient_disk");
});

test("a snapshot file dated in the future holds the hour and no longer", async () => {
  const { diagnostics, clock, directory } = fixture();
  fs.mkdirSync(directory, { recursive: true });
  const ahead = path.join(directory, "heap-20990101T000000Z-1.heapsnapshot");
  fs.writeFileSync(ahead, "{}");
  fs.utimesSync(ahead, new Date(clock.now + 10 * HEAP_SNAPSHOT_INTERVAL_MS), new Date(clock.now + 10 * HEAP_SNAPSHOT_INTERVAL_MS));
  expect((await diagnostics.snapshot()).body).toMatchObject({ refusal: "rate_limited", retryAfterMs: HEAP_SNAPSHOT_INTERVAL_MS });
});

test("a heap too large to serialize in one buffer is refused", async () => {
  const objectCount = Math.floor(HEAP_SNAPSHOT_MAX_FILE_BYTES / HEAP_SNAPSHOT_FILE_BYTES_PER_OBJECT) + 1;
  const { diagnostics, calls } = fixture({ objectCount });
  const answer = await diagnostics.snapshot();
  expect(answer.status).toBe(413);
  expect(answer.body).toMatchObject({ written: false, refusal: "too_large" });
  expect(calls.generate).toBe(0);
});

test("too little available memory for the serialization peak is refused", async () => {
  const { diagnostics, calls } = fixture({ objectCount: 10_000_000, availableMemoryBytes: () => 5 * GIB });
  const answer = await diagnostics.snapshot();
  expect(answer.status).toBe(507);
  expect(answer.body).toMatchObject({ refusal: "insufficient_memory", requiredMemoryBytes: 6_000_000_000 });
  expect(calls.generate).toBe(0);
});

test("a failed serialization leaves no file and still spends the hour", async () => {
  const { diagnostics, directory } = fixture({ generateSnapshot: () => { throw new Error("out of memory"); } });
  const answer = await diagnostics.snapshot();
  expect(answer.status).toBe(500);
  expect(answer.body).toMatchObject({ written: false, refusal: "failed", stage: "generate" });
  expect(files(directory)).toEqual([]);
  expect((await diagnostics.snapshot()).status).toBe(429);
});

test("the serving runtime produces a snapshot the V8 format readers accept", async () => {
  const serving = await servingHeapDiagnostics();
  expect(serving).not.toBeNull();
  const stats = serving!.stats();
  expect((stats.body.heap as { objectCount: number }).objectCount).toBeGreaterThan(0);
  expect(Object.keys(stats.body.objectTypeCounts as object).length).toBeGreaterThan(0);
  const bytes = (globalThis as unknown as { Bun: { generateHeapSnapshot(format: "v8", encoding: "arraybuffer"): ArrayBuffer } }).Bun.generateHeapSnapshot("v8", "arraybuffer");
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { snapshot: { node_count: number; meta: { node_fields: string[] } }; nodes: number[] };
  expect(parsed.nodes.length).toBe(parsed.snapshot.node_count * parsed.snapshot.meta.node_fields.length);
});
