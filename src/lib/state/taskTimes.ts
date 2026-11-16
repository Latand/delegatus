import type { Database } from "bun:sqlite";

/** Exact instants are derived from authoritative text in the writer's
 * transaction. Older writers queue their changes through these triggers too. */
export function installTaskTimes(db: Database): void {
  const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(state_rows)").all().map(row => row.name));
  const timeColumns = ["task_due_ms", "task_hold_ms", "task_updated_ms"];
  for (const column of timeColumns) {
    if (!columns.has(column)) db.exec(`ALTER TABLE state_rows ADD COLUMN ${column} INTEGER`);
  }
  db.exec("CREATE TABLE IF NOT EXISTS task_time_pending(row_key TEXT PRIMARY KEY)");
  for (const event of ["INSERT", "UPDATE OF value_json,collection,row_key"]) {
    const name = event.startsWith("INSERT") ? "insert" : "update";
    db.exec(`CREATE TRIGGER IF NOT EXISTS task_time_${name} AFTER ${event} ON state_rows
      WHEN NEW.collection='tasks' BEGIN
        INSERT OR IGNORE INTO task_time_pending VALUES (NEW.row_key);
      END`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS task_time_delete AFTER DELETE ON state_rows
    WHEN OLD.collection='tasks' BEGIN DELETE FROM task_time_pending WHERE row_key=OLD.row_key; END`);
  if (timeColumns.some(column => !columns.has(column))) db.exec("INSERT OR IGNORE INTO task_time_pending SELECT row_key FROM state_rows WHERE collection='tasks'");
}

export function taskTimesReady(db: Database): boolean {
  return !db.query("SELECT 1 FROM task_time_pending LIMIT 1").get();
}

/** A key page is committed with its values. Interrupted preparation resumes
 * from the durable queue, without changing the task or its revision. */
export function prepareTaskTimes(db: Database, limit = 128): boolean {
  const rows = db.query<{ row_key: string; due: string | null; held: string | null; updated: string | null }, [number]>(`
    SELECT p.row_key,
      CASE WHEN json_valid(r.value_json) THEN json_extract(r.value_json,'$.dueAt') END AS due,
      CASE WHEN json_valid(r.value_json) THEN json_extract(r.value_json,'$.hold.until') END AS held,
      CASE WHEN json_valid(r.value_json) THEN json_extract(r.value_json,'$.updatedAt') END AS updated
    FROM task_time_pending p LEFT JOIN state_rows r ON r.collection='tasks' AND r.row_key=p.row_key
    ORDER BY p.row_key LIMIT ?`).all(limit);
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
  return taskTimesReady(db);
}
