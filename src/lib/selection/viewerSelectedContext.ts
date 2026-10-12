"use client";

import { viewBus } from "@/hooks/viewPresenceBus";

import {
  captureSelectedContext,
  type SelectedCardIdentity,
  type SelectedContextRef,
} from "./selectedContext";

/**
 * The live read of the selected-card reference, from the same bus the board,
 * scheme and phone already report presence into (#844).
 *
 * Deliberately a plain function, not a hook: it is called AT THE SUBMISSION
 * INSTANT — inside the submit handler, inside the voice send — so the reference
 * is decided by the state that existed when the operator acted, not by whatever
 * a render happened to close over. Everything the bus can say is read here in
 * one synchronous pass, which is what makes "change the selection right after
 * sending" leave the admitted turn alone.
 *
 * The voice call reads it per utterance (#1629). A composer's turn does not:
 * see `composerSelectedContext`.
 */
export function viewerSelectedContext(now: number = Date.now()): SelectedContextRef {
  return captureSelectedContext({
    context: viewBus.getContext(),
    slice: viewBus.getSlice(),
    cards: viewBus.getCards(),
    identity: viewBus.getIdentity(),
    revision: viewBus.getSelectionRevision(),
    now,
  });
}

const NO_CARDS: readonly SelectedCardIdentity[] = [];
const NO_SELECTION = { focusedPath: null, selectedPaths: [] as readonly string[] };

/**
 * What a composer's turn carries about the board (operator, 2026-10-11): never
 * the card the operator happens to have open. The «eye» chip that previewed
 * it and the reference it attached to every message are gone; a task is named
 * by the card's own button (#2420), whose chips the caller adds on top.
 *
 * Still a whole reference — the explicit empty selection, with the same
 * binding evidence and capture time — because a retained generation replays
 * exactly what it was admitted with, and that record is how a replay knows
 * its payload is complete. What goes on the wire is the caller's to omit.
 */
export function composerSelectedContext(now: number = Date.now()): SelectedContextRef {
  return captureSelectedContext({
    context: viewBus.getContext(),
    slice: NO_SELECTION,
    cards: NO_CARDS,
    identity: viewBus.getIdentity(),
    revision: viewBus.getSelectionRevision(),
    now,
  });
}
