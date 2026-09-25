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
 *
 * Version 2 (#1841) adds where the seat sits, above the columns or at their
 * left, and how wide it was dragged there. Both are one choice per browser;
 * the v1 height and collapsed flags are read once and carried over.
 *
 * Both widths are the project's own (#2179): the seat on top can be dragged
 * wider or narrower on its right edge, and a project the operator never sized
 * keeps the default. The side width once stored for every project is what a
 * project with no side width of its own starts from.
 */

export const SEAT_STORAGE_KEY = "llv:kanban-seat:v2";
export const SEAT_STORAGE_KEY_V1 = "llv:kanban-seat:v1";
export const SEAT_MIN_HEIGHT = 160;
/** Bumped when the seat's default height changes; older dragged heights are dropped. */
export const SEAT_HEIGHT_VERSION = 2;
export const SEAT_SIDE_DEFAULT_WIDTH = 380;
export const SEAT_SIDE_MIN_WIDTH = 320;
export const SEAT_SIDE_MAX_WIDTH = 560;
/** The seat on top: never narrower than its header's one row at the 768 px
    board, never wider than the board (the stylesheet holds that bound). */
export const SEAT_TOP_MIN_WIDTH = 560;

export type SeatPlacement = "top" | "side";
export const SEAT_KEY_STEP = 40;
/** Below this window height a project the operator never set starts collapsed. */
export const SEAT_SHORT_WINDOW = 800;

interface SeatRecord {
  /** Pixel height of the expanded seat, or null for the default. */
  height: number | null;
  collapsed: Record<string, boolean>;
  placement: SeatPlacement;
  /** Pixel width of the side placement before widths were per project, or null. */
  width: number | null;
  /** Each project's dragged width of the seat on top. */
  topWidths: Record<string, number>;
  /** Each project's dragged width of the seat at the side. */
  sideWidths: Record<string, number>;
}

const EMPTY: SeatRecord = { height: null, collapsed: {}, placement: "top", width: null, topWidths: {}, sideWidths: {} };

function widths(value: unknown, clamp: (width: number) => number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [project, width] of Object.entries(value)) if (typeof width === "number" && Number.isFinite(width)) out[project] = clamp(width);
  return out;
}

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
    /* A height dragged before the default grew to 75% (role frames) was sized
       against the old 30vh default; it is dropped once so the new default shows.
       Every write marks its height as current. */
    const current = (value as { heightV?: unknown }).heightV === SEAT_HEIGHT_VERSION;
    const height = current && typeof value.height === "number" && Number.isFinite(value.height) ? value.height : null;
    const width = typeof value.width === "number" && Number.isFinite(value.width) ? clampSeatWidth(value.width) : null;
    const collapsed: Record<string, boolean> = {};
    if (value.collapsed && typeof value.collapsed === "object") {
      for (const [project, flag] of Object.entries(value.collapsed)) if (typeof flag === "boolean") collapsed[project] = flag;
    }
    return {
      height, collapsed, placement: value.placement === "side" ? "side" : "top", width,
      topWidths: widths(value.topWidths, clampSeatTopWidth), sideWidths: widths(value.sideWidths, clampSeatWidth),
    };
  } catch {
    return EMPTY;
  }
}

/** The side placement's width, inside its 320–560 px range. */
export function clampSeatWidth(width: number): number {
  return Math.round(Math.min(SEAT_SIDE_MAX_WIDTH, Math.max(SEAT_SIDE_MIN_WIDTH, width)));
}

/** The seat on top's width: at least its minimum, and at most what the board
    holds when the caller knows it. */
export function clampSeatTopWidth(width: number, available = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.max(SEAT_TOP_MIN_WIDTH, Math.min(available, width)));
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
  const store = storage();
  let raw = store?.getItem(SEAT_STORAGE_KEY) ?? null;
  /* v1 → v2, once: the height and the collapsed flags carry over and the
     placement starts on top, where v1 always drew it. */
  if (raw === null && store) {
    const legacy = store.getItem(SEAT_STORAGE_KEY_V1);
    if (legacy !== null) {
      const { height, collapsed } = parse(legacy);
      raw = JSON.stringify({ height, collapsed, placement: "top", width: null });
      try { store.setItem(SEAT_STORAGE_KEY, raw); } catch { /* read-only storage: carry it in memory */ }
    }
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

function write(next: SeatRecord): void {
  try {
    storage()?.setItem(SEAT_STORAGE_KEY, JSON.stringify({ ...next, heightV: SEAT_HEIGHT_VERSION }));
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

export function seatCollapsed(record: Pick<SeatRecord, "collapsed">, project: string, windowHeight: number): boolean {
  const chosen = record.collapsed[project];
  return chosen ?? windowHeight < SEAT_SHORT_WINDOW;
}

export interface KanbanSeatState {
  collapsed: boolean;
  /** The operator's height, or null for the default. */
  height: number | null;
  placement: SeatPlacement;
  /** The side placement's width, the dragged one or the default. */
  width: number;
  /** The seat on top's dragged width in this project, or null for the default. */
  topWidth: number | null;
  toggle(): void;
  setHeight(height: number): void;
  setWidth(width: number): void;
  /** Stores this project's width of the seat on top; null goes back to the default. */
  setTopWidth(width: number | null, available?: number): void;
  togglePlacement(): void;
}

/** Expand a project's seat, for a surface that hands the operator to its
    create draft (the setup guide's tour, #1876 slice 3). */
export function expandKanbanSeat(project: string): void {
  if (typeof window === "undefined") return;
  const current = read();
  write({ ...current, collapsed: { ...current.collapsed, [project]: false } });
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
  const setWidth = useCallback((width: number) => {
    const current = read();
    write({ ...current, sideWidths: { ...current.sideWidths, [project]: clampSeatWidth(width) } });
  }, [project]);
  const setTopWidth = useCallback((width: number | null, available?: number) => {
    const current = read();
    const topWidths = { ...current.topWidths };
    if (width === null) delete topWidths[project];
    else topWidths[project] = clampSeatTopWidth(width, available);
    write({ ...current, topWidths });
  }, [project]);
  const togglePlacement = useCallback(() => {
    const current = read();
    write({ ...current, placement: current.placement === "side" ? "top" : "side" });
  }, []);
  return {
    collapsed,
    height: record.height,
    placement: record.placement,
    width: record.sideWidths[project] ?? record.width ?? SEAT_SIDE_DEFAULT_WIDTH,
    topWidth: record.topWidths[project] ?? null,
    toggle,
    setHeight,
    setWidth,
    setTopWidth,
    togglePlacement,
  };
}

/* ── The seat's state for the header toggle (#1841) ─────────────────────── */

/** What the header's Orchestrator toggle shows of the seat: the state's tone
    and word, and whether a reply is unread. Published by the seat panel. */
export interface SeatToggleSignal {
  tone: "working" | "needs" | "failed" | "accent" | "quiet";
  label: string;
  unread: boolean;
}

const signals = new Map<string, SeatToggleSignal>();
const signalListeners = new Set<() => void>();

export function publishSeatSignal(project: string, signal: SeatToggleSignal | null): void {
  const previous = signals.get(project);
  if (signal === null) {
    if (!previous) return;
    signals.delete(project);
  } else {
    if (previous && previous.tone === signal.tone && previous.label === signal.label && previous.unread === signal.unread) return;
    signals.set(project, signal);
  }
  for (const listener of signalListeners) listener();
}

const subscribeSignals = (listener: () => void) => {
  signalListeners.add(listener);
  return () => { signalListeners.delete(listener); };
};

export function useSeatSignal(project: string | null): SeatToggleSignal | null {
  return useSyncExternalStore(subscribeSignals, () => (project ? signals.get(project) ?? null : null), () => null);
}
