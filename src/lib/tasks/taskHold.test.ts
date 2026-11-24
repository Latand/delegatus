import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTasks, mutateTasks, saveTasks } from "./store";
import { taskRevision } from "./revision";
import { expect, test } from "bun:test";
import { createTask, patchTask } from "./commands";
import { TASK_HOLD_KINDS, type BoardTask, type TaskHold } from "./types";

const NOW = "2026-10-02T10:00:00.000Z";
const LATER = "2026-10-02T11:00:00.000Z";
const DUE = "2026-10-03T10:00:00.000Z";
function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return { id: "hold-task", project: "fixture", text: "Finish the remaining work", status: "inbox", placement: "unplaced", assignments: [], createdAt: NOW, updatedAt: NOW, ...overrides };
}
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  return result as Extract<T, { ok: true }>;
}

test.each([
  ...TASK_HOLD_KINDS.map(kind => [kind, kind] as const),
  ["banana", "unstated"] as const,
  [" External ", "external"] as const,
  [" POSTPONED ", "postponed"] as const,
])("commands report discarded until for %s while preserving deadlines and stored holds", (kind, expectedKind) => {
  const supported = expectedKind === "limit" || expectedKind === "postponed";
  const hold = { kind, note: "Wait for the dependency", until: LATER };
  const notes = [
    ...(kind === "banana" ? ['Unknown hold kind "banana" normalized to unstated.'] : []),
    ...(!supported ? [`hold.until ignored for hold kind "${expectedKind}"; only limit and postponed store until. Use dueAt for the task deadline.`] : []),
  ];
  const created = ok(createTask([], { project: "fixture", text: "Wait for dependency", placement: "unplaced", dueAt: DUE, dueTz: "UTC", hold }, [],
    { now: () => NOW, id: () => "dated-hold", actor: "agent", conversationId: "conversation_fixture" }));
  const updated = ok(patchTask([task({ dueAt: DUE, dueTz: "UTC" })], "hold-task", { hold }, NOW, { actor: "agent", conversationId: "conversation_fixture" }));
  const step = ok(patchTask([task({ dueAt: DUE, dueTz: "UTC" })], "hold-task", {
    steps: [{ id: "dependency", text: "Wait for dependency", state: "open", hold }],
  }, NOW, { actor: "agent", conversationId: "conversation_fixture" }));
  const expectedHold: TaskHold = { kind: expectedKind, note: hold.note, since: NOW, by: "agent", conversationId: "conversation_fixture", ...(supported ? { until: LATER } : {}) };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dated-hold-"));
  try {
    for (const result of [created, updated, step]) {
      expect(result.notes).toEqual(notes.length ? notes : undefined);
      expect(result.task.dueAt).toBe(DUE);
      expect(result.task.dueTz).toBe("UTC");
      expect(result === step ? result.task.steps?.[0]?.hold : result.task.hold).toEqual(expectedHold);
      const file = path.join(directory, "tasks.json");
      saveTasks(result.tasks, file);
      const stored = loadTasks(file)[0]!;
      expect(stored.hold).toEqual(result.task.hold);
      expect(stored.steps).toEqual(result.task.steps);
      expect(stored.dueAt).toBe(DUE);
      expect(stored.dueHistory).toEqual(result.task.dueHistory);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("omitted until is quiet and malformed holds keep their forgiving normalization", () => {
  for (const kind of TASK_HOLD_KINDS) {
    const result = ok(patchTask([task()], "hold-task", { hold: { kind } }, NOW));
    expect(result.notes).toBeUndefined();
    expect(result.task.hold).not.toHaveProperty("until");
  }
  for (const until of ["bad date", "", null, 123, {}]) {
    for (const kind of ["limit", "postponed", "external"] as const) {
      const result = ok(patchTask([task()], "hold-task", { hold: { kind, until } }, NOW));
      expect(result.task.hold).toEqual({ kind, note: "", since: NOW, by: "operator" });
      expect(result.notes?.length).toBe(kind === "external" ? 1 : undefined);
    }
  }
  for (const hold of ["bad hold", [], 42, {}]) {
    const result = ok(patchTask([task()], "hold-task", { hold }, NOW));
    expect(result.task.hold).toEqual({ kind: "unstated", note: "", since: NOW, by: "operator" });
    expect(result.notes).toBeUndefined();
  }
});

test("a hold moves work to Waiting, preserves its age on edits, and clears by the owner rule", () => {
  const original = task();
  const waiting = ok(patchTask([original], original.id, { hold: { kind: "worker", note: "Wait for a free worker", since: "2000-01-01", by: "migration" } }, NOW));
  expect(waiting.task.status).toBe("inbox");
  expect(waiting.task.hold).toEqual({ kind: "worker", note: "Wait for a free worker", since: NOW, by: "operator" });
  const edited = ok(patchTask(waiting.tasks, original.id, { hold: { kind: "resource", note: "Wait for memory" } }, LATER, { actor: "agent" }));
  expect(edited.task.hold?.since).toBe(NOW);
  expect(edited.task.hold?.by).toBe("agent");
  expect(edited.task.status).toBe("inbox");
  const cleared = ok(patchTask(edited.tasks, original.id, { hold: null }, LATER));
  expect(cleared.task.status).toBe("inbox");
  expect(cleared.task.hold).toBeUndefined();
  const owned = task({ status: "assigned", assignments: [{ path: "/fixture/worker.jsonl", panePid: null, state: "delivered", error: null, at: NOW }] });
  const ownedWait = ok(patchTask([owned], owned.id, { hold: { kind: "limit", note: "Next usage window" } }, NOW));
  expect(ok(patchTask(ownedWait.tasks, owned.id, { hold: null }, LATER)).task.status).toBe("assigned");
});

test.each([...TASK_HOLD_KINDS])("agent %s holds preserve the work column and migrate old Waiting writes by ownership", kind => {
  const hold = { kind, note: "Fixture reason" };
  const agent = { actor: "agent" as const };
  const expected = kind === "operator" ? "blocked" : "inbox";
  const created = ok(createTask([], { project: "fixture", text: "Record a wait", placement: "unplaced", hold }, [],
    { ...agent, now: () => NOW, id: () => "created-hold" }));
  expect(created.task.status).toBe(expected);
  const owned = task({ status: "assigned", assignments: [{ path: null, panePid: null, state: "linked", error: null, at: NOW }] });
  for (const starting of [task(), owned, { ...owned, status: "blocked" as const }]) {
    const updated = ok(patchTask([starting], starting.id, { hold }, NOW, agent));
    expect(updated.task.status).toBe(kind === "operator" ? "blocked" : starting.assignments.length ? "assigned" : "inbox");
    expect(updated.task.hold?.kind).toBe(kind);
  }
});

test("explicit blocked writes are clamped with their reason and completion always clears it", () => {
  const options = { actor: "agent" as const, now: () => NOW, id: () => "clamped-hold" };
  const input = { project: "fixture", text: "Record a wait", placement: "unplaced", status: "blocked" };
  const original = task({ status: "blocked" });
  for (const hold of [undefined, { kind: "resource" as const, note: "Wait for capacity" }]) {
    const fields = hold ? { hold } : {};
    for (const result of [
      ok(createTask([], { ...input, ...fields }, [], options)),
      ok(patchTask([original], original.id, { status: "blocked", ...fields }, NOW, options)),
    ]) {
      expect(result.task.status).toBe("inbox");
      expect(result.task.hold?.kind).toBe(hold?.kind ?? "unstated");
      expect(result.notes).toEqual([expect.stringContaining('Use hold kind "operator"')]);
    }
  }
  const moved = ok(patchTask([original], original.id, { status: "assigned", hold: { kind: "pr" } }, NOW, options));
  expect(moved.task).toMatchObject({ status: "assigned", hold: { kind: "pr" } });
  const legacyWait = { ...moved.task, status: "blocked" as const };
  expect(ok(patchTask([legacyWait], original.id, { status: "blocked" }, LATER, options)).task)
    .toMatchObject({ status: "inbox", hold: legacyWait.hold! });
  expect(ok(patchTask(moved.tasks, original.id, { status: "inbox" }, LATER, options)).task.hold).toBeUndefined();
  const done = ok(patchTask(moved.tasks, original.id, { status: "done", hold: { kind: "operator" } }, LATER, options));
  expect(done.task.status).toBe("done");
  expect(done.task.hold).toBeUndefined();
  expect(ok(createTask([], input, [], { now: () => NOW, id: () => "operator-wait" })).task).toMatchObject({
    status: "inbox", hold: { kind: "unstated", by: "operator" },
  });
  expect(ok(createTask([], { ...input, hold: { kind: "operator", note: "Choose a setting" } }, [],
    { now: () => NOW, id: () => "operator-action" })).task.status).toBe("blocked");
});

test("an empty operator label cannot park an agent update and is routed to the seat", async () => {
  const { waitingRoute, waitingRouteIndex } = await import("./waitingRoute");
  const original = task({ status: "assigned", assignments: [{ path: null, panePid: null, state: "linked", error: null, at: NOW }] });
  const result = ok(patchTask([original], original.id, { status: "blocked", hold: { kind: "operator" } }, NOW, { actor: "agent" }));
  expect(result.task.status).toBe("assigned");
  expect(result.task.hold?.note).toBe("");
  expect(waitingRoute(result.task, waitingRouteIndex([result.task], []), Date.parse(NOW))).toMatchObject({ owner: "seat", why: expect.stringContaining("names no action") });
});

test("an empty operator hold enters Waiting only while its decision form is open", async () => {
  const { prototypeTask } = await import("@/lib/voiceCompanion/prototypeRead.fixture");
  const { dismissAttention } = await import("@/lib/attention/dismissals");
  const { resolvedPrototypeSummary } = await import("@/lib/prototypeReview/read");
  const original = prototypeTask("hold-form-task");
  const round = original.prototypeReviews![0]!;
  const target = { kind: "prototype" as const, taskId: original.id, reviewId: round.id };
  const operator = { kind: "operator" as const, surface: "desktop" as const };
  const update = () => mutateTasks(rows => {
    const patched = ok(patchTask(rows, original.id, { status: "blocked", hold: { kind: "operator" } }, original.updatedAt, { actor: "agent" }));
    return { tasks: patched.tasks, result: patched.task };
  });
  saveTasks([original]);
  try {
    expect(update().status).toBe("blocked");
    await dismissAttention(target, operator);
    expect(resolvedPrototypeSummary(original)?.waitingDismissal).toBeDefined();
    expect(update().status).toBe("inbox");
    await dismissAttention(target, operator, { undo: true });
    const answered = structuredClone(original);
    answered.prototypeReviews![0]!.decision = { chosen: [1], comment: "", at: original.updatedAt,
      revision: 1, delivery: { state: "no-orchestrator", conversationId: null, clientMessageId: "fixture-answer", text: "First variant chosen" } };
    expect(resolvedPrototypeSummary(answered)?.waitingReviewId).toBeNull();
    saveTasks([answered]);
    expect(update().status).toBe("inbox");
  } finally {
    await dismissAttention(target, operator, { undo: true });
    saveTasks([]);
  }
});


test("legacy status writes remain accepted, create refuses oversized reasons, and unrelated hidden cards stay untouched", () => {
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
  const created = createTask([], { project: "fixture", placement: "unplaced", text: "Wait for a dependency", hold: { kind: "unknown", note: "x".repeat(250), until: "bad date" } }, [], { now: () => NOW });
  expect(created).toMatchObject({ ok: false, field: "hold.note", error: expect.stringContaining("actual length is 250") });
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
  expect(restored.task.status).toBe("inbox");
  for (const [kind, expected] of [["PR", "pr"], [" Issue ", "issue"], ["banana", "unstated"]] as const) {
    const normalized = ok(patchTask([moved], moved.id, { ...request, restoreHold: { ...held.hold, kind } }, LATER, { actor: "operator" }));
    expect(normalized.task.hold?.kind).toBe(expected);
    expect(normalized.task.hold?.since).toBe(held.hold?.since);
    expect(normalized.notes).toEqual(kind === "banana" ? ['Unknown hold kind "banana" normalized to unstated.'] : undefined);
  }
  expect(patchTask([moved], moved.id, { ...request, expectedRevision: "stale" }, LATER, { actor: "operator" }).ok).toBe(false);
  expect(patchTask([moved], moved.id, request, LATER, { actor: "agent" }).ok).toBe(false);

  const operatorHeld = ok(patchTask([task()], "hold-task", { hold: { kind: "operator", note: "Choose a setting" } }, NOW, { actor: "operator" })).task;
  const operatorMoved = ok(patchTask([operatorHeld], operatorHeld.id, { status: "assigned" }, LATER)).task;
  const operatorRestored = ok(patchTask([operatorMoved], operatorMoved.id, {
    status: "blocked", restoreHold: operatorHeld.hold, expectedProject: operatorMoved.project,
    expectedRevision: taskRevision(operatorMoved),
  }, LATER, { actor: "operator" }));
  expect(operatorRestored.task).toMatchObject({ status: "blocked", hold: { kind: "operator" } });
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
