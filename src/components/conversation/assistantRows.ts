"use client";

import { useState } from "react";
import type { FeedEntry, Item } from "../feed/parse";
import type { RuntimeTurnAxis } from "@/lib/runtime/contracts";
import { newestTranscriptInstant, transcriptInstant } from "../feed/transcriptOrder";
import { LIVE_TURN_ITEM_LIMIT, LIVE_TURN_OVERFLOW_LIMIT, runtimeLiveTurnItems, type RuntimeLiveTurn, type RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";

interface PendingAnswer { key: string; live: RuntimeLiveTurnItem; order: number; stream: string; turnId: string }
interface Binding { key: string; at: number | null; order: number; identity: string }
export interface AssistantHandoff {
  pending: PendingAnswer[];
  bindings: Map<string, Binding>;
  sequence: number;
  retiredStreams: ReadonlySet<string>;
  liveOrder: ReadonlyMap<string, number>;
  hiddenEchoes: ReadonlySet<string>;
}
const empty = (): AssistantHandoff => ({ pending: [], bindings: new Map(), sequence: 0, retiredStreams: new Set(), liveOrder: new Map(), hiddenEchoes: new Set() });
const at = (live: RuntimeLiveTurnItem) => {
  const value = Date.parse(live.startedAt ?? live.completedAt ?? "");
  return Number.isFinite(value) ? value : null;
};
// Deltas keep their original start even when carried into a newer turn. A
// legacy descriptor without that identity is fenced by its consumed text.
const streamKey = (live: RuntimeLiveTurnItem, turnId: string) => JSON.stringify([
  live.startedAt, live.startedAt === null ? [turnId, live.text] : null,
]);
const source = (item: Item) => "sourceId" in item ? item.sourceId : undefined;
// Parser sequence keys restart on a new filter or locale. Bind the original
// transcript projection, so a reused sequence key cannot adopt another row.
// Codex mirrors can update both timestamp and source line. Their message id
// and within-record projection ordinal remain stable across that upgrade.
const bindingIdentity = (entry: FeedEntry) => source(entry.item)
  ? JSON.stringify([source(entry.item), entry.item.kind, entry.anchorKey?.split(":").at(-1)])
  : JSON.stringify([entry.anchorKey, entry.item.kind, transcriptInstant(entry.item),
    !entry.anchorKey && "text" in entry.item ? entry.item.text : null]);

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
    const stream = streamKey(live, liveTurn!.turnId);
    if (live.tool || !live.text.trim() || !live.itemId && retiredStreams.has(stream)) continue;
    const index = pending.findIndex((entry) => live.itemId && entry.live.itemId === live.itemId
      || !entry.live.itemId && entry.live.startedAt === live.startedAt
        && (live.startedAt !== null || live.text.startsWith(entry.live.text)));
    if (index >= 0) pending[index] = { ...pending[index], live, order };
    else pending.push({ key: `assistant-pending:${sequence++}`, live, order, stream, turnId: liveTurn!.turnId });
  }
  const bindings = new Map<string, Binding>();
  const priorBindings = new Map([...state.bindings.values()].map(binding => [binding.identity, binding]));
  for (const entry of feed) {
    const prior = priorBindings.get(bindingIdentity(entry));
    if (prior) bindings.set(entry.key, prior);
  }
  const remaining: PendingAnswer[] = [];
  const transcriptAt = newestTranscriptInstant(feed);
  const claimedRows = new Set<string>();
  const hiddenEchoes = new Set<string>();
  for (const entry of pending) {
    let matches = feed.filter(({ item, key }) => !claimedRows.has(key) && (entry.live.itemId
      ? source(item) === entry.live.itemId || item.kind === "think" && item.members?.some(member => member.sourceId === entry.live.itemId)
      : item.kind === "prose" && (item.text.trim() === entry.live.text.trim() || entry.live.phase === "streaming" && item.text.trim().startsWith(entry.live.text.trim()))
        && (at(entry.live) === null || transcriptInstant(item) === null || transcriptInstant(item)! >= at(entry.live)!)));
    if (!entry.live.itemId) matches = matches.slice(0, 1);
    if (!matches.length && entry.live.itemId && !claims.has(entry.live.itemId) && entry.live.phase === "awaiting-echo") {
      // A legacy Codex agent_message can precede its identified response mirror.
      // Keep the live node until that mirror gives ownership, suppressing just
      // one same-text event within the parser's existing one-second boundary.
      const completedAt = Date.parse(entry.live.completedAt ?? "");
      const mirror = feed.find(({ item, key }) => !claimedRows.has(key) && item.kind === "prose"
        && item.engine === "codex" && !item.sourceId && item.text.trim() === entry.live.text.trim()
        && Number.isFinite(completedAt) && transcriptInstant(item) !== null
        && Math.abs(transcriptInstant(item)! - completedAt) <= 1000);
      if (mirror) { hiddenEchoes.add(mirror.key); claimedRows.add(mirror.key); }
    }
    if (matches.length) {
      if (!entry.live.itemId) {
        retiredStreams.add(entry.stream);
        for (const match of matches) if (match.item.kind === "prose") {
          // Legacy reconnects can contain the full reply rather than the prefix
          // that this pane consumed. Both are already represented canonically.
          retiredStreams.add(streamKey({ ...entry.live, text: match.item.text }, entry.turnId));
        }
      }
      matches.forEach((match, index) => {
        claimedRows.add(match.key);
        // A structured answer can expand into several cards; each keeps a unique key.
        bindings.set(match.key, bindings.get(match.key) ?? { key: `${entry.key}${index ? `:${index}` : ""}`, at: index ? transcriptInstant(match.item) ?? at(entry.live) : at(entry.live), order: entry.order, identity: bindingIdentity(match) });
      });
    } else if ((!entry.live.itemId || !claims.has(entry.live.itemId))
      && !(entry.live.phase === "streaming" && turn === "idle" && transcriptAt !== null
        && at(entry.live) !== null && at(entry.live)! <= transcriptAt)) remaining.push(entry);
  }
  while (retiredStreams.size > LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT) retiredStreams.delete(retiredStreams.values().next().value!);
  return { pending: remaining, bindings, sequence, retiredStreams, liveOrder, hiddenEchoes };
}

export function useAssistantHandoff(identity: string | null, live: RuntimeLiveTurn | null,
  feed: readonly FeedEntry[], claims: ReadonlySet<string>, turn: RuntimeTurnAxis | null = null): AssistantHandoff {
  const [snapshot, setSnapshot] = useState(() => ({ identity, live, feed, claims, turn,
    value: projectAssistantHandoff(null, live, feed, claims, turn) }));
  // History-only panes have nothing to reconcile. In particular, a prepend
  // must not schedule a second render just to remember another empty handoff.
  if (!live && snapshot.identity === identity && !snapshot.value.pending.length && !snapshot.value.bindings.size) return snapshot.value;
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
  beforeAtSameInstant: (row: T) => boolean = () => false,
): T[] {
  const result: T[] = [];
  const canonicalOrder = new Map(rows.map((row, index) => [row.key, index]));
  const waiting: { row: T; at: number | null; order: number; canonicalIndex?: number }[] = handoff.pending.map(answer => ({ row: makeRow(answer), at: at(answer.live), order: answer.order }));
  for (const row of rows) {
    if (handoff.hiddenEchoes.has(row.key)) continue;
    const binding = handoff.bindings.get(row.key);
    if (binding) waiting.push({ row: { ...row, key: binding.key }, at: binding.at, order: binding.order, canonicalIndex: canonicalOrder.get(row.key) });
    else result.push(row);
  }
  waiting.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  const placed = new Map<string, { at: number | null; order: number; canonicalIndex?: number }>();
  const orderOf = (row: T) => row.liveOrder ?? (row.item?.kind === "tool" ? handoff.liveOrder.get(row.item.id)
    : row.item?.kind === "cmd-group" ? Math.min(...row.item.ids.map(id => handoff.liveOrder.get(id) ?? Infinity))
      : row.item && source(row.item) ? handoff.liveOrder.get(source(row.item)!) : undefined);
  for (const entry of waiting) {
    const index = entry.at === null ? -1 : result.findIndex(row => {
      const other = placed.get(row.key);
      const instant = (other ? other.at : instantOf(row)) ?? -Infinity;
      const order = other?.order ?? orderOf(row);
      if (instant !== entry.at) return instant > entry.at!;
      // Synthetic boundaries have no transcript source order. Their owner
      // supplies the tie rule, before canonical records compare their order.
      if (beforeAtSameInstant(row)) return true;
      const canonicalIndex = other?.canonicalIndex ?? canonicalOrder.get(row.key);
      if (entry.canonicalIndex !== undefined && canonicalIndex !== undefined) return canonicalIndex > entry.canonicalIndex;
      return order !== undefined && order > entry.order;
    });
    if (index < 0) result.push(entry.row);
    else result.splice(index, 0, entry.row);
    placed.set(entry.row.key, { at: entry.at, order: entry.order, canonicalIndex: entry.canonicalIndex });
  }
  return result;
}
