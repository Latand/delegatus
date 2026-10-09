import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, patchTask, type CreateTaskInput } from "./commands";
import { loadTasksFile, mutateTasksFile } from "./store";
import { readFindingKey } from "./finding";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-finding-"));
const file = path.join(root, "tasks.json");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const first = "2026-10-09T08:00:00.000Z";
const later = "2026-10-09T09:00:00.000Z";
const input = { project: "finding-project", text: "Preserve the operator's title", placement: "unplaced", findingKey: " log:socket " } as const;
function create(body: CreateTaskInput, now = first) {
  const result = mutateTasksFile(state => {
    const outcome = createTask(state.tasks, body, state.recentCreates, { now: () => now });
    return { state: outcome.ok && !outcome.replay ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined, result: outcome };
  }, file);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("finding identity", () => {
  test("persists recurrence and retry receipts without replacing the original text or other fields", () => {
    const initial = create({ ...input, details: "Keep this context", note: "First observation", clientRequestId: "first" });
    expect(create({ ...input, clientRequestId: "first" })).toMatchObject({ replay: true, matched: false, task: { finding: { count: 1 } } });
    const match = create({ ...input, text: "New reporter wording", details: "New context", note: "Seen again", clientRequestId: "repeat" }, later);
    expect(match.matched).toBe(true);
    expect(match.task).toMatchObject({ id: initial.task.id, text: input.text, details: "Keep this context", findingKey: input.findingKey, finding: { count: 2, lastSeenAt: later }, note: { text: "Seen again", author: { kind: "operator" }, updatedAt: later } });
    const disk = loadTasksFile(file);
    expect(disk.tasks).toHaveLength(1);
    expect(disk.tasks[0]).toEqual(match.task);
    expect(disk.recentCreates.find(receipt => receipt.clientRequestId === "repeat")?.matched).toBe(true);
    const replay = create({ ...input, note: "Seen again", clientRequestId: "repeat" }, "2026-10-09T10:00:00.000Z");
    expect(replay).toMatchObject({ replay: true, matched: true });
    expect(replay.task.finding).toEqual({ count: 2, lastSeenAt: later });
    const cleared = create({ ...input, clientRequestId: "clear" }, later);
    expect(cleared.task.note).toBeUndefined();
    expect(cleared.task.finding?.count).toBe(3);
  });

  test("Done permits a fresh task linked to the earlier one; reopening and assigning a duplicate refuse", () => {
    const made = createTask([], input, [], { now: () => first, id: () => "old" });
    if (!made.ok) throw new Error(made.error);
    const done = patchTask(made.tasks, made.task.id, { status: "done" }, later);
    if (!done.ok) throw new Error(done.error);
    const next = createTask(done.tasks, input, [], { now: () => later, id: () => "new" });
    if (!next.ok) throw new Error(next.error);
    expect(next.matched).toBe(false);
    expect(next.task.finding).toEqual({ count: 1, lastSeenAt: later, previousTaskId: "old" });
    expect(patchTask(next.tasks, "old", { status: "inbox" }, later)).toMatchObject({ ok: false, status: 409, code: "TASK_FINDING_KEY_CONFLICT" });
    const unkeyed = createTask(next.tasks, { ...input, findingKey: undefined }, [], { id: () => "plain" });
    if (!unkeyed.ok) throw new Error(unkeyed.error);
    expect(patchTask(unkeyed.tasks, "plain", { findingKey: input.findingKey })).toMatchObject({ ok: false, status: 409 });
    const changed = patchTask(next.tasks, "new", { findingKey: "different" }, later);
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.task.finding).toEqual({ count: 1, lastSeenAt: later });
    const cleared = patchTask(changed.tasks, "new", { findingKey: null }, later);
    if (!cleared.ok) throw new Error(cleared.error);
    expect(Object.hasOwn(cleared.task, "findingKey")).toBe(false);
    expect(Object.hasOwn(cleared.task, "finding")).toBe(false);
  });

  test("project, case and whitespace remain separate identities, and a keyless call still creates", () => {
    const made = createTask([], input);
    if (!made.ok) throw new Error(made.error);
    for (const fields of [{ project: "other" }, { findingKey: "log:socket" }, { findingKey: " LOG:SOCKET " }, { findingKey: undefined }]) {
      const next = createTask(made.tasks, { ...input, ...fields });
      expect(next.ok).toBe(true);
      if (next.ok) {
        expect(next.task.id).not.toBe(made.task.id);
        expect(next.matched).not.toBe(true);
        if (fields.findingKey === undefined && Object.hasOwn(fields, "findingKey")) {
          expect(next.task.finding).toBeUndefined();
          expect(Object.hasOwn(next, "matched")).toBe(false);
        }
      }
    }
  });

  test("validates opaque Unicode keys and refuses invalid notes without an occurrence write", () => {
    expect(readFindingKey("🙂".repeat(200))).toMatchObject({ ok: true });
    expect(readFindingKey("")).toEqual({ ok: true, key: "" });
    for (const value of ["a".repeat(201), "🙂".repeat(201), 42, {}]) {
      expect(createTask([], { ...input, findingKey: value })).toMatchObject({ ok: false, status: 400, field: "findingKey" });
    }
    const made = createTask([], input);
    if (!made.ok) throw new Error(made.error);
    for (const note of [17, "n".repeat(281)]) {
      expect(createTask(made.tasks, { ...input, note })).toMatchObject({ ok: false, field: "note" });
      expect(made.task.finding?.count).toBe(1);
    }
  });
});
