"use client";

import { useMemo, useRef } from "react";

import { buildKanbanModel, KANBAN_STATUSES, type KanbanCard, type KanbanModel, type KanbanModelInput } from "@/components/kanban/kanbanModel";
import { useBands, type BandsInput } from "@/components/kanban/useBands";
import { drawnTasks, type useTaskMutations } from "@/components/kanban/useTaskMutations";
import type { SeatRefs } from "@/lib/tasks/groupHide";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * The phone's board model, read by the status columns (#2072 slice 4) and the
 * task screen (slice 5) alike: the desktop's bands (`useBands`) and model
 * (`buildKanbanModel`) over the stored tasks with this device's edits drawn
 * ahead of the poll. A task opened from a card is the same card on its
 * screen: the same pipelines, members and earlier attempts, in the same order.
 */

/** The desktop's optimistic task mutations, one set the phone's screens share
    so a move made on the task screen is still drawn on the board after ‹. */
export type TaskMutations = ReturnType<typeof useTaskMutations>;

export interface PhoneBoardInput extends BandsInput {
  /** The seat as the dashboard read it; null while unknown (nothing hidden on a guess). */
  seatRefs: SeatRefs | null;
  /** The Overview's narrowing (#2098): the cards with live work, as its
      desktop board draws them (`cardHasLiveWork`, #1820). */
  cardFilter?: KanbanModelInput["cardFilter"];
}

export function usePhoneBoardModel(input: PhoneBoardInput, mutations: Pick<TaskMutations, "statuses" | "edits">): {
  model: KanbanModel;
  /** The stored tasks as the board draws them, with this device's edits. */
  allTasks: readonly BoardTask[];
  /** The model's clock, in 15 s steps. */
  modelNow: number;
} {
  const { statuses, edits } = mutations;
  const hideStamps = useRef(new Map<string, string>());
  const allTasks = useMemo(() => drawnTasks(input.allTasks, edits, hideStamps.current), [input.allTasks, edits]);
  const { bands, projection } = useBands({ ...input, allTasks });
  /* The model's clock moves in 15 s steps, as the desktop's does: it phrases
     ages, and a per-second clock would rebuild every card each tick. */
  const modelNow = Math.floor(input.now / 15) * 15;
  const { pipelines, files, flows, seatRefs, cardFilter } = input;
  const model = useMemo(
    () => buildKanbanModel({ bands, tasks: allTasks, pipelines, projection, files, flows, statusOverrides: statuses, seat: seatRefs, cardFilter, now: modelNow }),
    [bands, allTasks, pipelines, projection, files, flows, statuses, seatRefs, cardFilter, modelNow],
  );
  return { model, allTasks, modelNow };
}

/** The card a task draws, wherever the model put it: a column, or the hidden
    groups. A task the board draws no card for (a seat's own, one whose band
    the scan window did not carry) has none. */
export function cardOfTask(model: KanbanModel, taskId: string): KanbanCard | null {
  for (const status of KANBAN_STATUSES) {
    const card = model.columns[status].cards.find((entry) => entry.task?.id === taskId);
    if (card) return card;
  }
  return model.hiddenGroups.find((entry) => entry.task?.id === taskId) ?? null;
}
