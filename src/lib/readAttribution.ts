import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { Worker, isMainThread, parentPort, threadId } from "node:worker_threads";

export type ReadCounter = { bytes: number; observerBytes: number; observerMs?: number; degraded?: boolean; available?: boolean };
type CounterSampler = { buffer: SharedArrayBuffer; cells: BigInt64Array; worker: Worker; failed: boolean };
let sampler: CounterSampler | undefined;
let samplerFailed = false;
let workerThreadBytes = 0, workerThreadDegraded = false;
const samplerSource = `
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');
const cells = new BigInt64Array(workerData.buffer);
const path = '/proc/' + workerData.pid + '/task/' + workerData.tid + '/io';
let timer, degraded = false, failures = 0;
function sample() {
  const started = performance.now();
  if (workerData.delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.delayMs);
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const match = /^rchar: (\\d+)$/m.exec(raw);
    if (!match) throw new Error('counter unavailable');
    Atomics.store(cells, 0, BigInt(match[1]));
    Atomics.store(cells, 1, BigInt(Math.round(performance.now() * 1000)));
    Atomics.store(cells, 2, 1n);
    failures = 0;
  } catch {
    failures++;
    Atomics.store(cells, 2, -1n);
  }
  const elapsed = performance.now() - started;
  Atomics.add(cells, 3, BigInt(Math.max(0, Math.round(elapsed * 1000))));
  Atomics.add(cells, 5, 1n);
  if (elapsed > 10 || failures >= 3) {
    degraded = true;
    Atomics.store(cells, 4, 1n);
    clearInterval(timer);
  }
}
sample();
if (!degraded) timer = setInterval(sample, 10);
`;

function counterSampler(): CounterSampler | undefined {
  if (process.platform !== "linux") return undefined;
  if (sampler) return sampler.failed ? undefined : sampler;
  try {
    const buffer = new SharedArrayBuffer(6 * 8);
    const cells = new BigInt64Array(buffer);
    const tid = isMainThread ? process.pid : Number(fs.readlinkSync("/proc/thread-self").match(/task\/(\d+)$/)?.[1]);
    if (!Number.isInteger(tid) || tid <= 0) { samplerFailed = true; return undefined; }
    const worker = new Worker(samplerSource, { eval: true, workerData: { buffer, pid: process.pid, tid, delayMs: 0 } });
    sampler = { buffer, cells, worker, failed: false };
    worker.on("error", () => { if (sampler?.worker === worker) { sampler.failed = true; samplerFailed = true; } });
    worker.on("exit", () => { if (sampler?.worker === worker) { sampler.failed = true; samplerFailed = true; } });
    worker.unref();
    return sampler;
  } catch { samplerFailed = true; return undefined; }
}
parentPort?.once("close", () => { void sampler?.worker.terminate(); });

/** A deterministic probe for the bounded sampler's degraded-source behavior. */
export function createReadCounterSamplerProbe(delayMs: number) {
  const buffer = new SharedArrayBuffer(6 * 8);
  const cells = new BigInt64Array(buffer);
  const worker = new Worker(samplerSource, { eval: true, workerData: { buffer, pid: process.pid, tid: process.pid, delayMs } });
  worker.unref();
  return {
    snapshot: () => ({ available: Atomics.load(cells, 2) === BigInt(1), degraded: Atomics.load(cells, 4) === BigInt(1),
      observerMs: Number(Atomics.load(cells, 3)) / 1000, samples: Number(Atomics.load(cells, 5)) }),
    stop: () => worker.terminate(),
  };
}

// The procfs read runs in an independent worker and updates atomic snapshots.
// Synchronous call sites only read this cache, so a stalled sampler cannot
// create a serving-loop pause or be charged as application work.
export function mainThreadReadCounter(): ReadCounter | null {
  if (!isMainThread) {
    if (process.platform !== "linux") return null;
    if (workerThreadDegraded) return { bytes: workerThreadBytes, observerBytes: 0, observerMs: 0, available: false, degraded: true };
    const started = performance.now();
    try {
      const raw = fs.readFileSync("/proc/thread-self/io", "utf8");
      const match = /^rchar: (\d+)$/m.exec(raw);
      const observerMs = Math.max(0, performance.now() - started);
      if (!match) throw new Error("thread counter unavailable");
      workerThreadBytes = Number(match[1]);
      workerThreadDegraded ||= observerMs > 10;
      return { bytes: workerThreadBytes, observerBytes: Buffer.byteLength(raw), observerMs,
        available: !workerThreadDegraded, degraded: workerThreadDegraded };
    } catch {
      workerThreadDegraded = true;
      return { bytes: workerThreadBytes, observerBytes: 0, observerMs: Math.max(0, performance.now() - started), available: false, degraded: true };
    }
  }
  const current = counterSampler();
  if (!current) return process.platform === "linux" ? { bytes: 0, observerBytes: 0, available: false, degraded: samplerFailed } : null;
  const status = Number(Atomics.load(current.cells, 2));
  return { bytes: Number(Atomics.load(current.cells, 0)), observerBytes: 0, observerMs: 0,
    available: status === 1, degraded: status === -1 || Atomics.load(current.cells, 4) === BigInt(1) };
}

export function startReadAttributionSampler(): void { void counterSampler(); }

export type ReadTotals = { calls: number; syncMs: number; readBytes: number; decodedJsonBytes: number;
  sampledCalls: number; unsampledCalls: number; unavailableCalls: number; failed: number };
export const emptyReadTotals = (): ReadTotals => ({ calls: 0, syncMs: 0, readBytes: 0, decodedJsonBytes: 0,
  sampledCalls: 0, unsampledCalls: 0, unavailableCalls: 0, failed: 0 });
type Reader = ReadTotals & { operation: string; reader: string; connection: number; connections: number[]; connectionSamplesDropped: number; worker?: string };
type WorkerReadEvent = { operation: string; reader: string; connection: number; syncMs: number; readBytes: number; decodedJsonBytes: number;
  observerMs: number; samplerDegraded: boolean; sampledCalls: number; unsampledCalls: number; unavailableCalls: number; failed: number };
type Frame = { operation: string; childrenMs: number; childrenBytes: number; ioComplete: boolean };
const capacity = 128, samplesPerWindow = 32, sampleWindowMs = 10;

/** Exclusive synchronous counters. Async context carries only a static name;
 * no byte or duration delta spans an await. */
export function createReadAttribution(now = () => performance.now(), read = mainThreadReadCounter) {
  const context = new AsyncLocalStorage<string>();
  let frame: Frame | undefined;
  let rows = new Map<string, Reader>();
  let sampleAt = -Infinity, samples = 0, dropped = 0, droppedMs = 0, droppedBytes = 0;
  let observerMs = 0, observerBaseline = 0, samplerDegraded = false;
  let workerEvents: WorkerReadEvent[] = [];
  let workerEventsDropped = 0, workerFlushScheduled = false, workerInFlight = false, workerBatches = 0, workerTransportDropped = 0;
  let enabled = true;
  const flushWorkerEvents = () => {
    workerFlushScheduled = false;
    if (!parentPort || workerInFlight || !workerEvents.length && !workerEventsDropped) return;
    const events = workerEvents;
    const dropped = workerEventsDropped;
    workerEvents = [];
    workerEventsDropped = 0;
    try { workerInFlight = true; parentPort.postMessage({ type: "delegatus-read-attribution", threadId, events, dropped }); workerBatches++; }
    catch { workerInFlight = false; workerTransportDropped += events.length + dropped; }
  };
  const reportWorkerEvent = (event: WorkerReadEvent) => {
    if (isMainThread || !parentPort) return;
    if (workerEvents.length < 256) workerEvents.push(event); else workerEventsDropped++;
    if (!workerFlushScheduled) { workerFlushScheduled = true; setImmediate(flushWorkerEvents); }
  };
  parentPort?.on("message", message => {
    if (message?.type !== "delegatus-read-attribution-ack" || message.threadId !== threadId) return;
    workerInFlight = false;
    if ((workerEvents.length || workerEventsDropped) && !workerFlushScheduled) {
      workerFlushScheduled = true;
      setImmediate(flushWorkerEvents);
    }
  });
  const operation = () => context.getStore() ?? "unscoped";
  return {
    operation,
    setEnabled(value: boolean) { enabled = value; },
    run<T>(name: string, work: () => T): T {
      return context.run(name, () => this.sync("operation", work));
    },
    sync<T>(reader: string, work: () => T, connection = 0, decodedJsonBytes = 0, sampleIo = true, counters?: ReadTotals): T {
      if (!enabled) return work();
      const start = now(), parent = frame;
      if (start - sampleAt >= sampleWindowMs) { sampleAt = start; samples = 0; }
      const sampled = sampleIo && samples < samplesPerWindow;
      if (sampled) samples++;
      const before = sampled ? read() : null;
      if (before) { observerMs += before.observerMs ?? 0; samplerDegraded ||= before.degraded ?? false; }
      const op = context.getStore() ?? parent?.operation ?? reader;
      const current: Frame = { operation: op, childrenMs: 0, childrenBytes: 0, ioComplete: true };
      frame = current;
      let failed = false;
      try { return work(); }
      catch (error) { failed = true; throw error; }
      finally {
        const after = before ? read() : null;
        if (after) { observerMs += after.observerMs ?? 0; samplerDegraded ||= after.degraded ?? false; }
        const end = now(), observerDelta = Math.max(0, (after?.observerMs ?? 0) + (before?.observerMs ?? 0));
        const duration = Math.max(0, end - start - observerDelta);
        const totalBytes = before && after && before.available !== false && after.available !== false && after.bytes >= before.bytes
          ? Math.max(0, after.bytes - before.bytes - after.observerBytes) : null;
        // An unsampled child invalidates the enclosing byte delta, preventing
        // its traffic from being assigned to the parent reader.
        const bytes = totalBytes === null || !current.ioComplete ? 0 : Math.max(0, totalBytes - current.childrenBytes);
        frame = parent;
        if (parent) {
          parent.childrenMs += duration;
          parent.childrenBytes += totalBytes ?? (sampleIo ? 0 : current.childrenBytes);
          parent.ioComplete &&= sampleIo ? totalBytes !== null : current.ioComplete;
        }
        const syncMs = Math.max(0, duration - current.childrenMs);
        const key = `${op}/${reader}`;
        let row = rows.get(key);
        if (!row && rows.size < capacity) {
          row = { operation: op, reader, connection, connections: [], connectionSamplesDropped: 0, ...emptyReadTotals() };
          rows.set(key, row);
        }
        if (row) {
          if (row.connection !== connection) row.connection = 0;
          if (connection && !row.connections.includes(connection)) {
            if (row.connections.length < 8) row.connections.push(connection); else row.connectionSamplesDropped++;
          }
          row.calls++; row.syncMs += syncMs; row.readBytes += bytes; row.decodedJsonBytes += decodedJsonBytes;
          row.sampledCalls += Number(totalBytes !== null && current.ioComplete);
          row.unsampledCalls += Number(sampleIo && !sampled);
          row.unavailableCalls += Number(sampled && totalBytes === null);
          row.failed += Number(failed);
        } else { dropped++; droppedMs += syncMs; droppedBytes += bytes; }
        reportWorkerEvent({ operation: op, reader, connection, syncMs, readBytes: bytes, decodedJsonBytes,
          observerMs: observerDelta, samplerDegraded: !!(before?.degraded || after?.degraded),
          sampledCalls: Number(totalBytes !== null && current.ioComplete), unsampledCalls: Number(sampleIo && !sampled),
          unavailableCalls: Number(sampled && totalBytes === null), failed: Number(failed) });
        if (counters) {
          counters.calls++; counters.syncMs += syncMs; counters.readBytes += bytes; counters.decodedJsonBytes += decodedJsonBytes;
          counters.sampledCalls += Number(totalBytes !== null && current.ioComplete);
          counters.unsampledCalls += Number(sampleIo && !sampled);
          counters.unavailableCalls += Number(sampled && totalBytes === null);
          counters.failed += Number(failed);
        }
      }
    },
    snapshot(windowMs: number) {
      const readers = [...rows.values()];
      const namedSyncMs = readers.reduce((sum, row) => sum + row.syncMs, 0);
      const operations = new Map<string, { name: string; readBytes: number; decodedJsonBytes: number }>();
      for (const row of readers) {
        const op = operations.get(row.operation) ?? { name: row.operation, readBytes: 0, decodedJsonBytes: 0 };
        op.readBytes += row.readBytes; op.decodedJsonBytes += row.decodedJsonBytes; operations.set(row.operation, op);
      }
      const sourceObserverMs = sampler ? Number(Atomics.load(sampler.cells, 3)) / 1000 : 0;
      const sourceDegraded = samplerFailed || (sampler ? Atomics.load(sampler.cells, 4) === BigInt(1) : false);
      return { source: "linux-thread-rchar", byteCoverage: "sampled-exclusive", sampleLimit: { calls: samplesPerWindow, windowMs: sampleWindowMs },
        windowMs, namedSyncMs, attributedFraction: windowMs > 0 ? Math.min(1, namedSyncMs / windowMs) : 0,
        observerMs: observerMs + Math.max(0, sourceObserverMs - observerBaseline), samplerDegraded: samplerDegraded || sourceDegraded,
        workerBatches, workerTransportDropped,
        readBytes: readers.reduce((sum, row) => sum + row.readBytes, 0),
        decodedJsonBytes: readers.reduce((sum, row) => sum + row.decodedJsonBytes, 0),
        sampledCalls: readers.reduce((sum, row) => sum + row.sampledCalls, 0),
        unsampledCalls: readers.reduce((sum, row) => sum + row.unsampledCalls, 0),
        unavailableCalls: readers.reduce((sum, row) => sum + row.unavailableCalls, 0),
        dropped, droppedMs, droppedBytes, omitted: Math.max(0, readers.length - 16),
        top: readers.sort((a, b) => b.readBytes - a.readBytes || b.syncMs - a.syncMs).slice(0, 16),
        operations: [...operations.values()],
      };
    },
    ingestWorker(identity: string, message: { threadId: number; events: WorkerReadEvent[]; dropped: number }) {
      workerBatches++;
      const worker = `${identity}-${message.threadId}`;
      for (const event of message.events) {
        const operation = `worker-${worker}:${event.operation}`;
        const reader = event.reader;
        const key = `${operation}/${reader}`;
        let row = rows.get(key);
        if (!row && rows.size < capacity) {
          row = { operation, reader, connection: event.connection, connections: [], connectionSamplesDropped: 0, worker, ...emptyReadTotals() };
          rows.set(key, row);
        }
        if (!row) { dropped++; workerTransportDropped++; droppedMs += event.syncMs; droppedBytes += event.readBytes; continue; }
        if (row.connection !== event.connection) row.connection = 0;
        row.calls++; row.syncMs += event.syncMs; row.readBytes += event.readBytes; row.decodedJsonBytes += event.decodedJsonBytes;
        observerMs += event.observerMs; samplerDegraded ||= event.samplerDegraded;
        row.sampledCalls += event.sampledCalls; row.unsampledCalls += event.unsampledCalls;
        row.unavailableCalls += event.unavailableCalls; row.failed += event.failed;
        if (event.connection && !row.connections.includes(event.connection)) {
          if (row.connections.length < 8) row.connections.push(event.connection); else row.connectionSamplesDropped++;
        }
      }
      workerTransportDropped += Math.max(0, message.dropped);
    },
    noteWorkerTransportDrop() { workerTransportDropped++; },
    clear() { rows = new Map(); dropped = droppedMs = droppedBytes = observerMs = 0;
      observerBaseline = sampler ? Number(Atomics.load(sampler.cells, 3)) / 1000 : 0; samplerDegraded = false;
      workerBatches = workerTransportDropped = 0; },
  };
}
const shared = globalThis as typeof globalThis & { __delegatusReadAttribution?: ReturnType<typeof createReadAttribution> };
export const readAttribution = shared.__delegatusReadAttribution ??= createReadAttribution();

/** Attach bounded worker batches to the parent process monitor. */
export function attachReadAttributionWorker(worker: Worker, identity: string): () => void {
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/i.test(identity)) throw new Error("worker attribution identity must be a short static label");
  const listener = (message: unknown) => {
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "delegatus-read-attribution") return;
    const batch = message as { threadId: number; events: WorkerReadEvent[]; dropped: number };
    readAttribution.ingestWorker(identity, batch);
    try { worker.postMessage({ type: "delegatus-read-attribution-ack", threadId: batch.threadId }); }
    catch { readAttribution.noteWorkerTransportDrop(); }
  };
  worker.on("message", listener);
  return () => worker.off("message", listener);
}
