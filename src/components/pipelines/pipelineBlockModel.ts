import type { TFunction } from "@/lib/i18n";
import { failEdgeBudgetSpent, failEdgeExhaustion, failEdgeRoundsUsed, pipelineReviewSummary } from "@/lib/pipelines/failEdgeBudget";
import type { Pipeline, PipelineStage, StageFinding } from "@/lib/pipelines/types";

import type { KanbanPipeline, KanbanStageChip } from "@/components/kanban/kanbanModel";
import { pipelineActionOptions } from "@/components/kanban/stagesModel";
import { latestAttempt, stageAccess, type StageChipState } from "./pipelineModel";

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
 * the next and "+m"; the current stage and "+m"; the current stage with what
 * comes before and after it counted; the current stage alone. The card tries
 * them in order until one fits, and the current stage is in every one of them.
 * A chain of more than one stage always ends on the current stage alone, which
 * the card draws only once the chain has a line of its own.
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
  /* The current stage between what comes before it and what comes after, each
     as one count — "+2 → (!) Diagnose" on a lane that stopped on a fail branch. */
  const counted: ChainItem[] = [
    ...(foldable ? lead : before.length ? [{ kind: "more", n: before.length } as ChainItem] : []),
    stage(chips[current]!),
    ...(after > 0 ? [{ kind: "more", n: after } as ChainItem] : []),
  ];
  if (chips.length > 1) levels.push(counted);
  const key = (level: ChainItem[]) => level.map((item) => (item.kind === "stage" ? item.chip.stage.id : `${item.kind}${item.n}`)).join(",");
  const folds = levels.filter((level, index) => index === 0 || key(level) !== key(levels[index - 1]!));
  /* The narrowest: the current stage alone, for a name too long to share its
     line with even the counts. Every level before it holds two items or more. */
  return chips.length > 1 ? [...folds, [stage(chips[current]!)]] : folds;
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
export type PipelineAnswerAction = "skip-stage" | "retry-stage" | "close" | "continue-review" | "accept-head";

export interface PipelineAnswer {
  action: PipelineAnswerAction;
  /** Skip and retry: the stage the pipeline waits on, as the block showed it. */
  stageId: string | null;
  stageName: string | null;
  /** Skip and retry: the `n` of that stage's latest own attempt, `0` for none. */
  expectedAttempt: number | null;
}

/**
 * Why a lane stopped on a review (#2187 §3.4), one of the table's four rows:
 * - `stop-after-fix`: needs_review, the last fix landed and the pipeline asked
 *   to wait before anyone reviews it;
 * - `park`: a read-only reviewer's spent fail edge that stops before the fix;
 * - `once`: a reviewer that already handed its last findings on and failed
 *   again after another edge looped back through it;
 * - `legacy`: an older `review-loop` flow that ended at its round limit.
 * Any other stop is no review stop, and keeps Skip and Retry on the stage.
 */
export type ReviewStopKind = "stop-after-fix" | "park" | "once" | "legacy";

export interface ReviewStop {
  kind: ReviewStopKind;
  stage: PipelineStage;
  /** `park`: how many review rounds ran, the last of them failed. */
  rounds: number;
  /** `legacy`: the flow's own state detail stored as the first finding, which
      the reason line now says in words, so the list skips it. */
  hiddenFinding: string | null;
}

/** What a legacy review flow stores as its first finding when it ends at its
    round limit (`flows/engine.ts` `markNeedsDecision`). */
const LEGACY_ROUND_LIMIT = /^(flow review )?round limit reached$/;
/** The engine's park detail for a spent fail edge (`routeFailedAttempt`). */
const BUDGET_EXHAUSTED = "fail-edge budget exhausted";

export function reviewStop(pipeline: Pipeline): ReviewStop | null {
  if (pipeline.state === "needs_review") {
    const review = pipelineReviewSummary(pipeline);
    const stage = review ? pipeline.stages.find((entry) => entry.id === review.stageId) ?? null : null;
    return stage ? { kind: "stop-after-fix", stage, rounds: 0, hiddenFinding: null } : null;
  }
  if (pipeline.state !== "needs_decision") return null;
  const stage = parkedStage(pipeline);
  if (!stage) return null;
  const attempt = latestAttempt(pipeline, stage.id);
  const detail = [pipeline.stateDetail, attempt?.error].filter((text): text is string => Boolean(text));
  if (stage.kind === "review-loop") {
    const first = stageFindings(pipeline, stage.id)[0]?.text.trim() ?? "";
    const hidden = LEGACY_ROUND_LIMIT.test(first) ? first : null;
    if (!hidden && !detail.some((text) => /round limit reached/.test(text))) return null;
    return { kind: "legacy", stage, rounds: 0, hiddenFinding: hidden };
  }
  if (stage.kind !== "run" || !stage.onFail || stageAccess(pipeline, stage) !== "read-only") return null;
  if (!detail.some((text) => text.startsWith(BUDGET_EXHAUSTED))) return null;
  if (failEdgeExhaustion(stage.onFail) === "park") return { kind: "park", stage, rounds: failEdgeRoundsUsed(pipeline, stage) + 1, hiddenFinding: null };
  /* Under the other modes a spent edge parks only once the stage has handed
     its last findings on; a failure with no verdict to hand on parks without
     a fix round, and says so in today's words. */
  return failEdgeBudgetSpent(pipeline, stage) ? { kind: "once", stage, rounds: 0, hiddenFinding: null } : null;
}

/** The findings a stop's answer lists: the stage's own, less the one its
    reason line already says. */
export function reviewStopFindings(pipeline: Pipeline, stop: ReviewStop): StageFinding[] {
  const findings = stageFindings(pipeline, stop.stage.id);
  return stop.hiddenFinding !== null && findings[0]?.text.trim() === stop.hiddenFinding ? findings.slice(1) : findings;
}

export interface PipelineAnswers {
  kind: "decision" | "review";
  /** The stage the answer is about: the parked stage, or the review stage. */
  stage: PipelineStage | null;
  /** The quiet answer first, then the primary one. */
  choices: [PipelineAnswer, PipelineAnswer];
  /** A stop on a review (§3.4): its reason line and its plain labels. */
  stop: ReviewStop | null;
}

/**
 * What a lane that needs the operator can be answered with, from the same
 * options the board's ⋯ menu reads: a decision is skipped or retried on the
 * stage the pipeline waits on, and a lane that stopped after its last fix
 * (#1938, #2187) is accepted as is or reviewed again. Close stays in the ⋯.
 */
export function pipelineAnswers(pipeline: Pipeline, nameOf: (stage: PipelineStage) => string): PipelineAnswers | null {
  if (pipeline.state === "needs_decision") {
    const retry = pipelineActionOptions(pipeline).find((option) => option.action === "retry-stage");
    if (!retry || retry.refusal || !retry.stageId) return null;
    const stage = pipeline.stages.find((entry) => entry.id === retry.stageId) ?? null;
    const stageName = stage ? nameOf(stage) : retry.stageId;
    const base = { stageId: retry.stageId, stageName, expectedAttempt: retry.attempt };
    return { kind: "decision", stage, choices: [{ action: "skip-stage", ...base }, { action: "retry-stage", ...base }], stop: reviewStop(pipeline) };
  }
  if (pipeline.state === "needs_review") {
    const stop = reviewStop(pipeline);
    const none = { stageId: null, stageName: null, expectedAttempt: null };
    return { kind: "review", stage: stop?.stage ?? null, choices: [{ action: "accept-head", ...none }, { action: "continue-review", ...none }], stop };
  }
  return null;
}

/** The words on an answer's button. A review stop says what each one does in
    plain words, on the desktop and the phone alike (§3.4); any other decision
    keeps "Skip {stage}" / "Retry {stage}", or the phone's shorter words. */
export function answerLabel(t: TFunction, answers: PipelineAnswers, answer: PipelineAnswer, large: boolean): string {
  if (answer.action === "accept-head") return t("pipelineBlock.answer.acceptAsIs");
  if (answer.action === "continue-review") return t("pipelineBlock.answer.reviewAgain");
  if (answers.stop && answer.action === "skip-stage") return t("pipelineBlock.answer.acceptWithoutReview");
  if (answers.stop && answer.action === "retry-stage") return t("pipelineBlock.answer.reviewAgain");
  if (large) return t(answer.action === "skip-stage" ? "mobile2.pipeline.skip" : answer.action === "retry-stage" ? "mobile2.pipeline.retry" : "mobile2.pipeline.archive");
  return t(`kanban.pipelineAct.label.${answer.action}`, { stage: answer.stageName ?? "" });
}

/** The one line on why a lane stopped on a review, in warning ink (§3.4). */
export function reviewStopReason(t: TFunction, stop: ReviewStop, nameOf: (stage: PipelineStage) => string): string {
  if (stop.kind === "stop-after-fix") return t("pipelineBlock.stop.afterFix");
  if (stop.kind === "park") return t("pipelineBlock.stop.park", { count: stop.rounds });
  if (stop.kind === "once") return t("pipelineBlock.stop.once", { stage: nameOf(stop.stage) });
  return t("pipelineBlock.stop.legacy");
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

/** The stage the pipeline screen expands (§3.13): the one the lane waits on
    the operator for, else the one it stands on. A finished lane has none. */
export function screenCurrentStageId(summary: KanbanPipeline): string | null {
  const { pipeline, chips } = summary;
  if (pipelineEnded(pipeline)) return null;
  return parkedStage(pipeline)?.id ?? chips[currentChipIndex(chips)]?.stage.id ?? null;
}

/**
 * The card's reason line for a lane that needs the operator, in warning ink:
 * a stop on a review says why in one sentence (§3.4), any other decision
 * "Implement failed · 1 finding". The caller adds the age.
 */
export function pipelineReason(t: TFunction, pipeline: Pipeline, nameOf: (stage: PipelineStage) => string): string | null {
  const stop = reviewStop(pipeline);
  if (stop) return reviewStopReason(t, stop, nameOf);
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
