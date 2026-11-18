import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { statePath } from "../configDir";

export type ProtectionMarker = { version: string; content?: Buffer };
const filename = (directory: string) => statePath("attempt-protection", createHash("sha256").update(directory).digest("hex") + ".sqlite");
export function forgetAttemptProtection(directory: string) {
  fs.rmSync(filename(directory), { force: true });
}

/** Durable traversal work, never deletion authority. Completed rows are
 * revalidated under the ordinary mutation fence before any unlink. Each
 * directory's children and completion commit together; an interrupted reader
 * can repeat that directory without losing its already completed siblings. */
export class AttemptProtectionInventory {
  private db: Database;
  static exists(directory: string) { return fs.existsSync(filename(directory)); }
  constructor(private directory: string, version: string) {
    const file = filename(directory);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true });
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048; CREATE TABLE IF NOT EXISTS binding(version TEXT); CREATE TABLE IF NOT EXISTS directories(file TEXT PRIMARY KEY, version TEXT, readable INTEGER); CREATE TABLE IF NOT EXISTS markers(file TEXT PRIMARY KEY, version TEXT NOT NULL, content BLOB); CREATE INDEX IF NOT EXISTS pending ON directories(file) WHERE version IS NULL");
    const old = this.db.query<{ version: string }, []>("SELECT version FROM binding").get();
    if (old?.version !== version) this.db.transaction(() => {
      this.db.exec("DELETE FROM directories; DELETE FROM markers; DELETE FROM binding");
      this.db.query("INSERT INTO binding VALUES(?)").run(version);
      this.db.query("INSERT INTO directories VALUES(?,NULL,NULL)").run(directory);
    })();
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
      this.db.query("INSERT OR REPLACE INTO directories VALUES(?,?,?)").run(file, version, Number(readable));
      const marker = this.db.query("INSERT OR REPLACE INTO markers VALUES(?,?,?)");
      for (const [file, row] of markers) marker.run(file, row.version, row.content ?? null);
    })();
  }
  seed(directories: ReadonlyMap<string, string>, readable: readonly string[], markers: ReadonlyMap<string, ProtectionMarker>, pending: readonly string[]) {
    this.db.transaction(() => {
      const insert = this.db.query("INSERT OR IGNORE INTO directories VALUES(?,NULL,NULL)");
      for (const file of pending) insert.run(file);
      const read = new Set(readable);
      for (const [file, version] of directories) this.record(file, version, read.has(file), [], new Map());
      for (const [file, row] of markers) this.db.query("INSERT OR REPLACE INTO markers VALUES(?,?,?)").run(file, row.version, row.content ?? null);
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
  discard() { this.close(); forgetAttemptProtection(this.directory); }
}
