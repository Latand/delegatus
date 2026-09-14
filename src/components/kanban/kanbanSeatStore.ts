"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The orchestrator seat above the kanban board (#1695 K3), as this device
 * keeps it: how tall the operator dragged it, and whether it is collapsed to
 * its header in a project. Both are presentation of one screen, so they live
 * in this browser's storage and never in the shared board preferences another
 * device reads.
 *
 * The seat has no hide. Collapsed is the smallest it gets, and a window under
 * 800 px tall starts there until the operator says otherwise.
 */

export const SEAT_STORAGE_KEY = "llv:kanban-seat:v1";
export const SEAT_MIN_HEIGHT = 200;
export const SEAT_KEY_STEP = 40;
/** Below this window height a project the operator never set starts collapsed. */
export const SEAT_SHORT_WINDOW = 800;

interface SeatRecord {
  /** Pixel height of the expanded seat, or null for the default. */
  height: number | null;
  collapsed: Record<string, boolean>;
}

const EMPTY: SeatRecord = { height: null, collapsed: {} };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): SeatRecord {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<SeatRecord>;
    const height = typeof value.height === "number" && Number.isFinite(value.height) ? value.height : null;
    const collapsed: Record<string, boolean> = {};
    if (value.collapsed && typeof value.collapsed === "object") {
      for (const [project, flag] of Object.entries(value.collapsed)) if (typeof flag === "boolean") collapsed[project] = flag;
    }
    return { height, collapsed };
  } catch {
    return EMPTY;
  }
}

/** The tallest the seat may be dragged: three quarters of the window. */
export function seatMaxHeight(windowHeight: number): number {
  return Math.max(SEAT_MIN_HEIGHT, Math.round(windowHeight * 0.75));
}

export function clampSeatHeight(height: number, windowHeight: number): number {
  return Math.round(Math.min(seatMaxHeight(windowHeight), Math.max(SEAT_MIN_HEIGHT, height)));
}

let cachedRaw: string | null | undefined;
let cached: SeatRecord = EMPTY;
const listeners = new Set<() => void>();

function read(): SeatRecord {
  const raw = storage()?.getItem(SEAT_STORAGE_KEY) ?? null;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

function write(next: SeatRecord): void {
  try {
    storage()?.setItem(SEAT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the seat still works for this page */
    cachedRaw = undefined;
    cached = next;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SEAT_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const serverSnapshot = () => EMPTY;

export function seatCollapsed(record: SeatRecord, project: string, windowHeight: number): boolean {
  const chosen = record.collapsed[project];
  return chosen ?? windowHeight < SEAT_SHORT_WINDOW;
}

export interface KanbanSeatState {
  collapsed: boolean;
  /** The operator's height, or null for the default. */
  height: number | null;
  toggle(): void;
  setHeight(height: number): void;
}

export function useKanbanSeat(project: string): KanbanSeatState {
  const record = useSyncExternalStore(subscribe, read, serverSnapshot);
  const windowHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const collapsed = seatCollapsed(record, project, windowHeight);
  const toggle = useCallback(() => {
    const current = read();
    const height = typeof window === "undefined" ? 900 : window.innerHeight;
    write({ ...current, collapsed: { ...current.collapsed, [project]: !seatCollapsed(current, project, height) } });
  }, [project]);
  const setHeight = useCallback((height: number) => {
    write({ ...read(), height: clampSeatHeight(height, typeof window === "undefined" ? 900 : window.innerHeight) });
  }, []);
  return { collapsed, height: record.height, toggle, setHeight };
}
