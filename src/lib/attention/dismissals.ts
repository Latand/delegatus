import fs from "node:fs";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { currentPrototypeSummary, prototypeReviewSummary } from "@/lib/prototypeReview/model";
import { redactMonitorText } from "@/lib/monitor/redact";

import { statePath } from "@/lib/configDir";
import type { PipelinePatchResult } from "@/lib/pipelines/engine";
import { laneMovedSince } from "@/lib/pipelines/laneMovement";
import type { Pipeline } from "@/lib/pipelines/types";
import type { LegacyImportHooks, LegacyImportOutcome } from "@/lib/state/legacyImport";
import { LegacyDocumentStore } from "@/lib/state/legacyDocumentStore";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import {
  isDismissedBy,
  type AttentionSystemRule,
  type ConversationReasonKind,
  type DismissalOutcome,
  type DismissalSubject,
  type DismissalSubjectRequest,
  type DismissalTarget,
  type DismissedBy,
  type SystemClearSnapshot,
} from "./dismissalTypes";
import { laneWaitCleared, parseEscalationMark, type AttentionEscalationMark } from "./routeTypes";

/**
 * Needs-you dismissals (docs/design/needs-attention.md §5): one service behind
 * the operator's route and the `dismiss_attention` MCP tool, so a click on a
 * card and an agent's call write the same record, attributed on the server.
 *
 * Each subject keeps the record it already has:
 *
 *  - a conversation's is here, one record per conversation in the
 *    `attention_dismissals` collection of `state.sqlite`, built like the
 *    reply-suggestions store. A new dismissal replaces the old one;
 *  - a lane's is its own `dismissedAt`/`dismissedBy` (#1671), which the phone
 *    queue, the group hide and the seat monitor already read;
 *  - an orchestrator's decision request is resolved in the bridge report log
 *    itself (`resolvedAsks`), which is the record the report log's tick
 *    writes too, so the two surfaces are one action on one record;
 *  - a prototype round has an exact-round record in this collection;
 *  - a task has none: dismissing a task dismisses what is on it.
 *
 * A dismissal hides only what its maker saw, so nothing here ever has to be
 * taken back when something new happens. A card names the reason it drew and
 * the reason model covers that id alone; an agent names none and is compared
 * by time (`dismissalCovers`). A lane the card drew is stamped only while it
 * has not moved since.
 */

export const ATTENTION_DISMISSALS_SCHEMA_VERSION = 1 as const;
/** Records older than this are dropped on the next write: whatever they
    covered has long been answered or gone. */
export const DISMISSAL_RETENTION_MS = 30 * 24 * 3_600_000;
/** How many conversations the record holds before the oldest falls away. */
export const DISMISSAL_CAPACITY = 2_000;

export interface AttentionDismissalV1 {
  /** The durable conversation id, a legacy transcript path, a prototype
      round key prefixed with `prototype:`, or a seat's escalation of one
      routed wait prefixed with `escalation:` (docs/design/attention-auto-resolve.md). */
  kind?: "conversation" | "prototype" | "escalation";
  taskId?: string;
  note?: string;
  subject: string;
  conversationId: string | null;
  path: string | null;
  /** Server clock, ISO. */
  at: string;
  by: DismissedBy;
  /** What was on screen, for the record. */
  reason: ConversationReasonKind | null;
  /** That reason's attention id: the one reason the record covers. Null for
      an agent's call, which covers what started at or before `at`. */
  reasonId: string | null;
  /** The MCP operation that wrote it, so a replay answers the first result. */
  operationKey?: string;
  /** Only on a record Delegatus wrote (`by.kind === "system"`) that the
      operator then brought back: the record stays, covers nothing, and keeps
      the same rule from clearing the same reason again. */
  restoredAt?: string;
  restoredBy?: DismissedBy;
  /** Only on an `escalation` record: the wait and the decision round the
      seat asked the operator in. It holds no question of its own. */
  escalation?: AttentionEscalationMark;
  /** Only on a record Delegatus wrote: what it cleared, so the cleared list
      and the card keep the reason and its Undo once the source stops
      raising it. */
  cleared?: SystemClearSnapshot;
}

export interface AttentionDismissalsFileV1 {
  schemaVersion: typeof ATTENTION_DISMISSALS_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  records: AttentionDismissalV1[];
}

export function attentionDismissalsFile(): string {
  return statePath("attention-dismissals.json");
}

function emptyFile(now: Date): AttentionDismissalsFileV1 {
  return { schemaVersion: ATTENTION_DISMISSALS_SCHEMA_VERSION, revision: 0, updatedAt: now.toISOString(), records: [] };
}

const REASON_KINDS: ReadonlySet<string> = new Set(["decision", "question", "plan", "permission", "delivery", "launch", "memory", "ask"]);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

function parseRecord(value: unknown): AttentionDismissalV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.subject !== "string" || !record.subject) return null;
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) return null;
  if (!isDismissedBy(record.by)) return null;
  if (record.kind === "escalation") {
    const escalation = parseEscalationMark(record.escalation);
    if (!escalation) return null;
    return { kind: "escalation", subject: record.subject, conversationId: null, path: null, at: record.at, by: record.by, reason: null, reasonId: null, escalation,
      ...(typeof record.operationKey === "string" && record.operationKey ? { operationKey: record.operationKey } : {}) };
  }
  return {
    ...(record.kind === "prototype" ? { kind: "prototype" as const, taskId: typeof record.taskId === "string" ? record.taskId : undefined } : {}),
    ...(typeof record.note === "string" ? { note: record.note } : {}),
    subject: record.subject,
    conversationId: nullableString(record.conversationId) ? record.conversationId : null,
    path: nullableString(record.path) ? record.path : null,
    at: record.at,
    by: record.by,
    reason: typeof record.reason === "string" && REASON_KINDS.has(record.reason) ? record.reason as ConversationReasonKind : null,
    reasonId: typeof record.reasonId === "string" && record.reasonId ? record.reasonId : null,
    ...(typeof record.operationKey === "string" && record.operationKey ? { operationKey: record.operationKey } : {}),
    ...(typeof record.restoredAt === "string" && Number.isFinite(Date.parse(record.restoredAt)) && isDismissedBy(record.restoredBy)
      ? { restoredAt: record.restoredAt, restoredBy: record.restoredBy } : {}),
    ...(record.by.kind === "system" && parseClearSnapshot(record.cleared) ? { cleared: parseClearSnapshot(record.cleared)! } : {}),
  };
}

const SNAPSHOT_TEXT_MAX = 200;

/** A stored automatic-clear snapshot, checked; anything malformed reads as none. */
function parseClearSnapshot(value: unknown): SystemClearSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.reason !== "string" || !REASON_KINDS.has(raw.reason)) return null;
  if (typeof raw.raisedAt !== "number" || !Number.isFinite(raw.raisedAt)) return null;
  if (typeof raw.title !== "string" || typeof raw.project !== "string" || !raw.project) return null;
  return { reason: raw.reason as ConversationReasonKind, raisedAt: raw.raisedAt, title: raw.title.slice(0, SNAPSHOT_TEXT_MAX), project: raw.project.slice(0, SNAPSHOT_TEXT_MAX) };
}

/** Anything unreadable reads as no dismissal, which costs a card that flags
    again and never a card that stays hidden. */
function parseBody(raw: unknown, now: Date): AttentionDismissalsFileV1 {
  const parsed = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<AttentionDismissalsFileV1>;
  if (parsed.schemaVersion !== ATTENTION_DISMISSALS_SCHEMA_VERSION || !Array.isArray(parsed.records)) return emptyFile(now);
  return {
    schemaVersion: ATTENTION_DISMISSALS_SCHEMA_VERSION,
    revision: Number.isInteger(parsed.revision) ? parsed.revision! : 0,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now.toISOString(),
    records: parsed.records.map(parseRecord).filter((record): record is AttentionDismissalV1 => record !== null),
  };
}

function readLegacyFile(filePath: string, now: Date): AttentionDismissalsFileV1 {
  try {
    return parseBody(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown, now);
  } catch {
    return emptyFile(now);
  }
}

const META_KEY = "meta";
type DismissalsMeta = Pick<AttentionDismissalsFileV1, "schemaVersion" | "revision" | "updatedAt">;
const recordKey = (subject: string) => `d:${subject}`;

const dismissalsStore = new LegacyDocumentStore<AttentionDismissalsFileV1>({
  collection: "attention_dismissals",
  migrationId: "attention-dismissals-json-v1",
  busyMessage: "attention dismissals are busy",
  parse: (raw) => parseBody(raw, new Date()),
  toRows: (file) => [
    { key: META_KEY, value: { schemaVersion: file.schemaVersion, revision: file.revision, updatedAt: file.updatedAt } satisfies DismissalsMeta },
    ...file.records
      .filter((record, index) => file.records.findLastIndex((other) => other.subject === record.subject) === index)
      .map((record) => ({ key: recordKey(record.subject), value: record })),
  ],
  fromRows: (rows) => {
    const meta = rows.find((row) => row.key === META_KEY)?.value as DismissalsMeta | undefined;
    return {
      schemaVersion: ATTENTION_DISMISSALS_SCHEMA_VERSION,
      revision: meta?.revision ?? 0,
      updatedAt: meta?.updatedAt ?? "",
      records: rows.filter((row) => row.key.startsWith("d:")).map((row) => parseRecord(row.value)).filter((record): record is AttentionDismissalV1 => record !== null),
    };
  },
  toFile: (file) => file,
  mergeRow: (key, held, incoming) => {
    if (key !== META_KEY) return undefined;
    const [ours, theirs] = [held as DismissalsMeta, incoming as DismissalsMeta];
    return theirs.revision > ours.revision ? theirs : ours;
  },
  readLegacy: (filePath) => readLegacyFile(filePath, new Date()),
  error: (message, cause) => new Error(message, { cause }),
});

/** The store's legacy import spec, for the import driver and its tests. */
export function attentionDismissalsLegacyCollection(filePath = attentionDismissalsFile()) {
  return dismissalsStore.legacyCollection(filePath);
}

/** Import `attention-dismissals.json` into SQLite now (the Viewer's activation). */
export function importLegacyAttentionDismissals(
  filePath = attentionDismissalsFile(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return dismissalsStore.importLegacy(filePath, options);
}

/** Write `attention-dismissals.json` from SQLite for a rollback release. */
export function checkpointAttentionDismissalsRollbackMirrorForDemotion(filePath = attentionDismissalsFile()): void {
  dismissalsStore.checkpointRollbackMirror(filePath);
}

/** The persisted record, oldest dismissal first. */
export function readAttentionDismissals(filePath = attentionDismissalsFile(), now = new Date()): AttentionDismissalsFileV1 {
  const file = dismissalsStore.read(filePath);
  return file.updatedAt ? file : { ...file, updatedAt: now.toISOString() };
}

/** Each conversation's dismissal, by durable id and by transcript path, for
    the `/api/files` projection. */
export function attentionDismissalIndex(file: AttentionDismissalsFileV1 = readAttentionDismissals()): Map<string, AttentionDismissalV1> {
  const index = new Map<string, AttentionDismissalV1>();
  for (const record of file.records) {
    /* An escalation names a wait, not a conversation, and a restored record
       covers nothing. */
    if (record.kind === "escalation" || record.restoredAt) continue;
    if (record.conversationId) index.set(record.conversationId, record);
    if (record.path) index.set(record.path, record);
    index.set(record.subject, record);
  }
  return index;
}

/**
 * Stamp each conversation's dismissal onto its entries, for `/api/files`. A
 * retired round is skipped, as the bridge ask overlay skips it: the successor
 * carries the live card. An entry with no record carries none, so an undo
 * takes the mark off on the next projection. A record the store cannot read
 * costs a card that flags again, never the poll.
 */
export function overlayAttentionDismissals(files: readonly FileEntry[], read: () => Map<string, AttentionDismissalV1> = attentionDismissalIndex): void {
  let index: Map<string, AttentionDismissalV1>;
  try {
    index = read();
  } catch {
    return;
  }
  for (const file of files) {
    const record = file.supersededBy || file.migratedTo
      ? undefined
      : (file.conversationId ? index.get(file.conversationId) : undefined) ?? index.get(file.path);
    if (record && record.kind !== "prototype") file.attentionDismissal = { at: record.at, by: record.by, reasonId: record.reasonId, ...(record.cleared ? { cleared: record.cleared } : {}) };
    else if (file.attentionDismissal) delete file.attentionDismissal;
  }
}

/** One serialized read-modify-write. A mutation that returns no records
    changed nothing and writes nothing. Prototype hides remain undoable;
    conversation records alone expire and count towards the capacity. */
function mutate<R>(mutation: (records: AttentionDismissalV1[]) => { records?: AttentionDismissalV1[]; result: R }, now: Date): R {
  return dismissalsStore.mutate(attentionDismissalsFile(), (current) => {
    const outcome = mutation(current.records);
    if (!outcome.records) return { next: undefined, result: outcome.result };
    const floor = now.getTime() - DISMISSAL_RETENTION_MS;
    const conversations = new Set(outcome.records
      .filter(record => record.kind !== "prototype" && Date.parse(record.at) >= floor)
      .slice(-DISMISSAL_CAPACITY));
    const kept = outcome.records.filter(record => record.kind === "prototype" || conversations.has(record));
    return {
      next: {
        schemaVersion: ATTENTION_DISMISSALS_SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
        records: kept,
      },
      result: outcome.result,
    };
  });
}

export class DismissalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "DismissalError";
  }
}

/** A conversation as the service resolves it: its durable id when the
    registry knows it, and its current transcript path. */
export interface ResolvedConversation {
  conversationId: string | null;
  path: string | null;
}

/** What the service reads and writes besides its own record. Production wires
    the registry, the task store and the pipeline engine; tests pass their own. */
export interface DismissalPorts {
  now(): Date;
  /** The conversation a card or a caller named, or null when nothing names it. */
  resolveConversation(ref: { conversationId?: string | null; path?: string | null }): ResolvedConversation | null;
  task(taskId: string): BoardTask | null;
  pipelines(): readonly Pipeline[];
  pipeline(pipelineId: string): Pipeline | null;
  /** Stamp or clear a lane. `drawnMovedAt`, when stated, is the movement the
      card drew; a lane that moved since answers `moved` and is not stamped. */
  setPipelineDismissal(pipelineId: string, dismiss: boolean, by: DismissedBy, drawnMovedAt?: number | null, note?: string): Promise<PipelinePatchResult>;
  /** Resolve decision requests in the report log, or take the mark back. */
  resolveReports(seqs: readonly number[], resolve: boolean, by: DismissedBy, at: string, project?: string, note?: string): { resolved: number[]; alreadyClear: number[]; unknown: number[] };
}

export interface DismissOptions {
  undo?: boolean;
  reason?: string;
  project?: string;
  /** The MCP operation, when an agent called: a replay of it answers the
      record the first run wrote. */
  operationKey?: string;
  ports?: DismissalPorts;
}

const MAX_ID = 4_096;
/** How many subjects one card can name. */
export const MAX_DISMISSAL_SUBJECTS = 200;

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_ID) throw new DismissalError("INVALID_TARGET", `invalid ${field}`);
  return value;
}

function requiredId(value: unknown, field: string): string {
  const id = optionalId(value, field);
  if (!id) throw new DismissalError("INVALID_TARGET", `${field} is required`);
  return id;
}

/** The lane movement a card drew: epoch ms, null for a lane that never ran a
    round, undefined when the caller did not say. */
function drawnMovement(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DismissalError("INVALID_TARGET", "laneMovedAt must be epoch milliseconds or null");
  return value;
}

function parsePipeline(subject: Record<string, unknown>): Extract<DismissalSubjectRequest, { kind: "pipeline" }> {
  const moved = drawnMovement(subject.laneMovedAt);
  return { kind: "pipeline", pipelineId: requiredId(subject.pipelineId, "pipelineId"), ...(moved !== undefined ? { laneMovedAt: moved } : {}) };
}

function parseSubject(value: unknown): DismissalSubjectRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DismissalError("INVALID_TARGET", "a subject must be an object");
  const subject = value as Record<string, unknown>;
  if (subject.kind === "pipeline") return parsePipeline(subject);
  if (subject.kind === "report") {
    if (!Number.isInteger(subject.seq) || (subject.seq as number) < 1) throw new DismissalError("INVALID_TARGET", "a report needs its seq");
    return { kind: "report", seq: subject.seq as number };
  }
  if (subject.kind !== "conversation") throw new DismissalError("INVALID_TARGET", "a subject is a conversation, a pipeline or a report");
  const conversationId = optionalId(subject.conversationId, "conversationId");
  const path = optionalId(subject.path, "path");
  if (!conversationId && !path) throw new DismissalError("INVALID_TARGET", "a conversation needs its conversationId or its path");
  const reasonId = optionalId(subject.reasonId, "reasonId");
  const reason = typeof subject.reason === "string" && REASON_KINDS.has(subject.reason) ? subject.reason as ConversationReasonKind : undefined;
  return {
    kind: "conversation",
    ...(conversationId ? { conversationId } : {}),
    ...(path ? { path } : {}),
    ...(reasonId ? { reasonId } : {}),
    ...(reason ? { reason } : {}),
  };
}

function parseSubjects(value: unknown): DismissalSubjectRequest[] {
  if (!Array.isArray(value) || value.length > MAX_DISMISSAL_SUBJECTS) throw new DismissalError("INVALID_TARGET", `subjects must be a list of at most ${MAX_DISMISSAL_SUBJECTS}`);
  return value.map(parseSubject);
}

/**
 * A target as a caller sent it, checked. `subjects` (a task's drawn subjects,
 * or a card no task owns) is the operator's own batch form; the MCP tool
 * names individual targets or all attention on one task.
 */
export function parseDismissalTarget(value: unknown, options: { allowSubjects: boolean }): DismissalTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DismissalError("INVALID_TARGET", "target must be an object with a kind");
  const target = value as Record<string, unknown>;
  switch (target.kind) {
    case "conversation":
      return parseSubject({ ...target, kind: "conversation" }) as Extract<DismissalTarget, { kind: "conversation" }>;
    case "pipeline":
      return parsePipeline(target);
    case "prototype":
      return { kind: "prototype", taskId: requiredId(target.taskId, "taskId"), reviewId: requiredId(target.reviewId, "reviewId") };
    case "report":
      return parseSubject(target) as DismissalTarget;
    case "update":
      throw new DismissalError("UPDATE_NEEDS_ANSWER", "The operator chooses deploy now or keep waiting");
    case "task":
      return {
        kind: "task",
        taskId: requiredId(target.taskId, "taskId"),
        ...(options.allowSubjects && target.subjects !== undefined ? { subjects: parseSubjects(target.subjects) } : {}),
      };
    case "subjects":
      if (!options.allowSubjects) break;
      return { kind: "subjects", subjects: parseSubjects(target.subjects) };
  }
  throw new DismissalError("INVALID_TARGET", `target.kind must be ${options.allowSubjects ? "conversation, pipeline, task, report, prototype or subjects" : "conversation, pipeline, task, report or prototype"}`);
}

/** A completed lane whose automatic merge stopped (#2187 §4.6). */
function laneMergeBlocked(pipeline: Pipeline): boolean {
  return pipeline.state === "completed" && pipeline.merge?.state === "blocked";
}

/** A lane that waits on the operator right now. */
function laneAsks(pipeline: Pipeline): boolean {
  return pipeline.state === "needs_decision" || pipeline.state === "needs_review" || laneMergeBlocked(pipeline);
}

/** The subjects a target names. A task names the subjects its card drew when
    the caller says which, and otherwise everything on it: its assignments and
    the lanes filed under it. */
function subjectsOf(target: DismissalTarget, ports: DismissalPorts): Array<DismissalSubjectRequest | Extract<DismissalTarget, { kind: "prototype" }>> {
  switch (target.kind) {
    case "conversation":
      return [{ kind: "conversation", conversationId: target.conversationId, path: target.path, reasonId: target.reasonId ?? null }];
    case "pipeline":
    case "report":
    case "prototype":
      return [target];
    case "subjects":
      return target.subjects;
    case "task": {
      const task = ports.task(target.taskId);
      if (!task) throw new DismissalError("TASK_NOT_FOUND", `no task ${target.taskId}`, 404);
      if (target.subjects) return target.subjects;
      const reviewId = currentPrototypeSummary(task.prototypeReview ?? prototypeReviewSummary(task.prototypeReviews ?? []) ?? task.prototypeReviewReplica?.summary)?.waitingReviewId;
      return [
        ...(reviewId ? [{ kind: "prototype" as const, taskId: task.id, reviewId }] : []),
        ...task.assignments
          .filter((assignment) => assignment.conversationId || assignment.path)
          .map((assignment): DismissalSubjectRequest => ({ kind: "conversation", conversationId: assignment.conversationId ?? undefined, path: assignment.path ?? undefined })),
        ...ports.pipelines()
          .filter((pipeline) => pipeline.taskIds?.includes(task.id))
          .map((pipeline): DismissalSubjectRequest => ({ kind: "pipeline", pipelineId: pipeline.id })),
      ];
    }
  }
}

/**
 * Clear (or bring back) what a subject needs the operator for.
 *
 * Every subject the target names is answered once, as `dismissed`, as
 * `alreadyClear` (a lane that asks nothing, or one already cleared for the
 * decision it waits on; an undo of something nobody cleared), or as `changed`
 * (a lane that moved after the card drew it, which keeps asking). None is an
 * error. A conversation is always recorded: the record names the reason the
 * card drew, or says what was seen up to now, and cannot hide anything that
 * starts later. A target that names nothing the service can find is refused.
 */
export async function dismissAttention(target: DismissalTarget, by: DismissedBy, options: DismissOptions = {}): Promise<DismissalOutcome> {
  const note = dismissalNote(options.reason);
  const ports = options.ports ?? await productionDismissalPorts();
  const undo = options.undo === true;
  const now = ports.now();
  const at = now.toISOString();
  const requested = subjectsOf(target, ports);
  const dismissed: DismissalSubject[] = [];
  const alreadyClear: DismissalSubject[] = [];
  const changed: DismissalSubject[] = [];
  const seen = new Set<string>();

  const conversations: Array<{ resolved: ResolvedConversation; subject: string; reasonId: string | null; reason: ConversationReasonKind | null }> = [];
  for (const request of requested) {
    if (request.kind !== "conversation") continue;
    const resolved = ports.resolveConversation(request);
    if (!resolved) {
      if (target.kind === "conversation") throw new DismissalError("CONVERSATION_NOT_FOUND", "no conversation by that id or path", 404);
      continue;
    }
    const subject = resolved.conversationId ?? resolved.path;
    if (!subject || seen.has(`conversation:${subject}`)) continue;
    seen.add(`conversation:${subject}`);
    conversations.push({ resolved, subject, reasonId: request.reasonId ?? null, reason: request.reason && REASON_KINDS.has(request.reason) ? request.reason : null });
  }

  if (conversations.length) {
    const outcome = mutate((records) => {
      let next = records;
      let changed = false;
      const done: DismissalSubject[] = [];
      const clear: DismissalSubject[] = [];
      for (const entry of conversations) {
        const answer: DismissalSubject = { kind: "conversation", conversationId: entry.subject };
        const held = next.find((record) => record.subject === entry.subject) ?? null;
        if (undo) {
          if (!held || held.restoredAt) { clear.push(answer); continue; }
          /* What Delegatus cleared on its own evidence stays on record as
             restored, so the same rule cannot clear the same reason again. */
          next = held.by.kind === "system"
            ? next.map((record) => (record === held ? { ...held, restoredAt: at, restoredBy: by } : record))
            : next.filter((record) => record.subject !== entry.subject);
          changed = true;
          done.push(answer);
          continue;
        }
        /* A replay of the same operation answers what it wrote. */
        if (held && options.operationKey && held.operationKey === options.operationKey) { done.push(answer); continue; }
        const record: AttentionDismissalV1 = {
          subject: entry.subject,
          conversationId: entry.resolved.conversationId,
          path: entry.resolved.path,
          at,
          by,
          ...(note ? { note } : {}),
          reason: entry.reason,
          reasonId: entry.reasonId,
          ...(options.operationKey ? { operationKey: options.operationKey } : {}),
        };
        /* Newest last: the capacity trim drops the conversation cleared longest ago. */
        next = [...next.filter((existing) => existing.subject !== entry.subject), record];
        changed = true;
        done.push(answer);
      }
      return { ...(changed ? { records: next } : {}), result: { done, clear } };
    }, now);
    dismissed.push(...outcome.done);
    alreadyClear.push(...outcome.clear);
  }

  for (const request of requested) {
    if (request.kind !== "prototype" || seen.has(`prototype:${request.reviewId}`)) continue;
    seen.add(`prototype:${request.reviewId}`);
    const task = ports.task(request.taskId);
    if (!task) throw new DismissalError("TASK_NOT_FOUND", "prototype task not found", 404);
    const summary = currentPrototypeSummary(task.prototypeReview ?? prototypeReviewSummary(task.prototypeReviews ?? []) ?? task.prototypeReviewReplica?.summary);
    const answer: DismissalSubject = { ...request };
    const subject = `prototype:${request.reviewId}`;
    const result = mutate((records) => {
      const held = records.find(record => record.subject === subject && record.taskId === task.id);
      if (undo) return held ? { records: records.filter(record => record !== held), result: true } : { result: false };
      if (summary?.waitingReviewId !== request.reviewId || held) return { result: false };
      return { records: [...records, { kind: "prototype", taskId: task.id, subject, conversationId: null, path: null, at, by, reason: null, reasonId: null,
        ...(note ? { note } : {}), ...(options.operationKey ? { operationKey: options.operationKey } : {}) }], result: true };
    }, now);
    (result ? dismissed : alreadyClear).push(answer);
  }

  for (const request of requested) {
    if (request.kind !== "pipeline" || seen.has(`pipeline:${request.pipelineId}`)) continue;
    seen.add(`pipeline:${request.pipelineId}`);
    const answer: DismissalSubject = { kind: "pipeline", pipelineId: request.pipelineId };
    const pipeline = ports.pipeline(request.pipelineId);
    if (!pipeline) {
      if (target.kind === "pipeline") throw new DismissalError("PIPELINE_NOT_FOUND", `no pipeline ${request.pipelineId}`, 404);
      continue;
    }
    const nothing = undo ? !pipeline.dismissedAt : !laneAsks(pipeline) || laneWaitCleared(pipeline);
    if (nothing || pipeline.state === "draft" || pipeline.state === "closed") {
      alreadyClear.push(answer);
      continue;
    }
    /* What the operator saw is the lane as the card drew it. One that parked
       again since is a decision they have not seen, so nothing is stamped;
       the engine asks the same again under its own lock. */
    const drawn = undo ? undefined : request.laneMovedAt;
    if (laneMovedSince(pipeline, drawn)) {
      changed.push(answer);
      continue;
    }
    const result = await ports.setPipelineDismissal(pipeline.id, !undo, by, drawn, note);
    if (!result.pipeline) throw new DismissalError("PIPELINE_REFUSED", result.error ?? "the pipeline refused the dismissal", result.status ?? 409);
    (result.moved ? changed : dismissed).push(answer);
  }

  const reports = [...new Set(requested.flatMap((request) => (request.kind === "report" ? [request.seq] : [])))];
  if (reports.length) {
    const outcome = ports.resolveReports(reports, !undo, by, at, options.project, note);
    dismissed.push(...outcome.resolved.map((seq): DismissalSubject => ({ kind: "report", seq })));
    alreadyClear.push(...outcome.alreadyClear.map((seq): DismissalSubject => ({ kind: "report", seq })));
  }

  if (!dismissed.length && !alreadyClear.length && !changed.length) {
    throw new DismissalError("NOTHING_TO_DISMISS", "the target names nothing that can need the operator");
  }
  return { dismissed, alreadyClear, changed, at, by, undo, ...(options.reason !== undefined ? { reason: note ?? "" } : {}) };
}

/**
 * One reason Delegatus clears on its own evidence
 * (docs/design/attention-auto-resolve.md, «Implementation plan for
 * acceptance 2»): the conversation, the exact reason, or every reason raised
 * up to now when the conversation can raise no newer one (a retired seat that
 * ended), and the rule that proved it.
 */
export interface SystemAttentionClear {
  conversationId: string | null;
  path: string | null;
  reasonId: string | null;
  reason: ConversationReasonKind;
  /** Epoch seconds the reason began to need someone. */
  raisedAt: number;
  rule: AttentionSystemRule;
  /** The row's title and the conversation's project when it was cleared,
      kept on the record for the cleared list. */
  title: string;
  project: string;
}

/** Whether the conversation's record already settles this clear: it covers
    the reason, or the operator brought back what an earlier clear hid. A
    reason raised after the restore can be cleared again on new evidence. */
function systemClearSettled(held: AttentionDismissalV1, clear: SystemAttentionClear): boolean {
  if (held.kind === "prototype" || held.kind === "escalation") return false;
  if (held.restoredAt) {
    if (held.reasonId && held.reasonId === clear.reasonId) return true;
    return clear.raisedAt <= Date.parse(held.restoredAt) / 1000;
  }
  if (held.reasonId) return held.reasonId === clear.reasonId;
  return clear.raisedAt <= Date.parse(held.at) / 1000;
}

/**
 * Write Delegatus's own clears, attributed `{ kind: "system", rule }`, through
 * the same record a card's dismissal writes, so every surface reads them, the
 * card says who cleared it and why, and Undo brings it back. A clear the
 * record already settles writes nothing, so a repeated pass is a no-op.
 * Answers the clears it wrote.
 */
export function systemClearAttention(clears: readonly SystemAttentionClear[], now = new Date()): SystemAttentionClear[] {
  if (!clears.length) return [];
  const at = now.toISOString();
  const launchPlaceholder = (clear: SystemAttentionClear) => clear.rule.startsWith("launch-") && clear.path?.startsWith("spawn:");
  const subjectOf = (clear: SystemAttentionClear) => launchPlaceholder(clear)
    ? clear.path
    : clear.conversationId ?? clear.path;
  return mutate((records) => {
    let next = records;
    const written: SystemAttentionClear[] = [];
    for (const clear of clears) {
      const subject = subjectOf(clear);
      if (!subject || written.some((done) => subjectOf(done) === subject)) continue;
      const held = next.find((record) => record.subject === subject);
      if (held && systemClearSettled(held, clear)) continue;
      const record: AttentionDismissalV1 = {
        subject,
        conversationId: launchPlaceholder(clear) ? null : clear.conversationId,
        path: clear.path,
        at,
        by: { kind: "system", rule: clear.rule },
        reason: clear.reason,
        reasonId: clear.reasonId,
        cleared: { reason: clear.reason, raisedAt: clear.raisedAt, title: clear.title.slice(0, SNAPSHOT_TEXT_MAX), project: clear.project.slice(0, SNAPSHOT_TEXT_MAX) },
      };
      next = [...next.filter((existing) => existing.subject !== subject), record];
      written.push(clear);
    }
    return { ...(written.length ? { records: next } : {}), result: written };
  }, now);
}

const escalationSubject = (key: string) => `escalation:${key}`;

/** Every standing escalation by the wait it names, for `/api/files`. */
export function attentionEscalationIndex(file: AttentionDismissalsFileV1 = readAttentionDismissals()): Map<string, AttentionEscalationMark> {
  const index = new Map<string, AttentionEscalationMark>();
  for (const record of file.records) if (record.kind === "escalation" && record.escalation) index.set(record.escalation.key, record.escalation);
  return index;
}

/**
 * A seat hands one routed wait to the operator by naming the decision round it
 * asked them in; `undo` takes it back. The wait itself is untouched: while the
 * round waits, the form's row is the operator's row for it, and once the round
 * is answered the wait is the seat's again, to carry the answer to the asker.
 */
export function writeAttentionEscalation(
  escalation: Omit<AttentionEscalationMark, "at">,
  by: DismissedBy,
  options: { undo?: boolean; operationKey?: string; now?: Date } = {},
): { changed: boolean; escalation: AttentionEscalationMark | null } {
  const now = options.now ?? new Date();
  const subject = escalationSubject(escalation.key);
  return mutate<{ changed: boolean; escalation: AttentionEscalationMark | null }>((records) => {
    const held = records.find((record) => record.subject === subject && record.kind === "escalation");
    if (options.undo) return held ? { records: records.filter((record) => record !== held), result: { changed: true, escalation: null } } : { result: { changed: false, escalation: null } };
    if (held && options.operationKey && held.operationKey === options.operationKey) return { result: { changed: false, escalation: held.escalation ?? null } };
    const mark: AttentionEscalationMark = { ...escalation, at: now.toISOString() };
    const record: AttentionDismissalV1 = { kind: "escalation", subject, conversationId: null, path: null, at: mark.at, by, reason: null, reasonId: null, escalation: mark,
      ...(options.operationKey ? { operationKey: options.operationKey } : {}) };
    return { records: [...records.filter((existing) => existing.subject !== subject), record], result: { changed: true, escalation: mark } };
  }, now);
}

/** Production ports, loaded on first use so this module stays free of the
    engine's import graph until a dismissal is actually written. */
async function productionDismissalPorts(): Promise<DismissalPorts> {
  const [{ agentRegistry }, { loadTasksByIds }, { getPipeline, setPipelineDismissal }, { loadPipelinesForList }, { resolveBridgeAsks }] = await Promise.all([
    import("@/lib/agent/registry"),
    import("@/lib/tasks/store"),
    import("@/lib/pipelines/engine"),
    import("@/lib/pipelines/store"),
    import("@/lib/bridge/store"),
  ]);
  const registry = agentRegistry();
  return {
    now: () => new Date(),
    resolveConversation: (ref) => {
      const byId = ref.conversationId ? registry.conversation(ref.conversationId as `conversation_${string}`) : null;
      const conversation = byId ?? (ref.path ? registry.conversationForPath(ref.path) : null);
      if (conversation) return { conversationId: conversation.id, path: conversation.generations.at(-1)?.path ?? ref.path ?? null };
      /* A terminal session the registry never adopted is still a card: its
         path names it. */
      return ref.path ? { conversationId: null, path: ref.path } : null;
    },
    task: (taskId) => loadTasksByIds(new Set([taskId]))[0] ?? null,
    pipelines: () => loadPipelinesForList(),
    pipeline: (pipelineId) => getPipeline(pipelineId) ?? null,
    setPipelineDismissal: (pipelineId, dismiss, by, drawnMovedAt, note) => setPipelineDismissal(pipelineId, dismiss, by, undefined, drawnMovedAt, note),
    resolveReports: (seqs, resolve, by, at, project, note) => resolveBridgeAsks(seqs, { by, at, undo: !resolve, inProject: project ? (held) => canonicalOrchestratorProject(held) === project : undefined, note }),
  };
}

/** A dismissal reason is retained as one redacted line. */
export function dismissalNote(reason: unknown): string | undefined {
  if (reason === undefined) return undefined;
  if (typeof reason !== "string" || /[\r\n]/.test(reason) || reason.length > 200) throw new DismissalError("INVALID_REASON", "reason must be one line of at most 200 characters");
  return redactMonitorText(reason.trim()) || undefined;
}
