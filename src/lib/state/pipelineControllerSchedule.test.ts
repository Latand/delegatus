import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { installPipelineControllerSchedule, selectPipelineTickWork } from "./pipelineControllerSchedule";

test.each([100, 50_000])("due selection seeks past the cursor without statistics with %i rows", size => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE state_rows (
      collection TEXT, row_key TEXT, row_order INTEGER, row_revision INTEGER, value_json TEXT
    );
    CREATE TABLE pipeline_controller_work (row_key TEXT);`);
    installPipelineControllerSchedule(db, process.env.TMPDIR!);
    const insert = db.query("INSERT INTO pipeline_tick_work VALUES (?, ?, 1, ?, ?, 0)");
    db.transaction(() => {
      for (let i = 0; i < size; i++) insert.run(`due-${i}`, i, 0, 125);
      insert.run("dirty-peer", size, 1, 0);
    })();
    const previous = size - 3;
    db.query("UPDATE pipeline_tick_priority_cursor SET due_at=125,row_order=?,row_key=? WHERE kind='due'").run(previous, `due-${previous}`);
    db.query("UPDATE pipeline_tick_cursor SET row_order=?,row_key='dirty-peer' WHERE id=1").run(size);

    const duePlans: string[] = [];
    const traced = {
      query(sql: string) {
        const statement = db.query(sql);
        return {
          get: () => statement.get(),
          all: (...args: Array<string | number>) => {
            if (sql.includes("WHERE dirty=0 AND due_at")) {
              const plan = db.query<{ detail: string }, Array<string | number>>("EXPLAIN QUERY PLAN " + sql).all(...args);
              duePlans.push(...plan.map(row => row.detail));
            }
            return statement.all(...args);
          },
        };
      },
    } as unknown as Database;
    expect(db.query("SELECT name FROM sqlite_master WHERE name='sqlite_stat1'").get()).toBeNull();
    expect(selectPipelineTickWork(traced, 130, [], 4).map(row => row.row_key)).toEqual([
      `due-${size - 2}`, `due-${size - 1}`, "due-0", "dirty-peer",
    ]);
    expect(duePlans).toEqual(expect.arrayContaining([expect.stringMatching(/SEARCH .*pipeline_tick_clean_due .*\(due_at,row_order,row_key\)>/)]));
    expect(duePlans.some(detail => /TEMP B-TREE|pipeline_tick_dirty|SCAN pipeline_tick_work/.test(detail))).toBe(false);
  } finally {
    db.close();
  }
});
