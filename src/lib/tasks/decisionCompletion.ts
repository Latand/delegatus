import type { BoardTask } from "./types";

export function hasUndeliveredDecision(task: BoardTask): boolean {
  return !!task.prototypeReviews?.some(round => round.decision && round.decision.delivery.state !== "sent");
}

export class TaskDecisionUndeliveredError extends Error {
  readonly status = 409;
  readonly code = "TASK_DECISION_UNDELIVERED";
  constructor() { super("task has an undelivered decided round; verify delivery before completing it"); }
}
