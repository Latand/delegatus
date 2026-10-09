import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type { PauseResumeActor } from "@/lib/pauseResumeActor";

import { createTask, patchTask } from "./commands";
import { loadTasks, mutateTasks, saveTasks } from "./store";
import type { BoardTask } from "./types";

/* Who put a task in its column (docs/design/orchestrator-arrows.md §5). */

const SEAT: PauseResumeActor = { kind: "agent", role: "orchestrator", conversationId: "conversation_seat" };

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-status-by-")), "tasks.json");
}

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task-1", project: "proj", status: "inbox", text: "Title", placement: "unplaced", assignments: [],
    createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z", ...overrides,
  };
}

describe("task statusBy", () => {
  test("a status change by a named writer records the writer, the column it left and the time", () => {
    const moved = patchTask([task()], "task-1", { status: "assigned" }, "2026-10-06T10:05:00.000Z", { statusActor: SEAT });
    expect(moved.ok && moved.task.statusBy).toEqual({ actor: SEAT, from: "inbox", at: "2026-10-06T10:05:00.000Z" });
  });

  test("a patch that leaves the status where it was leaves the record", () => {
    const by = { actor: SEAT, from: "inbox" as const, at: "2026-10-06T10:05:00.000Z" };
    const same = patchTask([task({ status: "assigned", statusBy: by })], "task-1", { status: "assigned", text: "Renamed" }, "2026-10-06T10:06:00.000Z", { statusActor: { kind: "operator" } });
    expect(same.ok && same.task.statusBy).toEqual(by);
  });

  test("a status change with no named writer drops the earlier writer's record", () => {
    const by = { actor: SEAT, from: "inbox" as const, at: "2026-10-06T10:05:00.000Z" };
    const moved = patchTask([task({ status: "assigned", statusBy: by })], "task-1", { status: "done" }, "2026-10-06T10:06:00.000Z");
    expect(moved.ok && "statusBy" in moved.task).toBe(false);
  });

  test("a hold that moves the task to Waiting is a status change by its writer", () => {
    const held = patchTask([task()], "task-1", { hold: { kind: "operator", note: "Waits for the operator's answer." } }, "2026-10-06T10:05:00.000Z", { actor: "agent", statusActor: SEAT });
    expect(held.ok && held.task.status).toBe("blocked");
    expect(held.ok && held.task.statusBy).toEqual({ actor: SEAT, from: "inbox", at: "2026-10-06T10:05:00.000Z" });
  });

  test("a create by a named writer records it with no previous column", () => {
    const created = createTask([], { project: "proj", text: "New", placement: "unplaced" }, [], { now: () => "2026-10-06T10:05:00.000Z", id: () => "id", statusActor: SEAT });
    expect(created.ok && created.task.statusBy).toEqual({ actor: SEAT, from: null, at: "2026-10-06T10:05:00.000Z" });
    const plain = createTask([], { project: "proj", text: "New", placement: "unplaced" }, [], { now: () => "now", id: () => "id" });
    expect(plain.ok && "statusBy" in plain.task).toBe(false);
  });

  test("the store keeps the record, and drops it when a writer moves the row in place without naming itself", () => {
    const filePath = tmpFile();
    const by = { actor: SEAT, from: "inbox" as const, at: "2026-10-06T10:05:00.000Z" };
    saveTasks([task({ status: "assigned", statusBy: by })], filePath);
    expect(loadTasks(filePath)[0]!.statusBy).toEqual(by);

    mutateTasks((tasks) => {
      tasks[0]!.text = "Renamed in place";
      return { tasks, result: null };
    }, filePath);
    expect(loadTasks(filePath)[0]!.statusBy).toEqual(by);

    mutateTasks((tasks) => {
      tasks[0]!.status = "done";
      return { tasks, result: null };
    }, filePath);
    const stored = loadTasks(filePath)[0]!;
    expect(stored.status).toBe("done");
    expect("statusBy" in stored).toBe(false);
  });

  test("a malformed record loads as absent", () => {
    const filePath = tmpFile();
    saveTasks([task({ statusBy: { actor: { kind: "somebody" }, from: "inbox", at: "now" } as unknown as BoardTask["statusBy"] })], filePath);
    expect("statusBy" in loadTasks(filePath)[0]!).toBe(false);
  });
});
