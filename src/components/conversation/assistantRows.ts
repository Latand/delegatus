"use client";

import { useState } from "react";
import { assistantEchoText, type FeedEntry, type Item } from "../feed/parse";
import type { RuntimeTurnAxis } from "@/lib/runtime/contracts";
import { newestTranscriptInstant, transcriptInstant } from "../feed/transcriptOrder";
import { LIVE_TURN_ITEM_LIMIT, LIVE_TURN_OVERFLOW_LIMIT, runtimeLiveTurnItems, type RuntimeLiveTurn, type RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";

interface PendingAnswer {
  key: string; live: RuntimeLiveTurnItem; wire: RuntimeLiveTurnItem; order: number; turnId: string; occurrence: number;
  /** First seen in the mount's first runtime projection, with the window still unread. */
  unjudged?: boolean;
  /** The window had already moved past this reply when the pane first saw it. */
  fenced?: boolean;
}
interface RetiredAnswer { wire: RuntimeLiveTurnItem; turnId: string; occurrence: number; text: string }
interface Binding { key: string; at: number | null; order: number; identity: string }
export interface AssistantHandoff {
  pending: PendingAnswer[];
  /** Replies this pane never watched: tracked so they stay unpainted, as the tail fence leaves them. */
  held: PendingAnswer[];
  /** A runtime projection has been seen, so later replies are ones this pane watched arrive. */
  observed: boolean;
  bindings: Map<string, Binding>;
  /** Reply ids a transcript record took over on this mount. The host keeps
   * their descriptors long after the bounded claim set has dropped the id. */
  adopted: ReadonlySet<string>;
  sequence: number;
  retiredAnswers: readonly RetiredAnswer[];
  liveOrder: ReadonlyMap<string, number>;
  hiddenEchoes: ReadonlySet<string>;
}
const empty = (): AssistantHandoff => ({ pending: [], held: [], observed: false, bindings: new Map(), adopted: new Set(), sequence: 0, retiredAnswers: [], liveOrder: new Map(), hiddenEchoes: new Set() });
const at = (live: RuntimeLiveTurnItem) => {
  const value = Date.parse(live.startedAt ?? live.completedAt ?? "");
  return Number.isFinite(value) ? value : null;
};
const ADOPTED_LIMIT = 2 * (LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT);
const textKey = (text: string) => text.trim().replace(/\s+/g, " ");
const echoTextMatches = (text: string, live: RuntimeLiveTurnItem): boolean => {
  const canonical = textKey(text), streamed = textKey(live.text);
  if (!streamed) return false;
  return canonical === streamed || live.phase === "streaming" && canonical.startsWith(streamed)
    // The producer keeps the suffix when the bounded text buffer fills.
    || Boolean(live.omittedChars) && (live.phase === "streaming" ? canonical.includes(streamed) : canonical.endsWith(streamed));
};
const pendingEchoMatches = (text: string, entry: PendingAnswer) =>
  echoTextMatches(text, entry.wire) || echoTextMatches(text, entry.live);
// Keep rendered observations separate from the bounded transport descriptor.
// Missing intermediate deltas leave an explicit gap between known text spans.
const retainedBody = (entry: PendingAnswer, live: RuntimeLiveTurnItem): RuntimeLiveTurnItem => {
  if (!live.omittedChars) return live;
  const previous = Array.from(entry.wire.text);
  const dropped = live.omittedChars - (entry.wire.omittedChars ?? 0);
  const overlap = dropped >= 0 ? previous.slice(dropped).join("") : "";
  if (overlap && live.text.startsWith(overlap)) return { ...live,
    text: entry.live.text + live.text.slice(overlap.length), omittedChars: entry.live.omittedChars };
  if (entry.wire.text.endsWith(live.text)) return { ...live,
    text: entry.live.text, omittedChars: entry.live.omittedChars };
  if (dropped >= previous.length) {
    const gap = dropped - previous.length;
    return { ...live, text: entry.live.text + (gap ? "\n\n…\n\n" : "") + live.text,
      omittedChars: (entry.live.omittedChars ?? 0) + gap };
  }
  return live;
};
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
 * actual echo or durable claim retires them. Idle settles the caret without
 * proving canonical ownership. No transcript/parser state changes.
 *
 * A fresh mount (reload, new tab, another device) is handed every reply the
 * host still keeps, up to 544 of them, and watched none of them arrive. Once
 * the window has loaded, the ones it has already moved past are held under the
 * tail fence of `visibleRuntimeLiveTurnItems` and their transcript records
 * stay the only rows for them. `mount` is the mounted pane's own input: it
 * turns the fence on and defers the judgement until the window exists. Without
 * it every reply counts as watched.
 */
export function projectAssistantHandoff(previous: AssistantHandoff | null, liveTurn: RuntimeLiveTurn | null,
  feed: readonly FeedEntry[], claims: ReadonlySet<string>, turn: RuntimeTurnAxis | null = null,
  mount: { windowLoading: boolean } | null = null): AssistantHandoff {
  const state = previous ?? empty();
  let sequence = state.sequence;
  const pending = [...state.pending, ...state.held].map(entry => liveTurn && entry.turnId !== liveTurn.turnId
    && entry.live.startedAt === null && entry.live.phase === "streaming"
    ? { ...entry, live: { ...entry.live, phase: "awaiting-echo" as const }, wire: { ...entry.wire, phase: "awaiting-echo" as const } } : entry);
  const retiredAnswers = [...state.retiredAnswers];
  const current = runtimeLiveTurnItems(liveTurn);
  const liveOrder = liveTurn ? new Map(current.flatMap((live, index) => live.itemId ? [[live.itemId, index] as const] : [])) : state.liveOrder;
  const usedPending = new Set<number>();
  const adopted = new Set(state.adopted);
  let sourcePosition = 0;
  for (const [order, live] of current.entries()) {
    // Folded prefixes retain their logical item count. Positions therefore
    // survive descriptor rotation, including identical legacy replies.
    const occurrence = sourcePosition;
    sourcePosition += live.omittedItems || 1;
    if (live.tool || live.omittedItems || !live.itemId && retiredAnswers.some(answer =>
      answer.wire.startedAt === live.startedAt && (live.startedAt !== null || answer.turnId === liveTurn!.turnId)
      && answer.occurrence === occurrence && (answer.wire.text === live.text || echoTextMatches(answer.text, live)))) continue;
    if (live.itemId && adopted.has(live.itemId)) {
      // Seen again, so it stays the newest: the cap drops ids the host let go of.
      adopted.delete(live.itemId);
      adopted.add(live.itemId);
      continue;
    }
    const index = pending.findIndex((entry, index) => !usedPending.has(index) && (
      live.itemId && entry.wire.itemId === live.itemId
      || !entry.wire.itemId && entry.wire.startedAt === live.startedAt
        && (live.startedAt !== null || entry.turnId === liveTurn!.turnId)
        && entry.occurrence === occurrence
        && (entry.wire.text === live.text || entry.wire.phase === "streaming"
          || Boolean(live.omittedChars) && entry.wire.text.endsWith(live.text))));
    if (index >= 0) {
      pending[index] = { ...pending[index], live: retainedBody(pending[index], live), wire: live, order, occurrence };
      usedPending.add(index);
    } else if (live.text.trim()) {
      usedPending.add(pending.length);
      pending.push({ key: `assistant-pending:${sequence++}`, live, wire: live, order, turnId: liveTurn!.turnId, occurrence,
        ...(mount && !state.observed ? { unjudged: true } : {}) });
    }
  }
  const bindings = new Map<string, Binding>();
  const priorBindings = new Map([...state.bindings.values()].map(binding => [binding.identity, binding]));
  if (priorBindings.size) for (const entry of feed) {
    const prior = priorBindings.get(bindingIdentity(entry));
    if (prior) bindings.set(entry.key, prior);
  }
  const remaining: PendingAnswer[] = [];
  const claimedRows = new Set(bindings.keys());
  const hiddenEchoes = new Set<string>();
  // One assistant record can project into prose, review and citation cards.
  // Reassemble only its own projections; identical later records stay separate.
  const groups = new Map<string, FeedEntry[]>();
  // The loaded rows by the response id each carries, reasoning members included.
  const rowsById = new Map<string, FeedEntry[]>();
  for (const row of feed) {
    const ids = row.item.kind === "think" && row.item.members ? row.item.members.map(member => member.sourceId) : [];
    for (const id of new Set([...(source(row.item) ? [source(row.item)!] : []), ...ids])) rowsById.set(id, [...(rowsById.get(id) ?? []), row]);
  }
  for (const row of feed) if (assistantEchoText(row.item) !== null) {
    const identity = source(row.item) ? `source:${source(row.item)}`
      : row.anchorKey ? `record:${row.anchorKey.replace(/:\d+$/, "")}` : `row:${row.key}`;
    groups.set(identity, [...(groups.get(identity) ?? []), row]);
  }
  const echoes = [...groups.values()].map(rows => ({ rows,
    text: rows.map(row => assistantEchoText(row.item)).join("\n\n"),
    // Display hydration uses only public redacted/capped projections.
    displayText: rows.map(({ item }) => item.kind === "prose" || item.kind === "blob" ? item.text
      : item.kind === "review" || item.kind === "mem-citation" ? item.raw : "").join("\n\n"),
    at: rows.map(row => transcriptInstant(row.item)).find(value => value !== null) ?? null,
  }));
  const held: PendingAnswer[] = [];
  const transcriptAt = newestTranscriptInstant(feed);
  for (const [index, tracked] of pending.entries()) {
    let entry = tracked;
    // A reply in flight on a running turn is one this pane watches being written.
    if (entry.unjudged && entry.wire.phase === "streaming" && turn !== "idle") entry = { ...entry, unjudged: false };
    if (entry.unjudged && !mount?.windowLoading) {
      const liveAt = Date.parse(entry.live.completedAt ?? "") || at(entry.live);
      const fenced = transcriptAt !== null && liveAt !== null && liveAt <= transcriptAt
        && (entry.live.phase !== "streaming" || turn === "idle");
      entry = { ...entry, unjudged: false, fenced };
    }
    if (entry.fenced || entry.unjudged && entry.live.phase !== "streaming") {
      // Tracked for as long as the host keeps the descriptor, never painted.
      if (!liveTurn || usedPending.has(index)) held.push(entry);
      continue;
    }
    if (turn === "idle" && entry.live.phase === "streaming") {
      // Keep the wire phase for matching a missed completion's longer echo.
      entry = { ...entry, live: { ...entry.live, phase: "awaiting-echo" } };
    }
    const echo = !entry.live.itemId ? echoes.find(echo => echo.rows.every(row => !claimedRows.has(row.key))
      && pendingEchoMatches(echo.text, entry)
      && (at(entry.live) === null || echo.at === null || echo.at >= at(entry.live)!)) : undefined;
    const matches = entry.live.itemId ? (rowsById.get(entry.live.itemId) ?? []).filter(({ key }) => !claimedRows.has(key)) : echo?.rows ?? [];
    // A loaded row or a durable claim carries this id: the record owns the reply.
    const owned = Boolean(entry.live.itemId) && (claims.has(entry.live.itemId!) || rowsById.has(entry.live.itemId!));
    if (!matches.length && entry.live.itemId && !owned && entry.live.phase === "awaiting-echo") {
      // A legacy Codex agent_message can precede its identified response mirror.
      // Keep the live node until that mirror gives ownership, suppressing just
      // one same-text event within the parser's existing one-second boundary.
      const completedAt = Date.parse(entry.live.completedAt ?? "");
      const mirror = echoes.find(echo => echo.rows.every(row => !claimedRows.has(row.key) && !source(row.item))
        && echo.rows.some(({ item }) => item.kind === "prose" && item.engine === "codex" || item.kind === "review")
        && pendingEchoMatches(echo.text, entry) && Number.isFinite(completedAt)
        && echo.at !== null && Math.abs(echo.at - completedAt) <= 1000);
      if (mirror) {
        // The canonical event may contain a prefix the transport never sent.
        // Hydrate the same live node while the identified mirror is pending.
        entry = { ...entry, live: { ...entry.live, text: mirror.displayText, omittedChars: 0 } };
        for (const row of mirror.rows) { hiddenEchoes.add(row.key); claimedRows.add(row.key); }
      }
    }
    if (matches.length) {
      if (!entry.live.itemId) {
        // Bound completed occurrence ownership, never intermediate deltas.
        // Its canonical body also recognizes later transport suffix clipping.
        retiredAnswers.push({ wire: entry.wire, turnId: entry.turnId, occurrence: entry.occurrence,
          text: echo?.text ?? entry.live.text });
      }
      matches.forEach((match, index) => {
        claimedRows.add(match.key);
        // A structured answer can expand into several cards; each keeps a unique key.
        bindings.set(match.key, bindings.get(match.key) ?? { key: `${entry.key}${index ? `:${index}` : ""}`, at: index ? transcriptInstant(match.item) ?? at(entry.live) : at(entry.live) ?? transcriptInstant(match.item), order: entry.order, identity: bindingIdentity(match) });
      });
    } else if (!owned) remaining.push(entry);
    if (entry.live.itemId && (matches.length || owned)) adopted.add(entry.live.itemId);
  }
  while (adopted.size > ADOPTED_LIMIT) adopted.delete(adopted.values().next().value!);
  while (retiredAnswers.length > LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT) retiredAnswers.shift();
  return { pending: remaining, held, observed: state.observed || Boolean(liveTurn), bindings, adopted, sequence, retiredAnswers, liveOrder, hiddenEchoes };
}

export function useAssistantHandoff(identity: string | null, live: RuntimeLiveTurn | null,
  feed: readonly FeedEntry[], claims: ReadonlySet<string>, turn: RuntimeTurnAxis | null = null,
  windowLoading = false): AssistantHandoff {
  const [snapshot, setSnapshot] = useState(() => ({ identity, live, feed, claims, turn, windowLoading,
    value: projectAssistantHandoff(null, live, feed, claims, turn, { windowLoading }) }));
  // History-only panes have nothing to reconcile. In particular, a prepend
  // must not schedule a second render just to remember another empty handoff.
  if (!live && snapshot.identity === identity && !snapshot.value.pending.length && !snapshot.value.bindings.size) return snapshot.value;
  if (snapshot.identity !== identity || snapshot.live !== live || snapshot.feed !== feed || snapshot.claims !== claims || snapshot.turn !== turn
    || snapshot.windowLoading !== windowLoading) {
    const value = projectAssistantHandoff(snapshot.identity === identity ? snapshot.value : null, live, feed, claims, turn, { windowLoading });
    setSnapshot({ identity, live, feed, claims, turn, windowLoading, value });
    return value;
  }
  return snapshot.value;
}

/** Transport omissions count only replies this pane has not retained. Cached
 * replies stay owned until canonical adoption, even when descriptors rotate.
 */
export function retainedAssistantItems(handoff: AssistantHandoff, liveTurn: RuntimeLiveTurn | null,
  visible: readonly RuntimeLiveTurnItem[]): RuntimeLiveTurnItem[] {
  const pending = handoff.pending.map(answer => answer.live);
  const replyKey = (item: RuntimeLiveTurnItem) => item.itemId ? `id:${item.itemId}`
    : JSON.stringify([item.startedAt, textKey(item.text)]);
  const descriptors = runtimeLiveTurnItems(liveTurn);
  const aggregate = descriptors.length === LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT ? descriptors[0] : null;
  const aggregateStart = Date.parse(aggregate?.startedAt ?? "");
  const aggregateEnd = Date.parse(aggregate?.completedAt ?? "");
  // A fresh window's older cached replies lie outside this prefix interval.
  // Retired canonical occurrences are already owned as well as cached ones.
  const foldedButOwned = [...handoff.pending, ...handoff.retiredAnswers].filter(answer => {
    const instant = at("live" in answer ? answer.live : answer.wire);
    return aggregate && instant !== null && instant >= aggregateStart && instant <= aggregateEnd
      && answer.occurrence < (aggregate.omittedItems ?? 0);
  }).length;
  return [...pending, ...visible.flatMap(item => {
    if (!item.tool && !item.omittedItems && handoff.pending.some(answer => replyKey(answer.wire) === replyKey(item))) return [];
    if (item.omittedItems && !item.itemId && aggregate && !aggregate.itemId
      && item.startedAt === aggregate.startedAt && item.completedAt === aggregate.completedAt
      && item.omittedItems === aggregate.omittedItems) {
      const omittedItems = Math.max(0, item.omittedItems - foldedButOwned);
      return omittedItems ? [{ ...item, omittedItems }] : [];
    }
    return [item];
  })];
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
    const index = entry.at === null ? entry.canonicalIndex === undefined ? -1 : result.findIndex(row =>
      (placed.get(row.key)?.canonicalIndex ?? canonicalOrder.get(row.key) ?? -Infinity) > entry.canonicalIndex!) : result.findIndex(row => {
      const other = placed.get(row.key);
      const known = other ? other.at : instantOf(row);
      const canonicalIndex = other?.canonicalIndex ?? canonicalOrder.get(row.key);
      // A row with no instant (reasoning, a note) holds its transcript place
      // against a bound record, which has a transcript place of its own.
      if (known === null) return entry.canonicalIndex !== undefined && canonicalIndex !== undefined && canonicalIndex > entry.canonicalIndex;
      const instant = known;
      const order = other?.order ?? orderOf(row);
      if (instant !== entry.at) return instant > entry.at!;
      // Synthetic boundaries have no transcript source order. Their owner
      // supplies the tie rule, before canonical records compare their order.
      if (beforeAtSameInstant(row)) return true;
      if (entry.canonicalIndex !== undefined && canonicalIndex !== undefined) return canonicalIndex > entry.canonicalIndex;
      return order !== undefined && order > entry.order;
    });
    if (index < 0) result.push(entry.row);
    else result.splice(index, 0, entry.row);
    placed.set(entry.row.key, { at: entry.at, order: entry.order, canonicalIndex: entry.canonicalIndex });
  }
  return result;
}
