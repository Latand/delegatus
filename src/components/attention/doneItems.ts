import { useEffect, useSyncExternalStore } from "react";

import { hiddenTrafficSuspended } from "@/lib/client/hiddenTraffic";
import { DONE_ACK_MAX_KEYS, type DoneAcknowledgeAnswer, type DoneItemsAnswer, type DoneItemV1 } from "@/lib/done/types";

/*
 * The «Готово» items the Viewer shows (docs/design/done-section.md §3, §5):
 * read on mount, every 30 s (a hidden desktop tab included, because S5 and the
 * deploy and limit faults sound from this feed while the operator works in
 * another tab, docs/design/sound-redesign.md §4.3; a hidden phone reads
 * nothing, #1994), on return to the tab and after each acknowledgement, with the click drawn at once. An acknowledgement leaves
 * every count in the frame it is clicked and stays drawn that way until the
 * read carries the server's own answer, or a bound passes; another device
 * sees it on its next read.
 */

const POLL_MS = 30_000;
/** How long a layered acknowledgement outlives a read that never reflected it. */
const LAYER_TTL_MS = 60_000;
const ROUTE = "/api/attention/done";
const EMPTY: readonly DoneItemV1[] = [];

let server: readonly DoneItemV1[] = EMPTY;
/* Reads are numbered as they leave; one that comes back behind a later read
   that was already applied carries an older server, so it is dropped. The
   read an acknowledgement sends after its write always leaves later than any
   read in flight before it. */
let reads = 0;
let applied = 0;
/* Acknowledged (true) or taken back (false) on this device, ahead of the read. */
const layer = new Map<string, { acknowledged: boolean; item: DoneItemV1; until: number }>();
let snapshot: readonly DoneItemV1[] = EMPTY;
const listeners = new Set<() => void>();

const newestFirst = (left: DoneItemV1, right: DoneItemV1) => Date.parse(right.at) - Date.parse(left.at) || left.key.localeCompare(right.key);

function recompute(now = Date.now()): void {
  for (const [key, entry] of layer) if (entry.until <= now) layer.delete(key);
  const shown = server.filter((item) => layer.get(item.key)?.acknowledged !== true);
  const keys = new Set(shown.map((item) => item.key));
  for (const entry of layer.values()) if (!entry.acknowledged && !keys.has(entry.item.key)) shown.push(entry.item);
  snapshot = shown.length ? shown.sort(newestFirst) : EMPTY;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export async function refreshDoneItems(): Promise<void> {
  const read = ++reads;
  let body: DoneItemsAnswer;
  try {
    const response = await fetch(ROUTE, { cache: "no-store" });
    if (!response.ok) return;
    body = await response.json() as DoneItemsAnswer;
  } catch {
    return;
  }
  if (!Array.isArray(body?.items) || read < applied) return;
  applied = read;
  server = body.items;
  /* A layer the read already agrees with is done. */
  const present = new Set(server.map((item) => item.key));
  for (const [key, entry] of layer) if (entry.acknowledged !== present.has(key)) layer.delete(key);
  recompute();
}

export type DoneAcknowledgeOutcome = { ok: true } | { ok: false; error: string };

/** The operator's «Прийняти» (or «Повернути» with `undo`). */
export async function acknowledgeDone(items: readonly DoneItemV1[], options: { undo?: boolean; surface: "desktop" | "phone" }): Promise<DoneAcknowledgeOutcome> {
  if (!items.length) return { ok: true };
  const undo = options.undo === true;
  const until = Date.now() + LAYER_TTL_MS;
  for (const item of items) layer.set(item.key, { acknowledged: !undo, item, until });
  recompute();
  const unlayer = () => {
    for (const item of items) layer.delete(item.key);
    recompute();
  };
  try {
    for (let start = 0; start < items.length; start += DONE_ACK_MAX_KEYS) {
      const keys = items.slice(start, start + DONE_ACK_MAX_KEYS).map((item) => item.key);
      const response = await fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys, undo, surface: options.surface }) });
      const answer = await response.json().catch(() => null) as (DoneAcknowledgeAnswer & { error?: string }) | null;
      if (!response.ok || answer?.ok !== true) {
        unlayer();
        return { ok: false, error: answer?.error ?? `HTTP ${response.status}` };
      }
    }
  } catch (error) {
    unlayer();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  void refreshDoneItems();
  return { ok: true };
}

let pollers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const onTick = () => {
  if (!hiddenTrafficSuspended()) void refreshDoneItems();
};
const onVisible = () => {
  if (document.visibilityState === "visible") void refreshDoneItems();
};

/** Whether a read has answered yet: an empty list before it is no answer. */
export function useDoneItemsLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => applied > 0, () => false);
}

/** The items still waiting, newest first; the one reader that polls. */
export function useDoneItems(enabled = true): readonly DoneItemV1[] {
  const items = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
  useEffect(() => {
    if (!enabled) return;
    pollers += 1;
    if (pollers === 1) {
      void refreshDoneItems();
      timer = setInterval(onTick, POLL_MS);
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      pollers -= 1;
      if (pollers > 0) return;
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
  return items;
}

export function resetDoneItemsForTests(): void {
  server = EMPTY;
  reads = 0;
  applied = 0;
  layer.clear();
  snapshot = EMPTY;
}
