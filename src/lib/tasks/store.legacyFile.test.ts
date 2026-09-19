import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createTask } from "./commands";
import { loadTasks, loadTasksFile, mutateTasks, mutateTasksFile } from "./store";
import type { BoardTask } from "./types";

/* #1870 slice 1: what a legacy tasks.json does to the store, driven only
   through the store API that predates the move, so a case that fails on the
   old JSON store fails on its behaviour. Every case uses its own mkdtemp
   directory, never the live state directory. */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-legacy-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "tasks.json") };
}

function task(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "proj",
    status: "inbox",
    text: `task ${id}`,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function siblings(dir: string, prefix: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
}

function create(file: string, clientRequestId: string): { id: string; replay: boolean } {
  return mutateTasksFile((state) => {
    const created = createTask(state.tasks, { project: "proj", text: "Once", placement: "unplaced", clientRequestId }, state.recentCreates);
    if (!created.ok) throw new Error(created.error);
    return {
      state: created.replay ? undefined : { tasks: created.tasks, recentCreates: created.recentCreates },
      result: { id: created.task.id, replay: created.replay },
    };
  }, file);
}

describe("a legacy tasks.json on the SQLite store", () => {
  test("(b) a NUL-filled file serves an empty board, is kept aside, and the store keeps accepting writes", () => {
    const { dir, file } = sandbox();
    fs.writeFileSync(file, Buffer.alloc(4096, 0));

    expect(loadTasks(file)).toEqual([]);

    const unreadable = siblings(dir, "tasks.json.unreadable-");
    expect(unreadable).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, unreadable[0]!)).every((byte) => byte === 0)).toBe(true);
    mutateTasks((tasks) => ({ tasks: [...tasks, task("after-gap")], result: undefined }), file);
    expect(loadTasks(file).map((row) => row.id)).toEqual(["after-gap"]);
  });

  test("(e) an old-release writer after the import fails with EISDIR and nothing is lost", () => {
    const { dir, file } = sandbox();
    fs.writeFileSync(file, JSON.stringify({ tasks: [task("a")] }));
    loadTasks(file);

    // The pre-#1870 store read the file, then renamed a temp file over it.
    expect(() => fs.readFileSync(file, "utf8")).toThrow(/EISDIR/);
    const temp = path.join(dir, ".tasks.json.old-writer.tmp");
    fs.writeFileSync(temp, JSON.stringify({ tasks: [] }));
    expect(() => fs.renameSync(temp, file)).toThrow(/EISDIR|ENOTEMPTY|EEXIST/);

    expect(loadTasks(file).map((row) => row.id)).toEqual(["a"]);
  });

  test("a file with a duplicate create receipt loads, and a replay resolves to the task the newest receipt names", () => {
    const { file } = sandbox();
    // A create retried after its first task was deleted appended a second receipt.
    fs.writeFileSync(file, JSON.stringify({
      tasks: [task("live")],
      recentCreates: [
        { clientRequestId: "retried", taskId: "deleted" },
        { clientRequestId: "other", taskId: "live" },
        { clientRequestId: "retried", taskId: "live" },
      ],
    }));

    expect(loadTasksFile(file).recentCreates).toEqual([
      { clientRequestId: "other", taskId: "live" },
      { clientRequestId: "retried", taskId: "live" },
    ]);
    expect(create(file, "retried")).toEqual({ id: "live", replay: true });
    expect(loadTasks(file).map((row) => row.id)).toEqual(["live"]);
  });

  test("a create retried after its task was deleted keeps one receipt and replays to the new task", () => {
    const { file } = sandbox();
    fs.writeFileSync(file, JSON.stringify({ tasks: [] }));
    const first = create(file, "retried");
    mutateTasks((tasks) => ({ tasks: tasks.filter((row) => row.id !== first.id), result: undefined }), file);

    const second = create(file, "retried");

    expect(second.replay).toBe(false);
    expect(loadTasksFile(file).recentCreates).toEqual([{ clientRequestId: "retried", taskId: second.id }]);
    expect(create(file, "retried")).toEqual({ id: second.id, replay: true });
  });
});
