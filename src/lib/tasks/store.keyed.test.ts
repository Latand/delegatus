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
