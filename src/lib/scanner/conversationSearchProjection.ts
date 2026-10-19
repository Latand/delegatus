import type { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { stateDatabaseBusy, StateLockDeferredError, waitForStateLock } from "@/lib/state/lockWait";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { catalogEntryToFileEntry, type ConversationCatalogEntry } from "./conversationCatalog";
import { conversationSearchText, type ConversationSearchText } from "./describe";
import { HEAD_READ_CHUNK_BYTES } from "./head";

const BATCH = 24;
const MAX_ENTRIES = 50_000;
const MAX_BYTES = 512 * 1024 * 1024;
const WAIT_MS = 4_000;
const SEARCH_MS = 11_000;
const PREPARE_MS = 120_000;
type Entry = ConversationCatalogEntry;
type Metadata = { path: string; size: number; mtime: number; engine: string; sourceTitle: string; kind: string; title: string; displayed: string; project: string };
type Hydrated = { entry: Entry; text: ConversationSearchText };
class ProjectionChanged extends Error {}

export function conversationSearchMatchSql(count: number): string {
  return `SELECT path,size,mtime,engine,sourceTitle,kind,title,displayed,project,
    NOT EXISTS(SELECT 1 FROM json_each(?) AS term WHERE instr(displayFold || char(10) || promptFold || char(10) || projectFold,term.value)=0) AS matched
    FROM texts WHERE path IN (${Array.from({ length: count }, () => "?").join(",")})`;
}

async function readText(entry: Entry): Promise<ConversationSearchText> {
  let file;
  try {
    file = await fs.open(entry.path, "r");
    const buffer = Buffer.alloc(Math.min(entry.size, HEAD_READ_CHUNK_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return withViewerOperation("catalog.search", () => conversationSearchText(buffer.toString("utf8", 0, bytesRead), entry.engine));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { title: null, firstPrompt: null };
    throw error;
  } finally { await file?.close(); }
}

/** Derived text only: never an authority for catalog membership or ownership.
 * Reads decode at most one metadata batch; prompt strings stay in SQLite.
 * Every scope is filtered before it reaches this store. Eviction happens after
 * matching a batch, so even a corpus larger than the cache stays complete. */
export class ConversationSearchProjection {
  private db?: Database;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private retiring = false;
  private preparation?: Promise<void>;
  private preparationFailure?: unknown;
  constructor(private filename: string, private limits = { entries: MAX_ENTRIES, bytes: MAX_BYTES }) {}

  search(catalog: readonly Entry[], query: string, options: {
    signal?: AbortSignal;
    projectTitle?: (entry: FileEntry) => void;
    readText?: (entry: Entry) => Promise<ConversationSearchText>;
    prepareOnly?: boolean;
  } = {}): Promise<Entry[]> {
    if (this.retiring) return Promise.reject(new Error("conversation search projection retired"));
    if (this.pending >= 64) return Promise.reject(new Error("conversation search queue is full"));
    this.pending++;
    const signal = AbortSignal.any([AbortSignal.timeout(options.prepareOnly ? PREPARE_MS : SEARCH_MS), ...(options.signal ? [options.signal] : [])]);
    let started = false;
    const result = this.tail.then(() => withViewerOperation("catalog.search", async () => {
      started = true;
      signal.throwIfAborted();
      if (!options.prepareOnly && this.preparation) await this.preparation;
      if (!options.prepareOnly && this.preparationFailure) throw this.preparationFailure;
      await this.open(signal);
      this.db!.exec("CREATE TEMP TABLE IF NOT EXISTS search_unvisited(path TEXT PRIMARY KEY)");
      this.db!.exec("DELETE FROM search_unvisited");
      for (let offset = 0; offset < catalog.length; offset += 500) {
        const paths = catalog.slice(offset, offset + 500).map(entry => entry.path);
        this.db!.query(`INSERT OR IGNORE INTO search_unvisited(path) VALUES ${paths.map(() => "(?)").join(",")}`).run(...paths);
      }
      const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches: Entry[] = [];
      for (let start = 0; start < catalog.length; start += BATCH) {
        signal.throwIfAborted();
        try {
          const batch = catalog.slice(start, start + BATCH);
          const placeholders = batch.map(() => "?").join(",");
          const previous = new Map(this.db!.query<Metadata, string[]>(`SELECT path,size,mtime,engine,sourceTitle,kind,title,displayed,project FROM texts WHERE path IN (${placeholders})`).all(...batch.map(entry => entry.path)).map(row => [row.path, row]));
          const hydration = await Promise.allSettled(batch.map(async entry => {
            const old = previous.get(entry.path);
            const valid = old && old.size === entry.size && old.mtime === entry.mtime && old.engine === entry.engine && old.sourceTitle === entry.title && old.kind === entry.kind;
            return valid ? null : { entry, text: await (options.readText ?? readText)(entry) };
          }));
          // Await every owned file read/close before rejecting a failed batch.
          const failure = hydration.find(result => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          const hydrated = hydration.map(result => (result as PromiseFulfilledResult<Hydrated | null>).value);
          signal.throwIfAborted();
          const changed = hydrated.filter((row): row is Hydrated => row !== null);
          const textByPath = new Map(changed.map(row => [row.entry.path, row.text]));
          const baseTitles = new Map<string, string>();
          const displayed = new Map<string, string>();
          for (const entry of batch) {
            const old = previous.get(entry.path);
            const text = textByPath.get(entry.path);
            const title = text ? (entry.kind === "session" && text.title ? cleanTitle(text.title, 120) : entry.title) : old!.title;
            baseTitles.set(entry.path, title);
            const display = catalogEntryToFileEntry({ ...entry, title });
            options.projectTitle?.(display);
            displayed.set(entry.path, display.title);
          }
          const changedPaths = new Set(changed.map(row => row.entry.path));
          const updated = batch.filter(entry => {
            const old = previous.get(entry.path);
            return !changedPaths.has(entry.path) && (old!.displayed !== displayed.get(entry.path) || old!.project !== entry.project);
          });
          const select = () => {
            const rows = this.db!.query<Metadata & { matched: number }, string[]>(conversationSearchMatchSql(batch.length)).all(JSON.stringify(terms), ...batch.map(entry => entry.path));
            // Another Viewer generation may have replaced a row while hydration
            // or async writer admission yielded. Validate in the same statement
            // that matches the text; never return that other version's result.
            const current = new Map(rows.map(row => [row.path, row]));
            for (const entry of batch) {
              const row = current.get(entry.path);
              if (!row || row.size !== entry.size || row.mtime !== entry.mtime || row.engine !== entry.engine || row.sourceTitle !== entry.title || row.kind !== entry.kind || row.displayed !== displayed.get(entry.path) || row.project !== entry.project) throw new ProjectionChanged();
            }
            const paths = new Set(rows.filter(row => row.matched).map(row => row.path));
            return batch.filter(entry => paths.has(entry.path)).map(entry => ({ ...entry, title: displayed.get(entry.path)!, firstPrompt: "" }));
          };
          if (changed.length || updated.length) {
              const found = await this.write(signal, () => {
              for (const { entry, text } of changed) {
                const title = baseTitles.get(entry.path)!;
                const prompt = (text.firstPrompt ?? "").toLocaleLowerCase();
                const display = displayed.get(entry.path)!;
                this.db!.query(`INSERT INTO texts(path,size,mtime,engine,sourceTitle,kind,title,displayed,project,displayFold,promptFold,projectFold,bytes,seq)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT sequence FROM meta)) ON CONFLICT(path) DO UPDATE SET
                  size=excluded.size,mtime=excluded.mtime,engine=excluded.engine,sourceTitle=excluded.sourceTitle,kind=excluded.kind,title=excluded.title,
                  displayed=excluded.displayed,project=excluded.project,displayFold=excluded.displayFold,promptFold=excluded.promptFold,projectFold=excluded.projectFold,bytes=excluded.bytes,seq=excluded.seq`)
                  .run(entry.path, entry.size, entry.mtime, entry.engine, entry.title, entry.kind, title, display, entry.project, display.toLocaleLowerCase(), prompt, entry.project.toLocaleLowerCase(), Buffer.byteLength(prompt) + 2 * Buffer.byteLength(entry.path + entry.title + title + display + entry.project) + 256);
                this.db!.exec("UPDATE meta SET sequence=sequence+1");
              }
              for (const entry of updated) {
                const display = displayed.get(entry.path)!;
                this.db!.query("UPDATE texts SET bytes=bytes+2*(length(CAST(? AS BLOB))-length(CAST(displayed AS BLOB))+length(CAST(? AS BLOB))-length(CAST(project AS BLOB))),displayed=?,displayFold=?,project=?,projectFold=? WHERE path=?")
                  .run(display, entry.project, display, display.toLocaleLowerCase(), entry.project, entry.project.toLocaleLowerCase(), entry.path);
              }
              const found = select();
              this.db!.query(`DELETE FROM search_unvisited WHERE path IN (${placeholders})`).run(...batch.map(entry => entry.path));
              this.trim();
              return found;
            });
            if (!options.prepareOnly) matches.push(...found);
          } else {
            this.db!.query(`DELETE FROM search_unvisited WHERE path IN (${placeholders})`).run(...batch.map(entry => entry.path));
            if (!options.prepareOnly) matches.push(...withViewerOperation("catalog.search", select));
          }
          // Hydration and SQLite both have bounded slices, even on a warm cache.
          await new Promise<void>(resolve => setImmediate(resolve));
        } catch (error) {
          if (!(error instanceof ProjectionChanged)) throw error;
          start -= BATCH;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      this.db!.exec("DELETE FROM search_unvisited");
      signal.throwIfAborted();
      return matches;
    })).finally(() => { this.pending--; });
    this.tail = result.catch(() => undefined);
    return new Promise((resolve, reject) => {
      const aborted = () => {
        // A queued cancellation answers immediately. An active batch first
        // closes all its owned reads, then rejects through result below.
        if (!started) { cleanup(); reject(signal.reason); }
      };
      const cleanup = () => signal.removeEventListener("abort", aborted);
      signal.addEventListener("abort", aborted, { once: true });
      void result.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signal.aborted) aborted();
    });
  }

  /** Catalog publication owns cold hydration. Foreground searches wait for this
   * bounded-batch worker, then query the persisted text without opening every
   * transcript on the request path. */
  prepare(catalog: readonly Entry[], options: {
    projectTitle?: (entry: FileEntry) => void;
    readText?: (entry: Entry) => Promise<ConversationSearchText>;
  } = {}): Promise<void> {
    if (this.retiring) return Promise.reject(new Error("conversation search projection retired"));
    if (this.preparation) return this.preparation;
    this.preparationFailure = undefined;
    const job = this.search(catalog, "\u0000", { ...options, prepareOnly: true }).then(() => undefined, error => {
      this.preparationFailure = error;
      throw error;
    });
    this.preparation = job;
    void job.then(
      () => { if (this.preparation === job) this.preparation = undefined; },
      () => { if (this.preparation === job) this.preparation = undefined; },
    );
    return job;
  }

  close(): void { this.db?.close(); this.db = undefined; }

  retire(): void {
    this.retiring = true;
    void this.tail.finally(() => this.close());
  }

  private async open(signal: AbortSignal): Promise<void> {
    if (this.db) return;
    assertStateStartupMutation(path.dirname(this.filename), "conversation search projection");
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    await waitForStateLock("catalog.search.open", () => {
      let db: Database | undefined;
      try {
        // Keep the Bun-only module out of Next's static import graph, as the
        // other first-party SQLite stores do.
        const Sqlite = (process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined)?.Database;
        if (!Sqlite) throw new Error("conversation search requires Bun SQLite");
        db = new Sqlite(this.filename, { create: true });
        db.exec("PRAGMA busy_timeout=0");
        db.exec("PRAGMA journal_mode=WAL");
        // This is a reconstructible projection, so a lost cache transaction
        // after power loss needs no synchronous flush on every small batch.
        db.exec("PRAGMA synchronous=NORMAL");
        // Bound allocated disk pages as well as the live text payload.
        db.exec("PRAGMA max_page_count=262144");
        const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
        if (version !== 0 && version !== 1) throw new Error("unsupported conversation search projection version");
        if (version === 1) {
          // Validate the persisted artifact without taking a writer lock.
          db.query("SELECT path,size,mtime,engine,sourceTitle,kind,title,displayed,project,displayFold,promptFold,projectFold,bytes,seq FROM texts LIMIT 0").all();
          if (db.query<{ count: number }, []>("SELECT count(*) AS count FROM meta WHERE rows>=0 AND bytes>=0 AND sequence>=0").get()!.count !== 1) throw new Error("invalid conversation search projection metadata");
          if (db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('text_eviction','text_insert','text_update','text_delete')").get()!.count !== 4) throw new Error("incomplete conversation search projection schema");
          this.db = db;
          return;
        }
        db.exec("BEGIN IMMEDIATE");
        db.exec("CREATE TABLE IF NOT EXISTS meta(rows INTEGER NOT NULL,bytes INTEGER NOT NULL,sequence INTEGER NOT NULL)");
        db.exec("INSERT INTO meta SELECT 0,0,0 WHERE NOT EXISTS (SELECT 1 FROM meta)");
        db.exec("CREATE TABLE IF NOT EXISTS texts(path TEXT PRIMARY KEY,size INTEGER,mtime REAL,engine TEXT,sourceTitle TEXT,kind TEXT,title TEXT,displayed TEXT,project TEXT,displayFold TEXT,promptFold TEXT,projectFold TEXT,bytes INTEGER,seq INTEGER)");
        db.exec("CREATE INDEX IF NOT EXISTS text_eviction ON texts(seq,path)");
        db.exec("CREATE TRIGGER IF NOT EXISTS text_insert AFTER INSERT ON texts BEGIN UPDATE meta SET rows=rows+1,bytes=bytes+NEW.bytes; END");
        db.exec("CREATE TRIGGER IF NOT EXISTS text_update AFTER UPDATE ON texts BEGIN UPDATE meta SET bytes=bytes+NEW.bytes-OLD.bytes; END");
        db.exec("CREATE TRIGGER IF NOT EXISTS text_delete AFTER DELETE ON texts BEGIN UPDATE meta SET rows=rows-1,bytes=bytes-OLD.bytes; END");
        db.exec("PRAGMA user_version=1");
        db.exec("COMMIT");
        this.db = db;
      } catch (error) {
        db?.close();
        if (stateDatabaseBusy(error)) throw new StateLockDeferredError("catalog.search.open");
        throw error;
      }
    }, { signal, waitMs: WAIT_MS });
  }

  private write<T>(signal: AbortSignal, work: () => T): Promise<T> {
    return waitForStateLock("catalog.search.update", () => withViewerOperation("catalog.search", () => {
      signal.throwIfAborted();
      try { this.db!.exec("BEGIN IMMEDIATE"); }
      catch (error) {
        if (stateDatabaseBusy(error)) throw new StateLockDeferredError("catalog.search.update");
        throw error;
      }
      try {
        const result = work();
        this.db!.exec("COMMIT");
        return result;
      } catch (error) { this.db!.exec("ROLLBACK"); throw error; }
    }), { signal, waitMs: WAIT_MS });
  }

  private trim(): void {
    for (;;) {
      const totals = this.db!.query<{ rows: number; bytes: number }, []>("SELECT rows,bytes FROM meta").get()!;
      if (totals.rows <= this.limits.entries && totals.bytes <= this.limits.bytes) return;
      const oldest = this.db!.query<{ path: string; bytes: number }, []>("SELECT path,bytes FROM texts WHERE path NOT IN (SELECT path FROM search_unvisited) ORDER BY seq,path LIMIT 24").all();
      let count = 0;
      for (const row of oldest) {
        if (totals.rows <= this.limits.entries && totals.bytes <= this.limits.bytes) break;
        totals.rows--; totals.bytes -= row.bytes; count++;
      }
      if (!count) return;
      this.db!.query("DELETE FROM texts WHERE path IN (SELECT path FROM texts WHERE path NOT IN (SELECT path FROM search_unvisited) ORDER BY seq,path LIMIT ?)").run(count);
    }
  }
}

const shared = globalThis as typeof globalThis & { __llvSearchProjection?: { filename: string; store: ConversationSearchProjection } };
export function conversationSearchProjection(): ConversationSearchProjection {
  const filename = path.join(stateDir(), "conversation-search-v1.sqlite");
  if (shared.__llvSearchProjection?.filename !== filename) {
    shared.__llvSearchProjection?.store.retire();
    shared.__llvSearchProjection = { filename, store: new ConversationSearchProjection(filename) };
  }
  return shared.__llvSearchProjection.store;
}
