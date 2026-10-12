"use client";

import { useSyncExternalStore } from "react";

/**
 * Where a conversation's own-message navigator goes when its composer is on
 * screen (operator, 2026-10-11, variant 2 of the second round): «mine 4/4»
 * sits in the composer's own bottom row, so nothing is drawn above the input
 * field. The composer publishes that place; the feed of the same conversation
 * draws its navigator there instead of the row above the composer, and keeps
 * the row for a pane that has no composer.
 *
 * One place per conversation: there is exactly one composer per conversation
 * (the hoisted composer, #691), and the newest place a composer publishes is
 * where it renders.
 */
const slots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };

/** The composer's place for the navigator. Returns the retraction. */
export function publishComposerStepsSlot(conversation: string, node: HTMLElement): () => void {
  slots.set(conversation, node);
  notify();
  return () => {
    if (slots.get(conversation) !== node) return;
    slots.delete(conversation);
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The composer's place for this conversation's navigator, or null while none is published. */
export function useComposerStepsSlot(conversation: string | null): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => (conversation ? slots.get(conversation) ?? null : null),
    () => null,
  );
}

/** Tests only. */
export function resetComposerStepsSlotsForTest(): void {
  slots.clear();
  notify();
}
