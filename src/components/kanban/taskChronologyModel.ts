import type { ClearedNeed } from "@/components/attention/needReason";
import type { DismissedBy } from "@/lib/attention/dismissalTypes";
import { laneStopKind, type LaneStopKind } from "@/lib/pipelines/laneStop";
import { latestAttempt } from "@/lib/pipelines/stageChip";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

import type { PastAttempt } from "./pipelineGraph";

/*
 * A task's events in order (docs/design/calm-task-cards-build.md §3): its
 * lanes, their attempts and review rounds, the answers to their questions,
 * pauses, merges and clearings, all from records the board already holds.
 * Pure and browser-safe, with no words in it: the component turns kinds into
 * words, so a test reads the order without React or a locale.
 */

export type ChronologyKind =
  | "task-created" | "lane-started"
  | "attempt-passed" | "attempt-skipped" | "attempt-failed" | "attempt-cut" | "attempt-lost"
  | "attempt-stopped" | "attempt-running" | "round"
  | "decision-answered" | "lane-paused" | "lane-resumed" | "lane-cleared"
  | "merge-queued" | "merge-updated" | "merge-stopped" | "merge-merged" | "lane-closed"
  | "need-cleared";

export type ChronologyActor = "operator" | "seat" | "agent" | "system";

export interface ChronologyEntry {
  /** Stable across renders: the pipeline, the kind and what it is about. */
  key: string;
  kind: ChronologyKind;
  atMs: number;
  pipelineId: string | null;
  stageId: string | null;
  attempt: number | null;
  /** Folded restarts, or an attempt's findings. */
  count?: number;
  /** The lane's current stop: its manual answers ride this entry. */
  stop?: true;
  /** The attempt's or round's conversation, when one was kept. */
  conversation?: { path: string | null; conversationId: string | null };
  actor?: ChronologyActor;
  /** Who cleared a stop or a reason, as the dismissal recorded it. */
  by?: DismissedBy;
  /** The record's own words for a stop, for «Details». */
  detail?: string;
  stopKind?: LaneStopKind;
  prNumber?: number | null;
  /** The runner's reason as stored, or who merged it. */
  mergeReason?: string | null;
  mergedBy?: "auto-merge" | "outside" | null;
  /** The past row an attempt or round entry came from: its label and verdict. */
  past?: PastAttempt;
}

export interface ChronologyInput {
  taskCreatedAt: string | null;
  pipelines: readonly Pipeline[];
  /** The card's earlier attempts and review rounds (`card.past`). */
  past: readonly PastAttempt[];
  /** The card's cleared reasons (`card.cleared`). */
  cleared: readonly ClearedNeed[];
  /** The project's seat conversations, current and previous: their answers read as the orchestrator's. */
  seatConversationIds: readonly string[];
}

const LIVE_ATTEMPT: ReadonlySet<string> = new Set(["spawning", "running", "reviewing", "committing"]);
/** The engine's words for an attempt a Delegatus restart cut (`engine.ts` restart recovery). */
const RESTART_CUT = /interrupted by a Delegatus restart|interrupted again during this boot/;
const HOST_LOST = /stage host was lost/;
/** The publication reservation's note, which says nothing to a person. */
const PUBLICATION_TAIL = /\s*·\s*Viewer publication[\s\S]*$/;

const ms = (stamp: string | null | undefined): number | null => {
  const value = Date.parse(stamp ?? "");
  return Number.isFinite(value) ? value : null;
};

function attemptOf(pipeline: Pipeline, stageId: string, n: number): PipelineStageAttempt | null {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts.find((attempt) => attempt.n === n) ?? null;
}

function findingCount(attempt: PipelineStageAttempt | null): number {
  const verdict = attempt?.report?.verdict ?? attempt?.verdict;
  return verdict?.rankedFindings?.length ?? verdict?.findings?.length ?? 0;
}

/** The stage and attempt a lane stands stopped on, when it stands on one. */
function stopAttempt(pipeline: Pipeline): { stageId: string | null; attempt: PipelineStageAttempt | null } | null {
  const stop = laneStopKind(pipeline);
  if (!stop || stop.kind === "merge") return null;
  return { stageId: stop.stageId, attempt: stop.stageId ? latestAttempt(pipeline, stop.stageId) : null };
}

function actorOf(by: DismissedBy): ChronologyActor {
  if (by.kind === "operator" || by.kind === "gateway") return "operator";
  if (by.kind === "manager") return "seat";
  if (by.kind === "system") return "system";
  return "agent";
}

/** The task's events, oldest first. */
export function taskChronology(input: ChronologyInput): ChronologyEntry[] {
  const entries: ChronologyEntry[] = [];
  const created = ms(input.taskCreatedAt);
  if (created !== null) entries.push({ key: "task:created", kind: "task-created", atMs: created, pipelineId: null, stageId: null, attempt: null });
  const byId = new Map(input.pipelines.map((pipeline) => [pipeline.id, pipeline] as const));
  const stops = new Map(input.pipelines.flatMap((pipeline) => {
    const found = stopAttempt(pipeline);
    return found ? [[pipeline.id, found] as const] : [];
  }));

  for (const pipeline of input.pipelines) {
    const id = pipeline.id;
    const createdAt = ms(pipeline.createdAt);
    if (input.pipelines.length > 1 && createdAt !== null) entries.push({ key: `${id}:started`, kind: "lane-started", atMs: createdAt, pipelineId: id, stageId: null, attempt: null });
    /* The live attempt of each stage, which the past rows leave out. */
    for (const stage of pipeline.stages) {
      const live = latestAttempt(pipeline, stage.id);
      const startedAt = ms(live?.startedAt);
      if (live && LIVE_ATTEMPT.has(live.state) && startedAt !== null) {
        entries.push({ key: `${id}:running:${stage.id}:${live.n}`, kind: "attempt-running", atMs: startedAt, pipelineId: id, stageId: stage.id, attempt: live.n });
      }
    }
    const stop = stops.get(id);
    if (stop) {
      const attempt = stop.attempt;
      const kind = laneStopKind(pipeline)!.kind;
      const at = ms(attempt?.completedAt) ?? ms(attempt?.report?.at) ?? ms(attempt?.startedAt) ?? createdAt ?? 0;
      const detail = (attempt?.error ?? pipeline.stateDetail ?? "").replace(PUBLICATION_TAIL, "").trim();
      entries.push({
        key: `${id}:stop:${stop.stageId ?? "lane"}:${attempt?.n ?? 0}`,
        kind: "attempt-stopped",
        atMs: at,
        pipelineId: id,
        stageId: stop.stageId,
        attempt: attempt?.n ?? null,
        stop: true,
        stopKind: kind,
        ...(detail ? { detail } : {}),
        ...(attempt && (attempt.agentPath || attempt.conversationId) ? { conversation: { path: attempt.agentPath, conversationId: attempt.conversationId } } : {}),
      });
    }
    for (const answer of pipeline.decisionAnswers ?? []) {
      const at = ms(answer.at);
      if (at === null) continue;
      const actor: ChronologyActor = answer.actor.kind === "operator" ? "operator" : answer.actor.conversationId && input.seatConversationIds.includes(answer.actor.conversationId) ? "seat" : "agent";
      entries.push({ key: `${id}:answer:${answer.clientRequestId}`, kind: "decision-answered", atMs: at, pipelineId: id, stageId: answer.stageId, attempt: answer.attempt, actor });
    }
    const paused = ms(pipeline.pausedAt);
    if (paused !== null) entries.push({ key: `${id}:paused:${pipeline.pausedAt}`, kind: "lane-paused", atMs: paused, pipelineId: id, stageId: null, attempt: null });
    const resumed = ms(pipeline.resumedAt);
    if (resumed !== null) entries.push({ key: `${id}:resumed:${pipeline.resumedAt}`, kind: "lane-resumed", atMs: resumed, pipelineId: id, stageId: null, attempt: null });
    const dismissed = ms(pipeline.dismissedAt);
    if (dismissed !== null) {
      const by: DismissedBy = pipeline.dismissedBy ?? { kind: "operator" };
      entries.push({ key: `${id}:cleared:${pipeline.dismissedAt}`, kind: "lane-cleared", atMs: dismissed, pipelineId: id, stageId: null, attempt: null, by, actor: actorOf(by) });
    }
    const merge = pipeline.merge;
    if (merge) {
      const pr = merge.prNumber;
      const queued = ms(merge.requestedAt);
      if (queued !== null) entries.push({ key: `${id}:merge:queued`, kind: "merge-queued", atMs: queued, pipelineId: id, stageId: null, attempt: null, prNumber: pr });
      (merge.updates ?? []).forEach((update, index) => {
        const at = ms(update.requestedAt);
        if (at !== null) entries.push({ key: `${id}:merge:update:${index}`, kind: "merge-updated", atMs: at, pipelineId: id, stageId: null, attempt: null, prNumber: pr });
      });
      const blocked = ms(merge.blockedAt);
      if (merge.state === "blocked" && blocked !== null) {
        entries.push({ key: `${id}:merge:stopped:${merge.blockedAt}`, kind: "merge-stopped", atMs: blocked, pipelineId: id, stageId: null, attempt: null, prNumber: pr, mergeReason: merge.reason, stop: true, stopKind: "merge" });
      }
      const merged = ms(merge.mergedAt);
      if (merge.state === "merged" && merged !== null) entries.push({ key: `${id}:merge:merged`, kind: "merge-merged", atMs: merged, pipelineId: id, stageId: null, attempt: null, prNumber: pr, mergedBy: merge.by });
    }
    const closed = ms(pipeline.closedAt);
    if (pipeline.state === "closed" && closed !== null) entries.push({ key: `${id}:closed`, kind: "lane-closed", atMs: closed, pipelineId: id, stageId: null, attempt: null });
  }

  for (const row of input.past) {
    if (row.kind === "helper" || !row.atMs) continue;
    const pipeline = byId.get(row.pipelineId);
    if (!pipeline) continue;
    const conversation = row.conversation.path || row.conversation.conversationId ? { conversation: row.conversation } : {};
    const base = { atMs: row.atMs, pipelineId: row.pipelineId, stageId: row.stageId, past: row, ...conversation };
    if (row.kind === "round") {
      entries.push({ ...base, key: row.key, kind: "round", attempt: row.attempt });
      continue;
    }
    /* The attempt the lane stands stopped on is the stop's entry. */
    const stop = stops.get(row.pipelineId);
    if (stop?.attempt && stop.stageId === row.stageId && stop.attempt.n === row.n) continue;
    const attempt = attemptOf(pipeline, row.stageId, row.n);
    const error = attempt?.error ?? "";
    if (RESTART_CUT.test(error)) entries.push({ ...base, key: row.key, kind: "attempt-cut", attempt: row.n, count: 1 });
    else if (HOST_LOST.test(error)) entries.push({ ...base, key: row.key, kind: "attempt-lost", attempt: row.n });
    else if (row.state === "skipped") entries.push({ ...base, key: row.key, kind: "attempt-skipped", attempt: row.n });
    else if (row.state === "passed" && row.verdict !== "fail") entries.push({ ...base, key: row.key, kind: "attempt-passed", attempt: row.n });
    else entries.push({ ...base, key: row.key, kind: "attempt-failed", attempt: row.n, count: findingCount(attempt) });
  }

  for (const cleared of input.cleared) {
    if (cleared.need.subject !== "conversation" || !Number.isFinite(cleared.at)) continue;
    entries.push({ key: `need:${cleared.need.key}:${cleared.at}`, kind: "need-cleared", atMs: cleared.at * 1000, pipelineId: null, stageId: null, attempt: null, by: cleared.by, actor: actorOf(cleared.by) });
  }

  const sorted = entries.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.atMs - b.entry.atMs || a.index - b.index).map(({ entry }) => entry);
  /* A run of restarts that cut the same stage reads as one entry with its count. */
  const folded: ChronologyEntry[] = [];
  for (const entry of sorted) {
    const previous = folded.at(-1);
    if (entry.kind === "attempt-cut" && previous?.kind === "attempt-cut" && previous.pipelineId === entry.pipelineId && previous.stageId === entry.stageId) {
      folded[folded.length - 1] = { ...entry, key: previous.key, count: (previous.count ?? 1) + 1 };
      continue;
    }
    folded.push(entry);
  }
  return folded;
}

/**
 * What the expanded card shows: the latest `recent` entries, the rest counted
 * behind «Earlier · N». A stop that falls under the fold is pulled out and
 * shown first after that row, in the place of one of the latest, so a lane's
 * answers are always read under their reason. Open, everything shows.
 */
export function foldChronology(entries: readonly ChronologyEntry[], open: boolean, recent = 8): { hidden: number; shown: ChronologyEntry[] } {
  if (open || entries.length <= recent) return { hidden: 0, shown: [...entries] };
  const tailFrom = entries.length - recent;
  const pinned = entries.slice(0, tailFrom).filter((entry) => entry.stop);
  const room = Math.max(0, recent - pinned.length);
  const tail = room ? entries.slice(entries.length - room) : [];
  /* A pinned stop takes the place of the oldest of the latest, which joins the hidden. */
  const shown = [...pinned, ...tail];
  return { hidden: entries.length - shown.length, shown };
}
