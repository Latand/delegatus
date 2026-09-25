import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { createTask, patchTask } from "./commands";
import { priorityRank, readTaskPriorityInput, renderTaskPriorityRule } from "./priority";
import { taskRevision } from "./revision";
import { loadTasks, mutateTasks, mutateTasksFile } from "./store";
import { taskPriority, type BoardTask } from "./types";

/* Task priority as commands and as stored rows: invented tasks, and a store
   in its own mkdtemp directory, never the live state directory. */

const REV = ["task-v1:00000000", "0000", "4000", "8000", "000000000001"].join("-");
const NOW = "2026-09-25T12:00:00.000Z";

function task(extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task-a",
    project: "fixture",
    text: "Repair old links\nThe anchors moved",
    status: "inbox",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-14T09:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: REV,
    ...extra,
  } as BoardTask;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-priority-"));
  dirs.push(dir);
  return path.join(dir, "tasks.json");
}

test("absent, unknown and normal all read as normal; high and low are the only stored values", () => {
  expect(taskPriority(task())).toBe("normal");
  expect(taskPriority(task({ priority: "high" }))).toBe("high");
  expect(taskPriority({ priority: "urgent" })).toBe("normal");
  expect(taskPriority({ priority: "normal" })).toBe("normal");
  expect(["high", "normal", "low"].map((value) => priorityRank(value as "high"))).toEqual([0, 1, 2]);
  expect(readTaskPriorityInput(" LOW ")).toEqual({ kind: "set", priority: "low" });
  for (const value of [undefined, null, "", "normal"]) expect(readTaskPriorityInput(value)).toEqual({ kind: "clear" });
  expect(readTaskPriorityInput("urgent")).toMatchObject({ kind: "clamped" });
});

test("a create takes a priority, stores normal as nothing, and clamps an unknown one to normal with a note", () => {
  const created = createTask([], { project: "fixture", text: "Ship it", placement: "unplaced", priority: "high" }, [], { now: () => NOW, id: () => "t1" });
  expect(created).toMatchObject({ ok: true, task: { priority: "high" } });
  const normal = createTask([], { project: "fixture", text: "Ship it", placement: "unplaced", priority: "normal" }, [], { now: () => NOW, id: () => "t2" });
  expect(normal.ok && "priority" in normal.task).toBe(false);
  expect(normal.ok && normal.notes).toBeUndefined();
  const odd = createTask([], { project: "fixture", text: "Ship it", placement: "unplaced", priority: "urgent" }, [], { now: () => NOW, id: () => "t3" });
  expect(odd.ok && "priority" in odd.task).toBe(false);
  expect(odd.ok && odd.notes).toEqual(['priority "urgent" is not one of high, normal, low, so the task is normal']);
});

test("a patch sets high or low, normal clears it, anything else is refused with its field, and updatedAt stays", () => {
  const set = patchTask([task()], "task-a", { priority: "low" }, NOW);
  expect(set).toMatchObject({ ok: true, task: { priority: "low" } });
  /* Presentation, not work: the Inbox's order inside a level does not move. */
  expect(set.ok && set.task.updatedAt).toBe(task().updatedAt);
  if (!set.ok) return;
  const cleared = patchTask(set.tasks, "task-a", { priority: "normal" }, NOW);
  expect(cleared.ok && "priority" in cleared.task).toBe(false);
  const nulled = patchTask(set.tasks, "task-a", { priority: null }, NOW);
  expect(nulled.ok && "priority" in nulled.task).toBe(false);
  for (const value of ["urgent", 3, true]) {
    expect(patchTask([task()], "task-a", { priority: value }, NOW)).toMatchObject({ ok: false, status: 400, code: "TASK_INVALID_FIELD", field: "priority" });
  }
  /* With real work in the same patch, updatedAt moves as it always did. */
  const renamed = patchTask([task()], "task-a", { priority: "high", text: "Repair every link" }, NOW);
  expect(renamed.ok && renamed.task.updatedAt).toBe(NOW);
});

test("the store persists priority, a change mints a new revision, and older rows read as normal", () => {
  const file = sandbox();
  const created = mutateTasksFile((state) => {
    const outcome = createTask(state.tasks, { project: "fixture", text: "Ship it", placement: "unplaced" }, state.recentCreates, { id: () => "t1" });
    return { state: outcome.ok ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined, result: outcome };
  }, file);
  expect(created.ok).toBe(true);
  const before = loadTasks(file)[0]!;
  expect(taskPriority(before)).toBe("normal");
  expect("priority" in before).toBe(false);

  const raised = mutateTasks((tasks) => {
    const outcome = patchTask(tasks, "t1", { priority: "high" });
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  }, file);
  expect(raised.ok).toBe(true);
  const after = loadTasks(file)[0]!;
  expect(after.priority).toBe("high");
  expect(taskRevision(after)).not.toBe(taskRevision(before));
  expect(after.updatedAt).toBe(before.updatedAt);

  /* Back to normal leaves no field behind and moves the revision again. */
  mutateTasks((tasks) => {
    const outcome = patchTask(tasks, "t1", { priority: "normal" });
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  }, file);
  const reset = loadTasks(file)[0]!;
  expect("priority" in reset).toBe(false);
  expect(taskRevision(reset)).not.toBe(taskRevision(after));
});

test("both tool descriptions carry one line per level", () => {
  const rule = renderTaskPriorityRule();
  for (const level of ["high = ", "normal = ", "low = "]) expect(rule).toContain(level);
});
