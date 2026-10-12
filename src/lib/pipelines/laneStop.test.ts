import { expect, test } from "bun:test";

import { MERGE_REASONS } from "@/lib/forge/mergeReasons";

import { laneStopKind } from "./laneStop";
import type { Pipeline } from "./types";

/*
 * docs/design/calm-task-cards-build.md §5.2: the class of a lane's stop, read
 * from each producer's own phrase, so the card's words and the seat's wake
 * name the same class.
 */

const at = "2026-10-12T10:00:00.000Z";

const parked = (attempt: Record<string, unknown> | null, extra: Partial<Pipeline> = {}): Pipeline => ({
  id: "lane", task: "Lane", project: "project-a", state: "needs_decision", createdAt: at, stateDetail: null,
  stages: [{ id: "build", kind: "run" }], cursor: { stageId: "build" },
  runs: [{ stageId: "build", attempts: attempt ? [{ n: 1, state: "failed", startedAt: at, completedAt: at, ...attempt }] : [] }],
  ...extra,
}) as unknown as Pipeline;

test("each producer's phrase names its class", () => {
  const cases: Array<[string, string]> = [
    /* git.ts commitPipelineStage */
    ["committing the passed stage: fatal: Unable to create '.git/index.lock'", "commit"],
    /* git.ts recoverStageCommit */
    ["read-only stage review created a commit", "commit"],
    /* engine.ts publication park */
    ["publishing the passed stage: the pre-push hook refused the head. Fix it, then retry-stage.", "publish"],
    /* projectBindings.ts */
    ["no allowed codex account has capacity for project project-a (allowed codex accounts: one, two); resetsAt=unknown", "capacity"],
    ["no allowed claude account is available for project project-a (project project-a allows no claude account)", "capacity"],
    /* accounts/manager.ts, quotaController.ts */
    ["claude account requires authentication", "auth"],
    ["live authentication check failed", "auth"],
    /* engine.ts restart recovery */
    ["stage host was lost while its turn was open", "transport"],
    ["interrupted by a Delegatus restart", "transport"],
    ["the agent exited before it reported a verdict", "other"],
  ];
  for (const [error, kind] of cases) expect([error, laneStopKind(parked({ error }))?.kind]).toEqual([error, kind]);
});

test("the lane's own detail names the class when the attempt says nothing", () => {
  expect(laneStopKind(parked({ error: null }, { stateDetail: "publishing the passed stage: push interrupted" }))).toEqual({ kind: "publish", stageId: "build" });
});

test("a stage's question, a spent review budget and an unreviewed head come before the words", () => {
  expect(laneStopKind(parked({ state: "needs_decision", report: { verdict: { status: "needs_decision" }, summary: "Which one?" } }))?.kind).toBe("question");
  expect(laneStopKind(parked({ state: "needs_decision", verdict: { status: "needs_decision" } }))?.kind).toBe("question");
  expect(laneStopKind(parked({ error: "committing the passed stage: x" }, { stateDetail: "fail-edge budget exhausted after 2 rounds" }))?.kind).toBe("review");
  expect(laneStopKind(parked(null, { state: "needs_review", cursor: null, reviewPending: { stageId: "review" } } as unknown as Partial<Pipeline>))).toEqual({ kind: "unreviewed", stageId: "review" });
});

test("a lane that never ran a round stopped preparing; a completed lane stops only on its merge", () => {
  expect(laneStopKind(parked(null, { stateDetail: "worktree could not be created" }))).toEqual({ kind: "provisioning", stageId: "build" });
  /* A capacity refusal at admission names its class even before any attempt. */
  expect(laneStopKind(parked(null, { stateDetail: "no allowed codex account has capacity for project project-a (x); resetsAt=unknown" }))?.kind).toBe("capacity");
  const completed = parked(null, { state: "completed", cursor: null }) as Pipeline;
  expect(laneStopKind(completed)).toBeNull();
  expect(laneStopKind({ ...completed, merge: { state: "blocked", reason: MERGE_REASONS.closed, blockedAt: at, updatedAt: at } } as Pipeline)).toEqual({ kind: "merge", stageId: null });
  expect(laneStopKind({ ...completed, state: "running" } as Pipeline)).toBeNull();
});
