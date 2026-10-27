import type { Flow } from "@/lib/flows/types";
import { failEdgeRoundsUsed as stageFailEdgeRoundsUsed } from "@/lib/pipelines/failEdgeBudget";
import { latestAttempt, stageAttempts, stageChipState, type StageChipState } from "@/lib/pipelines/stageChip";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import { stageViews, type StageView, type WorkingConversations } from "./pipelineGraph";

/* The pipeline's chain as a card draws it: ordered stage chips and the fail
   loops between them. The module holds no React, so the lane feed a linked
   install publishes encodes from the same summary the boards draw. */

export interface KanbanStageChip {
  stage: PipelineStage;
  state: StageChipState;
  /** Review rounds recorded for a review-loop stage. */
  rounds: number;
  /** Off the pass path: reached only through a fail edge. */
  branch: boolean;
  /** The stage settled and its conversation is working again (#1744). */
  rework: boolean;
}

export interface KanbanLoop {
  from: PipelineStage;
  to: PipelineStage;
  /** Times the fail edge fired, counted from attempt provenance. */
  fired: number;
  max: number;
}

export interface KanbanPipeline {
  pipeline: Pipeline;
  /** Each stage as the graph draws it (#1695 K5a), by stage id. */
  views: Map<string, StageView>;
  chips: KanbanStageChip[];
  loops: KanbanLoop[];
  /** Stages with no attempt yet. */
  waiting: number;
}

function stageIndex(pipeline: Pipeline): Map<string, PipelineStage> {
  return new Map(pipeline.stages.map((stage) => [stage.id, stage] as const));
}

/** Stage ids along the pass path from the first stage, in order. */
function passPath(pipeline: Pipeline): string[] {
  const byId = stageIndex(pipeline);
  const targets = new Set(pipeline.stages.flatMap((stage) => (stage.next ? [stage.next] : [])));
  const failTargets = new Set(pipeline.stages.flatMap((stage) => (stage.onFail?.to ? [stage.onFail.to] : [])));
  const start = pipeline.stages.find((stage) => !targets.has(stage.id) && !failTargets.has(stage.id))
    ?? pipeline.stages.find((stage) => !targets.has(stage.id))
    ?? pipeline.stages[0];
  const path: string[] = [];
  const seen = new Set<string>();
  let current: PipelineStage | null = start ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current.id);
    current = current.next ? byId.get(current.next) ?? null : null;
  }
  return path;
}

/** `working`: the transcript paths and conversation ids whose board row is
    working, so a settled stage whose conversation took more work reads so
    (#1744). A surface without the files passes nothing. */
export function summarizePipeline(pipeline: Pipeline, flowsById: ReadonlyMap<string, Flow> = new Map(), working?: WorkingConversations): KanbanPipeline {
  const byId = stageIndex(pipeline);
  const views = stageViews(pipeline, flowsById, working);
  const main = passPath(pipeline);
  const onMain = new Set(main);
  /* Stages reached only through a fail edge are branches; any other stage the
     pass walk did not visit still belongs to the chain, in declared order. */
  const failOnly = new Set(
    pipeline.stages.filter((stage) => !onMain.has(stage.id)
      && pipeline.stages.some((source) => source.onFail?.to === stage.id)
      && !pipeline.stages.some((source) => source.next === stage.id)).map((stage) => stage.id),
  );
  const ordered = [
    ...main,
    ...pipeline.stages.filter((stage) => !onMain.has(stage.id) && !failOnly.has(stage.id)).map((stage) => stage.id),
    ...pipeline.stages.filter((stage) => failOnly.has(stage.id)).map((stage) => stage.id),
  ];
  const chips = ordered.map((id) => {
    const stage = byId.get(id)!;
    /* The embedded review flow's own round count, as the flow projection
       records it on the attempt; a stage with no review flow has none. */
    const rounds = stage.kind === "review-loop"
      ? stageAttempts(pipeline, stage.id).reduce((count, attempt) => count + (attempt.historical ? 0 : attempt.reviewFlowSync?.roundCount ?? 0), 0)
      : 0;
    const view = views.get(id);
    return { stage, state: view?.state ?? stageChipState(pipeline, stage), rounds, branch: failOnly.has(id), rework: view?.rework ?? false };
  });
  const loops: KanbanLoop[] = [];
  for (const stage of pipeline.stages) {
    const edge = stage.onFail;
    if (!edge?.to) continue;
    const to = byId.get(edge.to);
    if (!to) continue;
    /* The engine's spent budget: the target's own attempts this fail edge activated. */
    const fired = stageFailEdgeRoundsUsed(pipeline, stage);
    loops.push({ from: stage, to, fired, max: edge.maxRounds });
  }
  const waiting = pipeline.stages.filter((stage) => latestAttempt(pipeline, stage.id) === null).length;
  return { pipeline, views, chips, loops, waiting };
}
