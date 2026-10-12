import { expect, test } from "bun:test";

import { laneRouteKey } from "@/lib/attention/routeTypes";
import { translate, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { answerLabel, pipelineAnswers } from "@/components/pipelines/pipelineBlockModel";

import { laneState } from "./cardState";
import { heldAnswer, laneAnswerItems } from "./laneAnswerMenu";

/*
 * docs/design/calm-task-cards-build.md §4: the answer buttons left the card's
 * face, and every one of them is still reachable from the lane's ⋯, in the
 * button's own words, marked manual where the orchestrator owns the lane.
 */

const at = "2026-10-12T10:00:00.000Z";
const en: TFunction = ((key: string, params?: Record<string, unknown>) => translate("en", key as never, params as never)) as TFunction;
const uk: TFunction = ((key: string, params?: Record<string, unknown>) => translate("uk", key as never, params as never)) as TFunction;
const nameOf = (stage: PipelineStage) => stage.id[0]!.toUpperCase() + stage.id.slice(1);

const decision = (extra: Partial<Pipeline> = {}): Pipeline => ({
  id: "lane", task: "Lane", taskIds: [], project: "project-a", state: "needs_decision", createdAt: at, closedAt: null, stateDetail: "stage failed",
  stages: [{ id: "build", kind: "run", next: null, onFail: null }], cursor: { stageId: "build" }, srcConversationId: "conversation_seat",
  runs: [{ stageId: "build", attempts: [{ n: 2, state: "failed", startedAt: at, completedAt: at, effectiveRole: { roleId: "builder", access: "read-write" }, error: "boom" }] }],
  ...extra,
}) as unknown as Pipeline;

/* A read-only reviewer whose fail edge parks when spent: the review stop. */
const reviewStopLane = (): Pipeline => decision({
  stateDetail: "fail-edge budget exhausted after 2 rounds",
  stages: [
    { id: "build", kind: "run", next: "review", onFail: null },
    { id: "review", kind: "run", next: null, onFail: { to: "build", maxRounds: 2, onExhausted: "park" }, role: { roleId: "reviewer" }, effectiveRole: { roleId: "reviewer", access: "read-only" } },
  ],
  cursor: { stageId: "review" },
  runs: [{ stageId: "build", attempts: [] }, { stageId: "review", attempts: [{ n: 3, state: "failed", startedAt: at, completedAt: at, effectiveRole: { roleId: "reviewer", access: "read-only" }, verdict: { status: "fail", findings: ["P1 — x"] } }] }],
} as unknown as Partial<Pipeline>);

const needsReview = (): Pipeline => decision({
  state: "needs_review", cursor: null, srcConversationId: null,
  reviewPending: { stageId: "build", reviewedHead: "aaa", currentHead: "bbb", verdict: "fail", findings: 1 },
} as unknown as Partial<Pipeline>);

const stoppedMerge = (): Pipeline => decision({
  state: "completed", cursor: null,
  merge: { state: "blocked", reason: "conflict with the base branch", blockedAt: at, updatedAt: at, prNumber: 7, updates: [] },
} as unknown as Partial<Pipeline>);

const skipRefused = (): Pipeline => decision({
  stages: [{ id: "build", kind: "run", next: null, onFail: { to: "build", maxRounds: 1 } }],
  runs: [{ stageId: "build", attempts: [{ n: 2, state: "failed", startedAt: at, completedAt: at, effectiveRole: { roleId: "builder", access: "read-write" }, verdict: { status: "fail", findings: ["x"] }, error: null }] }],
} as unknown as Partial<Pipeline>);

const seatOwned = (pipeline: Pipeline): Pipeline => {
  pipeline.attentionRoute = { key: laneRouteKey(pipeline, pipeline.state === "completed" ? "lane-merge" : pipeline.state === "needs_review" ? "lane-review" : "lane-decision"), owner: "seat", seat: "conversation_seat" };
  return pipeline;
};

test("every answer the lane row offered is in the ⋯, in its own words, the quiet one first", () => {
  for (const make of [decision, skipRefused, reviewStopLane, needsReview, stoppedMerge]) {
    for (const t of [en, uk]) {
      const pipeline = make();
      const answers = pipelineAnswers(pipeline, nameOf);
      expect(answers).not.toBeNull();
      const items = laneAnswerItems(t, pipeline, laneState(pipeline).owner, nameOf);
      expect(items.map((item) => [item.action, item.label])).toEqual(answers!.choices.map((answer) => [answer.action, answerLabel(t, answers!, answer, false)]));
      /* The stage and attempt the answer was drawn at travel with it. */
      expect(items.map(({ action, stageId, stageName, expectedAttempt }) => ({ action, stageId, stageName, expectedAttempt }))).toEqual([...answers!.choices]);
    }
  }
  expect(laneAnswerItems(en, decision(), "you", nameOf).map((item) => item.label)).toEqual(["Skip Build", "Retry Build"]);
  expect(laneAnswerItems(en, reviewStopLane(), "you", nameOf).map((item) => item.label)).toEqual(["Accept without review", "Review again"]);
  expect(laneAnswerItems(en, needsReview(), "you", nameOf).map((item) => item.action)).toEqual(["accept-head"]);
  expect(laneAnswerItems(uk, stoppedMerge(), "you", nameOf).map((item) => item.label)).toEqual(["Залишити PR відкритим", "Спробувати мердж ще раз"]);
});

test("the answers say they are a manual override only where the orchestrator owns the lane", () => {
  for (const make of [decision, reviewStopLane, stoppedMerge]) {
    const owned = seatOwned(make());
    expect(laneState(owned).owner).toBe("seat");
    const items = laneAnswerItems(uk, owned, laneState(owned).owner, nameOf);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.why === "Вручну: оркестратор робить це сам")).toBe(true);
    const own = make();
    expect(laneAnswerItems(uk, own, laneState(own).owner, nameOf).every((item) => item.why === null)).toBe(true);
  }
});

test("a lane that asks nothing has no answers; skip is held for its receipt, retry goes at once", () => {
  expect(laneAnswerItems(en, decision({ state: "running", cursor: null }), "working", nameOf)).toEqual([]);
  expect(heldAnswer({ action: "skip-stage" })).toBe(true);
  expect(heldAnswer({ action: "close" })).toBe(true);
  expect(heldAnswer({ action: "retry-stage" })).toBe(false);
  expect(heldAnswer({ action: "retry-merge" })).toBe(false);
});
