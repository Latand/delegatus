"use client";

import { useEffect, useSyncExternalStore } from "react";

import type { TaskSpendResponse, TaskSpendSummary } from "@/lib/activity/taskLimitSpendTypes";

/**
 * Each task's approximate limit spend, for the marks on the cards' state lines
 * (docs/design/task-limit-spend.md §6). One store for the page, as the album
 * counts have: every mounted card registers its task, and the store asks for
 * all of them in one request, shortly after the set changes and then on the
 * board's slow beat. The Viewer reads a persisted aggregate by primary key, so
 * a board of a hundred cards costs one small request.
 */

const REFRESH_MS = 45_000;
const SETTLE_MS = 250;
/** The route answers at most this many ids per request. */
const BATCH = 400;

const watchers = new Map<string, number>();
const summaries = new Map<string, TaskSpendSummary>();
const listeners = new Set<() => void>();
type Clock = { set: (run: () => void, delay: number) => unknown; clear: (handle: unknown) => void };
const PAGE_CLOCK: Clock = { set: (run, delay) => setTimeout(run, delay), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
let clock = PAGE_CLOCK;
let timer: unknown = null;
let timerDelay: number | null = null;
let inflight = false;
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function schedule(delay: number): void {
  if (timer !== null) clock.clear(timer);
  timerDelay = delay;
  timer = clock.set(() => {
    timer = null;
    timerDelay = null;
    void refresh();
  }, delay);
}

function cancel(): void {
  if (timer !== null) clock.clear(timer);
  timer = null;
  timerDelay = null;
}

async function refresh(): Promise<void> {
  const ids = [...watchers.keys()];
  if (!ids.length) return;
  if (inflight) {
    schedule(SETTLE_MS);
    return;
  }
  inflight = true;
  /* The cache holds the watched tasks: one a card stopped watching keeps its
     answer until this pass, so a card that remounts does not blink. */
  for (const id of summaries.keys()) if (!watchers.has(id)) summaries.delete(id);
  try {
    for (let at = 0; at < ids.length; at += BATCH) {
      const batch = ids.slice(at, at + BATCH);
      const res = await fetch(`/api/task-spend?ids=${batch.map(encodeURIComponent).join(",")}`, { cache: "no-store" });
      if (!res.ok) continue;
      const body = (await res.json()) as Partial<TaskSpendResponse>;
      for (const [id, summary] of Object.entries(body.tasks ?? {})) summaries.set(id, summary);
      notify();
    }
  } catch {
    /* The next beat asks again; a card keeps what it last showed. */
  } finally {
    inflight = false;
    /* A card that mounted while this request was out was not in it: ask for it
       after the settle delay, not on the next slow beat. */
    const asked = new Set(ids);
    if ([...watchers.keys()].some((id) => !asked.has(id))) schedule(SETTLE_MS);
    else if (watchers.size) schedule(REFRESH_MS);
  }
}

function watch(taskId: string): () => void {
  const had = watchers.has(taskId);
  watchers.set(taskId, (watchers.get(taskId) ?? 0) + 1);
  if (!had) schedule(SETTLE_MS);
  return () => {
    const left = (watchers.get(taskId) ?? 1) - 1;
    if (left > 0) watchers.set(taskId, left);
    else watchers.delete(taskId);
    if (!watchers.size) cancel();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One task's spend, kept current while the caller is mounted; null until the Viewer has answered. */
export function useTaskSpend(taskId: string | null): TaskSpendSummary | null {
  useEffect(() => (taskId ? watch(taskId) : undefined), [taskId]);
  useSyncExternalStore(subscribe, () => version, () => 0);
  return taskId ? summaries.get(taskId) ?? null : null;
}

/** Test seam: forget every summary and watcher. */
export function resetTaskSpend(): void {
  watchers.clear();
  summaries.clear();
  cancel();
  inflight = false;
  notify();
}

/** Test seam: arm refreshes on this clock instead of the page's timers; null restores them. */
export function setTaskSpendClock(next: Clock | null): void {
  cancel();
  clock = next ?? PAGE_CLOCK;
}

/** Test seam: run the pending refresh now instead of on its timer, and wait for its answer. */
export async function flushTaskSpend(): Promise<void> {
  cancel();
  await refresh();
}

/** Test seam: the delay of the armed refresh, or null when none is armed. */
export function pendingTaskSpendRefresh(): number | null {
  return timerDelay;
}
