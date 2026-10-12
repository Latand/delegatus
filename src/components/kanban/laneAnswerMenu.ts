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
