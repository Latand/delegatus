import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { attachReadAttributionWorker, createReadAttribution, createReadCounterSamplerProbe, readAttribution, startReadAttributionSampler } from "./readAttribution";

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
    expect(recorder.snapshot(1).namedSyncMs).toBeLessThan(1);
  } finally { read.mockRestore(); }
});

test("worker event and parent retention overflow are reported", () => {
  const recorder = createReadAttribution(() => 0, () => null);
  recorder.ingestWorker("bounded-worker", { threadId: 7, dropped: 3, events: Array.from({ length: 140 }, (_, index) => ({
    operation: "files.get", reader: `reader-${index}`, connection: index + 1, syncMs: 1, readBytes: 4, decodedJsonBytes: 2,
    observerMs: 0, samplerDegraded: false, sampledCalls: 1, unsampledCalls: 0, unavailableCalls: 0, failed: 0,
  })) });
  const report = recorder.snapshot(1);
  expect(report.workerBatches).toBe(1);
  expect(report.workerTransportDropped).toBe(15);
  expect(report.dropped).toBe(12);
  expect(report.readBytes).toBe(512);
});

test("a degraded proc source is isolated and stops sampling", async () => {
  const probe = createReadCounterSamplerProbe(20);
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  try {
    const deadline = Date.now() + 1000;
    while (!probe.snapshot().degraded && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(timerFired).toBe(true);
    expect(probe.snapshot()).toMatchObject({ degraded: true, samples: 1 });
    expect(probe.snapshot().observerMs).toBeGreaterThanOrEqual(20);
  } finally { await probe.stop(); }
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
