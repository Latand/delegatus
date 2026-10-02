import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTask, patchTask } from "./commands";
import { deriveTaskSteps } from "./steps";
import { loadTasks, saveTasks } from "./store";
import type { BoardTask } from "./types";

const now = "2026-10-02T10:00:00.000Z";
const steps = [
  ...Array.from({ length: 5 }, (_, index) => ({ id: `fixed-${index + 1}`, text: `Fixed cause ${index + 1}`, state: "done" as const })),
  ...Array.from({ length: 3 }, (_, index) => ({ id: `remaining-${index + 1}`, text: `Remaining cause ${index + 1}`, state: "open" as const, ...(index === 0 ? { ref: "lane" } : {}), hold: { kind: "worker" as const, note: "When capacity is free" } })),
];

test("create, patch, store, and live derivation preserve the 5-of-8 checklist", () => {
  const created = createTask([], {
    project: "fixture", placement: "unplaced", text: "Resolve the audit", steps,
  } as never, [], { now: () => now, id: () => "task-steps" });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect((created.task as BoardTask).steps).toHaveLength(8);
  expect(deriveTaskSteps((created.task as BoardTask).steps, []).summary).toMatchObject({ done: 5, total: 8, open: 3, reasons: [{ kind: "queued", note: "When capacity is free", count: 3 }] });

  const edited = patchTask(created.tasks, created.task.id, { steps } as never, now);
  expect(edited.ok).toBe(true);
  if (!edited.ok) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-task-steps-"));
  const file = path.join(directory, "tasks.json");
  try {
    saveTasks(edited.tasks, file);
    const stored = loadTasks(file)[0] as BoardTask;
    expect(stored.steps).toHaveLength(8);
    expect(deriveTaskSteps(stored.steps, [{ id: "lane", state: "running" }]).steps.filter(step => step.motion === "working")).toHaveLength(1);
    expect(deriveTaskSteps(stored.steps, [{ id: "lane", state: "completed" }]).summary).toMatchObject({ done: 6, total: 8, open: 2, working: 0, needsYou: 0, reasons: [{ kind: "queued", note: "When capacity is free", count: 2 }] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("running and operator-held checklist steps are summarized separately from waiting reasons", () => {
  const steps = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `done-${index}`, text: "Done", state: "done" as const })),
    { id: "running", text: "In progress", state: "open" as const, ref: "lane", hold: { kind: "worker" as const, note: "Stale queue reason", since: now, by: "agent" as const } },
    { id: "queued-a", text: "Queued A", state: "open" as const, hold: { kind: "worker" as const, note: "When capacity is free", since: now, by: "agent" as const } },
    { id: "queued-b", text: "Queued B", state: "open" as const, hold: { kind: "worker" as const, note: "When capacity is free", since: now, by: "agent" as const } },
  ];
  const summary = deriveTaskSteps(steps, [{ id: "lane", state: "running" }]).summary;
  expect(summary).toMatchObject({ done: 5, total: 8, open: 3, working: 1, needsYou: 0, reasons: [{ kind: "queued", note: "When capacity is free", count: 2 }] });

  const asks = deriveTaskSteps([{ id: "ask", text: "Choose", state: "open", hold: { kind: "operator", note: "Choose a path", since: now, by: "agent" } }], []).summary;
  expect(asks).toMatchObject({ open: 1, needsYou: 1, working: 0, reasons: [] });
});
