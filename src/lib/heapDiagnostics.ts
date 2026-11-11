import fs from "node:fs";
import path from "node:path";

/*
 * On-demand heap diagnostics for the serving process. Nothing here runs on a
 * timer: both modes walk the JavaScriptCore heap on the main thread and block
 * the event loop for their whole duration, so each runs only when the operator
 * asks for it.
 *
 * Snapshot cost, measured on Bun 1.4.0. It has two very different unit prices,
 * and the census names only counts, so the estimate is an upper bound:
 *
 *   per non-string object   53–64 bytes of output, 300–330 bytes of extra
 *                           resident memory at the peak, 1.8–2.5 µs
 *   per string              the snapshot stores each string's first 1024
 *                           characters, JSON-escaped: 65 bytes for a short
 *                           string and up to 1.1 KB (ASCII), 1.7 KB (Cyrillic,
 *                           emoji, quotes and newlines); 3.3–5 KB of memory
 *                           and 8–11 µs for a long one
 *
 * The census (heapStats) costs 27–40 ns per object.
 *
 * A heap of short strings is overestimated about 30 times; that is the price
 * of a bound that holds for a heap of long ones. Only a string made mostly of
 * control characters (6 bytes of output each) can exceed it.
 *
 * The runtime serializes the whole snapshot into one contiguous buffer, and
 * that buffer cannot exceed about 2 GiB, so the bound on the output stays
 * well under it.
 */
export const HEAP_STATS_CACHE_MS = 30_000;
export const HEAP_SNAPSHOT_INTERVAL_MS = 60 * 60_000;
export const HEAP_SNAPSHOT_MIN_FREE_DISK_BYTES = 4 * 1024 ** 3;
export const HEAP_SNAPSHOT_MAX_FILE_BYTES = 1.5 * 1024 ** 3;
export const HEAP_SNAPSHOT_FILE_BYTES_PER_OBJECT = 80;
export const HEAP_SNAPSHOT_MEMORY_BYTES_PER_OBJECT = 400;
export const HEAP_SNAPSHOT_BLOCK_MS_PER_MILLION_OBJECTS = 3000;
export const HEAP_SNAPSHOT_FILE_BYTES_PER_STRING = 2200;
export const HEAP_SNAPSHOT_MEMORY_BYTES_PER_STRING = 7000;
export const HEAP_SNAPSHOT_BLOCK_MS_PER_MILLION_STRINGS = 15_000;
export const HEAP_SNAPSHOT_FORMAT = "v8-heapsnapshot";
const SNAPSHOT_NAME = /^heap-\d{8}T\d{6}Z-\d+\.heapsnapshot$/;
const PARTIAL_SUFFIX = ".partial";
/** Written before the heap is serialized, so a process that dies there still spends the hour. */
const ATTEMPT_MARKER = "last-attempt";

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
  stringCount: number;
  /** Upper bounds, see the cost model above. */
  fileBytes: number;
  peakExtraMemoryBytes: number;
  blockMs: number;
}

export type HeapSnapshotRefusal = "busy" | "rate_limited" | "too_large" | "insufficient_memory" | "insufficient_disk" | "failed";

export interface HeapDiagnosticsAnswer {
  status: number;
  body: Record<string, unknown>;
}

interface Census { at: number; heap: JscHeapStats; blockedMs: number }

interface State {
  census: Census | null;
  snapshotRunning: boolean;
  lastSnapshotAttemptAt: number | null;
}

/* The serving bundle may hold several copies of this module; the in-flight
   flag and the attempt time must be one per process. */
const slot = globalThis as typeof globalThis & { __delegatusHeapDiagnostics?: State };
function sharedState(): State {
  return slot.__delegatusHeapDiagnostics ??= { census: null, snapshotRunning: false, lastSnapshotAttemptAt: null };
}

const sortedCounts = (counts: Record<string, number> | undefined) =>
  Object.fromEntries(Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

export function estimateHeapSnapshot(heap: Pick<JscHeapStats, "objectCount" | "objectTypeCounts">): HeapSnapshotEstimate {
  const objectCount = Math.max(0, heap.objectCount);
  const stringCount = Math.min(objectCount, Math.max(0, heap.objectTypeCounts?.string ?? 0));
  const others = objectCount - stringCount;
  return {
    objectCount, stringCount,
    fileBytes: others * HEAP_SNAPSHOT_FILE_BYTES_PER_OBJECT + stringCount * HEAP_SNAPSHOT_FILE_BYTES_PER_STRING,
    peakExtraMemoryBytes: others * HEAP_SNAPSHOT_MEMORY_BYTES_PER_OBJECT + stringCount * HEAP_SNAPSHOT_MEMORY_BYTES_PER_STRING,
    blockMs: Math.round(others / 1e6 * HEAP_SNAPSHOT_BLOCK_MS_PER_MILLION_OBJECTS + stringCount / 1e6 * HEAP_SNAPSHOT_BLOCK_MS_PER_MILLION_STRINGS),
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

const isPartial = (name: string) => name.endsWith(PARTIAL_SUFFIX) && SNAPSHOT_NAME.test(name.slice(0, -PARTIAL_SUFFIX.length));

function markedAttemptAt(directory: string): number | null {
  try { return fs.statSync(path.join(directory, ATTEMPT_MARKER)).mtimeMs; }
  catch { return null; }
}

export function createHeapDiagnostics(deps: HeapDiagnosticsDeps, state: State = sharedState()) {
  /** One heap walk per cache window, shared by both modes. */
  function census(now: number): Census & { cached: boolean } {
    if (state.census && now - state.census.at >= 0 && now - state.census.at < HEAP_STATS_CACHE_MS) return { ...state.census, cached: true };
    const started = deps.monotonicMs();
    const heap = deps.heapStats();
    state.census = { at: now, heap, blockedMs: deps.monotonicMs() - started };
    return { ...state.census, cached: false };
  }

  /** A partial file is a whole heap's strings left by a process that died
      while writing; nothing reads it, so it goes the next time anyone asks. */
  function sweepPartials(directory: string): number {
    if (state.snapshotRunning) return 0;
    let names: string[];
    try { names = fs.readdirSync(directory); }
    catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!isPartial(name)) continue;
      try { fs.rmSync(path.join(directory, name), { force: true }); removed++; }
      catch { /* stays for the operator to see */ }
    }
    return removed;
  }

  /** Cheap mode: counters and the per-type object census. Writes no file. */
  function stats(): HeapDiagnosticsAnswer {
    const now = deps.now();
    sweepPartials(deps.directory());
    const { heap, at, blockedMs, cached } = census(now);
    const { rss, heapUsed, heapTotal, external, arrayBuffers } = deps.memoryUsage();
    const estimate = estimateHeapSnapshot(heap);
    return { status: 200, body: {
      mode: "stats",
      at: new Date(at).toISOString(),
      cached, ageMs: now - at,
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
        ...estimate,
        upperBound: true,
        maxFileBytes: HEAP_SNAPSHOT_MAX_FILE_BYTES,
        fitsSizeBound: estimate.fileBytes <= HEAP_SNAPSHOT_MAX_FILE_BYTES,
        availableMemoryBytes: deps.availableMemoryBytes(),
      },
    } };
  }

  const refuse = (status: number, refusal: HeapSnapshotRefusal, detail: Record<string, unknown>): HeapDiagnosticsAnswer =>
    ({ status, body: { mode: "snapshot", written: false, refusal, ...detail } });

  /** Explicit mode: one full snapshot written under the cache directory. */
  async function snapshot(): Promise<HeapDiagnosticsAnswer> {
    if (state.snapshotRunning) return refuse(409, "busy", {});
    const now = deps.now();
    const directory = deps.directory();
    sweepPartials(directory);
    const stored = storedSnapshots(directory);
    /* A file dated ahead of this clock counts as written now: it holds the
       hour and never longer. */
    const last = Math.min(now, Math.max(state.lastSnapshotAttemptAt ?? -Infinity, markedAttemptAt(directory) ?? -Infinity, stored[0]?.mtimeMs ?? -Infinity));
    if (now - last < HEAP_SNAPSHOT_INTERVAL_MS) {
      return refuse(429, "rate_limited", {
        retryAfterMs: Math.ceil(HEAP_SNAPSHOT_INTERVAL_MS - (now - last)),
        ...(stored[0] ? { existing: { path: stored[0].file, bytes: stored[0].bytes } } : {}),
      });
    }
    /* The census costs about 1% of the snapshot and bounds it in advance. A
       refused call inside the cache window walks nothing. */
    const estimate = estimateHeapSnapshot(census(now).heap);
    if (estimate.fileBytes > HEAP_SNAPSHOT_MAX_FILE_BYTES) {
      return refuse(413, "too_large", { estimate, maxFileBytes: HEAP_SNAPSHOT_MAX_FILE_BYTES });
    }
    const availableMemoryBytes = deps.availableMemoryBytes();
    const requiredMemoryBytes = Math.ceil(estimate.peakExtraMemoryBytes * 1.5);
    if (availableMemoryBytes === null || availableMemoryBytes < requiredMemoryBytes) {
      return refuse(507, "insufficient_memory", { estimate, availableMemoryBytes, requiredMemoryBytes });
    }
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // The mode above applies only to a directory this call created.
      fs.chmodSync(directory, 0o700);
    } catch { return refuse(500, "failed", { stage: "directory" }); }
    const freeDiskBytes = deps.freeDiskBytes(directory);
    const requiredDiskBytes = Math.max(HEAP_SNAPSHOT_MIN_FREE_DISK_BYTES, estimate.fileBytes * 2);
    if (freeDiskBytes === null || freeDiskBytes < requiredDiskBytes) {
      return refuse(507, "insufficient_disk", { estimate, freeDiskBytes, requiredDiskBytes });
    }
    /* On disk before the heap is touched: a process killed mid-serialization
       and restarted by its supervisor must find the hour already spent. */
    try {
      const marker = path.join(directory, ATTEMPT_MARKER);
      fs.writeFileSync(marker, `${new Date(now).toISOString()}\n`, { mode: 0o600 });
      fs.utimesSync(marker, new Date(now), new Date(now));
    } catch { return refuse(500, "failed", { stage: "marker" }); }

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
      // The runtime answers an empty buffer when the snapshot outgrew its own.
      if (bytes.byteLength === 0) return refuse(500, "failed", { stage: "generate", estimate });
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
      if (target === keep || (!SNAPSHOT_NAME.test(name) && !isPartial(name))) continue;
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
