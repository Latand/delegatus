import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDatabaseAtActivation, stateDatabases } from "./durability";
import { minimumSqliteLibrary, minimumSqliteModule } from "./minimumSqlite.fixture";
import { initializeStateCollections, readStateProjectKeys, SqliteStateCollection } from "./sqliteStateStore";

test("activation discards a preceding engine's membership index before considering database recovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "membership-version-"));
  try {
    const state = stateDatabases(root).find(row => row.name === "state.sqlite")!;
    const Old = minimumSqliteModule(minimumSqliteLibrary()).Database;
    const old = new Old(state.filename);
    const json = JSON.stringify({ project: "key\u0000suffix" });
    try {
      old.exec("CREATE TABLE state_rows(collection TEXT, row_key TEXT, value_json TEXT)");
      old.exec("CREATE INDEX preserved_row_key ON state_rows(row_key)");
      old.exec(`CREATE INDEX state_rows_project_membership ON state_rows(collection,json_extract(value_json,'$.project'))
        WHERE collection IN ('tasks','pipelines','pipelines_archive','flows') AND json_valid(value_json) AND json_type(value_json,'$.project')='text'`);
      old.query("INSERT INTO state_rows VALUES ('flows','item',?)").run(json);
      expect(old.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally { old.close(); }

    const identity = fs.statSync(state.filename).ino;
    const before = new Database(state.filename, { readonly: true });
    try {
      // Engines which keep the suffix see the truncated 3.39 index entry as damage.
      const key = before.query<{ key: string }, [string]>("SELECT json_extract(?, '$.project') AS key").get(json)!.key;
      expect(readStateProjectKeys(state.filename, ["flows"])).toEqual([key]);
      if (key.includes("suffix")) expect(before.query("PRAGMA integrity_check").all()).not.toEqual([{ integrity_check: "ok" }]);
    } finally { before.close(); }
    const writer = new Database(state.filename);
    try {
      writer.exec("BEGIN IMMEDIATE");
      expect(checkDatabaseAtActivation(state, { stateDirectory: root }).state).toBe("unchecked");
      expect(fs.statSync(state.filename).ino).toBe(identity);
      writer.exec("ROLLBACK");
    } finally { writer.close(); }
    expect(checkDatabaseAtActivation(state, { stateDirectory: root }).state).toBe("ok");
    expect(fs.statSync(state.filename).ino).toBe(identity);
    const after = new Database(state.filename, { readonly: true });
    try {
      expect(after.query("SELECT value_json FROM state_rows").get()).toEqual({ value_json: json });
      expect(after.query("SELECT name FROM sqlite_master WHERE name='state_rows_project_membership'").get()).toBeNull();
      expect(after.query("SELECT name FROM sqlite_master WHERE name='preserved_row_key'").get()).toEqual({ name: "preserved_row_key" });
      expect(after.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally { after.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a normal state open with no membership index succeeds while a peer owns the writer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "membership-open-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    const filename = path.join(root, "state.sqlite");
    initializeStateCollections(filename, [{ collection: "tasks", schemaVersion: 1, migrationId: "fixture", key: String, loadRecords: () => [] }]);
    const peer = new Database(filename);
    try {
      peer.exec("DROP INDEX IF EXISTS state_rows_project_membership");
      peer.exec("BEGIN IMMEDIATE");
      const store = new SqliteStateCollection(filename, { collection: "tasks", schemaVersion: 1, key: String,
        decode: value => value as string, clone: value => value, busyMessage: "tasks" });
      try { expect(readStateProjectKeys(filename)).toEqual([]); }
      finally { store.close(); }
      peer.exec("COMMIT");
      expect(peer.query("SELECT name FROM sqlite_master WHERE name='state_rows_project_membership'").get()).toBeNull();
    } finally { peer.close(); }
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
