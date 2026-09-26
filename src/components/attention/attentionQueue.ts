import type { MobileBoardPipelineRow } from "@/components/mobile/mobileBoardModel";
import { overviewPipelineRows } from "@/components/mobile/overviewPhone";
import type { Pipeline } from "@/lib/pipelines/types";
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
  | { kind: "pipeline"; id: string; row: MobileBoardPipelineRow };

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
 */
export function buildNeedsYouQueue(
  files: readonly FileEntry[],
  pipelines: readonly Pipeline[],
  now: number,
  closing: readonly string[],
): MobileAttentionEntry[] {
  return buildMobileAttentionQueue(buildAttentionQueue([...files], now), overviewPipelineRows(pipelines, now, closing));
}

/** The board key a lane is focused by: the card that holds the pipeline, the
    anchor a pipeline link already resolves to (`focusTargetAnchorKeys`). */
const LANE_FOCUS = "group::pipeline::";
export const laneFocusPath = (pipelineId: string): string => `${LANE_FOCUS}${pipelineId}`;
export const laneFocusId = (path: string): string | null => (path.startsWith(LANE_FOCUS) ? path.slice(LANE_FOCUS.length) || null : null);

/** The project an entry belongs to. */
export function attentionEntryProject(entry: MobileAttentionEntry): string {
  return entry.kind === "conversation" ? entry.item.project : entry.row.pipeline.project;
}
