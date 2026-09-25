import { TASK_PRIORITIES, type TaskPriority } from "./types";

/**
 * When each priority fits, one line each. Rendered into the create_task and
 * update_task descriptions so both say the same thing.
 */
export const TASK_PRIORITY_RULE: readonly { priority: TaskPriority; when: string }[] = [
  { priority: "high", when: "take it before anything else in the Inbox: something broken for the operator, a blocker for other work, or asked for as urgent" },
  { priority: "normal", when: "the default; leave it unless the task clearly belongs above or below the rest" },
  { priority: "low", when: "worth doing when nothing else waits: a nice-to-have, a cleanup, an idea to keep" },
];

/** The rule as one sentence, the form both tool descriptions carry. */
export function renderTaskPriorityRule(): string {
  return `\`priority\` orders the Inbox, high first and low last; the other columns keep their order. ${TASK_PRIORITY_RULE.map(({ priority, when }) => `${priority} = ${when}`).join("; ")}.`;
}

/** Where a priority sorts inside the Inbox: high first, low last. */
export function priorityRank(priority: TaskPriority): number {
  return TASK_PRIORITIES.indexOf(priority);
}

export type TaskPriorityInput =
  | { kind: "set"; priority: Exclude<TaskPriority, "normal"> }
  | { kind: "clear" }
  /** Named no priority: stored as normal, with this note in the answer. */
  | { kind: "clamped"; note: string };

/** What a create's `priority` field asks for. Absent, `null`, an empty string
    and `normal` mean normal; a value that is no priority is clamped to normal
    with a note, like an unknown colour, and never refused. */
export function readTaskPriorityInput(value: unknown): TaskPriorityInput {
  if (value === null || value === undefined) return { kind: "clear" };
  const key = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (key === "" || key === "normal") return { kind: "clear" };
  if (key === "high" || key === "low") return { kind: "set", priority: key };
  const shown = typeof value === "string" ? `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"` : typeof value;
  return { kind: "clamped", note: `priority ${shown} is not one of ${TASK_PRIORITIES.join(", ")}, so the task is normal` };
}
