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

test("array lookup and command refresh only changed payloads over successive revisions", () => {
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
  let payloads = 0;
  const json = spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
    if (value && typeof value === "object" && "id" in value && "status" in value) payloads++;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  });
  try {
    for (let i = 0; i < 3; i++) mutateTasks(tasks => {
      expect(tasks.findLast(row => row.id === "lookup-4598")?.id).toBe("lookup-4598");
      expect(tasks.find(row => row.id === "lookup-4598")?.id).toBe("lookup-4598");
      const result = patchTask(tasks, "lookup-4598", i % 2 ? { note: `note ${i}` } : { text: `text ${i}` }, at);
      if (result.ok) expect(result.tasks.find(row => row.id === "lookup-4598")?.text).toBe(`text ${i === 1 ? 0 : i}`);
      return { tasks: result.ok ? result.tasks : undefined, result };
    }, file);
    expect(payloads).toBeLessThan(30);
    expect(clone.mock.calls.length).toBeLessThan(30);
    expect(shallow).toBeLessThan(30);
  } finally { full.mockRestore(); clone.mockRestore(); json.mockRestore(); copies.mockRestore(); metadata?.mockRestore(); }
});

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
