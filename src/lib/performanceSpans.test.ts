import { expect, test } from "bun:test";
import { createPerformanceSpans } from "./performanceSpans";
import { startLoopWatchdog } from "./loopWatchdog";
import { createLoopLogSink } from "./viewerLoopMonitor";

test("completed sync slices survive and pending awaits have a separate duration", async () => {
  let at = 0;
  const recorder = createPerformanceSpans(() => at);
  let release!: () => void;
  const pending = recorder.wait("files.worker", () => new Promise<void>(resolve => { release = resolve; }));
  recorder.sync("registry.snapshot", () => { at += 1400; });
  const whileWaiting = recorder.snapshot();
  expect(whileWaiting.pending).toBe(1);
  expect(whileWaiting.records).toHaveLength(1);
  expect(whileWaiting.records[0]).toMatchObject({ kind: "sync", start: 0, end: 1400 });
  at += 500; release(); await pending;
  expect(recorder.snapshot().records[1]).toMatchObject({ kind: "await", totalMs: 1900 });
  expect(recorder.snapshot().pending).toBe(0);
});

test("overflow is counted and the longest synchronous blocker survives rotation", () => {
  let at = 0;
  const recorder = createPerformanceSpans(() => at);
  recorder.sync("registry.snapshot", () => { at += 17000; });
  for (let i = 0; i < 4000; i++) recorder.sync("state.json", () => { at += 2; });
  const result = recorder.snapshot();
  expect(result.records.length).toBeLessThanOrEqual(1040);
  expect(result.dropped).toBeGreaterThan(0);
  expect(result.records.some(row => row.totalMs === 17000)).toBe(true);
  recorder.clear();
  expect(recorder.snapshot()).toEqual({ records: [], pending: 0, dropped: 0, droppedMs: 0 });
});

test("errors and correlation metadata retain no arbitrary request content", async () => {
  const recorder = createPerformanceSpans();
  expect(() => recorder.sync("state.json", () => { throw Error("private payload"); })).toThrow();
  await expect(recorder.wait("runtime.handler", async () => { throw Error("private payload"); })).rejects.toThrow();
  recorder.event("rpc.receive", "private payload");
  recorder.event("rpc.send", "00000000-0000-0000-0000-000000000000", 42);
  const snapshot = recorder.snapshot();
  expect(snapshot.records.filter(row => row.failed)).toHaveLength(2);
  expect(JSON.stringify(snapshot)).not.toContain("private payload");
  expect(snapshot.records.at(-1)?.correlation).toBe("00000000-0000-0000-0000-000000000000");
});

test("independent watchdog samples while the main thread is synchronously asleep", async () => {
  if (process.platform !== "linux") return;
  const watcher = startLoopWatchdog();
  try {
    const deadline = performance.now() + 10_000;
    while (!watcher.snapshot().available && performance.now() < deadline) await Bun.sleep(20);
    expect(watcher.snapshot().available).toBe(true);
    const before = watcher.snapshot().samples.length;
    watcher.site(7);
    Bun.sleepSync(650);
    const during = watcher.snapshot();
    expect(during.samples.length).toBeGreaterThan(before + 1);
    expect(during.samples.at(-1)?.site).toBe(7);
    expect(during.samples.at(-1)!.runNs).toBeGreaterThanOrEqual(0);
  } finally { await watcher.stop(); }
}, 15_000);

test("journal backpressure bounds queued logs and counts discarded evidence", async () => {
  const written: string[] = [];
  const releases: Array<() => void> = [];
  const sink = createLoopLogSink((line, done) => { written.push(line); releases.push(done); });
  sink.enqueue("first");
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let i = 0; i < 100; i++) sink.enqueue(`next-${i}`);
  expect(written).toEqual(["first"]);
  expect(sink.dropped()).toBe(98);
  for (let i = 0; i < 3; i++) {
    releases.shift()?.();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(written).toEqual(["first", "next-0", "next-1"]);
  sink.enqueue("x".repeat(65 * 1024));
  expect(sink.dropped()).toBe(99);
});

test("request retention is bounded and exposes overflow without retaining arguments", () => {
  const recorder = createPerformanceSpans();
  for (let i = 0; i < 2000; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    recorder.request(id, "arbitrary-private-method", 1000);
    recorder.event("rpc.dispatch", id);
    recorder.event("rpc.deadline", id, 0, true);
  }
  const requests = recorder.requests();
  expect(requests.records).toHaveLength(16);
  expect(requests.omitted).toBe(240);
  expect(requests.dropped).toBe(1744);
  expect(JSON.stringify(requests)).not.toContain("arbitrary-private-method");
  expect(requests.records.every(row => row.events.at(-1)?.failed)).toBe(true);
});

test("unwrapped CPU work remains an unknown site while the watchdog observes running time", async () => {
  if (process.platform !== "linux") return;
  const watcher = startLoopWatchdog();
  try {
    const readyDeadline = performance.now() + 10_000;
    while (!watcher.snapshot().available && performance.now() < readyDeadline) await Bun.sleep(20);
    const before = watcher.snapshot().samples.at(-1)!;
    expect(before).toBeDefined();
    const end = performance.now() + 650;
    while (performance.now() < end) { /* Deliberately outside any JS span. */ }
    const after = watcher.snapshot().samples.at(-1)!;
    expect(after.sequence).toBeGreaterThan(before.sequence);
    expect(after.site).toBe(-1);
    expect(after.runNs).toBeGreaterThan(before.runNs);
  } finally { await watcher.stop(); }
}, 15_000);
