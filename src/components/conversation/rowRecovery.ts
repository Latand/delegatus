"use client";

import { useSyncExternalStore } from "react";

/**
 * The recovery a message row can perform, published by the composer that owns
 * the conversation's delivery machinery (send-latency slice 3).
 *
 * Slice 3 moved delivery status onto the message itself: one row, one quiet
 * affordance, and the transport evidence behind that affordance. The controls
 * that go with the evidence — ask the runtime again under this message's
 * original key, replay the admitted operation, end it — live in `TmuxComposer`,
 * which owns the payload store, the receipt stream and the reconciliation
 * window. The row is rendered by `LogFeed`, which owns none of that.
 *
 * So the composer REGISTERS what it can do for one conversation and the row
 * calls it. Module state keyed on the same stable conversation identity as the
 * queue itself, exactly like `appendComposerDraft`; a surface with no composer
 * behind it (a render-only pane, a fixture) simply finds nothing registered and
 * offers no control it cannot honour.
 *
 * Deliberately NOT a way to send anything. `check` asks about the key the row
 * is already filed under; it never mints a key, never posts a message, and is
 * the only thing an unconfirmed delivery is ever offered — handing those words
 * back to the composer is what let one message be admitted twice.
 */

export interface MessageRowRecovery {
  /**
   * Re-read delivery evidence under the message's ORIGINAL idempotency key.
   * The key exists from the moment the operator pressed Send, so this works for
   * an admission that never returned an operation id — the case that used to
   * offer a second send instead.
   */
  check: (key: string) => void;
  /** Replay the admitted operation itself, when the journal can start its next
      attempt from the recorded request. Absent for a row with no operation. */
  retryOperation?: (key: string) => void;
  /** End the admitted operation: the operator decides it must not arrive. */
  discard?: (key: string) => void;
}

const registry = new Map<string, MessageRowRecovery>();
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** Publish what this conversation's composer can do. Returns the unregister. */
export function publishMessageRowRecovery(cardId: string, recovery: MessageRowRecovery): () => void {
  registry.set(cardId, recovery);
  announce();
  return () => {
    if (registry.get(cardId) !== recovery) return;
    registry.delete(cardId);
    announce();
  };
}

/** What the row may offer for this conversation, or `null` with no composer. */
export function messageRowRecovery(cardId: string): MessageRowRecovery | null {
  return registry.get(cardId) ?? null;
}

/**
 * The same read, subscribed. The composer registers from an effect, which is
 * AFTER the feed's first paint, so a plain module read would leave the rows of
 * a freshly opened conversation without their controls until something else
 * happened to re-render the feed.
 */
export function useMessageRowRecovery(cardId: string): MessageRowRecovery | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => messageRowRecovery(cardId),
    () => null,
  );
}

/** Test seam: forget every registration (module state outlives one render). */
export function resetMessageRowRecoveryForTests(): void {
  registry.clear();
  announce();
}
