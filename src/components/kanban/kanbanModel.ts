import { reviewerBindingTargetsForRound } from "@/components/flows/flowModel";
import { conversationIdentity } from "@/lib/accounts/identity";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { groupHideState, isSeatConversation, seatAssignment, seatOnlyTask, type GroupHideState, type GroupResurfaceReason, type SeatRefs } from "@/lib/tasks/groupHide";
import { LAUNCH_NOT_STARTED_ERROR, TASK_COLORS, type BoardTask, type TaskColor, type TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { byNeedAge, conversationNeed, laneNeed, type ClearedNeed, type NeedReason } from "@/components/attention/needReason";
import { mobileRowState, nowFragment, type MobileRowStateKey } from "@/components/mobile/mobileBoardModel";
import { latestAttempt, stageAttempts, stageChipState, stageFailEdgeRoundsUsed, type StageChipState } from "@/components/pipelines/pipelineModel";
import { deckKey } from "@/components/scheme/agentLinks";
import type { TaskBand } from "@/components/scheme/taskBands";
import type { TaskWorkflowProjection } from "@/components/tasks/taskWorkflowModel";
import { workingSince } from "@/components/workingSince";

import { pastAttempts, stageViews, type PastAttempt, type StageView } from "./pipelineGraph";
import { placeholderTitle } from "./placeholderTitle";

/**
 * The kanban board's projection (#1695 K1).
 *
 * The board draws the SAME bands the task-centred scheme draws: `buildTaskBands`
 * decides identity, mirrors, containers and lineage grouping, and this module
 * only arranges them by status. Nothing here re-derives membership, so a
 * conversation sits on the same card on either board.
 *
 * Completeness is the contract. Every stored task of the project is either a
 * card in exactly one column, an off-board task counted in the header, or a
 * seat task (#1841) the seat panel lists instead of the board; no
 * constant slices the list, and every count is taken before search narrows it.
 * A member the scheme window elided is still counted from its durable
 * assignment or attempt row, so a card never under-reports its conversations.
 */

export const KANBAN_STATUSES: readonly TaskStatus[] = ["inbox", "assigned", "blocked", "done"];

export interface KanbanMember {
  key: string;
  file: FileEntry;
  state: MobileRowStateKey;
  /** A conversation that is owed an answer: its reason is flagged. */
  needsYou: boolean;
  /** Why it needs the operator, flagged or cleared; null when it asks nothing. */
  need: NeedReason | null;
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
  /** The project this card belongs to. One project's board draws one value;
      the cross-project Overview (#1820) draws the label from it and a status
      move writes with it. */
  project: string;
  task: BoardTask | null;
  origin: TaskBand["origin"];
  status: TaskStatus;
  title: string;
  /** A placeholder task still waiting for its first real title. */
  titlePending: boolean;
  description: string;
  /** Agent-facing context the card keeps behind one collapsed Details row
      (#1834); empty when the task has none, and the row is then absent. */
  details: string;
  members: KanbanMember[];
  mirrors: KanbanMirror[];
  /** Distinct conversations the card holds, counted from members, mirrors
      and durable rows that name a transcript or a minted conversation id. A
      launch that did not start is not one of them: it is listed in
      `unstarted`. */
  conversations: number;
  /** Conversations counted from durable rows whose transcripts this board
      does not carry: every row that names a transcript or a minted
      conversation id. */
  notLoaded: number;
  /** Those the card lists, each with the transcript or conversation id it
      opens. A pipeline stage's or a review round's is left out: it opens from
      its pipeline's chips and Past attempts. */
  notLoadedRefs: KanbanRecordedConversation[];
  /** The task's own launches that did not start, on evidence only: a failed
      receipt at once, and a launch that never minted a conversation past the
      grace a starting launch gets. None is a conversation; the card offers to
      dismiss each, and a failed one opens its launch view. A stage attempt or
      a review round is never one: its pipeline shows it. */
  unstarted: KanbanUnstartedLaunch[];
  /** Review decks and worker stacks the band carries besides conversations. */
  otherSurfaces: number;
  /** Agent drafts the card holds, in the band's order: its own «+ Agent», a handoff, a retried launch. */
  drafts: string[];
  pipelines: KanbanPipeline[];
  working: number;
  /** Something on the card needs the operator: `reasons` is not empty. */
  needsYou: boolean;
  /** Why, oldest first: every member's flagged reason and every lane parked
      on the operator that nobody cleared (docs/design/needs-attention.md §4). */
  reasons: NeedReason[];
  /** Reasons that are still live and were dismissed, with who cleared them
      and when, newest dismissal first. */
  cleared: ClearedNeed[];
  /** Working conversations plus pipelines still provisioning. */
  activity: number;
  /** Nothing on it: no conversation, no active pipeline, nothing owed. */
  idle: boolean;
  updatedAtMs: number;
  /** Newest agent work of anything the card holds, epoch ms: its conversations
      and mirrors, every attempt of its pipelines, its review decks; 0 when
      none is known. */
  lastAgentWorkAtMs: number;
  /** Null unless work is in flight on the card right now: a member
      conversation working, or a stage of a pipeline that is not paused
      running, reviewing or committing. Then when the newest of that work
      started, epoch ms, or 0 when no start is known. */
  workingSinceMs: number | null;
  searchText: string;
  /** The task's colour label, when it names one this build knows. */
  color: TaskColor | null;
  /** The task's stored lucide icon (#2102); null draws the title's suggestion. */
  icon: string | null;
  /** Earlier attempts and review rounds of the card's pipelines, newest first. */
  past: PastAttempt[];
  /** Whether the task's group is hidden, and why a hidden one came back. */
  hide: GroupHideState;
  /** The task holds the project's orchestrator seat conversation, active or
      pending: it stays on the board, and the server refuses to hide it. */
  holdsSeat: boolean;
}

/** A conversation the card holds that this board did not load. It opens by
    its conversation id, or by its transcript path when it has no id. */
export interface KanbanRecordedConversation {
  key: string;
  path: string | null;
  conversationId: string | null;
}

/** A launch recorded on the task that did not start. */
export interface KanbanUnstartedLaunch {
  key: string;
  launchId: string | null;
  conversationId: string | null;
  /** When the launch was recorded, epoch ms. */
  atMs: number;
  /** The launch failed: its receipt's error, and the placeholder that opens
      the launch view, where Retry lives. Null for a launch that never minted
      a conversation. */
  failed: { error: string | null; file: FileEntry } | null;
  /** The task still holds a live assignment for it, which Dismiss settles. */
  dismissable: boolean;
}

/** How long a launch that has minted no conversation may still count as
    starting. */
export const LAUNCH_START_GRACE_MS = 10 * 60_000;

/** The client attempt ids the pipeline engine (`pipeline_<id>_<stage>_<n>`,
    and `handshake_retry_<k>_…` when it retries a handshake) and the review-flow
    engine (`flow_<id>_…`) give their own launches. */
const ENGINE_ATTEMPT_ID = /^(?:pipeline|flow|handshake_retry)_/;

/** A projected launch placeholder whose launch failed: nothing ever ran. */
function failedLaunchPlaceholder(file: FileEntry): boolean {
  return file.path.startsWith("spawn:") && file.spawn?.state === "failed";
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
  /** Tasks that exist only for the orchestrator seat (#1841): the seat panel
      lists them, and no column, counter or tray does. */
  seatTasks: BoardTask[];
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
  /** A second narrowing beside `query`, applied where search is applied: a
      card it rejects leaves `shown`/`unlinkedShown` and nothing else. Every
      count is still taken over the whole inventory, exactly as with search.
      The Overview passes `cardHasLiveWork` (#1820). */
  cardFilter?: (card: KanbanCard) => boolean;
  /** The project's orchestrator seat as the board last read it; null or absent
      while it is unknown. With its `previous` seats, every conversation the
      seat record names leaves the bands (#1841). */
  seat?: SeatRefs | null;
  query?: string;
  /** Epoch seconds. */
  now: number;
}

const ACTIVE_PIPELINE_STATES = new Set(["provisioning", "running", "needs_decision", "needs_review", "paused"]);
/** A stage with an attempt in flight right now. `pending` is not started,
    `passed`/`failed`/`skipped` are over. */
const IN_FLIGHT_STAGES: ReadonlySet<StageChipState> = new Set(["running", "reviewing", "committing"]);
/* Only a flagged reason needs the operator; a stalled or rate-limited member
   keeps its word and counts as neither (docs/design/needs-attention.md §3). */
const NEEDS_STATES: ReadonlySet<MobileRowStateKey> = new Set(["waiting"]);
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
    need: conversationNeed(file, now)?.need ?? null,
    working: WORKING_STATES.has(row.key),
    latest: nowFragment(file),
    stage: stageByPath.get(file.path) ?? null,
  };
}

function referenceIdentity(reference: { conversationId: string | null; path: string | null; file: FileEntry | null }): string | null {
  if (reference.file) return conversationIdentity(reference.file);
  return reference.conversationId ?? reference.path;
}

/**
 * The order of a column, the Not-on-a-task list and the phone's columns alike.
 *
 * Cards with work in flight come first, the one whose work started last on
 * top. A start moves only when a turn or a stage attempt starts or ends, so
 * the working cards keep their places while their agents stream. Then the
 * newest agent work, then the newest edit of the task, then the id.
 */
export function compareCards(a: KanbanCard, b: KanbanCard): number {
  if ((a.workingSinceMs === null) !== (b.workingSinceMs === null)) return a.workingSinceMs === null ? 1 : -1;
  if (a.workingSinceMs !== null && b.workingSinceMs !== null) return b.workingSinceMs - a.workingSinceMs || a.id.localeCompare(b.id);
  return b.lastAgentWorkAtMs - a.lastAgentWorkAtMs
    || b.updatedAtMs - a.updatedAtMs
    || a.id.localeCompare(b.id);
}

/** When a working member's current work started: the anchor its working timer
    counts from, else the start of its session. */
function memberStartMs(file: FileEntry): number {
  return workingSince(file) ?? parseMs(file.sessionStartedAt);
}

export function cardMatches(card: KanbanCard, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || card.searchText.includes(needle);
}

/**
 * A card with a worker working right now (#1820).
 *
 * It reads the evidence the board's own counters read and nothing else:
 * `working` is the number the column's «N working» shows (a member
 * conversation whose row state is working or held), `needsYou` is the one its
 * «N need you» shows, and a stage chip in flight is the running stage the
 * graph already draws. There is no second definition of working here, so a
 * finished Claude conversation is as absent from this predicate as it is from
 * those counters.
 *
 * A card waiting on the operator counts: the work is live, it is the operator
 * who is holding it.
 */
export function cardHasLiveWork(card: KanbanCard): boolean {
  return card.working > 0
    || card.needsYou
    || card.pipelines.some((summary) => summary.chips.some((chip) => IN_FLIGHT_STAGES.has(chip.state)));
}

export function buildKanbanModel(input: KanbanModelInput): KanbanModel {
  const { bands, tasks, pipelines, projection, statusOverrides, cardFilter, now } = input;
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
  // A folded reviewer deck is not a standalone node. Include its
  // resolved historical/current bindings without changing card membership or
  // scanning the file corpus per round; the shared resolver indexes it once.
  const reviewerWorkByFlow = new Map<Flow, number>();
  const reviewerFiles = input.files ?? [];
  const reviewerWorkAt = (flow: Flow | null | undefined): number => {
    if (!flow) return 0;
    const cached = reviewerWorkByFlow.get(flow);
    if (cached !== undefined) return cached;
    let latest = 0;
    for (const round of flow.rounds) for (const target of reviewerBindingTargetsForRound(flow, round, reviewerFiles)) {
      latest = Math.max(latest, workByIdentity.get(target.conversationId ?? target.path) ?? workByIdentity.get(target.path) ?? 0);
    }
    reviewerWorkByFlow.set(flow, latest);
    return latest;
  };
  const query = input.query ?? "";
  const pipelineById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline] as const));
  const flowsById = new Map((input.flows ?? []).map((flow) => [flow.id, flow] as const));
  const flowsByDeck = new Map((input.flows ?? []).map(flow => [deckKey(flow.id), flow]));
  // A pipeline's own recency: the newest agent work of any attempt it recorded,
  // historical ones included, and of the reviewers its review-loop flows bound.
  // Memoized per pipeline, so a pipeline shared by several cards is read once.
  const pipelineWorkById = new Map<string, number>();
  const pipelineWorkAt = (pipeline: Pipeline): number => {
    const cached = pipelineWorkById.get(pipeline.id);
    if (cached !== undefined) return cached;
    let latest = 0;
    for (const run of pipeline.runs) for (const attempt of run.attempts) {
      if (attempt.conversationId) latest = Math.max(latest, workByIdentity.get(attempt.conversationId) ?? 0);
      if (attempt.agentPath) latest = Math.max(latest, workByIdentity.get(attempt.agentPath) ?? 0);
      if (attempt.flowId) latest = Math.max(latest, reviewerWorkAt(flowsById.get(attempt.flowId)));
    }
    pipelineWorkById.set(pipeline.id, latest);
    return latest;
  };
  const stageByPath = new Map<string, { pipeline: Pipeline; stage: PipelineStage }>();
  const pathByConversation = new Map((input.files ?? []).filter((file) => file.conversationId).map((file) => [file.conversationId!, file.path]));
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) {
      for (const attempt of stageAttempts(pipeline, stage.id)) {
        const attemptPath = attempt.agentPath ?? (attempt.conversationId ? pathByConversation.get(attempt.conversationId) : undefined);
        if (attemptPath) stageByPath.set(attemptPath, { pipeline, stage });
      }
    }
  }
  const workflowByTask = new Map(projection.tasks.map((workflow) => [workflow.task.id, workflow] as const));
  const bandTitle = new Map(bands.map((band) => [band.id, band.title] as const));

  /* Seat conversations draw no tile (#1841): the seat panel is their home. */
  const seatFile = (file: FileEntry) => isSeatConversation(input.seat, file);
  const seatTasks: BoardTask[] = [];
  const cards: KanbanCard[] = bands.flatMap((band): KanbanCard[] => {
    const task = band.task;
    const nodes = band.members.filter((member) => member.kind === "node" && member.file && !seatFile(member.file));
    /* A launch placeholder whose launch failed is no conversation: it is
       listed as a failed launch, which opens its launch view with Retry. */
    const members = nodes
      .filter((member) => !failedLaunchPlaceholder(member.file!))
      .map((member) => memberOf(member.key, member.file!, stageByPath, now));
    const failedLaunches = nodes.filter((member) => failedLaunchPlaceholder(member.file!)).map((member) => member.file!);
    const mirrors = band.mirrors.filter((mirror) => !seatFile(mirror.file)).map((mirror) => ({
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

    /* What a pipeline of this card ran, open or closed: its stage attempts,
       the helpers its agents brought in and its review rounds, and the rounds
       of the task's review flows. Each lives in its pipeline's chips and Past
       attempts, never in the card's own lists. */
    const attemptKeys = new Set<string>();
    const addAttemptKeys = (...keys: Array<string | null | undefined>) => {
      for (const key of keys) if (key) attemptKeys.add(key);
    };
    for (const pipeline of [...cardPipelines.values(), ...(workflow?.executions ?? []).map((execution) => execution.pipeline)]) {
      for (const run of pipeline.runs) for (const attempt of run.attempts) {
        addAttemptKeys(attempt.conversationId, attempt.launchId, attempt.agentPath);
        for (const round of (attempt.flowId ? flowsById.get(attempt.flowId)?.rounds : undefined) ?? []) addAttemptKeys(round.reviewerConversationId, round.reviewerPath);
      }
    }
    for (const flow of workflow?.flows ?? []) for (const round of flow.rounds) addAttemptKeys(round.reviewerConversationId, round.reviewerPath);
    const assignmentOf = (reference: { launchId: string | null; conversationId: string | null; path: string | null }, live = false) => task?.assignments.find((candidate) => (!live || candidate.state !== "failed")
      && ((reference.launchId && candidate.launchId === reference.launchId)
        || (reference.conversationId && candidate.conversationId === reference.conversationId)
        || (!reference.launchId && !reference.conversationId && reference.path !== null && candidate.path === reference.path)));
    const stageWork = (reference: { kind: string; launchId: string | null; conversationId: string | null; path: string | null }, clientAttemptId?: string | null) =>
      reference.kind === "attempt" || reference.kind === "review"
      || [reference.conversationId, reference.launchId, reference.path].some((key) => key && attemptKeys.has(key))
      || ENGINE_ATTEMPT_ID.test(clientAttemptId ?? (reference.kind === "assignment" ? assignmentOf(reference)?.clientAttemptId ?? "" : ""));

    /* Conversations: what the band carries, plus durable rows it could not
       resolve to a transcript on this board. */
    const identities = new Set<string>();
    let notLoaded = 0;
    const notLoadedRefs: KanbanRecordedConversation[] = [];
    const neverMinted: { kind: string; state: string; conversationId: string | null; launchId: string | null; path: string | null }[] = [];
    for (const member of members) identities.add(conversationIdentity(member.file));
    for (const mirror of mirrors) identities.add(conversationIdentity(mirror.file));
    const failedIdentities = new Set(failedLaunches.flatMap((file) => [file.conversationId, file.path].filter((key): key is string => Boolean(key))));
    const countReference = (reference: { kind: string; state: string; conversationId: string | null; launchId: string | null; path: string | null; file: FileEntry | null }) => {
      if (reference.kind === "planned") return;
      if (isSeatConversation(input.seat, reference.file ?? reference)) return;
      const identity = referenceIdentity(reference);
      /* A row with neither a conversation id nor a path: a launch that never
         minted a conversation, when it has a launch id to name it by. */
      if (!identity) {
        if (reference.launchId) neverMinted.push(reference);
        return;
      }
      if (identities.has(identity)) return;
      if (reference.file && failedLaunchPlaceholder(reference.file)) {
        failedLaunches.push(reference.file);
        return;
      }
      /* The row of a failed launch: its failed row stands for it. */
      if (reference.conversationId !== null && failedIdentities.has(reference.conversationId)) return;
      const known = Boolean(reference.file)
        || (reference.path !== null && knownConversations.has(reference.path))
        || (reference.conversationId !== null && knownConversations.has(reference.conversationId));
      if (known) {
        identities.add(identity);
        return;
      }
      /* Not on this board. A row that names a transcript, or a conversation
         id the launch minted, started: it counts, and opens through either.
         A failed row with neither (a dismissed launch, a dead spawn) is
         nothing to open. */
      const transcript = reference.path && !reference.path.startsWith("spawn:") ? reference.path : null;
      if (transcript || (reference.conversationId && reference.state !== "failed")) {
        identities.add(identity);
        notLoaded += 1;
        if (!stageWork(reference)) notLoadedRefs.push({ key: identity, path: transcript, conversationId: reference.conversationId });
        return;
      }
      if (!reference.conversationId) neverMinted.push(reference);
    };
    for (const reference of workflow?.references ?? []) countReference(reference);
    for (const execution of workflow?.executions ?? []) {
      if (execution.basis !== "explicit") continue;
      for (const reference of execution.references) countReference(reference);
    }
    const unstarted: KanbanUnstartedLaunch[] = [];
    const unstartedKeys = new Set<string>();
    const nowMs = now * 1000;
    /* A failed launch is final the moment its receipt says so: it is listed
       at once, with its error, and no start grace applies. A dismissed one is
       gone, and a stage's has its stage chip and past attempt instead. */
    for (const failed of failedLaunches) {
      if (stageByPath.has(failed.path) || failed.durableLineage?.memberships.some((membership) => membership.kind === "pipeline")) continue;
      const launchId = failed.spawn?.launchId ?? null;
      const conversationId = failed.spawn?.conversationId ?? failed.conversationId ?? null;
      const assignment = task?.assignments.find((candidate) => (launchId && candidate.launchId === launchId) || (conversationId && candidate.conversationId === conversationId));
      if (assignment?.state === "failed" && assignment.error === LAUNCH_NOT_STARTED_ERROR) continue;
      if (stageWork({ kind: "assignment", launchId, conversationId, path: failed.path }, failed.spawn?.clientAttemptId ?? assignment?.clientAttemptId)) continue;
      const key = launchId ?? conversationId ?? failed.path;
      if (unstartedKeys.has(key)) continue;
      unstartedKeys.add(key);
      if (assignment?.launchId) unstartedKeys.add(assignment.launchId);
      if (assignment?.conversationId) unstartedKeys.add(assignment.conversationId);
      const atMs = assignment ? Date.parse(assignment.at) : Number.NaN;
      unstarted.push({
        key,
        launchId,
        conversationId,
        atMs: Number.isFinite(atMs) ? atMs : failed.mtime * 1000,
        failed: { error: failed.spawn?.error ?? null, file: failed },
        /* A dismissed row was skipped above; a row the launch's own failure
           marked failed (#2170) is still the operator's to dismiss. */
        dismissable: Boolean(assignment),
      });
    }
    /* A launch of the task's own that never minted a conversation (a row
       from before launches reserved one) did not start once it is past the
       grace a starting launch gets. */
    for (const reference of neverMinted) {
      if (reference.kind !== "assignment" || reference.state === "failed" || !task) continue;
      const assignment = assignmentOf(reference, true);
      if (!assignment || stageWork(reference, assignment.clientAttemptId)) continue;
      const atMs = Date.parse(assignment.at);
      if (Number.isFinite(atMs) && nowMs - atMs < LAUNCH_START_GRACE_MS) continue;
      const key = assignment.launchId ?? "";
      if (!key || unstartedKeys.has(key)) continue;
      unstartedKeys.add(key);
      unstarted.push({ key, launchId: key, conversationId: null, atMs: Number.isFinite(atMs) ? atMs : 0, failed: null, dismissable: true });
    }

    /* Newest agent work first; a pipeline with no recorded work sorts last. */
    const summaries = [...cardPipelines.values()]
      .sort((a, b) => pipelineWorkAt(b) - pipelineWorkAt(a) || a.id.localeCompare(b.id))
      .map((pipeline) => summarizePipeline(pipeline, flowsById));
    const provisioning = summaries.filter((summary) => summary.pipeline.state === "provisioning").length;
    /* Why the card needs the operator, and what someone cleared. A lane
       dismissed on either surface asks nothing here either: `laneNeed` reads
       the phone queue's own predicate (`pipelineAsks`). */
    const reasons: NeedReason[] = [];
    const cleared: ClearedNeed[] = [];
    for (const found of [...members.map((member) => conversationNeed(member.file, now)), ...summaries.map((summary) => laneNeed(summary.pipeline))]) {
      if (!found) continue;
      if (found.cleared) cleared.push(found.cleared);
      else reasons.push(found.need);
    }
    reasons.sort(byNeedAge);
    cleared.sort((a, b) => b.at - a.at || a.need.key.localeCompare(b.need.key));
    const working = members.filter((member) => member.working).length;
    /* Work in flight and when its newest part started: a working member's
       turn, or the attempt of a stage running in a lane that is not paused. */
    const inFlight = summaries.flatMap((summary) => (summary.pipeline.state === "paused" ? [] : summary.chips
      .filter((chip) => IN_FLIGHT_STAGES.has(chip.state))
      .map((chip) => parseMs(latestAttempt(summary.pipeline, chip.stage.id)?.startedAt))));
    const workingSinceMs = working > 0 || inFlight.length > 0
      ? Math.max(0, ...inFlight, ...members.filter((member) => member.working).map((member) => memberStartMs(member.file)))
      : null;
    const needsYou = reasons.length > 0;
    const activePipeline = summaries.some((summary) => ACTIVE_PIPELINE_STATES.has(summary.pipeline.state));
    const overridden = task ? statusOverrides?.get(task.id) : undefined;
    const status: TaskStatus = overridden ?? task?.status ?? "inbox";
    const hide: GroupHideState = task
      ? groupHideState(task, { members: members.map((member) => member.file), pipelines: summaries.map((summary) => summary.pipeline), seat: input.seat })
      : { hidden: false, resurfaced: null };
    const holdsSeat = Boolean(task && input.seat && seatAssignment(task.assignments, input.seat));
    const color = task?.color && (TASK_COLORS as readonly string[]).includes(task.color) ? task.color : null;
    /* A placeholder no agent will name any more borrows its conversation's
       title rather than staying «Untitled task» for good. */
    const naming = task ? placeholderTitle({ task, members, mirrors, failedLaunches: unstarted.flatMap((launch) => (launch.failed ? [launch.failed.file] : [])), nowMs: now * 1000 }) : null;
    const title = naming?.derived ?? band.title;
    const description = task ? descriptionOf(task.text) : "";
    /* Retain modification metadata separately from agent-work ordering. A
       band without a task has only its conversations to date it. */
    const updatedAtMs = task
      ? parseMs(task.updatedAt)
      : Math.max(parseMs(band.createdAt), ...members.map((member) => member.file.mtime * 1000));
    const otherSurfaces = band.members.filter((member) => member.kind === "deck" || member.kind === "stack").length;
    const drafts = band.members.flatMap((member) => (member.kind === "draft" ? [member.key.slice("draft::".length)] : []));
    /* A task that holds nothing but seat conversations draws nothing at all:
       no card, no count, no share of working. */
    if (task && !members.length && !mirrors.length && !summaries.length && !otherSurfaces && !drafts.length && seatOnlyTask(task, input.seat, pipelines)) {
      seatTasks.push(task);
      return [];
    }
    /* A band no task owns that carried only seat conversations (a seat
       drawn as its own lineage root) is gone with them. */
    const heldSeat = band.members.some((member) => member.kind === "node" && member.file && seatFile(member.file))
      || band.mirrors.some((mirror) => seatFile(mirror.file));
    if (!task && heldSeat && !members.length && !mirrors.length && !summaries.length && !otherSurfaces && !drafts.length && !band.flow) return [];
    return [{
      id: band.id,
      /* One project's board answers `project` for every card alike; the
         cross-project Overview needs each card's own. A recorded task names
         it; a band without one takes it from the container or the first
         conversation it carries, which is where the board got the band. */
      project: task?.project
        || band.pipeline?.project
        || band.flow?.project
        || members[0]?.file.project
        || mirrors[0]?.file.project
        || "other",
      task,
      origin: band.origin,
      status,
      title,
      titlePending: naming?.pending ?? false,
      description,
      details: task?.details ?? "",
      members,
      mirrors,
      conversations: identities.size,
      notLoaded,
      notLoadedRefs,
      unstarted,
      otherSurfaces,
      drafts,
      pipelines: summaries,
      working,
      needsYou,
      reasons,
      cleared,
      activity: working + provisioning,
      idle: members.length === 0 && mirrors.length === 0 && !activePipeline && !needsYou && otherSurfaces === 0 && drafts.length === 0,
      updatedAtMs,
      lastAgentWorkAtMs: Math.max(reviewerWorkAt(band.flow),
        ...band.members.filter(member => member.kind === "deck").map(member => reviewerWorkAt(flowsByDeck.get(member.key))),
        ...[...members, ...mirrors].map(member => member.file.lastAgentWorkAt ?? 0).filter(Number.isFinite),
        ...[...identities].map(id => workByIdentity.get(id) ?? 0),
        ...summaries.map(summary => pipelineWorkAt(summary.pipeline))),
      workingSinceMs,
      searchText: [title, description, ...members.map((member) => member.file.title ?? ""), ...summaries.map((summary) => summary.pipeline.task)]
        .join("\n")
        .toLowerCase(),
      color,
      icon: typeof task?.icon === "string" && task.icon ? task.icon : null,
      past: pastAttempts(summaries.map((summary) => summary.pipeline), flowsById),
      hide,
      holdsSeat,
    }];
  });

  /* Search and the Overview's predicate narrow the same way and in the same
     place: what they reject leaves `shown`, and every count above is already
     taken over the whole inventory. */
  const keeps = (card: KanbanCard) => cardMatches(card, query) && (!cardFilter || cardFilter(card));
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
      shown: inColumn.filter((card) => keeps(card)),
      working: inColumn.reduce((sum, card) => sum + card.working, 0),
      needsYou: inColumn.filter((card) => card.needsYou).length,
    } satisfies KanbanColumn];
  })) as Record<TaskStatus, KanbanColumn>;

  const carded = new Set([...recorded, ...hiddenGroups].map((card) => card.task!.id));
  const seatOnly = new Set(seatTasks.map((task) => task.id));
  /* A seat task with no band this render (the scheme window did not carry
     it) is still the seat's, never an off-board task. */
  for (const task of tasks) {
    if (!carded.has(task.id) && !seatOnly.has(task.id) && seatOnlyTask(task, input.seat, pipelines)) {
      seatOnly.add(task.id);
      seatTasks.push(task);
    }
  }
  const offBoard = tasks.filter((task) => !carded.has(task.id) && !seatOnly.has(task.id));
  return {
    columns,
    unlinked,
    unlinkedShown: unlinked.filter((card) => keeps(card)),
    offBoard,
    seatTasks,
    hiddenGroups,
    resurfaced,
    totals: {
      tasks: tasks.length - seatOnly.size,
      onBoard: recorded.length,
      /* Agents of a hidden group keep working, and the header says so; a
         decision the operator hid is not counted as waiting on them. */
      working: cards.reduce((sum, card) => sum + card.working, 0),
      needsYou: cards.filter((card) => card.needsYou && !card.hide.hidden).length,
    },
  };
}
