import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { stateRowsContaining } from "./sqliteStateStore";

const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function database(rows: Array<[collection: string, key: string, value: unknown]>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-rows-")); made.push(directory);
  const filename = path.join(directory, "state.sqlite"), db = new Database(filename, { create: true });
  db.exec("CREATE TABLE state_rows(collection TEXT NOT NULL,row_key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(collection,row_key))");
  for (const [collection, key, value] of rows) db.query("INSERT INTO state_rows VALUES(?,?,?)").run(collection, key, JSON.stringify(value));
  db.close();
  return filename;
}

test("rows of the named collections that contain a needle come back as stored text", () => {
  const filename = database([
    ["tasks", "t1", { text: "lane lane-7 failed", note: "see test-results/case/" }],
    ["tasks", "t2", { text: "unrelated" }],
    ["bridge_reports", "r1", { v: { body: "checkout /work/lane-7-checkout holds the captures" } }],
    ["role_memory", "m1", { text: "lane-7 appears in a collection nobody asked for" }],
  ]);
  const rows = stateRowsContaining(filename, ["tasks", "bridge_reports"], ["lane-7", "/work/other"]).map(row => JSON.parse(row));
  expect(rows).toHaveLength(2);
  expect(rows).toContainEqual({ text: "lane lane-7 failed", note: "see test-results/case/" });
  expect(rows).toContainEqual({ v: { body: "checkout /work/lane-7-checkout holds the captures" } });
});

test("a result over the byte bound is refused whole; a missing database has no rows", () => {
  const filename = database([["tasks", "t1", { text: "lane-7 " + "x".repeat(4096) }]]);
  expect(() => stateRowsContaining(filename, ["tasks"], ["lane-7"], 1024)).toThrow();
  expect(stateRowsContaining(path.join(path.dirname(filename), "absent.sqlite"), ["tasks"], ["lane-7"])).toEqual([]);
});
