import { taskAccountingSchema, retainAccountingHold } from "./accounting";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { retainProactiveScope, validProactiveProvenance } from "./proactiveScope";
import { waitForStateLock } from "@/lib/state/lockWait";
import fs from "node:fs";
import { readFindingKey, reconcileOpenFindings, validStoredFinding } from "./finding";
import path from "node:path";
import { createHash } from "node:crypto";

import { isTaskNote } from "./note";
import { lazyTaskMutationView, type TaskMutationView } from "./mutationView";
import { TaskAdmissionEvidence } from "./admissionEvidence";
import { taskShowsOnBoard } from "./boardVisibility";
import { isTaskSummary } from "./summary";
import { isTaskProgress } from "./progress";
import { storedDueHistory } from "./helpers";

import { statePath } from "@/lib/configDir";
import { deepFreeze } from "@/lib/deepFreeze";
import { canonicalProject, projectAliasResolver, projectAliasSnapshot, withProjectAliasSnapshot } from "@/lib/projects/aliases";
import { canonicalProjectKeys, replaceProjectKeySource } from "@/lib/projects/projectKeyIndex";
import { FileTransactionBusyError, withFileTransactionAttempt } from "@/lib/state/fileTransaction";
import { assertNotOperatorStateUnderTest, assertStateStartupMutation, mayRunStateStartupMutation } from "@/lib/stateOwnership";
import { assertOperationLease, awaitLeasedOperation } from "@/lib/operationLease";
import { backupDatabase, BACKUP_DIRECTORY, stateDatabases } from "@/lib/state/durability";
import { databaseFileIdentity } from "@/lib/state/currentDatabase";
import { writeJsonDurably } from "@/lib/state/durableJson";
import {
  importLegacyCollection,
  lazyReconcileAllowed,
  legacyBaselineRevision,
  legacyDatabasePath,
  legacyImportAllowed,
  writeLegacyRollbackMirror,
  type LegacyCollectionSpec,
  type LegacyImportHooks,
  type LegacyImportOutcome,
  type LegacyReconcileSummary,
} from "@/lib/state/legacyImport";
import { readStateImport, SqliteStateCollection, type StateImportRecord, type StateImportRow, type OverdueTaskCursor } from "@/lib/state/sqliteStateStore";

import { TASK_SYNC_GROUPS } from "./types";
import { derivedStamp } from "@/lib/links/stamp";
import { linkedContext, runsHere } from "@/lib/links/linked";
import { groupDigest, snapshotGroups, stampLinkedRows, type GroupSnapshot, type TaskSyncWrite } from "@/lib/links/taskStamp";
import { tombstoneCollection, tombstoneRowKey, type TombstoneRow } from "@/lib/links/tombstones";

import { snapshotTasks, stampTaskRevisions, taskFingerprint, taskRevision } from "./revision";
import { storedTaskHold } from "./hold";
import { storedTaskSteps } from "./steps";
import { isTaskAttachment } from "./attachments";
import { withTaskCompletion } from "./completion";
import type { RecentCreate } from "./commands";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";
import type { AssignmentState, BoardTask, TaskAssignment, TaskBoardVisibility, TaskPlacement, TaskSource, TaskStatus, TaskStatusBy, TaskOrigin } from "./types";

export const TASKS_FILE = statePath("tasks.json");

// Keep untouched legacy rows exactly as stored, including extension fields and
// omitted placement/revision. Response coercion must not migrate other rows.
const taskRowOwner = globalThis as typeof globalThis & { __delegatusTaskPersistedRowsV1?: WeakMap<BoardTask, unknown> };
const persistedRows = taskRowOwner.__delegatusTaskPersistedRowsV1 ??= new WeakMap<BoardTask, unknown>();
/** For a draft array, the baseline task of a slot its callback never read. */
const unreadDrafts = new WeakMap<BoardTask[], (index: number) => BoardTask | undefined>();

const sameStoredCompletion = (stored: BoardTask, task: BoardTask) =>
  stored.doneAt === task.doneAt && JSON.stringify(stored.doneAdmissions) === JSON.stringify(task.doneAdmissions)
  && stored.findingKey === task.findingKey && JSON.stringify(stored.finding) === JSON.stringify(task.finding);

/** The stored row a never-read draft commits as, when every step below would
    leave it alone. Anything else returns undefined and takes the full path. A
    write cloned and normalized every task on the board to change one (#3809). */
function settledRow(pristine: BoardTask, before: ReturnType<typeof snapshotTasks>, canonical: (project: string) => string): unknown {
  const stored = persistedRows.get(pristine) as BoardTask | undefined;
  if (!stored || before.get(pristine.id)?.pristine !== pristine) return undefined;
  if (canonical(pristine.project) !== pristine.project) return undefined;
  if (stored.proactive !== undefined || pristine.proactive !== undefined) return undefined;
  if (withTaskCompletion(pristine, pristine) !== pristine) return undefined;
  return sameStoredCompletion(stored, pristine) ? stored : undefined;
}

function committedRows(drafts: BoardTask[], before: ReturnType<typeof snapshotTasks>, replacements: boolean, sync?: { write: TaskSyncWrite; groups: ReadonlyMap<string, GroupSnapshot> }): unknown[] {
  const canonical = projectAliasResolver();
  const unread = sync ? undefined : unreadDrafts.get(drafts);
  const settled = new Map<number, unknown>();
  const settledIds = new Set<string>();
  if (unread) for (let index = 0; index < drafts.length; index++) {
    const pristine = unread(index);
    const row = pristine && settledRow(pristine, before, canonical);
    if (row === undefined) continue;
    settled.set(index, row);
    settledIds.add(pristine!.id);
  }
  const tasks: BoardTask[] = [];
  if (settled.size) { for (let index = 0; index < drafts.length; index++) if (!settled.has(index)) tasks.push(drafts[index]!); }
  else for (const task of drafts) tasks.push(task);
  for (const task of tasks) {
    task.project = canonical(task.project);
    const prior = before.get(task.id);
    retainProactiveScope(task, prior ? (persistedRows.get(prior.ref) as BoardTask | undefined) ?? prior.ref : undefined);
    retainAccountingHold(task);
    const completed = withTaskCompletion(task, prior ? { ...task, status: prior.status } : task);
    Object.assign(task, completed);
    /* A writer that moved the task without naming itself leaves the earlier
       writer's record behind; it goes, so the move is nobody's. */
    if (prior && prior.status !== task.status && JSON.stringify(task.statusBy ?? null) === prior.statusBy) delete task.statusBy;
    if (task.status !== "done") {
      delete task.doneAt;
      delete task.doneAdmissions;
    }
  }
  /* A lazy legacy backfill is a real row change and gets a new fence. */
  for (const [id, prior] of before) {
    if (settledIds.has(id)) continue;
    const stored = persistedRows.get(prior.ref) as BoardTask | undefined;
    if (stored && !sameStoredCompletion(stored, prior.ref)) {
      before.set(id, { ...prior, fingerprint: taskFingerprint(stored), pristine: undefined });
    }
  }
  if (sync) stampLinkedRows(tasks, sync.groups, sync.write, taskFingerprint);
  stampTaskRevisions(tasks, before, replacements);
  const rows = tasks.map(task => {
    const prior = before.get(task.id);
    const stored = prior ? persistedRows.get(prior.ref) as BoardTask | undefined : undefined;
    return prior && taskRevision(task) === prior.revision && stored && sameStoredCompletion(stored, task)
      ? persistedRows.get(prior.ref) : task;
  });
  if (!settled.size) return rows;
  // Index access only: iterating the draft array would read every slot.
  const merged: unknown[] = new Array(drafts.length);
  for (let index = 0, next = 0; index < drafts.length; index++) merged[index] = settled.has(index) ? settled.get(index) : rows[next++];
  return merged;
}

type TasksFile = { tasks?: unknown; recentCreates?: unknown; migrations?: unknown };

/** One-time state transitions already applied to this file, by name → ISO
    instant. A name present here is never re-applied, so a migration that the
    operator has since reversed by hand stays reversed. */
export type TaskMigrations = Record<string, string>;

/** The whole persisted state: the task list plus the create-idempotency map. */
export interface TasksFileState {
  tasks: BoardTask[];
  recentCreates: RecentCreate[];
  /** Always present on a read. A writer that omits it keeps whatever the file
      already records, so a caller that only means to change tasks can never
      erase a migration marker and cause a one-time transition to run twice. */
  migrations?: TaskMigrations;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "inbox" || value === "assigned" || value === "blocked" || value === "done";
}

function isTaskStatusBy(value: unknown): value is TaskStatusBy {
  if (!value || typeof value !== "object") return false;
  const { actor, from, at } = value as Partial<TaskStatusBy>;
  if (typeof at !== "string" || (from !== null && !isTaskStatus(from)) || !actor || typeof actor !== "object") return false;
  return actor.kind === "operator" || (actor.kind === "agent" && (actor.conversationId === null || typeof actor.conversationId === "string"));
}

function isAssignmentState(value: unknown): value is AssignmentState {
  return value === "delivered" || value === "failed" || value === "spawning" || value === "handoff" || value === "linked";
}

function isTaskOrigin(value: unknown): value is TaskOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = value as Partial<TaskOrigin>;
  return (origin.kind === "conversation" || origin.kind === "launch" || origin.kind === "pipeline" || origin.kind === "flow")
    && typeof origin.key === "string" && origin.key.length > 0
    && (origin.refinement === "pending" || origin.refinement === "titled")
    && (origin.refinedBy === undefined || typeof origin.refinedBy === "string")
    && (origin.refinedText === undefined || typeof origin.refinedText === "string");
}

function isFinitePos(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pos = value as { x?: unknown; y?: unknown };
  return typeof pos.x === "number" && Number.isFinite(pos.x) && typeof pos.y === "number" && Number.isFinite(pos.y);
}

export function isTaskAssignment(value: unknown): value is TaskAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const assignment = value as Partial<TaskAssignment>;
  return (
    (typeof assignment.path === "string" || assignment.path === null) &&
    (assignment.launchId === undefined || typeof assignment.launchId === "string" || assignment.launchId === null) &&
    (assignment.clientAttemptId === undefined || typeof assignment.clientAttemptId === "string" || assignment.clientAttemptId === null) &&
    (assignment.conversationId === undefined || typeof assignment.conversationId === "string" || assignment.conversationId === null) &&
    (typeof assignment.panePid === "number" || assignment.panePid === null) &&
    (assignment.panePid === null || (Number.isInteger(assignment.panePid) && assignment.panePid > 0)) &&
    (assignment.statusBeforeLink === undefined || isTaskStatus(assignment.statusBeforeLink)) &&
    isAssignmentState(assignment.state) &&
    (typeof assignment.error === "string" || assignment.error === null) &&
    typeof assignment.at === "string"
  );
}

export function isTaskSource(value: unknown): value is TaskSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Partial<TaskSource>;
  return (
    typeof source.path === "string" &&
    (typeof source.ts === "string" || source.ts === null) &&
    typeof source.text === "string" &&
    typeof source.fingerprint === "string" &&
    (source.engine === "claude" || source.engine === "codex")
  );
}

function isPlacement(value: unknown): value is TaskPlacement {
  return value === "pinned" || value === "unplaced" || value === "auto";
}

function isBoardVisibility(value: unknown): value is TaskBoardVisibility {
  return value === "shown" || value === "hidden";
}

function isMigrations(value: unknown): value is TaskMigrations {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((at) => typeof at === "string");
}

/** Optional deadline is both-or-neither and both strings. */
function validDue(task: Partial<BoardTask>): boolean {
  const hasAt = task.dueAt !== undefined;
  const hasTz = task.dueTz !== undefined;
  if (!hasAt && !hasTz) return true;
  return typeof task.dueAt === "string" && typeof task.dueTz === "string";
}

function validAttachments(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isTaskAttachment));
}

/**
 * Validates a raw row and coerces it into a {@link BoardTask}, filling the
 * placement a legacy row (a `pos`, no `placement`) lacks: it loads as `pinned`.
 * A pinned row with no usable position is downgraded to `unplaced` so the board
 * never tries to render a positionless card. Returns null for unusable rows.
 */
function coerceTask(value: unknown, canonical = canonicalProject): BoardTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<BoardTask>;
  const structural =
    typeof raw.id === "string" &&
    typeof raw.project === "string" &&
    isTaskStatus(raw.status) &&
    typeof raw.text === "string" &&
    (raw.proactive === undefined || validProactiveProvenance(raw.proactive)) &&
    (raw.details === undefined || typeof raw.details === "string") &&
    (raw.placement === undefined || isPlacement(raw.placement)) &&
    (raw.pos === undefined || isFinitePos(raw.pos)) &&
    validDue(raw) &&
    validAttachments(raw.attachments) &&
    Array.isArray(raw.assignments) &&
    raw.assignments.every(isTaskAssignment) &&
    (raw.source === undefined || isTaskSource(raw.source)) &&
    (raw.origin === undefined || isTaskOrigin(raw.origin)) &&
    (raw.board === undefined || isBoardVisibility(raw.board)) &&
    typeof raw.createdAt === "string" &&
    typeof raw.updatedAt === "string";
  if (!structural) return null;

  const hasPos = isFinitePos(raw.pos);
  const steps = storedTaskSteps(raw.steps);
  const placement: TaskPlacement = isPlacement(raw.placement) ? raw.placement : hasPos ? "pinned" : "unplaced";
  const pinned = placement === "pinned" && hasPos;
  const task: BoardTask = {
    ...raw,
    id: raw.id!,
    project: canonical(raw.project!),
    status: raw.status!,
    hold: storedTaskHold(raw.hold),
    ...(steps ? { steps } : {}),
    text: raw.text!,
    ...(raw.details !== undefined ? { details: raw.details } : {}),
    placement: placement === "pinned" && !hasPos ? "unplaced" : placement,
    ...(pinned ? { pos: raw.pos } : {}),
    ...(raw.dueAt !== undefined ? { dueAt: raw.dueAt, dueTz: raw.dueTz } : {}),
    ...(raw.attachments !== undefined ? { attachments: raw.attachments } : {}),
    assignments: raw.assignments!,
    ...(raw.source !== undefined ? { source: raw.source } : {}),
    ...(raw.origin !== undefined ? { origin: raw.origin } : {}),
    ...(raw.board !== undefined ? { board: raw.board } : {}),
    createdAt: raw.createdAt!,
    updatedAt: raw.updatedAt!,
  };
  if (task.accounting !== undefined && !taskAccountingSchema.safeParse(task.accounting).success) delete task.accounting;
  if (task.findingKey !== undefined) {
    const key = readFindingKey(task.findingKey);
    if (!key.ok || key.key === undefined) delete task.findingKey;
  }
  if (task.findingKey === undefined || !validStoredFinding(task.finding)) delete task.finding;
  if (task.note !== undefined && !isTaskNote(task.note)) delete task.note;
  if (task.summary !== undefined && !isTaskSummary(task.summary)) delete task.summary;
  if (task.progress !== undefined && !isTaskProgress(task.progress)) delete task.progress;
  if (task.statusBy !== undefined && !isTaskStatusBy(task.statusBy)) delete task.statusBy;
  // A rejected checklist must not survive the raw extension spread above.
  if (!steps) delete task.steps;
  const dueHistory = task.dueAt ? storedDueHistory(raw.dueHistory) : undefined;
  if (dueHistory) task.dueHistory = dueHistory;
  else delete task.dueHistory;
  if (!pinned) delete task.pos;
  /* An icon is a name or nothing; a row carrying anything else loads without one. */
  if (task.icon !== undefined && typeof task.icon !== "string") delete task.icon;
  /* Normal is never stored; a row carrying it, or anything that is no
     priority, loads as normal. */
  if (task.priority !== undefined && task.priority !== "high" && task.priority !== "low") delete task.priority;
  try { Object.assign(task, { revision: taskRevision(task) }); } catch { return null; }
  return withTaskCompletion(task);
}

export function isTask(value: unknown): value is BoardTask {
  return coerceTask(value) !== null;
}

function isRecentCreate(value: unknown): value is RecentCreate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<RecentCreate>;
  return typeof entry.clientRequestId === "string" && typeof entry.taskId === "string";
}

export function loadTasks(filePath = TASKS_FILE): BoardTask[] {
  const tasks = loadTasksFile(filePath).tasks;
  replaceProjectKeySource(`tasks:${filePath}`, canonicalProjectKeys(tasks.map(task => task.project)));
  return tasks;
}

/* ---- SQLite storage (#1870) -------------------------------------------------
   The whole task state is one `tasks` collection in the `state.sqlite` beside
   `filePath`. Each row is stored exactly as the legacy file held it:
   `t:<id>` a task row, `r:<clientRequestId>` a create receipt, `m:<name>` a
   one-time migration marker. `tasks.json` itself is imported once and then
   replaced by a tombstone directory (src/lib/state/legacyImport.ts). */

const TASK_COLLECTION = "tasks";
const TASK_BUSY = "task state is busy";
type TaskStateRow = Record<string, unknown>;
type MigrationRow = { name: string; appliedAt: string };

function isPlainRow(value: unknown): value is TaskStateRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function taskRowKey(row: TaskStateRow): string {
  if (typeof row.status === "string" && typeof row.id === "string") return row.id ? `t:${row.id}` : "";
  if (typeof row.clientRequestId === "string" && typeof row.taskId === "string") return row.clientRequestId ? `r:${row.clientRequestId}` : "";
  if (typeof row.name === "string" && typeof row.appliedAt === "string") return row.name ? `m:${row.name}` : "";
  return "";
}

/** One receipt per `clientRequestId`, the last one written. A create retried
    after its task was deleted appended a second receipt before #1870, and the
    last is the task that create made. Order follows each survivor's position. */
function uniqueReceipts(recentCreates: RecentCreate[]): RecentCreate[] {
  const last = new Map<string, number>();
  recentCreates.forEach((entry, index) => last.set(entry.clientRequestId, index));
  return last.size === recentCreates.length ? recentCreates : recentCreates.filter((entry, index) => last.get(entry.clientRequestId) === index);
}

function stateRows(tasksRows: unknown[], recentCreates: RecentCreate[], migrations: TaskMigrations): TaskStateRow[] {
  return [
    ...tasksRows as TaskStateRow[],
    ...uniqueReceipts(recentCreates).map((entry) => ({ ...entry }) as TaskStateRow),
    ...Object.entries(migrations).map(([name, appliedAt]) => ({ name, appliedAt }) satisfies MigrationRow as TaskStateRow),
  ];
}

/** Validate a legacy-shaped body into the state a load returns. */
function stateFromBody(raw: TasksFile | undefined): TasksFileState {
  if (raw === undefined) return { tasks: [], recentCreates: [], migrations: {} };
  if (!raw || !Array.isArray(raw.tasks)) throw new Error("invalid persisted task state");
  const canonical = projectAliasResolver();
  const decoded = raw.tasks.map(value => {
    const task = coerceTask(value, canonical);
    if (!task) throw new Error("invalid persisted task row");
    persistedRows.set(task, value);
    return task;
  });
  const tasks = reconcileOpenFindings(decoded);
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    if (task === decoded[i]) continue;
    persistedRows.set(task, raw.tasks[i]);
    Object.assign(task, { revision: `task-legacy:${taskFingerprint(task)}` });
  }
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("duplicate persisted task id");
  if (raw.recentCreates !== undefined && (!Array.isArray(raw.recentCreates) || !raw.recentCreates.every(isRecentCreate))) {
    throw new Error("invalid persisted task receipts");
  }
  const recentCreates = uniqueReceipts((raw.recentCreates ?? []) as RecentCreate[]);
  if (raw.migrations !== undefined && !isMigrations(raw.migrations)) throw new Error("invalid persisted task migrations");
  return { tasks, recentCreates, migrations: { ...((raw.migrations ?? {}) as TaskMigrations) } };
}

function bodyFromRows(rows: readonly TaskStateRow[]): TasksFile {
  const tasks: unknown[] = [];
  const recentCreates: unknown[] = [];
  const migrations: Record<string, unknown> = {};
  for (const row of rows) {
    const key = taskRowKey(row);
    if (key.startsWith("t:")) tasks.push(row);
    else if (key.startsWith("r:")) recentCreates.push(row);
    else if (key.startsWith("m:")) migrations[row.name as string] = row.appliedAt;
    else throw new Error("invalid persisted task row");
  }
  return { tasks, recentCreates, migrations };
}

const taskCollections = new Map<string, SqliteStateCollection<TaskStateRow>>();

function openTaskCollection(database: string): SqliteStateCollection<TaskStateRow> {
  const held = taskCollections.get(database);
  if (held) return held;
  const collection = new SqliteStateCollection<TaskStateRow>(database, {
    readCacheKey: "task-v1",
    collection: TASK_COLLECTION,
    schemaVersion: 1,
    busyMessage: TASK_BUSY,
    key: taskRowKey,
    decode: (value) => isPlainRow(value) ? value : null,
    clone: (row) => structuredClone(row),
    controllerActive: (row) => row.status !== "done",
    strictDecode: true,
    decodeError: (error) => new Error("invalid persisted task row", { cause: error }),
  });
  taskCollections.set(database, collection);
  return collection;
}

/* A rollback mirror names the SQLite revision it was written from in this
   migration marker. Older releases carry `migrations` through every write, so
   a file that still holds the marker of the recorded mirror descends from it
   and its missing rows are deletions. A file without it (an old writer that
   found the path empty while an import or a mirror was mid-retire) proves
   nothing about the rows it lacks. The marker never becomes a SQLite row. */
const MIRROR_MARKER = "sqlite-mirror-revision";

type LegacyTasksBody = TasksFile & { mirrorOf: number | null };

function parseLegacyBody(raw: unknown): LegacyTasksBody {
  const body = raw as TasksFile;
  stateFromBody(body);
  if (!body.migrations || !Object.hasOwn(body.migrations as object, MIRROR_MARKER)) return { ...body, mirrorOf: null };
  const { [MIRROR_MARKER]: marker, ...migrations } = body.migrations as TaskMigrations;
  const mirrorOf = /^\d+$/.test(marker!) ? Number(marker) : null;
  return { ...body, migrations, mirrorOf };
}

/** Only atomic admission creates invention provenance: a mirror row cannot add
    it to a task that never carried it. */
function withoutAddedProvenance(row: TaskStateRow, held: TaskStateRow | undefined): TaskStateRow {
  if (!taskRowKey(row).startsWith("t:") || row.proactive === undefined || held?.proactive !== undefined) return row;
  const rest = { ...row };
  delete rest.proactive;
  return rest;
}

/** Merge a `tasks.json` that changed after the import (a rollback release wrote
    it, or an older writer raced a fence). Who changed a row is read from row
    revisions: a SQLite row not rewritten since `baseline` is the one the file
    was written from, so the file's version wins, and its absence from the file
    deletes it. A row SQLite rewrote since then stays unless the file holds a
    task strictly newer by `updatedAt`; either way it is listed as a conflict.
    A row only the file holds is added. Receipts and migration markers are
    unioned: one the file lacks is never deleted, since a replay or a one-time
    transition must not run twice. A file that does not carry the recorded
    mirror's marker deletes nothing: its missing rows are listed as spared. */
function mergeLegacyTasks(filePath: string, body: LegacyTasksBody, baseline: StateImportRecord, options: { fenceOwner: boolean; consumedSha256?: string }): LegacyReconcileSummary {
  const collection = openTaskCollection(legacyDatabasePath(filePath));
  const since = legacyBaselineRevision(baseline);
  const consumedSha256 = options.consumedSha256;
  const descends = baseline.mirrorRevision !== null && body.mirrorOf === baseline.mirrorRevision;
  const summary: LegacyReconcileSummary = { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
  collection.patchSync(() => {
    const current = new Map(collection.snapshot().map((row) => [taskRowKey(row), row] as const));
    const revisions = collection.rowRevisions();
    const incoming = stateRows(body.tasks as unknown[], (body.recentCreates ?? []) as RecentCreate[], (body.migrations ?? {}) as TaskMigrations);
    const incomingKeys = new Set(incoming.map(taskRowKey));
    const records: TaskStateRow[] = [];
    for (const row of incoming) {
      const key = taskRowKey(row);
      const held = current.get(key);
      if (!held) {
        records.push(withoutAddedProvenance(row, undefined));
        summary.added += 1;
        summary.keys.push(key);
        continue;
      }
      if (JSON.stringify(held) === JSON.stringify(row)) continue;
      if ((revisions.get(key) ?? 0) > since) {
        summary.conflicts.push(key);
        const legacyTask = key.startsWith("t:") ? coerceTask(row) : null;
        const heldTask = key.startsWith("t:") ? coerceTask(held) : null;
        if (!legacyTask || !heldTask || legacyTask.updatedAt <= heldTask.updatedAt) {
          summary.kept += 1;
          continue;
        }
      }
      const incomingTask = key.startsWith("t:") ? coerceTask(row) : null;
      const previousTask = key.startsWith("t:") ? coerceTask(held) : null;
      if (incomingTask && previousTask?.proactive) {
        retainProactiveScope(incomingTask, previousTask);
        records.push(incomingTask as unknown as TaskStateRow);
      } else {
        records.push(withoutAddedProvenance(row, held));
      }
      summary.replaced += 1;
      summary.keys.push(key);
    }
    const deleteKeys: string[] = [];
    for (const key of current.keys()) {
      if (incomingKeys.has(key) || !key.startsWith("t:")) continue;
      if (!descends) {
        summary.spared.push(key);
        continue;
      }
      if ((revisions.get(key) ?? 0) > since) {
        summary.conflicts.push(key);
        summary.kept += 1;
        continue;
      }
      deleteKeys.push(key);
      summary.removed += 1;
      summary.keys.push(key);
    }
    return { records, deleteKeys };
  }, {
    fenceOwner: options.fenceOwner,
    ...(consumedSha256 ? { afterPersist: (db) => {
      const result = db.query("UPDATE state_imports SET reconciled_sha256 = ? WHERE collection = ?")
        .run(consumedSha256, TASK_COLLECTION);
      if (result.changes !== 1) throw new Error("missing import evidence for tasks reconciliation");
    } } : {}),
  });
  return summary;
}

/** The task store's legacy import spec, for the import driver and its tests. */
export function taskLegacyCollection(filePath = TASKS_FILE): LegacyCollectionSpec<LegacyTasksBody> {
  return {
    collection: TASK_COLLECTION,
    schemaVersion: 1,
    migrationId: "tasks-json-v1",
    legacyPath: filePath,
    parse: parseLegacyBody,
    toRows: (body): StateImportRow[] => stateRows(
      body.tasks as unknown[],
      (body.recentCreates ?? []) as RecentCreate[],
      (body.migrations ?? {}) as TaskMigrations,
    ).map((row) => ({ key: taskRowKey(row), value: row, controllerActive: row.status !== "done" })),
    repairs: (body) => {
      const receipts = (body.recentCreates ?? []) as RecentCreate[];
      const dropped = receipts.length - uniqueReceipts(receipts).length;
      return dropped ? `dropped ${dropped} older duplicate create receipt${dropped === 1 ? "" : "s"}, keeping the newest per clientRequestId` : null;
    },
    reconcile: (body, baseline, options) => mergeLegacyTasks(filePath, body, baseline, options),
    mirrorBody: () => {
      const collection = openTaskCollection(legacyDatabasePath(filePath));
      let mirror: { body: unknown; revision: number } | null = null;
      collection.checkpointMirror((rows, revision) => {
        const body = bodyFromRows(rows);
        const migrations = { ...(body.migrations as TaskMigrations), [MIRROR_MARKER]: String(revision) };
        mirror = { body: fileBody(body.tasks as unknown[], body.recentCreates as RecentCreate[], migrations), revision };
      });
      return mirror!;
    },
  };
}

/** Import `tasks.json` into SQLite now. The Viewer's activation calls this with
    `reconcile: true`; tests drive the crash seams through `hooks`. */
export function importLegacyTasks(
  filePath = TASKS_FILE,
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return importLegacyCollection(taskLegacyCollection(filePath), options);
}

/** Write `tasks.json` from SQLite for a rollback release that predates #1870. */
export function checkpointTaskRollbackMirrorForDemotion(filePath = TASKS_FILE): void {
  writeLegacyRollbackMirror(taskLegacyCollection(filePath));
}

/** The collection for `filePath`, importing the legacy file on first use. Null
    only for a read before the import may run (an unpromoted release): the read
    then parses the legacy file without writing anything. */
function taskCollection(filePath: string, purpose: "read" | "write"): SqliteStateCollection<TaskStateRow> | null {
  /* A test run never reads or writes the operator's task store. */
  assertNotOperatorStateUnderTest(path.dirname(path.resolve(filePath)), "task store");
  const database = legacyDatabasePath(filePath);
  if (taskCollections.has(database)) return taskCollections.get(database)!;
  if (!readStateImport(database, TASK_COLLECTION)) {
    if (!legacyImportAllowed(filePath)) {
      if (purpose === "read") return null;
      throw new FileTransactionBusyError("task state is waiting for release promotion");
    }
    importLegacyTasks(filePath, { reconcile: lazyReconcileAllowed(filePath) });
  }
  return openTaskCollection(database);
}

function readLegacyTasksFile(filePath: string): TasksFileState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = undefined;
    else throw error;
  }
  return stateFromBody(raw as TasksFile | undefined);
}

/** Read without writes; malformed existing state refuses instead of dropping rows. */
export function loadTasksFile(filePath = TASKS_FILE): TasksFileState {
  const collection = taskCollection(filePath, "read");
  if (!collection) return readLegacyTasksFile(filePath);
  const committed = collection.loadReadonly();
  const aliases = JSON.stringify(projectAliasSnapshot().aliases);
  let baseline = writeSnapshots.get(committed);
  if (baseline?.aliases !== aliases) {
    baseline = { aliases, state: deepFreeze(stateFromBody(bodyFromRows(committed))) };
    writeSnapshots.set(committed, baseline);
  }
  return structuredClone(baseline.state);
}

/** The tick reads only overdue payloads, independently of the board snapshot. */
export type OverdueBoardTask = BoardTask & { overdueSweep?: string };
export function overdueTasks(project: string, nowMs: number, filePath = TASKS_FILE, shown: readonly string[] = [], cursor: OverdueTaskCursor | null = null, known: readonly string[] = shown): OverdueBoardTask[] {
  const collection = taskCollection(filePath, "read");
  if (!collection) throw new Error("overdue task selection requires the SQLite task store");
  const canonical = canonicalProject(project);
  const projects = [canonical, ...Object.keys(projectAliasSnapshot().aliases).filter(alias => canonicalProject(alias) === canonical)];
  const context = linkedContext();
  return collection.overdueTaskRows(projects, nowMs, 51, context.self?.id ?? null, shown, cursor, known)
    .flatMap(selection => {
      const row = collection.get(selection.row_key);
      const task = row ? coerceTask(row) : null;
      return task && canonicalProject(task.project) === canonical && task.status !== "done" && runsHere(task, context)
        && task.dueAt && Date.parse(task.dueAt) <= nowMs
        && !(task.hold?.until && Date.parse(task.hold.until) > nowMs) ? [{ ...task, ...(selection.advance ? { overdueSweep: Buffer.from(JSON.stringify([selection.priority, selection.eligible_at, selection.row_key])).toString("base64url") } : {}) }] : [];
    });
}

/** Prepare the bounded MCP selection reader without loading the collection. */
export function taskSelectionSource(filePath = TASKS_FILE) {
  const collection = taskCollection(filePath, "read");
  if (!collection) return null;
  const select = (ids: ReadonlySet<string>, limit: number): BoardTask[] => {
    const ordered = collection.keysInOrder([...ids].map(id => `t:${id}`), limit).map(key => key.slice(2));
    const tasks = new Map<string, BoardTask>();
    for (const id of ordered) {
      const task = collection.get(`t:${id}`);
      if (task) {
        const decoded = coerceTask(task);
        if (decoded) tasks.set(id, decoded);
      }
    }

    const aliases = projectAliasSnapshot().aliases;
    for (const task of tasks.values()) {
      if (task.status === "done" || task.findingKey === undefined) continue;
      const projects = [task.project, ...Object.keys(aliases).filter(alias => canonicalProject(alias) === task.project)];
      for (const project of new Set(projects)) {
        for (const key of collection.findingTaskKeys(project, task.findingKey)) {
          if (tasks.has(key.slice(2))) continue;
          const related = collection.get(key);
          if (!related) continue;
          const decoded = coerceTask(related);
          if (decoded) tasks.set(decoded.id, decoded);
        }
      }
    }

    const projected = reconcileOpenFindings([...tasks.values()]);
    const byId = new Map(projected.map(task => {
      if (tasks.get(task.id) !== task) Object.assign(task, { revision: `task-legacy:${taskFingerprint(task)}` });
      return [task.id, task] as const;
    }));
    return ordered.flatMap(id => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
  };
  return {
    filename: legacyDatabasePath(filePath),
    orderedIds: (ids: ReadonlySet<string>, limit: number) => collection.keysInOrder([...ids].map(id => `t:${id}`), limit).map(key => key.slice(2)),
    read: (id: string) => select(new Set([id]), 1)[0] ?? null,
    select,
  };
}

/** Read only the requested tasks, retaining collection order and the keyed
 * reader's ownership projection. The index seeks precede payload decoding;
 * ordinary keyed reads never decode unrelated history. Converged finding
 * ownership retains taskSelectionSource's existing reconciliation. */
export function loadTasksByIds(ids: ReadonlySet<string>, filePath = TASKS_FILE, limit = ids.size): BoardTask[] {
  if (!ids.size || limit <= 0) return [];
  const source = taskSelectionSource(filePath);
  if (!source) return loadTasksForList(filePath).filter(task => ids.has(task.id)).slice(0, limit);
  return source.select(ids, limit);
}

type TaskListSnapshot = { aliases: string; tasks: readonly BoardTask[]; projects: ReadonlySet<string>;
  byProject?: ReadonlyMap<string, readonly BoardTask[]> };
const taskListOwner = globalThis as typeof globalThis & { __delegatusTaskListReaders?: {
  rows: WeakMap<object, { aliases: string; task: BoardTask }>;
  snapshots: WeakMap<object, TaskListSnapshot>;
}; __delegatusTaskListLatestV1?: Map<string, { identity: string | null; revision: number; snapshot: WeakRef<TaskListSnapshot> }> };
// Raw collections have one bounded shared owner; weak keys give the derived
// task views the same lifetime across separately compiled route bundles.
const taskListReaders = taskListOwner.__delegatusTaskListReaders ??= { rows: new WeakMap(), snapshots: new WeakMap() };
const listRows = taskListReaders.rows;
const listSnapshots = taskListReaders.snapshots;
// Weak references add no retained payload beyond the existing read cache.
const latestListSnapshots = taskListOwner.__delegatusTaskListLatestV1 ??= new Map();
function rememberTaskList(collection: SqliteStateCollection<TaskStateRow>, snapshot: TaskListSnapshot, identity: string | null, revision: number): void {
  const previous = latestListSnapshots.get(collection.filename);
  if (previous?.identity === identity && previous.revision === revision && previous.snapshot.deref() === snapshot) return;
  const current = () => databaseFileIdentity(collection.filename) === identity && collection.revision() === revision
    && JSON.stringify(projectAliasSnapshot().aliases) === snapshot.aliases;
  if (!current()) return;
  latestListSnapshots.delete(collection.filename);
  latestListSnapshots.set(collection.filename, { identity, revision, snapshot: new WeakRef(snapshot) });
  while (latestListSnapshots.size > 8) latestListSnapshots.delete(latestListSnapshots.keys().next().value!);
  // A list reader already owns the full revision. Build its reusable command
  // projections here so the next single-row transaction never pays for them.
  const discard = () => {
    latestListSnapshots.delete(collection.filename);
    for (const cache of [mutationHistories, projectEvidence]) for (const key of cache.keys()) {
      if (JSON.parse(key)[0] === collection.filename) cache.delete(key);
    }
  };
  try {
    const canonical = projectAliasResolver(), aliases = Object.keys(projectAliasSnapshot().aliases);
    mutationHistory(collection, snapshot.aliases, canonical);
    const now = Date.now();
    for (const project of snapshot.projects) {
      const projects = [project, ...aliases.filter(alias => alias !== project && canonical(alias) === project)];
      const evidence = taskProjectEvidence(collection, projects, canonical, snapshot.aliases);
      if (!evidence.admission || now < evidence.admission.observedAt) evidence.admission = new TaskAdmissionEvidence(evidence.rows.values(), now);
    }
  } catch (error) {
    discard();
    if (current()) throw error;
  }
  if (!current()) discard();
}
/** Immutable list source. SQLite refreshes changed rows by revision; a repeated
 * list does not clone and validate every task and assignment again.
 *
 * The list, every task and everything a task holds are frozen, because they
 * are the cache every later caller reads: a reader that wrote into one would
 * have changed the next reader's tasks. Anything that changes a task goes
 * through `mutateTasks`, and anything that overlays one copies the task it
 * changes. A row the collection hands out is decoded for its cache alone and a
 * write reads its rows through clones, so freezing the nested values a task
 * shares with its row leaves no writer holding a frozen object. */
export async function loadTasksForListAsync(filePath = TASKS_FILE): Promise<readonly BoardTask[]> {
  await taskCollection(filePath, "read")?.loadReadonlyAsync();
  return loadTasksForList(filePath);
}

export function loadTasksForList(filePath = TASKS_FILE): readonly BoardTask[] {
  const collection = taskCollection(filePath, "read");
  if (!collection) {
    const tasks = deepFreeze(readLegacyTasksFile(filePath).tasks);
    replaceProjectKeySource(`tasks:${filePath}`, canonicalProjectKeys(tasks.map(task => task.project)));
    return tasks;
  }
  const identity = databaseFileIdentity(collection.filename), revision = collection.revision();
  const rows = collection.loadReadonly();
  const aliasSnapshot = projectAliasSnapshot();
  const aliases = JSON.stringify(aliasSnapshot.aliases);
  const cached = listSnapshots.get(rows);
  if (cached?.aliases === aliases) {
    rememberTaskList(collection, cached, identity, revision);
    replaceProjectKeySource(`tasks:${filePath}`, cached.projects);
    return cached.tasks;
  }
  const canonical = projectAliasResolver(aliasSnapshot);
  const tasks: BoardTask[] = [];
  for (const row of rows) {
    if (!taskRowKey(row).startsWith("t:")) continue;
    const held = listRows.get(row);
    let task = held?.aliases === aliases ? held.task : undefined;
    if (!task) {
      task = coerceTask(row, canonical) ?? undefined;
      if (!task) throw new Error("invalid persisted task row");
      persistedRows.set(task, row);
      deepFreeze(task);
      listRows.set(row, { aliases, task });
    }
    tasks.push(task);
  }
  const byProject = new Map<string, BoardTask[]>();
  const resolved = reconcileOpenFindings(tasks).map((task, index) => {
    if (task !== tasks[index]) persistedRows.set(task, persistedRows.get(tasks[index]!));
    if (!Object.isFrozen(task)) Object.assign(task, { revision: `task-legacy:${taskFingerprint(task)}` });
    const project = byProject.get(task.project);
    if (project) project.push(task); else byProject.set(task.project, [task]);
    return deepFreeze(task);
  });
  Object.freeze(resolved);
  const projects = canonicalProjectKeys(resolved.map(task => task.project));
  const snapshot = { aliases, tasks: resolved, projects, byProject };
  listSnapshots.set(rows, snapshot);
  rememberTaskList(collection, snapshot, identity, revision);
  replaceProjectKeySource(`tasks:${filePath}`, projects);
  return resolved;
}

/** The persisted body: optional sections stay omitted while empty so an
    untouched legacy file keeps its exact shape. */
function fileBody(rows: unknown[], recentCreates: RecentCreate[], migrations: TaskMigrations = {}): unknown {
  return {
    tasks: rows,
    ...(recentCreates.length ? { recentCreates } : {}),
    ...(Object.keys(migrations).length ? { migrations } : {}),
  };
}

/** The linked-boards side of one task write: which projects are linked, and
    the `task_tombstones` rows this commit writes beside the tasks. Null when
    nothing is linked, which is every install that never paired. */
function taskSyncWrite(filePath: string): { write: TaskSyncWrite; companion: NonNullable<ReturnType<typeof tombstoneCollection>>; pending: () => { records: TombstoneRow[]; deleteKeys: string[] } } | null {
  const context = linkedContext();
  if (!context.self || context.all.size === 0) return null;
  const companion = tombstoneCollection(legacyDatabasePath(filePath), true)!;
  const puts = new Map<string, TombstoneRow>();
  const removed = new Set<string>();
  const preservedStamps = new Set<string>();
  const aliases = projectAliasSnapshot().aliases;
  const write: TaskSyncWrite = {
    linked: context.all, self: context.self, now: Date.now,
    projectWatermark: project => {
      const projects = [project, ...Object.keys(aliases).filter(alias => canonicalProject(alias) === project)];
      return openTaskCollection(legacyDatabasePath(filePath)).maxTaskProjectStamp(projects, context.self!.prefix);
    },
    read: (key) => puts.get(key) ?? (removed.has(key) ? null : companion.get(key)),
    put: (row) => { const key = tombstoneRowKey(row); puts.set(key, row); removed.delete(key); },
    remove: (key) => { puts.delete(key); removed.add(key); },
    preserveStamp: (id, group) => { preservedStamps.add(`${id}:${group}`); },
    isStampPreserved: (id, group) => preservedStamps.has(`${id}:${group}`),
  };
  return { write, companion, pending: () => ({ records: [...puts.values()], deleteKeys: [...removed] }) };
}

/** One serialized read-modify-write: the prepare step reads the committed state
    under the collection lease and returns the whole next state, or undefined to
    skip the write. Only rows that changed are written; rows that disappeared
    are deleted in the same transaction. */
function writeTaskState<R>(
  filePath: string,
  prepare: (current: TasksFileState, sync: TaskSyncWrite | null, pristine: readonly BoardTask[], originalDraft: (index: number) => BoardTask) => { next: { rows: unknown[]; recentCreates: RecentCreate[]; migrations: TaskMigrations } | undefined; result: R },
  options: { afterPersist?: () => void } = {},
): R {
  const collection = taskCollection(filePath, "write")!;
  const sync = taskSyncWrite(filePath);
  let result: R;
  collection.patchSync(() => {
    const committed = collection.loadReadonly();
    const aliases = JSON.stringify(projectAliasSnapshot().aliases);
    let baseline = writeSnapshots.get(committed);
    if (baseline?.aliases !== aliases) {
      baseline = { aliases, state: deepFreeze(stateFromBody(bodyFromRows(committed))) };
      writeSnapshots.set(committed, baseline);
    }
    const draft = taskDrafts(baseline.state.tasks);
    const current = { tasks: draft.tasks, recentCreates: structuredClone(baseline.state.recentCreates), migrations: { ...baseline.state.migrations } };
    const outcome = prepare(current, sync?.write ?? null, baseline.state.tasks, draft.original);
    result = outcome.result;
    const companion = sync?.pending();
    if (!outcome.next) return { records: [], ...(companion ? { companion } : {}) };
    const records = stateRows(outcome.next.rows, outcome.next.recentCreates, outcome.next.migrations);
    const nextKeys = new Set(records.map(taskRowKey));
    const deleteKeys = committed.map(taskRowKey).filter((key) => !nextKeys.has(key));
    /* A row handed back as the very object read above is unchanged: an edit,
       in place or not, gives the task a new revision and `committedRows`
       returns the task instead. Receipts and markers are rebuilt, so they are
       compared by value. */
    const unchanged = new Set(committed);
    const byKey = new Map(committed.map((row) => [taskRowKey(row), row] as const));
    const changed = records.filter((row) => {
      if (unchanged.has(row)) return false;
      const held = byKey.get(taskRowKey(row));
      return !held || JSON.stringify(held) !== JSON.stringify(row);
    });
    /* A create that refreshes a receipt appends it as the newest; its row
       moves to the end too, so the receipt cap evicts it last after a reload. */
    const appendKeys = changed.map(taskRowKey).filter((key) => key.startsWith("r:") && byKey.has(key));
    return { records: changed, deleteKeys, appendKeys, ...(companion ? { companion } : {}) };
  }, { ...(sync ? { companion: sync.companion } : {}), afterPersist: options.afterPersist });
  return result!;
}

const writeSnapshots = new WeakMap<object, { aliases: string; state: TasksFileState }>();

/** A persistent indexed projection. A journaled patch replaces only the path
 * to its leaf; every already-issued draft keeps its original root. */
type TaskVectorNode = BoardTask | readonly [TaskVectorNode, TaskVectorNode];
class TaskHistoryVector {
  readonly tasks: BoardTask[];
  constructor(readonly length: number, readonly root: TaskVectorNode | undefined) {
    this.tasks = new Proxy<BoardTask[]>([], {
      get: (target, key) => {
        if (key === "length") return length;
        const index = typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
        return index >= 0 && index < length ? this.at(index) : Reflect.get(target, key);
      },
      has: (target, key) => typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length || Reflect.has(target, key),
    });
  }
  static from(tasks: readonly BoardTask[]): TaskHistoryVector {
    const build = (start: number, end: number): TaskVectorNode => end - start === 1 ? tasks[start]!
      : [build(start, (start + end) >>> 1), build((start + end) >>> 1, end)];
    return new TaskHistoryVector(tasks.length, tasks.length ? build(0, tasks.length) : undefined);
  }
  at(index: number): BoardTask {
    let node = this.root!, start = 0, end = this.length;
    while (end - start > 1) {
      const middle = (start + end) >>> 1, pair = node as readonly [TaskVectorNode, TaskVectorNode];
      if (index < middle) { node = pair[0]; end = middle; }
      else { node = pair[1]; start = middle; }
    }
    return node as BoardTask;
  }
  replace(index: number, task: BoardTask): TaskHistoryVector {
    const put = (node: TaskVectorNode, start: number, end: number): TaskVectorNode => {
      if (end - start === 1) return task;
      const middle = (start + end) >>> 1, pair = node as readonly [TaskVectorNode, TaskVectorNode];
      return index < middle ? [put(pair[0], start, middle), pair[1]] : [pair[0], put(pair[1], middle, end)];
    };
    return new TaskHistoryVector(this.length, put(this.root!, 0, this.length));
  }
}

type MutationHistory = { revision: number; rows: Map<string, BoardTask>; vector: TaskHistoryVector; indices: Map<string, number>; orders: Map<string, number>; sizes: Map<string, number>; bytes: number };
const mutationHistoryOwner = globalThis as typeof globalThis & { __delegatusTaskMutationHistoriesV2?: Map<string, MutationHistory> };
const mutationHistories = mutationHistoryOwner.__delegatusTaskMutationHistoriesV2 ??= new Map<string, MutationHistory>();

/** Array readers reuse immutable rows and refresh only journal entries. The
 * bounded owner holds references to reader payloads, never mutable drafts. */
function mutationHistory(collection: SqliteStateCollection<TaskStateRow>, aliases: string, canonical: (project: string) => string): MutationHistory {
  const key = JSON.stringify([collection.filename, databaseFileIdentity(collection.filename), aliases]);
  const revision = collection.revision();
  let held = mutationHistories.get(key);
  const fill = (): MutationHistory => {
    const latest = latestListSnapshots.get(collection.filename);
    const list = latest?.identity === databaseFileIdentity(collection.filename) && latest.revision === revision ? latest.snapshot.deref() : undefined;
    let tasks: BoardTask[];
    if (list?.aliases === aliases) tasks = list.tasks.slice();
    else {
      const committed = collection.loadReadonly();
      let baseline = writeSnapshots.get(committed);
      if (baseline?.aliases !== aliases) {
        baseline = { aliases, state: deepFreeze(stateFromBody(bodyFromRows(committed))) };
        writeSnapshots.set(committed, baseline);
      }
      tasks = baseline.state.tasks.slice();
    }
    const metadata = collection.keyMetadata(tasks.map(task => `t:${task.id}`));
    const sizes = new Map([...metadata].map(([key, value]) => [key.slice(2), value.bytes]));
    return { revision, vector: TaskHistoryVector.from(tasks), rows: new Map(tasks.map(task => [task.id, task])), indices: new Map(tasks.map((task, index) => [task.id, index])),
      orders: new Map([...metadata].map(([key, value]) => [key, value.order])), sizes, bytes: [...sizes.values()].reduce((sum, size) => sum + size, 0) };
  };
  if (!held || held.revision > revision) held = fill();
  if (held.revision !== revision) {
    // Already returned array views keep their revision while this reader
    // installs the journal's next immutable row references once.
    let from = held.revision, cursor = "", reordered = false;
    const findings = new Map<string, { project: string; key: string }>();
    const rememberFinding = (task: BoardTask | undefined) => {
      const raw = task && (persistedRows.get(task) as BoardTask | undefined) || task;
      if (raw && raw.status !== "done" && raw.findingKey !== undefined) {
        const project = canonical(raw.project), key = raw.findingKey;
        findings.set(JSON.stringify([project, key]), { project, key });
      }
    };
    for (;;) {
      const page = collection.changesAfter(from, cursor, 512);
      if (page.changeFloor > held.revision) { held = fill(); break; }
      const metadata = collection.keyMetadata(page.entries.filter(entry => entry.key.startsWith("t:")).map(entry => entry.key));
      for (const entry of page.entries) {
        if (!entry.key.startsWith("t:")) continue;
        const id = entry.key.slice(2), index = held.indices.get(id);
        rememberFinding(held.rows.get(id));
        const raw = entry.valueJson ? JSON.parse(entry.valueJson) as TaskStateRow : null;
        const task = raw ? coerceTask(raw, canonical) : null;
        if (raw && !task) throw new Error("invalid persisted task row");
        if (task) {
          persistedRows.set(task, raw); deepFreeze(task); held.rows.set(id, task);
          rememberFinding(task);
          if (index !== undefined) held.vector = held.vector.replace(index, task);
        } else held.rows.delete(id);
        held.bytes -= held.sizes.get(id) ?? 0;
        const size = entry.valueJson?.length ? entry.valueJson.length * 2 : 0;
        held.bytes += size;
        if (task) held.sizes.set(id, size); else held.sizes.delete(id);
        // Compare only changed ordering metadata. Ordinary patches retain
        // both the shared array and its index without a collection-wide pass.
        if (held.orders.get(entry.key) !== metadata.get(entry.key)?.order) reordered = true;
        if (metadata.has(entry.key)) held.orders.set(entry.key, metadata.get(entry.key)!.order);
        else held.orders.delete(entry.key);
      }
      if (page.entries.length < 512) { held.revision = page.revision; break; }
      const last = page.entries.at(-1)!; from = last.revision; cursor = last.key;
    }
    // Only changed finding groups can change another row's reader projection.
    // Reload their indexed raw candidates to avoid adding a combined count twice.
    const aliasNames = Object.keys(projectAliasSnapshot().aliases);
    for (const { project, key } of findings.values()) {
      const projects = [project, ...aliasNames.filter(alias => alias !== project && canonical(alias) === project)];
      const group = projects.flatMap(project => collection.findingTaskKeys(project, key)).map(key => {
        const raw = collection.get(key)!;
        const task = coerceTask(raw, canonical);
        if (!task) throw new Error("invalid persisted task row");
        persistedRows.set(task, raw); return task;
      });
      for (const task of reconcileOpenFindings(group)) {
        if (!persistedRows.has(task)) {
          persistedRows.set(task, persistedRows.get(group.find(row => row.id === task.id)!));
          Object.assign(task, { revision: `task-legacy:${taskFingerprint(task)}` });
        }
        deepFreeze(task); held.rows.set(task.id, task);
        const index = held.indices.get(task.id);
        if (index !== undefined) held.vector = held.vector.replace(index, task);
      }
    }
    if (reordered) {
      const tasks = [...held.rows.values()].sort((a, b) => held!.orders.get(`t:${a.id}`)! - held!.orders.get(`t:${b.id}`)! || a.id.localeCompare(b.id));
      held.vector = TaskHistoryVector.from(tasks);
      held.indices = new Map(tasks.map((task, index) => [task.id, index]));
    }
  }
  mutationHistories.delete(key); mutationHistories.set(key, held);
  let bytes = [...mutationHistories.values()].reduce((sum, history) => sum + history.bytes, 0);
  while (mutationHistories.size > 2 || bytes > PROJECT_EVIDENCE_BYTES) {
    const oldest = mutationHistories.keys().next().value!;
    bytes -= mutationHistories.get(oldest)!.bytes; mutationHistories.delete(oldest);
  }
  return held;
}

/** Clone a task only when the callback reads it. Original drafts stay available
    after array replacement, sorting or deletion for revision comparison. */
function taskDrafts(pristine: readonly BoardTask[], shared?: (task: BoardTask, index: number, peek: boolean) => BoardTask | undefined) {
  const copies = new Map<number, BoardTask>();
  const nested = new Map<number, Map<string, unknown>>();
  const materialize = (index: number): BoardTask => {
    let copy = copies.get(index);
    if (!copy) {
      const source = pristine[index]!;
      copy = { ...source };
      const materialized = new Map<string, unknown>();
      nested.set(index, materialized);
      for (const [key, value] of Object.entries(source)) {
        if (!value || typeof value !== "object") continue;
        const target = copy;
        Object.defineProperty(target, key, { configurable: true, enumerable: true,
          get: () => {
            if (!materialized.has(key)) materialized.set(key, structuredClone(value));
            return materialized.get(key);
          },
          set: next => Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value: next }),
        });
      }
      persistedRows.set(copy, persistedRows.get(pristine[index]!));
      copies.set(index, copy);
    }
    return copy;
  };
  const peek = (index: number): BoardTask => shared?.(pristine[index]!, index, true) ?? copies.get(index) ?? pristine[index]!;
  const original = (index: number): BoardTask => shared?.(pristine[index]!, index, false) ?? materialize(index);
  // No per-row array slots or shallow task copies for a scalar lookup.
  const target: BoardTask[] = new Array(pristine.length);
  let inheritedLength = pristine.length;
  const deleted = new Set<number>();
  const slot = (key: PropertyKey) => typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
  const tasks = new Proxy(target, {
    get: (array, key) => {
      if (key === "find" || key === "findLast" || key === "findIndex" || key === "findLastIndex") return (predicate: (task: BoardTask, index: number, rows: BoardTask[]) => unknown, receiver?: unknown) => {
        const reverse = key === "findLast" || key === "findLastIndex";
        const length = array.length;
        for (let index = reverse ? length - 1 : 0; reverse ? index >= 0 : index < length; index += reverse ? -1 : 1) {
          const held = Object.hasOwn(array, index) ? array[index] : index < inheritedLength && !deleted.has(index) ? peek(index) : undefined;
          if (predicate.call(receiver, held!, index, tasks)) return key === "findIndex" || key === "findLastIndex" ? index : Object.hasOwn(array, index) || index >= inheritedLength || deleted.has(index) ? held : original(index);
        }
        return key === "findIndex" || key === "findLastIndex" ? -1 : undefined;
      };
      const index = slot(key);
      return index >= 0 && index < array.length && !Object.hasOwn(array, key) && index < inheritedLength && !deleted.has(index) ? original(index) : Reflect.get(array, key);
    },
    has: (array, key) => slot(key) >= 0 && slot(key) < Math.min(array.length, inheritedLength) && !deleted.has(slot(key)) || Reflect.has(array, key),
    set: (array, key, value) => {
      const result = Reflect.set(array, key, value);
      if (result && key === "length") inheritedLength = Math.min(inheritedLength, array.length);
      if (result) deleted.delete(slot(key));
      return result;
    },
    defineProperty: (array, key, descriptor) => {
      const result = Reflect.defineProperty(array, key, descriptor);
      if (result && key === "length") inheritedLength = Math.min(inheritedLength, array.length);
      if (result) deleted.delete(slot(key));
      return result;
    },
    ownKeys: array => [...new Set([...Array.from({ length: Math.min(array.length, inheritedLength) }, (_, index) => index).filter(index => !deleted.has(index)).map(String), ...Reflect.ownKeys(array)])],
    getOwnPropertyDescriptor: (array, key) => Reflect.getOwnPropertyDescriptor(array, key)
      ?? (slot(key) >= 0 && slot(key) < Math.min(array.length, inheritedLength) && !deleted.has(slot(key))
        ? { configurable: true, enumerable: true, writable: true, value: original(slot(key)) } : undefined),
    deleteProperty: (array, key) => { deleted.add(slot(key)); return Reflect.deleteProperty(array, key); },
  });
  unreadDrafts.set(tasks, index => !copies.has(index) && !Object.hasOwn(target, index) ? pristine[index] : undefined);
  const changed = (index: number, task: BoardTask) => {
    const prior = pristine[index]! as unknown as Record<string, unknown>;
    const keys = Object.keys(task);
    if (keys.length !== Object.keys(prior).length) return true;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(task, key)!;
      if (!Object.hasOwn(prior, key)) return true;
      if (descriptor.get) {
        if (nested.get(index)?.has(key) && JSON.stringify(nested.get(index)!.get(key)) !== JSON.stringify(prior[key])) return true;
      } else if (!Object.is(descriptor.value, prior[key]) && JSON.stringify(descriptor.value) !== JSON.stringify(prior[key])) return true;
    }
    return false;
  };
  return { tasks, original, peek, copies, changed };
}

const syncStep = (current: readonly BoardTask[], sync: TaskSyncWrite | null) =>
  sync ? { write: sync, groups: snapshotGroups(current, sync.linked, taskFingerprint) } : undefined;

type ProjectEvidence = { revision: number; rows: Map<string, BoardTask>; doneFindings: Map<string, Map<string, BoardTask>>; admission?: TaskAdmissionEvidence; bytes: number };
const evidenceOwner = globalThis as typeof globalThis & { __delegatusTaskProjectEvidenceV2?: Map<string, ProjectEvidence> };
const projectEvidence = evidenceOwner.__delegatusTaskProjectEvidenceV2 ??= new Map<string, ProjectEvidence>();
const PROJECT_EVIDENCE_BYTES = 64 * 1024 * 1024;

/** Admission is a reader of project history. Reuse its immutable projection;
 * later revisions decode only journaled rows. The byte bound covers all
 * projects together; a normal project rotation retains its summaries. */
function taskProjectEvidence(collection: SqliteStateCollection<TaskStateRow>, projects: readonly string[], canonical: (project: string) => string, aliases: string): ProjectEvidence {
  const identity = databaseFileIdentity(collection.filename);
  const key = JSON.stringify([collection.filename, identity, projects, aliases]);
  const revision = collection.revision();
  let evidence = projectEvidence.get(key);
  const decode = (raw: TaskStateRow) => {
    const task = coerceTask(raw, canonical);
    if (!task) throw new Error("invalid persisted task row");
    return deepFreeze(task);
  };
  const fill = (reuseList = true): ProjectEvidence => {
    const latest = latestListSnapshots.get(collection.filename);
    const snapshot = reuseList && latest?.identity === identity && latest.revision <= revision ? latest.snapshot.deref() : undefined;
    const reuse = snapshot?.aliases === aliases && snapshot.byProject;
    const keys = reuse ? [] : collection.taskProjectKeys(projects);
    const tasks = reuse
      ? [...new Set(projects.map(canonical))].flatMap(project => snapshot!.byProject!.get(project) ?? [])
      : collection.keysInOrder(keys, keys.length).map(key => decode(collection.get(key)!));
    const doneFindings = new Map<string, Map<string, BoardTask>>();
    for (const task of tasks) if (task.status === "done" && task.findingKey !== undefined) {
      let group = doneFindings.get(task.findingKey);
      if (!group) doneFindings.set(task.findingKey, group = new Map());
      group.set(task.id, task);
    }
    return { revision: reuse ? latest!.revision : revision, rows: new Map(tasks.map(task => [task.id, task])), doneFindings, bytes: tasks.reduce((sum, task) => sum + JSON.stringify(task).length * 2, 0) };
  };
  if (!evidence || evidence.revision > revision) evidence = fill();
  if (evidence.revision !== revision) {
    let cursor = "";
    let from = evidence.revision;
    for (;;) {
      const page = collection.changesAfter(from, cursor, 512);
      if (page.changeFloor > evidence.revision) { evidence = fill(false); break; }
      for (const entry of page.entries) {
        if (!entry.key.startsWith("t:")) continue;
        const id = entry.key.slice(2);
        const previous = evidence.rows.get(id);
        if (previous) {
          evidence.bytes -= JSON.stringify(previous).length * 2; evidence.rows.delete(id);
          evidence.admission?.remove(previous);
          if (previous.findingKey !== undefined) {
            const group = evidence.doneFindings.get(previous.findingKey);
            group?.delete(id);
            if (!group?.size) evidence.doneFindings.delete(previous.findingKey);
          }
        }
        const raw = entry.valueJson ? JSON.parse(entry.valueJson) as TaskStateRow : null;
        if (raw && projects.includes(raw.project as string)) {
          const task = decode(raw);
          evidence.bytes += JSON.stringify(task).length * 2;
          evidence.rows.set(id, task);
          evidence.admission?.put(task);
          if (task.status === "done" && task.findingKey !== undefined) {
            let group = evidence.doneFindings.get(task.findingKey);
            if (!group) evidence.doneFindings.set(task.findingKey, group = new Map());
            group.set(id, task);
          }
        }
      }
      if (page.entries.length < 512) { evidence.revision = page.revision; break; }
      const last = page.entries.at(-1)!;
      from = last.revision; cursor = last.key;
    }
  }
  projectEvidence.delete(key); projectEvidence.set(key, evidence);
  let bytes = 0;
  for (const held of projectEvidence.values()) bytes += held.bytes;
  while (projectEvidence.size > 256 || bytes > PROJECT_EVIDENCE_BYTES) {
    const oldest = projectEvidence.keys().next().value!;
    bytes -= projectEvidence.get(oldest)!.bytes;
    projectEvidence.delete(oldest);
  }
  return evidence;
}

function preparationRevision(filePath: string): string {
  const context = linkedContext();
  return createHash("sha256").update(JSON.stringify([
    "task-row-preparation-v1", databaseFileIdentity(legacyDatabasePath(filePath)), projectAliasSnapshot().aliases, context.self, [...context.all].sort(),
  ])).digest("hex");
}

function preparedRevision(filePath: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), "tasks-row-preparation.json"), "utf8"));
    return typeof value.revision === "string" ? value.revision : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

class TaskPreparationRequiredBase extends FileTransactionBusyError {}
const preparationOwner = globalThis as typeof globalThis & {
  __delegatusTaskPreparationRequesterV1?: () => Promise<void>;
  __delegatusTaskPreparationErrorV1?: typeof TaskPreparationRequiredBase;
};
const TaskPreparationRequired = preparationOwner.__delegatusTaskPreparationErrorV1 ??= TaskPreparationRequiredBase;

/** A task worker requests preparation from its serving Viewer over its owned
 * pipe. It receives no startup authority and chooses no destination path. */
export function setTaskPreparationRequester(request: () => Promise<void>): () => void {
  const previous = preparationOwner.__delegatusTaskPreparationRequesterV1;
  preparationOwner.__delegatusTaskPreparationRequesterV1 = request;
  return () => {
    if (preparationOwner.__delegatusTaskPreparationRequesterV1 === request) preparationOwner.__delegatusTaskPreparationRequesterV1 = previous;
  };
}

export async function withTaskPreparation<R>(operation: () => R | Promise<R>): Promise<R> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    assertOperationLease();
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof TaskPreparationRequired) || !preparationOwner.__delegatusTaskPreparationRequesterV1 || performance.now() >= deadline) throw error;
      await awaitLeasedOperation("tasks.preparation", preparationOwner.__delegatusTaskPreparationRequesterV1);
      assertOperationLease();
      // A changed dependency after the reply takes a new attempt and yields.
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }
}

function prepareTaskWrite(filePath: string): void {
  if (mayRunStateStartupMutation(path.dirname(path.resolve(filePath)))) prepareTaskRows(filePath);
  else if (preparedRevision(filePath) !== preparationRevision(filePath)) throw new TaskPreparationRequired("task rows require serving Viewer preparation");
}

/** The old writer's first logical write, before keyed commands are admitted.
 * Task fields and revisions are produced by the existing pass. The marker
 * follows their commit: losing the marker repeats an idempotent pass.
 * Alias/link dependency changes use the same startup and release fences. */
export function prepareTaskRows(filePath = TASKS_FILE, options: { afterPersist?: () => void } = {}): number {
  assertOperationLease();
  if (preparedRevision(filePath) === preparationRevision(filePath)) return 0;
  assertStateStartupMutation(path.dirname(path.resolve(filePath)), "task row preparation");
  // Backup and marker publication share one nonblocking admission across
  // processes. Contention leaves every application callback unentered.
  return withFileTransactionAttempt(path.join(path.dirname(filePath), "tasks-row-preparation.json"),
    "task row preparation is busy", () => prepareTaskRowsLeased(filePath, options));
}

function prepareTaskRowsLeased(filePath: string, options: { afterPersist?: () => void }): number {
  const directory = path.dirname(path.resolve(filePath));
  if (preparedRevision(filePath) === null) assertStateStartupMutation(directory, "task row preparation");
  taskCollection(filePath, "write");
  const revision = preparationRevision(filePath);
  if (preparedRevision(filePath) === revision) return 0;
  assertStateStartupMutation(directory, "task row preparation");
  const database = stateDatabases(directory).find(db => db.name === "state.sqlite");
  if (!database?.backup) throw new Error("task row preparation requires a backed-up state database");
  const backup = backupDatabase({ ...database, backup: { ...database.backup, intervalMs: 0 } }, {
    backupDirectory: path.join(directory, BACKUP_DIRECTORY),
  });
  if (backup.state !== "taken" && backup.state !== "not-due" && backup.state !== "unchanged") {
    throw new Error(`task row preparation backup refused: ${backup.state}`);
  }
  const effects = ["doneAt", "doneAdmissions", "findingKey", "finding", "accounting", "proactive", "project", "machine", "sync"];
  const counts = Object.fromEntries([...effects, "projection"].map(field => [field, 0]));
  const at = Date.now();
  const changed = writeTaskState(filePath, (current, sync, pristine, originalDraft) => {
    // Recheck under the collection lease: another process may have prepared it.
    if (preparedRevision(filePath) === revision) return { next: undefined, result: 0 };
    const before = snapshotTasks(current.tasks, pristine, originalDraft);
    const step = syncStep(current.tasks, sync ? { ...sync, now: () => at } : null);
    const rows = committedRows(current.tasks.slice(), before, true, step);
    let changed = 0;
    for (let index = 0; index < rows.length; index++) {
      const prior = persistedRows.get(pristine[index]!) as Record<string, unknown>;
      const next = rows[index] as Record<string, unknown>;
      if (JSON.stringify(prior) === JSON.stringify(next)) continue;
      changed++;
      for (const field of effects) {
        if (JSON.stringify(prior[field]) !== JSON.stringify(next[field])) counts[field] = (counts[field] ?? 0) + 1;
      }
      if (["placement", "pos", "hold", "steps", "dueHistory", "note", "summary", "progress", "statusBy", "icon", "priority"]
        .some(field => JSON.stringify(prior[field]) !== JSON.stringify(next[field]))) counts.projection++;
    }
    return { next: { rows, recentCreates: current.recentCreates, migrations: current.migrations ?? {} }, result: changed };
  }, options);
  if (preparationRevision(filePath) !== revision) throw new FileTransactionBusyError("task preparation dependencies changed; retry");
  writeJsonDurably(path.join(directory, "tasks-row-preparation.json"), { revision });
  // Preparation has released the tasks transaction before warming readers.
  loadTasksForList(filePath);
  console.warn(`[tasks preparation] ${JSON.stringify({ changedRows: changed, effects: counts })}`);
  return changed;
}

/** Command writes have a keyed input/output plan. A callback that explicitly
 * traverses history still gets the existing array contract, resolved lazily. */
function writeTaskCommands<R>(filePath: string,
  mutate: (state: TasksFileState, sync: TaskSyncWrite | null) => { state: TasksFileState | undefined; result: R }, tasksOnly = false): R {
  assertOperationLease();
  prepareTaskWrite(filePath);
  const collection = taskCollection(filePath, "write")!;
  const sync = taskSyncWrite(filePath);
  const prepared = preparationRevision(filePath);
  let result: R;
  collection.patchSync(() => {
    if (preparedRevision(filePath) !== prepared || preparationRevision(filePath) !== prepared) throw new TaskPreparationRequired("task preparation dependencies changed; retry");
    const aliases = projectAliasSnapshot();
    const aliasKey = JSON.stringify(aliases.aliases);
    return withProjectAliasSnapshot(aliases, () => {
      const canonical = projectAliasResolver(aliases);
      const projects = (project: string) => {
        const key = canonical(project);
        return [key, ...Object.keys(aliases.aliases).filter(alias => alias !== key && canonical(alias) === key)];
      };
      const selected = new Map<string, BoardTask | null>();
      const normalizations = new Map<string, BoardTask>();
      const findingGroups = new Set<string>();
      const read = (id: string) => {
        if (!selected.has(id)) {
          const raw = collection.get(`t:${id}`);
          const task = raw ? coerceTask(raw, canonical) : null;
          if (raw && !task) throw new Error("invalid persisted task row");
          if (task) { persistedRows.set(task, raw); deepFreeze(task); }
          selected.set(id, task);
        }
        return selected.get(id)!;
      };
      const pristineGet = (id: string) => {
        const task = read(id);
        if (task?.status !== "done" && task?.findingKey !== undefined) {
          const identity = JSON.stringify([task.project, task.findingKey]);
          if (!findingGroups.has(identity)) {
            findingGroups.add(identity);
            const group = projects(task.project).flatMap(project => collection.findingTaskKeys(project, task.findingKey!))
              .flatMap(key => { const row = read(key.slice(2)); return row ? [row] : []; });
            const projected = reconcileOpenFindings(group);
            for (let index = 0; index < projected.length; index++) {
              const row = projected[index]!;
              if (row === group[index]) continue;
              persistedRows.set(row, persistedRows.get(group[index]!));
              Object.assign(row, { revision: `task-legacy:${taskFingerprint(row)}` });
              deepFreeze(row); selected.set(row.id, row); normalizations.set(row.id, row);
            }
          }
        }
        return selected.get(id)!;
      };
      const mutable = new Map<string, ReturnType<typeof taskDrafts>>();
      const get = (id: string) => {
        let draft = mutable.get(id);
        if (!draft) {
          const index = full?.indices.get(id);
          if (index !== undefined) return full!.draft.original(index);
          const task = pristineGet(id);
          if (!task) return null;
          draft = taskDrafts([task]); mutable.set(id, draft);
        }
        return draft.original(0);
      };
      let structural = false;
      let full: { current: TasksFileState; pristine: TasksFileState; draft: ReturnType<typeof taskDrafts>; indices: Map<string, number> } | undefined;
      const readFull = () => {
        if (!full) {
          const history = mutationHistory(collection, aliasKey, canonical);
          const pristine: TasksFileState = { tasks: history.vector.tasks, recentCreates: [], migrations: {} };
          const draft = taskDrafts(pristine.tasks, (task, _index, peek) => {
            const held = mutable.get(task.id);
            return held ? peek ? held.peek(0) : held.original(0) : undefined;
          });
          const current = { ...pristine, tasks: draft.tasks };
          const indices = history.indices;
          full = { current, pristine, draft, indices };
        }
        return full.current.tasks;
      };
      const plans = new WeakMap<BoardTask[], ReadonlyMap<string, BoardTask>>();
      const draftChanges = (changes: ReadonlyMap<string, BoardTask>) => {
        const rows = new Map<string, BoardTask>();
        for (const [id, draft] of mutable) {
          const copy = draft.copies.get(0);
          if (copy && draft.changed(0, copy)) rows.set(id, copy);
        }
        if (full) for (const [index, copy] of full.draft.copies) {
          if (full.draft.changed(index, copy)) rows.set(full.pristine.tasks[index]!.id, copy);
        }
        for (const [id, task] of changes) rows.set(id, task);
        return rows;
      };
      const makeView = (changes: ReadonlyMap<string, BoardTask>): BoardTask[] => {
        const view: TaskMutationView = {
          get: id => changes.get(id) ?? get(id),
          boardCount: (project, now, members, seat) => {
            // Preserve the pure command's exact project comparison.
            if (project !== canonical(project)) return 0;
            const evidence = taskProjectEvidence(collection, projects(project), canonical, aliasKey);
            if (!evidence.admission || now < evidence.admission.observedAt) evidence.admission = new TaskAdmissionEvidence(evidence.rows.values(), now);
            let count = evidence.admission.count(project, now, members, seat);
            for (const [id, task] of draftChanges(changes)) {
              const prior = evidence.rows.get(id);
              const visible = (row: BoardTask) => row.project === project && taskShowsOnBoard(row, members?.(row) ?? false, { now, get holdsSeat() { return seat?.(row) === "holds"; } });
              if (prior && visible(prior)) count--;
              if (visible(task)) count++;
            }
            return count;
          },
          completedFinding: (project, key) => {
            const evidence = taskProjectEvidence(collection, projects(project), canonical, aliasKey);
            const rows = new Map(evidence.doneFindings.get(key));
            for (const [id, task] of draftChanges(changes)) {
              rows.delete(id);
              if (task.project === canonical(project) && task.findingKey === key && task.status === "done") rows.set(id, task);
            }
            const ordered = collection.keysInOrder([...rows.keys()].map(id => `t:${id}`), rows.size);
            const existing = new Set(ordered.map(key => key.slice(2)));
            return [...ordered.map(key => rows.get(key.slice(2))!), ...[...rows.values()].filter(task => !existing.has(task.id))];
          },
          finding: (project, key) => {
            const rows = new Map(projects(project).flatMap(project => collection.findingTaskKeys(project, key)).flatMap(key => {
              const task = get(key.slice(2));
              return task ? [[task.id, task] as const] : [];
            }));
            for (const [id, task] of draftChanges(changes)) {
              rows.delete(id);
              if (canonical(task.project) === canonical(project) && task.findingKey === key && task.status !== "done") rows.set(id, task);
            }
            return [...rows.values()];
          },
          replace: task => makeView(new Map([...changes, [task.id, task]])),
        };
        const tasks = lazyTaskMutationView(() => {
          const rows = readFull();
          if (!changes.size) return rows;
          const appended = [...changes.values()].filter(task => !full!.indices.has(task.id));
          const source = appended.length ? [...full!.pristine.tasks, ...appended] : full!.pristine.tasks;
          return taskDrafts(source, (task, index, peek) => changes.get(task.id)
            ?? (peek ? full!.draft.peek(index) : full!.draft.original(index))).tasks;
        }, view, () => { structural = true; });
        plans.set(tasks, changes);
        return tasks;
      };
      // Receipts and migration markers have their own keyed ranges. Task
      // commands never decode the retained task history to read these sections.
      const section = (prefix: string) => {
        const rows: TaskStateRow[] = [];
        let after = prefix;
        for (;;) {
          const page = collection.keyRange(after, `${prefix}\uffff`, 512);
          rows.push(...page);
          if (page.length < 512) return rows;
          after = taskRowKey(page.at(-1)!);
        }
      };
      const receipts = (tasksOnly ? [] : section("r:")) as unknown as RecentCreate[];
      // Receipt order is insertion order, not request-key order.
      const orderedReceipts = new Map(receipts.map(receipt => [`r:${receipt.clientRequestId}`, receipt]));
      const recentCreates = collection.keysInOrder([...orderedReceipts.keys()], receipts.length).map(key => orderedReceipts.get(key)!);
      const migrations = Object.fromEntries((tasksOnly ? [] : section("m:")).map(row => [row.name, row.appliedAt])) as TaskMigrations;
      const current: TasksFileState = { tasks: makeView(new Map()), recentCreates, migrations };
      assertOperationLease();
      let outcome: ReturnType<typeof mutate>;
      try { outcome = mutate(current, sync?.write ?? null); }
      catch (error) {
        // A nested admission cannot replay an application callback's effects.
        if (error instanceof TaskPreparationRequired) throw new FileTransactionBusyError(error.message);
        throw error;
      }
      result = outcome.result;
      assertOperationLease();
      if (preparationRevision(filePath) !== prepared) throw new FileTransactionBusyError("task preparation dependencies changed; retry");
      if (!outcome.state) return { records: [], companion: sync?.pending() };
      const plan = plans.get(outcome.state.tasks);
      if (full) for (const task of full.draft.copies.values()) pristineGet(task.id);
      if ([...mutable].some(([id, draft]) => draft.copies.get(0)?.id !== undefined && draft.copies.get(0)!.id !== id)) structural = true;
      if (full && [...full.draft.copies].some(([index, task]) => task.id !== full!.pristine.tasks[index]!.id)) structural = true;
      const edits = new Map([...normalizations].map(([id, task]) => [id, structuredClone(task)]));
      let deleted: BoardTask[] = [];
      let outputPositions: Map<string, number> | undefined;
      const replacements = new Set<string>();
      if (!plan || structural) {
        readFull();
        const ids = new Map<string, number>();
        for (const task of outcome.state.tasks) {
          if (ids.has(task.id)) throw new Error("duplicate persisted task id");
          ids.set(task.id, ids.size);
          const index = full!.indices.get(task.id);
          if (index === undefined || (mutable.get(task.id)?.original(0) ?? full!.draft.copies.get(index)) !== task) {
            edits.set(task.id, task); replacements.add(task.id);
          }
        }
        deleted = full!.pristine.tasks.filter(task => !ids.has(task.id));
        outputPositions = ids;
      }
      for (const [id, task] of normalizations) if (!edits.has(id)) edits.set(id, structuredClone(task));
      const deletedIds = new Set(deleted.map(task => task.id));
      for (const id of deletedIds) edits.delete(id);
      for (const [id, draft] of mutable) {
        const task = draft.copies.get(0);
        if (task && draft.changed(0, task) && !deletedIds.has(id) && !replacements.has(task.id)) edits.set(task.id, task);
      }
      if (full) for (const [index, task] of full.draft.copies) {
        const prior = full.pristine.tasks[index]!;
        if (full.draft.changed(index, task) && !deletedIds.has(prior.id) && !replacements.has(task.id)) edits.set(task.id, task);
      }
      if (plan && !structural) for (const [id, task] of plan) edits.set(id, task);
      let tasks = [...edits.values()];
      if (outputPositions) tasks.sort((left, right) => outputPositions!.get(left.id)! - outputPositions!.get(right.id)!);
      else if (plan && tasks.length > 1) {
        const ordered = collection.keysInOrder(tasks.map(task => `t:${task.id}`), tasks.length);
        const existing = new Set(ordered);
        tasks = [...ordered.map(key => edits.get(key.slice(2))!), ...tasks.filter(task => !existing.has(`t:${task.id}`))];
      }
      const baseline = [...tasks.flatMap(task => {
        const index = full?.indices.get(task.id);
        const prior = index === undefined ? pristineGet(task.id) : full!.pristine.tasks[index];
        return prior ? [prior] : [];
      }), ...deleted];
      const before = snapshotTasks(baseline);
      if (full) for (const [id, prior] of before) {
        const index = full.indices.get(id);
        if (index !== undefined) before.set(id, { ...prior, ref: mutable.get(id)?.original(0) ?? full.draft.original(index), pristine: full.pristine.tasks[index] });
      }
      const rows = committedRows(tasks, before, true, syncStep(baseline, sync?.write ?? null));
      const committed = baseline.map(task => persistedRows.get(task) as TaskStateRow);
      const deleteKeys = deleted.map(task => `t:${task.id}`);
      const nextMigrations = outcome.state.migrations ?? migrations;
      const records = stateRows(rows, outcome.state.recentCreates, nextMigrations);
      const previous = new Map([...committed, ...receipts as unknown as TaskStateRow[], ...Object.entries(migrations).map(([name, appliedAt]) => ({ name, appliedAt }))].map(row => [taskRowKey(row), row]));
      const changed = records.filter(row => { const prior = previous.get(taskRowKey(row)); return prior !== row && JSON.stringify(prior) !== JSON.stringify(row); });
      const receiptKeys = new Set(outcome.state.recentCreates.map(receipt => `r:${receipt.clientRequestId}`));
      for (const receipt of receipts) if (!receiptKeys.has(`r:${receipt.clientRequestId}`)) deleteKeys.push(`r:${receipt.clientRequestId}`);
      for (const name of Object.keys(migrations)) if (!Object.hasOwn(nextMigrations, name)) deleteKeys.push(`m:${name}`);
      if (preparationRevision(filePath) !== prepared) throw new FileTransactionBusyError("task preparation dependencies changed; retry");
      return { records: changed, deleteKeys, appendKeys: changed.map(taskRowKey).filter(key => key.startsWith("r:") && previous.has(key)), companion: sync?.pending() };
    });
  }, sync ? { companion: sync.companion } : {});
  return result!;
}

export function saveTasks(tasks: BoardTask[], filePath = TASKS_FILE): void {
  writeTaskState(filePath, ({ tasks: current, recentCreates, migrations }, sync) => {
    /* Preserve the idempotency receipts a tasks-only save (patch/delete/send)
       doesn't touch, so a create replay still resolves after them. */
    const rows = committedRows(tasks, snapshotTasks(current), false, syncStep(current, sync));
    return { next: { rows, recentCreates, migrations: migrations ?? {} }, result: undefined };
  });
  replaceProjectKeySource(`tasks:${filePath}`, canonicalProjectKeys(tasks.map(task => task.project)));
}

export function saveTasksFile(state: TasksFileState, filePath = TASKS_FILE): void {
  writeTaskState(filePath, (persisted, sync) => {
    const rows = committedRows(state.tasks, snapshotTasks(persisted.tasks), false, syncStep(persisted.tasks, sync));
    return { next: { rows, recentCreates: state.recentCreates, migrations: state.migrations ?? persisted.migrations ?? {} }, result: undefined };
  });
  replaceProjectKeySource(`tasks:${filePath}`, canonicalProjectKeys(state.tasks.map(task => task.project)));
}

/**
 * Process-shared read-modify-write over the task state. The callback must stay
 * synchronous: complete slow async work first, then fold its result into the
 * fresh snapshot here. Return `tasks: undefined` to skip the write.
 */
export function mutateTasks<R>(
  mutate: (tasks: BoardTask[]) => { tasks: BoardTask[] | undefined; result: R },
  filePath = TASKS_FILE,
): R {
  return mutateLinkedTasks((tasks) => mutate(tasks), filePath);
}

/**
 * {@link mutateTasks} with the linked-boards companion in hand: the sync apply
 * reads and writes `task_tombstones` rows in the same commit as the tasks.
 * `sync` is null when nothing is linked.
 */
export function mutateLinkedTasks<R>(
  mutate: (tasks: BoardTask[], sync: TaskSyncWrite | null) => { tasks: BoardTask[] | undefined; result: R },
  filePath = TASKS_FILE,
): R {
  return writeTaskCommands(filePath, (current, sync) => {
    const outcome = mutate(current.tasks, sync);
    return { state: outcome.tasks ? { ...current, tasks: outcome.tasks } : undefined, result: outcome.result };
  }, true);
}

/**
 * The create-path variant of {@link mutateTasks} that carries the idempotency
 * receipts through the same serialized read-modify-write, so a `clientRequestId`
 * replay is resolved against the freshest persisted map. Return `state: undefined`
 * to skip the write (validation failures, and replays that changed nothing).
 */
export function mutateTasksFile<R>(
  mutate: (state: TasksFileState) => { state: TasksFileState | undefined; result: R },
  filePath = TASKS_FILE,
): R {
  return writeTaskCommands(filePath, current => mutate(current));
}

/** The change log and key order of the task collection, for the linked-boards
    feed (docs/design/linked-installs.md M.5). Null before the store exists. */
export function taskFeedSource(filePath = TASKS_FILE) {
  const collection = taskCollection(filePath, "read");
  if (!collection) return null;
  return {
    database: legacyDatabasePath(filePath),
    revision: () => collection.revision(),
    get: (id: string) => coerceTask(collection.get(`t:${id}`)),
    /** Eligibility can change in scanner/pipeline state without a task edit.
        Requeue the current persisted row without changing its data or stamps. */
    requeue: (ids: readonly string[]) => collection.boundedPatch(ids.length * 2, (tx) => {
      for (const id of ids) {
        const row = tx.get(`t:${id}`);
        if (row) tx.put(row);
      }
    }),
    changesAfter: (revision: number, key: string, limit: number) => collection.changesAfter(revision, key, limit),
    /** Task rows with keys in `(after, through]`, in key order. */
    keyRange: (after: string, through: string, limit: number) => collection.keyRange(after, through, limit).map((row) => {
      const task = coerceTask(row);
      if (!task) throw new Error("invalid persisted task row");
      return task;
    }),
    parse: (valueJson: string) => coerceTask(JSON.parse(valueJson)),
  };
}

/** A validated keyed task, retaining legacy reads before promotion. */
export function loadPrototypeTask(taskId: string, filePath = TASKS_FILE): BoardTask | null {
  const collection = taskCollection(filePath, "read");
  if (!collection) return loadTasks(filePath).find(task => task.id === taskId) ?? null;
  const row = collection.get(`t:${taskId}`);
  if (!row) return null;
  const task = coerceTask(row);
  if (!task) throw new Error("invalid persisted task row");
  return task;
}

/** One prototype round update. Unlinked tasks need only their own row;
 * linked text changes keep the board writer's project watermark and stamps.
 * A round update cannot delete tasks or change the tombstone companion. */
export function mutateTaskPrototypeRound<R>(taskId: string, reviewId: string,
  change: (round: PrototypeReviewRound | undefined, task: BoardTask | null) => R, filePath = TASKS_FILE): R {
  const collection = taskCollection(filePath, "write")!;
  const sync = taskSyncWrite(filePath);
  return collection.boundedPatch(2, tx => {
    const raw = tx.get(`t:${taskId}`);
    const task = raw ? coerceTask(raw) : null;
    if (raw && !task) throw new Error("invalid persisted task row");
    const round = task?.prototypeReviews?.find(round => round.id === reviewId);
    if (!task || !round) return change(undefined, task);
    const before = snapshotTasks([task]);
    const previous = JSON.stringify(round);
    const ownGroups = sync?.write.linked.has(task.project)
      ? snapshotGroups([task], sync.write.linked, taskFingerprint) : undefined;
    const result = change(round, task);
    if (JSON.stringify(round) === previous) return result;
    task.updatedAt = new Date().toISOString();
    if (sync && ownGroups) {
      const prior = ownGroups.get(task.id)!;
      const groupChanged = Object.entries(prior.digests).some(([group, digest]) =>
        groupDigest(task, group as keyof typeof prior.digests) !== digest);
      // Poll bookkeeping leaves replicated groups intact. Only a semantic
      // group change needs the project's watermark; peer views stay shared.
      if (groupChanged) stampLinkedRows([task], ownGroups, sync.write, taskFingerprint);
    }
    const row = committedRows([task], before, false)[0]!;
    tx.put(row as TaskStateRow);
    return result;
  });
}

/** Notes and summaries are installation-local and cannot change replicated groups, task
 * membership or tombstones. Each transaction reads and writes one named row;
 * the callback sees the latest task after asynchronous admission. */
async function mutateTaskLocalField(field: "note" | "summary", taskId: string,
  change: (task: BoardTask) => BoardTask | undefined, filePath = TASKS_FILE,
  options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  await withViewerOperation("tasks.note", () => waitForStateLock("tasks.note", () => {
    const collection = taskCollection(filePath, "write")!;
    const context = linkedContext();
    collection.boundedPatch(2, tx => {
      const raw = tx.get(`t:${taskId}`);
      if (!raw) return;
      const task = coerceTask(raw);
      if (!task) throw new Error("invalid persisted task row");
      const next = change(structuredClone(task));
      if (!next || JSON.stringify(next[field]) === JSON.stringify(task[field])) return;
      // Retain stored extensions and pin any derived linked stamps before
      // changing updatedAt, so a local field leaves every replicated group alone.
      const row = { ...raw, updatedAt: next.updatedAt } as unknown as BoardTask;
      if (context.self && context.all.has(task.project)) {
        const stamps = { ...task.sync?.s };
        for (const group of TASK_SYNC_GROUPS) stamps[group] ??= derivedStamp(task.updatedAt, context.self.prefix);
        row.sync = { s: stamps, o: task.sync?.o ?? context.self.prefix };
      }
      if (next[field]) Object.assign(row, { [field]: next[field] });
      else delete row[field];
      stampTaskRevisions([row], snapshotTasks([task]), false);
      tx.put(row as unknown as TaskStateRow);
    });
  }, { ...options, subject: "tasks" }));
}

export function mutateTaskNote(...args: Parameters<TaskLocalMutationArgs>): Promise<void> {
  return mutateTaskLocalField("note", ...args);
}

export function mutateTaskSummary(...args: Parameters<TaskLocalMutationArgs>): Promise<void> {
  return mutateTaskLocalField("summary", ...args);
}

/** Signature shared by the two local-field mutations. */
type TaskLocalMutationArgs = (taskId: string, change: (task: BoardTask) => BoardTask | undefined,
  filePath?: string, options?: { waitMs?: number; signal?: AbortSignal }) => Promise<void>;

/** Advisory Telegram outcomes are installation-local. Touch one task row and
 * its cache revision, preserving editor, timestamps and linked group stamps. */
export function mutateTaskTelegramPolls(taskId: string, reviewId: string,
  change: (held: PrototypeReviewRound["telegramPolls"]) => PrototypeReviewRound["telegramPolls"], filePath = TASKS_FILE): void {
  const collection = taskCollection(filePath, "read");
  if (!collection) return;
  collection.boundedPatch(2, tx => {
    const raw = tx.get(`t:${taskId}`);
    if (!raw || !coerceTask(raw)) return;
    // Validation projects legacy defaults; retain the original stored fields.
    const task = raw as unknown as BoardTask;
    const round = task?.prototypeReviews?.find(round => round.id === reviewId);
    if (!task || !round) return;
    const before = snapshotTasks([task]);
    const previous = JSON.stringify(round.telegramPolls);
    const polls = change(round.telegramPolls);
    if (JSON.stringify(polls) === previous) return;
    round.telegramPolls = polls;
    stampTaskRevisions([task], before, false);
    tx.put(raw);
  });
}

export function mutateTasksAsync<R>(mutate: (tasks: BoardTask[]) => { tasks: BoardTask[] | undefined; result: R }, filePath = TASKS_FILE): Promise<R> {
  return withTaskPreparation(() => waitForStateLock("tasks.mutation", () => mutateTasks(mutate, filePath), { subject: "tasks" }));
}

/** Targeted task + companion transaction. Both leases are acquired in canonical
 * order before reading, and SQLite commits both rows together. Board evidence
 * seeks only the project's raw keys, including aliases, under a finite budget;
 * an oversized or unreadable project refuses admission without spending a slot. */
export async function patchTaskCompanion<C, R>(companion: SqliteStateCollection<C>,
  prepare: (get: (id: string) => BoardTask | null, boardTasks: (projects: readonly string[]) => BoardTask[]) => { task?: BoardTask; records: C[]; result: R }, filePath = TASKS_FILE): Promise<R> {
  return withViewerOperation("tasks.proactive.admission", () => waitForStateLock("tasks.proactive.admission", () => {
    const tasks = taskCollection(filePath, "write")!;
    let records: C[] = [];
    return tasks.boundedPatch(1_024, tx => {
      const patch = prepare(id => {
        const raw = tx.get(`t:${id}`);
        return raw ? coerceTask(raw) : null;
      }, projects => tx.taskProjectRows(projects).map(raw => {
        const task = coerceTask(raw);
        if (!task) throw new Error("invalid persisted task row");
        return task;
      }));
      records = patch.records;
      if (patch.task) {
        stampTaskRevisions([patch.task], new Map(), false);
        tx.put(patch.task as unknown as TaskStateRow);
      }
      return patch.result;
    }, undefined, { collection: companion, prepare: () => ({ records }) });
  }, { waitMs: 5_000, subject: "tasks.proactive" }));
}

/** Indexed, bounded evidence for discretionary dispatch. No busy wait: callers
 * defer when a writer owns the store or retained history exceeds the cap. */
export function proactiveProjectWork(projects: readonly string[], filePath = TASKS_FILE): BoardTask[] {
  const store = taskCollection(filePath, "read");
  if (!store) throw new Error("task capacity evidence is unavailable");
  return store.boundedPatch(1_024, tx => tx.taskProjectRows(projects).map(raw => {
    const task = coerceTask(raw);
    if (!task) throw new Error("invalid task capacity evidence");
    return task;
  }));
}
