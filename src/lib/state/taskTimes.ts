import type { Database } from "bun:sqlite";

function columnNames(db: Database, table: "state_rows" | "task_time_pending"): Set<string> {
  // Schema probes run once per initialization. Keep them out of Bun's bounded
  // query cache and release their statements before the connection is closed.
  const statement = db.prepare<{ name: string }, []>(`PRAGMA table_info(${table})`);
  try { return new Set(statement.all().map(row => row.name)); }
  finally { statement.finalize(); }
}

/** Exact instants are derived from authoritative text in the writer's
 * transaction. Older writers queue their changes through these triggers too. */
export function installTaskTimes(db: Database): void {
  const columns = columnNames(db, "state_rows");
  const timeColumns = ["task_due_ms", "task_hold_ms", "task_updated_ms"];
  const missingTimeColumns = timeColumns.filter(column => !columns.has(column));
  for (const column of missingTimeColumns) db.exec(`ALTER TABLE state_rows ADD COLUMN ${column} INTEGER`);
  const pendingColumns = columnNames(db, "task_time_pending");
  const rebuildPending = pendingColumns.size === 0 || !pendingColumns.has("queue_id");
  if (pendingColumns.size && rebuildPending) db.exec("DROP TABLE task_time_pending");
  db.exec("CREATE TABLE IF NOT EXISTS task_time_pending(queue_id INTEGER PRIMARY KEY AUTOINCREMENT, row_key TEXT NOT NULL UNIQUE)");
  db.exec("DROP TRIGGER IF EXISTS task_time_insert; DROP TRIGGER IF EXISTS task_time_update;");
  for (const event of ["INSERT", "UPDATE OF value_json,collection,row_key"]) {
    const name = event.startsWith("INSERT") ? "insert" : "update";
    db.exec(`CREATE TRIGGER IF NOT EXISTS task_time_${name} AFTER ${event} ON state_rows
      WHEN NEW.collection='tasks' BEGIN
        DELETE FROM task_time_pending WHERE row_key=NEW.row_key;
        INSERT INTO task_time_pending(row_key) VALUES (NEW.row_key);
      END`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS task_time_delete AFTER DELETE ON state_rows
    WHEN OLD.collection='tasks' BEGIN DELETE FROM task_time_pending WHERE row_key=OLD.row_key; END`);
  if (rebuildPending || missingTimeColumns.length) db.exec("INSERT OR IGNORE INTO task_time_pending(row_key) SELECT row_key FROM state_rows WHERE collection='tasks'");
}

export function taskTimesReady(db: Database): boolean {
  return !db.query("SELECT 1 FROM task_time_pending LIMIT 1").get();
}

/** Current queue watermark for the task-time trigger table, or null when the
 * database predates `task_time_pending`. Cached via `db.query` once present. */
export function taskTimePendingCursor(db: Database): number | null {
  try {
    return db.query<{ rowid: number }, []>("SELECT COALESCE(MAX(rowid), 0) AS rowid FROM task_time_pending").get()!.rowid;
  } catch {
    return null;
  }
}

/** A key page is committed with its values. Interrupted preparation resumes
 * from the durable queue, without changing the task or its revision. */
export function prepareTaskTimes(db: Database, limit = 128, afterRowid = 0): boolean {
  const rows = db.query<{ row_key: string; due: string | null; held: string | null; updated: string | null }, [number, number]>(`
    SELECT p.row_key,
      CASE WHEN json_valid(r.value_json) THEN json_extract(r.value_json,'$.dueAt') END AS due,
      CASE WHEN json_valid(r.value_json) THEN json_extract(r.value_json,'$.hold.until') END AS held,
      CASE WHEN json_valid(r.value_json) THEN json_extract(r.value_json,'$.updatedAt') END AS updated
    FROM task_time_pending p LEFT JOIN state_rows r ON r.collection='tasks' AND r.row_key=p.row_key
    WHERE p.rowid > ? ORDER BY p.rowid LIMIT ?`).all(afterRowid, limit);
  if (rows.length === 0) return afterRowid === 0 ? true : !db.query<{ pending: number }, [number]>("SELECT 1 AS pending FROM task_time_pending WHERE rowid > ? LIMIT 1").get(afterRowid);
  const instant = (text: unknown) => {
    const ms = typeof text === "string" ? Date.parse(text) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const update = db.query("UPDATE state_rows SET task_due_ms=?,task_hold_ms=?,task_updated_ms=? WHERE collection='tasks' AND row_key=?");
  const done = db.query("DELETE FROM task_time_pending WHERE row_key=?");
  for (const row of rows) {
    update.run(instant(row.due), instant(row.held), instant(row.updated), row.row_key);
    done.run(row.row_key);
  }
  if (afterRowid === 0) return taskTimesReady(db);
  return !db.query<{ pending: number }, [number]>("SELECT 1 AS pending FROM task_time_pending WHERE rowid > ? LIMIT 1").get(afterRowid);
}
