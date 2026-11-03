"use client";

import { useMemo, useSyncExternalStore } from "react";

export const TIMELINE_HOURS = [6, 12, 24, 72, 168] as const;
export interface TimelinePreference {
  view: "board" | "timeline";
  hours: number;
  expanded: Readonly<Record<string, boolean>>;
}
const EMPTY: TimelinePreference = { view: "board", hours: 24, expanded: {} };
export const timelineStorageKey = (project: string) => `llv:board-timeline:v1:${project}`;

export function parseTimelinePreference(raw: string | null): TimelinePreference {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return EMPTY;
    const expanded = Object.fromEntries(Object.entries(value.expanded ?? {}).filter(([, open]) => typeof open === "boolean")) as Record<string, boolean>;
    return { view: value.view === "timeline" ? "timeline" : "board", hours: TIMELINE_HOURS.includes(value.hours) ? value.hours : 24, expanded };
  } catch { return EMPTY; }
}

/** One project per record. A fresh instance reads the exact output of every write. */
export class BoardTimelineStore {
  private value = EMPTY;
  private raw: string | null | undefined;
  private listeners = new Set<() => void>();
  readonly key: string;
  constructor(project: string, private storage: Pick<Storage, "getItem" | "setItem"> | null) { this.key = timelineStorageKey(project); }
  snapshot = (): TimelinePreference => {
    try {
      const raw = this.storage?.getItem(this.key) ?? null;
      if (raw !== this.raw) { this.raw = raw; this.value = parseTimelinePreference(raw); }
    } catch { /* Unavailable storage keeps this page's choices. */ }
    return this.value;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const changed = (event: StorageEvent) => { if (event.key === this.key || event.key === null) listener(); };
    window.addEventListener("storage", changed);
    return () => { this.listeners.delete(listener); window.removeEventListener("storage", changed); };
  };
  update = (patch: Partial<TimelinePreference>) => {
    const next = { ...this.snapshot(), ...patch };
    const raw = JSON.stringify(next);
    this.value = next;
    // Cache the persisted bytes only after the write succeeds. A denied write
    // still leaves an immediately usable choice for this mounted surface.
    try { this.storage?.setItem(this.key, raw); this.raw = this.storage ? raw : null; }
    catch { this.storage = null; this.raw = null; }
    for (const listener of this.listeners) listener();
  };
}

export function timelineExpanded(preference: TimelinePreference, taskId: string, live: boolean): boolean {
  return Object.hasOwn(preference.expanded, taskId) ? preference.expanded[taskId]! : live;
}

export function useBoardTimeline(project: string) {
  const store = useMemo(() => {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* SSR or private mode */ }
    return new BoardTimelineStore(project, storage);
  }, [project]);
  const preference = useSyncExternalStore(store.subscribe, store.snapshot, () => EMPTY);
  return { preference, update: store.update };
}
