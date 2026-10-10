"use client";

import { useSyncExternalStore } from "react";

import type { PrototypeReviewNotice, PrototypeReviewSummary } from "@/lib/prototypeReview/types";

/*
 * Two small page-wide facts the review's three surfaces share.
 *
 * The waiting notices: the page's one task poll already carries them, and the
 * orchestrator's composer has no task list of its own, so the host publishes
 * them here and the composer's row reads them by project.
 *
 * The rounds this browser has opened: a round the operator looked at and left
 * undecided keeps its mark on the card and loses the highlight that asked for
 * the first look.
 */

const SEEN_KEY = "llv.prototypeReview.seen";
/** Rounds remembered as opened; the oldest are forgotten past this many. */
const SEEN_MAX = 200;
const EMPTY: readonly PrototypeReviewNotice[] = [];

let notices: readonly PrototypeReviewNotice[] = EMPTY;
let seen: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishPrototypeNotices(next: readonly PrototypeReviewNotice[]): void {
  const same = next.length === notices.length && next.every((notice, at) => notice.id === notices[at]!.id && notice.title === notices[at]!.title && notice.roundTitle === notices[at]!.roundTitle);
  if (same) return;
  notices = next.length ? next : EMPTY;
  emit();
}

function readSeen(): ReadonlySet<string> {
  if (seen) return seen;
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as unknown;
    seen = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    seen = new Set();
  }
  return seen;
}

export function markPrototypeReviewSeen(reviewId: string): void {
  const held = readSeen();
  if (held.has(reviewId)) return;
  const next = [...held, reviewId].slice(-SEEN_MAX);
  seen = new Set(next);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)); } catch { /* a private window keeps it for the page's life */ }
  emit();
}

export function usePrototypeNoticesFor(project: string | null): readonly PrototypeReviewNotice[] {
  const all = useSyncExternalStore(subscribe, () => notices, () => EMPTY);
  if (!project) return EMPTY;
  return all.some((notice) => notice.project !== project) ? all.filter((notice) => notice.project === project) : all;
}

const NONE_SEEN: ReadonlySet<string> = new Set();
export function usePrototypeReviewsSeen(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, readSeen, () => NONE_SEEN);
}

/** What the card's button says about a task's review. */
export type PrototypeButtonState = "ready" | "opened" | "decided" | "unsent" | "hidden";

export function prototypeButtonState(summary: PrototypeReviewSummary | undefined, seenIds: ReadonlySet<string>): PrototypeButtonState | null {
  if (!summary) return null;
  if (summary.waitingReviewId && summary.waitingDismissal) return "hidden";
  if (summary.waitingReviewId) return seenIds.has(summary.waitingReviewId) ? "opened" : "ready";
  if (!summary.decision) return null;
  return summary.decision.delivery === "failed" || summary.decision.delivery === "uncertain" ? "unsent" : "decided";
}

/** Tests only: a clean store, memory and storage both. */
export function resetPrototypeReviewStoreForTests(): void {
  notices = EMPTY;
  seen = null;
  try { localStorage.removeItem(SEEN_KEY); } catch { /* none */ }
  emit();
}
