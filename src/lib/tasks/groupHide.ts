import { laneMovedAt } from "@/lib/pipelines/laneMovement";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import type { BoardTask, TaskAssignment } from "./types";

/**
 * When a hidden task group comes back to the kanban board (#1695).
 *
 * A hide answers what the operator saw when they hid the group. It stops
 * answering the moment something newer than the hide needs them, and the
 * board shows the group again with the reason. This is the same shape as the
 * phone's dismissed-lane rule (`pipelineHiddenFromBoard`, #1671), and both read
 * one `laneMovedAt`.
 *
 * Pure and client-safe: the board calls it with the group's conversations, the
 * pipelines and the project's seat it can see. Nothing here writes;
 * resurfacing never clears the stored hide, so hiding the group again is one
 * more write with a newer `at` and a fresh snapshot.
 */

export type GroupResurfaceReason =
  /** A conversation of the group asked for a decision after the hide. */
  | { kind: "decision"; path: string; at: string }
  /** A conversation joined the task after the hide: an admission the hide's
      snapshot does not name. */
  | { kind: "admitted"; conversation: string }
  /** A pipeline of the task moved and now waits on a decision nobody hid. */
  | { kind: "pipeline-decision"; pipelineId: string; at: string }
  /** The group holds the project's orchestrator seat conversation, which
      stays on the board whatever the stored hide says. */
  | { kind: "seat"; conversation: string };

export type GroupHideState =
  | { hidden: false; resurfaced: null }
  | { hidden: true; since: string }
  | { hidden: false; resurfaced: GroupResurfaceReason };

/** The conversation or conversations holding a project's seat, active or pending. */
export interface SeatRefs {
  conversationIds: readonly string[];
  paths: readonly string[];
}

const parse = (stamp: string | null | undefined): number => (stamp ? Date.parse(stamp) : Number.NaN);

/**
 * Every identifier an assignment is known by. An admission is the same one
 * when any of them is shared: a conversation that resumed into a successor
 * transcript keeps its conversation id, a launch keeps its launch key, and a
 * re-send of a path keeps the path.
 */
export function admissionKeys(assignment: Pick<TaskAssignment, "launchId" | "clientAttemptId" | "conversationId" | "path">): string[] {
  return [assignment.clientAttemptId, assignment.launchId, assignment.conversationId, assignment.path].filter((key): key is string => typeof key === "string" && key.length > 0);
}

/**
 * The admissions a hide covers, recorded with it. Taken from the task's live
 * assignments at the moment of the hide; `assignment.at` is not used, because
 * reconciliation and a re-handoff rewrite it for a conversation that was
 * already in the group.
 */
export function admissionSnapshot(assignments: readonly TaskAssignment[]): string[] {
  const keys = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.state === "failed") continue;
    for (const key of admissionKeys(assignment)) keys.add(key);
  }
  return [...keys].sort();
}

/** The assignment naming one of the seat's conversations, if the task has one. */
export function seatAssignment(assignments: readonly TaskAssignment[], seat: SeatRefs): TaskAssignment | null {
  if (!seat.conversationIds.length && !seat.paths.length) return null;
  return assignments.find((assignment) =>
    (assignment.conversationId && seat.conversationIds.includes(assignment.conversationId))
    || (assignment.path && seat.paths.includes(assignment.path))) ?? null;
}

/** When a conversation asked for a decision, if it is asking now. */
function decisionAskedAt(file: Pick<FileEntry, "pendingQuestion" | "waitingInput">): number {
  const asked = parse(file.pendingQuestion?.askedAt);
  const waiting = typeof file.waitingInput?.since === "number" ? file.waitingInput.since * 1000 : Number.NaN;
  return Math.max(Number.isNaN(asked) ? Number.NEGATIVE_INFINITY : asked, Number.isNaN(waiting) ? Number.NEGATIVE_INFINITY : waiting);
}

export function groupHideState(
  task: Pick<BoardTask, "id" | "groupHidden" | "assignments">,
  inputs: {
    /** The group's conversations as the board resolves them. */
    members: readonly Pick<FileEntry, "path" | "pendingQuestion" | "waitingInput">[];
    pipelines: readonly Pipeline[];
    /** The project's seat as the board knows it; absent when it does not. */
    seat?: SeatRefs | null;
  },
): GroupHideState {
  const hide = task.groupHidden;
  if (!hide) return { hidden: false, resurfaced: null };

  /* The seat stays on the board: a group that holds it (designated after the
     hide, or while its spawn was still pending) is shown, and says why. */
  const seatRow = inputs.seat ? seatAssignment(task.assignments, inputs.seat) : null;
  if (seatRow) return { hidden: false, resurfaced: { kind: "seat", conversation: seatRow.conversationId ?? seatRow.path ?? "" } };

  const hiddenAt = parse(hide.at);
  if (Number.isNaN(hiddenAt)) return { hidden: true, since: hide.at };

  for (const file of inputs.members) {
    const asked = decisionAskedAt(file);
    if (asked > hiddenAt) return { hidden: false, resurfaced: { kind: "decision", path: file.path, at: new Date(asked).toISOString() } };
  }
  /* A hide recorded without a snapshot names no admissions, so none reads as
     new: the group waits for a decision rather than guessing from times. */
  if (Array.isArray(hide.admitted)) {
    const known = new Set(hide.admitted);
    for (const assignment of task.assignments) {
      if (assignment.state === "failed") continue;
      const keys = admissionKeys(assignment);
      if (keys.length && !keys.some((key) => known.has(key))) {
        return { hidden: false, resurfaced: { kind: "admitted", conversation: assignment.conversationId ?? assignment.path ?? assignment.launchId ?? keys[0]! } };
      }
    }
  }
  for (const pipeline of inputs.pipelines) {
    if (!pipeline.taskIds.includes(task.id) || pipeline.state !== "needs_decision") continue;
    const moved = laneMovedAt(pipeline);
    const dismissed = parse(pipeline.dismissedAt);
    if (moved > hiddenAt && !(moved <= dismissed)) {
      return { hidden: false, resurfaced: { kind: "pipeline-decision", pipelineId: pipeline.id, at: new Date(moved).toISOString() } };
    }
  }
  return { hidden: true, since: hide.at };
}
