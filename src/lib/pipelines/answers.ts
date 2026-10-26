import type { Pipeline, PipelineEdgeActivation, PipelineStageAttempt } from "./types";

export type AnswerRef =
  | { kind: "fix" | "retry"; pipelineId: string; stageId: string; attempt: number }
  | { kind: "refresh"; pipelineId: string };

function sameActivation(a: PipelineEdgeActivation | null, b: PipelineEdgeActivation | null): boolean {
  return a === b || (!!a && !!b && a.stageId === b.stageId && a.attempt === b.attempt && a.edge === b.edge
    && a.budgetSpent === b.budgetSpent && a.budgetRecheck === b.budgetRecheck);
}

/** Own retries take precedence over the fail edge they retain. Adopted helper
 * evidence never counts as the stage's own preceding attempt. */
export function attemptAnswers(pipeline: Pipeline, attempt: PipelineStageAttempt): AnswerRef | null {
  if (attempt.historical) return null;
  const run = pipeline.runs.find(run => run.attempts.includes(attempt));
  if (!run) return null;
  const previous = run.attempts.filter(candidate => !candidate.historical && candidate.n < attempt.n)
    .reduce<PipelineStageAttempt | null>((latest, candidate) => !latest || candidate.n > latest.n ? candidate : latest, null);
  if (previous && sameActivation(previous.activatedBy, attempt.activatedBy)) {
    return { kind: "retry", pipelineId: pipeline.id, stageId: run.stageId, attempt: previous.n };
  }
  const activation = attempt.activatedBy;
  return activation?.edge === "fail"
    ? { kind: "fix", pipelineId: pipeline.id, stageId: activation.stageId, attempt: activation.attempt }
    : null;
}

export function laneAnswers(pipeline: Pipeline): AnswerRef | null {
  return pipeline.refreshOf ? { kind: "refresh", pipelineId: pipeline.refreshOf.pipelineId } : null;
}

export function stageResultLine(attempt: PipelineStageAttempt | null): string | null {
  return attempt?.report?.result?.trim() || null;
}
