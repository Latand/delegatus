"use client";

import { applyTaskSnapshot, revertTaskSnapshot } from "@/hooks/useFiles";
import { getLocale, translate } from "@/lib/i18n";
import { LAUNCH_NOT_STARTED_ERROR, type AssignmentRef, type BoardTask, type TaskAssignment } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { fireTasksChanged } from "@/components/tasks/taskApi";

/**
 * Link and Unlink on the kanban board (#1695 K3), over the existing
 * `POST` / `DELETE /api/tasks/:id/assignment`. What each does, as the route
 * does it — the copy on the board says exactly this:
 *
 * - Link records a `handoff` assignment and sends the agent nothing. When the
 *   task has no open pipeline, the route first creates a draft pipeline for it
 *   that does not start (`ensureTaskPipelineForAssignment`).
 * - Unlink removes one assignment and stops nothing. A conversation left with
 *   no task is bound to a new untitled task of its own; when the task being
 *   left is already that, the route refuses with 409.
 *
 * Each of them is drawn at once (`optimisticAssignment`): the task row the
 * write will produce is layered over the client cache before the request,
 * replaced by the server's row when it answers, and taken off on a refusal.
 */

export type AssignmentAnswer = { ok: true; task: BoardTask | null } | { ok: false; status: number; error: string };

export interface AssignmentPorts {
  link(taskId: string, path: string): Promise<AssignmentAnswer>;
  unlink(taskId: string, ref: AssignmentRef): Promise<AssignmentAnswer>;
}

async function send(taskId: string, method: "POST" | "DELETE", body: unknown): Promise<AssignmentAnswer> {
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/assignment`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as { task?: BoardTask; error?: string } | null;
    if (!response.ok) {
      return { ok: false, status: response.status, error: json?.error ?? translate(getLocale(), "tasks.failed", { status: response.status }) };
    }
    fireTasksChanged();
    return { ok: true, task: json?.task ?? null };
  } catch {
    return { ok: false, status: 0, error: translate(getLocale(), "common.serverUnavailable") };
  }
}

export const browserAssignmentPorts: AssignmentPorts = {
  link: (taskId, path) => send(taskId, "POST", { path }),
  unlink: (taskId, ref) => send(taskId, "DELETE", ref),
};

/**
 * The strongest handle of the assignment that ties this conversation to this
 * task, in the order the route matches them. Null when no assignment does: a
 * pipeline stage belongs to its task through the pipeline, and there is no
 * assignment to remove.
 */
export function assignmentRefFor(task: BoardTask, file: FileEntry): AssignmentRef | null {
  const assignment = task.assignments.find((candidate) =>
    (file.conversationId && candidate.conversationId === file.conversationId) || (candidate.path !== null && candidate.path === file.path));
  if (!assignment) return null;
  if (assignment.launchId) return { launchId: assignment.launchId };
  if (assignment.conversationId) return { conversationId: assignment.conversationId };
  if (assignment.path) return { path: assignment.path };
  return assignment.panePid ? { panePid: assignment.panePid } : null;
}

type LaunchRef = { launchId: string | null; conversationId: string | null };

async function patchDismiss(taskId: string, launch: LaunchRef): Promise<AssignmentAnswer> {
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/assignment`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ launchId: launch.launchId, conversationId: launch.conversationId, dismiss: "launch-did-not-start" }),
    });
    const json = (await response.json().catch(() => null)) as { task?: BoardTask; error?: string } | null;
    if (!response.ok) {
      return { ok: false, status: response.status, error: json?.error ?? translate(getLocale(), "tasks.failed", { status: response.status }) };
    }
    return { ok: true, task: json?.task ?? null };
  } catch {
    return { ok: false, status: 0, error: translate(getLocale(), "common.serverUnavailable") };
  }
}

/**
 * Dismiss a launch that did not start (the card's «launch did not start» row)
 * over `PATCH /api/tasks/:id/assignment`. The row is kept on the task, marked
 * failed; a placeholder task left with nothing else is done.
 */
export async function dismissUnstartedLaunch(taskId: string, launch: LaunchRef): Promise<AssignmentAnswer> {
  const answer = await patchDismiss(taskId, launch);
  if (answer.ok) fireTasksChanged();
  return answer;
}

/**
 * «Dismiss all»: each launch in turn, so each request reads the task the one
 * before it wrote. A refusal does not stop the rest; the answer is the first
 * refusal, or the last success. The board refreshes once.
 */
export async function dismissUnstartedLaunches(taskId: string, launches: readonly LaunchRef[]): Promise<AssignmentAnswer> {
  let refused: AssignmentAnswer | null = null;
  let last: AssignmentAnswer | null = null;
  for (const launch of launches) {
    const answer = await patchDismiss(taskId, launch);
    if (answer.ok) last = answer;
    else refused ??= answer;
  }
  if (last) fireTasksChanged();
  return refused ?? last ?? { ok: true, task: null };
}

function matches(assignment: TaskAssignment, ref: AssignmentRef): boolean {
  if (ref.launchId && assignment.launchId) return assignment.launchId === ref.launchId;
  if (ref.conversationId && assignment.conversationId) return assignment.conversationId === ref.conversationId;
  if (ref.path && assignment.path) return assignment.path === ref.path;
  return ref.panePid != null && assignment.panePid === ref.panePid;
}

/** The task as a link of `file` leaves it: one more handoff row, unless the conversation is already on it. */
export function predictLink(task: BoardTask, file: FileEntry, at = new Date().toISOString()): BoardTask {
  if (task.assignments.some((assignment) => (file.conversationId && assignment.conversationId === file.conversationId) || assignment.path === file.path)) return task;
  const row: TaskAssignment = { path: file.path, conversationId: file.conversationId ?? null, panePid: null, state: "handoff", error: null, at };
  return { ...task, assignments: [...task.assignments, row] };
}

/** The task as an unlink of `ref` leaves it. */
export function predictUnlink(task: BoardTask, ref: AssignmentRef): BoardTask {
  return { ...task, assignments: task.assignments.filter((assignment) => !matches(assignment, ref)) };
}

/** The task as dismissing `launches` leaves it: each row kept and marked failed, as the route does. */
export function predictDismissedLaunches(task: BoardTask, launches: readonly LaunchRef[], at = new Date().toISOString()): BoardTask {
  const assignments = task.assignments.map((assignment) => launches.some((launch) => matches(assignment, launch))
    ? { ...assignment, state: "failed" as const, error: LAUNCH_NOT_STARTED_ERROR, at }
    : assignment);
  return { ...task, assignments };
}

/**
 * Draw `predicted` at once, send `write`, then settle: the server's row (or,
 * when it answers none, the prediction until the next scan) on success; the
 * stored row again on a refusal.
 */
export async function optimisticAssignment(predicted: BoardTask, write: () => Promise<AssignmentAnswer>): Promise<AssignmentAnswer> {
  applyTaskSnapshot(predicted, false);
  const answer = await write();
  if (answer.ok) applyTaskSnapshot(answer.task?.id === predicted.id ? answer.task : predicted, true);
  else revertTaskSnapshot(predicted.id);
  return answer;
}
