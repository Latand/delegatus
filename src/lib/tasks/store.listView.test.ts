import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { loadTasks, loadTasksForList, mutateTasks } from "./store";
import type { BoardTask } from "./types";

/* The shared task list (viewer-hot-path-clones): the board, the task route and
   the MCP list read the same cached tasks, so none may change them, and every
   write must reach the next read. Each case owns a mkdtemp directory. */

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function task(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "proj",
    status: "inbox",
    text: `task ${id}`,
    placement: "unplaced",
    assignments: [{ path: `/sessions/${id}.jsonl`, panePid: null, state: "delivered", error: null, at: "2026-09-01T00:00:00.000Z" }],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function store(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-list-view-"));
  directories.push(directory);
  const file = path.join(directory, "tasks.json");
  fs.writeFileSync(file, JSON.stringify({ tasks: [task("a"), task("b"), task("c", { project: "other" })] }));
  return file;
}

function attempt(write: () => void): boolean {
  try {
    write();
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return false;
  }
}

test("a reader cannot change the shared list, a task in it, or anything a task holds", () => {
  const file = store();
  const tasks = loadTasksForList(file);
  const list = tasks as BoardTask[];
  const first = tasks[0]!;
  expect(attempt(() => { list.push(task("pushed")); })).toBe(false);
  expect(attempt(() => { list.sort((left, right) => right.id.localeCompare(left.id)); })).toBe(false);
  expect(attempt(() => { first.text = "changed by a reader"; })).toBe(false);
  expect(attempt(() => { delete (first as Partial<BoardTask>).details; first.status = "done"; })).toBe(false);
  expect(attempt(() => { first.assignments.push(first.assignments[0]!); })).toBe(false);
  expect(attempt(() => { first.assignments[0]!.state = "failed"; })).toBe(false);

  const next = loadTasksForList(file);
  expect(next).toBe(tasks);
  expect(next.map((row) => row.id)).toEqual(["a", "b", "c"]);
  expect(next[0]).toMatchObject({ text: "task a", status: "inbox" });
  expect(next[0]!.assignments).toHaveLength(1);
  expect(next[0]!.assignments[0]!.state).toBe("delivered");
});

test("the list is the same tasks loadTasks copies, and loadTasks still hands out its own mutable copy", () => {
  const file = store();
  const shared = loadTasksForList(file);
  const copied = loadTasks(file);
  expect(copied).toEqual([...shared]);
  expect(Object.isFrozen(copied[0])).toBe(false);
  copied[0]!.text = "a caller's own copy";
  copied[0]!.assignments.push(copied[0]!.assignments[0]!);
  expect(loadTasksForList(file)[0]).toMatchObject({ text: "task a" });
  expect(loadTasksForList(file)[0]!.assignments).toHaveLength(1);
});

test("every write reaches the next list, and the list a reader already holds stays as it was", () => {
  const file = store();
  const before = loadTasksForList(file);

  mutateTasks((current) => ({ tasks: current.map((row) => row.id === "a" ? { ...row, text: "updated" } : row), result: null }), file);
  const updated = loadTasksForList(file);
  expect(updated).not.toBe(before);
  expect(updated.find((row) => row.id === "a")?.text).toBe("updated");
  expect(Object.isFrozen(updated.find((row) => row.id === "a"))).toBe(true);
  expect(before.find((row) => row.id === "a")?.text).toBe("task a");
  /* An unchanged row keeps its frozen task. */
  expect(updated.find((row) => row.id === "b")).toBe(before.find((row) => row.id === "b"));

  mutateTasks((current) => ({ tasks: [...current, task("d")], result: null }), file);
  expect(loadTasksForList(file).map((row) => row.id)).toEqual(["a", "b", "c", "d"]);

  mutateTasks((current) => ({ tasks: current.filter((row) => row.id !== "b"), result: null }), file);
  expect(loadTasksForList(file).map((row) => row.id)).toEqual(["a", "c", "d"]);
  expect(before.map((row) => row.id)).toEqual(["a", "b", "c"]);
});
