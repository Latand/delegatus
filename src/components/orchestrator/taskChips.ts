"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { MAX_SELECTED_TASKS, type SelectedTaskRef } from "@/lib/selection/selectedContext";
import { designatedManagerConversationId } from "@/components/voice/managerIdentity";
import type { TaskColor } from "@/lib/tasks/types";

/**
 * The task references an operator has attached to a project's orchestrator
 * composer, as this tab keeps them.
 *
 * A card's «Ask the orchestrator» button adds a chip here; the composer of that
 * project's seat draws the list above its input and carries it with the next
 * send as `selectedContext.tasks`. The chips are references the operator has
 * not sent yet, so they live beside the draft: in memory, written through to
 * this tab's session storage, which is where the composer keeps the draft they
 * belong to. A reload brings both back; closing the tab drops both.
 *
 * One module-level store rather than props: the button sits on a board card and
 * the composer sits in the seat, two subtrees with no parent between them that
 * could carry a prop, and the card already reaches the seat the same way for
 * the tick panel (`openSeatTick`).
 */

export interface TaskChip {
  id: string;
  /** The card's title when the chip was added: what the operator read. */
  title: string;
  /** The card's colour label, drawn as the chip's edge. */
  color?: TaskColor | null;
  /** The card's icon name, drawn before the title. */
  icon?: string | null;
}

/** Chips one message can carry: what the wire accepts, so none is dropped unsent. */
export const MAX_TASK_CHIPS = MAX_SELECTED_TASKS;

const NONE: readonly TaskChip[] = Object.freeze([]);
const byProject = new Map<string, readonly TaskChip[]>();
/** Projects whose stored list has been read into `byProject` (or cleared). */
const loaded = new Set<string>();
const listeners = new Set<() => void>();
const focusListeners = new Set<(project: string) => void>();
const openListeners = new Set<(request: TaskChipOpenRequest) => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export const taskChipsStorageKey = (project: string): string => `llv:task-chips:v1:${project}`;

function storage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; }
  catch { return null; }
}

function stored(project: string): readonly TaskChip[] {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(taskChipsStorageKey(project)) ?? "[]");
    if (!Array.isArray(value)) return NONE;
    const seen = new Set<string>();
    const chips: TaskChip[] = [];
    for (const entry of value) {
      if (chips.length >= MAX_TASK_CHIPS) break;
      if (!entry || typeof entry !== "object") continue;
      const { id, title, color, icon } = entry as Record<string, unknown>;
      if (typeof id !== "string" || !id || typeof title !== "string" || seen.has(id)) continue;
      seen.add(id);
      chips.push({ id, title, ...(typeof color === "string" && color ? { color: color as TaskColor } : {}), ...(typeof icon === "string" && icon ? { icon } : {}) });
    }
    return chips.length ? chips : NONE;
  } catch {
    return NONE;
  }
}

function persist(project: string, next: readonly TaskChip[]): void {
  try {
    if (next.length) storage()?.setItem(taskChipsStorageKey(project), JSON.stringify(next));
    else storage()?.removeItem(taskChipsStorageKey(project));
  } catch { /* a full or blocked storage costs the reload, never the chip */ }
}

function set(project: string, next: readonly TaskChip[]): void {
  loaded.add(project);
  if (next.length) byProject.set(project, next);
  else byProject.delete(project);
  persist(project, next);
  emit();
}

/** This project's chips, in the order they were added. The same array until a
    chip is added or removed, so a subscribed render can skip. */
export function readTaskChips(project: string): readonly TaskChip[] {
  if (!loaded.has(project)) {
    loaded.add(project);
    const restored = stored(project);
    if (restored.length) byProject.set(project, restored);
  }
  return byProject.get(project) ?? NONE;
}

/** Attach a task to the project's orchestrator composer and ask the shell to
    show that composer. Adding a task already attached refreshes its title and
    keeps its place. A list already at `MAX_TASK_CHIPS` refuses a new task and
    answers false: the wire carries that many, and a chip the send would leave
    behind unsent must never be taken for one that went. */
export function addTaskChip(project: string, chip: TaskChip): boolean {
  const current = readTaskChips(project);
  const at = current.findIndex((entry) => entry.id === chip.id);
  if (at < 0 && current.length >= MAX_TASK_CHIPS) return false;
  const clean: TaskChip = { id: chip.id, title: chip.title, ...(chip.color ? { color: chip.color } : {}), ...(chip.icon ? { icon: chip.icon } : {}) };
  set(project, at < 0 ? [...current, clean] : current.map((entry, index) => (index === at ? clean : entry)));
  for (const listener of [...focusListeners]) listener(project);
  return true;
}

export function removeTaskChip(project: string, id: string): void {
  const current = readTaskChips(project);
  if (!current.some((chip) => chip.id === id)) return;
  set(project, current.filter((chip) => chip.id !== id));
}

/** The chips a send carried leave with it; `ids` absent clears the project's
    list. A chip added while the send was in flight stays. */
export function clearTaskChips(project: string, ids?: readonly string[]): void {
  const current = readTaskChips(project);
  if (!current.length) return;
  set(project, ids ? current.filter((chip) => !ids.includes(chip.id)) : []);
}

/** What a chip says to the wire: identity and title, nothing the card drew. */
export function taskChipRefs(chips: readonly TaskChip[]): SelectedTaskRef[] {
  return chips.map(({ id, title }) => ({ id, title }));
}

/** Whether this task is attached to the project's orchestrator composer now. */
export function useTaskChipAttached(project: string, id: string): boolean {
  return useTaskChips(project).some((chip) => chip.id === id);
}

/** Whether the project's list is at the cap, so a task not yet attached cannot join. */
export function useTaskChipsFull(project: string): boolean {
  return useTaskChips(project).length >= MAX_TASK_CHIPS;
}

export function subscribeTaskChips(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The live list, for a composer that follows it. */
export function useTaskChips(project: string | null | undefined): readonly TaskChip[] {
  return useSyncExternalStore(
    subscribeTaskChips,
    () => (project ? readTaskChips(project) : NONE),
    () => NONE,
  );
}

/**
 * The project whose chips a composer carries, or null for a composer that is
 * not its project's orchestrator.
 *
 * A surface that is the seat by construction (the dock, the kanban seat, which
 * render the seat's own conversation) names its project and is believed. Any
 * other composer, the phone's conversation screen among them, holds the seat
 * only if the project's seat route names its conversation: asked once chips
 * exist, through the same cached read the viewer-context prelude uses, and
 * failing closed, so a worker's composer in the same project never takes a
 * chip meant for the orchestrator.
 */
export function useSeatChipProject(conversationId: string, project: string | undefined, explicit: string | undefined): string | null {
  const probe = explicit ? null : project ?? null;
  const waiting = useTaskChips(probe).length > 0;
  const [seatOf, setSeatOf] = useState<{ conversationId: string; project: string } | null>(null);
  useEffect(() => {
    if (!probe || !waiting || !conversationId.startsWith("conversation_")) return;
    let live = true;
    void designatedManagerConversationId(probe).then((seat) => {
      if (live && seat === conversationId) setSeatOf({ conversationId, project: probe });
    });
    return () => { live = false; };
  }, [probe, waiting, conversationId]);
  if (explicit) return explicit;
  return seatOf && seatOf.conversationId === conversationId && seatOf.project === probe ? probe : null;
}

/** The shell shows this project's orchestrator: open the dock, expand the seat. */
export function onOrchestratorFocusRequest(listener: (project: string) => void): () => void {
  focusListeners.add(listener);
  return () => { focusListeners.delete(listener); };
}

export interface TaskChipOpenRequest {
  project: string;
  id: string;
}

/** A chip was clicked: the board opens or frames that task. */
export function openTaskChip(project: string, id: string): void {
  for (const listener of [...openListeners]) listener({ project, id });
}

export function onTaskChipOpen(listener: (request: TaskChipOpenRequest) => void): () => void {
  openListeners.add(listener);
  return () => { openListeners.delete(listener); };
}

/** Tests only: a clean store, memory and storage both. */
export function resetTaskChipsForTests(): void {
  for (const project of new Set([...byProject.keys(), ...loaded])) {
    try { storage()?.removeItem(taskChipsStorageKey(project)); } catch { /* none */ }
  }
  byProject.clear();
  loaded.clear();
  emit();
}

/** Tests only: what a page reload does to the module, memory gone and the tab's storage kept. */
export function reloadTaskChipsForTests(): void {
  byProject.clear();
  loaded.clear();
  emit();
}
