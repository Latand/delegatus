import type { Database } from "bun:sqlite";
import { declaredIndexes } from "@/lib/state/declaredIndexes";

const indexes = declaredIndexes([`CREATE INDEX IF NOT EXISTS retention_sources_expiry ON retention_sources(expiresAt DESC)
  WHERE eligible=1 AND unattributed=0 AND expiresAt IS NOT NULL`]);

/** Incremental byte sums in seven radix levels. Each prefix reads at most
 * 255 buckets per level, regardless of the number of retained paths. Old
 * ledgers populate the index through two durable, bounded keyset cursors. */
export class AttemptRetentionReporting {
  constructor(private db: Database, directory: string) {
    db.transaction(() => {
      indexes.assertRepairAuthority(db, directory);
      db.exec(`CREATE TABLE IF NOT EXISTS retention_sources (
        source TEXT NOT NULL, entry TEXT NOT NULL, bytes REAL NOT NULL,
        expiresAt REAL, unattributed INTEGER NOT NULL, eligible INTEGER NOT NULL,
        PRIMARY KEY(source,entry));
        CREATE TABLE IF NOT EXISTS retention_buckets (
          level INTEGER NOT NULL, slot INTEGER NOT NULL, bytes REAL NOT NULL, PRIMARY KEY(level,slot));
        CREATE TABLE IF NOT EXISTS retention_unattributed (id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL, bytes REAL NOT NULL);
        INSERT OR IGNORE INTO retention_unattributed VALUES(1,0,0);
        CREATE TABLE IF NOT EXISTS retention_backfill (source TEXT PRIMARY KEY, cursor TEXT NOT NULL, done INTEGER NOT NULL);
        INSERT OR IGNORE INTO retention_backfill VALUES('root','',0),('copy','',0);
        CREATE TABLE IF NOT EXISTS copy_eligibility(destination TEXT PRIMARY KEY, eligible INTEGER NOT NULL);`);
      indexes.install(db, directory);
      const contribution = (row: string, sign: number) => {
        // Ceil to integer milliseconds without optional SQLite math extensions.
        const timestamp = `min(9007199254740991,max(0,CAST(${row}.expiresAt AS INTEGER)+(${row}.expiresAt>CAST(${row}.expiresAt AS INTEGER))))`;
        return Array.from({ length: 7 }, (_, level) => `
          INSERT INTO retention_buckets(level,slot,bytes)
            SELECT ${level},CAST((${timestamp})/${256 ** level} AS INTEGER),${sign}*${row}.bytes
            WHERE ${row}.eligible=1 AND ${row}.unattributed=0 AND ${row}.expiresAt IS NOT NULL
            ON CONFLICT(level,slot) DO UPDATE SET bytes=bytes+excluded.bytes;
          DELETE FROM retention_buckets WHERE level=${level} AND slot=CAST((${timestamp})/${256 ** level} AS INTEGER) AND bytes=0;`).join("") + `
          UPDATE retention_unattributed SET count=count+${sign}*${row}.unattributed,
            bytes=bytes+${sign}*${row}.unattributed*${row}.bytes WHERE id=1;`;
      };
      db.exec(`CREATE TRIGGER IF NOT EXISTS retention_source_insert AFTER INSERT ON retention_sources BEGIN ${contribution("NEW", 1)} END;
        CREATE TRIGGER IF NOT EXISTS retention_source_delete AFTER DELETE ON retention_sources BEGIN ${contribution("OLD", -1)} END;
        CREATE TRIGGER IF NOT EXISTS retention_source_update AFTER UPDATE ON retention_sources BEGIN ${contribution("OLD", -1)} ${contribution("NEW", 1)} END;`);
      const root = (key: string) => `INSERT INTO retention_sources
        SELECT 'root',r.directory,r.bytes,t.expiresAt,0,1 FROM roots r
        LEFT JOIN root_retention t ON t.directory=r.directory WHERE r.directory=${key}
        ON CONFLICT(source,entry) DO UPDATE SET bytes=excluded.bytes,expiresAt=excluded.expiresAt
          WHERE retention_sources.bytes IS NOT excluded.bytes OR retention_sources.expiresAt IS NOT excluded.expiresAt;`;
      const copy = (key: string) => `INSERT INTO retention_sources
        SELECT 'copy',c.destination,c.bytes,c.expiresAt,c.kind='unattributed',coalesce(e.eligible,1)
        FROM copies c LEFT JOIN copy_eligibility e ON e.destination=c.destination WHERE c.destination=${key}
        ON CONFLICT(source,entry) DO UPDATE SET bytes=excluded.bytes,expiresAt=excluded.expiresAt,
          unattributed=excluded.unattributed,eligible=excluded.eligible
          WHERE retention_sources.bytes IS NOT excluded.bytes OR retention_sources.expiresAt IS NOT excluded.expiresAt
            OR retention_sources.unattributed<>excluded.unattributed OR retention_sources.eligible<>excluded.eligible;`;
      for (const [table, key, source, refresh] of [
        ["roots", "directory", "root", root], ["root_retention", "directory", "root", root],
        ["copies", "destination", "copy", copy], ["copy_eligibility", "destination", "copy", copy],
      ] as const) {
        for (const event of ["INSERT", "UPDATE", "DELETE"]) {
          const keyRef = `${event === "DELETE" ? "OLD" : "NEW"}.${key}`;
          const sql = event === "DELETE" && (table === "roots" || table === "copies")
            ? `DELETE FROM retention_sources WHERE source='${source}' AND entry=${keyRef};`
            : refresh(keyRef);
          const columns = table === "roots" ? "bytes" : table === "root_retention" ? "expiresAt"
            : table === "copies" ? "bytes,expiresAt,kind" : "eligible";
          db.exec(`CREATE TRIGGER IF NOT EXISTS retention_${table}_${event.toLowerCase()} AFTER ${event === "UPDATE" ? `UPDATE OF ${columns}` : event} ON ${table} BEGIN ${sql} END;`);
        }
      }
    })();
  }

  backfill(now: () => number, deadline: number) {
    for (const [source, table, key] of [["root", "roots", "directory"], ["copy", "copies", "destination"]] as const) {
      if (now() >= deadline) return;
      this.db.transaction(() => {
        const cursor = this.db.query<{ cursor: string; done: number }, [string]>("SELECT cursor,done FROM retention_backfill WHERE source=?").get(source)!;
        if (cursor.done) return;
        const rows = this.db.query<{ entry: string }, [string]>(`SELECT ${key} AS entry FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT 32`).all(cursor.cursor);
        for (const { entry } of rows) {
          if (now() >= deadline) return;
          if (source === "root") this.db.query(`INSERT INTO retention_sources
            SELECT 'root',r.directory,r.bytes,t.expiresAt,0,1 FROM roots r LEFT JOIN root_retention t USING(directory)
            WHERE r.directory=? ON CONFLICT(source,entry) DO NOTHING`).run(entry);
          else this.db.query(`INSERT INTO retention_sources
            SELECT 'copy',c.destination,c.bytes,c.expiresAt,c.kind='unattributed',coalesce(e.eligible,1)
            FROM copies c LEFT JOIN copy_eligibility e ON e.destination=c.destination
            WHERE c.destination=? ON CONFLICT(source,entry) DO NOTHING`).run(entry);
          this.db.query("UPDATE retention_backfill SET cursor=? WHERE source=?").run(entry, source);
        }
        if (rows.length < 32) this.db.query("UPDATE retention_backfill SET done=1 WHERE source=?").run(source);
      })();
    }
  }

  private prefix(until: number) {
    const end = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(until)) + 1;
    if (end <= 0) return 0;
    let start = 0, bytes = 0;
    for (let level = 6; level >= 0; level--) {
      const size = 256 ** level, low = Math.floor(start / size), high = Math.floor(end / size);
      if (high > low) bytes += this.db.query<{ bytes: number }, [number, number, number]>(`SELECT coalesce(sum(bytes),0) AS bytes FROM (
        SELECT bytes FROM retention_buckets WHERE level=? AND slot>=? AND slot<? LIMIT 256)`).get(level, low, high)!.bytes;
      start = high * size;
    }
    return bytes;
  }
  retention(now: number, retentionMs: number) {
    const dueBytes = this.prefix(now), upcomingBytes = this.prefix(now + retentionMs) - dueBytes;
    const until = this.db.query<{ expiresAt: number }, [number]>(`SELECT expiresAt FROM retention_sources
      WHERE eligible=1 AND unattributed=0 AND expiresAt IS NOT NULL AND expiresAt<=? ORDER BY expiresAt DESC LIMIT 1`).get(now + retentionMs)?.expiresAt ?? null;
    const pending = !!this.db.query("SELECT 1 FROM retention_backfill WHERE done=0 LIMIT 1").get();
    return { periodDays: retentionMs / 86400000, dueBytes, upcomingBytes, until, partial: pending };
  }
  unattributed() {
    return this.db.query<{ count: number; bytes: number }, []>("SELECT count,bytes FROM retention_unattributed WHERE id=1").get()!;
  }
}
