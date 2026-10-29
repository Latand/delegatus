import type { RuntimeEngine } from "@/lib/agent/runtimeConfig";
import type { Pipeline, PipelineAttemptState, PipelineRoleId, PipelineStageKind } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

export interface TimelineAttempt {
  key: string;
  pipelineId: string;
  stageId: string;
  kind: PipelineStageKind;
  attempt: number;
  state: PipelineAttemptState;
  historical: boolean;
  roleId: PipelineRoleId | null;
  engine: RuntimeEngine | null;
  model: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  /** Recorded completion, or the supplied clock while this attempt is live. */
  endAtMs: number | null;
  live: boolean;
}

export interface TimelinePipeline {
  id: string;
  state: Pipeline["state"];
  createdAtMs: number | null;
  closedAtMs: number | null;
  attempts: TimelineAttempt[];
}

export interface TaskTimeline {
  taskId: string;
  project: string;
  createdAtMs: number | null;
  /** First recorded work; lane creation is the fallback before work starts. */
  startedAtMs: number | null;
  endAtMs: number;
  /** A live stage is the default-expansion candidate. */
  live: boolean;
  pipelines: TimelinePipeline[];
}

const LIVE_STATES = new Set<PipelineAttemptState>(["spawning", "running", "reviewing", "committing"]);
const OPEN_STATES = new Set<Pipeline["state"]>(["provisioning", "running", "needs_decision", "needs_review", "paused"]);

function timestamp(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function timelinePipeline(pipeline: Pipeline, nowMs: number): TimelinePipeline {
  const stages = new Map(pipeline.stages.map(stage => [stage.id, stage]));
  const attempts: TimelineAttempt[] = [];
  for (const run of pipeline.runs) {
    const stage = stages.get(run.stageId);
    const latest = run.attempts.reduce<typeof run.attempts[number] | null>((current, attempt) =>
      !attempt.historical && (!current || attempt.n > current.n) ? attempt : current, null);
    for (const attempt of run.attempts) {
      const startedAtMs = timestamp(attempt.startedAt);
      const completedAtMs = timestamp(attempt.completedAt);
      const live = OPEN_STATES.has(pipeline.state) && pipeline.cursor?.stageId === run.stageId
        && attempt === latest && !attempt.historical
        && LIVE_STATES.has(attempt.state) && startedAtMs !== null && startedAtMs <= nowMs && attempt.completedAt == null;
      // Each attempt freezes its runtime. Editing the stage must not recolour its past.
      const role = attempt.effectiveRole ?? stage?.effectiveRole;
      attempts.push({
        key: JSON.stringify([pipeline.id, run.stageId, attempt.n]),
        pipelineId: pipeline.id,
        stageId: run.stageId,
        kind: attempt.legacyReview ? "review-loop" : stage?.kind ?? "run",
        attempt: attempt.n,
        state: attempt.state,
        historical: attempt.historical === true,
        roleId: role ? role.roleId : attempt.definition?.role?.roleId ?? stage?.role?.roleId ?? null,
        engine: role ? role.engine : stage?.engine ?? null,
        model: role ? role.model : stage?.model ?? null,
        startedAtMs,
        completedAtMs,
        endAtMs: completedAtMs !== null && (startedAtMs === null || completedAtMs >= startedAtMs)
          ? completedAtMs : live ? nowMs : null,
        live,
      });
    }
  }
  attempts.sort((a, b) => (a.startedAtMs ?? Infinity) - (b.startedAtMs ?? Infinity)
    || compareId(a.stageId, b.stageId) || a.attempt - b.attempt);
  return {
    id: pipeline.id,
    state: pipeline.state,
    createdAtMs: timestamp(pipeline.createdAt),
    closedAtMs: timestamp(pipeline.closedAt),
    attempts,
  };
}

/**
 * Browser-safe data for the board's Gantt view. Consume the board's existing
 * workspace-filtered `/api/files?view=summary` tasks and pipelines; full
 * `/api/tasks` and `/api/pipelines` records work too. This projection grants
 * no access: project selection only narrows the already authorized records.
 *
 * An open lane keeps a task in work, including waits for a worker, review or
 * an operator. Drafts, hidden lanes and settled-only tasks contribute no rows.
 * Earlier settled lanes of an active task remain visible as work history.
 * No transcript, account identity or mutable source object is returned.
 */
export function projectTaskTimelines(input: {
  project: string;
  tasks: readonly BoardTask[];
  pipelines: readonly Pipeline[];
  nowMs: number;
}): { nowMs: number; tasks: TaskTimeline[] } {
  const { project, nowMs } = input;
  if (!Number.isFinite(nowMs)) throw new RangeError("timeline clock must be finite");
  const byTask = new Map<string, Pipeline[]>();
  for (const pipeline of input.pipelines) {
    if (pipeline.project !== project || pipeline.hiddenAt || pipeline.state === "draft") continue;
    for (const taskId of new Set(pipeline.taskIds)) {
      const linked = byTask.get(taskId);
      if (linked) linked.push(pipeline);
      else byTask.set(taskId, [pipeline]);
    }
  }
  const tasks: TaskTimeline[] = [];
  for (const task of input.tasks) {
    if (task.project !== project || task.status === "done") continue;
    const linked = byTask.get(task.id) ?? [];
    if (!linked.some(pipeline => OPEN_STATES.has(pipeline.state))) continue;
    const pipelines = linked.map(pipeline => timelinePipeline(pipeline, nowMs));
    pipelines.sort((a, b) => (a.createdAtMs ?? Infinity) - (b.createdAtMs ?? Infinity) || compareId(a.id, b.id));
    let firstWork: number | null = null;
    let firstLane: number | null = null;
    let live = false;
    for (const pipeline of pipelines) {
      if (pipeline.createdAtMs !== null && pipeline.createdAtMs <= nowMs) firstLane = Math.min(firstLane ?? Infinity, pipeline.createdAtMs);
      for (const attempt of pipeline.attempts) {
        if (attempt.startedAtMs !== null && attempt.startedAtMs <= nowMs) firstWork = Math.min(firstWork ?? Infinity, attempt.startedAtMs);
        live ||= attempt.live;
      }
    }
    tasks.push({ taskId: task.id, project, createdAtMs: timestamp(task.createdAt), startedAtMs: firstWork ?? firstLane,
      endAtMs: nowMs, live, pipelines });
  }
  tasks.sort((a, b) => (a.startedAtMs ?? Infinity) - (b.startedAtMs ?? Infinity) || compareId(a.taskId, b.taskId));
  return { nowMs, tasks };
}
