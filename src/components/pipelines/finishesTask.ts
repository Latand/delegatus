import type { TFunction } from "@/lib/i18n";
import { finishesTask, openPipelinesOnTask } from "@/lib/pipelines/taskFinish";
import type { Pipeline } from "@/lib/pipelines/types";

import type { PipelinePorts } from "@/components/kanban/pipelinePorts";

/*
 * The lane menu's "Finishes the task" (#2187 §6), one rule for the desktop ⋯
 * and the phone's lane sheet: whether it is offered and checked, and how many
 * other open pipelines on the task Done would wait for, said whether it is
 * checked or not.
 */

export interface FinishesTaskOffer {
  checked: boolean;
  /** Other started pipelines on the task that are still open. */
  open: number;
}

/** Null where the toggle means nothing: no task, a closed lane, or a lane
    that already finished this task. */
export function finishesTaskOffer(pipeline: Pipeline, taskId: string | null | undefined, pipelines: readonly Pipeline[]): FinishesTaskOffer | null {
  if (!taskId || pipeline.state === "closed" || !(pipeline.taskIds ?? []).includes(taskId)) return null;
  if ((pipeline.taskFinishes ?? []).some((finish) => finish.taskId === taskId)) return null;
  return { checked: finishesTask(pipeline, taskId), open: openPipelinesOnTask(pipelines, taskId, pipeline.id).length };
}

/** Sets or clears the flag with `link-task`, an upsert, and says so. */
export async function toggleFinishesTask(
  ports: PipelinePorts,
  pipeline: Pipeline,
  taskId: string,
  title: string,
  t: TFunction,
  show: (text: string, error?: boolean) => void,
): Promise<void> {
  const next = !finishesTask(pipeline, taskId);
  const result = await ports.patch(pipeline.id, { action: "link-task", taskId, finishes: next });
  if (result.ok) show(t(next ? "pipelineBlock.finish.set" : "pipelineBlock.finish.cleared", { title }));
  else show(t("pipelineBlock.finish.failed", { title, error: result.error }), true);
}
