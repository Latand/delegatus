import type { Pipeline, PipelineEdgeKind, PipelineFailEdge, PipelineFailEdgeExhaustion, PipelineStage, StageVerdictStatus } from "./types";

/** What the record says when a spent fail edge handed its last findings on
    without asking the source again (#1868). */
export const FAIL_EDGE_BUDGET_SPENT_DETAIL = "budget spent: last findings handed to the fix stage, not re-reviewed";

/**
 * How many times an edge has been traversed, derived (never stored) from the
 * durable activation records the target's attempts carry.
 *
 * A round is one traversal, so what is counted is the distinct source attempts
 * that activated the target — `activatedBy.stageId` plus `activatedBy.attempt`
 * — never the target's own attempts. A retry of the target (a spawn failure, a
 * provider throttle, a cut turn) is a fresh attempt carrying the same
 * activation, and it spends no round (#1754). Lineage-adopted evidence
 * (`historical`) is not the stage's own work and never counts. The handoff
 * that ends a spent budget (#1868) is a traversal like any other.
 */
export function edgeRoundsUsed(
  pipeline: Pipeline,
  edge: { from: string; to: string; kind: PipelineEdgeKind },
): number {
  const target = pipeline.runs.find((run) => run.stageId === edge.to);
  if (!target) return 0;
  const sources = new Set<string>();
  for (const attempt of target.attempts) {
    const activation = attempt.activatedBy;
    if (attempt.historical || !activation) continue;
    if (activation.edge !== edge.kind || activation.stageId !== edge.from) continue;
    sources.add(`${activation.stageId}:${activation.attempt}`);
  }
  return sources.size;
}

/** The loop budget a stage's fail edge has already spent — the one function the
    engine's routing decision and every displayed n/max read. */
export function failEdgeRoundsUsed(pipeline: Pipeline, stage: PipelineStage): number {
  if (!stage.onFail) return 0;
  return edgeRoundsUsed(pipeline, { from: stage.id, to: stage.onFail.to, kind: "fail" });
}

/** The rounds a stage's fail edge may spend: its frozen `maxRounds` plus every
    round a `continue-review` granted it since (#1938). */
export function failEdgeMaxRounds(pipeline: Pipeline, stage: PipelineStage): number {
  if (!stage.onFail) return 0;
  const granted = (pipeline.reviewGrants ?? [])
    .filter((grant) => grant.stageId === stage.id)
    .reduce((sum, grant) => sum + grant.rounds, 0);
  return stage.onFail.maxRounds + granted;
}

export function failEdgeExhaustion(edge: PipelineFailEdge): PipelineFailEdgeExhaustion {
  return edge.onExhausted ?? "advance";
}

/** Whether this stage has already handed findings along its spent fail edge.
    Read from the stage's own attempts, so the handoff happens once per stage:
    when another stage's fail edge later loops back through this one and it
    fails again, it parks as budget exhausted. Each `continue-review` grant
    (#1938) buys one more handoff, at the end of the rounds it added. */
export function failEdgeBudgetSpent(pipeline: Pipeline, stage: PipelineStage): boolean {
  const run = pipeline.runs.find((candidate) => candidate.stageId === stage.id);
  const handoffs = run?.attempts.filter((attempt) => !attempt.historical && attempt.budgetSpent).length ?? 0;
  const grants = (pipeline.reviewGrants ?? []).filter((grant) => grant.stageId === stage.id).length;
  return handoffs > grants;
}

/** What `needs_review` names on every surface (#1938): the review stage, the
    head it last judged, the head nobody reviewed, and the verdict it gave. */
export type PipelineReviewSummary = {
  stageId: string;
  reviewedHead: string | null;
  currentHead: string;
  lastVerdict: StageVerdictStatus;
  findings: number;
};

export function pipelineReviewSummary(pipeline: Pick<Pipeline, "reviewPending" | "state" | "pausedState">): PipelineReviewSummary | null {
  const pending = pipeline.reviewPending;
  /* A lane closed out of needs_review keeps the record as history; only the
     open state names it. */
  if (!pending || (pipeline.state !== "needs_review" && pipeline.pausedState !== "needs_review")) return null;
  return {
    stageId: pending.stageId,
    reviewedHead: pending.reviewedHead,
    currentHead: pending.currentHead,
    lastVerdict: pending.verdict,
    findings: pending.findings,
  };
}

/** What a completed lane names when its last fix was never reviewed (#2187
    §3.5, #1938 kept): the review stage whose spent budget handed its findings
    on, the head that review judged, the head the lane completed on, and how
    many findings went unreviewed. */
export type PipelineCompletedUnreviewed = {
  stageId: string;
  reviewedHead: string | null;
  currentHead: string;
  findings: number;
};

/**
 * Read from the record alone: a completed lane whose review stage's latest own
 * attempt handed its findings along a spent fail edge (`budgetSpent`), and
 * whose fix of those findings passed. A reviewer that ran again after the
 * handoff (a `continue-review` grant) judged the newer head itself, so its
 * latest attempt is no handoff and the lane counts as reviewed. When several
 * review stages handed on, the one whose fix passed last is named.
 */
export function pipelineCompletedUnreviewed(pipeline: Pick<Pipeline, "state" | "stages" | "runs" | "lastPassedCommit">): PipelineCompletedUnreviewed | null {
  if (pipeline.state !== "completed") return null;
  let latest: { summary: PipelineCompletedUnreviewed; order: string } | null = null;
  for (const stage of pipeline.stages) {
    if (!stage.onFail) continue;
    const review = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.filter((attempt) => !attempt.historical).at(-1);
    if (!review?.budgetSpent) continue;
    const fix = pipeline.runs
      .find((run) => run.stageId === stage.onFail!.to)
      ?.attempts.find((attempt) => !attempt.historical
        && attempt.state === "passed"
        && attempt.activatedBy?.edge === "fail"
        && attempt.activatedBy.budgetSpent === true
        && attempt.activatedBy.stageId === stage.id
        && attempt.activatedBy.attempt === review.n);
    if (!fix) continue;
    const order = fix.completedAt ?? "";
    if (latest && latest.order > order) continue;
    latest = {
      order,
      summary: {
        stageId: stage.id,
        reviewedHead: review.reviewedHead ?? null,
        currentHead: pipeline.lastPassedCommit,
        findings: review.verdict?.findings?.length ?? 0,
      },
    };
  }
  return latest?.summary ?? null;
}
