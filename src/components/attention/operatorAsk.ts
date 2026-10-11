import type { TFunction } from "@/lib/i18n";
import { laneEscalationNow } from "@/lib/attention/routeTypes";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import type { ConversationReason } from "../attention";
import { conversationNeedText, laneStageLabel } from "./decision";
import { laneStageId } from "./needReason";

/*
 * What a «Waiting for you» row asks of the operator
 * (docs/design/attention-auto-resolve.md, «Implementation plan for
 * acceptance 5»): the question exactly as its author wrote it, the choices as
 * they were named, and one plain sentence saying what to choose or do and what
 * happens next. The desktop panel, the phone sheet and the project read all
 * draw from here, so a row says the same thing on every surface.
 *
 * A stage's question is the stage's own text: a decision it reported, else
 * the summary it reported with its verdict. A stage name is metadata and never
 * stands in for the question.
 */

export interface OperatorAsk {
  /** The question in its author's words, or null when the sentence says it all. */
  question: string | null;
  /** The choices, as their author named them; empty for a free answer. */
  options: string[];
  /** Index into `options` of the author's recommendation. */
  recommended: number | null;
  /** One plain sentence: what to choose or do, and what happens next. */
  sentence: string;
}

/** How much of an unstructured question a row shows; the lane holds the rest. */
export const QUESTION_DISPLAY_MAX = 600;

function clipQuestion(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > QUESTION_DISPLAY_MAX ? `${trimmed.slice(0, QUESTION_DISPLAY_MAX - 1).trimEnd()}…` : trimmed;
}

/** A seat's escalation of a routed wait: its own question, choices and what
    the answer does next. */
function escalatedAsk(t: TFunction, escalation: NonNullable<ConversationReason["escalation"]>): OperatorAsk {
  return {
    question: escalation.question,
    options: escalation.options,
    recommended: escalation.recommended,
    sentence: escalation.effect ? t("needs.ask.escalatedEffect", { effect: escalation.effect }) : t("needs.ask.escalated"),
  };
}

const plain = (sentence: string): OperatorAsk => ({ question: null, options: [], recommended: null, sentence });

/** What one conversation's reason asks of the operator. A native question
    carries its own text and options; an orchestrator's report is the row's
    title already, so it is not repeated here. */
export function conversationOperatorAsk(t: TFunction, reason: ConversationReason, file?: Pick<FileEntry, "pendingQuestion">): OperatorAsk {
  if (reason.escalation) return escalatedAsk(t, reason.escalation);
  switch (reason.kind) {
    case "decision":
      return plain(t("needs.ask.decision"));
    case "question": {
      const first = file?.pendingQuestion?.questions?.[0];
      const options = first?.options?.map((option) => option.label?.trim() ?? "").filter(Boolean) ?? [];
      const recommended = first?.options?.findIndex((option) => option.recommended) ?? -1;
      return { question: first?.question?.trim() || reason.header, options, recommended: recommended >= 0 && options.length ? recommended : null, sentence: t("needs.ask.question") };
    }
    case "plan":
      return plain(t("needs.ask.plan"));
    case "permission":
      return plain(reason.header ? t("needs.ask.permissionNamed", { request: reason.header }) : t("needs.ask.permission"));
    case "delivery":
      return plain(t("needs.ask.delivery"));
    case "launch":
      return plain(reason.header ? t("needs.ask.launchReason", { reason: reason.header }) : t("needs.ask.launch"));
    case "memory":
      return plain(t("needs.ask.memory", { memory: conversationNeedText(t, reason) }));
    case "ask":
      return plain(reason.header ? t("needs.ask.askNamed", { ask: reason.header }) : t("needs.ask.ask"));
  }
}

/** The attempt a parked lane stopped on. */
function parkedAttempt(pipeline: Pipeline): PipelineStageAttempt | null {
  const stageId = pipeline.cursor?.stageId;
  return stageId ? pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) ?? null : null;
}

/** The engine's generic words for a verdict that carried no question. */
const UNSTATED = /^stage verdict: (needs_decision|fail)$/;

/** What a parked lane asks of the operator. */
export function laneOperatorAsk(t: TFunction, pipeline: Pipeline): OperatorAsk {
  const escalation = laneEscalationNow(pipeline);
  if (escalation) return escalatedAsk(t, escalation);
  const stage = laneStageLabel(t, pipeline, laneStageId(pipeline)) || t("needs.laneDecision");
  if (pipeline.state === "needs_review") return plain(t("needs.ask.laneReview", { stage }));
  const attempt = parkedAttempt(pipeline);
  const report = attempt?.report;
  /* The stage reported the question itself. */
  if (report?.verdict.status === "needs_decision" && report.decision) {
    const { question, options, recommended } = report.decision;
    return { question, options, recommended, sentence: t(options.length ? "needs.ask.laneOptions" : "needs.ask.laneQuestion", { stage }) };
  }
  if (report?.verdict.status === "needs_decision" && report.summary?.trim()) {
    return { question: clipQuestion(report.summary), options: [], recommended: null, sentence: t("needs.ask.laneQuestion", { stage }) };
  }
  /* A mechanical stop: what stopped it, in the engine's words. */
  const detail = pipeline.stateDetail?.trim().split("\n", 1)[0] ?? "";
  if (detail && !UNSTATED.test(detail)) return plain(t("needs.ask.laneStopped", { stage, detail: detail.length > 240 ? `${detail.slice(0, 239)}…` : detail }));
  return plain(t("needs.ask.laneUnstated", { stage }));
}
