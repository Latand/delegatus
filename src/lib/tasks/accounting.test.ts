import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, patchTask } from "./commands";
import { loadTasks, saveTasks } from "./store";
import { taskRevision } from "./revision";
import { encodeTask } from "@/lib/links/taskWire";
import { taskAccountingSchema } from "./accounting";

const now = "2026-11-01T00:00:00.000Z", later = "2026-11-02T00:00:00.000Z";
const input = { project: "fixture", text: "Deliver the requested change", placement: "unplaced",
  accounting: { criteria: "The recorded example succeeds", taskClass: { size: "small", money: false, access: true, dataMigration: null } } };
const create = () => {
  const result = createTask([], input, [], { now: () => now, id: () => "original" });
  if (!result.ok) throw new Error(result.error);
  return result;
};
test("creation freezes criteria and class; Done alone earns no acceptance", () => {
  const created = create();
  const done = patchTask(created.tasks, created.task.id, { status: "done", text: "A later title" }, later);
  if (!done.ok) throw new Error(done.error);
  expect(done.task.accounting).toEqual({ criteria: input.accounting.criteria, declaredClass: { ...input.accounting.taskClass, project: input.project }, originalTaskId: null, correctsTaskId: null, readyAt: now, accepted: null, holds: [] });
  expect(created.task.status).toBe("inbox");
  expect(taskAccountingSchema.safeParse(done.task.accounting).success).toBe(true);
  expect("accounting" in encodeTask(done.task, { id: "fixture", prefix: "12345678" }).row).toBe(false);
});
test("acceptance requires creation criteria, evidence and current guards; replay preserves its first event", () => {
  const created = create();
  for (const patch of [{ accept: { evidence: "Observed success" } }, { accept: { evidence: "" }, expectedProject: "fixture", expectedRevision: taskRevision(created.task) },
    { accept: { evidence: "Observed success" }, expectedProject: "fixture", expectedRevision: "stale" }]) {
    expect(patchTask(created.tasks, created.task.id, patch, later).ok).toBe(false);
    expect(created.task.accounting!.accepted).toBeNull();
  }
  const guards = { expectedProject: created.task.project, expectedRevision: taskRevision(created.task) };
  const accepted = patchTask(created.tasks, created.task.id, { ...guards, accept: { evidence: "Observed success" } }, later, { actor: "agent" });
  if (!accepted.ok) throw new Error(accepted.error);
  expect(accepted.task.accounting!.accepted).toEqual({ at: later, evidence: "Observed success", by: "agent" });
  const replay = patchTask(accepted.tasks, created.task.id, { expectedProject: "fixture", expectedRevision: taskRevision(accepted.task), accept: { evidence: "Repeated observation" } }, "2026-11-03T00:00:00.000Z");
  expect(replay.ok && replay.task.accounting!.accepted).toEqual(accepted.task.accounting!.accepted);
  const legacy = { ...created.task, accounting: undefined };
  expect(patchTask([legacy], legacy.id, { expectedProject: "fixture", expectedRevision: taskRevision(legacy), accept: { evidence: "Observed success" } }, later).ok).toBe(false);
});
test("task references must exist in the same project and retain original and correction links", () => {
  const root = create();
  for (const accounting of [{ originalTaskId: "missing" }, { correctsTaskId: "missing" }, { taskClass: { money: "yes" } }]) {
    expect(createTask(root.tasks, { ...input, accounting }, [], { now: () => later, id: () => "child" }).ok).toBe(false);
  }
  const result = createTask(root.tasks, { ...input, accounting: { originalTaskId: root.task.id, correctsTaskId: root.task.id } }, [], { now: () => later, id: () => "child" });
  if (!result.ok) throw new Error(result.error);
  expect(result.task.accounting).toMatchObject({ originalTaskId: "original", correctsTaskId: "original" });
  expect(createTask([{ ...root.task, project: "other" }], { ...input, accounting: { correctsTaskId: "original" } }, [], { now: () => later }).ok).toBe(false);
});
test("real task persistence and a fresh process preserve declarations, acceptance and hold history", async () => {
  const created = create();
  const waiting = patchTask(created.tasks, "original", { hold: { kind: "external", note: "Awaiting a reply" } }, later);
  if (!waiting.ok) throw new Error(waiting.error);
  const ready = patchTask(waiting.tasks, "original", { status: "assigned" }, "2026-11-03T00:00:00.000Z");
  if (!ready.ok) throw new Error(ready.error);
  expect(created.task.accounting!.holds).toEqual([]);
  expect(ready.task.accounting!.holds).toEqual([{ kind: "external", since: later, endedAt: "2026-11-03T00:00:00.000Z" }]);
  const accepted = patchTask(ready.tasks, "original", { expectedProject: "fixture", expectedRevision: taskRevision(ready.task), accept: { evidence: "The example succeeds" } }, "2026-11-04T00:00:00.000Z");
  if (!accepted.ok) throw new Error(accepted.error);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "task-accounting-")), "tasks.json");
  saveTasks(accepted.tasks, file);
  expect(loadTasks(file)[0]!.accounting).toEqual(accepted.task.accounting);
  const child = Bun.spawn([process.execPath, "-e", `import { loadTasks } from "./src/lib/tasks/store"; console.log(JSON.stringify(loadTasks(process.argv[1])[0].accounting));`, file], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, errors }).toEqual({ code: 0, errors: "" });
  expect(JSON.parse(output)).toEqual(accepted.task.accounting);
});


test("changing a hold kind records the change time while preserving the board's wait age", () => {
  const root = create();
  const external = patchTask(root.tasks, "original", { hold: { kind: "external" } }, later);
  if (!external.ok) throw new Error(external.error);
  const changedAt = "2026-11-03T00:00:00.000Z";
  const operator = patchTask(external.tasks, "original", { hold: { kind: "operator" } }, changedAt);
  if (!operator.ok) throw new Error(operator.error);
  expect(operator.task.hold!.since).toBe(later);
  const expected = [{ kind: "external", since: later, endedAt: changedAt }, { kind: "operator", since: changedAt, endedAt: null }];
  expect(operator.task.accounting!.holds).toEqual(expected);
  const note = patchTask(operator.tasks, "original", { note: "Awaiting the answer" }, "2026-11-04T00:00:00.000Z");
  expect(note.ok && note.task.accounting!.holds).toEqual(expected);
});
