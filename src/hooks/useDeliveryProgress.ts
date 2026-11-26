"use client";

import { useMemo, useSyncExternalStore } from "react";

import type { DeliveryProgressRecord } from "@/lib/runtime/deliveryProgress";

/** How often unsettled messages re-read what they are waiting on. Under the
    ten seconds in which a stalled send must show why. */
export const DELIVERY_PROGRESS_POLL_MS = 3_000;

/*
 * One poller for the whole tab: every message row and receipt stack that shows
 * an unsettled operation subscribes its id, and one request every few seconds
 * reads them all. The records are written by the delivery queue whether or not
 * anybody reads them; this only shows them. A read that fails keeps the last
 * answer, and a hidden tab reads nothing until it is shown again.
 */

const subscribers = new Map<string, Set<() => void>>();
const observations = new Map<string, { record?: DeliveryProgressRecord; at: number }>();
const retired = new Set<string>();
export interface DeliveryProgressReading {
  records: ReadonlyMap<string, DeliveryProgressRecord>;
  /** When the records were read, so "next check in" is measured from a clock
      that moves with each read. Zero before the first read. */
  readAt: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: AbortController | null = null;

function emit(ids: Iterable<string>): void {
  const affected = new Set<() => void>();
  for (const id of ids) for (const listener of subscribers.get(id) ?? []) affected.add(listener);
  for (const listener of affected) listener();
}

async function poll(): Promise<void> {
  if (subscribers.size === 0 || typeof fetch !== "function") return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const ids = [...subscribers.keys()];
  try {
    const batches = Array.from({ length: Math.ceil(ids.length / 64) }, (_, n) => ids.slice(n * 64, (n + 1) * 64));
    await Promise.allSettled(batches.map(async (batch) => {
      const query = batch.map((id) => `operationId=${encodeURIComponent(id)}`).join("&");
      const response = await fetch(`/api/runtime/delivery-progress?${query}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as { records?: DeliveryProgressRecord[] };
      if (inFlight !== controller || controller.signal.aborted || !Array.isArray(body.records)) return;
      // Publish each answer immediately, even while another batch is pending.
      // Keep a parked reader's last successful observation until another poll can replace it.
      for (const id of retired) observations.delete(id);
      retired.clear();
      const returned = new Map(body.records.map(record => [record.operationId, record]));
      const at = Date.now();
      for (const id of batch) {
        if (subscribers.has(id)) observations.set(id, { record: returned.get(id), at });
      }
      emit(batch);
    }));
  } catch {
    /* Unreachable or aborted: the last answer stands. */
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

function onVisible(): void {
  if (document.visibilityState === "visible") void poll();
}

function subscribeOperations(operationIds: readonly string[], listener: () => void): () => void {
  if (!operationIds.length || typeof document === "undefined") return () => {};
  const fresh = operationIds.filter((id) => !subscribers.has(id));
  for (const id of operationIds) {
    retired.delete(id);
    const listeners = subscribers.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    subscribers.set(id, listeners);
  }
  if (!timer) {
    timer = setInterval(() => void poll(), DELIVERY_PROGRESS_POLL_MS);
    document.addEventListener?.("visibilitychange", onVisible);
  }
  if (fresh.length > 0) void poll();
  return () => {
    for (const id of operationIds) {
      const listeners = subscribers.get(id);
      listeners?.delete(listener);
      if (!listeners?.size) {
        subscribers.delete(id);
        if (observations.has(id)) retired.add(id);
      }
    }
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      inFlight?.abort();
      document.removeEventListener?.("visibilitychange", onVisible);
    }
  };
}

const EMPTY: DeliveryProgressReading = { records: new Map(), readAt: 0 };

/** A batch that answered another operation leaves this snapshot and its read clock intact. */
function selection(ids: string[]) {
  let previous = EMPTY;
  return {
    subscribe: (listener: () => void) => subscribeOperations(ids, listener),
    read() {
      let readAt = 0, count = 0, changed = false;
      for (const id of ids) {
        const current = observations.get(id);
        if (!current) continue;
        readAt = Math.max(readAt, current.at);
        if (current.record) {
          count++;
          if (previous.records.get(id) !== current.record) changed = true;
        }
      }
      if (!changed && readAt === previous.readAt && count === previous.records.size) return previous;
      const records = new Map<string, DeliveryProgressRecord>();
      for (const id of ids) {
        const record = observations.get(id)?.record;
        if (record) records.set(id, record);
      }
      previous = { records, readAt };
      return previous;
    },
  };
}

/** What the delivery queue recorded about these unsettled operations, read
 * while `active` and the page is visible. */
export function useDeliveryProgress(operationIds: readonly string[], active: boolean): DeliveryProgressReading {
  const key = active ? [...new Set(operationIds)].filter(Boolean).sort().join("\n") : "";
  const scoped = useMemo(() => selection(key ? key.split("\n") : []), [key]);
  return useSyncExternalStore(scoped.subscribe, scoped.read, () => EMPTY);
}

/** Tests only. */
export function resetDeliveryProgressPollerForTests(next: ReadonlyMap<string, DeliveryProgressRecord> = new Map(), readAt = 0): void {
  observations.clear();
  retired.clear();
  for (const id of new Set([...subscribers.keys(), ...next.keys()])) {
    observations.set(id, { record: next.get(id), at: readAt });
    if (!subscribers.has(id)) retired.add(id);
  }
  emit(subscribers.keys());
}
