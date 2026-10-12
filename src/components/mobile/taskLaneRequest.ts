/*
 * «Answer» on a phone card whose lane the operator owns opens the task screen
 * with that lane's sheet open (docs/design/calm-task-cards-build.md §4.3). The
 * card asks here before it pushes the screen; the screen takes the request
 * once, for its own task, when it mounts.
 */

let requested: { taskId: string; pipelineId: string } | null = null;

export function requestTaskLane(taskId: string, pipelineId: string): void {
  requested = { taskId, pipelineId };
}

/** The lane asked for this task, once; any other task's request is dropped. */
export function takeRequestedLane(taskId: string): string | null {
  const found = requested;
  requested = null;
  return found && found.taskId === taskId ? found.pipelineId : null;
}
