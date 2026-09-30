import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DONE_TASK_BOARD_RETENTION_MS, countBoardTasks, taskShowsOnBoard } from "./boardVisibility";
import { createTask, patchTask } from "./commands";
import { withTaskCompletion } from "./completion";
import { ensureTaskMembership } from "./membership";
import { loadTasks, mutateTasks, saveTasks } from "./store";
import { taskRevision } from "./revision";
import { taskSeatHoldingSnapshot } from "./seatHolding";
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

test("create and show admission read seats once across 1000 expired rows and count the seat", () => {
  const now = new Date(END + 1).toISOString();
  const old = Array.from({ length: 1000 }, (_, index) => ({ ...completed(), id: `old-${index}`, assignments: index === 0 ? [member] : [] }));
  const target = task({ id: "restore", board: "hidden", assignments: [] });
  const live = Array.from({ length: 299 }, (_, index) => task({ id: `live-${index}`, assignments: [] }));
  for (const operation of ["create", "show"] as const) {
    for (const holdsSeat of [false, true]) {
      let reads = 0;
      const seatHolding = taskSeatHoldingSnapshot((project) => {
        expect(project).toBe("fixture");
        reads += 1;
        return { active: holdsSeat ? { conversationId: "worker", path: null } as never : null, pending: null };
      });
      const rows = [...old, ...live, target];
      const result = operation === "create"
        ? createTask(rows, { project: "fixture", text: "New work", placement: "unplaced" }, [], { now: () => now, seatHolding })
        : patchTask(rows, target.id, { board: "shown" }, now, { seatHolding });
      expect(reads).toBe(1);
      expect(result.ok).toBe(!holdsSeat);
      if (!result.ok) expect(result.code).toBe("TASK_BOARD_FULL");
    }
  }
});

test("limit checks consult seat holding only for expired done rows", () => {
  const target = task({ id: "restore", board: "hidden", assignments: [] });
  const rows = [task({ id: "assigned" }), task({ id: "inbox", status: "inbox" }), task({ id: "blocked", status: "blocked" }), completed(), target];
  for (const operation of ["create", "show"] as const) {
    for (const at of [END, END + 1]) {
      const consulted: string[] = [];
      const seatHolding = (row: BoardTask) => { consulted.push(row.id); return "free" as const; };
      const now = new Date(at).toISOString();
      const result = operation === "create"
        ? createTask(rows, { project: "fixture", text: "New work", placement: "unplaced" }, [], { now: () => now, seatHolding })
        : patchTask(rows, target.id, { board: "shown" }, now, { seatHolding });
      expect(result.ok).toBe(true);
      expect(consulted).toEqual(at === END ? [] : ["task"]);
    }
  }
});

test("a command caches an unreadable seat once; the next command reads again", () => {
  let reads = 0;
  const seatsFor = () => {
    reads += 1;
    if (reads === 1) throw new Error("seat record unreadable");
    return { active: null, pending: null };
  };
  const first = taskSeatHoldingSnapshot(seatsFor);
  expect(first(task())).toBe("unknown");
  expect(first(task())).toBe("unknown");
  expect(reads).toBe(1);
  expect(taskSeatHoldingSnapshot(seatsFor)(task())).toBe("free");
  expect(reads).toBe(2);
});

test("new admission resurfaces, reconciliation of an old admission does not", () => {
  const row = completed();
  expect(taskShowsOnBoard({ ...row, assignments: [{ ...member, at: new Date(END + 1).toISOString() }] }, true, { now: END + 2 })).toBe(false);
  expect(taskShowsOnBoard({ ...row, assignments: [...row.assignments, { ...member, path: "/fixture/new.jsonl", conversationId: "new" }] }, true, { now: END + 2 })).toBe(true);
});

test("a late admission restarts retention once and expires after three days", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "done-admission-")), "tasks.json");
  saveTasks([completed()], file);
  const admittedAt = END + 24 * 60 * 60 * 1000;
  const input = {
    project: "fixture", origin: { kind: "conversation" as const, key: "new" },
    explicitTaskIds: ["task"], identity: { conversationId: "new", path: "/fixture/new.jsonl" },
  };
  mutateTasks((tasks) => {
    const result = ensureTaskMembership(tasks, input, { now: () => new Date(admittedAt).toISOString() });
    if (!result.ok) throw new Error(result.error);
    const row = result.tasks[0]!;
    expect(row.status).toBe("done");
    expect(row.doneAt).toBe(new Date(admittedAt).toISOString());
    expect(row.doneAdmissions).toContain("new");
    expect(taskShowsOnBoard(row, true, { now: admittedAt })).toBe(true);
    return { tasks: result.tasks, result: null };
  }, file);
  const end = admittedAt + DONE_TASK_BOARD_RETENTION_MS;
  const revision = taskRevision(loadTasks(file)[0]!);
  mutateTasks((tasks) => {
    const replay = ensureTaskMembership(tasks, input, { now: () => new Date(end).toISOString() });
    if (!replay.ok) throw new Error(replay.error);
    expect(replay.changed).toBe(false);
    return { tasks: replay.tasks, result: null };
  }, file);
  const row = loadTasks(file)[0]!;
  expect(taskRevision(row)).toBe(revision);
  expect(row.doneAt).toBe(new Date(admittedAt).toISOString());
  for (const now of [admittedAt, end, end + 1, Date.parse(DONE) + 60 * 24 * 60 * 60 * 1000]) {
    const visible = now <= end;
    expect(taskShowsOnBoard(row, true, { now })).toBe(visible);
    expect(countBoardTasks([row], "fixture", () => true, () => ({ now }))).toBe(visible ? 1 : 0);
  }
});

test("reconciling an old admission with new identifiers does not restart retention", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "done-reconcile-")), "tasks.json");
  saveTasks([completed()], file);
  mutateTasks((tasks) => {
    const result = ensureTaskMembership(tasks, {
      project: "fixture", origin: { kind: "conversation", key: "worker" },
      explicitTaskIds: ["task"],
      identity: { conversationId: "worker", path: "/fixture/successor.jsonl", launchId: "successor" },
    }, { now: () => new Date(END + 1).toISOString() });
    if (!result.ok) throw new Error(result.error);
    expect(result.changed).toBe(true);
    expect(result.tasks[0]!.doneAt).toBe(DONE);
    return { tasks: result.tasks, result: null };
  }, file);
  const row = loadTasks(file)[0]!;
  expect(row.doneAt).toBe(DONE);
  expect(taskShowsOnBoard(row, true, { now: END + 1 })).toBe(false);
  expect(countBoardTasks([row], "fixture", () => true, () => ({ now: END + 1 }))).toBe(0);
});

test("the store restarts retention for direct admission writes and later admissions", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "done-direct-admission-")), "tasks.json");
  saveTasks([completed()], file);
  for (const [index, now] of [END + 1, END + DONE_TASK_BOARD_RETENTION_MS + 2].entries()) {
    const at = new Date(now).toISOString();
    mutateTasks((tasks) => {
      tasks[0]!.assignments.push({ ...member, conversationId: `late-${index}`, path: `/fixture/late-${index}.jsonl`, at });
      tasks[0]!.updatedAt = at;
      return { tasks, result: null };
    }, file);
    const row = loadTasks(file)[0]!;
    expect(row.doneAt).toBe(at);
    expect(row.doneAdmissions).toContain(`late-${index}`);
    expect(taskShowsOnBoard(row, false, { now })).toBe(true);
    expect(taskShowsOnBoard(row, true, { now: now + DONE_TASK_BOARD_RETENTION_MS + 1 })).toBe(false);
    const revision = taskRevision(row);
    mutateTasks((tasks) => ({ tasks, result: null }), file);
    expect(taskRevision(loadTasks(file)[0]!)).toBe(revision);
  }
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
