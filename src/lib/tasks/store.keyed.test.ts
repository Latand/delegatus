import { strict as assert } from "node:assert";
import * as store from "./store";
import * as commands from "./commands";
import { proactiveScopeHash } from "./proactiveScope";
import { readMutationTask } from "./mutationView";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { setStateOwnershipPathsForTests } from "@/lib/stateOwnership";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { canonicalProject, persistProjectAliases } from "@/lib/projects/aliases";
import { updateRemoteProjects } from "@/lib/links/boardLinks";
import { applyTaskRows, resetRowBudgetsForTests } from "@/lib/links/taskApply";
import { encodeTask } from "@/lib/links/taskWire";
import { installPrefix } from "@/lib/links/stamp";
import { createTask, patchTask } from "./commands";
import { importLegacyTasks, loadTasks, loadTasksFile, loadTasksForList, mutateTasks, mutateTasksFile, prepareTaskRows, saveTasks, setTaskPreparationRequester, withTaskPreparation } from "./store";
import { OperationLease } from "@/lib/operationLease";
import type { BoardTask } from "./types";
import { taskRevision } from "./revision";
import { TaskAdmissionEvidence } from "./admissionEvidence";
import { taskSeatHoldingSnapshot } from "./seatHolding";
import { admissionSnapshot } from "./groupHide";
import { DONE_TASK_BOARD_RETENTION_MS } from "./boardVisibility";

const at = "2026-11-01T00:00:00.000Z";
const roots: string[] = [];
const saved = { state: process.env.LLV_STATE_DIR, config: process.env.XDG_CONFIG_HOME };
afterEach(() => {
  process.env.LLV_STATE_DIR = saved.state;
  process.env.XDG_CONFIG_HOME = saved.config;
  setSystemTime();
  resetRowBudgetsForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-keyed-"));
  roots.push(root);
  process.env.LLV_STATE_DIR = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  return { root, file: path.join(root, "tasks.json") };
}

function task(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
  return { id, project: "fixture", text: `Task ${id}`, status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, ...overrides };
}

function seed(file: string, tasks: BoardTask[]) {
  fs.writeFileSync(file, JSON.stringify({ tasks }));
  importLegacyTasks(file);
}

function raw(file: string) {
  const db = new Database(path.join(path.dirname(file), "state.sqlite"), { readonly: true });
  try { return db.query<{ row_key: string; value_json: string; row_revision: number }, []>(
    "SELECT row_key,value_json,row_revision FROM state_rows WHERE collection='tasks' ORDER BY row_order,row_key").all(); }
  finally { db.close(); }
}

test("nested draft edits and a following command preserve both changes and roll back together", () => {
  const { file } = sandbox();
  seed(file, [task("target"), task("other")]); prepareTaskRows(file);
  const assignment = { path: "fixture/composed.jsonl", panePid: null, state: "delivered" as const, error: null, at, conversationId: "composed" };
  const edit = (refuse: boolean) => mutateTasks(tasks => {
    tasks.find(row => row.id === "target")!.assignments.push(assignment);
    const result = patchTask(tasks, "target", { text: "composed edit", status: "done" }, at);
    if (!result.ok) throw new Error(result.error);
    if (refuse) throw new Error("refused composed edit");
    return { tasks: result.tasks, result: null };
  }, file);
  const before = raw(file);
  expect(() => edit(true)).toThrow("refused composed edit");
  expect(raw(file)).toEqual(before);
  edit(false);
  const persisted = loadTasks(file).find(row => row.id === "target")!;
  expect(persisted.assignments).toEqual([assignment]);
  expect(persisted.text).toBe("composed edit");
  expect(persisted.doneAdmissions).toEqual(admissionSnapshot([assignment]));
  expect(raw(file).find(row => row.row_key === "t:other")).toEqual(before.find(row => row.row_key === "t:other"));
});

for (const access of ["input", "output"] as const) test(`command followed by nested ${access} edits shares assignments and rolls back`, () => {
  const { file } = sandbox();
  seed(file, [task("target"), task("other")]); prepareTaskRows(file);
  const assignment = { path: "fixture/after.jsonl", panePid: null, state: "delivered" as const, error: null, at, conversationId: "after" };
  const write = (refuse: boolean) => mutateTasks(tasks => {
    const out = patchTask(tasks, "target", { text: "changed" }, at);
    if (!out.ok) throw new Error(out.error);
    (access === "input" ? tasks : out.tasks).find(row => row.id === "target")!.assignments.push(assignment);
    const done = patchTask(out.tasks, "target", { status: "done" }, at);
    if (!done.ok) throw new Error(done.error);
    if (refuse) throw new Error("rollback after command");
    return { tasks: done.tasks, result: null };
  }, file);
  const before = raw(file);
  expect(() => write(true)).toThrow("rollback after command");
  expect(raw(file)).toEqual(before);
  write(false);
  expect(loadTasks(file).find(row => row.id === "target")).toMatchObject({ text: "changed", assignments: [assignment], doneAdmissions: admissionSnapshot([assignment]) });
  expect(raw(file).find(row => row.row_key === "t:other")).toEqual(before.find(row => row.row_key === "t:other"));
});

for (const lookup of ["keyed", "array"] as const) test(`${lookup} lookup and command refresh only changed payloads over successive revisions`, () => {
  const { file } = sandbox();
  seed(file, Array.from({ length: 4599 }, (_, i) => task(`lookup-${i}`, { details: "x".repeat(5000) })));
  prepareTaskRows(file); loadTasksForList(file);
  // Preparation/list readers own the full revision before the first lookup write.
  const full = spyOn(SqliteStateCollection.prototype, "loadReadonly").mockImplementation(() => { throw new Error("repeated full payload read"); });
  const clone = spyOn(globalThis, "structuredClone");
  const entries = Object.entries;
  let shallow = 0;
  const copies = spyOn(Object, "entries").mockImplementation((value: object) => {
    if (value && typeof value === "object" && "id" in value && "status" in value) shallow++;
    return entries(value);
  });
  const orders = SqliteStateCollection.prototype.keyMetadata;
  const metadata = orders && spyOn(SqliteStateCollection.prototype, "keyMetadata").mockImplementation(function(this: SqliteStateCollection<BoardTask>, keys) {
    expect(keys.length).toBeLessThan(2);
    return orders.call(this, keys);
  });
  const stringify = JSON.stringify;
  const retained: BoardTask[][] = [];
  const slice = Array.prototype.slice;
  const slices = spyOn(Array.prototype, "slice").mockImplementation(function(this: unknown[], ...args: [number?, number?]) {
    if (this.length >= 4599) throw new Error("full task reference vector copied during lookup write");
    return Reflect.apply(slice, this, args);
  });
  const NativeProxy = Proxy;
  let wrappers = 0;
  globalThis.Proxy = new NativeProxy(NativeProxy, {
    construct(target, args) { wrappers++; return Reflect.construct(target, args); },
  });
  let payloads = 0;
  const json = spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
    if (value && typeof value === "object" && "id" in value && "status" in value) payloads++;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  });
  try {
    const read = (rows: BoardTask[]) => lookup === "keyed" ? readMutationTask(rows, "lookup-4598") : rows.find(row => row.id === "lookup-4598");
    for (let i = 0; i < 3; i++) mutateTasks(tasks => {
      retained.push(tasks);
      expect(read(tasks)?.id).toBe("lookup-4598");
      const result = patchTask(tasks, "lookup-4598", i % 2 ? { note: `note ${i}` } : { text: `text ${i}` }, at);
      if (result.ok) expect(read(result.tasks)?.text).toBe(`text ${i === 1 ? 0 : i}`);
      return { tasks: result.ok ? result.tasks : undefined, result };
    }, file);
    expect(payloads).toBeLessThan(30);
    expect(clone.mock.calls.length).toBeLessThan(30);
    // Mutable array predicates open a shallow draft for every visited row.
    // Keyed readers open only their selected draft. Neither copies payloads.
    expect(shallow).toBeLessThan(lookup === "keyed" ? 30 : 4599 * 3 + 30);
    expect(wrappers).toBeLessThan(60);
  } finally { globalThis.Proxy = NativeProxy; slices.mockRestore(); full.mockRestore(); clone.mockRestore(); json.mockRestore(); copies.mockRestore(); metadata?.mockRestore(); }
  expect(retained.map(rows => rows.find(row => row.id === "lookup-4598")?.text)).toEqual(["Task lookup-4598", "text 0", "text 0"]);
});

for (const mode of ["replace-patched", "splice-patched", "truncate-patched", "splice-created"] as const) {
  test(`final structural array wins over command plan: ${mode}, rollback and receipt replay`, () => {
    setSystemTime(new Date(at));
    const { file } = sandbox();
    seed(file, [task("target"), task("other")]); prepareTaskRows(file);
    const before = raw(file);
    const original = loadTasksForList(file);
    const revision = taskRevision(original[0]!);
    const write = (refuse: boolean) => mutateTasksFile(state => {
      let recentCreates = state.recentCreates;
      const out = mode === "splice-created"
        ? (() => {
          const created = createTask(state.tasks, { project: "fixture", text: "New", placement: "unplaced", clientRequestId: "structural-create" }, recentCreates, { now: () => at, id: () => "new" });
          if (created.ok) recentCreates = created.recentCreates;
          return created;
        })()
        : patchTask(state.tasks, "target", { note: "Command edit", expectedProject: "fixture", expectedRevision: revision }, at);
      if (!out.ok) throw new Error(out.error);
      const index = out.tasks.findIndex(row => row.id === out.task.id);
      if (mode === "replace-patched") out.tasks[index] = { ...out.task, text: "Replacement" };
      else if (mode === "truncate-patched") out.tasks.length = 0;
      else out.tasks.splice(index, 1);
      if (refuse) throw new Error("structural rollback");
      return { state: { ...state, tasks: out.tasks, recentCreates }, result: null };
    }, file);
    expect(() => write(true)).toThrow("structural rollback");
    expect(raw(file)).toEqual(before);
    write(false);
    const expectedIds = mode === "truncate-patched" ? [] : mode === "splice-patched" ? ["other"] : ["target", "other"];
    const persisted = loadTasksFile(file);
    expect(persisted.tasks.map(row => row.id)).toEqual(expectedIds);
    expect(loadTasksForList(file).map(row => row.id)).toEqual(expectedIds);
    expect(original.map(row => row.id)).toEqual(["target", "other"]);
    expect(original[0]!.text).toBe("Task target");
    if (mode === "replace-patched") {
      expect(persisted.tasks[0]).toMatchObject({ text: "Replacement", note: { text: "Command edit" } });
      expect(taskRevision(persisted.tasks[0]!)).not.toBe(revision);
    }
    if (mode !== "truncate-patched") expect(raw(file).find(row => row.row_key === "t:other")).toEqual(before.find(row => row.row_key === "t:other"));
    if (mode === "splice-created") {
      expect(persisted.recentCreates).toHaveLength(1);
      const replay = mutateTasksFile(state => {
        const out = createTask(state.tasks, { project: "fixture", text: "New", placement: "unplaced", clientRequestId: "structural-create" }, state.recentCreates, { now: () => at, id: () => "replacement-new" });
        return { state: out.ok ? { ...state, tasks: out.tasks, recentCreates: out.recentCreates } : undefined, result: out };
      }, file);
      expect(replay.ok && replay.task.id).toBe("replacement-new");
      expect(loadTasksFile(file).tasks.map(row => row.id)).toEqual(["target", "other", "replacement-new"]);
    }
  });
}

test("seventeen project rotations retain admission facts and apply journaled edits", () => {
  setSystemTime(new Date(at));
  const { file } = sandbox();
  seed(file, Array.from({ length: 4599 }, (_, i) => task(`rotation-${i}`, { project: `project-${i % 17}`, status: "done", board: "hidden", doneAt: at, doneAdmissions: [], details: "x".repeat(5000) })));
  prepareTaskRows(file); loadTasksForList(file);
  const create = (project: number, pass: number) => mutateTasksFile(state => {
    const out = createTask(state.tasks, { project: `project-${project}`, text: "Rotation", placement: "unplaced" }, state.recentCreates, { now: () => at, id: () => `new-${pass}-${project}` });
    return { state: out.ok ? { ...state, tasks: out.tasks } : undefined, result: out };
  }, file);
  const facts = spyOn(TaskAdmissionEvidence.prototype, "put");
  const read = spyOn(SqliteStateCollection.prototype, "taskProjectKeys").mockImplementation(() => { throw new Error("project refill"); });
  try {
    for (let project = 0; project < 17; project++) expect(create(project, 0).ok).toBe(true);
    for (let project = 0; project < 17; project++) expect(create(project, 1).ok).toBe(true);
    expect(facts.mock.calls.length).toBeLessThan(40);
  } finally { facts.mockRestore(); read.mockRestore(); }
});

test("array reader follows peer edits and deletion while an earlier view keeps its revision", () => {
  const { file, root } = sandbox();
  seed(file, [task("a"), task("b")]); prepareTaskRows(file); loadTasksForList(file);
  const old = mutateTasks(tasks => {
    expect(tasks.find(row => row.id === "b")?.text).toBe("Task b");
    return { tasks: undefined, result: tasks };
  }, file);
  const peer = new SqliteStateCollection<BoardTask>(path.join(root, "state.sqlite"), { collection: "tasks", schemaVersion: 1,
    key: row => `t:${row.id}`, decode: value => value as BoardTask, clone: structuredClone, busyMessage: "peer busy" });
  try { peer.boundedPatch(3, tx => { tx.delete("t:a"); tx.put(task("b", { text: "Peer edit" })); tx.put(task("c")); }); }
  finally { peer.close(); }
  const before = raw(file);
  mutateTasks(tasks => {
    expect(tasks.find(row => row.id === "a")).toBeUndefined();
    expect(tasks.findLast(row => row.id === "b")?.text).toBe("Peer edit");
    expect(tasks.map(row => row.id)).toEqual(["b", "c"]);
    tasks.find(row => row.id === "b")!.text = "Discarded";
    return { tasks: undefined, result: null };
  }, file);
  expect(old.find(row => row.id === "b")?.text).toBe("Task b");
  expect(old.find(row => row.id === "a")?.text).toBe("Task a");
  expect(raw(file)).toEqual(before);
});

test("a cached array lookup reconciles only a peer's changed finding group before revision guards", () => {
  const { file, root } = sandbox();
  seed(file, [task("keeper", { findingKey: "incident", finding: { count: 2, lastSeenAt: at } }), task("other")]);
  prepareTaskRows(file); loadTasksForList(file);
  mutateTasks(tasks => { expect(tasks.find(row => row.id === "keeper")?.finding?.count).toBe(2); return { tasks: undefined, result: null }; }, file);
  const peer = new SqliteStateCollection<BoardTask>(path.join(root, "state.sqlite"), { collection: "tasks", schemaVersion: 1,
    key: row => `t:${row.id}`, decode: value => value as BoardTask, clone: structuredClone, busyMessage: "peer busy" });
  try { peer.boundedPatch(1, tx => tx.put(task("late", { findingKey: "incident", finding: { count: 3, lastSeenAt: at } }))); }
  finally { peer.close(); }
  const expected = loadTasksForList(file).find(row => row.id === "keeper")!;
  const result = mutateTasks(tasks => {
    const keeper = tasks.find(row => row.id === "keeper")!;
    expect(keeper.finding?.count).toBe(5);
    expect(taskRevision(keeper)).toBe(taskRevision(expected));
    const out = patchTask(tasks, "keeper", { note: "Peer group", expectedProject: "fixture", expectedRevision: taskRevision(expected) }, at);
    return { tasks: out.ok ? out.tasks : undefined, result: out };
  }, file);
  expect(result.ok).toBe(true);
  expect(loadTasksForList(file).find(row => row.id === "keeper")?.finding?.count).toBe(5);
  expect(loadTasksForList(file).find(row => row.id === "late")?.findingKey).toBeUndefined();
});

for (const boundary of ["snapshot", "metadata"] as const) test(`reader warming discards a revision changed after ${boundary}`, () => {
  const { file, root } = sandbox();
  seed(file, [task("a"), task("b")]); prepareTaskRows(file);
  const peer = new SqliteStateCollection<BoardTask>(path.join(root, "state.sqlite"), { collection: "tasks", schemaVersion: 1,
    key: row => `t:${row.id}`, decode: value => value as BoardTask, clone: structuredClone, busyMessage: "peer busy" });
  peer.boundedPatch(1, tx => tx.put(task("b", { text: "Before reader" })));
  const method = boundary === "snapshot" ? "loadReadonly" : "keyMetadata";
  const original = SqliteStateCollection.prototype[method];
  let raced = false;
  const read = spyOn(SqliteStateCollection.prototype, method).mockImplementation(function(this: SqliteStateCollection<BoardTask>, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    if (!raced) { raced = true; peer.boundedPatch(1, tx => tx.put(task("b", { text: "Racing writer" }))); }
    return result;
  });
  try { loadTasksForList(file); }
  finally { read.mockRestore(); peer.close(); }
  expect(raced).toBe(true);
  const before = raw(file);
  mutateTasks(tasks => {
    expect(tasks.find(row => row.id === "b")?.text).toBe("Racing writer");
    return { tasks: undefined, result: null };
  }, file);
  expect(raw(file)).toEqual(before);
});

test("4599 rows in one project: hidden creates skip history and visible creates refresh only changed admission facts", () => {
  const { file } = sandbox();
  seed(file, Array.from({ length: 4599 }, (_, i) => task(`history-${i}`, { status: "done", board: "hidden", doneAt: at, doneAdmissions: [], details: "x".repeat(5000) })));
  prepareTaskRows(file);
  loadTasksForList(file);
  const now = new Date(Date.parse(at) + DONE_TASK_BOARD_RETENTION_MS + 1).toISOString();
  const create = (id: string, board: "hidden" | "shown") => mutateTasksFile(state => {
    const result = createTask(state.tasks, { project: "fixture", text: id, placement: "unplaced", board }, state.recentCreates, { now: () => now, id: () => id, seatHolding: taskSeatHoldingSnapshot(() => ({ active: null, pending: null }) as never) });
    return { state: result.ok ? { ...state, tasks: result.tasks, recentCreates: result.recentCreates } : undefined, result };
  }, file);
  const order = SqliteStateCollection.prototype.keysInOrder;
  const sort = spyOn(SqliteStateCollection.prototype, "keysInOrder").mockImplementation(function(this: SqliteStateCollection<BoardTask>, keys, limit) {
    expect(keys.filter(key => key.startsWith("t:")).length).toBeLessThan(2);
    return order.call(this, keys, limit);
  });
  const read = spyOn(SqliteStateCollection.prototype, "loadReadonly").mockImplementation(() => { throw new Error("full read"); });
  const projectRead = spyOn(SqliteStateCollection.prototype, "taskProjectKeys").mockImplementation(() => { throw new Error("project history read"); });
  const facts = spyOn(TaskAdmissionEvidence.prototype, "put");
  try {
    expect(create("hidden", "hidden").ok).toBe(true);
    expect(facts).not.toHaveBeenCalled();
    expect(create("warm", "shown").ok).toBe(true);
    facts.mockClear();
    for (let i = 0; i < 3; i++) {
      mutateTasks(tasks => {
        const result = patchTask(tasks, "history-4598", { note: `note ${i}` }, now);
        return { tasks: result.ok ? result.tasks : undefined, result };
      }, file);
      expect(create(`visible-${i}`, "shown").ok).toBe(true);
    }
    expect(facts.mock.calls.length).toBeLessThan(10);
  } finally { facts.mockRestore(); read.mockRestore(); sort.mockRestore(); projectRead.mockRestore(); }
});

test("admission summaries keep the strict expiry boundary, seat candidates and changed rows", () => {
  const { file } = sandbox();
  const assignment = { path: "fixture/seat.jsonl", panePid: null, state: "delivered" as const, error: null, at, conversationId: "seat" };
  seed(file, [...Array.from({ length: 299 }, (_, i) => task(`visible-${i}`)), task("done", { status: "done", doneAt: at, doneAdmissions: admissionSnapshot([assignment]), assignments: [assignment] })]);
  prepareTaskRows(file); loadTasksForList(file);
  const expires = Date.parse(at) + DONE_TASK_BOARD_RETENTION_MS;
  const create = (id: string, now: number, seat: boolean) => mutateTasksFile(state => {
    const result = createTask(state.tasks, { project: "fixture", text: id, placement: "unplaced" }, state.recentCreates, { id: () => id, now: () => new Date(now).toISOString(), seatHolding: taskSeatHoldingSnapshot(() => ({ active: seat ? { conversationId: "seat" } : null, pending: null }) as never) });
    return { state: result.ok ? { ...state, tasks: result.tasks } : undefined, result };
  }, file);
  expect(create("at-boundary", expires, false)).toMatchObject({ ok: false, code: "TASK_BOARD_FULL" });
  expect(create("seat-held", expires + 1, true)).toMatchObject({ ok: false, code: "TASK_BOARD_FULL" });
  expect(create("after-expiry", expires + 1, false).ok).toBe(true);
  // The preceding accepted create is now the 300th visible band.
  expect(create("full", expires + 2, false)).toMatchObject({ ok: false, code: "TASK_BOARD_FULL" });
  mutateTasks(tasks => {
    const result = patchTask(tasks, "visible-0", { board: "hidden" }, new Date(expires + 3).toISOString());
    return { tasks: result.ok ? result.tasks : undefined, result };
  }, file);
  expect(create("freed", expires + 3, false).ok).toBe(true);
});

test("keyed create retains completed finding order and validates accounting references", () => {
  const { file } = sandbox();
  seed(file, [task("first", { status: "done", findingKey: "incident", finding: { count: 1, lastSeenAt: at } }),
    task("second", { status: "done", findingKey: "incident", finding: { count: 1, lastSeenAt: at } }),
    task("parent"), task("other-project", { project: "elsewhere" })]);
  prepareTaskRows(file); loadTasksForList(file);
  const create = (id: string, accounting: unknown, findingKey?: string) => mutateTasksFile(state => {
    const result = createTask(state.tasks, { project: "fixture", text: id, placement: "unplaced", board: "hidden", accounting, findingKey }, state.recentCreates, { id: () => id, now: () => at });
    return { state: result.ok ? { ...state, tasks: result.tasks } : undefined, result };
  }, file);
  const accepted = create("followup", { originalTaskId: "parent" }, "incident");
  expect(accepted.ok && accepted.task.finding?.previousTaskId).toBe("first");
  expect(accepted.ok && accepted.task.accounting?.originalTaskId).toBe("parent");
  const before = raw(file);
  expect(create("invalid", { correctsTaskId: "other-project" })).toMatchObject({ ok: false, field: "accounting" });
  expect(create("missing", { originalTaskId: "absent" })).toMatchObject({ ok: false, field: "accounting" });
  expect(create("nested", { originalTaskId: "followup" })).toMatchObject({ ok: false, field: "accounting" });
  expect(raw(file)).toEqual(before);
});

test("preparation equals the old full writer, preserves extensions and is idempotent", () => {
  setSystemTime(new Date("2026-11-05T00:00:00.000Z"));
  const declaration = createTask([], { project: "fixture", text: "Accounting", placement: "unplaced" }, [], { now: () => at, id: () => "accounting" });
  if (!declaration.ok) throw new Error(declaration.error);
  const accounting = { ...declaration.task.accounting!, readyAt: null };
  const rows = [task("done", { status: "done" }), task("non-done", { doneAt: at, doneAdmissions: [] }), task("accounting", { accounting }), task("unrelated")];
  Object.assign(rows[0]!, { extension: { preserved: ["fixture", 7] } });
  const nextUuid = crypto.randomUUID;
  let token = 0;
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => new Error().stack?.includes("stampTaskRevisions")
    ? `00000000-0000-4000-8000-${String(++token).padStart(12, "0")}` : nextUuid());
  try {
    const old = sandbox(); seed(old.file, rows);
    const oldTasks = loadTasks(old.file);
    oldTasks.at(-1)!.text = "Unrelated edit";
    token = 0; saveTasks(oldTasks, old.file);
    const expected = raw(old.file).filter(row => row.row_key !== "t:unrelated");
    const next = sandbox(); seed(next.file, rows);
    token = 0;
    expect(prepareTaskRows(next.file)).toBe(3);
    expect(raw(next.file).filter(row => row.row_key !== "t:unrelated")).toEqual(expected);
    const prepared = raw(next.file);
    expect(prepareTaskRows(next.file)).toBe(0);
    expect(raw(next.file)).toEqual(prepared);
    fs.unlinkSync(path.join(next.root, "tasks-row-preparation.json"));
    expect(prepareTaskRows(next.file)).toBe(0);
    expect(raw(next.file)).toEqual(prepared);
    expect(fs.readdirSync(path.join(next.root, "backups/sqlite")).length).toBeGreaterThan(0);
  } finally { uuid.mockRestore(); }
});

test("an interrupted preparation rolls back every row and the retry finishes", () => {
  const { file, root } = sandbox();
  seed(file, [task("a", { status: "done" }), task("b", { status: "done" })]);
  const previous = raw(file);
  expect(() => prepareTaskRows(file, { afterPersist: () => { throw new Error("interrupted before commit"); } })).toThrow("interrupted before commit");
  expect(raw(file)).toEqual(previous);
  expect(fs.existsSync(path.join(root, "tasks-row-preparation.json"))).toBe(false);
  expect(prepareTaskRows(file)).toBe(2);
  expect(prepareTaskRows(file)).toBe(0);
});

test("preparation refuses an owner that cannot run startup mutations in an operator-shaped sandbox", () => {
  const { root } = sandbox();
  const fakeHome = path.join(root, "operator");
  const privateTemp = path.join(root, "temp");
  fs.mkdirSync(privateTemp);
  const restorePaths = setStateOwnershipPathsForTests({ home: fakeHome, tempRoots: [privateTemp] });
  const previous = { tmp: process.env.TMPDIR, owner: process.env.LLV_STATE_OWNER };
  process.env.TMPDIR = privateTemp;
  process.env.LLV_STATE_OWNER = "tool";
  try {
    expect(() => prepareTaskRows(path.join(fakeHome, ".config/delegatus/state/tasks.json"))).toThrow("task row preparation");
  } finally {
    process.env.TMPDIR = previous.tmp;
    process.env.LLV_STATE_OWNER = previous.owner;
    restorePaths();
  }
});

test("an expired preparation waiter cannot enter its application callback after the owner replies", async () => {
  const { root } = sandbox();
  const home = path.join(root, "operator"), temp = path.join(root, "temp");
  const directory = path.join(home, ".config/delegatus/state");
  fs.mkdirSync(temp); fs.mkdirSync(directory, { recursive: true });
  const restorePaths = setStateOwnershipPathsForTests({ home, tempRoots: [temp] });
  const previous = { tmp: process.env.TMPDIR, owner: process.env.LLV_STATE_OWNER, NODE_ENV: process.env.NODE_ENV };
  process.env.TMPDIR = temp; process.env.LLV_STATE_DIR = directory;
  process.env.LLV_STATE_OWNER = "viewer";
  const file = path.join(directory, "tasks.json");
  let restoreRequester = () => {};
  try {
    Object.assign(process.env, { NODE_ENV: "production" });
    seed(file, [task("kept")]);
    const before = raw(file), lease = new OperationLease();
    let callbackCalls = 0, requests = 0;
    process.env.LLV_STATE_OWNER = "mcp";
    restoreRequester = setTaskPreparationRequester(async () => {
      requests++; await Promise.resolve(); lease.expire();
    });
    await expect(lease.run(() => withTaskPreparation(() => mutateTasks(() => {
      callbackCalls++; throw new Error("late callback");
    }, file)))).rejects.toThrow("controller pass deadline exceeded");
    expect(requests).toBe(1);
    expect(callbackCalls).toBe(0);
    expect(raw(file)).toEqual(before);
    expect(fs.existsSync(path.join(directory, "tasks-row-preparation.json"))).toBe(false);
  } finally {
    restoreRequester(); restorePaths(); process.env.TMPDIR = previous.tmp; process.env.LLV_STATE_OWNER = previous.owner;
    Object.assign(process.env, { NODE_ENV: previous.NODE_ENV });
  }
});

test("keyed commands never load history and keep guards, receipt replay and finding uniqueness", () => {
  const { file } = sandbox();
  seed(file, Array.from({ length: 120 }, (_, i) => task(`row-${i}`, { project: i === 119 ? "fixture" : "history", details: "Retained context. ".repeat(200) })));
  prepareTaskRows(file);
  const before = raw(file);
  const originalRevision = taskRevision(loadTasks(file).find(task => task.id === "row-119")!);
  loadTasksForList(file);
  const read = spyOn(SqliteStateCollection.prototype, "loadReadonly").mockImplementation(() => { throw new Error("unexpected whole collection read"); });
  const projectRead = spyOn(SqliteStateCollection.prototype, "taskProjectKeys").mockImplementation(() => { throw new Error("unexpected refill after a list read"); });
  try {
    const changed = mutateTasks(tasks => {
      const result = patchTask(tasks, "row-119", { note: "A note", expectedProject: "fixture", expectedRevision: originalRevision }, at);
      return { tasks: result.ok ? result.tasks : undefined, result };
    }, file);
    expect(changed.ok).toBe(true);
    const write = (request: string, id: string) => mutateTasksFile(state => {
      const result = createTask(state.tasks, { project: "fixture", findingKey: "occurrence", text: "A finding", placement: "unplaced", clientRequestId: request }, state.recentCreates, { now: () => at, id: () => id });
      return { state: result.ok && !result.replay ? { tasks: result.tasks, recentCreates: result.recentCreates } : undefined, result };
    }, file);
    const first = write("first", "finding");
    const replay = write("first", "unused");
    const matched = write("second", "unused");
    expect(first.ok && first.task.id).toBe("finding");
    expect(replay.ok && replay.replay).toBe(true);
    expect(matched.ok && matched.matched).toBe(true);
    const stale = mutateTasks(tasks => {
      const result = patchTask(tasks, "row-119", { text: "Stale", expectedProject: "fixture", expectedRevision: originalRevision }, at);
      return { tasks: result.ok ? result.tasks : undefined, result };
    }, file);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("TASK_REVISION_MISMATCH");
    const after = raw(file);
    expect(after.slice(0, 119)).toEqual(before.slice(0, 119));
  } finally { read.mockRestore(); projectRead.mockRestore(); }
});

test("a late legacy row is normalized only when that row is touched", () => {
  const { file, root } = sandbox();
  seed(file, [task("a"), task("b")]); prepareTaskRows(file);
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    const legacy = task("late", { status: "done" });
    db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES ('tasks','t:late',?,2,2,0)").run(JSON.stringify(legacy));
    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='tasks'").run();
  } finally { db.close(); }
  const late = raw(file).find(row => row.row_key === "t:late")!;
  mutateTasks(tasks => {
    const result = patchTask(tasks, "a", { note: "Another row" }, at);
    return { tasks: result.ok ? result.tasks : undefined, result };
  }, file);
  expect(raw(file).find(row => row.row_key === "t:late")).toEqual(late);
  mutateTasks(tasks => {
    const result = patchTask(tasks, "late", { note: "Touched legacy row" }, at);
    return { tasks: result.ok ? result.tasks : undefined, result };
  }, file);
  const persisted = loadTasksFile(file).tasks.find(task => task.id === "late")!;
  expect(persisted.doneAt).toBe(at);
  expect(persisted.doneAdmissions).toEqual([]);
  expect(JSON.parse(raw(file).find(row => row.row_key === "t:late")!.value_json).doneAt).toBe(at);
});

test("a late finding duplicate keeps the reader's guard and normalizes only its indexed group", () => {
  const { file, root } = sandbox();
  seed(file, [task("keeper", { findingKey: "incident", finding: { count: 2, lastSeenAt: at } }), task("unrelated")]);
  prepareTaskRows(file);
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES ('tasks','t:late',?,2,2,0)")
      .run(JSON.stringify(task("late", { findingKey: "incident", finding: { count: 3, lastSeenAt: at } })));
    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='tasks'").run();
  } finally { db.close(); }
  const projected = loadTasksFile(file).tasks.find(task => task.id === "keeper")!;
  const unrelated = raw(file).find(row => row.row_key === "t:unrelated");
  const result = mutateTasks(tasks => {
    const result = patchTask(tasks, "keeper", { note: "Group edit", expectedProject: "fixture", expectedRevision: taskRevision(projected) }, at);
    return { tasks: result.ok ? result.tasks : undefined, result };
  }, file);
  expect(result.ok).toBe(true);
  const rows = raw(file).map(row => JSON.parse(row.value_json) as BoardTask);
  expect(rows.find(task => task.id === "keeper")?.finding?.count).toBe(5);
  expect(rows.find(task => task.id === "late")?.findingKey).toBeUndefined();
  expect(raw(file).find(row => row.row_key === "t:unrelated")).toEqual(unrelated);
});

test("two keyed writers on different rows retain both edits", async () => {
  const { root, file } = sandbox();
  seed(file, [task("a"), task("b")]); prepareTaskRows(file);
  const gate = path.join(root, "start");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    for (const id of ["a", "b"]) children.push(Bun.spawn([process.execPath, path.join(import.meta.dir, "store.sqliteChild.ts"), "keyed-patch", file, id, gate], { stdout: "ignore", stderr: "pipe" }));
    fs.writeFileSync(gate, "start");
    for (const child of children) expect(await child.exited).toBe(0);
    const rows = loadTasks(file);
    expect(rows.map(row => row.note?.text)).toEqual(["a-2", "b-2"]);
  } finally {
    for (const child of children) if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
});

test("a process killed after preparation writes rolls back, then a new process can recover", async () => {
  const { root, file } = sandbox();
  seed(file, [task("a", { status: "done" }), task("b", { status: "done" })]);
  const before = raw(file);
  const ready = path.join(root, "ready");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "store.sqliteChild.ts"), "hold-preparation", file, ready], { stdout: "ignore", stderr: "pipe" });
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(10);
    expect(fs.existsSync(ready)).toBe(true);
    child.kill("SIGKILL"); await child.exited;
    expect(raw(file)).toEqual(before);
    const recovery = Bun.spawn([process.execPath, path.join(import.meta.dir, "store.sqliteChild.ts"), "recover-preparation", file], { stdout: "pipe", stderr: "pipe" });
    try {
      const [output, errors, code] = await Promise.all([new Response(recovery.stdout).text(), new Response(recovery.stderr).text(), recovery.exited]);
      expect(code, errors).toBe(0);
      expect(JSON.parse(output)).toEqual({ changedRows: 2, repeat: 0 });
    } finally { if (recovery.exitCode === null) { recovery.kill("SIGKILL"); await recovery.exited; } }
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
});

test("a peer edit wins over preparation exactly as it wins over the old first write", () => {
  const remote = "code.example.test/acme/widget";
  const project = projectIdentityFromRemote(`https://${remote}`, "/")!.project;
  const self = ["0a0a0a0a", "1111", "4111", "8111", "111111111111"].join("-");
  const peer = ["0b0b0b0b", "2222", "4222", "8222", "222222222222"].join("-");
  const taskId = ["0d0d0d0d", "4444", "4444", "8444", "444444444444"].join("-");
  const preparedAt = Date.parse("2026-11-05T00:00:00.000Z");
  const point = (root: string) => { process.env.LLV_STATE_DIR = root; process.env.XDG_CONFIG_HOME = path.join(root, "config"); };
  const install = (local: string, other: string) => {
    const fixture = sandbox();
    fs.mkdirSync(path.join(fixture.root, "links"));
    fs.writeFileSync(path.join(fixture.root, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [project]: remote } }));
    fs.writeFileSync(path.join(fixture.root, "links/self.json"), JSON.stringify({ v: 1, installId: local, label: "fixture", publicUrl: null, check: null }));
    fs.writeFileSync(path.join(fixture.root, "links/shared.json"), JSON.stringify({ v: 1, all: false, projects: [project] }));
    fs.writeFileSync(path.join(fixture.root, "links/peers.json"), JSON.stringify({ v: 1, peers: [{ id: other, url: "https://peer.example.test", token: "t".repeat(43), grantId: crypto.randomUUID(), install: other, label: "fixture peer", store: crypto.randomUUID(), state: "active", lastCall: null, error: null }] }));
    const result = createTask([], { project, text: "Legacy linked row", placement: "unplaced" }, [], { now: () => at, id: () => taskId });
    if (!result.ok) throw new Error(result.error);
    result.task.accounting!.readyAt = null;
    seed(fixture.file, [result.task]);
    updateRemoteProjects(other, [{ key: project, name: "fixture" }], crypto.randomUUID());
    return fixture;
  };
  const nativeUuid = crypto.randomUUID;
  let token = 0;
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => new Error().stack?.includes("stampTaskRevisions")
    ? `00000000-0000-4000-8000-${String(++token).padStart(12, "0")}` : nativeUuid());
  const run = (prepared: boolean) => {
    token = 0; setSystemTime(new Date(preparedAt));
    const local = install(self, peer);
    if (prepared) prepareTaskRows(local.file);
    else saveTasks(loadTasks(local.file), local.file);
    const other = install(peer, self);
    setSystemTime(new Date(preparedAt + 1000));
    const edited = patchTask(loadTasks(other.file), taskId, { text: "Peer edit" }, new Date(preparedAt + 1000).toISOString(), { explicit: true });
    if (!edited.ok) throw new Error(edited.error);
    saveTasks(edited.tasks, other.file);
    const wire = encodeTask(loadTasks(other.file)[0]!, { id: peer, prefix: installPrefix(peer) }).row;
    point(local.root);
    const applied = applyTaskRows([wire], { key: `peer:${peer}`, install: peer, prefix: installPrefix(peer), projects: new Set([project]) }, { now: preparedAt + 1000, filePath: local.file });
    expect(applied.changed).toBe(1);
    const after = loadTasks(local.file)[0]!;
    expect(after.text).toBe("Peer edit");
    expect(after.machine).toBe(self);
    return after;
  };
  try { expect(run(true)).toEqual(run(false)); }
  finally { uuid.mockRestore(); }
});

test("array predicates reuse one leased alias snapshot and a refusal restores the outer resolver", () => {
  const { file } = sandbox();
  seed(file, Array.from({ length: 120 }, (_, i) => task(`row-${i}`)));
  expect(persistProjectAliases([{ source: "alias", target: "fixture", displayName: "Fixture" }])).toBe(true);
  prepareTaskRows(file);
  const stat = fs.statSync;
  let aliasStats = 0;
  const reads = spyOn(fs, "statSync").mockImplementation(((...args: unknown[]) => {
    if (new Error().stack?.includes("at canonicalProject")) aliasStats++;
    return Reflect.apply(stat, fs, args);
  }) as typeof fs.statSync);
  try {
    mutateTasks(tasks => {
      const last = tasks.findLast(task => canonicalProject(task.project) === canonicalProject("alias"))!;
      const result = patchTask(tasks, last.id, { note: "Changed" }, at);
      return { tasks: result.ok ? result.tasks : undefined, result };
    }, file);
    expect(aliasStats).toBe(0);
  } finally { reads.mockRestore(); }
  expect(() => mutateTasks(() => { throw new Error("callback refused"); }, file)).toThrow("callback refused");
  expect(persistProjectAliases([{ source: "later", target: "fixture", displayName: "Fixture" }])).toBe(true);
  expect(canonicalProject("later")).toBe("fixture");
});

for (const mode of ["owner", "refused"]) test.skipIf(process.platform !== "linux")(`the real private task channel delegates preparation to its ${mode} Viewer`, async () => {
  const { root } = sandbox();
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "store.preparationChild.ts"), root, mode], { stdout: "pipe", stderr: "pipe" });
  try {
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, errors).toBe(0);
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ mode, privateChannel: true, workerStartupAuthority: false, preparations: mode === "owner" ? 3 : 0 });
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}, 60_000);

for (const method of ["find", "findLast", "findIndex", "findLastIndex"] as const) {
  for (const output of [false, true]) test(`${method} predicates retain mutable row and array identity on ${output ? "command output" : "input"}`, () => {
    const { file } = sandbox();
    seed(file, [task("extra-a", { assignments: [{ path: "fixture/predicate.jsonl", panePid: null, state: "delivered", error: null, at }] }), task("extra-b")]);
    prepareTaskRows(file);
    const retained = loadTasksForList(file);
    const before = raw(file);
    const write = (rollback: boolean) => mutateTasks(tasks => {
      const command = output ? patchTask(tasks, "extra-b", { text: "Command edit" }, at) : undefined;
      if (command && !command.ok) throw new Error(command.error);
      const rows = command?.ok ? command.tasks : tasks;
      const receiver = { visited: [] as number[] };
      const found = rows[method](function(this: typeof receiver, row, index, array) {
        expect(this).toBe(receiver);
        expect(array).toBe(rows);
        expect(row).toBe(array[index]!);
        this.visited.push(index);
        if (row.id !== "extra-a") return false;
        row.text = "Edited inside predicate";
        row.assignments[0]!.state = "failed";
        return true;
      }, receiver);
      expect(found).toBe(method === "findIndex" || method === "findLastIndex" ? 0 : rows[0]!);
      expect(receiver.visited).toEqual(method === "findLast" || method === "findLastIndex" ? [1, 0] : [0]);
      expect(rows[method](() => false)).toBe(method === "findIndex" || method === "findLastIndex" ? -1 : undefined);
      const other = [task("borrowed")];
      const borrowed = Reflect.apply(rows[method], other, [(row: BoardTask) => row.id === "borrowed"]);
      expect(borrowed).toBe(method === "findIndex" || method === "findLastIndex" ? 0 : other[0]!);
      if (rollback) throw new Error("predicate rollback");
      return { tasks: rows, result: null };
    }, file);
    expect(() => write(true)).toThrow("predicate rollback");
    expect(raw(file)).toEqual(before);
    write(false);
    expect(loadTasks(file).find(row => row.id === "extra-a")).toMatchObject({ text: "Edited inside predicate", assignments: [{ state: "failed" }] });
    expect(retained[0]).toMatchObject({ text: "Task extra-a", assignments: [{ state: "delivered" }] });
  });
}

test("mixed identity replay matches all 45 whole-state writer checkpoints", () => {
  const { root, file } = sandbox();
  let serial = 100_000;
  const nativeUuid = crypto.randomUUID;
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => new Error().stack?.includes("stampTaskRevisions")
    ? `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}` : nativeUuid());
  try {
    let instant = Date.parse("2026-11-05T00:00:00.000Z");
    const at = () => new Date(instant).toISOString();
    const freeze = () => setSystemTime(new Date(instant));
    freeze();
    const make = (id: string, project: string): BoardTask => {
      const result = commands.createTask([], { project, text: `Task ${id}`, placement: "unplaced" }, [], { now: at, id: () => id });
      if (!result.ok) throw new Error(result.error);
      return result.task;
    };
    const a = make("finding-a", "dir-before"), b = make("finding-b", "dir-after");
    for (const task of [a, b]) { task.findingKey = "incident"; task.finding = { count: 2, lastSeenAt: at() }; }
    const done = make("done", "dir-after"); done.status = "done";
    const accounting = make("accounting", "dir-after"); accounting.accounting!.readyAt = null;
    const proactive = make("proactive", "dir-before");
    proactive.proactive = { episode: at(), candidateKey: "candidate", sources: ["fixture"], score: [1, 1, 1, 1], scopeHash: proactiveScopeHash(proactive), scopeRevision: 0 };
    const tasks = [a, b, done, accounting, proactive, make("plain", "dir-after")];
    fs.writeFileSync(file, JSON.stringify({ tasks }));
    store.importLegacyTasks(file);
    // This is the unchanged whole-state writer, shared with the reference.
    store.saveTasks(store.loadTasks(file), file);
    if (store.prepareTaskRows) store.prepareTaskRows(file);
    serial = 0;
    const db = new Database(path.join(root, "state.sqlite"), { readonly: true });
    try {
      const snapshots: unknown[] = [];
      const checkpoint = (result: unknown) => snapshots.push({ result, state: store.loadTasksFile(file), rows: db.query("SELECT row_key,value_json,row_order,row_revision FROM state_rows WHERE collection='tasks' ORDER BY row_order,row_key").all() });
      const patch = (id: string, input: Parameters<typeof commands.patchTask>[2]) => {
        instant += 1000; freeze();
        const result = store.mutateTasks(tasks => {
          const outcome = commands.patchTask(tasks, id, input, at());
          return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
        }, file);
        checkpoint(result.ok ? { ok: true, id: result.task.id, revision: taskRevision(result.task), notes: result.notes } : result);
      };
      const create = (id: string, request: string, extra: Parameters<typeof commands.createTask>[1] = {}) => {
        instant += 1000; freeze();
        const result = store.mutateTasksFile(state => {
          const outcome = commands.createTask(state.tasks, { project: "dir-after", text: `Created ${id}`, placement: "unplaced", clientRequestId: request, ...extra }, state.recentCreates, { now: at, id: () => id });
          return { state: outcome.ok && !outcome.replay ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined, result: outcome };
        }, file);
        checkpoint(result.ok ? { ok: true, id: result.task.id, revision: taskRevision(result.task), replay: result.replay, matched: result.matched } : result);
      };
      checkpoint({ prepared: true });
      const initial = taskRevision(store.loadTasks(file).find(task => task.id === "plain")!);
      patch("plain", { text: "Edited", expectedProject: "dir-after", expectedRevision: initial });
      patch("plain", { note: "A note" });
      patch("plain", { text: "Stale", expectedProject: "dir-after", expectedRevision: initial });
      create("created", "first", { findingKey: "new-occurrence" });
      create("unused", "first", { findingKey: "new-occurrence" });
      create("unused", "second", { findingKey: "new-occurrence" });
      const legacyWriter = new SqliteStateCollection<BoardTask>(path.join(root, "state.sqlite"), {
        collection: "tasks", schemaVersion: 1, key: row => `t:${row.id}`,
        busyMessage: "fixture state busy", decode: value => value as BoardTask, clone: row => structuredClone(row),
      });
      const late = make("late-finding", "dir-after");
      late.findingKey = "incident"; late.finding = { count: 3, lastSeenAt: at() };
      legacyWriter.boundedPatch(1, tx => tx.put(late));
      checkpoint({ lateFinding: true });
      const keeper = store.loadTasksFile(file).tasks.find(task => task.id === "finding-b")!;
      patch("finding-b", { note: "Late finding guard", expectedProject: "dir-after", expectedRevision: taskRevision(keeper) });
      instant += 1000; freeze();
      assert(persistProjectAliases([{ source: "dir-before", target: "dir-after", displayName: "Fixture" }]));
      if (store.prepareTaskRows) store.prepareTaskRows(file);
      else store.mutateTasks(tasks => ({ tasks: tasks.slice(), result: null }), file);
      checkpoint({ aliased: true });
      patch("plain", { findingKey: "incident" });
      patch("done", { status: "inbox" });
      patch("done", { status: "done" });
      instant += 1000; freeze();
      store.mutateTasks(tasks => {
        const task = tasks.find(task => task.id === "done")!;
        task.assignments.push({ path: "fixture/new.jsonl", panePid: null, state: "delivered", error: null, at: at(), conversationId: "fixture-new" });
        task.updatedAt = at();
        return { tasks, result: null };
      }, file);
      checkpoint({ admitted: true });
      patch("plain", { color: "amber" });
      patch("plain", { color: "amber" });
      instant += 1000; freeze();
      store.mutateTasks(tasks => {
        const result = commands.deleteTask(tasks, "created");
        if (!result.ok) throw new Error(result.error);
        return { tasks: result.tasks, result: null };
      }, file);
      checkpoint({ deleted: true });
      create("recreated", "first", { findingKey: "new-occurrence" });
      instant += 1000; freeze();
      store.mutateTasks(tasks => { tasks.reverse(); return { tasks, result: null }; }, file);
      checkpoint({ reverse: true, list: store.loadTasksForList(file).map(task => task.id), selected: store.loadTasksByIds(new Set(["plain", "done"]), file).map(task => task.id) });
      instant += 1000; freeze();
      const saved = JSON.stringify(store.loadTasksFile(file));
      assert.throws(() => store.mutateTasks(tasks => { tasks[0]!.text = "rollback edit"; throw new Error("intentional refusal"); }, file), /intentional refusal/);
      assert.equal(JSON.stringify(store.loadTasksFile(file)), saved);
      checkpoint({ rollback: true });
      store.mutateTasks(tasks => {
        const first = commands.patchTask(tasks, "plain", { note: "first composed command" }, at());
        if (!first.ok) throw new Error(first.error);
        const second = commands.patchTask(first.tasks, "done", { color: "lime" }, at());
        if (!second.ok) throw new Error(second.error);
        return { tasks: second.tasks, result: null };
      }, file);
      checkpoint({ twoCommands: true });
      instant += 1000; freeze();
      store.mutateTasks(tasks => {
        tasks.find(task => task.id === "plain")!.assignments.push({ path: "fixture/composed.jsonl", panePid: null, state: "delivered", error: null, at: at(), conversationId: "composed" });
        const result = commands.patchTask(tasks, "plain", { text: "composed edit" }, at());
        if (!result.ok) throw new Error(result.error);
        return { tasks: result.tasks, result: null };
      }, file);
      checkpoint({ composedNestedAndCommand: true });
      for (const access of ["input", "output"] as const) {
        instant += 1000; freeze();
        store.mutateTasks(tasks => {
          const command = commands.patchTask(tasks, "plain", { note: `command then nested ${access}` }, at());
          if (!command.ok) throw new Error(command.error);
          (access === "input" ? tasks : command.tasks).find(task => task.id === "plain")!.assignments.push({ path: `fixture/${access}.jsonl`, panePid: null, state: "delivered", error: null, at: at(), conversationId: access });
          if (access === "output") command.tasks.reverse();
          return { tasks: command.tasks, result: null };
        }, file);
        checkpoint({ commandThenNested: access });
      }
      instant += 1000; freeze();
      store.mutateTasks(tasks => {
        tasks.find(task => task.id === "plain")!.project = "dir-moved";
        const command = commands.patchTask(tasks, "plain", { color: "lime" }, at());
        if (!command.ok) throw new Error(command.error);
        return { tasks: command.tasks, result: null };
      }, file);
      checkpoint({ projectMove: true, list: store.loadTasksForList(file).map(task => [task.id, task.project]), selected: store.loadTasksByIds(new Set(["plain", "done"]), file).map(task => [task.id, task.project]) });
      patch("plain", { status: "done" });
      patch("plain", { status: "inbox" });
      create("mixed-finding", "mixed-new", { findingKey: "incident" });
      patch("accounting", { findingKey: "incident" });
      checkpoint({ finalMixed: true });
      for (const mode of ["replace-patched", "splice-created", "splice-patched", "truncate-patched"]) {
        instant += 1000; freeze();
        const before = store.loadTasksFile(file);
        const structural = (rollback: boolean) => store.mutateTasksFile(state => {
          let recentCreates = state.recentCreates;
          const command = mode === "splice-created"
            ? (() => {
              const created = commands.createTask(state.tasks, { project: "dir-after", text: "Structural", placement: "unplaced", clientRequestId: "structural-request" }, recentCreates, { now: at, id: () => "structural-new" });
              if (created.ok) recentCreates = created.recentCreates;
              return created;
            })()
            : commands.patchTask(state.tasks, "plain", { note: `Structural ${mode}` }, at());
          if (!command.ok) throw new Error(command.error);
          const index = command.tasks.findIndex(task => task.id === command.task.id);
          if (mode === "replace-patched") command.tasks[index] = { ...command.task, text: "Final replacement" };
          else if (mode === "truncate-patched") command.tasks.length = 0;
          else command.tasks.splice(index, 1);
          if (rollback) throw new Error("structural rollback");
          return { state: { ...state, tasks: command.tasks, recentCreates }, result: null };
        }, file);
        assert.throws(() => structural(true), /structural rollback/);
        assert.deepEqual(store.loadTasksFile(file), before);
        structural(false);
        checkpoint({ structural: mode, list: store.loadTasksForList(file) });
        if (mode === "splice-created") create("structural-retry", "structural-request", { text: "Structural" });
        if (mode === "splice-patched") create("plain", "restore-plain", { project: "dir-moved" });
      }

      create("extra-a", "extra-a", { project: "dir-extra" });
      create("extra-b", "extra-b", { project: "dir-extra" });
      const mixed = (label: string, mutate: (tasks: BoardTask[]) => BoardTask[] | undefined) => {
        instant += 1000; freeze();
        let error: string | null = null;
        try { store.mutateTasks(tasks => ({ tasks: mutate(tasks), result: null }), file); }
        catch (e) { error = e instanceof Error ? e.name : String(e); }
        checkpoint({ reviewerMixed: label, error, list: store.loadTasksForList(file), selected: store.loadTasksByIds(new Set(["extra-a", "extra-b"]), file) });
      };
      mixed("two commands and done admission", tasks => {
        const a = commands.patchTask(tasks, "extra-a", { status: "done", note: "a note" }, at());
        if (!a.ok) throw new Error(a.error);
        a.task.assignments.push({ path: "fixture/reviewer.jsonl", panePid: null, state: "delivered", error: null, at: at(), conversationId: "fixture-reviewer" });
        const b = commands.patchTask(a.tasks, "extra-b", { text: "Second changed" }, at());
        if (!b.ok) throw new Error(b.error);
        return b.tasks;
      });
      mixed("rollback after replacement", tasks => {
        const a = commands.patchTask(tasks, "extra-a", { text: "Rolled back" }, at());
        if (!a.ok) throw new Error(a.error);
        a.tasks.splice(0, 1);
        throw new Error("rollback");
      });
      mixed("reverse then guarded command", tasks => {
        tasks.reverse();
        const before = tasks.find(t => t.id === "extra-a")!;
        const a = commands.patchTask(tasks, "extra-a", { color: "amber", expectedProject: before.project, expectedRevision: taskRevision(before) }, at());
        if (!a.ok) throw new Error(a.error);
        return a.tasks;
      });
      mixed("nested edit and refused command", tasks => {
        tasks.find(t => t.id === "extra-a")!.assignments[0]!.error = "changed nested";
        const staleRevision = `task-v1:00000000-0000-4000-8000-${String(999_999_999_999)}`;
        const a = commands.patchTask(tasks, "extra-a", { text: "Should refuse", expectedProject: "dir-extra", expectedRevision: staleRevision }, at());
        assert.equal(a.ok, false);
        return tasks;
      });
      mixed("command output structural change then next command", tasks => {
        const a = commands.patchTask(tasks, "extra-b", { note: "before deletion" }, at());
        if (!a.ok) throw new Error(a.error);
        a.tasks.splice(a.tasks.findIndex(t => t.id === "extra-b"), 1);
        const b = commands.patchTask(a.tasks, "extra-a", { status: "inbox" }, at());
        if (!b.ok) throw new Error(b.error);
        return b.tasks;
      });
      store.mutateTasks(tasks => {
        const byIdentity = tasks.find((row, i, rows) => row.id === "extra-a" && rows[i] === row);
        const byArray = tasks.find((row, _i, rows) => row.id === "extra-a" && rows === tasks);
        checkpoint({ reviewerMixed: "pure predicate identity", byIdentity: byIdentity?.id ?? null, byArray: byArray?.id ?? null });
        return { tasks: undefined, result: null };
      }, file);
      mixed("predicate mutates visited row", tasks => {
        const index = tasks.findIndex(task => {
          if (task.id !== "extra-a") return false;
          task.text = "Edited inside predicate";
          task.assignments[0]!.state = "failed";
          return true;
        });
        assert(index >= 0);
        return tasks;
      });

      // Captured from the unmodified whole-state writer at d040eef4955f.
      // Hash canonical keys only; values include exact JSON, row order/revisions,
      // task revisions, receipts, refusals and predicate results.
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
      const expected = [
        "8a5430af329e374354a4e37d1ed45850c7d756248bb0e650d1a5b182493253e0",
        "93984561fe5ce288c6b7710487bfa4b6fb220d96ddc2fa4596c4a9b1af01fbce",
        "ecbc7df095dd11385d2edbba0e264251ec3dc690e7690f91c943846ffab1610c",
        "25e728a2ad1c8fcf42d511be4a67078fcd594026039b40c4f4d0988cf690831c",
        "289ee8f38202bebe59e51c94ead34795d15f7116b03615a9fbcf3b376c3524e1",
        "081062443ae0cebc69ff90a4230a54b2d8c23f2bfdc9aa42dcd5afb23c2be3d2",
        "3c7d7fc3be2355a050d6ec7595d4c53ff0c118c299e34eaee80b1813603c4eb7",
        "f08f66a1a3f9a088e26d21df371b0043f0ab34557b694b1dcef5e1ab54fc0ead",
        "a44b2b322431b8a5747f5ad654799442d29733926a2c69443b2365e33a839ea2",
        "a3075a91188bd3b1951f1e632a0f47092bd7c72066c2eee04c612b69536c1c67",
        "ccee6b278129f7503c75345c6924c828fe3519fbdb75bf5ee1aa64d131df8931",
        "90a5a8751393be37321ed93c301f0ae565e8fa02c944e418f3624bb472626315",
        "a3934b880c248b388f3e81eb3e7d214b931b8f1e68d97ec9c3d34dbbd3f2c88d",
        "810ceca38fe036ed35df913ca4867101645eac2f65e2a898d3d66416933aa524",
        "037a92cc339a7dd6447f9ae658538db205ea347eeb48494a40394faa9ce3d28a",
        "fc618536e05b5a475ab70a63b5b8993e4cee0ed22d59e8031fd57d57ae4827eb",
        "0c4c338ae717635eb9897f7df49c7450df71e3a19b1f27d9e46b788c91637788",
        "f55921d8f2f45a039afd490e77bc520f28955e80c2a130f63212499cf64d562a",
        "d0eb1c9c4c22dede49350245c2a185c904739b8beecd7dfb04facf84ac6cab69",
        "57ef8b6b28acc21771d512746d9226845d87af67a6dce3835072bda5c11b8042",
        "f77a907f1193baeb548ba79b3ed388d90dcd64d1bfc8a86e79d01a7acd99ff33",
        "f3658307bb555e9d381bd49d305a1431ba85ba708e1af7df4e62e44ba30bd9ee",
        "97d8b5643763dd1172cd6a9b450f98bd46b807efadc4f658f5a8ebcb45fb48c7",
        "85242c3b9c54c5c73c223472843c7d6f8b7b5540d02c21a69110beecc31bd5ca",
        "d79dc186a89c9cdf02779bd18447c8d26f7a2576922079b480ae4b04d21f10b4",
        "726eecadea274a0adc90da41168c1c73d0820ec59121f2b351651be50ee4f86d",
        "b687bbb7cd12032df7018032e5584d44e89ce94470fe069437636bb6aae1369c",
        "3726dda2ab155113c87fc39a4f9bf2acbc9844ab67a52adf6420b13f710fe2f3",
        "405d5968b77fd88f77521f73278fe4ef25b7f516d28795a58c1d9133823642e3",
        "1ce985a6d280e80ec6eab6ef10a8d7ca34e2555b635986141c3c738c8dee8412",
        "b1b83f9fd5eb9279813473034cad5de9d5977ef8824278c84457f16c7ea19b22",
        "6fe6ced313a887b555d3bb971cb6e368d658393e020fe9bc804b20e394ca52f2",
        "56425d5a4f3e174b1c18caf1ccb5ccba01d725881d4074994745d8f75f8b5ed0",
        "4ae8a7b1510b69f5b8eba9ec162e2699169ab8c62237e7d5580f4c7670fd5cda",
        "422c9d7337bb26e1c44125c971dc975ff857ff88d403de30bf2e0f0a44bf9854",
        "3ce829137e51b8c390bcbdd2df4d86fab2c2a085768379030a35d622a6a4c6b8",
        "43a3709299c71ef8edc9b5a27e59282cfe63bcd06b4ec59c0df2f61d647d7628",
        "ac2b2f1fb9853f537c3b37cd3f06a1b9ba5c141e8888b0aa733c2f79cf86134f",
        "a84c80da50d709e7e21a7657d1dd78000ce22bbdbac57c2bfdecd2d3af07d73a",
        "b1edd6130bb7457c97f9d15141dc131403537ce6b95b5849881ed39be60dfaa5",
        "6e663d370d1dc26ba5e2f5045d38c56832abbe71951716b0c7f72a167d68a601",
        "fbb8c2d06117abf236dfc5c47f730e8e680efcc81d6591daa41becf6237c7a6c",
        "a0caffbb1339a5d1bd470df6552c86a161ba32d2b5e94815895649c346ef5729",
        "92e18a3f6f9b4e004f926ce6868e6d24d7792d056545e87ccfd5101623b25994",
        "a695b3e8a74066054b4d6333fd7a4f6daa360debb85f46ead786eec8bffca965"
    ];
      const actual = snapshots.map(snapshot => crypto.createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex"));
      const mismatches = actual.flatMap((hash, index) => hash === expected[index] ? [] : [index]);
      console.log(JSON.stringify({ mixedIdentityCheckpoints: actual.length, mismatches }));
      expect(actual).toHaveLength(45);
      expect(mismatches).toEqual([]);
    } finally { db.close(); }
  } finally { uuid.mockRestore(); }
});
