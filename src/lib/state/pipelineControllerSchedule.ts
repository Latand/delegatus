import { declaredIndexes } from "./declaredIndexes";
import { pipelineControllerObligationSql } from "./pipelineControllerIndex";
import type { Database } from "bun:sqlite";
import { mayRunStateStartupMutation } from "@/lib/stateOwnership";

export const pipelineControllerScheduleIndexes = declaredIndexes([
  "CREATE INDEX IF NOT EXISTS pipeline_tick_dirty ON pipeline_tick_work(dirty, row_order, row_key)",
  "CREATE INDEX IF NOT EXISTS pipeline_tick_due ON pipeline_tick_work(due_at, row_order, row_key)",
  "CREATE INDEX IF NOT EXISTS pipeline_tick_clean_due ON pipeline_tick_work(due_at, row_order, row_key) WHERE dirty=0",
  "CREATE INDEX IF NOT EXISTS pipeline_tick_order ON pipeline_tick_work(row_order, row_key)",
  "CREATE INDEX IF NOT EXISTS pipeline_controller_work_key ON pipeline_controller_work(row_key)",
]);

function installPriorityCursors(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_tick_priority_cursor (
    kind TEXT PRIMARY KEY CHECK(kind IN ('dirty','due')), due_at INTEGER NOT NULL,
    row_order INTEGER NOT NULL, row_key TEXT NOT NULL
  )`);
  db.exec("INSERT OR IGNORE INTO pipeline_tick_priority_cursor VALUES ('dirty',0,-1,''),('due',-1,-1,'')");
}

/** Headers only. Triggers keep old writers and raw SQL in the same queue;
 * acknowledgment is conditional on the revision that was actually observed. */
export function installPipelineControllerSchedule(db: Database, directory: string, refresh = false): void {
  const objects = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master").all().map(row => row.name));
  if (!refresh && objects.has("pipeline_tick_delete")) {
    if (!pipelineControllerScheduleIndexes.ready(objects) && mayRunStateStartupMutation(directory)) {
      pipelineControllerScheduleIndexes.install(db, directory);
    }
    if (!objects.has("pipeline_tick_priority_cursor") && mayRunStateStartupMutation(directory)) installPriorityCursors(db);
    return;
  }
  if (!mayRunStateStartupMutation(directory)) return;
  if (refresh) for (const name of ["pipeline_tick_insert", "pipeline_tick_update", "pipeline_tick_delete"]) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_tick_work (
    row_key TEXT PRIMARY KEY, row_order INTEGER NOT NULL, generation INTEGER NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1, due_at INTEGER NOT NULL DEFAULT 0, attempt_cursor INTEGER NOT NULL DEFAULT 0
  )`);
  pipelineControllerScheduleIndexes.install(db, directory);
  db.exec("CREATE TABLE IF NOT EXISTS pipeline_tick_cursor (id INTEGER PRIMARY KEY CHECK(id=1), row_order INTEGER NOT NULL, row_key TEXT NOT NULL)");
  db.exec("INSERT OR IGNORE INTO pipeline_tick_cursor VALUES (1,-1,'')");
  installPriorityCursors(db);
  db.exec("CREATE TABLE IF NOT EXISTS pipeline_tick_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)");
  db.exec("INSERT OR IGNORE INTO pipeline_tick_clock SELECT 1,COALESCE(MAX(row_revision),0) FROM state_rows");
  const put = `UPDATE pipeline_tick_clock SET revision=revision+1 WHERE id=1;
    DELETE FROM pipeline_tick_work WHERE row_key=NEW.row_key AND NOT (${pipelineControllerObligationSql("NEW.value_json")});
    INSERT INTO pipeline_tick_work(row_key,row_order,generation) SELECT NEW.row_key,NEW.row_order,(SELECT revision FROM pipeline_tick_clock WHERE id=1) WHERE ${pipelineControllerObligationSql("NEW.value_json")}
    ON CONFLICT(row_key) DO UPDATE SET row_order=excluded.row_order,generation=excluded.generation,dirty=1,due_at=0;`;
  db.exec(`CREATE TRIGGER pipeline_tick_insert AFTER INSERT ON state_rows WHEN NEW.collection='pipelines' BEGIN ${put} END`);
  db.exec(`CREATE TRIGGER pipeline_tick_update AFTER UPDATE ON state_rows
    WHEN OLD.collection='pipelines' OR NEW.collection='pipelines' BEGIN
      UPDATE pipeline_tick_clock SET revision=revision+1 WHERE id=1;
      DELETE FROM pipeline_tick_work WHERE row_key=OLD.row_key AND OLD.collection='pipelines'
        AND (NEW.collection!='pipelines' OR NEW.row_key!=OLD.row_key OR NOT (${pipelineControllerObligationSql("NEW.value_json")}));
      INSERT INTO pipeline_tick_work(row_key,row_order,generation) SELECT NEW.row_key,NEW.row_order,(SELECT revision FROM pipeline_tick_clock WHERE id=1)
        WHERE NEW.collection='pipelines' AND (${pipelineControllerObligationSql("NEW.value_json")}) ON CONFLICT(row_key) DO UPDATE SET
        row_order=excluded.row_order,generation=excluded.generation,dirty=1,due_at=0;
    END`);
  db.exec(`CREATE TRIGGER pipeline_tick_delete AFTER DELETE ON state_rows WHEN OLD.collection='pipelines'
    BEGIN DELETE FROM pipeline_tick_work WHERE row_key=OLD.row_key; END`);
  db.exec(`INSERT INTO pipeline_tick_work(row_key,row_order,generation)
    SELECT row_key,row_order,row_revision FROM state_rows r WHERE collection='pipelines'
      AND (${pipelineControllerObligationSql("r.value_json")})
    ON CONFLICT(row_key) DO UPDATE SET dirty=1,due_at=0`);
}

export type PipelineTickWork = { row_key: string; row_order: number; generation: number; attempt_cursor: number; dirty: number; due_at: number };

/** Reserve capacity for the fair walk even under continuous dirty writes.
 * It also covers runtime/account events that do not write a pipeline row. */
export function selectPipelineTickWork(db: Database, now: number, excluded: readonly string[], limit: number): PipelineTickWork[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error("invalid controller lane budget");
  const cursor = db.query<{ row_order: number; row_key: string; dirty: number | null }, []>(`
    SELECT cursor.row_order,cursor.row_key,work.dirty FROM pipeline_tick_cursor cursor
    LEFT JOIN pipeline_tick_work work ON work.row_key=cursor.row_key
    WHERE cursor.id=1`).get()!;
  // Dirty and due walks keep their positions across changes of lane class.
  // A lane selected while due can return dirty after its Git job checkpoints.
  const [dirtyCursor, dueCursor] = db.query<{ due_at: number; row_order: number; row_key: string }, []>(
    "SELECT due_at,row_order,row_key FROM pipeline_tick_priority_cursor ORDER BY kind",
  ).all();
  if (!dirtyCursor || !dueCursor) throw new Error("controller priority cursors are missing");
  // A deadline still records the selected row. After dirty work, give a
  // due lane the first await; after due work, give dirty retries their turn.
  const dueFirst = cursor.dirty !== 0;
  const skip = JSON.stringify(excluded);
  const dirtyPage = (after: boolean, count: number) => db.query<PipelineTickWork, [number, string, string, number]>(`SELECT * FROM pipeline_tick_work
    WHERE dirty=1 AND (row_order,row_key) ${after ? ">" : "<="} (?,?)
      AND row_key NOT IN (SELECT value FROM json_each(?))
    ORDER BY row_order,row_key LIMIT ?`).all(dirtyCursor.row_order, dirtyCursor.row_key, skip, count);
  // A deadline can leave the selected lane dirty. Resume past the last pick
  // before wrapping back to it, including on the priority path.
  const dirtyLimit = Math.max(1, limit - 2);
  const dirty = dirtyPage(true, dirtyLimit);
  if (dirty.length < dirtyLimit) dirty.push(...dirtyPage(false, dirtyLimit - dirty.length));
  // The partial index keeps due selection separate from dirty rows whose
  // due time is zero. The full range key permits a seek past the cursor.
  const duePage = (after: boolean, count: number) => db.query<PipelineTickWork, [number, number, number, string, string, number]>(`SELECT * FROM pipeline_tick_work INDEXED BY pipeline_tick_clean_due
    WHERE dirty=0 AND due_at<=? AND (due_at,row_order,row_key) ${after ? ">" : "<="} (?,?,?)
      AND row_key NOT IN (SELECT value FROM json_each(?))
    ORDER BY due_at,row_order,row_key LIMIT ?`).all(now, dueCursor.due_at, dueCursor.row_order, dueCursor.row_key, skip, count);
  const dueLimit = Math.max(dueFirst || !dirty.length ? 1 : 0, limit - dirty.length - 1);
  const due = dueLimit ? duePage(true, dueLimit) : [];
  if (due.length < dueLimit) due.push(...duePage(false, dueLimit - due.length));
  dirty.splice(limit - due.length);
  const fairSkip = JSON.stringify([...excluded,...dirty.map(row=>row.row_key),...due.map(row=>row.row_key)]);
  const fairPage = (after: boolean, count: number) => db.query<PipelineTickWork, [number, string, string, number]>(`SELECT * FROM pipeline_tick_work
    WHERE (row_order,row_key) ${after ? ">" : "<="} (?,?) AND row_key NOT IN (SELECT value FROM json_each(?))
    ORDER BY row_order,row_key LIMIT ?`).all(cursor.row_order, cursor.row_key, fairSkip, count);
  const fairLimit = limit - dirty.length - due.length;
  const fair = fairLimit ? fairPage(true, fairLimit) : [];
  if (fair.length < fairLimit) fair.push(...fairPage(false, fairLimit - fair.length));
  const work = dueFirst ? [...due, ...dirty, ...fair] : [...dirty, ...due, ...fair];
  // The cursor may still name the only dirty row after a deadline. A wrapped
  // selection must give the other candidates a turn before retrying that row.
  const previous = work.findIndex(row => row.row_key === cursor.row_key);
  if (previous !== -1 && previous !== work.length - 1) work.push(...work.splice(previous, 1));
  return work;
}
