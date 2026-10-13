import type { TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { answerLabel, pipelineAnswers, type PipelineAnswer } from "@/components/pipelines/pipelineBlockModel";

import type { CardOwner } from "./cardState";

/*
 * A lane's manual answers, for every menu that offers them
 * (docs/design/calm-task-cards-build.md §4): the card's ⋯ lane group, the ⋯
 * on the stop's chronology entry, the phone's lane sheet and the pipeline
 * screen's sheet. The answers left the card's face; the orchestrator gives
 * them by itself where it owns the lane, so there each one says it is a
 * manual override.
 */

export interface LaneAnswerItem extends PipelineAnswer {
  label: string;
  /** «Manual: the orchestrator does this itself» on a lane the seat owns. */
  why: string | null;
}

/** Every answer `pipelineAnswers` gives the lane, in its button's words, the quiet one first. */
export function laneAnswerItems(t: TFunction, pipeline: Pipeline, owner: CardOwner | null, nameOf: (stage: PipelineStage) => string): LaneAnswerItem[] {
  const answers = pipelineAnswers(pipeline, nameOf);
  if (!answers) return [];
  const why = owner === "seat" ? t("cardState.manualHint") : null;
  return answers.choices.map((answer) => ({ ...answer, label: answerLabel(t, answers, answer, false), why }));
}

/** Skip and Close are the two acts the engine cannot take back: the board holds them for their receipt. */
export const heldAnswer = (answer: Pick<PipelineAnswer, "action">): boolean => answer.action === "skip-stage" || answer.action === "close";

/**
 * Skip and Retry on a lane the orchestrator owns ride the lane's stop entry in
 * the task's timeline as quiet links (the form decision on the calm cards,
 * variant 2); they are not repeated in the ⋯. A lane the operator owns keeps
 * every answer in the menu, and accept-head, retry-merge and leave-PR-open stay
 * in the card's ⋯ on either.
 */
const isStopLink = (answer: Pick<PipelineAnswer, "action">): boolean => answer.action === "skip-stage" || answer.action === "retry-stage";

export const stopLinkAnswers = (items: readonly LaneAnswerItem[], owner: CardOwner | null): LaneAnswerItem[] => (owner === "seat" ? items.filter(isStopLink) : []);

/** The answers the ⋯ lists: all of them, less the two the stop entry carries as links. */
export const menuAnswers = (items: readonly LaneAnswerItem[], owner: CardOwner | null): LaneAnswerItem[] => (owner === "seat" ? items.filter((item) => !isStopLink(item)) : [...items]);
