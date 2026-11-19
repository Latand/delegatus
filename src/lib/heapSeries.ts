import { statePath } from "./configDir";
import { initializeStateCollections, readStateCollectionRows, SqliteStateCollection } from "./state/sqliteStateStore";
import { servingHeapDiagnostics } from "./heapDiagnostics";
import { readHeapSeriesMemory } from "./heapSeriesMemory";

export const HEAP_SERIES_INTERVAL_MS = 10 * 60_000;
export const HEAP_SERIES_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const HEAP_SERIES_MAX_ROWS = 1008;
export const HEAP_SERIES_MAX_ROW_BYTES = 64 * 1024;
const COLLECTION = "heap_series";
const TYPES = ["Subprocess", "AsyncFunctionGenerator", "Promise", "Object", "Array", "string", "Function", "Timeout"];
export interface HeapSeriesRow {
  id: string; at: number; pid: number; uptimeSeconds: number;
  censusAt: string; heapSize: number; extraMemorySize: number; rss: number;
  censusMs: number; gc: unknown; types: Record<string, number>; attribution: unknown;
  /** Added to new samples; older retained rows predate the breakdown. */
  heapCapacity?: number | null; heapTotal?: number | null; external?: number | null; arrayBuffers?: number | null;
  memoryBreakdown?: Awaited<ReturnType<typeof readHeapSeriesMemory>> | null;
}
const decode = (value: unknown): HeapSeriesRow | null => {
  const row = value as HeapSeriesRow;
  return row && typeof row.id === "string" && Number.isFinite(row.at) ? {
    heapCapacity: null, heapTotal: null, external: null, arrayBuffers: null, memoryBreakdown: null, ...row,
  } : null;
};

/** Initialized only after the Viewer has its state startup fence. */
export function createHeapSeriesStore(filename: string) {
  initializeStateCollections(filename, [{ collection: COLLECTION, schemaVersion: 1,
    migrationId: "heap-series-v1", loadRecords: () => [], key: (row: HeapSeriesRow) => row.id }]);
  const store = new SqliteStateCollection<HeapSeriesRow>(filename, { collection: COLLECTION, schemaVersion: 1,
    busyMessage: "heap history is busy", key: row => row.id, decode, clone: row => structuredClone(row) });
  return {
    append(row: HeapSeriesRow) {
      if (Buffer.byteLength(JSON.stringify(row)) > HEAP_SERIES_MAX_ROW_BYTES) throw new Error("heap series row budget exhausted");
      store.patchSync(() => {
        const rows = [...store.loadReadonly()].filter(prior => prior.id !== row.id).sort((a, b) => b.at - a.at);
        const deleteKeys = rows.filter((prior, index) => prior.at <= row.at - HEAP_SERIES_RETENTION_MS || index >= HEAP_SERIES_MAX_ROWS - 1).map(prior => prior.id);
        return { records: [row], deleteKeys };
      });
    },
    close: () => store.close(),
  };
}

const shared = process as typeof process & { __delegatusHeapSeries?: { stop(): void; failures: number; lastSuccessAt: number | null } };

/** No timer reaches the runtime host; each sample reads this Viewer's heap. */
export function createHeapSeriesRecorder(deps: {
  sample(): Promise<HeapSeriesRow | null>; append(row: HeapSeriesRow): void;
  current(): boolean; schedule(work: () => void, ms: number): { unref?(): unknown };
  cancel(timer: { unref?(): unknown }): void;
}) {
  let stopped = false, timer: ReturnType<typeof deps.schedule> | undefined;
  const state = { failures: 0, lastSuccessAt: null as number | null, stop() { stopped = true; if (timer) deps.cancel(timer); } };
  const tick = async () => {
    try {
      if (deps.current()) {
        const row = await deps.sample();
        if (row && !stopped && deps.current()) { deps.append(row); state.lastSuccessAt = row.at; }
      }
    } catch { state.failures++; }
    if (!stopped) { timer = deps.schedule(() => { void tick(); }, HEAP_SERIES_INTERVAL_MS); timer.unref?.(); }
  };
  timer = deps.schedule(() => { void tick(); }, HEAP_SERIES_INTERVAL_MS); timer.unref?.();
  return state;
}

export function startServingHeapSeries(current: () => boolean) {
  if (shared.__delegatusHeapSeries) return;
  // Open lazily at the first tick. Diagnostics can never refuse readiness.
  let store: ReturnType<typeof createHeapSeriesStore> | undefined;
  shared.__delegatusHeapSeries = createHeapSeriesRecorder({
    current,
    schedule: (work, ms) => setTimeout(work, ms), cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    sample: async () => {
      const diagnostics = await servingHeapDiagnostics();
      if (!diagnostics) return null;
      const body = diagnostics.stats(false, false).body;
      return sampleHeapSeries(body);
    },
    append: row => { store ??= createHeapSeriesStore(statePath("state.sqlite")); store.append(row); },
  });
}

/** Each source can be absent independently without discarding the census. */
export async function sampleHeapSeries(body: Record<string, unknown>): Promise<HeapSeriesRow> {
  const at = Date.now();
  const heap = body.heap as { heapSize: number; extraMemorySize: number; heapCapacity?: number };
  const memory = body.memoryUsage as Partial<NodeJS.MemoryUsage> & { rss: number };
  const counts = body.objectTypeCounts as Record<string, number>;
  return { id: `${at}-${process.pid}`, at, pid: process.pid, uptimeSeconds: process.uptime(), censusAt: body.at as string,
    heapSize: heap.heapSize, extraMemorySize: heap.extraMemorySize, rss: memory.rss,
    heapCapacity: heap.heapCapacity ?? null, heapTotal: memory.heapTotal ?? null,
    external: memory.external ?? null, arrayBuffers: memory.arrayBuffers ?? null,
    memoryBreakdown: await readHeapSeriesMemory(),
    censusMs: body.blockedMs as number, gc: body.gc,
    types: Object.fromEntries(TYPES.map(type => [type, counts[type] ?? 0])), attribution: body.attribution };
}

/** Reading never initializes a collection or writes a sample. */
export function readHeapSeries(filename = statePath("state.sqlite"), now = Date.now()) {
  const samples = (readStateCollectionRows(filename, COLLECTION) ?? []).map(decode)
    .filter((row): row is HeapSeriesRow => row !== null && row.at > now - HEAP_SERIES_RETENTION_MS)
    .sort((a, b) => a.at - b.at).slice(-HEAP_SERIES_MAX_ROWS);
  const recorder = shared.__delegatusHeapSeries;
  return { mode: "series", intervalMs: HEAP_SERIES_INTERVAL_MS, retentionMs: HEAP_SERIES_RETENTION_MS,
    maxRows: HEAP_SERIES_MAX_ROWS, maxRowBytes: HEAP_SERIES_MAX_ROW_BYTES,
    recorder: { started: !!recorder, failures: recorder?.failures ?? 0, lastSuccessAt: recorder?.lastSuccessAt ?? null }, samples };
}
