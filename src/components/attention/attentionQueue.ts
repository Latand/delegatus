import type { MobileBoardPipelineRow } from "@/components/mobile/mobileBoardModel";
import type { MobileScreen } from "@/components/mobile/mobileNav";
import { overviewPipelineRows } from "@/components/mobile/overviewPhone";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { buildAttentionQueue, type AttentionItem } from "../attention";

/*
 * The phone's ONE attention list (issue #1439, lane 8; docs/design/mobile-v2/
 * README.md §4.1, §4.6): conversations waiting on the operator and pipelines
 * in `needs_decision`, as one ordered list. The bar's badge counts it, the
 * Needs-you sheet lists it, the sheet's «Next ›» walks it — three entries to
 * one queue, so none of them can promise an item another cannot reach. The
 * desktop island reads the same list since #2129 (`buildNeedsYouQueue`).
 *
 * Pure on purpose. The conversation half is `buildAttentionQueue`'s answer,
 * already scoped and ordered (blocked before stalled, oldest signal first);
 * the pipeline half is `needsDecisionPipelineRows`, the same rows the board's
 * Needs-you section renders. This module only joins them, in the order the
 * board shows them, and answers "which one is next from here".
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
 * the desktop island counts, lists and walks with «Next ›», and the one the
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

/** Whether `entry` is what the screen on top of the stack shows: the
    conversation screen is keyed by the transcript path, the pipeline screen
    by the pipeline id. */
export function isCurrentAttentionEntry(entry: MobileAttentionEntry, screen: MobileScreen | null): boolean {
  if (!screen) return false;
  if (entry.kind === "conversation") return screen.kind === "chat" && screen.id === entry.item.file.path;
  return screen.kind === "pipeline" && screen.id === entry.row.id;
}

/**
 * The entry «Next ›» goes to from `screen`: the one after the item the
 * operator is looking at, wrapping past the end; the first (or, backward, the
 * last) when the screen shows none of them. The item on screen is never the
 * answer — with a single entry, and that entry open, there is nowhere to go
 * and the sheet has no Next to offer.
 */
export function nextMobileAttention(
  entries: readonly MobileAttentionEntry[],
  screen: MobileScreen | null,
  dir: 1 | -1 = 1,
): MobileAttentionEntry | null {
  if (!entries.length) return null;
  const here = entries.findIndex((entry) => isCurrentAttentionEntry(entry, screen));
  if (here === -1) return dir === 1 ? entries[0]! : entries[entries.length - 1]!;
  const target = (here + dir + entries.length) % entries.length;
  return target === here ? null : entries[target]!;
}
