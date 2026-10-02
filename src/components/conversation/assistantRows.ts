"use client";

import { useState } from "react";
import type { FeedEntry, Item } from "../feed/parse";
import { transcriptInstant } from "../feed/transcriptOrder";
import { LIVE_TURN_ITEM_LIMIT, LIVE_TURN_OVERFLOW_LIMIT, runtimeLiveTurnItems, type RuntimeLiveTurn, type RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";

interface PendingAnswer { key: string; live: RuntimeLiveTurnItem }
interface Binding { key: string; at: number | null }
export interface AssistantHandoff {
  pending: PendingAnswer[];
  bindings: Map<string, Binding>;
  sequence: number;
  retiredStreams: ReadonlySet<string>;
}
const empty = (): AssistantHandoff => ({ pending: [], bindings: new Map(), sequence: 0, retiredStreams: new Set() });
const at = (live: RuntimeLiveTurnItem) => {
  const value = Date.parse(live.startedAt ?? live.completedAt ?? "");
  return Number.isFinite(value) ? value : null;
};
const streamKey = (live: RuntimeLiveTurnItem) => JSON.stringify([live.startedAt, live.text]);
const source = (item: Item) => "sourceId" in item ? item.sourceId : undefined;

/** Pane-owned replies survive a missing runtime snapshot. Only an actual echo
 * (or a durable claim from one) retires them. No transcript/parser state changes.
 */
export function projectAssistantHandoff(previous: AssistantHandoff | null, liveTurn: RuntimeLiveTurn | null,
  feed: readonly FeedEntry[], claims: ReadonlySet<string>): AssistantHandoff {
  const state = previous ?? empty();
  let sequence = state.sequence;
  const pending = state.pending.slice();
  const retiredStreams = new Set(state.retiredStreams);
  for (const live of runtimeLiveTurnItems(liveTurn)) {
    if (live.tool || !live.text.trim() || !live.itemId && retiredStreams.has(streamKey(live))) continue;
    const index = pending.findIndex((entry) => live.itemId && entry.live.itemId === live.itemId
      || !entry.live.itemId && entry.live.startedAt === live.startedAt
        && (live.startedAt !== null || live.text.startsWith(entry.live.text)));
    if (index >= 0) pending[index] = { ...pending[index], live };
    else pending.push({ key: `assistant-pending:${sequence++}`, live });
  }
  const bindings = new Map<string, Binding>();
  for (const entry of feed) {
    const prior = state.bindings.get(entry.key);
    if (prior) bindings.set(entry.key, prior);
  }
  const remaining: PendingAnswer[] = [];
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
        bindings.set(match.key, bindings.get(match.key) ?? { key: `${entry.key}${index ? `:${index}` : ""}`, at: at(entry.live) });
      });
    } else if (!entry.live.itemId || !claims.has(entry.live.itemId)) remaining.push(entry);
  }
  while (retiredStreams.size > LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT) retiredStreams.delete(retiredStreams.values().next().value!);
  return { pending: remaining, bindings, sequence, retiredStreams };
}

export function useAssistantHandoff(identity: string | null, live: RuntimeLiveTurn | null,
  feed: readonly FeedEntry[], claims: ReadonlySet<string>): AssistantHandoff {
  const [snapshot, setSnapshot] = useState(() => ({ identity, live, feed, claims,
    value: projectAssistantHandoff(null, live, feed, claims) }));
  if (snapshot.identity !== identity || snapshot.live !== live || snapshot.feed !== feed || snapshot.claims !== claims) {
    const value = projectAssistantHandoff(snapshot.identity === identity ? snapshot.value : null, live, feed, claims);
    setSnapshot({ identity, live, feed, claims, value });
    return value;
  }
  return snapshot.value;
}

/** Splice answers at their original instant. The canonical echo takes the same
 * keyed outer row and slot, including when its file record arrives out of order.
 */
export function mergeAssistantRows<T extends { key: string; kind: string; item?: Item; instant?: number | null }>(
  rows: readonly T[], handoff: AssistantHandoff, makeRow: (answer: PendingAnswer) => T,
  instantOf: (row: T) => number | null = row => row.instant ?? (row.item ? transcriptInstant(row.item) : null),
): T[] {
  const result: T[] = [];
  const waiting: { row: T; at: number | null }[] = handoff.pending.map(answer => ({ row: makeRow(answer), at: at(answer.live) }));
  for (const row of rows) {
    const binding = handoff.bindings.get(row.key);
    if (binding) waiting.push({ row: { ...row, key: binding.key }, at: binding.at });
    else result.push(row);
  }
  waiting.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  const placed = new Map<string, number | null>();
  for (const entry of waiting) {
    const index = entry.at === null ? -1 : result.findIndex(row =>
      ((placed.has(row.key) ? placed.get(row.key) : instantOf(row)) ?? -Infinity) > entry.at!);
    if (index < 0) result.push(entry.row);
    else result.splice(index, 0, entry.row);
    placed.set(entry.row.key, entry.at);
  }
  return result;
}
