import type { Database } from "bun:sqlite";
import { parentPort, threadId, type Worker } from "node:worker_threads";

export const SQLITE_MEMORY_MAX_CONNECTIONS = 128;
export const SQLITE_MEMORY_WORKER_WAIT_MS = 100;
export interface SqliteConnectionMemory {
  connection: number;
  threadId: number;
  /** Cache budget in SQLite units: positive = pages, negative = KiB. */
  cacheSize: number | null;
  /** Configured maximum mapping size in bytes. */
  mmapSizeBytes: number | null;
}
export interface SqliteMemorySample {
  /** Null when a worker did not answer; never claim a partial count is total. */
  openConnections: number | null;
  connections: SqliteConnectionMemory[];
  omittedConnections: number;
  unavailableWorkers: number;
  /** bun:sqlite exposes no sqlite3_memory_used/status API. */
  memoryUsedBytes: number | null;
}
type Slot = { id: number; db: WeakRef<Database> };
type State = { next: number; slots: Set<Slot>; workers: Set<Worker>; request: number;
  listening?: boolean; finalizer: FinalizationRegistry<Slot> };
const owner = globalThis as typeof globalThis & { __delegatusSqliteMemory?: State };
const state: State = owner.__delegatusSqliteMemory ??= (() => {
  const slots = new Set<Slot>();
  return { next: 0, slots, workers: new Set<Worker>(), request: 0,
    finalizer: new FinalizationRegistry<Slot>(slot => slots.delete(slot)) };
})();

/** Registration retains no connection. Explicit close removes it immediately. */
export function trackSqliteMemory(db: Database): () => void {
  const slot = { id: ++state.next, db: new WeakRef(db) };
  state.slots.add(slot);
  state.finalizer.register(db, slot, slot);
  return () => { state.slots.delete(slot); state.finalizer.unregister(slot); };
}

function pragma(db: Database, sql: string): number | null {
  try {
    // Uncached statements leave the application's query cache undisturbed.
    const statement = db.prepare(sql);
    try {
      const value = statement.values()[0]?.[0];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } finally { statement.finalize(); }
  } catch { return null; }
}

function connectionPragmas(db: Database) {
  const missing = { cacheSize: null, mmapSizeBytes: null };
  const timeout = pragma(db, "PRAGMA busy_timeout");
  if (timeout === null) return missing;
  // An unopened schema can meet another process's exclusive lock. Disable
  // waiting for this synchronous turn and restore the connection setting.
  // busy_timeout is connection-local; it acquires no database write lock.
  try { if (timeout !== 0) db.exec("PRAGMA busy_timeout=0"); }
  catch { return missing; }
  try {
    return { cacheSize: pragma(db, "PRAGMA cache_size"), mmapSizeBytes: pragma(db, "PRAGMA mmap_size") };
  } finally { if (timeout !== 0) db.exec(`PRAGMA busy_timeout=${timeout}`); }
}

export function sqliteMemoryOnThisThread(): SqliteMemorySample {
  const connections: SqliteConnectionMemory[] = [];
  let openConnections = 0;
  for (const slot of state.slots) {
    const db = slot.db.deref();
    if (!db) { state.slots.delete(slot); continue; }
    openConnections++;
    if (connections.length >= SQLITE_MEMORY_MAX_CONNECTIONS) continue;
    try { connections.push({ connection: slot.id, threadId, ...connectionPragmas(db) }); }
    catch { connections.push({ connection: slot.id, threadId, cacheSize: null, mmapSizeBytes: null }); }
  }
  return { openConnections, connections, omittedConnections: openConnections - connections.length,
    unavailableWorkers: 0, memoryUsedBytes: null };
}

const REQUEST = "delegatus-sqlite-memory-request", ANSWER = "delegatus-sqlite-memory-answer";
// The observer is loaded on each store-owning worker through readAttribution.
if (parentPort && !state.listening) {
  state.listening = true;
  parentPort.on("message", (message: { type?: string; request?: number }) => {
    if (message?.type === REQUEST && Number.isSafeInteger(message.request)) {
      parentPort!.postMessage({ type: ANSWER, request: message.request, sample: sqliteMemoryOnThisThread() });
    }
  });
}

/** The same owner that attaches read attribution detaches on worker exit. */
export function attachSqliteMemoryWorker(worker: Worker): () => void {
  state.workers.add(worker);
  const detach = () => { state.workers.delete(worker); worker.off("exit", detach); };
  worker.once("exit", detach);
  return detach;
}

function workerSample(worker: Worker): Promise<SqliteMemorySample | null> {
  return new Promise(resolve => {
    const request = ++state.request;
    const finish = (sample: SqliteMemorySample | null) => {
      clearTimeout(timer); worker.off("message", message); worker.off("exit", exited); resolve(sample);
    };
    const message = (value: { type?: string; request?: number; sample: SqliteMemorySample }) => {
      if (value?.type === ANSWER && value.request === request) finish(value.sample);
    };
    const exited = () => finish(null);
    const timer = setTimeout(() => finish(null), SQLITE_MEMORY_WORKER_WAIT_MS);
    worker.on("message", message); worker.once("exit", exited);
    try { worker.postMessage({ type: REQUEST, request }); } catch { finish(null); }
  });
}

/** Reads existing observed store connections only; opens nothing and takes no write lock. */
export async function readSqliteMemory(): Promise<SqliteMemorySample> {
  const sample = sqliteMemoryOnThisThread();
  for (const other of await Promise.all([...state.workers].map(workerSample))) {
    if (!other) { sample.unavailableWorkers++; sample.openConnections = null; continue; }
    if (sample.openConnections !== null) sample.openConnections += other.openConnections ?? 0;
    const remaining = SQLITE_MEMORY_MAX_CONNECTIONS - sample.connections.length;
    sample.connections.push(...other.connections.slice(0, remaining));
    sample.omittedConnections += other.omittedConnections + Math.max(0, other.connections.length - remaining);
  }
  return sample;
}
