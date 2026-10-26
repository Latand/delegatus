import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchTask } from "./commands";
import { loadTasks, saveTasks, mutateTaskSummary } from "./store";
import { readTaskSummaryInput } from "./summary";
import { encodeTask } from "@/lib/links/taskWire";
import type { BoardTask, TaskSummaryAuthor } from "./types";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-summary-"));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const file = path.join(directory, "tasks.json");
const now = "2026-10-02T10:00:00.000Z";
const task: BoardTask = { id: "task-summary", project: "fixture", text: "Keep the outcome", status: "inbox", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now };
const content = { headline: "Outcome", text: "The change is complete. Reads retain it." };

test.each([
  { kind: "operator" }, { kind: "agent", conversationId: null },
  { kind: "orchestrator", conversationId: "conversation_fixture" },
  { kind: "stage", pipelineId: "lane", stageId: "verify", attempt: 1, conversationId: "conversation_stage" },
] satisfies TaskSummaryAuthor[])("every summary writer round-trips: %j", async author => {
  const parsed = readTaskSummaryInput(content, now, author);
  if (!parsed.ok) throw new Error(parsed.error);
  saveTasks([{ ...task, summary: parsed.summary }], file);
  expect(loadTasks(file)[0]?.summary).toEqual({ ...content, author, updatedAt: now });
  await mutateTaskSummary(task.id, current => ({ ...current, summary: { ...current.summary!, headline: "Replaced" } }), file);
  expect(loadTasks(file)[0]?.summary?.headline).toBe("Replaced");
});

test("patch derives author and time, preserves unrelated fields, replaces and clears", () => {
  const first = patchTask([task], task.id, { summary: { ...content, author: { kind: "stage" }, updatedAt: "forged" } }, now);
  if (!first.ok) throw new Error(first.error);
  expect(first.task.summary).toEqual({ ...content, author: { kind: "operator" }, updatedAt: now });
  const second = patchTask(first.tasks, task.id, { summary: { headline: "  New   outcome ", text: "Works.\nMore context.", left: "  " } }, now,
    { actor: "agent", noteAuthor: { kind: "orchestrator", conversationId: "conversation_fixture" } });
  if (!second.ok) throw new Error(second.error);
  expect(second.task.summary).toEqual({ headline: "New outcome", text: "Works. More context.", author: { kind: "orchestrator", conversationId: "conversation_fixture" }, updatedAt: now });
  expect(second.task.text).toBe(task.text);
  const unchanged = patchTask(second.tasks, task.id, { status: "assigned" }, now);
  expect(unchanged.ok && unchanged.task.summary).toEqual(second.task.summary);
  const cleared = patchTask(second.tasks, task.id, { summary: null }, now);
  if (!cleared.ok) throw new Error(cleared.error);
  expect("summary" in cleared.task).toBe(false);
  saveTasks(cleared.tasks, file);
  expect(loadTasks(file)[0]?.summary).toBeUndefined();
  const agent = patchTask([task], task.id, { summary: content }, now, { actor: "agent" });
  expect(agent.ok && agent.task.summary?.author).toEqual({ kind: "agent", conversationId: null });
});

test.each([{}, [], 12, "text", { ...content, headline: "" }, { ...content, text: " " },
  { ...content, headline: "h".repeat(121) }, { ...content, text: "t".repeat(601) },
  { ...content, left: "l".repeat(201) }, { ...content, left: false }, { ...content, headline: "two\nlines" },
].map(summary => ({ summary })))("patch refuses malformed summary without changing the task: %j", ({ summary }) => {
  const before = JSON.stringify(task);
  expect(patchTask([task], task.id, { summary }, now)).toMatchObject({ ok: false, field: "summary", status: 400 });
  expect(JSON.stringify(task)).toBe(before);
});

test("maximum fields survive storage; malformed metadata is discarded; summary stays off the wire", () => {
  const result = patchTask([task], task.id, { summary: { headline: "h".repeat(120), text: "t".repeat(600), left: "l".repeat(200) } }, now);
  if (!result.ok) throw new Error(result.error);
  saveTasks(result.tasks, file);
  expect(loadTasks(file)[0]?.summary).toEqual(result.task.summary);
  expect(encodeTask(result.task, { id: "machine", prefix: "aaaaaaaa" }).row).not.toHaveProperty("summary");
  for (const broken of [{ ...content }, { ...result.task.summary, updatedAt: "bad" }, { ...result.task.summary, author: { kind: "stage", attempt: 0 } }, { ...result.task.summary, text: "t".repeat(601) }]) {
    saveTasks([{ ...task, summary: broken as BoardTask["summary"] }], file);
    const stored = loadTasks(file)[0]!;
    expect(stored.id).toBe(task.id);
    expect(stored.summary).toBeUndefined();
  }
});
