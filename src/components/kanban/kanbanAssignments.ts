"use client";

import { getLocale, translate } from "@/lib/i18n";
import type { AssignmentRef, BoardTask } from "@/lib/tasks/types";
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
