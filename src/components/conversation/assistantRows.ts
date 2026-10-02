"use client";

import { useState } from "react";
import type { FeedEntry, Item } from "../feed/parse";
import type { RuntimeTurnAxis } from "@/lib/runtime/contracts";
import { newestTranscriptInstant, transcriptInstant } from "../feed/transcriptOrder";
import { LIVE_TURN_ITEM_LIMIT, LIVE_TURN_OVERFLOW_LIMIT, runtimeLiveTurnItems, type RuntimeLiveTurn, type RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";

interface PendingAnswer { key: string; live: RuntimeLiveTurnItem; order: number }
interface Binding { key: string; at: number | null; order: number }
export interface AssistantHandoff {
  pending: PendingAnswer[];
  bindings: Map<string, Binding>;
  sequence: number;
  retiredStreams: ReadonlySet<string>;
  liveOrder: ReadonlyMap<string, number>;
}
const empty = (): AssistantHandoff => ({ pending: [], bindings: new Map(), sequence: 0, retiredStreams: new Set(), liveOrder: new Map() });
const at = (live: RuntimeLiveTurnItem) => {
  const value = Date.parse(live.startedAt ?? live.completedAt ?? "");
  return Number.isFinite(value) ? value : null;
};
const streamKey = (live: RuntimeLiveTurnItem) => JSON.stringify([live.startedAt, live.text]);
const source = (item: Item) => "sourceId" in item ? item.sourceId : undefined;

/** Pane-owned completed replies survive a missing runtime snapshot until an
 * actual echo or durable claim retires them. Idle turns retain the existing
 * fence for stranded streaming drafts. No transcript/parser state changes.
 */
export function projectAssistantHandoff(previous: AssistantHandoff | null, liveTurn: RuntimeLiveTurn | null,
  feed: readonly FeedEntry[], claims: ReadonlySet<string>, turn: RuntimeTurnAxis | null = null): AssistantHandoff {
  const state = previous ?? empty();
  let sequence = state.sequence;
  const pending = state.pending.slice();
  const retiredStreams = new Set(state.retiredStreams);
  const current = runtimeLiveTurnItems(liveTurn);
  const liveOrder = liveTurn ? new Map(current.flatMap((live, index) => live.itemId ? [[live.itemId, index] as const] : [])) : state.liveOrder;
  for (const [order, live] of current.entries()) {
    if (live.tool || !live.text.trim() || !live.itemId && retiredStreams.has(streamKey(live))) continue;
    const index = pending.findIndex((entry) => live.itemId && entry.live.itemId === live.itemId
      || !entry.live.itemId && entry.live.startedAt === live.startedAt
        && (live.startedAt !== null || live.text.startsWith(entry.live.text)));
    if (index >= 0) pending[index] = { ...pending[index], live, order };
    else pending.push({ key: `assistant-pending:${sequence++}`, live, order });
  }
  const bindings = new Map<string, Binding>();
  for (const entry of feed) {
    const prior = state.bindings.get(entry.key);
    if (prior) bindings.set(entry.key, prior);
  }
  const remaining: PendingAnswer[] = [];
  const transcriptAt = newestTranscriptInstant(feed);
  const claimedRows = new Set<string>();
  for (const entry of pending) {
    let matches = feed.filter(({ item, key }) => !claimedRows.has(key) && (entry.live.itemId
      ? source(item) === entry.live.itemId || item.kind === "think" && item.members?.some(member => member.sourceId === entry.live.itemId)
      : item.kind === "prose" && (item.text.trim() === entry.live.text.trim() || entry.live.phase === "streaming" && item.text.trim().startsWith(entry.live.text.trim()))
        && (at(entry.live) === null || transcriptInstant(item) === null || transcriptInstant(item)! >= at(entry.live)!)));
    if (!entry.live.itemId) matches = matches.slice(0, 1);
    if (matches.length) {
      if (!entry.live.itemId) retiredStreams.add(streamKey(entry.live));
      matches.forEach((match, index) => {
        claimedRows.add(match.key);
        // A structured answer can expand into several cards; each keeps a unique key.
        bindings.set(match.key, bindings.get(match.key) ?? { key: `${entry.key}${index ? `:${index}` : ""}`, at: at(entry.live), order: entry.order });
      });
    } else if ((!entry.live.itemId || !claims.has(entry.live.itemId))
      && !(entry.live.phase === "streaming" && turn === "idle" && transcriptAt !== null
        && at(entry.live) !== null && at(entry.live)! <= transcriptAt)) remaining.push(entry);
  }
  while (retiredStreams.size > LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT) retiredStreams.delete(retiredStreams.values().next().value!);
  return { pending: remaining, bindings, sequence, retiredStreams, liveOrder };
}

export function useAssistantHandoff(identity: string | null, live: RuntimeLiveTurn | null,
  feed: readonly FeedEntry[], claims: ReadonlySet<string>, turn: RuntimeTurnAxis | null = null): AssistantHandoff {
  const [snapshot, setSnapshot] = useState(() => ({ identity, live, feed, claims, turn,
    value: projectAssistantHandoff(null, live, feed, claims, turn) }));
  if (snapshot.identity !== identity || snapshot.live !== live || snapshot.feed !== feed || snapshot.claims !== claims || snapshot.turn !== turn) {
    const value = projectAssistantHandoff(snapshot.identity === identity ? snapshot.value : null, live, feed, claims, turn);
    setSnapshot({ identity, live, feed, claims, turn, value });
    return value;
  }
  return snapshot.value;
}

/** Splice answers at their original instant. The canonical echo takes the same
 * keyed outer row and slot, including when its file record arrives out of order.
 */
export function mergeAssistantRows<T extends { key: string; kind: string; item?: Item; instant?: number | null; liveOrder?: number }>(
  rows: readonly T[], handoff: AssistantHandoff, makeRow: (answer: PendingAnswer) => T,
  instantOf: (row: T) => number | null = row => row.instant ?? (row.item ? transcriptInstant(row.item) : null),
): T[] {
  const result: T[] = [];
  const waiting = handoff.pending.map(answer => ({ row: makeRow(answer), at: at(answer.live), order: answer.order }));
  for (const row of rows) {
    const binding = handoff.bindings.get(row.key);
    if (binding) waiting.push({ row: { ...row, key: binding.key }, at: binding.at, order: binding.order });
    else result.push(row);
  }
  waiting.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  const placed = new Map<string, { at: number | null; order: number }>();
  const orderOf = (row: T) => row.liveOrder ?? (row.item?.kind === "tool" ? handoff.liveOrder.get(row.item.id)
    : row.item?.kind === "cmd-group" ? Math.min(...row.item.ids.map(id => handoff.liveOrder.get(id) ?? Infinity))
      : row.item && source(row.item) ? handoff.liveOrder.get(source(row.item)!) : undefined);
  for (const entry of waiting) {
    const index = entry.at === null ? -1 : result.findIndex(row => {
      const other = placed.get(row.key);
      const instant = (other ? other.at : instantOf(row)) ?? -Infinity;
      const order = other?.order ?? orderOf(row);
      return instant > entry.at! || instant === entry.at && order !== undefined && order > entry.order;
    });
    if (index < 0) result.push(entry.row);
    else result.splice(index, 0, entry.row);
    placed.set(entry.row.key, { at: entry.at, order: entry.order });
  }
  return result;
}
