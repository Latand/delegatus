import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { assertNotOperatorStateUnderTest } from "@/lib/stateOwnership";

export type TemporaryDataKind = "lane-evidence" | "agent-evidence" | "journal" | "ownerless-copy";
export type TemporaryDataCandidate = {
  directory: string; scope: string; kind: TemporaryDataKind; owner: string;
  identity: string; adoptedAt: number; checkedAt: number; bytes: number; reason: string;
};
export type TemporaryNamespace = { directory: string; kind: string; owner: string; cursor: string; checkedAt: number };

/** Only discovery and bounded due pages are read on a tick. Identity replacement
 * starts a fresh adoption clock; an outstanding intent is never rebound. */
export class TemporaryDataStore {
  private db: Database;
  constructor(readonly filename = statePath("temporary-data.sqlite")) {
    assertNotOperatorStateUnderTest(path.dirname(filename), "temporary data retention");
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
    this.db = new sqlite.Database(filename, { create: true });
    this.db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS candidates (
      directory TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL,
      identity TEXT NOT NULL, adoptedAt REAL NOT NULL, checkedAt REAL NOT NULL, bytes REAL NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS candidates_due ON candidates(checkedAt,directory);
      CREATE TABLE IF NOT EXISTS namespaces(directory TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT NOT NULL,cursor TEXT NOT NULL,checkedAt REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS namespaces_due ON namespaces(checkedAt,directory);
      CREATE TABLE IF NOT EXISTS agent_bindings(hash TEXT PRIMARY KEY,launchId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
    fs.chmodSync(filename, 0o600);
  }
  close() { this.db.close(); }
  get(directory: string) { return this.db.query<TemporaryDataCandidate, [string]>("SELECT * FROM candidates WHERE directory=?").get(directory); }
  register(row: TemporaryDataCandidate) {
    const prior = this.get(row.directory);
    if (prior?.identity === row.identity) return;
    this.db.query("INSERT OR REPLACE INTO candidates VALUES(?,?,?,?,?,?,?,?,?)")
      .run(row.directory, row.scope, row.kind, row.owner, row.identity, row.adoptedAt, row.checkedAt, row.bytes, row.reason);
  }
  due(now: number, limit = 8) {
    return this.db.query<TemporaryDataCandidate, [number, number]>("SELECT * FROM candidates WHERE checkedAt<=? ORDER BY checkedAt,directory LIMIT ?").all(now, limit);
  }
  record(directory: string, checkedAt: number, bytes: number, reason: string) {
    this.db.query("UPDATE candidates SET checkedAt=?,bytes=?,reason=? WHERE directory=?").run(checkedAt, bytes, reason, directory);
  }
  forget(directory: string) { this.db.query("DELETE FROM candidates WHERE directory=?").run(directory); }
  namespace(directory: string, kind: string, owner = "") {
    this.db.query("INSERT OR IGNORE INTO namespaces VALUES(?,?,?,'',0)").run(directory, kind, owner);
  }
  namespaces(now: number, limit = 4) {
    return this.db.query<TemporaryNamespace, [number, number]>("SELECT * FROM namespaces WHERE checkedAt<=? ORDER BY checkedAt,directory LIMIT ?").all(now, limit);
  }
  checkpoint(row: TemporaryNamespace) {
    this.db.query("UPDATE namespaces SET cursor=?,checkedAt=? WHERE directory=?").run(row.cursor, row.checkedAt, row.directory);
  }
  agent(hash: string) { return this.db.query<{ launchId: string }, [string]>("SELECT launchId FROM agent_bindings WHERE hash=?").get(hash)?.launchId; }
  bindAgent(hash: string, launchId: string) {
    this.db.query("INSERT INTO agent_bindings VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET launchId=CASE WHEN launchId=excluded.launchId THEN launchId ELSE '' END").run(hash, launchId);
  }
  meta(key: string) { return this.db.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key=?").get(key)?.value; }
  setMeta(key: string, value: string) { this.db.query("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(key, value); }
}
