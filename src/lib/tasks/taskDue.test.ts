import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, patchTask } from "./commands";
import { loadTasks, saveTasks } from "./store";
import type { BoardTask } from "./types";

const NOW = "2026-10-23T12:00:00.000Z";
const PAST = "2026-10-22T12:00:00.000Z";
const FUTURE = "2026-10-24T12:00:00.000Z";
const task = (extra: Partial<BoardTask> = {}): BoardTask => ({
  id: "due-task", project: "fixture", text: "Finish the work", status: "inbox", placement: "unplaced",
  assignments: [], createdAt: PAST, updatedAt: PAST, dueAt: PAST, dueTz: "UTC", ...extra,
});
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
}

test("agent slip refuses missing, blank and oversized reasons without changing the row; records a reason and first date", () => {
  const row = task();
  const before = structuredClone(row);
  for (const dueReason of [undefined, "  ", "x".repeat(201), 7]) {
    expect(patchTask([row], row.id, { dueAt: FUTURE, dueReason }, NOW, { actor: "agent" }))
      .toMatchObject({ ok: false, code: "TASK_DUE_REASON_REQUIRED", field: "dueReason" });
    expect(row).toEqual(before);
  }
  const moved = ok(patchTask([row], row.id, { dueAt: FUTURE, dueReason: "  Start after the dependency  " }, NOW,
    { actor: "agent", conversationId: "conversation_fixture" })).task;
  expect(moved.updatedAt).toBe(NOW);
  expect(moved.dueHistory).toEqual({ firstAt: PAST, slips: 1, last: {
    at: NOW, from: PAST, to: FUTURE, by: "agent", reason: "Start after the dependency", conversationId: "conversation_fixture",
  } });
  const fourth = ok(patchTask([{ ...row, dueHistory: { firstAt: PAST, slips: 3 } }], row.id,
    { dueAt: FUTURE, dueReason: "A running lane will complete it" }, NOW, { actor: "agent" })).task;
  expect(fourth.dueHistory?.slips).toBe(4);
  const later = "2026-10-26T12:00:00.000Z";
  const twice = ok(patchTask([moved], moved.id, { dueAt: later }, "2026-10-25T12:00:00.000Z", { actor: "operator" })).task;
  expect(twice.dueHistory?.slips).toBe(2);
  expect(twice.dueHistory?.firstAt).toBe(PAST);
  expect(twice.dueHistory?.last).toEqual({ at: "2026-10-25T12:00:00.000Z", from: FUTURE, to: later, by: "operator" });
});

test("create records the first date; planning and earlier moves preserve it without slips", () => {
  const made = ok(createTask([], { project: "fixture", text: "Ship the outcome", placement: "unplaced", dueAt: FUTURE, dueTz: "UTC" }, [], { now: () => NOW, id: () => "created" })).task;
  expect(made.dueHistory).toEqual({ firstAt: FUTURE, slips: 0 });
  for (const [row, dueAt, actor] of [
    [made, "2026-10-25T12:00:00.000Z", "agent"],
    [task(), "2026-10-21T12:00:00.000Z", "operator"],
    [task(), PAST, "operator"],
  ] as const) {
    const updated = ok(patchTask([row], row.id, { dueAt }, NOW, { actor })).task;
    expect(updated.dueHistory).toEqual({ firstAt: row.dueAt!, slips: 0 });
  }
});

test("agent past dates and every clear shape refuse; operator clear removes all date fields", () => {
  const row = task({ dueHistory: { firstAt: PAST, slips: 0 } });
  for (const dueAt of [PAST, NOW]) expect(patchTask([row], row.id, { dueAt, dueReason: "Move" }, NOW, { actor: "agent" }))
    .toMatchObject({ ok: false, code: "TASK_DUE_PAST", field: "dueAt" });
  for (const input of [{ dueAt: null }, { dueAt: null, dueTz: null }, { dueTz: null }]) {
    expect(patchTask([row], row.id, input, NOW, { actor: "agent" })).toMatchObject({ ok: false, code: "TASK_DUE_REQUIRED" });
  }
  const undated = task({ dueAt: undefined, dueTz: undefined });
  expect(ok(patchTask([undated], undated.id, { text: "Continue the old work" }, NOW, { actor: "agent" })).task.dueAt).toBeUndefined();
  const cleared = ok(patchTask([row], row.id, { dueAt: null }, NOW, { actor: "operator" })).task;
  for (const key of ["dueAt", "dueTz", "dueHistory"]) expect(Object.hasOwn(cleared, key)).toBe(false);
});

test("history survives a fresh process; malformed records load without history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-due-"));
  const file = path.join(root, "tasks.json");
  try {
    const moved = ok(patchTask([task()], "due-task", { dueAt: FUTURE, dueReason: "Dependency" }, NOW, { actor: "agent" })).task;
    saveTasks([moved], file);
    const source = `import {loadTasks} from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; console.log(JSON.stringify(loadTasks(process.argv[1])[0].dueHistory));`;
    const child = Bun.spawnSync({ cmd: [process.execPath, "-e", source, file], stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_STATE_DIR: path.join(root, "state") } });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual(moved.dueHistory);
    for (const history of [null, [], { firstAt: "bad", slips: 0 }, { firstAt: PAST, slips: -1 }, { firstAt: PAST, slips: 1.5 },
      { firstAt: PAST, slips: 1, last: { at: NOW, from: PAST, to: FUTURE, by: "unknown" } },
      { firstAt: PAST, slips: 1, last: { at: NOW, from: PAST, to: FUTURE, by: "agent", reason: 7 } }]) {
      saveTasks([{ ...task(), dueHistory: history } as BoardTask], file);
      expect(loadTasks(file)[0]?.dueHistory).toBeUndefined();
      expect(loadTasks(file)[0]?.id).toBe("due-task");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
