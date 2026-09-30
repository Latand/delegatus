import { admissionSnapshot } from "./groupHide";
import type { BoardTask } from "./types";

/** Freeze the legacy fallback once, before any later edit can move updatedAt.
 * Reads only normalize; the next task-store write persists the backfill.
 * The field itself is the idempotency marker; no row or assignment is removed. */
export function withTaskCompletion(task: BoardTask, previous: BoardTask = task): BoardTask {
  if (task.status !== "done") {
    if (task.doneAt === undefined && task.doneAdmissions === undefined) return task;
    const next = { ...task };
    delete next.doneAt;
    delete next.doneAdmissions;
    return next;
  }
  const entering = previous.status !== "done";
  if (!entering && task.doneAt !== undefined && task.doneAdmissions !== undefined) return task;
  return {
    ...task,
    doneAt: entering ? task.updatedAt : task.doneAt ?? previous.doneAt ?? previous.updatedAt,
    doneAdmissions: entering ? admissionSnapshot(task.assignments) : task.doneAdmissions ?? previous.doneAdmissions ?? admissionSnapshot(previous.assignments),
  };
}
