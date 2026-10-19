import { pipelineControllerObligationSql } from "./pipelineControllerIndex";
import type { Database } from "bun:sqlite";
import { mayRunStateStartupMutation } from "@/lib/stateOwnership";

/** Headers only. Triggers keep old writers and raw SQL in the same queue;
 * acknowledgment is conditional on the revision that was actually observed. */
export function installPipelineControllerSchedule(db: Database, directory: string): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='pipeline_tick_delete'").get()) return;
  if (!mayRunStateStartupMutation(directory)) return;
  db.exec(`CREATE TABLE pipeline_tick_work (
    row_key TEXT PRIMARY KEY, row_order INTEGER NOT NULL, generation INTEGER NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1, due_at INTEGER NOT NULL DEFAULT 0, attempt_cursor INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec("CREATE INDEX pipeline_tick_dirty ON pipeline_tick_work(dirty, row_order, row_key)");
  db.exec("CREATE INDEX pipeline_tick_due ON pipeline_tick_work(due_at, row_order, row_key)");
  db.exec("CREATE INDEX pipeline_tick_order ON pipeline_tick_work(row_order, row_key)");
  db.exec("CREATE INDEX IF NOT EXISTS pipeline_controller_work_key ON pipeline_controller_work(row_key)");
  db.exec("CREATE TABLE pipeline_tick_cursor (id INTEGER PRIMARY KEY CHECK(id=1), row_order INTEGER NOT NULL, row_key TEXT NOT NULL)");
  db.exec("INSERT INTO pipeline_tick_cursor VALUES (1,-1,'')");
  db.exec("CREATE TABLE pipeline_tick_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)");
  db.exec("INSERT INTO pipeline_tick_clock SELECT 1,COALESCE(MAX(row_revision),0) FROM state_rows");
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
      AND (${pipelineControllerObligationSql("r.value_json")})`);
}

export type PipelineTickWork = { row_key: string; row_order: number; generation: number; attempt_cursor: number };

/** Reserve capacity for the fair walk even under continuous dirty writes.
 * It also covers runtime/account events that do not write a pipeline row. */
export function selectPipelineTickWork(db: Database, now: number, excluded: readonly string[], limit: number): PipelineTickWork[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error("invalid controller lane budget");
  const skip = JSON.stringify(excluded);
  const dirty = db.query<PipelineTickWork, [string, number]>(`SELECT * FROM pipeline_tick_work
    WHERE dirty=1 AND row_key NOT IN (SELECT value FROM json_each(?))
    ORDER BY row_order,row_key LIMIT ?`).all(skip, Math.max(1, limit - 2));
  const due = db.query<PipelineTickWork, [number, string, number]>(`SELECT * FROM pipeline_tick_work
    WHERE due_at<=? AND row_key NOT IN (SELECT value FROM json_each(?))
    ORDER BY due_at,row_order,row_key LIMIT ?`).all(now, JSON.stringify([...excluded,...dirty.map(row=>row.row_key)]), Math.max(0, limit - dirty.length - 1));
  const cursor = db.query<{ row_order: number; row_key: string }, []>("SELECT row_order,row_key FROM pipeline_tick_cursor WHERE id=1").get()!;
  const fairSkip = JSON.stringify([...excluded,...dirty.map(row=>row.row_key),...due.map(row=>row.row_key)]);
  const fair = (order: number, key: string) => db.query<PipelineTickWork, [number, number, string, string, number]>(`SELECT * FROM pipeline_tick_work
    WHERE row_order>=? AND (row_order>? OR row_key>?) AND row_key NOT IN (SELECT value FROM json_each(?))
    ORDER BY row_order,row_key LIMIT ?`).all(order, order, key, fairSkip, limit - dirty.length - due.length);
  const tail = fair(cursor.row_order, cursor.row_key);
  return [...dirty,...due,...(tail.length ? tail : fair(-1,""))];
}
