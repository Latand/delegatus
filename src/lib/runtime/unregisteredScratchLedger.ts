import type { Database } from "bun:sqlite";

/** The free-space readings of the last twenty minutes: one per minute tick. */
export const UNREGISTERED_SAMPLE_LIMIT = 41;
export type FreeSample = { at: number; freeBytes: number };
export type UnregisteredSkip = { name: string; reason: string; code: string; retryAt: number; at: number; bytes: number };
/** Where an unfinished tree walk stands: what it saw so far and what it still has to read. */
export type WalkCursor = {
  identity: string; startedAt: number; newestMs: number; bytes: number; entries: number;
  /** Directories still to read, last first. */
  pending: string[];
  /** The directory being read, and how many of its sorted names are done. */
  current: { directory: string; skip: number; mtimeMs: number } | null;
};
const validCursor = (value: unknown): value is WalkCursor => {
  const cursor = value as WalkCursor | null;
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  return !!cursor && typeof cursor === "object" && typeof cursor.identity === "string" && finite(cursor.startedAt) && finite(cursor.newestMs)
    && finite(cursor.bytes) && finite(cursor.entries) && Array.isArray(cursor.pending) && cursor.pending.every(item => typeof item === "string")
    && (cursor.current === null || typeof cursor.current === "object" && typeof cursor.current.directory === "string"
      && finite(cursor.current.skip) && finite(cursor.current.mtimeMs));
};
export type UnregisteredPassSummary = {
  at: number; trigger: "free-space" | "loss-rate" | null; mode: "on" | "dry-run"; freeBytes: number | null; lossBytes: number;
  found: number; examined: number; removed: number; removedBytes: number; observedFreedBytes: number; finishedInterrupted: number;
  kept: number; errors: number; deferred: string | null; elapsedMs: number;
};

/** What the unregistered-scratch pass remembers between ticks, in tables of the
 * attempt ledger's database that the ledger itself never reads: free-space
 * samples for the rate trigger, a retry time per kept root so a root that
 * cannot be removed never starves the next one, the removals this pass began
 * (so a crash leaves a tombstone only this pass finishes), and the last pass
 * with its running totals. Nothing here grants removal authority; every pass
 * repeats every proof. It uses its own connection, opened for one pass. */
export class UnregisteredScratchLedger {
  private constructor(private readonly db: Database) {
    db.exec("PRAGMA busy_timeout=0");
    db.exec("CREATE TABLE IF NOT EXISTS unregistered_scratch_removals(identity TEXT PRIMARY KEY, name TEXT NOT NULL, at REAL NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS unregistered_scratch_samples(at REAL PRIMARY KEY, freeBytes REAL NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS unregistered_scratch_skips(name TEXT PRIMARY KEY, reason TEXT NOT NULL, code TEXT NOT NULL,
      retryAt REAL NOT NULL, at REAL NOT NULL, bytes REAL NOT NULL DEFAULT 0)`);
    db.exec("CREATE TABLE IF NOT EXISTS unregistered_scratch_walks(name TEXT PRIMARY KEY, cursor TEXT NOT NULL, at REAL NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS unregistered_scratch_state(id INTEGER PRIMARY KEY CHECK(id=1),
      removedRoots INTEGER NOT NULL, removedBytes REAL NOT NULL, last TEXT)`);
    db.exec("INSERT OR IGNORE INTO unregistered_scratch_state VALUES(1,0,0,NULL)");
  }
  static open(filename: string): UnregisteredScratchLedger {
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("Unregistered scratch retention requires Bun");
    const db = new sqlite.Database(filename, { create: true });
    try { return new UnregisteredScratchLedger(db); }
    catch (error) { db.close(); throw error; }
  }
  close() { this.db.close(); }
  /** Durable intent, written before the tree is renamed to its tombstone. */
  beginRemoval(identity: string, name: string, at: number) {
    this.db.query("INSERT OR REPLACE INTO unregistered_scratch_removals VALUES(?,?,?)").run(identity, name, at);
  }
  endRemoval(identity: string) { this.db.query("DELETE FROM unregistered_scratch_removals WHERE identity=?").run(identity); }
  /** Directory identities (`dev:ino`) of the removals begun and not finished. */
  removals(): Array<{ identity: string; name: string }> {
    return this.db.query<{ identity: string; name: string }, []>("SELECT identity,name FROM unregistered_scratch_removals").all();
  }
  samples(): FreeSample[] {
    return this.db.query<FreeSample, []>("SELECT at,freeBytes FROM unregistered_scratch_samples ORDER BY at").all();
  }
  /** Records this tick's reading and drops readings older than the window. */
  recordSample(sample: FreeSample, windowMs: number) {
    this.db.transaction(() => {
      this.db.query("INSERT OR REPLACE INTO unregistered_scratch_samples VALUES(?,?)").run(sample.at, sample.freeBytes);
      this.db.query("DELETE FROM unregistered_scratch_samples WHERE at<?").run(sample.at - windowMs);
      this.db.query(`DELETE FROM unregistered_scratch_samples WHERE at NOT IN
        (SELECT at FROM unregistered_scratch_samples ORDER BY at DESC LIMIT ?)`).run(UNREGISTERED_SAMPLE_LIMIT);
    })();
  }
  /** Roots to leave alone until their retry time, by name. */
  waiting(now: number): Map<string, UnregisteredSkip> {
    return new Map(this.db.query<UnregisteredSkip, [number]>("SELECT * FROM unregistered_scratch_skips WHERE retryAt>?").all(now)
      .map(row => [row.name, row]));
  }
  skipped(name: string): UnregisteredSkip | null {
    return this.db.query<UnregisteredSkip, [string]>("SELECT * FROM unregistered_scratch_skips WHERE name=?").get(name);
  }
  /** Returns whether this reason is new for the root, so the journal records
   * each kept root once per reason and not once per tick. */
  skip(row: UnregisteredSkip): boolean {
    const prior = this.skipped(row.name);
    this.db.query("INSERT OR REPLACE INTO unregistered_scratch_skips VALUES(?,?,?,?,?,?)")
      .run(row.name, row.reason, row.code, row.retryAt, row.at, row.bytes);
    return prior?.code !== row.code;
  }
  clearSkip(name: string) { this.db.query("DELETE FROM unregistered_scratch_skips WHERE name=?").run(name); }
  /** Forgets a root that is gone, whatever removed it. */
  retainSkips(present: ReadonlySet<string>) {
    for (const { name } of this.db.query<{ name: string }, []>("SELECT name FROM unregistered_scratch_skips").all())
      if (!present.has(name)) this.clearSkip(name);
  }
  /** The unfinished tree walk of a root, so a tree larger than one pass's window is proven across passes. */
  walk(name: string): WalkCursor | null {
    const row = this.db.query<{ cursor: string }, [string]>("SELECT cursor FROM unregistered_scratch_walks WHERE name=?").get(name);
    if (!row) return null;
    try { const parsed = JSON.parse(row.cursor) as unknown; return validCursor(parsed) ? parsed : null; } catch { return null; }
  }
  saveWalk(name: string, cursor: WalkCursor, at: number) {
    this.db.query("INSERT OR REPLACE INTO unregistered_scratch_walks VALUES(?,?,?)").run(name, JSON.stringify(cursor), at);
  }
  clearWalk(name: string) { this.db.query("DELETE FROM unregistered_scratch_walks WHERE name=?").run(name); }
  retainWalks(present: ReadonlySet<string>) {
    for (const { name } of this.db.query<{ name: string }, []>("SELECT name FROM unregistered_scratch_walks").all())
      if (!present.has(name)) this.clearWalk(name);
  }
  skipSummary(): Array<{ code: string; count: number; bytes: number }> {
    return this.db.query<{ code: string; count: number; bytes: number }, []>(
      "SELECT code,count(*) AS count,sum(bytes) AS bytes FROM unregistered_scratch_skips GROUP BY code ORDER BY count DESC,code").all();
  }
  recordPass(summary: UnregisteredPassSummary) {
    // A finished interrupted removal is the one root a crashed pass began, counted once here.
    this.db.query("UPDATE unregistered_scratch_state SET removedRoots=removedRoots+?,removedBytes=removedBytes+?,last=? WHERE id=1")
      .run(summary.removed + summary.finishedInterrupted, summary.removedBytes, JSON.stringify(summary));
  }
  totals(): { removedRoots: number; removedBytes: number; last: UnregisteredPassSummary | null } {
    const row = this.db.query<{ removedRoots: number; removedBytes: number; last: string | null }, []>(
      "SELECT removedRoots,removedBytes,last FROM unregistered_scratch_state WHERE id=1").get()!;
    let last: UnregisteredPassSummary | null = null;
    try { last = row.last ? JSON.parse(row.last) as UnregisteredPassSummary : null; } catch { /* A damaged summary shows no last pass. */ }
    return { removedRoots: row.removedRoots, removedBytes: row.removedBytes, last };
  }
}
