import { admissionKeys, admissionSnapshot } from "./groupHide";
import type { BoardTask } from "./types";

/** Freeze the legacy fallback once, before any later edit can move updatedAt.
 * Reads only normalize; the next task-store write persists the backfill.
 * The field itself is the idempotency marker; no row or assignment is removed.
 * Writers pass the previous row so a new admission restarts retention once. */
export function withTaskCompletion(task: BoardTask, previous?: BoardTask): BoardTask {
  if (task.status !== "done") {
    if (task.doneAt === undefined && task.doneAdmissions === undefined) return task;
    const next = { ...task };
    delete next.doneAt;
    delete next.doneAdmissions;
    return next;
  }
  const baseline = previous ?? task;
  const entering = baseline.status !== "done";
  const admissions = task.doneAdmissions ?? baseline.doneAdmissions ?? admissionSnapshot(baseline.assignments);
  const known = new Set(admissions);
  // Shared identifiers mean reconciliation of an existing admission, even when
  // its timestamp or transcript changes. Only a new identity starts a window.
  const newAdmission = previous && task.assignments.some((assignment) => {
    if (assignment.state === "failed") return false;
    const keys = admissionKeys(assignment);
    return keys.length > 0 && !keys.some((key) => known.has(key));
  });
  if (!entering && !newAdmission && task.doneAt !== undefined && task.doneAdmissions !== undefined) return task;
  return {
    ...task,
    doneAt: entering || newAdmission ? task.updatedAt : task.doneAt ?? baseline.doneAt ?? baseline.updatedAt,
    doneAdmissions: entering || newAdmission ? admissionSnapshot(task.assignments) : admissions,
  };
}
