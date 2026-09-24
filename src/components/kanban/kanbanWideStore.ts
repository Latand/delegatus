"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import type { TaskStatus } from "@/lib/tasks/types";

/**
 * Which kanban column takes the wide share (#1841).
 *
 * Assigned is the wide column by default. Widening a shelf (Inbox, Blocked,
 * Done) swaps the shares: that column takes the workspace width and Assigned
 * the shelf's. One wide column at a time. A widened shelf gives the space back
 * by itself when the operator goes back to work in Assigned, unless it is
 * pinned; the pin is remembered per browser and survives a reload.
 */

export const WIDE_STORAGE_KEY = "llv:kanban-wide:v1";
const SHELVES: readonly TaskStatus[] = ["inbox", "blocked", "done"];

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The pinned shelf as stored, or null for none. Anything else reads as none. */
export function parsePinned(raw: string | null): TaskStatus | null {
  return raw && (SHELVES as readonly string[]).includes(raw) ? (raw as TaskStatus) : null;
}

let memoryPin: TaskStatus | null = null;
const listeners = new Set<() => void>();

function readPinned(): TaskStatus | null {
  const store = storage();
  return store ? parsePinned(store.getItem(WIDE_STORAGE_KEY)) : memoryPin;
}

function writePinned(value: TaskStatus | null): void {
  memoryPin = value;
  try {
    const store = storage();
    if (value) store?.setItem(WIDE_STORAGE_KEY, value);
    else store?.removeItem(WIDE_STORAGE_KEY);
  } catch {
    /* private mode: the pin lasts for this page */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === WIDE_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export interface KanbanWideState {
  /** The shelf holding the wide share, or null when Assigned has it. */
  wide: TaskStatus | null;
  pinned: TaskStatus | null;
  /** Give a column the wide share; `assigned` is the default layout. */
  widen(status: TaskStatus): void;
  /** Back to the default layout, unpinning. */
  narrow(): void;
  /** Pin or unpin the wide shelf. */
  togglePin(): void;
  /** Work in Assigned narrows an unpinned wide shelf. */
  workInAssigned(): void;
}

export function useKanbanWide(): KanbanWideState {
  const pinned = useSyncExternalStore(subscribe, readPinned, () => null);
  const [transient, setTransient] = useState<TaskStatus | null>(null);
  const wide = pinned ?? transient;
  const transientRef = useRef(transient);
  transientRef.current = transient;
  const widen = useCallback((status: TaskStatus) => {
    const shelf = status === "assigned" ? null : status;
    setTransient(shelf);
    /* Widening another column unpins. */
    const current = readPinned();
    if (current && current !== shelf) writePinned(null);
  }, []);
  const narrow = useCallback(() => {
    setTransient(null);
    if (readPinned()) writePinned(null);
  }, []);
  const togglePin = useCallback(() => {
    const current = readPinned();
    if (current) {
      /* Unpinning keeps the column wide until the next work in Assigned. */
      setTransient(current);
      writePinned(null);
    } else if (transientRef.current) {
      writePinned(transientRef.current);
    }
  }, []);
  const workInAssigned = useCallback(() => {
    if (!readPinned()) setTransient(null);
  }, []);
  return { wide, pinned, widen, narrow, togglePin, workInAssigned };
}
