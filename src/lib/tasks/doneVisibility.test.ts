import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DONE_TASK_BOARD_RETENTION_MS, countBoardTasks, taskShowsOnBoard } from "./boardVisibility";
import { createTask, patchTask } from "./commands";
import { withTaskCompletion } from "./completion";
import { loadTasks, mutateTasks, saveTasks } from "./store";
import { taskRevision } from "./revision";
import { finishBoardTask } from "@/lib/forge/autoMerge";
import type { BoardTask, TaskAssignment } from "./types";

const DONE = "2026-09-20T00:00:00.000Z";
const END = Date.parse(DONE) + DONE_TASK_BOARD_RETENTION_MS;
const member: TaskAssignment = { path: "/fixture/worker.jsonl", conversationId: "worker", panePid: null, state: "linked", error: null, at: DONE };
function task(over: Partial<BoardTask> = {}): BoardTask {
  return { id: "task", project: "fixture", text: "Retained history", status: "assigned", placement: "unplaced", assignments: [member], createdAt: DONE, updatedAt: DONE, ...over };
}
const completed = () => withTaskCompletion(task({ status: "done" }));

test("done entry is stamped, repeated done and edits preserve it, reopen clears it", () => {
  const done = patchTask([task()], "task", { status: "done" }, DONE);
  expect(done.ok).toBe(true);
  if (!done.ok) throw new Error(done.error);
  expect(done.task.doneAt).toBe(DONE);
  expect(done.task.doneAdmissions).toContain("worker");
  const edit = patchTask(done.tasks, "task", { status: "done", text: "Edited history" }, "2026-09-24T00:00:00Z");
  if (!edit.ok) throw new Error(edit.error);
  expect(edit.task.doneAt).toBe(DONE);
  for (const status of ["inbox", "assigned", "blocked"] as const) {
    const reopened = patchTask(edit.tasks, "task", { status });
    if (!reopened.ok) throw new Error(reopened.error);
    expect(reopened.task.doneAt).toBeUndefined();
    expect(reopened.task.doneAdmissions).toBeUndefined();
    expect(taskShowsOnBoard(reopened.task, false, { now: END + 1 })).toBe(true);
  }
});

test("three-day boundary is strict; old members and shown flags cannot retain a band", () => {
  for (const board of [undefined, "shown", "hidden"] as const) {
    const row = { ...completed(), board };
    expect(taskShowsOnBoard(row, true, { now: END - 1 })).toBe(true);
    expect(taskShowsOnBoard(row, true, { now: END })).toBe(true);
    expect(taskShowsOnBoard(row, true, { now: END + 1 })).toBe(false);
    expect(countBoardTasks([row], "fixture", () => true, () => ({ now: END + 1 }))).toBe(0);
  }
});

test("927 old done tasks with members free capacity; recent bands still enforce 300", () => {
  const old = Array.from({ length: 927 }, (_, index) => ({ ...completed(), id: `old-${index}` }));
  expect(countBoardTasks(old, "fixture", () => true, () => ({ now: END + 1 }))).toBe(0);
  const deps = { now: () => new Date(END + 1).toISOString(), id: () => "new", hasBoardMembers: () => true };
  expect(createTask(old, { project: "fixture", text: "New work", placement: "unplaced" }, [], deps).ok).toBe(true);
  const full = [...old, ...Array.from({ length: 300 }, (_, index) => task({ id: `live-${index}` }))];
  const refused = createTask(full, { project: "fixture", text: "Full", placement: "unplaced" }, [], deps);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.code).toBe("TASK_BOARD_FULL");
});

test("the current seat survives expiry and remains protected from group hide", () => {
  const row = completed();
  const context = { now: END + 1, seat: { conversationIds: ["worker"], paths: [] } };
  expect(taskShowsOnBoard(row, false, context)).toBe(true);
  expect(countBoardTasks([row], "fixture", () => false, () => context)).toBe(1);
  const hidden = patchTask([row], row.id, { hide: true, expectedProject: row.project, expectedRevision: taskRevision(row) }, DONE, { seatHolding: () => "holds" });
  if (hidden.ok) throw new Error("seat was hidden");
  expect(hidden.code).toBe("TASK_HIDE_PROTECTED");
});

test("new admission resurfaces, reconciliation of an old admission does not", () => {
  const row = completed();
  expect(taskShowsOnBoard({ ...row, assignments: [{ ...member, at: new Date(END + 1).toISOString() }] }, true, { now: END + 2 })).toBe(false);
  expect(taskShowsOnBoard({ ...row, assignments: [...row.assignments, { ...member, path: "/fixture/new.jsonl", conversationId: "new" }] }, true, { now: END + 2 })).toBe(true);
});

test("a fresh decision request resurfaces; a decision predating expiry does not", () => {
  const row = completed();
  const members = (at: number) => [{ path: member.path!, pendingQuestion: { askedAt: new Date(at).toISOString() }, waitingInput: null }] as never;
  expect(taskShowsOnBoard(row, true, { now: END + 2, members: members(END - 1) })).toBe(false);
  expect(taskShowsOnBoard(row, true, { now: END + 2, members: members(END + 1) })).toBe(true);
});

test("legacy backfill freezes updatedAt, persists once, retains extensions and search history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "done-backfill-"));
  const file = path.join(directory, "tasks.json");
  const row = { ...task({ status: "done" }), extension: { retained: true } };
  fs.writeFileSync(file, JSON.stringify({ tasks: [row] }));
  const loaded = loadTasks(file)[0]!;
  expect(loaded.doneAt).toBe(DONE);
  const before = taskRevision(loaded);
  mutateTasks((tasks) => ({ tasks, result: null }), file);
  const saved = loadTasks(file)[0]!;
  expect(taskRevision(saved)).not.toBe(before);
  expect((saved as typeof row).extension).toEqual(row.extension);
  mutateTasks((tasks) => ({ tasks, result: null }), file);
  expect(taskRevision(loadTasks(file)[0]!)).toBe(taskRevision(saved));
  mutateTasks((tasks) => {
    const edited = patchTask(tasks, row.id, { text: "Searchable retained history" }, "2026-09-29T00:00:00Z");
    if (!edited.ok) throw new Error(edited.error);
    return { tasks: edited.tasks, result: null };
  }, file);
  expect(loadTasks(file)[0]!.doneAt).toBe(DONE);
  expect(loadTasks(file).filter((item) => item.text.includes("Searchable"))).toHaveLength(1);
});

test("the production lane/merge completion writer stamps doneAt under the task lock", () => {
  saveTasks([task({ id: "finish-writer" })]);
  expect(finishBoardTask("finish-writer")).toBe("moved");
  const finished = loadTasks().find((row) => row.id === "finish-writer")!;
  expect(finished.doneAt).toBe(finished.updatedAt);
  expect(finished.doneAdmissions).toContain("worker");
  expect(finishBoardTask("finish-writer")).toBe("already-done");
  expect(loadTasks()[0]!.doneAt).toBe(finished.doneAt);
});

test("store catches direct and in-place status writers and clears timestamps on reopen", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "done-direct-")), "tasks.json");
  saveTasks([task()], file);
  mutateTasks((tasks) => {
    tasks[0]!.status = "done";
    tasks[0]!.updatedAt = "2026-09-21T00:00:00Z";
    return { tasks, result: null };
  }, file);
  expect(loadTasks(file)[0]!.doneAt).toBe("2026-09-21T00:00:00Z");
  mutateTasks((tasks) => {
    tasks[0]!.status = "assigned";
    return { tasks, result: null };
  }, file);
  expect(loadTasks(file)[0]!.doneAt).toBeUndefined();
});


test("setting shown on an expired row takes no slot, including on a full board", () => {
  const old = completed();
  const full = [old, ...Array.from({ length: 300 }, (_, index) => task({ id: `band-${index}` }))];
  const result = patchTask(full, old.id, { board: "shown" }, new Date(END + 1).toISOString());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(taskShowsOnBoard(result.task, true, { now: END + 1 })).toBe(false);
});
