import type { PauseResumeActor } from "@/lib/pauseResumeActor";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * The orchestrator's wires (docs/design/orchestrator-arrows.md, Variant 2,
 * drawn only for a while after the seat acts). This file is the data half:
 * which cards the seat runs, and which changes in the board's own records are
 * the seat's actions. `orchestratorWires.ts` draws them.
 */

/** How long a wire stays after the seat's action on its card. */
export const ORCHESTRATOR_WIRE_HOLD_MS = 60_000;
/** The fade that follows the hold. */
export const ORCHESTRATOR_WIRE_FADE_MS = 1_600;
/** More actions than this in one board update draw nothing: a sweep is not
    a set of gestures (§4, the rule the board's own card flight uses). */
export const ORCHESTRATOR_BURST_LIMIT = 6;
export type LinkTone = "live" | "needs" | "idle";

/** One card the seat runs, and why: a lane it made, or an agent it spawned. */
export interface OrchestratorLink {
  taskId: string;
  via: "pipeline" | "spawn";
  pipelineId: string | null;
  tone: LinkTone;
}

const TONE_RANK: Record<LinkTone, number> = { idle: 0, live: 1, needs: 2 };

function pipelineTone(state: Pipeline["state"]): LinkTone {
  if (state === "needs_decision" || state === "needs_review") return "needs";
  if (state === "running" || state === "provisioning") return "live";
  return "idle";
}

function seatSet(ids: readonly (string | null | undefined)[]): Set<string> {
  return new Set(ids.filter((id): id is string => !!id));
}

/** A lane the seat owns and the board draws: made by the seat (or by its
    deputy for it), neither closed, hidden nor a draft. */
function seatLane(pipeline: Pipeline, seat: ReadonlySet<string>): boolean {
  if (pipeline.hiddenAt || pipeline.state === "closed" || pipeline.state === "draft") return false;
  return seat.has(pipeline.srcConversationId ?? "") || seat.has(pipeline.srcDeputyConversationId ?? "");
}

/**
 * The cards the seat runs, from records `/api/files` already carries: a lane
 * whose `srcConversationId` (or the deputy that made it for the seat) is a seat
 * conversation, and a conversation on the task whose durable lineage names a
 * seat conversation as its parent. Done tasks are left out. One link per task,
 * the most urgent tone winning, a lane before a spawn at equal tone.
 */
export function orchestratorLinks(input: {
  seatConversationIds: readonly (string | null | undefined)[];
  pipelines: readonly Pipeline[];
  tasks: readonly BoardTask[];
  files: readonly FileEntry[];
}): OrchestratorLink[] {
  const seat = seatSet(input.seatConversationIds);
  if (!seat.size) return [];
  const open = new Map(input.tasks.filter((task) => task.status !== "done").map((task) => [task.id, task] as const));
  const links = new Map<string, OrchestratorLink>();
  const offer = (link: OrchestratorLink) => {
    const prior = links.get(link.taskId);
    const rank = TONE_RANK[link.tone] - (prior ? TONE_RANK[prior.tone] : -1);
    if (rank > 0 || (rank === 0 && prior?.via === "spawn" && link.via === "pipeline")) links.set(link.taskId, link);
  };
  for (const pipeline of input.pipelines) {
    if (!seatLane(pipeline, seat)) continue;
    for (const taskId of pipeline.taskIds ?? []) {
      if (open.has(taskId)) offer({ taskId, via: "pipeline", pipelineId: pipeline.id, tone: pipelineTone(pipeline.state) });
    }
  }
  const byId = new Map<string, FileEntry>();
  const byPath = new Map<string, FileEntry>();
  for (const file of input.files) {
    if (!seat.has(file.durableLineage?.parentConversationId ?? "")) continue;
    if (file.conversationId) byId.set(file.conversationId, file);
    byPath.set(file.path, file);
  }
  for (const task of open.values()) {
    for (const assignment of task.assignments) {
      const file = (assignment.conversationId ? byId.get(assignment.conversationId) : undefined) ?? (assignment.path ? byPath.get(assignment.path) : undefined);
      if (!file) continue;
      const tone: LinkTone = file.waitingInput || file.pendingQuestion ? "needs" : file.activity === "live" ? "live" : "idle";
      offer({ taskId: task.id, via: "spawn", pipelineId: null, tone });
    }
  }
  return [...links.values()];
}

/* ── The seat's actions ──────────────────────────────────────────────────── */

/** `pipeline`: the seat started a lane on the card. `stage`: it launched a
    stage of a lane by hand. `move`: it moved the task to another column.
    `task`: it created the task. */
export type SeatActionKind = "pipeline" | "stage" | "move" | "task";

export interface SeatAction {
  kind: SeatActionKind;
  taskId: string;
  /** The lane the action is on; null for a move and a create. */
  pipelineId: string | null;
  /** When the action took effect, in epoch ms from its record. The wire's
      minute runs from here, however late the board reads it. */
  at: number;
}

export interface BoardRecords {
  tasks: readonly BoardTask[];
  pipelines: readonly Pipeline[];
}

const KIND_RANK: Record<SeatActionKind, number> = { task: 0, move: 1, stage: 2, pipeline: 3 };

function bySeat(actor: PauseResumeActor | null | undefined, seat: ReadonlySet<string>): boolean {
  return actor?.kind === "agent" && !!actor.conversationId && seat.has(actor.conversationId);
}

/** When a record's action took effect, while its wire would still hold; null
    once the hold is over. A time ahead of this clock reads as now. */
function actedAt(at: string | null | undefined, nowMs: number): number | null {
  const ms = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return null;
  const effective = Math.min(ms, nowMs);
  return nowMs - effective < ORCHESTRATOR_WIRE_HOLD_MS ? effective : null;
}

type StartedAttempt = Pipeline["runs"][number]["attempts"][number];

function startedAttempts(pipeline: Pipeline): Map<string, StartedAttempt> {
  const started = new Map<string, StartedAttempt>();
  for (const run of pipeline.runs ?? []) {
    for (const attempt of run.attempts ?? []) {
      if (attempt.startedAt && !attempt.historical) started.set(`${run.stageId}#${attempt.n}`, attempt);
    }
  }
  return started;
}

/**
 * What the seat did between two reads of the board's records. Everything is
 * read from rows the client already has: a new lane the seat made, a newly
 * started attempt whose `launchedBy` names the seat (the engine writes it only
 * on the one attempt a start, a retry, a decision answer, a review grant, an
 * accepted head or a skip launched), and a task whose `statusBy` names the
 * seat. A change whose writer is anyone else, or nobody on record, is no
 * action, and so is one whose wire would already be over. One action per
 * card, the weightiest winning; a burst above `ORCHESTRATOR_BURST_LIMIT` cards
 * is no action at all.
 */
export function seatActions(previous: BoardRecords, next: BoardRecords, seatConversationIds: readonly (string | null | undefined)[], nowMs: number): SeatAction[] {
  const seat = seatSet(seatConversationIds);
  if (!seat.size) return [];
  const actions = new Map<string, SeatAction>();
  const offer = (action: SeatAction) => {
    const prior = actions.get(action.taskId);
    if (!prior || KIND_RANK[action.kind] > KIND_RANK[prior.kind]) actions.set(action.taskId, { ...action, at: Math.max(action.at, prior?.at ?? -Infinity) });
    else prior.at = Math.max(prior.at, action.at);
  };

  if (previous.tasks !== next.tasks) {
    const before = new Map(previous.tasks.map((task) => [task.id, task] as const));
    for (const task of next.tasks) {
      const by = task.statusBy;
      const at = by && bySeat(by.actor, seat) ? actedAt(by.at, nowMs) : null;
      if (!by || at === null) continue;
      const prior = before.get(task.id);
      if (prior?.statusBy && prior.statusBy.at === by.at && prior.statusBy.from === by.from) continue;
      /* A row that carried no record a moment ago and is where it was did not move. */
      if (prior && !prior.statusBy && prior.status === task.status) continue;
      offer({ kind: by.from === null ? "task" : "move", taskId: task.id, pipelineId: null, at });
    }
  }

  if (previous.pipelines !== next.pipelines) {
    const before = new Map(previous.pipelines.map((pipeline) => [pipeline.id, pipeline] as const));
    for (const pipeline of next.pipelines) {
      const prior = before.get(pipeline.id);
      if (prior === pipeline || pipeline.hiddenAt || pipeline.state === "closed" || pipeline.state === "draft") continue;
      if (!prior && seatLane(pipeline, seat)) {
        const at = actedAt(pipeline.createdAt, nowMs);
        if (at !== null) for (const taskId of pipeline.taskIds ?? []) offer({ kind: "pipeline", taskId, pipelineId: pipeline.id, at });
      }
      const known = prior ? startedAttempts(prior) : new Map<string, StartedAttempt>();
      const started = startedAttempts(pipeline);
      for (const [key, attempt] of started) {
        const at = !known.has(key) && bySeat(attempt.launchedBy?.actor, seat) ? actedAt(attempt.startedAt, nowMs) : null;
        if (at === null) continue;
        /* The lane's first attempt is its start: a draft the seat started. */
        const kind = started.size === 1 ? "pipeline" : "stage";
        for (const taskId of pipeline.taskIds ?? []) offer({ kind, taskId, pipelineId: pipeline.id, at });
        break;
      }
    }
  }
  return actions.size > ORCHESTRATOR_BURST_LIMIT ? [] : [...actions.values()];
}
