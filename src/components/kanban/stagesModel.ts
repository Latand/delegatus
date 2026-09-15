import type { Pipeline, PipelineEdgeKind, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import { latestAttempt, stageFailEdgeRoundsUsed, stagePromptExtra, type StageChipState } from "@/components/pipelines/pipelineModel";

import { graphOrder, operationalAttempts, type StageView } from "./pipelineGraph";

/**
 * The Stages sheet's pure half (#1695 K5b): which stage the sheet opens on,
 * which stages are finished, what each pane says about its stage, and which
 * pipeline actions the engine would accept right now. It reads the same record
 * and the same attempt rule the card graph does: a stage's attempts are its own
 * (`operationalAttempts`), never lineage-adopted helpers.
 */

const LIVE_STATES: ReadonlySet<StageChipState> = new Set(["running", "reviewing", "committing", "needs_decision"]);

export function pipelineEnded(pipeline: Pick<Pipeline, "state">): boolean {
  return pipeline.state === "completed" || pipeline.state === "closed";
}

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

/** A stage whose first message can still be opened and edited: no attempt yet, on a pipeline still going. */
export function stageDraftable(pipeline: Pipeline, stageId: string): boolean {
  return !pipelineEnded(pipeline) && stageNotStarted(pipeline, stageId);
}

/** An attempt the engine recorded and never launched: no start, no launch, no conversation. */
export function neverLaunched(attempt: PipelineStageAttempt): boolean {
  return !attempt.startedAt && !attempt.launchId && !attempt.conversationId && !attempt.agentPath;
}

/**
 * What became of an operator's edit of a stage's first message, judged from
 * the stage as a record shows it. An attempt freezes the stage's prompt (the
 * engine refuses `override-stage` from then on), so a stage that has one
 * holds exactly the words its first turn got:
 *   - `waiting`: no attempt, the pipeline still going; the edit stands.
 *   - `untouched`: the edit's words are the ones it began from; nothing to deliver.
 *   - `included`: the stage holds the edit's words.
 *   - `ended-before-start`: the pipeline ended before the stage ever launched.
 *   - `undelivered`: the stage started with other words.
 */
export type DraftOutcome = "waiting" | "untouched" | "included" | "ended-before-start" | "undelivered";

export function draftOutcome(pipeline: Pipeline, stageId: string, draft: { text: string; base: string }): DraftOutcome {
  const stage = pipeline.stages.find((entry) => entry.id === stageId);
  const attempts = pipeline.runs.find((run) => run.stageId === stageId)?.attempts ?? [];
  const text = stagePromptExtra(draft.text);
  if (text === stagePromptExtra(draft.base)) return attempts.length || pipelineEnded(pipeline) ? "untouched" : "waiting";
  if (!attempts.length) return pipelineEnded(pipeline) ? "ended-before-start" : "waiting";
  if (stage && stagePromptExtra(stage.prompt) === text) return "included";
  if (pipelineEnded(pipeline) && attempts.every(neverLaunched)) return "ended-before-start";
  return "undelivered";
}

export type PipelineActionKind = "pause" | "resume" | "retry-stage" | "skip-stage" | "close";

export interface PipelineActionOption {
  action: PipelineActionKind;
  /** Why the engine would refuse it now, or null when it would accept it. */
  refusal: "draft" | "ended" | "no-decision" | "other-stage" | null;
  /** The stage retry and skip act on: the one the pipeline waits on. */
  stageId: string | null;
  /** The `n` of that stage's latest own attempt, which retry and skip expect. */
  attempt: number | null;
}

/**
 * The actions the pipeline menu offers, each with the refusal the engine's
 * own preconditions would give (`patchPipeline`): a draft is only started or
 * edited elsewhere, an ended pipeline takes nothing, pause and resume swap,
 * and retry and skip apply to the stage a `needs_decision` pipeline waits on.
 */
export function pipelineActionOptions(pipeline: Pipeline): PipelineActionOption[] {
  const ended = pipelineEnded(pipeline);
  const draft = pipeline.state === "draft";
  const general = draft ? "draft" : ended ? "ended" : null;
  const decisionStage = pipeline.state === "needs_decision" ? pipeline.cursor?.stageId ?? null : null;
  const attempt = decisionStage ? latestAttempt(pipeline, decisionStage)?.n ?? null : null;
  return [
    pipeline.state === "paused"
      ? { action: "resume", refusal: null, stageId: null, attempt: null }
      : { action: "pause", refusal: general, stageId: null, attempt: null },
    { action: "retry-stage", refusal: general ?? (decisionStage ? null : "no-decision"), stageId: decisionStage, attempt },
    { action: "skip-stage", refusal: general ?? (decisionStage ? null : "no-decision"), stageId: decisionStage, attempt },
    { action: "close", refusal: general, stageId: null, attempt: null },
  ];
}

/**
 * Whether a pipeline read shows the state an action leads to, for an action
 * whose answer never arrived. It says what the pipeline is now, never that
 * this page's request did it: another client may have acted, and a request
 * still on its way may act later.
 */
export function actionObserved(action: PipelineActionKind, stageId: string | null, now: Pipeline): boolean {
  if (action === "pause") return now.state === "paused";
  if (action === "resume") return now.state !== "paused" && !pipelineEnded(now);
  if (action === "close") return now.state === "closed";
  return now.state !== "needs_decision" || now.cursor?.stageId !== stageId;
}
