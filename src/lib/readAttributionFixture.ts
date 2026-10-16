import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { WorkerOptions } from "node:worker_threads";

if (process.argv[2] === "service-recovery") {
  // Reproduce production's busy ownership changes, followed by one slow
  // procfs read, in the actual sampler launched by the default recorder.
  // Install the CommonJS constructor seam before the recorder initializes
  // its named worker_threads imports.
  const threads: typeof import("node:worker_threads") = createRequire(import.meta.url)("node:worker_threads");
  const NativeWorker = threads.Worker;
  const samplerWorkers = new Set<InstanceType<typeof NativeWorker>>();
  let cells: BigInt64Array | undefined;
  threads.Worker = class extends NativeWorker {
    constructor(source: string | URL, options?: WorkerOptions) {
      const counter = typeof source === "string" && source.includes("counter unavailable");
      const prefix = `{
        const fs = require('node:fs');
        const { workerData } = require('node:worker_threads');
        const cells = new BigInt64Array(workerData.buffer);
        const nativeRead = fs.readFileSync;
        let reads = 0;
        fs.readFileSync = function(...args) {
          reads++;
          if (reads === 4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          const raw = nativeRead.apply(this, args);
          if (reads <= 3) Atomics.add(cells, 8, BigInt(1));
          return raw;
        };
      }`;
      super(counter ? prefix + source : source, options);
      if (counter) { samplerWorkers.add(this); cells = new BigInt64Array(options!.workerData.buffer); }
    }
  };
  const { readAttribution, startReadAttributionSampler } = await import("./readAttribution");
  const { observeSqlite, sqliteReadCounters } = await import("./sqliteReadAttribution");
  const { createViewerLoopMonitor } = await import("./viewerLoopMonitor");
  const { Database } = await import("bun:sqlite");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-counter-service-"));
  const db = new Database(path.join(directory, "fixture.sqlite"));
  let clock = 0;
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => clock);
  try {
    db.exec("CREATE TABLE rows(value BLOB); INSERT INTO rows VALUES (zeroblob(4194304))");
    const statement = db.query("SELECT value FROM rows");
    const nativeAll = statement.all.bind(statement);
    // This native adapter makes the read long enough to contain complete
    // samples; observeSqlite still owns the real statement instrumentation.
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    const sampleBoundary = () => {
      const target = Atomics.load(cells!, 5) + BigInt(3);
      const deadline = performance.now() + 1000;
      while (Atomics.load(cells!, 5) < target && performance.now() < deadline) Atomics.wait(waiter, 0, 0, 1);
      if (Atomics.load(cells!, 5) < target) throw Error("sampler boundary unavailable");
    };
    Object.defineProperty(statement, "all", { configurable: true, writable: true, value: () => {
      sampleBoundary();
      const rows = nativeAll();
      sampleBoundary();
      return rows;
    } });
    observeSqlite(db, "state");
    const connection = sqliteReadCounters(db)!.connection;
    startReadAttributionSampler();
    const deadline = performance.now() + 5000;
    while ((!cells || Atomics.load(cells, 5) < BigInt(6) || Atomics.load(cells, 4) !== BigInt(0)) && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    if (!cells || Atomics.load(cells, 5) < BigInt(6) || Atomics.load(cells, 4) !== BigInt(0)) throw Error("sampler did not recover");
    readAttribution.clear();
    // A native read bounded on each side by sampler ticks supplies an owned
    // interval. No serving request waits for a counter snapshot.
    monitor.run("files.get", () => db.query("SELECT value FROM rows").all());
    clock = 600;
    monitor.tick();
    console.log(JSON.stringify({ runtime: process.versions.bun, nodeEnv: process.env.NODE_ENV,
      connection, counters: sqliteReadCounters(db), gap: JSON.parse(lines[0].slice("[viewer loop-gap] ".length)) }));
  } finally {
    monitor.stop(); db.close(); threads.Worker = NativeWorker;
    await Promise.all([...samplerWorkers].map(worker => worker.terminate()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  const { readAttribution } = await import("./readAttribution");
  const before = readAttribution.snapshot(1);
  if (process.argv[2] === "overflow") {
    for (let i = 0; i < 512; i++) readAttribution.sync(`fixture-${i}`, () => {}, i);
  }
  console.log(JSON.stringify({ before, after: readAttribution.snapshot(1) }));
}
