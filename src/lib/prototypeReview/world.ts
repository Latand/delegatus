import type { NextRequest } from "next/server";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { loadPipelines } from "@/lib/pipelines/store";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectForCwd } from "@/lib/scanner/describe";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { loadTasks } from "@/lib/tasks/store";
import { runsElsewhere } from "@/lib/links/linked";
import type { PrototypeReviewRound } from "./types";
import { PrototypeError } from "./input";

export interface PrototypeCaller { conversationId: string | null; project: string | null }
export interface PrototypeWorld {
  caller(request: NextRequest): PrototypeCaller;
  stage(conversationId: string): { taskIds: string[]; project: string; source: PrototypeReviewRound["source"] } | null;
  orchestrator(project: string): string | null;
}
export const prototypeWorld: PrototypeWorld = {
  caller(request) {
    const id = callerConversationId(request);
    if (!id) {
      if (request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) throw new PrototypeError("caller could not be identified",403);
      return { conversationId: null, project: null };
    }
    const conversation = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot()).conversation(id as `conversation_${string}`);
    const cwd = conversation?.generations.at(-1)?.launchProfile?.cwd;
    const project = conversation?.projectOwnership?.project ?? (cwd ? projectForCwd(cwd) : null);
    return { conversationId: id, project: project ? canonicalProject(project) : null };
  },
  stage(conversationId) {
    const found = loadPipelines().flatMap(pipeline => pipeline.runs.flatMap(run => run.attempts
      .filter(attempt => attempt.conversationId === conversationId && !attempt.historical)
      .map(attempt => ({ taskIds: pipeline.taskIds, project: pipeline.project,
        source: { conversationId, pipelineId: pipeline.id, stageId: run.stageId, attempt: attempt.n } }))));
    if (found.length > 1) throw new PrototypeError("caller holds multiple pipeline stages; publication cannot choose a task",409);
    return found[0] ?? null;
  },
  orchestrator(project) {
    const seat = orchestratorSeatFor(project);
    return seat.active?.conversationId ?? null;
  },
};
export function taskForPrototype(taskId: string, caller: PrototypeCaller, write = false) {
  const task = loadTasks().find(t => t.id === taskId);
  if (!task) throw new PrototypeError("task not found",404);
  if (caller.conversationId && (!caller.project || canonicalProject(task.project) !== canonicalProject(caller.project))) throw new PrototypeError("prototype access is limited to the caller's project",403);
  if (write && runsElsewhere(task)) throw new PrototypeError("this task's prototypes are owned by another installation",409);
  return task;
}
