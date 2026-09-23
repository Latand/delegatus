import type { TFunction } from "@/lib/i18n";
import { pipelineReviewSummary } from "@/lib/pipelines/failEdgeBudget";
import type { Pipeline, PipelineStage, StageFinding } from "@/lib/pipelines/types";

import type { KanbanPipeline, KanbanStageChip } from "@/components/kanban/kanbanModel";
import { pipelineActionOptions } from "@/components/kanban/stagesModel";
import { latestAttempt, type StageChipState } from "./pipelineModel";

/*
 * What the one pipeline block (#2072 slice 3, docs/design/phone-kanban.md
 * §3.13, docs/design/desktop-flat-cards.md §4) says about a pipeline, decided
 * once for every density. Pure: no DOM and no React, so a test and each
 * surface that mounts the block read the same answers.
 */

/** The three places the block is drawn: a board card's one line, a task's
    lane row (the desktop card and the phone's task screen), and the pipeline
    screen. */
export type PipelineBlockDensity = "card" | "task" | "screen";

const NEEDS_YOU: ReadonlySet<Pipeline["state"]> = new Set(["needs_decision", "needs_review"]);
const LIVE: ReadonlySet<StageChipState> = new Set(["running", "reviewing", "committing"]);
const ENDED: ReadonlySet<Pipeline["state"]> = new Set(["completed", "closed"]);

/** A pipeline that waits on the operator: its whole block takes the warning tone. */
export const pipelineNeedsYou = (pipeline: Pick<Pipeline, "state">): boolean => NEEDS_YOU.has(pipeline.state);

export const pipelineEnded = (pipeline: Pick<Pipeline, "state">): boolean => ENDED.has(pipeline.state);

/** The mark a stage state draws. The shape carries the state, so it reads
    without colour; the colour is the stage's `STAGE_TONE`. */
export type StageMarkShape = "dot" | "check" | "cross" | "alert" | "ring";

export const STAGE_MARK: Record<StageChipState, StageMarkShape> = {
  pending: "ring",
  skipped: "ring",
  running: "dot",
  committing: "dot",
  reviewing: "dot",
  passed: "check",
  failed: "cross",
  needs_decision: "alert",
};

/** An age to the unit that matters (§3.4: "4m", "1h 5m"): seconds only under
    a minute, never minutes and seconds together. */
export function blockAgeSeconds(seconds: number): number {
  const total = Math.max(0, Math.round(seconds));
  return total >= 60 ? Math.floor(total / 60) * 60 : total;
}

/** When the lane last moved, in ms: the newest start or end of any of its
    attempts, else when it was created. The age every density prints. */
export function pipelineMovedAtMs(pipeline: Pipeline): number | null {
  let latest = 0;
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      for (const at of [attempt.startedAt, attempt.completedAt]) {
        const ms = Date.parse(at ?? "");
        if (Number.isFinite(ms) && ms > latest) latest = ms;
      }
    }
  }
  if (latest) return latest;
  const created = Date.parse(pipeline.createdAt ?? "");
  return Number.isFinite(created) ? created : null;
}

/** The title a pipeline shares with the task it sits on is not drawn twice. */
export function sameTitle(a: string, b: string | null | undefined): boolean {
  if (!b) return false;
  const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return norm(a) === norm(b);
}

/** The stage the lane stands on: the one parked on the operator, else the
    running one, else the failed one, else the first that has not passed. */
export function currentChipIndex(chips: readonly KanbanStageChip[]): number {
  const find = (test: (chip: KanbanStageChip) => boolean) => chips.findIndex(test);
  for (const index of [
    find((chip) => chip.state === "needs_decision"),
    find((chip) => LIVE.has(chip.state)),
    find((chip) => chip.state === "failed"),
    find((chip) => chip.state !== "passed" && chip.state !== "skipped"),
  ]) {
    if (index >= 0) return index;
  }
  return Math.max(0, chips.length - 1);
}

/** The chain a card draws on its one line: the pass path, plus a fail branch
    while it holds the work — that is where the lane stands. */
export function cardChain(summary: KanbanPipeline): KanbanStageChip[] {
  return summary.chips.filter((chip) => !chip.branch || chip.state === "needs_decision" || LIVE.has(chip.state));
}

export type ChainItem =
  | { kind: "stage"; chip: KanbanStageChip }
  | { kind: "passed"; n: number }
  | { kind: "more"; n: number };

/**
 * How a card's chain folds to fit one line (phone-kanban §3.13): the whole
 * chain; the passed stages before the current one as "✓n"; the current stage,
 * the next and "+m"; the current stage and "+m"; the current stage alone with
 * what comes before and after it counted. The card tries them in order until
 * one fits, and the current stage is in every one of them.
 */
export function cardChainLevels(chips: readonly KanbanStageChip[]): ChainItem[][] {
  if (!chips.length) return [[]];
  const current = currentChipIndex(chips);
  const stage = (chip: KanbanStageChip): ChainItem => ({ kind: "stage", chip });
  const before = chips.slice(0, current);
  const foldable = before.length > 0 && before.every((chip) => chip.state === "passed" || chip.state === "skipped");
  const lead: ChainItem[] = foldable ? [{ kind: "passed", n: before.length }] : before.map(stage);
  const levels: ChainItem[][] = [chips.map(stage)];
  if (foldable) levels.push([...lead, ...chips.slice(current).map(stage)]);
  const afterNext = chips.length - current - 2;
  if (afterNext > 0) levels.push([...lead, stage(chips[current]!), stage(chips[current + 1]!), { kind: "more", n: afterNext }]);
  const after = chips.length - current - 1;
  if (after > 0) levels.push([...lead, stage(chips[current]!), { kind: "more", n: after }]);
  /* The narrowest: the current stage alone between what comes before it and
     what comes after, each as one count — "+2 → (!) Diagnose" on a lane that
     stopped on a fail branch. */
  const last: ChainItem[] = [
    ...(foldable ? lead : before.length ? [{ kind: "more", n: before.length } as ChainItem] : []),
    stage(chips[current]!),
    ...(after > 0 ? [{ kind: "more", n: after } as ChainItem] : []),
  ];
  if (chips.length > 1) levels.push(last);
  const key = (level: ChainItem[]) => level.map((item) => (item.kind === "stage" ? item.chip.stage.id : `${item.kind}${item.n}`)).join(",");
  return levels.filter((level, index) => index === 0 || key(level) !== key(levels[index - 1]!));
}

/** A finding list as the stage reported it: ranked when it was, else the
    plain strings with no rank. */
export function stageFindings(pipeline: Pipeline, stageId: string): StageFinding[] {
  const attempt = latestAttempt(pipeline, stageId);
  return attempt?.report?.verdict.rankedFindings
    ?? attempt?.verdict?.rankedFindings
    ?? (attempt?.report?.verdict.findings ?? attempt?.verdict?.findings ?? []).map((text) => ({ severity: null, text }));
}

/** An answer the block gives in place, through the board's pipeline actions. */
export type PipelineAnswerAction = "skip-stage" | "retry-stage" | "close" | "continue-review";

export interface PipelineAnswer {
  action: PipelineAnswerAction;
  /** Skip and retry: the stage the pipeline waits on, as the block showed it. */
  stageId: string | null;
  stageName: string | null;
  /** Skip and retry: the `n` of that stage's latest own attempt, `0` for none. */
  expectedAttempt: number | null;
}

export interface PipelineAnswers {
  kind: "decision" | "review";
  /** The stage the answer is about: the parked stage, or the review stage. */
  stage: PipelineStage | null;
  /** The quiet answer first, then the primary one. */
  choices: [PipelineAnswer, PipelineAnswer];
}

/**
 * What a lane that needs the operator can be answered with, from the same
 * options the board's ⋯ menu reads: a decision is skipped or retried on the
 * stage the pipeline waits on, and a spent review budget (#1938) is closed or
 * given one more round.
 */
export function pipelineAnswers(pipeline: Pipeline, nameOf: (stage: PipelineStage) => string): PipelineAnswers | null {
  if (pipeline.state === "needs_decision") {
    const retry = pipelineActionOptions(pipeline).find((option) => option.action === "retry-stage");
    if (!retry || retry.refusal || !retry.stageId) return null;
    const stage = pipeline.stages.find((entry) => entry.id === retry.stageId) ?? null;
    const stageName = stage ? nameOf(stage) : retry.stageId;
    const base = { stageId: retry.stageId, stageName, expectedAttempt: retry.attempt };
    return { kind: "decision", stage, choices: [{ action: "skip-stage", ...base }, { action: "retry-stage", ...base }] };
  }
  if (pipeline.state === "needs_review") {
    const review = pipelineReviewSummary(pipeline);
    const stage = review ? pipeline.stages.find((entry) => entry.id === review.stageId) ?? null : null;
    const none = { stageId: null, stageName: null, expectedAttempt: null };
    return { kind: "review", stage, choices: [{ action: "close", ...none }, { action: "continue-review", ...none }] };
  }
  return null;
}

/** The stage a lane that needs the operator stands on: the one its answer is about. */
export function parkedStage(pipeline: Pipeline): PipelineStage | null {
  if (pipeline.state === "needs_decision") {
    const id = pipeline.cursor?.stageId ?? null;
    return id ? pipeline.stages.find((stage) => stage.id === id) ?? null : null;
  }
  if (pipeline.state === "needs_review") {
    const review = pipelineReviewSummary(pipeline);
    return review ? pipeline.stages.find((stage) => stage.id === review.stageId) ?? null : null;
  }
  return null;
}

/**
 * The card's reason line for a lane that needs the operator, in warning ink:
 * "Implement failed · 1 finding" for a decision, "head 9b2e7d4c unreviewed ·
 * no rounds left" for a spent review budget. The caller adds the age.
 */
export function pipelineReason(t: TFunction, pipeline: Pipeline, nameOf: (stage: PipelineStage) => string): string | null {
  if (pipeline.state === "needs_review") {
    const review = pipelineReviewSummary(pipeline);
    if (!review) return null;
    const current = review.currentHead ? review.currentHead.slice(0, 8) : t("pipelineReview.unknownHead");
    return t("pipelineBlock.reason.review", { current });
  }
  if (pipeline.state !== "needs_decision") return null;
  const stage = parkedStage(pipeline);
  if (!stage) return null;
  const attempt = latestAttempt(pipeline, stage.id);
  const failed = attempt?.state === "failed" || attempt?.verdict?.status === "fail" || attempt?.report?.verdict.status === "fail";
  const findings = stageFindings(pipeline, stage.id).length;
  return [
    t(failed ? "pipelineBlock.reason.failed" : "pipelineBlock.reason.parked", { stage: nameOf(stage) }),
    findings ? t("pipelineVerdict.findings", { count: findings }) : null,
  ].filter(Boolean).join(" · ");
}
