import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cooperative from "../cooperative";
import { createProjectMembershipIndex, readStateProjectKeys } from "./sqliteStateStore";

test("membership preparation yields to a writer and catches changes committed during and after the scan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membership-reader-"));
  const filename = path.join(dir, "state.sqlite");
  const peer = new Database(filename);
  peer.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;
    CREATE TABLE state_rows(collection TEXT,row_key TEXT,value_json TEXT,PRIMARY KEY(collection,row_key));
    CREATE TABLE state_collections(collection TEXT PRIMARY KEY,revision INTEGER,change_floor INTEGER,migration_id TEXT);
    CREATE TABLE state_changes(collection TEXT,revision INTEGER,row_key TEXT,PRIMARY KEY(collection,revision,row_key));
    INSERT INTO state_collections VALUES ('tasks',1,0,'fixture'),('flows',1,0,'fixture');
    INSERT INTO state_rows VALUES ('tasks','a','{"project":"first"}'),('tasks','b','{"project":"first"}'),
      ('flows','foreign','{"project":"elsewhere"}'),('tasks','malformed','{');`);
  const index = createProjectMembershipIndex(filename);
  const read = () => readStateProjectKeys(filename, ["tasks"], index).sort();
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const original = cooperative.yieldToRuntime;
  let yields = 0;
  const yielding = spyOn(cooperative, "yieldToRuntime").mockImplementation(async (...args) => {
    if (++yields === 2) { entered.resolve(); await resume.promise; }
    return original(...args);
  });
  try {
    expect(read()).toEqual(["first"]);
    const building = index.prepare();
    await entered.promise;
    // The builder pins a WAL read snapshot. This independent write must commit
    // immediately, and the fallback must already see it before preparation ends.
    peer.exec(`BEGIN IMMEDIATE; UPDATE state_rows SET value_json='{"project":"second"}' WHERE row_key='a';
      INSERT INTO state_changes VALUES ('tasks',2,'a'); UPDATE state_collections SET revision=2 WHERE collection='tasks'; COMMIT`);
    expect(read()).toEqual(["first", "second"]);
    resume.resolve(); await building;
    const sql = spyOn(Database.prototype, "query");
    try {
      expect(read()).toEqual(["first", "second"]);
      expect(sql.mock.calls.some(([s]) => s.includes("FROM state_changes c"))).toBe(true);
      expect(sql.mock.calls.some(([s]) => s.includes("SELECT DISTINCT"))).toBe(false);
    } finally { sql.mockRestore(); }

    peer.exec(`BEGIN IMMEDIATE; DELETE FROM state_rows WHERE row_key='b'; INSERT INTO state_changes VALUES ('tasks',3,'b');
      UPDATE state_collections SET revision=3 WHERE collection='tasks'; COMMIT`);
    expect(read()).toEqual(["second"]);
    // A trimmed change log forces an authoritative read.
    peer.exec(`BEGIN IMMEDIATE; UPDATE state_rows SET value_json='{"project":"reimported"}' WHERE row_key='a';
      UPDATE state_collections SET revision=5,change_floor=5 WHERE collection='tasks'; COMMIT`);
    expect(read()).toEqual(["reimported"]);
    await index.prepare();
    expect(read()).toEqual(["reimported"]);
    expect(peer.query("SELECT name FROM sqlite_master WHERE name='state_rows_project_membership'").get()).toBeNull();
  } finally {
    resume.resolve(); index.dispose();
    await index.prepare(); yielding.mockRestore(); peer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
