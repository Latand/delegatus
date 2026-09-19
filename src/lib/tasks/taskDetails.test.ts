import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { createTask, patchTask, TASK_DETAILS_LIMIT } from "./commands";
import { isTask, loadTasks, saveTasks } from "./store";
import type { BoardTask } from "./types";

/* Agent-facing `details` beside the human `text` (#1834): a task's title and
   description are for the operator reviewing the board, and the prompt, ids,
   rules and state an agent needs live in their own field. These cases pin the
   independence of the two — the whole point of the split — plus the cap, the
   clear, and that a stored row round-trips through the task file. */

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-details-")), "tasks.json");
}

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task-1",
    project: "proj",
    status: "inbox",
    text: "Fold agent context away\nThe card reads for a human first.",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    ...overrides,
  };
}

const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  expect(result.ok).toBe(true);
  return result as Extract<T, { ok: true }>;
};

test("a create carries details beside the text, and a blank one creates no field at all", () => {
  const created = ok(createTask([], {
    project: "proj",
    text: "Fold agent context away\nThe card reads for a human first.",
    details: "  lane ffb09e5c\nfences: PipelineSection.tsx  ",
    placement: "unplaced",
  }));
  expect(created.task.text).toBe("Fold agent context away\nThe card reads for a human first.");
  expect(created.task.details).toBe("lane ffb09e5c\nfences: PipelineSection.tsx");

  const blank = ok(createTask([], { project: "proj", text: "Human title", details: "   ", placement: "unplaced" }));
  expect("details" in blank.task).toBe(false);

  const absent = ok(createTask([], { project: "proj", text: "Human title", placement: "unplaced" }));
  expect("details" in absent.task).toBe(false);
});

test("an update carrying only details leaves the text byte for byte, and the reverse", () => {
  const stored = task({ details: "the agent's original context" });
  const detailsOnly = ok(patchTask([stored], "task-1", { details: "a replacement state card" }));
  expect(detailsOnly.task.details).toBe("a replacement state card");
  expect(detailsOnly.task.text).toBe(stored.text);

  const textOnly = ok(patchTask([detailsOnly.task], "task-1", { text: "A new human title\nAnd its description." }));
  expect(textOnly.task.text).toBe("A new human title\nAnd its description.");
  expect(textOnly.task.details).toBe("a replacement state card");
});

test("null and an empty string clear details; the field is gone from the row, not left empty", () => {
  const stored = task({ details: "context nobody needs any more" });
  for (const value of [null, "", "   "] as const) {
    const cleared = ok(patchTask([stored], "task-1", { details: value }));
    expect("details" in cleared.task).toBe(false);
    expect(cleared.task.text).toBe(stored.text);
  }
});

test("details answers for its own cap and its own field, and a non-string is refused", () => {
  const tooLong = patchTask([task()], "task-1", { details: "x".repeat(TASK_DETAILS_LIMIT + 1) });
  expect(tooLong.ok).toBe(false);
  if (tooLong.ok) throw new Error("unreachable");
  expect(tooLong.status).toBe(400);
  expect(tooLong.field).toBe("details");
  /* Its own cap: details is allowed to be far longer than the human text. */
  expect(ok(patchTask([task()], "task-1", { details: "x".repeat(TASK_DETAILS_LIMIT) })).task.details).toHaveLength(TASK_DETAILS_LIMIT);

  const wrongType = createTask([], { project: "proj", text: "Human title", details: { prompt: "no" }, placement: "unplaced" });
  expect(wrongType.ok).toBe(false);
  if (wrongType.ok) throw new Error("unreachable");
  expect(wrongType.field).toBe("details");
});

test("details persists and reloads like text, and a non-string row refuses to load", () => {
  const file = tmpFile();
  const stored = task({ details: "seat card for 9feead69" });
  saveTasks([stored], file);
  expect(loadTasks(file)[0]!.details).toBe("seat card for 9feead69");
  /* Revisioned like text: a details-only write moves the revision. */
  const before = (loadTasks(file)[0] as BoardTask & { revision: string }).revision;
  saveTasks([ok(patchTask(loadTasks(file), "task-1", { details: "a newer card" })).task], file);
  expect((loadTasks(file)[0] as BoardTask & { revision: string }).revision).not.toBe(before);

  expect(isTask({ ...stored, details: "still text" })).toBe(true);
  expect(isTask({ ...stored, details: 42 })).toBe(false);
  /* A task written before #1834 stays valid with no details at all. */
  const legacy: Record<string, unknown> = { ...stored };
  delete legacy.details;
  expect(isTask(legacy)).toBe(true);
});
