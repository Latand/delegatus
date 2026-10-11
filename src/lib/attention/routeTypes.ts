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
 * automatic retry waits for nobody. A seat that cannot decide asks the
 * operator in a decision form, a prototype-review question round, and
 * escalates the wait to that round: the escalation holds the round's id and
 * no question of its own (docs/design/operator-decision-forms.md §4), so the
 * form's row is the one row the operator answers.
 */

/** A reason nobody but its owner answers, stamped onto the conversation or
    the lane it belongs to. `key` names exactly the reason it covers, so a
    newer ask on the same conversation or a lane that parked again is not
    covered and is routed afresh. */
export interface AttentionRouteMark {
  key: string;
  /** `seat`: the project's designated seat answers it first.
      `system`: an automatic retry already owns it; nobody is asked.
      `form`: the seat escalated it, and the operator answers the waiting
      decision form `form` names; the wait draws no row of its own. */
  owner: "seat" | "system" | "form";
  /** The seat conversation that answers a `seat` reason, or that escalated a
      `form` one. */
  seat?: string;
  /** The round a `form` reason waits on. */
  form?: AttentionFormRef;
}

/** One prototype-review round: a decision form the operator answers. */
export interface AttentionFormRef {
  taskId: string;
  reviewId: string;
}

/** A seat handed one routed wait to the operator by asking in a decision
    form. While that round waits, the wait is the form's; once the operator
    decides it, dismisses it or a newer round replaces it, the wait is the
    seat's again, with the operator's answer in its conversation. */
export interface AttentionEscalationMark extends AttentionFormRef {
  key: string;
  /** Server clock, ISO. */
  at: string;
  /** The seat conversation that escalated it. */
  seat: string | null;
}

const ROUND_ID_MAX = 200;

/** An escalation as a caller sent it, checked; a string names what is wrong.
    Only the round is named: the task it belongs to is resolved on the server. */
export function parseEscalation(value: unknown): { reviewId: string } | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "escalate must be an object { reviewId }: publish the question with publish_prototype_review first";
  const raw = value as Record<string, unknown>;
  const reviewId = typeof raw.reviewId === "string" ? raw.reviewId.trim() : "";
  if (!reviewId || reviewId.length > ROUND_ID_MAX) return "escalate.reviewId must name the decision round publish_prototype_review answered";
  return { reviewId };
}

/** A stored escalation, checked as strictly as the tool checks a new one. */
export function parseEscalationMark(value: unknown): AttentionEscalationMark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const round = parseEscalation(raw);
  if (typeof round === "string" || typeof raw.taskId !== "string" || !raw.taskId) return null;
  if (typeof raw.key !== "string" || !raw.key || typeof raw.at !== "string") return null;
  return { key: raw.key, at: raw.at, seat: typeof raw.seat === "string" ? raw.seat : null, taskId: raw.taskId, reviewId: round.reviewId };
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
