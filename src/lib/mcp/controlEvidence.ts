import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { assertStateStartupMutation, mayRunStateStartupMutation } from "@/lib/stateOwnership";
import { EVIDENCE_TTL_MS, requestTime } from "./controlRequest";
export { CONTROL_REQUEST_HEADER, CONTROL_RECOVERY_PATH, EVIDENCE_LIMIT, EVIDENCE_TTL_MS, OUTCOME_LIMIT, controlRequestId } from "./controlRequest";

export type ControlEvidence = { state: "seen" | "fenced" | "unknown"; status?: number; outcome?: string | null; fresh?: boolean; nonce?: string };

function evidenceDatabaseOpener(fs: typeof import("node:fs"), filename: string, open: () => Database): Database {
  const identity = () => { try { const s = fs.statSync(filename); return `${s.dev}:${s.ino}`; } catch { return null; } };
  let db = open(), stamp = identity();
  return new Proxy(db, { get(_target, key) {
    if (["query", "exec", "transaction", "prepare", "run"].includes(String(key)) && identity() !== stamp) {
      if (db.inTransaction) { db.exec("ROLLBACK"); throw Error("evidence database changed during transaction"); }
      db.close(); db = open(); stamp = identity();
    }
    const value = Reflect.get(db, key, db); return typeof value === "function" ? value.bind(db) : value;
  } });
}

/** A missing row proves nothing until its id is atomically fenced. The floor
 * makes deletion, retention and a newly created database conservative: an old
 * request can never become a fresh negative observation. Busy writers refuse
 * immediately; no serving loop waits for a shared SQLite lock. */
// All dependencies are explicit parameters so the same implementation runs in
// the source tests and in a worker embedded in a packaged Next/MCP bundle.
function evidenceStoreFactory(fs: typeof import("node:fs"), path: typeof import("node:path"),
  database: () => typeof import("bun:sqlite").Database, openCurrentDatabase: (filename: string, open: () => Database) => Database,
  assertMutation: typeof assertStateStartupMutation, requestTime: (id: string) => number | null, ttl: number) {
  return function createStore(filename: string, now = Date.now, prepare = true) {
    if (prepare) assertMutation(path.dirname(filename), "prepare MCP HTTP evidence");
    if (prepare) fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const db = openCurrentDatabase(filename, () => {
      const db = new (database())(filename, prepare ? { create: true, strict: true } : { create: false, readwrite: true, strict: true });
      try {
      if (!prepare) { db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL"); return db; }
      fs.chmodSync(filename, 0o600);
      db.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=1048576;
        CREATE TABLE IF NOT EXISTS coverage (id INTEGER PRIMARY KEY CHECK(id=1), floor INTEGER NOT NULL, opened INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, issued INTEGER NOT NULL, route TEXT, nonce TEXT NOT NULL,
          state TEXT NOT NULL, status INTEGER, outcome TEXT, closed INTEGER, read_bytes INTEGER, written_bytes INTEGER);
        CREATE INDEX IF NOT EXISTS requests_issued ON requests(issued);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, id TEXT NOT NULL,
          event TEXT NOT NULL, code TEXT, route TEXT, read_bytes INTEGER NOT NULL, written_bytes INTEGER NOT NULL);`);
      db.query("INSERT OR IGNORE INTO coverage VALUES(1, ?, ?)").run(now(), now());
      // Retain positive witnesses across restart. A missing pre-open witness
      // is conservative even if an older database was restored in place.
      db.query("UPDATE coverage SET opened=max(opened,?) WHERE id=1").run(now());
      return db;
      } catch (error) { db.close(); throw error; }
    });
    function prune(): void {
      const cutoff = now() - ttl;
      const excess = db.query<{ issued: number }, []>("SELECT issued FROM requests ORDER BY issued DESC LIMIT 1 OFFSET 2046").get();
      const floor = Math.max(cutoff, excess?.issued ?? 0);
      db.query("UPDATE coverage SET floor=max(floor, ?) WHERE id=1").run(floor);
      db.query("DELETE FROM requests WHERE issued<=?").run(floor);
    }
    return { db,
      observe(id: string, fence = false, route?: string): ControlEvidence {
        return db.transaction(() => {
          prune();
          const issued = requestTime(id);
          const row = db.query<ControlEvidence, [string]>("SELECT state,status,outcome FROM requests WHERE id=?").get(id);
          if (row) return row;
          const coverage = db.query<{ floor: number; opened: number }, []>("SELECT floor,opened FROM coverage WHERE id=1").get()!;
          if (issued === null || issued <= Math.max(coverage.floor, coverage.opened) || issued > now() + 1000) return { state: "unknown" } as const;
          const nonce = globalThis.crypto.randomUUID();
          db.query("INSERT INTO requests(id,issued,state,route,nonce) VALUES(?,?,?,?,?)").run(id, issued, fence ? "fenced" : "seen", route?.slice(0, 256) ?? null, nonce);
          return { state: fence ? "fenced" : "seen", fresh: true, nonce } as const;
        }).immediate();
      },
      complete(id: string, status: number, outcome: string | null, nonce?: string): void {
        db.query("UPDATE requests SET status=?,outcome=? WHERE id=? AND state='seen' AND (? IS NULL OR nonce=?)").run(status, outcome, id, nonce ?? null, nonce ?? null);
      },
      abandon(id: string, nonce: string): void {
        db.query("UPDATE requests SET state='fenced' WHERE id=? AND nonce=? AND state='seen' AND status IS NULL").run(id, nonce);
      },
      closed(id: string, read: number, written: number): void {
        db.query("UPDATE requests SET closed=?,read_bytes=?,written_bytes=? WHERE id=?").run(now(), read, written, id);
      },
      event(id: string, event: "start" | "response" | "close" | "error", read = 0, written = 0, code?: string, route?: string): void {
        db.transaction(() => {
          db.query("INSERT INTO events(at,id,event,code,route,read_bytes,written_bytes) VALUES(?,?,?,?,?,?,?)")
            .run(now(), id, event, code && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null, route?.slice(0, 256) ?? null, read, written);
          db.query("DELETE FROM events WHERE seq <= (SELECT coalesce(max(seq),0)-2048 FROM events) OR at<?")
            .run(now() - ttl);
        }).immediate();
      },
      close(): void { db.close(); },
    };
  };
}

const createEvidenceStore = evidenceStoreFactory(fs, path,
  () => (process.getBuiltinModule!("bun:sqlite") as typeof import("bun:sqlite")).Database,
  (filename, open) => evidenceDatabaseOpener(fs, filename, open), assertStateStartupMutation, requestTime, EVIDENCE_TTL_MS);
type EvidenceOperations = ReturnType<typeof createEvidenceStore>;
export class ControlEvidenceStore {
  private readonly store: EvidenceOperations;
  constructor(readonly filename: string, now = Date.now, prepare = true) { this.store = createEvidenceStore(filename, now, prepare); }
  get db(): Database { return this.store.db; }
  observe(...args: Parameters<EvidenceOperations["observe"]>) { return this.store.observe(...args); }
  complete(...args: Parameters<EvidenceOperations["complete"]>) { this.store.complete(...args); }
  abandon(...args: Parameters<EvidenceOperations["abandon"]>) { this.store.abandon(...args); }
  closed(...args: Parameters<EvidenceOperations["closed"]>) { this.store.closed(...args); }
  event(...args: Parameters<EvidenceOperations["event"]>) { this.store.event(...args); }
  close() { this.store.close(); }
}

/** Durability and fsync run off the serving loop. Admission waits for one ack
 * under a deadline; a dead or stalled writer refuses new work without leaving
 * a lock or an unbounded message queue on the Viewer. */
export class AsyncControlEvidenceStore {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private failed = false;
  constructor(readonly filename: string, prepare = mayRunStateStartupMutation(path.dirname(filename)), private readonly timeoutMs = 15_000) {
    if (prepare) assertStateStartupMutation(path.dirname(filename), "prepare MCP HTTP evidence");
    const source = `
      const fs = require('node:fs'), path = require('node:path');
      const { parentPort, workerData } = require('node:worker_threads');
      const openCurrentDatabase=(filename,open)=>(${evidenceDatabaseOpener.toString()})(fs,filename,open);
      const Store = (${evidenceStoreFactory.toString()})(fs,path,()=>require('bun:sqlite').Database,
        openCurrentDatabase,()=>{},(${requestTime.toString()}),${EVIDENCE_TTL_MS});
      const ready=(async()=>{
        const until=Date.now()+10000;
        for(let attempt=0;;attempt++) {
          try { return Store(workerData.filename, Date.now, workerData.prepare); }
          catch(error) {
            const busy=error.code==='SQLITE_BUSY'||error.code==='SQLITE_LOCKED'||/database is (locked|busy)/.test(error.message);
            if(!busy||Date.now()>=until) throw error;
            await new Promise(resolve=>setTimeout(resolve,Math.min(100,5*2**Math.min(attempt,5))));
          }
        }
      })();
      ready.catch(()=>{});
      parentPort.on('message', async ({key,method,args}) => {
        try {
          const store=await ready;
          if (!['ready','observe','complete','abandon','closed','event'].includes(method)) throw Error('invalid evidence operation');
          const value=method==='ready' ? null : store[method](...args);
          parentPort.postMessage({key,value});
        } catch (error) { parentPort.postMessage({key,error:String(error.message).slice(0,200)}); }
      });`;
    this.worker = new Worker(source, { eval: true, workerData: { filename, prepare } });
    this.worker.on("message", ({ key, value, error }: { key: number; value: unknown; error?: string }) => {
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key); clearTimeout(pending.timer);
      if (error) pending.reject(new Error(error)); else pending.resolve(value);
    });
    const fail = () => {
      this.failed = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("MCP HTTP evidence writer unavailable")); }
      this.pending.clear();
    };
    this.worker.on("error", fail); this.worker.on("exit", fail); this.worker.unref();
  }
  private call(method: string, args: unknown[], timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.failed || this.pending.size >= 256) return Promise.reject(new Error("MCP HTTP evidence writer unavailable"));
    const key = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failed = true;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("MCP HTTP evidence writer deadline exceeded")); }
        this.pending.clear(); void this.worker.terminate();
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      this.worker.postMessage({ key, method, args });
    });
  }
  async ready(): Promise<void> { await this.call("ready", [], Math.max(1500, this.timeoutMs)); }
  async observe(id: string, fence = false, route?: string): Promise<ControlEvidence> { return await this.call("observe", [id, fence, route]) as ControlEvidence; }
  async complete(id: string, status: number, outcome: string | null, nonce?: string): Promise<void> { await this.call("complete", [id, status, outcome, nonce]); }
  async abandon(id: string, nonce: string): Promise<void> { await this.call("abandon", [id, nonce]); }
  async closed(id: string, read: number, written: number): Promise<void> { await this.call("closed", [id, read, written]); }
  async event(id: string, event: "start" | "response" | "close" | "error", read = 0, written = 0, code?: string, route?: string): Promise<void> { await this.call("event", [id, event, read, written, code, route]); }
  async close(): Promise<void> { this.failed = true; await this.worker.terminate(); }
}

const stores = globalThis as typeof globalThis & { __mcpControlEvidence?: Map<string, AsyncControlEvidenceStore> };
export function controlEvidenceStore(side: "client" | "server"): AsyncControlEvidenceStore {
  const filename = statePath(`mcp-http-${side}.sqlite`);
  const cache = stores.__mcpControlEvidence ??= new Map();
  // One root per serving process. Tests use explicit stores for other roots.
  let store = cache.get(filename);
  if (!store) {
    if (cache.size >= 2) { for (const old of cache.values()) void old.close(); cache.clear(); }
    store = new AsyncControlEvidenceStore(filename);
    cache.set(filename, store);
  }
  return store;
}
