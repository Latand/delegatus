import type { Pipeline, PipelineAttemptState, PipelineStageKind } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { isWorkingAgent } from "@/components/workingAgents";

export interface TimelineAttempt {
  key: string;
  pipelineId: string | null;
  stageId: string;
  kind: PipelineStageKind;
  attempt: number;
  state: PipelineAttemptState;
  historical: boolean;
  roleId: string | null;
  engine: Exclude<FileEntry["engine"], "shell"> | null;
  model: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  /** Attempt lifecycle end, including waits; never an active-work duration. */
  endAtMs: number | null;
  /** The single native turn visible in the authorized board snapshot, not total work. */
  observedTurn: { startedAtMs: number; endAtMs: number } | null;
  activity: "working" | "idle" | "unknown";
  live: boolean;
  /** The engine confirmed a stop; the recorded state is still the one it held. */
  stopped: boolean;
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
  /** Live agent work is the default-expansion candidate. */
  live: boolean;
  pipelines: TimelinePipeline[];
  /** Current turns not already represented by a live pipeline attempt. */
  agents: TimelineAttempt[];
}

export interface TimelineMember { taskId: string; file: FileEntry }

const LIVE_STATES = new Set<PipelineAttemptState>(["spawning", "running", "reviewing", "committing"]);
const OPEN_STATES = new Set<Pipeline["state"]>(["provisioning", "running", "needs_decision", "needs_review", "paused"]);

function timestamp(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function observedTurn(file: FileEntry | undefined, start: number | null, end: number | null, nowMs: number, working: boolean) {
  const turn = file?.lastTurn;
  if (!turn || start === null || end === null || !Number.isFinite(turn.startedAt)
    || turn.startedAt < start || turn.startedAt > nowMs) return null;
  // An unclosed turn on a dead/idle host gives no evidence for the silent tail.
  const turnEnd = turn.endedAt === null ? working ? nowMs : null : turn.endedAt;
  if (turnEnd === null || !Number.isFinite(turnEnd) || turnEnd < turn.startedAt || turnEnd > nowMs) return null;
  const endAtMs = Math.min(end, turnEnd);
  return endAtMs >= turn.startedAt ? { startedAtMs: turn.startedAt, endAtMs } : null;
}

function timelinePipeline(pipeline: Pipeline, nowMs: number, fileFor: (identity: string) => FileEntry | undefined, liveConversations: Set<string>, stoppedConversations: Map<string, number>): TimelinePipeline {
  const stages = new Map(pipeline.stages.map(stage => [stage.id, stage]));
  const attempts: TimelineAttempt[] = [];
  for (const run of pipeline.runs) {
    const stage = stages.get(run.stageId);
    const latest = run.attempts.reduce<typeof run.attempts[number] | null>((current, attempt) =>
      !attempt.historical && (!current || attempt.n > current.n) ? attempt : current, null);
    for (const attempt of run.attempts) {
      const startedAtMs = timestamp(attempt.startedAt);
      const completedAtMs = timestamp(attempt.completedAt);
      const stoppedAtMs = timestamp(attempt.suspension?.stoppedAt);
      const completedEnd = completedAtMs !== null && startedAtMs !== null && completedAtMs >= startedAtMs ? completedAtMs : null;
      const stoppedEnd = stoppedAtMs !== null && startedAtMs !== null && stoppedAtMs >= startedAtMs && stoppedAtMs <= nowMs ? stoppedAtMs : null;
      const operational = OPEN_STATES.has(pipeline.state) && pipeline.cursor?.stageId === run.stageId
        && attempt === latest && !attempt.historical
        && LIVE_STATES.has(attempt.state) && startedAtMs !== null && startedAtMs <= nowMs
        && attempt.completedAt == null && attempt.suspension?.stoppedAt == null;
      // A recorded ID remains authoritative even when it is unresolved. A
      // stale path can belong to another independently assigned conversation.
      const identity = attempt.conversationId || attempt.agentPath;
      const file = identity ? fileFor(identity) : undefined;
      const live = operational && !!file && isWorkingAgent(file, nowMs / 1000);
      const confirmedIdle = !!file && (file.proc === "killed" || file.proc === "done"
        || typeof file.lastTurn?.endedAt === "number" && Number.isFinite(file.lastTurn.endedAt) && file.lastTurn.endedAt <= nowMs);
      const endAtMs = stoppedEnd !== null ? Math.min(stoppedEnd, completedEnd ?? Infinity) : completedEnd ?? (operational ? nowMs : null);
      if (operational && identity) liveConversations.add(identity);
      if (identity && stoppedAtMs !== null && stoppedAtMs <= nowMs) {
        stoppedConversations.set(identity, Math.max(stoppedConversations.get(identity) ?? -Infinity, stoppedAtMs));
      }
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
        endAtMs,
        observedTurn: observedTurn(file, startedAtMs, endAtMs, nowMs, live),
        activity: live ? "working" : confirmedIdle ? "idle" : "unknown",
        live,
        stopped: stoppedEnd !== null && LIVE_STATES.has(attempt.state),
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
 * An open lane or a working resolved member keeps a task in work, including
 * lane waits for a worker, review or an operator. Drafts, hidden lanes and
 * settled tasks without working members contribute no rows.
 * Earlier settled lanes of an active task remain visible as work history.
 * No transcript, account identity or mutable source object is returned.
 */
export function projectTaskTimelines(input: {
  project: string;
  tasks: readonly BoardTask[];
  pipelines: readonly Pipeline[];
  /** Resolved, authorized members of shown board cards; never raw assignments. */
  members?: readonly TimelineMember[];
  nowMs: number;
}): { nowMs: number; tasks: TaskTimeline[] } {
  const { project, nowMs } = input;
  if (!Number.isFinite(nowMs)) throw new RangeError("timeline clock must be finite");
  const byTask = new Map<string, Pipeline[]>();
  const filesByTask = new Map<string, Map<string, FileEntry>>();
  for (const { taskId, file } of input.members ?? []) {
    if (file.project !== project) continue;
    const files = filesByTask.get(taskId) ?? new Map<string, FileEntry>();
    for (const id of [file.conversationId, file.path]) if (id) files.set(id, file);
    filesByTask.set(taskId, files);
  }
  const projectedPipelines = new Map<string, TimelinePipeline>();
  const liveConversations = new Map<string, Set<string>>();
  const stoppedConversations = new Map<string, Map<string, number>>();
  for (const pipeline of input.pipelines) {
    if (pipeline.project !== project || pipeline.hiddenAt || pipeline.state === "draft") continue;
    const conversations = new Set<string>();
    const stops = new Map<string, number>();
    const fileFor = (identity: string) => {
      for (let index = pipeline.taskIds.length - 1; index >= 0; index--) {
        const file = filesByTask.get(pipeline.taskIds[index]!)?.get(identity);
        if (file) return file;
      }
      return undefined;
    };
    projectedPipelines.set(pipeline.id, timelinePipeline(pipeline, nowMs, fileFor, conversations, stops));
    for (const taskId of new Set(pipeline.taskIds)) {
      const represented = liveConversations.get(taskId) ?? new Set<string>();
      for (const id of conversations) represented.add(id);
      liveConversations.set(taskId, represented);
      const stopped = stoppedConversations.get(taskId) ?? new Map<string, number>();
      for (const [id, at] of stops) stopped.set(id, Math.max(stopped.get(id) ?? -Infinity, at));
      stoppedConversations.set(taskId, stopped);
      const linked = byTask.get(taskId);
      if (linked) linked.push(pipeline);
      else byTask.set(taskId, [pipeline]);
    }
  }
  const tasks: TaskTimeline[] = [];
  const members = new Map<string, TimelineAttempt[]>();
  const seen = new Set<string>();
  for (const { taskId, file } of input.members ?? []) {
    if (file.project !== project || !isWorkingAgent(file, nowMs / 1000)
      || [file.conversationId, file.path].some(id => id && liveConversations.get(taskId)?.has(id))) continue;
    const key = JSON.stringify([taskId, file.conversationId ?? file.path]);
    if (seen.has(key)) continue;
    seen.add(key);
    const launch = file.spawn ?? file.launch;
    const start = file.lastTurn?.endedAt === null ? file.lastTurn.startedAt : launch?.admittedAt ?? launch?.promptAt ?? launch?.deliveredAt;
    const startedAtMs = typeof start === "number" && Number.isFinite(start) && start <= nowMs ? start : null;
    // Scanner liveness may lag the engine's confirmed stop. Only a later
    // turn can establish new work beyond that recorded boundary.
    if ([file.conversationId, file.path].some(id => {
      const stoppedAt = id ? stoppedConversations.get(taskId)?.get(id) : undefined;
      return stoppedAt !== undefined && (startedAtMs === null || startedAtMs <= stoppedAt);
    })) continue;
    const rows = members.get(taskId) ?? [];
    rows.push({ key, pipelineId: null, stageId: "", kind: "run", attempt: 1, state: "running", historical: false,
      roleId: file.durableLineage?.role ?? null, engine: file.engine === "shell" ? null : file.engine,
      model: file.model, startedAtMs, completedAtMs: null, endAtMs: startedAtMs === null ? null : nowMs,
      observedTurn: observedTurn(file, startedAtMs, startedAtMs === null ? null : nowMs, nowMs, true), activity: "working", live: true, stopped: false });
    members.set(taskId, rows);
  }
  const materialized = new Set<string>();
  for (const task of input.tasks) {
    if (task.project !== project || task.status === "done") continue;
    const linked = byTask.get(task.id) ?? [];
    const agents = members.get(task.id) ?? [];
    if (!agents.length && !linked.some(pipeline => OPEN_STATES.has(pipeline.state))) continue;
    const pipelines = linked.map(pipeline => {
      const projected = projectedPipelines.get(pipeline.id)!;
      if (materialized.has(pipeline.id)) return structuredClone(projected);
      materialized.add(pipeline.id);
      return projected;
    });
    pipelines.sort((a, b) => (a.createdAtMs ?? Infinity) - (b.createdAtMs ?? Infinity) || compareId(a.id, b.id));
    let firstWork: number | null = null;
    let firstLane: number | null = null;
    let live = false;
    agents.sort((a, b) => (a.startedAtMs ?? Infinity) - (b.startedAtMs ?? Infinity) || compareId(a.key, b.key));
    for (const agent of agents) {
      if (agent.startedAtMs !== null) firstWork = Math.min(firstWork ?? Infinity, agent.startedAtMs);
      live = true;
    }
    for (const pipeline of pipelines) {
      if (pipeline.createdAtMs !== null && pipeline.createdAtMs <= nowMs) firstLane = Math.min(firstLane ?? Infinity, pipeline.createdAtMs);
      for (const attempt of pipeline.attempts) {
        if (attempt.startedAtMs !== null && attempt.startedAtMs <= nowMs) firstWork = Math.min(firstWork ?? Infinity, attempt.startedAtMs);
        live ||= attempt.live;
      }
    }
    tasks.push({ taskId: task.id, project, createdAtMs: timestamp(task.createdAt), startedAtMs: firstWork ?? firstLane,
      endAtMs: nowMs, live, pipelines, agents });
  }
  tasks.sort((a, b) => (a.startedAtMs ?? Infinity) - (b.startedAtMs ?? Infinity) || compareId(a.taskId, b.taskId));
  return { nowMs, tasks };
}
