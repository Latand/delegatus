import { proactiveCandidateDecision } from "./proactive";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { loadTasksByIds, TASKS_FILE } from "./store";
import type { BoardTask } from "./types";

/** Shared by membership, dispatch, recovery and subsequent effects. Adoption
 * is a durable operator receipt, never a task field or a launch-body assertion.
 * Inspect every task: adding an unrelated accepted task cannot confer authority.
 * Missing retained provenance requires recovery rather than a fresh placeholder. */
export function proactiveExecutionError(tasks: readonly BoardTask[], file = TASKS_FILE): string | null {
  for (const task of tasks) {
    if (!task.proactive) continue;
    try {
      const decision = proactiveCandidateDecision(task, file);
      if (decision.adopted) continue;
      if (decision.rejected) return "invented work was rejected by the operator";
      return "proactive starts and effects remain disabled pending independent scope review";
    } catch {
      return "invented work authority is unreadable; operator recovery required";
    }
  }
  return null;
}

export function proactiveTaskExecutionError(taskIds: readonly string[], file = TASKS_FILE): string | null {
  if (!taskIds.length) return null;
  try {
    const ids = new Set(taskIds);
    return proactiveExecutionError(loadTasksByIds(ids, file), file);
  } catch {
    return "task authority is unreadable; operator recovery required";
  }
}

export function assertProactiveTaskExecution(taskIds: readonly string[], file = TASKS_FILE): void {
  const error = proactiveTaskExecutionError(taskIds, file);
  if (error) throw new Error(error);
}

/** Original launch receipts retain task authority across failed attempts,
 * successors and edited attachments. The registry's existing keyed retention
 * reader follows aliases without scanning the task store or registry history. */
export function proactiveConversationTaskIds(conversationIds: readonly (string | null | undefined)[],
  registry?: Pick<AgentRegistry, "conversationRetentionSnapshot">, file = TASKS_FILE): string[] {
  const ids = new Set(conversationIds.filter((id): id is string => !!id));
  if (!ids.size) return [];
  registry ??= agentRegistry();
  const tasks = new Set<string>();
  for (const id of ids) {
    const retained = registry.conversationRetentionSnapshot(id);
    for (const receipt of Object.values(retained.receipts)) {
      for (const taskId of receipt.failureReporting?.taskIds ?? []) tasks.add(taskId);
    }
  }
  return loadTasksByIds(tasks, file).filter(task => task.proactive).map(task => task.id);
}
