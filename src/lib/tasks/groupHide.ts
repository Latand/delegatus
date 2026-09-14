import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import type { BoardTask } from "./types";

/**
 * When a hidden task group comes back to the kanban board (#1695).
 *
 * A hide answers what the operator saw when they hid the group. It stops
 * answering the moment something newer than the hide needs them, and the
 * board shows the group again with the reason. This is the same shape as the
 * phone's dismissed-lane rule (`pipelineHiddenFromBoard`, #1671): a hide covers
 * only what was already there.
 *
 * Pure and client-safe: the board calls it with the group's conversations and
 * the pipelines it can see. Nothing here writes; resurfacing never clears the
 * stored hide, so hiding the group again is one more write with a newer `at`.
 */

export type GroupResurfaceReason =
  /** A conversation of the group asked for a decision after the hide. */
  | { kind: "decision"; path: string; at: string }
  /** A conversation was linked to the task, or handed it, after the hide. */
  | { kind: "admitted"; conversation: string; at: string }
  /** A pipeline of the task moved and now waits on a decision nobody hid. */
  | { kind: "pipeline-decision"; pipelineId: string; at: string };

export type GroupHideState =
  | { hidden: false; resurfaced: null }
  | { hidden: true; since: string }
  | { hidden: false; resurfaced: GroupResurfaceReason };

const parse = (stamp: string | null | undefined): number => (stamp ? Date.parse(stamp) : Number.NaN);

/* The instants the engine stamps on a lane as it moves — the same set the
   phone reads. None of them changes while a lane sits parked on one decision. */
function laneMovedAt(pipeline: Pipeline): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      for (const stamp of [attempt.startedAt, attempt.completedAt, attempt.controllerWait?.startedAt, attempt.verdictRecovery?.startedAt, attempt.verdictRecovery?.lastCheckedAt]) {
        const at = parse(stamp);
        if (at > latest) latest = at;
      }
    }
  }
  return latest;
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
  },
): GroupHideState {
  const hide = task.groupHidden;
  if (!hide) return { hidden: false, resurfaced: null };
  const hiddenAt = parse(hide.at);
  if (Number.isNaN(hiddenAt)) return { hidden: true, since: hide.at };

  for (const file of inputs.members) {
    const asked = decisionAskedAt(file);
    if (asked > hiddenAt) return { hidden: false, resurfaced: { kind: "decision", path: file.path, at: new Date(asked).toISOString() } };
  }
  for (const assignment of task.assignments) {
    const at = parse(assignment.at);
    if (at > hiddenAt && assignment.state !== "failed") {
      return { hidden: false, resurfaced: { kind: "admitted", conversation: assignment.conversationId ?? assignment.path ?? assignment.launchId ?? "", at: assignment.at } };
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
