import type { Pipeline, PipelineEdgeKind, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import { latestAttempt, stageFailEdgeRoundsUsed, type StageChipState } from "@/components/pipelines/pipelineModel";

import { graphOrder, operationalAttempts, type StageView } from "./pipelineGraph";

/**
 * The Stages sheet's pure half (#1695 K5b): which stage the sheet opens on,
 * which stages are finished, what each pane says about its stage, and which
 * pipeline actions the engine would accept right now. It reads the same record
 * and the same attempt rule the card graph does: a stage's attempts are its own
 * (`operationalAttempts`), never lineage-adopted helpers.
 */

const LIVE_STATES: ReadonlySet<StageChipState> = new Set(["running", "reviewing", "committing", "needs_decision"]);

/** The stage the sheet opens on: the one running or waiting on a decision, else
    the last one that started, else the first. */
export function currentStageId(pipeline: Pipeline, views: ReadonlyMap<string, StageView>): string | null {
  const order = graphOrder(pipeline);
  const live = order.find((stage) => LIVE_STATES.has(views.get(stage.id)?.state ?? "pending"));
  if (live) return live.id;
  const started = [...order].reverse().find((stage) => latestAttempt(pipeline, stage.id));
  return (started ?? order[0])?.id ?? null;
}

/** Stages "Collapse finished" folds: passed or skipped, or waiting again after passing. */
export function finishedStageIds(pipeline: Pipeline, views: ReadonlyMap<string, StageView>): string[] {
  return pipeline.stages.filter((stage) => {
    const view = views.get(stage.id);
    return view && (view.state === "passed" || view.state === "skipped" || (view.again && view.previous === "passed"));
  }).map((stage) => stage.id);
}

/** The attempt a pane shows: the one the operator picked, else the stage's latest own attempt. */
export function shownAttempt(pipeline: Pipeline, stageId: string, chosen: number | null): PipelineStageAttempt | null {
  const own = operationalAttempts(pipeline, stageId);
  return (chosen !== null ? own.find((attempt) => attempt.n === chosen) : undefined) ?? own.at(-1) ?? null;
}

export interface PaneFacts {
  /** The stage and edge that activated the shown attempt. */
  startedBy: { stageId: string; edge: PipelineEdgeKind } | null;
  /** For a stage with no attempt: the stage whose pass starts it. */
  runsAfter: string | null;
  /** For the latest attempt of a stage an upstream stage ran again after: what it last was. */
  nextAttempt: StageChipState | null;
  /** The stage's fail edge and the engine's spent budget. */
  onFail: { to: string; fired: number; max: number } | null;
}

export function paneFacts(pipeline: Pipeline, stage: PipelineStage, shown: PipelineStageAttempt | null, view: StageView | undefined): PaneFacts {
  const latest = latestAttempt(pipeline, stage.id);
  return {
    startedBy: shown?.activatedBy ? { stageId: shown.activatedBy.stageId, edge: shown.activatedBy.edge } : null,
    runsAfter: shown ? null : pipeline.stages.find((candidate) => candidate.next === stage.id)?.id ?? null,
    nextAttempt: view?.again && shown === latest ? view.previous : null,
    onFail: stage.onFail ? { to: stage.onFail.to, fired: stageFailEdgeRoundsUsed(pipeline, stage), max: stage.onFail.maxRounds } : null,
  };
}

/** What a waiting stage's first message will follow: the stage whose pass
    starts it, the stage after it, and where a failure sends the run. */
export function draftFacts(pipeline: Pipeline, stage: PipelineStage): { after: string | null; then: string | null; onFail: { to: string; max: number } | null } {
  return {
    after: pipeline.stages.find((candidate) => candidate.next === stage.id)?.id ?? null,
    then: stage.next,
    onFail: stage.onFail ? { to: stage.onFail.to, max: stage.onFail.maxRounds } : null,
  };
}

/** The stage's position in the record, which `buildStagePrompt` uses for its default wiring. */
export function stageWiringIndex(pipeline: Pipeline, stageId: string): number {
  return Math.max(0, pipeline.stages.findIndex((stage) => stage.id === stageId));
}

/** A stage the operator can still edit: it has never started (the engine's "already started" rule). */
export function stageNotStarted(pipeline: Pipeline, stageId: string): boolean {
  return (pipeline.runs.find((run) => run.stageId === stageId)?.attempts.length ?? 0) === 0;
}

export type PipelineActionKind = "pause" | "resume" | "retry-stage" | "skip-stage" | "close";

export interface PipelineActionOption {
  action: PipelineActionKind;
  /** Why the engine would refuse it now, or null when it would accept it. */
  refusal: "draft" | "ended" | "no-decision" | "other-stage" | null;
  /** The stage retry and skip act on: the one the pipeline waits on. */
  stageId: string | null;
}

/**
 * The actions the pipeline menu offers, each with the refusal the engine's
 * own preconditions would give (`patchPipeline`): a draft is only started or
 * edited elsewhere, an ended pipeline takes nothing, pause and resume swap,
 * and retry and skip apply to the stage a `needs_decision` pipeline waits on.
 */
export function pipelineActionOptions(pipeline: Pipeline): PipelineActionOption[] {
  const ended = pipeline.state === "completed" || pipeline.state === "closed";
  const draft = pipeline.state === "draft";
  const general = draft ? "draft" : ended ? "ended" : null;
  const decisionStage = pipeline.state === "needs_decision" ? pipeline.cursor?.stageId ?? null : null;
  return [
    pipeline.state === "paused"
      ? { action: "resume", refusal: null, stageId: null }
      : { action: "pause", refusal: general, stageId: null },
    { action: "retry-stage", refusal: general ?? (decisionStage ? null : "no-decision"), stageId: decisionStage },
    { action: "skip-stage", refusal: general ?? (decisionStage ? null : "no-decision"), stageId: decisionStage },
    { action: "close", refusal: general, stageId: null },
  ];
}
