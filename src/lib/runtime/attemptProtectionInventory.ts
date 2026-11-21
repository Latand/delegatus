import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { statePath } from "../configDir";

export type ProtectionMarker = { version: string; content?: Buffer };
const inventoryRoot = (original: string) => statePath("attempt-protection", createHash("sha256").update(original).digest("hex"));
const filename = (directory: string, original = directory) => path.join(inventoryRoot(original), directory === original ? "root.sqlite" : "quarantine.sqlite");
const openInventory = (file: string, readonly = false): Database => {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("Attempt protection inventory requires Bun");
  return new sqlite.Database(file, readonly ? { readonly: true } : { create: true });
};
export function forgetAttemptProtection(directory: string, original = directory) {
  if (directory === original) fs.rmSync(inventoryRoot(original), { recursive: true, force: true });
  else fs.rmSync(filename(directory, original), { force: true });
}

/** Durable traversal work, never deletion authority. Completed rows are
 * revalidated under the ordinary mutation fence before any unlink. Each
 * directory's children and completion commit together; an interrupted reader
 * can repeat that directory without losing its already completed siblings. */
export class AttemptProtectionInventory {
  private db: Database;
  static exists(directory: string, original = directory) { return fs.existsSync(filename(directory, original)); }
  constructor(private directory: string, version: string, private original = directory, checkBudget: () => void = () => {}) {
    this.admitted(directory);
    const file = filename(directory, original), binding = JSON.stringify([directory, version]);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = openInventory(file);
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048; CREATE TABLE IF NOT EXISTS binding(version TEXT); CREATE TABLE IF NOT EXISTS directories(file TEXT PRIMARY KEY, version TEXT, readable INTEGER); CREATE TABLE IF NOT EXISTS markers(file TEXT PRIMARY KEY, version TEXT NOT NULL, content BLOB); CREATE INDEX IF NOT EXISTS pending ON directories(file) WHERE version IS NULL");
    const old = this.db.query<{ version: string }, []>("SELECT version FROM binding").get();
    if (old?.version !== binding) this.db.transaction(() => {
      this.db.exec("DELETE FROM directories; DELETE FROM markers; DELETE FROM binding");
      this.db.query("INSERT INTO binding VALUES(?)").run(binding);
      this.db.query("INSERT INTO directories VALUES(?,NULL,NULL)").run(directory);
    })();
    try {
      if (old?.version !== binding && original !== directory) this.rebase(original, version, checkBudget);
    } catch (error) { this.db.close(); throw error; }
  }
  /** Quarantine changes the root name and ctime. Reuse only a completed
   * inventory of the same root with unchanged identity, mode and mtime;
   * snapshotAttemptProtection revalidates every rebased descendant and marker.
   * Traversal never restarts merely because the quarantine has a fresh name. */
  private rebase(original: string, version: string, checkBudget: () => void) {
    if (!AttemptProtectionInventory.exists(original)) return;
    const source = openInventory(filename(original), true);
    try {
      if (source.query("SELECT 1 FROM directories WHERE version IS NULL LIMIT 1").get()) return;
      const root = source.query<{ version: string }, [string]>("SELECT version FROM directories WHERE file=?").get(original);
      if (!root || root.version.split(":").slice(0, 4).join(":") !== version.split(":").slice(0, 4).join(":")) return;
      const target = (file: string) => {
        if (file !== original && !file.startsWith(original + path.sep)) throw new Error("protection inventory source escaped its root");
        return this.admitted(this.directory + file.slice(original.length));
      };
      this.db.transaction(() => {
        this.db.exec("DELETE FROM directories; DELETE FROM markers");
        const insert = this.db.query("INSERT INTO directories VALUES(?,?,?)");
        for (const row of source.query<{ file: string; version: string; readable: number }, []>("SELECT * FROM directories").iterate()) {
          checkBudget(); insert.run(target(row.file), row.file === original ? version : row.version, row.readable);
        }
        const marker = this.db.query("INSERT INTO markers VALUES(?,?,?)");
        for (const row of source.query<{ file: string; version: string; content: Uint8Array | null }, []>("SELECT * FROM markers").iterate()) {
          checkBudget(); marker.run(target(row.file), row.version, row.content);
        }
      })();
    } finally { source.close(); }
  }
  private admitted(file: string) {
    if (file !== this.directory && !file.startsWith(this.directory + path.sep)) throw new Error("protection inventory path escaped its root");
    if (path.resolve(file) !== file) throw new Error("protection inventory path is not canonical");
    return file;
  }
  pending() {
    const file = this.db.query<{ file: string }, []>("SELECT file FROM directories WHERE version IS NULL ORDER BY file LIMIT 1").get()?.file;
    return file === undefined ? undefined : this.admitted(file);
  }
  record(file: string, version: string, readable: boolean, children: readonly string[], markers: ReadonlyMap<string, ProtectionMarker>) {
    this.db.transaction(() => {
      const insert = this.db.query("INSERT OR IGNORE INTO directories VALUES(?,NULL,NULL)");
      for (const child of children) insert.run(this.admitted(child));
      this.db.query("INSERT OR REPLACE INTO directories VALUES(?,?,?)").run(this.admitted(file), version, Number(readable));
      const marker = this.db.query("INSERT OR REPLACE INTO markers VALUES(?,?,?)");
      for (const [file, row] of markers) marker.run(this.admitted(file), row.version, row.content ?? null);
    })();
  }
  seed(directories: ReadonlyMap<string, string>, readable: readonly string[], markers: ReadonlyMap<string, ProtectionMarker>, pending: readonly string[]) {
    this.db.transaction(() => {
      const insert = this.db.query("INSERT OR IGNORE INTO directories VALUES(?,NULL,NULL)");
      for (const file of pending) insert.run(this.admitted(file));
      const read = new Set(readable);
      for (const [file, version] of directories) this.record(file, version, read.has(file), [], new Map());
      for (const [file, row] of markers) this.db.query("INSERT OR REPLACE INTO markers VALUES(?,?,?)").run(this.admitted(file), row.version, row.content ?? null);
    })();
  }
  load(directories: Map<string, string>, readable: string[], markers: Map<string, ProtectionMarker>, checkBudget: () => void) {
    directories.clear(); readable.length = 0; markers.clear();
    for (const row of this.db.query<{ file: string; version: string; readable: number }, []>("SELECT * FROM directories").iterate()) {
      checkBudget(); this.admitted(row.file); directories.set(row.file, row.version); if (row.readable) readable.push(row.file);
    }
    for (const row of this.db.query<{ file: string; version: string; content: Uint8Array | null }, []>("SELECT * FROM markers").iterate()) {
      checkBudget(); this.admitted(row.file); markers.set(row.file, { version: row.version, content: row.content ? Buffer.from(row.content) : undefined });
    }
  }
  close() { this.db.close(); }
  discard() { this.close(); forgetAttemptProtection(this.directory, this.original); }
}
