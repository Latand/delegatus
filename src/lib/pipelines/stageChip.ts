import type { Pipeline, PipelineAttemptState, PipelineStage, PipelineStageAttempt, PipelineState } from "./types";
import { latestOperationalStageAttempt } from "./attemptSelection";

/* The stage chip state and the attempt reads under it. They hold no React and
   no browser state, so the server can encode a lane from them (the lane feed a
   linked install publishes); pipelineModel re-exports them for the surfaces. */

export const PIPELINE_BUSY_STATES: ReadonlySet<PipelineState> = new Set(["provisioning", "running"]);

/**
 * Is the pipeline actively working its cursor stage? Pausing a running pipeline
 * flips `state` to `paused` but preserves the busy state in `pausedState`; the
 * cursor stage must keep its active tone (only the pulse/chevron animation
 * freezes, which callers handle). Reading `state` alone would demote a paused
 * live stage to `pending`/`dim`.
 */
export function pipelineCursorActive(pipeline: Pipeline): boolean {
  if (PIPELINE_BUSY_STATES.has(pipeline.state)) return true;
  return pipeline.state === "paused" && pipeline.pausedState !== null && PIPELINE_BUSY_STATES.has(pipeline.pausedState);
}

/* ── Stage chip state matrix (§3 of the #93 design) ─────────────────────── */

export type StageChipState =
  | "pending"
  | "running"
  | "reviewing"
  | "committing"
  | "passed"
  | "failed"
  | "needs_decision"
  | "skipped";

export function latestAttempt(pipeline: Pipeline, stageId: string): PipelineStageAttempt | null {
  return latestOperationalStageAttempt(pipeline, stageId);
}

export function stageAttempts(pipeline: Pipeline, stageId: string): PipelineStageAttempt[] {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts ?? [];
}

/**
 * Resolves a stage's chip state from its latest attempt and the pipeline cursor,
 * following the state matrix: a terminal attempt state wins; otherwise a stage
 * under an active cursor shows running/reviewing/committing; everything else is
 * pending.
 */
export function stageChipState(pipeline: Pipeline, stage: PipelineStage): StageChipState {
  /* A lane stopped after its last fix (#1938, #2187 §3.4) waits on its review
     stage: that stage takes the mark and the ink a decision's stage takes. */
  if ((pipeline.state === "needs_review" || pipeline.pausedState === "needs_review") && pipeline.reviewPending?.stageId === stage.id) return "needs_decision";
  const attempt = latestAttempt(pipeline, stage.id);
  if (attempt) {
    if (attempt.state === "passed") return "passed";
    if (attempt.state === "skipped") return "skipped";
    if (attempt.state === "failed") return "failed";
    /* A needs_decision whose findings the engine routed along the fail edge
       (#1785) is settled and the lane moved on, so it must not read as the one
       thing the needs chip means — that the operator is holding the pipeline up.
       It is the loop source it became: the failed chip, which the progress line
       ranks below live work and `stageViews` folds to pending-again once the fix
       stage re-runs. A parked needs_decision carries no such mark and keeps the
       chip, the progress line and the sheet focus it has today. */
    if (attempt.state === "needs_decision") return attempt.decisionRequested ? "failed" : "needs_decision";
  }
  const onCursor = pipeline.cursor?.stageId === stage.id;
  if (onCursor && pipelineCursorActive(pipeline)) {
    if (pipeline.cursor?.state === "committing" || attempt?.state === "committing") return "committing";
    if (stage.kind === "review-loop" || pipeline.cursor?.state === "reviewing" || attempt?.state === "reviewing") return "reviewing";
    return "running";
  }
  return "pending";
}

/** Attempt states that are still in flight — the engine created the attempt and it
    has not yet settled on a verdict. These are exactly the states an attempt passes
    through while its surface travels from a bare cursor to a placed board rect
    (pending → spawning → running/reviewing/committing). A settled attempt
    (passed/failed/skipped/needs_decision) is terminal evidence, folded into compact
    navigable history rather than a live placeholder. */
export const LIVE_ATTEMPT_STATES: ReadonlySet<PipelineAttemptState> = new Set([
  "pending", "spawning", "running", "reviewing", "committing",
]);
