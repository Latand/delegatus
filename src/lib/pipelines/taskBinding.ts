import type { RuntimeEngine as FlowEngine } from "@/lib/agent/runtimeConfig";
import { firstLineTitle } from "@/lib/tasks/helpers";
import type { BoardTask } from "@/lib/tasks/types";
import { BEARER_TOKEN, hardenedRedact } from "@/lib/view/compactText";

import { MAX_TASK_LENGTH } from "./limits";
import type { CreatePipelineRequest, Pipeline } from "./types";

type TaskPipelineRuntimeParams = {
  repoDir: string;
  engine: FlowEngine;
  model: string | null;
  effort: string | null;
};

export type TaskSpawnPipelineParams = TaskPipelineRuntimeParams & {
  launchId: string;
  conversationId: string;
  /** Conversation receiving the first assignment. */
  srcPath: string | null;
  /** Failed task launch explicitly replaced by this launch. */
  retryOfLaunchId?: string | null;
};

export type TaskPipelineSpawnParams = TaskSpawnPipelineParams | (TaskPipelineRuntimeParams & {
  srcPath: string;
  launchId?: never;
  conversationId?: never;
  retryOfLaunchId?: never;
});

export function isTaskSpawnPipelineParams(params: TaskPipelineSpawnParams): params is TaskSpawnPipelineParams {
  return typeof params.launchId === "string" && typeof params.conversationId === "string";
}

export type TaskPipelineReadModel = BoardTask & { pipelineIds: string[] };

export function projectTaskPipelineIds(
  tasks: readonly BoardTask[],
  pipelines: readonly Pipeline[],
): TaskPipelineReadModel[] {
  if (!tasks.length) return [];
  const requested = new Set(tasks.map(task => task.id));
  const byTask = new Map<string, string[]>();
  for (const pipeline of pipelines) {
    for (const id of new Set(pipeline.taskIds)) {
      if (!requested.has(id)) continue;
      const linked = byTask.get(id);
      if (linked) linked.push(pipeline.id);
      else byTask.set(id, [pipeline.id]);
    }
  }
  return tasks.map((task) => ({
    ...task,
    pipelineIds: [...(byTask.get(task.id) ?? [])],
  }));
}

/** Assignment-time decision. Persistence repeats it under the store lock. */
export function ensurePipelineForTask(
  task: BoardTask,
  pipelines: readonly Pipeline[],
  spawnParams: TaskPipelineSpawnParams,
): CreatePipelineRequest | null {
  const linked = pipelines.some((pipeline) =>
    pipeline.taskIds.includes(task.id) && pipeline.state !== "closed" && !pipeline.hiddenAt);
  if (linked) return null;

  return {
    task: firstLineTitle(task.text).slice(0, MAX_TASK_LENGTH),
    spec: task.text,
    taskIds: [task.id],
    repoDir: spawnParams.repoDir,
    ...(spawnParams.srcPath ? { src: spawnParams.srcPath } : {}),
    inputContext: {
      handoffDigest: hardenedRedact(
        [task.text, task.details].filter(Boolean).join("\n\n").replace(BEARER_TOKEN, "[redacted]"),
      ),
    },
    autoStart: false,
    stages: [{
      id: "run",
      kind: "run",
      role: { roleId: "builder" },
      engine: spawnParams.engine,
      model: spawnParams.model,
      effort: spawnParams.effort,
      access: "read-write",
      "prompt": "{{task}}",
      next: null,
    }],
  };
}
