import { expect, test } from "bun:test";

import type { ClearedNeed } from "@/components/attention/needReason";
import type { Pipeline } from "@/lib/pipelines/types";

import { pastAttempts, type PastAttempt } from "./pipelineGraph";
import { foldChronology, taskChronology, type ChronologyEntry } from "./taskChronologyModel";

/*
 * docs/design/calm-task-cards-build.md §3: a task's events in order, from
 * records the board already holds, restarts folded, the latest eight shown,
 * and a lane's stop never hidden under «Earlier».
 */

const T0 = Date.parse("2026-10-12T08:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const ms = (minutes: number) => T0 + minutes * 60_000;

type Attempt = Record<string, unknown>;
const attempt = (n: number, state: string, start: number, end: number | null, extra: Attempt = {}): Attempt => ({
  n, state, startedAt: at(start), completedAt: end === null ? null : at(end), error: null, verdict: null, report: null,
  agentPath: `/fixture/${n}-${start}.jsonl`, conversationId: `conversation_${n}_${start}`, flowId: null, ...extra,
});

const lane = (id: string, extra: Partial<Pipeline>): Pipeline => ({
  id, task: `Lane ${id}`, taskIds: ["t1"], project: "project-a", state: "running", createdAt: at(0), closedAt: null, stateDetail: null,
  stages: [{ id: "build", kind: "run", next: "review", onFail: null }, { id: "review", kind: "run", next: null, onFail: null }],
  cursor: null, runs: [],
  ...extra,
}) as unknown as Pipeline;

const chronology = (pipelines: Pipeline[], extra: { cleared?: ClearedNeed[]; past?: PastAttempt[] } = {}) => taskChronology({
  taskCreatedAt: at(-5),
  pipelines,
  past: extra.past ?? pastAttempts(pipelines, new Map()),
  cleared: extra.cleared ?? [],
  seatConversationIds: ["conversation_seat"],
});

const kinds = (entries: readonly ChronologyEntry[]) => entries.map((entry) => entry.kind);

test("attempts, answers, pauses and the lane's stop read oldest first, and the stop carries the record's words", () => {
  const pipeline = lane("one", {
    state: "needs_decision",
    cursor: { stageId: "review" } as Pipeline["cursor"],
    pausedAt: at(25), resumedAt: at(27),
    runs: [
      { stageId: "build", attempts: [attempt(1, "passed", 10, 20)] },
      { stageId: "review", attempts: [
        attempt(1, "failed", 21, 24, { verdict: { status: "fail", findings: ["P1 — one", "P2 — two"] } }),
        attempt(2, "failed", 30, 34, { error: "committing the passed stage: fatal: index.lock exists · Viewer publication reserved for execution outside the mutation lease" }),
      ] },
    ] as unknown as Pipeline["runs"],
    decisionAnswers: [{ clientRequestId: "a1", expectedRevision: "r", stageId: "review", attempt: 1, nextAttempt: 2, question: "q", answer: "a", actor: { kind: "agent", role: null, conversationId: "conversation_seat" }, at: at(29) }],
  });
  const entries = chronology([pipeline]);
  expect(kinds(entries)).toEqual(["task-created", "attempt-passed", "attempt-failed", "lane-paused", "lane-resumed", "decision-answered", "attempt-stopped"]);
  const failed = entries.find((entry) => entry.kind === "attempt-failed")!;
  expect(failed.count).toBe(2);
  expect(failed.conversation).toEqual({ path: "/fixture/1-21.jsonl", conversationId: "conversation_1_21" });
  expect(entries.find((entry) => entry.kind === "decision-answered")?.actor).toBe("seat");
  const stop = entries.at(-1)!;
  expect(stop).toMatchObject({ kind: "attempt-stopped", stop: true, stopKind: "commit", stageId: "review", attempt: 2, atMs: ms(34) });
  /* The publication reservation's note says nothing to a person. */
  expect(stop.detail).toBe("committing the passed stage: fatal: index.lock exists");
});

test("a run of restarts cutting one stage folds into one entry with its count; a lost host is its own", () => {
  const cut = (n: number, start: number) => attempt(n, "failed", start, start + 1, { error: "interrupted by a Delegatus restart" });
  const pipeline = lane("cuts", {
    runs: [{ stageId: "build", attempts: [cut(1, 10), cut(2, 12), cut(3, 14), attempt(4, "failed", 16, 17, { error: "stage host was lost while its turn was open" }), attempt(5, "running", 18, null)] }] as unknown as Pipeline["runs"],
  });
  const entries = chronology([pipeline]);
  expect(kinds(entries)).toEqual(["task-created", "attempt-cut", "attempt-lost", "attempt-running"]);
  expect(entries[1]).toMatchObject({ count: 3, atMs: ms(15) });
});

test("a merge's queue, updates, stop and clearing, and a cleared conversation reason, take their places", () => {
  const pipeline = lane("merge", {
    state: "completed",
    runs: [{ stageId: "build", attempts: [attempt(1, "passed", 1, 5)] }] as unknown as Pipeline["runs"],
    merge: { state: "blocked", reason: "the PR was closed", prNumber: 9, requestedAt: at(6), updates: [{ requestedAt: at(8), head: null }], blockedAt: at(10), updatedAt: at(10), mergedAt: null, by: null } as unknown as Pipeline["merge"],
    dismissedAt: at(12), dismissedBy: { kind: "manager", conversationId: "conversation_seat", role: null },
  });
  const cleared = [{ need: { subject: "conversation", key: "ask-1" }, at: ms(13) / 1000, by: { kind: "operator" } }] as unknown as ClearedNeed[];
  const entries = chronology([pipeline], { cleared });
  expect(kinds(entries)).toEqual(["task-created", "attempt-passed", "merge-queued", "merge-updated", "merge-stopped", "lane-cleared", "need-cleared"]);
  expect(entries.find((entry) => entry.kind === "merge-stopped")).toMatchObject({ stop: true, prNumber: 9, mergeReason: "the PR was closed" });
  expect(entries.find((entry) => entry.kind === "lane-cleared")?.actor).toBe("seat");
  expect(entries.find((entry) => entry.kind === "need-cleared")?.actor).toBe("operator");
});

test("two lanes each say when they started; a merged lane says who merged it; a closed one that it closed", () => {
  const first = lane("first", { state: "completed", runs: [{ stageId: "build", attempts: [attempt(1, "passed", 1, 3)] }] as unknown as Pipeline["runs"], merge: { state: "merged", by: "auto-merge", prNumber: 3, requestedAt: at(4), updates: [], mergedAt: at(6), blockedAt: null, updatedAt: at(6), reason: null } as unknown as Pipeline["merge"] });
  const second = lane("second", { createdAt: at(7), state: "closed", closedAt: at(9), runs: [{ stageId: "build", attempts: [attempt(1, "skipped", 8, 8)] }] as unknown as Pipeline["runs"] });
  expect(kinds(chronology([first, second]))).toEqual(["task-created", "lane-started", "attempt-passed", "merge-queued", "merge-merged", "lane-started", "attempt-skipped", "lane-closed"]);
});

test("the fold shows the latest eight behind «Earlier · N», and a stop under the fold is pulled out first", () => {
  /* The first lane stopped early; the second lane's work pushes the stop under the fold. */
  const stopped = lane("stopped", {
    state: "needs_decision", cursor: { stageId: "build" } as Pipeline["cursor"],
    runs: [{ stageId: "build", attempts: [attempt(1, "failed", 1, 2, { error: "no allowed codex account has capacity for project project-a (x); resetsAt=unknown" })] }] as unknown as Pipeline["runs"],
  });
  const busy = lane("busy", {
    createdAt: at(3),
    runs: [{ stageId: "build", attempts: Array.from({ length: 10 }, (_, index) => attempt(index + 1, "failed", 10 + index * 2, 11 + index * 2, { verdict: { status: "fail", findings: ["x"] } })) }] as unknown as Pipeline["runs"],
  });
  const entries = chronology([stopped, busy]);
  expect(entries.length).toBe(14);
  const folded = foldChronology(entries, false);
  expect(folded.shown).toHaveLength(8);
  expect(folded.hidden).toBe(6);
  expect(folded.shown[0]).toMatchObject({ kind: "attempt-stopped", stop: true, pipelineId: "stopped", stopKind: "capacity" });
  expect(folded.shown.slice(1)).toEqual(entries.slice(-7));
  /* Opened, everything shows in order. */
  expect(foldChronology(entries, true)).toEqual({ hidden: 0, shown: entries });
  /* Eight or fewer never fold. */
  expect(foldChronology(entries.slice(0, 8), false)).toEqual({ hidden: 0, shown: entries.slice(0, 8) });
});
