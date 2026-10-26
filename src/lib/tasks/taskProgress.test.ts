import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";
import { encodeTask } from "@/lib/links/taskWire";
import { compactTask } from "@/lib/mcp/listAnswers";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import { createTask, patchTask } from "./commands";
import { loadTasks, saveTasks } from "./store";
import { taskRevision } from "./revision";
import type { BoardTask } from "./types";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-progress-"));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const now = "2026-10-26T10:00:00.000Z";
const later = "2026-10-26T11:00:00.000Z";
const agent: PauseResumeActor = { kind: "agent", role: "builder", conversationId: "conversation_progress" };
const task: BoardTask = { id: "task-progress", project: "fixture", text: "Implement progress", status: "inbox",
  placement: "unplaced", assignments: [], createdAt: now, updatedAt: now };
const input = { project: task.project, text: task.text, placement: "unplaced" };
const invalid = [-1, 101, 0.5, NaN, Infinity, -Infinity, "50", true, false, [], {}, { value: 50, setAt: now, by: agent }];

test("every integer estimate and trusted actor round-trips through storage and board projections", () => {
  const actors: PauseResumeActor[] = [agent, { kind: "operator" }, { kind: "agent", role: null, conversationId: null },
    { kind: "agent", role: "orchestrator", conversationId: "conversation_seat", via: { deputy: "conversation_deputy" } }];
  const rows: BoardTask[] = [];
  for (const by of actors) for (let value = 0; value <= 100; value++) {
    const id = `progress-${rows.length}`;
    const result = createTask([], { ...input, progress: value }, [], { now: () => now, id: () => id, statusActor: by });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.task.progress).toEqual({ value, setAt: now, by });
    rows.push(result.task);
  }
  const file = path.join(directory, "all-values", "tasks.json");
  saveTasks(rows, file);
  expect(loadTasks(file).map(row => row.progress)).toEqual(rows.map(row => row.progress));
  const restarted = JSON.parse(execFileSync(process.execPath, ["-e",
    'import { loadTasks } from "./src/lib/tasks/store.ts"; console.log(JSON.stringify(loadTasks(process.argv[1]).map(row => row.progress)))', file,
  ], { cwd: process.cwd(), encoding: "utf8" }));
  expect(restarted).toEqual(rows.map(row => row.progress));
  expect(projectTaskPipelineIds(loadTasks(file), []).map(row => row.progress)).toEqual(restarted);
  expect(loadTasks(file).map(row => compactTask(row).progress)).toEqual(restarted);
  // The reporter's local conversation identity is never sent to another install.
  const fixtureId = (n: number) => ["00000000", "0000", "0000", "0000", String(n).padStart(12, "0")].join("-");
  const wire = encodeTask({ ...rows[0]!, id: fixtureId(1), project: `repo-${"0".repeat(32)}` },
    { id: fixtureId(2), prefix: "12345678" }).row;
  expect("text" in wire).toBe(true);
  expect("progress" in wire).toBe(false);
});

test("absent and cleared estimates stay absent, including after restart and status changes", () => {
  for (const progress of [{}, { progress: null }]) {
    const result = createTask([], { ...input, ...progress }, [], { now: () => now, id: () => task.id });
    expect(result.ok).toBe(true);
    expect(result.ok && Object.hasOwn(result.task, "progress")).toBe(false);
  }
  const set = patchTask([task], task.id, { progress: 0 }, now, { statusActor: agent });
  if (!set.ok) throw new Error(set.error);
  const changed = patchTask(set.tasks, task.id, { progress: 100 }, later, { statusActor: { kind: "operator" } });
  if (!changed.ok) throw new Error(changed.error);
  expect(changed.task.progress).toEqual({ value: 100, setAt: later, by: { kind: "operator" } });
  expect(changed.task.updatedAt).toBe(task.updatedAt);
  expect(taskRevision(changed.task)).not.toBe(taskRevision(set.task));
  for (const status of ["assigned", "blocked", "done", "inbox"] as const) {
    const preserved = patchTask(changed.tasks, task.id, { status }, later, { statusActor: agent });
    expect(preserved.ok && preserved.task.progress).toEqual(changed.task.progress);
  }
  const clear = patchTask(changed.tasks, task.id, { progress: null }, later);
  if (!clear.ok) throw new Error(clear.error);
  expect(Object.hasOwn(clear.task, "progress")).toBe(false);
  const file = path.join(directory, "clear", "tasks.json");
  saveTasks(clear.tasks, file);
  expect(Object.hasOwn(loadTasks(file)[0]!, "progress")).toBe(false);
  expect(Object.hasOwn(compactTask(loadTasks(file)[0]!), "progress")).toBe(false);
});

/* An estimate carries its own setAt, so reporting one is presentation of the
   task: ages, ranking and the seat tick's quiet guard read updatedAt. */
test("an estimate alone or with presentation keeps updatedAt and moves the revision; with work it advances", () => {
  for (const patch of [{ progress: 40 }, { color: "teal", progress: 40 }, { progress: null }, { icon: "bug", priority: "high", progress: 40 }]) {
    const prior = { ...task, progress: { value: 10, setAt: now, by: agent } };
    const result = patchTask([prior], task.id, patch, later, { statusActor: agent });
    if (!result.ok) throw new Error(result.error);
    expect(result.task.updatedAt).toBe(task.updatedAt);
    expect(taskRevision(result.task)).not.toBe(taskRevision(prior));
  }
  for (const patch of [{ text: "Implement progress bar", progress: 40 }, { status: "assigned", progress: 40 }, { note: "Halfway", progress: 40 }]) {
    const result = patchTask([task], task.id, patch, later, { statusActor: agent });
    if (!result.ok) throw new Error(result.error);
    expect(result.task.updatedAt).toBe(later);
    expect(result.task.progress).toEqual({ value: 40, setAt: later, by: agent });
  }
});

describe("validation before writing", () => {
  for (const progress of invalid) test(`refuses ${JSON.stringify(progress)} on create, patch and finding match`, () => {
    const original = structuredClone(task);
    const refusal = { ok: false, status: 400, code: "TASK_INVALID_FIELD", field: "progress" };
    expect(createTask([], { ...input, progress }, [], { now: () => now })).toMatchObject(refusal);
    expect(createTask([original], { ...input, progress, clientRequestId: "cached-create" },
      [{ clientRequestId: "cached-create", taskId: task.id }], { now: () => now })).toMatchObject(refusal);
    expect(patchTask([original], task.id, { progress, text: "Must not change" }, later)).toMatchObject(refusal);
    expect(original).toEqual(task);
    expect(createTask([{ ...task, findingKey: "progress-finding" }], { ...input, findingKey: "progress-finding", progress }, [], { now: () => now })).toMatchObject(refusal);
  });
});

test("metadata comes from trusted options and repeated reports refresh it; finding omission preserves it", () => {
  const mutableActor = { kind: "agent" as const, role: "builder", conversationId: "conversation_actor" };
  const attributed = patchTask([task], task.id, { progress: 25 }, now, { statusActor: mutableActor });
  mutableActor.role = "reviewer";
  expect(attributed.ok && attributed.task.progress?.by).toEqual({ ...mutableActor, role: "builder" });
  const result = patchTask([task], task.id, { progress: 50, by: { kind: "operator" }, setAt: "forged" } as never, now,
    { actor: "agent", conversationId: "conversation_fallback" });
  if (!result.ok) throw new Error(result.error);
  expect(result.task.progress).toEqual({ value: 50, setAt: now, by: { kind: "agent", role: null, conversationId: "conversation_fallback" } });
  const repeated = patchTask(result.tasks, task.id, { progress: 50 }, later, { statusActor: agent });
  expect(repeated.ok && repeated.task.progress).toEqual({ value: 50, setAt: later, by: agent });
  const prior = { ...result.task, findingKey: "progress-finding" };
  const deps = { now: () => later, statusActor: agent };
  const matched = createTask([prior], { ...input, findingKey: prior.findingKey }, [], deps);
  expect(matched.ok && matched.task.progress).toEqual(prior.progress);
  const updated = createTask([prior], { ...input, findingKey: prior.findingKey, progress: 80 }, [], deps);
  expect(updated.ok && updated.task.progress).toEqual({ value: 80, setAt: later, by: agent });
  const cleared = createTask([prior], { ...input, findingKey: prior.findingKey, progress: null }, [], deps);
  expect(cleared.ok && Object.hasOwn(cleared.task, "progress")).toBe(false);
  const created = createTask([], { ...input, progress: 20, clientRequestId: "progress-create" }, [], { now: () => now, id: () => task.id });
  if (!created.ok) throw new Error(created.error);
  const replay = createTask(created.tasks, { ...input, progress: 20, clientRequestId: "progress-create" }, created.recentCreates, deps);
  expect(replay.ok && replay.replay).toBe(true);
  expect(replay.ok && replay.task.progress).toEqual(created.task.progress);
});

test("malformed stored metadata is discarded without losing the task", () => {
  const valid = { value: 50, setAt: now, by: agent };
  const corrupt = [...invalid.map(value => ({ ...valid, value })), null, { ...valid, setAt: "invalid" },
    { ...valid, by: "agent" }, { ...valid, by: { kind: "agent" } }, { ...valid, by: { kind: "unknown" } },
    { ...valid, by: { ...agent, via: [] } }];
  const file = path.join(directory, "corrupt", "tasks.json");
  saveTasks(corrupt.map((progress, i) => ({ ...task, id: `corrupt-${i}`, progress } as BoardTask)), file);
  const rows = loadTasks(file);
  expect(rows).toHaveLength(corrupt.length);
  for (const row of rows) expect(Object.hasOwn(row, "progress")).toBe(false);
});
