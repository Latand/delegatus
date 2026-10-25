import { observeRegistryWriter } from "@/lib/agent/registryWriter";
import { assertStateStartupMutation, mayRunStateStartupMutation } from "@/lib/stateOwnership";
import { IncompatibleSchemaError, schemaCompileFailure } from "./schemaCompatibility";
import { blockingWaitRole, type StateLockHolder } from "@/lib/blockingWaits";
import { observeSqlite, parseSqliteJson } from "@/lib/sqliteReadAttribution";
import { performanceSpans } from "@/lib/performanceSpans";
import crypto from "node:crypto";
import { viewerLoopMonitor, withViewerOperation } from "@/lib/viewerLoopMonitor";
import { forEachCooperatively, mapCooperatively, yieldToRuntime } from "@/lib/cooperative";
import { StateLockDeferredError, stateLockAttempt, stateLockDeferral, stateLockProcessKind, waitForStateLock } from "./lockWait";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase, SQLQueryBindings } from "bun:sqlite";

import { procBackend } from "@/lib/proc";

import { rememberRecordBytes } from "./registryRecords";
import { installPipelineControllerSchedule, pipelineControllerScheduleIndexes, selectPipelineTickWork, type PipelineTickWork } from "./pipelineControllerSchedule";
import { installPipelineControllerIndex, type PipelineControllerSelection } from "./pipelineControllerIndex";
import { installPipelineControllerReferences, pipelineControllerReferencesCurrent, pipelineControllerReferencesReady, type PipelineAttemptReference } from "./pipelineControllerReferences";
import { installPipelineEvidenceIndex, pipelineEvidenceIndexReady, pipelineEvidenceSchemaReady } from "./pipelineEvidenceIndex";
import { databaseFileIdentity, databaseSwapMarker, databaseSwapInProgress, DatabaseReplacedError, openCurrentDatabase } from "./currentDatabase";
import { collectionReadCache, rememberCollectionReadCache, type ReadCacheSlot } from "./collectionReadCache";
import { FileTransactionBusyError } from "./fileTransaction";
import { isDiskFullError, noteStateCommit, noteStateDiskFull, StateDiskFullError, stateFreeBytes, STATE_DISK_FULL_FLOOR_BYTES } from "./diskFull";

export const STATE_LEASE_MAX_AGE_MS = 15 * 60_000;
export class StateSnapshotChangedError extends Error {
  constructor() { super("controller snapshot changed; reconcile on the next pass"); }
}
export class StateLeaseLostError extends FileTransactionBusyError {
  constructor(message: string) {
    super(`${message}: this writer's lease expired or was taken over; nothing was written`);
    this.name = "StateLeaseLostError";
  }
}
function classifyStateError(error: unknown, detail: string): unknown {
  if (error instanceof IncompatibleSchemaError) return error;
  const failure = schemaCompileFailure(error);
  if (failure) return new IncompatibleSchemaError("state.sqlite", failure, { cause: error });
  if (!isDiskFullError(error)) return error;
  noteStateDiskFull(detail);
  return error instanceof StateDiskFullError ? error : new StateDiskFullError(detail, error);
}

type WriteFault = { site: "release" | "commit"; collection?: string; times?: number; error: Error };
const writeFaults = new Map<WriteFault["site"], WriteFault>();
export function injectStateWriteFaultForTests(fault: WriteFault | null): void {
  if (fault === null) writeFaults.clear();
  else writeFaults.set(fault.site, { ...fault });
}
function injectWriteFault(site: WriteFault["site"], collection?: string): void {
  const fault = writeFaults.get(site);
  if (!fault || (fault.collection !== undefined && fault.collection !== collection)) return;
  if (fault.times !== undefined) {
    if (fault.times <= 0) return;
    fault.times -= 1;
  }
  throw fault.error;
}

type DurableHold = { start: number; operation: string; collection: string; timer: ReturnType<typeof setTimeout> };
const holdHost = globalThis as typeof globalThis & { __llvDurableStateHolds?: Map<string, DurableHold> };
const durableHolds = holdHost.__llvDurableStateHolds ??= new Map();
export function stateLeaseHoldsInFlight(): { collection: string; operation: string; ageMs: number }[] {
  return [...durableHolds.values()].map(held => ({ collection: held.collection, operation: held.operation, ageMs: performance.now() - held.start }));
}
function finishDurableHold(token: string, collection: string): number {
  const held = durableHolds.get(token);
  if (!held) return 0;
  durableHolds.delete(token);
  clearTimeout(held.timer);
  const heldMs = performance.now() - held.start;
  if (heldMs > 1000) console.warn("[state lease-hold]", { collection, operation: held.operation, heldMs: Math.round(heldMs) });
  return heldMs;
}

type AbandonedLease = { filename: string; collection: string; token: string; abandonedAt: number };
type AbandonedLeases = { entries: Map<string, Map<string, Map<string, AbandonedLease>>>; timer: ReturnType<typeof setTimeout> | null; deadline?: number; delay: number };
const leaseGlobal = globalThis as typeof globalThis & { __llvAbandonedStateLeases?: AbandonedLeases };
const abandoned: AbandonedLeases = leaseGlobal.__llvAbandonedStateLeases ??= { entries: new Map(), timer: null, delay: 250 };
function abandonedTokens(filename: string, collection: string) {
  return abandoned.entries.get(path.resolve(filename))?.get(collection);
}
function forgetAbandoned(lease: AbandonedLease): void {
  const filename = path.resolve(lease.filename);
  const collections = abandoned.entries.get(filename);
  const tokens = collections?.get(lease.collection);
  if (!tokens?.delete(lease.token)) return;
  if (!tokens.size) collections!.delete(lease.collection);
  if (!collections!.size) abandoned.entries.delete(filename);
  console.info(`[state lease] cleared abandoned ${lease.collection} after ${Date.now() - lease.abandonedAt} ms`);
}
function deleteLease(lease: AbandonedLease): void {
  // If a sandbox or retired database has disappeared, do not recreate it.
  if (!fs.existsSync(lease.filename)) { finishDurableHold(lease.token, lease.collection); return; }
  const db = connectDatabase(lease.filename);
  try {
    stateLockAttempt("state.lease.release", () => db.exec("BEGIN IMMEDIATE"), lease.collection);
    injectWriteFault("release", lease.collection);
    db.query("DELETE FROM state_leases WHERE collection = ? AND owner_token = ?").run(lease.collection, lease.token);
    performanceSpans.sync("state.lease-release", () => db.exec("COMMIT"));
    finishDurableHold(lease.token, lease.collection);
  } catch (error) { rollbackQuietly(db); throw error; }
  finally { db.close(); }
}
function scheduleAbandonedRetry(): void {
  if (!abandoned.entries.size) return;
  const deadline = Date.now() + abandoned.delay;
  // New abandoned tokens may shorten a pending retry, never postpone it.
  if (abandoned.timer) {
    if (abandoned.deadline === undefined || abandoned.deadline <= deadline) return;
    clearTimeout(abandoned.timer);
  }
  abandoned.deadline = deadline;
  abandoned.timer = setTimeout(() => {
    abandoned.timer = null;
    abandoned.deadline = undefined;
    for (const collections of abandoned.entries.values()) for (const tokens of collections.values()) for (const lease of tokens.values()) {
      try { deleteLease(lease); forgetAbandoned(lease); }
      catch (error) { classifyStateError(error, `${lease.collection} release`); }
    }
    abandoned.delay = Math.min(5_000, abandoned.delay * 2);
    scheduleAbandonedRetry();
  }, abandoned.delay);
  abandoned.timer.unref();
}
function abandonLease(lease: AbandonedLease, error: unknown): void {
  const filename = path.resolve(lease.filename);
  let collections = abandoned.entries.get(filename);
  if (!collections) abandoned.entries.set(filename, collections = new Map());
  let tokens = collections.get(lease.collection);
  if (!tokens) collections.set(lease.collection, tokens = new Map());
  if (!tokens.has(lease.token)) {
    tokens.set(lease.token, lease);
    console.warn(`[state lease] abandoned ${lease.collection}: ${String(classifyStateError(error, `${lease.collection} release`))}`);
  }
  abandoned.delay = 250;
  scheduleAbandonedRetry();
}
import {
  hotStatePreparingWriterReady,
  hotStateSqliteWriterReady,
  hotStateWriterRevision,
  readHotStateAuthority,
  readHotStateReleaseTarget,
} from "./hotStateAuthority";

const CHANGE_READ_CHUNK = 400;
const CHANGE_RETENTION_REVISIONS = 1_024;
const CHANGE_PRUNE_BATCH = 1_000;
const cutoverReadyDatabases = new Set<string>();
let readonlyConnectionCount = 0;
type Database = BunDatabase;

export interface StateCollectionSeed<T> {
  collection: string;
  schemaVersion: number;
  migrationId: string;
  loadRecords(): readonly T[];
  recordJson?(records: readonly T[], index: number): string | undefined;
  key(record: T): string;
  controllerActive?(record: T): boolean;
}

export interface SqliteStateCollectionOptions<T> {
  collection: string;
  schemaVersion: number;
  busyMessage: string;
  key(record: T): string;
  decode(value: unknown): T | null;
  clone(record: T): T;
  /** Controllers may cache decoded rows across turns; every mutable nested
      field in a detached controller copy must be independent of that cache. */
  cloneController?(record: T): T;
  controllerActive?(record: T): boolean;
  validate?(record: T): void;
  strictDecode?: boolean;
  /** A parsed record this release cannot interpret stays in its original row.
      JSON/decoder exceptions still indicate corruption and abort the read. */
  preserveRejectedRecords?: boolean;
  decodeError?(error: unknown): Error;
  onDecodeError?(error: unknown): void;
  onIncrementalReadSnapshot?(revision: number): void;
  /** Authority outside SQLite that affects decoding (for example project aliases). */
  decodeAuthority?(): unknown;
  /** Opt-in version for identical decoders and rejection policies across
      separately compiled copies of a store. Bump when their semantics change. */
  readCacheKey?: string;
}

type CollectionRow = {
  row_key: string;
  value_json: string;
  row_order: number;
  row_revision: number;
  controller_active: number;
};

type CollectionMeta = {
  revision: number;
  schema_version: number;
  change_floor: number;
};

type LeaseRow = {
  owner_token: string;
  owner_pid: number;
  owner_start_identity: string | null;
  acquired_at: number;
};

type CachedRecord<T> = {
  sourceBytes: number;
  value: T;
  order: number;
  rowRevision: number;
};

interface CollectionCache<T> {
  revision: number;
  records: Map<string, CachedRecord<T>>;
  orderedKeys: readonly string[];
  ordered: readonly T[];
}

type CollectionReadContext = { identity: string | null; authority: unknown; key?: string };

interface TrackedRoot<T> {
  originalKey: string;
  persistedJson: string | null;
  value: T;
}

interface MutationSession<T> {
  records: T[];
  rawRecords: T[];
  materialized: Map<number, TrackedRoot<T>>;
  structural: boolean;
  explicitOnly: boolean;
}

export interface StateMutationContext<T> {
  records: T[];
  dirtyRecords: readonly T[];
  structural: boolean;
}

export interface ChangeLogPage {
  revision: number;
  changeFloor: number;
  entries: { revision: number; key: string; operation: "upsert" | "delete"; valueJson: string | null; rowRevision: number | null }[];
}

/** Rows another collection of the same database writes in the same commit. */
export interface CompanionPatch<C> {
  records: readonly C[];
  deleteKeys?: readonly string[];
}

export interface StateBoundedTransaction<T> {
  get(key: string): T | null;
  /** Indexed task evidence; each project seek and returned row spends budget. */
  taskProjectRows(projects: readonly string[]): T[];
  pipelineLookup(query: { requestKey: string } | { repository: string; branch: string; active?: boolean }): T | null;
  hasUnfinishedPipeline(query: {
    repository: string;
    branch: string;
    pullRequestRepository?: string;
    prNumber?: number;
    pullRequestMatches?: (pipeline: T, repository: string, number: number) => boolean;
  }): boolean;
  put(record: T): void;
  delete(key: string): void;
}

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("SQLite state stores require the Bun runtime");
  return sqlite.Database;
}

export function markStateSqliteCutoverReady(filename: string): void {
  cutoverReadyDatabases.add(path.resolve(filename));
}

function collectionMarkersMatch(db: Database, seeds: readonly StateCollectionSeed<unknown>[]): boolean {
  const marker = db.query<{ schema_version: number; migration_id: string }, [string]>(
    "SELECT schema_version, migration_id FROM state_collections WHERE collection = ?",
  );
  return seeds.every((seed) => {
    const current = marker.get(seed.collection);
    return current?.schema_version === seed.schemaVersion && current.migration_id === seed.migrationId;
  });
}

export function stateCollectionsInitialized(filename: string, seeds: readonly StateCollectionSeed<unknown>[]): boolean {
  if (!fs.existsSync(filename)) return false;
  try {
    return collectionMarkersMatch(sharedStateReadonlyDatabase(filename), seeds);
  } catch {
    return false;
  }
}

function ensureFirstSqliteCutover(filename: string, seeds: readonly StateCollectionSeed<unknown>[]): void {
  const resolved = path.resolve(filename);
  if (cutoverReadyDatabases.has(resolved) || stateCollectionsInitialized(filename, seeds)) return;
  const directory = path.dirname(filename);
  if (readHotStateReleaseTarget(directory) === null) {
    cutoverReadyDatabases.add(resolved);
    return;
  }
  if (!hotStateSqliteWriterReady(directory)) {
    throw new FileTransactionBusyError("hot state migration is waiting for release promotion");
  }
  cutoverReadyDatabases.add(resolved);
}

function assertSqliteWriteAuthority(filename: string): void {
  if (!hotStateSqliteWriterReady(path.dirname(filename))) {
    throw new FileTransactionBusyError("hot state writes are fenced during release handoff");
  }
}

function assertSqliteInitializationAuthority(filename: string, allowFencedExisting = false): void {
  if (hotStateSqliteWriterReady(path.dirname(filename))) return;
  if (cutoverReadyDatabases.has(path.resolve(filename))
    && hotStatePreparingWriterReady(path.dirname(filename))) return;
  const revision = hotStateWriterRevision(path.dirname(filename));
  const authority = readHotStateAuthority(path.dirname(filename));
  if (allowFencedExisting
    && revision !== null
    && authority?.mode === "fencing"
    && authority.releaseRevision === revision) return;
  throw new FileTransactionBusyError("hot state migration is waiting for release promotion");
}

/* Every connection stays bound to the file at its name: a database the
   activation fallback replaced is reopened, never written through the moved
   handle (currentDatabase.ts). */
function connectDatabase(filename: string): Database {
  try { return openCurrentDatabase(filename, () => connectRawDatabase(filename)); }
  catch (error) { throw classifyStateError(error, "state database connection"); }
}

function connectRawDatabase(filename: string): Database {
  return stateLockAttempt("state.connection", () => {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const db = observeRegistryWriter(
      observeSqlite(new (sqliteDatabase())(filename, { create: true, strict: true }), "state"),
      filename, viewerLoopMonitor.current() ?? "state database write",
    );
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA journal_size_limit = 67108864");
      db.exec("PRAGMA foreign_keys = ON");
      return db;
    } catch (error) { db.close(); throw error; }
  });
}

function connectReadonlyDatabase(filename: string): Database {
  readonlyConnectionCount += 1;
  return openCurrentDatabase(filename, () => connectRawReadonlyDatabase(filename));
}

function connectRawReadonlyDatabase(filename: string): Database {
  const Database = sqliteDatabase();
  const db = observeSqlite(new Database(filename, { readonly: true, strict: true }), "state");
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function openDatabase(filename: string): Database {
  try { return openCurrentDatabase(filename, () => openRawDatabase(filename)); }
  catch (error) { throw classifyStateError(error, "state database initialization"); }
}

/** Schema creation and the read-only readiness probe share one inventory. */
const stateSchema = [
  `CREATE TABLE IF NOT EXISTS state_collections (
    collection TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    change_floor INTEGER NOT NULL DEFAULT 0,
    migration_id TEXT NOT NULL,
    imported_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS state_rows (
    collection TEXT NOT NULL,
    row_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    row_order INTEGER NOT NULL,
    row_revision INTEGER NOT NULL,
    controller_active INTEGER NOT NULL CHECK(controller_active IN (0, 1)),
    PRIMARY KEY(collection, row_key),
    FOREIGN KEY(collection) REFERENCES state_collections(collection) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS state_rows_collection_order
    ON state_rows(collection, row_order)`,
  `CREATE INDEX IF NOT EXISTS state_rows_task_project
    ON state_rows(json_extract(value_json,'$.project'), row_key)
    WHERE collection='tasks' AND json_valid(value_json)`,
  `CREATE INDEX IF NOT EXISTS state_rows_task_finding
    ON state_rows(json_extract(value_json,'$.project'), json_extract(value_json,'$.findingKey'), row_order, row_key)
    WHERE collection='tasks' AND json_valid(value_json)
      AND json_type(value_json,'$.findingKey')='text' AND json_type(value_json,'$.status')='text'
      AND json_extract(value_json,'$.status') <> 'done'`,
  `CREATE INDEX IF NOT EXISTS state_rows_task_due ON state_rows(
    json_extract(value_json,'$.project'),
    coalesce(json_extract(value_json,'$.machine'),''),
    CASE json_extract(value_json,'$.priority') WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END,
    coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0),
    round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000), row_key)
    WHERE collection='tasks' AND json_valid(value_json)
      AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
      AND json_extract(value_json,'$.status') <> 'done'`,
  ...["text", "status", "look", "place", "links", "machine", "handover"].map(field => `CREATE INDEX IF NOT EXISTS state_rows_task_stamp_${field}
      ON state_rows(json_extract(value_json,'$.project'), json_extract(value_json,'$.sync.s.${field}') DESC)
      WHERE collection='tasks' AND json_valid(value_json) AND json_type(value_json,'$.sync.s.${field}')='text'`),
  `CREATE INDEX IF NOT EXISTS state_rows_task_legacy_stamp
    ON state_rows(json_extract(value_json,'$.project'), round((julianday(json_extract(value_json,'$.updatedAt'))-2440587.5)*86400000) DESC)
    WHERE collection='tasks' AND json_valid(value_json)
      AND (json_type(value_json,'$.sync.s.text') IS NULL OR json_type(value_json,'$.sync.s.status') IS NULL
        OR json_type(value_json,'$.sync.s.look') IS NULL OR json_type(value_json,'$.sync.s.place') IS NULL
        OR json_type(value_json,'$.sync.s.links') IS NULL OR json_type(value_json,'$.sync.s.machine') IS NULL
        OR json_type(value_json,'$.sync.s.handover') IS NULL)`,
  `CREATE INDEX IF NOT EXISTS state_rows_controller_active
    ON state_rows(collection, controller_active, row_order)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_delivery_owner
    ON state_rows(json_extract(value_json, '$.delivery.target.repository'), json_extract(value_json, '$.delivery.target.branch'))
    WHERE collection = 'pipelines' AND json_valid(value_json) AND json_extract(value_json, '$.delivery.active') = 1
      AND json_extract(value_json, '$.delivery.disposition') = 'owner'`,
  `CREATE INDEX IF NOT EXISTS pipeline_delivery_history
    ON state_rows(collection, json_extract(value_json, '$.delivery.target.repository'), json_extract(value_json, '$.delivery.target.branch'), json_extract(value_json, '$.delivery.epoch') DESC)
    WHERE collection IN ('pipelines', 'pipelines_archive') AND json_valid(value_json)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_creation_request
    ON state_rows(collection, json_extract(value_json, '$.creationRequest.key'))
    WHERE collection IN ('pipelines', 'pipelines_archive') AND json_valid(value_json) AND json_extract(value_json, '$.creationRequest.key') IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS pipeline_delivery_unclaimed ON state_rows(row_key)
    WHERE collection = 'pipelines' AND json_valid(value_json)
      AND json_extract(value_json, '$.delivery') IS NULL
      AND json_extract(value_json, '$.publication') = 'remote-branch'
      AND json_extract(value_json, '$.state') NOT IN ('completed', 'closed')`,
  `CREATE TABLE IF NOT EXISTS state_changes (
    collection TEXT NOT NULL,
    revision INTEGER NOT NULL,
    row_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
    PRIMARY KEY(collection, revision, row_key),
    FOREIGN KEY(collection) REFERENCES state_collections(collection) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS state_changes_collection_revision
    ON state_changes(collection, revision)`,
  `CREATE TABLE IF NOT EXISTS state_leases (
    collection TEXT PRIMARY KEY,
    owner_token TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_start_identity TEXT,
    acquired_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS state_imports (
    collection TEXT PRIMARY KEY REFERENCES state_collections(collection) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    source_sha256 TEXT,
    source_bytes INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    row_digest TEXT NOT NULL,
    gap TEXT,
    release TEXT,
    imported_at TEXT NOT NULL,
    mirror_sha256 TEXT,
    mirror_revision INTEGER,
    reconciled_sha256 TEXT
  )`,
];
const stateSchemaNames = stateSchema.map(sql => /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) IF NOT EXISTS (\w+)/.exec(sql)![1]!);

function taskDueIndexCurrent(db: Database): boolean {
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='index' AND name='state_rows_task_due'").get()?.sql;
  const expected = stateSchema.find(statement => statement.startsWith("CREATE INDEX IF NOT EXISTS state_rows_task_due ON"))!;
  const normalize = (statement: string) => statement.replace("IF NOT EXISTS ", "").replace(/\s+/g, " ").trim();
  return sql !== undefined && normalize(sql) === normalize(expected);
}

function openRawDatabase(filename: string): Database {
  const db = connectRawDatabase(filename);
  try {
    return stateLockAttempt("state.schema", () => {
      try {
        // Existing collections are read without acquiring SQLite's writer lock.
        // Missing schema still follows the fenced initialization path below.
        const objects = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").all();
        const names = new Set(objects.map(row => row.name));
        if ([...stateSchemaNames,
          "pipeline_controller_work", "pipeline_controller_work_order", "pipeline_controller_work_insert",
          "pipeline_controller_work_update", "pipeline_controller_work_delete", "pipeline_tick_delete"].every(name => names.has(name))
          && pipelineControllerScheduleIndexes.ready(names)
          && pipelineControllerReferencesReady(db, names)
          && (pipelineControllerReferencesCurrent(db) || !mayRunStateStartupMutation(path.dirname(filename)))
          && pipelineEvidenceIndexReady(db)
          && taskDueIndexCurrent(db)
          && db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode === "wal"
          && db.query<{ name: string }, []>("PRAGMA table_info(state_collections)").all().some(row => row.name === "change_floor")
          && db.query<{ name: string }, []>("PRAGMA table_info(state_imports)").all().some(row => row.name === "reconciled_sha256")) return db;
        // The readiness check above is read-only. Any path below can mutate
        // the shared database, so an older or partial schema may only be
        // repaired by the release that currently owns SQLite writes.
        assertSqliteInitializationAuthority(filename);
        assertStateStartupMutation(path.dirname(filename), "state database schema");
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        db.exec("BEGIN IMMEDIATE");
        if (!taskDueIndexCurrent(db)) db.exec("DROP INDEX IF EXISTS state_rows_task_due");
        for (const sql of stateSchema) db.exec(sql);
        const collectionColumns = db.query<{ name: string }, []>("PRAGMA table_info(state_collections)").all();
        if (!collectionColumns.some((column) => column.name === "change_floor")) {
          db.exec("ALTER TABLE state_collections ADD COLUMN change_floor INTEGER NOT NULL DEFAULT 0");
        }
        const importColumns = db.query<{ name: string }, []>("PRAGMA table_info(state_imports)").all();
        if (!importColumns.some((column) => column.name === "reconciled_sha256")) {
          db.exec("ALTER TABLE state_imports ADD COLUMN reconciled_sha256 TEXT");
        }
        installPipelineControllerIndex(db, path.dirname(filename));
        installPipelineControllerSchedule(db, path.dirname(filename));
        installPipelineControllerReferences(db, path.dirname(filename));
        installPipelineEvidenceIndex(db, path.dirname(filename));
        db.exec("COMMIT");
        secureDatabaseFiles(filename);
        return db;
      } catch (error) {
        rollbackQuietly(db);
        throw classifyStateError(error, "state schema");
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }
}

function secureDatabaseFiles(filename: string): void {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    try { fs.chmodSync(candidate, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function rollbackQuietly(db: Database): void {
  try { db.exec("ROLLBACK"); } catch { /* transaction never opened or already closed */ }
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is (?:locked|busy)|SQLITE_BUSY/i.test(message);
}

function withImmediateTransaction<T>(db: Database, busyMessage: string, operation: () => T, collection?: string): T {
  stateLockAttempt(`state.transaction.${collection ?? "import"}`, () => db.exec("BEGIN IMMEDIATE"), collection);
  const holdStart = performance.now();
  try {
    const before = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes;
    const result = operation();
    if (result instanceof Promise) throw new Error("state SQL transactions must be synchronous");
    const after = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes;
    injectWriteFault("commit", collection);
    db.exec("COMMIT");
    if (after > before) noteStateCommit();
    return result;
  } catch (error) {
    rollbackQuietly(db);
    // A callback has entered. Never let admission retry replay it.
    if (stateLockDeferral(error)) throw new FileTransactionBusyError(busyMessage);
    throw classifyStateError(error, "state transaction");
  } finally {
    const heldMs = performance.now() - holdStart;
    if (heldMs >= 50) console.warn(`[state transaction-hold] ${JSON.stringify({ collection, heldMs: Math.round(heldMs), pid: process.pid, role: blockingWaitRole() })}`);
  }
}

async function stateTransactionAsync<T>(filename: string, collection: string, operation: (db: Database) => T, afterCommit?: (result: T) => void): Promise<T> {
  return waitForStateLock(`state.transaction.${collection}`, () => {
    const db = connectDatabase(filename);
    try {
      const result = withImmediateTransaction(db, "state transaction is busy", () => operation(db), collection);
      // Apply the committed baseline before yielding to queued edits. Keep
      // bookkeeping failures from replaying a transaction that already committed.
      try { afterCommit?.(result); }
      catch (error) {
        if (stateLockDeferral(error)) throw new FileTransactionBusyError("state checkpoint bookkeeping failed after commit");
        throw error;
      }
      return result;
    }
    finally { db.close(); }
  }, { subject: collection });
}

function processAlive(pid: number, expectedStartIdentity: string | null): boolean {
  if (!procBackend.pidAlive(pid)) return false;
  if (expectedStartIdentity === null) return true;
  const current = procBackend.processIdentity(pid);
  return current === null || current === expectedStartIdentity;
}

export function stateLeaseOwnerAlive(owner: { pid: number; startIdentity: string | null }): boolean {
  return Number.isInteger(owner.pid) && owner.pid > 0 && processAlive(owner.pid, owner.startIdentity);
}

function leaseIsStale(lease: LeaseRow, filename: string, collection: string, now: number): boolean {
  return abandonedTokens(filename, collection)?.has(lease.owner_token) === true
    || now - lease.acquired_at > STATE_LEASE_MAX_AGE_MS
    || !stateLeaseOwnerAlive({ pid: lease.owner_pid, startIdentity: lease.owner_start_identity });
}

function insertSeed<T>(db: Database, seed: StateCollectionSeed<T>): void {
  const records = seed.loadRecords();
  const revision = records.length > 0 ? 1 : 0;
  db.query(`
    INSERT INTO state_collections(collection, schema_version, revision, migration_id, imported_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(seed.collection, seed.schemaVersion, revision, seed.migrationId, new Date().toISOString());
  const insert = db.query(`
    INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const key = seed.key(record);
    if (!key || seen.has(key)) throw new Error(`duplicate or empty ${seed.collection} migration key: ${key}`);
    seen.add(key);
    insert.run(seed.collection, key, seed.recordJson?.(records, index) ?? JSON.stringify(record), index, revision, seed.controllerActive?.(record) === false ? 0 : 1);
  });
}

/** Import one or more legacy collections in one durable first-boot transaction. */
export function initializeStateCollections(
  filename: string,
  seeds: readonly StateCollectionSeed<unknown>[],
  options: {
    reimportExisting?: boolean;
    afterCollectionImport?: (collection: string) => void;
  } = {},
): void {
  ensureFirstSqliteCutover(filename, seeds);
  const allowFencedExisting = !options.reimportExisting && stateCollectionsInitialized(filename, seeds);
  const db = openDatabase(filename);
  try {
    if (!options.reimportExisting && collectionMarkersMatch(db, seeds)) {
      assertSqliteInitializationAuthority(filename, allowFencedExisting);
      return;
    }
    withImmediateTransaction(db, "state migration is busy", () => {
      assertSqliteInitializationAuthority(filename, allowFencedExisting);
      if (options.reimportExisting && !collectionMarkersMatch(db, seeds)) {
        const removeLease = db.query("DELETE FROM state_leases WHERE collection = ?");
        const removeCollection = db.query("DELETE FROM state_collections WHERE collection = ?");
        for (const seed of seeds) {
          removeLease.run(seed.collection);
          removeCollection.run(seed.collection);
        }
      }
      for (const seed of seeds) {
        const current = db.query<{ schema_version: number; migration_id: string }, [string]>(
          "SELECT schema_version, migration_id FROM state_collections WHERE collection = ?",
        ).get(seed.collection);
        if (current) {
          if (current.schema_version !== seed.schemaVersion) {
            throw new Error(`unsupported ${seed.collection} SQLite schema: ${current.schema_version}`);
          }
          if (current.migration_id !== seed.migrationId) {
            throw new Error(`unsupported ${seed.collection} SQLite migration: ${current.migration_id}`);
          }
          continue;
        }
        insertSeed(db, seed);
        options.afterCollectionImport?.(seed.collection);
      }
      assertSqliteInitializationAuthority(filename, allowFencedExisting);
    }, "migration");
    secureDatabaseFiles(filename);
  } finally {
    db.close();
  }
}

/** First-open and migration admission can yield before loading any seed. */
export async function initializeStateCollectionsAsync(...args: Parameters<typeof initializeStateCollections>): Promise<void> {
  await waitForStateLock("state.initialize", () => initializeStateCollections(...args));
}

/** Evidence of one legacy file's first-boot import (#1870). */
export interface StateImportRecord {
  collection: string;
  sourceName: string;
  sourceSha256: string | null;
  sourceBytes: number;
  rowCount: number;
  rowDigest: string;
  gap: string | null;
  release: string | null;
  importedAt: string;
  mirrorSha256: string | null;
  mirrorRevision: number | null;
  reconciledSha256: string | null;
}

export interface StateImportRow {
  key: string;
  value: unknown;
  controllerActive: boolean;
}

export class StateImportVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateImportVerificationError";
  }
}

type StateImportDbRow = {
  collection: string;
  source_name: string;
  source_sha256: string | null;
  source_bytes: number;
  row_count: number;
  row_digest: string;
  gap: string | null;
  release: string | null;
  imported_at: string;
  mirror_sha256: string | null;
  mirror_revision: number | null;
  reconciled_sha256: string | null;
};

function stateImportRecord(row: StateImportDbRow): StateImportRecord {
  return {
    collection: row.collection,
    sourceName: row.source_name,
    sourceSha256: row.source_sha256,
    sourceBytes: row.source_bytes,
    rowCount: row.row_count,
    rowDigest: row.row_digest,
    gap: row.gap,
    release: row.release,
    importedAt: row.imported_at,
    mirrorSha256: row.mirror_sha256,
    mirrorRevision: row.mirror_revision,
    reconciledSha256: row.reconciled_sha256,
  };
}

/** sha256 over each row's value_json in row order, one line per row. */
export function stateRowDigest(valueJsons: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const valueJson of valueJsons) hash.update(valueJson).update("\n");
  return hash.digest("hex");
}

function selectStateImport(db: Database, collection: string): StateImportRecord | null {
  const row = db.query<StateImportDbRow, [string]>("SELECT * FROM state_imports WHERE collection = ?").get(collection);
  return row ? stateImportRecord(row) : null;
}

/** The import evidence for a collection, or null before its import commits. */
export function readStateImport(filename: string, collection: string): StateImportRecord | null {
  return stateLockAttempt("state.marker", () => readStateImportAttempt(filename, collection), collection);
}

function readStateImportAttempt(filename: string, collection: string): StateImportRecord | null {
  if (!fs.existsSync(filename)) return null;
  try {
    return selectStateImport(sharedStateReadonlyDatabase(filename), collection);
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  }
}

/**
 * Import a legacy store's rows as a new collection in one `BEGIN IMMEDIATE`
 * transaction. The rows are read back inside the transaction and their count
 * and digest compared with what the caller parsed; a mismatch rolls back and
 * leaves the database unmarked. An existing import record makes this a no-op,
 * checked after the write lock is held, so concurrent importers import once.
 */
export function importStateCollection(filename: string, input: {
  collection: string;
  schemaVersion: number;
  migrationId: string;
  rows: readonly StateImportRow[];
  sourceName: string;
  sourceSha256: string | null;
  sourceBytes: number;
  gap: string | null;
  release: string | null;
  /** Test seam: runs inside the transaction after the rows are written. */
  beforeVerify?: (execute: (sql: string, ...bindings: SQLQueryBindings[]) => void) => void;
}): { imported: boolean; record: StateImportRecord } {
  const encoded = input.rows.map((row) => ({ ...row, valueJson: JSON.stringify(row.value) }));
  const seen = new Set<string>();
  for (const row of encoded) {
    if (!row.key || seen.has(row.key)) throw new Error(`duplicate or empty ${input.collection} import key: ${row.key}`);
    seen.add(row.key);
  }
  const expectedDigest = stateRowDigest(encoded.map((row) => row.valueJson));
  const db = openDatabase(filename);
  try {
    const outcome = withImmediateTransaction(db, `${input.collection} import is busy`, () => {
      assertSqliteWriteAuthority(filename);
      const held = selectStateImport(db, input.collection);
      if (held) return { imported: false, record: held };
      if (db.query("SELECT 1 FROM state_collections WHERE collection = ?").get(input.collection)) {
        throw new StateImportVerificationError(`${input.collection} collection exists without import evidence`);
      }
      const revision = encoded.length > 0 ? 1 : 0;
      const importedAt = new Date().toISOString();
      db.query(`
        INSERT INTO state_collections(collection, schema_version, revision, migration_id, imported_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.collection, input.schemaVersion, revision, input.migrationId, importedAt);
      const insert = db.query(`
        INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      encoded.forEach((row, index) => {
        insert.run(input.collection, row.key, row.valueJson, index, revision, row.controllerActive ? 1 : 0);
      });
      input.beforeVerify?.((sql, ...bindings) => { db.query(sql).run(...bindings); });
      const stored = db.query<{ value_json: string }, [string]>(
        "SELECT value_json FROM state_rows WHERE collection = ? ORDER BY row_order, row_key",
      ).all(input.collection).map((row) => row.value_json);
      const storedDigest = stateRowDigest(stored);
      if (stored.length !== encoded.length || storedDigest !== expectedDigest) {
        throw new StateImportVerificationError(
          `${input.collection} import verification failed: ${stored.length}/${encoded.length} rows, digest mismatch=${storedDigest !== expectedDigest}`,
        );
      }
      db.query(`
        INSERT INTO state_imports(collection, source_name, source_sha256, source_bytes, row_count, row_digest, gap, release, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.collection, input.sourceName, input.sourceSha256, input.sourceBytes, encoded.length,
        storedDigest, input.gap, input.release, importedAt);
      assertSqliteWriteAuthority(filename);
      return { imported: true, record: selectStateImport(db, input.collection)! };
    });
    secureDatabaseFiles(filename);
    return outcome;
  } finally {
    db.close();
  }
}

/**
 * Rebuild a collection from its legacy source, replacing the rows and the
 * import record an earlier, stale import left (#1905). Same verified,
 * single-transaction shape as {@link importStateCollection}: the rows are read
 * back and compared before the commit, so a mismatch rolls the replacement
 * back and leaves the stale rows exactly as they were.
 *
 * The collection revision moves forward rather than restarting, and the change
 * log is cleared up to it, so every reader holding an older revision — in this
 * process or another — takes a full snapshot instead of replaying changes
 * against rows that are no longer there.
 */
export function reimportStateCollection(filename: string, input: {
  collection: string;
  schemaVersion: number;
  migrationId: string;
  rows: readonly StateImportRow[];
  sourceName: string;
  sourceSha256: string | null;
  sourceBytes: number;
  gap: string | null;
  release: string | null;
  /** Test seam: runs inside the transaction after the rows are written. */
  beforeVerify?: (execute: (sql: string, ...bindings: SQLQueryBindings[]) => void) => void;
}): { record: StateImportRecord } {
  const encoded = input.rows.map((row) => ({ ...row, valueJson: JSON.stringify(row.value) }));
  const seen = new Set<string>();
  for (const row of encoded) {
    if (!row.key || seen.has(row.key)) throw new Error(`duplicate or empty ${input.collection} import key: ${row.key}`);
    seen.add(row.key);
  }
  const expectedDigest = stateRowDigest(encoded.map((row) => row.valueJson));
  const db = openDatabase(filename);
  try {
    const outcome = withImmediateTransaction(db, `${input.collection} import is busy`, () => {
      assertSqliteWriteAuthority(filename);
      const held = selectStateImport(db, input.collection);
      if (!held) throw new StateImportVerificationError(`${input.collection} has no import record to replace`);
      if (held.mirrorSha256 !== null || held.mirrorRevision !== null) {
        throw new StateImportVerificationError(`${input.collection} carries a rollback mirror and may not be re-imported`);
      }
      const previous = db.query<{ revision: number }, [string]>(
        "SELECT revision FROM state_collections WHERE collection = ?",
      ).get(input.collection)?.revision ?? 0;
      const revision = previous + 1;
      const importedAt = new Date().toISOString();
      db.query("DELETE FROM state_changes WHERE collection = ?").run(input.collection);
      db.query("DELETE FROM state_rows WHERE collection = ?").run(input.collection);
      db.query(`
        UPDATE state_collections
        SET schema_version = ?, revision = ?, change_floor = ?, migration_id = ?, imported_at = ?
        WHERE collection = ?
      `).run(input.schemaVersion, revision, revision, input.migrationId, importedAt, input.collection);
      const insert = db.query(`
        INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      encoded.forEach((row, index) => {
        insert.run(input.collection, row.key, row.valueJson, index, revision, row.controllerActive ? 1 : 0);
      });
      input.beforeVerify?.((sql, ...bindings) => { db.query(sql).run(...bindings); });
      const stored = db.query<{ value_json: string }, [string]>(
        "SELECT value_json FROM state_rows WHERE collection = ? ORDER BY row_order, row_key",
      ).all(input.collection).map((row) => row.value_json);
      const storedDigest = stateRowDigest(stored);
      if (stored.length !== encoded.length || storedDigest !== expectedDigest) {
        throw new StateImportVerificationError(
          `${input.collection} re-import verification failed: ${stored.length}/${encoded.length} rows, digest mismatch=${storedDigest !== expectedDigest}`,
        );
      }
      db.query(`
        UPDATE state_imports
        SET source_name = ?, source_sha256 = ?, source_bytes = ?, row_count = ?, row_digest = ?,
            gap = ?, release = ?, imported_at = ?
        WHERE collection = ?
      `).run(input.sourceName, input.sourceSha256, input.sourceBytes, encoded.length, storedDigest,
        input.gap, input.release, importedAt, input.collection);
      assertSqliteWriteAuthority(filename);
      return { record: selectStateImport(db, input.collection)! };
    });
    secureDatabaseFiles(filename);
    return outcome;
  } finally {
    db.close();
  }
}

/** Record the rollback mirror last written for a collection. Evidence only, so
    it is written during a release fence, when collection writes are refused. */
export function recordStateImportMirror(filename: string, collection: string, mirrorSha256: string | null, mirrorRevision: number | null): void {
  const db = connectDatabase(filename);
  try {
    withImmediateTransaction(db, `${collection} import is busy`, () => {
      db.query("UPDATE state_imports SET mirror_sha256 = ?, mirror_revision = ? WHERE collection = ?")
        .run(mirrorSha256, mirrorRevision, collection);
    });
  } finally {
    db.close();
  }
}

/** A cheap invalidation signature that also observes uncheckpointed WAL writes. */
export function stateDatabaseSignature(filename: string): string {
  const parts = [filename];
  for (const candidate of [filename, `${filename}-wal`]) {
    try {
      const stat = fs.statSync(candidate, { bigint: true });
      parts.push(`${path.basename(candidate)}:${stat.mtimeNs}:${stat.size}`);
    } catch {
      parts.push(`${path.basename(candidate)}:missing`);
    }
  }
  return parts.join("|");
}

type EvidenceVersionReader = { identity: string; db: ReturnType<typeof connectReadonlyDatabase>; generation: number };
// Retirement witnesses are shared across compiled bundles; their version
// connection and generation must have the same owner.
const evidenceOwner = process as typeof process & { __llvStateEvidenceVersion?: { reader?: EvidenceVersionReader; generation: number } };
const evidenceVersions = evidenceOwner.__llvStateEvidenceVersion ??= { generation: 0 };
/** A dedicated read-only connection observes every committed write, including
 * writes that bypass collection revisions and change journals. Its generation
 * and inode prevent reuse after replacement or a switch of state directory. */
export function stateEvidenceVersion(filename: string): string {
  let identity: string;
  try {
    const stat = fs.statSync(filename, { bigint: true });
    identity = `${filename}:${stat.dev}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    evidenceVersions.reader?.db.close(); evidenceVersions.reader = undefined;
    return "missing";
  }
  if (evidenceVersions.reader?.identity !== identity) {
    evidenceVersions.reader?.db.close();
    evidenceVersions.reader = undefined;
    evidenceVersions.reader = { identity, db: connectReadonlyDatabase(filename), generation: ++evidenceVersions.generation };
  }
  const reader = evidenceVersions.reader;
  const version = reader.db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  const schema = reader.db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version;
  return `${reader.generation}:${version}:${schema}`;
}

/* Schema readiness per file and schema_version. Every schema edit moves
   schema_version, and a replaced file has another identity. */
const evidenceSchemaMemo = evidenceOwner as typeof evidenceOwner & { __llvPipelineEvidenceSchema?: { key: string; ready: boolean } };
function evidenceIndexReadyAt(db: Database, key: string): boolean {
  if (evidenceSchemaMemo.__llvPipelineEvidenceSchema?.key !== key) {
    evidenceSchemaMemo.__llvPipelineEvidenceSchema = { key, ready: pipelineEvidenceSchemaReady(db) };
  }
  return evidenceSchemaMemo.__llvPipelineEvidenceSchema.ready
    && Boolean(db.query("SELECT 1 FROM pipeline_evidence_clock WHERE id=1").get());
}

/** The index's validity is checked against the actual trigger definitions.
 * Schema loss or an older store takes the complete reader path. Opening the
 * state database and checking its schema cost about 16 ms on a production
 * copy, and one startup admission asks two or three times; the persistent
 * version connection answers it, and the schema check runs once per
 * schema_version. */
export function pipelineEvidenceRevision(filename: string): string | null {
  if (!fs.existsSync(filename)) return null;
  if (stateEvidenceVersion(filename) === "missing" || !evidenceVersions.reader) return null;
  const { db, identity } = evidenceVersions.reader;
  const schema = db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version;
  if (!evidenceIndexReadyAt(db, `${identity}:${schema}`)) return null;
  const clock = db.query<{ revision: number }, []>("SELECT revision FROM pipeline_evidence_clock WHERE id=1").get();
  return clock ? `${identity.slice(filename.length + 1)}:${schema}:${clock.revision}` : null;
}

export type CompactEvidenceCache<T> = { identity: string; sourceRevision?: number; rows: Map<string, { revision: number; value: T }> };

/** Revalidate only changed rows, against one consistent snapshot. The caller
 * supplies a compact projection; this cache never retains historical JSON. */
export async function readCompactPipelineEvidence<T>(filename: string, prior: CompactEvidenceCache<T> | undefined,
  project: (record: unknown, collection: string) => T,
  options: { signal?: AbortSignal; deadline?: number } = {}): Promise<CompactEvidenceCache<T> | null> {
  const assertActive = () => {
    options.signal?.throwIfAborted();
    if (options.deadline !== undefined && performance.now() >= options.deadline) {
      throw new FileTransactionBusyError("pipeline evidence preparation deadline exceeded");
    }
  };
  assertActive();
  if (!fs.existsSync(filename)) return null;
  // Bind the cache key to the file opened for this snapshot. A pathname stat
  // taken only after BEGIN can observe a replacement inode while SQLite keeps
  // reading the original one.
  const openedIdentity = databaseFileIdentity(filename);
  const db = connectReadonlyDatabase(filename);
  try {
    db.exec("BEGIN");
    const schema = db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version;
    if (!evidenceIndexReadyAt(db, `${filename}:${openedIdentity}:${schema}`)) return null;
    if (databaseFileIdentity(filename) !== openedIdentity) throw new StateSnapshotChangedError();
    const identity = `${openedIdentity}:${schema}`;
    const collections = db.query<{ collection: string }, []>("SELECT collection FROM state_collections WHERE collection IN ('pipelines','pipelines_archive')").all();
    if (collections.length !== 2) return null;
    const sourceRevision = db.query<{ revision: number }, []>("SELECT revision FROM pipeline_evidence_clock WHERE id=1").get()!.revision;
    if (prior?.identity === identity && prior.sourceRevision === sourceRevision) return prior;
    const rows = new Map<string, { revision: number; value: T }>();
    const incremental = prior?.identity === identity && prior.sourceRevision !== undefined && prior.sourceRevision <= sourceRevision;
    let slice = performance.now();
    const yieldIfNeeded = async () => {
      await performanceSpans.wait("pipeline.yield", () => new Promise<void>(resolve => setTimeout(resolve, 0)));
      assertActive();
      slice = performance.now();
    };
    // Readers retain their old snapshot. Copy only compact references, with
    // timer opportunities; source queries below visit only changed identities.
    if (incremental) for (const [key, value] of prior.rows) { rows.set(key, value); if (performance.now() - slice >= 4) await yieldIfNeeded(); }
    const read = db.query<{ value_json: string }, [string, string]>("SELECT value_json FROM state_rows WHERE collection=? AND row_key=?");
    const headers = incremental
      ? db.query<{ collection: string; row_key: string; revision: number; present: string | null }, [number]>(`SELECT e.collection,e.row_key,e.revision,r.row_key AS present
          FROM pipeline_evidence_rows e INDEXED BY pipeline_evidence_changed LEFT JOIN state_rows r
          ON r.collection=e.collection AND r.row_key=e.row_key
          WHERE e.revision>? AND e.collection IN ('pipelines','pipelines_archive') ORDER BY e.revision,e.collection,e.row_key`).iterate(prior.sourceRevision!)
      : db.query<{ collection: string; row_key: string; revision: number; present: string | null }, []>(`SELECT r.collection,r.row_key,COALESCE(e.revision,-1) AS revision,r.row_key AS present
          FROM state_rows r LEFT JOIN pipeline_evidence_rows e ON e.collection=r.collection AND e.row_key=r.row_key
          WHERE r.collection IN ('pipelines','pipelines_archive') ORDER BY r.collection,r.row_order,r.row_key`).iterate();
    for (const header of headers) {
      assertActive();
      const key = JSON.stringify([header.collection, header.row_key]);
      if (header.present === null) rows.delete(key);
      else {
        const raw = performanceSpans.sync("state.sql-next", () => read.get(header.collection, header.row_key))!.value_json;
        let value: unknown;
        try { value = performanceSpans.sync("state.json", () => parseSqliteJson(raw, db), 1, Buffer.byteLength(raw)); }
        catch (error) { throw new Error(`corrupt ${header.collection} SQLite row: ${header.row_key}`, { cause: error }); }
        rows.set(key, { revision: header.revision, value: project(value, header.collection) });
      }
      if (performance.now() - slice >= 4) await yieldIfNeeded();
    }
    return { identity, rows, sourceRevision };
  } finally { rollbackQuietly(db); db.close(); }
}

/** Read raw authoritative rows for compatibility projections, with JSON fallback before migration. */
export function readStateCollectionRows(filename: string, collection: string): unknown[] | null {
  return readStateCollectionsRows(filename, [collection]).get(collection) ?? null;
}

/** Return project membership without decoding or materializing persisted rows. */
export function readStateProjectKeys(filename: string): string[] {
  if (!fs.existsSync(filename)) return [];
  const db = connectReadonlyDatabase(filename);
  try {
    return db.query<{ project: string | null }, []>(`
      SELECT DISTINCT json_extract(value_json, '$.project') AS project
      FROM state_rows
      WHERE collection IN ('tasks', 'pipelines', 'flows')
        AND json_valid(value_json)
        AND json_type(value_json, '$.project') = 'text'
    `).all().flatMap(row => row.project ? [row.project] : []);
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return [];
    throw error;
  } finally { db.close(); }
}

/** Read several authoritative collections through one snapshot connection. */
export function readStateCollectionsRows(
  filename: string,
  collections: readonly string[],
): Map<string, unknown[] | null> {
  const result = new Map<string, unknown[] | null>(collections.map((collection) => [collection, null]));
  if (!fs.existsSync(filename) || collections.length === 0) return result;
  const db = sharedStateReadonlyDatabase(filename);
  try {
    const placeholders = collections.map(() => "?").join(", ");
    const rows = db.query<{
      collection: string;
      row_key: string | null;
      value_json: string | null;
    }, SQLQueryBindings[]>(`
      SELECT collections.collection, rows.row_key, rows.value_json
      FROM state_collections AS collections
      LEFT JOIN state_rows AS rows ON rows.collection = collections.collection
      WHERE collections.collection IN (${placeholders})
      ORDER BY collections.collection, rows.row_order, rows.row_key
    `).all(...collections as SQLQueryBindings[]);
    for (const row of rows) {
      const records = result.get(row.collection) ?? [];
      result.set(row.collection, records);
      if (row.row_key === null || row.value_json === null) continue;
      try { records.push(parseSqliteJson(row.value_json, db) as unknown); }
      catch (error) {
        throw new Error(`corrupt ${row.collection} SQLite row: ${row.row_key}`, { cause: error });
      }
    }
    return result;
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return result;
    throw error;
  }
}

/** A complete read-only snapshot, decoded one row at a time with actual
    timer opportunities. No writer lease is held across the read. */
export async function visitStateCollectionsRows(
  filename: string,
  collections: readonly string[],
  visit: (record: unknown, collection: string) => void,
  options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<Map<string, number | null>> {
  const assertActive = () => {
    options.signal?.throwIfAborted();
    if (options.deadline !== undefined && performance.now() >= options.deadline) {
      throw new FileTransactionBusyError("state evidence preparation deadline exceeded");
    }
  };
  assertActive();
  const revisions = new Map<string, number | null>(collections.map(collection => [collection, null]));
  if (!fs.existsSync(filename) || !collections.length) return revisions;
  const db = connectReadonlyDatabase(filename);
  let slice = performance.now();
  let readingRows = false;
  try {
    db.exec("BEGIN");
    const placeholders = collections.map(() => "?").join(", ");
    for (const row of db.query<{ collection: string; revision: number }, SQLQueryBindings[]>(
      `SELECT collection, revision FROM state_collections WHERE collection IN (${placeholders})`,
    ).all(...collections as SQLQueryBindings[])) revisions.set(row.collection, row.revision);
    readingRows = true;
    const rows = db.query<{ collection: string; row_key: string; value_json: string }, SQLQueryBindings[]>(
      `SELECT collection, row_key, value_json FROM state_rows WHERE collection IN (${placeholders}) ORDER BY collection, row_order, row_key`,
    ).iterate(...collections as SQLQueryBindings[]);
    const iterator = rows[Symbol.iterator]();
    for (;;) {
      assertActive();
      const next = performanceSpans.sync("state.sql-next", () => iterator.next());
      if (next.done) break;
      const row = next.value;
      let value: unknown;
      try { value = performanceSpans.sync("state.json", () => parseSqliteJson(row.value_json, db), 1, Buffer.byteLength(row.value_json)); }
      catch (error) { throw new Error(`corrupt ${row.collection} SQLite row: ${row.row_key}`, { cause: error }); }
      visit(value, row.collection);
      if (performance.now() - slice >= 4) {
        await performanceSpans.wait("pipeline.yield", () => new Promise<void>(resolve => setTimeout(resolve, 0)));
        assertActive();
        slice = performance.now();
      }
    }
    db.exec("COMMIT");
    return revisions;
  } catch (error) {
    if (!readingRows && /no such table/i.test(error instanceof Error ? error.message : String(error))) return revisions;
    throw error;
  } finally { db.close(); }
}

/** Authoritative revision for cache keys, or null until this collection migrates. */
export function readStateCollectionRevision(filename: string, collection: string): number | null {
  return readStateCollectionRevisions(filename, [collection]).get(collection) ?? null;
}

/** Read several collection revisions through one read-only connection. */
export function readStateCollectionRevisions(
  filename: string,
  collections: readonly string[],
): Map<string, number | null> {
  const revisions = new Map<string, number | null>(collections.map((collection) => [collection, null]));
  if (collections.length === 0 || !fs.existsSync(filename)) return revisions;
  const db = sharedStateReadonlyDatabase(filename);
  try {
    const placeholders = collections.map(() => "?").join(", ");
    const rows = db.query<{ collection: string; revision: number }, SQLQueryBindings[]>(`
      SELECT collection, revision FROM state_collections
      WHERE collection IN (${placeholders})
    `).all(...collections as SQLQueryBindings[]);
    for (const row of rows) revisions.set(row.collection, row.revision);
    return revisions;
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return revisions;
    throw error;
  }
}

export function resetStateReadonlyConnectionCountForTests(): void {
  readonlyConnectionCount = 0;
}

export function stateReadonlyConnectionCountForTests(): number {
  return readonlyConnectionCount;
}

type StateReadonlyReader = { filename: string; db: Database };
const stateReadonlyReaderOwner = globalThis as typeof globalThis & { __llvStateReadonlyReader?: StateReadonlyReader };

/** Release the test process's shared reader before removing its state root. */
export function resetStateReadonlyReaderForTests(): void {
  stateReadonlyReaderOwner.__llvStateReadonlyReader?.db.close();
  stateReadonlyReaderOwner.__llvStateReadonlyReader = undefined;
}

/** Shared metadata and controller statements finish synchronously. No transaction or iterator is
 * held over a yield, so all compiled consumers can share this one connection.
 * Switching directories closes the previous handle; replacement is guarded by
 * openCurrentDatabase. Row versions remain the authority across awaits. */
function sharedStateReadonlyDatabase(filename: string): Database {
  const current = stateReadonlyReaderOwner.__llvStateReadonlyReader;
  if (current?.filename === filename) return current.db;
  current?.db.close();
  stateReadonlyReaderOwner.__llvStateReadonlyReader = undefined;
  const db = connectReadonlyDatabase(filename);
  stateReadonlyReaderOwner.__llvStateReadonlyReader = { filename, db };
  return db;
}

export type OverdueTaskCursor = readonly [priority: number, dueAt: number, rowKey: string];
type OverdueTaskRow = { row_key: string; priority: number; eligible_at: number; advance: number | null };

/** Seek each eligible hold partition, then merge bounded pages in due-date
 * order. Future holds and foreign machines are excluded by index prefixes;
 * the fixed head retains daily repeats, discovery excludes known dates, and
 * the sweep excludes recent deliveries before its page limit. */
export const OVERDUE_TASK_KEYS_SQL = `
  WITH RECURSIVE owners AS (
    SELECT DISTINCT p.value AS project, m.value AS machine, q.value AS priority
    FROM json_each(?1) p, json_each(?2) m, json_each('[0,1,2]') q
  ), scopes(project, machine, priority, held_until) AS (
    SELECT project, machine, priority, -9007199254740991 FROM owners
    UNION ALL
    SELECT project, machine, priority, (
      SELECT coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0) FROM state_rows INDEXED BY state_rows_task_due
      WHERE collection='tasks' AND json_valid(value_json)
          AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
          AND json_extract(value_json,'$.status') <> 'done'
          AND json_extract(value_json,'$.project')=scopes.project
          AND coalesce(json_extract(value_json,'$.machine'),'')=scopes.machine
          AND CASE json_extract(value_json,'$.priority') WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END=scopes.priority
        AND coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0)>scopes.held_until AND coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0)<=?3
      ORDER BY coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0) LIMIT 1
    ) FROM scopes WHERE held_until IS NOT NULL
  ), pages AS MATERIALIZED (
    SELECT priority, (
      SELECT json_group_array(json_object('key', row_key, 'due', due)) FROM (
        SELECT row_key, round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) AS due
        FROM state_rows INDEXED BY state_rows_task_due
        WHERE collection='tasks' AND json_valid(value_json)
          AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
          AND json_extract(value_json,'$.status') <> 'done'
          AND json_extract(value_json,'$.project')=scopes.project
          AND coalesce(json_extract(value_json,'$.machine'),'')=scopes.machine
          AND CASE json_extract(value_json,'$.priority') WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END=scopes.priority
          AND coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0)=scopes.held_until
          AND round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) <= ?3
        ORDER BY round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000), row_key LIMIT 25
      )
    ) AS repeat_rows, (
      SELECT json_group_array(json_object('key', row_key, 'due', due)) FROM (
        SELECT row_key, round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) AS due
        FROM state_rows INDEXED BY state_rows_task_due
        WHERE collection='tasks' AND json_valid(value_json)
          AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
          AND json_extract(value_json,'$.status') <> 'done'
          AND json_extract(value_json,'$.project')=scopes.project
          AND coalesce(json_extract(value_json,'$.machine'),'')=scopes.machine
          AND CASE json_extract(value_json,'$.priority') WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END=scopes.priority
          AND coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0)=scopes.held_until
          AND round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) <= ?3
          AND row_key || ':' || CAST(round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) AS INTEGER) NOT IN (SELECT value FROM json_each(?7))
        ORDER BY round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000), row_key LIMIT 51
      )
    ) AS head_rows, (
      SELECT json_group_array(json_object('key', row_key, 'due', due)) FROM (
        SELECT row_key, round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) AS due
        FROM state_rows INDEXED BY state_rows_task_due
        WHERE collection='tasks' AND json_valid(value_json)
          AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
          AND json_extract(value_json,'$.status') <> 'done'
          AND json_extract(value_json,'$.project')=scopes.project
          AND coalesce(json_extract(value_json,'$.machine'),'')=scopes.machine
          AND CASE json_extract(value_json,'$.priority') WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END=scopes.priority
          AND coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0)=scopes.held_until
          AND round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) <= ?3
          AND scopes.priority=json_extract(?6,'$[0]') AND round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000)=json_extract(?6,'$[1]') AND row_key>json_extract(?6,'$[2]')
          AND row_key || ':' || CAST(round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) AS INTEGER) NOT IN (SELECT value FROM json_each(?4))
        ORDER BY round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000), row_key LIMIT 51
      )
    ) AS same_rows, (
      SELECT json_group_array(json_object('key', row_key, 'due', due)) FROM (
        SELECT row_key, round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) AS due
        FROM state_rows INDEXED BY state_rows_task_due
        WHERE collection='tasks' AND json_valid(value_json)
          AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
          AND json_extract(value_json,'$.status') <> 'done'
          AND json_extract(value_json,'$.project')=scopes.project
          AND coalesce(json_extract(value_json,'$.machine'),'')=scopes.machine
          AND CASE json_extract(value_json,'$.priority') WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END=scopes.priority
          AND coalesce(round((julianday(json_extract(value_json,'$.hold.until'))-2440587.5)*86400000), 0)=scopes.held_until
          AND round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) <= ?3
          AND scopes.priority >= coalesce(json_extract(?6,'$[0]'), -1) AND round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000)>CASE WHEN scopes.priority=json_extract(?6,'$[0]') THEN json_extract(?6,'$[1]') ELSE -9007199254740991 END
          AND row_key || ':' || CAST(round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000) AS INTEGER) NOT IN (SELECT value FROM json_each(?4))
        ORDER BY round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000), row_key LIMIT 51
      )
    ) AS later_rows FROM scopes WHERE held_until IS NOT NULL
  ), expanded AS MATERIALIZED (
    SELECT priority, CASE WHEN batch.key < 2 THEN batch.key ELSE 2 END AS pass,
      json_extract(item.value,'$.key') AS row_key, json_extract(item.value,'$.due') AS due
    FROM pages, json_each(json_array(repeat_rows, head_rows, same_rows, later_rows)) batch, json_each(batch.value) item
  ), head AS MATERIALIZED (
    SELECT row_key, priority, due FROM expanded WHERE pass=0 ORDER BY priority, due, row_key LIMIT 25
  ), discovery AS MATERIALIZED (
    SELECT row_key, priority, due FROM expanded WHERE pass=1 ORDER BY priority, due, row_key LIMIT 25
  ), sweep AS MATERIALIZED (
    SELECT row_key, priority, due FROM expanded WHERE pass=2 ORDER BY priority, due, row_key LIMIT 51
  ), combined AS (
    SELECT * FROM head UNION SELECT * FROM discovery UNION SELECT * FROM sweep
  )
  SELECT row_key, priority, due AS eligible_at,
    row_key=(SELECT row_key FROM sweep ORDER BY priority, due, row_key LIMIT 1) AS advance
  FROM combined ORDER BY priority, due, row_key LIMIT ?5
`;

export class SqliteStateCollection<T> {
  private readonly readDb: Database;
  private localCache: CollectionCache<T> | null = null;
  private cacheSlot?: ReadCacheSlot<CollectionCache<T>>;
  private cacheIdentity: string | null = null;
  private cacheAuthority: unknown;
  private get cache(): CollectionCache<T> | null { return this.cacheSlot ? this.cacheSlot.value : this.localCache; }

  private refreshReadCache(): CollectionReadContext {
    const identity = databaseFileIdentity(this.filename);
    const authority = this.options.decodeAuthority?.();
    if (identity !== this.cacheIdentity || authority !== this.cacheAuthority) {
      this.localCache = null;
      this.revisionCache = null;
      this.cacheIdentity = identity;
      this.cacheAuthority = authority;
    }
    const key = this.options.readCacheKey ? JSON.stringify([path.resolve(this.filename), identity,
      this.options.collection, this.options.schemaVersion, this.options.readCacheKey, authority]) : undefined;
    if (key) this.cacheSlot = collectionReadCache(key, this.options.collection === "pipelines_archive");
    return { identity, authority, key };
  }

  private assertReadContext(context: CollectionReadContext): void {
    if (databaseFileIdentity(this.filename) !== context.identity || this.options.decodeAuthority?.() !== context.authority) {
      throw new StateSnapshotChangedError();
    }
  }

  /** Publish only after a successful read, under the context that decoded it.
      Reacquire its verified key in case other readers evicted the slot. */
  private publishCache(value: CollectionCache<T>, context: CollectionReadContext): readonly T[] {
    this.assertReadContext(context);
    if (context.key) {
      this.cacheSlot = collectionReadCache(context.key, this.options.collection === "pipelines_archive");
      let bytes = 0;
      for (const row of value.records.values()) bytes += row.sourceBytes;
      rememberCollectionReadCache(this.cacheSlot, value, bytes);
    } else this.localCache = value;
    this.revisionCache = null;
    return value.ordered;
  }

  private commitReadCache(value: CollectionCache<T>, context: CollectionReadContext): readonly T[] {
    this.readDb.exec("COMMIT");
    return this.publishCache(value, context);
  }
  private revisionCache: { signature: string; revision: number } | null = null;
  private readonly controllerCacheIdentity = crypto.randomUUID();

  constructor(readonly filename: string, private readonly options: SqliteStateCollectionOptions<T>) {
    this.readDb = openDatabase(filename);
    try {
      const meta = this.collectionMeta();
      if (!meta) throw new Error(`SQLite state collection is not initialized: ${options.collection}`);
      if (meta.schema_version !== options.schemaVersion) {
        throw new Error(`unsupported ${options.collection} SQLite schema: ${meta.schema_version}`);
      }
    } catch (error) {
      this.readDb.close();
      throw error;
    }
  }

  revision(): number {
    this.refreshReadCache();
    const signature = stateDatabaseSignature(this.filename);
    if (this.revisionCache?.signature === signature) return this.revisionCache.revision;
    const revision = this.collectionMeta()?.revision ?? 0;
    const after = stateDatabaseSignature(this.filename);
    if (after === signature) this.revisionCache = { signature: after, revision };
    return revision;
  }

  signature(): string {
    return `${this.filename}:${this.options.collection}:${this.revision()}`;
  }

  snapshot(): T[] {
    return this.loadReadonly().map((record) => this.options.clone(record));
  }

  async snapshotAsync(): Promise<T[]> {
    return mapCooperatively(await this.loadReadonlyAsync(), record => this.options.clone(record), { batchSize: 4, timeBudgetMs: 16 });
  }

  /** Cold fills use bounded pages; warm readers keep the same revision cache. */
  async loadReadonlyAsync(): Promise<readonly T[]> {
    const revision = this.revision();
    const context = this.refreshReadCache();
    const meta = this.collectionMeta()!;
    if (!this.cache || this.cache.revision > revision || this.cache.revision < meta.change_floor) {
      const records = new Map<string, CachedRecord<T>>();
      let order = -1, key = "";
      for (;;) {
        const rows = withViewerOperation("pipelines.controller-read", () => this.readDb.query<CollectionRow,
          [string, number, number, string, number]>(`
          SELECT row_key, value_json, row_order, row_revision, controller_active FROM state_rows
          WHERE collection = ? AND row_order >= ? AND (row_order > ? OR row_key > ?)
          ORDER BY row_order, row_key LIMIT ?
        `).all(this.options.collection, order, order, key, 16));
        await mapCooperatively(rows, row => {
          const value = withViewerOperation("pipelines.controller-decode", () => this.decodeRow(row.value_json));
          if (value !== null) records.set(row.row_key, { value, sourceBytes: row.value_json.length * 2, rowRevision: row.row_revision, order: row.row_order });
          order = row.row_order; key = row.row_key;
        }, { batchSize: 4, timeBudgetMs: 16 });
        if (rows.length < 16) break;
        await yieldToRuntime();
      }
      if (this.revision() !== revision) throw new StateSnapshotChangedError();
      const source = this.publishCache(this.createCache(revision, records), context);
      return source;
    }
    return this.loadReadonly();
  }

  /** The indexed maximum records this pass's provisioning boundary without
      reading payloads or constructing a collection census. */
  pipelineControllerRowOrder(): number {
    if (this.options.collection !== "pipelines") throw new Error("pipeline selection requires the pipeline collection");
    return sharedStateReadonlyDatabase(this.filename).query<{ last: number }, []>(
      "SELECT COALESCE(MAX(row_order), -1) AS last FROM state_rows WHERE collection = 'pipelines'",
    ).get()!.last;
  }

  pipelineControllerVersion(key: string): string {
    const row = sharedStateReadonlyDatabase(this.filename).query<{ row_revision: number; generation: number | null }, [string]>(`
      SELECT r.row_revision,w.generation FROM state_rows r LEFT JOIN pipeline_tick_work w ON w.row_key=r.row_key
      WHERE r.collection='pipelines' AND r.row_key=?`).get(key);
    return `${databaseFileIdentity(this.filename)}:${row?.row_revision ?? "missing"}:${row?.generation ?? "missing"}`;
  }

  pipelineControllerCandidate(key: string): T | null {
    const row = sharedStateReadonlyDatabase(this.filename).query<{ row_revision: number }, [string, string]>(
      "SELECT row_revision FROM state_rows WHERE collection=? AND row_key=?").get(this.options.collection, key);
    return row ? this.controllerRow(key, row.row_revision) : null;
  }

  pipelineTickWork(now: number, excluded: readonly string[], limit = 4): PipelineTickWork[] {
    return selectPipelineTickWork(sharedStateReadonlyDatabase(this.filename), now, excluded, limit);
  }

  pipelineAttemptWindow(key: string, after: number, limit: number): PipelineAttemptReference[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("invalid controller attempt budget");
    const tail = sharedStateReadonlyDatabase(this.filename).query<PipelineAttemptReference, [string, number, number]>(`SELECT * FROM pipeline_attempt_refs
      WHERE row_key=? AND position>? ORDER BY position LIMIT ?`).all(key, after, limit);
    if (tail.length < limit) tail.push(...sharedStateReadonlyDatabase(this.filename).query<PipelineAttemptReference, [string, number, number]>(`SELECT * FROM pipeline_attempt_refs
      WHERE row_key=? AND position<=? ORDER BY position LIMIT ?`).all(key, after, limit-tail.length));
    return tail;
  }

  pipelineOtherTerminalHosts(key: string, selected: readonly number[]): boolean {
    return Boolean(sharedStateReadonlyDatabase(this.filename).query(`SELECT 1 FROM pipeline_attempt_refs WHERE row_key=? AND terminal=1 AND firstHost=1
      AND position NOT IN (SELECT value FROM json_each(?)) LIMIT 1`).get(key,JSON.stringify(selected)));
  }

  pipelineCurrentReferences(key: string, stage: string): PipelineAttemptReference[] {
    return sharedStateReadonlyDatabase(this.filename).query<PipelineAttemptReference, [string, string]>(`SELECT * FROM pipeline_attempt_refs
      WHERE row_key=? AND stageId=? AND historical=0 ORDER BY position DESC LIMIT 1`).all(key,stage);
  }

  pipelineOwnerExists(identities: readonly [string, string][], live: boolean): boolean {
    return identities.some(([kind, identity]) => Boolean(sharedStateReadonlyDatabase(this.filename).query(`SELECT 1 FROM pipeline_owner_refs
      WHERE kind=? AND identity=? ${live ? "AND live=1" : ""} LIMIT 1`).get(kind,identity)));
  }

  pipelineTickReady(now: number, excluded: readonly string[]): boolean {
    return Boolean(sharedStateReadonlyDatabase(this.filename).query(`SELECT 1 FROM pipeline_tick_work
      WHERE (dirty=1 OR due_at<=?) AND row_key NOT IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(now, JSON.stringify(excluded)));
  }

  async acknowledgePipelineTick(work: PipelineTickWork, cursor: number, dueAt: number): Promise<void> {
    await stateTransactionAsync(this.filename, "pipelines.controller-schedule", db => {
      db.query("UPDATE pipeline_tick_work SET attempt_cursor=? WHERE row_key=?").run(cursor, work.row_key);
      db.query("UPDATE pipeline_tick_work SET dirty=0,due_at=? WHERE row_key=? AND generation=?")
        .run(dueAt, work.row_key, work.generation);
      db.query(`DELETE FROM pipeline_tick_work WHERE row_key=? AND generation=? AND NOT EXISTS
        (SELECT 1 FROM state_rows WHERE collection='pipelines' AND row_key=? AND controller_active=1)
        AND NOT EXISTS (SELECT 1 FROM pipeline_controller_work WHERE row_key=?)`)
        .run(work.row_key, work.generation, work.row_key, work.row_key);
      db.query("UPDATE pipeline_tick_cursor SET row_order=?,row_key=? WHERE id=1").run(work.row_order, work.row_key);
    });
  }

  async deferPipelineTick(work: PipelineTickWork): Promise<void> {
    await stateTransactionAsync(this.filename, "pipelines.controller-schedule", db => {
      db.query("UPDATE pipeline_tick_work SET dirty=1,due_at=0 WHERE row_key=? AND generation=?")
        .run(work.row_key, work.generation);
      db.query("UPDATE pipeline_tick_cursor SET row_order=?,row_key=? WHERE id=1").run(work.row_order, work.row_key);
    });
  }

  /** Shared with selectors and detached reconciliation, keyed by the SQLite
      row revision, file identity and decoder authority. Pipeline LRU: 64 rows;
      other collections: 512 rows. Each slot retains at most 16 MiB. */
  private controllerRow(key: string, revision: number, db = sharedStateReadonlyDatabase(this.filename), identity = databaseFileIdentity(this.filename), authority = this.options.decodeAuthority?.()): T | null {
    const cacheKey = JSON.stringify([this.filename, this.options.collection, "controller-v1", this.options.readCacheKey ?? this.controllerCacheIdentity,
      identity, authority]);
    const slot = collectionReadCache<Map<string, { revision: number; value: T | null; bytes: number }>>(cacheKey);
    const cache = slot.value ?? new Map<string, { revision: number; value: T | null; bytes: number }>();
    let held = cache.get(key);
    if (held?.revision !== revision) {
      const row = db.query<{ value_json: string; row_revision: number }, [string, string]>(
        "SELECT value_json,row_revision FROM state_rows WHERE collection=? AND row_key=?").get(this.options.collection, key);
      if (!row || row.row_revision !== revision) throw new StateSnapshotChangedError();
      const value = withViewerOperation("pipelines.controller-decode", () => this.decodeRow(row.value_json, db));
      const freeze = (item: unknown): void => {
        if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
        Object.freeze(item);
        for (const child of Object.values(item)) freeze(child);
      };
      performanceSpans.sync("pipeline.shared", () => freeze(value));
      held = { revision, value, bytes: row.value_json.length * 2 };
    }
    cache.delete(key); cache.set(key, held);
    let bytes = 0;
    for (const row of cache.values()) bytes += row.bytes;
    const entries = this.options.collection === "pipelines" ? 64 : 512;
    while (cache.size > entries || bytes > 16 * 1024 * 1024) {
      const oldest = cache.keys().next().value!;
      bytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
    }
    rememberCollectionReadCache(slot, cache, bytes);
    return held.value;
  }

  /** A candidate projection reads only indexed work, preserving collection
      order. A private read transaction pins flags and payloads together while
      peer writers commit; decoding yields between batches. Observation-only
      hosts/running selectors share immutable candidates; other selectors keep
      detached copies, limited to the controller's attempt window when scoped.
      Actuation still belongs to the caller's existing admission fences. */
  async pipelineControllerSelection(kind: PipelineControllerSelection, throughOrder = Number.MAX_SAFE_INTEGER, keys?: readonly string[]): Promise<T[]> {
    if (this.options.collection !== "pipelines") throw new Error("pipeline selection requires the pipeline collection");
    const identity = databaseFileIdentity(this.filename), authority = this.options.decodeAuthority?.();
    const db = keys ? sharedStateReadonlyDatabase(this.filename) : connectReadonlyDatabase(this.filename);
    try {
      if (!keys) db.exec("BEGIN");
      const records: T[] = [];
      let order = -1, key = "";
      for (;;) {
        const rows = withViewerOperation("pipelines.controller-select", () => (keys ? sharedStateReadonlyDatabase(this.filename) : db).query<
          Pick<CollectionRow, "row_key" | "row_order" | "row_revision">, SQLQueryBindings[]>(`
          SELECT w.row_key, w.row_order, r.row_revision FROM pipeline_controller_work w
          ${keys ? "INDEXED BY sqlite_autoindex_pipeline_controller_work_1" : ""}
          JOIN state_rows r ON r.collection = 'pipelines' AND r.row_key = w.row_key
          WHERE w.kind = ? AND w.row_order >= ? AND (w.row_order > ? OR w.row_key > ?) AND w.row_order <= ?
          ${keys ? "AND w.row_key IN (SELECT value FROM json_each(?))" : ""}
          ORDER BY w.row_order, w.row_key LIMIT ?
        `).all(kind, order, order, key, throughOrder, ...(keys ? [JSON.stringify(keys)] : []), 16));
        await mapCooperatively(rows, row => {
          const decoded = this.controllerRow(row.row_key, row.row_revision, keys ? sharedStateReadonlyDatabase(this.filename) : db, identity, authority);
          if (decoded) records.push(kind === "hosts" || kind === "running" ? decoded
            : performanceSpans.sync("pipeline.copy", () => (this.options.cloneController ?? this.options.clone)(decoded)));
          order = row.row_order; key = row.row_key;
        }, { batchSize: 4, timeBudgetMs: 16 });
        if (rows.length < 16) break;
        await yieldToRuntime();
      }
      if (!keys) db.exec("COMMIT");
      if (databaseFileIdentity(this.filename) !== identity || this.options.decodeAuthority?.() !== authority) throw new StateSnapshotChangedError();
      return records;
    } catch (error) { if (!keys) rollbackQuietly(db); throw error; }
    finally { if (!keys) db.close(); }
  }

  snapshotForController(): T[] {
    return this.loadControllerReadonly().map((record) => this.options.clone(record));
  }

  /** Seek the supplied keys before sorting their metadata. No payload is read
      or decoded here; callers retain collection order for a bounded selection. */
  keysInOrder(rowKeys: readonly string[], limit: number): string[] {
    if (!rowKeys.length || limit <= 0) return [];
    return this.readDb.query<{ row_key: string }, [string, string, number]>(`
      SELECT DISTINCT r.row_key, r.row_order FROM json_each(?) AS wanted CROSS JOIN state_rows AS r
      WHERE r.collection = ? AND r.row_key = wanted.value
      ORDER BY r.row_order, r.row_key LIMIT ?
    `).all(JSON.stringify(rowKeys), this.options.collection, limit).map(row => row.row_key);
  }

  /** Open finding rows for one project/key pair, using the task finding index
      to avoid decoding unrelated collection history. */
  findingTaskKeys(project: string, findingKey: string): string[] {
    return this.readDb.query<{ row_key: string }, [string, string]>(`
      SELECT row_key FROM state_rows INDEXED BY state_rows_task_finding
      WHERE collection='tasks' AND json_valid(value_json)
        AND json_type(value_json,'$.findingKey')='text' AND json_type(value_json,'$.status')='text'
        AND json_extract(value_json,'$.status') <> 'done'
        AND json_extract(value_json,'$.project')=? AND json_extract(value_json,'$.findingKey')=?
      ORDER BY row_order, row_key
    `).all(project, findingKey).map(row => row.row_key);
  }

  /** One indexed read; rejected holds and remote rows never reach the decoder. */
  overdueTaskKeys(projects: readonly string[], nowMs: number, limit = 51, machine: string | null = null, shown: readonly string[] = [], cursor: OverdueTaskCursor | null = null, known: readonly string[] = shown): string[] {
    return this.overdueTaskRows(projects, nowMs, limit, machine, shown, cursor, known).map(row => row.row_key);
  }

  overdueTaskRows(projects: readonly string[], nowMs: number, limit = 51, machine: string | null = null, shown: readonly string[] = [], cursor: OverdueTaskCursor | null = null, known: readonly string[] = shown): OverdueTaskRow[] {
    if (!projects.length) return [];
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(limit) || limit < 1 || limit > 51) throw new Error("invalid overdue task selection");
    const machines = machine ? ["", machine] : [""];
    return this.readDb.query<OverdueTaskRow, [string, string, number, string, number, string, string]>(OVERDUE_TASK_KEYS_SQL)
      .all(JSON.stringify([...new Set(projects)]), JSON.stringify(machines), nowMs, JSON.stringify(shown), limit, JSON.stringify(cursor), JSON.stringify(known));
  }

  /** Release an evicted document owner's connection. */
  close(): void {
    this.readDb.close();
    this.localCache = null;
    this.revisionCache = null;
  }

  /** Keyset page over a collection's primary key; no unrelated payload reads. */
  keyPage(after: string, limit: number): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new Error("invalid state page limit");
    return this.readDb.query<{ value_json: string }, [string, string, number]>(`
      SELECT value_json FROM state_rows
      WHERE collection = ? AND row_key > ? ORDER BY row_key LIMIT ?
    `).all(this.options.collection, after, limit).map(row => this.decodeRow(row.value_json)).filter((row): row is T => row !== null).map(row => this.options.clone(row));
  }

  get(rowKey: string): T | null {
    const row = this.readDb.query<Pick<CollectionRow, "value_json">, [string, string]>(
      "SELECT value_json FROM state_rows WHERE collection = ? AND row_key = ?",
    ).get(this.options.collection, rowKey);
    if (!row) return null;
    const decoded = this.decodeRow(row.value_json);
    return decoded === null ? null : this.options.clone(decoded);
  }

  /** Cold history never warms the full collection cache. Pages are pinned by
      one read transaction; a callback may select a bounded subset. */
  async selectReadonlyAsync(select: (record: T) => boolean, limit: number): Promise<T[]> {
    const db = connectReadonlyDatabase(this.filename);
    const authority = this.options.decodeAuthority?.();
    try {
      db.exec("BEGIN");
      const selected: T[] = [];
      let order = -1, key = "";
      while (selected.length < limit) {
        const rows = db.query<CollectionRow, [string, number, number, string, number]>(`
          SELECT row_key, value_json, row_order, row_revision FROM state_rows
          WHERE collection = ? AND row_order >= ? AND (row_order > ? OR row_key > ?)
          ORDER BY row_order, row_key LIMIT ?
        `).all(this.options.collection, order, order, key, Math.min(16, limit - selected.length));
        for (const row of rows) {
          order = row.row_order; key = row.row_key;
          const decoded = this.decodeRow(row.value_json, db);
          if (decoded !== null && select(decoded)) selected.push(this.options.clone(decoded));
        }
        if (!rows.length) break;
        await yieldToRuntime();
      }
      if (this.options.decodeAuthority?.() !== authority) throw new StateSnapshotChangedError();
      db.exec("COMMIT");
      return selected;
    } catch (error) { rollbackQuietly(db); throw error; }
    finally { db.close(); }
  }

  /** One read transaction over the change log strictly after `(revision,
      key)`, in `(revision, row_key)` order, joined to each row's current
      value (null once deleted). An empty `key` means the whole of `revision`
      is behind the caller. Reads nothing when the collection revision equals
      `revision` and no key is given. */
  changesAfter(revision: number, key: string, limit: number): ChangeLogPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new Error("invalid state page limit");
    this.readDb.exec("BEGIN");
    try {
      const meta = this.readDb.query<{ revision: number; change_floor: number }, [string]>(
        "SELECT revision, change_floor FROM state_collections WHERE collection = ?",
      ).get(this.options.collection);
      if (!meta) throw new Error(`SQLite state collection disappeared: ${this.options.collection}`);
      const entries = meta.revision === revision && !key ? [] : this.readDb.query<{ revision: number; row_key: string; operation: "upsert" | "delete"; value_json: string | null; row_revision: number | null }, [string, number, number, string, number, number]>(`
        SELECT c.revision, c.row_key, c.operation, r.value_json, r.row_revision FROM state_changes c
        LEFT JOIN state_rows r ON r.collection = c.collection AND r.row_key = c.row_key
        WHERE c.collection = ? AND (c.revision > ? OR (c.revision = ? AND c.row_key > ?)) AND c.revision <= ?
        ORDER BY c.revision, c.row_key LIMIT ?
      `).all(this.options.collection, revision, key ? revision : -1, key, meta.revision, limit).map((row) => ({
        revision: row.revision, key: row.row_key, operation: row.operation, valueJson: row.value_json, rowRevision: row.row_revision,
      }));
      this.readDb.exec("COMMIT");
      return { revision: meta.revision, changeFloor: meta.change_floor, entries };
    } catch (error) {
      rollbackQuietly(this.readDb);
      throw error;
    }
  }

  /** Indexed keyset page. The caller owns the upper bound and continuation. */
  keyRange(after: string, through: string, limit: number): T[] {
    return this.keyRangeEntries(after, through, limit).flatMap(({ value }) => {
      if (value === null && !this.options.preserveRejectedRecords) throw new Error("invalid bounded state row");
      return value === null ? [] : [value];
    });
  }

  /** Indexed raw-key page for collections whose read contract skips rejected
      rows. The cursor advances over every key, while decoding stays bounded. */
  keyRangeEntries(after: string, through: string, limit: number): Array<{ key: string; value: T | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new Error("invalid state page limit");
    return this.readDb.query<Pick<CollectionRow, "row_key" | "value_json">, [string, string, string, number]>(`
      SELECT row_key, value_json FROM state_rows
      WHERE collection = ? AND row_key > ? AND row_key <= ? ORDER BY row_key LIMIT ?
    `).all(this.options.collection, after, through, limit).map((row) => {
      const decoded = this.decodeRow(row.value_json);
      return { key: row.row_key, value: decoded === null ? null : this.options.clone(decoded) };
    });
  }

  /** Project-scoped replica watermark from indexed group maxima, without
      materializing or aggregating task rows. */
  maxTaskProjectStamp(projects: readonly string[], prefix: string): string | null {
    const fields = ["text", "status", "look", "place", "links", "machine", "handover"] as const;
    if (!projects.length) return null;
    let newest: string | null = null;
    for (const project of new Set(projects)) {
      for (const field of fields) {
        const stamp = this.readDb.query<{ stamp: string }, [string]>(`
          SELECT json_extract(value_json,'$.sync.s.${field}') AS stamp FROM state_rows
          INDEXED BY state_rows_task_stamp_${field}
          WHERE collection='tasks' AND json_valid(value_json) AND json_extract(value_json,'$.project')=?
            AND json_type(value_json,'$.sync.s.${field}')='text'
          ORDER BY json_extract(value_json,'$.sync.s.${field}') DESC LIMIT 1
        `).get(project)?.stamp;
        if (stamp && (!newest || stamp > newest)) newest = stamp;
      }
      const ms = this.readDb.query<{ ms: number }, [string]>(`
        SELECT round((julianday(json_extract(value_json,'$.updatedAt'))-2440587.5)*86400000) AS ms FROM state_rows
        INDEXED BY state_rows_task_legacy_stamp
        WHERE collection='tasks' AND json_valid(value_json) AND json_extract(value_json,'$.project')=?
          AND (json_type(value_json,'$.sync.s.text') IS NULL OR json_type(value_json,'$.sync.s.status') IS NULL
            OR json_type(value_json,'$.sync.s.look') IS NULL OR json_type(value_json,'$.sync.s.place') IS NULL
            OR json_type(value_json,'$.sync.s.links') IS NULL OR json_type(value_json,'$.sync.s.machine') IS NULL
            OR json_type(value_json,'$.sync.s.handover') IS NULL)
        ORDER BY round((julianday(json_extract(value_json,'$.updatedAt'))-2440587.5)*86400000) DESC LIMIT 1
      `).get(project)?.ms;
      if (ms !== undefined && Number.isFinite(ms)) {
        const bounded = Math.max(0, Math.min(9_999_999_999_999, ms));
        const fallback = `${String(bounded).padStart(13, "0")}.000.${prefix}`;
        if (!newest || fallback > newest) newest = fallback;
      }
    }
    return newest;
  }

  /** A bounded read/modify/write transaction. No collection materialization.
      Every read and mutation consumes the caller's finite row budget. */
  boundedPatch<R, C = never>(limit: number, operation: (tx: StateBoundedTransaction<T>) => R, heldLease?: string,
    companion?: { collection: SqliteStateCollection<C>; prepare: () => CompanionPatch<C> }): R {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new Error("invalid state patch limit");
    const peer = companion?.collection;
    if (peer && (heldLease || peer === (this as unknown) || peer.filename !== this.filename)) {
      throw new Error("a bounded companion write needs another collection of the same database and owns both leases");
    }
    assertSqliteWriteAuthority(this.filename);
    // The same ordering as patchSync; failed second acquisition releases the first.
    const peerFirst = peer && peer.options.collection < this.options.collection;
    let peerLease: string | null = null;
    let lease: string | null = heldLease ?? null;
    try {
      if (peerFirst) peerLease = peer!.acquireLeaseSync();
      lease ??= this.acquireLeaseSync();
      if (peer && !peerFirst) peerLease = peer.acquireLeaseSync();
      const db = connectDatabase(this.filename);
      try {
        const result = withImmediateTransaction(db, this.options.busyMessage, () => {
          assertSqliteWriteAuthority(this.filename);
          this.assertLease(db, lease!);
          const revision = this.collectionMeta(db)!.revision + 1;
          let remaining = limit;
          const consume = () => { if (--remaining < 0) throw new Error("state patch row budget exceeded"); };
          const changed = new Map<string, "upsert" | "delete">();
          const result = operation({
            taskProjectRows: (projects) => {
              if (this.options.collection !== "tasks") throw new Error("task project lookup requires the task collection");
              const records: T[] = [];
              for (const project of new Set(projects)) {
                consume();
                const rows = db.query<{ value_json: string }, [string, number]>(`
                  SELECT value_json FROM state_rows INDEXED BY state_rows_task_project
                  WHERE collection='tasks' AND json_valid(value_json)
                    AND json_extract(value_json,'$.project')=?
                  ORDER BY row_key LIMIT ?
                `).all(project, remaining + 1);
                for (const row of rows) {
                  consume();
                  const value = this.decodeRow(row.value_json, db);
                  if (value === null) throw new Error("invalid bounded task row");
                  records.push(this.options.clone(value));
                }
              }
              return records;
            },
            pipelineLookup: (query) => {
              consume();
              return this.lookupPipeline(db, query);
            },
            hasUnfinishedPipeline: (query) => {
              consume();
              if (this.options.collection !== "pipelines") throw new Error("unfinished pipeline lookup requires the pipeline collection");
              const scanLimit = remaining;
              const rows = db.query<{ value_json: string }, [number]>(`
                SELECT value_json FROM state_rows
                WHERE collection = 'pipelines' AND json_valid(value_json)
                  AND json_extract(value_json, '$.state') NOT IN ('completed', 'closed')
                ORDER BY row_key LIMIT ?
              `).all(scanLimit + 1);
              for (const row of rows) {
                consume();
                const pipeline = this.decodeRow(row.value_json, db);
                if (!pipeline) throw new Error("invalid bounded state row");
                if ((pipeline as { hiddenAt?: string | null }).hiddenAt) continue;
                const value = pipeline as { delivery?: { target?: { repository?: string; branch?: string; pr?: number } } };
                if (value.delivery?.target?.repository === query.repository && value.delivery.target.branch === query.branch) return true;
                if (query.prNumber && value.delivery?.target?.repository === query.repository && value.delivery.target.pr === query.prNumber) return true;
                if (query.prNumber && query.pullRequestRepository && query.pullRequestMatches
                  && query.pullRequestMatches(pipeline, query.pullRequestRepository, query.prNumber)) return true;
              }
              return false;
            },
            get: (key) => {
              consume();
              const row = db.query<{ value_json: string }, [string, string]>(
                "SELECT value_json FROM state_rows WHERE collection = ? AND row_key = ?",
              ).get(this.options.collection, key);
              if (!row) return null;
              const value = this.decodeRow(row.value_json, db);
              if (value === null) {
                if (!this.options.preserveRejectedRecords) throw new Error("invalid bounded state row");
                return null;
              }
              return this.options.clone(value);
            },
            put: (record) => {
              consume();
              this.validate(record);
              const key = this.options.key(record);
              this.assertRowWritable(db, key);
              // Keep the indexed order lookup outside the INSERT program:
              // SQLite's scalar-subquery form repeatedly initializes the
              // reference trigger graph even for unrelated collections.
              const order = db.query<{ value: number }, [string]>(
                "SELECT COALESCE(MAX(row_order)+1,0) AS value FROM state_rows WHERE collection=?",
              ).get(this.options.collection)!.value;
              db.query(`INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active)
                VALUES (?,?,?,?,?,?) ON CONFLICT(collection,row_key) DO UPDATE SET
                value_json=excluded.value_json,row_revision=excluded.row_revision,controller_active=excluded.controller_active`)
                .run(this.options.collection, key, JSON.stringify(record), order, revision, this.options.controllerActive?.(record) === false ? 0 : 1);
              changed.set(key, "upsert");
            },
            delete: (key) => {
              consume();
              this.assertRowWritable(db, key);
              db.query("DELETE FROM state_rows WHERE collection = ? AND row_key = ?").run(this.options.collection, key);
              changed.set(key, "delete");
            },
          });
          if (result instanceof Promise) throw new Error("bounded state patches must be synchronous");
          if (companion) {
            const patch = companion.prepare();
            for (let n = 0; n < patch.records.length + (patch.deleteKeys?.length ?? 0); n++) consume();
            companion.collection.mergeRows(db, peerLease!, patch.records, patch.deleteKeys ?? []);
          }
          // The callback and authority are checked inside the same commit boundary.
          assertSqliteWriteAuthority(this.filename);
          if (changed.size) {
            for (const [key, kind] of changed) db.query(
              "INSERT INTO state_changes(collection,revision,row_key,operation) VALUES (?,?,?,?)",
            ).run(this.options.collection, revision, key, kind);
            db.query("UPDATE state_collections SET revision = ? WHERE collection = ?").run(revision, this.options.collection);
            this.pruneChanges(db, revision);
          }
          return result;
        }, this.options.collection);
        secureDatabaseFiles(this.filename);
        this.invalidateAfterCommit();
        peer?.invalidateAfterCommit();
        return result;
      } finally { db.close(); }
    } finally {
      if (peerLease && !peerFirst) peer!.releaseLeaseSync(peerLease);
      if (!heldLease && lease) this.releaseLeaseSync(lease);
      if (peerLease && peerFirst) peer!.releaseLeaseSync(peerLease);
    }
  }

  /** Admission without materializing the collection. Prepared evidence is
      revalidated by the caller under this same durable writer lease. */
  private admissionTail: Promise<unknown> = Promise.resolve();
  private waitingAdmissions = 0;
  async admit<R>(operation: () => Promise<R> | R, lockWaitMs?: number, observeHold?: (heldMs: number) => void): Promise<R> {
    if (lockWaitMs === 0 && this.waitingAdmissions > 0) throw new FileTransactionBusyError(this.options.busyMessage);
    this.waitingAdmissions++;
    const deadline = lockWaitMs === undefined ? null : Date.now() + lockWaitMs;
    const turn = this.admissionTail.catch(() => undefined).then(async () => {
      // A burst of ready timer callbacks otherwise drains all admissions and
      // their microtasks before the overdue loop probe or HTTP callback runs.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (deadline !== null && lockWaitMs !== 0 && Date.now() > deadline) throw new FileTransactionBusyError(this.options.busyMessage);
      assertSqliteWriteAuthority(this.filename);
      const lease = await this.acquireLease(deadline === null ? undefined : Math.max(0, deadline - Date.now()));
      const acquiredAt = durableHolds.get(lease)!.start;
      try { assertSqliteWriteAuthority(this.filename); return await operation(); }
      finally { await this.releaseLease(lease); observeHold?.(performance.now() - acquiredAt); }
    });
    this.admissionTail = turn.then(() => undefined, () => undefined);
    return turn.finally(() => { this.waitingAdmissions--; });
  }

  async boundedPatchAsync<R>(limit: number, operation: (tx: StateBoundedTransaction<T>) => R, lockWaitMs?: number): Promise<R> {
    return waitForStateLock("state.boundedPatch", () => this.boundedPatch(limit, operation), { waitMs: lockWaitMs, subject: this.options.collection });
  }

  private lookupPipeline(db: Database, query: { requestKey: string } | { repository: string; branch: string; active?: boolean }): T | null {
    if (this.options.collection !== "pipelines") throw new Error("pipeline lookup requires the pipeline collection");
    if (!("requestKey" in query) && query.active) {
      const row = db.query<{ value_json: string }, [string, string]>(`SELECT value_json FROM state_rows INDEXED BY pipeline_delivery_owner
        WHERE collection = 'pipelines' AND json_valid(value_json) AND json_extract(value_json, '$.delivery.active') = 1
        AND json_extract(value_json, '$.delivery.disposition') = 'owner'
        AND json_extract(value_json, '$.delivery.target.repository') = ? AND json_extract(value_json, '$.delivery.target.branch') = ? LIMIT 1`).get(query.repository, query.branch);
      if (!row) return null;
      const decoded = this.decodeRow(row.value_json, db);
      if (!decoded) throw new Error("invalid indexed owner row");
      return this.options.clone(decoded);
    }
    const rows = ["pipelines", "pipelines_archive"].flatMap((collection) => {
      if (!("requestKey" in query) && query.active && collection !== "pipelines") return [];
      const row = "requestKey" in query
        ? db.query<{ value_json: string }, [string, string]>(`SELECT value_json FROM state_rows
            WHERE collection = ? AND collection IN ('pipelines', 'pipelines_archive') AND json_valid(value_json) AND json_extract(value_json, '$.creationRequest.key') IS NOT NULL
            AND json_extract(value_json, '$.creationRequest.key') = ? LIMIT 1`).get(collection, query.requestKey)
        : db.query<{ value_json: string }, [string, string, string]>(`SELECT value_json FROM state_rows
            WHERE collection = ? AND collection IN ('pipelines', 'pipelines_archive') AND json_valid(value_json) AND json_extract(value_json, '$.delivery.target.repository') = ?
            AND json_extract(value_json, '$.delivery.target.branch') = ?
            ${query.active ? "AND json_extract(value_json, '$.delivery.active') = 1 AND json_extract(value_json, '$.delivery.disposition') = 'owner'" : ""}
            ORDER BY json_extract(value_json, '$.delivery.epoch') DESC LIMIT 1`).get(collection, query.repository, query.branch);
      if (!row) return [];
      const decoded = this.decodeRow(row.value_json, db);
      if (!decoded) throw new Error("invalid indexed pipeline row");
      return [this.options.clone(decoded)];
    });
    if (!("requestKey" in query)) rows.sort((a, b) =>
      Number((b as { delivery?: { epoch: number } }).delivery?.epoch ?? 0) - Number((a as { delivery?: { epoch: number } }).delivery?.epoch ?? 0));
    return rows[0] ?? null;
  }

  pipelineLookup(query: { requestKey: string } | { repository: string; branch: string; active?: boolean }): T | null {
    return this.lookupPipeline(this.readDb, query);
  }

  unclaimedPipelinePublications(): T[] {
    if (this.options.collection !== "pipelines") throw new Error("pipeline admission requires the pipeline collection");
    const accepted: T[] = [];
    let after = "";
    // Advance by raw keys even when an entire page is opaque. Otherwise sixteen
    // future records at the front starve every healthy publication behind them.
    while (accepted.length < 16) {
      const limit = 16 - accepted.length;
      const rows = this.readDb.query<{ row_key: string; value_json: string }, [string, number]>(`SELECT row_key, value_json FROM state_rows INDEXED BY pipeline_delivery_unclaimed
        WHERE collection = 'pipelines' AND json_valid(value_json) AND json_extract(value_json, '$.delivery') IS NULL
        AND json_extract(value_json, '$.publication') = 'remote-branch'
        AND json_extract(value_json, '$.state') NOT IN ('completed', 'closed')
        AND row_key > ? ORDER BY row_key LIMIT ?`).all(after, limit);
      for (const row of rows) {
        after = row.row_key;
        const decoded = this.decodeRow(row.value_json);
        if (!decoded && !this.options.preserveRejectedRecords) throw new Error("invalid legacy pipeline row");
        if (decoded) accepted.push(this.options.clone(decoded));
      }
      if (rows.length < limit) break;
    }
    return accepted;
  }

  loadReadonly(): readonly T[] {
    const context = this.refreshReadCache();
    this.readDb.exec("BEGIN");
    try {
      const meta = this.collectionMeta();
      if (!meta) throw new Error(`SQLite state collection disappeared: ${this.options.collection}`);
      const revision = meta.revision;
      const cache = this.cache;
      if (cache?.revision === revision) {
        this.readDb.exec("COMMIT");
        this.assertReadContext(context);
        return cache.ordered;
      }
      if (!cache || cache.revision > revision || cache.revision < meta.change_floor) {
        return this.commitReadCache(this.loadFull(revision), context);
      }

      const changes = this.readDb.query<{ row_key: string }, [string, number, number]>(`
        SELECT DISTINCT row_key FROM state_changes
        WHERE collection = ? AND revision > ? AND revision <= ?
        ORDER BY revision, row_key
      `).all(this.options.collection, cache.revision, revision);
      if (changes.length === 0) {
        return this.commitReadCache(this.loadFull(revision), context);
      }
      this.options.onIncrementalReadSnapshot?.(revision);

      const changedKeys = [...new Set(changes.map((change) => change.row_key))];
      const rows = new Map<string, CollectionRow>();
      for (let start = 0; start < changedKeys.length; start += CHANGE_READ_CHUNK) {
        const chunk = changedKeys.slice(start, start + CHANGE_READ_CHUNK);
        const placeholders = chunk.map(() => "?").join(", ");
        const bindings = [this.options.collection, ...chunk] as SQLQueryBindings[];
        for (const row of this.readDb.query<CollectionRow, SQLQueryBindings[]>(`
          SELECT row_key, value_json, row_order, row_revision, controller_active
          FROM state_rows WHERE collection = ? AND row_key IN (${placeholders})
        `).all(...bindings)) rows.set(row.row_key, row);
      }
      const next = new Map(cache.records);
      let orderChanged = false;
      for (const key of changedKeys) {
        const row = rows.get(key);
        if (!row) {
          if (next.has(key)) orderChanged = true;
          next.delete(key);
          continue;
        }
        const held = next.get(key);
        if (!held || held.order !== row.row_order) orderChanged = true;
        if (held?.rowRevision === row.row_revision) {
          next.set(key, { ...held, order: row.row_order, rowRevision: row.row_revision });
          continue;
        }
        const decoded = this.decodeRow(row.value_json);
        if (decoded === null) next.delete(key);
        else next.set(key, {
          sourceBytes: row.value_json.length * 2,
          value: decoded,
          order: row.row_order,
          rowRevision: row.row_revision,
        });
      }
      const ordered = orderChanged
        ? this.createCache(revision, next)
        : this.createCacheWithOrder(revision, next, cache.orderedKeys);
      return this.commitReadCache(ordered, context);
    } catch (error) {
      rollbackQuietly(this.readDb);
      throw error;
    }
  }

  /** Move selected rows in bounded pages, each in one SQLite commit. Lease
      contention must yield: startup can hold the source lease while awaiting
      an RPC on this same event loop. A synchronous wait starves its release. */
  async moveMatchingTo(
    target: SqliteStateCollection<T>,
    predicate: (record: T) => boolean,
    options: { beforeCommit?: () => void } = {},
  ): Promise<number> {
    if (target === this || target.filename !== this.filename) {
      throw new Error("atomic state moves require two collections in one database");
    }
    assertSqliteWriteAuthority(this.filename);
    const throughOrder = this.readDb.query<{ last: number }, [string]>(
      "SELECT COALESCE(MAX(row_order),-1) AS last FROM state_rows WHERE collection=?").get(this.options.collection)!.last;
    let movedTotal = 0, afterOrder = -1, afterKey = "";
    for (;;) {
      let page: CollectionRow[] = [];
      const ordered = [this, target].sort((left, right) => left.options.collection.localeCompare(right.options.collection));
      const leases = new Map<SqliteStateCollection<T>, string>();
      try {
        for (const collection of ordered) leases.set(collection, await collection.acquireLease());
        const moved = await withViewerOperation("pipelines.controller-checkpoint", () => stateTransactionAsync(this.filename, this.options.collection, db => {
          assertSqliteWriteAuthority(this.filename);
          this.assertLease(db, leases.get(this)!);
          target.assertLease(db, leases.get(target)!);
          const sourceRows = db.query<CollectionRow, [string, number, number, string, number]>(`
            SELECT row_key, value_json, row_order, row_revision, controller_active
            FROM state_rows WHERE collection = ? AND row_order >= ? AND (row_order > ? OR row_key > ?) AND row_order <= ?
            ORDER BY row_order, row_key LIMIT 16
          `).all(this.options.collection, afterOrder, afterOrder, afterKey, throughOrder);
          page = sourceRows;
          const selected = sourceRows.flatMap((row) => {
            const decoded = this.decodeRow(row.value_json, db);
            return decoded !== null && predicate(decoded) ? [{ row, record: decoded }] : [];
          });
          if (selected.length === 0) return 0;
          for (const entry of selected) target.validate(entry.record);

          const sourceRevision = this.collectionMeta(db)!.revision + 1;
          const targetMeta = target.collectionMeta(db)!;
          const targetRows = new Map(selected.flatMap(({ record }) => {
            const held = db.query<CollectionRow, [string, string]>(`SELECT row_key,value_json,row_order,row_revision,controller_active
              FROM state_rows WHERE collection=? AND row_key=?`).get(target.options.collection,target.options.key(record));
            return held ? [[held.row_key,held] as const] : [];
          }));
          let targetOrder = db.query<{ last: number }, [string]>(
            "SELECT COALESCE(MAX(row_order),-1) AS last FROM state_rows WHERE collection=?").get(target.options.collection)!.last + 1;
          const targetPrepared = selected.map(({ record }) => {
            const key = target.options.key(record);
            const valueJson = JSON.stringify(record);
            const controllerActive = target.options.controllerActive?.(record) === false ? 0 : 1;
            target.assertRowWritable(db, key);
            const held = targetRows.get(key);
            return { key, valueJson, controllerActive, held, order: held?.row_order ?? targetOrder++ };
          });
          const targetChanged = targetPrepared.filter((entry) => (
            entry.held?.value_json !== entry.valueJson
            || entry.held.controller_active !== entry.controllerActive
          ));
          const targetRevision = targetChanged.length > 0 ? targetMeta.revision + 1 : targetMeta.revision;
          const upsert = db.query(`
            INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(collection, row_key) DO UPDATE SET
              value_json = excluded.value_json,
              row_revision = excluded.row_revision,
              controller_active = excluded.controller_active
          `);
          const change = db.query(`
            INSERT INTO state_changes(collection, revision, row_key, operation)
            VALUES (?, ?, ?, ?)
          `);
          for (const entry of targetChanged) {
            upsert.run(target.options.collection, entry.key, entry.valueJson, entry.order, targetRevision, entry.controllerActive);
            change.run(target.options.collection, targetRevision, entry.key, "upsert");
          }
          const remove = db.query("DELETE FROM state_rows WHERE collection = ? AND row_key = ?");
          for (const { row } of selected) {
            remove.run(this.options.collection, row.row_key);
            change.run(this.options.collection, sourceRevision, row.row_key, "delete");
          }
          db.query("UPDATE state_collections SET revision = ? WHERE collection = ?")
            .run(sourceRevision, this.options.collection);
          if (targetChanged.length > 0) {
            db.query("UPDATE state_collections SET revision = ? WHERE collection = ?")
              .run(targetRevision, target.options.collection);
          }
          this.pruneChanges(db, sourceRevision);
          if (targetChanged.length > 0) target.pruneChanges(db, targetRevision);
          options.beforeCommit?.();
          return selected.length;
        }));
        if (moved > 0) {
          secureDatabaseFiles(this.filename);
          this.invalidateAfterCommit();
          target.invalidateAfterCommit();
        }
        movedTotal += moved;
      } finally {
        for (const collection of [...ordered].reverse()) {
          const lease = leases.get(collection);
          if (lease) await collection.releaseLease(lease);
        }
      }
      const last = page.at(-1);
      if (!last || page.length < 16) return movedTotal;
      afterOrder = last.row_order; afterKey = last.row_key;
      await yieldToRuntime();
    }
  }

  replaceSync(records: readonly T[], options: {
    mergeOmitted?: boolean;
    deleteKeys?: readonly string[];
    beforePersist?: (records: readonly T[]) => void;
  } = {}): void {
    assertSqliteWriteAuthority(this.filename);
    const lease = this.acquireLeaseSync();
    try {
      const db = connectDatabase(this.filename);
      try {
        withImmediateTransaction(db, this.options.busyMessage, () => {
          options.beforePersist?.(records);
          this.persistReplacement(lease, records, options.mergeOmitted === true, options.deleteKeys ?? [], undefined, undefined, undefined, db);
        }, this.options.collection);
      } finally { db.close(); }
    } finally {
      this.releaseLeaseSync(lease);
    }
  }

  /** `fenceOwner` also admits the release that owns an active rollback fence,
      for the legacy reconcile its own demotion checkpoint runs (#1870).
      `appendKeys` names changed rows that move to the end of the collection
      order instead of keeping their held position. */
  patchSync<C = never>(
    prepare: () => { records: readonly T[]; deleteKeys?: readonly string[]; appendKeys?: readonly string[]; companion?: CompanionPatch<C> },
    options: { fenceOwner?: boolean; companion?: SqliteStateCollection<C>; afterPersist?: (db: Database) => void } = {},
  ): void {
    const authorize = options.fenceOwner
      ? () => assertSqliteInitializationAuthority(this.filename, true)
      : () => assertSqliteWriteAuthority(this.filename);
    authorize();
    const companion = options.companion;
    if (companion && (companion === (this as unknown) || companion.filename !== this.filename)) {
      throw new Error("a companion write needs another collection of the same database");
    }
    /* Both leases, taken in collection-name order like `moveMatchingTo`, so
       the prepare step reads both collections as committed. */
    const first = companion && companion.options.collection < this.options.collection ? companion : null;
    const companionLease = first ? first.acquireLeaseSync() : null;
    let ownLease: string | null = null;
    let laterLease: string | null = null;
    try {
      ownLease = this.acquireLeaseSync();
      if (companion && !first) laterLease = companion.acquireLeaseSync();
      const db = connectDatabase(this.filename);
      try {
        withImmediateTransaction(db, this.options.busyMessage, () => {
          const patch = prepare();
          const companionWrite = companion && patch.companion
            ? { collection: companion, lease: (companionLease ?? laterLease)!, ...patch.companion }
            : undefined;
          this.persistReplacement(ownLease!, patch.records, true, patch.deleteKeys ?? [], authorize, new Set(patch.appendKeys ?? []),
            companionWrite as (CompanionPatch<unknown> & { collection: SqliteStateCollection<unknown>; lease: string }) | undefined, db);
          options.afterPersist?.(db);
        }, this.options.collection);
      } finally { db.close(); }
    } finally {
      if (laterLease) companion!.releaseLeaseSync(laterLease);
      if (ownLease) this.releaseLeaseSync(ownLease);
      if (companionLease) first!.releaseLeaseSync(companionLease);
    }
  }

  async replace(records: readonly T[], options: Parameters<SqliteStateCollection<T>["replaceSync"]>[1] = {}): Promise<void> {
    await waitForStateLock("state.replace", () => this.replaceSync(records, options), { subject: this.options.collection });
  }

  async patch<C = never>(prepare: () => { records: readonly T[]; deleteKeys?: readonly string[]; appendKeys?: readonly string[]; companion?: CompanionPatch<C> }, options: { fenceOwner?: boolean; companion?: SqliteStateCollection<C> } = {}): Promise<void> {
    await waitForStateLock("state.patch", () => this.patchSync(prepare, options), { subject: this.options.collection });
  }

  /** Upserts across any number of collections of one database in a single
      SQLite transaction: the companion write generalised. Leases are taken in
      collection-name order, like `patchSync`, so two such writers cannot
      deadlock. `beforeCommit` runs inside the transaction after every merge;
      a throw there rolls every collection back. */
  static commitPatchesSync(
    patches: readonly { collection: SqliteStateCollection<unknown>; records: readonly unknown[]; deleteKeys?: readonly string[] }[],
    options: {
      /** Runs first inside the transaction, with the committed revision and row
          count of any collection; a throw rolls back before anything is written. */
      beforeMerge?: (read: { revision(collection: string): number | null; rows(collection: string): number }) => void;
      beforeCommit?: () => void;
      busyMessage?: string;
    } = {},
  ): void {
    if (!patches.length) return;
    const filename = patches[0]!.collection.filename;
    const names = new Set<string>();
    for (const patch of patches) {
      if (patch.collection.filename !== filename) throw new Error("a combined state write needs collections of one database");
      if (names.has(patch.collection.options.collection)) throw new Error(`duplicate collection in a combined state write: ${patch.collection.options.collection}`);
      names.add(patch.collection.options.collection);
    }
    assertSqliteWriteAuthority(filename);
    const ordered = [...patches].sort((a, b) => a.collection.options.collection.localeCompare(b.collection.options.collection));
    const leases: { collection: SqliteStateCollection<unknown>; token: string }[] = [];
    try {
      for (const patch of ordered) leases.push({ collection: patch.collection, token: patch.collection.acquireLeaseSync() });
      const db = connectDatabase(filename);
      let changed = false;
      try {
        withImmediateTransaction(db, options.busyMessage ?? "state is busy", () => {
          assertSqliteWriteAuthority(filename);
          options.beforeMerge?.({
            revision: collection => db.query<{ revision: number }, [string]>("SELECT revision FROM state_collections WHERE collection = ?").get(collection)?.revision ?? null,
            rows: collection => db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM state_rows WHERE collection = ?").get(collection)?.count ?? 0,
          });
          for (const [index, patch] of ordered.entries()) {
            if (patch.collection.mergeRows(db, leases[index]!.token, patch.records, patch.deleteKeys ?? [])) changed = true;
          }
          options.beforeCommit?.();
        });
      } finally { db.close(); }
      if (changed) {
        secureDatabaseFiles(filename);
        for (const patch of ordered) patch.collection.invalidateAfterCommit();
      }
    } finally {
      for (const lease of leases.reverse()) lease.collection.releaseLeaseSync(lease.token);
    }
  }

  /** One prepared, indexed revision reader per in-flight pipeline operation.
      Check the file fence before reusing its statement, as openCurrentDatabase
      does before preparing one. A swap rebinds it to the replacement inode. */
  pipelineRecordVersionReader(rowKey: string, authority: () => unknown = () => this.options.decodeAuthority?.()): () => string {
    const marker = databaseSwapMarker(this.filename);
    let boundIdentity: string | null | undefined;
    let read: (() => { hot: number | null; archive: number | null; recovery: number | null } | null) | undefined;
    let previous: { identity: string | null; hot: number | null; archive: number | null; recovery: number | null; authority: unknown } | undefined;
    let token = "";
    return () => {
      const identity = databaseFileIdentity(this.filename);
      if (fs.existsSync(marker) && databaseSwapInProgress(this.filename)) throw new DatabaseReplacedError("pipeline state is being restored; try again");
      if (!read || boundIdentity !== identity) {
        const statement = this.readDb.query<{ hot: number | null; archive: number | null; recovery: number | null }, [string, string]>(`
          SELECT (SELECT row_revision FROM state_rows WHERE collection = 'pipelines' AND row_key = ?) AS hot,
                 (SELECT row_revision FROM state_rows WHERE collection = 'pipelines_archive' AND row_key = ?) AS archive,
                 (SELECT revision FROM state_collections WHERE collection = 'worktree_recovery') AS recovery`);
        read = () => statement.get(rowKey, rowKey);
        boundIdentity = identity;
      }
      const row = read(), currentAuthority = authority();
      if (!previous || previous.identity !== identity || previous.hot !== row?.hot
        || previous.archive !== row?.archive || previous.recovery !== row?.recovery || previous.authority !== currentAuthority) {
        previous = { identity, hot: row?.hot ?? null, archive: row?.archive ?? null, recovery: row?.recovery ?? null, authority: currentAuthority };
        token = JSON.stringify(previous);
      }
      return token;
    };
  }

  /** Each row's last-written collection revision, by row key. */
  rowRevisions(): Map<string, number> {
    return new Map(this.readDb.query<Pick<CollectionRow, "row_key" | "row_revision">, [string]>(
      "SELECT row_key, row_revision FROM state_rows WHERE collection = ?",
    ).all(this.options.collection).map((row) => [row.row_key, row.row_revision] as const));
  }

  withSnapshotSync<R>(read: (records: readonly T[]) => R): R {
    const lease = this.acquireLeaseSync();
    try {
      return read(this.snapshot());
    } finally {
      this.releaseLeaseSync(lease);
    }
  }

  async mutate<R>(
    operation: (records: T[], persist: (records?: readonly T[]) => Promise<void>) => Promise<R> | R,
    beforePersist?: (context: StateMutationContext<T>) => void,
    controllerOnly = false,
    lockWaitMs?: number,
    observeHold?: (heldMs: number) => void,
    keys?: readonly string[],
  ): Promise<R> {
    assertSqliteWriteAuthority(this.filename);
    const lease = await this.acquireLease(lockWaitMs);
    const acquiredAt = durableHolds.get(lease)!.start;
    try {
      const source = keys ? keys.flatMap(key => { const row = this.get(key); return row ? [row] : []; })
        : controllerOnly ? this.loadControllerReadonly() : this.loadReadonly();
      const session = this.track(source);
      return await operation(session.records, async (records) => {
        await stateTransactionAsync(this.filename, this.options.collection,
          db => this.persistSession(lease, session, beforePersist, records, db), apply => apply());
      });
    } finally {
      await this.releaseLease(lease);
      observeHold?.(performance.now() - acquiredAt);
    }
  }

  /** Controller I/O runs on a detached snapshot. Each checkpoint takes only
      the write lease and verifies the rows it will replace. Reservations still
      become durable at persist(), before their existing actuation paths run.
      Explicit-only callers omit comparison baselines and must name every row
      they checkpoint. Ordinary callers retain implicit dirty-row checkpoints. */
  async reconcileSnapshot<R>(
    operation: (records: T[], persist: (records?: readonly T[]) => Promise<void>, assertCurrent: (record: T) => void) => Promise<R> | R,
    observeHold?: (heldMs: number) => void,
    explicitOnly = false,
    keys?: readonly string[],
  ): Promise<R> {
    assertSqliteWriteAuthority(this.filename);
    const authority = this.options.decodeAuthority?.();
    const identity = databaseFileIdentity(this.filename);
    const expected = new Map<string, number>();
    const session = this.track(await this.prepareControllerSnapshot(expected, keys), explicitOnly, true);
    // A synchronous callback may filter all selected rows before its first
    // await. Finish their independent copies in bounded slices beforehand.
    await forEachCooperatively(session.records, () => undefined, { batchSize: 4, timeBudgetMs: 16 });
    if (this.options.decodeAuthority?.() !== authority) throw new StateSnapshotChangedError();
    if (databaseFileIdentity(this.filename) !== identity) throw new StateSnapshotChangedError();
    const rowRevision = (key: string) => sharedStateReadonlyDatabase(this.filename).query<{ row_revision: number }, [string, string]>(
      "SELECT row_revision FROM state_rows WHERE collection = ? AND row_key = ?",
    ).get(this.options.collection, key)?.row_revision;
    const assertCurrent = (record: T) => {
      const key = this.options.key(record);
      if (!expected.has(key) || (keys !== undefined && this.options.decodeAuthority?.() !== authority) || databaseFileIdentity(this.filename) !== identity
        || rowRevision(key) !== expected.get(key)) throw new StateSnapshotChangedError();
    };
    for (const record of session.records) assertCurrent(record);
    return operation(session.records, async records => {
      // Defer a controller pass behind an admitted logical writer. Once its
      // lease is held, SQLite admission yields and rechecks every dirty row.
      let lease: string;
      try { lease = await this.acquireLease(0); }
      catch (error) {
        if (error instanceof FileTransactionBusyError) throw new StateSnapshotChangedError();
        throw error;
      }
      const acquiredAt = durableHolds.get(lease)!.start;
      const committed: string[] = [];
      try {
        await withViewerOperation("pipelines.controller-checkpoint", () => stateTransactionAsync(this.filename, this.options.collection, db => performanceSpans.sync("state.checkpoint", () => this.persistSession(lease, session, context => {
          if (context.structural) throw new Error("controller snapshots cannot replace the collection");
          for (const record of context.dirtyRecords) {
            assertCurrent(record);
            committed.push(this.options.key(record));
          }
        }, records, db)), apply => apply()));
        for (const key of committed) {
          const current = rowRevision(key);
          if (current !== undefined) expected.set(key, current);
        }
      } finally {
        await this.releaseLease(lease);
        observeHold?.(performance.now() - acquiredAt);
      }
    }, assertCurrent);
  }

  checkpointMirror(write: (records: readonly T[], revision: number) => void): void {
    const lease = this.acquireLeaseSync();
    try {
      const records = this.mirrorSnapshot();
      write(records, this.revision());
    } finally {
      this.releaseLeaseSync(lease);
    }
  }

  checkpointMirrorForDemotion(write: (records: readonly T[], revision: number) => void, maxAttempts = 2): number {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let checkpointRevision = -1;
      this.checkpointMirror((records, revision) => {
        checkpointRevision = revision;
        write(records, revision);
      });
      if (this.revision() === checkpointRevision) return checkpointRevision;
    }
    throw new Error(`${this.options.collection} rollback checkpoint did not converge`);
  }

  async checkpointMirrorForDemotionAsync(write: (records: readonly T[], revision: number) => void, maxAttempts = 2): Promise<number> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const lease = await this.acquireLease();
      let revision: number;
      try {
        const records = this.mirrorSnapshot();
        revision = this.revision();
        write(records, revision);
      } finally {
        await this.releaseLease(lease);
      }
      if (this.revision() === revision) return revision;
    }
    throw new Error(`${this.options.collection} rollback checkpoint did not converge`);
  }

  /** Rollback mirrors include opaque records; controller snapshots exclude them. */
  private mirrorSnapshot(): readonly T[] {
    if (!this.options.preserveRejectedRecords) return this.snapshot();
    const rows = this.readDb.query<{ value_json: string }, [string]>(
      "SELECT value_json FROM state_rows WHERE collection = ? ORDER BY row_order, row_key",
    ).all(this.options.collection);
    const records = rows.map((row) => {
      this.decodeRow(row.value_json); // strict parse before publication
      return parseSqliteJson(row.value_json, this.readDb) as T;
    });
    return rememberRecordBytes(records, rows.map((row) => row.value_json), (record) => this.options.decode(record) !== null);
  }

  private collectionMeta(db = this.readDb): CollectionMeta | null {
    return db.query<CollectionMeta, [string]>(
      "SELECT revision, schema_version, change_floor FROM state_collections WHERE collection = ?",
    ).get(this.options.collection) ?? null;
  }

  private decodeRow(valueJson: string, db = this.readDb): T | null {
    try {
      const decoded = this.options.decode(parseSqliteJson(valueJson, db) as unknown);
      if (decoded === null && this.options.strictDecode && !this.options.preserveRejectedRecords) {
        throw new Error(`${this.options.collection} SQLite row is malformed`);
      }
      return decoded;
    } catch (error) {
      if (this.options.strictDecode || this.options.preserveRejectedRecords) {
        throw this.options.decodeError?.(error) ?? error;
      }
      this.options.onDecodeError?.(error);
      return null;
    }
  }

  private loadControllerReadonly(): readonly T[] {
    return this.readDb.query<Pick<CollectionRow, "value_json">, [string]>(`
      SELECT value_json FROM state_rows
      WHERE collection = ? AND controller_active = 1
      ORDER BY row_order, row_key
    `).all(this.options.collection).flatMap((row) => {
      const decoded = this.decodeRow(row.value_json);
      return decoded === null ? [] : [decoded];
    });
  }

  /** Indexed pages contain only selected headers. Unchanged history keeps its
      decoded value; payload reads and decoding yield without holding a lease
      or a read transaction. The outer revision check refuses a mixed snapshot. */
  private async prepareControllerSnapshot(expected: Map<string, number>, keys?: readonly string[]): Promise<readonly T[]> {
    const identity = databaseFileIdentity(this.filename);
    const authority = this.options.decodeAuthority?.();
    const records: T[] = [];
    let order = -1, key = "";
    for (;;) {
      const rows = withViewerOperation("pipelines.controller-read", () => sharedStateReadonlyDatabase(this.filename).query<
        Pick<CollectionRow, "row_key" | "row_order" | "row_revision">, SQLQueryBindings[]>(`
        SELECT row_key, row_order, row_revision FROM state_rows
        ${keys ? "INDEXED BY sqlite_autoindex_state_rows_1" : ""}
        WHERE collection = ? AND controller_active = 1 AND row_order >= ?
          AND (row_order > ? OR row_key > ?)
          ${keys ? "AND row_key IN (SELECT value FROM json_each(?))" : ""}
        ORDER BY row_order, row_key LIMIT ?
      `).all(this.options.collection, order, order, key, ...(keys ? [JSON.stringify(keys)] : []), 16));
      if (!rows.length) break;
      let sliceStarted = performance.now();
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const value = this.controllerRow(row.row_key, row.row_revision);
        if (value !== null) { records.push(value); expected.set(row.row_key, row.row_revision); }
        order = row.row_order; key = row.row_key;
        if (index + 1 < rows.length && performance.now() - sliceStarted >= 16) {
          await yieldToRuntime(); sliceStarted = performance.now();
        }
      }
      if (rows.length < 16) break;
      await yieldToRuntime();
    }
    // Drop rows that left the controller set; never retain inactive history.
    if (databaseFileIdentity(this.filename) !== identity || this.options.decodeAuthority?.() !== authority) {
      throw new StateSnapshotChangedError();
    }
    return records;
  }

  private loadFull(revision: number): CollectionCache<T> {
    const records = new Map<string, CachedRecord<T>>();
    for (const row of this.readDb.query<CollectionRow, [string]>(`
      SELECT row_key, value_json, row_order, row_revision
      FROM state_rows WHERE collection = ? ORDER BY row_order, row_key
    `).iterate(this.options.collection)) {
      const decoded = this.decodeRow(row.value_json);
      if (decoded === null) continue;
      records.set(row.row_key, {
        sourceBytes: row.value_json.length * 2,
        value: decoded,
        order: row.row_order,
        rowRevision: row.row_revision,
      });
    }
    return this.createCache(revision, records);
  }

  private createCache(revision: number, records: Map<string, CachedRecord<T>>): CollectionCache<T> {
    const entries = [...records.entries()]
      .sort((left, right) => left[1].order - right[1].order || left[0].localeCompare(right[0]));
    const orderedKeys = entries.map((entry) => entry[0]);
    const ordered = entries.map((entry) => entry[1].value);
    return { revision, records, orderedKeys, ordered };
  }

  private createCacheWithOrder(
    revision: number,
    records: Map<string, CachedRecord<T>>,
    orderedKeys: readonly string[],
  ): CollectionCache<T> {
    const ordered = orderedKeys.flatMap((key) => {
      const held = records.get(key);
      return held ? [held.value] : [];
    });
    return { revision, records, orderedKeys, ordered };
  }

  private invalidateAfterCommit(): void {
    this.revisionCache = null;
  }

  private track(records: readonly T[], explicitOnly = false, controller = false): MutationSession<T> {
    const materialized = new Map<number, TrackedRoot<T>>();
    const tracked = [...records];
    const session: MutationSession<T> = { records: [], rawRecords: tracked, materialized, structural: false, explicitOnly };
    const indexOf = (property: string | symbol): number | null => {
      if (typeof property !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(property)) return null;
      const index = Number(property);
      return Number.isSafeInteger(index) ? index : null;
    };
    session.records = new Proxy(tracked, {
      get: (target, property, receiver) => {
        const index = indexOf(property);
        if (index === null || index >= target.length) return Reflect.get(target, property, receiver);
        if (!materialized.has(index)) {
          const materialize = () => {
            const clone = controller ? this.options.cloneController ?? this.options.clone : this.options.clone;
            const cloned = clone(target[index]!);
            target[index] = cloned;
            materialized.set(index, {
              originalKey: this.options.key(cloned),
              persistedJson: explicitOnly ? null : JSON.stringify(cloned),
              value: cloned,
            });
          };
          if (controller) withViewerOperation("pipelines.controller-materialize", materialize);
          else materialize();
        }
        return target[index];
      },
      set: (target, property, value) => {
        session.structural = true;
        const index = indexOf(property);
        if (index !== null) materialized.delete(index);
        return Reflect.set(target, property, value);
      },
      deleteProperty: (target, property) => {
        session.structural = true;
        const index = indexOf(property);
        if (index !== null) materialized.delete(index);
        return Reflect.deleteProperty(target, property);
      },
      defineProperty: (target, property, descriptor) => {
        session.structural = true;
        const index = indexOf(property);
        if (index !== null) materialized.delete(index);
        return Reflect.defineProperty(target, property, descriptor);
      },
    });
    return session;
  }

  private persistSession(
    ownerToken: string,
    session: MutationSession<T>,
    beforePersist: ((context: StateMutationContext<T>) => void) | undefined,
    explicitRecords: readonly T[] | undefined,
    db: Database,
  ): () => void {
    if (session.explicitOnly && !explicitRecords) throw new Error("explicit controller checkpoints require records");
    if (explicitRecords) {
      if (explicitRecords.length === 0) return () => {};
      beforePersist?.({ records: session.records, dirtyRecords: explicitRecords, structural: false });
      this.persistChangedRows(ownerToken, explicitRecords, db);
      return () => {
        const explicitKeys = new Set(explicitRecords.map((record) => this.options.key(record)));
        for (const tracked of session.materialized.values()) {
          const currentKey = this.options.key(tracked.value);
          if (explicitKeys.has(currentKey)) {
            tracked.originalKey = currentKey;
            tracked.persistedJson = session.explicitOnly ? null : JSON.stringify(tracked.value);
          }
        }
      };
    }
    const changed: T[] = [];
    if (session.structural) {
      for (const record of session.records) changed.push(record);
      beforePersist?.({ records: session.records, dirtyRecords: changed, structural: true });
      this.persistReplacement(ownerToken, changed, false, [], undefined, undefined, undefined, db);
      return () => {
        session.structural = false;
        session.materialized.clear();
        session.rawRecords.forEach((record, index) => session.materialized.set(index, {
          originalKey: this.options.key(record),
          persistedJson: JSON.stringify(record),
          value: record,
        }));
      };
    }
    for (const tracked of session.materialized.values()) {
      const currentKey = this.options.key(tracked.value);
      if (currentKey !== tracked.originalKey) {
        session.structural = true;
        return this.persistSession(ownerToken, session, beforePersist, undefined, db);
      }
      if (JSON.stringify(tracked.value) !== tracked.persistedJson) changed.push(tracked.value);
    }
    if (changed.length === 0) return () => {};
    beforePersist?.({ records: session.records, dirtyRecords: changed, structural: false });
    this.persistChangedRows(ownerToken, changed, db);
    return () => {
      for (const tracked of session.materialized.values()) {
        tracked.originalKey = this.options.key(tracked.value);
        tracked.persistedJson = JSON.stringify(tracked.value);
      }
    };
  }

  private validate(record: T): void {
    const key = this.options.key(record);
    if (!key) throw new Error(`refusing to persist an empty ${this.options.collection} row key`);
    this.options.validate?.(record);
  }

  private protectedRow(row: { value_json: string } | null | undefined, db: Database): boolean {
    return Boolean(row && this.options.preserveRejectedRecords && this.decodeRow(row.value_json, db) === null);
  }

  private assertRowWritable(db: Database, key: string): void {
    if (!this.options.preserveRejectedRecords) return;
    const row = db.query<{ value_json: string }, [string, string]>(
      "SELECT value_json FROM state_rows WHERE collection = ? AND row_key = ?",
    ).get(this.options.collection, key);
    if (this.protectedRow(row, db)) throw new Error(`refusing to overwrite preserved ${this.options.collection} record: ${key}`);
  }

  private persistChangedRows(ownerToken: string, records: readonly T[], admittedDb?: Database): void {
    for (const record of records) this.validate(record);
    const db = admittedDb ?? connectDatabase(this.filename);
    try {
      const write = () => {
        assertSqliteWriteAuthority(this.filename);
        this.assertLease(db, ownerToken);
        const meta = this.collectionMeta(db)!;
        const current = db.query<CollectionRow, [string, string]>(`
          SELECT row_key, value_json, row_order, row_revision, controller_active
          FROM state_rows WHERE collection = ? AND row_key = ?
        `);
        const prepared = records.map((record) => {
          const key = this.options.key(record);
          const valueJson = JSON.stringify(record);
          const controllerActive = this.options.controllerActive?.(record) === false ? 0 : 1;
          this.assertRowWritable(db, key);
          return { key, valueJson, controllerActive, row: current.get(this.options.collection, key) };
        });
        const actual = prepared.filter((entry) => (
          entry.row?.value_json !== entry.valueJson
          || entry.row.controller_active !== entry.controllerActive
        ));
        if (actual.length === 0) return null;
        const nextRevision = meta.revision + 1;
        const maxOrder = db.query<{ value: number }, [string]>(
          "SELECT COALESCE(MAX(row_order), -1) AS value FROM state_rows WHERE collection = ?",
        ).get(this.options.collection)?.value ?? -1;
        let appendOrder = maxOrder + 1;
        const upsert = db.query(`
          INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(collection, row_key) DO UPDATE SET
            value_json = excluded.value_json,
            row_revision = excluded.row_revision,
            controller_active = excluded.controller_active
        `);
        const change = db.query(`
          INSERT INTO state_changes(collection, revision, row_key, operation)
          VALUES (?, ?, ?, 'upsert')
        `);
        for (const entry of actual) {
          const order = entry.row?.row_order ?? appendOrder++;
          upsert.run(this.options.collection, entry.key, entry.valueJson, order, nextRevision, entry.controllerActive);
          change.run(this.options.collection, nextRevision, entry.key);
        }
        db.query("UPDATE state_collections SET revision = ? WHERE collection = ?")
          .run(nextRevision, this.options.collection);
        this.pruneChanges(db, nextRevision);
        return nextRevision;
      };
      const revision = admittedDb ? write() : withImmediateTransaction(db, this.options.busyMessage, write, this.options.collection);
      if (revision !== null) {
        secureDatabaseFiles(this.filename);
        this.invalidateAfterCommit();
      }
    } finally {
      if (!admittedDb) db.close();
    }
  }

  private persistReplacement(
    ownerToken: string,
    records: readonly T[],
    mergeOmitted: boolean,
    deleteKeys: readonly string[] = [],
    authorize: () => void = () => assertSqliteWriteAuthority(this.filename),
    appendKeys: ReadonlySet<string> = new Set(),
    companion?: CompanionPatch<unknown> & { collection: SqliteStateCollection<unknown>; lease: string },
    admittedDb?: Database,
  ): void {
    for (const record of records) this.validate(record);
    const seen = new Set<string>();
    for (const record of records) {
      const key = this.options.key(record);
      if (seen.has(key)) throw new Error(`duplicate ${this.options.collection} row key: ${key}`);
      seen.add(key);
    }
    const requestedDeletes = new Set(deleteKeys);
    if (requestedDeletes.size !== deleteKeys.length || [...requestedDeletes].some((key) => !key || seen.has(key))) {
      throw new Error(`invalid ${this.options.collection} row deletion`);
    }
    const db = admittedDb ?? connectDatabase(this.filename);
    try {
      const write = () => {
        authorize();
        this.assertLease(db, ownerToken);
        const meta = this.collectionMeta(db)!;
        const current = new Map(db.query<CollectionRow, [string]>(`
          SELECT row_key, value_json, row_order, row_revision, controller_active
          FROM state_rows WHERE collection = ?
        `).all(this.options.collection).map((row) => [row.row_key, row] as const));
        for (const key of [...seen, ...requestedDeletes]) this.assertRowWritable(db, key);
        const protectedKeys = new Set([...current].filter(([, row]) => this.protectedRow(row, db)).map(([key]) => key));
        const encoded = records.map((record, index) => ({
          key: this.options.key(record),
          valueJson: JSON.stringify(record),
          order: index,
          controllerActive: this.options.controllerActive?.(record) === false ? 0 : 1,
        }));
        const changed = encoded.filter((entry) => {
          const held = current.get(entry.key);
          return !held
            || held.value_json !== entry.valueJson
            || held.controller_active !== entry.controllerActive
            || (!mergeOmitted && held.row_order !== entry.order);
        });
        const deleted = mergeOmitted
          ? [...requestedDeletes].filter((key) => current.has(key))
          : [...current.keys()].filter((key) => !seen.has(key) && !protectedKeys.has(key));
        const companionChanged = companion ? companion.collection.mergeRows(db, companion.lease, companion.records, companion.deleteKeys ?? []) : false;
        if (changed.length === 0 && deleted.length === 0) return companionChanged ? meta.revision : null;
        const nextRevision = meta.revision + 1;
        const nextOrder = mergeOmitted
          ? (Math.max(-1, ...[...current.values()].map((row) => row.row_order)) + 1)
          : 0;
        let appended = nextOrder;
        const upsert = db.query(`
          INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(collection, row_key) DO UPDATE SET
            value_json = excluded.value_json,
            row_order = excluded.row_order,
            row_revision = excluded.row_revision,
            controller_active = excluded.controller_active
        `);
        const change = db.query(`
          INSERT INTO state_changes(collection, revision, row_key, operation)
          VALUES (?, ?, ?, ?)
        `);
        for (const entry of changed) {
          const held = current.get(entry.key);
          const order = mergeOmitted ? (appendKeys.has(entry.key) ? undefined : held?.row_order) ?? appended++ : entry.order;
          upsert.run(this.options.collection, entry.key, entry.valueJson, order, nextRevision, entry.controllerActive);
          change.run(this.options.collection, nextRevision, entry.key, "upsert");
        }
        const remove = db.query("DELETE FROM state_rows WHERE collection = ? AND row_key = ?");
        for (const key of deleted) {
          remove.run(this.options.collection, key);
          change.run(this.options.collection, nextRevision, key, "delete");
        }
        db.query("UPDATE state_collections SET revision = ? WHERE collection = ?")
          .run(nextRevision, this.options.collection);
        this.pruneChanges(db, nextRevision);
        return nextRevision;
      };
      const revision = admittedDb ? write() : withImmediateTransaction(db, this.options.busyMessage, write, this.options.collection);
      if (revision !== null) {
        secureDatabaseFiles(this.filename);
        this.invalidateAfterCommit();
        companion?.collection.invalidateAfterCommit();
      }
    } finally {
      if (!admittedDb) db.close();
    }
  }

  /** Upsert and delete rows of this collection inside a transaction another
      collection opened, under this collection's lease. Returns whether
      anything changed. */
  private mergeRows(db: Database, ownerToken: string, records: readonly T[], deleteKeys: readonly string[]): boolean {
    this.assertLease(db, ownerToken);
    for (const record of records) this.validate(record);
    const current = db.query<Pick<CollectionRow, "value_json" | "row_order" | "controller_active">, [string, string]>(
      "SELECT value_json, row_order, controller_active FROM state_rows WHERE collection = ? AND row_key = ?",
    );
    const upserts = records.flatMap((record) => {
      const key = this.options.key(record);
      const valueJson = JSON.stringify(record);
      this.assertRowWritable(db, key);
      const held = current.get(this.options.collection, key);
      return held?.value_json === valueJson ? [] : [{ key, valueJson, held, controllerActive: this.options.controllerActive?.(record) === false ? 0 : 1 }];
    });
    for (const key of deleteKeys) this.assertRowWritable(db, key);
    const deletes = deleteKeys.filter((key) => current.get(this.options.collection, key));
    if (!upserts.length && !deletes.length) return false;
    const revision = this.collectionMeta(db)!.revision + 1;
    let order = (db.query<{ value: number }, [string]>("SELECT COALESCE(MAX(row_order), -1) AS value FROM state_rows WHERE collection = ?")
      .get(this.options.collection)?.value ?? -1) + 1;
    const change = db.query("INSERT INTO state_changes(collection, revision, row_key, operation) VALUES (?, ?, ?, ?)");
    const upsert = db.query(`INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(collection, row_key) DO UPDATE SET
      value_json = excluded.value_json, row_revision = excluded.row_revision, controller_active = excluded.controller_active`);
    for (const entry of upserts) {
      upsert.run(this.options.collection, entry.key, entry.valueJson, entry.held?.row_order ?? order++, revision, entry.controllerActive);
      change.run(this.options.collection, revision, entry.key, "upsert");
    }
    const remove = db.query("DELETE FROM state_rows WHERE collection = ? AND row_key = ?");
    for (const key of deletes) {
      remove.run(this.options.collection, key);
      change.run(this.options.collection, revision, key, "delete");
    }
    db.query("UPDATE state_collections SET revision = ? WHERE collection = ?").run(revision, this.options.collection);
    this.pruneChanges(db, revision);
    return true;
  }

  private assertLease(db: Database, ownerToken: string): void {
    const lease = db.query<Pick<LeaseRow, "owner_token">, [string]>(
      "SELECT owner_token FROM state_leases WHERE collection = ?",
    ).get(this.options.collection);
    if (lease?.owner_token !== ownerToken) throw new StateLeaseLostError(this.options.busyMessage);
  }

  private pruneChanges(db: Database, revision: number): void {
    const cutoff = revision - CHANGE_RETENTION_REVISIONS;
    if (cutoff <= 0) return;
    db.query(`
      DELETE FROM state_changes WHERE rowid IN (
        SELECT rowid FROM state_changes
        WHERE collection = ? AND revision <= ?
        ORDER BY revision, row_key LIMIT ?
      )
    `).run(this.options.collection, cutoff, CHANGE_PRUNE_BATCH);
    db.query(`
      UPDATE state_collections SET change_floor = MAX(change_floor, ?)
      WHERE collection = ?
    `).run(cutoff, this.options.collection);
  }

  private tryAcquireLease(db: Database, ownerToken: string): true | StateLockHolder {
    try {
      db.exec("BEGIN IMMEDIATE");
      const held = db.query<LeaseRow, [string]>(`
        SELECT owner_token, owner_pid, owner_start_identity, acquired_at
        FROM state_leases WHERE collection = ?
      `).get(this.options.collection);
      const now = Date.now();
      if (held && !leaseIsStale(held, this.filename, this.options.collection, now)) {
        db.exec("ROLLBACK");
        return { kind: held.owner_pid === process.pid ? stateLockProcessKind() : "other-process",
          ageMs: Math.max(0, now - held.acquired_at) };
      }
      if (held) db.query("DELETE FROM state_leases WHERE collection = ?").run(this.options.collection);
      db.query(`
        INSERT INTO state_leases(collection, owner_token, owner_pid, owner_start_identity, acquired_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(this.options.collection, ownerToken, process.pid, procBackend.processIdentity(process.pid), Date.now());
      performanceSpans.sync("state.lease-commit", () => db.exec("COMMIT"));
      const start = performance.now();
      const operation = viewerLoopMonitor.current() ?? `${this.options.collection}.mutation`;
      const timer = setTimeout(() => {
        if (durableHolds.has(ownerToken)) console.warn("[state lease-hold]", {
          collection: this.options.collection, operation, heldMs: Math.round(performance.now() - start), inFlight: true,
        });
      }, 1001);
      timer.unref();
      durableHolds.set(ownerToken, { start, operation, collection: this.options.collection, timer });
      if (held) {
        finishDurableHold(held.owner_token, this.options.collection);
        if (now - held.acquired_at > STATE_LEASE_MAX_AGE_MS) console.warn(`[state lease] taking over ${this.options.collection} from pid ${held.owner_pid}, age ${now - held.acquired_at} ms`);
        const old = abandonedTokens(this.filename, this.options.collection)?.get(held.owner_token);
        if (old) forgetAbandoned(old);
      }
      return true;
    } catch (error) {
      rollbackQuietly(db);
      if (isBusyError(error)) throw new StateLockDeferredError("state.lease.sqlite");
      throw classifyStateError(error, `${this.options.collection} acquisition`);
    }
  }

  private acquireLeaseSync(_waitMs?: number): string {
    return stateLockAttempt("state.lease", () => {
      const db = connectDatabase(this.filename);
      const ownerToken = crypto.randomUUID();
      try {
        const acquired = this.tryAcquireLease(db, ownerToken);
        if (acquired === true) return ownerToken;
        this.assertDiskHasSpace();
        throw new StateLockDeferredError("state.lease", "lease", acquired);
      } finally { db.close(); }
    }, this.options.collection);
  }

  private async acquireLease(waitMs?: number): Promise<string> {
    return waitForStateLock("state.lease", () => this.acquireLeaseSync(), { waitMs, subject: this.options.collection });
  }

  private assertDiskHasSpace(): void {
    const free = stateFreeBytes(path.dirname(this.filename));
    if (free !== null && free < STATE_DISK_FULL_FLOOR_BYTES) {
      const detail = `${this.options.collection} is held by a writer that cannot release it`;
      noteStateDiskFull(detail);
      throw new StateDiskFullError(detail);
    }
  }

  private releaseLeaseSync(ownerToken: string): void {
    const lease = { filename: this.filename, collection: this.options.collection, token: ownerToken, abandonedAt: Date.now() };
    try { deleteLease(lease); }
    catch (error) { abandonLease(lease, error); }
  }

  private async releaseLease(ownerToken: string): Promise<void> {
    this.releaseLeaseSync(ownerToken);
  }
}
