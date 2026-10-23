import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

type PipelineWithTaskIds = Pipeline & { taskIds?: readonly string[] };

function pipelineLineage(pipeline: Pipeline): { paths: Set<string>; conversationIds: Set<string> } {
  const paths = new Set<string>();
  const conversationIds = new Set<string>();
  if (pipeline.srcPath) paths.add(pipeline.srcPath);
  if (pipeline.srcConversationId) conversationIds.add(pipeline.srcConversationId);
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      if (attempt.agentPath) paths.add(attempt.agentPath);
      if (attempt.conversationId) conversationIds.add(attempt.conversationId);
    }
  }
  return { paths, conversationIds };
}

/**
 * Every board task linked to a pipeline (#531): the explicit `taskIds` links
 * and tasks whose source or assignments point into the pipeline's lineage
 * (src conversation or any stage attempt), preserving board-task order.
 */
export function linkedPipelineTasks(pipeline: Pipeline, tasks: readonly BoardTask[]): BoardTask[] {
  const explicit = new Set((pipeline as PipelineWithTaskIds).taskIds ?? []);
  const lineage = pipelineLineage(pipeline);
  return tasks.filter((task) =>
    explicit.has(task.id) ||
    Boolean(
      (task.source && lineage.paths.has(task.source.path)) ||
      task.assignments.some((assignment) =>
        Boolean(
          (assignment.path && lineage.paths.has(assignment.path)) ||
          (assignment.conversationId && lineage.conversationIds.has(assignment.conversationId)),
        ),
      ),
    ),
  );
}
