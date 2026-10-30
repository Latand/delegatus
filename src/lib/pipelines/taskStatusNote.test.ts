import { afterEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { TASKS_FILE, loadTasks, saveTasks, mutateTaskNote } from "@/lib/tasks/store";
import { SqliteStateCollection, StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline } from "./types";
import { writeCompletedTaskSummary, clearEngineParkedTaskNote, writeParkedTaskNote } from "./taskStatusNote";

const at = "2026-10-01T00:00:00.000Z";
const lane = { taskIds: ["target", "other-project", "missing"], project: "fixture", createdAt: at, runs: [] } as unknown as Pipeline;
const task = (id: string, extra: Partial<BoardTask> = {}): BoardTask => ({ id, project: "fixture", text: "Retained task", status: "assigned", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, ...extra });
afterEach(() => saveTasks([]));

test("park and clear use keyed rows and preserve foreign projects, local notes and unknown stored fields", async () => {
  saveTasks([task("target"), task("other-project", { project: "foreign" }), ...Array.from({ length: 400 }, (_, i) => task(`history-${i}`, { details: "retained ".repeat(200) }))]);
  const db = new Database(path.join(path.dirname(TASKS_FILE), "state.sqlite"));
  db.query("UPDATE state_rows SET value_json=json_set(value_json, '$.extension', 'keep') WHERE collection='tasks' AND row_key='t:target'").run();
  db.close();
  const scan = spyOn(SqliteStateCollection.prototype, "loadReadonly").mockImplementation(() => { throw new Error("note materialized the whole board"); });
  try { await writeParkedTaskNote(lane, "signed out"); await clearEngineParkedTaskNote(lane); }
  finally { scan.mockRestore(); }
  const loaded = loadTasks();
  expect(loaded.find(row => row.id === "target")?.note).toBeUndefined();
  expect(loaded.find(row => row.id === "other-project")?.note).toBeUndefined();
  const check = new Database(path.join(path.dirname(TASKS_FILE), "state.sqlite"));
  try { expect(check.query<{ value: string }, []>("SELECT json_extract(value_json, '$.extension') AS value FROM state_rows WHERE collection='tasks' AND row_key='t:target'").get()?.value).toBe("keep"); }
  finally { check.close(); }
});

test.each(["operator", "agent", "orchestrator"] as const)("fresh %s note wins admission and survives engine clear", async kind => {
  const note = { text: "Newer human decision", updatedAt: "2026-10-02T00:00:00.000Z", author: kind === "operator" ? { kind } : { kind, conversationId: "conversation_fixture" } } as BoardTask["note"];
  saveTasks([task("target", { note })]);
  await writeParkedTaskNote(lane, "signed out");
  await clearEngineParkedTaskNote(lane);
  expect(loadTasks()[0]?.note).toEqual(note);
});

test("park waits asynchronously for a real SQLite writer and checks the note after admission", async () => {
  saveTasks([task("target")]);
  const filename = path.join(path.dirname(TASKS_FILE), "state.sqlite");
  const writer = new Database(filename);
  writer.exec("BEGIN IMMEDIATE");
  let released = false;
  let sawWait = false;
  const release = setInterval(() => {
    if (!stateLockWaitsInFlight().some(wait => wait.attempts > 1)) return;
    sawWait = true;
    const note = { text: "Changed while waiting", updatedAt: "2026-10-03T00:00:00.000Z", author: { kind: "operator" } };
    writer.query("UPDATE state_rows SET value_json=json_set(value_json, '$.note', json(?)) WHERE collection='tasks' AND row_key='t:target'").run(JSON.stringify(note));
    writer.exec("COMMIT"); released = true; clearInterval(release);
  }, 1);
  const watchdog = setTimeout(() => { if (!released) { writer.exec("ROLLBACK"); released = true; } }, 2000);
  try {
    await writeParkedTaskNote(lane, "signed out");
    expect(sawWait).toBe(true);
    expect(loadTasks()[0]?.note?.text).toBe("Changed while waiting");
  } finally {
    clearInterval(release); clearTimeout(watchdog);
    if (!released) writer.exec("ROLLBACK");
    writer.close();
  }
});


test.each([1, 2, 3])("matched retained-board note workload, repeat %i", async repeat => {
  const rows = [task("target"), ...Array.from({ length: 1000 }, (_, i) => task(`retained-${i}`, { details: "retained detail ".repeat(300) }))];
  saveTasks(rows);
  loadTasks();
  const original = SqliteStateCollection.prototype.loadReadonly;
  let materializations = 0;
  const scan = spyOn(SqliteStateCollection.prototype, "loadReadonly").mockImplementation(function(this: SqliteStateCollection<unknown>) {
    materializations++; return original.call(this);
  });
  const start = performance.now();
  try {
    for (let write = 0; write < 12; write++) await writeParkedTaskNote({ ...lane, taskIds: ["target"] }, write % 2 ? "budget spent" : "signed out");
  } finally { scan.mockRestore(); }
  console.log(JSON.stringify({ workload: "parked-note", repeat, retainedRows: rows.length, detailCharacters: rows[1]!.details!.length, writes: 12, materializations, elapsedMs: Math.round((performance.now() - start) * 100) / 100 }));
  expect(materializations).toBe(0);
});


test("refused admission never enters the note callback, and a later request succeeds", async () => {
  saveTasks([task("target")]);
  const writer = new Database(path.join(path.dirname(TASKS_FILE), "state.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  let entered = 0;
  try {
    await expect(mutateTaskNote("target", current => { entered++; return current; }, TASKS_FILE, { waitMs: 0 })).rejects.toThrow("state admission timed out");
    expect(entered).toBe(0);
  } finally { writer.exec("ROLLBACK"); writer.close(); }
  await writeParkedTaskNote(lane, "budget spent");
  expect(loadTasks()[0]?.note?.author).toEqual({ kind: "orchestrator" });
});

test("a callback failure rolls back its note and is never replayed", async () => {
  saveTasks([task("target")]);
  let entered = 0;
  await expect(mutateTaskNote("target", current => {
    entered++; current.text = "Must roll back"; throw new Error("callback refused");
  })).rejects.toThrow("callback refused");
  expect(entered).toBe(1);
  expect(loadTasks()[0]?.text).toBe("Retained task");
});


test.each(["park", "clear", "summary"] as const)("%s rechecks pipeline authority after note admission waits", async action => {
  const original = { text: "Existing engine note", author: { kind: "orchestrator" as const }, updatedAt: at };
  saveTasks([task("target", { note: original })]);
  const writer = new Database(path.join(path.dirname(TASKS_FILE), "state.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  let current = true, released = false, checks = 0;
  const assertCurrent = () => { checks++; if (!current) throw new StateSnapshotChangedError(); };
  const release = setInterval(() => {
    if (!stateLockWaitsInFlight().some(wait => wait.attempts > 1)) return;
    current = false; writer.exec("COMMIT"); released = true; clearInterval(release);
  }, 1);
  const watchdog = setTimeout(() => { if (!released) { writer.exec("ROLLBACK"); released = true; } }, 2000);
  try {
    const pending = action === "park" ? writeParkedTaskNote(lane, "budget spent", null, undefined, assertCurrent)
      : action === "clear" ? clearEngineParkedTaskNote(lane, assertCurrent)
      : writeCompletedTaskSummary({ ...lane, id: "lane" }, "verify", { n: 1, conversationId: null,
        report: { verdict: { status: "pass" }, taskSummary: { headline: "Complete", text: "Task outcome." } } } as import("./types").PipelineStageAttempt, at, assertCurrent);
    await expect(pending).rejects.toBeInstanceOf(StateSnapshotChangedError);
    expect(checks).toBe(1);
    expect(loadTasks()[0]?.note).toEqual(original);
    expect(loadTasks()[0]?.summary).toBeUndefined();
  } finally {
    clearInterval(release); clearTimeout(watchdog);
    if (!released) writer.exec("ROLLBACK"); writer.close();
  }
});


test.each(["note", "summary"] as const)("a linked local %s needs no tombstone lease and preserves replicated stamps", async field => {
  const linked = await import("@/lib/links/linked");
  const { TASK_SYNC_GROUPS } = await import("@/lib/tasks/types");
  const { effectiveStamp } = await import("@/lib/links/taskStamp");
  const { installPrefix, derivedStamp } = await import("@/lib/links/stamp");
  const { tombstoneCollection } = await import("@/lib/links/tombstones");
  const id = "00000000-0000-0000-0000-000000000000";
  const prefix = installPrefix(id);
  const sync = { s: { text: derivedStamp(at, prefix) }, o: prefix };
  saveTasks([task("target", { sync })]);
  const companion = tombstoneCollection(path.join(path.dirname(TASKS_FILE), "state.sqlite"), true)!;
  const context = spyOn(linked, "linkedContext").mockReturnValue({ self: { id, prefix }, all: new Set(["fixture"]), links: [], labels: new Map() });
  try {
    await companion.mutate(async () => {
      if (field === "note") {
        await writeParkedTaskNote(lane, "budget spent");
        expect(loadTasks()[0]?.note?.author).toEqual({ kind: "orchestrator" });
      } else {
        await writeCompletedTaskSummary({ ...lane, id: "lane" }, "verify", { n: 1, conversationId: null,
          report: { verdict: { status: "pass" }, taskSummary: { headline: "Complete", text: "Task outcome." } } } as import("./types").PipelineStageAttempt, at);
        expect(loadTasks()[0]?.summary?.author.kind).toBe("stage");
      }
    });
    const current = loadTasks()[0]!;
    for (const group of TASK_SYNC_GROUPS) expect(effectiveStamp(current, group, prefix)).toBe(effectiveStamp(task("target", { sync }), group, prefix));
    expect(current.machine).toBeUndefined();
    expect(companion.snapshot()).toEqual([]);
  } finally { context.mockRestore(); }
});


test("summary completion uses keyed rows, checks authority at write, and retains a newer local note", async () => {
  const note = { text: "New note", updatedAt: at, author: { kind: "operator" as const } };
  saveTasks([task("target", { note }), task("other-project", { project: "foreign" })]);
  const report = { verdict: { status: "pass" }, taskSummary: { headline: "Complete", text: "The task now retains its outcome." } };
  const attempt = { n: 1, conversationId: "conversation_stage", report } as import("./types").PipelineStageAttempt;
  const scan = spyOn(SqliteStateCollection.prototype, "loadReadonly").mockImplementation(() => { throw new Error("summary materialized the board"); });
  let guards = 0;
  try { await writeCompletedTaskSummary({ ...lane, id: "summary-lane" }, "verify", attempt, at, () => { guards++; }); }
  finally { scan.mockRestore(); }
  expect(guards).toBe(2);
  expect(loadTasks().find(row => row.id === "target")).toMatchObject({ note, summary: { ...report.taskSummary, updatedAt: at,
    author: { kind: "stage", pipelineId: "summary-lane", stageId: "verify", attempt: 1, conversationId: "conversation_stage" } } });
  expect(loadTasks().find(row => row.id === "other-project")?.summary).toBeUndefined();
  await expect(writeCompletedTaskSummary(lane, "verify", attempt, at, () => { throw new Error("superseded"); })).rejects.toThrow("superseded");
  expect(loadTasks().find(row => row.id === "target")?.summary?.headline).toBe("Complete");
});


test.each(["fail", "refresh", "absent"] as const)("completion refuses a task summary from %s", async kind => {
  saveTasks([task("target")]);
  const pipeline = { ...lane, id: "summary-lane", ...(kind === "refresh" ? { refreshOf: { pipelineId: "source", base: "a".repeat(40) } } : {}) };
  const attempt = { n: 1, conversationId: null, report: { verdict: { status: kind === "fail" ? "fail" : "pass" },
    ...(kind === "absent" ? {} : { taskSummary: { headline: "Must stay absent", text: "This summary cannot apply." } }) } } as import("./types").PipelineStageAttempt;
  await writeCompletedTaskSummary(pipeline, "verify", attempt, at);
  expect(loadTasks()[0]?.summary).toBeUndefined();
});
