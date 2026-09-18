import type { Pipeline, PipelineEdgeKind, PipelineStage } from "./types";

/**
 * How many times an edge has been traversed, derived (never stored) from the
 * durable activation records the target's attempts carry.
 *
 * A round is one traversal, so what is counted is the distinct source attempts
 * that activated the target — `activatedBy.stageId` plus `activatedBy.attempt`
 * — never the target's own attempts. A retry of the target (a spawn failure, a
 * provider throttle, a cut turn) is a fresh attempt carrying the same
 * activation, and it spends no round (#1754). Lineage-adopted evidence
 * (`historical`) is not the stage's own work and never counts.
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
