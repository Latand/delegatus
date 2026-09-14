import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { groupHideState } from "./groupHide";
import { patchTask, type SeatHolding } from "./commands";
import { taskRevision } from "./revision";
import { taskSeatHolding } from "./seatHolding";
import type { BoardTask } from "./types";
import type { Pipeline } from "@/lib/pipelines/types";

/* Task colour and group hide (#1695 K4a) as pure commands: invented tasks,
   injected seat answers, no store and no state directory. */

const REV = ["task-v1:00000000", "0000", "4000", "8000", "000000000001"].join("-");
const NOW = "2026-09-14T12:00:00.000Z";

function task(extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task-a",
    project: "fixture",
    text: "Repair old links\nThe anchors moved",
    status: "assigned",
    placement: "unplaced",
    assignments: [{ path: "/fixture/links.jsonl", conversationId: "conversation_links", panePid: null, state: "delivered", error: null, at: "2026-09-14T10:00:00.000Z" }],
    createdAt: "2026-09-14T09:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: REV,
    ...extra,
  } as BoardTask;
}

const guard = { expectedProject: "fixture", expectedRevision: REV };
const free = (): SeatHolding => "free";

test("a colour is one of the nine names; none clears it; anything else is refused with its field", () => {
  const set = patchTask([task()], "task-a", { color: "teal" }, NOW);
  expect(set).toMatchObject({ ok: true, task: { color: "teal" } });
  if (!set.ok) return;
  const cleared = patchTask(set.tasks, "task-a", { color: "none" }, NOW);
  expect(cleared.ok && "color" in cleared.task).toBe(false);
  for (const value of ["ultraviolet", "", null, 3, "None"]) {
    expect(patchTask([task()], "task-a", { color: value }, NOW)).toMatchObject({ ok: false, status: 400, code: "TASK_INVALID_FIELD", field: "color" });
  }
});

test("a hide is fenced: no guard is a 400, and a stale revision or another project is a conflict that writes nothing", () => {
  const existing = [task()];
  expect(patchTask(existing, "task-a", { hide: true }, NOW, { seatHolding: free })).toMatchObject({ ok: false, status: 400, field: "expectedProject" });
  expect(patchTask(existing, "task-a", { hide: true, expectedProject: "fixture", expectedRevision: `${REV.slice(0, -1)}2` }, NOW, { seatHolding: free }))
    .toMatchObject({ ok: false, status: 409, code: "TASK_REVISION_MISMATCH" });
  expect(patchTask(existing, "task-a", { hide: true, expectedProject: "elsewhere", expectedRevision: REV }, NOW, { seatHolding: free }))
    .toMatchObject({ ok: false, status: 409, code: "TASK_PROJECT_MISMATCH" });
  expect(patchTask(existing, "task-a", { hide: "yes", ...guard }, NOW, { seatHolding: free })).toMatchObject({ ok: false, status: 400, field: "hide" });
  expect(existing[0]!.groupHidden).toBeUndefined();
});

test("hiding writes the hide and nothing else; showing removes it; hiding again moves its instant forward", () => {
  const before = task();
  const hidden = patchTask([before], "task-a", { hide: true, ...guard }, NOW, { actor: "agent", seatHolding: free });
  expect(hidden.ok).toBe(true);
  if (!hidden.ok) return;
  expect(hidden.task.groupHidden).toEqual({ at: NOW, by: "agent" });
  const { groupHidden: _hide, updatedAt: _updated, ...rest } = hidden.task;
  const { updatedAt: _beforeUpdated, ...unchanged } = before;
  expect(rest).toEqual(unchanged);
  expect(hidden.task.assignments).toBe(before.assignments);

  const shown = patchTask(hidden.tasks, "task-a", { hide: false, ...guard }, "2026-09-14T12:05:00.000Z");
  expect(shown.ok && "groupHidden" in shown.task).toBe(false);

  const again = patchTask(hidden.tasks, "task-a", { hide: true, ...guard }, "2026-09-14T13:00:00.000Z", { seatHolding: free });
  expect(again.ok && again.task.groupHidden).toEqual({ at: "2026-09-14T13:00:00.000Z", by: "operator" });
});

test("the task holding the seat conversation is never hidden, and an unreadable seat record refuses rather than guesses", () => {
  const existing = [task()];
  expect(patchTask(existing, "task-a", { hide: true, ...guard }, NOW, { seatHolding: () => "holds" }))
    .toMatchObject({ ok: false, status: 409, code: "TASK_HIDE_PROTECTED", field: "hide" });
  expect(patchTask(existing, "task-a", { hide: true, ...guard }, NOW, { seatHolding: () => "unknown" }))
    .toMatchObject({ ok: false, status: 503, code: "TASK_HIDE_UNVERIFIED" });
  /* A caller that cannot see seats at all cannot hide. */
  expect(patchTask(existing, "task-a", { hide: true, ...guard }, NOW)).toMatchObject({ ok: false, code: "TASK_HIDE_UNVERIFIED" });
  /* Showing is never refused on seat grounds. */
  expect(patchTask([task({ groupHidden: { at: NOW, by: "agent" } })], "task-a", { hide: false, ...guard }, NOW, { seatHolding: () => "holds" }).ok).toBe(true);
});

test("the seat is held through an assignment naming the active or pending seat by conversation id or path", () => {
  const seat = (conversationId: string | null, pathValue: string | null) => ({ conversationId, path: pathValue }) as never;
  expect(taskSeatHolding(task(), () => ({ active: seat("conversation_links", null), pending: null }))).toBe("holds");
  expect(taskSeatHolding(task(), () => ({ active: seat("conversation_other", "/fixture/links.jsonl"), pending: null }))).toBe("holds");
  expect(taskSeatHolding(task(), () => ({ active: null, pending: seat("conversation_links", null) }))).toBe("holds");
  expect(taskSeatHolding(task(), () => ({ active: seat("conversation_other", "/fixture/other.jsonl"), pending: null }))).toBe("free");
  expect(taskSeatHolding(task(), () => ({ active: null, pending: null }))).toBe("free");
  expect(taskSeatHolding(task(), () => { throw new Error("seat record unreadable"); })).toBe("unknown");
});

test("the hide path reaches no lifecycle code: the modules it runs through import no runtime, pipeline engine, flow, delivery or process module", () => {
  const forbidden = /from "@\/lib\/(runtime|flows|delivery|monitor|lifecycle|proc|agent)\b|from "@\/lib\/pipelines\/(engine|controller)|from "@\/lib\/tasks\/(send|reconcile)"/;
  for (const file of ["src/lib/tasks/commands.ts", "src/lib/tasks/seatHolding.ts", "src/lib/tasks/groupHide.ts", "src/app/api/tasks/[id]/route.ts"]) {
    const source = fs.readFileSync(path.resolve(file), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect({ file, lifecycleImports: imports.filter((line) => forbidden.test(line)) }).toEqual({ file, lifecycleImports: [] });
  }
});

/* ── Resurfacing ─────────────────────────────────────────────────────────── */

const HIDDEN_AT = "2026-09-14T11:00:00.000Z";
const hiddenTask = (extra: Partial<BoardTask> = {}) => task({ groupHidden: { at: HIDDEN_AT, by: "operator" }, ...extra });
const member = (extra: Record<string, unknown> = {}) => ({ path: "/fixture/links.jsonl", pendingQuestion: null, waitingInput: null, ...extra }) as never;

function pipeline(state: string, stamps: string[], extra: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "pipeline-a",
    taskIds: ["task-a"],
    state,
    runs: [{ stageId: "build", attempts: stamps.map((startedAt, index) => ({ n: index + 1, startedAt, completedAt: null })) }],
    ...extra,
  } as unknown as Pipeline;
}

test("a hidden group stays hidden while nothing newer than the hide needs the operator", () => {
  expect(groupHideState(task(), { members: [], pipelines: [] })).toEqual({ hidden: false, resurfaced: null });
  const old = groupHideState(hiddenTask(), {
    members: [member({ pendingQuestion: { askedAt: "2026-09-14T10:30:00.000Z" } })],
    pipelines: [pipeline("needs_decision", ["2026-09-14T10:40:00.000Z"])],
  });
  expect(old).toEqual({ hidden: true, since: HIDDEN_AT });
});

test("it comes back, with the reason, for a newer decision request, a newly admitted conversation, or a pipeline newly waiting on a decision", () => {
  expect(groupHideState(hiddenTask(), { members: [member({ pendingQuestion: { askedAt: "2026-09-14T11:05:00.000Z" } })], pipelines: [] }))
    .toEqual({ hidden: false, resurfaced: { kind: "decision", path: "/fixture/links.jsonl", at: "2026-09-14T11:05:00.000Z" } });
  expect(groupHideState(hiddenTask(), { members: [member({ waitingInput: { since: Date.parse("2026-09-14T11:10:00.000Z") / 1000 } })], pipelines: [] }))
    .toMatchObject({ hidden: false, resurfaced: { kind: "decision" } });

  const admitted = hiddenTask({ assignments: [...task().assignments, { path: "/fixture/new.jsonl", conversationId: "conversation_new", panePid: null, state: "handoff", error: null, at: "2026-09-14T11:20:00.000Z" }] });
  expect(groupHideState(admitted, { members: [], pipelines: [] }))
    .toEqual({ hidden: false, resurfaced: { kind: "admitted", conversation: "conversation_new", at: "2026-09-14T11:20:00.000Z" } });
  const failedLaunch = hiddenTask({ assignments: [{ path: null, conversationId: null, panePid: null, state: "failed", error: "spawn refused", at: "2026-09-14T11:20:00.000Z" }] });
  expect(groupHideState(failedLaunch, { members: [], pipelines: [] })).toMatchObject({ hidden: true });

  expect(groupHideState(hiddenTask(), { members: [], pipelines: [pipeline("needs_decision", ["2026-09-14T11:30:00.000Z"])] }))
    .toEqual({ hidden: false, resurfaced: { kind: "pipeline-decision", pipelineId: "pipeline-a", at: "2026-09-14T11:30:00.000Z" } });
});

test("a pipeline the operator dismissed since, one that is not waiting, or one of another task does not bring the group back", () => {
  const moved = ["2026-09-14T11:30:00.000Z"];
  expect(groupHideState(hiddenTask(), { members: [], pipelines: [pipeline("needs_decision", moved, { dismissedAt: "2026-09-14T11:45:00.000Z" })] })).toMatchObject({ hidden: true });
  expect(groupHideState(hiddenTask(), { members: [], pipelines: [pipeline("running", moved)] })).toMatchObject({ hidden: true });
  expect(groupHideState(hiddenTask(), { members: [], pipelines: [pipeline("needs_decision", moved, { taskIds: ["task-b"] })] })).toMatchObject({ hidden: true });
});
