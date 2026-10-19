import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { Worker, isMainThread, parentPort, threadId } from "node:worker_threads";

export type ReadCounter = { bytes: number; observerBytes: number; observerMs?: number; degraded?: boolean; available?: boolean;
  sampledAt?: number; sequence?: number; owner?: number; };
type CounterSampler = { buffer: SharedArrayBuffer; cells: BigInt64Array; worker: Worker; failed: boolean };
let sampler: CounterSampler | undefined;
let samplerFailed = false;
export const samplerSource = `
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');
const cells = new BigInt64Array(workerData.buffer);
const path = '/proc/' + workerData.pid + '/task/' + workerData.tid + '/io';
let failures = 0;
function sample() {
  const started = performance.now();
  if (workerData.delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.delayMs);
  const ownerBefore = Atomics.load(cells, 8);
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const match = /^rchar: (\\d+)$/m.exec(raw);
    if (!match) throw new Error('counter unavailable');
    const bytes = BigInt(match[1]);
    const ownerAfter = Atomics.load(cells, 8);
    // An ownership collision is an unowned sample, not a source failure.
    // BigInt atomics require the sentinel to have the same type as the ids.
    const owner = ownerBefore === ownerAfter ? ownerBefore : 0n;
    const priorOwner = Atomics.load(cells, 11);
    const priorBytes = Atomics.load(cells, 12);
    if (owner !== 0n && owner === priorOwner && bytes >= priorBytes) {
      if (Atomics.load(cells, 9) !== owner) { Atomics.store(cells, 9, owner); Atomics.store(cells, 10, 0n); }
      Atomics.add(cells, 10, bytes - priorBytes);
      Atomics.add(cells, 13, 1n);
    } else if (owner !== 0n && Atomics.load(cells, 9) !== owner) {
      Atomics.store(cells, 9, owner); Atomics.store(cells, 10, 0n);
      Atomics.store(cells, 13, 1n);
    } else if (owner === 0n || owner !== priorOwner) {
      Atomics.store(cells, 13, 0n);
    }
    Atomics.store(cells, 11, owner);
    Atomics.store(cells, 12, bytes);
    Atomics.store(cells, 0, bytes);
    const targetNow = performance.timeOrigin + performance.now() - workerData.timeOrigin;
    Atomics.store(cells, 1, BigInt(Math.round(targetNow * 1000)));
    Atomics.store(cells, 2, 1n);
    Atomics.store(cells, 6, owner);
    Atomics.add(cells, 7, 1n);
    failures = 0;
  } catch {
    failures++;
    Atomics.store(cells, 2, -1n);
  }
  const elapsed = performance.now() - started;
  Atomics.add(cells, 3, BigInt(Math.max(0, Math.round(elapsed * 1000))));
  Atomics.add(cells, 5, 1n);
  const degraded = elapsed > 10 || failures >= 3;
  Atomics.store(cells, 4, degraded ? 1n : 0n);
  if (degraded) Atomics.store(cells, 2, -1n);
  // A descheduled or temporarily inaccessible proc read must not turn off
  // diagnostics for the rest of the release. Back off on this worker only;
  // healthy samples restore availability without waiting on the serving loop.
  setTimeout(sample, degraded ? Math.min(1000, 250 * Math.max(1, failures)) : 10);
}
sample();
`;

function counterSampler(): CounterSampler | undefined {
  if (process.platform !== "linux") return undefined;
  if (sampler) return sampler.failed ? undefined : sampler;
  try {
    const buffer = new SharedArrayBuffer(14 * 8);
    const cells = new BigInt64Array(buffer);
    const tid = isMainThread ? process.pid : Number(fs.readlinkSync("/proc/thread-self").match(/task\/(\d+)$/)?.[1]);
    if (!Number.isInteger(tid) || tid <= 0) { samplerFailed = true; return undefined; }
    const worker = new Worker(samplerSource, { eval: true, workerData: { buffer, pid: process.pid, tid, delayMs: 0, timeOrigin: performance.timeOrigin } });
    sampler = { buffer, cells, worker, failed: false };
    worker.on("error", () => { if (sampler?.worker === worker) { sampler.failed = true; samplerFailed = true; } });
    worker.on("exit", () => { if (sampler?.worker === worker) { sampler.failed = true; samplerFailed = true; } });
    worker.unref();
    return sampler;
  } catch { samplerFailed = true; return undefined; }
}
parentPort?.once("close", () => { void sampler?.worker.terminate(); });
// Resolve this worker's OS thread id during module setup so the first measured
// callback never has to perform a synchronous procfs lookup itself.
if (!isMainThread && process.platform === "linux") void counterSampler();

/** A deterministic probe for the bounded sampler's degraded-source behavior. */
export function createReadCounterSamplerProbe(delayMs: number) {
  const buffer = new SharedArrayBuffer(14 * 8);
  const cells = new BigInt64Array(buffer);
  const worker = new Worker(samplerSource, { eval: true, workerData: { buffer, pid: process.pid, tid: process.pid, delayMs, timeOrigin: performance.timeOrigin } });
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
  const current = counterSampler();
  if (!current) return process.platform === "linux" ? { bytes: 0, observerBytes: 0, available: false, degraded: samplerFailed } : null;
  const status = Number(Atomics.load(current.cells, 2));
  return { bytes: Number(Atomics.load(current.cells, 10)), observerBytes: 0, observerMs: 0,
    sampledAt: Number(Atomics.load(current.cells, 1)) / 1000, sequence: Number(Atomics.load(current.cells, 7)), owner: Number(Atomics.load(current.cells, 9)),
    available: status === 1, degraded: status === -1 || Atomics.load(current.cells, 4) === BigInt(1) };
}

export function startReadAttributionSampler(): void { void counterSampler(); }

export type ReadTotals = { calls: number; syncMs: number; readBytes: number; decodedJsonBytes: number;
  sampledCalls: number; unsampledCalls: number; unavailableCalls: number; failed: number };
export const emptyReadTotals = (): ReadTotals => ({ calls: 0, syncMs: 0, readBytes: 0, decodedJsonBytes: 0,
  sampledCalls: 0, unsampledCalls: 0, unavailableCalls: 0, failed: 0 });
type Reader = ReadTotals & { operation: string; reader: string; connection: number; connections: number[]; connectionSamplesDropped: number;
  worker?: string; workerSyncMs?: number; workerIntervals?: Array<{ start: number; end: number; syncMs: number }>; workerIntervalsDropped?: number };
type WorkerReadEvent = { operation: string; reader: string; connection: number; syncMs: number; readBytes: number; decodedJsonBytes: number;
  start: number; end: number; observerMs: number; samplerDegraded: boolean; sampledCalls: number; unsampledCalls: number; unavailableCalls: number; failed: number };
type Frame = { operation: string; id: number; childrenMs: number; childrenObserverMs: number; childrenBytes: number; ioComplete: boolean; hadChild: boolean };
const capacity = 128, samplesPerWindow = 32, sampleWindowMs = 10;
let nextFrameId = 0;

/** Exclusive synchronous counters. Async context carries only a static name;
 * no byte or duration delta spans an await. */
export function createReadAttribution(now = () => performance.now(), read = mainThreadReadCounter) {
  const context = new AsyncLocalStorage<string>();
    let frame: Frame | undefined;
  let rows = new Map<string, Reader>();
  let sampleAt = -Infinity, samples = 0, dropped = 0, droppedMs = 0, droppedBytes = 0;
  const usesDefaultCounter = read === mainThreadReadCounter;
  let observerMs = 0, observerBaseline = usesDefaultCounter && sampler ? Number(Atomics.load(sampler.cells, 3)) / 1000 : 0, samplerDegraded = false;
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
      const op = context.getStore() ?? parent?.operation ?? reader;
      const id = ++nextFrameId;
      const current: Frame = { operation: op, id, childrenMs: 0, childrenObserverMs: 0, childrenBytes: 0, ioComplete: true, hadChild: false };
      if (parent) parent.hadChild = true;
      if (sampled && usesDefaultCounter && process.platform === "linux") {
        const source = counterSampler();
        if (source) {
          Atomics.store(source.cells, 9, BigInt(id)); Atomics.store(source.cells, 10, BigInt(0));
          Atomics.store(source.cells, 11, BigInt(0)); Atomics.store(source.cells, 13, BigInt(0)); Atomics.store(source.cells, 8, BigInt(id));
        }
      }
      const beforeSourceObserverMs = usesDefaultCounter && sampler ? Number(Atomics.load(sampler.cells, 3)) / 1000 : 0;
      const before = sampled ? read() : null;
      if (before) { observerMs += before.observerMs ?? 0; samplerDegraded ||= before.degraded ?? false; }
      frame = current;
      let failed = false;
      try { return work(); }
      catch (error) { failed = true; throw error; }
      finally {
        const after = before ? read() : null;
        if (after) { observerMs += after.observerMs ?? 0; samplerDegraded ||= after.degraded ?? false; }
        const end = now(), sourceObserverMs = usesDefaultCounter && sampler ? Number(Atomics.load(sampler.cells, 3)) / 1000 : beforeSourceObserverMs;
        const observerDelta = Math.max(0, (after?.observerMs ?? 0) + (before?.observerMs ?? 0));
        const duration = Math.max(0, end - start - observerDelta - current.childrenObserverMs);
        const sampledInterval = before?.sampledAt !== undefined || after?.sampledAt !== undefined;
        const intervalOwned = !sampledInterval || (before?.owner === id && after?.owner === id
          && (after?.sequence ?? 0) > (before?.sequence ?? 0) && (after?.sampledAt ?? -Infinity) >= start
          && (after?.sampledAt ?? Infinity) <= end && !current.hadChild && !!sampler && Atomics.load(sampler.cells, 13) >= BigInt(2));
        const totalBytes = before && after && intervalOwned && before.available !== false && after.available !== false && after.bytes >= before.bytes
          ? Math.max(0, after.bytes - before.bytes - after.observerBytes) : null;
        // An unsampled child invalidates the enclosing byte delta, preventing
        // its traffic from being assigned to the parent reader.
        const bytes = totalBytes === null || !current.ioComplete ? 0 : Math.max(0, totalBytes - current.childrenBytes);
        frame = parent;
        if (parent) {
          parent.childrenMs += duration;
          parent.childrenObserverMs += observerDelta + current.childrenObserverMs + Math.max(0, sourceObserverMs - beforeSourceObserverMs);
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
          start: performance.timeOrigin + start, end: performance.timeOrigin + end,
          observerMs: observerDelta + Math.max(0, sourceObserverMs - beforeSourceObserverMs), samplerDegraded: !!(before?.degraded || after?.degraded),
          sampledCalls: Number(totalBytes !== null && current.ioComplete), unsampledCalls: Number(sampleIo && !sampled),
          unavailableCalls: Number(sampled && totalBytes === null), failed: Number(failed) });
        if (counters) {
          counters.calls++; counters.syncMs += syncMs; counters.readBytes += bytes; counters.decodedJsonBytes += decodedJsonBytes;
          counters.sampledCalls += Number(totalBytes !== null && current.ioComplete);
          counters.unsampledCalls += Number(sampleIo && !sampled);
          counters.unavailableCalls += Number(sampled && totalBytes === null);
          counters.failed += Number(failed);
        }
        if (sampled && sampler) {
          const owner = parent?.id ?? 0;
          Atomics.store(sampler.cells, 8, BigInt(owner)); Atomics.store(sampler.cells, 9, BigInt(owner));
          Atomics.store(sampler.cells, 10, BigInt(0)); Atomics.store(sampler.cells, 11, BigInt(0)); Atomics.store(sampler.cells, 13, BigInt(0));
        }
      }
    },
    snapshot(windowMs: number) {
      const readers = [...rows.values()];
      const namedSyncMs = readers.filter(row => !row.worker).reduce((sum, row) => sum + row.syncMs, 0);
      const operationsWithBytes = new Set(readers.filter(row => !row.worker && (row.readBytes > 0 || row.decodedJsonBytes > 0))
        .map(row => row.operation));
      const byteAttributedSyncMs = readers.filter(row => !row.worker && operationsWithBytes.has(row.operation))
        .reduce((sum, row) => sum + row.syncMs, 0);
      const workerSyncMs = readers.reduce((sum, row) => sum + (row.workerSyncMs ?? 0), 0);
      const operations = new Map<string, { name: string; readBytes: number; decodedJsonBytes: number }>();
      for (const row of readers) {
        const op = operations.get(row.operation) ?? { name: row.operation, readBytes: 0, decodedJsonBytes: 0 };
        op.readBytes += row.readBytes; op.decodedJsonBytes += row.decodedJsonBytes; operations.set(row.operation, op);
      }
      const sourceObserverMs = sampler ? Number(Atomics.load(sampler.cells, 3)) / 1000 : 0;
      const sourceDegraded = samplerFailed || (sampler ? Atomics.load(sampler.cells, 4) === BigInt(1) : false);
      return { source: "linux-thread-rchar", byteCoverage: "sampled-exclusive", sampleLimit: { calls: samplesPerWindow, windowMs: sampleWindowMs },
        windowMs, namedSyncMs, byteAttributedSyncMs, workerSyncMs,
        attributedFraction: windowMs > 0 ? Math.min(1, byteAttributedSyncMs / windowMs) : 0,
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
        row.calls++; row.workerSyncMs = (row.workerSyncMs ?? 0) + event.syncMs; row.readBytes += event.readBytes; row.decodedJsonBytes += event.decodedJsonBytes;
        row.workerIntervals ??= [];
        if (row.workerIntervals.length < 16) row.workerIntervals.push({ start: event.start, end: event.end, syncMs: event.syncMs });
        else row.workerIntervalsDropped = (row.workerIntervalsDropped ?? 0) + 1;
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
      observerBaseline = usesDefaultCounter && sampler ? Number(Atomics.load(sampler.cells, 3)) / 1000 : 0; samplerDegraded = false;
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
