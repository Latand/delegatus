"use client";

import { useSyncExternalStore } from "react";

/**
 * Which submitted messages currently have a row on screen (send-latency
 * slice 3).
 *
 * Slice 3's rule is that one delivery is explained in ONE place: the message's
 * own row, with its transport evidence and its original-operation controls one
 * tap behind the row's quiet affordance. The composer's receipt stack therefore
 * stops speaking for any delivery that has such a row — otherwise the same
 * failure is explained twice, with two sets of controls, which is the second
 * status surface the whole slice removes.
 *
 * "Has a row" is a fact about what is MOUNTED, not about what the queue holds.
 * A composer mounted without a feed behind it — a surface that renders no
 * transcript at all — owns the only thing the operator can read, and silently
 * filtering there would hide an unconfirmed delivery completely. So the feed
 * publishes the keys it is actually painting and the composer reads them; with
 * no feed, nothing is published and the composer keeps its whole fallback.
 *
 * Module state keyed on the same stable conversation identity as the queue.
 */

const rendered = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
const NONE: ReadonlySet<string> = new Set();

function same(left: ReadonlySet<string> | undefined, right: ReadonlySet<string>): boolean {
  if (!left || left.size !== right.size) return false;
  for (const key of right) if (!left.has(key)) return false;
  return true;
}

/** Publish the message keys this feed is painting for one conversation. */
export function publishRenderedMessageRows(cardId: string, keys: readonly string[]): void {
  const next = new Set(keys);
  if (same(rendered.get(cardId), next)) return;
  if (next.size) rendered.set(cardId, next);
  else rendered.delete(cardId);
  for (const listener of listeners) listener();
}

/** The keys some feed is painting for this conversation, live. */
export function useRenderedMessageRows(cardId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => rendered.get(cardId) ?? NONE,
    () => NONE,
  );
}

/** Test seam: forget every publication (module state outlives one render). */
export function resetRenderedMessageRowsForTests(): void {
  rendered.clear();
  for (const listener of listeners) listener();
}
