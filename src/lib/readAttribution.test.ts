import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { attachReadAttributionWorker, createReadAttribution, readAttribution, samplerSource, startReadAttributionSampler } from "./readAttribution";

test("nested readers have exclusive time and bytes; observer traffic is removed", () => {
  let at = 0, bytes = 0;
  const read = () => { const result = { bytes, observerBytes: 10 }; bytes += 10; return result; };
  const recorder = createReadAttribution(() => at, read);
  recorder.run("files.get", () => {
    at += 2; bytes += 50;
    recorder.sync("state.pipelines", () => { at += 600; bytes += 4096; }, 1);
    at += 3; bytes += 80;
  });
  const report = recorder.snapshot(605);
  expect(report.namedSyncMs).toBe(605);
  expect(report.top.find(row => row.reader === "state.pipelines")).toMatchObject({ syncMs: 600, readBytes: 4096, operation: "files.get", connection: 1 });
  expect(report.top.find(row => row.reader === "operation")!.syncMs).toBe(5);
  expect(report.attributedFraction).toBe(1);
});

test("interleaved awaits carry names without assigning peer time or bytes", async () => {
  let at = 0, bytes = 0;
  const recorder = createReadAttribution(() => at, () => ({ bytes, observerBytes: 0 }));
  let release!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  const pending = recorder.run("files.get", async () => {
    await latch;
    recorder.sync("state", () => { at += 300; bytes += 8192; }, 1);
  });
  recorder.run("pipelines.get", () => recorder.sync("registry", () => { at += 700; bytes += 4096; }, 2));
  release(); await pending;
  const report = recorder.snapshot(1000);
  expect(report.namedSyncMs).toBe(1000);
  expect(report.operations).toContainEqual({ name: "files.get", readBytes: 8192, decodedJsonBytes: 0 });
  expect(report.operations).toContainEqual({ name: "pipelines.get", readBytes: 4096, decodedJsonBytes: 0 });
});

test("unavailable and regressing counters stay explicit; failures preserve decoded bytes", () => {
  let at = 0;
  const recorder = createReadAttribution(() => at, () => null);
  expect(() => recorder.sync("registry.json", () => { at += 600; throw Error("private"); }, 3, 23, false)).toThrow();
  recorder.sync("registry", () => { at += 1; }, 3);
  const report = recorder.snapshot(601);
  expect(report.top.find(row => row.reader === "registry.json")).toMatchObject({ failed: 1, decodedJsonBytes: 23 });
  expect(report.top.find(row => row.reader === "registry")).toMatchObject({ unavailableCalls: 1, readBytes: 0 });
  expect(JSON.stringify(report)).not.toContain("private");
  let bytes = 100;
  const resets = createReadAttribution(() => at, () => ({ bytes: bytes--, observerBytes: 0 }));
  resets.sync("state", () => {});
  expect(resets.snapshot(1).top[0]).toMatchObject({ unavailableCalls: 1, readBytes: 0 });
});

test("sampling and retention bounds report lost evidence and reset for the next window", () => {
  let at = 0, reads = 0;
  const recorder = createReadAttribution(() => at, () => ({ bytes: ++reads, observerBytes: 0 }));
  for (let i = 0; i < 1000; i++) recorder.sync(`state-${i}`, () => {}, i);
  const report = recorder.snapshot(1);
  expect(reads).toBe(64);
  expect(report.dropped).toBe(872);
  expect(report.omitted).toBe(112);
  expect(report.unsampledCalls).toBe(96);
  recorder.clear(); at = 10;
  recorder.sync("state", () => {});
  expect(reads).toBe(66);
  expect(recorder.snapshot(1).dropped).toBe(0);
});

test("unsampled nested traffic is never reassigned to its sampled parent", () => {
  let bytes = 0;
  const recorder = createReadAttribution(() => 0, () => ({ bytes, observerBytes: 0 }));
  for (let i = 0; i < 31; i++) recorder.sync("state", () => {});
  recorder.run("files.get", () => recorder.sync("registry", () => { bytes += 4096; }));
  expect(recorder.snapshot(1).readBytes).toBe(0);
});

test("synchronous site siblings name child SQL and preserve exclusive bytes through JSON frames", () => {
  let at = 0, bytes = 0;
  const recorder = createReadAttribution(() => at, () => ({ bytes, observerBytes: 0 }));
  recorder.sync("registry.snapshot", () => {
    at += 100;
    recorder.sync("registry.json", () => {
      at += 100;
      recorder.sync("registry.get", () => { at += 600; bytes += 4096; }, 1);
    }, 1, 16, false);
  });
  const report = recorder.snapshot(800);
  expect(report.namedSyncMs).toBe(800);
  expect(report.readBytes).toBe(4096);
  expect(report.operations).toEqual([{ name: "registry.snapshot", readBytes: 4096, decodedJsonBytes: 16 }]);
});

test("a slow counter source cannot be charged to empty application work", () => {
  let at = 0;
  let calls = 0;
  const recorder = createReadAttribution(() => at, () => {
    calls++;
    at += 20;
    return { bytes: calls, observerBytes: 0, observerMs: 20, degraded: true };
  });
  for (let i = 0; i < 20; i++) recorder.run("files.get", () => {});
  const report = recorder.snapshot(400);
  expect(report.namedSyncMs).toBe(0);
  expect(report.top.every(row => row.syncMs === 0)).toBe(true);
  expect(report.observerMs).toBeGreaterThan(0);
  expect(report.samplerDegraded).toBe(true);
});

test("proc counter reads stay off the serving thread", () => {
  startReadAttributionSampler();
  let procReads = 0;
  const original = fs.readFileSync;
  const read = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).includes("/proc/") && String(args[0]).endsWith("/io")) {
      procReads++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return original.apply(fs, args as never);
  }) as typeof fs.readFileSync);
  try {
    const recorder = createReadAttribution();
    for (let i = 0; i < 20; i++) recorder.run("files.get", () => {});
    expect(procReads).toBe(0);
  } finally { read.mockRestore(); }
});

test("stale thread counter samples never bill a later reader or certify zero bytes", () => {
  const staleA = { bytes: 0, observerBytes: 0, sampledAt: 1, sequence: 7, owner: 0 };
  const lateA = { bytes: 1_048_576, observerBytes: 0, sampledAt: 49, sequence: 8, owner: 0 };
  const snapshots = [staleA, staleA, lateA, lateA];
  let index = 0;
  const recorder = createReadAttribution(() => 50, () => snapshots[index++] ?? lateA);
  recorder.sync("reader-A", () => { /* the sampler has not published A's completed I/O yet */ }, 1);
  recorder.sync("reader-B", () => {}, 2);
  const report = recorder.snapshot(100);
  expect(report.top.find(row => row.reader === "reader-A")).toMatchObject({ readBytes: 0, sampledCalls: 0, unavailableCalls: 1 });
  expect(report.top.find(row => row.reader === "reader-B")).toMatchObject({ readBytes: 0, sampledCalls: 0, unavailableCalls: 1 });
});

test("nested empty callbacks exclude every level of observer work from application time", () => {
  let at = 0;
  const recorder = createReadAttribution(() => at, () => {
    at += 20;
    return { bytes: 0, observerBytes: 0, observerMs: 20 };
  });
  recorder.run("files.get", () => recorder.sync("state.get", () => recorder.sync("state.decode", () => {})));
  const report = recorder.snapshot(200);
  expect(report.namedSyncMs).toBe(0);
  expect(report.observerMs).toBeGreaterThanOrEqual(120);
});

test("worker durations remain outside main-loop pause coverage", () => {
  let at = 0;
  const recorder = createReadAttribution(() => at, () => null);
  recorder.sync("empty-main-work", () => { at += 590; });
  recorder.ingestWorker("delayed-worker", { threadId: 5, dropped: 0, events: [{
    operation: "files.get", reader: "state.get", connection: 3, syncMs: 600, readBytes: 4096, decodedJsonBytes: 32,
    start: 1_800_000_000_000, end: 1_800_000_000_600, observerMs: 0, samplerDegraded: false,
    sampledCalls: 1, unsampledCalls: 0, unavailableCalls: 0, failed: 0,
  }] });
  const report = recorder.snapshot(600);
  expect(report.namedSyncMs).toBe(590);
  expect(report.byteAttributedSyncMs).toBe(0);
  expect(report.attributedFraction).toBe(0);
  expect(report.workerSyncMs).toBe(600);
  expect(report.top[0]).toMatchObject({ worker: "delayed-worker-5", readBytes: 4096, decodedJsonBytes: 32 });
  expect(report.top[0].workerIntervals).toEqual([{ start: 1_800_000_000_000, end: 1_800_000_000_600, syncMs: 600 }]);
});

test("named main-loop work counts toward coverage when its operation carries decoded bytes", () => {
  let at = 0;
  const recorder = createReadAttribution(() => at, () => null);
  recorder.run("files.get", () => {
    recorder.sync("state.get", () => { at += 500; });
    recorder.sync("state.json", () => {}, 4, 32, false);
  });
  const report = recorder.snapshot(500);
  expect(report.namedSyncMs).toBe(500);
  expect(report.byteAttributedSyncMs).toBe(500);
  expect(report.attributedFraction).toBe(1);
});

test("worker event and parent retention overflow are reported", () => {
  const recorder = createReadAttribution(() => 0, () => null);
  recorder.ingestWorker("bounded-worker", { threadId: 7, dropped: 3, events: Array.from({ length: 140 }, (_, index) => ({
    operation: "files.get", reader: `reader-${index}`, connection: index + 1, syncMs: 1, readBytes: 4, decodedJsonBytes: 2,
    start: index, end: index + 1,
    observerMs: 0, samplerDegraded: false, sampledCalls: 1, unsampledCalls: 0, unavailableCalls: 0, failed: 0,
  })) });
  const report = recorder.snapshot(1);
  expect(report.workerBatches).toBe(1);
  expect(report.workerTransportDropped).toBe(15);
  expect(report.dropped).toBe(12);
  expect(report.readBytes).toBe(512);
});

test("a degraded proc source is isolated and backs off sampling", async () => {
  const probe = samplerFixture("transient-slow");
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  try {
    await new Promise(resolve => setTimeout(resolve, 600));
    await untilSampler(() => samplerHasRecovery(probe));
    expect(timerFired).toBe(true);
    expectSamplerRecovery(probe, 250);
  } finally { await probe.stop(); }
});

test("a slow counter source cannot stall an actual worker event loop", async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const nativeReadFileSync = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      if (String(path) === '/proc/thread-self/io') {
        parentPort.postMessage({ type: 'sync-proc-read' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
      return nativeReadFileSync.call(this, path, ...args);
    };
    let timerFired = false;
    setTimeout(() => { timerFired = true; parentPort.postMessage({ type: 'timer' }); }, 0);
    const { readAttribution, createReadCounterSamplerProbe } = require(workerData.modulePath);
    const probe = createReadCounterSamplerProbe(40);
    readAttribution.run('worker.empty', () => {});
    setTimeout(() => {
      const counter = probe.snapshot();
      void probe.stop();
      parentPort.postMessage({ type: 'report', timerFired, counter, reads: readAttribution.snapshot(1) });
    }, 100);
  `, { eval: true, workerData: { modulePath: `${import.meta.dir}/readAttribution.ts` } });
  const messages: Array<Record<string, unknown>> = [];
  try {
    const report = await new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.on("message", message => { messages.push(message); if (message.type === "report") resolve(message); });
      worker.once("error", reject);
    });
    expect(messages.find(message => message.type === "timer")?.type).toBe("timer");
    expect(messages.some(message => message.type === "sync-proc-read")).toBe(false);
    expect(report.timerFired).toBe(true);
    expect((report.counter as { degraded: boolean }).degraded).toBe(true);
    expect((report.counter as { observerMs: number }).observerMs).toBeGreaterThan(0);
  } finally { await worker.terminate(); }
});

test("worker transport caps pending batches and reports dropped observations", async () => {
  readAttribution.clear();
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { readAttribution } = require(workerData.modulePath);
    let acknowledgements = 0;
    parentPort.on('message', message => {
      if (message?.type === 'delegatus-read-attribution-ack' && ++acknowledgements === 1) parentPort.close();
    });
    for (let index = 0; index < 300; index++) readAttribution.sync('reader-' + index, () => {}, 0, 0, false);
  `, { eval: true, workerData: { modulePath: `${import.meta.dir}/readAttribution.ts` } });
  const detach = attachReadAttributionWorker(worker, "overflow-probe");
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    });
    const report = readAttribution.snapshot(1);
    expect(report.workerBatches).toBe(1);
    expect(report.workerTransportDropped).toBeGreaterThanOrEqual(44);
    expect(report.dropped).toBeGreaterThan(0);
  } finally { detach(); await worker.terminate(); readAttribution.clear(); }
});

// Run the production worker program with a controlled procfs seam. Each test
// owns a fresh worker and buffer; no service process or shared state is used.
function samplerFixture(mode: "ownership-race" | "transient-slow" | "transient-denied" | "denied") {
  const buffer = new SharedArrayBuffer(16_404 * 8);
  const cells = new BigInt64Array(buffer);
  const prefix = `{
    const fs = require('node:fs');
    const { workerData } = require('node:worker_threads');
    const cells = new BigInt64Array(workerData.buffer);
    const nativeRead = fs.readFileSync;
    const nativeTimeout = setTimeout;
    globalThis.setTimeout = function(callback, delay) {
      Atomics.store(cells, 14, BigInt(delay));
      const count = Number(Atomics.load(cells, 15)) + 1;
      if (count <= 4096) {
        const offset = 16 + count * 4;
        Atomics.store(cells, offset, BigInt(delay));
        Atomics.store(cells, offset + 1, Atomics.load(cells, 2));
        Atomics.store(cells, offset + 2, Atomics.load(cells, 4));
        Atomics.store(cells, offset + 3, Atomics.load(cells, 5));
      }
      Atomics.store(cells, 15, BigInt(count));
      return nativeTimeout(callback, delay);
    };
    let reads = 0;
    fs.readFileSync = function(...args) {
      reads++;
      if (workerData.mode === 'denied' || workerData.mode === 'transient-denied' && reads <= 3) throw new Error('unavailable');
      if (workerData.mode === 'transient-slow' && reads === 1)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      const raw = nativeRead.apply(this, args);
      if (workerData.mode === 'ownership-race' && reads <= 3) Atomics.add(cells, 8, BigInt(1));
      return raw;
    };
  }`;
  const worker = new Worker(prefix + samplerSource, { eval: true,
    workerData: { buffer, mode, pid: process.pid, tid: process.pid, delayMs: 0, timeOrigin: performance.timeOrigin } });
  return { cells, stop: () => worker.terminate() };
}

function samplerEvents(probe: ReturnType<typeof samplerFixture>) {
  const count = Math.min(Number(Atomics.load(probe.cells, 15)), 4096);
  return Array.from({ length: count }, (_, offset) => ({
    delay: Number(Atomics.load(probe.cells, 16 + (offset + 1) * 4)),
    available: Atomics.load(probe.cells, 17 + (offset + 1) * 4),
    degraded: Atomics.load(probe.cells, 18 + (offset + 1) * 4),
    samples: Atomics.load(probe.cells, 19 + (offset + 1) * 4),
  }));
}

function expectSamplerRecovery(probe: ReturnType<typeof samplerFixture>, backoffMs: number) {
  const events = samplerEvents(probe);
  const degradedAt = events.findIndex(event => event.degraded === BigInt(1));
  const backoffAt = events.findIndex((event, index) => index >= degradedAt && event.delay === backoffMs);
  const recoveredAt = events.findIndex((event, index) => index > backoffAt && event.available === BigInt(1) && event.degraded === BigInt(0));
  expect(degradedAt).toBeGreaterThanOrEqual(0);
  expect(backoffAt).toBeGreaterThanOrEqual(degradedAt);
  expect(recoveredAt).toBeGreaterThan(backoffAt);
}

function samplerHasRecovery(probe: ReturnType<typeof samplerFixture>) {
  const events = samplerEvents(probe);
  const degradedAt = events.findIndex(event => event.degraded === BigInt(1));
  return degradedAt >= 0 && events.some((event, index) => index > degradedAt && event.available === BigInt(1) && event.degraded === BigInt(0));
}

async function untilSampler(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

test.skipIf(process.platform !== "linux")("ownership changes during procfs reads do not disable the production sampler", async () => {
  const probe = samplerFixture("ownership-race");
  try {
    await untilSampler(() => Atomics.load(probe.cells, 5) >= BigInt(4) && Atomics.load(probe.cells, 4) === BigInt(0));
    expect(Atomics.load(probe.cells, 2)).toBe(BigInt(1));
    expect(Atomics.load(probe.cells, 8)).toBe(BigInt(3));
  } finally { await probe.stop(); }
}, 10_000);

test.skipIf(process.platform !== "linux")("a transient slow sample backs off and recovers without restarting the process", async () => {
  const probe = samplerFixture("transient-slow");
  try {
    await new Promise(resolve => setTimeout(resolve, 1250));
    await untilSampler(() => samplerHasRecovery(probe));
    expectSamplerRecovery(probe, 250);
  } finally { await probe.stop(); }
}, 10_000);

test("an inaccessible proc source remains unavailable and retries at a bounded rate", async () => {
  const probe = samplerFixture("denied");
  try {
    await untilSampler(() => Atomics.load(probe.cells, 5) >= BigInt(4) && Atomics.load(probe.cells, 14) === BigInt(1000));
    expect(Atomics.load(probe.cells, 2)).toBe(-BigInt(1));
    expect(Atomics.load(probe.cells, 4)).toBe(BigInt(1));
  } finally { await probe.stop(); }
}, 10_000);

test.skipIf(process.platform !== "linux")("proc read failures recover after the source becomes accessible", async () => {
  const probe = samplerFixture("transient-denied");
  try {
    await new Promise(resolve => setTimeout(resolve, 1250));
    await untilSampler(() => samplerHasRecovery(probe));
    expectSamplerRecovery(probe, 750);
  } finally { await probe.stop(); }
}, 10_000);
