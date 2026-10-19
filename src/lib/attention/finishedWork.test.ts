import { expect, test } from "bun:test";
import { buildNeedsYouQueue } from "@/components/attention/attentionQueue";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { attentionSystemClears, type ReconcileFacts } from "./reconcile";
import { finishedWorkIndex } from "./finishedWork";

const now = Date.parse("2026-10-19T06:00:00Z") / 1000;
const at = "2026-10-12T06:00:00Z";
const finishedAt = "2026-10-12T07:00:00Z";
const entry = { path: "/fixture/stage.jsonl", conversationId: "conversation_stage", project: "fixture", title: "Review", root: "claude-projects", name: "stage", kind: "session", engine: "claude", fmt: "claude", mtime: Date.parse(at) / 1000, size: 1,
  activity: "idle", proc: "killed", pid: null, parent: null, model: null, pendingQuestion: null, waitingInput: null,
  pendingPermission: { id: "approval", since: at, tool: "Bash", command: "make" },
} as FileEntry;
const task = { id: "task", project: "fixture", text: "Work", status: "assigned", placement: "unplaced", createdAt: at, updatedAt: at,
  assignments: [{ path: entry.path, conversationId: entry.conversationId, at, state: "linked", panePid: null, error: null }] } as BoardTask;
const lane = { id: "lane", state: "completed", project: "fixture", taskIds: [task.id], createdAt: at, closedAt: finishedAt, stages: [],
  runs: [{ stageId: "review", attempts: [{ n: 1, state: "needs_decision", startedAt: at, completedAt: finishedAt, conversationId: entry.conversationId, agentPath: entry.path }] }] } as unknown as Pipeline;
const facts = (tasks: BoardTask[], pipelines: Pipeline[]): ReconcileFacts => ({ tasks, pipelines, pipeline: id => pipelines.find(lane => lane.id === id) ?? null,
  canonicalConversationId: id => id, retiredSeats: new Set(), operatorWroteAt: new Map() });

test("done tasks and completed or closed lanes withdraw old dead permission requests across badge and reconciliation", () => {
  for (const [tasks, lanes] of [[[ { ...task, status: "done", doneAt: finishedAt }], []], [[task], [lane]], [[task], [{ ...lane, state: "closed" }]]] as [BoardTask[], Pipeline[]][]) {
    expect(attentionSystemClears([entry], now, facts(tasks, lanes)).map(clear => clear.rule)).toEqual(["container-finished"]);
    expect(buildNeedsYouQueue([entry], lanes, now, [], null, tasks)).toHaveLength(0);
  }
});

test("live, newer, undated, active and unreadable owners preserve their asks", () => {
  const newer = { ...entry, pendingPermission: { ...entry.pendingPermission!, since: "2026-10-19T05:00:00Z" } };
  const undated = { ...entry, pendingPermission: { ...entry.pendingPermission!, since: "" } };
  for (const file of [{ ...entry, proc: "running" as const }, { ...entry, activity: "live" as const, proc: null }, newer, undated]) {
    expect(attentionSystemClears([file], now, facts([task], [lane]))).toEqual([]);
    expect(buildNeedsYouQueue([file], [lane], now, [], null, [task])).toHaveLength(1);
  }
  for (const lanes of [[], [{ ...lane, state: "running", runs: [] }], [{ ...lane, closedAt: null, runs: [] }]] as Pipeline[][]) {
    expect(attentionSystemClears([entry], now, facts([task], lanes))).toEqual([]);
  }
  expect(attentionSystemClears([entry], now, facts([task], [lane, { ...lane, id: "active", state: "running" }]))).toEqual([]);
});

test("old dead-host stage decisions expire with their lane; deliveries and later decisions remain", () => {
  const decision = { ...entry, pendingPermission: null, operatorAsk: { id: "decision", messageAt: Date.parse(at), gist: "Continue?", state: "open" } } as FileEntry;
  expect(attentionSystemClears([decision], now, facts([task], [lane])).map(clear => clear.reason)).toEqual(["ask"]);
  const bridge = { ...entry, pendingPermission: null, bridgeAsks: [{ id: "decision", at: "2026-10-19T05:30:00Z", body: "Continue?", seq: 1 }] } as FileEntry;
  const justFinished = { ...lane, closedAt: "2026-10-19T05:40:00Z" };
  expect(attentionSystemClears([bridge], now, facts([task], [justFinished])).map(clear => clear.reason)).toEqual(["decision"]);
  expect(attentionSystemClears([bridge], now, facts([task], [lane]))).toEqual([]);
  const delivery = { ...entry, pendingPermission: null, stuckDelivery: { state: "delivery-uncertain", since: at } } as FileEntry;
  expect(attentionSystemClears([delivery], now, facts([task], [lane]))).toEqual([]);
});

test("terminal lane work returns unfinished assigned tasks to Inbox; Done, later work, reopenings and active lanes keep their column", () => {
  expect(finishedWorkIndex([task], [lane]).taskStatus(task)).toBe("inbox");
  for (const state of ["closed", "completed"] as const) expect(finishedWorkIndex([task], [{ ...lane, state }]).taskStatus(task)).toBe("inbox");
  expect(finishedWorkIndex([task], [lane]).taskStatus({ ...task, status: "done" })).toBe("done");
  expect(finishedWorkIndex([task], [lane]).taskStatus({ ...task, machine: "peer-install" })).toBe("assigned");
  expect(finishedWorkIndex([task], [lane]).taskStatus({ ...task, hold: { kind: "operator", note: "Pick the release", since: at, by: "operator" } })).toBe("assigned");
  expect(finishedWorkIndex([task], [lane, { ...lane, id: "active", state: "running" }]).taskStatus(task)).toBe("assigned");
  expect(finishedWorkIndex([task], [lane]).taskStatus({ ...task, statusBy: { actor: { kind: "operator" }, from: "inbox", at: "2026-10-19T05:00:00Z" } })).toBe("assigned");
  expect(finishedWorkIndex([task], [lane]).taskStatus({ ...task, assignments: [{ ...task.assignments[0]!, at: "2026-10-19T05:00:00Z" }] })).toBe("assigned");
  expect(finishedWorkIndex([task], [{ ...lane, closedAt: null, runs: [] }]).taskStatus(task)).toBe("assigned");
});


test("an operator restore keeps the exact old ask visible after another reconciliation", () => {
  const restored = { ...entry, attentionDismissal: { at: finishedAt, by: { kind: "system", rule: "container-finished" }, reasonId: `${entry.path}:permission:approval`, restoredAt: "2026-10-19T05:00:00Z" } } as FileEntry;
  expect(attentionSystemClears([restored], now, facts([task], [lane]))).toHaveLength(1);
  expect(buildNeedsYouQueue([restored], [lane], now, [], null, [task])).toHaveLength(1);
});


test("a running host in an already settled stage retains its relevant permission", () => {
  const file = { ...entry, proc: "running", durableLineage: { kind: "spawn", role: "reviewer", parentConversationId: null, reviewsConversationId: null,
    memberships: [{ kind: "pipeline", containerId: lane.id, stageId: "review", stageOrder: 0, role: "reviewer", slot: "review", round: null, parentConversationId: null }] } } as FileEntry;
  expect(attentionSystemClears([file], now, facts([task], [lane]))).toEqual([]);
});


test("task decision forms raised before completion expire; newer forms and owed decision deliveries remain", () => {
  const summary = { latestReviewId: "review", waitingReviewId: "review", title: "Pick an option", rounds: 1, createdAt: at };
  const done = { ...task, status: "done", doneAt: finishedAt, prototypeReview: summary } as BoardTask;
  expect(buildNeedsYouQueue([], [], now, [], null, [done])).toHaveLength(0);
  expect(buildNeedsYouQueue([], [], now, [], null, [{ ...done, prototypeReview: { ...summary, createdAt: "2026-10-19T05:00:00Z" } }])).toHaveLength(1);
  expect(buildNeedsYouQueue([], [], now, [], null, [{ ...done, prototypeReview: { ...summary, createdAt: "unknown" } }])).toHaveLength(1);
  const undelivered = { ...done, prototypeReview: { ...summary, waitingReviewId: null, undelivered: [{ reviewId: "review", title: "Pick an option", at }] } };
  expect(buildNeedsYouQueue([], [], now, [], null, [undelivered])).toHaveLength(1);
});


test("a revived host with the same permission id reappears despite the earlier automatic clear", () => {
  const live = { ...entry, proc: "running", attentionDismissal: { at: finishedAt, by: { kind: "system", rule: "container-finished" }, reasonId: `${entry.path}:permission:approval` } } as FileEntry;
  expect(buildNeedsYouQueue([live], [lane], now, [], null, [task])).toHaveLength(1);
  const reopened = { ...live, proc: "killed" } as FileEntry;
  expect(buildNeedsYouQueue([reopened], [{ ...lane, state: "running" }], now, [], null, [task])).toHaveLength(1);
});
