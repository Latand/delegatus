import { attentionReason } from "@/components/attention";
import { roleNameById } from "@/components/builderCopy";
import { clearedByText, laneStageLabel, needLabel } from "@/components/attention/decision";
import { laneNeed, type ClearedNeed, type NeedReason } from "@/components/attention/needReason";
import { laneMergeWord, mergeReasonText, pipelineMovedAtMs } from "@/components/pipelines/pipelineBlockModel";
import { laneRouteNow, type AttentionRouteMark } from "@/lib/attention/routeTypes";
import type { TFunction } from "@/lib/i18n";
import { laneStopKind, type LaneStop } from "@/lib/pipelines/laneStop";
import type { Pipeline } from "@/lib/pipelines/types";
import { prototypeWaitsOnOperator } from "@/lib/prototypeReview/model";
import type { FileEntry } from "@/lib/types";

import type { KanbanCard } from "./kanbanModel";

/*
 * Who has a card now (docs/design/calm-task-cards-build.md §5): one owner per
 * lane and one per card, from what the server already stamps (the route) and
 * the client already reads (the lane's need and its dismissal). The cause only
 * picks the words. Pure: the closed card's state line, its dot, «Answer» and
 * the lane's manual hint all read it, and a test reads it without React.
 */

export type CardOwner = "you" | "seat" | "waiting" | "working" | "done";

/** Most urgent first, after «you»: the card names the lane that leads. */
const URGENCY: readonly CardOwner[] = ["you", "seat", "working", "waiting", "done"];

export interface LaneState {
  pipeline: Pipeline;
  owner: CardOwner;
  /** The stop the lane stands on, whoever answers it. */
  stop: LaneStop | null;
  route: AttentionRouteMark | null;
  /** A stop someone already cleared, with who and when. */
  cleared: ClearedNeed | null;
  /** An automatic retry's time, epoch ms. */
  retryAtMs: number | null;
  /** Since when the lane stands where it is, epoch ms. */
  sinceMs: number | null;
}

const parseMs = (stamp: string | null | undefined): number | null => {
  const value = Date.parse(stamp ?? "");
  return Number.isFinite(value) ? value : null;
};

/** When the engine retries a provider wait by itself. */
function automaticRetryAt(pipeline: Pipeline): number | null {
  const stageId = pipeline.cursor?.stageId;
  const attempt = stageId ? pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) : undefined;
  return parseMs(attempt?.providerWait?.resumeAt);
}

/** The lane's owner by §5.1's table. */
export function laneState(pipeline: Pipeline): LaneState {
  const route = laneRouteNow(pipeline);
  const found = laneNeed(pipeline);
  const stop = laneStopKind(pipeline);
  const merge = pipeline.merge;
  const moved = pipelineMovedAtMs(pipeline);
  const stoppedAt = stop?.kind === "merge" ? parseMs(merge?.blockedAt ?? merge?.updatedAt) : moved;
  const base = { pipeline, stop, route, cleared: null, retryAtMs: null };
  if (route?.owner === "form" || (found && !found.cleared)) return { ...base, owner: "you", sinceMs: stoppedAt };
  if (route?.owner === "seat") return { ...base, owner: "seat", sinceMs: stoppedAt };
  if (route?.owner === "system") return { ...base, owner: "waiting", retryAtMs: automaticRetryAt(pipeline), sinceMs: stoppedAt };
  if (found?.cleared) return { ...base, owner: "waiting", cleared: found.cleared, sinceMs: stoppedAt };
  switch (pipeline.state) {
    case "running":
      return { ...base, owner: "working", sinceMs: moved };
    case "provisioning":
      return { ...base, owner: pipeline.stateDetail?.startsWith("waiting for disk space:") ? "waiting" : "working", sinceMs: moved };
    case "completed": {
      const word = laneMergeWord(pipeline);
      if (word === "updating" || word === "merging") return { ...base, owner: "working", sinceMs: parseMs(merge?.updatedAt) ?? moved };
      if (word === "waiting" || word === "stopped") return { ...base, owner: "waiting", sinceMs: parseMs(merge?.requestedAt) ?? moved };
      return { ...base, owner: "done", sinceMs: parseMs(merge?.mergedAt) ?? parseMs(pipeline.closedAt) ?? moved };
    }
    case "closed":
      return { ...base, owner: "done", sinceMs: parseMs(pipeline.closedAt) ?? moved };
    default:
      /* Paused, a draft, or a stop with no route the client can read. */
      return { ...base, owner: "waiting", sinceMs: pipeline.state === "paused" ? parseMs(pipeline.pausedAt) ?? moved : moved };
  }
}

export type CardSubject =
  /** A decision form waits: the task's own round, or the round a lane's wait was escalated to. */
  | { kind: "form"; taskId: string; reviewId: string; title: string | null }
  /** The operator's own reason on a member conversation. */
  | { kind: "conversation"; need: Extract<NeedReason, { subject: "conversation" }> }
  | { kind: "lane"; lane: LaneState }
  /** A member's ask the seat answers first. */
  | { kind: "seat-conversation"; file: FileEntry }
  /** Nothing to name beyond the card's motion. */
  | { kind: "motion" };

export interface CardState {
  owner: CardOwner;
  subject: CardSubject;
  /** Every lane's state, in the card's order. */
  lanes: LaneState[];
  sinceMs: number | null;
}

type CardInput = Pick<KanbanCard, "needsYou" | "reasons" | "pipelines" | "members" | "task" | "motion">;

/**
 * The card's one owner (§5.1): the operator when they owe an answer, else the
 * most urgent lane, a seat-routed member, else the card's motion. A card that
 * has not started draws no state line.
 */
export function cardState(card: CardInput, nowSeconds: number): CardState | null {
  const lanes = card.pipelines.map((summary) => laneState(summary.pipeline));
  const formLane = lanes.find((lane) => lane.route?.owner === "form" && lane.route.form);
  const waitingRound = card.task && prototypeWaitsOnOperator(card.task.prototypeReview) ? card.task.prototypeReview! : null;
  const motionSince = parseMs(card.motion.since);
  if (card.needsYou || formLane) {
    const first = card.reasons[0];
    if (first?.subject === "conversation") return { owner: "you", subject: { kind: "conversation", need: first }, lanes, sinceMs: first.since * 1000 };
    if (first?.subject === "pipeline") {
      const lane = lanes.find((entry) => entry.pipeline.id === first.pipeline.id) ?? laneState(first.pipeline);
      return { owner: "you", subject: { kind: "lane", lane: { ...lane, owner: "you" } }, lanes, sinceMs: first.since * 1000 };
    }
    if (formLane?.route?.form) {
      const own = waitingRound && waitingRound.waitingReviewId === formLane.route.form.reviewId ? waitingRound.title : null;
      return { owner: "you", subject: { kind: "form", ...formLane.route.form, title: own }, lanes, sinceMs: formLane.sinceMs };
    }
    if (waitingRound && card.task) {
      return { owner: "you", subject: { kind: "form", taskId: card.task.id, reviewId: waitingRound.waitingReviewId!, title: waitingRound.title }, lanes, sinceMs: parseMs(waitingRound.createdAt) };
    }
  }
  const lead = URGENCY.map((owner) => lanes.find((lane) => lane.owner === owner)).find(Boolean) ?? null;
  if (lead?.owner === "seat") return { owner: "seat", subject: { kind: "lane", lane: lead }, lanes, sinceMs: lead.sinceMs };
  const seatMember = card.members.find((member) => attentionReason(member.file, nowSeconds)?.route?.owner === "seat");
  if (seatMember) {
    const reason = attentionReason(seatMember.file, nowSeconds);
    return { owner: "seat", subject: { kind: "seat-conversation", file: seatMember.file }, lanes, sinceMs: reason ? reason.since * 1000 : null };
  }
  if (card.motion.key === "working" || lead?.owner === "working") {
    return { owner: "working", subject: lead?.owner === "working" && card.motion.key !== "working" ? { kind: "lane", lane: lead } : { kind: "motion" }, lanes, sinceMs: motionSince ?? lead?.sinceMs ?? null };
  }
  /* A lane that waits on something it names (a retry's time, a clearing, a merge's checks) says it. */
  const namedWait = lanes.find((lane) => lane.owner === "waiting" && (lane.retryAtMs !== null || lane.cleared || laneMergeWord(lane.pipeline) === "waiting"));
  if (namedWait) return { owner: "waiting", subject: { kind: "lane", lane: namedWait }, lanes, sinceMs: namedWait.sinceMs };
  switch (card.motion.key) {
    case "needs-you":
      return { owner: "you", subject: { kind: "motion" }, lanes, sinceMs: motionSince };
    case "waiting":
    case "stopped":
      return { owner: "waiting", subject: { kind: "motion" }, lanes, sinceMs: motionSince ?? lead?.sinceMs ?? null };
    case "done":
      return { owner: "done", subject: lead ? { kind: "lane", lane: lead } : { kind: "motion" }, lanes, sinceMs: lead?.sinceMs ?? null };
    default:
      if (lead && lead.owner !== "done") return { owner: lead.owner, subject: { kind: "lane", lane: lead }, lanes, sinceMs: lead.sinceMs };
      return lead ? { owner: "done", subject: { kind: "lane", lane: lead }, lanes, sinceMs: lead.sinceMs } : null;
  }
}

/* ── Words (§5.3) ─────────────────────────────────────────────────────── */

/** A stage's name in the line's words, or the empty string. */
function stageName(t: TFunction, pipeline: Pipeline, stageId: string | null): string {
  return laneStageLabel(t, pipeline, stageId);
}

/** Why a lane stopped, by its stop kind. `short` drops the stage, for a
    chronology entry that already names it. */
export function laneStopWhy(t: TFunction, pipeline: Pipeline, stop: LaneStop, short = false): string {
  if (stop.kind === "merge") {
    const pr = pipeline.merge?.prNumber;
    const reason = mergeReasonText(t, pipeline.merge?.reason ?? null);
    return pr ? t("cardState.why.merge", { pr, reason }) : t("cardState.why.mergeNoPr", { reason });
  }
  if (short) return t(`cardState.whyShort.${stop.kind}`);
  const stage = stageName(t, pipeline, stop.stageId);
  return stage ? t(`cardState.why.${stop.kind}`, { stage }) : t(`cardState.whyShort.${stop.kind}`);
}

/** Who cleared a stop, in the line's words. */
export function clearedWho(t: TFunction, cleared: ClearedNeed): string {
  return clearedByText(t, cleared.by);
}

/** The words of a role the seat answers for. */
function memberRole(t: TFunction, file: FileEntry): string {
  const role = file.durableLineage?.role?.trim();
  return role ? roleNameById(t, role) : "";
}

/**
 * The state line's sentence, or null when the card's motion line says it
 * (the component draws `TaskMotionLine` then). `clock` writes an epoch-ms
 * time as HH:MM in the operator's locale.
 */
export function cardStateText(t: TFunction, state: CardState, clock: (ms: number) => string): string | null {
  const subject = state.subject;
  if (subject.kind === "form") return subject.title ? t("cardState.you.form", { title: subject.title }) : t("cardState.you.plain");
  if (subject.kind === "conversation") return t("cardState.you.conversation", { need: needLabel(t, subject.need) });
  if (subject.kind === "seat-conversation") {
    const role = memberRole(t, subject.file);
    return role ? t("cardState.seat.conversation", { role }) : t("cardState.seat.conversationPlain");
  }
  if (subject.kind === "motion") return null;
  const lane = subject.lane;
  if (state.owner === "you") return lane.stop ? t("cardState.you.lane", { why: laneStopWhy(t, lane.pipeline, lane.stop) }) : t("cardState.you.plain");
  if (state.owner === "seat") return lane.stop ? t("cardState.seat.lane", { why: laneStopWhy(t, lane.pipeline, lane.stop) }) : t("cardState.seat.plain");
  if (state.owner === "waiting" && lane.retryAtMs !== null) return t("cardState.waiting.retry", { time: clock(lane.retryAtMs) });
  if (state.owner === "waiting" && lane.cleared) return t("cardState.waiting.cleared", { who: clearedWho(t, lane.cleared) });
  const pr = lane.pipeline.merge?.prNumber ?? null;
  if (state.owner === "waiting" && laneMergeWord(lane.pipeline) === "waiting") return pr ? t("cardState.waiting.checks", { pr }) : t("cardState.waiting.checksNoPr");
  if (state.owner === "working" && (laneMergeWord(lane.pipeline) === "updating" || laneMergeWord(lane.pipeline) === "merging")) return t(`pipelineBlock.merge.${laneMergeWord(lane.pipeline) as "updating" | "merging"}`);
  if (state.owner === "done") {
    const word = laneMergeWord(lane.pipeline);
    if (word !== "merged") return t("cardState.done.plain");
    return pr ? t("cardState.done.merged", { pr }) : t("cardState.done.mergedNoPr");
  }
  return null;
}

/** The dot's popover: the owner and how long. */
export function cardStatePopover(t: TFunction, state: CardState, age: string): string {
  return t(`cardState.popover.${state.owner}`, { age });
}

/** Whether the closed card offers «Answer»: only where the operator owes one
    and there is a place to give it. */
export function cardAnswers(state: CardState | null): boolean {
  if (!state || state.owner !== "you") return false;
  return state.subject.kind === "form" || state.subject.kind === "conversation" || state.subject.kind === "lane";
}
