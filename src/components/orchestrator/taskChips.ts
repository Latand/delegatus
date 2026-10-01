"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { SelectedTaskRef } from "@/lib/selection/selectedContext";
import { designatedManagerConversationId } from "@/components/voice/managerIdentity";
import type { TaskColor } from "@/lib/tasks/types";

/**
 * The task references an operator has attached to a project's orchestrator
 * composer, as this tab keeps them.
 *
 * A card's «Ask the orchestrator» button adds a chip here; the composer of that
 * project's seat draws the list above its input and carries it with the next
 * send as `selectedContext.tasks`. The chips are references the operator has
 * not sent yet, so they live in memory beside the draft and are gone with the
 * tab, exactly as an unsent draft's attachments are.
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

const NONE: readonly TaskChip[] = Object.freeze([]);
const byProject = new Map<string, readonly TaskChip[]>();
const listeners = new Set<() => void>();
const focusListeners = new Set<(project: string) => void>();
const openListeners = new Set<(request: TaskChipOpenRequest) => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function set(project: string, next: readonly TaskChip[]): void {
  if (next.length) byProject.set(project, next);
  else byProject.delete(project);
  emit();
}

/** This project's chips, in the order they were added. The same array until a
    chip is added or removed, so a subscribed render can skip. */
export function readTaskChips(project: string): readonly TaskChip[] {
  return byProject.get(project) ?? NONE;
}

/** Attach a task to the project's orchestrator composer and ask the shell to
    show that composer. Adding a task already attached refreshes its title and
    keeps its place. */
export function addTaskChip(project: string, chip: TaskChip): void {
  const current = readTaskChips(project);
  const at = current.findIndex((entry) => entry.id === chip.id);
  const clean: TaskChip = { id: chip.id, title: chip.title, ...(chip.color ? { color: chip.color } : {}), ...(chip.icon ? { icon: chip.icon } : {}) };
  set(project, at < 0 ? [...current, clean] : current.map((entry, index) => (index === at ? clean : entry)));
  for (const listener of [...focusListeners]) listener(project);
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

/** Tests only. */
export function resetTaskChipsForTests(): void {
  byProject.clear();
  emit();
}
