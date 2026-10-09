/**
 * Pages of linked tasks out of this machine's own store
 * (docs/design/linked-installs.md M.5). One reader serves B's answer and A's
 * push: a log page walks the change log strictly after a position, a scan
 * page walks the rows of chosen projects by key and then their tombstones.
 * A page stops at 200 rows or 512 KB of encoded rows.
 */
import { taskFeedSource, TASKS_FILE } from "@/lib/tasks/store";
import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import type { BoardTask } from "@/lib/tasks/types";
import { taskShowsOnBoard } from "@/lib/tasks/boardVisibility";
import { taskSeatHoldingSnapshot } from "@/lib/tasks/seatHolding";
import { lastScannedFiles } from "@/lib/scanner/scanCache";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { initializeStateCollections, readStateCollectionRevision, SqliteStateCollection, stateCollectionsInitialized, stateDatabaseSignature } from "@/lib/state/sqliteStateStore";

import { encodeTask, type WireRow } from "./taskWire";
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

export function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && (value.length === 1 || value.length === 2) && Number.isSafeInteger(value[0]) && (value[0] as number) >= 0
    && (value.length === 1 || (typeof value[1] === "string" && value[1].length > 0 && value[1].length <= 64));
}

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
};

export type LogPage = { kind: "page"; rows: WireRow[]; cursor: Position; more: boolean; withheld: string[] } | { kind: "resync" };

class Page {
  rows: WireRow[] = [];
  bytes = 0;
  withheld: string[] = [];
  /** Adds the row, or answers false when it would pass a bound. */
  add(row: WireRow, bytes: number, id: string, stub: boolean): boolean {
    if (this.rows.length >= PAGE_ROWS || (this.rows.length > 0 && this.bytes + bytes > PAGE_BYTES)) return false;
    this.rows.push(row);
    this.bytes += bytes;
    if (stub) this.withheld.push(id);
    return true;
  }
}

function encoded(task: BoardTask, filter: FeedFilter) {
  const { row, bytes } = encodeTask(task, filter.self, { includeBoard: filter.includeBoard, includePrototypeReview: filter.includePrototypeReview, peerTaskWireVersion: filter.peerTaskWireVersion });
  return { row, bytes, stub: "withheld" in row };
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
  files: ReturnType<typeof lastScannedFiles>;
  pipelineRevision: number | null;
  seats: string;
  after: string | null;
};
const eligibilitySweeps = new Map<string, Map<string, EligibilitySweep>>();
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
    ...readEligibilityRevisions(source, omissions), files: lastScannedFiles(), seats: seatSignature(),
  };
  let sweeps = eligibilitySweeps.get(source.database);
  if (!sweeps) eligibilitySweeps.set(source.database, sweeps = new Map());
  const scope = JSON.stringify([filter.self.id, [...filter.projects].sort()]);
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
  let files: ReturnType<typeof lastScannedFiles> | undefined;
  let pipelines: ReturnType<typeof loadPipelinesForList> | undefined;
  const now = Date.now();
  return (task) => task.status !== "done" || (!!task.machine && task.machine !== filter.self.id) || taskShowsOnBoard(task, true, {
    now,
    get holdsSeat() { return (holdsSeat ??= taskSeatHoldingSnapshot())(task) === "holds"; },
    get members() {
      files ??= lastScannedFiles() ?? [];
      return files.filter((file) => task.assignments.some((assignment) =>
        (assignment.conversationId && assignment.conversationId === file.conversationId) || assignment.path === file.path));
    },
    get pipelines() { return pipelines ??= loadPipelinesForList(); },
  });
}

/** One log page after `after`, or `resync` when the log no longer reaches
    back that far (or the position is from another store). */
export function readLogPage(after: Position, filter: FeedFilter): LogPage {
  const source = taskFeedSource(filter.filePath ?? TASKS_FILE);
  if (!source) return { kind: "page", rows: [], cursor: after, more: false, withheld: [] };
  const exportable = exportableTasks(filter);
  const current = resumeOmittedTasks(source, filter, exportable);
  const [revision, key = ""] = after;
  // Unchanged eligibility context leaves omissions off the idle read path.
  if (revision > current) return { kind: "resync" };
  if (revision === current && !key) return { kind: "page", rows: [], cursor: after, more: false, withheld: [] };
  const tombstones = tombstoneCollection(source.database, false);
  const page = new Page();
  let cursor: Position = after;
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
        const last = cursor;
        // The page ends a revision when the next entry starts another one.
        const ended = next && last[0] !== next.revision && last.length === 2 ? [last[0]] as Position : last;
        return { kind: "page", rows: page.rows, cursor: ended, more: true, withheld: page.withheld };
      }
      cursor = [entry.revision, entry.key];
      scanned++;
    }
    const exhausted = batch.entries.length < LOG_BATCH;
    if (exhausted) {
      // Everything up to the revision this read saw was covered.
      return { kind: "page", rows: page.rows, cursor: [batch.revision], more: false, withheld: page.withheld };
    }
    if (scanned >= MAX_LOG_ENTRIES) {
      const lastEntry = batch.entries.at(-1)!;
      return { kind: "page", rows: page.rows, cursor: [lastEntry.revision, lastEntry.key], more: true, withheld: page.withheld };
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
  const page = new Page();
  const exportable = exportableTasks(filter);
  let cursor = after;
  let read = 0;
  if (!cursor.startsWith("g:")) {
    let from = cursor.startsWith("t:") ? cursor : "t:";
    while (read < MAX_SCAN_KEYS) {
      const batch = source.keyRange(from, "t:\uffff", SCAN_BATCH);
      for (const task of batch) {
        read++;
        if (filter.projects.has(task.project) && trackOmission(task, source.database, exportable)) {
          const row = encoded(task, filter);
          if (!page.add(row.row, row.bytes, task.id, row.stub)) return { rows: page.rows, next: cursor, withheld: page.withheld };
        }
        cursor = `t:${task.id}`;
      }
      if (batch.length < SCAN_BATCH) { cursor = "g:"; break; }
      from = cursor;
    }
    if (!cursor.startsWith("g:")) return { rows: page.rows, next: cursor, withheld: page.withheld };
  }
  const tombstones = tombstoneCollection(source.database, false);
  if (!tombstones) return { rows: page.rows, next: null, withheld: page.withheld };
  while (read < MAX_SCAN_KEYS) {
    const batch = tombstones.keyRange(cursor, "g:\uffff", SCAN_BATCH);
    for (const tomb of batch) {
      read++;
      if (isTombstone(tomb) && filter.projects.has(tomb.project)) {
        const gone = { id: tomb.id, project: tomb.project, gone: tomb.gone };
        if (!page.add(gone, Buffer.byteLength(JSON.stringify(gone)), tomb.id, false)) return { rows: page.rows, next: cursor, withheld: page.withheld };
      }
      cursor = tombstoneRowKey(tomb);
    }
    if (batch.length < SCAN_BATCH) return { rows: page.rows, next: null, withheld: page.withheld };
  }
  return { rows: page.rows, next: cursor, withheld: page.withheld };
}
