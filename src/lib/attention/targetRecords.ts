import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { isGeometricTarget } from "./targets";
import type { FocusTarget } from "./types";

/**
 * The board rows a device is handed with the read it already makes (#1836):
 * every pipeline the server admitted in the last few minutes, plus whatever a
 * live attention request names.
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
  /**
   * Rows the client says it is holding out of an earlier push that the server
   * does not hold at all — item 1's other half: a lane that was refused, or
   * that never materialized, goes away and SAYS WHY.
   *
   * Only the server can answer this. An echo is retired in the ordinary way by
   * the first complete corpus scan that carries it; a row that scan will never
   * carry would otherwise sit on the board as a lane that does not exist.
   */
  withdrawn: WithdrawnRecord[];
}

/** A row the client holds and the server does not, with the reason it goes. */
export interface WithdrawnRecord {
  id: string;
  reason: WithdrawalReason;
}

/**
 * Why a pushed row is taken back. One value, because there is exactly one
 * thing the server can say with certainty: it looked, and the pipeline is not
 * there — the creation was refused, or it never materialized.
 */
export type WithdrawalReason = "never-materialized";

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

/**
 * How recently a pipeline must have been admitted for the device read to carry
 * it WITHOUT anything asking for it.
 *
 * This is item 1 on its own terms: the lane is on the board from the moment
 * the server answered the creation, whether or not anybody ever requests
 * attention on it. The browser cannot learn of an `create_pipeline` the
 * operator never made from its own board read — `/api/files` is a whole-corpus
 * scan of about fourteen seconds, served stale-while-revalidate — so the read
 * it is ALREADY making every four seconds carries the freshly admitted rows
 * with it. No new poll, no new socket, and no guess: these are rows the server
 * holds.
 *
 * The window is what bounds it. A pipeline older than this has been through
 * several complete scans and is on the board the ordinary way; re-pushing it
 * would put the whole registry on a four-second poll forever.
 */
export const ADMISSION_WINDOW_MS = 180_000;

/** The ids of the rows a client says it is holding from an earlier push, so
    the server can tell it which of them it does not hold. Bounded on the way
    in: a device naming a thousand ids must not turn a poll into a scan. */
export const MAX_ECHOED_IDS = 16;

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
 * The rows this device is owed right now, or null when there are none.
 *
 * Three things end up here, and the first is the one item 1 is about:
 *
 * - every pipeline admitted inside {@link ADMISSION_WINDOW_MS}, asked for by
 *   nobody. This is what puts a lane on the board from the moment the server
 *   answered its creation, with no attention request in the story at all;
 * - the rows a live request's target names, so the handoff that follows a few
 *   milliseconds later has a card to land on;
 * - the ids the client says it holds and the registry does not, which come
 *   back as withdrawals.
 *
 * A pipeline drags in the tasks it is filed under and a task drags in the
 * pipelines filed under it, because the lane the operator is being taken to is
 * the TASK CARD that carries the pipeline: pushing one without the other would
 * put a record in the client that still draws no card.
 */
export function attentionTargetRecords(
  targets: readonly FocusTarget[],
  sources: AttentionRecordSources,
  options: { now?: Date; echoedPipelineIds?: readonly string[] } = {},
): AttentionTargetRecords | null {
  const pipelineIds = new Set<string>();
  const targetTaskIds = new Set<string>();
  for (const target of targets) {
    const wanted = wantedIds(target);
    if (wanted.pipelineId) pipelineIds.add(wanted.pipelineId);
    if (wanted.taskId) targetTaskIds.add(wanted.taskId);
  }
  const echoed = (options.echoedPipelineIds ?? []).slice(0, MAX_ECHOED_IDS);
  const admittedSince = (options.now?.getTime() ?? Date.now()) - ADMISSION_WINDOW_MS;

  const storedPipelines = sources.pipelines();
  const pipelines: Pipeline[] = [];
  const taskIds = new Set(targetTaskIds);
  const held = new Set<string>();
  const addPipeline = (pipeline: Pipeline) => {
    if (pipelines.length >= MAX_RECORDS_PER_KIND || pipelines.some((row) => row.id === pipeline.id)) return;
    pipelines.push(pipeline);
    for (const id of pipeline.taskIds ?? []) taskIds.add(id);
  };
  const recentlyAdmitted: Pipeline[] = [];
  for (const pipeline of storedPipelines) {
    held.add(pipeline.id);
    /* The lane the target names, and — for a task target — the lanes filed
       under it, which are what that card draws as its stages. */
    if (pipelineIds.has(pipeline.id) || (pipeline.taskIds ?? []).some((id) => targetTaskIds.has(id))) addPipeline(pipeline);
    else if (Date.parse(pipeline.createdAt) >= admittedSince) recentlyAdmitted.push(pipeline);
  }
  /* Newest first, so the cap keeps the lane the operator is least likely to
     have on screen rather than whichever the registry happened to list. */
  recentlyAdmitted.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  for (const pipeline of recentlyAdmitted) addPipeline(pipeline);

  const tasks = taskIds.size === 0 ? [] : sources.tasks()
    .filter((task) => taskIds.has(task.id))
    .slice(0, MAX_RECORDS_PER_KIND);

  /* A row the client holds out of an earlier push and the registry does not
     carry at all: refused, or never materialized. Said once, per id, with the
     reason — the client takes the lane off the board rather than leaving it
     standing for a scan that will never carry it. */
  const withdrawn: WithdrawnRecord[] = echoed
    .filter((id) => !held.has(id))
    .map((id) => ({ id, reason: "never-materialized" as const }));

  return pipelines.length === 0 && tasks.length === 0 && withdrawn.length === 0
    ? null
    : { pipelines, tasks, withdrawn };
}
