import type { Database } from "bun:sqlite";

/** Companion scalars avoid rewriting the large entity records. Both indexes are
 * created while the new table is empty; backfill grows them a few rows at a time.
 * Triggers also cover a previous release writing during succession or rollback.
 * This is a storage migration version, independent of the snapshot wire version.
 */
export class SessionHostMetadata {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private initialized = false;
  private reportedError = false;
  ready = false;
  // This connection's metadata-only writes must not evict unchanged snapshots
  // while readers still use the expensive legacy selection during backfill.
  excludedChanges = 0;

  constructor(private readonly db: Database) {}

  start(): void { this.schedule(0); }
  close(): void { clearTimeout(this.timer); }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      try {
        this.step();
        this.reportedError = false;
        if (!this.ready) this.schedule(1);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED" && !this.reportedError) {
          console.error("[runtime host] session metadata migration deferred", error);
          this.reportedError = true;
        }
        // Legacy selection remains authoritative until the durable completion
        // marker commits. Lock contention never waits on the host's event loop.
        this.schedule(250);
      }
    }, delay);
    this.timer.unref();
  }

  /** At most 32 rows / 4 ms of cooperative work per transaction. A single row
   * and COMMIT are indivisible; there is no hard I/O latency promise. No entity
   * body is rewritten, and the cursor commits with the metadata it describes.
   */
  step(): void {
    const changes = this.totalChanges();
    const timeout = this.db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout;
    this.db.exec("PRAGMA busy_timeout = 0");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!this.initialized) this.install();
        const read = this.db.query<{ value: string }, [string]>("SELECT value FROM journal_meta WHERE key = ?");
        if (read.get("session_host_metadata_ready")?.value === "1") {
          this.db.exec("COMMIT");
          this.ready = true;
          this.initialized = true;
          return;
        }
        let cursor = read.get("session_host_metadata_cursor")?.value ?? null;
        const next = this.db.query<{ id: string }, [string]>(
          "SELECT id FROM entities WHERE kind = 'session' AND id > ? ORDER BY id LIMIT 1",
        );
        const first = this.db.query<{ id: string }, []>(
          "SELECT id FROM entities WHERE kind = 'session' ORDER BY id LIMIT 1",
        );
        const copy = this.db.query(`INSERT INTO session_host_metadata(id, host, inactive, checkpoint_seq, updated_at)
          SELECT id, json_extract(state_json, '$.host'),
            CASE WHEN json_extract(state_json, '$.host') IN ('dead', 'unhosted') THEN 1 ELSE 0 END,
            checkpoint_seq, updated_at FROM entities WHERE kind = 'session' AND id = ?
          ON CONFLICT(id) DO UPDATE SET host = excluded.host, inactive = excluded.inactive,
            checkpoint_seq = excluded.checkpoint_seq, updated_at = excluded.updated_at`);
        const started = performance.now();
        let complete = false;
        for (let rows = 0; rows < 32; rows++) {
          const row = cursor === null ? first.get() : next.get(cursor);
          if (!row) { complete = true; break; }
          copy.run(row.id);
          cursor = row.id;
          if (performance.now() - started >= 4) break;
        }
        if (cursor !== null) this.set("session_host_metadata_cursor", cursor);
        if (complete) this.set("session_host_metadata_ready", "1");
        this.db.exec("COMMIT");
        this.initialized = true;
        this.ready = complete;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.excludedChanges += this.totalChanges() - changes;
      this.db.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
  }

  private totalChanges(): number {
    return this.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  }

  private set(key: string, value: string): void {
    this.db.query("INSERT INTO journal_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private install(): void {
    const version = this.db.query<{ value: string }, []>(
      "SELECT value FROM journal_meta WHERE key = 'session_host_metadata_schema_version'",
    ).get()?.value;
    if (version === "1") return;
    if (version !== undefined) throw new Error("unsupported session metadata schema version");
    this.db.exec(`
      CREATE TABLE session_host_metadata (
        id TEXT PRIMARY KEY, host, inactive INTEGER NOT NULL,
        checkpoint_seq INTEGER NOT NULL, updated_at INTEGER
      );
      CREATE INDEX session_host_activity ON session_host_metadata(inactive, id, updated_at);
      CREATE INDEX session_host_inactive_recency ON session_host_metadata(checkpoint_seq DESC, id DESC) WHERE inactive = 1;
      CREATE TRIGGER session_host_insert AFTER INSERT ON entities WHEN NEW.kind = 'session' BEGIN
        INSERT INTO session_host_metadata(id, host, inactive, checkpoint_seq, updated_at)
        VALUES (NEW.id, json_extract(NEW.state_json, '$.host'),
          CASE WHEN json_extract(NEW.state_json, '$.host') IN ('dead', 'unhosted') THEN 1 ELSE 0 END,
          NEW.checkpoint_seq, NEW.updated_at)
        ON CONFLICT(id) DO UPDATE SET host = excluded.host, inactive = excluded.inactive,
          checkpoint_seq = excluded.checkpoint_seq, updated_at = excluded.updated_at;
      END;
      CREATE TRIGGER session_host_update AFTER UPDATE OF kind, id, state_json, checkpoint_seq, updated_at ON entities
        WHEN OLD.kind = 'session' OR NEW.kind = 'session' BEGIN
        DELETE FROM session_host_metadata WHERE OLD.kind = 'session' AND id = OLD.id;
        INSERT INTO session_host_metadata(id, host, inactive, checkpoint_seq, updated_at)
        SELECT NEW.id, json_extract(NEW.state_json, '$.host'),
          CASE WHEN json_extract(NEW.state_json, '$.host') IN ('dead', 'unhosted') THEN 1 ELSE 0 END,
          NEW.checkpoint_seq, NEW.updated_at WHERE NEW.kind = 'session'
        ON CONFLICT(id) DO UPDATE SET host = excluded.host, inactive = excluded.inactive,
          checkpoint_seq = excluded.checkpoint_seq, updated_at = excluded.updated_at;
      END;
      CREATE TRIGGER session_host_delete AFTER DELETE ON entities WHEN OLD.kind = 'session' BEGIN
        DELETE FROM session_host_metadata WHERE id = OLD.id;
      END;
    `);
    this.set("session_host_metadata_schema_version", "1");
  }
}

// CROSS JOIN keeps the compact metadata as the outer loop even before SQLite
// has planner statistics. Only selected bodies are fetched from entities.
export const SESSION_HOST_ACTIVE_FROM = `FROM session_host_metadata AS metadata INDEXED BY session_host_activity
  CROSS JOIN entities ON entities.kind = 'session' AND entities.id = metadata.id
  WHERE metadata.inactive = 0 ORDER BY metadata.id`;
export const SESSION_HOST_INACTIVE_FROM = `FROM session_host_metadata AS metadata INDEXED BY session_host_inactive_recency
  CROSS JOIN entities ON entities.kind = 'session' AND entities.id = metadata.id
  WHERE metadata.inactive = 1 ORDER BY metadata.checkpoint_seq DESC, metadata.id DESC LIMIT ?`;
export const SESSION_HOST_TERMINAL = `SELECT id, updated_at AS last_changed_at
  FROM session_host_metadata INDEXED BY session_host_activity WHERE inactive = 1`;
export const SESSION_HOST_EXPIRY = `SELECT MIN(session.updated_at + ? + 1) AS expires_at
  FROM entities AS edge
  JOIN session_host_metadata AS session ON session.id = json_extract(edge.state_json, '$.childConversationId')
  WHERE edge.kind = 'edge' AND session.inactive = 1 AND session.updated_at + ? >= ?`;
