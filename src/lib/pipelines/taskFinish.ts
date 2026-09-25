import type { Pipeline, PipelineState } from "./types";

/*
 * A pipeline that finishes its task (#2187 §5), the rules both the finish
 * sweep (`src/lib/forge/autoMerge.ts`) and the board read. Pure, so the board
 * imports it without the sweep's `gh` runner.
 */

/** The states of another pipeline on the task that hold its move to Done
    (§5.3). A draft asks nothing yet; completed and closed have ended. */
export const TASK_FINISH_HOLDING_STATES: ReadonlySet<PipelineState> = new Set(["provisioning", "running", "paused", "needs_review", "needs_decision"]);

/** The other pipelines on a task that hold its move to Done, by id. */
export function openPipelinesOnTask(pipelines: readonly Pipeline[], taskId: string, except: string): string[] {
  return pipelines
    .filter((candidate) => candidate.id !== except && (candidate.taskIds ?? []).includes(taskId) && TASK_FINISH_HOLDING_STATES.has(candidate.state))
    .map((candidate) => candidate.id)
    .sort();
}

export function finishesTask(pipeline: Pipeline, taskId: string): boolean {
  return (pipeline.finishesTaskIds ?? []).includes(taskId) && (pipeline.taskIds ?? []).includes(taskId);
}

/** What the lane row says about the task it sits on (§6): it finished it, its
    finished move waits on `open` other pipelines, or it is marked to finish
    it. Null for a lane that does not finish this task. */
export type PipelineTaskFinishState =
  | { kind: "finished" }
  | { kind: "waits"; open: number }
  | { kind: "marked" };

export function pipelineTaskFinishState(pipeline: Pipeline, taskId: string): PipelineTaskFinishState | null {
  if ((pipeline.taskFinishes ?? []).some((finish) => finish.taskId === taskId)) return { kind: "finished" };
  if (!finishesTask(pipeline, taskId)) return null;
  const wait = (pipeline.taskFinishWaits ?? []).find((entry) => entry.taskId === taskId);
  return wait && wait.open.length > 0 ? { kind: "waits", open: wait.open.length } : { kind: "marked" };
}

/** How many more pipelines a task's move to Done waits on, the most any of
    its finished marked lanes recorded (§5.3); 0 when nothing waits. */
export function taskFinishWaitCount(pipelines: readonly Pipeline[], taskId: string): number {
  let open = 0;
  for (const pipeline of pipelines) {
    const state = pipelineTaskFinishState(pipeline, taskId);
    if (state?.kind === "waits") open = Math.max(open, state.open);
  }
  return open;
}
