import fs from "node:fs";
import path from "node:path";

/*
 * On-demand heap diagnostics for the serving process. Nothing here runs on a
 * timer: both modes walk the JavaScriptCore heap on the main thread and block
 * the event loop for their whole duration, so each runs only when the operator
 * asks for it.
 *
 * Cost model, measured on Bun 1.4.0 with fixture heaps of 110–220 MB
 * (2.7–5.5 million objects) and assumed linear in the object count:
 *
 *   heapStats()                  27–34 ns per object
 *   generateHeapSnapshot("v8")   1.8–2.5 µs per object, 315–330 bytes of extra
 *                                resident memory per object at the peak, and
 *                                53–64 bytes of output per object
 *
 * The constants below round those up. The runtime builds the whole snapshot as
 * one in-memory buffer before a byte reaches the disk, so the estimated output
 * is capped well under the 2 GiB ceiling of a single JavaScriptCore string.
 */
export const HEAP_STATS_CACHE_MS = 30_000;
export const HEAP_SNAPSHOT_INTERVAL_MS = 60 * 60_000;
export const HEAP_SNAPSHOT_MIN_FREE_DISK_BYTES = 4 * 1024 ** 3;
export const HEAP_SNAPSHOT_MAX_FILE_BYTES = 1.5 * 1024 ** 3;
export const HEAP_SNAPSHOT_FILE_BYTES_PER_OBJECT = 80;
export const HEAP_SNAPSHOT_MEMORY_BYTES_PER_OBJECT = 400;
export const HEAP_SNAPSHOT_BLOCK_MS_PER_MILLION_OBJECTS = 3000;
export const HEAP_SNAPSHOT_FORMAT = "v8-heapsnapshot";
const SNAPSHOT_NAME = /^heap-\d{8}T\d{6}Z-\d+\.heapsnapshot$/;
const PARTIAL_SUFFIX = ".partial";

export interface JscHeapStats {
  heapSize: number;
  heapCapacity: number;
  extraMemorySize: number;
  objectCount: number;
  protectedObjectCount: number;
  globalObjectCount: number;
  protectedGlobalObjectCount: number;
  objectTypeCounts: Record<string, number>;
  protectedObjectTypeCounts: Record<string, number>;
  /** Allocator counters the runtime attaches; passed through when present. */
  mimalloc?: unknown;
}

export interface HeapDiagnosticsDeps {
  heapStats(): JscHeapStats;
  memoryUsage(): NodeJS.MemoryUsage;
  /** The whole snapshot in the V8 `.heapsnapshot` JSON encoding. */
  generateSnapshot(): ArrayBuffer | Uint8Array;
  /** Where snapshots live; created 0700 on first use. */
  directory(): string;
  freeDiskBytes(directory: string): number | null;
  availableMemoryBytes(): number | null;
  now(): number;
  monotonicMs(): number;
}

export interface HeapSnapshotEstimate {
  objectCount: number;
  fileBytes: number;
  peakExtraMemoryBytes: number;
  blockMs: number;
}

export type HeapSnapshotRefusal = "busy" | "rate_limited" | "too_large" | "insufficient_memory" | "insufficient_disk" | "failed";

export interface HeapDiagnosticsAnswer {
  status: number;
  body: Record<string, unknown>;
}

interface State {
  stats: { at: number; body: Record<string, unknown> } | null;
  snapshotRunning: boolean;
  lastSnapshotAttemptAt: number | null;
}

/* The serving bundle may hold several copies of this module; the in-flight
   flag and the attempt time must be one per process. */
const slot = globalThis as typeof globalThis & { __delegatusHeapDiagnostics?: State };
function sharedState(): State {
  return slot.__delegatusHeapDiagnostics ??= { stats: null, snapshotRunning: false, lastSnapshotAttemptAt: null };
}

const sortedCounts = (counts: Record<string, number> | undefined) =>
  Object.fromEntries(Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

export function estimateHeapSnapshot(objectCount: number): HeapSnapshotEstimate {
  return {
    objectCount,
    fileBytes: objectCount * HEAP_SNAPSHOT_FILE_BYTES_PER_OBJECT,
    peakExtraMemoryBytes: objectCount * HEAP_SNAPSHOT_MEMORY_BYTES_PER_OBJECT,
    blockMs: Math.round(objectCount / 1e6 * HEAP_SNAPSHOT_BLOCK_MS_PER_MILLION_OBJECTS),
  };
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

interface StoredSnapshot { file: string; mtimeMs: number; bytes: number }

function storedSnapshots(directory: string): StoredSnapshot[] {
  let names: string[];
  try { names = fs.readdirSync(directory); }
  catch { return []; }
  const found: StoredSnapshot[] = [];
  for (const name of names) {
    if (!SNAPSHOT_NAME.test(name)) continue;
    try {
      const stat = fs.statSync(path.join(directory, name));
      if (stat.isFile()) found.push({ file: path.join(directory, name), mtimeMs: stat.mtimeMs, bytes: stat.size });
    } catch { /* removed between the listing and the stat */ }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function createHeapDiagnostics(deps: HeapDiagnosticsDeps, state: State = sharedState()) {
  /** Cheap mode: counters and the per-type object census. Writes no file. */
  function stats(): HeapDiagnosticsAnswer {
    const now = deps.now();
    if (state.stats && now - state.stats.at >= 0 && now - state.stats.at < HEAP_STATS_CACHE_MS) {
      return { status: 200, body: { ...state.stats.body, cached: true, ageMs: now - state.stats.at } };
    }
    const started = deps.monotonicMs();
    const heap = deps.heapStats();
    const blockedMs = deps.monotonicMs() - started;
    const { rss, heapUsed, heapTotal, external, arrayBuffers } = deps.memoryUsage();
    const body: Record<string, unknown> = {
      mode: "stats",
      at: new Date(now).toISOString(),
      blockedMs: Math.round(blockedMs * 10) / 10,
      memoryUsage: { rss, heapUsed, heapTotal, external, arrayBuffers },
      heap: {
        heapSize: heap.heapSize, heapCapacity: heap.heapCapacity, extraMemorySize: heap.extraMemorySize,
        objectCount: heap.objectCount, protectedObjectCount: heap.protectedObjectCount,
        globalObjectCount: heap.globalObjectCount, protectedGlobalObjectCount: heap.protectedGlobalObjectCount,
      },
      objectTypeCounts: sortedCounts(heap.objectTypeCounts),
      protectedObjectTypeCounts: sortedCounts(heap.protectedObjectTypeCounts),
      ...(heap.mimalloc && typeof heap.mimalloc === "object" ? { mimalloc: heap.mimalloc } : {}),
      snapshotEstimate: {
        ...estimateHeapSnapshot(heap.objectCount),
        maxFileBytes: HEAP_SNAPSHOT_MAX_FILE_BYTES,
        fitsSizeBound: estimateHeapSnapshot(heap.objectCount).fileBytes <= HEAP_SNAPSHOT_MAX_FILE_BYTES,
        availableMemoryBytes: deps.availableMemoryBytes(),
      },
    };
    state.stats = { at: now, body };
    return { status: 200, body: { ...body, cached: false, ageMs: 0 } };
  }

  const refuse = (status: number, refusal: HeapSnapshotRefusal, detail: Record<string, unknown>): HeapDiagnosticsAnswer =>
    ({ status, body: { mode: "snapshot", written: false, refusal, ...detail } });

  /** Explicit mode: one full snapshot written under the cache directory. */
  async function snapshot(): Promise<HeapDiagnosticsAnswer> {
    if (state.snapshotRunning) return refuse(409, "busy", {});
    const now = deps.now();
    const directory = deps.directory();
    const stored = storedSnapshots(directory);
    /* A file dated ahead of this clock counts as written now: it holds the
       hour and never longer. */
    const last = Math.min(now, Math.max(state.lastSnapshotAttemptAt ?? -Infinity, stored[0]?.mtimeMs ?? -Infinity));
    if (now - last < HEAP_SNAPSHOT_INTERVAL_MS) {
      return refuse(429, "rate_limited", {
        retryAfterMs: Math.ceil(HEAP_SNAPSHOT_INTERVAL_MS - (now - last)),
        ...(stored[0] ? { existing: { path: stored[0].file, bytes: stored[0].bytes } } : {}),
      });
    }
    /* The census costs about 1% of the snapshot and sizes it in advance. */
    const estimate = estimateHeapSnapshot(deps.heapStats().objectCount);
    if (estimate.fileBytes > HEAP_SNAPSHOT_MAX_FILE_BYTES) {
      return refuse(413, "too_large", { estimate, maxFileBytes: HEAP_SNAPSHOT_MAX_FILE_BYTES });
    }
    const availableMemoryBytes = deps.availableMemoryBytes();
    const requiredMemoryBytes = Math.ceil(estimate.peakExtraMemoryBytes * 1.5);
    if (availableMemoryBytes === null || availableMemoryBytes < requiredMemoryBytes) {
      return refuse(507, "insufficient_memory", { estimate, availableMemoryBytes, requiredMemoryBytes });
    }
    try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
    catch { return refuse(500, "failed", { stage: "directory" }); }
    const freeDiskBytes = deps.freeDiskBytes(directory);
    const requiredDiskBytes = Math.max(HEAP_SNAPSHOT_MIN_FREE_DISK_BYTES, estimate.fileBytes * 2);
    if (freeDiskBytes === null || freeDiskBytes < requiredDiskBytes) {
      return refuse(507, "insufficient_disk", { estimate, freeDiskBytes, requiredDiskBytes });
    }

    state.snapshotRunning = true;
    state.lastSnapshotAttemptAt = now;
    const file = path.join(directory, `heap-${stamp(now)}-${process.pid}.heapsnapshot`);
    const partial = `${file}${PARTIAL_SUFFIX}`;
    try {
      const before = deps.memoryUsage();
      const generateStarted = deps.monotonicMs();
      let bytes: Uint8Array | null;
      try {
        const produced = deps.generateSnapshot();
        bytes = produced instanceof Uint8Array ? produced : new Uint8Array(produced);
      } catch {
        return refuse(500, "failed", { stage: "generate", estimate });
      }
      const generateMs = deps.monotonicMs() - generateStarted;
      const size = bytes.byteLength;
      const writeStarted = deps.monotonicMs();
      try {
        /* Heap contents include every live string: owner-only, like the state. */
        await fs.promises.writeFile(partial, bytes, { mode: 0o600, flag: "w" });
        bytes = null;
        await fs.promises.rename(partial, file);
      } catch {
        bytes = null;
        await fs.promises.rm(partial, { force: true }).catch(() => {});
        return refuse(500, "failed", { stage: "write", estimate });
      }
      const writeMs = deps.monotonicMs() - writeStarted;
      const removed = await removeOthers(directory, file);
      return { status: 200, body: {
        mode: "snapshot", written: true, format: HEAP_SNAPSHOT_FORMAT, path: file, bytes: size,
        at: new Date(now).toISOString(),
        generateBlockedMs: Math.round(generateMs), writeMs: Math.round(writeMs),
        estimate, removedOlder: removed,
        memoryUsageBefore: { rss: before.rss, heapUsed: before.heapUsed },
      } };
    } finally {
      state.snapshotRunning = false;
    }
  }

  /** One snapshot stays on disk: the one just written. */
  async function removeOthers(directory: string, keep: string): Promise<number> {
    let names: string[];
    try { names = await fs.promises.readdir(directory); }
    catch { return 0; }
    let removed = 0;
    for (const name of names) {
      const target = path.join(directory, name);
      if (target === keep) continue;
      const partial = name.endsWith(PARTIAL_SUFFIX) && SNAPSHOT_NAME.test(name.slice(0, -PARTIAL_SUFFIX.length));
      if (!SNAPSHOT_NAME.test(name) && !partial) continue;
      try { await fs.promises.rm(target, { force: true }); removed++; }
      catch { /* a snapshot that cannot be removed stays for the operator to see */ }
    }
    return removed;
  }

  return { stats, snapshot };
}

type BunRuntime = { generateHeapSnapshot?: (format: "v8", encoding: "arraybuffer") => ArrayBuffer };

/** The serving process's own heap. Null where the runtime has no JavaScriptCore census. */
export async function servingHeapDiagnostics(): Promise<ReturnType<typeof createHeapDiagnostics> | null> {
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!process.versions.bun || typeof bun?.generateHeapSnapshot !== "function") return null;
  // Next leaves the Bun builtin to the serving interpreter (see loopProfilerServing).
  const jsc = await import(/* webpackIgnore: true */ "bun:jsc") as unknown as { heapStats(): JscHeapStats };
  const { cacheEntryPath } = await import("./configDir");
  return createHeapDiagnostics({
    heapStats: () => jsc.heapStats(),
    memoryUsage: () => process.memoryUsage(),
    generateSnapshot: () => bun.generateHeapSnapshot!("v8", "arraybuffer"),
    directory: () => cacheEntryPath("heap-snapshots"),
    freeDiskBytes: directory => {
      try { const info = fs.statfsSync(directory); return info.bavail * info.bsize; }
      catch { return null; }
    },
    availableMemoryBytes: () => {
      try {
        const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
        return match ? Number(match[1]) * 1024 : null;
      } catch { return null; }
    },
    now: () => Date.now(),
    monotonicMs: () => performance.now(),
  });
}
