import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { isMainThread } from "node:worker_threads";

export type ReadCounter = { bytes: number; observerBytes: number };
let observerBytes = 0;
// rchar includes cached pread/read bytes. Physical read_bytes would hide
// the cached SQLite traffic that motivated this monitor.
export function mainThreadReadCounter(): ReadCounter | null {
  if (process.platform !== "linux" || !isMainThread) return null;
  try {
    const raw = fs.readFileSync(`/proc/self/task/${process.pid}/io`, "utf8");
    const match = /^rchar: (\d+)$/m.exec(raw);
    const before = observerBytes;
    observerBytes += Buffer.byteLength(raw);
    return match ? { bytes: Number(match[1]) - before, observerBytes: 0 } : null;
  } catch { return null; }
}

export type ReadTotals = { calls: number; syncMs: number; readBytes: number; decodedJsonBytes: number;
  sampledCalls: number; unsampledCalls: number; unavailableCalls: number; failed: number };
export const emptyReadTotals = (): ReadTotals => ({ calls: 0, syncMs: 0, readBytes: 0, decodedJsonBytes: 0,
  sampledCalls: 0, unsampledCalls: 0, unavailableCalls: 0, failed: 0 });
type Reader = ReadTotals & { operation: string; reader: string; connection: number; connections: number[]; connectionSamplesDropped: number };
type Frame = { operation: string; childrenMs: number; childrenBytes: number; ioComplete: boolean };
const capacity = 128, samplesPerWindow = 32, sampleWindowMs = 10;

/** Exclusive synchronous counters. Async context carries only a static name;
 * no byte or duration delta spans an await. */
export function createReadAttribution(now = () => performance.now(), read = mainThreadReadCounter) {
  const context = new AsyncLocalStorage<string>();
  let frame: Frame | undefined;
  let rows = new Map<string, Reader>();
  let sampleAt = -Infinity, samples = 0, dropped = 0, droppedMs = 0, droppedBytes = 0;
  let enabled = true;
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
      const op = context.getStore() ?? parent?.operation ?? reader;
      const current: Frame = { operation: op, childrenMs: 0, childrenBytes: 0, ioComplete: true };
      frame = current;
      let failed = false;
      try { return work(); }
      catch (error) { failed = true; throw error; }
      finally {
        const after = before ? read() : null;
        const end = now(), duration = Math.max(0, end - start);
        const totalBytes = before && after && after.bytes >= before.bytes
          ? Math.max(0, after.bytes - before.bytes - before.observerBytes) : null;
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
      return { source: "linux-main-thread-rchar", byteCoverage: "sampled-exclusive", sampleLimit: { calls: samplesPerWindow, windowMs: sampleWindowMs },
        windowMs, namedSyncMs, attributedFraction: windowMs > 0 ? Math.min(1, namedSyncMs / windowMs) : 0,
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
    clear() { rows = new Map(); dropped = droppedMs = droppedBytes = 0; },
  };
}
const shared = globalThis as typeof globalThis & { __delegatusReadAttribution?: ReturnType<typeof createReadAttribution> };
export const readAttribution = shared.__delegatusReadAttribution ??= createReadAttribution();
