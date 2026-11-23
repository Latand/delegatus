/*
 * A tap on a stage that has not started, on the task screen,
 * opens its pipeline's screen with that stage's ⚙ sheet open, which shows and
 * edits the message the stage will be sent
 * (docs/design/task-card-no-inline-conversations.md §6). The tap asks here
 * before it pushes the screen; the screen takes the request once, for its own
 * pipeline, when it mounts.
 */

let requested: { pipelineId: string; stageId: string } | null = null;

export function requestPipelineStage(pipelineId: string, stageId: string): void {
  requested = { pipelineId, stageId };
}

/** The stage asked for this pipeline, once; any other pipeline's request is dropped. */
export function takeRequestedStage(pipelineId: string): string | null {
  const found = requested;
  requested = null;
  return found && found.pipelineId === pipelineId ? found.stageId : null;
}
