import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Database as BunDatabase } from "bun:sqlite";

import { openCurrentDatabase } from "@/lib/state/currentDatabase";

import { reboundAssembledMcpGrants, rowClaimsBeyondBaselineGrant, type McpGrantPolicy } from "./mcpAllowlist";
import { identityMaterializationFence } from "./identityMaterialization";
import type { RegistryFile, SeatChildrenAnchor, SeatChildrenPage, SnapshotSpawnProjection, SnapshotTitleConversationProjection } from "./registry";
import { sessionKeyId } from "./sessionKey";

/** The collections the MCP grant decision reads and writes. Touching any one of
    them requires the decision to have run over ALL of them, because an entry or
    a receipt is only decidable against the conversations and lineage edges that
    attest to it (#739). */
const GRANT_COLLECTIONS = new Set(["entries", "receipts", "conversations", "lineageEdges"]);
const SNAPSHOT_SPAWN_ALIAS_LIMIT = 64;
const SNAPSHOT_TITLE_CONVERSATION_LIMIT = 2_000;
const SNAPSHOT_TITLE_OWNED_PATH_LIMIT = 128;

const ROW_COLLECTIONS = [
  "entries",
  "receipts",
  "lineageEdges",
  "memberships",
  "conversations",
  "conversationAliases",
  "migrationIntents",
  "heldDeliveries",
  "deliveryOperationOwners",
  "deliveryEvidenceCompactions",
  "pendingSuccessorCleanups",
  "pendingSupersedence",
] as const satisfies ReadonlyArray<keyof RegistryFile>;

const META_FIELDS = [
  "importedResumePanes",
  "legacyResumePanes",
  "identityMigrations",
  "conversationRevision",
  "engineRouting",
  "autoBalance",
  "quotaObservations",
] as const satisfies ReadonlyArray<keyof RegistryFile>;

export type RowCollection = (typeof ROW_COLLECTIONS)[number];
type LookupValue = string | readonly string[];
type LookupField = "conversationId" | "artifactPath" | "command.operationId" | "alias";
const LOOKUP_PATHS: Record<LookupField, string> = { conversationId: "$.conversationId", artifactPath: "$.artifactPath", "command.operationId": "$.command.operationId", alias: "$" };
const keyedReaders = new WeakMap<RegistryFile, (collection: RowCollection, field: LookupField, value: LookupValue) => string[]>();
const pathReaders = new WeakMap<RegistryFile, (path: string) => string[]>();

/** Indexed selection inside the same lazy transaction, including pending writes. */
export function registryRowsMatching<C extends RowCollection>(file: RegistryFile, collection: C, field: LookupField, value: LookupValue): RegistryFile[C][string][] {
  const keys = registryKeysMatching(file, collection, field, value);
  const rows = file[collection] as Record<string, RegistryFile[C][string]>;
  return keys.map(key => rows[key]!).filter(Boolean);
}

export function registryKeysMatching(file: RegistryFile, collection: RowCollection, field: LookupField, value: LookupValue): string[] {
  return keyedReaders.get(file)?.(collection, field, value) ?? Object.entries(file[collection]).filter(([, row]) => (typeof value === "string" ? [value] : value).includes(lookupValue(row, field) as string)).map(([key]) => key);
}

function lookupValue(row: unknown, field: LookupField): unknown {
  if (field === "alias") return row;
  return field.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, row);
}

export function registryConversationsForPath(file: RegistryFile, path: string): RegistryFile["conversations"][string][] {
  const keys = pathReaders.get(file)?.(path);
  return keys ? keys.map(key => file.conversations[key]!).filter(Boolean) : Object.values(file.conversations).filter(row =>
    row.generations.some(generation => generation.path === path) || row.continuityPaths.includes(path));
}

type StoredRow = { collection: string; row_key: string; value_json: string; row_order: number };
type MetaRow = { key: string; value: string };
type CachedRow = { valueJson: string; parsed: unknown };

/** Per grant-bearing row, the stored JSON it was decided from and the MCP lists
    the assembled decision left on it: one for an entry or a receipt, one per
    generation for a conversation. */
type RecordedGrant = { storedJson: string | undefined; lists: readonly (readonly string[] | undefined)[] };
/** `stamp` detects commits since the last read. The row journal then removes
    decisions whose source rows changed, including changes that did not bump
    the registry revision. */
type GrantDecisions = {
  revision: number;
  stamp: string;
  changeId: number;
  rows: Map<string, RecordedGrant>;
  sourceTargets: Map<string, Set<string>>;
  entryPaths: Map<string, Set<string>>;
  receiptConversations: Map<string, Set<string>>;
  receiptKeys: Map<string, Set<string>>;
  conversationByEntryKey: Map<string, Set<string>>;
  conversationByPath: Map<string, Set<string>>;
};
type GrantProfileRow = { launchProfile?: { mcpServers?: string[] } | null; generations?: { launchProfile?: { mcpServers?: string[] } }[] };

const grantDecisionKey = (collection: string, key: string) => `${collection}\u0000${key}`;

function grantLists(collection: string, row: GrantProfileRow): (string[] | undefined)[] {
  return collection === "conversations"
    ? (row.generations ?? []).map((generation) => generation.launchProfile?.mcpServers)
    : [row.launchProfile?.mcpServers];
}

/** Read off a file the assembled decision has just run over. `storedJson`
    names the stored row each decision was made from. */
function recordGrantDecisions(
  file: RegistryFile,
  revision: number,
  stamp: string,
  changeId: number,
  storedJson: (collection: RowCollection, key: string) => string | undefined,
): GrantDecisions {
  const rows = new Map<string, RecordedGrant>();
  const decisions: GrantDecisions = {
    revision, stamp, changeId, rows,
    sourceTargets: new Map(), entryPaths: new Map(), receiptConversations: new Map(), receiptKeys: new Map(),
    conversationByEntryKey: new Map(), conversationByPath: new Map(),
  };
  for (const collection of ["entries", "receipts", "conversations"] as const) {
    for (const [key, row] of Object.entries(file[collection] as Record<string, GrantProfileRow>)) {
      rows.set(grantDecisionKey(collection, key), {
        storedJson: storedJson(collection, key),
        lists: grantLists(collection, row).map((list) => list && [...list]),
      });
      if (collection === "entries") addIndexedTarget(decisions.entryPaths, (row as RegistryFile["entries"][string]).artifactPath, grantDecisionKey(collection, key));
      if (collection === "receipts") indexReceipt(decisions, key, row as RegistryFile["receipts"][string]);
    }
  }
  for (const [key, row] of Object.entries(file.conversations)) indexGrantSource(decisions, "conversations", key, row);
  for (const [key, row] of Object.entries(file.lineageEdges)) indexGrantSource(decisions, "lineageEdges", key, row);
  return decisions;
}

function addIndexedTarget(index: Map<string, Set<string>>, source: string | null | undefined, target: string): void {
  if (!source) return;
  const targets = index.get(source) ?? new Set<string>();
  targets.add(target);
  index.set(source, targets);
}

function indexReceipt(decisions: GrantDecisions, key: string, receipt: RegistryFile["receipts"][string]): void {
  const target = grantDecisionKey("receipts", key);
  addIndexedTarget(decisions.receiptConversations, receipt.conversationId, target);
  if (receipt.conversationId) {
    addIndexedTarget(decisions.sourceTargets, grantDecisionKey("conversations", receipt.conversationId), target);
    addIndexedTarget(decisions.sourceTargets, grantDecisionKey("lineageEdges", receipt.conversationId), target);
  }
  if (receipt.key) {
    const entryKey = sessionKeyId(receipt.key);
    addIndexedTarget(decisions.receiptKeys, entryKey, target);
    for (const conversationId of decisions.conversationByEntryKey.get(entryKey) ?? []) {
      addIndexedTarget(decisions.sourceTargets, grantDecisionKey("conversations", conversationId), target);
      addIndexedTarget(decisions.sourceTargets, grantDecisionKey("lineageEdges", conversationId), target);
    }
  }
}

function indexGrantSource(decisions: GrantDecisions, collection: "conversations" | "lineageEdges", key: string, row: unknown): Set<string> {
  const source = grantDecisionKey(collection, key);
  const targets = decisions.sourceTargets.get(source) ?? new Set<string>();
  if (collection === "conversations") {
    targets.add(grantDecisionKey("conversations", key));
    for (const receipt of decisions.receiptConversations.get(key) ?? []) targets.add(receipt);
    const conversation = row as RegistryFile["conversations"][string];
    for (const generation of conversation.generations) {
      const entryKey = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
      addIndexedTarget(decisions.conversationByEntryKey, entryKey, key);
      addIndexedTarget(decisions.conversationByPath, generation.path, key);
      targets.add(grantDecisionKey("entries", entryKey));
      for (const receipt of decisions.receiptKeys.get(entryKey) ?? []) targets.add(receipt);
      for (const entry of decisions.entryPaths.get(generation.path) ?? []) targets.add(entry);
    }
    // A later edge edit must also invalidate targets introduced by this conversation edit.
    const edgeTargets = decisions.sourceTargets.get(grantDecisionKey("lineageEdges", key));
    if (edgeTargets) for (const target of targets) edgeTargets.add(target);
  } else {
    targets.add(grantDecisionKey("conversations", key));
    for (const target of decisions.sourceTargets.get(grantDecisionKey("conversations", key)) ?? []) targets.add(target);
    const edge = row as RegistryFile["lineageEdges"][string];
    if (edge.evidence?.launchId) targets.add(grantDecisionKey("receipts", edge.evidence.launchId));
  }
  decisions.sourceTargets.set(source, targets);
  return targets;
}

/** Gives one row what the assembled decision gave it, but only when the row is
    stored exactly as it was when that decision ran: a row rewritten without a
    revision can never inherit a decision made about its predecessor. False
    when the record cannot say, so the caller decides in full. */
function applyRecordedGrantDecision(
  decisions: GrantDecisions,
  collection: string,
  key: string,
  storedJson: string | null | undefined,
  row: unknown,
  rewritten: () => void,
): boolean {
  // The decision reads lineage edges and never rewrites one.
  if (collection === "lineageEdges") return true;
  const recorded = decisions.rows.get(grantDecisionKey(collection, key));
  if (!recorded || recorded.storedJson === undefined || recorded.storedJson !== storedJson) return false;
  const target = row as GrantProfileRow;
  const profiles = collection === "conversations"
    ? (target.generations ?? []).map((generation) => generation.launchProfile)
    : [target.launchProfile];
  if (recorded.lists.length !== profiles.length) return false;
  for (const [index, profile] of profiles.entries()) {
    if ((profile?.mcpServers === undefined) !== (recorded.lists[index] === undefined)) return false;
  }
  let changed = false;
  for (const [index, profile] of profiles.entries()) {
    const list = recorded.lists[index];
    if (!profile?.mcpServers || !list) continue;
    if (profile.mcpServers.length !== list.length || profile.mcpServers.some((name, at) => name !== list[at])) changed = true;
    profile.mcpServers = [...list];
  }
  // A mutation persists what the decision rewrote, as it does after the full one.
  if (changed) rewritten();
  return true;
}

interface RegistryChanges {
  rows: Map<RowCollection, Set<string>>;
  meta: Set<(typeof META_FIELDS)[number]>;
  order: Set<RowCollection>;
}

export interface SqliteRegistrySnapshot {
  file: RegistryFile;
  revision: number;
}

export interface SqliteRegistryReplacement extends SqliteRegistrySnapshot {
  replaced: boolean;
}

export interface SqliteRegistryMutation<T> {
  result: T;
  file: RegistryFile | null;
  revision: number;
}

export class RegistryMutationRetryLimitError extends Error {
  override name = "RegistryMutationRetryLimitError";
  constructor(readonly operationName: string, readonly attempts: number) {
    super(`registry mutation ${operationName} exceeded ${attempts} attempts`);
  }
}

export interface SqliteRegistryStoreOptions {
  /** The legacy registry to import on first boot. A loader is called only
      when the store holds no import marker, so an initialised store never
      reads the JSON. */
  initialSnapshot: RegistryFile | (() => RegistryFile);
  /** Runs inside the import transaction with the source as it was decided and
      the snapshot read back from the new rows. Throwing rolls the import back,
      leaving the store unmarked. */
  verifyImport?(source: RegistryFile, imported: RegistryFile): void;
  /** Open an existing, imported store for reading only: no schema, no import,
      no file-mode changes. A preview uses it to see the registry without
      performing any of a writer's startup work. */
  readOnly?: boolean;
  normalize(value: unknown): RegistryFile;
  /** Grant bound for the assembled-snapshot rebound below, matching whatever
      `normalize` enforces. Production omits both; a test supplies a policy that
      HAS a grantable connector, because the shipped bound has none and an empty
      bound cannot tell an origin reset from itself (issue #739). */
  mcpGrantPolicy?: McpGrantPolicy;
  onWriterWait?(durationMs: number): void;
  onSnapshotLoad?(): void;
  onRowPayloadRead?(collection: RowCollection, count: number): void;
  onRowPayloadParse?(collection: RowCollection, count: number): void;
  onRevisionQuery?(): void;
  /** Test seam for the hard ceiling; production uses two attempts. */
  maxMutationAttempts?: number;
}

/**
 * A registry file no undecided MCP grant can leave (#739).
 *
 * The three row writers below take ONLY this type, and `markDecided` is the one
 * place that mints it, so a new persist path cannot be written without the
 * decision — it is a compile error, not a convention a future path has to know
 * about. That is the difference between this and enumerating today's callers:
 * enumeration notices a fourth entry point after somebody adds it, this one
 * refuses to let it be expressed.
 *
 * A file earns the brand two ways, and they are the same guarantee reached
 * differently:
 *
 *  - `decideAssembled` has run {@link reboundAssembledMcpGrants} over the whole
 *    of it, which is what a payload arriving from OUTSIDE the store needs;
 *  - it came from the lazy loader, whose row accessors run that same decision
 *    before handing out any row that claims more than the baseline, which is
 *    what a mutation reading rows one at a time needs.
 *
 * The brand is a runtime WeakSet as well as a type, so an `as` cast that skips
 * `markDecided` still throws at the write rather than silently persisting.
 */
declare const DECIDED: unique symbol;
export type DecidedRegistryFile = RegistryFile & { readonly [DECIDED]: true };

type StampedSnapshot = SqliteRegistrySnapshot & { stamp: string };

interface LazyRegistrySnapshot extends SqliteRegistrySnapshot {
  file: DecidedRegistryFile;
  changes(): RegistryChanges;
}

function trackMutableJson<T>(
  value: T,
  markDirty: () => void,
  seen: WeakMap<object, object>,
): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  const cached = seen.get(object);
  if (cached) return cached as T;
  const proxy = new Proxy(object, {
    get: (target, property, receiver) => trackMutableJson(Reflect.get(target, property, receiver), markDirty, seen),
    set: (target, property, next) => {
      markDirty();
      return Reflect.set(target, property, next);
    },
    deleteProperty: (target, property) => {
      markDirty();
      return Reflect.deleteProperty(target, property);
    },
    defineProperty: (target, property, descriptor) => {
      markDirty();
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
  seen.set(object, proxy);
  return proxy as T;
}

export class SqliteAgentRegistryStore {
  private readonly db: BunDatabase;
  private readonly normalize: (value: unknown) => RegistryFile;
  private readonly onWriterWait: ((durationMs: number) => void) | undefined;
  private readonly maxMutationAttempts: number;
  private onSnapshotLoad: (() => void) | undefined;
  private onRowPayloadRead: ((collection: RowCollection, count: number) => void) | undefined;
  private onRowPayloadParse: ((collection: RowCollection, count: number) => void) | undefined;
  private onRevisionQuery: (() => void) | undefined;
  private readonly rowCache = new Map<RowCollection, Map<string, CachedRow>>();
  private revisionCache: { signature: string; revision: number } | null = null;
  /** Stamped like the grant record: a complete snapshot is only ever handed
      out again over exactly the database it was loaded from. */
  private readOnlyCache: StampedSnapshot | null = null;
  /** What the assembled grant decision (#739) returned for every grant-bearing
      row at one stored revision. A keyed read of a row claiming more than the
      baseline otherwise assembles, clones and decides the whole file, per read:
      sixty such rows cost startup half a minute of blocked event loop. */
  private grantDecisions: GrantDecisions | null = null;
  private grantJournalReady = false;

  private readonly mcpGrantPolicy: McpGrantPolicy | undefined;
  /** Runtime half of {@link DecidedRegistryFile}: the files this store has
      actually seen the decision run over, so an `as` cast cannot mint one. */
  private readonly decidedFiles = new WeakSet<object>();

  /** The sole mint. Everything that reaches a row writer passes through here. */
  private markDecided(file: RegistryFile): DecidedRegistryFile {
    this.decidedFiles.add(file);
    return file as DecidedRegistryFile;
  }

  /** For a payload arriving from outside the store, which has had no accessor
      gate applied to it: run the assembled decision over the whole file. */
  private decideAssembled(file: RegistryFile): DecidedRegistryFile {
    reboundAssembledMcpGrants(file, this.mcpGrantPolicy);
    return this.markDecided(file);
  }

  private assertDecided(file: DecidedRegistryFile): void {
    if (this.decidedFiles.has(file)) return;
    throw new Error("agent registry rows cannot be persisted before the MCP grant decision has run (#739)");
  }

  constructor(readonly filename: string, options: SqliteRegistryStoreOptions) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("SQLite registry modes require the Bun runtime");
    const { Database } = sqlite;
    this.normalize = options.normalize;
    this.onWriterWait = options.onWriterWait;
    this.maxMutationAttempts = options.maxMutationAttempts ?? 2;
    if (!Number.isInteger(this.maxMutationAttempts) || this.maxMutationAttempts < 1) {
      throw new RangeError("maxMutationAttempts must be a positive integer");
    }
    this.onSnapshotLoad = options.onSnapshotLoad;
    this.onRowPayloadRead = options.onRowPayloadRead;
    this.onRowPayloadParse = options.onRowPayloadParse;
    this.onRevisionQuery = options.onRevisionQuery;
    this.mcpGrantPolicy = options.mcpGrantPolicy;
    if (options.readOnly) {
      /* Bound to the file at its name like the writer below, so a preview
         held across a fallback restore reads the registry that now carries it. */
      this.db = openCurrentDatabase(filename, () => {
        const db = new Database(filename, { readonly: true, strict: true });
        db.exec("PRAGMA busy_timeout = 5000");
        return db;
      }, { reopened: (db) => this.onDatabaseReopened(db) });
      const table = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registry_meta'").get();
      if (!table || !this.imported()) {
        this.db.close();
        throw new Error(`${path.basename(filename)} holds no imported registry`);
      }
      this.grantJournalReady = Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registry_grant_changes'").get());
      return;
    }
    /* Bound to the file at its name: a registry the activation fallback
       replaced is reopened, never written through the moved handle. */
    this.db = openCurrentDatabase(filename, () => {
      const db = new Database(filename, { create: true, strict: true });
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA journal_size_limit = 67108864; PRAGMA foreign_keys = ON; PRAGMA auto_vacuum = INCREMENTAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS registry_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registry_rows (
          collection TEXT NOT NULL,
          row_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          row_order INTEGER NOT NULL,
          PRIMARY KEY(collection, row_key)
        );
      `);
      // A restored pre-upgrade database can arrive under a held connection.
      // Install the journal on each connection, including one opened after a
      // file replacement, before any mutation can use it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS registry_grant_changes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          collection TEXT NOT NULL,
          row_key TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS registry_grant_insert AFTER INSERT ON registry_rows
          WHEN NEW.collection IN ('entries', 'receipts', 'conversations', 'lineageEdges') BEGIN
          INSERT INTO registry_grant_changes(collection, row_key) VALUES (NEW.collection, NEW.row_key);
        END;
        CREATE TRIGGER IF NOT EXISTS registry_grant_update AFTER UPDATE ON registry_rows
          WHEN NEW.collection IN ('entries', 'receipts', 'conversations', 'lineageEdges') BEGIN
          INSERT INTO registry_grant_changes(collection, row_key) VALUES (NEW.collection, NEW.row_key);
        END;
        CREATE TRIGGER IF NOT EXISTS registry_grant_delete AFTER DELETE ON registry_rows
          WHEN OLD.collection IN ('entries', 'receipts', 'conversations', 'lineageEdges') BEGIN
          INSERT INTO registry_grant_changes(collection, row_key) VALUES (OLD.collection, OLD.row_key);
        END;
      `);
      return db;
    }, { reopened: (db) => this.onDatabaseReopened(db) });
    this.grantJournalReady = true;
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(registry_rows)").all();
    if (!columns.some((column) => column.name === "row_order")) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE registry_rows ADD COLUMN row_order INTEGER NOT NULL DEFAULT 0;
        WITH ordered AS (
          SELECT rowid, ROW_NUMBER() OVER (PARTITION BY collection ORDER BY rowid) - 1 AS position
          FROM registry_rows
        )
        UPDATE registry_rows
        SET row_order = (SELECT position FROM ordered WHERE ordered.rowid = registry_rows.rowid);
        INSERT INTO registry_meta(key, value) VALUES ('schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        COMMIT;
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS registry_rows_collection_order
      ON registry_rows(collection, row_order);
      CREATE INDEX IF NOT EXISTS registry_seat_children_order
      ON registry_rows(json_extract(value_json, '$.parentConversationId'), row_order)
      WHERE collection = 'lineageEdges' AND json_extract(value_json, '$.source') = 'viewer-spawn';
    `);
    for (const [field, jsonPath] of Object.entries(LOOKUP_PATHS)) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS registry_lookup_${field.replaceAll(".", "_")} ON registry_rows(collection, json_extract(value_json, '${jsonPath}'), row_order)${field === 'alias' ? " WHERE collection = 'conversationAliases'" : ''}`);
    }
    // Array paths need a relational index. Triggers cover every writer,
    // including older releases sharing this journal during handover.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registry_conversation_paths (
        path TEXT NOT NULL, conversation_id TEXT NOT NULL, PRIMARY KEY(path, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS registry_conversation_paths_owner ON registry_conversation_paths(conversation_id);
    `);
    // The outer UPSERT's conflict policy overrides a trigger's OR IGNORE.
    // Explicit UPSERT clauses keep overlapping generation/continuity paths
    // harmless, including writes from a predecessor release during handover.
    if (this.meta("conversation_paths_trigger_version") !== "2") {
      this.db.transaction(() => {
        this.db.exec(`
          DROP TRIGGER IF EXISTS registry_paths_insert;
          DROP TRIGGER IF EXISTS registry_paths_update;
          DROP TRIGGER IF EXISTS registry_paths_delete;
          CREATE TRIGGER registry_paths_insert AFTER INSERT ON registry_rows WHEN NEW.collection = 'conversations' BEGIN
            INSERT INTO registry_conversation_paths SELECT json_extract(value, '$.path'), NEW.row_key FROM json_each(NEW.value_json, '$.generations') WHERE json_extract(value, '$.path') IS NOT NULL ON CONFLICT(path, conversation_id) DO NOTHING;
            INSERT INTO registry_conversation_paths SELECT value, NEW.row_key FROM json_each(NEW.value_json, '$.continuityPaths') WHERE true ON CONFLICT(path, conversation_id) DO NOTHING;
          END;
          CREATE TRIGGER registry_paths_update AFTER UPDATE ON registry_rows WHEN NEW.collection = 'conversations' BEGIN
            DELETE FROM registry_conversation_paths WHERE conversation_id = OLD.row_key;
            INSERT INTO registry_conversation_paths SELECT json_extract(value, '$.path'), NEW.row_key FROM json_each(NEW.value_json, '$.generations') WHERE json_extract(value, '$.path') IS NOT NULL ON CONFLICT(path, conversation_id) DO NOTHING;
            INSERT INTO registry_conversation_paths SELECT value, NEW.row_key FROM json_each(NEW.value_json, '$.continuityPaths') WHERE true ON CONFLICT(path, conversation_id) DO NOTHING;
          END;
          CREATE TRIGGER registry_paths_delete AFTER DELETE ON registry_rows WHEN OLD.collection = 'conversations' BEGIN
            DELETE FROM registry_conversation_paths WHERE conversation_id = OLD.row_key;
          END;
          INSERT INTO registry_meta(key, value) VALUES ('conversation_paths_trigger_version', '2')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        `);
      }).immediate();
    }
    if (this.meta("conversation_paths_ready") !== "1") {
      this.db.exec(`BEGIN IMMEDIATE;
        INSERT OR IGNORE INTO registry_conversation_paths SELECT json_extract(g.value, '$.path'), r.row_key FROM registry_rows r, json_each(r.value_json, '$.generations') g WHERE r.collection = 'conversations' AND json_extract(g.value, '$.path') IS NOT NULL;
        INSERT OR IGNORE INTO registry_conversation_paths SELECT p.value, r.row_key FROM registry_rows r, json_each(r.value_json, '$.continuityPaths') p WHERE r.collection = 'conversations';
        INSERT OR REPLACE INTO registry_meta(key, value) VALUES ('conversation_paths_ready', '1'); COMMIT;`);
    }
    this.secureFiles();
    this.importFirstBoot(options.initialSnapshot, options.verifyImport);
  }

  /** Runs a read the caller's storage metrics must not count: the import's
      own read-back is not a registry read. */
  private unobserved<T>(read: () => T): T {
    const observers = [this.onSnapshotLoad, this.onRowPayloadRead, this.onRowPayloadParse, this.onRevisionQuery] as const;
    this.onSnapshotLoad = this.onRowPayloadRead = this.onRowPayloadParse = this.onRevisionQuery = undefined;
    try {
      return read();
    } finally {
      [this.onSnapshotLoad, this.onRowPayloadRead, this.onRowPayloadParse, this.onRevisionQuery] = observers;
    }
  }

  /** Whether the first-boot import has committed. */
  imported(): boolean {
    return this.meta("migration_complete") === "1";
  }

  close(): void {
    this.db.close();
  }

  private onDatabaseReopened(db: BunDatabase): void {
    // A restored file may have the same revision and counter stamp as the file
    // it replaced. No parsed row or assembled grant from the old inode holds.
    this.rowCache.clear();
    this.revisionCache = null;
    this.readOnlyCache = null;
    this.grantDecisions = null;
    this.grantJournalReady = Boolean(db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registry_grant_changes'",
    ).get());
  }

  snapshot(): SqliteRegistrySnapshot {
    const { file, revision } = this.loadSnapshot(false);
    return { file, revision };
  }

  private loadSnapshot(useRowCache: boolean): StampedSnapshot {
    this.onSnapshotLoad?.();
    this.db.exec("BEGIN");
    try {
      const snapshot = this.loadInTransaction(useRowCache);
      const stamp = this.storeStamp();
      this.db.exec("COMMIT");
      return { ...snapshot, stamp };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  revision(): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = this.storageSignature();
      if (this.revisionCache?.signature === before) return this.revisionCache.revision;
      this.onRevisionQuery?.();
      const revision = Number(this.meta("revision") ?? 0);
      const after = this.storageSignature();
      if (before !== after) continue;
      this.revisionCache = { signature: after, revision };
      return revision;
    }
    this.onRevisionQuery?.();
    const revision = Number(this.meta("revision") ?? 0);
    this.rememberRevision(revision);
    return revision;
  }

  readOnlySnapshot(): SqliteRegistrySnapshot {
    const revision = this.revision();
    /* The revision alone cannot say the rows are the ones cached: a commit that
       rewrites a row without advancing it would leave the decision over the old
       rows standing in every whole-file read. */
    if (this.readOnlyCache?.revision === revision && this.readOnlyCache.stamp === this.storeStamp()) return this.readOnlyCache;
    this.readOnlyCache = this.loadSnapshot(true);
    return this.readOnlyCache;
  }

  /** The callback must finish inside the transaction; no lazy object escapes. */
  read<T>(reader: (file: RegistryFile) => T): T {
    this.db.exec("BEGIN");
    try {
      const result = reader(this.loadLazyInTransaction(true, true, true).file);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    }
  }

  /** One transaction and keyed row reads for the at-most-bounded spawn paths in
      a Viewer snapshot. No collection enumeration or whole snapshot occurs. */
  snapshotSpawns(launchIds: readonly string[]): SnapshotSpawnProjection {
    this.db.exec("BEGIN");
    try {
      const readRow = (collection: RowCollection, key: string): unknown => {
        const stored = this.db.query<Pick<StoredRow, "value_json">, [string, string]>(
          "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
        ).get(collection, key);
        this.onRowPayloadRead?.(collection, stored ? 1 : 0);
        return stored ? this.parseRow(collection, key, stored.value_json, true) : undefined;
      };
      const normalizeRow = <Collection extends "receipts" | "conversations" | "entries">(
        collection: Collection,
        key: string,
        value: unknown,
      ): RegistryFile[Collection][string] | undefined => {
        const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
        input[collection] = { [key]: value };
        return this.normalize(input)[collection][key] as RegistryFile[Collection][string] | undefined;
      };
      const projection: SnapshotSpawnProjection = {};
      for (const launchId of new Set(launchIds)) {
        const rawReceipt = readRow("receipts", launchId);
        if (rawReceipt === undefined) continue;
        const receipt = normalizeRow("receipts", launchId, rawReceipt);
        if (!receipt) continue;

        const seen = new Set<string>();
        let conversationId: string = receipt.conversationId;
        let aliasLimitReached = false;
        while (!seen.has(conversationId) && seen.size < SNAPSHOT_SPAWN_ALIAS_LIMIT) {
          seen.add(conversationId);
          const alias = readRow("conversationAliases", conversationId);
          if (typeof alias !== "string" || !alias.startsWith("conversation_")) break;
          conversationId = alias;
          aliasLimitReached = seen.size === SNAPSHOT_SPAWN_ALIAS_LIMIT;
        }
        const rawConversation = aliasLimitReached ? undefined : readRow("conversations", conversationId);
        const conversation = rawConversation === undefined
          ? undefined
          : normalizeRow("conversations", conversationId, rawConversation);
        const needsLegacyTransportEvidence = receipt.state !== "completed"
          && receipt.transport === null
          && receipt.key !== null;
        const rawEntry = needsLegacyTransportEvidence && receipt.key
          ? readRow("entries", sessionKeyId(receipt.key))
          : undefined;
        const entry = receipt.key && rawEntry !== undefined
          ? normalizeRow("entries", sessionKeyId(receipt.key), rawEntry)
          : undefined;
        const identityPublished = identityMaterializationFence().allowsReceipt(receipt, { entry });
        projection[launchId] = {
          launchId: receipt.launchId,
          state: receipt.state,
          error: receipt.error,
          engine: receipt.engine,
          cwd: receipt.cwd,
          createdAt: receipt.createdAt,
          materializedPath: identityPublished
            ? conversation?.generations.at(-1)?.path ?? receipt.artifactPath
            : null,
        };
      }
      this.db.exec("COMMIT");
      return projection;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  /**
   * One page of a seat's spawned children (#1465), in the order their lineage
   * edges were inserted, past `after`.
   *
   * Insertion order is what makes discovery keep pace with a seat that has
   * hundreds of children: the store assigns `row_order` monotonically, so a
   * child spawned after a sweep completed is exactly the next page, and no
   * sweep ever restarts from the beginning. The anchor is re-resolved by key
   * every time: an edge that was renumbered is followed at its current order,
   * and one that is gone restarts the sweep, which is idempotent for the
   * caller. `keys` reads the named edges instead, for a re-projection.
   */
  pageSeatChildren(parentId: string, after: SeatChildrenAnchor | null, limit: number, keys?: readonly string[]): SeatChildrenPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw new Error("invalid child page limit");
    if (keys && keys.length > limit) throw new Error("child key budget exceeded");
    this.db.exec("BEGIN");
    try {
      const file = this.normalize({ version: 2, entries: {}, receipts: {} });
      let evidenceGap = false;
      const read = (collection: RowCollection, key: string) => {
        const row = this.db.query<{ value_json: string }, [string, string]>(
          "SELECT value_json FROM registry_rows WHERE collection=? AND row_key=?",
        ).get(collection, key);
        this.onRowPayloadRead?.(collection, row ? 1 : 0);
        if (row) (file[collection] as Record<string, unknown>)[key] = this.parseRow(collection, key, row.value_json, true);
      };
      let anchor: SeatChildrenAnchor | null = null;
      if (after && !keys) {
        const current = this.db.query<{ row_order: number }, [string]>(
          "SELECT row_order FROM registry_rows WHERE collection='lineageEdges' AND row_key=?",
        ).get(after.key);
        anchor = current ? { key: after.key, order: current.row_order } : null;
      }
      const latest = keys ? null : this.db.query<{ row_key: string; row_order: number }, [string]>(`
        SELECT row_key,row_order FROM registry_rows WHERE collection='lineageEdges'
        AND json_extract(value_json,'$.source')='viewer-spawn'
        AND json_extract(value_json,'$.parentConversationId')=? ORDER BY row_order DESC LIMIT 1
      `).get(parentId);
      const rows = keys ? keys.flatMap((key) => {
        const row = this.db.query<{ row_key: string; value_json: string; row_order: number }, [string]>(
          "SELECT row_key,value_json,row_order FROM registry_rows WHERE collection='lineageEdges' AND row_key=?",
        ).get(key);
        return row ? [row] : [];
      }) : this.db.query<{ row_key: string; value_json: string; row_order: number }, [string, number, number]>(`
        SELECT row_key,value_json,row_order FROM registry_rows WHERE collection='lineageEdges'
        AND json_extract(value_json,'$.source')='viewer-spawn'
        AND json_extract(value_json,'$.parentConversationId')=? AND row_order>?
        ORDER BY row_order LIMIT ?
      `).all(parentId, anchor?.order ?? Number.MIN_SAFE_INTEGER, limit);
      this.onRowPayloadRead?.("lineageEdges", rows.length);
      for (const row of rows) {
        const edge = this.parseRow("lineageEdges", row.row_key, row.value_json, true) as RegistryFile["lineageEdges"][string];
        file.lineageEdges[row.row_key] = edge;
        if (edge.evidence.launchId) read("receipts", edge.evidence.launchId);
        let id: string = edge.childConversationId;
        let invalidAlias = false;
        const seen = new Set<string>();
        for (let depth = 0; depth < 64; depth++) {
          if (seen.has(id)) { evidenceGap = true; invalidAlias = true; break; }
          seen.add(id);
          read("conversationAliases", id);
          const alias = file.conversationAliases[id];
          if (!alias) break;
          id = alias;
          if (depth === 63) { evidenceGap = true; invalidAlias = true; }
        }
        if (invalidAlias) { delete file.lineageEdges[row.row_key]; continue; }
        read("conversations", id);
        read("memberships", id);
        const conversation = file.conversations[id];
        const receipt = edge.evidence.launchId ? file.receipts[edge.evidence.launchId] : null;
        const generation = conversation?.generations.at(-1);
        for (const key of [edge.childSessionKey, receipt?.key, generation ? { engine: conversation!.engine, sessionId: generation.id } : null]) {
          if (key) read("entries", sessionKeyId(key));
        }
      }
      this.db.exec("COMMIT");
      const last = rows.at(-1);
      return {
        file,
        keys: rows.map((row) => row.row_key),
        after: keys ? after : last ? { key: last.row_key, order: last.row_order } : anchor,
        latest: latest ? { key: latest.row_key, order: latest.row_order } : null,
        complete: rows.length < limit,
        evidenceGap,
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* No open transaction. */ }
      throw error;
    }
  }

  seatTickConversation(id: string): Pick<RegistryFile["conversations"][string], "id" | "turn"> | null {
    this.db.exec("BEGIN");
    try {
      const read = (collection: "conversationAliases" | "conversations", key: string) => {
        const row = this.db.query<{ value_json: string }, [string, string]>(
          "SELECT value_json FROM registry_rows WHERE collection=? AND row_key=?",
        ).get(collection, key);
        this.onRowPayloadRead?.(collection, row ? 1 : 0);
        return row ? this.parseRow(collection, key, row.value_json, true) : undefined;
      };
      const seen = new Set<string>();
      let current = id;
      for (let depth = 0; depth < 64; depth++) {
        if (seen.has(current)) throw new Error("seat alias cycle");
        seen.add(current);
        const alias = read("conversationAliases", current);
        if (alias === undefined) {
          const raw = read("conversations", current);
          const conversation = raw === undefined ? null : this.normalize({ version: 2, entries: {}, receipts: {}, conversations: { [current]: raw } }).conversations[current];
          if (raw !== undefined && !conversation) throw new Error("invalid seat conversation");
          this.db.exec("COMMIT");
          return conversation ? { id: conversation.id, turn: conversation.turn } : null;
        }
        if (typeof alias !== "string" || !alias.startsWith("conversation_")) throw new Error("invalid seat alias");
        current = alias;
      }
      throw new Error("seat alias traversal budget exhausted");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* No open transaction. */ }
      throw error;
    }
  }

  /** Retirement observation reads only the named conversation and session row.
      No receipt/catalog materialization, catalog fallback or state write. */
  retirementSubject(conversationId: string, key: string): {
    conversation: RegistryFile["conversations"][string] | null;
    entry: RegistryFile["entries"][string] | null;
  } {
    this.db.exec("BEGIN");
    try {
      const read = (collection: "conversations" | "entries", id: string): unknown => {
        const row = this.db.query<{ value_json: string | null }, [string, string]>(
          "SELECT CASE WHEN length(CAST(value_json AS BLOB)) <= 262144 THEN value_json END AS value_json FROM registry_rows WHERE collection=? AND row_key=?",
        ).get(collection, id);
        this.onRowPayloadRead?.(collection, row ? 1 : 0);
        if (!row) return null;
        if (row.value_json === null) throw new Error("retirement subject exceeds the row byte budget");
        return this.parseRow(collection, id, row.value_json, true);
      };
      const rawConversation = read("conversations", conversationId);
      const rawEntry = read("entries", key);
      const normalized = this.normalize({ version: 2, receipts: {},
        conversations: rawConversation === null ? {} : { [conversationId]: rawConversation },
        entries: rawEntry === null ? {} : { [key]: rawEntry } });
      this.db.exec("COMMIT");
      return { conversation: normalized.conversations[conversationId] ?? null, entry: normalized.entries[key] ?? null };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* No open transaction. */ }
      throw error;
    }
  }

  /** The receipt is a lookup key. Match either the capability digest or the
      session identity already attributed by the trusted MCP server. */
  retirementCaller(launchId: string, authentication: string | { conversationId: string }): string | null {
    const row = this.db.query<{ value_json: string | null }, [string]>(
      "SELECT CASE WHEN length(CAST(value_json AS BLOB)) <= 262144 THEN value_json END AS value_json FROM registry_rows WHERE collection='receipts' AND row_key=?",
    ).get(launchId);
    this.onRowPayloadRead?.("receipts", row ? 1 : 0);
    if (!row?.value_json) return null;
    const receipt = JSON.parse(row.value_json) as { spawnCapabilityDigest?: unknown; conversationId?: unknown };
    if (typeof authentication !== "string") {
      return receipt.conversationId === authentication.conversationId ? authentication.conversationId : null;
    }
    const digest = authentication;
    if (typeof receipt.spawnCapabilityDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.spawnCapabilityDigest)
      || !/^[a-f0-9]{64}$/.test(digest) || typeof receipt.conversationId !== "string") return null;
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(receipt.spawnCapabilityDigest, "hex"))
      ? receipt.conversationId : null;
  }

  /** Keyed title lookup for the bounded custom-title store. A request reads at
      most one alias chain and one conversation row per title record; it never
      enumerates a registry collection. */
  snapshotTitleConversations(conversationIds: readonly string[]): SnapshotTitleConversationProjection {
    this.db.exec("BEGIN");
    try {
      const readRow = (collection: "conversationAliases" | "conversations", key: string): unknown => {
        const stored = this.db.query<Pick<StoredRow, "value_json">, [string, string]>(
          "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
        ).get(collection, key);
        this.onRowPayloadRead?.(collection, stored ? 1 : 0);
        return stored ? this.parseRow(collection, key, stored.value_json, true) : undefined;
      };
      const normalizedConversation = (key: string, value: unknown): RegistryFile["conversations"][string] | undefined => {
        const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {}, conversations: { [key]: value } };
        return this.normalize(input).conversations[key];
      };
      const grouped = new Map<string, { aliases: Set<string>; conversation: RegistryFile["conversations"][string] }>();
      for (const requestedId of [...new Set(conversationIds)].slice(0, SNAPSHOT_TITLE_CONVERSATION_LIMIT)) {
        if (!requestedId.startsWith("conversation_")) continue;
        const seen = new Set<string>();
        let conversationId: string | null = requestedId;
        let aliasLimitReached = false;
        while (conversationId) {
          if (seen.has(conversationId)) {
            conversationId = null;
            break;
          }
          if (seen.size >= SNAPSHOT_SPAWN_ALIAS_LIMIT) {
            aliasLimitReached = true;
            break;
          }
          seen.add(conversationId);
          const alias = readRow("conversationAliases", conversationId);
          if (typeof alias !== "string" || !alias.startsWith("conversation_")) break;
          conversationId = alias;
        }
        if (!conversationId || aliasLimitReached) continue;
        const held = grouped.get(conversationId);
        const rawConversation = held ? undefined : readRow("conversations", conversationId);
        const conversation = held?.conversation
          ?? (rawConversation === undefined ? undefined : normalizedConversation(conversationId, rawConversation));
        if (!conversation) continue;
        const group = held ?? { aliases: new Set<string>(), conversation };
        for (const alias of seen) if (alias !== conversationId) group.aliases.add(alias);
        grouped.set(conversationId, group);
      }
      const projection = [...grouped.values()].map(({ aliases, conversation }) => ({
        conversationId: conversation.id,
        aliases: [...aliases] as RegistryFile["conversationAliases"][string][],
        ownedPaths: [...new Set([
          ...[...conversation.generations].reverse().map((generation) => generation.path),
          ...[...conversation.continuityPaths].reverse(),
        ])].slice(0, SNAPSHOT_TITLE_OWNED_PATH_LIMIT),
      }));
      this.db.exec("COMMIT");
      return projection;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  mutate<T>(operation: (file: RegistryFile) => T, includeSnapshot = true, options: { updateSnapshotCache?: boolean; operationName?: string } = {}): SqliteRegistryMutation<T> {
    let operationName = options.operationName ?? operation.name;
    for (let attempt = 1; attempt <= this.maxMutationAttempts; attempt += 1) {
      const pessimistic = attempt > 1;
      const waitStartedAt = performance.now();
      if (pessimistic) this.beginMutationWrite();
      else this.db.exec("BEGIN");
      let current: LazyRegistrySnapshot;
      let changes: RegistryChanges;
      let result: T;
      try {
        if (pessimistic) this.onWriterWait?.(performance.now() - waitStartedAt);
        current = this.loadLazyInTransaction();
        result = operation(current.file);
        changes = current.changes();
        if (!pessimistic) this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
      const optimisticWaitStartedAt = performance.now();
      if (!pessimistic) this.beginMutationWrite();
      let revision: number;
      let stamps = { before: "", after: "" };
      const changed = changes.rows.size > 0 || changes.meta.size > 0 || changes.order.size > 0;
      try {
        if (!pessimistic) this.onWriterWait?.(performance.now() - optimisticWaitStartedAt);
        if (!pessimistic && Number(this.meta("revision") ?? 0) !== current.revision) {
          this.db.exec("ROLLBACK");
          operationName ||= new Error().stack?.split("\n")[2]?.trim() ?? "anonymous";
          if (attempt >= this.maxMutationAttempts) {
            console.warn(`[registry] mutation ${operationName} reached its retry ceiling after ${attempt} lost revision`);
            throw new RegistryMutationRetryLimitError(operationName, attempt);
          }
          // The next attempt owns the write lock, so it cannot lose a second
          // revision. Surface a costly first loss before it becomes an outage.
          const elapsed = performance.now() - waitStartedAt;
          if (elapsed >= 1_000) console.warn(`[registry] mutation ${operationName} retrying after ${Math.round(elapsed)}ms`);
          continue;
        }
        revision = changed ? current.revision + 1 : current.revision;
        if (changed) {
          // Inside the write lock, so no other connection commits in between.
          const before = this.storeStamp();
          this.persistChanges(current.file, changes, revision);
          stamps = { before, after: this.storeStamp() };
        }
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
      if (changed) {
        this.secureFiles();
        // A narrow delivery commit must not clone populated snapshot maps.
        if (options.updateSnapshotCache === false) this.readOnlyCache = null;
        this.updateCachesAfterCommit(current.file, changes, revision, stamps);
        this.rememberRevision(revision);
      }
      if (includeSnapshot) {
        const committed = this.snapshot();
        return { result, file: committed.file, revision: committed.revision };
      }
      return { result, file: null, revision };
    }
    throw new RegistryMutationRetryLimitError(operationName || "anonymous", this.maxMutationAttempts);
  }

  private beginMutationWrite(): void {
    const deadline = performance.now() + 5_000;
    // SQLite's default busy handler grows its sleep to 100 ms. Short registry
    // commits can repeatedly pass a sleeping lane. Retry acquisition in short
    // intervals, retaining the same total deadline and measuring the whole wait.
    this.db.exec("PRAGMA busy_timeout = 5");
    try {
      for (;;) {
        try {
          this.db.exec("BEGIN IMMEDIATE");
          return;
        } catch (error) {
          if (!(error instanceof Error)
            || (error as { code?: string }).code !== "SQLITE_BUSY"
            || performance.now() >= deadline) throw error;
        }
      }
    } finally {
      this.db.exec("PRAGMA busy_timeout = 5000");
    }
  }

  replace(file: RegistryFile, expectedRevision?: number): SqliteRegistryReplacement {
    /* A wholesale replacement is a mutation like any other, and its payload
       arrives from outside this store, so it is re-decided before it lands
       rather than on the way back out (#739). `persistDiff` takes only a
       DecidedRegistryFile, so this line cannot be dropped without the store
       failing to compile. */
    const decided = this.decideAssembled(file);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.loadInTransaction();
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        this.db.exec("ROLLBACK");
        return { ...current, replaced: false };
      }
      const revision = current.revision + 1;
      this.persistDiff(current.file, decided, revision);
      this.db.exec("COMMIT");
      this.secureFiles();
      this.rowCache.clear();
      this.readOnlyCache = null;
      this.grantDecisions = null;
      this.rememberRevision(revision);
      return { file, revision, replaced: true };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private importFirstBoot(
    initialSnapshot: SqliteRegistryStoreOptions["initialSnapshot"],
    verifyImport: SqliteRegistryStoreOptions["verifyImport"],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const complete = this.meta("migration_complete");
      if (complete !== "1") {
        const source = this.decideAssembled(typeof initialSnapshot === "function" ? initialSnapshot() : initialSnapshot);
        this.persistAll(source, 1);
        this.setMeta("schema_version", "2");
        this.setMeta("migration_complete", "1");
        if (verifyImport) verifyImport(source, this.unobserved(() => this.loadInTransaction().file));
      }
      this.db.exec("COMMIT");
      this.secureFiles();
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private loadInTransaction(useRowCache = false): SqliteRegistrySnapshot {
    const snapshot = this.loadLazyInTransaction(false, useRowCache);
    /* Touching the grant-bearing collections runs the assembled re-decision
       through the same gate every other path goes through (#739); the rest are
       materialized because a snapshot is by definition complete. */
    for (const collection of ROW_COLLECTIONS) void snapshot.file[collection];
    for (const field of META_FIELDS) void snapshot.file[field];
    return snapshot;
  }

  private loadLazyInTransaction(trackMutations = true, useRowCache = trackMutations, readOnly = false): LazyRegistrySnapshot {
    /* Branded here because the row ACCESSORS below carry the guarantee: every
       row this file can hand out goes through `admitRow`, which runs the
       assembled decision before returning anything claiming more than the
       baseline. The brand is what lets `persistChanges` accept it. */
    const file = this.markDecided(this.normalize({ version: 2, entries: {}, receipts: {} }));
    /* The assembled origin re-decision is a PRECONDITION of observing a grant,
       not a step some paths reach later (#739). Rows are normalized one
       collection — one row, even — at a time, so a row loaded lazily has had
       only the global bound applied; the origin half needs the conversations,
       lineage edges and receipts together. `mutate` used to hand its operation
       the lazily normalized file directly, which put every store mutation —
       settlement, structured claim, upsert — underneath the gate that `snapshot`
       passed through.
       Gating the ACCESSORS rather than a call site means the ordering cannot be
       got wrong by a future path. The gate hangs off the ROW, not the
       collection: a row already at the baseline is returned byte-identical by
       the decision, so skipping it there is the gate answering trivially rather
       than a way around it, and a keyed mutation still reads exactly the one row
       it asked for. The first row that claims anything MORE runs the decision
       over the whole file before it is handed out. */
    const revision = Number(this.meta("revision") ?? 0);
    const loadedCollections = new Map<RowCollection, RegistryFile[RowCollection]>();
    const baselineCollections = new Map<RowCollection, Map<string, string | null>>();
    const dirtyRows = new Map<RowCollection, Set<string>>();
    const reorderedCollections = new Set<RowCollection>();
    /* Nothing this transaction wrote yet: the file is exactly the stored
       revision, so the decision over it is the one recorded for that revision. */
    const unchanged = () => reorderedCollections.size === 0
      && [...dirtyRows.values()].every((rows) => rows.size === 0);
    /* Read at most once: nothing this transaction does writes the database, so
       the stored state it sees cannot move under it. */
    let transactionStamp: string | undefined;
    const stamp = () => transactionStamp ??= this.storeStamp();
    const recordHolds = () => {
      this.refreshGrantDecisions(revision, stamp());
      return this.grantDecisions?.revision === revision && this.grantDecisions.stamp === stamp();
    };
    let grantsDecided = false;
    let decidingGrants = false;
    const decideGrants = () => {
      if (grantsDecided || decidingGrants) return;
      decidingGrants = true;
      try {
        const recordable = unchanged();
        reboundAssembledMcpGrants(file, this.mcpGrantPolicy);
        grantsDecided = true;
        if (recordable) {
          this.grantDecisions = recordGrantDecisions(file, revision, stamp(), this.grantChangeId(), (collection, key) =>
            this.rowCache.get(collection)?.get(key)?.valueJson);
        }
      } finally {
        decidingGrants = false;
      }
    };
    /* Whether this transaction reads its decisions from the record. Settled
       once, at the first row that needs a decision, exactly where the whole
       decision would otherwise have run: from then on a row still at the stored
       revision gets what that decision gave it, and a row this transaction
       rewrote is not re-decided, as before. */
    let recordedDecisions: GrantDecisions | null | undefined;
    /* Every row leaves a loader through here. A row at the baseline is admitted
       untouched; anything claiming more is only returned once the decision has
       run over the whole file, including the rows attesting to this one. */
    const admitRow = <T>(collection: RowCollection, key: string, storedJson: string | null | undefined, row: T): T => {
      if (!GRANT_COLLECTIONS.has(collection) || grantsDecided || decidingGrants
        || !rowClaimsBeyondBaselineGrant(row)) return row;
      if (recordedDecisions === undefined) {
        if (readOnly && unchanged() && !recordHolds()) {
          /* The same decision over the same revision, read in this transaction
             by the eager loader: it neither clones every row nor wraps it for
             mutation tracking, and it leaves the complete snapshot the next
             whole-file read at this revision would load again. Only a read
             takes it: it decides the shared parsed rows in place, and a
             mutation persists the rows its decision rewrites. */
          const snapshot = this.loadInTransaction(true);
          if (this.readOnlyCache?.revision !== revision || this.readOnlyCache.stamp !== stamp()) {
            this.readOnlyCache = { file: snapshot.file, revision, stamp: stamp() };
          }
        }
        recordedDecisions = unchanged() && recordHolds() ? this.grantDecisions : null;
      }
      if (recordedDecisions && (dirtyRows.get(collection)?.has(key)
        || applyRecordedGrantDecision(recordedDecisions, collection, key, storedJson, row,
          () => dirtyRows.get(collection)?.add(key)))) return row;
      decideGrants();
      return row;
    };
    keyedReaders.set(file, (collection, field, value) => {
      const values = typeof value === "string" ? [value] : value;
      if (values.length === 0) return [];
      if (reorderedCollections.has(collection)) return Object.entries(file[collection])
        .filter(([, row]) => values.includes(lookupValue(row, field) as string)).map(([key]) => key);
      const keys = new Set(this.db.query<{ row_key: string }, string[]>(
        `SELECT row_key FROM registry_rows WHERE collection = ? AND json_extract(value_json, '${LOOKUP_PATHS[field]}') IN (${values.map(() => "?").join(",")}) ORDER BY row_order`,
      ).all(collection, ...values).map(row => row.row_key));
      for (const key of dirtyRows.get(collection) ?? []) {
        const row = (file[collection] as Record<string, unknown>)[key];
        if (values.includes(lookupValue(row, field) as string)) keys.add(key); else keys.delete(key);
      }
      return [...keys];
    });
    pathReaders.set(file, path => {
      if (reorderedCollections.has("conversations")) return Object.values(file.conversations)
        .filter(row => row.generations.some(generation => generation.path === path) || row.continuityPaths.includes(path)).map(row => row.id);
      const keys = new Set(this.db.query<{ conversation_id: string }, [string]>(
        "SELECT p.conversation_id FROM registry_conversation_paths p JOIN registry_rows r ON r.collection = 'conversations' AND r.row_key = p.conversation_id WHERE p.path = ? ORDER BY r.row_order",
      ).all(path).map(row => row.conversation_id));
      for (const key of dirtyRows.get("conversations") ?? []) {
        const row = file.conversations[key];
        if (row && (row.generations.some(generation => generation.path === path) || row.continuityPaths.includes(path))) keys.add(key); else keys.delete(key);
      }
      return [...keys];
    });
    for (const collection of ROW_COLLECTIONS) {
      let loaded = false;
      let value = file[collection];
      let loadAllBaseline = () => {};
      const load = () => {
        if (loaded) return;
        const dirty = new Set<string>();
        const baseline = new Map<string, string | null>();
        if (!trackMutations) {
          const storedValue = {} as typeof value;
          const storedRows = this.db.query<Pick<StoredRow, "row_key" | "value_json">, [string]>(
            "SELECT row_key, value_json FROM registry_rows WHERE collection = ? ORDER BY row_order",
          ).all(collection);
          this.onRowPayloadRead?.(collection, storedRows.length);
          for (const row of storedRows) {
            const parsed = this.parseRow(collection, row.row_key, row.value_json, useRowCache);
            (storedValue as Record<string, unknown>)[row.row_key] = trackMutations
              ? structuredClone(parsed)
              : parsed;
            if (trackMutations) baseline.set(row.row_key, row.value_json);
          }
          const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
          input[collection] = storedValue;
          if (collection === "deliveryOperationOwners") input.heldDeliveries = file.heldDeliveries;
          value = this.normalize(input)[collection] as typeof value;
          if (trackMutations) {
            const rowProxies = new Map<string, WeakMap<object, object>>();
            value = new Proxy(value as Record<string, unknown>, {
              get: (target, property, receiver) => {
                const row = Reflect.get(target, property, receiver);
                if (typeof property !== "string" || !Object.hasOwn(target, property)) return row;
                let seen = rowProxies.get(property);
                if (!seen) {
                  seen = new WeakMap<object, object>();
                  rowProxies.set(property, seen);
                }
                return trackMutableJson(row, () => dirty.add(property), seen);
              },
              set: (target, property, next) => {
                if (typeof property === "string") dirty.add(property);
                return Reflect.set(target, property, next);
              },
              deleteProperty: (target, property) => {
                if (typeof property === "string") dirty.add(property);
                return Reflect.deleteProperty(target, property);
              },
              defineProperty: (target, property, descriptor) => {
                if (typeof property === "string") dirty.add(property);
                return Reflect.defineProperty(target, property, descriptor);
              },
            }) as typeof value;
          }
          loadAllBaseline = () => {};
        } else {
          const rows = {} as Record<string, unknown>;
          const deleted = new Set<string>();
          let orderedKeys: string[] | null = null;
          let storedKeySet: Set<string> | null = null;
          let allRowsLoaded = false;
          let storedPayloadRows: Pick<StoredRow, "row_key" | "value_json">[] | null = null;
          const rowProxies = new Map<string, WeakMap<object, object>>();
          const storedRow = this.db.query<Pick<StoredRow, "value_json">, [string, string]>(
            "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
          );
          const storedRows = this.db.query<Pick<StoredRow, "row_key" | "value_json">, [string]>(
            "SELECT row_key, value_json FROM registry_rows WHERE collection = ? ORDER BY row_order",
          );
          const readAllStoredRows = () => {
            if (storedPayloadRows) return storedPayloadRows;
            storedPayloadRows = storedRows.all(collection);
            this.onRowPayloadRead?.(collection, storedPayloadRows.length);
            orderedKeys = storedPayloadRows.map((row) => row.row_key);
            storedKeySet = new Set(orderedKeys);
            for (const row of storedPayloadRows) baseline.set(row.row_key, row.value_json);
            return storedPayloadRows;
          };
          loadAllBaseline = () => {
            readAllStoredRows();
          };
          const readBaseline = (key: string): string | null => {
            if (baseline.has(key)) return baseline.get(key)!;
            const stored = storedRow.get(collection, key)?.value_json ?? null;
            this.onRowPayloadRead?.(collection, stored === null ? 0 : 1);
            baseline.set(key, stored);
            return stored;
          };
          /* Every row this collection hands out leaves through here — the keyed
             read below, and equally the rows `loadAllRows` has already cached,
             which an enumeration reaches through `getOwnPropertyDescriptor`. So
             the gate sits on the single exit rather than on the load, and no
             route to a row can arrive before the decision it needs. */
          const readRow = (key: string): unknown => {
            if (!Object.hasOwn(rows, key)) {
              if (deleted.has(key)) return undefined;
              const stored = readBaseline(key);
              if (stored === null && collection !== "deliveryOperationOwners") return undefined;
              const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
              input[collection] = stored === null ? {} : { [key]: structuredClone(this.parseRow(collection, key, stored, useRowCache)) };
              if (stored === null && collection === "deliveryOperationOwners") {
                const delivery = registryRowsMatching(file, "heldDeliveries", "command.operationId", key)[0];
                if (!delivery) return undefined;
                input.heldDeliveries = { [delivery.id]: delivery };
              }
              if (collection === "deliveryOperationOwners") {
                const owner = (input[collection] as Record<string, { deliveryId?: string }>)[key];
                const delivery = owner?.deliveryId ? file.heldDeliveries[owner.deliveryId] : undefined;
                if (delivery) input.heldDeliveries = { [delivery.id]: delivery };
              }
              const normalized = this.normalize(input)[collection] as Record<string, unknown>;
              if (!Object.hasOwn(normalized, key)) return undefined;
              rows[key] = normalized[key];
            }
            /* The decision rewrites `rows[key]` in place where it denies, so the
               caller never holds the undecided object. */
            return admitRow(collection, key, baseline.get(key), rows[key]);
          };
          const loadAllRows = () => {
            if (allRowsLoaded) return;
            const stored = readAllStoredRows();
            const unloaded: Record<string, unknown> = {};
            for (const row of stored) {
              if (!Object.hasOwn(rows, row.row_key) && !deleted.has(row.row_key)) {
                unloaded[row.row_key] = structuredClone(this.parseRow(
                  collection,
                  row.row_key,
                  row.value_json,
                  useRowCache,
                ));
              }
            }
            const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
            input[collection] = unloaded;
            if (collection === "deliveryOperationOwners") input.heldDeliveries = file.heldDeliveries;
            const normalized = this.normalize(input)[collection] as Record<string, unknown>;
            for (const [key, row] of Object.entries(normalized)) {
              // Owner normalization can synthesize rows from held deliveries.
              // Those defaults must preserve the transaction's loaded evidence
              // and must never resurrect a row deleted in this transaction.
              if (!Object.hasOwn(rows, key) && !deleted.has(key)) rows[key] = row;
            }
            allRowsLoaded = true;
          };
          const keys = (): string[] => {
            loadAllRows();
            return [
              ...orderedKeys!.filter((key) => !deleted.has(key)),
              ...Object.keys(rows).filter((key) => !storedKeySet!.has(key)),
            ];
          };
          value = new Proxy(rows, {
            get: (target, property, receiver) => {
              if (typeof property !== "string") return Reflect.get(target, property, receiver);
              const row = readRow(property);
              if (row === undefined) return undefined;
              let seen = rowProxies.get(property);
              if (!seen) {
                seen = new WeakMap<object, object>();
                rowProxies.set(property, seen);
              }
              return trackMutableJson(row, () => dirty.add(property), seen);
            },
            set: (target, property, next) => {
              if (typeof property === "string") {
                readBaseline(property);
                dirty.add(property);
                deleted.delete(property);
                rowProxies.delete(property);
              }
              return Reflect.set(target, property, next);
            },
            deleteProperty: (target, property) => {
              if (typeof property === "string") {
                readBaseline(property);
                dirty.add(property);
                deleted.add(property);
                rowProxies.delete(property);
              }
              return Reflect.deleteProperty(target, property);
            },
            defineProperty: (target, property, descriptor) => {
              if (typeof property === "string") {
                readBaseline(property);
                dirty.add(property);
                deleted.delete(property);
                rowProxies.delete(property);
              }
              return Reflect.defineProperty(target, property, descriptor);
            },
            has: (_target, property) => typeof property === "string"
              ? readRow(property) !== undefined
              : Reflect.has(rows, property),
            ownKeys: () => keys(),
            getOwnPropertyDescriptor: (_target, property) => {
              if (typeof property !== "string") return undefined;
              const row = readRow(property);
              if (row === undefined) return undefined;
              return { configurable: true, enumerable: true, writable: true, value: row };
            },
          }) as typeof value;
        }
        loaded = true;
        loadedCollections.set(collection, value);
        baselineCollections.set(collection, baseline);
        dirtyRows.set(collection, dirty);
      };
      Object.defineProperty(file, collection, {
        configurable: true,
        enumerable: true,
        get: () => {
          load();
          /* The eager loader has materialized the whole collection by now, so
             there is no laziness left to protect and the decision runs on the
             collection. The lazy loader gates each ROW instead, on `readRow`'s
             single exit, so a keyed read stays keyed. */
          if (!trackMutations && GRANT_COLLECTIONS.has(collection)) decideGrants();
          return value;
        },
        set: (next: typeof value) => {
          load();
          loadAllBaseline();
          value = next;
          loadedCollections.set(collection, value);
          reorderedCollections.add(collection);
        },
      });
    }
    const loadedMeta = new Map<(typeof META_FIELDS)[number], RegistryFile[(typeof META_FIELDS)[number]]>();
    const baselineMeta = new Map<(typeof META_FIELDS)[number], RegistryFile[(typeof META_FIELDS)[number]]>();
    for (const field of META_FIELDS) {
      let loaded = false;
      let value = file[field];
      const load = () => {
        if (loaded) return;
        const stored = this.meta(field);
        /* Through the registry's normalizer, as every row is: a meta value
           persisted before an engine existed has no key for it (#2045). */
        if (stored !== null) value = this.normalize({ version: 2, entries: {}, receipts: {}, [field]: JSON.parse(stored) })[field] as typeof value;
        loaded = true;
        loadedMeta.set(field, value);
        baselineMeta.set(field, structuredClone(value));
      };
      Object.defineProperty(file, field, {
        configurable: true,
        enumerable: true,
        get: () => {
          load();
          return value;
        },
        set: (next: typeof value) => {
          load();
          value = next;
          loadedMeta.set(field, value);
        },
      });
    }
    return {
      file,
      revision,
      changes: () => {
        const changes: RegistryChanges = { rows: new Map(), meta: new Set(), order: new Set() };
        for (const [collection, value] of loadedCollections) {
          const baseline = baselineCollections.get(collection)!;
          const current = value as Record<string, unknown>;
          const candidates = reorderedCollections.has(collection)
            ? new Set([...baseline.keys(), ...Object.keys(current)])
            : dirtyRows.get(collection)!;
          const changed = new Set([...candidates].filter((key) => {
            if (!Object.hasOwn(current, key)) return baseline.has(key);
            const previous = baseline.get(key);
            return previous === undefined || JSON.stringify(current[key]) !== previous;
          }));
          if (changed.size > 0) changes.rows.set(collection, changed);
          if (reorderedCollections.has(collection)) {
            changes.rows.set(collection, new Set([...Object.keys(baseline), ...Object.keys(current)]));
            changes.order.add(collection);
          }
        }
        for (const [field, value] of loadedMeta) {
          if (!isDeepStrictEqual(baselineMeta.get(field), value)) changes.meta.add(field);
        }
        return changes;
      },
    };
  }

  private parseRow(
    collection: RowCollection,
    key: string,
    valueJson: string,
    useCache: boolean,
  ): unknown {
    if (!useCache) {
      this.onRowPayloadParse?.(collection, 1);
      return JSON.parse(valueJson);
    }
    let collectionCache = this.rowCache.get(collection);
    if (!collectionCache) {
      collectionCache = new Map();
      this.rowCache.set(collection, collectionCache);
    }
    const cached = collectionCache.get(key);
    if (cached?.valueJson === valueJson) return cached.parsed;
    const parsed = JSON.parse(valueJson);
    this.onRowPayloadParse?.(collection, 1);
    collectionCache.set(key, { valueJson, parsed });
    return parsed;
  }

  private updateCachesAfterCommit(
    file: RegistryFile,
    changes: RegistryChanges,
    revision: number,
    stamps: { before: string; after: string },
  ): void {
    // The journal identifies only changed grant inputs. A local grant write
    // invalidates its target and dependents, leaving other decisions warm.
    this.refreshGrantDecisions(revision, stamps.after);
    // Entry and receipt decisions affect their own rows only, so the cached
    // snapshot can patch those rows. Conversation and edge edits can change
    // another row's grant and require the next snapshot to reassemble it.
    const grantInputChanged = [...changes.rows.keys(), ...changes.order]
      .some((collection) => collection === "conversations" || collection === "lineageEdges");
    const cachedSnapshot = !grantInputChanged && this.readOnlyCache?.revision === revision - 1 && this.readOnlyCache.stamp === stamps.before
      ? this.readOnlyCache
      : null;
    const nextFile = cachedSnapshot ? { ...cachedSnapshot.file } : null;

    for (const [collection, keys] of changes.rows) {
      const currentRows = file[collection] as Record<string, unknown>;
      let collectionCache = this.rowCache.get(collection);
      if (!collectionCache) {
        collectionCache = new Map();
        this.rowCache.set(collection, collectionCache);
      }
      const nextRows = nextFile
        ? { ...(cachedSnapshot!.file[collection] as Record<string, unknown>) }
        : null;
      for (const key of keys) {
        if (!Object.hasOwn(currentRows, key)) {
          collectionCache.delete(key);
          if (nextRows) delete nextRows[key];
          continue;
        }
        const valueJson = JSON.stringify(currentRows[key]);
        const parsed = JSON.parse(valueJson) as unknown;
        collectionCache.set(key, { valueJson, parsed });
        if (nextRows) nextRows[key] = parsed;
      }
      if (nextFile && nextRows) {
        if (changes.order.has(collection)) {
          const ordered: Record<string, unknown> = {};
          for (const key of Object.keys(currentRows)) {
            if (Object.hasOwn(nextRows, key)) ordered[key] = nextRows[key];
          }
          (nextFile as unknown as Record<string, unknown>)[collection] = ordered;
        } else {
          (nextFile as unknown as Record<string, unknown>)[collection] = nextRows;
        }
      }
    }

    if (nextFile) {
      for (const field of changes.meta) {
        (nextFile as unknown as Record<string, unknown>)[field] = structuredClone(file[field]);
      }
      this.readOnlyCache = { file: nextFile, revision, stamp: stamps.after };
    } else {
      this.readOnlyCache = null;
    }
  }

  private grantChangeId(): number {
    if (!this.grantJournalReady) return 0;
    return this.db.query<{ seq: number }, []>("SELECT COALESCE(MAX(seq), 0) AS seq FROM registry_grant_changes").get()!.seq;
  }

  private refreshGrantDecisions(revision: number, stamp: string): void {
    const previous = this.grantDecisions;
    if (!previous || (previous.revision === revision && previous.stamp === stamp)) return;
    if (!this.grantJournalReady) { this.grantDecisions = null; return; }
    const first = this.db.query<{ seq: number }, []>("SELECT COALESCE(MIN(seq), 0) AS seq FROM registry_grant_changes").get()!.seq;
    if (first > previous.changeId + 1) { this.grantDecisions = null; return; }
    const changed = this.db.query<{ seq: number; collection: RowCollection; row_key: string }, [number]>(
      "SELECT seq, collection, row_key FROM registry_grant_changes WHERE seq > ? ORDER BY seq",
    ).all(previous.changeId);
    const rows = previous.rows;
    for (const { collection, row_key: key } of changed) {
      const source = grantDecisionKey(collection, key);
      rows.delete(source);
      for (const target of previous.sourceTargets.get(source) ?? []) rows.delete(target);
      const raw = this.db.query<{ value_json: string }, [string, string]>(
        "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
      ).get(collection, key)?.value_json;
      if (!raw) continue;
      const value = JSON.parse(raw) as unknown;
      if (collection === "conversations" || collection === "lineageEdges") {
        for (const target of indexGrantSource(previous, collection, key, value)) rows.delete(target);
      } else if (collection === "entries") {
        const entry = value as RegistryFile["entries"][string];
        addIndexedTarget(previous.entryPaths, entry.artifactPath, source);
        for (const conversationId of previous.conversationByPath.get(entry.artifactPath) ?? []) {
          addIndexedTarget(previous.sourceTargets, grantDecisionKey("conversations", conversationId), source);
        }
      } else if (collection === "receipts") {
        indexReceipt(previous, key, value as RegistryFile["receipts"][string]);
      }
    }
    this.grantDecisions = {
      ...previous, revision, stamp,
      changeId: changed.at(-1)?.seq ?? previous.changeId,
    };
  }

  private persistAll(file: DecidedRegistryFile, revision: number): void {
    this.assertDecided(file);
    this.db.exec("DELETE FROM registry_rows");
    for (const collection of ROW_COLLECTIONS) {
      for (const [order, [key, value]] of Object.entries(file[collection]).entries()) {
        this.upsertRow(collection, key, value, order);
      }
    }
    for (const field of META_FIELDS) this.setMeta(field, JSON.stringify(file[field]));
    this.setMeta("revision", String(revision));
  }

  private persistDiff(before: RegistryFile, after: DecidedRegistryFile, revision: number): void {
    this.assertDecided(after);
    for (const collection of ROW_COLLECTIONS) {
      const previous = before[collection] as Record<string, unknown>;
      const next = after[collection] as Record<string, unknown>;
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
      for (const key of keys) {
        if (!(key in next)) {
          this.db.query("DELETE FROM registry_rows WHERE collection = ? AND row_key = ?").run(collection, key);
          continue;
        }
        if (key in previous && isDeepStrictEqual(previous[key], next[key])) continue;
        this.upsertRow(collection, key, next[key]);
      }
      this.persistRowOrder(collection, Object.keys(next));
    }
    for (const field of META_FIELDS) {
      if (isDeepStrictEqual(before[field], after[field])) continue;
      this.setMeta(field, JSON.stringify(after[field]));
    }
    this.setMeta("revision", String(revision));
  }

  private persistChanges(file: DecidedRegistryFile, changes: RegistryChanges, revision: number): void {
    this.assertDecided(file);
    for (const [collection, keys] of changes.rows) {
      const rows = file[collection] as Record<string, unknown>;
      for (const key of keys) {
        if (key in rows) this.upsertRow(collection, key, rows[key]);
        else this.db.query("DELETE FROM registry_rows WHERE collection = ? AND row_key = ?").run(collection, key);
      }
    }
    for (const collection of changes.order) this.persistRowOrder(collection, Object.keys(file[collection]));
    for (const field of changes.meta) this.setMeta(field, JSON.stringify(file[field]));
    this.setMeta("revision", String(revision));
    this.db.exec("DELETE FROM registry_grant_changes WHERE seq <= (SELECT MAX(seq) - 100000 FROM registry_grant_changes)");
  }

  private upsertRow(collection: RowCollection, key: string, value: unknown, order?: number): void {
    if (order !== undefined) {
      this.db.query(`
        INSERT INTO registry_rows(collection, row_key, value_json, row_order) VALUES (?, ?, ?, ?)
        ON CONFLICT(collection, row_key) DO UPDATE SET value_json = excluded.value_json, row_order = excluded.row_order
      `).run(collection, key, JSON.stringify(value), order);
      return;
    }
    this.db.query(`
      INSERT INTO registry_rows(collection, row_key, value_json, row_order)
      SELECT ?, ?, ?, COALESCE(MAX(row_order) + 1, 0) FROM registry_rows WHERE collection = ?
      ON CONFLICT(collection, row_key) DO UPDATE SET value_json = excluded.value_json
    `).run(collection, key, JSON.stringify(value), collection);
  }

  private persistRowOrder(collection: RowCollection, keys: string[]): void {
    for (const [order, key] of keys.entries()) {
      // Replacement usually appends a row. Rewriting unchanged positions also
      // rewrites the collection and lineage indexes under the writer lock.
      this.db.query("UPDATE registry_rows SET row_order = ? WHERE collection = ? AND row_key = ? AND row_order != ?")
        .run(order, collection, key, order);
    }
  }

  /** Names the stored database as this connection sees it, in two O(1)
      counters: `data_version` moves on every commit by any other connection,
      in this process or another, whatever it wrote and whether or not it
      advanced the revision; `total_changes()` moves on every row this
      connection writes, including writes a rollback discarded. Read inside a
      transaction, it is fixed for the transaction's snapshot. */
  private storeStamp(): string {
    const stamp = this.db.query<{ dataVersion: number; changes: number }, []>(
      "SELECT (SELECT data_version FROM pragma_data_version) AS dataVersion, total_changes() AS changes",
    ).get()!;
    return `${stamp.dataVersion}:${stamp.changes}`;
  }

  private meta(key: string): string | null {
    return this.db.query<MetaRow, [string]>("SELECT key, value FROM registry_meta WHERE key = ?").get(key)?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.query(`
      INSERT INTO registry_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private secureFiles(): void {
    for (const candidate of [this.filename, `${this.filename}-wal`, `${this.filename}-shm`]) {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    }
  }

  private storageSignature(): string {
    return [this.filename, `${this.filename}-wal`].map((candidate) => {
      try {
        const stat = fs.statSync(candidate, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
      }
    }).join("|");
  }

  private rememberRevision(revision: number): void {
    this.revisionCache = { signature: this.storageSignature(), revision };
  }
}

/** Whether a registry store already holds a committed import, read without
    creating, migrating or importing anything. A missing file is `false`. */
export function sqliteRegistryStoreImported(filename: string): boolean {
  if (!fs.existsSync(filename)) return false;
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("SQLite registry modes require the Bun runtime");
  const db = new sqlite.Database(filename, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registry_meta'").get();
    if (!table) return false;
    return db.query<MetaRow, [string]>("SELECT key, value FROM registry_meta WHERE key = ?").get("migration_complete")?.value === "1";
  } finally {
    db.close();
  }
}
