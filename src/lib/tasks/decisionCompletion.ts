import type { BoardTask } from "./types";
import { prototypeDeliverySettled } from "@/lib/prototypeReview/deliveryPolicy";

export function hasUndeliveredDecision(task: BoardTask): boolean {
  return !!task.prototypeReviews?.some(round => round.decision && !prototypeDeliverySettled(round.decision.delivery));
}

export class TaskDecisionUndeliveredError extends Error {
  readonly status = 409;
  readonly code = "TASK_DECISION_UNDELIVERED";
  constructor() { super("task has an undelivered decided round; verify delivery before completing it"); }
}
