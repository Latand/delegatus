/** Differential replay against a caller-supplied, unmodified source export.
 * Each version runs in a separate process with identical clocks and UUIDs. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { mock, setSystemTime } from "bun:test";
import type { BoardTask } from "../src/lib/tasks/types";

if (process.argv[2] === "--worker") {
  const source = process.argv[3]!;
  const root = process.env.LLV_STATE_DIR!;
  const file = path.join(root, "tasks.json");
  let serial = 100_000;
  const nativeUuid = crypto.randomUUID;
  const uuid = () => new Error().stack?.includes("stampTaskRevisions")
    ? `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}` : nativeUuid();
  mock.module("node:crypto", () => ({ ...crypto, randomUUID: uuid, default: { ...crypto, randomUUID: uuid } }));
  console.info = (...args: unknown[]) => console.error(...args);
  const store = await import(path.join(source, "src/lib/tasks/store.ts")) as typeof import("../src/lib/tasks/store");
  const commands = await import(path.join(source, "src/lib/tasks/commands.ts")) as typeof import("../src/lib/tasks/commands");
  const { persistProjectAliases } = await import(path.join(source, "src/lib/projects/aliases.ts")) as typeof import("../src/lib/projects/aliases");
  const { proactiveScopeHash } = await import(path.join(source, "src/lib/tasks/proactiveScope.ts")) as typeof import("../src/lib/tasks/proactiveScope");
  const { taskRevision } = await import(path.join(source, "src/lib/tasks/revision.ts")) as typeof import("../src/lib/tasks/revision");
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
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ tasks }));
  store.importLegacyTasks(file);
  // This is the unchanged whole-state writer, shared with the reference.
  store.saveTasks(store.loadTasks(file), file);
  if (store.prepareTaskRows) store.prepareTaskRows(file);
  serial = 0;
  const db = new Database(path.join(root, "state.sqlite"), { readonly: true });
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
  const { SqliteStateCollection } = await import(path.join(source, "src/lib/state/sqliteStateStore.ts")) as typeof import("../src/lib/state/sqliteStateStore");
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
      const command = mode === "splice-created"
        ? commands.createTask(state.tasks, { project: "dir-after", text: "Structural", placement: "unplaced", clientRequestId: "structural-request" }, state.recentCreates, { now: at, id: () => "structural-new" })
        : commands.patchTask(state.tasks, "plain", { note: `Structural ${mode}` }, at());
      if (!command.ok) throw new Error(command.error);
      const index = command.tasks.findIndex(task => task.id === command.task.id);
      if (mode === "replace-patched") command.tasks[index] = { ...command.task, text: "Final replacement" };
      else if (mode === "truncate-patched") command.tasks.length = 0;
      else command.tasks.splice(index, 1);
      if (rollback) throw new Error("structural rollback");
      return { state: { ...state, tasks: command.tasks, recentCreates: "recentCreates" in command ? command.recentCreates : state.recentCreates }, result: null };
    }, file);
    assert.throws(() => structural(true), /structural rollback/);
    assert.deepEqual(store.loadTasksFile(file), before);
    structural(false);
    checkpoint({ structural: mode, list: store.loadTasksForList(file) });
    if (mode === "splice-created") create("structural-retry", "structural-request", { text: "Structural" });
    if (mode === "splice-patched") create("plain", "restore-plain", { project: "dir-moved" });
  }
  db.close();
  console.log(JSON.stringify(snapshots));
} else {
  const directory = process.env.LLV_COMPARE_DIR;
  if (!directory || !directory.startsWith(path.resolve(process.env.TMPDIR!) + path.sep)) throw new Error("private LLV_COMPARE_DIR required");
  const sources = process.argv.slice(2);
  assert.equal(sources.length, 2, "pass reference and candidate exports");
  const results: unknown[] = [];
  for (const [index, source] of sources.entries()) {
    const root = path.join(directory, String(index)), temp = path.join(root, "tmp"), state = path.join(temp, "state");
    for (const name of ["home", "config", "tmp/state"]) fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
    const child = Bun.spawn([process.execPath, import.meta.path, "--worker", path.resolve(source)], { cwd: source, stdout: "pipe", stderr: Bun.file(path.join(root, "stderr.log")), env: { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: temp, LLV_STATE_DIR: state, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" } });
    try {
      const output = await new Response(child.stdout).text();
      assert.equal(await child.exited, 0, "replay worker failed; inspect its retained stderr");
      results.push(JSON.parse(output));
    } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  }
  assert.deepEqual(results[1], results[0]);
  console.log(JSON.stringify({ versions: 2, checkpoints: (results[0] as unknown[]).length, equal: true, clocksAndRevisionsCompared: true, aliasTransitions: 1 }));
}
