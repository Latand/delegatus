import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createPerformanceSpans, type RegistryReadCaller } from "./performanceSpans";
import { requestWorkload } from "./requestWorkload";
import { startLoopWatchdog } from "./loopWatchdog";
import { createLoopLogSink, createViewerLoopMonitor } from "./viewerLoopMonitor";

test("writer snapshot spans carry a numeric watchdog site and appear in loop-gap attribution", () => {
  let at = 0;
  const recorder = createPerformanceSpans(() => at);
  recorder.observeSite(site => { BigInt(site); });
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, recorder);
  recorder.sync("registry.writer-snapshot", () => { at += 900; });
  monitor.tick();
  expect(JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length)).attribution.slices[0].site).toBe("registry.writer-snapshot");
});

test.each([1, 80])("gap reports retain synchronous blockers among longer awaits (%i sync slices)", async (syncCount) => {
  let at = 0;
  const recorder = createPerformanceSpans(() => at);
  let release!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  const waits = Array.from({ length: 80 }, () => recorder.wait("runtime.handler", () => latch));
  at = 600;
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, recorder);
  recorder.sync("registry.snapshot", () => { at += 1100; });
  for (let i = 1; i < syncCount; i++) recorder.sync("state.json", () => { at += 2; });
  release();
  await Promise.all(waits);
  const recorded = recorder.snapshot();
  expect(recorded.records.filter(row => row.kind === "await" && row.maxMs > 1100)).toHaveLength(80);

  monitor.tick();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("[viewer loop-gap] ");
  const report = JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length));
  expect(report.operations).toEqual([]);
  expect(report.gapMs).toBe(1090 + (syncCount - 1) * 2);
  expect(report.attribution.slices).toHaveLength(64);
  expect(report.attribution.slices[0]).toMatchObject({
    kind: "sync", site: "registry.snapshot", start: 600, end: 1700,
    totalMs: 1100, maxMs: 1100, overlapMs: 1100,
  });
  expect(report.attribution.slices.filter((row: { kind: string }) => row.kind === "sync")).toHaveLength(Math.min(syncCount, 64));
  expect(report.attribution.omitted).toBe(80 + syncCount - 64);
  expect(report.attribution.pending).toBe(0);
  expect(report.attribution.dropped).toBe(0);
  expect(report.attribution.droppedMs).toBe(0);
  expect(recorder.snapshot().records).toEqual([]);
});

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

const requestId = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;

test("request retention is bounded and exposes overflow without retaining arguments", () => {
  const recorder = createPerformanceSpans(() => 0);
  for (let i = 0; i < 2000; i++) {
    const id = requestId(i);
    recorder.request(id, "arbitrary-private-method", 1000);
    recorder.event("rpc.dispatch", id);
    recorder.event("rpc.deadline", id, 0, true);
  }
  const requests = recorder.requests();
  expect(requests.records).toHaveLength(16);
  expect(requests.omitted).toBe(240);
  expect(requests).toMatchObject({ dropped: 1744, droppedExpired: 0, droppedOverflow: 1744 });
  expect(JSON.stringify(requests)).not.toContain("arbitrary-private-method");
  expect(requests.records.every(row => row.events.at(-1)?.failed)).toBe(true);
});

test("request expiry and event overflow are counted separately and reset on clear", () => {
  let at = 0;
  const recorder = createPerformanceSpans(() => at);
  const expired = requestId(1);
  const retained = requestId(2);
  recorder.request(expired, "snapshot");
  at = 1;
  recorder.request(retained, "snapshot");
  for (let i = 0; i < 17; i++) recorder.event("rpc.receive", retained, i);

  at = 60_000;
  const atCutoff = recorder.requests();
  expect(atCutoff).toMatchObject({ dropped: 1, droppedExpired: 0, droppedOverflow: 1, omitted: 0 });
  expect(atCutoff.records.map(row => row.id)).toEqual([expired, retained]);
  expect(atCutoff.records[1]!.events.map(event => event.bytes)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));

  at++;
  const afterExpiry = recorder.requests();
  expect(afterExpiry).toMatchObject({ dropped: 2, droppedExpired: 1, droppedOverflow: 1, omitted: 0 });
  expect(afterExpiry.records.map(row => row.id)).toEqual([retained]);
  expect(recorder.requests().droppedExpired).toBe(1);

  recorder.clear();
  expect(recorder.requests()).toEqual({ dropped: 0, droppedExpired: 0, droppedOverflow: 0, omitted: 0, records: afterExpiry.records });
  at++;
  expect(recorder.requests()).toEqual({ dropped: 1, droppedExpired: 1, droppedOverflow: 0, omitted: 0, records: [] });
});

test("request drop counters start at zero in each recorder process", () => {
  const script = `
    import { performanceSpans } from "./performanceSpans.ts";
    const counts = () => {
      const { dropped, droppedExpired, droppedOverflow } = performanceSpans.requests();
      return [dropped, droppedExpired, droppedOverflow];
    };
    const before = counts();
    const id = ${JSON.stringify(requestId(1))};
    performanceSpans.request(id, "snapshot");
    for (let i = 0; i < 17; i++) performanceSpans.event("rpc.receive", id);
    console.log(JSON.stringify([before, counts()]));
  `;
  for (let i = 0; i < 2; i++) {
    const child = spawnSync(process.execPath, ["-e", script], { cwd: import.meta.dir, encoding: "utf8", timeout: 5_000 });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([[0, 0, 0], [1, 0, 1]]);
  }
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

test("gap attribution keeps different background callers separate and samples slow unscoped reads within budget", () => {
  let at = 0, captures = 0, watchdogSite = -1;
  const recorder = createPerformanceSpans(() => at);
  recorder.observeSite(site => { watchdogSite = site; });
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, recorder);
  const stack = () => {
    captures++;
    expect(watchdogSite).toBe(-1);
    at += 0.5; // Observer time must stay outside the recorded read.
    const frames = [21, 22, 23, 24, 25, 26].map(line => `    at private-input (${import.meta.path}:${line}:34)`);
    return ["Error: private-input", "    at private-input (/outside/private-input.js:9:9)", ...frames].join("\n");
  };
  function read(work: () => void, operation?: RegistryReadCaller["operation"], capture = stack) {
    const caller: RegistryReadCaller = { operation };
    try { recorder.sync("registry.keyed", work, 0, 0, caller); }
    finally { caller.sample?.(capture); }
  }
  const fast = () => { at += 0.25; };
  read(fast, "agents.reconcile");
  read(fast, "seat.panel");
  read(fast, "seat.panel");
  read(() => { at += 3; }, "agents.reconcile");
  requestWorkload.withRoute("/api/files?query=private-input", () => read(() => { at += 3; }, "seat.panel"));
  expect(captures).toBe(0);

  for (let i = 0; i < 10; i++) read(() => { at += 3; });
  expect(captures).toBe(8);
  at += 1000;
  const original = new Error("read failed");
  expect(() => read(() => { at += 3; throw original; }, undefined, () => {
    throw new Error("sampling failed");
  })).toThrow(original);
  monitor.tick();
  const rows = JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length)).attribution.slices;
  expect(rows).toContainEqual(expect.objectContaining({ registryOperation: "agents.reconcile", count: 1, totalMs: 0.25 }));
  expect(rows).toContainEqual(expect.objectContaining({ registryOperation: "seat.panel", count: 2, totalMs: 0.5 }));
  const expectedChain = [21, 22, 23, 24].map(line => `src/lib/performanceSpans.test.ts:${line}:34`).join(" <- ");
  const sampled = rows.filter((row: { registryCallSite?: string }) => row.registryCallSite === expectedChain);
  expect(sampled).toHaveLength(8);
  expect(sampled.every((row: { totalMs: number }) => row.totalMs === 3)).toBe(true);
  expect(rows).toContainEqual(expect.objectContaining({ requestClass: "http:/api/files", totalMs: 3 }));
  expect(rows).toContainEqual(expect.objectContaining({ registryCallSite: "unresolved", failed: true, totalMs: 3 }));
  expect(JSON.stringify(rows)).not.toContain("private-input");
  expect(JSON.stringify(rows)).not.toContain(import.meta.dir);
});
