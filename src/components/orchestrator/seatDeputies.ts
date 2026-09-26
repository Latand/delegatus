"use client";

import { useSyncExternalStore } from "react";

import type { SeatDeputyView } from "@/lib/orchestrator/deputyView";

/**
 * The seat's deputies as this tab last read them, keyed by the SEAT's
 * conversation id (docs/design/ghost-seat.md §5 "Reaching the feed").
 *
 * The seat read is already polled by every surface that shows the seat — the
 * dock's panel, the board's seat frame, the phone's focus view and seat card —
 * and each answer carries the deputies. Publishing them here lets the one feed
 * that renders the seat's conversation draw the blocks without a second poll
 * and without threading a prop through every surface that mounts a feed. A
 * feed of any other conversation reads an empty list and renders as before.
 *
 * The composer's «ask in parallel» publishes the record the route answered
 * with, so the block's head is on screen before the next poll.
 */

const EMPTY: readonly SeatDeputyView[] = [];
const bySeat = new Map<string, readonly SeatDeputyView[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function same(left: readonly SeatDeputyView[], right: readonly SeatDeputyView[]): boolean {
  return left.length === right.length && JSON.stringify(left) === JSON.stringify(right);
}

/** The seat's answer replaces what this tab knew about that seat. */
export function publishSeatDeputies(seatConversationId: string, deputies: readonly SeatDeputyView[]): void {
  const current = bySeat.get(seatConversationId) ?? EMPTY;
  /* A record published by the composer and not yet in the poll's answer is
     kept until the answer names it: the poll may have been in flight. */
  const known = new Set(deputies.map((deputy) => deputy.askId));
  const pending = current.filter((deputy) => !known.has(deputy.askId) && deputy.state !== "ended"
    && Date.now() - Date.parse(deputy.startedAt) < 30_000);
  const next = [...deputies, ...pending];
  if (same(current, next)) return;
  bySeat.set(seatConversationId, next);
  emit();
}

/** One record, from the route's own answer. */
export function publishSeatDeputy(deputy: SeatDeputyView): void {
  const current = bySeat.get(deputy.seatConversationId) ?? EMPTY;
  const next = [deputy, ...current.filter((entry) => entry.askId !== deputy.askId)];
  bySeat.set(deputy.seatConversationId, next);
  emit();
}

export function seatDeputiesFor(seatConversationId: string | null | undefined): readonly SeatDeputyView[] {
  return seatConversationId ? bySeat.get(seatConversationId) ?? EMPTY : EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSeatDeputies(seatConversationId: string | null | undefined): readonly SeatDeputyView[] {
  return useSyncExternalStore(
    subscribe,
    () => seatDeputiesFor(seatConversationId),
    () => EMPTY,
  );
}

/* Which project each seat conversation holds, from the same answers: the
   composer offers «ask in parallel» only on a seat's own conversation, and the
   route needs the project to name the seat. */
const projectBySeat = new Map<string, string>();

export function publishSeatProject(seatConversationId: string, project: string): void {
  if (projectBySeat.get(seatConversationId) === project) return;
  projectBySeat.set(seatConversationId, project);
  emit();
}

export function useSeatProjectFor(conversationId: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (conversationId ? projectBySeat.get(conversationId) ?? null : null),
    () => null,
  );
}

export function resetSeatDeputiesForTests(): void {
  bySeat.clear();
  projectBySeat.clear();
  emit();
}
