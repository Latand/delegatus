import { finishedWorkIndex } from "@/lib/attention/finishedWork";
import { withFinishedAttention } from "@/lib/attention/finishedAttention";
import { delegatedConversation, SEAT_CONVERSATION_KINDS } from "@/lib/attention/routing";
import type { MobileBoardPipelineRow } from "@/components/mobile/mobileBoardModel";
import { overviewPipelineRows } from "@/components/mobile/overviewPhone";
import type { AutoView } from "@/lib/selfUpdate/auto";
import type { Pipeline } from "@/lib/pipelines/types";
import { prototypeReviewNotices } from "@/lib/prototypeReview/model";
import type { PrototypeReviewNotice } from "@/lib/prototypeReview/types";
import type { SecretRequestNotice } from "@/lib/secretRequests/view";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { buildAttentionQueue, type AttentionItem } from "../attention";

/*
 * The phone's ONE attention list (issue #1439, lane 8; docs/design/mobile-v2/
 * README.md §4.1, §4.6): conversations waiting on the operator and pipelines
 * in `needs_decision`, as one ordered list. The bar's badge counts it, the
 * Needs-you sheet lists it — two entries to one queue, so neither can promise
 * an item the other cannot reach. The desktop control and its panel read the
 * same list since #2129 (`buildNeedsYouQueue`); since option B of
 * docs/design/needs-you-options.md nothing walks it but the N key, over the
 * project on screen.
 *
 * Pure on purpose. The conversation half is `buildAttentionQueue`'s answer,
 * already scoped and ordered (blocked before stalled, oldest signal first);
 * the pipeline half is `needsDecisionPipelineRows`, the same rows the board's
 * Needs-you section renders. This module only joins them, in the order the
 * board shows them.
 */

export type MobileAttentionEntry =
  | { kind: "conversation"; id: string; item: AttentionItem }
  | { kind: "pipeline"; id: string; row: MobileBoardPipelineRow }
  | { kind: "update"; id: string; decision: NonNullable<AutoView["decision"]> }
  /** A task's prototype review that waits for the operator's choice. */
  | { kind: "prototype"; id: string; notice: PrototypeReviewNotice }
  | { kind: "secret-request"; id: string; notice: SecretRequestNotice };

/** Conversations first in queue order, then the pipelines — the board's
    Needs-you order (`buildMobileBoard`), so the sheet and the section under
    the bar list the same rows in the same sequence. */
export function buildMobileAttentionQueue(
  conversations: readonly AttentionItem[],
  pipelines: readonly MobileBoardPipelineRow[],
): MobileAttentionEntry[] {
  return [
    ...conversations.map((item): MobileAttentionEntry => ({ kind: "conversation", id: item.id, item })),
    ...pipelines.map((row): MobileAttentionEntry => ({ kind: "pipeline", id: row.id, row })),
  ];
}

/**
 * Everything that needs the operator, in every project (#2129): the ONE list
 * the desktop control counts and its panel lists by project, and the one the
 * phone's ⚠ badge slices by the project behind it. Parked lanes are the second
 * authority (docs/design/needs-attention.md §1) and ride beside the
 * conversations, so a lane the card names counts in the header too, and a lane
 * dismissed on its card, or closing, leaves both counts with the card's mark.
 * A task's prototype review that waits for a choice is an entry of its own,
 * one per task: the choice clears it and a newer round brings it back.
 */
export function buildNeedsYouQueue(
  files: readonly FileEntry[],
  pipelines: readonly Pipeline[],
  now: number,
  closing: readonly string[],
  decision?: AutoView["decision"],
  tasks: readonly BoardTask[] = [],
  /** The orchestrators' own open questions, which no task carries. */
  seatDecisions: readonly PrototypeReviewNotice[] = [],
  secretRequests: readonly SecretRequestNotice[] = [],
): MobileAttentionEntry[] {
  const finished = finishedWorkIndex(tasks, pipelines);
  const queue = buildMobileAttentionQueue(buildAttentionQueue(files.map(file => withFinishedAttention(file, now, finished)), now), overviewPipelineRows(pipelines, now, closing));
  for (const notice of prototypeReviewNotices(tasks, seatDecisions)) queue.push({ kind: "prototype", id: notice.id, notice });
  for (const notice of secretRequests) queue.push({ kind: "secret-request", id: notice.id, notice });
  if (decision) queue.push({ kind: "update", id: `auto-update:${decision.id}`, decision });
  return queue;
}

/**
 * Whether «Needs you» holds an entry (docs/design/legatus/build-plan.md,
 * slice 1): the button counts the decision forms that wait for the operator,
 * plus what nobody else answers yet. Every form and the update decision stay.
 * A parked lane stays: one whose project has a seat already carries the seat's
 * route and is not on the queue. A worker's question, plan, permission, memory
 * kill or prose ask stays only in the same case, a project with no seat to
 * route it to (`routing.ts`). An orchestrator's own questions are its reports
 * and its forms; a question in the operator's own session, a stuck delivery
 * and a failed launch stay on their cards' state lines. An answered form whose
 * delivery needs attention waits on nobody: it stays as its record, where
 * Retry lives, and leaves the count (needs-you-restructure.md §3).
 */
export function needsYouHolds(entry: MobileAttentionEntry): boolean {
  if (entry.kind === "prototype") return !entry.notice.undelivered;
  if (entry.kind !== "conversation") return true;
  const { reason, file } = entry.item;
  return !reason.report && SEAT_CONVERSATION_KINDS.has(reason.kind) && delegatedConversation(file);
}

/** The board key a lane is focused by: the card that holds the pipeline, the
    anchor a pipeline link already resolves to (`focusTargetAnchorKeys`). */
const LANE_FOCUS = "group::pipeline::";
export const laneFocusPath = (pipelineId: string): string => `${LANE_FOCUS}${pipelineId}`;
export const laneFocusId = (path: string): string | null => (path.startsWith(LANE_FOCUS) ? path.slice(LANE_FOCUS.length) || null : null);

/** The project an entry belongs to. */
export function attentionEntryProject(entry: MobileAttentionEntry): string {
  if (entry.kind === "update") return entry.decision.project;
  if (entry.kind === "prototype" || entry.kind === "secret-request") return entry.notice.project;
  return entry.kind === "conversation" ? entry.item.project : entry.row.pipeline.project;
}
