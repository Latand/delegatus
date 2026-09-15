import { conversationIdentity } from "@/lib/accounts/identity";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { groupHideState, seatAssignment, type GroupHideState, type GroupResurfaceReason, type SeatRefs } from "@/lib/tasks/groupHide";
import { TASK_COLORS, type BoardTask, type TaskColor, type TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { mobileRowState, nowFragment, type MobileRowStateKey } from "@/components/mobile/mobileBoardModel";
import { latestAttempt, stageAttempts, stageChipState, stageFailEdgeRoundsUsed, type StageChipState } from "@/components/pipelines/pipelineModel";
import type { TaskBand } from "@/components/scheme/taskBands";
import { taskTitle } from "@/components/tasks/taskModel";
import type { TaskWorkflowProjection } from "@/components/tasks/taskWorkflowModel";

import { pastAttempts, stageViews, type PastAttempt, type StageView } from "./pipelineGraph";

/**
 * The kanban board's projection (#1695 K1).
 *
 * The board draws the SAME bands the task-centred scheme draws: `buildTaskBands`
 * decides identity, mirrors, containers and lineage grouping, and this module
 * only arranges them by status. Nothing here re-derives membership, so a
 * conversation sits on the same card on either board.
 *
 * Completeness is the contract. Every stored task of the project is either a
 * card in exactly one column or an off-board task counted in the header; no
 * constant slices the list, and every count is taken before search narrows it.
 * A member the scheme window elided is still counted from its durable
 * assignment or attempt row, so a card never under-reports its conversations.
 */

export const KANBAN_STATUSES: readonly TaskStatus[] = ["inbox", "assigned", "blocked", "done"];

export interface KanbanMember {
  key: string;
  file: FileEntry;
  state: MobileRowStateKey;
  /** A conversation that is owed an answer: waiting, stalled, at a limit. */
  needsYou: boolean;
  working: boolean;
  /** The agent's own words about the work in flight, when it published any. */
  latest: string | null;
  /** Pipeline stage this conversation runs, when it is one. */
  stage: { pipeline: Pipeline; stage: PipelineStage } | null;
}

export interface KanbanMirror {
  key: string;
  file: FileEntry;
  primaryCardId: string;
  primaryTitle: string;
}

export interface KanbanStageChip {
  stage: PipelineStage;
  state: StageChipState;
  /** Review rounds recorded for a review-loop stage. */
  rounds: number;
  /** Off the pass path: reached only through a fail edge. */
  branch: boolean;
}

export interface KanbanLoop {
  from: PipelineStage;
  to: PipelineStage;
  /** Times the fail edge fired, counted from attempt provenance. */
  fired: number;
  max: number;
}

export interface KanbanPipeline {
  pipeline: Pipeline;
  /** Each stage as the graph draws it (#1695 K5a), by stage id. */
  views: Map<string, StageView>;
  chips: KanbanStageChip[];
  loops: KanbanLoop[];
  /** Stages with no attempt yet. */
  waiting: number;
}

export interface KanbanCard {
  /** The band id: `task:<id>` for a recorded task, otherwise the derived origin. */
  id: string;
  task: BoardTask | null;
  origin: TaskBand["origin"];
  status: TaskStatus;
  title: string;
  /** A placeholder task still waiting for its first real title. */
  titlePending: boolean;
  description: string;
  members: KanbanMember[];
  mirrors: KanbanMirror[];
  /** Distinct conversations, counted from members, mirrors and durable rows. */
  conversations: number;
  /** Conversations counted from durable rows whose transcripts this board does not carry. */
  notLoaded: number;
  /** Review decks and worker stacks the band carries besides conversations. */
  otherSurfaces: number;
  /** Agent drafts the card holds, in the band's order: its own «+ Agent», a handoff, a retried launch. */
  drafts: string[];
  pipelines: KanbanPipeline[];
  working: number;
  needsYou: boolean;
  /** Working conversations plus pipelines still provisioning. */
  activity: number;
  /** Nothing on it: no conversation, no active pipeline, nothing owed. */
  idle: boolean;
  updatedAtMs: number;
  lastAgentWorkAtMs: number;
  searchText: string;
  /** The task's colour label, when it names one this build knows. */
  color: TaskColor | null;
  /** Earlier attempts and review rounds of the card's pipelines, newest first. */
  past: PastAttempt[];
  /** Whether the task's group is hidden, and why a hidden one came back. */
  hide: GroupHideState;
  /** The task holds the project's orchestrator seat conversation, active or
      pending: it stays on the board, and the server refuses to hide it. */
  holdsSeat: boolean;
}

export interface KanbanColumn {
  status: TaskStatus;
  /** Every card of the column, ordered. */
  cards: KanbanCard[];
  /** The cards the current search keeps, in the same order. */
  shown: KanbanCard[];
  working: number;
  needsYou: number;
}

export interface KanbanModel {
  columns: Record<TaskStatus, KanbanColumn>;
  /** Bands no recorded task owns yet: pipelines, flows and lineage roots. */
  unlinked: KanbanCard[];
  unlinkedShown: KanbanCard[];
  /** Tasks the board draws no card for: empty tasks taken off the board. */
  offBoard: BoardTask[];
  /** Task groups the operator or an agent hid, newest hide first. Each is a
      whole card, counted here and never in a column. */
  hiddenGroups: KanbanCard[];
  /** Hidden groups that came back because something newer needs the operator. */
  resurfaced: Array<{ card: KanbanCard; reason: GroupResurfaceReason }>;
  totals: {
    tasks: number;
    onBoard: number;
    working: number;
    needsYou: number;
  };
}

export interface KanbanModelInput {
  bands: readonly TaskBand[];
  /** Every stored task of the project, placed or not. */
  tasks: readonly BoardTask[];
  pipelines: readonly Pipeline[];
  projection: TaskWorkflowProjection;
  /** Every conversation this board carries, so a durable row naming one of
      them is never reported as missing. */
  files?: readonly FileEntry[];
  /** The review flows the board carries, for the rounds of review stages. */
  flows?: readonly Flow[];
  /** Optimistic statuses of tasks with a write in flight. */
  statusOverrides?: ReadonlyMap<string, TaskStatus>;
  /** The project's orchestrator seat as the board last read it; null or absent
      while it is unknown. */
  seat?: SeatRefs | null;
  query?: string;
  /** Epoch seconds. */
  now: number;
}

const ACTIVE_PIPELINE_STATES = new Set(["provisioning", "running", "needs_decision", "paused"]);
const NEEDS_STATES: ReadonlySet<MobileRowStateKey> = new Set(["waiting", "stalled", "limit"]);
const WORKING_STATES: ReadonlySet<MobileRowStateKey> = new Set(["working", "held"]);

function parseMs(iso: string | undefined | null): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function descriptionOf(text: string): string {
  const newline = text.search(/\r?\n/);
  return newline < 0 ? "" : text.slice(newline).trim();
}

function stageIndex(pipeline: Pipeline): Map<string, PipelineStage> {
  return new Map(pipeline.stages.map((stage) => [stage.id, stage] as const));
}

/** Stage ids along the pass path from the first stage, in order. */
function passPath(pipeline: Pipeline): string[] {
  const byId = stageIndex(pipeline);
  const targets = new Set(pipeline.stages.flatMap((stage) => (stage.next ? [stage.next] : [])));
  const failTargets = new Set(pipeline.stages.flatMap((stage) => (stage.onFail?.to ? [stage.onFail.to] : [])));
  const start = pipeline.stages.find((stage) => !targets.has(stage.id) && !failTargets.has(stage.id))
    ?? pipeline.stages.find((stage) => !targets.has(stage.id))
    ?? pipeline.stages[0];
  const path: string[] = [];
  const seen = new Set<string>();
  let current: PipelineStage | null = start ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current.id);
    current = current.next ? byId.get(current.next) ?? null : null;
  }
  return path;
}

export function summarizePipeline(pipeline: Pipeline, flowsById: ReadonlyMap<string, Flow> = new Map()): KanbanPipeline {
  const byId = stageIndex(pipeline);
  const views = stageViews(pipeline, flowsById);
  const main = passPath(pipeline);
  const onMain = new Set(main);
  /* Stages reached only through a fail edge are branches; any other stage the
     pass walk did not visit still belongs to the chain, in declared order. */
  const failOnly = new Set(
    pipeline.stages.filter((stage) => !onMain.has(stage.id)
      && pipeline.stages.some((source) => source.onFail?.to === stage.id)
      && !pipeline.stages.some((source) => source.next === stage.id)).map((stage) => stage.id),
  );
  const ordered = [
    ...main,
    ...pipeline.stages.filter((stage) => !onMain.has(stage.id) && !failOnly.has(stage.id)).map((stage) => stage.id),
    ...pipeline.stages.filter((stage) => failOnly.has(stage.id)).map((stage) => stage.id),
  ];
  const chips = ordered.map((id) => {
    const stage = byId.get(id)!;
    /* The embedded review flow's own round count, as the flow projection
       records it on the attempt; a stage with no review flow has none. */
    const rounds = stage.kind === "review-loop"
      ? stageAttempts(pipeline, stage.id).reduce((count, attempt) => count + (attempt.historical ? 0 : attempt.reviewFlowSync?.roundCount ?? 0), 0)
      : 0;
    return { stage, state: views.get(id)?.state ?? stageChipState(pipeline, stage), rounds, branch: failOnly.has(id) };
  });
  const loops: KanbanLoop[] = [];
  for (const stage of pipeline.stages) {
    const edge = stage.onFail;
    if (!edge?.to) continue;
    const to = byId.get(edge.to);
    if (!to) continue;
    /* The engine's spent budget: the target's own attempts this fail edge activated. */
    const fired = stageFailEdgeRoundsUsed(pipeline, stage);
    loops.push({ from: stage, to, fired, max: edge.maxRounds });
  }
  const waiting = pipeline.stages.filter((stage) => latestAttempt(pipeline, stage.id) === null).length;
  return { pipeline, views, chips, loops, waiting };
}

function memberOf(key: string, file: FileEntry, stageByPath: ReadonlyMap<string, { pipeline: Pipeline; stage: PipelineStage }>, now: number): KanbanMember {
  const row = mobileRowState(file, now);
  return {
    key,
    file,
    state: row.key,
    needsYou: NEEDS_STATES.has(row.key),
    working: WORKING_STATES.has(row.key),
    latest: nowFragment(file),
    stage: stageByPath.get(file.path) ?? null,
  };
}

function referenceIdentity(reference: { conversationId: string | null; path: string | null; file: FileEntry | null }): string | null {
  if (reference.file) return conversationIdentity(reference.file);
  return reference.conversationId ?? reference.path;
}

/** Columns keep their status; display order follows actual agent execution. */
export function compareCards(a: KanbanCard, b: KanbanCard): number {
  return b.lastAgentWorkAtMs - a.lastAgentWorkAtMs
    || a.id.localeCompare(b.id);
}

export function cardMatches(card: KanbanCard, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || card.searchText.includes(needle);
}

export function buildKanbanModel(input: KanbanModelInput): KanbanModel {
  const { bands, tasks, pipelines, projection, statusOverrides, now } = input;
  const knownConversations = new Set<string>();
  const workByIdentity = new Map<string, number>();
  for (const file of input.files ?? []) {
    knownConversations.add(file.path);
    const at = file.lastAgentWorkAt;
    if (typeof at === "number" && Number.isFinite(at) && at > 0) {
      for (const key of [file.path, file.conversationId].filter((key): key is string => Boolean(key)))
        workByIdentity.set(key, Math.max(workByIdentity.get(key) ?? 0, at));
    }
    if (file.conversationId) knownConversations.add(file.conversationId);
  }
  const query = input.query ?? "";
  const pipelineById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline] as const));
  const flowsById = new Map((input.flows ?? []).map((flow) => [flow.id, flow] as const));
  const stageByPath = new Map<string, { pipeline: Pipeline; stage: PipelineStage }>();
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) {
      for (const attempt of stageAttempts(pipeline, stage.id)) {
        if (attempt.agentPath) stageByPath.set(attempt.agentPath, { pipeline, stage });
      }
    }
  }
  const workflowByTask = new Map(projection.tasks.map((workflow) => [workflow.task.id, workflow] as const));
  const bandTitle = new Map(bands.map((band) => [band.id, band.title] as const));

  const cards: KanbanCard[] = bands.map((band) => {
    const task = band.task;
    const members = band.members
      .filter((member) => member.kind === "node" && member.file)
      .map((member) => memberOf(member.key, member.file!, stageByPath, now));
    const mirrors = band.mirrors.map((mirror) => ({
      key: mirror.key,
      file: mirror.file,
      primaryCardId: mirror.primaryBandId,
      primaryTitle: bandTitle.get(mirror.primaryBandId) ?? mirror.primaryTitle,
    }));

    const cardPipelines = new Map<string, Pipeline>();
    if (band.pipeline) cardPipelines.set(band.pipeline.id, band.pipeline);
    for (const groupKey of band.groups) {
      const match = /^group::pipeline::(.+)$/.exec(groupKey);
      const pipeline = match ? pipelineById.get(match[1]!) : undefined;
      if (pipeline) cardPipelines.set(pipeline.id, pipeline);
    }
    const workflow = task ? workflowByTask.get(task.id) : undefined;
    for (const execution of workflow?.executions ?? []) {
      if (execution.basis === "explicit") cardPipelines.set(execution.pipeline.id, pipelineById.get(execution.pipeline.id) ?? execution.pipeline);
    }

    /* Conversations: what the band carries, plus durable rows it could not
       resolve to a transcript on this board. */
    const identities = new Set<string>();
    let notLoaded = 0;
    for (const member of members) identities.add(conversationIdentity(member.file));
    for (const mirror of mirrors) identities.add(conversationIdentity(mirror.file));
    const countReference = (reference: { kind: string; conversationId: string | null; path: string | null; file: FileEntry | null }) => {
      if (reference.kind === "planned") return;
      const identity = referenceIdentity(reference);
      if (!identity || identities.has(identity)) return;
      identities.add(identity);
      const known = Boolean(reference.file)
        || (reference.path !== null && knownConversations.has(reference.path))
        || (reference.conversationId !== null && knownConversations.has(reference.conversationId));
      if (!known) notLoaded += 1;
    };
    for (const reference of workflow?.references ?? []) countReference(reference);
    for (const execution of workflow?.executions ?? []) {
      if (execution.basis !== "explicit") continue;
      for (const reference of execution.references) countReference(reference);
    }

    const summaries = [...cardPipelines.values()].map((pipeline) => summarizePipeline(pipeline, flowsById));
    const provisioning = summaries.filter((summary) => summary.pipeline.state === "provisioning").length;
    const pipelineNeeds = summaries.some((summary) => summary.pipeline.state === "needs_decision");
    const working = members.filter((member) => member.working).length;
    const needsYou = pipelineNeeds || members.some((member) => member.needsYou);
    const activePipeline = summaries.some((summary) => ACTIVE_PIPELINE_STATES.has(summary.pipeline.state));
    const overridden = task ? statusOverrides?.get(task.id) : undefined;
    const status: TaskStatus = overridden ?? task?.status ?? "inbox";
    const hide: GroupHideState = task
      ? groupHideState(task, { members: members.map((member) => member.file), pipelines: summaries.map((summary) => summary.pipeline), seat: input.seat })
      : { hidden: false, resurfaced: null };
    const holdsSeat = Boolean(task && input.seat && seatAssignment(task.assignments, input.seat));
    const color = task?.color && (TASK_COLORS as readonly string[]).includes(task.color) ? task.color : null;
    const title = band.title;
    const description = task ? descriptionOf(task.text) : "";
    /* A task's own write time, as the column orders it; a band without a
       task has only its conversations to date it. */
    const updatedAtMs = task
      ? parseMs(task.updatedAt)
      : Math.max(parseMs(band.createdAt), ...members.map((member) => member.file.mtime * 1000));
    const otherSurfaces = band.members.filter((member) => member.kind === "deck" || member.kind === "stack").length;
    const drafts = band.members.flatMap((member) => (member.kind === "draft" ? [member.key.slice("draft::".length)] : []));
    return {
      id: band.id,
      task,
      origin: band.origin,
      status,
      title,
      titlePending: Boolean(task?.origin && task.origin.refinement === "pending") || (task ? !taskTitle(task.text) : false),
      description,
      members,
      mirrors,
      conversations: identities.size,
      notLoaded,
      otherSurfaces,
      drafts,
      pipelines: summaries,
      working,
      needsYou,
      activity: working + provisioning,
      idle: members.length === 0 && mirrors.length === 0 && !activePipeline && !needsYou && otherSurfaces === 0 && drafts.length === 0,
      updatedAtMs,
      lastAgentWorkAtMs: Math.max(0,
        ...[...members, ...mirrors].map(member => member.file.lastAgentWorkAt ?? 0).filter(Number.isFinite),
        ...[...identities].map(id => workByIdentity.get(id) ?? 0)),
      searchText: [title, description, ...members.map((member) => member.file.title ?? ""), ...summaries.map((summary) => summary.pipeline.task)]
        .join("\n")
        .toLowerCase(),
      color,
      past: pastAttempts(summaries.map((summary) => summary.pipeline), flowsById),
      hide,
      holdsSeat,
    };
  });

  const hiddenGroups = cards
    .filter((card) => card.task && card.hide.hidden)
    .sort((a, b) => (b.hide.hidden ? Date.parse(b.hide.since) || 0 : 0) - (a.hide.hidden ? Date.parse(a.hide.since) || 0 : 0));
  const resurfaced = cards.flatMap((card) => (card.task && !card.hide.hidden && card.hide.resurfaced ? [{ card, reason: card.hide.resurfaced }] : []));
  const recorded = cards.filter((card) => card.task && !card.hide.hidden);
  const unlinked = cards.filter((card) => !card.task).sort(compareCards);
  const columns = Object.fromEntries(KANBAN_STATUSES.map((status) => {
    const inColumn = recorded.filter((card) => card.status === status).sort(compareCards);
    return [status, {
      status,
      cards: inColumn,
      shown: inColumn.filter((card) => cardMatches(card, query)),
      working: inColumn.reduce((sum, card) => sum + card.working, 0),
      needsYou: inColumn.filter((card) => card.needsYou).length,
    } satisfies KanbanColumn];
  })) as Record<TaskStatus, KanbanColumn>;

  const carded = new Set([...recorded, ...hiddenGroups].map((card) => card.task!.id));
  const offBoard = tasks.filter((task) => !carded.has(task.id));
  return {
    columns,
    unlinked,
    unlinkedShown: unlinked.filter((card) => cardMatches(card, query)),
    offBoard,
    hiddenGroups,
    resurfaced,
    totals: {
      tasks: tasks.length,
      onBoard: recorded.length,
      /* Agents of a hidden group keep working, and the header says so; a
         decision the operator hid is not counted as waiting on them. */
      working: cards.reduce((sum, card) => sum + card.working, 0),
      needsYou: cards.filter((card) => card.needsYou && !card.hide.hidden).length,
    },
  };
}
