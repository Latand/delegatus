import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { savePipelines } from "@/lib/pipelines/store";
import { saveTasks } from "@/lib/tasks/store";
import { readStateProjectKeys } from "@/lib/state/sqliteStateStore";
import { projectKeyIndexSnapshot } from "./projectKeyIndex";

const cacheKey = "__llvProjectKeyDatabase";
const cacheOwner = globalThis as typeof globalThis & Record<string, unknown>;
let root: string | undefined;
let previousState: string | undefined;

afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  previousState = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  delete cacheOwner[cacheKey];
});

test("hot revisions reuse archived membership until the archive revision advances", () => {
  previousState = process.env.LLV_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "project-key-index-"));
  process.env.LLV_STATE_DIR = root;
  delete cacheOwner[cacheKey];
  saveTasks([]);
  savePipelines([]);

  const filename = path.join(root, "state.sqlite");
  const db = new Database(filename);
  try {
    db.query(`INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active)
      VALUES ('pipelines_archive','archive-lane','{"project":"archive-project-a"}',0,1,0)`).run();
    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines_archive'").run();
    expect(projectKeyIndexSnapshot().has("archive-project-a")).toBe(true);

    // Deliberately change stored membership without advancing its own revision.
    // A task write invalidates hot keys and must leave the archive cache alone.
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines_archive' AND row_key='archive-lane'")
      .run('{"project":"archive-project-b"}');
    saveTasks([{ id: "hot-task", project: "hot-project", text: "Hot task", status: "inbox", placement: "unplaced",
      assignments: [], createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z" }]);
    const afterHotWrite = projectKeyIndexSnapshot();
    expect(afterHotWrite.has("hot-project")).toBe(true);
    expect(afterHotWrite.has("archive-project-a")).toBe(true);
    expect(afterHotWrite.has("archive-project-b")).toBe(false);

    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines_archive'").run();
    const afterArchiveWrite = projectKeyIndexSnapshot();
    expect(afterArchiveWrite.has("archive-project-a")).toBe(false);
    expect(afterArchiveWrite.has("archive-project-b")).toBe(true);
  } finally { db.close(); }
});

test("seat project membership reads the compact index and follows committed project moves", () => {
  previousState = process.env.LLV_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-project-membership-"));
  process.env.LLV_STATE_DIR = root;
  delete cacheOwner[cacheKey];
  saveTasks([]);
  savePipelines([]);

  const filename = path.join(root, "state.sqlite");
  const peer = new Database(filename);
  const put = peer.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES (?,?,?,0,1,0)");
  try {
    put.run("tasks", "t:first", JSON.stringify({ project: "shared-key" }));
    put.run("flows", "flow-a", JSON.stringify({ project: "shared-key" }));
    put.run("pipelines", "lane-a", JSON.stringify({ project: "hot-key" }));
    put.run("pipelines_archive", "archive-a", JSON.stringify({ project: "archived-key" }));
    put.run("tasks", "t:blank", '{"project":""}');
    put.run("flows", "space", '{"project":" "}');
    put.run("flows", "zero", '{"project":"0"}');
    put.run("flows", "flow-number", '{"project":42}');
    put.run("flows", "no-project", '{}');
    const sql = spyOn(Database.prototype, "query");
    let membershipSql: string | undefined;
    try {
      expect(readStateProjectKeys(filename, ["tasks", "pipelines", "flows"]).sort()).toEqual([" ", "0", "hot-key", "shared-key"]);
      membershipSql = sql.mock.calls.map(([statement]) => statement)
        .find(statement => /SELECT DISTINCT.*AS project/i.test(statement));
    } finally { sql.mockRestore(); }
    expect(membershipSql).toBeDefined();
    const plan = peer.query<{ detail: string }, string[]>("EXPLAIN QUERY PLAN " + membershipSql)
      .all("tasks", "pipelines", "flows");
    expect(plan.map(row => row.detail).join("\n")).toContain("state_rows_project_membership");
    const program = peer.query<{ p4: string | null }, string[]>("EXPLAIN " + membershipSql)
      .all("tasks", "pipelines", "flows");
    expect(program.some(row => /json_(?:valid|type|extract)\(/i.test(row.p4 ?? ""))).toBe(false);

    peer.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='lane-a'").run('{"project":"new-key"}');
    expect(readStateProjectKeys(filename).sort()).toEqual([" ", "0", "archived-key", "new-key", "shared-key"]);
    peer.exec("DELETE FROM state_rows WHERE collection='pipelines_archive' AND row_key='archive-a'");
    expect(readStateProjectKeys(filename, ["pipelines_archive"])).toEqual([]);
  } finally { peer.close(); }
});

test("membership can read an old database before index installation and accept other collections", () => {
  previousState = process.env.LLV_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-project-membership-"));
  const filename = path.join(root, "state.sqlite");
  const db = new Database(filename);
  try {
    db.exec("CREATE TABLE state_rows(collection TEXT, value_json TEXT)");
    const put = db.query("INSERT INTO state_rows VALUES (?,?)");
    put.run("flows", '{"project":"present"}');
    put.run("flows", "invalid");
    put.run("tasks", '{"project":null}');
    put.run("other", '{"project":"other-key"}');
    expect(readStateProjectKeys(filename)).toEqual(["present"]);
    expect(readStateProjectKeys(filename, ["flows", "other"]).sort()).toEqual(["other-key", "present"]);
    expect(readStateProjectKeys(filename, [])).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index'").all()).toEqual([]);
  } finally { db.close(); }
});
