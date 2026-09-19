import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { isGeometricTarget } from "./targets";
import type { FocusTarget } from "./types";

/**
 * The board rows behind a request's target, pushed to the browser WITH the
 * request (#1836).
 *
 * The production failure this closes: `create_pipeline` answered a pipeline at
 * 08:28:04, its build stage was live by 08:29, and `request_attention` on it
 * answered TARGET_LOST a minute later. Nothing was wrong with the navigator —
 * the browser's board payload simply did not carry the pipeline or its task.
 * `/api/files` is a whole-corpus scan that takes about fourteen seconds and is
 * served stale-while-revalidate, so a lane created seconds ago is not in the
 * data the board draws from, and a card that does not exist has no anchor to
 * land on.
 *
 * Telling the client to refetch would not help: the refetch is the very scan
 * that is behind. So the server hands over what it already knows, on the poll
 * that delivers the request, and the client layers it into the board's data
 * layer as an optimistic row. The board then draws the lane — title, task
 * band, one pending slot per stage — out of its ordinary projection, with no
 * component changed and nothing invented here.
 *
 * Only rows the server actually holds are returned: a target that names
 * nothing yields nothing, which is what keeps TARGET_LOST meaning "there is no
 * such thing" rather than "the browser was behind".
 */
export interface AttentionTargetRecords {
  pipelines: Pipeline[];
  tasks: BoardTask[];
}

/** Where the rows are read from. Injected so the resolution is testable, and
    so the stores are touched only when a live request actually names one. */
export interface AttentionRecordSources {
  pipelines(): readonly Pipeline[];
  tasks(): readonly BoardTask[];
}

/**
 * The rows one poll may carry. A handful of live requests, each naming one
 * lane and the tasks it belongs to, is the whole of the intended traffic; the
 * cap is what stops a pathological target (a task carrying a long history of
 * pipelines) from putting a large graph on a four-second poll.
 */
const MAX_RECORDS_PER_KIND = 8;

/** The ids a target needs drawn before it can be landed on. A conversation
    target is not here: the navigator already materializes a missing card
    through the shell, and a geometric target is its own destination. */
function wantedIds(target: FocusTarget): { pipelineId?: string; taskId?: string } {
  if (isGeometricTarget(target)) return {};
  switch (target.kind) {
    case "pipeline":
    case "stage":
      return { pipelineId: target.pipelineId };
    case "task":
      return { taskId: target.taskId };
    default:
      return {};
  }
}

/**
 * The rows the given targets name, or null when they name none — in which case
 * no store is read at all.
 *
 * A pipeline drags in the tasks it is filed under and a task drags in the
 * pipelines filed under it, because the lane the operator is being taken to is
 * the TASK CARD that carries the pipeline: pushing one without the other would
 * put a record in the client that still draws no card.
 */
export function attentionTargetRecords(
  targets: readonly FocusTarget[],
  sources: AttentionRecordSources,
): AttentionTargetRecords | null {
  const pipelineIds = new Set<string>();
  const targetTaskIds = new Set<string>();
  for (const target of targets) {
    const wanted = wantedIds(target);
    if (wanted.pipelineId) pipelineIds.add(wanted.pipelineId);
    if (wanted.taskId) targetTaskIds.add(wanted.taskId);
  }
  if (pipelineIds.size === 0 && targetTaskIds.size === 0) return null;

  const storedPipelines = sources.pipelines();
  const pipelines: Pipeline[] = [];
  const taskIds = new Set(targetTaskIds);
  const addPipeline = (pipeline: Pipeline) => {
    if (pipelines.length >= MAX_RECORDS_PER_KIND || pipelines.some((held) => held.id === pipeline.id)) return;
    pipelines.push(pipeline);
    for (const id of pipeline.taskIds ?? []) taskIds.add(id);
  };
  for (const pipeline of storedPipelines) {
    /* The lane the target names, and — for a task target — the lanes filed
       under it, which are what that card draws as its stages. */
    if (pipelineIds.has(pipeline.id) || (pipeline.taskIds ?? []).some((id) => targetTaskIds.has(id))) addPipeline(pipeline);
  }

  const tasks = sources.tasks()
    .filter((task) => taskIds.has(task.id))
    .slice(0, MAX_RECORDS_PER_KIND);

  return pipelines.length === 0 && tasks.length === 0 ? null : { pipelines, tasks };
}
