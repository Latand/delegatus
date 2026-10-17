/**
 * Pages of linked tasks out of this machine's own store
 * (docs/design/linked-installs.md M.5). One reader serves B's answer and A's
 * push: a log page walks the change log strictly after a position, a scan
 * page walks the rows of chosen projects by key and then their tombstones.
 * A page stops at 200 rows or 512 KB of encoded rows.
 */
import { taskFeedSource, TASKS_FILE } from "@/lib/tasks/store";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import type { BoardTask } from "@/lib/tasks/types";
import { withTaskCompletion } from "@/lib/tasks/completion";
import type { FileEntry } from "@/lib/types";
import { DONE_TASK_BOARD_RETENTION_MS, taskShowsOnBoard } from "@/lib/tasks/boardVisibility";
import { taskSeatHoldingSnapshot } from "@/lib/tasks/seatHolding";
import { lastScannedFiles } from "@/lib/scanner/scanCache";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { initializeStateCollections, readStateCollectionRevision, SqliteStateCollection, stateCollectionsInitialized, stateDatabaseSignature } from "@/lib/state/sqliteStateStore";
import { databaseFileIdentity } from "@/lib/state/currentDatabase";
import { withoutStoredLessonsIn } from "@/lib/memory/roleStore";

import { decodeWireRow, encodeTask, MalformedRow, type WireRow } from "./taskWire";
import { isTombstone, tombstoneCollection, tombstoneKey, tombstoneRowKey } from "./tombstones";

/** Everything in the change log up to and including this has been sent:
    `[revision]` covers the whole revision, `[revision, key]` stops inside it. */
export type Position = [number] | [number, string];
export const PAGE_ROWS = 200;
export const PAGE_BYTES = 512 * 1024;
const LOG_BATCH = 400;
const MAX_LOG_ENTRIES = 4_000;
const SCAN_BATCH = 512;
const MAX_SCAN_KEYS = 2_048;
const PAGE_CURSOR_TTL = 30 * 24 * 60 * 60 * 1_000;

type PageCursorMode = "scan-task" | "scan-tombstone" | "log";
type PageCursorRecord = { key: string; token: string; mode: PageCursorMode | "expiry"; cursor: string; revision: number | null; expires: number };
const pageCursorSeed = {
  collection: "task_page_cursors", schemaVersion: 1, migrationId: "bounded-task-page-cursors",
  key: (row: PageCursorRecord) => row.key, loadRecords: (): PageCursorRecord[] => [],
};
const pageCursorCollections = new Map<string, { identity: string | null; collection: SqliteStateCollection<PageCursorRecord> }>();

function pageCursors(database: string): SqliteStateCollection<PageCursorRecord> {
  const identity = databaseFileIdentity(database);
  const held = pageCursorCollections.get(database);
  if (held?.identity === identity) return held.collection;
  if (!stateCollectionsInitialized(database, [pageCursorSeed])) initializeStateCollections(database, [pageCursorSeed]);
  const collection = new SqliteStateCollection<PageCursorRecord>(database, {
    collection: pageCursorSeed.collection, schemaVersion: 1, busyMessage: "task page cursor busy", key: pageCursorSeed.key,
    clone: structuredClone,
    decode: (value) => {
      if (!value || typeof value !== "object") return null;
      const row = value as Partial<PageCursorRecord>;
      return typeof row.key === "string" && typeof row.token === "string"
        && (row.mode === "scan-task" || row.mode === "scan-tombstone" || row.mode === "log" || row.mode === "expiry")
        && typeof row.cursor === "string" && (row.revision === null || Number.isSafeInteger(row.revision))
        && Number.isSafeInteger(row.expires) ? row as PageCursorRecord : null;
    }, strictDecode: true,
  });
  pageCursorCollections.set(database, { identity, collection });
  return collection;
}

const paddedExpiry = (expires: number) => String(expires).padStart(16, "0");

function resolvePageCursor(database: string, token: string, mode: PageCursorMode): PageCursorRecord | null {
  const collection = pageCursors(database);
  const record = collection.get(`p:${token}`);
  if (!record || record.mode !== mode) return null;
  if (record.expires > Date.now()) return record;
  collection.boundedPatch(2, tx => { tx.delete(record.key); tx.delete(`e:${paddedExpiry(record.expires)}:${token}`); });
  return null;
}

function checkpoint(database: string, mode: PageCursorMode, cursor: string, revision: number | null, reserved?: (token: string) => boolean): string {
  const collection = pageCursors(database);
  let token = "";
  for (let nonce = 0; ; nonce++) {
    const tokenBytes = createHash("sha256").update(JSON.stringify([database, mode, revision, cursor, nonce])).digest().subarray(0, 16);
    tokenBytes[6] = (tokenBytes[6]! & 0x0f) | 0x40;
    tokenBytes[8] = (tokenBytes[8]! & 0x3f) | 0x80;
    const hex = tokenBytes.toString("hex");
    token = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (!reserved?.(token)) break;
  }
  const expires = Date.now() + PAGE_CURSOR_TTL;
  const key = `p:${token}`;
  const row: PageCursorRecord = { key, token, mode, cursor, revision, expires };
  const previous = collection.get(key);
  const expiryKey = `e:${paddedExpiry(expires)}:${token}`;
  const expiry: PageCursorRecord = { ...row, key: expiryKey, mode: "expiry", cursor: "", revision: null };
  collection.boundedPatch(previous ? 3 : 2, tx => {
    if (previous) tx.delete(`e:${paddedExpiry(previous.expires)}:${token}`);
    tx.put(row);
    tx.put(expiry);
  });
  // Expiry keys are ordered, so cleanup visits at most one bounded batch.
  const expired = collection.keyRange("e:", `e:${paddedExpiry(Date.now())}:\uffff`, 512);
  if (expired.length) collection.boundedPatch(expired.length * 2, tx => {
    for (const entry of expired) { tx.delete(entry.key); tx.delete(`p:${entry.token}`); }
  });
  return token;
}

function scanCursor(database: string, cursor: string, continuation: string, continuationCursor: string, mode: PageCursorMode, reserved?: (token: string) => boolean): string {
  if (cursor === continuationCursor) return continuation;
  if (mode === "scan-task" && /^t:[0-9a-f-]{36}$/.test(cursor)) return cursor;
  if (mode === "scan-tombstone" && /^g:[0-9a-f-]{36}$/.test(cursor)) return cursor;
  if (cursor === "g:") return cursor;
  return `${mode === "scan-task" ? "t" : "g"}:${checkpoint(database, mode, cursor, null, reserved)}`;
}

export function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && (value.length === 1 || value.length === 2) && Number.isSafeInteger(value[0]) && (value[0] as number) >= 0
    && (value.length === 1 || (typeof value[1] === "string" && value[1].length > 0 && value[1].length <= 64));
}

export type FeedFiles = readonly Pick<FileEntry, "path" | "conversationId" | "pendingQuestion" | "waitingInput">[];
export type FeedFilter = {
  self: { id: string; prefix: string };
  /** The projects linked over this link. */
  projects: ReadonlySet<string>;
  /** Rows whose copy equals the peer's (`o`) are not served to it. */
  skipPrefix: string | null;
  /** Older peers reject the board preference added in task wire v3. */
  includeBoard?: boolean;
  includePrototypeReview?: boolean;
  peerTaskWireVersion?: number;
  filePath?: string;
  /** The caller's completed scanner observation, carried into the worker. */
  files?: FeedFiles;
  validity?: { until: number };
  now?: number;
};

export type LogPage = { kind: "page"; rows: WireRow[]; cursor: Position; more: boolean; withheld: string[] } | { kind: "resync" };

class Page {
  rows: WireRow[] = [];
  bytes = 0;
  withheld: string[] = [];
  constructor(private readonly database: string) {}
  /** Adds the row, or answers false when it would pass a bound. */
  add(row: WireRow, bytes: number, id: string, stub: boolean): boolean {
    try { decodeWireRow(row); }
    catch (error) {
      if (!(error instanceof MalformedRow)) throw error;
      // A stub can itself be malformed, as can a legacy tombstone. Keep the
      // cursor moving, and record only the local key and rejected field.
      // Exclusive creation logs once across peers and worker replacements.
      const key = `${"gone" in row ? "g" : "t"}:${id}`;
      const directory = statePath("task-export-rejections");
      const name = createHash("sha256").update(JSON.stringify([this.database, key])).digest("hex");
      fs.mkdirSync(directory, { recursive: true });
      try {
        fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ key, field: error.field }), { flag: "wx", mode: 0o600 });
        console.warn("[links] skipped malformed task export row", { key, field: error.field });
      }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
      return true;
    }
    if (this.rows.length >= PAGE_ROWS || (this.rows.length > 0 && this.bytes + bytes > PAGE_BYTES)) return false;
    this.rows.push(row);
    this.bytes += bytes;
    if (stub) this.withheld.push(id);
    return true;
  }
}

function encoded(task: BoardTask, filter: FeedFilter) {
  const { row, bytes } = encodeTask(outboundTask(task), filter.self, { includeBoard: filter.includeBoard, includePrototypeReview: filter.includePrototypeReview, peerTaskWireVersion: filter.peerTaskWireVersion });
  return { row, bytes, stub: "withheld" in row };
}

/** A task as it leaves this machine: a role-memory lesson any of its texts
    quotes (its text, details, prototype review titles, variants and decision
    comments, an original record or a replica) is withheld
    (src/lib/memory/roleStore.ts); the local task keeps it. A role memory that
    cannot be read or completely compiled throws, and the page is not sent. */
export function outboundTask(task: BoardTask): BoardTask {
  return withoutStoredLessonsIn(task, { requireComplete: true });
}

type OmittedTask = { id: string; project: string };
const omittedSeed = {
  collection: "task_export_omissions", schemaVersion: 1, migrationId: "done-export-eligibility",
  key: (row: OmittedTask) => row.id, loadRecords: (): OmittedTask[] => [],
};
const omittedCollections = new Map<string, SqliteStateCollection<OmittedTask>>();
type EligibilitySweep = {
  taskRevision: number;
  omissionRevision: number;
  files: FeedFiles | null;
  pipelineRevision: number | null;
  seats: string;
  after: string | null;
};
const eligibilitySweeps = new Map<string, Map<string, EligibilitySweep>>();
function eligibilityScope(self: string, projects: Iterable<string>): string {
  return JSON.stringify([self, [...projects].sort()]);
}
/** An unchanged log request must keep advancing a bounded omission sweep.
 * Its empty page becomes reusable only after the last omission was inspected. */
export function taskEligibilitySweepPending(database: string, self: string, projects: Iterable<string>): boolean {
  const sweep = eligibilitySweeps.get(database)?.get(eligibilityScope(self, projects));
  return !!sweep && sweep.after !== null;
}
type EligibilityRevisions = Pick<EligibilitySweep, "taskRevision" | "omissionRevision" | "pipelineRevision">;
const eligibilityRevisions = new Map<string, { signature: string; pipelineSignature: string; revisions: EligibilityRevisions }>();

/** Opening a read-only connection on every idle page costs more than the
 * sync budget. Observe WAL writes too, and read the revision only on change. */
function readEligibilityRevisions(source: NonNullable<ReturnType<typeof taskFeedSource>>, omissions: SqliteStateCollection<OmittedTask>): EligibilityRevisions {
  const pipelineDatabase = statePath("state.sqlite");
  const signature = stateDatabaseSignature(source.database);
  const pipelineSignature = pipelineDatabase === source.database ? signature : stateDatabaseSignature(pipelineDatabase);
  const held = eligibilityRevisions.get(source.database);
  if (held?.signature === signature && held.pipelineSignature === pipelineSignature) return held.revisions;
  const revisions = { taskRevision: source.revision(), omissionRevision: omissions.revision(),
    pipelineRevision: readStateCollectionRevision(pipelineDatabase, "pipelines") };
  // Cache the signature read before the query: a concurrent write after it
  // must invalidate the result on the next call.
  eligibilityRevisions.set(source.database, { signature, pipelineSignature, revisions });
  return revisions;
}

function seatSignature(): string {
  try {
    const stat = fs.statSync(statePath("orchestrator-seats.json"), { bigint: true, throwIfNoEntry: false });
    if (!stat) return "absent";
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}
function omittedTasks(database: string, create = false): SqliteStateCollection<OmittedTask> | null {
  const held = omittedCollections.get(database);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(database, [omittedSeed])) return null;
  if (create) initializeStateCollections(database, [omittedSeed]);
  const collection = new SqliteStateCollection<OmittedTask>(database, {
    collection: omittedSeed.collection, schemaVersion: 1, busyMessage: "task export eligibility busy",
    key: omittedSeed.key, clone: structuredClone,
    decode: (value) => {
      if (!value || typeof value !== "object") return null;
      const row = value as Partial<OmittedTask>;
      return typeof row.id === "string" && typeof row.project === "string" ? row as OmittedTask : null;
    }, strictDecode: true,
  });
  omittedCollections.set(database, collection);
  return collection;
}

/** Remember exclusions across restarts. When external state makes one eligible
 * again, append its unchanged row to the normal log before reading the cursor.
 * Requeue commits before removing the marker, so a crash can only replay it. */
function resumeOmittedTasks(source: NonNullable<ReturnType<typeof taskFeedSource>>, filter: FeedFilter, eligible: (task: BoardTask) => boolean): number {
  const omissions = omittedTasks(source.database);
  if (!omissions) return source.revision();
  const context = {
    ...readEligibilityRevisions(source, omissions), files: filter.files ?? lastScannedFiles(), seats: seatSignature(),
  };
  let sweeps = eligibilitySweeps.get(source.database);
  if (!sweeps) eligibilitySweeps.set(source.database, sweeps = new Map());
  const scope = eligibilityScope(filter.self.id, filter.projects);
  let sweep = sweeps.get(scope);
  // Snapshot identities and store revisions are constant-time idle checks.
  // Finish a started sweep before observing newer context, so frequent scans
  // cannot keep restarting at the first omission and starve the later keys.
  if (!sweep || sweep.after === null) {
    if (sweep && sweep.taskRevision === context.taskRevision && sweep.omissionRevision === context.omissionRevision
      && sweep.files === context.files && sweep.pipelineRevision === context.pipelineRevision && sweep.seats === context.seats) return context.taskRevision;
    sweep = { ...context, after: "" };
    sweeps.set(scope, sweep);
  }
  const batch = omissions.keyRange(sweep.after!, "\uffff", SCAN_BATCH);
  const resumed: string[] = [];
  const removed: string[] = [];
  for (const row of batch) {
    if (!filter.projects.has(row.project)) continue;
    const task = source.get(row.id);
    if (!task) removed.push(row.id);
    else if (eligible(task)) resumed.push(row.id);
  }
  if (resumed.length) source.requeue(resumed);
  const deleted = [...resumed, ...removed];
  if (deleted.length) omissions.boundedPatch(deleted.length, (tx) => { for (const id of deleted) tx.delete(id); });
  sweep.after = batch.length < SCAN_BATCH ? null : batch.at(-1)!.id;
  return resumed.length ? source.revision() : context.taskRevision;
}

function trackOmission(task: BoardTask, database: string, eligible: (task: BoardTask) => boolean): boolean {
  if (eligible(task)) return true;
  const omissions = omittedTasks(database, true)!;
  if (omissions.get(task.id)?.project !== task.project) omissions.boundedPatch(1, (tx) => tx.put({ id: task.id, project: task.project }));
  return false;
}

/** Only the owner can age a task out of export: replicas retain their rows and
 * do not have the owner's admissions or completion time. Passing hasMembers
 * keeps manual board preferences out of sync policy; the done expiry still
 * uses the board's exact predicate, including resurfacing and seat exceptions.
 * Context is read lazily, once per page, only when an expired row needs it. */
function exportableTasks(filter: FeedFilter): (task: BoardTask) => boolean {
  let holdsSeat: ReturnType<typeof taskSeatHoldingSnapshot> | undefined;
  let files: FeedFiles | null | undefined;
  let pipelines: ReturnType<typeof loadPipelinesForList> | undefined;
  const now = filter.now ?? Date.now();
  return (task) => {
    if (filter.validity && task.status === "done") {
      const expires = Date.parse(withTaskCompletion(task).doneAt!) + DONE_TASK_BOARD_RETENTION_MS + 1;
      if (expires > now) filter.validity.until = Math.min(filter.validity.until, expires);
    }
    return task.status !== "done" || (!!task.machine && task.machine !== filter.self.id) || taskShowsOnBoard(task, true, {
    now,
    get holdsSeat() { return (holdsSeat ??= taskSeatHoldingSnapshot())(task) === "holds"; },
    get members() {
      files ??= filter.files ?? lastScannedFiles() ?? [];
      return files.filter((file) => task.assignments.some((assignment) =>
        (assignment.conversationId && assignment.conversationId === file.conversationId) || assignment.path === file.path));
    },
    get pipelines() { return pipelines ??= loadPipelinesForList(); },
  });
  };
}

/** One log page after `after`, or `resync` when the log no longer reaches
    back that far (or the position is from another store). */
export function readLogPage(after: Position, filter: FeedFilter): LogPage {
  const source = taskFeedSource(filter.filePath ?? TASKS_FILE);
  if (!source) return { kind: "page", rows: [], cursor: after, more: false, withheld: [] };
  const exportable = exportableTasks(filter);
  const current = resumeOmittedTasks(source, filter, exportable);
  const [revision, wireKey = ""] = after;
  const checkpointed = wireKey.startsWith("x:") ? resolvePageCursor(source.database, wireKey.slice(2), "log") : null;
  if (wireKey.startsWith("x:") && (!checkpointed || checkpointed.revision !== revision)) return { kind: "resync" };
  const key = checkpointed?.cursor ?? wireKey;
  // Unchanged eligibility context leaves omissions off the idle read path.
  if (revision > current) return { kind: "resync" };
  if (revision === current && !key) return { kind: "page", rows: [], cursor: after, more: false, withheld: [] };
  const tombstones = tombstoneCollection(source.database, false);
  const page = new Page(source.database);
  let cursor: Position = after;
  let continuation: Position = after;
  let continuationCursor: Position = [revision, key];
  let scanned = 0;
  let position = { revision, key };
  for (;;) {
    const batch = source.changesAfter(position.revision, position.key, LOG_BATCH);
    // Entries at or below the floor are pruned: a position inside the floor
    // revision, or below it, can no longer be continued.
    if (position.revision < batch.changeFloor || (position.revision === batch.changeFloor && position.key)) return { kind: "resync" };
    for (const [index, entry] of batch.entries.entries()) {
      let row: { row: WireRow; bytes: number; stub: boolean; id: string } | null = null;
      if (entry.key.startsWith("t:")) {
        const id = entry.key.slice(2);
        if (entry.operation === "upsert") {
          // A key changed again later reappears at its later pair.
          if (entry.valueJson !== null && entry.rowRevision === entry.revision) {
            const task = source.parse(entry.valueJson);
            if (task && filter.projects.has(task.project) && task.sync?.o !== filter.skipPrefix && trackOmission(task, source.database, exportable)) row = { ...encoded(task, filter), id };
          }
        } else {
          const tomb = tombstones?.get(tombstoneKey(id));
          if (isTombstone(tomb) && filter.projects.has(tomb.project) && tomb.o !== filter.skipPrefix) {
            const gone = { id, project: tomb.project, gone: tomb.gone };
            row = { row: gone, bytes: Buffer.byteLength(JSON.stringify(gone)), stub: false, id };
          }
        }
      }
      if (row && !page.add(row.row, row.bytes, row.id, row.stub)) {
        const next = batch.entries[index];
        const last = continuation;
        // The page ends a revision when the next entry starts another one.
        const ended = next && last[0] !== next.revision && last.length === 2 ? [last[0]] as Position : last;
        return { kind: "page", rows: page.rows, cursor: ended, more: true, withheld: page.withheld };
      }
      cursor = [entry.revision, entry.key];
      if (isPosition(cursor)) { continuation = cursor; continuationCursor = cursor; }
      scanned++;
    }
    const exhausted = batch.entries.length < LOG_BATCH;
    if (exhausted) {
      // Everything up to the revision this read saw was covered.
      return { kind: "page", rows: page.rows, cursor: [batch.revision], more: false, withheld: page.withheld };
    }
    if (scanned >= MAX_LOG_ENTRIES) {
      const progressed = cursor[0] !== continuationCursor[0] || cursor[1] !== continuationCursor[1];
      const next = progressed
        ? [cursor[0], `x:${checkpoint(source.database, "log", cursor[1] ?? "", cursor[0])}`] as Position
        : continuation;
      return { kind: "page", rows: page.rows, cursor: next, more: true, withheld: page.withheld };
    }
    position = { revision: cursor[0], key: cursor[1] ?? "" };
  }
}

export type ScanPage = { rows: WireRow[]; next: string | null; withheld: string[] };

/**
 * One page of the rows of `projects` in key order after `after` (a row key,
 * "" to start), then their tombstones. `next` is null once both are done.
 * A scan ignores `o`: it rebuilds what the peer holds.
 */
export function readScanPage(after: string, filter: FeedFilter): ScanPage {
  const source = taskFeedSource(filter.filePath ?? TASKS_FILE);
  if (!source) return { rows: [], next: null, withheld: [] };
  const page = new Page(source.database);
  const exportable = exportableTasks(filter);
  const token = after.startsWith("t:") || after.startsWith("g:") ? after.slice(2) : "";
  const taskCheckpoint = after.startsWith("t:") ? resolvePageCursor(source.database, token, "scan-task") : null;
  const tombstoneCheckpoint = after.startsWith("g:") ? resolvePageCursor(source.database, token, "scan-tombstone") : null;
  let cursor = taskCheckpoint?.cursor ?? tombstoneCheckpoint?.cursor ?? after;
  let continuation = after;
  let continuationCursor = cursor;
  let read = 0;
  if (!cursor.startsWith("g:")) {
    let from = cursor.startsWith("t:") ? cursor : "t:";
    while (read < MAX_SCAN_KEYS) {
      const batch = source.keyRange(from, "t:\uffff", SCAN_BATCH);
      for (const task of batch) {
        read++;
        if (filter.projects.has(task.project) && trackOmission(task, source.database, exportable)) {
          const row = encoded(task, filter);
          if (!page.add(row.row, row.bytes, task.id, row.stub)) return { rows: page.rows, next: continuation, withheld: page.withheld };
        }
        cursor = `t:${task.id}`;
        if (/^t:[0-9a-f-]{36}$/.test(cursor)) { continuation = cursor; continuationCursor = cursor; }
      }
      if (batch.length < SCAN_BATCH) { cursor = continuation = continuationCursor = "g:"; break; }
      from = cursor;
    }
    if (!cursor.startsWith("g:")) return { rows: page.rows, next: scanCursor(source.database, cursor, continuation, continuationCursor, "scan-task", token => !!source.get(token)), withheld: page.withheld };
  }
  const tombstones = tombstoneCollection(source.database, false);
  if (!tombstones) return { rows: page.rows, next: null, withheld: page.withheld };
  while (read < MAX_SCAN_KEYS) {
    const batch = tombstones.keyRange(cursor, "g:\uffff", SCAN_BATCH);
    for (const tomb of batch) {
      read++;
      if (isTombstone(tomb) && filter.projects.has(tomb.project)) {
        const gone = { id: tomb.id, project: tomb.project, gone: tomb.gone };
        if (!page.add(gone, Buffer.byteLength(JSON.stringify(gone)), tomb.id, false)) return { rows: page.rows, next: continuation, withheld: page.withheld };
      }
      cursor = tombstoneRowKey(tomb);
      if (/^g:[0-9a-f-]{36}$/.test(cursor)) { continuation = cursor; continuationCursor = cursor; }
    }
    if (batch.length < SCAN_BATCH) return { rows: page.rows, next: null, withheld: page.withheld };
  }
  const mode = cursor.startsWith("g:") ? "scan-tombstone" : "scan-task";
  return { rows: page.rows, next: scanCursor(source.database, cursor, continuation, continuationCursor, mode, token => mode === "scan-task"
    ? !!source.get(token)
    : !!tombstones.get(tombstoneKey(token))), withheld: page.withheld };
}
