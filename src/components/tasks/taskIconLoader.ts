"use client";

import { useEffect, useSyncExternalStore } from "react";

import type { TaskIconNode } from "@/lib/tasks/taskIconNodes";

/**
 * The browser half of the task icon loader (#2102). Every icon a page draws
 * asks for its drawing here; the names asked for in one render go to
 * `/api/task-icons` as one request, and each answer is kept for the life of
 * the page. Only the icons in use are ever fetched, and the browser never
 * carries lucide's whole name → chunk table.
 *
 * A name's drawing is `undefined` while unknown, a node once loaded, and null
 * when lucide has no such icon. A request that failed leaves the names
 * unknown and asks again a little later, a few times at most.
 */

type Fetcher = (names: string[]) => Promise<Record<string, unknown>>;

const BATCH = 100;
const RETRY_MS = 4_000;
const MAX_ATTEMPTS = 4;
/** The SVG children lucide draws with; anything else in an answer is dropped. */
const TAGS: ReadonlySet<string> = new Set(["circle", "ellipse", "g", "line", "path", "polygon", "polyline", "rect"]);

const cache = new Map<string, TaskIconNode | null>();
const queued = new Set<string>();
const inFlight = new Set<string>();
const attempts = new Map<string, number>();
const listeners = new Set<() => void>();
let flushScheduled = false;

const fetchIcons: Fetcher = async (names) => {
  const response = await fetch(`/api/task-icons?names=${encodeURIComponent(names.join(","))}`);
  if (!response.ok) throw new Error(`task icons answered ${response.status}`);
  const body = (await response.json()) as { icons?: Record<string, unknown> };
  return body.icons ?? {};
};
let fetcher: Fetcher = fetchIcons;

/** An answer's drawing, kept only when it is the shape lucide draws. */
function iconNode(value: unknown): TaskIconNode | null {
  if (!Array.isArray(value)) return null;
  const node: TaskIconNode = [];
  for (const item of value) {
    if (!Array.isArray(item) || typeof item[0] !== "string" || !TAGS.has(item[0]) || !item[1] || typeof item[1] !== "object") continue;
    const attrs = Object.fromEntries(Object.entries(item[1] as Record<string, unknown>).filter(([, attr]) => typeof attr === "string")) as Record<string, string>;
    /* lucide keys every child; the renderer lists them under that key. */
    node.push([item[0] as TaskIconNode[number][0], { key: `${node.length}`, ...attrs }]);
  }
  return node.length ? node : null;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function schedule(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    void flush();
  });
}

async function flush(): Promise<void> {
  const names = [...queued].sort();
  queued.clear();
  for (let start = 0; start < names.length; start += BATCH) {
    const batch = names.slice(start, start + BATCH);
    for (const name of batch) inFlight.add(name);
    try {
      const icons = await fetcher(batch);
      for (const name of batch) cache.set(name, iconNode(icons[name]));
    } catch {
      /* Unknown rather than missing: the icon may well exist, so it is asked
         for again rather than drawn as the fallback for good. */
      const retry = batch.filter((name) => (attempts.get(name) ?? 0) < MAX_ATTEMPTS);
      for (const name of batch) attempts.set(name, (attempts.get(name) ?? 0) + 1);
      if (retry.length) {
        setTimeout(() => {
          for (const name of retry) if (!cache.has(name)) queued.add(name);
          schedule();
        }, RETRY_MS);
      }
    } finally {
      for (const name of batch) inFlight.delete(name);
      emit();
    }
  }
}

/** Ask for `name`'s drawing; one request carries every name asked for together. */
export function requestTaskIcon(name: string): void {
  if (!name || cache.has(name) || inFlight.has(name) || queued.has(name)) return;
  queued.add(name);
  schedule();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `name`'s drawing, asked for on first use. A null name asks for nothing. */
export function useTaskIconNode(name: string | null): TaskIconNode | null | undefined {
  const node = useSyncExternalStore(subscribe, () => (name ? cache.get(name) : undefined), () => undefined);
  useEffect(() => {
    if (name) requestTaskIcon(name);
  }, [name]);
  return node;
}

/** Tests: answer requests with `next` and forget every drawing held. */
export function resetTaskIconLoaderForTests(next?: Fetcher): void {
  cache.clear();
  queued.clear();
  inFlight.clear();
  attempts.clear();
  fetcher = next ?? fetchIcons;
}
