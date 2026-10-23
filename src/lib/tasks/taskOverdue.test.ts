import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStateCollections, SqliteStateCollection, OVERDUE_TASK_KEYS_SQL } from "@/lib/state/sqliteStateStore";
import { overdueTasks, saveTasks } from "./store";
import { persistProjectAliases } from "@/lib/projects/aliases";
import type { BoardTask } from "./types";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const stamp = (offset: number) => new Date(NOW + offset).toISOString();
const task = (id: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  id, project: "fixture", text: id, status: "inbox", placement: "unplaced", assignments: [],
  createdAt: stamp(-100_000), updatedAt: stamp(-100_000), dueAt: stamp(-1_000), dueTz: "UTC", ...extra,
});

test("indexed overdue selection decodes three of 1000 dated open rows, excludes deferrals and remote work, caps at 51", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-overdue-"));
  const filename = path.join(root, "state.sqlite");
  let decoded = 0;
  const options = { collection: "tasks", schemaVersion: 1, busyMessage: "busy", key: (row: BoardTask) => `t:${row.id}`,
    clone: structuredClone, decode: (raw: unknown) => { decoded++; return raw as BoardTask; } };
  const eligible = [task("high", { priority: "high", dueAt: "2026-10-23T11:59:00Z" }),
    task("normal", { dueAt: "2026-10-23T13:59:00+02:00", hold: { kind: "worker", note: "No date", since: stamp(-1000), by: "operator" } }),
    task("low", { priority: "low", dueAt: stamp(-100_000) })];
  const rows = [...eligible, ...Array.from({ length: 997 }, (_, n) => task(`future-${n}`, { dueAt: stamp(100_000) })),
    task("done", { status: "done" }), task("held", { hold: { kind: "postponed", until: stamp(10_000), note: "Later", since: stamp(-1000), by: "operator" } }),
    task("remote", { machine: "other" }), task("undated", { dueAt: undefined, dueTz: undefined }), task("local", { machine: "self" })];
  let store: SqliteStateCollection<BoardTask> | undefined;
  try {
    initializeStateCollections(filename, [{ ...options, migrationId: "overdue", loadRecords: () => rows }]);
    store = new SqliteStateCollection<BoardTask>(filename, options);
    decoded = 0;
    const keys = store.overdueTaskKeys(["fixture", "fixture"], NOW);
    expect(keys.map(key => store!.get(key)!.id)).toEqual(["high", "normal", "low"]);
    expect(decoded).toBe(3);
    expect(store.overdueTaskKeys(["fixture"], NOW, 51, "self")).toContain("t:local");
    expect(store.overdueTaskKeys(["other"], NOW)).toEqual([]);
    const db = new Database(filename);
    try {
      db.exec("BEGIN IMMEDIATE");
      try { expect(store.overdueTaskKeys(["fixture"], NOW)).toHaveLength(3); }
      finally { db.exec("ROLLBACK"); }
      // Capture EXPLAIN for the exact production predicate/order/limit, including aliases and duplicate binds.
      for (const projects of [["fixture"], ["old", "fixture"], ["fixture", "fixture"]]) {
        const plan = db.query<{ detail: string }, [string, number, number, string | null, number]>(`EXPLAIN QUERY PLAN ${OVERDUE_TASK_KEYS_SQL}`)
          .all(JSON.stringify(projects), NOW, NOW, null, 51);
        expect(plan.some(row => row.detail.includes("SEARCH") && row.detail.includes("state_rows_task_due"))).toBe(true);
        expect(plan.some(row => /SCAN state_rows/.test(row.detail))).toBe(false);
      }
    } finally { db.close(); }
    store.boundedPatch(100, tx => {
      for (let n = 0; n < 100; n++) tx.put(task(`overdue-${String(n).padStart(3, "0")}`));
    });
    decoded = 0;
    expect(store.overdueTaskKeys(["fixture"], NOW).map(key => store!.get(key))).toHaveLength(51);
    expect(decoded).toBe(51);
    expect(() => store!.overdueTaskKeys(["fixture"], NOW, 52)).toThrow("invalid overdue");
  } finally { store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("task reader resolves canonical projects and aliases without a whole-store read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-overdue-alias-"));
  const file = path.join(root, "tasks.json");
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  try {
    saveTasks([task("alias", { project: "due-old" }), task("current", { project: "due-current" }), task("foreign")], file);
    expect(persistProjectAliases([{ source: "due-old", target: "due-current", displayName: "Due fixture" }])).toBe(true);
    expect(overdueTasks("due-old", NOW, file).map(row => row.id)).toEqual(["alias", "current"]);
    expect(overdueTasks("due-current", NOW, file).map(row => row.id)).toEqual(["alias", "current"]);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
