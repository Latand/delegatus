import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchTask } from "./commands";
import { loadTasks, saveTasks } from "./store";
import type { BoardTask } from "./types";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-task-note-"));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const file = path.join(directory, "tasks.json");
const now = "2026-10-02T10:00:00.000Z";
const task: BoardTask = { id: "task-note", project: "fixture", text: "Fix the card\nKeep its context visible.", status: "inbox", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now };

test("a status note replaces and clears independently, with trusted authorship and store round-trip", () => {
  const first = patchTask([task], task.id, { note: "Waiting for the review." }, now);
  expect(first).toMatchObject({ ok: true, task: { note: { text: "Waiting for the review.", author: { kind: "operator" }, updatedAt: now } } });
  if (!first.ok) return;
  saveTasks(first.tasks, file);
  expect(loadTasks(file)[0]).toMatchObject({ text: task.text, note: { text: "Waiting for the review." } });
  const second = patchTask(loadTasks(file), task.id, { note: "Review is running.", author: { kind: "operator" } } as never, now, { actor: "agent", noteAuthor: { kind: "agent", conversationId: "conversation_fixture" } });
  expect(second).toMatchObject({ ok: true, task: { note: { text: "Review is running.", author: { kind: "agent", conversationId: "conversation_fixture" } } } });
  if (!second.ok) return;
  const unchanged = patchTask(second.tasks, task.id, { status: "assigned" }, now);
  expect(unchanged.ok && unchanged.task.note).toEqual(second.task.note);
  const clear = patchTask(second.tasks, task.id, { note: null }, now);
  expect(clear.ok && "note" in clear.task).toBe(false);
  if (!clear.ok) return;
  saveTasks(clear.tasks, file);
  expect("note" in loadTasks(file)[0]!).toBe(false);
});

test("notes accept plain whitespace, enforce the 280-character cap and refuse caller metadata", () => {
  expect(patchTask([task], task.id, { note: "  Waiting\nfor   review. " }, now)).toMatchObject({ ok: true, task: { note: { text: "Waiting for review." } } });
  for (const note of ["x".repeat(281), 12, { text: "Spoof", author: "operator" }]) {
    expect(patchTask([task], task.id, { note }, now)).toMatchObject({ ok: false, field: "note", status: 400 });
  }
  expect(patchTask([task], task.id, { note: "x".repeat(280) }, now).ok).toBe(true);
});

test("loading a malformed status note keeps the task and discards the invalid optional field", () => {
  saveTasks([{ ...task, note: { text: "x".repeat(281), author: { kind: "operator" }, updatedAt: now } }], file);
  const loaded = loadTasks(file)[0]!;
  expect(loaded.id).toBe(task.id);
  expect(loaded.note).toBeUndefined();
});
