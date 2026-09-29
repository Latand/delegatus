/**
 * M.4 seams 4 and 5 (docs/design/linked-installs.md): boot adoption and the
 * account-migration successor reopen a conversation's process, which is new
 * work for every task the conversation holds. They resolve those tasks as
 * launch admission does for a resume (the tasks whose assignment holds the
 * conversation, and a pipeline stage's pipeline tasks) and refuse when one
 * runs on another machine.
 */
import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { loadPipelinesForProjection } from "@/lib/pipelines/store";
import { loadTasksForList } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

import { firstRunsElsewhere, linkedContext, TASK_RUNS_ELSEWHERE, type RunsElsewhereRefusal } from "./linked";

export type ConversationRef = { engine: string; sessionId: string | null; artifactPath: string | null; conversationId?: string | null };

export function conversationTasks(ref: ConversationRef, snapshot: Pick<RegistryFile, "conversations" | "memberships">, tasks: readonly BoardTask[], pipelineTaskIds: (id: string) => readonly string[]): BoardTask[] {
  const conversationId = ref.conversationId ?? Object.values(snapshot.conversations).find((candidate) => candidate.engine === ref.engine
    && candidate.generations.some((generation) => generation.id === ref.sessionId || (!!ref.artifactPath && generation.path === ref.artifactPath)))?.id ?? null;
  const pipelines = conversationId
    ? Object.values(snapshot.memberships).flat().filter((membership) => membership.conversationId === conversationId && membership.kind === "pipeline").map((membership) => membership.containerId)
    : [];
  const pipelineTasks = new Set(pipelines.flatMap((id) => pipelineTaskIds(id)));
  return tasks.filter((task) => pipelineTasks.has(task.id) || task.assignments.some((assignment) => assignment.state !== "failed"
    && ((conversationId !== null && assignment.conversationId === conversationId) || (!!ref.artifactPath && assignment.path === ref.artifactPath))));
}

const productionPipelineTaskIds = (id: string) => {
  try { return loadPipelinesForProjection().find((pipeline) => pipeline.id === id)?.taskIds ?? []; } catch { return []; }
};

/** Null when every task the conversation holds runs here (or it holds none). */
export function reopenRefusal(ref: ConversationRef, snapshot: Pick<RegistryFile, "conversations" | "memberships">): RunsElsewhereRefusal | null {
  let tasks: readonly BoardTask[];
  try { tasks = loadTasksForList(); } catch {
    // Without links no task can name another machine; with one, an unread
    // store cannot prove the conversation's tasks run here.
    if (!linkedContext().links.length) return null;
    return { code: TASK_RUNS_ELSEWHERE, status: 409, taskId: "", machine: "", error: `${TASK_RUNS_ELSEWHERE}: the task store could not be read, so where this conversation's tasks run is unknown` };
  }
  if (!tasks.some((task) => task.machine)) return null;
  return firstRunsElsewhere(conversationTasks(ref, snapshot, tasks, productionPipelineTaskIds));
}

/** Boot adoption's step between the claim and `adopt`. */
export function adoptionRefusal(entry: AgentRegistryEntry, snapshot: Pick<RegistryFile, "conversations" | "memberships">): RunsElsewhereRefusal | null {
  return reopenRefusal({ engine: entry.key.engine, sessionId: entry.key.sessionId, artifactPath: entry.artifactPath || null }, snapshot);
}

/** M.4 seam 5: the account-migration successor reopens the conversation
    under another account, so it is refused like boot adoption. */
export function successorRefusal(input: { conversationId?: string | null; receipt: { nativeId: string; path: string } }, engine: "codex" | "claude", snapshot: Pick<RegistryFile, "conversations" | "memberships">): RunsElsewhereRefusal | null {
  return reopenRefusal({ engine, sessionId: input.receipt.nativeId, artifactPath: input.receipt.path, conversationId: input.conversationId ?? null }, snapshot);
}
