"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * How many pictures each task's album holds and how many are new, for the
 * album buttons on the task cards. One store for the page: every mounted
 * button registers its task, and the store asks for all of them in one
 * request — shortly after the set changes and then on a slow beat — so a board
 * of a hundred cards costs one request, never a hundred.
 */

export interface AlbumSummary {
  count: number;
  newCount: number;
  newestAt: number | null;
}

const REFRESH_MS = 45_000;
const SETTLE_MS = 250;

const watchers = new Map<string, number>();
const summaries = new Map<string, AlbumSummary>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = false;
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function schedule(delay: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refresh();
  }, delay);
}

async function refresh(): Promise<void> {
  const ids = [...watchers.keys()];
  if (!ids.length) return;
  if (inflight) {
    schedule(SETTLE_MS);
    return;
  }
  inflight = true;
  try {
    const res = await fetch(`/api/task-album?ids=${ids.map(encodeURIComponent).join(",")}`, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { tasks?: Record<string, AlbumSummary> };
      for (const [id, summary] of Object.entries(body.tasks ?? {})) summaries.set(id, summary);
      notify();
    }
  } catch {
    /* The next beat asks again. */
  } finally {
    inflight = false;
    if (watchers.size) schedule(REFRESH_MS);
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
    if (!watchers.size && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The album summary of one task, kept current while the caller is mounted. */
export function useTaskAlbumSummary(taskId: string | null): AlbumSummary | null {
  useEffect(() => (taskId ? watch(taskId) : undefined), [taskId]);
  useSyncExternalStore(subscribe, () => version, () => 0);
  return taskId ? summaries.get(taskId) ?? null : null;
}

/** The album was opened: its pictures are seen here at once, and the
    Viewer's answer confirms it on the next beat. */
export function albumOpened(taskId: string, count?: number): void {
  const held = summaries.get(taskId);
  summaries.set(taskId, { count: count ?? held?.count ?? 0, newCount: 0, newestAt: held?.newestAt ?? null });
  notify();
}

/** Test seam: forget every summary and watcher. */
export function resetAlbumSummaries(): void {
  watchers.clear();
  summaries.clear();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  inflight = false;
  notify();
}
