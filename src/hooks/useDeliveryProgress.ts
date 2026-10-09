"use client";

import { useEffect, useSyncExternalStore } from "react";

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

const subscribers = new Map<string, number>();
const listeners = new Set<() => void>();
export interface DeliveryProgressReading {
  records: ReadonlyMap<string, DeliveryProgressRecord>;
  /** When the records were read, so "next check in" is measured from a clock
      that moves with each read. Zero before the first read. */
  readAt: number;
}

let reading: DeliveryProgressReading = { records: new Map(), readAt: 0 };
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: AbortController | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

async function poll(): Promise<void> {
  if (subscribers.size === 0 || typeof fetch !== "function") return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const ids = [...subscribers.keys()].slice(0, 64);
  try {
    const query = ids.map((id) => `operationId=${encodeURIComponent(id)}`).join("&");
    const response = await fetch(`/api/runtime/delivery-progress?${query}`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { records?: DeliveryProgressRecord[] };
    if (controller.signal.aborted || !Array.isArray(body.records)) return;
    reading = { records: new Map(body.records.map((record) => [record.operationId, record])), readAt: Date.now() };
    emit();
  } catch {
    /* Unreachable or aborted: the last answer stands. */
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

function onVisible(): void {
  if (document.visibilityState === "visible") void poll();
}

function subscribeOperations(operationIds: readonly string[]): () => void {
  const fresh = operationIds.filter((id) => !subscribers.has(id));
  for (const id of operationIds) subscribers.set(id, (subscribers.get(id) ?? 0) + 1);
  if (!timer) {
    timer = setInterval(() => void poll(), DELIVERY_PROGRESS_POLL_MS);
    document.addEventListener?.("visibilitychange", onVisible);
  }
  if (fresh.length > 0) void poll();
  return () => {
    for (const id of operationIds) {
      const count = (subscribers.get(id) ?? 1) - 1;
      if (count <= 0) subscribers.delete(id);
      else subscribers.set(id, count);
    }
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      inFlight?.abort();
      document.removeEventListener?.("visibilitychange", onVisible);
    }
  };
}

function subscribeRecords(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const EMPTY: DeliveryProgressReading = { records: new Map(), readAt: 0 };

/**
 * What the delivery queue recorded about these unsettled operations, read
 * while `active` and the page is visible.
 */
export function useDeliveryProgress(operationIds: readonly string[], active: boolean): DeliveryProgressReading {
  const key = active ? [...new Set(operationIds)].filter(Boolean).sort().join("\n") : "";
  useEffect(() => {
    if (!key || typeof window === "undefined") return;
    return subscribeOperations(key.split("\n"));
  }, [key]);
  const current = useSyncExternalStore(subscribeRecords, () => reading, () => EMPTY);
  return key ? current : EMPTY;
}

/** Tests only. */
export function resetDeliveryProgressPollerForTests(next: ReadonlyMap<string, DeliveryProgressRecord> = new Map(), readAt = 0): void {
  reading = { records: next, readAt };
  emit();
}
