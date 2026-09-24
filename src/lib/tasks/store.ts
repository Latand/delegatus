import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { assertNotOperatorStateUnderTest } from "@/lib/stateOwnership";
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
import { readStateImport, SqliteStateCollection, type StateImportRecord, type StateImportRow } from "@/lib/state/sqliteStateStore";

import { snapshotTasks, stampTaskRevisions, taskRevision } from "./revision";
import { isTaskAttachment } from "./attachments";
import type { RecentCreate } from "./commands";
import type { AssignmentState, BoardTask, TaskAssignment, TaskBoardVisibility, TaskPlacement, TaskSource, TaskStatus, TaskOrigin } from "./types";

export const TASKS_FILE = statePath("tasks.json");

// Keep untouched legacy rows exactly as stored, including extension fields and
// omitted placement/revision. Response coercion must not migrate other rows.
const persistedRows = new WeakMap<BoardTask, unknown>();
function committedRows(tasks: BoardTask[], before: ReturnType<typeof snapshotTasks>, replacements: boolean): unknown[] {
  for (const task of tasks) task.project = canonicalProject(task.project);
  stampTaskRevisions(tasks, before, replacements);
  return tasks.map(task => {
    const prior = before.get(task.id);
    return prior && taskRevision(task) === prior.revision && persistedRows.has(prior.ref)
      ? persistedRows.get(prior.ref) : task;
  });
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
function coerceTask(value: unknown): BoardTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<BoardTask>;
  const structural =
    typeof raw.id === "string" &&
    typeof raw.project === "string" &&
    isTaskStatus(raw.status) &&
    typeof raw.text === "string" &&
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
  const placement: TaskPlacement = isPlacement(raw.placement) ? raw.placement : hasPos ? "pinned" : "unplaced";
  const pinned = placement === "pinned" && hasPos;
  const task: BoardTask = {
    ...raw,
    id: raw.id!,
    project: canonicalProject(raw.project!),
    status: raw.status!,
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
  if (!pinned) delete task.pos;
  /* An icon is a name or nothing; a row carrying anything else loads without one. */
  if (task.icon !== undefined && typeof task.icon !== "string") delete task.icon;
  try { Object.assign(task, { revision: taskRevision(task) }); } catch { return null; }
  return task;
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
  return loadTasksFile(filePath).tasks;
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
  const tasks = raw.tasks.map(value => {
    const task = coerceTask(value);
    if (!task) throw new Error("invalid persisted task row");
    persistedRows.set(task, value);
    return task;
  });
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
function mergeLegacyTasks(filePath: string, body: LegacyTasksBody, baseline: StateImportRecord, options: { fenceOwner: boolean }): LegacyReconcileSummary {
  const collection = openTaskCollection(legacyDatabasePath(filePath));
  const since = legacyBaselineRevision(baseline);
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
        records.push(row);
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
      records.push(row);
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
  }, { fenceOwner: options.fenceOwner });
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
  return stateFromBody(bodyFromRows(collection.snapshot()));
}

/** Prepare the bounded MCP selection reader without loading the collection. */
export function taskSelectionSource(filePath = TASKS_FILE) {
  const collection = taskCollection(filePath, "read");
  if (!collection) return null;
  return {
    filename: legacyDatabasePath(filePath),
    read: (id: string) => {
      const row = collection.get(`t:${id}`);
      return row ? coerceTask(row) : null;
    },
  };
}

const listSnapshots = new WeakMap<object, { aliases: string; tasks: readonly BoardTask[] }>();
const listRows = new WeakMap<object, { aliases: string; task: BoardTask }>();
/** Immutable list source. SQLite refreshes changed rows by revision; a repeated
 * list does not clone and validate every task and assignment again. */
export function loadTasksForList(filePath = TASKS_FILE): readonly BoardTask[] {
  const collection = taskCollection(filePath, "read");
  if (!collection) return readLegacyTasksFile(filePath).tasks;
  const rows = collection.loadReadonly();
  const aliases = JSON.stringify(projectAliasSnapshot().aliases);
  const cached = listSnapshots.get(rows);
  if (cached?.aliases === aliases) return cached.tasks;
  const tasks: BoardTask[] = [];
  for (const row of rows) {
    if (!taskRowKey(row).startsWith("t:")) continue;
    const held = listRows.get(row);
    let task = held?.aliases === aliases ? held.task : undefined;
    if (!task) {
      task = coerceTask(row) ?? undefined;
      if (!task) throw new Error("invalid persisted task row");
      listRows.set(row, { aliases, task });
    }
    tasks.push(task);
  }
  listSnapshots.set(rows, { aliases, tasks });
  return tasks;
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

/** One serialized read-modify-write: the prepare step reads the committed state
    under the collection lease and returns the whole next state, or undefined to
    skip the write. Only rows that changed are written; rows that disappeared
    are deleted in the same transaction. */
function writeTaskState<R>(
  filePath: string,
  prepare: (current: TasksFileState) => { next: { rows: unknown[]; recentCreates: RecentCreate[]; migrations: TaskMigrations } | undefined; result: R },
): R {
  const collection = taskCollection(filePath, "write")!;
  let result: R;
  collection.patchSync(() => {
    const committed = collection.snapshot();
    const outcome = prepare(stateFromBody(bodyFromRows(committed)));
    result = outcome.result;
    if (!outcome.next) return { records: [] };
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
    return { records: changed, deleteKeys, appendKeys };
  });
  return result!;
}

export function saveTasks(tasks: BoardTask[], filePath = TASKS_FILE): void {
  writeTaskState(filePath, ({ tasks: current, recentCreates, migrations }) => {
    /* Preserve the idempotency receipts a tasks-only save (patch/delete/send)
       doesn't touch, so a create replay still resolves after them. */
    const rows = committedRows(tasks, snapshotTasks(current), false);
    return { next: { rows, recentCreates, migrations: migrations ?? {} }, result: undefined };
  });
}

export function saveTasksFile(state: TasksFileState, filePath = TASKS_FILE): void {
  writeTaskState(filePath, (persisted) => {
    const rows = committedRows(state.tasks, snapshotTasks(persisted.tasks), false);
    return { next: { rows, recentCreates: state.recentCreates, migrations: state.migrations ?? persisted.migrations ?? {} }, result: undefined };
  });
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
  return writeTaskState(filePath, (current) => {
    const before = snapshotTasks(current.tasks);
    const outcome = mutate(current.tasks);
    if (!outcome.tasks) return { next: undefined, result: outcome.result };
    const rows = committedRows(outcome.tasks, before, true);
    return { next: { rows, recentCreates: current.recentCreates, migrations: current.migrations ?? {} }, result: outcome.result };
  });
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
  return writeTaskState(filePath, (current) => {
    const before = snapshotTasks(current.tasks);
    const outcome = mutate(current);
    if (!outcome.state) return { next: undefined, result: outcome.result };
    const rows = committedRows(outcome.state.tasks, before, true);
    return {
      next: { rows, recentCreates: outcome.state.recentCreates, migrations: outcome.state.migrations ?? current.migrations ?? {} },
      result: outcome.result,
    };
  });
}
