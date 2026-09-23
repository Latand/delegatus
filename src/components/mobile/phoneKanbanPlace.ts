"use client";

import { useSyncExternalStore } from "react";

import type { TaskStatus } from "@/lib/tasks/types";

import { DEFAULT_COLUMN, DONE_WINDOW } from "./phoneKanbanModel";

/*
 * Where the operator stands on a project's phone board (#2072 slice 4;
 * docs/design/phone-kanban.md §3.7): the column, each column's scroll offset
 * and how much of Done is open. Kept per project for the session, so opening a
 * conversation and coming back lands on the same column at the same offset,
 * and a fresh load opens on the last column used (Assigned the first time).
 * Switching columns writes no history entry: this is the only record of it.
 */

export interface PhoneKanbanPlace {
  column: TaskStatus;
  offsets: Partial<Record<TaskStatus, number>>;
  doneShown: number;
}

const STATUSES: ReadonlySet<string> = new Set(["inbox", "assigned", "blocked", "done"]);
const PREFIX = "llv.phoneKanban.";
const memory = new Map<string, PhoneKanbanPlace>();
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function fresh(): PhoneKanbanPlace {
  return { column: DEFAULT_COLUMN, offsets: {}, doneShown: DONE_WINDOW };
}

function parse(raw: string | null): PhoneKanbanPlace | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PhoneKanbanPlace>;
    const place = fresh();
    if (typeof value.column === "string" && STATUSES.has(value.column)) place.column = value.column as TaskStatus;
    if (value.offsets && typeof value.offsets === "object") {
      for (const [status, offset] of Object.entries(value.offsets)) {
        if (STATUSES.has(status) && typeof offset === "number" && Number.isFinite(offset) && offset >= 0) place.offsets[status as TaskStatus] = offset;
      }
    }
    if (typeof value.doneShown === "number" && Number.isInteger(value.doneShown) && value.doneShown >= DONE_WINDOW) place.doneShown = value.doneShown;
    return place;
  } catch {
    return null;
  }
}

export function readPlace(project: string): PhoneKanbanPlace {
  const known = memory.get(project);
  if (known) return known;
  const place = parse(storage()?.getItem(PREFIX + project) ?? null) ?? fresh();
  memory.set(project, place);
  return place;
}

/** Session writes wait for the scroll that caused them to pause. */
const PERSIST_MS = 250;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function persist(project: string, now: boolean): void {
  const write = () => {
    pending.delete(project);
    try {
      storage()?.setItem(PREFIX + project, JSON.stringify(memory.get(project)));
    } catch {
      /* Private mode or a full store: the place still holds for this page. */
    }
  };
  const waiting = pending.get(project);
  if (waiting !== undefined) clearTimeout(waiting);
  if (now) write();
  else pending.set(project, setTimeout(write, PERSIST_MS));
}

/** Records a change of place. Only a new column or Done window is announced
    and written at once: an offset changes on every scroll frame, nobody
    renders from it, and the session copy of it waits for the scroll to rest. */
export function writePlace(project: string, patch: Partial<PhoneKanbanPlace>): void {
  const current = readPlace(project);
  const next: PhoneKanbanPlace = {
    column: patch.column ?? current.column,
    offsets: patch.offsets ? { ...current.offsets, ...patch.offsets } : current.offsets,
    doneShown: patch.doneShown ?? current.doneShown,
  };
  memory.set(project, next);
  const announced = next.column !== current.column || next.doneShown !== current.doneShown;
  persist(project, announced || !patch.offsets);
  if (announced) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The project's column, re-read when it changes. */
export function usePhoneKanbanColumn(project: string): TaskStatus {
  return useSyncExternalStore(subscribe, () => readPlace(project).column, () => DEFAULT_COLUMN);
}

/** How many Done cards the operator has opened on this project. */
export function usePhoneKanbanDoneShown(project: string): number {
  return useSyncExternalStore(subscribe, () => readPlace(project).doneShown, () => DONE_WINDOW);
}

/** Tests start from a clean session. */
export function resetPhoneKanbanPlaces(): void {
  for (const waiting of pending.values()) clearTimeout(waiting);
  pending.clear();
  memory.clear();
}
