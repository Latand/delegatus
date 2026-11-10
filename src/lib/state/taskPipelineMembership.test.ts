import { expect, spyOn, test } from "bun:test";
import { Database, type Statement } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStateCollections, readPipelineRowsForTask } from "./sqliteStateStore";

type Lane = { id: string; taskIds: string[] };
const LANES = 120;

function fixture(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const filename = path.join(root, "state.sqlite");
  initializeStateCollections(filename, ["pipelines", "pipelines_archive"].map(collection => ({ collection, schemaVersion: 1,
    migrationId: "one", key: (row: Lane) => row.id,
    loadRecords: (): Lane[] => Array.from({ length: LANES }, (_, i) => ({ id: `${collection}-${i}`, taskIds: [`task-${i}`] })) })));
  return { root, filename, db: new Database(filename) };
}
const ids = (rows: unknown[] | null) => (rows as Lane[] | null)?.map(row => row.id) ?? null;

/** Rows SQLite handed back to the reader while `work` ran. */
function rowsRead<T>(work: () => T): { value: T; rows: number } {
  let rows = 0;
  const real = Database.prototype.query, wrapped = new WeakSet<object>();
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    const statement = real.call(this, sql) as Statement;
    if (!wrapped.has(statement)) {
      wrapped.add(statement);
      const all = statement.all.bind(statement), get = statement.get.bind(statement);
      statement.all = ((...args: never[]) => { const found = all(...args); if (counting) rows += found.length; return found; }) as typeof statement.all;
      statement.get = ((...args: never[]) => { const found = get(...args); if (counting && found) rows++; return found; }) as typeof statement.get;
    }
    return statement;
  } as never);
  let counting = true;
  try { const value = work(); return { value, rows }; }
  finally { counting = false; spy.mockRestore(); }
}

test("a lane write refreshes task membership from the written lanes only", () => {
  const { root, filename, db } = fixture("task-membership-refresh");
  try {
    expect(ids(readPipelineRowsForTask(filename, "task-3"))).toEqual(["pipelines-3", "pipelines_archive-3"]);
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='pipelines-7'")
      .run(JSON.stringify({ id: "pipelines-7", taskIds: ["task-7", "task-3"] }));
    const refreshed = rowsRead(() => readPipelineRowsForTask(filename, "task-3"));
    expect(ids(refreshed.value)).toEqual(["pipelines-3", "pipelines-7", "pipelines_archive-3"]);
    // Both collections hold 240 lanes; one was written and three are answered.
    expect(refreshed.rows).toBeLessThan(40);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("membership follows removals, archive moves, new lanes and malformed rows", () => {
  const { root, filename, db } = fixture("task-membership-follow");
  try {
    expect(ids(readPipelineRowsForTask(filename, "task-5"))).toEqual(["pipelines-5", "pipelines_archive-5"]);
    // A lane leaves the task.
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines_archive' AND row_key='pipelines_archive-5'")
      .run(JSON.stringify({ id: "pipelines_archive-5", taskIds: [] }));
    expect(ids(readPipelineRowsForTask(filename, "task-5"))).toEqual(["pipelines-5"]);
    // An active lane is archived: deleted from one collection, stored in the other.
    const order = db.query<{ next: number }, []>("SELECT MAX(row_order)+1 AS next FROM state_rows WHERE collection='pipelines_archive'").get()!.next;
    const moved = db.query<{ value_json: string; row_revision: number; controller_active: number }, []>(
      "SELECT value_json,row_revision,controller_active FROM state_rows WHERE collection='pipelines' AND row_key='pipelines-5'").get()!;
    db.transaction(() => {
      db.query("DELETE FROM state_rows WHERE collection='pipelines' AND row_key='pipelines-5'").run();
      db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive','pipelines-5',?,?,?,0)")
        .run(moved.value_json, order, moved.row_revision);
    })();
    expect(ids(readPipelineRowsForTask(filename, "task-5"))).toEqual(["pipelines-5"]);
    expect(readPipelineRowsForTask(filename, "task-5")).toHaveLength(1);
    // A deleted lane no longer answers.
    db.query("DELETE FROM state_rows WHERE collection='pipelines_archive' AND row_key='pipelines-5'").run();
    expect(ids(readPipelineRowsForTask(filename, "task-5"))).toEqual([]);
    // A row that stops being JSON holds no membership; the others keep theirs.
    db.query("UPDATE state_rows SET value_json='{broken' WHERE collection='pipelines' AND row_key='pipelines-9'").run();
    expect(ids(readPipelineRowsForTask(filename, "task-9"))).toEqual(["pipelines_archive-9"]);
    expect(ids(readPipelineRowsForTask(filename, "task-10"))).toEqual(["pipelines-10", "pipelines_archive-10"]);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("losing the evidence index returns to the complete read", () => {
  const { root, filename, db } = fixture("task-membership-untracked");
  try {
    expect(ids(readPipelineRowsForTask(filename, "task-1"))).toEqual(["pipelines-1", "pipelines_archive-1"]);
    db.exec("DROP TRIGGER pipeline_evidence_update");
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='pipelines-2'")
      .run(JSON.stringify({ id: "pipelines-2", taskIds: ["task-1"] }));
    expect(ids(readPipelineRowsForTask(filename, "task-1"))).toEqual(["pipelines-1", "pipelines-2", "pipelines_archive-1"]);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
