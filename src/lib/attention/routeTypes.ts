import { drawnLaneMovement } from "@/lib/pipelines/laneMovement";
import type { Pipeline } from "@/lib/pipelines/types";

import type { LaneReasonKind } from "./dismissalTypes";

/**
 * Who answers a needs-you reason (docs/design/attention-auto-resolve.md), in
 * the shapes the server stamps onto `/api/files` and every surface reads.
 * Browser-safe: no store and no filesystem here.
 *
 * The operator's list keeps only what is theirs. A worker's or a stage's ask
 * goes to the project's designated seat first, and a lane that waits for an
 * automatic retry waits for nobody. A seat that cannot decide escalates the
 * ask, and the escalation carries the question, its options and what the
 * answer does next, so the row the operator gets says what to choose.
 */

/** A reason nobody but its owner answers, stamped onto the conversation or
    the lane it belongs to. `key` names exactly the reason it covers, so a
    newer ask on the same conversation or a lane that parked again is not
    covered and is routed afresh. */
export interface AttentionRouteMark {
  key: string;
  /** `seat`: the project's designated seat answers it first.
      `system`: an automatic retry already owns it; nobody is asked. */
  owner: "seat" | "system";
  /** The seat conversation that answers a `seat` reason. */
  seat?: string;
}

/** What a seat could not decide and handed to the operator, in its words:
    the question (one plain sentence or two), the choices as it named them
    (empty for a free answer), its recommendation and what the answer does
    next. */
export interface AttentionEscalationMark extends OperatorQuestion {
  key: string;
  /** Server clock, ISO. */
  at: string;
  /** The seat conversation that escalated it. */
  seat: string | null;
}

/** Bounds of an escalation, shared by the tool, the store and the tests. */
export const ESCALATION_QUESTION_MAX = 400;
export const ESCALATION_OPTION_MAX = 160;
export const ESCALATION_OPTIONS_MAX = 6;
export const ESCALATION_EFFECT_MAX = 240;

/** A question put to the operator, with its choices and what the answer does
    next: a seat's escalation and a stage's decision request share it. */
export interface OperatorQuestion {
  question: string;
  options: string[];
  recommended: number | null;
  effect: string | null;
}

/** A question as a caller sent it, checked; a string names what is wrong.
    `field` is the argument it came in, for the refusal. */
export function parseOperatorQuestion(value: unknown, field: string): OperatorQuestion | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be an object { question, options?, recommended?, effect? }`;
  const raw = value as Record<string, unknown>;
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question || question.length > ESCALATION_QUESTION_MAX) return `${field}.question must be 1 to ${ESCALATION_QUESTION_MAX} characters`;
  const options: string[] = [];
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options) || raw.options.length > ESCALATION_OPTIONS_MAX) return `${field}.options must be a list of at most ${ESCALATION_OPTIONS_MAX}`;
    for (const option of raw.options) {
      const label = typeof option === "string" ? option.trim() : "";
      if (!label || label.length > ESCALATION_OPTION_MAX) return `each ${field} option must be 1 to ${ESCALATION_OPTION_MAX} characters`;
      options.push(label);
    }
    if (options.length === 1) return `${field}.options needs two or more choices, or none for a free answer`;
  }
  let recommended: number | null = null;
  if (raw.recommended !== undefined && raw.recommended !== null) {
    if (!Number.isInteger(raw.recommended) || (raw.recommended as number) < 0 || (raw.recommended as number) >= options.length) return `${field}.recommended must index one of the options`;
    recommended = raw.recommended as number;
  }
  let effect: string | null = null;
  if (raw.effect !== undefined && raw.effect !== null) {
    effect = typeof raw.effect === "string" ? raw.effect.trim() : "";
    if (!effect || effect.length > ESCALATION_EFFECT_MAX) return `${field}.effect must be 1 to ${ESCALATION_EFFECT_MAX} characters`;
  }
  return { question, options, recommended, effect };
}

/** A seat's escalation as the tool received it. */
export function parseEscalation(value: unknown): OperatorQuestion | string {
  return parseOperatorQuestion(value, "escalate");
}

/** What a lane waits on, whoever answers it: a decision, a spent review
    budget, or a completed lane's merge that stopped (#2187 §4.6). */
export function laneNeedKind(pipeline: Pick<Pipeline, "state" | "merge">): LaneReasonKind | null {
  if (pipeline.state === "completed" && pipeline.merge?.state === "blocked") return "lane-merge";
  if (pipeline.state === "needs_review") return "lane-review";
  if (pipeline.state === "needs_decision") return "lane-decision";
  return null;
}

/** The exact wait a lane's route names: its kind and the movement it parked
    at, or the instant its merge stopped. A lane that moves again is a new
    wait and is routed afresh. */
export function laneRouteKey(pipeline: Pipeline, kind: LaneReasonKind): string {
  if (kind === "lane-merge") return `lane:${pipeline.id}:merge:${pipeline.merge?.blockedAt ?? pipeline.merge?.updatedAt ?? ""}`;
  return `lane:${pipeline.id}:${kind}:${drawnLaneMovement(pipeline) ?? "none"}`;
}

/** The exact wait a conversation's route names: its reason's id. */
export function conversationRouteKey(reasonId: string): string {
  return `reason:${reasonId}`;
}

/** The route that covers what this lane waits on now, or null. A stamp drawn
    for an earlier wait covers nothing. */
export function laneRouteNow(pipeline: Pipeline): AttentionRouteMark | null {
  const kind = laneNeedKind(pipeline);
  const route = pipeline.attentionRoute;
  return kind && route && route.key === laneRouteKey(pipeline, kind) ? route : null;
}

/** The escalation that covers what this lane waits on now, or null. */
export function laneEscalationNow(pipeline: Pipeline): AttentionEscalationMark | null {
  const kind = laneNeedKind(pipeline);
  const escalation = pipeline.attentionEscalation;
  return kind && escalation && escalation.key === laneRouteKey(pipeline, kind) ? escalation : null;
}
