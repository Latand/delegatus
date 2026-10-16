import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createLoopHeapSignals as createSignals, type GcSubscriber } from "./loopHeapSignals";

const createLoopHeapSignals = (read?: () => number, subscribe?: GcSubscriber) => createSignals(read, subscribe, () => 0);

const unsupported: GcSubscriber = () => ({ unavailable: "gc-entry-unsupported" });

test("heap proxy preserves growth, shrinkage and zero without inventing allocation or GC totals", () => {
  let heap = 4000;
  const signals = createLoopHeapSignals(() => heap, unsupported);
  signals.start();
  heap = 9000;
  const growth = signals.sample(0, 800, 790)!;
  expect(growth.gc).toEqual({ source: "unavailable", count: null, ms: null, reason: "gc-entry-unsupported" });
  expect(growth.heap).toEqual({ source: "process.memoryUsage.heapUsed", sampleFrom: 0, sampleTo: 800, deltaBytes: 5000,
    allocatedBytes: null, freedBytes: null, allocationUnavailable: "no-cheap-cumulative-counters" });
  heap = 1000;
  expect(signals.sample(800, 1600, 790)!.heap.deltaBytes).toBe(-8000);
  expect(signals.sample(1600, 2400, 790)!.heap.deltaBytes).toBe(0);
  signals.stop();
});

test.each([1000, 1001])("heap endpoints require a gap strictly above one second (%i ms)", gap => {
  let heap = 10;
  const signals = createLoopHeapSignals(() => heap, unsupported);
  heap = 20;
  const { heap: report } = signals.sample(0, gap + 10, gap)!;
  expect("beforeBytes" in report).toBe(gap > 1000);
  expect("afterBytes" in report).toBe(gap > 1000);
  if (gap > 1000) expect(report).toMatchObject({ beforeBytes: 10, afterBytes: 20 });
});

test("failed and invalid heap reads are explicit and recover on the next complete interval", () => {
  let value = 100, fail = false;
  const signals = createLoopHeapSignals(() => { if (fail) throw Error("private diagnostic"); return value; }, unsupported);
  fail = true;
  const failed = signals.sample(0, 2000, 1990)!;
  expect(failed.heap).toMatchObject({ deltaBytes: null, beforeBytes: 100, afterBytes: null, unavailable: "heap-read-failed" });
  expect(JSON.stringify(failed)).not.toContain("private diagnostic");
  fail = false; value = NaN;
  expect(signals.sample(2000, 4000, 1990)!.heap.deltaBytes).toBeNull();
  value = -1;
  expect(signals.sample(4000, 6000, 1990)!.heap.deltaBytes).toBeNull();
  value = 200;
  expect(signals.sample(6000, 8000, 1990)!.heap.deltaBytes).toBeNull();
  value = 300;
  expect(signals.sample(8000, 10000, 1990)!.heap.deltaBytes).toBe(100);
});

test("GC entries drain before a gap, clip to its interval and keep future entries", () => {
  let deliver!: Parameters<GcSubscriber>[0];
  let records = [{ startTime: 90, duration: 30 }, { startTime: 990, duration: 5 }];
  let disconnected = 0;
  const signals = createLoopHeapSignals(() => 100, record => {
    deliver = record;
    return { observer: { takeRecords: () => { const batch = records; records = []; return batch; }, disconnect: () => { disconnected++; } } };
  });
  signals.start();
  deliver([{ startTime: 120, duration: 20 }, { startTime: 1100, duration: 30 }, { startTime: 0, duration: 1 }]);
  expect(signals.sample(100, 1000, 890)!.gc).toEqual({
    source: "performance-observer", coverage: "observed-entries", count: 3, ms: 45, dropped: 0, late: 1,
  });
  expect(signals.sample(1000, 2000, 990)!.gc).toMatchObject({ count: 1, ms: 30 });
  expect(signals.sample(2000, 3000, 990)!.gc).toMatchObject({ count: 0, ms: 0 });
  signals.stop();
  expect(disconnected).toBe(1);
});

test("GC storage is bounded, ignores invalid timing and reports observer refusal", () => {
  const signals = createLoopHeapSignals(() => 100, record => {
    record([{ startTime: NaN, duration: 1 }, { startTime: 1, duration: -1 }, { startTime: 1, duration: Infinity }]);
    record(Array.from({ length: 200 }, (_, i) => ({ startTime: i + 10, duration: 1 })));
    return { observer: { takeRecords: () => [], disconnect() {} } };
  });
  signals.start();
  expect(signals.sample(0, 1000, 990)!.gc).toMatchObject({ count: 128, ms: 128, dropped: 72 });
  expect(signals.sample(1000, 2000, 990)!.gc).toMatchObject({ count: 0, dropped: 0 });
  signals.stop();
  const refused = createLoopHeapSignals(() => 1, () => ({ unavailable: "gc-observer-refused" }));
  refused.start();
  expect(refused.sample(0, 1000, 990)!.gc).toMatchObject({ count: null, ms: null, reason: "gc-observer-refused" });
});

test("stop/start clears prior heap and GC state", () => {
  let heap = 100, stops = 0;
  const signals = createLoopHeapSignals(() => heap, record => {
    record([{ startTime: 10, duration: 5 }]);
    return { observer: { takeRecords: () => [], disconnect() { stops++; } } };
  });
  signals.start(); signals.stop();
  heap = 1000;
  signals.start();
  heap = 1100;
  expect(signals.sample(1000, 2000, 990)).toMatchObject({ heap: { deltaBytes: 100 }, gc: { count: 0, late: 1 } });
  signals.stop(); expect(stops).toBe(2);
});

test("a disconnected observer cannot add entries to a restarted sampler", () => {
  const callbacks: Array<Parameters<GcSubscriber>[0]> = [];
  const signals = createLoopHeapSignals(() => 100, record => {
    callbacks.push(record);
    return { observer: { takeRecords: () => [], disconnect() {} } };
  });
  signals.start(); signals.stop(); signals.start();
  callbacks[0]!([{ startTime: 100, duration: 10 }]);
  callbacks[1]!([{ startTime: 200, duration: 20 }]);
  expect(signals.sample(0, 1000, 990)!.gc).toMatchObject({ count: 1, ms: 20 });
  signals.stop();
});

test("fresh processes begin with empty GC counters and an independent heap baseline", async () => {
  const script = `
    import { createLoopHeapSignals } from ${JSON.stringify(fileURLToPath(new URL("./loopHeapSignals.ts", import.meta.url)))};
    let heap = 100;
    const signals = createLoopHeapSignals(() => heap, () => {
      return { observer: { takeRecords: () => [], disconnect() {} } };
    });
    signals.start(); heap = 150;
    console.log(JSON.stringify(signals.sample(0, 1000, 990)));
    signals.stop();
  `;
  for (let run = 0; run < 2; run++) {
    const child = Bun.spawn([process.execPath, "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe(""); expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ heap: { deltaBytes: 50 }, gc: { count: 0, ms: 0, dropped: 0, late: 0 } });
  }
});

test("ordinary polls only advance the baseline and allocate no report", () => {
  let heap = 100;
  const signals = createLoopHeapSignals(() => heap, unsupported);
  heap = 200;
  expect(signals.sample(0, 250, 240)).toBeUndefined();
  heap = 300;
  expect(signals.sample(250, 1000, 740)!.heap.deltaBytes).toBe(100);
});

test("the pinned Bun exposes the cached heap proxy and explicitly lacks GC entries", () => {
  const signals = createLoopHeapSignals();
  signals.start();
  const report = signals.sample(0, 1000, 990)!;
  expect(report.heap.source).toBe("process.memoryUsage.heapUsed");
  expect(Number.isFinite(report.heap.deltaBytes)).toBe(true);
  expect(report.gc).toMatchObject({ count: null, ms: null, reason: "gc-entry-unsupported" });
  signals.stop();
});

test("overlapping GC entries count separately but their wall time is a union", () => {
  const signals = createLoopHeapSignals(() => 100, record => {
    record([{ startTime: 990, duration: 40 }, { startTime: 90, duration: 130 }, { startTime: 180, duration: 100 }]);
    return { observer: { takeRecords: () => [], disconnect() {} } };
  });
  signals.start();
  expect(signals.sample(100, 1000, 890)!.gc).toMatchObject({ count: 3, ms: 190 });
  expect(signals.sample(1000, 2000, 990)!.gc).toMatchObject({ count: 1, ms: 30 });
  signals.stop();
});

test("heap cadence skips cheap ticks, forces a gap read and labels the wider proxy window", () => {
  let heap = 100, reads = 0;
  const signals = createLoopHeapSignals(() => { reads++; return heap; }, unsupported);
  for (let at = 10; at < 250; at += 10) signals.sample(at - 10, at, 0);
  expect(reads).toBe(1);
  heap = 200; signals.sample(240, 250, 0);
  expect(reads).toBe(2);
  heap = 300; signals.sample(250, 260, 0);
  expect(reads).toBe(2);
  expect(signals.sample(260, 861, 591)!.heap).toMatchObject({ sampleFrom: 250, sampleTo: 861, deltaBytes: 100 });
  expect(reads).toBe(3);
});
