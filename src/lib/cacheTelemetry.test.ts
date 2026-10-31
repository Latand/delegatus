import { expect, test } from "bun:test";
import { cacheSizes, MeasuredCache, MeasuredWeakCache } from "./cacheTelemetry";
import { gzipBody } from "./http/gzipBody";
import { globalCache } from "./scanner/caches";
import { BoardEncoder } from "./boardEncoding";
import { BoardHistory } from "./boardHistory";
import { McpPageCursorStore, MCP_CURSOR_MAX_ENTRIES, MCP_CURSOR_TTL_MS } from "./mcp/pageCursors";
import { createViewerLoopMonitor, LOOP_MEMORY_RETENTION } from "./viewerLoopMonitor";
import { createPerformanceSpans } from "./performanceSpans";

function size(owner: string, name: string) {
  const row = cacheSizes().caches.find(row => row.owner === owner && row.name === name);
  if (!row) throw new Error(`missing cache counter ${owner}:${name}`);
  return row;
}

test("real scanner cache mutations replace charges, account in-place refreshes, delete and clear", () => {
  const cache = globalCache<{ text: string; bytes: Uint8Array }>("telemetry-mutations");
  try {
    expect(size("scanner/caches", "telemetry-mutations")).toMatchObject({ count: 0, bytes: 0 });
    const value = { text: "a", bytes: new Uint8Array(10) };
    cache.set("one", value);
    const before = size("scanner/caches", "telemetry-mutations");
    expect(before.count).toBe(1);
    expect(before.bytes).toBeGreaterThanOrEqual(12);
    value.text += "longer";
    cache.set("one", value);
    expect(size("scanner/caches", "telemetry-mutations")).toMatchObject({ count: 1, bytes: before.bytes + 12 });
    expect(cache.delete("missing")).toBe(false);
    cache.set("two", value);
    expect(size("scanner/caches", "telemetry-mutations").count).toBe(2);
    expect(cache.delete("one")).toBe(true);
    expect(size("scanner/caches", "telemetry-mutations").count).toBe(1);
    cache.clear();
    expect(size("scanner/caches", "telemetry-mutations")).toMatchObject({ count: 0, bytes: 0 });
  } finally { cache.clear(); }
});

test("accounting refuses no cache write when a value cannot be measured", () => {
  const cache = new MeasuredCache<string, unknown>("refused-estimate", "telemetry-test");
  const value = new Proxy({}, { ownKeys() { throw new Error("unreadable graph"); } });
  try {
    cache.set("key", value);
    expect(cache.get("key")).toBe(value);
    expect(size("telemetry-test", "refused-estimate")).toMatchObject({ count: 1, bytes: 0, unmeasured: 1 });
    cache.set("key", "readable");
    expect(size("telemetry-test", "refused-estimate")).toMatchObject({ count: 1, unmeasured: 0 });
    cache.delete("key");
    expect(size("telemetry-test", "refused-estimate")).toMatchObject({ count: 0, bytes: 0, unmeasured: 0 });
  } finally { cache.clear(); }
});

test("weak compression counters follow completed buffers and explicit removal", async () => {
  const encoded = new BoardEncoder().encode("gzip", "epoch", { text: "payload" }, 1);
  const compressed = await gzipBody(encoded.body);
  const cache = new MeasuredWeakCache<object, Uint8Array>("gzip", "telemetry-test", value => value.byteLength);
  try {
    cache.set(encoded, compressed);
    expect(cache.get(encoded)).toBe(compressed);
    expect(size("telemetry-test", "gzip")).toMatchObject({ count: 1, bytes: compressed.byteLength });
    cache.set(encoded, new Uint8Array());
    expect(size("telemetry-test", "gzip")).toMatchObject({ count: 1, bytes: 0 });
    expect(cache.delete(encoded)).toBe(true);
    expect(cache.delete(encoded)).toBe(false);
    expect(size("telemetry-test", "gzip")).toMatchObject({ count: 0, bytes: 0 });
  } finally { cache.delete(encoded); }
});

test("default board owners report production encoded bytes through eviction and expiry", () => {
  const encoder = new BoardEncoder();
  const initial = size("boardEncoding", "bases");
  const bodies: number[] = [];
  // The default production builder owns normalization, encoding and its bound.
  for (let index = 0; index < 5; index++) {
    const encoded = encoder.encode(String(index), "epoch", { index }, index);
    bodies.push(Buffer.byteLength(encoded.body));
  }
  expect(size("boardEncoding", "bases")).toMatchObject({ count: initial.count + 4,
    bytes: initial.bytes + bodies.slice(1).reduce((sum, bytes) => sum + bytes, 0) });
  const last = encoder.encode("after-expiry", "epoch", {}, 120_010);
  expect(size("boardEncoding", "bases")).toMatchObject({ count: initial.count + 1, bytes: initial.bytes + Buffer.byteLength(last.body) });

  const history = new BoardHistory();
  const linksBefore = cacheSizes().caches.find(row => row.owner === "boardHistory" && row.name === "links")?.bytes ?? 0;
  const answersBefore = cacheSizes().caches.find(row => row.owner === "boardHistory" && row.name === "answers")?.bytes ?? 0;
  history.record("scope", "first", "second", last.body, 1);
  expect(size("boardHistory", "links").bytes).toBe(linksBefore + Buffer.byteLength(last.body));
  const answer = history.answer("scope", "first", "second", 100_000, 2).answer!;
  expect(size("boardHistory", "answers").bytes).toBe(answersBefore + answer.charged);
  history.forget("scope");
  expect(size("boardHistory", "links").bytes).toBe(linksBefore);
  expect(size("boardHistory", "answers").bytes).toBe(answersBefore);
});

test("production cursor bounds and expiry release their byte charges", () => {
  let now = 1;
  const store = new McpPageCursorStore({ now: () => now });
  const before = cacheSizes().caches.find(row => row.owner === "mcp/pageCursors") ?? { count: 0, bytes: 0 };
  const handles: string[] = [];
  for (let index = 0; index <= MCP_CURSOR_MAX_ENTRIES; index++) handles.push(store.issue("scope", String(index))!);
  expect(store.resolve(handles[0], "scope")).toBeNull();
  expect(size("mcp/pageCursors", "page-cursors").count).toBe(before.count + MCP_CURSOR_MAX_ENTRIES);
  now += MCP_CURSOR_TTL_MS;
  for (const handle of handles) expect(store.resolve(handle, "scope")).toBeNull();
  expect(size("mcp/pageCursors", "page-cursors")).toMatchObject(before);
});

test("monitor ticks and reads never enumerate the real cached store or its payloads", () => {
  let at = 0, reads = 0;
  const cache = globalCache<object>("telemetry-no-scan");
  const payload = new Proxy({ text: "large".repeat(100) }, { ownKeys(value) { reads++; return Reflect.ownKeys(value); } });
  for (let index = 0; index < 5000; index++) cache.set(String(index), payload);
  const afterMutations = reads;
  const iteration = () => { throw new Error("whole cache scanned by monitor"); };
  const values = cache.values, entries = cache.entries, iterator = cache[Symbol.iterator];
  cache.values = iteration; cache.entries = iteration; cache[Symbol.iterator] = iteration;
  const monitor = createViewerLoopMonitor(() => {}, () => at, createPerformanceSpans(() => at));
  try {
    for (let index = 0; index < 130; index++) { at += LOOP_MEMORY_RETENTION.intervalMs; monitor.tick(); }
    const sampled = monitor.memorySamples().samples.at(-1)!.caches.find(row => row.name === "telemetry-no-scan")!;
    expect(sampled.count).toBe(5000);
    expect(sampled.bytes).toBeGreaterThan(5_000_000);
    expect(reads).toBe(afterMutations);
  } finally {
    monitor.stop(); cache.values = values; cache.entries = entries; cache[Symbol.iterator] = iterator; cache.clear();
  }
});
