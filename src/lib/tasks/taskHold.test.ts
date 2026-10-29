import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTasks, saveTasks } from "./store";
import { taskRevision } from "./revision";
import { expect, test } from "bun:test";
import { createTask, patchTask } from "./commands";
import type { BoardTask } from "./types";

const NOW = "2026-10-02T10:00:00.000Z";
const LATER = "2026-10-02T11:00:00.000Z";
function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return { id: "hold-task", project: "fixture", text: "Finish the remaining work", status: "inbox", placement: "unplaced", assignments: [], createdAt: NOW, updatedAt: NOW, ...overrides };
}
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  return result as Extract<T, { ok: true }>;
}

test("a hold moves work to Waiting, preserves its age on edits, and clears by the owner rule", () => {
  const original = task();
  const waiting = ok(patchTask([original], original.id, { hold: { kind: "worker", note: "Wait for a free worker", since: "2000-01-01", by: "migration" } }, NOW));
  expect(waiting.task.status).toBe("blocked");
  expect(waiting.task.hold).toEqual({ kind: "worker", note: "Wait for a free worker", since: NOW, by: "operator" });
  const edited = ok(patchTask(waiting.tasks, original.id, { hold: { kind: "resource", note: "Wait for memory" } }, LATER, { actor: "agent" }));
  expect(edited.task.hold?.since).toBe(NOW);
  expect(edited.task.hold?.by).toBe("agent");
  const cleared = ok(patchTask(edited.tasks, original.id, { hold: null }, LATER));
  expect(cleared.task.status).toBe("inbox");
  expect(cleared.task.hold).toBeUndefined();
  const owned = task({ status: "assigned", assignments: [{ path: "/fixture/worker.jsonl", panePid: null, state: "delivered", error: null, at: NOW }] });
  const ownedWait = ok(patchTask([owned], owned.id, { hold: { kind: "limit", note: "Next usage window" } }, NOW));
  expect(ok(patchTask(ownedWait.tasks, owned.id, { hold: null }, LATER)).task.status).toBe("assigned");
});


test("legacy status writes remain accepted, create clamps reasons, and unrelated hidden cards stay untouched", () => {
  const hidden = task({ id: "hidden", status: "blocked", groupHidden: { at: NOW, by: "operator", admitted: [] } });
  const original = task();
  const waiting = ok(patchTask([original, hidden], original.id, { status: "blocked" }, NOW));
  expect(waiting.task.hold?.kind).toBe("unstated");
  expect(waiting.tasks[1]).toBe(hidden);
  expect(hidden.hold).toBeUndefined();
  for (const status of ["inbox", "assigned", "done"] as const) {
    const moved = ok(patchTask(waiting.tasks, original.id, { status }, LATER));
    expect(moved.task.status).toBe(status);
    expect(moved.task.hold).toBeUndefined();
  }
  const created = ok(createTask([], { project: "fixture", placement: "unplaced", text: "Wait for a dependency", hold: { kind: "unknown", note: "x".repeat(250), until: "bad date" } }, [], { now: () => NOW }));
  expect(created.task.status).toBe("blocked");
  expect(created.task.hold).toEqual({ kind: "unstated", note: "x".repeat(200), since: NOW, by: "operator" });
  const numbered = ok(createTask([], { project: "fixture", placement: "unplaced", text: "Wait for a PR", hold: { kind: "pr", ref: 123, note: "After merge" } }, [], { now: () => NOW, actor: "agent", conversationId: "conversation_fixture" }));
  expect(numbered.task.hold?.ref).toBe("123");
  expect(numbered.task.hold?.conversationId).toBe("conversation_fixture");
});

test("holds survive persistence and old blocked rows load without a migration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-hold-"));
  const file = path.join(directory, "tasks.json");
  try {
    const held = ok(patchTask([task()], "hold-task", { hold: { kind: "postponed", until: LATER, note: "After a week of green checks" } }, NOW)).task;
    const old = task({ id: "old-blocked", status: "blocked" });
    saveTasks([held, old], file);
    const read = loadTasks(file);
    expect(read.find(t => t.id === held.id)?.hold).toEqual(held.hold);
    expect(read.find(t => t.id === old.id)?.hold).toBeUndefined();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("operator undo restores hold age and provenance, requires its revision, and refuses an agent restore", () => {
  const held = ok(patchTask([task()], "hold-task", { hold: { kind: "worker", note: "When free" } }, NOW, { actor: "agent", conversationId: "conversation_fixture" })).task;
  const moved = ok(patchTask([held], held.id, { status: "assigned" }, LATER)).task;
  const request = { status: "blocked", restoreHold: held.hold, expectedProject: moved.project, expectedRevision: taskRevision(moved) };
  const restored = ok(patchTask([moved], moved.id, request, LATER, { actor: "operator" }));
  expect(restored.task.hold).toEqual(held.hold);
  for (const [kind, expected] of [["PR", "pr"], [" Issue ", "issue"], ["banana", "unstated"]] as const) {
    const normalized = ok(patchTask([moved], moved.id, { ...request, restoreHold: { ...held.hold, kind } }, LATER, { actor: "operator" }));
    expect(normalized.task.hold?.kind).toBe(expected);
    expect(normalized.task.hold?.since).toBe(held.hold?.since);
    expect(normalized.notes).toEqual(kind === "banana" ? ['Unknown hold kind "banana" normalized to unstated.'] : undefined);
  }
  expect(patchTask([moved], moved.id, { ...request, expectedRevision: "stale" }, LATER, { actor: "operator" }).ok).toBe(false);
  expect(patchTask([moved], moved.id, request, LATER, { actor: "agent" }).ok).toBe(false);
});

for (const [kind, expected] of [["PR", "pr"], [" Issue ", "issue"], ["banana", "unstated"], ["unstated", "unstated"]] as const) {
  test(`hold kind ${JSON.stringify(kind)} normalizes across create, update and steps`, () => {
    const hold = { kind, ref: 123, note: "After the dependency finishes" };
    const steps = [{ id: "dependency", text: "Finish dependency", state: "open", hold }];
    const created = ok(createTask([], { project: "fixture", placement: "unplaced", text: "Wait for dependency", hold, steps }, [], { now: () => NOW, id: () => "normalized-hold" }));
    const updated = ok(patchTask(created.tasks, created.task.id, { hold, steps }, LATER));
    for (const result of [created, updated]) {
      expect(result.task.hold?.kind).toBe(expected);
      expect(result.task.steps?.[0]?.hold?.kind).toBe(expected);
      expect(result.task.hold?.ref).toBe(expected === "pr" || expected === "issue" ? "123" : undefined);
      if (kind === "banana") {
        expect(result.notes).toEqual([
          'Unknown hold kind "banana" normalized to unstated.',
          'Unknown hold kind "banana" normalized to unstated.',
        ]);
      } else expect(result.notes).toBeUndefined();
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "normalized-hold-"));
      try {
        const file = path.join(directory, "tasks.json");
        saveTasks(result.tasks, file);
        const stored = loadTasks(file)[0]!;
        expect(stored.hold).toEqual(result.task.hold);
        expect(stored.steps).toEqual(result.task.steps);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    expect(updated.task.hold?.since).toBe(NOW);
  });
}
