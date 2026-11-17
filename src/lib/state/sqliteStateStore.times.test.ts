import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStateCollections, resetStateReadonlyReaderForTests, SqliteStateCollection } from "./sqliteStateStore";

type Task = { id: string; project: string; status: string; dueAt?: string; updatedAt: string; hold?: { until: string } };
const AT = "2026-10-11T04:58:01.001Z";
const MS = Date.parse(AT);
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, project: "fixture", status: "inbox", dueAt: AT, updatedAt: AT, ...extra });
const roots: string[] = [];
afterEach(() => {
  resetStateReadonlyReaderForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(rows: Task[], withPipelines = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-times-")); roots.push(root);
  const filename = path.join(root, "state.sqlite");
  const options = { collection: "tasks", schemaVersion: 1, busyMessage: "busy", key: (row: Task) => row.id,
    clone: structuredClone, decode: (raw: unknown) => raw as Task };
  initializeStateCollections(filename, [{ ...options, migrationId: "times", loadRecords: () => rows }]);
  if (withPipelines) initializeStateCollections(filename, [{ collection: "pipelines", schemaVersion: 1, migrationId: "times-pipelines",
    loadRecords: () => [], key: (row: { id: string }) => row.id }]);
  return { filename, open: () => new SqliteStateCollection<Task>(filename, options) };
}

test("due and hold boundaries never admit a task one millisecond early", () => {
  const f = fixture([task("due"), task("held", { dueAt: new Date(MS - 10).toISOString(), hold: { until: AT } })]);
  const store = f.open();
  try {
    expect(store.overdueTaskKeys(["fixture"], MS - 1)).toEqual([]);
    expect(store.overdueTaskRows(["fixture"], MS).map(row => [row.row_key, row.eligible_at])).toEqual([["held", MS - 10], ["due", MS]]);
  } finally { store.close(); }
});

test("adjacent due dates keep their order, cursor and delivered-key identity", () => {
  const f = fixture([task("a-later"), task("z-earlier", { dueAt: new Date(MS - 1).toISOString() })]);
  const store = f.open();
  try {
    expect(store.overdueTaskRows(["fixture"], MS).map(row => [row.row_key, row.eligible_at])).toEqual([["z-earlier", MS - 1], ["a-later", MS]]);
    const delivered = [`a-later:${MS}`, `z-earlier:${MS - 1}`];
    const remaining = store.overdueTaskRows(["fixture"], MS, 51, null, delivered, [1, MS - 1, "z-earlier"], delivered);
    // The fixed repeat head may include known tasks; discovery/sweep must not
    // invent another key by rounding the already-delivered instant down.
    expect(remaining.filter(row => row.advance)).toEqual([]);
  } finally { store.close(); }
});

test("legacy replica watermark preserves the millisecond across reopen and writes", () => {
  const f = fixture([task("legacy")]);
  let store = f.open();
  try {
    expect(store.maxTaskProjectStamp(["fixture"], "local")).toBe(`${MS}.000.local`);
    store.boundedPatch(1, tx => tx.put(task("legacy", { updatedAt: new Date(MS + 2).toISOString() })));
    store.close(); store = f.open();
    expect(store.maxTaskProjectStamp(["fixture"], "local")).toBe(`${MS + 2}.000.local`);
  } finally { store.close(); }
});

test("compatibility writes refresh exact instants and invalid times stay excluded", () => {
  const f = fixture([task("changed", { dueAt: new Date(MS + 10).toISOString() })]);
  const store = f.open(); const peer = new Database(f.filename);
  try {
    const change = peer.query("UPDATE state_rows SET value_json=? WHERE collection='tasks' AND row_key='changed'");
    change.run(JSON.stringify(task("changed")));
    expect(store.overdueTaskRows(["fixture"], MS)[0]?.eligible_at).toBe(MS);
    expect(store.maxTaskProjectStamp(["fixture"], "local")).toBe(`${MS}.000.local`);
    change.run(JSON.stringify(task("changed", { dueAt: "invalid", updatedAt: "invalid", hold: { until: "invalid" } })));
    expect(store.overdueTaskKeys(["fixture"], MS)).toEqual([]);
    expect(store.maxTaskProjectStamp(["fixture"], "local")).toBeNull();
    change.run(JSON.stringify(task("changed")));
    peer.exec("DELETE FROM state_rows WHERE collection='tasks'");
    expect(store.overdueTaskKeys(["fixture"], MS)).toEqual([]);
  } finally { peer.close(); store.close(); }
});

test("repeated compatibility UPSERTs work with and without an existing queue entry", () => {
  const f = fixture([task("queued", { dueAt: new Date(MS + 5).toISOString() })]);
  const store = f.open(); const peer = new Database(f.filename);
  const put = peer.query(`INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active)
    VALUES('tasks','queued',?,0,2,1) ON CONFLICT(collection,row_key) DO UPDATE SET value_json=excluded.value_json`);
  try {
    peer.query("UPDATE state_rows SET value_json=value_json WHERE collection='tasks'").run();
    put.run(JSON.stringify(task("queued", { dueAt: AT })));
    put.run(JSON.stringify(task("queued", { dueAt: new Date(MS + 1).toISOString() })));
    expect(store.overdueTaskKeys(["fixture"], MS)).toEqual([]);
    expect(store.overdueTaskRows(["fixture"], MS + 1)[0]?.eligible_at).toBe(MS + 1);
  } finally { peer.close(); store.close(); }
});

test("repeated bounded task writes refresh their projection in the same commit", () => {
  const f = fixture([task("repeat", { dueAt: new Date(MS + 5).toISOString() })]);
  const store = f.open();
  try {
    store.boundedPatch(2, tx => {
      tx.put(task("repeat", { dueAt: new Date(MS + 2).toISOString() }));
      tx.put(task("repeat", { dueAt: new Date(MS + 1).toISOString() }));
    });
    expect(store.overdueTaskRows(["fixture"], MS + 1)[0]?.eligible_at).toBe(MS + 1);
  } finally { store.close(); }
});

test("unrelated bounded writes leave old projection work for separately committed read batches", () => {
  const f = fixture(Array.from({ length: 130 }, (_, n) => task(`task-${String(n).padStart(3, "0")}`)), true);
  const tasks = f.open(); const pipelines = new SqliteStateCollection<{ id: string }>(f.filename, {
    collection: "pipelines", schemaVersion: 1, busyMessage: "busy", key: row => row.id,
    clone: structuredClone, decode: raw => raw as { id: string },
  });
  const peer = new Database(f.filename);
  try {
    peer.exec("UPDATE state_rows SET value_json=value_json WHERE collection='tasks'");
    expect(peer.query("SELECT count(*) AS n FROM task_time_pending").get()).toEqual({ n: 130 });
    pipelines.boundedPatch(1, tx => tx.put({ id: "unrelated" }));
    expect(peer.query("SELECT count(*) AS n FROM task_time_pending").get()).toEqual({ n: 130 });
    expect(() => tasks.overdueTaskKeys(["fixture"], MS)).toThrow("projection is preparing");
    expect(peer.query("SELECT count(*) AS n FROM task_time_pending").get()).toEqual({ n: 2 });
  } finally { peer.close(); pipelines.close(); tasks.close(); }
});

test("an older schema rebuilds time columns and indexes without changing payloads or revisions", () => {
  const f = fixture([task("legacy")]);
  const peer = new Database(f.filename);
  try {
    const before = peer.query("SELECT value_json,row_revision FROM state_rows WHERE collection='tasks'").all();
    // Recreate the schema an earlier release left, including its time indexes.
    for (const name of ["insert", "update", "delete"]) peer.exec(`DROP TRIGGER IF EXISTS task_time_${name}`);
    peer.exec("DROP TABLE IF EXISTS task_time_pending");
    peer.exec("DROP INDEX state_rows_task_due");
    peer.exec("DROP INDEX state_rows_task_legacy_stamp");
    const columns = peer.query<{ name: string }, []>("PRAGMA table_info(state_rows)").all();
    for (const name of ["task_due_ms", "task_hold_ms", "task_updated_ms"]) {
      if (columns.some(column => column.name === name)) peer.exec(`ALTER TABLE state_rows DROP COLUMN ${name}`);
    }
    const store = f.open();
    try {
      expect(store.overdueTaskRows(["fixture"], MS)[0]?.eligible_at).toBe(MS);
      expect(store.maxTaskProjectStamp(["fixture"], "local")).toBe(`${MS}.000.local`);
      expect(peer.query("SELECT value_json,row_revision FROM state_rows WHERE collection='tasks'").all()).toEqual(before);
    } finally { store.close(); }
  } finally { peer.close(); }
});


test("a compatibility write between preparation and the read snapshot refuses stale times and recovers", () => {
  const f = fixture([task("raced")]);
  const store = f.open(); const peer = new Database(f.filename);
  const exec = Database.prototype.exec;
  let raced = false;
  const spy = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
    if (sql === "BEGIN" && !raced) {
      raced = true;
      peer.query("UPDATE state_rows SET value_json=? WHERE collection='tasks'").run(JSON.stringify(task("raced", { dueAt: new Date(MS + 1).toISOString() })));
    }
    return exec.call(this, sql);
  });
  try { expect(() => store.overdueTaskKeys(["fixture"], MS)).toThrow("projection changed"); }
  finally { spy.mockRestore(); }
  try { expect(store.overdueTaskKeys(["fixture"], MS)).toEqual([]); }
  finally { peer.close(); store.close(); }
});

test("bounded preparation resumes from its durable queue after reopening", () => {
  const f = fixture(Array.from({ length: 130 }, (_, n) => task(`task-${String(n).padStart(3, "0")}`)));
  const peer = new Database(f.filename);
  let store = f.open();
  try {
    peer.exec("UPDATE state_rows SET value_json=value_json WHERE collection='tasks'");
    expect(() => store.overdueTaskKeys(["fixture"], MS)).toThrow("projection is preparing");
    expect(peer.query("SELECT count(*) AS n FROM task_time_pending").get()).toEqual({ n: 2 });
    store.close(); store = f.open();
    expect(store.overdueTaskKeys(["fixture"], MS)).toHaveLength(51);
    expect(peer.query("SELECT count(*) AS n FROM task_time_pending").get()).toEqual({ n: 0 });
  } finally { peer.close(); store.close(); }
});

test("every state write path publishes exact times and rolled-back writes publish none", async () => {
  const f = fixture([]); const store = f.open();
  const check = () => expect(store.maxTaskProjectStamp(["fixture"], "local")).toBe(`${MS}.000.local`);
  try {
    store.replaceSync([task("replace")]); check();
    store.patchSync(() => ({ records: [task("patch")] })); check();
    await store.replace([task("async-replace")]); check();
    await store.patch(() => ({ records: [task("async-patch")] })); check();
    store.boundedPatch(1, tx => tx.put(task("bounded"))); check();
    SqliteStateCollection.commitPatchesSync([{ collection: store as SqliteStateCollection<unknown>, records: [task("combined")] }]); check();
    expect(() => store.replaceSync([task("rollback", { updatedAt: new Date(MS + 10).toISOString() })], { beforePersist: () => { throw new Error("refused"); } })).toThrow("refused");
    check(); expect(store.get("rollback")).toBeNull();
  } finally { store.close(); }
});
