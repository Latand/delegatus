import type { TaskWorkflowProjection } from "@/components/tasks/taskWorkflowModel";
import type { BoardTask } from "@/lib/tasks/types";
import type { TimelineMember } from "./taskTimeline";

/** Resolved workers also survive layout folding into pipeline groups. */
export function resolvedTimelineMembers(projection: TaskWorkflowProjection, shownTasks: readonly BoardTask[]): TimelineMember[] {
  const shown = new Set(shownTasks.map(task => task.id));
  return projection.tasks.flatMap(workflow => {
    if (!shown.has(workflow.task.id)) return [];
    const bound = new Set(workflow.executions.filter(execution => !execution.pipeline.hiddenAt && execution.pipeline.state !== "draft"
      && execution.pipeline.project === workflow.task.project && (execution.basis === "explicit"
        || workflow.task.origin?.kind === "pipeline" && workflow.task.origin.key === execution.pipeline.id)).map(execution => execution.pipeline.id));
    return workflow.references.flatMap(reference => reference.file && (reference.kind === "assignment"
      || reference.pipelineId && bound.has(reference.pipelineId)) ? [{ taskId: workflow.task.id, file: reference.file }] : []);
  });
}
