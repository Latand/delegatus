import crypto from "node:crypto";
import fs from "node:fs";

import { readWorktreeRecoveries } from "@/lib/projects/worktreeRecoveryStore";

import { statePath } from "@/lib/configDir";
import { withFileTransaction, withFileTransactionSync } from "@/lib/state/fileTransaction";
import {
  openJournalCollection,
  readableJournal,
  resetJournalCollectionsForTests,
  writableJournal,
  JournalRowCopy,
  type JournalLocation,
  type JournalRow,
} from "@/lib/state/journalCollection";
import {
  importLegacyCollection,
  legacyDatabasePath,
  writeLegacyRollbackMirror,
  type LegacyCollectionSpec,
  type LegacyImportHooks,
  type LegacyImportOutcome,
  type LegacyReconcileSummary,
} from "@/lib/state/legacyImport";
import { waitForStateLock } from "@/lib/state/lockWait";
import type { SqliteStateCollection, StateImportRow } from "@/lib/state/sqliteStateStore";

import {
  isLifecycleEventType,
  isLifecycleState,
  LIFECYCLE_STATE_FOR_EVENT,
  operatorSafeSummary,
  type LifecycleEventType,
  type LifecycleState,
} from "./vocabulary";

/**
 * #686 — the durable lifecycle event journal.
 *
 * One append-only record per meaningful transition, carrying a stable id, a
 * timestamp, project/pipeline lineage, the conversation/stage role, the shared
 * event type and one bounded, redacted operator-safe summary. It survives a
 * Viewer restart because it is stored (in `state.sqlite` since #1870 slice 8;
 * the layout is below), and a replay cannot duplicate anything because every
 * id is derived from a caller-supplied stable key: appending the same
 * transition twice is a no-op, whatever produced it.
 *
 * Never a notification service: nothing here pushes. Producers append,
 * consumers read by lineage and cursor.
 */

export const LIFECYCLE_JOURNAL_VERSION = 1;

/** Events retained in the journal. Older ones are trimmed, their ids retired. */
export const LIFECYCLE_JOURNAL_CAPACITY = 2_000;
/** Retired ids kept so a trimmed event cannot be re-appended by a late replay. */
const RETIRED_ID_CAPACITY = 8_000;

export interface LifecycleEvent {
  id: string;
  /** Monotonic, never reused — the cursor a consumer stores. */
  seq: number;
  at: string;
  type: LifecycleEventType;
  state: LifecycleState;
  project: string | null;
  pipelineId: string | null;
  stageId: string | null;
  attempt: number | null;
  conversationId: string | null;
  /** Stage or agent role this event belongs to (`reviewer`, `builder`, …). */
  role: string | null;
  /** Bounded, redacted. Raw transcript text can never reach this field. */
  summary: string;
}

export interface LifecycleEventInput {
  /** Stable identity of the transition. The same key always yields the same
      event id, which is what makes replay idempotent. */
  key: string;
  type: LifecycleEventType;
  at: string;
  project?: string | null;
  pipelineId?: string | null;
  stageId?: string | null;
  attempt?: number | null;
  conversationId?: string | null;
  role?: string | null;
  /** Raw candidate text; bounded and redacted before it is stored. */
  summary?: string | null;
}

export interface LifecycleJournalFile {
  version: number;
  lastSeq: number;
  events: LifecycleEvent[];
  retired: string[];
  /** Permanent idempotency keys for spawn failures. Event rows are bounded;
      losing this receipt would let a later repair emit a second seat wake. */
  spawnFailureKeys?: string[];
}

export interface LifecycleEventQuery {
  project?: string;
  pipelineId?: string;
  conversationId?: string;
  stageId?: string;
  type?: LifecycleEventType;
  /** Exclusive cursor: only events with a greater seq are returned. */
  afterSeq?: number;
  limit?: number;
}

export interface LifecycleEventPage {
  count: number;
  events: LifecycleEvent[];
  /** Highest seq in the journal — a caller with no events yet can start here. */
  cursor: number;
  /** Events matching the query that did not fit under `limit`. */
  remaining: number;
}

export function lifecycleJournalPath(): string {
  return statePath("lifecycle-journal.json");
}

/**
 * Raised when the journal file exists but cannot be read as a journal. It is
 * deliberately fatal to the lifecycle surfaces: an append-only record of what
 * happened is worthless if a truncated write can silently restart it at
 * `lastSeq 0`. A durable subscriber whose cursor sits above a reset `lastSeq`
 * would then never match another event again — permanently deaf, with nothing
 * anywhere saying so. Surfacing the path lets the operator move the file aside
 * deliberately, which is the only way durable history is ever discarded.
 */
export class LifecycleJournalCorruptError extends Error {
  readonly journalPath: string;

  constructor(journalPath: string, detail: string) {
    super(`the lifecycle journal at ${journalPath} is unreadable (${detail}); move it aside to start a new one`);
    this.name = "LifecycleJournalCorruptError";
    this.journalPath = journalPath;
  }
}

export function lifecycleEventId(key: string): string {
  return `evt_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function emptyJournal(): LifecycleJournalFile {
  return { version: LIFECYCLE_JOURNAL_VERSION, lastSeq: 0, events: [], retired: [], spawnFailureKeys: [] };
}

function normalizeEvent(value: unknown): LifecycleEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<LifecycleEvent>;
  if (typeof event.id !== "string" || !event.id) return null;
  if (!Number.isInteger(event.seq) || (event.seq as number) < 1) return null;
  if (typeof event.at !== "string" || !event.at) return null;
  if (!isLifecycleEventType(event.type)) return null;
  const state = isLifecycleState(event.state) ? event.state : LIFECYCLE_STATE_FOR_EVENT[event.type];
  const nullableString = (candidate: unknown): string | null => (typeof candidate === "string" ? candidate : null);
  return {
    id: event.id,
    seq: event.seq as number,
    at: event.at,
    type: event.type,
    state,
    project: nullableString(event.project),
    pipelineId: nullableString(event.pipelineId),
    stageId: nullableString(event.stageId),
    attempt: Number.isInteger(event.attempt) ? event.attempt as number : null,
    conversationId: nullableString(event.conversationId),
    role: nullableString(event.role),
    summary: typeof event.summary === "string" ? event.summary : "",
  };
}

/** Every recorded row must survive the round trip. A row that does not is
    damage, not noise: dropping it silently would rewrite history on the next
    append, so it stops the read instead. */
function normalizeJournal(value: unknown, journalPath: string): LifecycleJournalFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleJournalCorruptError(journalPath, "its contents are not a journal object");
  }
  const file = value as Partial<LifecycleJournalFile>;
  if (file.events !== undefined && !Array.isArray(file.events)) {
    throw new LifecycleJournalCorruptError(journalPath, "its events field is not an array");
  }
  const raw = file.events ?? [];
  const events: LifecycleEvent[] = [];
  for (const [index, candidate] of raw.entries()) {
    const event = normalizeEvent(candidate);
    if (!event) throw new LifecycleJournalCorruptError(journalPath, `recorded event ${index + 1} of ${raw.length} is malformed`);
    events.push(event);
  }
  events.sort((left, right) => left.seq - right.seq);
  const retired = Array.isArray(file.retired) ? file.retired.filter((id): id is string => typeof id === "string") : [];
  const highest = events.at(-1)?.seq ?? 0;
  const lastSeq = Number.isInteger(file.lastSeq) ? Math.max(file.lastSeq as number, highest) : highest;
  const spawnFailureKeys = Array.isArray(file.spawnFailureKeys)
    ? [...new Set(file.spawnFailureKeys.filter((key): key is string => typeof key === "string" && key.startsWith("spawn:") && key.endsWith(":failed")))]
    : [];
  return { version: LIFECYCLE_JOURNAL_VERSION, lastSeq, events, retired, spawnFailureKeys };
}

function readLegacyJournalFile(journalPath = lifecycleJournalPath()): LifecycleJournalFile {
  let contents: string;
  try {
    contents = fs.readFileSync(journalPath, "utf8");
  } catch (error) {
    /* Absent is a genuine "nothing recorded yet"; anything else is a journal
       the Viewer has but cannot read, which is never the same thing. */
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyJournal();
    throw new LifecycleJournalCorruptError(journalPath, `it could not be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new LifecycleJournalCorruptError(journalPath, "it is not valid JSON — the last write was truncated");
  }
  return normalizeJournal(parsed, journalPath);
}

/** Recovery events (worktreeRecoveryStore.ts) commit with the board in
    SQLite and join the journal on read, as the legacy reader joined them: an
    event the journal does not hold yet, numbered after its head. The bound is
    applied after the join, so the journal never shows more than its capacity. */
function withRecoveries(stored: LifecycleJournalFile): LifecycleJournalFile {
  const file: LifecycleJournalFile = {
    version: LIFECYCLE_JOURNAL_VERSION,
    lastSeq: stored.lastSeq,
    events: [...stored.events],
    retired: [...stored.retired],
    spawnFailureKeys: [...stored.spawnFailureKeys ?? []],
  };
  const known = new Set([...file.events.map(event => event.id), ...file.retired]);
  const storedLastSeq = file.lastSeq;
  for (const { event } of readWorktreeRecoveries()) {
    if (known.has(event.id) || event.seq <= storedLastSeq) continue;
    file.events.push(event);
    known.add(event.id);
    file.lastSeq = Math.max(file.lastSeq, event.seq);
  }
  file.events.sort((a, b) => a.seq - b.seq);
  if (file.events.length > LIFECYCLE_JOURNAL_CAPACITY) {
    const trimmed = file.events.splice(0, file.events.length - LIFECYCLE_JOURNAL_CAPACITY);
    file.retired = [...file.retired, ...trimmed.map(event => event.id)].slice(-RETIRED_ID_CAPACITY);
  }
  return file;
}

/* ------------------------------------------------------------ SQLite store */

/*
 * The journal in `state.sqlite` (#1870 slice 8, docs/design/state-sqlite-
 * migration.md §4.4), moved out of `lifecycle-journal.json`, which every
 * append rewrote whole (1.35 MB on a busy installation) and every reader
 * parsed whole.
 *
 * Layout of the `lifecycle` collection, one row per key:
 *
 *   meta             { lastSeq, retiredOrder, spawnOrder }
 *   e:<eventId>      one event, exactly as the legacy file held it
 *   x:<eventId>      a retired id { order }: an event trimmed out of the
 *                    bounded history, kept so a late replay cannot add it again
 *   s:<key>          a permanent spawn-failure receipt { order }
 *
 * An append inserts its events and moves `meta` in one transaction. When the
 * journal holds more than its capacity, the same transaction turns the oldest
 * events into `x:` rows and drops the oldest `x:` rows beyond theirs, at most
 * a thousand of each per transaction. Readers keep a copy of the rows that
 * follows the collection's change log, so a read of an unchanged journal reads
 * no journal row and the read after an append reads the rows it wrote. Appends still take the legacy file's
 * write lock, which worktree recovery holds while it numbers its own events.
 */

export const LIFECYCLE_COLLECTION = "lifecycle";
const MIGRATION_ID = "lifecycle-journal-json-v1";
const BUSY = "lifecycle journal is busy";
const META_KEY = "meta";
const EVENT_PREFIX = "e:";
const RETIRED_PREFIX = "x:";
const SPAWN_PREFIX = "s:";
/** Rows a single append may trim from either bound, like CHANGE_PRUNE_BATCH. */
const TRIM_BATCH = 1_000;

interface JournalMeta {
  lastSeq: number;
  retiredOrder: number;
  spawnOrder: number;
}

type StoredJournalRow =
  | { kind: "meta"; meta: JournalMeta }
  | { kind: "event"; event: LifecycleEvent }
  | { kind: "retired"; id: string; order: number }
  | { kind: "spawn"; key: string; order: number };

function journalLocation(journalPath = lifecycleJournalPath()): JournalLocation {
  return {
    collection: LIFECYCLE_COLLECTION,
    database: legacyDatabasePath(journalPath),
    legacyPath: journalPath,
    busyMessage: BUSY,
    importLegacy: (options) => importLegacyLifecycleJournal(journalPath, options),
  };
}

function decodeStoredRow(databasePath: string, key: string, value: unknown): StoredJournalRow {
  const damaged = (detail: string) => new LifecycleJournalCorruptError(`${databasePath} (collection "${LIFECYCLE_COLLECTION}")`, detail);
  const record = value as Record<string, unknown> | null;
  const order = (candidate: unknown) => Number.isSafeInteger(candidate) && (candidate as number) >= 0 ? candidate as number : null;
  if (key === META_KEY) {
    const lastSeq = order(record?.lastSeq), retiredOrder = order(record?.retiredOrder), spawnOrder = order(record?.spawnOrder);
    if (lastSeq === null || retiredOrder === null || spawnOrder === null) throw damaged("its head row is malformed");
    return { kind: "meta", meta: { lastSeq, retiredOrder, spawnOrder } };
  }
  if (key.startsWith(EVENT_PREFIX)) {
    const event = normalizeEvent(value);
    if (!event || event.id !== key.slice(EVENT_PREFIX.length)) throw damaged(`recorded event ${key.slice(EVENT_PREFIX.length)} is malformed`);
    return { kind: "event", event };
  }
  const rank = order(record?.order);
  if (key.startsWith(RETIRED_PREFIX) && rank !== null) return { kind: "retired", id: key.slice(RETIRED_PREFIX.length), order: rank };
  if (key.startsWith(SPAWN_PREFIX) && rank !== null) return { kind: "spawn", key: key.slice(SPAWN_PREFIX.length), order: rank };
  throw damaged(`stored row ${key} is malformed`);
}

/** The stored journal: every row, split by kind, with the order each keeps. */
interface StoredJournal {
  meta: JournalMeta;
  events: Map<string, LifecycleEvent>;
  retired: Map<string, number>;
  spawn: Map<string, number>;
}

/** The highest sequence the journal has handed out. */
function headOf(journal: StoredJournal): number {
  let head = journal.meta.lastSeq;
  for (const event of journal.events.values()) if (event.seq > head) head = event.seq;
  return head;
}

/** Records and deletions for one write: an event this write added and its own
    trim removed is written as its retired id only. */
function withTrim(held: ReadonlyMap<string, unknown>, records: JournalRow[], trimmed: { records: JournalRow[]; deleteKeys: string[] }, meta: JournalMeta) {
  const deleted = new Set(trimmed.deleteKeys);
  return {
    records: [...records.filter(row => !deleted.has(row.key)), ...trimmed.records, { key: META_KEY, value: { ...meta } }],
    deleteKeys: trimmed.deleteKeys.filter(key => held.has(key)),
  };
}

function storedJournalOf(rows: Iterable<StoredJournalRow>): StoredJournal {
  const journal: StoredJournal = { meta: { lastSeq: 0, retiredOrder: 0, spawnOrder: 0 }, events: new Map(), retired: new Map(), spawn: new Map() };
  for (const row of rows) {
    if (row.kind === "meta") journal.meta = { ...row.meta };
    else if (row.kind === "event") journal.events.set(row.event.id, row.event);
    else if (row.kind === "retired") journal.retired.set(row.id, row.order);
    else journal.spawn.set(row.key, row.order);
  }
  return journal;
}

/** The stored journal in the legacy file's shape, before recoveries join. */
function fileOf(journal: StoredJournal): LifecycleJournalFile {
  const events = [...journal.events.values()].sort((a, b) => a.seq - b.seq);
  const byOrder = (entries: Map<string, number>) => [...entries].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  return {
    version: LIFECYCLE_JOURNAL_VERSION,
    lastSeq: Math.max(journal.meta.lastSeq, events.at(-1)?.seq ?? 0),
    events,
    retired: byOrder(journal.retired),
    spawnFailureKeys: byOrder(journal.spawn),
  };
}

/* The decoder names the database in its error, so there is one copy per
   database (a test sandbox, the live state directory). */
const rowCopies = new Map<string, JournalRowCopy<StoredJournalRow>>();
function rowCopyFor(database: string): JournalRowCopy<StoredJournalRow> {
  let copy = rowCopies.get(database);
  if (!copy) {
    copy = new JournalRowCopy<StoredJournalRow>({
      prefixes: [EVENT_PREFIX, RETIRED_PREFIX, SPAWN_PREFIX],
      keys: [META_KEY],
      decode: (key, value) => decodeStoredRow(database, key, value),
    });
    rowCopies.set(database, copy);
  }
  return copy;
}
interface JournalView {
  slot: string;
  generation: number;
  recoveries: string;
  file: LifecycleJournalFile;
}
let view: JournalView | null = null;

function freezeFile(file: LifecycleJournalFile): LifecycleJournalFile {
  for (const event of file.events) Object.freeze(event);
  Object.freeze(file.events);
  Object.freeze(file.retired);
  if (file.spawnFailureKeys) Object.freeze(file.spawnFailureKeys);
  return Object.freeze(file);
}

/** The journal as readers see it, rebuilt only when a row or a recovery
    changed since the last read. Shared and frozen: callers copy to edit. */
function readStoredJournal(collection: SqliteStateCollection<JournalRow>): LifecycleJournalFile {
  const held = rowCopyFor(collection.filename).read(collection, LIFECYCLE_COLLECTION);
  const recoveries = readWorktreeRecoveries().map(({ event }) => `${event.id}:${event.seq}`).join(",");
  const slot = `${collection.filename}\0${held.identity}`;
  if (view && view.slot === slot && view.generation === held.generation && view.recoveries === recoveries) return view.file;
  const file = freezeFile(withRecoveries(fileOf(storedJournalOf(held.rows.values()))));
  view = { slot, generation: held.generation, recoveries, file };
  return file;
}

/** The durable journal as readers see it. Before the import (an unpromoted
    release, a process that may not import) it is the legacy file. */
function readJournalFile(): LifecycleJournalFile {
  const location = journalLocation();
  const collection = readableJournal(location);
  if (!collection) return withRecoveries(readLegacyJournalFile(location.legacyPath));
  return readStoredJournal(collection);
}

/** The durable journal as stored, with recovery events joined. Shared and
    read-only once imported. */
export function readLifecycleJournal(): LifecycleJournalFile {
  return readJournalFile();
}

/**
 * Appends every input whose id is not already recorded (or already retired by
 * trimming), in one transaction. Returns what was actually added, so a
 * projector can tell a genuinely new transition from a replay of an old one.
 */
export function appendLifecycleEvents(inputs: LifecycleEventInput[]): { appended: LifecycleEvent[]; skipped: number } {
  if (inputs.length === 0) return { appended: [], skipped: 0 };
  const location = journalLocation();
  const collection = writableJournal(location);
  return withFileTransactionSync(location.legacyPath, BUSY, () => appendStored(collection, inputs));
}

/** Background producers wait asynchronously on the same journal admission. */
export async function appendLifecycleEventsAsync(inputs: LifecycleEventInput[]): Promise<{ appended: LifecycleEvent[]; skipped: number }> {
  if (inputs.length === 0) return { appended: [], skipped: 0 };
  const location = journalLocation();
  const collection = await waitForStateLock("lifecycle.journal.import", () => writableJournal(location), { subject: LIFECYCLE_COLLECTION });
  return withFileTransaction(location.legacyPath, BUSY, () =>
    waitForStateLock("lifecycle.journal.append", () => appendStored(collection, inputs), { subject: LIFECYCLE_COLLECTION }));
}

/** Rows that keep both bounds after `journal` grew: the oldest events become
    retired ids, and the oldest retired ids beyond their own bound go, at most
    {@link TRIM_BATCH} of each. Mutates `journal` to match. */
function trimRows(journal: StoredJournal): { records: JournalRow[]; deleteKeys: string[] } {
  const records: JournalRow[] = [];
  const deleteKeys: string[] = [];
  const overflow = Math.min(TRIM_BATCH, journal.events.size - LIFECYCLE_JOURNAL_CAPACITY);
  if (overflow > 0) {
    const oldest = [...journal.events.values()].sort((a, b) => a.seq - b.seq).slice(0, overflow);
    for (const event of oldest) {
      journal.events.delete(event.id);
      deleteKeys.push(`${EVENT_PREFIX}${event.id}`);
      if (journal.retired.has(event.id)) continue;
      const order = ++journal.meta.retiredOrder;
      journal.retired.set(event.id, order);
      records.push({ key: `${RETIRED_PREFIX}${event.id}`, value: { order } });
    }
  }
  const retiredOverflow = Math.min(TRIM_BATCH, journal.retired.size - RETIRED_ID_CAPACITY);
  if (retiredOverflow > 0) {
    const fresh = new Set(records.map(row => row.key));
    const oldest = [...journal.retired].sort((a, b) => a[1] - b[1]).slice(0, retiredOverflow);
    for (const [id] of oldest) {
      const key = `${RETIRED_PREFIX}${id}`;
      journal.retired.delete(id);
      if (fresh.has(key)) {
        records.splice(records.findIndex(row => row.key === key), 1);
        continue;
      }
      deleteKeys.push(key);
    }
  }
  return { records, deleteKeys };
}

function appendStored(collection: SqliteStateCollection<JournalRow>, inputs: LifecycleEventInput[]): { appended: LifecycleEvent[]; skipped: number } {
  let outcome: { appended: LifecycleEvent[]; skipped: number } = { appended: [], skipped: 0 };
  collection.patchSync(() => {
    const held = rowCopyFor(collection.filename).read(collection, LIFECYCLE_COLLECTION);
    const journal = storedJournalOf(held.rows.values());
    journal.meta.lastSeq = headOf(journal);
    const records: JournalRow[] = [];
    /* Recovery events the journal does not hold yet join it with the first
       write after them, as the legacy append folded them into the file. */
    const recovered: LifecycleEvent[] = [];
    const storedLastSeq = journal.meta.lastSeq;
    for (const { event } of readWorktreeRecoveries()) {
      if (journal.events.has(event.id) || journal.retired.has(event.id) || event.seq <= storedLastSeq) continue;
      recovered.push(event);
    }
    const known = new Set<string>([...journal.events.keys(), ...journal.retired.keys(), ...recovered.map(event => event.id),
      ...[...journal.spawn.keys()].map(lifecycleEventId)]);
    const appended: LifecycleEvent[] = [];
    let skipped = 0;
    let spawnFailureKeysChanged = false;
    for (const input of inputs) {
      if (input.type === "spawn_failed" && input.key.startsWith("spawn:") && input.key.endsWith(":failed")
        && !journal.spawn.has(input.key)) {
        const order = ++journal.meta.spawnOrder;
        journal.spawn.set(input.key, order);
        records.push({ key: `${SPAWN_PREFIX}${input.key}`, value: { order } });
        spawnFailureKeysChanged = true;
      }
      const id = lifecycleEventId(input.key);
      if (known.has(id)) {
        skipped += 1;
        continue;
      }
      known.add(id);
      appended.push(newEvent(id, 0, input));
    }
    outcome = { appended, skipped };
    if (appended.length === 0 && !spawnFailureKeysChanged) return { records: [] };
    for (const event of recovered) {
      journal.events.set(event.id, event);
      journal.meta.lastSeq = Math.max(journal.meta.lastSeq, event.seq);
      records.push({ key: `${EVENT_PREFIX}${event.id}`, value: event });
    }
    for (const event of appended) {
      event.seq = ++journal.meta.lastSeq;
      journal.events.set(event.id, event);
      records.push({ key: `${EVENT_PREFIX}${event.id}`, value: event });
    }
    return withTrim(held.rows, records, trimRows(journal), journal.meta);
  });
  return outcome;
}

function newEvent(id: string, seq: number, input: LifecycleEventInput): LifecycleEvent {
  return {
    id,
    seq,
    at: input.at,
    type: input.type,
    state: LIFECYCLE_STATE_FOR_EVENT[input.type],
    project: input.project ?? null,
    pipelineId: input.pipelineId ?? null,
    stageId: input.stageId ?? null,
    attempt: Number.isInteger(input.attempt) ? input.attempt as number : null,
    conversationId: input.conversationId ?? null,
    role: input.role ?? null,
    summary: operatorSafeSummary(input.summary),
  };
}

/** Whether an idempotency key has already been appended or retired. */
export function hasLifecycleEventKey(key: string): boolean {
  const id = lifecycleEventId(key);
  const file = readJournalFile();
  return file.events.some(event => event.id === id) || file.retired.includes(id)
    || file.spawnFailureKeys?.includes(key) === true;
}

/* ---------------------------------------------------- import and rollback */

/** The rows a legacy journal imports as: every event, retired id and receipt
    in the order the file kept them. A repeated id keeps its first row. */
function legacyRows(file: LifecycleJournalFile): { rows: StateImportRow[]; dropped: number } {
  const rows: StateImportRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const push = (key: string, value: unknown) => {
    if (seen.has(key)) { dropped += 1; return; }
    seen.add(key);
    rows.push({ key, value: { key, value }, controllerActive: true });
  };
  const retired = file.retired;
  const spawnFailureKeys = file.spawnFailureKeys ?? [];
  push(META_KEY, { lastSeq: file.lastSeq, retiredOrder: retired.length, spawnOrder: spawnFailureKeys.length } satisfies JournalMeta);
  for (const event of file.events) push(`${EVENT_PREFIX}${event.id}`, event);
  retired.forEach((id, index) => push(`${RETIRED_PREFIX}${id}`, { order: index + 1 }));
  spawnFailureKeys.forEach((key, index) => push(`${SPAWN_PREFIX}${key}`, { order: index + 1 }));
  return { rows, dropped };
}

/**
 * Fold a legacy journal that changed after the import (a rollback release
 * appended to it, or an older writer raced the fence) back into the
 * collection. The journal only grows, so the merge is a union by id: an event
 * or retired id the collection already holds stays as it is, a retired id
 * never comes back as an event, and nothing is removed. An event numbered at
 * or below the collection's head (the collection grew too during the rollback
 * window) is numbered again after it, with every later one, so no two events
 * share a sequence and the older release's events keep their order.
 */
function mergeLegacyJournal(journalPath: string, file: LifecycleJournalFile, options: { fenceOwner: boolean; consumedSha256?: string }): LegacyReconcileSummary {
  const location = journalLocation(journalPath);
  const collection = openJournalCollection(location);
  const summary: LegacyReconcileSummary = { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
  collection.patchSync(() => {
    const held = rowCopyFor(collection.filename).read(collection, LIFECYCLE_COLLECTION);
    const journal = storedJournalOf(held.rows.values());
    const head = headOf(journal);
    journal.meta.lastSeq = Math.max(head, file.lastSeq);
    const records: JournalRow[] = [];
    /* Once one event needs a new number, every later one takes the next, so
       the older release's events keep their order. */
    let renumber = false;
    for (const event of [...file.events].sort((a, b) => a.seq - b.seq)) {
      if (journal.events.has(event.id) || journal.retired.has(event.id)) { summary.kept += 1; continue; }
      renumber ||= event.seq <= head;
      const stored = renumber ? { ...event, seq: ++journal.meta.lastSeq } : { ...event };
      journal.events.set(stored.id, stored);
      records.push({ key: `${EVENT_PREFIX}${stored.id}`, value: stored });
      summary.added += 1;
      summary.keys.push(`${EVENT_PREFIX}${stored.id}`);
    }
    for (const id of file.retired) {
      if (journal.retired.has(id) || journal.events.has(id)) continue;
      const order = ++journal.meta.retiredOrder;
      journal.retired.set(id, order);
      records.push({ key: `${RETIRED_PREFIX}${id}`, value: { order } });
      summary.added += 1;
      summary.keys.push(`${RETIRED_PREFIX}${id}`);
    }
    for (const key of file.spawnFailureKeys ?? []) {
      if (journal.spawn.has(key)) continue;
      const order = ++journal.meta.spawnOrder;
      journal.spawn.set(key, order);
      records.push({ key: `${SPAWN_PREFIX}${key}`, value: { order } });
      summary.added += 1;
      summary.keys.push(`${SPAWN_PREFIX}${key}`);
    }
    return withTrim(held.rows, records, trimRows(journal), journal.meta);
  }, {
    fenceOwner: options.fenceOwner,
    ...(options.consumedSha256 ? { afterPersist: (db) => {
      const result = db.query("UPDATE state_imports SET reconciled_sha256 = ? WHERE collection = ?").run(options.consumedSha256!, LIFECYCLE_COLLECTION);
      if (result.changes !== 1) throw new Error(`missing import evidence for ${LIFECYCLE_COLLECTION} reconciliation`);
    } } : {}),
  });
  return summary;
}

/** The legacy journal's import spec, for the import driver and its tests. */
export function lifecycleJournalLegacyCollection(journalPath = lifecycleJournalPath()): LegacyCollectionSpec<{ file: LifecycleJournalFile; dropped: number }> {
  return {
    collection: LIFECYCLE_COLLECTION,
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    legacyPath: journalPath,
    /* A journal that does not parse is refused, never imported as empty: an
       empty journal restarts at sequence 0, and every durable subscriber above
       that cursor would never match another event. The file stays where it is
       and readers keep failing on it, as they did, until it is moved aside. */
    decode: (bytes) => {
      try { return { ok: true, value: JSON.parse(bytes.toString("utf8")) as unknown }; }
      catch { throw new LifecycleJournalCorruptError(journalPath, "it is not valid JSON — the last write was truncated"); }
    },
    parse: (raw) => {
      const file = normalizeJournal(raw, journalPath);
      return { file, dropped: legacyRows(file).dropped };
    },
    toRows: ({ file }) => legacyRows(file).rows,
    repairs: ({ dropped }) => dropped > 0 ? `${dropped} repeated journal row(s) kept once` : null,
    reconcile: ({ file }, _baseline, options) => mergeLegacyJournal(journalPath, file, options),
    mirrorBody: () => {
      const collection = openJournalCollection(journalLocation(journalPath));
      let mirror: { body: unknown; revision: number } | null = null;
      collection.checkpointMirror((rows, revision) => {
        const stored = storedJournalOf(rows.map(row => decodeStoredRow(collection.filename, row.key, row.value)));
        /* What the Viewer's own reader answers: worktree recovery's demotion
           checkpoint writes the same document over it, byte for byte. */
        mirror = { body: withRecoveries(fileOf(stored)), revision };
      });
      return mirror!;
    },
  };
}

/** Import `lifecycle-journal.json` now. The Viewer's activation calls this
    with `reconcile: true`; tests drive the crash seams through `hooks`. */
export function importLegacyLifecycleJournal(
  journalPath = lifecycleJournalPath(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return importLegacyCollection(lifecycleJournalLegacyCollection(journalPath), options);
}

/** Write `lifecycle-journal.json` from SQLite for a rollback release that
    predates the move. */
export function checkpointLifecycleJournalRollbackMirrorForDemotion(journalPath = lifecycleJournalPath()): void {
  writeLegacyRollbackMirror(lifecycleJournalLegacyCollection(journalPath));
}

/** Test seam: forget every held row copy and open collection, the way a
    restarted process would. */
export function resetLifecycleJournalForTests(): void {
  for (const copy of rowCopies.values()) copy.reset();
  rowCopies.clear();
  view = null;
  resetJournalCollectionsForTests();
}

/** Queryable by project, pipeline, conversation and cursor, as #686 requires. */
export function queryLifecycleEvents(query: LifecycleEventQuery = {}): LifecycleEventPage {
  const file = readJournalFile();
  return pageFromEvents(file, query);
}

/** The one definition of "matches this query", so a bounded page and an
    unbounded scan can never disagree about what is pending. */
function matchesQuery(event: LifecycleEvent, query: LifecycleEventQuery, afterSeq: number): boolean {
  if (event.seq <= afterSeq) return false;
  if (query.project && event.project !== query.project) return false;
  if (query.pipelineId && event.pipelineId !== query.pipelineId) return false;
  if (query.conversationId && event.conversationId !== query.conversationId) return false;
  if (query.stageId && event.stageId !== query.stageId) return false;
  if (query.type && event.type !== query.type) return false;
  return true;
}

function queryCursor(query: LifecycleEventQuery): number {
  return Number.isInteger(query.afterSeq) ? query.afterSeq as number : 0;
}

/**
 * Whether ANY retained event matching the query satisfies the predicate —
 * across the whole retained range, not one page of it.
 *
 * Paging exists to bound what is *carried* to a caller. Deciding whether
 * something is present at all is a different question, and answering it a page
 * at a time is how a caller ends up concluding "no" about an event that is
 * simply further down. Bounded by the journal's own capacity and allocating
 * nothing, so asking it over the full range is cheap.
 */
export function someMatchingEvent(
  file: LifecycleJournalFile,
  query: LifecycleEventQuery,
  predicate: (event: LifecycleEvent) => boolean,
): boolean {
  const afterSeq = queryCursor(query);
  return file.events.some((event) => matchesQuery(event, query, afterSeq) && predicate(event));
}

export function pageFromEvents(file: LifecycleJournalFile, query: LifecycleEventQuery = {}): LifecycleEventPage {
  const limit = Math.max(1, Math.min(200, Number.isInteger(query.limit) ? query.limit as number : 50));
  const afterSeq = queryCursor(query);
  const matched = file.events.filter((event) => matchesQuery(event, query, afterSeq));
  const events = matched.slice(0, limit);
  return {
    count: events.length,
    events,
    cursor: file.lastSeq,
    remaining: matched.length - events.length,
  };
}
