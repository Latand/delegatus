import { withFinishedAttention } from "@/lib/attention/finishedAttention";
import { finishedWorkIndex } from "@/lib/attention/finishedWork";
import { prototypeWaitsOnOperator } from "@/lib/prototypeReview/model";
import { reviewerBindingTargetsForRound } from "@/components/flows/flowModel";
import { conversationIdentity } from "@/lib/accounts/identity";
import type { ReviewGroup as Flow } from "@/components/flows/reviewGroup";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { groupHideState, isSeatConversation, seatAssignment, seatOnlyTask, type GroupHideState, type GroupResurfaceReason, type SeatRefs } from "@/lib/tasks/groupHide";
import { LAUNCH_NOT_STARTED_ERROR, TASK_COLORS, taskPriority, type BoardTask, type TaskColor, type TaskPriority, type TaskStatus } from "@/lib/tasks/types";
import { taskMotion, type TaskMotion } from "@/lib/tasks/motion";
import { deriveTaskSteps, type TaskStepsSummary } from "@/lib/tasks/steps";
import { priorityRank } from "@/lib/tasks/priority";
import type { FileEntry } from "@/lib/types";
import { byNeedAge, conversationNeed, laneNeed, type ClearedNeed, type NeedReason } from "@/components/attention/needReason";
import { mobileRowState, nowFragment, type MobileRowState, type MobileRowStateKey } from "@/components/mobile/mobileBoardModel";
import { latestAttempt, stageAttempts, type StageChipState } from "@/components/pipelines/pipelineModel";
import { deckKey } from "@/components/scheme/agentLinks";
import type { TaskBand } from "@/components/scheme/taskBands";
import { sameFileExceptSizeAndMtime, taskWorkflowMembershipKey, type TaskWorkflow, type TaskWorkflowProjection } from "@/components/tasks/taskWorkflowModel";
import { workingSince } from "@/components/workingSince";
import { isWorkingAgent, workingAgentCount } from "@/components/workingAgents";
import { turnIsRunning } from "@/components/turnDuration";
import { DONE_TASK_BOARD_RETENTION_MS, taskShowsOnBoard } from "@/lib/tasks/boardVisibility";
import { laneMovedAt } from "@/lib/pipelines/laneMovement";
import { bandHoldsMembers } from "@/components/scheme/taskBands";

import { pastAttempts, type PastAttempt, type WorkingConversations } from "./pipelineGraph";
import { summarizePipeline, type KanbanLoop, type KanbanPipeline, type KanbanStageChip } from "./pipelineSummary";
import { awaitsName, placeholderTitle } from "./placeholderTitle";
import { reuseKanbanModel, structurallyEqual } from "./reuseKanbanModel";

export { summarizePipeline };
export type { KanbanLoop, KanbanPipeline, KanbanStageChip };

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
  /** What the scan knows the agent is doing, when it carries that. */
  activity?: MobileRowState["activity"];
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
  holdTarget?: { title: string; done: boolean };
  motion: TaskMotion;
  stepSummary: TaskStepsSummary | null;
  /** Its members working now, by the rule every «working» count uses (`isWorkingAgent`). */
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
      and mirrors, every attempt of its pipelines, its review decks, and when
      each of its lanes last moved (`laneMovedAt`, known even when no
      transcript of the lane is loaded); 0 when none is known. */
  lastAgentWorkAtMs: number;
  /** Null unless work is in flight on the card right now: a member
      conversation working, or a stage of a pipeline that is not paused
      running, reviewing or committing. Then when the newest of that work
      started, epoch ms, or 0 when no start is known. */
  workingSinceMs: number | null;
  searchText: string;
  /** The task's colour label, when it names one this build knows. */
  color: TaskColor | null;
  /** How soon to take the task; normal for a card with no task. */
  priority: TaskPriority;
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
  /** Agents working on the column's cards (`isWorkingAgent`). */
  working: number;
  needsYou: number;
  /** Stopped cards nobody worked on lately (`parkedCard`): the ones the
      column draws under its Stopped divider, counted once for the header and the divider. */
  stopped: number;
  /** The ids of the shown cards among them. */
  parked: string[];
  noReason: number;
}

export type TaskReasonFilter = "needs-you" | "queued" | "waiting" | "postponed" | "no-reason";

function cardHasUnknownReason(card: KanbanCard): boolean {
  return (card.motion.key === "stopped" && (!card.motion.reason || (typeof card.motion.reason === "object" && card.motion.reason.kind === "unstated")))
    || Boolean(card.stepSummary?.reasons.some(reason => reason.kind === "stopped"));
}

export function taskReasonFiltersOfCard(card: KanbanCard): TaskReasonFilter[] {
  const reason = typeof card.motion.reason === "object" ? card.motion.reason : null;
  const filters = new Set<TaskReasonFilter>();
  if (card.motion.key === "needs-you") filters.add("needs-you");
  if (reason?.kind === "worker" || reason?.kind === "resource" || reason?.kind === "limit") filters.add("queued");
  if (reason?.kind === "postponed") filters.add("postponed");
  if (card.motion.key === "waiting" && reason?.kind !== "postponed" && !["worker", "resource", "limit"].includes(reason?.kind ?? "")) filters.add("waiting");
  if (cardHasUnknownReason(card)) filters.add("no-reason");
  for (const stepReason of card.stepSummary?.reasons ?? []) {
    if (stepReason.kind === "queued") filters.add("queued");
    else if (stepReason.kind === "waiting") filters.add("waiting");
    else if (stepReason.kind === "postponed") filters.add("postponed");
  }
  return [...filters];
}

function matchesReasonFilter(card: KanbanCard, filter: TaskReasonFilter | undefined): boolean {
  if (!filter) return true;
  return taskReasonFiltersOfCard(card).includes(filter);
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
    /** Agents working now in the files the board carries: the number the
        sidebar row of the same project shows (`workingAgentCount`). */
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
  reasonFilter?: TaskReasonFilter;
  /** The project's orchestrator seat as the board last read it; null or absent
      while it is unknown. With its `previous` seats, every conversation the
      seat record names leaves the bands (#1841). */
  seat?: SeatRefs | null;
  query?: string;
  /** The conversations with a reader open and unfolded in a card. A draft no
      task holds stands in Assigned unless one of these is held by a card there:
      a reader fills the column, so a draft above it would push the agent the
      operator is reading out of the window. */
  openReaders?: ReadonlySet<string>;
  /** Whether this page launched the conversation from an agent draft. With a
      reader open on another card in Assigned, the launched card stands under
      that card, where the draft stood, and does not push it out of the window. */
  launched?: (file: FileEntry) => boolean;
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

function parseMs(iso: string | undefined | null): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function descriptionOf(text: string): string {
  const newline = text.search(/\r?\n/);
  return newline < 0 ? "" : text.slice(newline).trim();
}

/** The stage conversations working right now, by the rule the card's
    «N working» reads. Only a stage's own transcripts are asked. */
function workingStageConversationsOf(stagePaths: { has(path: string): boolean }, files: readonly FileEntry[], now: number): Set<string> {
  const working = new Set<string>();
  for (const file of files) {
    if (!stagePaths.has(file.path) || !isWorkingAgent(file, now)) continue;
    working.add(file.path);
    if (file.conversationId) working.add(file.conversationId);
  }
  return working;
}

/** The working stage conversations of the given pipelines, for a surface that
    summarizes lanes outside the board model (the phone's pipeline and task
    screens). `now` is epoch seconds, as the board model reads it. */
export function workingStageConversations(pipelines: readonly Pipeline[], files: readonly FileEntry[], now: number): WorkingConversations {
  const pathByConversation = new Map(files.filter((file) => file.conversationId).map((file) => [file.conversationId!, file.path]));
  const stagePaths = new Set<string>();
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) {
      for (const attempt of stageAttempts(pipeline, stage.id)) {
        const attemptPath = attempt.agentPath ?? (attempt.conversationId ? pathByConversation.get(attempt.conversationId) : undefined);
        if (attemptPath) stagePaths.add(attemptPath);
      }
    }
  }
  return workingStageConversationsOf(stagePaths, files, now);
}

function memberOf(key: string, file: FileEntry, stageByPath: ReadonlyMap<string, { pipeline: Pipeline; stage: PipelineStage }>, now: number): KanbanMember {
  const row = mobileRowState(file, now);
  return {
    key,
    file,
    state: row.key,
    activity: row.activity,
    needsYou: NEEDS_STATES.has(row.key),
    need: conversationNeed(file, now)?.need ?? null,
    working: isWorkingAgent(file, now),
    latest: nowFragment(file),
    stage: stageByPath.get(file.path) ?? null,
  };
}

function referenceIdentity(reference: { conversationId: string | null; path: string | null; file: FileEntry | null }): string | null {
  if (reference.file) return conversationIdentity(reference.file);
  return reference.conversationId ?? reference.path;
}

/** A card no task owns that holds nothing but agent drafts. Its launch becomes
    a task in Assigned, so the board draws it there from the first keystroke. */
export function holdsOnlyDrafts(card: Pick<KanbanCard, "task" | "drafts" | "members" | "mirrors">): boolean {
  return !card.task && card.drafts.length > 0 && card.members.length === 0 && card.mirrors.length === 0;
}

/**
 * A card launched from this page's draft, with its reader open, takes the
 * place right under the last card the operator is reading in the column. The
 * draft waited in Inbox beside that card; the launch writes a task that sorts
 * above it, and the card being read would drop below the new card's reader and
 * out of the window. When the launched agent's turn ends its card sorts below
 * the working ones, and it keeps the same place under the card being read
 * instead. With no other card read, the launched card stands first:
 * the work order would put it under cards whose work started later, below
 * the window's edge, where the draft it replaced stood in view. Closing either reader lets
 * the launched card sort as any other. Reorders `cards` in place.
 */
export function landUnderReading(cards: KanbanCard[], reading: ReadonlySet<string> | undefined, launched: ((file: FileEntry) => boolean) | undefined): void {
  if (!reading?.size || !launched) return;
  const held = (card: KanbanCard) => card.members.some((member) => reading.has(conversationIdentity(member.file)));
  const landing = (card: KanbanCard) => held(card) && card.members.some((member) => launched(member.file));
  const moved = cards.filter(landing);
  if (!moved.length) return;
  const rest = cards.filter((card) => !landing(card));
  const anchor = rest.findLastIndex(held);
  cards.splice(0, cards.length, ...rest.slice(0, anchor + 1), ...moved, ...rest.slice(anchor + 1));
}

/**
 * The order of a column, the Not-on-a-task list and the phone's columns alike.
 *
 * Cards with work in flight come first, the one whose work started last on
 * top. A start moves only when a turn or a stage attempt starts or ends, so
 * the working cards keep their places while their agents stream. Then the
 * newest agent work, lane movement included, then the newest edit of the task,
 * then the id. Motion (needs-you, waiting, stopped) does not order a column:
 * the card keeps its motion line wherever it sorts, and the header's
 * needs-you filter gathers those cards.
 */
export function compareCards(a: KanbanCard, b: KanbanCard): number {
  if ((a.workingSinceMs === null) !== (b.workingSinceMs === null)) return a.workingSinceMs === null ? 1 : -1;
  if (a.workingSinceMs !== null && b.workingSinceMs !== null) return b.workingSinceMs - a.workingSinceMs || a.id.localeCompare(b.id);
  return b.lastAgentWorkAtMs - a.lastAgentWorkAtMs
    || b.updatedAtMs - a.updatedAtMs
    || a.id.localeCompare(b.id);
}

/**
 * Whether work happened on the card recently enough to stand above the
 * untouched queue: something in flight, or agent work within the span the board
 * already treats as recent for «Done».
 */
function workedRecently(card: KanbanCard, nowMs: number): boolean {
  return card.workingSinceMs !== null || card.lastAgentWorkAtMs >= nowMs - DONE_TASK_BOARD_RETENTION_MS;
}

/**
 * A stopped card that nobody worked on recently. The column sorts by recent
 * work, so a card that stopped minutes ago sits among the live ones; only the
 * long-quiet stopped cards gather under the Stopped divider, and the header
 * counts exactly those.
 */
export function parkedCard(card: KanbanCard, nowMs: number): boolean {
  return card.motion.key === "stopped" && !workedRecently(card, nowMs);
}

/**
 * The Inbox's order: cards worked recently first, in {@link compareCards}
 * order; then the rest, high, normal, low, with {@link compareCards} inside
 * each level. Untouched work keeps the priority queue, and only work of the
 * last three days rises above it. Every other column keeps
 * {@link compareCards} alone.
 */
export function compareInboxCards(a: KanbanCard, b: KanbanCard, nowMs: number): number {
  const recentA = workedRecently(a, nowMs);
  if (recentA !== workedRecently(b, nowMs)) return recentA ? -1 : 1;
  if (recentA) return compareCards(a, b);
  return priorityRank(a.priority) - priorityRank(b.priority) || compareCards(a, b);
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

/** The Overview and filters use the board's motion, including provisioning
    and declared operator holds. Paused historical stage chips are not work. */
export function cardHasLiveWork(card: KanbanCard): boolean {
  return card.motion.key === "working" || card.motion.key === "needs-you";
}

interface CachedCard {
  band: TaskBand;
  dependencies: readonly unknown[];
  card: KanbanCard;
}
interface CachedVisibility { dependencies: readonly unknown[]; visible: boolean }
interface CachedMembership { dependencies: readonly unknown[]; value: ReturnType<typeof bandMembership> }
interface CachedPipelineSummary { flows: KanbanModelInput["flows"]; working: Set<string>; value: KanbanPipeline }
interface ModelCache {
  previous: Map<string, CachedCard>;
  next: Map<string, CachedCard>;
  visibility: Map<string, CachedVisibility>;
  nextVisibility: Map<string, CachedVisibility>;
  indexes: ReturnType<typeof modelIndexes>;
  membership: Map<string, CachedMembership>;
  nextMembership: Map<string, CachedMembership>;
  summaries: Map<Pipeline, CachedPipelineSummary>;
  nextSummaries: Map<Pipeline, CachedPipelineSummary>;
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameFields(a: object, b: object): boolean {
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => left[key] === right[key]);
}

function sameBand(a: TaskBand, b: TaskBand): boolean {
  if (a === b) return true;
  return sameFields({ ...a, members: null, mirrors: null, groups: null }, { ...b, members: null, mirrors: null, groups: null })
    && sameValues(a.groups, b.groups)
    && a.members.length === b.members.length && a.members.every((member, i) => sameFields(member, b.members[i]))
    && a.mirrors.length === b.mirrors.length && a.mirrors.every((mirror, i) => sameFields(mirror, b.mirrors[i]));
}

/** One mounted board's task cards. Only the last answer is retained; removing
 * a task, or a task leaving the board, removes its cached derivation too. */
export function createKanbanModel(): (input: KanbanModelInput) => KanbanModel {
  let previous = new Map<string, CachedCard>();
  let visibility = new Map<string, CachedVisibility>();
  let membership = new Map<string, CachedMembership>();
  let summaries = new Map<Pipeline, CachedPipelineSummary>();
  let last: { input: KanbanModelInput; model: KanbanModel } | undefined;
  let indexed: { inputs: unknown[]; files: KanbanModelInput["files"]; value: ReturnType<typeof modelIndexes> } | undefined;
  return function projectKanbanModel(input) {
    if (last) {
      const { files: beforeFiles, projection: beforeProjection, ...before } = last.input;
      const { files, projection, ...current } = input;
      // Visible payloads come from bands, failed placeholders from workflow
      // references. A hidden transcript's byte/mtime refresh affects this
      // model only if it changes working evidence. Time and every other input
      // retain their normal invalidation, including the full task clock.
      if (sameFields(before, current) && taskWorkflowMembershipKey(beforeProjection) === taskWorkflowMembershipKey(projection)
        && beforeFiles && files && beforeFiles.length === files.length
        && files.every((file, i) => file === beforeFiles[i] || (!file.spawn && !file.path.startsWith("spawn:")
          && sameFileExceptSizeAndMtime(beforeFiles[i], file) && isWorkingAgent(beforeFiles[i], input.now) === isWorkingAgent(file, input.now)))) {
        last = { input, model: last.model };
        return last.model;
      }
    }
    const next = new Map<string, CachedCard>();
    const nextVisibility = new Map<string, CachedVisibility>();
    const nextMembership = new Map<string, CachedMembership>();
    const nextSummaries = new Map<Pipeline, CachedPipelineSummary>();
    const indexInputs = [input.tasks, input.pipelines, input.flows, input.bands];
    // These indexes read identity, membership and lastAgentWorkAt. Byte count
    // and mtime affect none of them; working state below still reads fresh files.
    const sameFiles = indexed && (indexed.files === input.files || (indexed.files && input.files
      && indexed.files.length === input.files.length && input.files.every((file, i) => sameFileExceptSizeAndMtime(indexed!.files![i], file))));
    const indexes = indexed && sameFiles && sameValues(indexed.inputs, indexInputs) ? indexed.value : modelIndexes(input);
    indexed = { inputs: indexInputs, files: input.files, value: indexes };
    const model = reuseKanbanModel(last?.model ?? null, deriveKanbanModel(input, { previous, next, visibility, nextVisibility, indexes: indexed.value, membership, nextMembership, summaries, nextSummaries }));
    // The reconciler can keep an older equal card. Cache that exact object so
    // a later clock tick can reuse it without comparing its whole tree again.
    const retained = new Map([...Object.values(model.columns).flatMap(column => column.cards), ...model.unlinked, ...model.hiddenGroups].map(card => [card.id, card]));
    for (const [id, entry] of next) {
      const card = retained.get(id);
      if (card && card !== entry.card) next.set(id, { ...entry, card });
    }
    previous = next;
    visibility = nextVisibility;
    membership = nextMembership;
    summaries = nextSummaries;
    last = { input, model };
    return model;
  };
}

export function buildKanbanModel(input: KanbanModelInput): KanbanModel {
  return deriveKanbanModel(input);
}

/** Immutable membership indexes and historical work do not read the board clock. */
function modelIndexes(input: KanbanModelInput) {
  const { bands, tasks, pipelines } = input;
  const knownConversations = new Set<string>();
  const workByIdentity = new Map<string, number>();
  // Running-turn eligibility is independent of the clock. Keep positions so
  // metadata refreshes still supply fresh files to the activity predicates.
  const workingCandidates: number[] = [];
  for (let i = 0; i < (input.files?.length ?? 0); i += 1) {
    const file = input.files![i];
    if (file.proc !== "killed" && turnIsRunning(file, Number.NEGATIVE_INFINITY)) workingCandidates.push(i);
  }
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
  const tasksById = new Map(tasks.map(task => [task.id, task]));
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
  const bandTitle = new Map(bands.map((band) => [band.id, band.title] as const));

  return { knownConversations, workByIdentity, reviewerWorkAt, tasksById, pipelineById, flowsById, flowsByDeck,
    pipelineWorkAt, stageByPath, bandTitle, workingCandidates, finished: finishedWorkIndex(tasks, pipelines, id => id, input.files) };
}

/** Static membership survives clock ticks and unrelated transcript payloads. */
function bandMembership(band: TaskBand, workflow: TaskWorkflow | undefined, seat: KanbanModelInput["seat"], pipelineById: ReadonlyMap<string, Pipeline>) {
  const task = band.task;
  const seatFile = (file: FileEntry) => isSeatConversation(seat, file);
  const cardPipelines = new Map<string, Pipeline>();
  if (band.pipeline) cardPipelines.set(band.pipeline.id, band.pipeline);
  for (const groupKey of band.groups) {
    const match = /^group::pipeline::(.+)$/.exec(groupKey);
    const pipeline = match ? pipelineById.get(match[1]!) : undefined;
    if (pipeline) cardPipelines.set(pipeline.id, pipeline);
  }
  for (const execution of workflow?.executions ?? []) {
    if (execution.basis === "explicit") cardPipelines.set(execution.pipeline.id, pipelineById.get(execution.pipeline.id) ?? execution.pipeline);
  }
  const nodes = band.members.filter((member) => member.kind === "node" && member.file && !seatFile(member.file));
  const memberNodes = nodes.filter(member => !failedLaunchPlaceholder(member.file!));
  const holdsSeat = Boolean(task && seat && seatAssignment(task.assignments, seat));
  const activePipeline = [...cardPipelines.values()].some(pipeline => ACTIVE_PIPELINE_STATES.has(pipeline.state));
  const laneMovedMs = Math.max(0, ...[...cardPipelines.values()].map(laneMovedAt).filter(Number.isFinite));
  // Retention is checked separately on every tick. A named task with delivered
  // transcript assignments, no holds/steps and no launch receipt has no other
  // task deadline. Its time-dependent content is its members' working/attention
  // state and its pipeline attempts' working evidence (keyed below).
  // Everything else keeps the full clock key. Drafts always rebuild because
  // a reader can move their card later in this pass.
  const memberClock = !band.members.some(member => member.kind === "draft" || member.file?.spawn)
    && (!task || (!task.hold && !task.steps?.length && !awaitsName(task)
      && task.assignments.every(assignment => assignment.state === "delivered" && assignment.path && !assignment.path.startsWith("spawn:"))
      && !workflow?.references.some(reference => reference.file?.spawn || reference.file?.path.startsWith("spawn:"))));
  // The fields below cover the clock-dependent branches of mobileRowState,
  // conversationNeed and isWorkingAgent. Elapsed seconds are rendered by the
  // member component and are absent from KanbanMember. Quiet history needs no
  // new row/attention objects just to prove that those fields are unchanged.
  const staticMembers = nodes.every(({ file }) => file && !file.agentActivity
    && file.activity !== "stalled" && !file.bridgeAsk && !file.bridgeAsks?.length
    && !file.stuckDelivery && !file.memoryKill && !file.attentionDismissal?.cleared
    && !(file.proc !== "running" && file.activityReason?.startsWith("structured_spawn_host_gone")));
  return { cardPipelines, nodes, memberNodes, holdsSeat, activePipeline, laneMovedMs, memberClock, staticMembers };
}

function deriveKanbanModel(input: KanbanModelInput, cache?: ModelCache): KanbanModel {
  const { bands, tasks, pipelines, statusOverrides, cardFilter, reasonFilter, now } = input;
  const { knownConversations, workByIdentity, reviewerWorkAt, tasksById, pipelineById, flowsById, flowsByDeck,
    pipelineWorkAt, stageByPath, bandTitle, workingCandidates, finished } = cache?.indexes ?? modelIndexes(input);
  const workingFiles = workingCandidates.map(index => input.files![index]);
  const workingStageConversations = workingStageConversationsOf(stageByPath, workingFiles, now);
  const pipelineSummary = (pipeline: Pipeline) => {
    const previous = cache?.summaries.get(pipeline);
    const summary = previous && previous.flows === input.flows && structurallyEqual(previous.working, workingStageConversations) ? previous
      : { flows: input.flows, working: workingStageConversations, value: summarizePipeline(pipeline, flowsById, workingStageConversations) };
    cache?.nextSummaries.set(pipeline, summary);
    return summary.value;
  };
  const query = input.query ?? "";
  const workflowByTask = new Map(input.projection.tasks.map(workflow => [workflow.task.id, workflow]));

  /* Seat conversations draw no tile (#1841): the seat panel is their home. */
  const seatFile = (file: FileEntry) => isSeatConversation(input.seat, file);
  const seatTasks: BoardTask[] = [];
  const cards: KanbanCard[] = bands.flatMap((band): KanbanCard[] => {
    const task = band.task;
    const workflow = task ? workflowByTask.get(task.id) : undefined;
    const membershipInputs = [band, workflow, input.seat, pipelines];
    const previousMembership = cache?.membership.get(band.id);
    const membership = previousMembership && sameValues(previousMembership.dependencies, membershipInputs) ? previousMembership
      : { dependencies: membershipInputs, value: bandMembership(band, workflow, input.seat, pipelineById) };
    cache?.nextMembership.set(band.id, membership);
    const { cardPipelines, nodes, memberNodes, holdsSeat, activePipeline, laneMovedMs, memberClock, staticMembers } = membership.value;
    const overridden = task ? statusOverrides?.get(task.id) : undefined;
    /* A draft becomes an Assigned task when launched. */
    const status: TaskStatus = overridden ?? (task ? finished.taskStatus(task) : undefined) ?? (!memberNodes.length && band.members.some(member => member.kind === "draft") ? "assigned" : "inbox");
    const laneWorkedRecently = activePipeline || laneMovedMs >= now * 1000 - DONE_TASK_BOARD_RETENTION_MS;
    // Visibility needs membership and lane facts, all available before card
    // construction. Hidden empty tasks still enter offBoard below, without
    // building reference histories and summaries on every clock tick.
    if (task) {
      // taskShowsOnBoard reads the clock only at completion + retention; its
      // resurfacing checks read the immutable membership/seat/lane inputs.
      // Optimistically completing a task starts its window at this tick.
      const expired = status === "done" && task.status === "done"
        && now * 1000 > Date.parse(task.doneAt ?? task.updatedAt) + DONE_TASK_BOARD_RETENTION_MS;
      const dependencies = [band, task, status, input.seat, pipelines, holdsSeat, laneWorkedRecently, expired];
      const previous = cache?.visibility.get(band.id);
      const visibility = previous && sameValues(previous.dependencies, dependencies) ? previous : {
        dependencies,
        visible: taskShowsOnBoard(status === task.status ? task : { ...task, status, ...(status === "done" ? { doneAt: new Date(now * 1000).toISOString() } : {}) }, bandHoldsMembers(band) || (laneWorkedRecently && !task.boardChoice), {
          now: now * 1000, holdsSeat, seat: input.seat,
          members: memberNodes.map(member => member.file!), pipelines,
        }),
      };
      cache?.nextVisibility.set(band.id, visibility);
      if (!visibility.visible) return [];
    }
    const holdTarget = task?.hold?.kind === "task" ? tasksById.get(task.hold.ref ?? "") : undefined;
    let clockKey: unknown = memberClock ? staticMembers ? null : nodes.map(member => {
      const row = memberOf(member.key, withFinishedAttention(member.file!, now, finished), stageByPath, now);
      return [row.state, row.activity, row.needsYou, row.need, row.working, row.latest, conversationNeed(member.file!, now)];
    }) : now;
    const previousClock = cache?.previous.get(band.id)?.dependencies[2];
    if (memberClock && structurallyEqual(previousClock, clockKey)) clockKey = previousClock;
    const cacheable = Boolean(task) || memberClock;
    const dependencies: unknown[] = [task, workflow, clockKey, status, input.seat, task ? statusOverrides?.get(task.id) : undefined, holdTarget];
    if (cache && cacheable) {
      // Resolve the external facts the card reads, including work by historical
      // reviewers outside its visible members and a competing stage owner.
      for (const member of band.members) {
        const stage = member.file ? stageByPath.get(member.file.path) : undefined;
        dependencies.push(stage?.pipeline, stage?.stage, reviewerWorkAt(flowsByDeck.get(member.key)));
      }
      if (memberClock) for (const member of [...band.members, ...band.mirrors]) {
        if (member.file) dependencies.push(workByIdentity.get(member.file.path), member.file.conversationId ? workByIdentity.get(member.file.conversationId) : undefined);
      }
      dependencies.push(reviewerWorkAt(band.flow));
      for (const mirror of band.mirrors) dependencies.push(bandTitle.get(mirror.primaryBandId));
      for (const reference of workflow?.references ?? []) {
        const identity = referenceIdentity(reference);
        dependencies.push(reference.path ? knownConversations.has(reference.path) : false,
          reference.conversationId ? knownConversations.has(reference.conversationId) : false,
          identity ? workByIdentity.get(identity) : undefined);
      }
      for (const pipeline of cardPipelines.values()) {
        dependencies.push(pipeline, pipelineWorkAt(pipeline));
        for (const run of pipeline.runs) for (const attempt of run.attempts) {
          dependencies.push(attempt.flowId ? flowsById.get(attempt.flowId) : undefined,
            attempt.agentPath ? workingStageConversations.has(attempt.agentPath) : false,
            attempt.conversationId ? workingStageConversations.has(attempt.conversationId) : false);
        }
      }
      const previous = cache.previous.get(band.id);
      if (previous && sameBand(previous.band, band) && sameValues(previous.dependencies, dependencies)) {
        cache.next.set(band.id, previous);
        for (const pipeline of cardPipelines.values()) {
          const summary = cache.summaries.get(pipeline);
          if (summary) cache.nextSummaries.set(pipeline, summary);
        }
        return [previous.card];
      }
    }
    /* A launch placeholder whose launch failed is no conversation: it is
       listed as a failed launch, which opens its launch view with Retry. */
    const members = memberNodes.map((member) => memberOf(member.key, withFinishedAttention(member.file!, now, finished), stageByPath, now));
    const failedLaunches = nodes.filter((member) => failedLaunchPlaceholder(member.file!)).map((member) => member.file!);
    const mirrors = band.mirrors.filter((mirror) => !seatFile(mirror.file)).map((mirror) => ({
      key: mirror.key,
      file: mirror.file,
      primaryCardId: mirror.primaryBandId,
      primaryTitle: bandTitle.get(mirror.primaryBandId) ?? mirror.primaryTitle,
    }));

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
      .map(pipelineSummary);
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
    const needsYou = reasons.length > 0 || prototypeWaitsOnOperator(task?.prototypeReview, task);
    const hide: GroupHideState = task
      ? groupHideState(task, { members: members.map((member) => member.file), pipelines: summaries.map((summary) => summary.pipeline), seat: input.seat })
      : { hidden: false, resurfaced: null };
    const stepProjection = deriveTaskSteps(task?.steps, summaries.map(summary => summary.pipeline), now * 1000);
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
    const card: KanbanCard = {
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
      stepSummary: stepProjection.summary,
      ...(holdTarget ? { holdTarget: { title: holdTarget.text.split("\n")[0]!, done: holdTarget.status === "done" } } : {}),
      /* A card holding only unsent drafts has started nothing, so nothing stopped: it reads as not started in any column. */
      motion: taskMotion({ status: !task && !members.length && !mirrors.length && drafts.length > 0 ? "inbox" : status, hold: overridden && overridden !== "blocked" ? undefined : task?.hold, needsYou, working,
        inFlight: inFlight.length > 0, pipelines: summaries.map(summary => summary.pipeline),
        steps: stepProjection.steps.map(step => ({ motion: step.motion, open: step.effectiveState === "open", hold: step.hold, since: step.since })) }, now * 1000),
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
        ...summaries.map(summary => pipelineWorkAt(summary.pipeline)),
        laneMovedMs),
      workingSinceMs,
      searchText: [title, description, task?.hold?.note ?? "", task?.hold?.ref ?? "", ...(task?.steps ?? []).flatMap(step => [step.text, step.hold?.note ?? "", step.ref ?? ""]), ...members.map((member) => member.file.title ?? ""), ...summaries.map((summary) => summary.pipeline.task)]
        .join("\n")
        .toLowerCase(),
      color,
      priority: task ? taskPriority(task) : "normal",
      icon: typeof task?.icon === "string" && task.icon ? task.icon : null,
      past: pastAttempts(summaries.map((summary) => summary.pipeline), flowsById),
      hide,
      holdsSeat,
    };
    if (cache && cacheable) cache.next.set(band.id, { band, dependencies, card });
    return [card];
  });

  /* The draft's launch writes a task in Assigned and takes the draft's place there. Beside an agent being
     read in Assigned the draft stays in Inbox instead, where it pushes nothing out of the window. */
  const readInAssigned = cards.some((card) => card.task && !card.hide.hidden && card.status === "assigned"
    && card.members.some((member) => input.openReaders?.has(conversationIdentity(member.file))));
  if (readInAssigned) for (const card of cards) if (holdsOnlyDrafts(card)) card.status = "inbox";

  /* Search and the Overview's predicate narrow the same way and in the same
     place: what they reject leaves `shown`, and every count above is already
     taken over the whole inventory. */
  const keeps = (card: KanbanCard) => cardMatches(card, query) && matchesReasonFilter(card, reasonFilter) && (!cardFilter || cardFilter(card));
  const hiddenGroups = cards
    .filter((card) => card.task && card.hide.hidden)
    .sort((a, b) => (b.hide.hidden ? Date.parse(b.hide.since) || 0 : 0) - (a.hide.hidden ? Date.parse(a.hide.since) || 0 : 0));
  const resurfaced = cards.flatMap((card) => (card.task && !card.hide.hidden && card.hide.resurfaced ? [{ card, reason: card.hide.resurfaced }] : []));
  const recorded = cards.filter((card) => card.task && !card.hide.hidden);
  const unlinked = cards.filter((card) => !card.task).sort(compareCards);
  const columns = Object.fromEntries(KANBAN_STATUSES.map((status) => {
    const inColumn = recorded.filter((card) => card.status === status).sort(status === "inbox" ? (a, b) => compareInboxCards(a, b, now * 1000) : compareCards);
    if (status === "assigned") landUnderReading(inColumn, input.openReaders, input.launched);
    return [status, {
      status,
      cards: inColumn,
      shown: inColumn.filter((card) => keeps(card)),
      working: inColumn.reduce((sum, card) => sum + card.working, 0),
      needsYou: inColumn.filter((card) => card.motion.key === "needs-you").length,
      stopped: status === "assigned" ? inColumn.filter((card) => parkedCard(card, now * 1000)).length : 0,
      parked: status === "assigned" ? inColumn.filter((card) => keeps(card) && parkedCard(card, now * 1000)).map((card) => card.id) : [],
      noReason: inColumn.filter(cardHasUnknownReason).length,
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
      /* Every agent working in the project, the sidebar row's own selector over
         the same files: a hidden group's agents and the seat keep working, and
         the header says so. A decision the operator hid is not counted as
         waiting on them. */
      working: workingAgentCount(workingFiles, now),
      needsYou: cards.filter((card) => card.motion.key === "needs-you" && !card.hide.hidden).length,
    },
  };
}
