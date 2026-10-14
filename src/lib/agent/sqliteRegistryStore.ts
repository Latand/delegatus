import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Database as BunDatabase } from "bun:sqlite";

import { deepFreeze } from "@/lib/deepFreeze";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { databaseFileIdentity, DatabaseReplacedError, openCurrentDatabase } from "@/lib/state/currentDatabase";
import { recordBlockingWait, type BlockingWaitCorrelation } from "@/lib/blockingWaits";

import { reboundAssembledMcpGrants, rowClaimsBeyondBaselineGrant, type McpGrantPolicy } from "./mcpAllowlist";
import { identityMaterializationFence } from "./identityMaterialization";
import type { AgentRegistryEntry, RegistryFile, SeatChildrenAnchor, SeatChildrenPage, SnapshotSpawnProjection, SnapshotTitleConversationProjection } from "./registry";
import { sessionKeyId } from "./sessionKey";
import { archiveCandidates, archiveInactiveRegistryRows, installRegistryArchive } from "./registryArchive";

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
const ROW_COLLECTION_KEYS: ReadonlySet<string> = new Set(ROW_COLLECTIONS);
/** The rows whose MCP grant lists a complete load decides from other rows. */
const READER_GRANT_COLLECTIONS: ReadonlySet<RowCollection> = new Set(["entries", "receipts", "conversations"]);
type LookupValue = string | readonly string[];
type LookupField = "conversationId" | "artifactPath" | "command.operationId" | "deliveryId" | "alias" | "clientAttemptId" | "spawnCapabilityDigest" | "pendingSpawnCapability.digest" | "state" | "status" | "key.sessionId";
const LOOKUP_PATHS: Record<LookupField, string> = { conversationId: "$.conversationId", artifactPath: "$.artifactPath", "command.operationId": "$.command.operationId", deliveryId: "$.deliveryId", alias: "$", clientAttemptId: "$.clientAttemptId", spawnCapabilityDigest: "$.spawnCapabilityDigest", "pendingSpawnCapability.digest": "$.pendingSpawnCapability.digest", state: "$.state", status: "$.status", "key.sessionId": "$.key.sessionId" };
type KeyedReader = (collection: RowCollection, field: LookupField, value: LookupValue) => string[];
type ProjectionReader = (collection: RowCollection, projector: RegistryRowProjector<RowCollection, unknown>) => Array<[string, unknown]>;
interface RegistryFileReaders {
  keyed: WeakMap<object, KeyedReader>;
  path: WeakMap<RegistryFile, (path: string) => string[]>;
  entryKey: WeakMap<RegistryFile, (entryKey: string) => string[]>;
  coldKey: WeakMap<RegistryFile, (collection: RowCollection) => ReadonlySet<string> | undefined>;
  endedOwner: WeakMap<RegistryFile, (since: string) => string[]>;
  projection: WeakMap<object, ProjectionReader>;
  liveness: WeakMap<RegistryFile, () => { entries: AgentRegistryEntry[]; receipts: RegistryFile["receipts"][string][] }>;
}
/* Next standalone evaluates instrumentation and route handlers in separate
   bundle realms, each with its own copy of this module, while the process
   holds one registry and so one store, built by whichever copy loaded first.
   Kept in module-level maps, a file's indexed readers were found only by that
   copy: a route in another bundle found none and fell back to enumerating the
   collection, every archived row included, on each lookup, which held the
   production server's event loop for seconds under eight browser views
   (#2761). They live on the process object those realms share, as the
   registry itself does. */
const readerState = process as typeof process & { __llvRegistryFileReaders?: RegistryFileReaders };
const fileReaders = readerState.__llvRegistryFileReaders ??= {
  keyed: new WeakMap(), path: new WeakMap(), entryKey: new WeakMap(), coldKey: new WeakMap(), endedOwner: new WeakMap(), projection: new WeakMap(), liveness: new WeakMap(),
};
const keyedReaders = fileReaders.keyed;
const pathReaders = fileReaders.path;
const entryKeyReaders = fileReaders.entryKey;
const coldKeyReaders = fileReaders.coldKey;
const endedOwnerReaders = fileReaders.endedOwner;
const projectionReaders = fileReaders.projection;
const livenessReaders = fileReaders.liveness;

/**
 * A narrow, immutable reading of every row of one collection (#2761).
 *
 * Whole-history passes in a projection need a few identity fields of every
 * row, and enumerating the rows themselves parses, normalizes and freezes each
 * cold payload again on every pass. A projector names what it reads; over a
 * SQLite view its result for an archived version is computed once and kept,
 * because archived versions never change. `project` sees the normalized row
 * and must not read its MCP grant lists, which a projection does not pin.
 * `id` must be unique to the projector's code.
 */
export interface RegistryRowProjector<C extends RowCollection, T> {
  readonly id: string;
  readonly collection: C;
  project(row: RegistryFile[C][string]): T;
}

/** Every row of the projector's collection, in collection order, projected. */
export function registryRowProjection<C extends RowCollection, T>(
  file: Pick<RegistryFile, C>,
  projector: RegistryRowProjector<C, T>,
): Array<[string, T]> {
  const reader = projectionReaders.get(file);
  if (reader) return reader(projector.collection, projector as RegistryRowProjector<RowCollection, unknown>) as Array<[string, T]>;
  const rows = file[projector.collection] as Record<string, RegistryFile[C][string]>;
  return Object.keys(rows).map(key => [key, projector.project(rows[key]!)]);
}

/** A reader's frozen copy of one row. `stored` is the stored JSON a complete
    load decided it from and `grants` the MCP lists that decision left on it;
    `json` is the decided row's own JSON, taken only when those cannot say. */
type ReaderRow = { row: unknown; stored: string | undefined; grants: string; json?: string };

/** Stored JSON of a row in a complete load, from the parse cache it was read through. */
type StoredRowJson = (collection: RowCollection, key: string) => string | undefined;

/**
 * The shared view every whole-file read-only reader holds, and the only objects
 * it is built from. The store's own objects stay private and mutable: the parse
 * cache, which a later load normalizes again, and the loaded rows, which the
 * assembled grant decision rewrites in place. A reader gets frozen copies of
 * them instead, all the way down, so an assignment, push or delete on any part
 * of the view throws, and the next reader gets what the store loaded.
 *
 * A copy is only made for a row whose decided value changed. A view patched
 * after a local commit carries the frozen rows of the view before it. A
 * complete load decides a row from its own stored JSON and, for the MCP grant
 * lists, from the rows that attest to it, which is what the recorded grant
 * decisions already rest on; so a row whose stored JSON and grant lists are
 * both unchanged keeps its copy. An operation owner, which a held delivery can
 * rewrite, and a row a local commit patched in are compared by their decided
 * JSON instead. A copy is never changed, so a view a reader already holds
 * stays as it was.
 */
class RegistryReaderViews {
  private readonly rows = new Map<RowCollection, Map<string, ReaderRow>>();
  private readonly owned = new WeakSet<object>();

  clear(): void {
    this.rows.clear();
  }

  /** `storedJson` is given for a complete load and absent for a patched view. */
  view(file: RegistryFile, storedJson?: StoredRowJson): RegistryFile {
    if (this.owned.has(file)) return file;
    const source = file as unknown as Record<string, unknown>;
    const view = {} as Record<string, unknown>;
    for (const key of Object.keys(file)) {
      view[key] = ROW_COLLECTION_KEYS.has(key)
        ? this.collection(key as RowCollection, source[key] as Record<string, unknown>, storedJson)
        : this.value(source[key]);
    }
    const frozen = this.own(Object.freeze(view)) as unknown as RegistryFile;
    const keyed = keyedReaders.get(file);
    if (keyed) keyedReaders.set(frozen, keyed);
    const paths = pathReaders.get(file);
    if (paths) pathReaders.set(frozen, paths);
    const entryKeys = entryKeyReaders.get(file);
    if (entryKeys) entryKeyReaders.set(frozen, entryKeys);
    const projections = projectionReaders.get(file);
    if (projections) projectionReaders.set(frozen, projections);
    return frozen;
  }

  private collection(collection: RowCollection, rows: Record<string, unknown>, storedJson: StoredRowJson | undefined): Record<string, unknown> {
    if (this.owned.has(rows)) return rows;
    const previous = this.rows.get(collection);
    const next = new Map<string, ReaderRow>();
    const record: Record<string, unknown> = {};
    for (const [key, row] of Object.entries(rows)) {
      const known = previous?.get(key);
      let reader: ReaderRow;
      if (known && known.row === row) reader = known;
      else {
        const stored = collection === "deliveryOperationOwners" ? undefined : storedJson?.(collection, key);
        const grants = READER_GRANT_COLLECTIONS.has(collection) ? JSON.stringify(grantLists(collection, row as GrantProfileRow)) : "";
        if (stored !== undefined && known?.stored === stored && known.grants === grants) reader = known;
        else {
          const json = JSON.stringify(row);
          if (known && (known.json ??= JSON.stringify(known.row)) === json) {
            known.stored = stored;
            known.grants = grants;
            reader = known;
          } else reader = { row: this.value(row), stored, grants, json };
        }
      }
      next.set(key, reader);
      record[key] = reader.row;
    }
    /* Only the rows of this view: a row it no longer holds is not kept. */
    this.rows.set(collection, next);
    return this.own(Object.freeze(record));
  }

  /** A private, deeply frozen copy; a copy this made already is returned as is. */
  private value(value: unknown): unknown {
    if (value === null || typeof value !== "object" || this.owned.has(value)) return value;
    return this.own(deepFreeze(structuredClone(value)));
  }

  private own<T extends object>(value: T): T {
    this.owned.add(value);
    return value;
  }
}

/** Indexed selection inside the same lazy transaction, including pending writes. */
export function registryRowsMatching<C extends RowCollection>(file: Pick<RegistryFile, C>, collection: C, field: LookupField, value: LookupValue): RegistryFile[C][string][] {
  const keys = registryKeysMatching(file, collection, field, value);
  const rows = (file[collection] ?? {}) as Record<string, RegistryFile[C][string]>;
  return keys.map(key => rows[key]!).filter(Boolean);
}

/** The owner rows liveness can still consider. SQLite applies the durable
    owner predicate before loading payloads, so archived terminal history is
    never expanded into an in-memory census. Plain registry fixtures retain
    their complete behavior. */
export function registryLivenessRows(file: RegistryFile): { entries: AgentRegistryEntry[]; receipts: RegistryFile["receipts"][string][] } {
  const read = livenessReaders.get(file);
  return read ? read() : { entries: Object.values(file.entries ?? {}), receipts: Object.values(file.receipts ?? {}) };
}

/** Whether this view can select rows without expanding the whole collection. */
export function registryHasLookupIndex(file: object): boolean {
  return keyedReaders.has(file);
}

export function registryKeysMatching<C extends RowCollection>(file: Pick<RegistryFile, C>, collection: C, field: LookupField, value: LookupValue): string[] {
  return keyedReaders.get(file)?.(collection, field, value) ?? Object.entries(file[collection] ?? {}).filter(([, row]) => (typeof value === "string" ? [value] : value).includes(lookupValue(row, field) as string)).map(([key]) => key);
}

function lookupValue(row: unknown, field: LookupField): unknown {
  if (field === "alias") return row;
  return field.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, row);
}

/** Whether path lookups on this file read the relational path index rather
    than enumerating every conversation, cold history included. */
export function registryHasPathIndex(file: RegistryFile): boolean {
  return pathReaders.has(file);
}

export function registryConversationsForPath(file: RegistryFile, path: string): RegistryFile["conversations"][string][] {
  const keys = pathReaders.get(file)?.(path);
  return keys ? keys.map(key => file.conversations[key]!).filter(Boolean) : Object.values(file.conversations).filter(row =>
    row.generations.some(generation => generation.path === path) || row.continuityPaths.includes(path));
}

/** The conversations that hold a generation of one entry row
    (`engine:sessionId`), in collection order. Over SQLite this reads the
    generation identity index rather than enumerating every conversation, cold
    history included; a plain file is enumerated. */
export function registryConversationsForEntryKey(file: RegistryFile, entryKey: string): RegistryFile["conversations"][string][] {
  const keys = entryKeyReaders.get(file)?.(entryKey);
  return keys ? keys.map(key => file.conversations[key]!).filter(Boolean) : Object.values(file.conversations).filter(row =>
    row.generations.some(generation => `${row.engine}:${generation.id}` === entryKey));
}

/**
 * The rows of one collection that are not archived, in collection order. An
 * archive version is terminal by the archive's own rules (a dead entry with no
 * host or claim, a delivery that was delivered, failed, cancelled or
 * superseded, an operation owner with a terminal state), so a pass looking for
 * open work finds all of it here without reading retained history. A plain
 * file, or one this store did not assemble, yields every row.
 */
export function hotRegistryRows<C extends RowCollection>(file: RegistryFile, collection: C): Array<[string, RegistryFile[C][string]]> {
  const rows = file[collection] as Record<string, RegistryFile[C][string]>;
  const cold = coldKeyReaders.get(file)?.(collection);
  if (!cold?.size) return Object.entries(rows);
  return Object.keys(rows).flatMap((key) => cold.has(key) ? [] : [[key, rows[key]!] as [string, RegistryFile[C][string]]]);
}

/**
 * The archived operation owners that may have ended at or after `since` (an
 * ISO instant), or undefined when this file is not a view over an archive and
 * the caller reads its rows. An archived owner is read through an accessor
 * that fetches and normalizes its version, so a sweep that enumerated the
 * collection to find the last seconds' endings read every archived owner
 * each time, a third of a second over retained history (#2761). The stored
 * instant decides here; an owner stored without one takes its delivery's, as
 * normalization does. The caller judges each named row as it reads it.
 */
export function archivedOwnersEndedSince(file: RegistryFile, since: string): string[] | undefined {
  return endedOwnerReaders.get(file)?.(since);
}

/** Whether entry-key lookups on this file read the generation identity index. */
export function registryHasEntryKeyIndex(file: RegistryFile): boolean {
  return entryKeyReaders.has(file);
}

const conversationEntryKeySql = (records: string) => `SELECT conversation_id FROM (
  SELECT i.conversation_id, (SELECT r.row_order FROM ${records} r WHERE r.collection='conversations' AND r.row_key=i.conversation_id) AS row_order
  FROM (SELECT DISTINCT conversation_id FROM registry_generation_identities WHERE entry_key=?) i) WHERE row_order IS NOT NULL ORDER BY row_order`;

/* The owners of one transcript path, in collection order. Each owner's order
   is read by its key: joining the path index to the records view made SQLite
   expand every conversation of the view per lookup, 16 ms apiece over a
   retained registry (#2761). */
const conversationPathSql = (records: string) => `SELECT conversation_id FROM (
  SELECT p.conversation_id, (SELECT r.row_order FROM ${records} r WHERE r.collection='conversations' AND r.row_key=p.conversation_id) AS row_order
  FROM registry_conversation_paths p WHERE p.path=?) WHERE row_order IS NOT NULL ORDER BY row_order`;

/** Stored bytes of archived rows a store keeps normalized between passes.
    Retained conversations, entries, receipts and deliveries of a long-running
    installation fit; operation owners, the largest payloads, stay per commit. */
const COLD_STABLE_ROW_BYTES = 48 * 1024 * 1024;

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
  childGrantSources: Map<string, { parentId: string; launchId: string }>;
};
type GrantProfileRow = { launchProfile?: { mcpServers?: string[] } | null; generations?: { launchProfile?: { mcpServers?: string[] } }[] };
type ColdGrantDecision = { lists: (string[] | undefined)[]; dependencies: Set<string> };
/** A mutation's own version of the rows it rewrote: undefined for a row it has
    not touched, null for one it deleted. */
type TransactionGrantRows = {
  row: (collection: RowCollection, key: string) => { row: unknown } | null | undefined;
  dirty: (collection: RowCollection) => Iterable<string>;
};

/** Stored identity matches, corrected by the rows this transaction rewrote:
    a rewritten row is selected exactly when its current version matches. */
function transactionSelection<R>(
  transaction: TransactionGrantRows | undefined,
  collection: RowCollection,
  stored: readonly string[],
  matches: (row: R) => boolean,
): string[] {
  if (!transaction) return [...stored];
  const selected = new Set(stored);
  for (const key of transaction.dirty(collection)) {
    const local = transaction.row(collection,key);
    if (local === undefined) continue;
    if (local && matches(local.row as R)) selected.add(key);
    else selected.delete(key);
  }
  return [...selected];
}

const authorityDependency = (kind: string, key: string) => `${kind}\u0000${key}`;

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
    conversationByEntryKey: new Map(), conversationByPath: new Map(), childGrantSources: new Map(),
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
  for (const [key, row] of Object.entries(file.lineageEdges)) indexChildGrantSources(decisions, key, row);
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

/** A child's decision also reads its seat and admitting receipt. Mirror the
    child's targets onto both sources so a keyed cache cannot outlive either
    revocation, including a raw SQLite commit without a revision bump. */
function indexChildGrantSources(decisions: GrantDecisions, childId: string, edge: RegistryFile["lineageEdges"][string]): void {
  const parentId = edge.parentConversationId;
  const launchId = edge.evidence?.launchId;
  if (!parentId || !launchId || parentId === childId) {
    decisions.childGrantSources.delete(childId);
    return;
  }
  decisions.childGrantSources.set(childId, { parentId, launchId });
  syncChildGrantTargets(decisions, childId);
}

function syncChildGrantTargets(decisions: GrantDecisions, childId: string): void {
  const sources = decisions.childGrantSources.get(childId);
  if (!sources) return;
  const edgeSource = grantDecisionKey("lineageEdges", childId);
  const targets = decisions.sourceTargets.get(edgeSource) ?? new Set<string>();
  for (const target of decisions.sourceTargets.get(grantDecisionKey("conversations", childId)) ?? []) targets.add(target);
  decisions.sourceTargets.set(edgeSource, targets);
  for (const target of targets) {
    addIndexedTarget(decisions.sourceTargets, grantDecisionKey("conversations", sources.parentId), target);
    addIndexedTarget(decisions.sourceTargets, grantDecisionKey("lineageEdges", sources.parentId), target);
    addIndexedTarget(decisions.sourceTargets, grantDecisionKey("receipts", sources.launchId), target);
  }
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
  /** MCP readers can use an older schema until its serving owner migrates it. */
  allowArchiveMigration?: boolean;
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
  /** Row mode applies structural bounds while deferring the grant decision
      until SQLite has assembled the receipt, edge and parent attestations. */
  normalize(value: unknown, mode?: { deferStoredGrantDecision: true }): RegistryFile;
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
  /** Test seam for the writer-acquisition deadline: the clock it is measured
      on, read once when the wait starts and once after every busy attempt.
      Production omits it and measures on `performance.now()`. */
  writerClock?(): number;
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

/**
 * A value about to enter a mutation, with every frozen object in it replaced by
 * a mutable copy. A writer that spreads a row of the shared reader view
 * (`upsert({ ...view.entries[id], status })`) carries the view's frozen nested
 * objects in: the tracking proxy cannot wrap a frozen object, and a later edit
 * in the same mutation could not change it. A frozen object cannot have been
 * changed by whoever holds it, so the copy loses no write.
 */
function writableJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return structuredClone(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    const next = writableJson(child);
    if (next !== child) record[key] = next;
  }
  return value;
}

function writableDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
  return "value" in descriptor ? { ...descriptor, value: writableJson(descriptor.value) } : descriptor;
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
      return Reflect.set(target, property, writableJson(next));
    },
    deleteProperty: (target, property) => {
      markDirty();
      return Reflect.deleteProperty(target, property);
    },
    defineProperty: (target, property, descriptor) => {
      markDirty();
      return Reflect.defineProperty(target, property, writableDescriptor(descriptor));
    },
  });
  seen.set(object, proxy);
  return proxy as T;
}

export class SqliteAgentRegistryStore {
  private readonly db: BunDatabase;
  private readonly normalize: (value: unknown, mode?: { deferStoredGrantDecision: true }) => RegistryFile;
  private readonly normalizePartial: (value: unknown) => RegistryFile;
  private readonly onWriterWait: ((durationMs: number) => void) | undefined;
  private readonly maxMutationAttempts: number;
  private readonly writerClock: () => number;
  /** Set while {@link withWriter} holds an open write transaction for the next {@link mutate}. */
  private writerHeld = false;
  private onSnapshotLoad: (() => void) | undefined;
  private onRowPayloadRead: ((collection: RowCollection, count: number) => void) | undefined;
  private onRowPayloadParse: ((collection: RowCollection, count: number) => void) | undefined;
  private onRevisionQuery: (() => void) | undefined;
  private readonly rowCache = new Map<RowCollection, Map<string, CachedRow>>();
  private revisionCache: { signature: string; revision: number } | null = null;
  /** Stamped like the grant record: a complete snapshot is only ever handed
      out again over exactly the database it was loaded from. */
  private readOnlyCache: StampedSnapshot | null = null;
  private snapshotChangeId = 0;
  private readOnlyHotFile: RegistryFile | null = null;
  private readonly coldReaderRows = new Map<number, { stamp: string; row: unknown }>();
  /** Normalized archived rows whose reading depends on nothing but their
      immutable version and, for a grant-bearing row, the decision pinned on
      it. They outlive commits, which the stamped cache above cannot: one
      writer committing every few dozen milliseconds left every pass over the
      history parsing all of it again (#2761). Bounded by stored bytes. */
  private readonly coldStableRows = new Map<number, { pinned: unknown; row: unknown; bytes: number }>();
  private coldStableBytes = 0;
  /** Immutable grant/operation projections only, never archived payloads.
      Current cold versions bound this map; held views pin their own decisions. */
  private readonly coldRowProjections = new Map<number, { claimsGrant: boolean; operationId: string | null }>();
  /** Only effective lists and authority keys survive a refresh, never payloads.
      Reverse dependencies also track absent attestors and identity selectors. */
  private readonly coldGrantDecisions = new Map<number, ColdGrantDecision>();
  private readonly coldGrantTargets = new Map<string, Set<number>>();
  /** The cold layer of the last view: the mapping it was built from and, per
      collection, the hot rows it merged and the collection it produced. A
      refresh reuses a collection whose cold versions, hot rows and pinned
      grant decisions are all unchanged (#2761). */
  private coldViewCache: {
    signature: string;
    headers: readonly { collection: RowCollection; row_key: string; archive_id: number }[];
    /** Derived from `headers` once: keys and version ids per collection. */
    coldKeys: Map<RowCollection, Set<string>>;
    coldIds: Map<RowCollection, Map<string, number>>;
    /** The headers of each collection, in archive order. */
    grouped: Map<RowCollection, { collection: RowCollection; row_key: string; archive_id: number }[]>;
    /** Per collection, which archive versions it holds: a mapping change in
        one collection leaves the others' built views reusable. */
    coldSignatures: Map<RowCollection, string>;
    forgets: number;
    /** Operation owners synthesized from archived deliveries that no stored owner names. */
    syntheticOwners: Map<string, string>;
    /** `built` yields the merged collection, making it on first use when only
        its hot rows changed; `cold` is the accessors of its archived rows,
        carried from build to build while its versions and decisions stand. */
    collections: Map<RowCollection, {
      hot: Map<string, unknown>; deliveries?: Map<string, unknown>; synthetic: string;
      built: () => Record<string, unknown>; cold?: Map<string, PropertyDescriptor>;
    }>;
  } | null = null;
  /** Counts forgotten cold grant decisions; a change rebuilds the grant-bearing collections. */
  private coldGrantForgets = 0;
  /** Per projector, its result for each current archived version. */
  private readonly coldRowProjectionResults = new Map<string, Map<number, unknown>>();
  private coldGrantCursor: { changeId: number; stamp: string } | null = null;
  private coldKeys = new Set<string>();
  private coldKeysStamp = "";
  /** The change journal position the cold key set was read at; 0 forces a full read. */
  private coldKeysChangeId = 0;
  private changesReady = false;
  private recordsSource = "registry_rows";
  private readonly localRows = new Map<string, { dataVersion: string; valueJson: string | null }>();
  /** Frozen copies of rows for the shared view. Keyed by what a row was
      decided from, so a copy stays valid across a reopened or replaced
      database: the same stored JSON and grant lists are the same row. */
  private readonly readerViews = new RegistryReaderViews();
  /** What the assembled grant decision (#739) returned for every grant-bearing
      row at one stored revision. A keyed read of a row claiming more than the
      baseline otherwise assembles, clones and decides the whole file, per read:
      sixty such rows cost startup half a minute of blocked event loop. */
  private grantDecisions: GrantDecisions | null = null;
  private grantJournalReady = false;
  /* What each hot row's grant decision read: the rows and the identity
     lookups that attested to it, absent ones included. A refresh after another
     writer's commit decides again only the rows a journalled change can reach
     through these, where it used to decide every grant-bearing hot row after
     any conversation, receipt or lineage write (#2761). */
  private readonly hotGrantDependencies = new Map<string, Set<string>>();
  private readonly hotGrantTargets = new Map<string, Set<string>>();
  /** Every grant-claiming row of the hot view has its dependencies recorded. */
  private hotGrantsTracked = false;
  /* Each collection's keys in stored order, archived ones included, as of the
     read-only view. A refresh keeps a collection's order while every row the
     journal names still holds the position it held; reading and sorting every
     key of each changed collection was most of a refresh over retained
     history (#2761). */
  private readonly collectionOrders = new Map<RowCollection, { keys: string[]; orders: Map<string, number> }>();
  /** Whether registry_generation_identities is installed and backfilled. */
  private generationIdentitiesReady = false;

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
    this.normalizePartial = (value) => options.normalize(value, { deferStoredGrantDecision: true });
    this.onWriterWait = options.onWriterWait;
    this.maxMutationAttempts = options.maxMutationAttempts ?? 2;
    if (!Number.isInteger(this.maxMutationAttempts) || this.maxMutationAttempts < 1) {
      throw new RangeError("maxMutationAttempts must be a positive integer");
    }
    this.writerClock = options.writerClock ?? (() => performance.now());
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
      this.recordsSource = this.db.query("SELECT 1 FROM sqlite_master WHERE name='registry_records'").get() ? "registry_records" : "registry_rows";
      this.changesReady = Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE name='registry_changes'").get());
      this.grantJournalReady = Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registry_grant_changes'").get());
      this.generationIdentitiesReady = this.generationIdentitiesInstalled(this.db);
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
      if (options.allowArchiveMigration !== false) {
        assertStateStartupMutation(path.dirname(filename),"agent registry archive schema");
        db.transaction(() => installRegistryArchive(db)).immediate();
      }
      return db;
    }, { reopened: (db) => this.onDatabaseReopened(db) });
    this.grantJournalReady = true;
    this.changesReady = Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE name='registry_changes'").get());
    this.recordsSource = this.changesReady ? "registry_records" : "registry_rows";
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(registry_rows)").all();
    if (!columns.some((column) => column.name === "row_order")) {
      this.runAtomically([
        "ALTER TABLE registry_rows ADD COLUMN row_order INTEGER NOT NULL DEFAULT 0",
        `WITH ordered AS (
          SELECT rowid, ROW_NUMBER() OVER (PARTITION BY collection ORDER BY rowid) - 1 AS position
          FROM registry_rows
        )
        UPDATE registry_rows
        SET row_order = (SELECT position FROM ordered WHERE ordered.rowid = registry_rows.rowid)`,
        `INSERT INTO registry_meta(key, value) VALUES ('schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ]);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS registry_rows_collection_order
      ON registry_rows(collection, row_order);
      CREATE INDEX IF NOT EXISTS registry_seat_children_order
      ON registry_rows(json_extract(value_json, '$.parentConversationId'), row_order)
      WHERE collection = 'lineageEdges' AND json_extract(value_json, '$.source') = 'viewer-spawn';
    `);
    for (const [field, jsonPath] of Object.entries(LOOKUP_PATHS)) {
      if (options.allowArchiveMigration === false
        && !["conversationId", "artifactPath", "command.operationId", "alias"].includes(field)) continue;
      this.db.exec(`CREATE INDEX IF NOT EXISTS registry_lookup_${field.replaceAll(".", "_")} ON registry_rows(collection, json_extract(value_json, '${jsonPath}'), row_order)${field === 'alias' ? " WHERE collection = 'conversationAliases'" : ''}`);
    }
    /* A receipt's grant decision selects the lineage edges its launch created.
       The archive indexes that field; without the hot half each decision parsed
       every edge, about 6 ms apiece over a retained registry (#2761). */
    if (options.allowArchiveMigration !== false) {
      this.db.exec("CREATE INDEX IF NOT EXISTS registry_lookup_evidence_launchId ON registry_rows(collection, json_extract(value_json, '$.evidence.launchId'), row_order)");
    }
    const livenessProjectionReady = this.meta("liveness_projection_version") === "1";
    this.runAtomically([
      `CREATE TABLE IF NOT EXISTS registry_liveness_entries (
        row_key TEXT PRIMARY KEY, row_order INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS registry_liveness_receipts (
        row_key TEXT PRIMARY KEY, row_order INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS registry_liveness_receipts_order ON registry_liveness_receipts(row_order)`,
      `CREATE INDEX IF NOT EXISTS registry_liveness_receipt_session ON registry_rows(
        (json_extract(value_json,'$.key.engine')||':'||json_extract(value_json,'$.key.sessionId'))
      ) WHERE collection='receipts'`,
      `CREATE TRIGGER IF NOT EXISTS registry_liveness_insert AFTER INSERT ON registry_rows
      WHEN NEW.collection IN ('entries','receipts') BEGIN
        DELETE FROM registry_liveness_entries WHERE NEW.collection='entries' AND row_key=NEW.row_key;
        DELETE FROM registry_liveness_receipts WHERE NEW.collection='receipts' AND row_key=NEW.row_key;
        INSERT INTO registry_liveness_entries(row_key,row_order)
          SELECT NEW.row_key,NEW.row_order WHERE NEW.collection='entries' AND (
            json_extract(NEW.value_json,'$.status')!='dead'
            OR json_extract(NEW.value_json,'$.host') IS NOT NULL
            OR json_extract(NEW.value_json,'$.structuredHost.process') IS NOT NULL
            OR json_extract(NEW.value_json,'$.claimOwner') IS NOT NULL
            OR json_extract(NEW.value_json,'$.pendingAction') IS NOT NULL
            OR COALESCE(json_array_length(NEW.value_json,'$.structuredTerminationSurvivors'),0)>0
          );
        INSERT INTO registry_liveness_receipts(row_key,row_order)
          SELECT NEW.row_key,NEW.row_order WHERE NEW.collection='receipts' AND (
            json_extract(NEW.value_json,'$.state') NOT IN ('completed','failed','conflicted')
            OR json_extract(NEW.value_json,'$.admissionOwner') IS NOT NULL
            OR json_extract(NEW.value_json,'$.queuedPinnedSpawn') IS NOT NULL
          );
      END`,
      `CREATE TRIGGER IF NOT EXISTS registry_liveness_update AFTER UPDATE ON registry_rows
      WHEN NEW.collection IN ('entries','receipts') BEGIN
        DELETE FROM registry_liveness_entries WHERE NEW.collection='entries' AND row_key=NEW.row_key;
        DELETE FROM registry_liveness_receipts WHERE NEW.collection='receipts' AND row_key=NEW.row_key;
        INSERT INTO registry_liveness_entries(row_key,row_order)
          SELECT NEW.row_key,NEW.row_order WHERE NEW.collection='entries' AND (
            json_extract(NEW.value_json,'$.status')!='dead'
            OR json_extract(NEW.value_json,'$.host') IS NOT NULL
            OR json_extract(NEW.value_json,'$.structuredHost.process') IS NOT NULL
            OR json_extract(NEW.value_json,'$.claimOwner') IS NOT NULL
            OR json_extract(NEW.value_json,'$.pendingAction') IS NOT NULL
            OR COALESCE(json_array_length(NEW.value_json,'$.structuredTerminationSurvivors'),0)>0
          );
        INSERT INTO registry_liveness_receipts(row_key,row_order)
          SELECT NEW.row_key,NEW.row_order WHERE NEW.collection='receipts' AND (
            json_extract(NEW.value_json,'$.state') NOT IN ('completed','failed','conflicted')
            OR json_extract(NEW.value_json,'$.admissionOwner') IS NOT NULL
            OR json_extract(NEW.value_json,'$.queuedPinnedSpawn') IS NOT NULL
          );
      END`,
      `CREATE TRIGGER IF NOT EXISTS registry_liveness_delete AFTER DELETE ON registry_rows BEGIN
        DELETE FROM registry_liveness_entries WHERE OLD.collection='entries' AND row_key=OLD.row_key;
        DELETE FROM registry_liveness_receipts WHERE OLD.collection='receipts' AND row_key=OLD.row_key;
      END`,
    ]);
    if (!livenessProjectionReady) this.runAtomically([
      `INSERT INTO registry_liveness_entries(row_key,row_order)
        SELECT row_key,row_order FROM registry_rows WHERE collection='entries' AND (
          json_extract(value_json,'$.status')!='dead' OR json_extract(value_json,'$.host') IS NOT NULL
          OR json_extract(value_json,'$.structuredHost.process') IS NOT NULL OR json_extract(value_json,'$.claimOwner') IS NOT NULL
          OR json_extract(value_json,'$.pendingAction') IS NOT NULL
          OR COALESCE(json_array_length(value_json,'$.structuredTerminationSurvivors'),0)>0
        ) ON CONFLICT(row_key) DO UPDATE SET row_order=excluded.row_order`,
      `INSERT INTO registry_liveness_receipts(row_key,row_order)
        SELECT row_key,row_order FROM registry_rows WHERE collection='receipts' AND (
          json_extract(value_json,'$.state') NOT IN ('completed','failed','conflicted')
          OR json_extract(value_json,'$.admissionOwner') IS NOT NULL OR json_extract(value_json,'$.queuedPinnedSpawn') IS NOT NULL
        ) ON CONFLICT(row_key) DO UPDATE SET row_order=excluded.row_order`,
      `INSERT INTO registry_meta(key,value) VALUES ('liveness_projection_version','1')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ]);
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
      this.runAtomically([
        "DROP TRIGGER IF EXISTS registry_paths_insert",
        "DROP TRIGGER IF EXISTS registry_paths_update",
        "DROP TRIGGER IF EXISTS registry_paths_delete",
        `CREATE TRIGGER registry_paths_insert AFTER INSERT ON registry_rows WHEN NEW.collection = 'conversations' BEGIN
          INSERT INTO registry_conversation_paths SELECT json_extract(value, '$.path'), NEW.row_key FROM json_each(NEW.value_json, '$.generations') WHERE json_extract(value, '$.path') IS NOT NULL ON CONFLICT(path, conversation_id) DO NOTHING;
          INSERT INTO registry_conversation_paths SELECT value, NEW.row_key FROM json_each(NEW.value_json, '$.continuityPaths') WHERE true ON CONFLICT(path, conversation_id) DO NOTHING;
        END`,
        `CREATE TRIGGER registry_paths_update AFTER UPDATE ON registry_rows WHEN NEW.collection = 'conversations' BEGIN
          DELETE FROM registry_conversation_paths WHERE conversation_id = OLD.row_key;
          INSERT INTO registry_conversation_paths SELECT json_extract(value, '$.path'), NEW.row_key FROM json_each(NEW.value_json, '$.generations') WHERE json_extract(value, '$.path') IS NOT NULL ON CONFLICT(path, conversation_id) DO NOTHING;
          INSERT INTO registry_conversation_paths SELECT value, NEW.row_key FROM json_each(NEW.value_json, '$.continuityPaths') WHERE true ON CONFLICT(path, conversation_id) DO NOTHING;
        END`,
        `CREATE TRIGGER registry_paths_delete AFTER DELETE ON registry_rows WHEN OLD.collection = 'conversations' BEGIN
          DELETE FROM registry_conversation_paths WHERE conversation_id = OLD.row_key;
        END`,
        `INSERT INTO registry_meta(key, value) VALUES ('conversation_paths_trigger_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ]);
    }
    if (this.meta("conversation_paths_ready") !== "1") {
      this.runAtomically([
        "INSERT OR IGNORE INTO registry_conversation_paths SELECT json_extract(g.value, '$.path'), r.row_key FROM registry_rows r, json_each(r.value_json, '$.generations') g WHERE r.collection = 'conversations' AND json_extract(g.value, '$.path') IS NOT NULL",
        "INSERT OR IGNORE INTO registry_conversation_paths SELECT p.value, r.row_key FROM registry_rows r, json_each(r.value_json, '$.continuityPaths') p WHERE r.collection = 'conversations'",
        "INSERT OR REPLACE INTO registry_meta(key, value) VALUES ('conversation_paths_ready', '1')",
      ]);
    }
    // Each generation's entry identity and path, so a grant decision finds the
    // conversations attesting to an entry through an index. Expanding every
    // conversation's generations instead cost 34 ms per decision (#2761). Triggers keep it
    // current for every writer, including a predecessor during handover.
    if (options.allowArchiveMigration !== false && this.meta("generation_identities_version") !== "1") {
      assertStateStartupMutation(path.dirname(filename), "agent registry generation identity index");
      const identities = (row: "NEW") => `INSERT INTO registry_generation_identities(conversation_id, entry_key, path)
        SELECT ${row}.row_key, json_extract(${row}.value_json, '$.engine') || ':' || json_extract(g.value, '$.id'), json_extract(g.value, '$.path')
        FROM json_each(${row}.value_json, '$.generations') g`;
      this.runAtomically([
        `CREATE TABLE IF NOT EXISTS registry_generation_identities (
          conversation_id TEXT NOT NULL, entry_key TEXT, path TEXT
        )`,
        "CREATE INDEX IF NOT EXISTS registry_generation_identities_entry ON registry_generation_identities(entry_key)",
        "CREATE INDEX IF NOT EXISTS registry_generation_identities_path ON registry_generation_identities(path)",
        "CREATE INDEX IF NOT EXISTS registry_generation_identities_owner ON registry_generation_identities(conversation_id)",
        "DROP TRIGGER IF EXISTS registry_generation_identities_insert",
        "DROP TRIGGER IF EXISTS registry_generation_identities_update",
        "DROP TRIGGER IF EXISTS registry_generation_identities_delete",
        `CREATE TRIGGER registry_generation_identities_insert AFTER INSERT ON registry_rows WHEN NEW.collection = 'conversations' BEGIN
          ${identities("NEW")};
        END`,
        `CREATE TRIGGER registry_generation_identities_update AFTER UPDATE ON registry_rows WHEN NEW.collection = 'conversations' OR OLD.collection = 'conversations' BEGIN
          DELETE FROM registry_generation_identities WHERE conversation_id = OLD.row_key AND OLD.collection = 'conversations';
          INSERT INTO registry_generation_identities(conversation_id, entry_key, path)
            SELECT NEW.row_key, json_extract(NEW.value_json, '$.engine') || ':' || json_extract(g.value, '$.id'), json_extract(g.value, '$.path')
            FROM json_each(NEW.value_json, '$.generations') g WHERE NEW.collection = 'conversations';
        END`,
        `CREATE TRIGGER registry_generation_identities_delete AFTER DELETE ON registry_rows WHEN OLD.collection = 'conversations' BEGIN
          DELETE FROM registry_generation_identities WHERE conversation_id = OLD.row_key;
        END`,
        "DELETE FROM registry_generation_identities",
        `INSERT INTO registry_generation_identities(conversation_id, entry_key, path)
          SELECT r.row_key, json_extract(r.value_json, '$.engine') || ':' || json_extract(g.value, '$.id'), json_extract(g.value, '$.path')
          FROM registry_rows r, json_each(r.value_json, '$.generations') g WHERE r.collection = 'conversations'`,
        `INSERT INTO registry_meta(key, value) VALUES ('generation_identities_version', '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ]);
    }
    this.generationIdentitiesReady = this.generationIdentitiesInstalled(this.db);
    this.secureFiles();
    this.importFirstBoot(options.initialSnapshot, options.verifyImport);
    if (this.changesReady) this.refreshColdKeys();
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

  private generationIdentitiesInstalled(db: BunDatabase): boolean {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registry_generation_identities'").get()) return false;
    return db.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key = 'generation_identities_version'").get()?.value === "1";
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
    this.readOnlyHotFile = null;
    this.coldReaderRows.clear();
    this.coldStableRows.clear();
    this.coldStableBytes = 0;
    this.coldRowProjections.clear();
    this.coldGrantDecisions.clear();
    this.coldGrantTargets.clear();
    this.coldRowProjectionResults.clear();
    this.coldViewCache = null;
    this.coldGrantCursor = null;
    this.coldKeys.clear();
    this.coldKeysStamp = "";
    this.coldKeysChangeId = 0;
    this.grantDecisions = null;
    this.resetHotGrants();
    this.collectionOrders.clear();
    this.snapshotChangeId = 0;
    this.localRows.clear();
    this.recordsSource = db.query("SELECT 1 FROM sqlite_master WHERE name='registry_records'").get() ? "registry_records" : "registry_rows";
    this.changesReady = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name='registry_changes'").get());
    this.grantJournalReady = Boolean(db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registry_grant_changes'",
    ).get());
    this.generationIdentitiesReady = this.generationIdentitiesInstalled(db);
  }

  snapshot(): SqliteRegistrySnapshot {
    const { file, revision } = this.loadSnapshot(false);
    return { file, revision };
  }

  private loadSnapshot(useRowCache: boolean): StampedSnapshot {
    this.onSnapshotLoad?.();
    this.db.exec("BEGIN");
    try {
      if (this.changesReady) this.refreshColdKeys();
      const hot = useRowCache && this.coldKeys.size > 0;
      const snapshot = hot ? this.loadHotInTransaction() : this.loadInTransaction(useRowCache);
      const stamp = this.storeStamp();
      const remembered = useRowCache ? this.rememberReadOnly({ ...snapshot,stamp },true,hot) : { ...snapshot,stamp };
      if (useRowCache) this.snapshotChangeId = this.changeId();
      this.db.exec("COMMIT");
      return remembered;
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
    const increment = this.refreshSnapshot();
    if (increment) return increment;
    return this.loadSnapshot(true);
  }

  private changeId(): number {
    return this.changesReady ? this.db.query<{ seq: number }, []>("SELECT COALESCE(MAX(seq),0) AS seq FROM registry_changes").get()!.seq : 0;
  }

  private refreshColdKeys(): void {
    const stamp = this.storeStamp();
    if (stamp === this.coldKeysStamp) return;
    /* Another writer committed. Replay only the journalled identities since the
       last read; rereading the whole mapping cost every transaction a scan of
       every cold row while two writers alternated (#2761). A trimmed or empty
       journal, or one that went backwards, takes the complete read. */
    const changeId = this.changeId();
    const first = this.coldKeysChangeId
      ? this.db.query<{ seq: number }, []>("SELECT COALESCE(MIN(seq),0) AS seq FROM registry_changes").get()!.seq : 0;
    if (this.coldKeysChangeId && first > 0 && first <= this.coldKeysChangeId + 1 && changeId >= this.coldKeysChangeId) {
      const changed = this.db.query<{ collection: string; row_key: string; cold: number }, [number]>(
        `SELECT DISTINCT j.collection,j.row_key,EXISTS (SELECT 1 FROM registry_cold c WHERE c.collection=j.collection AND c.row_key=j.row_key) AS cold
          FROM registry_changes j WHERE j.seq>?`).all(this.coldKeysChangeId);
      for (const { collection,row_key: key,cold } of changed) {
        const identity = grantDecisionKey(collection,key);
        if (!cold) { this.coldKeys.delete(identity); continue; }
        this.coldKeys.add(identity);
        this.rowCache.get(collection as RowCollection)?.delete(key);
      }
    } else {
      this.coldKeys = new Set(this.db.query<{ collection: string; row_key: string }, []>(
        "SELECT collection,row_key FROM registry_cold").all().map(row => grantDecisionKey(row.collection,row.row_key)));
      for (const [collection,rows] of this.rowCache) {
        for (const key of rows.keys()) if (this.coldKeys.has(grantDecisionKey(collection,key))) rows.delete(key);
      }
    }
    if (this.coldKeys.size) this.grantDecisions = null;
    this.coldKeysStamp = stamp;
    this.coldKeysChangeId = changeId;
  }

  private loadHotInTransaction(): SqliteRegistrySnapshot {
    this.refreshColdKeys();
    const input: Record<string, unknown> = { version: 2,entries: {},receipts: {} };
    for (const collection of ROW_COLLECTIONS) {
      const rows = this.db.query<Pick<StoredRow,"row_key"|"value_json">, [string]>(
        "SELECT row_key,value_json FROM registry_hot_rows WHERE collection=? ORDER BY row_order").all(collection);
      this.onRowPayloadRead?.(collection,rows.length);
      const values: Record<string, unknown> = {};
      for (const row of rows) values[row.row_key] = this.parseRow(collection,row.row_key,row.value_json,true);
      input[collection] = values;
    }
    for (const field of META_FIELDS) {
      const value = this.meta(field);
      if (value !== null) input[field] = JSON.parse(value);
    }
    const file = this.normalizePartial(input);
    const storedOwners = input.deliveryOperationOwners as Record<string, { deliveryId?: string } | null>;
    for (const [key,storedOwner] of Object.entries(storedOwners)) {
      if (storedOwner?.deliveryId && !Object.hasOwn(input.heldDeliveries as object,storedOwner.deliveryId)) {
        const owner = this.loadOwnerInTransaction(key);
        if (owner) file.deliveryOperationOwners[key] = owner;
      }
    }
    this.resetHotGrants();
    for (const collection of READER_GRANT_COLLECTIONS) {
      for (const [key,row] of Object.entries(file[collection])) {
        if (!rowClaimsBeyondBaselineGrant(row)) continue;
        const dependencies = new Set<string>();
        (file[collection] as Record<string, unknown>)[key] = this.decideStoredRow(collection,key,row,dependencies);
        this.trackHotGrant(grantDecisionKey(collection,key),dependencies);
      }
    }
    this.hotGrantsTracked = true;
    return { file,revision: Number(this.meta("revision") ?? 0) };
  }

  /** Every key of one collection in stored order, kept until the journal moves one. */
  private orderedKeys(collection: RowCollection): string[] {
    let order = this.collectionOrders.get(collection);
    if (!order) {
      const rows = this.db.query<{ row_key: string; row_order: number }, [string]>(
        "SELECT row_key,row_order FROM registry_rows WHERE collection=? ORDER BY row_order").all(collection);
      order = { keys: rows.map(row => row.row_key), orders: new Map(rows.map(row => [row.row_key,row.row_order])) };
      this.collectionOrders.set(collection,order);
    }
    return order.keys;
  }

  /** Drop the kept order of every collection in which a journalled row was
      added, removed or moved. */
  private refreshCollectionOrders(changes: readonly { collection: string; row_key: string }[]): void {
    const named = new Map<RowCollection, string[]>();
    for (const { collection,row_key: key } of changes) {
      if (!this.collectionOrders.has(collection as RowCollection)) continue;
      const keys = named.get(collection as RowCollection) ?? [];
      keys.push(key);
      named.set(collection as RowCollection,keys);
    }
    for (const [collection,keys] of named) {
      const kept = this.collectionOrders.get(collection)!;
      const position = this.db.query<{ row_order: number }, [string, string]>("SELECT row_order FROM registry_rows WHERE collection=? AND row_key=?");
      if (keys.length > 256 || keys.some(key => position.get(collection,key)?.row_order !== kept.orders.get(key))) this.collectionOrders.delete(collection);
    }
  }

  private resetHotGrants(): void {
    this.hotGrantDependencies.clear();
    this.hotGrantTargets.clear();
    this.hotGrantsTracked = false;
  }

  private forgetHotGrant(identity: string): void {
    const previous = this.hotGrantDependencies.get(identity);
    if (!previous) return;
    for (const dependency of previous) {
      const targets = this.hotGrantTargets.get(dependency)!;
      targets.delete(identity);
      if (!targets.size) this.hotGrantTargets.delete(dependency);
    }
    this.hotGrantDependencies.delete(identity);
  }

  private trackHotGrant(identity: string, dependencies: Set<string>): void {
    this.forgetHotGrant(identity);
    this.hotGrantDependencies.set(identity,dependencies);
    for (const dependency of dependencies) {
      const targets = this.hotGrantTargets.get(dependency) ?? new Set<string>();
      targets.add(identity);
      this.hotGrantTargets.set(dependency,targets);
    }
  }

  /** Owners normalize from their stored fields and the current reservation in
      the same read transaction. A missing owner is synthesized just as it is
      by the complete loader; legacy fallback fields must not come from an
      already-normalized previous view. */
  private loadOwnerInTransaction(operationId: string): RegistryFile["deliveryOperationOwners"][string] | undefined {
    const stored = this.db.query<{ value_json: string }, [string,string]>(
      `SELECT value_json FROM ${this.recordsSource} WHERE collection=? AND row_key=?`).get("deliveryOperationOwners",operationId);
    this.onRowPayloadRead?.("deliveryOperationOwners",stored ? 1 : 0);
    if (stored) this.onRowPayloadParse?.("deliveryOperationOwners",1);
    const owner = stored ? JSON.parse(stored.value_json) as { deliveryId?: string } : undefined;
    const delivery = owner?.deliveryId
      ? this.db.query<{ row_key: string; value_json: string }, [string]>(
        `SELECT row_key,value_json FROM ${this.recordsSource} WHERE collection='heldDeliveries' AND row_key=?`).get(owner.deliveryId)
      : this.db.query<{ row_key: string; value_json: string }, [string]>(
        `SELECT row_key,value_json FROM ${this.recordsSource} WHERE collection='heldDeliveries' AND json_extract(value_json,'$.command.operationId')=? ORDER BY row_order LIMIT 1`).get(operationId);
    this.onRowPayloadRead?.("heldDeliveries",delivery ? 1 : 0);
    if (delivery) this.onRowPayloadParse?.("heldDeliveries",1);
    return this.normalizePartial({ version: 2,entries: {},receipts: {},
      deliveryOperationOwners: owner ? { [operationId]: owner } : {},
      heldDeliveries: delivery ? { [delivery.row_key]: JSON.parse(delivery.value_json) } : {},
    }).deliveryOperationOwners[operationId];
  }

  /** Replay all intervening writers under one read transaction. A trimmed
      journal or a replaced database takes the complete, fail-closed loader. */
  private refreshSnapshot(): StampedSnapshot | null {
    const previous = this.readOnlyCache;
    if (!previous || !this.changesReady) return null;
    this.db.exec("BEGIN");
    try {
      const first = this.db.query<{ seq: number }, []>("SELECT COALESCE(MIN(seq),0) AS seq FROM registry_changes").get()!.seq;
      if (first > this.snapshotChangeId + 1 || this.changeId() < this.snapshotChangeId
        || (first === 0 && this.storeStamp() !== previous.stamp)) {
        this.db.exec("COMMIT");
        return null;
      }
      const changes = this.db.query<{ collection: string; row_key: string }, [number]>(
        "SELECT DISTINCT collection,row_key FROM registry_changes WHERE seq>? ORDER BY seq").all(this.snapshotChangeId);
      const file = { ...this.readOnlyHotFile! };
      this.refreshColdKeys();
      this.refreshCollectionOrders(changes);
      const dataVersion = this.storeStamp().split(":")[0]!;
      const changedCollections = new Set<RowCollection>();
      const affectedOwners = new Set<string>();
      /* Rows whose grant decision a journalled change can reach: the changed
         rows themselves and every row that read one of them, or looked for
         the identity one of them now carries, when it was decided. */
      const redecide = new Set<string>();
      const reaches = (dependency: string) => {
        for (const target of this.hotGrantTargets.get(dependency) ?? []) redecide.add(target);
      };
      let attestorsChanged = false;
      for (const { collection, row_key: key } of changes) {
        if (collection === "meta") {
          if (!META_FIELDS.includes(key as typeof META_FIELDS[number])) continue;
          const raw = this.meta(key);
          const normalized = this.normalize({ version: 2, entries: {}, receipts: {}, [key]: raw === null ? undefined : JSON.parse(raw) });
          (file as unknown as Record<string, unknown>)[key] = normalized[key as typeof META_FIELDS[number]];
          continue;
        }
        if (!ROW_COLLECTION_KEYS.has(collection)) continue;
        const kind = collection as RowCollection;
        if (!changedCollections.has(kind)) {
          (file as unknown as Record<string, unknown>)[kind] = { ...file[kind] };
          changedCollections.add(kind);
        }
        const rows = file[kind] as Record<string, unknown>;
        if (kind === "deliveryOperationOwners") {
          affectedOwners.add(key);
          continue;
        }
        if (kind === "heldDeliveries") {
          const previousDelivery = file.heldDeliveries[key];
          if (previousDelivery) affectedOwners.add(previousDelivery.command.operationId);
          const owners = this.db.query<{ row_key: string }, [string]>(
            "SELECT row_key FROM registry_rows WHERE collection='deliveryOperationOwners' AND json_extract(value_json,'$.deliveryId')=?").all(key);
          for (const owner of owners) affectedOwners.add(owner.row_key);
        }
        const rowIdentity = grantDecisionKey(kind, key);
        const local = this.localRows.get(rowIdentity);
        const warm = local?.dataVersion === dataVersion;
        let stored: { value_json: string } | null = null;
        if (!this.coldKeys.has(rowIdentity)) {
          if (warm) stored = local.valueJson === null ? null : { value_json: local.valueJson };
          else stored = this.db.query<{ value_json: string }, [string, string]>(
            "SELECT value_json FROM registry_hot_rows WHERE collection=? AND row_key=?").get(kind, key);
        }
        if (!warm) this.onRowPayloadRead?.(kind, stored ? 1 : 0);
        let parsed: unknown;
        if (!stored) { delete rows[key]; this.rowCache.get(kind)?.delete(key); }
        else {
          parsed = this.parseRow(kind,key,stored.value_json,true);
          const input = { version: 2, entries: {}, receipts: {}, [kind]: { [key]: parsed } };
          rows[key] = this.normalizePartial(input)[kind][key];
        }
        if (kind === "heldDeliveries" && file.heldDeliveries[key]) affectedOwners.add(file.heldDeliveries[key]!.command.operationId);
        if (kind === "conversations" || kind === "lineageEdges" || kind === "receipts") {
          /* An attestor changed, appeared, was archived or is gone. The
             journal names it whether or not it is hot now. */
          attestorsChanged = true;
          reaches(authorityDependency("row",rowIdentity));
          const current = (parsed ?? this.db.query<{ value_json: string }, [string, string]>(
            `SELECT value_json FROM ${this.recordsSource} WHERE collection=? AND row_key=?`).get(kind,key)?.value_json) as unknown;
          const attestor = (typeof current === "string" ? JSON.parse(current) : current) as
            { engine?: string; generations?: { id?: string; path?: string }[]; evidence?: { launchId?: string } } | undefined;
          if (kind === "conversations") {
            for (const generation of attestor?.generations ?? []) {
              reaches(authorityDependency("entry",`${attestor!.engine}:${generation.id}`));
              if (generation.path) reaches(authorityDependency("path",generation.path));
            }
          } else if (kind === "lineageEdges" && attestor?.evidence?.launchId) reaches(authorityDependency("launch",attestor.evidence.launchId));
        }
        if (READER_GRANT_COLLECTIONS.has(kind)) {
          if (rows[key]) redecide.add(rowIdentity);
          else this.forgetHotGrant(rowIdentity);
        }
      }
      const decide = (kind: RowCollection, key: string, changed: boolean) => {
        const identity = grantDecisionKey(kind,key);
        const held = (file[kind] as Record<string, unknown>)[key];
        if (held === undefined) { this.forgetHotGrant(identity); return; }
        /* A row the journal did not name is decided from what is stored, never
           from the lists an earlier decision left on it. */
        let candidate = held as object;
        if (!changed) {
          const stored = this.rowCache.get(kind)?.get(key)?.valueJson
            ?? this.db.query<{ value_json: string }, [string, string]>("SELECT value_json FROM registry_hot_rows WHERE collection=? AND row_key=?").get(kind,key)?.value_json;
          if (stored) candidate = JSON.parse(stored) as object;
        }
        if (!rowClaimsBeyondBaselineGrant(candidate)) { this.forgetHotGrant(identity); return; }
        const dependencies = new Set<string>();
        const decided = this.decideStoredRow(kind,key,candidate,dependencies);
        this.trackHotGrant(identity,dependencies);
        /* A decision that stands leaves the row, and with it its collection, as the view held them. */
        if (!changed && isDeepStrictEqual(grantLists(kind,decided as GrantProfileRow),grantLists(kind,held as GrantProfileRow))) return;
        if (!changedCollections.has(kind)) {
          (file as unknown as Record<string, unknown>)[kind] = { ...file[kind] };
          changedCollections.add(kind);
        }
        (file[kind] as Record<string, unknown>)[key] = decided;
      };
      const journalled = new Set(changes.map(change => grantDecisionKey(change.collection,change.row_key)));
      if (attestorsChanged && !this.hotGrantsTracked) {
        /* This view was loaded whole, without dependencies: decide every
           grant-bearing hot row once and keep what each read. */
        for (const kind of READER_GRANT_COLLECTIONS) {
          for (const key of Object.keys(file[kind])) decide(kind,key,journalled.has(grantDecisionKey(kind,key)));
        }
        this.hotGrantsTracked = true;
      } else {
        for (const identity of redecide) {
          const cut = identity.indexOf("\u0000");
          decide(identity.slice(0,cut) as RowCollection,identity.slice(cut+1),journalled.has(identity));
        }
      }
      if (affectedOwners.size) {
        file.deliveryOperationOwners = { ...file.deliveryOperationOwners };
        changedCollections.add("deliveryOperationOwners");
        for (const key of affectedOwners) {
          if (this.coldKeys.has(grantDecisionKey("deliveryOperationOwners",key))) {
            delete file.deliveryOperationOwners[key];
            continue;
          }
          const owner = this.loadOwnerInTransaction(key);
          if (owner) file.deliveryOperationOwners[key] = owner;
          else delete file.deliveryOperationOwners[key];
        }
      }
      for (const kind of changedCollections) {
        const ordered: Record<string, unknown> = {};
        for (const key of this.orderedKeys(kind)) if (Object.hasOwn(file[kind],key)) ordered[key] = file[kind][key];
        if (kind === "deliveryOperationOwners") {
          for (const [key,owner] of Object.entries(file.deliveryOperationOwners)) {
            if (!Object.hasOwn(ordered,key)) ordered[key] = owner;
          }
        }
        (file as unknown as Record<string, unknown>)[kind] = ordered;
      }
      const revision = Number(this.meta("revision") ?? 0);
      const stamp = this.storeStamp();
      this.refreshGrantDecisions(revision,stamp);
      /* The archive's mapping is unchanged when every row the journal names
         holds the archived version it held, or none as before. */
      const kept = this.coldViewCache;
      const version = this.db.query<{ archive_id: number }, [string, string]>("SELECT archive_id FROM registry_cold WHERE collection=? AND row_key=?");
      const archiveUnchanged = kept !== null && changes.length <= 256 && changes.every(change => !ROW_COLLECTION_KEYS.has(change.collection)
        || version.get(change.collection,change.row_key)?.archive_id === kept.coldIds.get(change.collection as RowCollection)?.get(change.row_key));
      const ownersUnchanged = archiveUnchanged && !changes.some(change => change.collection === "deliveryOperationOwners");
      const remembered = this.rememberReadOnly({ file,revision,stamp },false,false,{ archiveUnchanged,ownersUnchanged });
      this.snapshotChangeId = this.changeId();
      this.db.exec("COMMIT");
      return remembered;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* closed */ }
      throw error;
    }
  }

  /** Assemble every possible attestor of one grant through indexed identity
      reads, including cold contradictions. A receipt cannot pick its attestor
      by editing its own conversation id or embedded session key. */
  private decideStoredRow(collection: RowCollection, key: string, row: unknown, dependencies?: Set<string>, transaction?: TransactionGrantRows): unknown {
    const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {}, conversations: {}, lineageEdges: {} };
    const records = (kind: RowCollection) => input[kind] as Record<string, unknown>;
    /* A transaction's rows can hold the tracking proxies of other rows, which
       structured cloning refuses; they persist as JSON, so they copy as JSON. */
    const copy = (value: unknown) => transaction ? JSON.parse(JSON.stringify(value)) as unknown : structuredClone(value);
    records(collection)[key] = copy(row);
    dependencies?.add(authorityDependency("row",grantDecisionKey(collection,key)));
    const read = (kind: RowCollection, id: string) => {
      dependencies?.add(authorityDependency("row",grantDecisionKey(kind,id)));
      if (Object.hasOwn(records(kind),id)) return;
      const local = transaction?.row(kind,id);
      if (local !== undefined) {
        if (local) records(kind)[id] = copy(local.row);
        return;
      }
      const raw = this.db.query<{ value_json: string }, [string,string]>(`SELECT value_json FROM ${this.recordsSource} WHERE collection=? AND row_key=?`).get(kind,id);
      this.onRowPayloadRead?.(kind,raw ? 1 : 0);
      if (raw) records(kind)[id] = JSON.parse(raw.value_json);
    };
    const subject = row as { artifactPath?: string; key?: { engine: string; sessionId: string }; conversationId?: string };
    const entryKey = collection === "entries" ? key : subject.key ? `${subject.key.engine}:${subject.key.sessionId}` : null;
    if (entryKey || subject.artifactPath) {
      if (entryKey) dependencies?.add(authorityDependency("entry",entryKey));
      if (subject.artifactPath) dependencies?.add(authorityDependency("path",subject.artifactPath));
      const owners = (this.generationIdentitiesReady
        ? this.db.query<{ row_key: string }, [string|null,string|null]>(`SELECT DISTINCT i.conversation_id AS row_key FROM registry_generation_identities i
          WHERE (i.entry_key=?1 OR i.path=?2) AND EXISTS (SELECT 1 FROM ${this.recordsSource} r WHERE r.collection='conversations' AND r.row_key=i.conversation_id)`)
        : this.db.query<{ row_key: string }, [string|null,string|null]>(`SELECT DISTINCT r.row_key FROM ${this.recordsSource} r,json_each(r.value_json,'$.generations') g
          WHERE r.collection='conversations' AND (json_extract(r.value_json,'$.engine')||':'||json_extract(g.value,'$.id')=? OR json_extract(g.value,'$.path')=?)`))
        .all(entryKey,subject.artifactPath ?? null).map(owner => owner.row_key);
      for (const id of transactionSelection(transaction,"conversations",owners,(candidate: { engine?: string; generations?: { id?: string; path?: string }[] }) =>
        Boolean(candidate.generations?.some(generation => (entryKey !== null && `${candidate.engine}:${generation.id}` === entryKey)
          || (Boolean(subject.artifactPath) && generation.path === subject.artifactPath))))) read("conversations",id);
    }
    if (subject.conversationId) read("conversations",subject.conversationId);
    if (collection === "receipts") {
      dependencies?.add(authorityDependency("launch",key));
      const edges = this.db.query<{ row_key: string }, [string]>(`SELECT row_key FROM ${this.recordsSource} WHERE collection='lineageEdges' AND json_extract(value_json,'$.evidence.launchId')=?`).all(key).map(edge => edge.row_key);
      for (const id of transactionSelection(transaction,"lineageEdges",edges,(edge: { evidence?: { launchId?: string } }) => edge.evidence?.launchId === key)) read("lineageEdges",id);
    }
    for (const id of Object.keys(records("conversations"))) read("lineageEdges",id);
    for (const edge of Object.values(records("lineageEdges")) as { parentConversationId?: string; evidence?: { launchId?: string } }[]) {
      if (edge.parentConversationId) { read("conversations",edge.parentConversationId); read("lineageEdges",edge.parentConversationId); }
      if (edge.evidence?.launchId) read("receipts",edge.evidence.launchId);
    }
    const file = this.normalizePartial(input);
    reboundAssembledMcpGrants(file,this.mcpGrantPolicy);
    return (file[collection] as Record<string, unknown>)[key];
  }

  /* 250 rows per pass keeps the write lock short: a 1,000-row pass held it for
     about 160 ms on an idle machine and 0.8 s on a loaded one, and every
     writer waits that long synchronously (#2761). */
  archiveInactive(limit = 250): number {
    if (!this.changesReady) return 0;
    assertStateStartupMutation(path.dirname(this.filename), "agent registry archive");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("invalid registry archive batch limit");
    const held = this.writerHeld;
    /* Found before the lock is taken and confirmed under it: the search is
       most of a pass, and a pass with nothing to move takes no lock at all. */
    const preselected = held ? undefined : archiveCandidates(this.db,limit);
    if (preselected && !preselected.length) return 0;
    this.writerHeld = false;
    if (!held) this.db.exec("BEGIN IMMEDIATE");
    try {
      const moved = archiveInactiveRegistryRows(this.db,limit,preselected);
      if (moved) {
        this.setMeta("revision",String(Number(this.meta("revision") ?? 0)+1));
        this.db.run("DELETE FROM registry_changes WHERE seq <= (SELECT MAX(seq)-100000 FROM registry_changes)");
        this.db.run("DELETE FROM registry_grant_changes WHERE seq <= (SELECT MAX(seq)-100000 FROM registry_grant_changes)");
      }
      this.db.exec("COMMIT");
      if (moved) {
        this.refreshColdKeys();
        this.readOnlyCache = null;
        this.readOnlyHotFile = null;
        this.readerViews.clear();
      }
      return moved;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* closed */ }
      throw error;
    }
  }

  /** Project only grant lists for newly seen immutable versions. Refreshing
      their attestors then reuses these small claims without rereading every
      archived payload. Retired versions leave the store's projection cache. */
  private rememberColdProjections(headers: readonly { collection: RowCollection; archive_id: number }[]): void {
    const active = new Set(headers.filter(header => READER_GRANT_COLLECTIONS.has(header.collection) || header.collection === "heldDeliveries").map(header => header.archive_id));
    for (const id of this.coldRowProjections.keys()) if (!active.has(id)) this.coldRowProjections.delete(id);
    for (const id of this.coldGrantDecisions.keys()) if (!active.has(id)) this.forgetColdGrant(id);
    const missing = [...active].filter(id => !this.coldRowProjections.has(id));
    for (let offset = 0; offset < missing.length; offset += 500) {
      const ids = missing.slice(offset,offset+500);
      const claims = this.db.query<{ id: number; claims: string; operation_id: string | null }, number[]>(`SELECT id,
        json_object('launchProfile',json_object('mcpServers',json_extract(value_json,'$.launchProfile.mcpServers')),
          'generations',(SELECT json_group_array(json_object('launchProfile',json_object('mcpServers',json_extract(g.value,'$.launchProfile.mcpServers'))))
            FROM json_each(registry_archive.value_json,'$.generations') g)) AS claims,
        CASE WHEN json_type(value_json,'$.requestDigest')='text' AND json_extract(value_json,'$.requestDigest')!=''
          THEN json_extract(value_json,'$.command.operationId') END AS operation_id
        FROM registry_archive WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
      for (const row of claims) this.coldRowProjections.set(row.id,{ claimsGrant: rowClaimsBeyondBaselineGrant(JSON.parse(row.claims)),operationId: row.operation_id });
    }
  }

  private forgetColdGrant(id: number): void {
    const previous = this.coldGrantDecisions.get(id);
    if (!previous) return;
    this.coldGrantForgets += 1;
    for (const dependency of previous.dependencies) {
      const targets = this.coldGrantTargets.get(dependency)!;
      targets.delete(id);
      if (!targets.size) this.coldGrantTargets.delete(dependency);
    }
    this.coldGrantDecisions.delete(id);
  }

  /** A new owner can contradict an identity lookup that previously found no
      such row. Read only its identity projection to invalidate those selectors.
      Lost journals invalidate everything, including consecutive empty trims. */
  private refreshColdGrantDecisions(stamp: string): number {
    const changeId = this.changeId();
    const previous = this.coldGrantCursor;
    if (!previous || previous.stamp === stamp) return changeId;
    const first = this.db.query<{ seq: number }, []>("SELECT COALESCE(MIN(seq),0) AS seq FROM registry_changes").get()!.seq;
    if (changeId < previous.changeId || first > previous.changeId + 1 || first === 0) {
      this.coldGrantDecisions.clear();
      this.coldGrantTargets.clear();
      this.coldGrantForgets += 1;
      return changeId;
    }
    const changes = this.db.query<{ collection: RowCollection; row_key: string }, [number]>(
      "SELECT DISTINCT collection,row_key FROM registry_changes WHERE seq>?").all(previous.changeId);
    const invalidate = (dependency: string) => {
      for (const id of [...this.coldGrantTargets.get(dependency) ?? []]) this.forgetColdGrant(id);
    };
    for (const { collection,row_key: key } of changes) {
      invalidate(authorityDependency("row",grantDecisionKey(collection,key)));
      if (collection === "conversations") {
        const identities = this.db.query<{ entry_key: string; artifact_path: string | null }, [string]>(
          `SELECT json_extract(r.value_json,'$.engine')||':'||json_extract(g.value,'$.id') AS entry_key,
            json_extract(g.value,'$.path') AS artifact_path FROM ${this.recordsSource} r,json_each(r.value_json,'$.generations') g
            WHERE r.collection='conversations' AND r.row_key=?`).all(key);
        for (const identity of identities) {
          invalidate(authorityDependency("entry",identity.entry_key));
          if (identity.artifact_path) invalidate(authorityDependency("path",identity.artifact_path));
        }
      } else if (collection === "lineageEdges") {
        const edge = this.db.query<{ launch_id: string | null }, [string]>(
          `SELECT json_extract(value_json,'$.evidence.launchId') AS launch_id FROM ${this.recordsSource} WHERE collection='lineageEdges' AND row_key=?`).get(key);
        if (edge?.launch_id) invalidate(authorityDependency("launch",edge.launch_id));
      }
    }
    return changeId;
  }

  // Keep these factories as methods. The production minifier inlines local
  // functions into rememberReadOnly, making their closures retain its scope.
  private constantReader<T>(value: T): () => T {
    return () => value;
  }

  private mergedArchiveReader(
    archived: ReadonlyMap<string, PropertyDescriptor>, order: readonly string[], rows: Record<string, unknown>,
  ): () => Record<string, unknown> {
    let merged: Record<string, unknown> | undefined;
    return () => {
      if (merged) return merged;
      const descriptors: Record<string, PropertyDescriptor> = {};
      for (const key of order) {
        const accessor = archived.get(key);
        if (accessor) descriptors[key] = accessor;
        else if (Object.hasOwn(rows, key)) descriptors[key] = { enumerable: true, value: rows[key] };
      }
      return merged = Object.preventExtensions(Object.create(Object.prototype, descriptors)) as Record<string, unknown>;
    };
  }

  /** Archive accessors survive many refreshes. Capture only the immutable
      version and its grant lists; retaining a whole snapshot here links the
      next view to every older view whose accessors it reuses. Operation owners
      additionally retain the delivery collection they normalize against. */
  private archivedRowReader(
    collection: RowCollection, key: string, id: number, identity: string | null,
    stamp: string, pinnedGrants: (string[] | undefined)[] | undefined,
    deliveries: { read: () => RegistryFile["heldDeliveries"] } | undefined,
  ): () => unknown {
    return () => {
      // The immutable version id pins payload truth for an already-held view.
      if (databaseFileIdentity(this.filename) !== identity) throw new DatabaseReplacedError("registry view was replaced; request a fresh snapshot");
      /* An operation owner normalizes against its delivery, which commits
         can change; every other archived row reads the same until its
         pinned grant decision is replaced. */
      const stable = collection !== "deliveryOperationOwners";
      if (stable) {
        const kept = this.coldStableRows.get(id);
        if (kept && kept.pinned === pinnedGrants) {
          this.coldStableRows.delete(id); this.coldStableRows.set(id,kept);
          return kept.row;
        }
      }
      const cached = this.coldReaderRows.get(id);
      if (cached?.stamp === stamp) {
        this.coldReaderRows.delete(id); this.coldReaderRows.set(id,cached);
        return cached.row;
      }
      const raw = this.db.query<{ value_json: string }, [number]>("SELECT value_json FROM registry_archive WHERE id=?").get(id);
      if (!raw) throw new Error("registry archive version is missing");
      this.onRowPayloadRead?.(collection,1);
      this.onRowPayloadParse?.(collection,1);
      const value = JSON.parse(raw.value_json) as { deliveryId?: string };
      const delivery = collection === "deliveryOperationOwners" && value.deliveryId ? deliveries!.read()[value.deliveryId] : undefined;
      const normalized = this.normalizePartial({ version: 2,entries: {},receipts: {},[collection]: { [key]: value },
        ...(delivery ? { heldDeliveries: { [delivery.id]: delivery } } : {}) });
      let row = (normalized[collection] as Record<string, unknown>)[key];
      if (pinnedGrants) {
        const candidate = row as GrantProfileRow;
        const profiles = collection === "conversations" ? (candidate.generations ?? []).map(generation => generation.launchProfile) : [candidate.launchProfile];
        for (const [index,profile] of profiles.entries()) {
          const list = pinnedGrants[index];
          if (profile && list) profile.mcpServers = [...list];
        }
      }
      row = deepFreeze(row);
      if (stable) {
        const previous = this.coldStableRows.get(id);
        if (previous) { this.coldStableBytes -= previous.bytes; this.coldStableRows.delete(id); }
        this.coldStableRows.set(id,{ pinned: pinnedGrants,row,bytes: raw.value_json.length });
        this.coldStableBytes += raw.value_json.length;
        while (this.coldStableBytes > COLD_STABLE_ROW_BYTES && this.coldStableRows.size > 1) {
          const [oldest,evicted] = this.coldStableRows.entries().next().value!;
          this.coldStableRows.delete(oldest);
          this.coldStableBytes -= evicted.bytes;
        }
        return row;
      }
      this.coldReaderRows.delete(id);
      this.coldReaderRows.set(id,{ stamp,row });
      while (this.coldReaderRows.size > 128) this.coldReaderRows.delete(this.coldReaderRows.keys().next().value!);
      return row;
    };
  }

  private syntheticOwnerReader(operationId: string, deliveryId: string,
    deliveries: { read: () => RegistryFile["heldDeliveries"] }): () => unknown {
    return () => {
      const delivery = deliveries.read()[deliveryId];
      return deepFreeze(this.normalizePartial({ version: 2, entries: {}, receipts: {},
        heldDeliveries: delivery ? { [deliveryId]: delivery } : {},
      }).deliveryOperationOwners[operationId]);
    };
  }

  /** Every snapshot the shared cache holds is the frozen reader view of it.
      `complete` says the file is a complete load through the parse cache. */
  private rememberReadOnly(
    snapshot: StampedSnapshot,
    complete: boolean,
    tracked = false,
    /* What a refresh already read from the journal: whether any archived
       version moved, and whether a stored operation owner did. */
    journal: { archiveUnchanged: boolean; ownersUnchanged: boolean } = { archiveUnchanged: false, ownersUnchanged: false },
  ): StampedSnapshot {
    /* A whole load that recorded no dependencies leaves none to trust, and no
       journal position the kept orders could be replayed from. */
    if (complete && !tracked) this.resetHotGrants();
    if (complete) this.collectionOrders.clear();
    const identity = databaseFileIdentity(this.filename);
    /* Archive ids only grow, so the mapping's count, sum and largest id change
       whenever a version is archived, promoted or deleted. */
    const prior = this.coldViewCache;
    const signature = prior && journal.archiveUnchanged ? prior.signature
      : this.changesReady ? JSON.stringify(this.db.query<{ count: number; total: number; largest: number }, []>(
        "SELECT COUNT(*) AS count,COALESCE(SUM(archive_id),0) AS total,COALESCE(MAX(archive_id),0) AS largest FROM registry_cold").get()) : "";
    const cache = prior?.signature === signature ? prior : null;
    const headers = cache ? cache.headers : this.changesReady ? this.db.query<{ collection: RowCollection; row_key: string; archive_id: number }, []>(
      "SELECT c.collection,c.row_key,c.archive_id FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id ORDER BY a.row_order").all() : [];
    if (!cache) this.rememberColdProjections(headers);
    const coldGrantChangeId = this.refreshColdGrantDecisions(snapshot.stamp);
    /* The archive's mapping changes rarely and commits often: what is derived
       from the mapping alone is kept with it, so a refresh after another
       writer's commit walks only the collections whose hot rows changed. */
    let grouped = cache?.grouped;
    if (!grouped) {
      grouped = new Map();
      for (const header of headers) {
        const group = grouped.get(header.collection);
        if (group) group.push(header);
        else grouped.set(header.collection,[header]);
      }
    }
    const keptOwners = cache && journal.ownersUnchanged ? cache.syntheticOwners : null;
    const syntheticOwners = keptOwners ?? new Map<string,string>();
    const archivedDeliveries = keptOwners ? undefined : grouped.get("heldDeliveries");
    if (archivedDeliveries) {
      const storedOwners = new Set(this.db.query<{ row_key: string }, []>(
        "SELECT row_key FROM registry_rows WHERE collection='deliveryOperationOwners'").all().map(row => row.row_key));
      for (const header of archivedDeliveries) {
        const operationId = this.coldRowProjections.get(header.archive_id)?.operationId;
        if (operationId && !storedOwners.has(operationId) && !syntheticOwners.has(operationId)) syntheticOwners.set(operationId,header.row_key);
      }
    }
    if (headers.length) this.grantDecisions = null;
    let coldKeys = cache?.coldKeys;
    let coldIds = cache?.coldIds;
    let coldSignatures = cache?.coldSignatures;
    if (!coldKeys || !coldIds || !coldSignatures) {
      coldKeys = new Map<RowCollection, Set<string>>();
      coldIds = new Map<RowCollection, Map<string, number>>();
      coldSignatures = new Map<RowCollection, string>();
      const currentIds = new Set<number>();
      const tallies = new Map<RowCollection, { count: number; total: number; largest: number }>();
      for (const header of headers) {
        const tally = tallies.get(header.collection) ?? { count: 0, total: 0, largest: 0 };
        tally.count += 1;
        tally.total += header.archive_id;
        tally.largest = Math.max(tally.largest, header.archive_id);
        tallies.set(header.collection, tally);
        let keys = coldKeys.get(header.collection);
        if (!keys) coldKeys.set(header.collection,keys = new Set());
        keys.add(header.row_key);
        let ids = coldIds.get(header.collection);
        if (!ids) coldIds.set(header.collection,ids = new Map());
        ids.set(header.row_key,header.archive_id);
        currentIds.add(header.archive_id);
        this.rowCache.get(header.collection)?.delete(header.row_key);
        this.localRows.delete(grantDecisionKey(header.collection,header.row_key));
      }
      for (const results of this.coldRowProjectionResults.values()) {
        for (const id of results.keys()) if (!currentIds.has(id)) results.delete(id);
      }
      for (const [collection, tally] of tallies) coldSignatures.set(collection, `${tally.count}:${tally.total}:${tally.largest}`);
    }
    const hot = { ...snapshot.file };
    if (syntheticOwners.size) {
      hot.deliveryOperationOwners = { ...hot.deliveryOperationOwners };
      for (const key of syntheticOwners.keys()) delete hot.deliveryOperationOwners[key];
    }
    for (const [collection,keys] of coldKeys) {
      const rows: Record<string, unknown> = {};
      for (const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(hot[collection]))) {
        if (!keys.has(key) && "value" in descriptor) rows[key] = descriptor.value;
      }
      (hot as unknown as Record<string, unknown>)[collection] = rows;
    }
    const storedJson: StoredRowJson | undefined = complete
      ? (collection,key) => this.rowCache.get(collection)?.get(key)?.valueJson : undefined;
    this.readOnlyHotFile = this.readerViews.view(hot,storedJson);
    const file = { ...this.readOnlyHotFile };
    const collections = new Map<RowCollection, Record<string, unknown>>();
    // Bound after all collection descriptors are installed. The narrow cell
    // permits lazy delivery assembly without retaining this view's root.
    const deliveries = { read: this.constantReader(file.heldDeliveries) };
    /* A collection is reused only when every input to its getters is the
       same: its cold versions, its hot rows (frozen view rows are shared while
       unchanged), its pinned grant decisions, and for operation owners the
       deliveries they normalize against and the owners synthesized from them. */
    const hotRows = (collection: RowCollection) => new Map(Object.entries(file[collection] as Record<string, unknown>));
    const sameRows = (left: Map<string, unknown> | undefined, right: Map<string, unknown>) =>
      left !== undefined && left.size === right.size && [...right].every(([key,row]) => left.get(key) === row);
    const synthetic = JSON.stringify([...syntheticOwners]);
    const nextCache: NonNullable<typeof this.coldViewCache> = { signature,headers,coldKeys,coldIds,grouped,coldSignatures,forgets: this.coldGrantForgets,syntheticOwners,collections: new Map() };
    const reused = new Set<RowCollection>();
    /* Collections whose archived versions and pinned decisions are the ones
       the previous build held: only their hot rows differ, so the accessors
       of the archived rows are taken over rather than made again. */
    const coldReused = new Set<RowCollection>();
    const layered = [...new Set([...coldKeys.keys(),...(syntheticOwners.size ? ["deliveryOperationOwners" as const] : [])])];
    /* Read every hot side before any collection is replaced by a merged one. */
    const hotSides = new Map(layered.map(collection => [collection,hotRows(collection)] as const));
    const hotDeliveries = layered.includes("deliveryOperationOwners") ? hotRows("heldDeliveries") : undefined;
    for (const collection of layered) {
      /* Another writer's archive pass changed the mapping: a collection whose
         own archived versions are the ones it held reuses its build. */
      const source = cache ?? (prior?.coldSignatures.get(collection) === coldSignatures.get(collection) ? prior : null);
      const previous = source?.collections.get(collection);
      const hot = hotSides.get(collection)!;
      const deliveries = collection === "deliveryOperationOwners" ? hotDeliveries : undefined;
      const reusable = previous && sameRows(previous.hot,hot) && previous.synthetic === synthetic
        && (!deliveries || sameRows(previous.deliveries,deliveries))
        && (!READER_GRANT_COLLECTIONS.has(collection) || source!.forgets === this.coldGrantForgets);
      if (reusable) {
        Object.defineProperty(file,collection,{ enumerable: true,configurable: false,get: previous.built });
        reused.add(collection);
        nextCache.collections.set(collection,previous);
        continue;
      }
      /* An operation owner's accessor reads this view's deliveries. */
      const takenOver = previous && collection !== "deliveryOperationOwners" && coldKeys.has(collection)
        && (!READER_GRANT_COLLECTIONS.has(collection) || source!.forgets === this.coldGrantForgets);
      if (!takenOver) {
        nextCache.collections.set(collection,{ hot,...(deliveries ? { deliveries } : {}),synthetic,built: () => ({}) });
        continue;
      }
      let cold = previous.cold;
      if (!cold) {
        const built = previous.built();
        cold = new Map();
        for (const key of coldKeys.get(collection)!) cold.set(key,Object.getOwnPropertyDescriptor(built,key)!);
      }
      /* Everything the merged collection is made of is held here, so it is
         made when a reader first asks for it: most refreshes change a
         collection the next read never enumerates, and making nine thousand
         accessors for each cost every refresh milliseconds (#2761). */
      const archived = cold;
      const order = this.orderedKeys(collection);
      const rows = file[collection] as Record<string, unknown>;
      const built = this.mergedArchiveReader(archived, order, rows);
      Object.defineProperty(file,collection,{ enumerable: true,configurable: false,get: built });
      coldReused.add(collection);
      nextCache.collections.set(collection,{ hot,synthetic,built,cold });
    }
    const rebuilt = [...coldKeys.keys()].filter(collection => !reused.has(collection) && !coldReused.has(collection));
    for (const header of rebuilt.flatMap(collection => grouped.get(collection) ?? [])) {
      let rows = collections.get(header.collection);
      if (!rows) collections.set(header.collection,rows = { ...file[header.collection] });
      const { collection,row_key: key,archive_id: id } = header;
      // Resolve authority while this snapshot's transaction is still open.
      // Only the effective lists escape; the row payload remains evictable.
      let pinnedGrants: (string[] | undefined)[] | undefined;
      if (this.coldRowProjections.get(id)?.claimsGrant) {
        let decision = this.coldGrantDecisions.get(id);
        if (!decision) {
          const raw = this.db.query<{ value_json: string }, [number]>("SELECT value_json FROM registry_archive WHERE id=?").get(id)!;
          this.onRowPayloadRead?.(collection,1);
          this.onRowPayloadParse?.(collection,1);
          const dependencies = new Set<string>();
          const decided = this.decideStoredRow(collection,key,JSON.parse(raw.value_json),dependencies) as GrantProfileRow;
          decision = { lists: grantLists(collection,decided).map(list => list && [...list]),dependencies };
          this.coldGrantDecisions.set(id,decision);
          for (const dependency of dependencies) {
            const targets = this.coldGrantTargets.get(dependency) ?? new Set<number>();
            targets.add(id);
            this.coldGrantTargets.set(dependency,targets);
          }
        }
        pinnedGrants = decision.lists;
      }
      Object.defineProperty(rows,key,{ enumerable: true, configurable: false,
        get: this.archivedRowReader(collection, key, id, identity, snapshot.stamp, pinnedGrants,
          collection === "deliveryOperationOwners" ? deliveries : undefined) });
    }
    if (syntheticOwners.size && !reused.has("deliveryOperationOwners")) {
      let rows = collections.get("deliveryOperationOwners");
      if (!rows) collections.set("deliveryOperationOwners",rows = { ...file.deliveryOperationOwners });
      for (const [operationId,deliveryId] of syntheticOwners) {
        Object.defineProperty(rows,operationId,{ enumerable: true,
          get: this.syntheticOwnerReader(operationId, deliveryId, deliveries) });
      }
    }
    for (const [collection,rows] of collections) {
      const ordered: Record<string, unknown> = {};
      const descriptors = Object.getOwnPropertyDescriptors(rows);
      for (const key of this.orderedKeys(collection)) Object.defineProperty(ordered,key,descriptors[key]!);
      if (collection === "deliveryOperationOwners") {
        for (const key of Object.keys(descriptors)) if (!Object.hasOwn(ordered,key)) Object.defineProperty(ordered,key,descriptors[key]!);
      }
      (file as unknown as Record<string, unknown>)[collection] = Object.freeze(ordered);
      nextCache.collections.get(collection)!.built = this.constantReader(ordered);
    }
    const deliveryDescriptor = Object.getOwnPropertyDescriptor(file, "heldDeliveries")!;
    deliveries.read = deliveryDescriptor.get as (() => RegistryFile["heldDeliveries"]) | undefined
      ?? this.constantReader(deliveryDescriptor.value as RegistryFile["heldDeliveries"]);
    this.coldViewCache = nextCache;
    this.coldGrantCursor = { changeId: coldGrantChangeId,stamp: snapshot.stamp };
    const pinnedReceipts = this.changesReady ? this.pinnedRowKeys(file, "receipts", coldGrantChangeId, identity) : null;
    keyedReaders.set(file,(collection,field,value) => {
      const values = typeof value === "string" ? [value] : value;
      if (!values.length) return [];
      const indexed = () => this.db.query<{ row_key: string }, string[]>(`SELECT row_key FROM ${this.recordsSource} WHERE collection=? AND json_extract(value_json,'${LOOKUP_PATHS[field]}') IN (${values.map(() => "?").join(",")}) ORDER BY row_order`)
        .all(collection,...values).map(row => row.row_key);
      if (collection === "receipts" && field === "artifactPath") {
        const holds = (receipt: RegistryFile["receipts"][string]) => values.includes(receipt.artifactPath ?? "");
        return pinnedReceipts ? pinnedReceipts(indexed, holds) : Object.keys(file.receipts).filter(key => holds(file.receipts[key]!));
      }
      return indexed();
    });
    livenessReaders.set(file,() => {
      const projection = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_liveness_entries'").get();
      const entryRows = projection
        ? this.db.query<{ row_key: string }, []>("SELECT row_key FROM registry_liveness_entries ORDER BY row_order").all()
        : this.db.query<{ row_key: string }, []>(`SELECT row_key FROM ${this.recordsSource} WHERE collection='entries' AND (
          json_extract(value_json,'$.status')!='dead' OR json_extract(value_json,'$.host') IS NOT NULL
          OR json_extract(value_json,'$.structuredHost.process') IS NOT NULL OR json_extract(value_json,'$.claimOwner') IS NOT NULL
          OR json_extract(value_json,'$.pendingAction') IS NOT NULL
          OR COALESCE(json_array_length(value_json,'$.structuredTerminationSurvivors'),0)>0
        ) ORDER BY row_order`).all();
      const entries = entryRows.map(row => file.entries[row.row_key]).filter((row): row is AgentRegistryEntry => !!row);
      const entryKeys = entries.map(row => `${row.key.engine}:${row.key.sessionId}`);
      const receiptKeys = new Set((projection
        ? this.db.query<{ row_key: string }, []>("SELECT row_key FROM registry_liveness_receipts ORDER BY row_order").all()
        : this.db.query<{ row_key: string }, []>(`SELECT row_key FROM ${this.recordsSource} WHERE collection='receipts' AND (
          json_extract(value_json,'$.state') NOT IN ('completed','failed','conflicted')
          OR json_extract(value_json,'$.admissionOwner') IS NOT NULL OR json_extract(value_json,'$.queuedPinnedSpawn') IS NOT NULL
        ) ORDER BY row_order`).all()).map(row => row.row_key));
      if (entryKeys.length) {
        const placeholders = entryKeys.map(() => "?").join(",");
        for (const row of this.db.query<{ row_key: string }, string[]>(`SELECT r.row_key FROM registry_rows r INDEXED BY registry_liveness_receipt_session
          JOIN registry_liveness_entries e ON e.row_key IN (${placeholders})
          WHERE r.collection='receipts'
            AND (json_extract(r.value_json,'$.key.engine')||':'||json_extract(r.value_json,'$.key.sessionId'))=e.row_key
            AND (json_extract(r.value_json,'$.verifiedHost.agent') IS NOT NULL OR json_extract(r.value_json,'$.pane.panePid') IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM registry_cold c WHERE c.collection='receipts' AND c.row_key=r.row_key)`)
          .all(...entryKeys)) receiptKeys.add(row.row_key);
        const operationIds = entries.flatMap(row => row.structuredHostOperationId ? [row.structuredHostOperationId] : []);
        for (const operationId of operationIds) {
          const row = this.db.query<{ row_key: string }, [string]>(`SELECT row_key FROM registry_rows WHERE collection='receipts' AND row_key=?
            AND (json_extract(value_json,'$.verifiedHost.agent') IS NOT NULL OR json_extract(value_json,'$.pane.panePid') IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM registry_cold c WHERE c.collection='receipts' AND c.row_key=registry_rows.row_key)`).get(operationId);
          if (row) receiptKeys.add(row.row_key);
        }
      }
      const receipts = [...receiptKeys].map(key => file.receipts[key]).filter((row): row is RegistryFile["receipts"][string] => !!row);
      return { entries, receipts };
    });
    const ids = coldIds;
    const keys = coldKeys;
    coldKeyReaders.set(file,collection => keys.get(collection));
    projectionReaders.set(file,(collection,projector) => this.projectRows(file,collection,projector,ids.get(collection),identity));
    if (this.changesReady) endedOwnerReaders.set(file,since => this.db.query<{ row_key: string }, [string]>(
      `SELECT c.row_key FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id WHERE c.collection='deliveryOperationOwners'
        AND CASE WHEN json_type(a.value_json,'$.settledAt')='text' THEN json_extract(a.value_json,'$.settledAt')>=?1
          ELSE COALESCE(json_extract(a.value_json,'$.settledDelivery.deliveredAt')>=?1,0)
            OR EXISTS (SELECT 1 FROM ${this.recordsSource} d WHERE d.collection='heldDeliveries' AND d.row_key=json_extract(a.value_json,'$.deliveryId')
              AND json_extract(d.value_json,'$.deliveredAt')>=?1) END`).all(since).map(row => row.row_key));
    const pinned = this.pinnedRowKeys(file,"conversations",coldGrantChangeId,identity);
    if (this.changesReady) pathReaders.set(file,path => pinned(
      () => this.db.query<{ conversation_id: string }, [string]>(conversationPathSql(this.recordsSource)).all(path).map(row => row.conversation_id),
      row => row.generations.some(generation => generation.path === path) || row.continuityPaths.includes(path)));
    if (this.changesReady && this.generationIdentitiesReady) entryKeyReaders.set(file,entryKey => pinned(
      () => this.db.query<{ conversation_id: string }, [string]>(conversationEntryKeySql(this.recordsSource)).all(entryKey).map(row => row.conversation_id),
      row => row.generations.some(generation => `${row.engine}:${generation.id}` === entryKey)));
    this.readOnlyCache = Object.freeze({ ...snapshot,file: Object.freeze(file) });
    return this.readOnlyCache;
  }

  /** Identity lookups of one held view, answered as that view knows them.
      The path and generation indexes are the database's current ones, so a
      view held across another writer's commit asked them about rows it does
      not hold: a conversation moved to another path afterwards vanished from
      its own view, and a path taken over named an owner the view shows
      elsewhere. The rows journalled since the view was taken are the
      only ones the indexes can describe differently, so those are answered
      from the view's own rows and the rest from the index. A journal that no
      longer reaches back to the view, or a replaced database, enumerates the
      view. */
  private pinnedRowKeys<C extends RowCollection>(file: RegistryFile, collection: C, changeId: number, identity: string | null) {
    type Row = RegistryFile[C][string];
    let seen = changeId;
    let changed: Set<string> | null = new Set();
    let order: Map<string, number> | undefined;
    return (indexed: () => string[], holds: (row: Row) => boolean): string[] => {
      /* The index is read before the journal: whatever commits between the
         two reads is in the journal, and is then answered from the view. */
      const current = indexed();
      const last = this.changeId();
      if (last !== seen || databaseFileIdentity(this.filename) !== identity) {
        const first = this.db.query<{ seq: number }, []>("SELECT COALESCE(MIN(seq),0) AS seq FROM registry_changes").get()!.seq;
        changed = last < changeId || first > changeId + 1 || databaseFileIdentity(this.filename) !== identity ? null
          : new Set(this.db.query<{ row_key: string }, [number, string]>(
            "SELECT DISTINCT row_key FROM registry_changes WHERE seq>? AND collection=?").all(changeId, collection).map(row => row.row_key));
        seen = last;
      }
      const rows = file[collection] as Record<string, Row>;
      if (!changed) return Object.keys(rows).filter(key => holds(rows[key]!));
      if (!changed.size) return current;
      const owners = current.filter(key => !changed!.has(key));
      for (const key of changed) {
        const row = rows[key];
        if (row && holds(row)) owners.push(key);
      }
      if (owners.length > 1) {
        order ??= new Map(Object.keys(rows).map((key,index) => [key,index]));
        owners.sort((left,right) => (order!.get(left) ?? 0) - (order!.get(right) ?? 0));
      }
      return owners;
    };
  }

  /** Hot rows project from the view; an archived version projects once, read
      in batches straight from the archive and normalized as its accessor
      would normalize it, and the result is kept while the version is current. */
  private projectRows(
    file: RegistryFile,
    collection: RowCollection,
    projector: RegistryRowProjector<RowCollection, unknown>,
    cold: ReadonlyMap<string, number> | undefined,
    identity: string | null,
  ): Array<[string, unknown]> {
    if (collection === "deliveryOperationOwners") throw new Error("operation owners normalize against their deliveries; project them from the rows");
    const rows = file[collection] as Record<string, unknown>;
    const keys = Object.keys(rows);
    if (!cold?.size) return keys.map(key => [key, projector.project(rows[key] as never)]);
    let results = this.coldRowProjectionResults.get(projector.id);
    if (!results) this.coldRowProjectionResults.set(projector.id,results = new Map());
    const missing: Array<[string, number]> = [];
    for (const [key,id] of cold) if (!results.has(id)) missing.push([key,id]);
    if (missing.length) {
      if (databaseFileIdentity(this.filename) !== identity) throw new DatabaseReplacedError("registry view was replaced; request a fresh snapshot");
      const keyOf = new Map(missing.map(([key,id]) => [id,key]));
      const select = (count: number) => this.db.query<{ id: number; value_json: string }, number[]>(
        `SELECT id,value_json FROM registry_archive WHERE id IN (${Array.from({ length: count },() => "?").join(",")})`);
      for (let offset = 0; offset < missing.length; offset += 500) {
        const batch = missing.slice(offset,offset+500).map(([,id]) => id);
        const stored = select(batch.length).all(...batch);
        this.onRowPayloadRead?.(collection,stored.length);
        this.onRowPayloadParse?.(collection,stored.length);
        for (const { id,value_json: json } of stored) {
          const key = keyOf.get(id)!;
          const normalized = this.normalizePartial({ version: 2,entries: {},receipts: {},[collection]: { [key]: JSON.parse(json) } });
          const row = (normalized[collection] as Record<string, unknown>)[key];
          results.set(id,row === undefined ? undefined : deepFreeze(projector.project(row as never)));
        }
      }
    }
    return keys.map(key => {
      const id = cold.get(key);
      return [key, id === undefined ? projector.project(rows[key] as never) : results.get(id)];
    });
  }

  /** The callback must finish inside the transaction; no lazy object escapes. */
  read<T>(reader: (file: RegistryFile) => T): T {
    this.db.exec("BEGIN");
    try {
      if (this.changesReady) this.refreshColdKeys();
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
      if (this.changesReady) this.refreshColdKeys();
      const readRow = (collection: RowCollection, key: string): unknown => {
        const stored = this.db.query<Pick<StoredRow, "value_json">, [string, string]>(
          `SELECT value_json FROM ${this.recordsSource} WHERE collection = ? AND row_key = ?`,
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
      if (this.changesReady) this.refreshColdKeys();
      const file = this.normalize({ version: 2, entries: {}, receipts: {} });
      let evidenceGap = false;
      const read = (collection: RowCollection, key: string) => {
        const row = this.db.query<{ value_json: string }, [string, string]>(
          `SELECT value_json FROM ${this.recordsSource} WHERE collection=? AND row_key=?`,
        ).get(collection, key);
        this.onRowPayloadRead?.(collection, row ? 1 : 0);
        if (row) (file[collection] as Record<string, unknown>)[key] = this.parseRow(collection, key, row.value_json, true);
      };
      let anchor: SeatChildrenAnchor | null = null;
      if (after && !keys) {
        const current = this.db.query<{ row_order: number }, [string]>(
          `SELECT row_order FROM ${this.recordsSource} WHERE collection='lineageEdges' AND row_key=?`,
        ).get(after.key);
        anchor = current ? { key: after.key, order: current.row_order } : null;
      }
      const latest = keys ? null : this.db.query<{ row_key: string; row_order: number }, [string]>(`
        SELECT row_key,row_order FROM ${this.recordsSource} WHERE collection='lineageEdges'
        AND json_extract(value_json,'$.source')='viewer-spawn'
        AND json_extract(value_json,'$.parentConversationId')=? ORDER BY row_order DESC LIMIT 1
      `).get(parentId);
      const rows = keys ? keys.flatMap((key) => {
        const row = this.db.query<{ row_key: string; value_json: string; row_order: number }, [string]>(
          `SELECT row_key,value_json,row_order FROM ${this.recordsSource} WHERE collection='lineageEdges' AND row_key=?`,
        ).get(key);
        return row ? [row] : [];
      }) : this.db.query<{ row_key: string; value_json: string; row_order: number }, [string, number, number]>(`
        SELECT row_key,value_json,row_order FROM ${this.recordsSource} WHERE collection='lineageEdges'
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

  /** Advisory worker inventory. This reads indexed live hosts and their own
      lineage only; the general lazy registry reader inventories historical keys. */
  liveWorkerChildren(): { conversationId: string; parentConversationId: string; pipeline: boolean; deputy: boolean }[] {
    this.db.exec("BEGIN");
    try {
      const rows = this.db.query<{ artifactPath: string }, []>(`
        SELECT json_extract(value_json, '$.artifactPath') AS artifactPath
        FROM ${this.recordsSource}
        WHERE collection = 'entries' AND json_extract(value_json, '$.status') IN ('starting', 'live', 'idle', 'handoff')
          AND json_type(value_json, '$.structuredHost') = 'object'
        ORDER BY row_order
      `).all();
      this.onRowPayloadRead?.("entries", rows.length);
      const children = new Map<string, { conversationId: string; parentConversationId: string; pipeline: boolean; deputy: boolean }>();
      const parents = new Map<string, string>();
      const canonicalParent = (parent: string): string => {
        const cached = parents.get(parent);
        if (cached) return cached;
        const current = this.workerConversationId(parent);
        parents.set(parent, current);
        return current;
      };
      for (const row of rows) {
        // Literal keyed lookups keep the hot/cold records view from being
        // materialized by a join across its independently ordered histories.
        const owners = this.db.query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM registry_conversation_paths WHERE path = ?").all(row.artifactPath);
        const ordered = owners.flatMap(owner => {
          const record = this.db.query<{ row_order: number }, [string]>(`SELECT row_order FROM ${this.recordsSource} WHERE collection = 'conversations' AND row_key = ?`).get(owner.conversation_id);
          return record ? [{ id: owner.conversation_id, order: record.row_order }] : [];
        }).sort((left, right) => left.order - right.order);
        const conversationId = ordered[0]?.id;
        if (!conversationId || children.has(conversationId)) continue;
        const edge = this.db.query<{ parent: string; source: string }, [string]>(`SELECT json_extract(value_json, '$.parentConversationId') AS parent, json_extract(value_json, '$.source') AS source FROM ${this.recordsSource} WHERE collection = 'lineageEdges' AND row_key = ?`).get(conversationId);
        if (!edge || edge.source !== "viewer-spawn") continue;
        const stored = this.db.query<{ value_json: string }, [string]>(`SELECT value_json FROM ${this.recordsSource} WHERE collection = 'memberships' AND row_key = ?`).get(conversationId);
        const memberships = stored ? JSON.parse(stored.value_json) as { kind: string }[] : [];
        this.onRowPayloadRead?.("lineageEdges", 1);
        this.onRowPayloadRead?.("memberships", stored ? 1 : 0);
        children.set(conversationId, { conversationId, parentConversationId: canonicalParent(edge.parent), pipeline: memberships.some(item => item.kind === "pipeline"), deputy: memberships.some(item => item.kind === "orchestrator") });
      }
      this.db.exec("COMMIT");
      return [...children.values()];
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    }
  }

  private workerConversationId(id: string): string {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current) && seen.size < 64) {
      seen.add(current);
      const alias = this.db.query<{ value_json: string }, [string]>(`SELECT value_json FROM ${this.recordsSource} WHERE collection = 'conversationAliases' AND row_key = ?`).get(current);
      if (!alias) break;
      const next: unknown = JSON.parse(alias.value_json);
      if (typeof next !== "string") break;
      current = next;
    }
    return current;
  }

  workerSeatContexts(ids: readonly string[]): Map<string, { conversationId: string; directories: string[] }> {
    this.db.exec("BEGIN");
    try {
      const result = new Map<string, { conversationId: string; directories: string[] }>();
      for (const id of new Set(ids)) {
        const conversationId = this.workerConversationId(id);
        const row = this.db.query<{ generations: string }, [string]>(`SELECT json_extract(value_json, '$.generations') AS generations FROM ${this.recordsSource} WHERE collection = 'conversations' AND row_key = ?`).get(conversationId);
        this.onRowPayloadRead?.("conversations", row ? 1 : 0);
        const generations = row?.generations ? JSON.parse(row.generations) as { launchProfile?: { cwd?: string } }[] : [];
        result.set(id, { conversationId, directories: generations.toReversed().flatMap(generation => generation.launchProfile?.cwd ? [generation.launchProfile.cwd] : []) });
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    }
  }

  seatTickConversation(id: string): Pick<RegistryFile["conversations"][string], "id" | "turn"> | null {
    this.db.exec("BEGIN");
    try {
      if (this.changesReady) this.refreshColdKeys();
      const read = (collection: "conversationAliases" | "conversations", key: string) => {
        const row = this.db.query<{ value_json: string }, [string, string]>(
          `SELECT value_json FROM ${this.recordsSource} WHERE collection=? AND row_key=?`,
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

  /** One indexed receipt lookup for seat MCP liveness. Never load the registry
      or its child payloads into a five-minute monitor check. */
  seatMcpReceipt(conversationId: string): { spawnCapabilityDigest: string; createdAt: string; viewerMcpTransport: "stdio" | "http" | null } | null {
    const row = this.db.query<{ digest: string | null; created_at: string | null; mcp_transport: string | null }, [string]>(
      `SELECT json_extract(value_json, '$.spawnCapabilityDigest') AS digest, json_extract(value_json, '$.createdAt') AS created_at, json_extract(value_json, '$.viewerMcpTransport') AS mcp_transport FROM ${this.recordsSource} WHERE collection='receipts' AND json_extract(value_json, '$.conversationId')=? AND json_extract(value_json, '$.spawnCapabilityDigest') IS NOT NULL ORDER BY row_order DESC LIMIT 1`,
    ).get(conversationId);
    if (!row || typeof row.digest !== "string" || !/^[0-9a-f]{64}$/.test(row.digest) || typeof row.created_at !== "string") return null;
    return { spawnCapabilityDigest: row.digest, createdAt: row.created_at,
      viewerMcpTransport: row.mcp_transport === "http" ? "http" : row.mcp_transport === "stdio" ? "stdio" : null };
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
          `SELECT CASE WHEN length(CAST(value_json AS BLOB)) <= 262144 THEN value_json END AS value_json FROM ${this.recordsSource} WHERE collection=? AND row_key=?`,
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
      `SELECT CASE WHEN length(CAST(value_json AS BLOB)) <= 262144 THEN value_json END AS value_json FROM ${this.recordsSource} WHERE collection='receipts' AND row_key=?`,
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
      if (this.changesReady) this.refreshColdKeys();
      const readRow = (collection: "conversationAliases" | "conversations", key: string): unknown => {
        const stored = this.db.query<Pick<StoredRow, "value_json">, [string, string]>(
          `SELECT value_json FROM ${this.recordsSource} WHERE collection = ? AND row_key = ?`,
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

  mutate<T>(operation: (file: RegistryFile) => T, includeSnapshot = true, options: { operationName?: string; noWait?: boolean } = {}): SqliteRegistryMutation<T> {
    let operationName = options.operationName ?? operation.name;
    /* {@link withWriter} already opened the write transaction for this call. */
    const writerHeld = this.writerHeld;
    this.writerHeld = false;
    for (let attempt = 1; attempt <= this.maxMutationAttempts; attempt += 1) {
      const pessimistic = attempt > 1 || writerHeld;
      const waitStartedAt = performance.now();
      if (writerHeld) { /* the lock is held and the transaction is open */ }
      else if (pessimistic) this.beginMutationWrite(options.noWait);
      else this.db.exec("BEGIN");
      let current: LazyRegistrySnapshot;
      let changes: RegistryChanges;
      let result: T;
      try {
        if (pessimistic && !writerHeld) this.noteWriterWait(performance.now() - waitStartedAt, operationName);
        current = this.loadLazyInTransaction();
        result = operation(current.file);
        changes = current.changes();
        if (!pessimistic) this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
      const optimisticWaitStartedAt = performance.now();
      if (!pessimistic) this.beginMutationWrite(options.noWait);
      let revision: number;
      let stamps = { before: "", after: "" };
      const changed = changes.rows.size > 0 || changes.meta.size > 0 || changes.order.size > 0;
      try {
        if (!pessimistic) this.noteWriterWait(performance.now() - optimisticWaitStartedAt, operationName);
        if (!pessimistic && Number(this.meta("revision") ?? 0) !== current.revision) {
          this.db.exec("ROLLBACK");
          operationName ||= new Error().stack?.split("\n")[2]?.trim() ?? "anonymous";
          /* The whole lost attempt, read and wait included: the time a lost
             revision cost the caller before its retry. */
          recordBlockingWait({
            site: "registry-revision-retry",
            durationMs: performance.now() - waitStartedAt,
            synchronous: true,
            subject: operationName,
          });
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
        /* A delivery commit patches the cached reader view like any other
           narrow commit. Dropping it cost the next whole-registry
           reader a full reload, 0.28 to 0.40 s on a copy of the production
           registry (3,052 conversations, 3,254 deliveries) where the patch
           costs nothing measurable, and an account switch interleaves dozens
           of such commits with such readers on the Viewer's main thread
           (2026-10-07: every request stalled 3 to 6 s as a switch started). */
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

  private noteWriterWait(durationMs: number, operationName: string): void {
    this.onWriterWait?.(durationMs);
    recordBlockingWait({ site: "registry-lock", durationMs, synchronous: true, subject: operationName || "anonymous" });
  }

  /**
   * Runs `operation` once this connection holds the registry write lock, having
   * waited for the lock without holding the event loop. Answers
   * `{ acquired: false }` and runs nothing when the deadline passes first.
   *
   * The synchronous acquisition in {@link mutate} spins for up to five seconds
   * on the caller's thread, and on 2026-10-06 the Viewer's delivery path spent
   * up to 4.1 s there with every request behind it. Here each attempt asks for
   * the lock once with no busy wait and sleeps between attempts, so a lock
   * another process holds is waited out while the loop serves others. The
   * attempt that gets the lock keeps it: `operation` runs in the same
   * synchronous step, and the one {@link mutate} it makes reads, writes and
   * commits inside that transaction, so no writer can pass between the wait
   * and the write and the mutation cannot lose its revision.
   *
   * `operation` must go straight to its mutation: a snapshot read inside it
   * would open a second transaction.
   */
  async withWriter<T>(
    operation: () => T,
    options: {
      deadlineMs?: number;
      probeMs?: number;
      /** The correlation of a wait whose operation is only known once the
          write has made it (an admission mints its operation id inside). */
      correlate?: (value: T) => BlockingWaitCorrelation | null;
    } = {},
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const startedAt = performance.now();
    const deadline = this.writerClock() + (options.deadlineMs ?? 5_000);
    const probeMs = options.probeMs ?? 5;
    let attempts = 1;
    while (!this.tryBeginWrite()) {
      if (this.writerClock() >= deadline) {
        recordBlockingWait({ site: "registry-lock-async", durationMs: performance.now() - startedAt, synchronous: false, subject: "agent-registry" });
        return { acquired: false };
      }
      attempts += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, probeMs));
    }
    const waitedMs = performance.now() - startedAt;
    const noteWait = (correlation?: BlockingWaitCorrelation | null) => {
      if (attempts > 1) recordBlockingWait({ site: "registry-lock-async", durationMs: waitedMs, synchronous: false, subject: "agent-registry", correlation });
    };
    this.writerHeld = true;
    let value: T;
    try {
      value = operation();
    } catch (error) {
      noteWait();
      throw error;
    } finally {
      /* An operation that made no mutation leaves the transaction open. */
      if (this.writerHeld) {
        this.writerHeld = false;
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      }
    }
    noteWait(options.correlate?.(value));
    return { acquired: true, value };
  }

  /**
   * {@link withWriter} for a caller that may not wait at all: the lock is asked
   * for once, without a busy wait, and `operation` runs in the same synchronous
   * step when it was granted. A refusal runs nothing and is recorded with the
   * caller's correlation. For writes made inside another synchronous lock,
   * where neither a spin nor an `await` is safe.
   */
  tryWriter<T>(operation: () => T, options: { recordRefusal?: boolean } = {}): { acquired: true; value: T } | { acquired: false } {
    const startedAt = performance.now();
    if (!this.tryBeginWrite()) {
      if (options.recordRefusal !== false) recordBlockingWait({ site: "registry-lock-async", durationMs: performance.now() - startedAt, synchronous: false, subject: "agent-registry", refused: true });
      return { acquired: false };
    }
    this.writerHeld = true;
    try {
      return { acquired: true, value: operation() };
    } finally {
      if (this.writerHeld) {
        this.writerHeld = false;
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      }
    }
  }

  /** One request for the write lock that never waits. */
  private tryBeginWrite(): boolean {
    this.db.exec("PRAGMA busy_timeout = 0");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      return true;
    } catch (error) {
      if (error instanceof Error && (error as { code?: string }).code === "SQLITE_BUSY") return false;
      throw error;
    } finally {
      this.db.exec("PRAGMA busy_timeout = 5000");
    }
  }

  private beginMutationWrite(noWait = false): void {
    if (noWait) {
      this.db.exec("PRAGMA busy_timeout = 0");
      try { this.db.exec("BEGIN IMMEDIATE"); }
      finally { this.db.exec("PRAGMA busy_timeout = 5000"); }
      return;
    }
    const deadline = this.writerClock() + 5_000;
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
            || this.writerClock() >= deadline) throw error;
        }
      }
    } finally {
      this.db.exec("PRAGMA busy_timeout = 5000");
    }
  }

  replace(file: RegistryFile, expectedRevision?: number, options: { noWait?: boolean } = {}): SqliteRegistryReplacement {
    /* A wholesale replacement is a mutation like any other, and its payload
       arrives from outside this store, so it is re-decided before it lands
       rather than on the way back out (#739). `persistDiff` takes only a
       DecidedRegistryFile, so this line cannot be dropped without the store
       failing to compile. */
    const decided = this.decideAssembled(file);
    if (options.noWait) this.beginMutationWrite(true);
    else this.db.exec("BEGIN IMMEDIATE");
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
    /* The eager loader materializes collections without per-row accessors.
       Decide only now, with the complete receipt/edge/parent evidence present. */
    reboundAssembledMcpGrants(snapshot.file, this.mcpGrantPolicy);
    return snapshot;
  }

  private loadLazyInTransaction(trackMutations = true, useRowCache = trackMutations, readOnly = false): LazyRegistrySnapshot {
    if (this.changesReady) this.refreshColdKeys();
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
        if (recordable && this.coldKeys.size === 0) {
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
    /* What this transaction itself holds for a row: undefined while it has not
       touched the row, null once it deleted it. A scoped decision reads the
       transaction's own version of every attestor it rewrote. */
    const rawRows = new Map<RowCollection, (key: string) => unknown>();
    const transactionRows: TransactionGrantRows = {
      row: (kind, id) => {
        if (!dirtyRows.get(kind)?.has(id)) return undefined;
        const row = rawRows.get(kind)?.(id);
        return row === undefined ? null : { row };
      },
      dirty: kind => dirtyRows.get(kind) ?? [],
    };
    /* Rows a scoped decision already ran over in this transaction. Like a row
       the recorded decision answered, such a row is not decided again when the
       transaction rewrites it or serializes it (#2761). */
    const scopedDecided = new Set<string>();
    /* Every row leaves a loader through here. A row at the baseline is admitted
       untouched; anything claiming more is only returned once the decision has
       run over the whole file, including the rows attesting to this one. */
    const admitRow = <T>(collection: RowCollection, key: string, storedJson: string | null | undefined, row: T): T => {
      if (!GRANT_COLLECTIONS.has(collection) || grantsDecided || decidingGrants
        || !rowClaimsBeyondBaselineGrant(row)) return row;
      // Read-only authority checks need the subject and its independent
      // attestors, including cold evidence, rather than every historical row.
      if (readOnly && this.coldKeys.size && unchanged()) return this.decideStoredRow(collection,key,row) as T;
      /* A mutation over a registry with cold history decides the same way, over
         the subject, its attestors and this transaction's own rewrites of them.
         Assembling the whole file instead read every historical row for each
         grant-bearing write: 20,839 payloads and 1.2 s per write (#2761). */
      if (!readOnly && this.coldKeys.size && ![...reorderedCollections].some(kind => GRANT_COLLECTIONS.has(kind))) {
        const identity = grantDecisionKey(collection,key);
        if (scopedDecided.has(identity)) return row;
        scopedDecided.add(identity);
        const decided = grantLists(collection,this.decideStoredRow(collection,key,row,undefined,transactionRows) as GrantProfileRow);
        const candidate = row as GrantProfileRow;
        const profiles = collection === "conversations" ? (candidate.generations ?? []).map(generation => generation.launchProfile) : [candidate.launchProfile];
        let rewritten = false;
        for (const [index,profile] of profiles.entries()) {
          const list = decided[index];
          if (!profile || !list || isDeepStrictEqual(profile.mcpServers,list)) continue;
          profile.mcpServers = [...list];
          rewritten = true;
        }
        if (rewritten) dirtyRows.get(collection)?.add(key);
        return row;
      }
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
            this.rememberReadOnly({ file: snapshot.file, revision, stamp: stamp() }, true);
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
        `SELECT row_key FROM ${this.recordsSource} WHERE collection = ? AND json_extract(value_json, '${LOOKUP_PATHS[field]}') IN (${values.map(() => "?").join(",")}) ORDER BY row_order`,
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
        conversationPathSql(this.recordsSource),
      ).all(path).map(row => row.conversation_id));
      for (const key of dirtyRows.get("conversations") ?? []) {
        const row = file.conversations[key];
        if (row && (row.generations.some(generation => generation.path === path) || row.continuityPaths.includes(path))) keys.add(key); else keys.delete(key);
      }
      return [...keys];
    });
    if (this.generationIdentitiesReady) entryKeyReaders.set(file, entryKey => {
      const owns = (row: RegistryFile["conversations"][string] | undefined) =>
        Boolean(row?.generations.some(generation => `${row.engine}:${generation.id}` === entryKey));
      if (reorderedCollections.has("conversations")) return Object.values(file.conversations).filter(owns).map(row => row.id);
      const keys = new Set(this.db.query<{ conversation_id: string }, [string]>(
        conversationEntryKeySql(this.recordsSource),
      ).all(entryKey).map(row => row.conversation_id));
      for (const key of dirtyRows.get("conversations") ?? []) {
        if (owns(file.conversations[key])) keys.add(key); else keys.delete(key);
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
            `SELECT row_key, value_json FROM ${this.recordsSource} WHERE collection = ? ORDER BY row_order`,
          ).all(collection);
          this.onRowPayloadRead?.(collection, storedRows.length);
          for (const row of storedRows) {
            const parsed = this.parseRow(collection, row.row_key, row.value_json, useRowCache);
            (storedValue as Record<string, unknown>)[row.row_key] = trackMutations
              ? structuredClone(parsed)
              : parsed;
            if (trackMutations) baseline.set(row.row_key, row.value_json);
          }
          /* Every stored row is cached by now, so a larger cache holds rows
             this complete read proved gone. Without this a deleted row's parsed
             JSON stayed in the process for its lifetime. */
          const parsedRows = useRowCache ? this.rowCache.get(collection) : undefined;
          if (parsedRows && parsedRows.size > storedRows.length) {
            const stored = new Set(storedRows.map((row) => row.row_key));
            for (const key of parsedRows.keys()) if (!stored.has(key)) parsedRows.delete(key);
          }
          const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
          input[collection] = storedValue;
          if (collection === "deliveryOperationOwners") input.heldDeliveries = file.heldDeliveries;
          value = this.normalizePartial(input)[collection] as typeof value;
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
                return Reflect.set(target, property, writableJson(next));
              },
              deleteProperty: (target, property) => {
                if (typeof property === "string") dirty.add(property);
                return Reflect.deleteProperty(target, property);
              },
              defineProperty: (target, property, descriptor) => {
                if (typeof property === "string") dirty.add(property);
                return Reflect.defineProperty(target, property, writableDescriptor(descriptor));
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
          rawRows.set(collection, key => deleted.has(key) || !Object.hasOwn(rows, key) ? undefined : rows[key]);
          const storedRow = this.db.query<Pick<StoredRow, "value_json">, [string, string]>(
            `SELECT value_json FROM ${this.recordsSource} WHERE collection = ? AND row_key = ?`,
          );
          const storedRows = this.db.query<Pick<StoredRow, "row_key" | "value_json">, [string]>(
            `SELECT row_key, value_json FROM ${this.recordsSource} WHERE collection = ? ORDER BY row_order`,
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
              const normalized = this.normalizePartial(input)[collection] as Record<string, unknown>;
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
            const normalized = this.normalizePartial(input)[collection] as Record<string, unknown>;
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
              return Reflect.set(target, property, writableJson(next));
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
              return Reflect.defineProperty(target, property, writableDescriptor(descriptor));
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
          value = writableJson(next);
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
        /* Only a mutation compares against the baseline. */
        if (trackMutations) baselineMeta.set(field, structuredClone(value));
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
          value = writableJson(next);
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
    if (!useCache || this.coldKeys.has(grantDecisionKey(collection,key))) {
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
    // Both local and external writers use the same durable delta on the next
    // read. Never advance the snapshot cursor past an interleaved writer.
    this.refreshGrantDecisions(revision,stamps.after);
    for (const [collection,keys] of changes.rows) {
      const cache = this.rowCache.get(collection);
      const rows = file[collection] as Record<string, unknown>;
      for (const key of keys) {
        const valueJson = Object.hasOwn(rows,key) ? JSON.stringify(rows[key]) : null;
        this.localRows.delete(grantDecisionKey(collection,key));
        this.localRows.set(grantDecisionKey(collection,key),{ dataVersion: stamps.after.split(":")[0]!,valueJson });
        while (this.localRows.size > 128) this.localRows.delete(this.localRows.keys().next().value!);
        if (valueJson === null) { cache?.delete(key); continue; }
        cache?.set(key,{ valueJson,parsed: JSON.parse(valueJson) });
      }
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
        `SELECT value_json FROM ${this.recordsSource} WHERE collection = ? AND row_key = ?`,
      ).get(collection, key)?.value_json;
      if (!raw) continue;
      const value = JSON.parse(raw) as unknown;
      if (collection === "conversations" || collection === "lineageEdges") {
        for (const target of indexGrantSource(previous, collection, key, value)) rows.delete(target);
        if (collection === "lineageEdges") indexChildGrantSources(previous, key, value as RegistryFile["lineageEdges"][string]);
        else syncChildGrantTargets(previous, key);
      } else if (collection === "entries") {
        const entry = value as RegistryFile["entries"][string];
        addIndexedTarget(previous.entryPaths, entry.artifactPath, source);
        for (const conversationId of previous.conversationByPath.get(entry.artifactPath) ?? []) {
          addIndexedTarget(previous.sourceTargets, grantDecisionKey("conversations", conversationId), source);
          syncChildGrantTargets(previous, conversationId);
        }
      } else if (collection === "receipts") {
        indexReceipt(previous, key, value as RegistryFile["receipts"][string]);
        const receipt = value as RegistryFile["receipts"][string];
        if (receipt.conversationId) syncChildGrantTargets(previous, receipt.conversationId);
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
    if (this.changesReady) this.db.exec("DELETE FROM registry_cold");
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
          this.deleteRow(collection,key);
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
        else this.deleteRow(collection,key);
      }
    }
    for (const collection of changes.order) this.persistRowOrder(collection, Object.keys(file[collection]));
    for (const field of changes.meta) this.setMeta(field, JSON.stringify(file[field]));
    this.setMeta("revision", String(revision));
    if (this.changesReady) this.db.run("DELETE FROM registry_changes WHERE seq <= (SELECT MAX(seq)-100000 FROM registry_changes)");
    this.db.exec("DELETE FROM registry_grant_changes WHERE seq <= (SELECT MAX(seq) - 100000 FROM registry_grant_changes)");
  }

  private deleteRow(collection: RowCollection,key: string): void {
    if (this.changesReady) this.db.query("DELETE FROM registry_cold WHERE collection=? AND row_key=?").run(collection,key);
    this.db.query("DELETE FROM registry_rows WHERE collection=? AND row_key=?").run(collection,key);
    if (collection === "conversations") this.db.query("DELETE FROM registry_conversation_paths WHERE conversation_id=?").run(key);
  }

  private upsertRow(collection: RowCollection, key: string, value: unknown, order?: number): void {
    if (order !== undefined) {
      this.db.query(`
        INSERT INTO registry_rows(collection, row_key, value_json, row_order) VALUES (?, ?, ?, ?)
        ON CONFLICT(collection, row_key) DO UPDATE SET value_json = excluded.value_json, row_order = excluded.row_order
      `).run(collection, key, JSON.stringify(value), order);
      return;
    }
    /* The next position comes from the two order indexes. Aggregating over
       registry_records expanded every cold row of the collection on each
       insert, under the writer lock (#2761). */
    const archived = this.changesReady
      ? `(SELECT MAX(row_order) FROM registry_archive WHERE collection=?6)` : "NULL";
    this.db.query(`
      INSERT INTO registry_rows(collection, row_key, value_json, row_order)
      SELECT ?1, ?2, ?3, COALESCE((SELECT row_order FROM ${this.recordsSource} WHERE collection=?4 AND row_key=?5),
        MAX(COALESCE((SELECT MAX(row_order) FROM registry_rows WHERE collection=?6),-1), COALESCE(${archived},-1)) + 1) WHERE true
      ON CONFLICT(collection, row_key) DO UPDATE SET value_json = excluded.value_json
    `).run(collection, key, JSON.stringify(value), collection, key, collection);
  }

  private persistRowOrder(collection: RowCollection, keys: string[]): void {
    for (const [order, key] of keys.entries()) {
      // Replacement usually appends a row. Rewriting unchanged positions also
      // rewrites the collection and lineage indexes under the writer lock.
      this.db.query(`INSERT INTO registry_rows(collection,row_key,value_json,row_order)
        SELECT collection,row_key,value_json,? FROM ${this.recordsSource} WHERE collection=? AND row_key=? AND row_order!=?
        ON CONFLICT(collection,row_key) DO UPDATE SET row_order=excluded.row_order`)
        .run(order,collection,key,order);
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

  /** Runs a startup migration as one immediate transaction, one statement
      per call. A multi-statement `exec` under Bun 1.4.0 swallows a runtime
      fault and keeps running the statements after it (#1974), so a block
      written that way could commit half a migration and its marker. */
  private runAtomically(statements: readonly string[]): void {
    this.db.transaction(() => {
      for (const statement of statements) this.db.run(statement);
    }).immediate();
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
