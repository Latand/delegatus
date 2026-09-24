import type { ConversationReasonKind, DismissedBy, LaneReasonKind } from "@/lib/attention/dismissalTypes";
import { pipelineReviewSummary } from "@/lib/pipelines/failEdgeBudget";
import { laneMovedAt } from "@/lib/pipelines/laneMovement";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { pipelineHiddenFromBoard } from "@/components/mobile/mobileBoardModel";
import { pipelineNeedsYou } from "@/components/pipelines/pipelineBlockModel";

import { attentionReason, type ConversationReason } from "../attention";

/*
 * Why a card needs the operator (docs/design/needs-attention.md §4): every
 * member conversation's reason and every lane parked on them, as one list the
 * desktop card and the phone card both read. A reason someone dismissed is
 * kept apart as «cleared», with who cleared it, for as long as it stays live.
 */

export type NeedReason =
  | {
    subject: "conversation";
    kind: ConversationReasonKind;
    /** The reason's own identity: its attention id. */
    key: string;
    file: FileEntry;
    reason: ConversationReason;
    /** Epoch seconds it began to need the operator. */
    since: number;
  }
  | {
    subject: "pipeline";
    kind: LaneReasonKind;
    key: string;
    pipeline: Pipeline;
    /** The stage the lane stopped on. */
    stageId: string | null;
    since: number;
  };

export interface ClearedNeed {
  need: NeedReason;
  /** Epoch seconds the dismissal was made. */
  at: number;
  by: DismissedBy;
}

/** A dismissal written before attribution existed: the phone's Hide, the one
    place a lane could be cleared from then. */
const LEGACY_DISMISSAL: DismissedBy = { kind: "operator" };

/** A conversation's reason, flagged or cleared, or null when it has none. */
export function conversationNeed(file: FileEntry, now: number): { need: NeedReason; cleared: ClearedNeed | null } | null {
  const reason = attentionReason(file, now);
  if (!reason) return null;
  const need: NeedReason = { subject: "conversation", kind: reason.kind, key: reason.id, file, reason, since: reason.raisedAt };
  if (!reason.dismissal) return { need, cleared: null };
  const at = Date.parse(reason.dismissal.at);
  return { need, cleared: { need, at: at / 1000, by: reason.dismissal.by } };
}

/** The stage a parked lane stands on: its cursor, or the review stage a
    needs_review lane stands on without one (#1938). */
export function laneStageId(pipeline: Pipeline): string | null {
  return pipeline.cursor?.stageId ?? pipelineReviewSummary(pipeline)?.stageId ?? null;
}

/** When the lane stopped on the operator: its last movement, or its creation
    for a lane parked before any round ran. */
function laneSince(pipeline: Pipeline): number {
  const moved = laneMovedAt(pipeline);
  if (Number.isFinite(moved)) return moved / 1000;
  const created = Date.parse(pipeline.createdAt);
  return Number.isFinite(created) ? created / 1000 : 0;
}

/** A lane's reason, flagged or cleared, or null when it asks nothing. */
export function laneNeed(pipeline: Pipeline): { need: NeedReason; cleared: ClearedNeed | null } | null {
  if (!pipelineNeedsYou(pipeline)) return null;
  const need: NeedReason = {
    subject: "pipeline",
    kind: pipeline.state === "needs_review" ? "lane-review" : "lane-decision",
    key: `pipeline:${pipeline.id}`,
    pipeline,
    stageId: laneStageId(pipeline),
    since: laneSince(pipeline),
  };
  if (!pipelineHiddenFromBoard(pipeline)) return { need, cleared: null };
  return { need, cleared: { need, at: Date.parse(pipeline.dismissedAt!) / 1000, by: pipeline.dismissedBy ?? LEGACY_DISMISSAL } };
}

/** Oldest first, the key as the tie-break: the order the card names them in. */
export function byNeedAge(a: { since: number; key: string }, b: { since: number; key: string }): number {
  return a.since - b.since || a.key.localeCompare(b.key);
}
