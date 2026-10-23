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
        const plan = db.query<{ detail: string }, [string, string, number, string, number, string]>(`EXPLAIN QUERY PLAN ${OVERDUE_TASK_KEYS_SQL}`)
          .all(JSON.stringify(projects), JSON.stringify([""]), NOW, "[]", 51, "null");
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

// Python exposes SQLite's VM progress counter, so the check measures examined
// work rather than treating a decoder count or a LIMIT as a work bound.
test.skipIf(process.platform !== "linux")("SQLite VM work stays bounded as eligible, future-held and remote prefixes grow", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "overdue-work-"));
  const filename = path.join(root, "state.sqlite");
  try {
    initializeStateCollections(filename, [{ collection: "tasks", schemaVersion: 1, migrationId: "work",
      key: (row: BoardTask) => `t:${row.id}`, loadRecords: () => [] }]);
    const script = `
import sqlite3, sys, json
conn = sqlite3.connect(sys.argv[1])
query, now = sys.argv[2], int(sys.argv[3])
counts = {}
for case in ['eligible', 'held', 'remote', 'eligible-sweep', 'held-sweep', 'remote-sweep', 'eligible-deep', 'eligible-peer']:
    mode = case.split('-')[0]
    cursor = json.dumps([0, 1792627200000, 't:eligible-030']) if case.endswith(('-sweep','-deep')) else json.dumps([0, 1790812800000, 't:prefix-zzzz']) if case.endswith('-peer') else 'null'
    observed = []
    for size in [1000, 10000]:
        conn.execute("DELETE FROM state_rows WHERE collection='tasks'")
        rows = []
        for n in range(size):
            row = dict(id=f'prefix-{n:05}', project='fixture', status='inbox', dueAt='2026-10-01T00:00:00Z')
            if case.endswith(('-deep','-peer')): row['priority'] = 'high'
            if mode == 'held': row['hold'] = dict(until='2026-12-01T00:00:00Z')
            if mode == 'remote': row['machine'] = 'elsewhere'
            rows.append(('tasks', 't:'+row['id'], json.dumps(row), n, 1, 0))
        for n in range(60):
            row = dict(id=f'eligible-{n:03}', project='fixture', status='inbox', priority='high', dueAt='2026-10-22T00:00:00Z')
            rows.append(('tasks', 't:'+row['id'], json.dumps(row), size+n, 1, 0))
        conn.executemany('INSERT INTO state_rows VALUES (?,?,?,?,?,?)', rows)
        conn.commit()
        # Warm statement preparation and schema-cookie revalidation before
        # measuring the two observations under identical conditions.
        params = {'1': json.dumps(['fixture','fixture','alias']), '2': json.dumps(['','self','self']), '3': now, '4': '[]', '5': 51, '6': cursor}
        conn.execute(query, params).fetchall()
        repeats = []
        for repeat in range(2):
            steps = [0]
            def count():
                steps[0] += 1
                return 0
            conn.set_progress_handler(count, 1)
            keys = conn.execute(query, params).fetchall()
            conn.set_progress_handler(None, 0)
            assert len(keys) == 51
            if case.endswith(('-deep','-peer')): assert sum(key[0].startswith('t:eligible-') for key in keys) == 26
            else: assert all(key[0].startswith('t:eligible-') for key in keys)
            repeats.append(steps[0])
        observed.append(repeats)
    counts[case] = observed
print(json.dumps(counts))
`;
    const child = Bun.spawnSync({ cmd: ["python3", "-c", script, filename, OVERDUE_TASK_KEYS_SQL, String(NOW)], stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const counts = JSON.parse(child.stdout.toString()) as Record<string, number[][]>;
    for (const observations of Object.values(counts)) {
      expect(observations[0]![0], JSON.stringify(counts)).toBe(observations[0]![1]);
      expect(observations[1]![0], JSON.stringify(counts)).toBe(observations[1]![1]);
      expect(observations[1]![0]!).toBeLessThanOrEqual(observations[0]![0]! + 50);
      expect(observations[1]![0]!).toBeLessThan(50000);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
