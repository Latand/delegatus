import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import type { PipelinePatchResult } from "@/lib/pipelines/engine";
import { laneMovedAt, laneMovedSince } from "@/lib/pipelines/laneMovement";
import type { Pipeline } from "@/lib/pipelines/types";
import type { LegacyImportHooks, LegacyImportOutcome } from "@/lib/state/legacyImport";
import { LegacyDocumentStore } from "@/lib/state/legacyDocumentStore";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import {
  isDismissedBy,
  type ConversationReasonKind,
  type DismissalOutcome,
  type DismissalSubject,
  type DismissalSubjectRequest,
  type DismissalTarget,
  type DismissedBy,
} from "./dismissalTypes";

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
  /** The durable conversation id, or the transcript path of a conversation
      the registry does not know. */
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

const REASON_KINDS: ReadonlySet<string> = new Set(["decision", "question", "plan", "permission", "delivery"]);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

function parseRecord(value: unknown): AttentionDismissalV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.subject !== "string" || !record.subject) return null;
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) return null;
  if (!isDismissedBy(record.by)) return null;
  return {
    subject: record.subject,
    conversationId: nullableString(record.conversationId) ? record.conversationId : null,
    path: nullableString(record.path) ? record.path : null,
    at: record.at,
    by: record.by,
    reason: typeof record.reason === "string" && REASON_KINDS.has(record.reason) ? record.reason as ConversationReasonKind : null,
    reasonId: typeof record.reasonId === "string" && record.reasonId ? record.reasonId : null,
    ...(typeof record.operationKey === "string" && record.operationKey ? { operationKey: record.operationKey } : {}),
  };
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
    if (record) file.attentionDismissal = { at: record.at, by: record.by, reasonId: record.reasonId };
    else if (file.attentionDismissal) delete file.attentionDismissal;
  }
}

/** One serialized read-modify-write. A mutation that returns no records
    changed nothing and writes nothing. Old records and the overflow go on
    every write. */
function mutate<R>(mutation: (records: AttentionDismissalV1[]) => { records?: AttentionDismissalV1[]; result: R }, now: Date): R {
  return dismissalsStore.mutate(attentionDismissalsFile(), (current) => {
    const outcome = mutation(current.records);
    if (!outcome.records) return { next: undefined, result: outcome.result };
    const floor = now.getTime() - DISMISSAL_RETENTION_MS;
    const kept = outcome.records.filter((record) => Date.parse(record.at) >= floor).slice(-DISMISSAL_CAPACITY);
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
  setPipelineDismissal(pipelineId: string, dismiss: boolean, by: DismissedBy, drawnMovedAt?: number | null): Promise<PipelinePatchResult>;
}

export interface DismissOptions {
  undo?: boolean;
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
  if (subject.kind !== "conversation") throw new DismissalError("INVALID_TARGET", "a subject is a conversation or a pipeline");
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
 * or a card no task owns) is the operator's own form: the MCP tool names a
 * conversation, a pipeline or a task and nothing narrower.
 */
export function parseDismissalTarget(value: unknown, options: { allowSubjects: boolean }): DismissalTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DismissalError("INVALID_TARGET", "target must be an object with a kind");
  const target = value as Record<string, unknown>;
  switch (target.kind) {
    case "conversation":
      return parseSubject(target);
    case "pipeline":
      return parsePipeline(target);
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
  throw new DismissalError("INVALID_TARGET", `target.kind must be ${options.allowSubjects ? "conversation, pipeline, task or subjects" : "conversation, pipeline or task"}`);
}

/** A completed lane whose automatic merge stopped (#2187 §4.6). */
function laneMergeBlocked(pipeline: Pipeline): boolean {
  return pipeline.state === "completed" && pipeline.merge?.state === "blocked";
}

/** A lane that waits on the operator right now. */
function laneAsks(pipeline: Pipeline): boolean {
  return pipeline.state === "needs_decision" || pipeline.state === "needs_review" || laneMergeBlocked(pipeline);
}

/** The operator's (or an earlier agent's) dismissal still covers what the
    lane waits on: it moved nowhere since, and a stopped merge was cleared
    after it stopped. */
function laneCleared(pipeline: Pipeline): boolean {
  if (!pipeline.dismissedAt) return false;
  const dismissed = Date.parse(pipeline.dismissedAt);
  if (laneMergeBlocked(pipeline)) return dismissed >= Date.parse(pipeline.merge!.blockedAt ?? pipeline.merge!.updatedAt);
  return laneMovedAt(pipeline) <= dismissed;
}

/** The subjects a target names. A task names the subjects its card drew when
    the caller says which, and otherwise everything on it: its assignments and
    the lanes filed under it. */
function subjectsOf(target: DismissalTarget, ports: DismissalPorts): DismissalSubjectRequest[] {
  switch (target.kind) {
    case "conversation":
      return [{ kind: "conversation", conversationId: target.conversationId, path: target.path, reasonId: target.reasonId ?? null }];
    case "pipeline":
      return [target];
    case "subjects":
      return target.subjects;
    case "task": {
      const task = ports.task(target.taskId);
      if (!task) throw new DismissalError("TASK_NOT_FOUND", `no task ${target.taskId}`, 404);
      if (target.subjects) return target.subjects;
      return [
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
          if (!held) { clear.push(answer); continue; }
          next = next.filter((record) => record.subject !== entry.subject);
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
    if (request.kind !== "pipeline" || seen.has(`pipeline:${request.pipelineId}`)) continue;
    seen.add(`pipeline:${request.pipelineId}`);
    const answer: DismissalSubject = { kind: "pipeline", pipelineId: request.pipelineId };
    const pipeline = ports.pipeline(request.pipelineId);
    if (!pipeline) {
      if (target.kind === "pipeline") throw new DismissalError("PIPELINE_NOT_FOUND", `no pipeline ${request.pipelineId}`, 404);
      continue;
    }
    const nothing = undo ? !pipeline.dismissedAt : !laneAsks(pipeline) || laneCleared(pipeline);
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
    const result = await ports.setPipelineDismissal(pipeline.id, !undo, by, drawn);
    if (!result.pipeline) throw new DismissalError("PIPELINE_REFUSED", result.error ?? "the pipeline refused the dismissal", result.status ?? 409);
    (result.moved ? changed : dismissed).push(answer);
  }

  if (!dismissed.length && !alreadyClear.length && !changed.length) {
    throw new DismissalError("NOTHING_TO_DISMISS", "the target names nothing that can need the operator");
  }
  return { dismissed, alreadyClear, changed, at, by, undo };
}

/** Production ports, loaded on first use so this module stays free of the
    engine's import graph until a dismissal is actually written. */
async function productionDismissalPorts(): Promise<DismissalPorts> {
  const [{ agentRegistry }, { loadTasks }, { getPipeline, setPipelineDismissal }, { loadPipelinesForList }] = await Promise.all([
    import("@/lib/agent/registry"),
    import("@/lib/tasks/store"),
    import("@/lib/pipelines/engine"),
    import("@/lib/pipelines/store"),
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
    task: (taskId) => loadTasks().find((task) => task.id === taskId) ?? null,
    pipelines: () => loadPipelinesForList(),
    pipeline: (pipelineId) => getPipeline(pipelineId) ?? null,
    setPipelineDismissal: (pipelineId, dismiss, by, drawnMovedAt) => setPipelineDismissal(pipelineId, dismiss, by, undefined, drawnMovedAt),
  };
}
