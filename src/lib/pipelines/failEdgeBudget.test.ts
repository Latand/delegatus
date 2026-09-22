import { expect, test } from "bun:test";

import type { Pipeline, PipelineEdgeActivation, PipelineStage } from "./types";

import { edgeRoundsUsed, failEdgeBudgetSpent, failEdgeMaxRounds, failEdgeRoundsUsed, pipelineReviewSummary } from "./failEdgeBudget";

/* `critique -> review` with `critique.onFail = { to: fix, maxRounds: 2 }` and
   `fix.next = critique` — the shape of the pipeline in #1754. */
const CRITIQUE: PipelineStage = {
  id: "critique", kind: "run", prompt: "Critique.", next: "review", onFail: { to: "fix", maxRounds: 2 },
} as unknown as PipelineStage;
const FIX: PipelineStage = { id: "fix", kind: "run", prompt: "Fix.", next: "critique", onFail: null } as unknown as PipelineStage;

const failedBy = (attempt: number): PipelineEdgeActivation => ({ stageId: "critique", attempt, edge: "fail" });

function attempt(n: number, over: Record<string, unknown> = {}) {
  return { n, state: "passed", activatedBy: null, ...over } as never;
}

function pipeline(runs: Array<{ stageId: string; attempts: unknown[] }>): Pipeline {
  return { id: "p", stages: [CRITIQUE, FIX], runs, cursor: null, state: "running" } as unknown as Pipeline;
}

const budgetLeft = (record: Pipeline) => failEdgeRoundsUsed(record, CRITIQUE) < CRITIQUE.onFail!.maxRounds;

test("one fail followed by two retries of the target reads one round used (#1754)", () => {
  /* The first `fix` spawn failed and the operator used retry-stage twice: three
     `fix` attempts carry the provenance of the one critique failure. */
  const record = pipeline([
    { stageId: "critique", attempts: [attempt(1, { state: "failed" })] },
    { stageId: "fix", attempts: [
      attempt(1, { state: "failed", activatedBy: failedBy(1), error: "pipeline structured runtime host is unavailable" }),
      attempt(2, { state: "failed", activatedBy: failedBy(1) }),
      attempt(3, { state: "running", activatedBy: failedBy(1) }),
    ] },
  ]);
  expect(failEdgeRoundsUsed(record, CRITIQUE)).toBe(1);
  /* The budget is not exhausted, so the next critique failure takes its round. */
  expect(budgetLeft(record)).toBe(true);
});

test("two separate fails read two rounds used, and the exhausted budget stops routing", () => {
  const record = pipeline([
    { stageId: "critique", attempts: [attempt(1, { state: "failed" }), attempt(2, { state: "failed" })] },
    { stageId: "fix", attempts: [
      attempt(1, { state: "passed", activatedBy: failedBy(1) }),
      attempt(2, { state: "running", activatedBy: failedBy(2) }),
    ] },
  ]);
  expect(failEdgeRoundsUsed(record, CRITIQUE)).toBe(2);
  expect(budgetLeft(record)).toBe(false);
});

test("a manual retry of the source stage that fails again is a new round", () => {
  /* The operator retried `critique` itself: attempt 3 is a different source
     attempt, so its failure traverses the edge again. */
  const record = pipeline([
    { stageId: "critique", attempts: [attempt(1, { state: "failed" }), attempt(3, { state: "failed" })] },
    { stageId: "fix", attempts: [
      attempt(1, { state: "passed", activatedBy: failedBy(1) }),
      attempt(2, { state: "failed", activatedBy: failedBy(1) }),
      attempt(3, { state: "running", activatedBy: failedBy(3) }),
    ] },
  ]);
  expect(failEdgeRoundsUsed(record, CRITIQUE)).toBe(2);
  expect(budgetLeft(record)).toBe(false);
});

test("lineage-adopted evidence and other edges spend no round", () => {
  const record = pipeline([
    { stageId: "critique", attempts: [attempt(1, { state: "failed" })] },
    { stageId: "fix", attempts: [
      attempt(1, { state: "running", activatedBy: failedBy(1) }),
      /* An adopted helper copies the source attempt's provenance. */
      attempt(2, { historical: true, activatedBy: { stageId: "critique", attempt: 2, edge: "fail" } }),
      /* `fix` also runs after a pass from elsewhere; that is another edge. */
      attempt(3, { activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } }),
    ] },
  ]);
  expect(failEdgeRoundsUsed(record, CRITIQUE)).toBe(1);
  expect(edgeRoundsUsed(record, { from: "plan", to: "fix", kind: "pass" })).toBe(1);
  expect(edgeRoundsUsed(record, { from: "critique", to: "missing", kind: "fail" })).toBe(0);
  expect(failEdgeRoundsUsed(record, FIX)).toBe(0);
});

/* #1938: continue-review grants add rounds to a frozen edge and buy one more
   handoff each; the review summary is read only while the lane waits. */
test("continue-review grants add to maxRounds and each buys one more handoff (#1938)", () => {
  const grant = (rounds: number) => ({ clientRequestId: `g${rounds}`, expectedRevision: "0".repeat(64), stageId: "critique", rounds, reviewedHead: null, currentHead: "2".repeat(40), actor: { kind: "operator" }, at: "t" });
  const record = pipeline([
    { stageId: "critique", attempts: [attempt(1, { state: "failed" }), attempt(2, { state: "failed", budgetSpent: true })] },
    { stageId: "fix", attempts: [] },
  ]);
  expect(failEdgeMaxRounds(record, CRITIQUE)).toBe(2);
  expect(failEdgeBudgetSpent(record, CRITIQUE)).toBe(true);
  (record as { reviewGrants?: unknown[] }).reviewGrants = [grant(3)];
  expect(failEdgeMaxRounds(record, CRITIQUE)).toBe(5);
  expect(failEdgeBudgetSpent(record, CRITIQUE)).toBe(false);
  record.runs[0]!.attempts.push(attempt(3, { state: "failed", budgetSpent: true }));
  expect(failEdgeBudgetSpent(record, CRITIQUE)).toBe(true);
  /* A grant for another stage changes nothing here. */
  expect(failEdgeMaxRounds(record, FIX)).toBe(0);
});

test("the review summary exists only while the lane waits in needs_review (#1938)", () => {
  const reviewPending = { stageId: "critique", attempt: 2, fixStageId: "fix", fixAttempt: 3, reviewedHead: "1".repeat(40), currentHead: "2".repeat(40), verdict: "fail" as const, findings: 1, at: "t" };
  expect(pipelineReviewSummary({ state: "needs_review", pausedState: null, reviewPending }))
    .toEqual({ stageId: "critique", reviewedHead: "1".repeat(40), currentHead: "2".repeat(40), lastVerdict: "fail", findings: 1 });
  expect(pipelineReviewSummary({ state: "paused", pausedState: "needs_review", reviewPending })).not.toBeNull();
  expect(pipelineReviewSummary({ state: "closed", pausedState: null, reviewPending })).toBeNull();
  expect(pipelineReviewSummary({ state: "needs_review", pausedState: null })).toBeNull();
});
