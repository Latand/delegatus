import crypto from "node:crypto";
import fs from "node:fs";

import { MeasuredCache } from "@/lib/cacheTelemetry";
import { statePath } from "@/lib/configDir";
import { performanceSpans } from "@/lib/performanceSpans";
import { projectAliasResolver } from "@/lib/projects/aliases";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
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
import { stateLockAttempt } from "@/lib/state/lockWait";
import {
  readStateCollectionRevision,
  readStateCollectionSelection,
  readStateImport,
  SqliteStateCollection,
  type StateImportRecord,
  type StateImportRow,
} from "@/lib/state/sqliteStateStore";

import {
  cloneOrchestratorSeat,
  cloneOrchestratorSeatFile,
  cloneOrchestratorRevocation,
  cloneOrchestratorSeatTerminalization,
  emptyOrchestratorSeatFile,
  normalizeOrchestratorSeatDocument,
  normalizeSeat,
  normalizeSeatTrigger,
  ORCHESTRATOR_SEAT_HISTORY_CAP,
  ORCHESTRATOR_SEATS_SCHEMA_VERSION,
  seatSpanOf,
  strictOrchestratorSeatDocument,
  type OrchestratorRevocation,
  type OrchestratorSeat,
  type OrchestratorSeatFile,
  type OrchestratorSeatTerminalization,
  type ProjectResolver,
  type SeatLineageEntry,
} from "./seatRecords";

/*
 * The orchestrator seat record in `state.sqlite` (#1870 slice 4,
 * docs/design/state-sqlite-migration.md §4.2), moved out of
 * `orchestrator-seats.json`, which every caller used to read and parse whole.
 *
 * Layout of the `orchestrator_seats` collection, one row per key:
 *
 *   meta                     { schemaVersion, nextSeatEpoch, nextSeq }
 *   seat:<project>           the active seat of a project
 *   pending:<project>        its pending designate-and-inject intent
 *   rollback:<project>       the seat a provisional activation replaced
 *   revocation:<seq>         one revocation, in the order it was written
 *   lineage:<seq>            one retained seat lineage entry
 *   history:<seq>            one terminalized intent, the oldest trimmed at the cap
 *   text:<sha256>            one mandate or role table text
 *
 * A seat row stores its mandate and role table as `mandateText` and
 * `roleTableText`, the digests of `text:` rows. Twelve active seats and fifty
 * history entries used to carry about sixty copies of a handful of mandates of
 * about 29 KB each; now each distinct text is stored once, and a history entry
 * costs its few hundred bytes of metadata.
 *
 * `<seq>` comes from `meta.nextSeq` and is zero-padded, so key order is the
 * order the rows were written in, which is the order every reader of the
 * legacy arrays relied on. Project keys are stored as written and resolved
 * through the project alias map on every read, as the legacy reader did.
 *
 * Reads go through the shared read-only connection and select only the key
 * prefixes a question needs, in one snapshot (`readStateCollectionSelection`).
 * A read keeps what it selected per revision, so an unchanged record costs one
 * revision query and no parse. Texts are content-addressed and cached by digest.
 * Nothing on the read path imports the legacy file: the Viewer's activation
 * does (`LEGACY_COLLECTIONS`), and so does the first write of an install with
 * no release target. Until then a read parses the legacy file as before.
 *
 * Writes run under the collection lease: the record is read fresh, a private
 * copy is changed, and only the rows that differ are written.
 */

export const ORCHESTRATOR_SEAT_COLLECTION = "orchestrator_seats";
export const ORCHESTRATOR_SEATS_FILE_NAME = "orchestrator-seats.json";
const MIGRATION_ID = "orchestrator-seats-json-v1";
const BUSY = "orchestrator seat state is busy";

const META_KEY = "meta";
const TEXT_PREFIX = "text:";
const SLOT_PREFIX = { seats: "seat:", pending: "pending:", rollbacks: "rollback:" } as const;
const SEQUENCE_PREFIX = { revocations: "revocation:", seatLineage: "lineage:", history: "history:" } as const;
type Slot = keyof typeof SLOT_PREFIX;
type Sequence = keyof typeof SEQUENCE_PREFIX;
const SLOTS = Object.keys(SLOT_PREFIX) as Slot[];
const SEQUENCES = Object.keys(SEQUENCE_PREFIX) as Sequence[];

/** The keyed parts a reader may ask for. `slots` carries the meta row. */
export type SeatPart = "slots" | "revocations" | "lineage" | "history";
const PART_PREFIXES: Record<SeatPart, readonly string[]> = {
  slots: Object.values(SLOT_PREFIX),
  revocations: [SEQUENCE_PREFIX.revocations],
  lineage: [SEQUENCE_PREFIX.seatLineage],
  history: [SEQUENCE_PREFIX.history],
};
export const ALL_SEAT_PARTS: readonly SeatPart[] = ["slots", "revocations", "lineage", "history"];

/** Import gaps that leave the record unestablished until the next write. */
const UNESTABLISHED_GAPS = new Set(["legacy-unreadable", "tombstone-without-import"]);

/* A rollback mirror names the SQLite revision it was written from in one
   lineage entry. Every release that reads the legacy file keeps lineage
   entries through its own rewrites, so a file that still carries the recorded
   mirror's marker descends from that mirror and the rows it lacks were
   removed by the release that wrote it. The project cannot collide with a
   real project key, and the conversation names no conversation. The entry is
   never imported as a row. */
const MIRROR_MARKER_PROJECT = "sqlite-mirror-revision:orchestrator_seats";
const MIRROR_MARKER_CONVERSATION = "sqlite-mirror-revision-";

export function orchestratorSeatsLegacyPath(): string {
  return statePath(ORCHESTRATOR_SEATS_FILE_NAME);
}

/* ------------------------------------------------------------------ rows */

/** One stored row: the key it lives under and the record part it holds. */
interface SeatRow {
  key: string;
  value: unknown;
}

interface SeatMeta {
  schemaVersion: number;
  nextSeatEpoch: number;
  nextSeq: number;
}

/** A seat as stored: its texts replaced by their digests. */
type StoredSeat = Omit<OrchestratorSeat, "mandate" | "roleTable"> & { mandateText: string; roleTableText?: string };

function isSeatRow(value: unknown): value is SeatRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as SeatRow).key === "string" && (value as SeatRow).key.length > 0
    && Object.hasOwn(value as object, "value");
}

function sequenceKey(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(12, "0")}`;
}

/** The meta row of a record this release reads. A counter that does not
    hold is repaired on read, as the legacy reader repaired it: the epoch
    counter postdates every epoch on record, and new rows number after every
    stored one. Only another schema leaves the record unestablished. */
function isMeta(value: unknown): value is SeatMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Partial<SeatMeta>).schemaVersion === ORCHESTRATOR_SEATS_SCHEMA_VERSION;
}

function metaOf(value: SeatMeta): SeatMeta {
  return {
    schemaVersion: value.schemaVersion,
    nextSeatEpoch: Number.isSafeInteger(value.nextSeatEpoch) && value.nextSeatEpoch >= 1 ? value.nextSeatEpoch : 1,
    nextSeq: Number.isSafeInteger(value.nextSeq) && value.nextSeq >= 0 ? value.nextSeq : 0,
  };
}

/* ----------------------------------------------------------------- texts */

interface SeatStoreCaches {
  /** digest → text; content-addressed, so an entry never goes stale. */
  texts: MeasuredCache<string, string>;
  textBytes: number;
  /** text → digest, so a write does not hash the same mandate twice. */
  digests: Map<string, string>;
  snapshots: MeasuredCache<string, StoreSnapshot>;
  legacy: MeasuredCache<string, LegacySnapshot>;
}

const TEXT_CACHE_BYTES = 32 * 1024 * 1024;
const DIGEST_CACHE_ENTRIES = 512;
const SNAPSHOT_CACHE_ENTRIES = 4;
const cacheProperty = "__delegatusOrchestratorSeatStoreV1__" as const;

function caches(): SeatStoreCaches {
  const owner = globalThis as typeof globalThis & { [cacheProperty]?: SeatStoreCaches };
  return owner[cacheProperty] ??= {
    texts: new MeasuredCache("texts", "orchestrator/seatStore", (text) => text.length * 2, "utf16"),
    textBytes: 0,
    digests: new Map(),
    snapshots: new MeasuredCache("snapshots", "orchestrator/seatStore", (snapshot) => snapshot.bytes, "stored-json"),
    legacy: new MeasuredCache("legacy", "orchestrator/seatStore", (snapshot) => snapshot.bytes, "file-bytes"),
  };
}

function rememberText(digest: string, text: string): void {
  const cache = caches();
  if (cache.texts.has(digest)) {
    cache.texts.delete(digest);
    cache.texts.set(digest, text);
    return;
  }
  cache.texts.set(digest, text);
  cache.textBytes += text.length * 2;
  while (cache.textBytes > TEXT_CACHE_BYTES && cache.texts.size > 1) {
    const oldest = cache.texts.keys().next().value!;
    cache.textBytes -= (cache.texts.get(oldest)?.length ?? 0) * 2;
    cache.texts.delete(oldest);
  }
}

function textDigest(text: string): string {
  const cache = caches();
  const held = cache.digests.get(text);
  if (held) return held;
  const digest = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  cache.digests.set(text, digest);
  while (cache.digests.size > DIGEST_CACHE_ENTRIES) cache.digests.delete(cache.digests.keys().next().value!);
  rememberText(digest, text);
  return digest;
}

/** A seat as stored, in the shape a read normalizes it to, so a row read back
    and written again unchanged compares equal and is not rewritten. */
function storedSeat(seat: OrchestratorSeat, texts: Map<string, string>): StoredSeat {
  const { mandate, roleTable, ...rest } = normalizeSeat(seat) ?? seat;
  const mandateText = textDigest(mandate);
  texts.set(mandateText, mandate);
  if (typeof roleTable !== "string") return { ...rest, mandateText };
  const roleTableText = textDigest(roleTable);
  texts.set(roleTableText, roleTable);
  return { ...rest, mandateText, roleTableText };
}

/** The stored seat with its texts put back, or the row as stored when a text
    is missing: the normalizer then refuses it as it refuses any torn seat. */
function hydratedSeat(value: unknown, text: (digest: string) => string | undefined): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { mandateText, roleTableText, ...rest } = value as Partial<StoredSeat> & Record<string, unknown>;
  if (typeof mandateText !== "string") return value;
  const mandate = text(mandateText);
  if (mandate === undefined) return rest;
  if (typeof roleTableText !== "string") return { ...rest, mandate };
  const roleTable = text(roleTableText);
  return roleTable === undefined ? rest : { ...rest, mandate, roleTable };
}

function seatTextDigests(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const seat = value as Partial<StoredSeat>;
  if (typeof seat.mandateText === "string") into.add(seat.mandateText);
  if (typeof seat.roleTableText === "string") into.add(seat.roleTableText);
}

function storedRevocation(entry: OrchestratorRevocation): OrchestratorRevocation {
  return {
    project: entry.project,
    conversationId: entry.conversationId,
    seatEpoch: entry.seatEpoch,
    revokedAt: entry.revokedAt,
    successorConversationId: typeof entry.successorConversationId === "string" ? entry.successorConversationId : null,
    triggeredBy: normalizeSeatTrigger(entry.triggeredBy),
    ...seatSpanOf(entry),
  };
}

function storedTerminalization(entry: OrchestratorSeatTerminalization, texts: Map<string, string>): unknown {
  return { seat: storedSeat(entry.seat, texts), reason: entry.reason, terminalizedAt: entry.terminalizedAt };
}

/* ------------------------------------------------------- record <-> rows */

/** Rows for a record. `keys` names the stored row of an ordered element the
    record was read from; an element without one is new and takes the next
    sequence number. */
function recordRows(file: OrchestratorSeatFile, keys: WeakMap<object, string>, firstSeq: number): {
  rows: Map<string, unknown>;
  texts: Map<string, string>;
  added: Map<Sequence, object[]>;
} {
  const rows = new Map<string, unknown>();
  const texts = new Map<string, string>();
  const added = new Map<Sequence, object[]>(SEQUENCES.map((section) => [section, []]));
  let nextSeq = firstSeq;
  rows.set(META_KEY, null);
  for (const slot of SLOTS) {
    for (const [project, seat] of Object.entries(file[slot])) rows.set(`${SLOT_PREFIX[slot]}${project}`, storedSeat(seat, texts));
  }
  const sections: Record<Sequence, readonly object[]> = { revocations: file.revocations, seatLineage: file.seatLineage ?? [], history: file.history };
  for (const section of SEQUENCES) {
    for (const element of sections[section]) {
      let key = keys.get(element);
      if (!key || rows.has(key)) {
        key = sequenceKey(SEQUENCE_PREFIX[section], nextSeq++);
        added.get(section)!.push(element);
      }
      rows.set(key, section === "history" ? storedTerminalization(element as OrchestratorSeatTerminalization, texts)
        : section === "revocations" ? storedRevocation(element as OrchestratorRevocation)
          : element);
    }
  }
  const meta: SeatMeta = { schemaVersion: ORCHESTRATOR_SEATS_SCHEMA_VERSION, nextSeatEpoch: file.nextSeatEpoch, nextSeq };
  rows.set(META_KEY, meta);
  for (const [digest, text] of texts) rows.set(`${TEXT_PREFIX}${digest}`, text);
  return { rows, texts, added };
}

function rowJson(key: string, value: unknown): string {
  return JSON.stringify({ key, value });
}

/** A record's rows for the import: every row is new. */
function importRows(file: OrchestratorSeatFile): StateImportRow[] {
  const { rows } = recordRows(file, new WeakMap(), 0);
  return [...rows].map(([key, value]) => ({ key, value: { key, value }, controllerActive: true }));
}

/* ------------------------------------------------------------- snapshot */

interface StoredRow {
  key: string;
  json: string;
  value: unknown;
  rowRevision: number;
}

/** What one database answered at one collection revision. Parts join it as
    readers ask for them; a later revision starts a new snapshot. */
interface StoreSnapshot {
  database: string;
  identity: string;
  revision: number;
  importGap: string | null;
  meta: StoredRow | null;
  parts: Map<SeatPart, StoredRow[]>;
  textKeys: Set<string> | null;
  bytes: number;
  view: CanonicalView | null;
}

/** The record as the alias map read when it was built. */
interface CanonicalView {
  parts: ReadonlySet<SeatPart>;
  projects: readonly string[];
  resolved: readonly string[];
  /** Null: the stored record could not be established. */
  file: OrchestratorSeatFile | null;
  /** Ordered element of `file` → the stored row it was read from. */
  keys: WeakMap<object, string>;
  /** Canonical slot entry → the stored rows that resolve to it. */
  slotKeys: Map<string, string[]>;
  /** Why the record is unestablished, when it is. */
  unestablished: "gap" | "meta" | null;
}

function databaseIdentity(database: string): string | null {
  const stat = fs.statSync(database, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

/** A stored row whose JSON does not parse, or does not name its own key,
    decodes to no value: the tolerant read drops it, the strict read refuses
    the record, and the next write removes it, as a torn file used to be. */
function decodeStored(row: { key: string; valueJson: string; rowRevision: number }): StoredRow {
  let value: unknown;
  try {
    const parsed = JSON.parse(row.valueJson) as unknown;
    if (isSeatRow(parsed) && parsed.key === row.key) value = parsed.value;
  } catch {
    value = undefined;
  }
  return { key: row.key, json: row.valueJson, value, rowRevision: row.rowRevision };
}

function partOf(key: string): SeatPart | "meta" | "text" | null {
  if (key === META_KEY) return "meta";
  if (key.startsWith(TEXT_PREFIX)) return "text";
  for (const part of ALL_SEAT_PARTS) if (PART_PREFIXES[part].some((prefix) => key.startsWith(prefix))) return part;
  return null;
}

function selectParts(database: string, parts: readonly SeatPart[], textKeys: boolean) {
  return performanceSpans.sync("orchestrator.seat-read", () => readStateCollectionSelection(database, ORCHESTRATOR_SEAT_COLLECTION, {
    prefixes: parts.flatMap((part) => PART_PREFIXES[part]),
    keys: parts.includes("slots") ? [META_KEY] : [],
    keysOnly: textKeys ? [TEXT_PREFIX] : [],
  }));
}

function absorb(snapshot: StoreSnapshot, parts: readonly SeatPart[], selection: NonNullable<ReturnType<typeof readStateCollectionSelection>>, textKeys: boolean): void {
  const grouped = new Map<SeatPart, StoredRow[]>(parts.map((part) => [part, []]));
  for (const raw of selection.rows) {
    const row = decodeStored(raw);
    snapshot.bytes += raw.valueJson.length * 2;
    const part = partOf(row.key);
    if (part === "meta") snapshot.meta = row;
    else if (part !== "text" && part !== null) grouped.get(part)?.push(row);
  }
  for (const [part, rows] of grouped) snapshot.parts.set(part, rows);
  if (textKeys) snapshot.textKeys = new Set(selection.keys.map((key) => key.slice(TEXT_PREFIX.length)));
  if (parts.length > 0) snapshot.view = null;
}

/* The collection revision, read again only when the database or its WAL
   changed since the last read: an unchanged database costs two stats and no
   query, as the state collections' own revision reads do. A writer asks
   fresh. */
const revisionProbes = new Map<string, { signature: string; revision: number | null }>();

function databaseSignature(database: string): { identity: string; signature: string } | null {
  const db = fs.statSync(database, { bigint: true, throwIfNoEntry: false });
  if (!db) return null;
  const wal = fs.statSync(`${database}-wal`, { bigint: true, throwIfNoEntry: false });
  const identity = `${db.dev}:${db.ino}`;
  return { identity, signature: `${identity}:${db.mtimeNs}:${db.size}:${wal ? `${wal.mtimeNs}:${wal.size}` : "-"}` };
}

/** The database's identity and the collection's revision (null before the
    import), or null when there is no database at all. */
function probeDatabase(database: string, fresh: boolean): { identity: string; revision: number | null } | null {
  const before = databaseSignature(database);
  if (!before) return null;
  const held = revisionProbes.get(database);
  if (!fresh && held?.signature === before.signature) return { identity: before.identity, revision: held.revision };
  const revision = readStateCollectionRevision(database, ORCHESTRATOR_SEAT_COLLECTION);
  if (databaseSignature(database)?.signature === before.signature) {
    revisionProbes.delete(database);
    revisionProbes.set(database, { signature: before.signature, revision });
    while (revisionProbes.size > SNAPSHOT_CACHE_ENTRIES) revisionProbes.delete(revisionProbes.keys().next().value!);
  }
  return { identity: before.identity, revision };
}

/** The selected parts at the current revision, or null while the collection
    does not exist (the legacy file is still the record). */
function storeSnapshot(database: string, parts: readonly SeatPart[], textKeys: boolean, fresh = false): StoreSnapshot | null {
  const probed = probeDatabase(database, fresh);
  if (probed === null) return null;
  const { identity, revision } = probed;
  const cache = caches();
  let snapshot: StoreSnapshot | undefined = cache.snapshots.get(database);
  if (snapshot && snapshot.identity !== identity) snapshot = undefined;
  if (revision === null) return null;
  if (snapshot && snapshot.revision !== revision) snapshot = undefined;
  const missing = parts.filter((part) => !snapshot?.parts.has(part));
  const needsTextKeys = textKeys && !snapshot?.textKeys;
  if (snapshot && missing.length === 0 && !needsTextKeys) return snapshot;

  let selection = selectParts(database, snapshot ? missing : parts, needsTextKeys);
  if (!selection) return null;
  if (snapshot && selection.revision !== snapshot.revision) {
    // The record moved between the two reads: take everything from one snapshot.
    snapshot = undefined;
    selection = selectParts(database, parts, textKeys);
    if (!selection) return null;
  }
  const loading = snapshot ? missing : parts;
  snapshot ??= {
    database, identity, revision: selection.revision, importGap: selection.importGap,
    meta: null, parts: new Map(), textKeys: null, bytes: 0, view: null,
  };
  absorb(snapshot, loading, selection, needsTextKeys || (textKeys && !snapshot.textKeys));
  cache.snapshots.delete(database);
  cache.snapshots.set(database, snapshot);
  while (cache.snapshots.size > SNAPSHOT_CACHE_ENTRIES) cache.snapshots.delete(cache.snapshots.keys().next().value!);
  return snapshot;
}

/** Texts the snapshot's seats name. Texts are content-addressed: one read at
    a later revision is still the right text for its digest, and a digest it
    no longer holds means the snapshot itself is stale. */
function loadTexts(snapshot: StoreSnapshot): "loaded" | "stale" {
  const wanted = new Set<string>();
  for (const [part, rows] of snapshot.parts) {
    for (const row of rows) {
      if (part === "slots") seatTextDigests(row.value, wanted);
      else if (part === "history") seatTextDigests((row.value as { seat?: unknown } | null)?.seat, wanted);
    }
  }
  const cache = caches();
  const missing = [...wanted].filter((digest) => !cache.texts.has(digest));
  if (missing.length === 0) return "loaded";
  const selection = performanceSpans.sync("orchestrator.seat-read", () => readStateCollectionSelection(snapshot.database, ORCHESTRATOR_SEAT_COLLECTION, {
    keys: missing.map((digest) => `${TEXT_PREFIX}${digest}`),
  }));
  if (!selection) return "stale";
  for (const raw of selection.rows) {
    const row = decodeStored(raw);
    if (typeof row.value === "string") rememberText(row.key.slice(TEXT_PREFIX.length), row.value);
  }
  const absent = missing.some((digest) => !cache.texts.has(digest));
  return absent && selection.revision !== snapshot.revision ? "stale" : "loaded";
}

function resolverRecorder(resolve: ProjectResolver): { resolve: ProjectResolver; seen: Map<string, string> } {
  const seen = new Map<string, string>();
  return {
    seen,
    resolve: (project) => {
      let resolved = seen.get(project);
      if (resolved === undefined) {
        resolved = resolve(project);
        seen.set(project, resolved);
      }
      return resolved;
    },
  };
}

function viewCurrent(view: CanonicalView | null, parts: readonly SeatPart[], resolve: ProjectResolver): view is CanonicalView {
  return Boolean(view) && parts.every((part) => view!.parts.has(part))
    && view!.projects.every((project, index) => resolve(project) === view!.resolved[index]);
}

/** The legacy-shaped record a snapshot holds, with its texts put back, for
    the shared normalizer. */
function snapshotDocument(snapshot: StoreSnapshot): { document: Record<string, unknown>; sources: Record<Sequence, string[]>; slotRows: Map<string, { slot: Slot; project: string }> } | "gap" | "meta" {
  let meta: unknown = snapshot.meta?.value;
  if (snapshot.meta === null) {
    if (snapshot.importGap !== null && UNESTABLISHED_GAPS.has(snapshot.importGap)) return "gap";
    meta = { schemaVersion: ORCHESTRATOR_SEATS_SCHEMA_VERSION, nextSeatEpoch: 1, nextSeq: 0 };
  }
  if (!isMeta(meta)) return "meta";
  const text = (digest: string) => caches().texts.get(digest);
  const document: Record<string, unknown> = {
    schemaVersion: meta.schemaVersion,
    nextSeatEpoch: meta.nextSeatEpoch,
    seats: {}, pending: {}, rollbacks: {}, seatLineage: [], revocations: [], history: [],
  };
  const sources: Record<Sequence, string[]> = { revocations: [], seatLineage: [], history: [] };
  const slotRows = new Map<string, { slot: Slot; project: string }>();
  for (const row of snapshot.parts.get("slots") ?? []) {
    const slot = SLOTS.find((candidate) => row.key.startsWith(SLOT_PREFIX[candidate]))!;
    const project = row.key.slice(SLOT_PREFIX[slot].length);
    (document[slot] as Record<string, unknown>)[project] = hydratedSeat(row.value, text);
    slotRows.set(row.key, { slot, project });
  }
  const sequenceParts: [Sequence, SeatPart][] = [["revocations", "revocations"], ["seatLineage", "lineage"], ["history", "history"]];
  for (const [section, part] of sequenceParts) {
    for (const row of snapshot.parts.get(part) ?? []) {
      const value = section === "history" && row.value && typeof row.value === "object" && !Array.isArray(row.value)
        ? { ...(row.value as Record<string, unknown>), seat: hydratedSeat((row.value as { seat?: unknown }).seat, text) }
        : row.value;
      (document[section] as unknown[]).push(value);
      sources[section].push(row.key);
    }
  }
  return { document, sources, slotRows };
}

function buildView(snapshot: StoreSnapshot, resolve: ProjectResolver): CanonicalView {
  const recorder = resolverRecorder(resolve);
  const keys = new WeakMap<object, string>();
  const slotKeys = new Map<string, string[]>();
  const shaped = snapshotDocument(snapshot);
  let file: OrchestratorSeatFile | null = null;
  let unestablished: CanonicalView["unestablished"] = null;
  if (shaped === "gap" || shaped === "meta") {
    unestablished = shaped;
  } else {
    file = performanceSpans.sync("orchestrator.seat-parse", () => normalizeOrchestratorSeatDocument(shaped.document, recorder.resolve, (section, element, index) => {
      keys.set(element, shaped.sources[section][index]!);
    }), snapshot.parts.size);
    for (const [key, { slot, project }] of shaped.slotRows) {
      const label = `${SLOT_PREFIX[slot]}${recorder.resolve(project)}`;
      slotKeys.set(label, [...(slotKeys.get(label) ?? []), key]);
    }
    if (file === null) unestablished = "meta";
  }
  return {
    parts: new Set(snapshot.parts.keys()),
    projects: [...recorder.seen.keys()],
    resolved: [...recorder.seen.values()],
    file, keys, slotKeys, unestablished,
  };
}

/* --------------------------------------------------------- legacy reads */

interface LegacySnapshot {
  signature: string;
  /** undefined: absent file; null: unreadable. */
  parsed: unknown;
  bytes: number;
  view: CanonicalView | null;
}

function legacySignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "missing";
  } catch {
    return null;
  }
}

function legacySnapshot(filePath: string): LegacySnapshot {
  const signature = legacySignature(filePath);
  const cache = caches();
  const held = cache.legacy.get(filePath);
  if (signature !== null && held?.signature === signature) return held;
  let parsed: unknown = null;
  let bytes = 0;
  if (signature === "missing") parsed = undefined;
  else if (signature !== null) {
    try {
      const raw = performanceSpans.sync("orchestrator.seat-read", () => fs.readFileSync(filePath, "utf8"));
      bytes = raw.length * 2;
      parsed = performanceSpans.sync("orchestrator.seat-parse", () => JSON.parse(raw) as unknown, 0, Buffer.byteLength(raw));
    } catch {
      parsed = null;
    }
  }
  const snapshot: LegacySnapshot = { signature: signature ?? "unreadable", parsed, bytes, view: null };
  /* A read that failed is never kept: it may have been transient, and the
     next call reads again whether or not the file changed. */
  if (signature !== null && parsed !== null && legacySignature(filePath) === signature) {
    cache.legacy.delete(filePath);
    cache.legacy.set(filePath, snapshot);
    while (cache.legacy.size > SNAPSHOT_CACHE_ENTRIES) cache.legacy.delete(cache.legacy.keys().next().value!);
  }
  return snapshot;
}

function legacyView(snapshot: LegacySnapshot, resolve: ProjectResolver): CanonicalView {
  const recorder = resolverRecorder(resolve);
  const file = snapshot.parsed === undefined
    ? emptyOrchestratorSeatFile()
    : snapshot.parsed === null ? null
      : performanceSpans.sync("orchestrator.seat-parse", () => normalizeOrchestratorSeatDocument(snapshot.parsed, recorder.resolve), 1);
  return {
    parts: new Set(ALL_SEAT_PARTS),
    projects: [...recorder.seen.keys()],
    resolved: [...recorder.seen.values()],
    file, keys: new WeakMap(), slotKeys: new Map(), unestablished: file === null ? "meta" : null,
  };
}

/* ---------------------------------------------------------------- reads */

/** One answer from the seat store. `file` is shared and read-only: callers
    copy what they hand out. Only the parts asked for are complete. */
export interface SeatStoreRead {
  /** The committed state the answer was read from; null when unreadable. */
  signature: string | null;
  /** Null: the record could not be established. */
  file: OrchestratorSeatFile | null;
}

/** Whether the SQLite collection exists, i.e. the legacy file was imported. */
function storeDatabase(filePath: string): string {
  return legacyDatabasePath(filePath);
}

/**
 * Read the parts of the seat record a question needs. An unchanged record is
 * answered from the snapshot this process already holds; a changed one reads
 * only the selected prefixes. Before the import the legacy file is read, with
 * its stat as the cache key.
 */
export function readOrchestratorSeatStore(parts: readonly SeatPart[]): SeatStoreRead {
  const filePath = orchestratorSeatsLegacyPath();
  const database = storeDatabase(filePath);
  /* The alias map is read only when a stored project key has to be resolved:
     a record that names no project answers without it. */
  let resolver: ProjectResolver | null = null;
  const resolve: ProjectResolver = (project) => (resolver ??= projectAliasResolver())(project);
  try {
    let absent = false;
    for (let attempt = 0; attempt < 3 && !absent; attempt += 1) {
      const snapshot = storeSnapshot(database, parts, false);
      if (!snapshot) { absent = true; break; }
      if (!viewCurrent(snapshot.view, parts, resolve)) {
        if (loadTexts(snapshot) === "stale") {
          caches().snapshots.delete(database);
          continue;
        }
        snapshot.view = buildView(snapshot, resolve);
      }
      return { signature: `sqlite:${database}:${snapshot.identity}:${snapshot.revision}`, file: snapshot.view!.file };
    }
    // Three reads in a row moved past their own snapshot: answer unknown.
    if (!absent) return { signature: null, file: null };
  } catch (error) {
    console.error("[orchestrator seats] the seat store could not be read", error instanceof Error ? error.message : String(error));
    return { signature: null, file: null };
  }
  const legacy = legacySnapshot(filePath);
  if (!viewCurrent(legacy.view, parts, resolve)) legacy.view = legacyView(legacy, resolve);
  return { signature: legacy.parsed === null ? null : `legacy:${filePath}:${legacy.signature}`, file: legacy.view.file };
}

/** The committed state's identity without reading any row, for cache keys:
    the collection revision once imported, the legacy file's stat before. */
export function orchestratorSeatStoreSignature(): string | null {
  const filePath = orchestratorSeatsLegacyPath();
  const database = storeDatabase(filePath);
  try {
    const probed = probeDatabase(database, false);
    if (probed?.revision != null) return `sqlite:${database}:${probed.identity}:${probed.revision}`;
  } catch {
    return null;
  }
  const signature = legacySignature(filePath);
  return signature === null ? null : `legacy:${filePath}:${signature}`;
}

/** The record read through the strict normalizer: any stored row that would
    be dropped refuses the whole read. */
export function readOrchestratorSeatStoreStrict(): OrchestratorSeatFile {
  const filePath = orchestratorSeatsLegacyPath();
  const database = storeDatabase(filePath);
  const resolve = projectAliasResolver();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = storeSnapshot(database, ALL_SEAT_PARTS, false);
    if (!snapshot) break;
    if (loadTexts(snapshot) === "stale") {
      caches().snapshots.delete(database);
      continue;
    }
    const shaped = snapshotDocument(snapshot);
    if (shaped === "gap" || shaped === "meta") throw new Error("orchestrator seat evidence is malformed");
    return strictOrchestratorSeatDocument(shaped.document, resolve);
  }
  if (readStateCollectionRevision(database, ORCHESTRATOR_SEAT_COLLECTION) !== null) {
    throw new FileTransactionBusyError("orchestrator seat evidence changed during the read");
  }
  let rawText: string;
  try {
    rawText = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyOrchestratorSeatFile();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error("orchestrator seat evidence is malformed", { cause: error });
  }
  return strictOrchestratorSeatDocument(parsed, resolve);
}

/* --------------------------------------------------------------- writes */

/* One open collection per database file. A database replaced under the same
   path (a restore, a test sandbox made again) opens a new one. */
const seatCollections = new Map<string, { identity: string | null; collection: SqliteStateCollection<SeatRow> }>();

function openSeatCollection(database: string): SqliteStateCollection<SeatRow> {
  const identity = databaseIdentity(database);
  const held = seatCollections.get(database);
  if (held && held.identity === identity) return held.collection;
  held?.collection.close();
  const collection = new SqliteStateCollection<SeatRow>(database, {
    collection: ORCHESTRATOR_SEAT_COLLECTION,
    schemaVersion: 1,
    busyMessage: BUSY,
    key: (row) => row.key,
    decode: (value) => isSeatRow(value) ? value : null,
    clone: (row) => structuredClone(row),
    strictDecode: true,
    decodeError: (error) => new Error("invalid orchestrator seat row", { cause: error }),
  });
  seatCollections.set(database, { identity, collection });
  return collection;
}

function readImportMarker(database: string): StateImportRecord | null {
  return stateLockAttempt("state.marker.orchestrator-seats", () => readStateImport(database, ORCHESTRATOR_SEAT_COLLECTION), ORCHESTRATOR_SEAT_COLLECTION);
}

/** The collection for a write, importing the legacy file first when no
    release target exists or this is the activated release. */
function writableSeatCollection(filePath: string): SqliteStateCollection<SeatRow> {
  const database = storeDatabase(filePath);
  if (!readImportMarker(database)) {
    if (!legacyImportAllowed(filePath)) throw new FileTransactionBusyError("orchestrator seat state is waiting for release promotion");
    importLegacyOrchestratorSeats(filePath, { reconcile: lazyReconcileAllowed(filePath) });
  }
  return openSeatCollection(database);
}

/** Everything a writer needs, read fresh under the collection lease. */
interface WritableState {
  snapshot: StoreSnapshot;
  view: CanonicalView;
  meta: SeatMeta;
  stored: Map<string, StoredRow>;
}

function writableState(database: string, resolve: ProjectResolver): WritableState {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = storeSnapshot(database, ALL_SEAT_PARTS, true, true);
    if (!snapshot) throw new FileTransactionBusyError("orchestrator seat state is not imported");
    if (loadTexts(snapshot) === "stale") {
      caches().snapshots.delete(database);
      continue;
    }
    if (!viewCurrent(snapshot.view, ALL_SEAT_PARTS, resolve)) snapshot.view = buildView(snapshot, resolve);
    const view = snapshot.view!;
    /* An unestablished record is written over from empty, as a torn or
       future-schema file was: the store answers "unknown" until the next
       designation, and that designation is what establishes it again. */
    const meta = isMeta(snapshot.meta?.value) ? metaOf(snapshot.meta.value) : { schemaVersion: ORCHESTRATOR_SEATS_SCHEMA_VERSION, nextSeatEpoch: 1, nextSeq: 0 };
    const stored = new Map<string, StoredRow>();
    if (snapshot.meta) stored.set(snapshot.meta.key, snapshot.meta);
    for (const rows of snapshot.parts.values()) for (const row of rows) stored.set(row.key, row);
    return { snapshot, view, meta, stored };
  }
  throw new FileTransactionBusyError("orchestrator seat state changed during the write");
}

/** A private copy of the record a writer may change, carrying which stored
    row each ordered element came from. */
function workingCopy(state: WritableState): { file: OrchestratorSeatFile; keys: WeakMap<object, string> } {
  const keys = new WeakMap<object, string>();
  const source = state.view.file ?? emptyOrchestratorSeatFile();
  const file = cloneOrchestratorSeatFile(source, (original, copy) => {
    const key = state.view.keys.get(original);
    if (key) keys.set(copy, key);
  });
  return { file, keys };
}

/** The rows that differ between the stored record and `file`. */
function rowsPatch(state: WritableState, file: OrchestratorSeatFile, keys: WeakMap<object, string>): {
  records: SeatRow[];
  deleteKeys: string[];
  addedRevocations: OrchestratorRevocation[];
} {
  /* New rows number after every stored one, whatever the meta row says. */
  let firstSeq = state.meta.nextSeq;
  for (const key of state.stored.keys()) {
    const prefix = Object.values(SEQUENCE_PREFIX).find((candidate) => key.startsWith(candidate));
    const seq = prefix ? Number(key.slice(prefix.length)) : NaN;
    if (Number.isSafeInteger(seq) && seq >= firstSeq) firstSeq = seq + 1;
  }
  const { rows, added } = recordRows(file, keys, firstSeq);
  const records: SeatRow[] = [];
  for (const [key, value] of rows) {
    if (key.startsWith(TEXT_PREFIX)) {
      if (!state.snapshot.textKeys?.has(key.slice(TEXT_PREFIX.length))) records.push({ key, value });
      continue;
    }
    if (state.stored.get(key)?.json !== rowJson(key, value)) records.push({ key, value });
  }
  const deleteKeys = [...state.stored.keys()].filter((key) => !rows.has(key));
  for (const digest of state.snapshot.textKeys ?? []) {
    const key = `${TEXT_PREFIX}${digest}`;
    if (!rows.has(key)) deleteKeys.push(key);
  }
  return { records, deleteKeys, addedRevocations: added.get("revocations") as OrchestratorRevocation[] };
}

export interface SeatStoreCommit {
  /** The signature of the committed revision. */
  signature: string;
  /** The signature of the revision the write read. */
  previousSignature: string;
  previous: OrchestratorSeatFile | null;
  file: OrchestratorSeatFile;
  /** Revocations this write appended, in order. */
  addedRevocations: OrchestratorRevocation[];
}

export type SeatStoreMutation<R> = { write: boolean; result: R };

let writeHookForTests: ((phase: "in-lease") => void) | null = null;
/** Test seam: runs inside the collection lease, before the record is read. */
export function setOrchestratorSeatWriteHookForTests(hook: ((phase: "in-lease") => void) | null): void {
  writeHookForTests = hook;
}

/**
 * One serialized read-modify-write of the seat record. The operation receives
 * a private copy read fresh under the lease and says whether to write it;
 * only the rows that changed are written, in one transaction.
 */
export function mutateOrchestratorSeatStore<R>(
  operation: (file: OrchestratorSeatFile) => SeatStoreMutation<R>,
  afterCommit?: (commit: SeatStoreCommit) => void,
): R {
  const filePath = orchestratorSeatsLegacyPath();
  const database = storeDatabase(filePath);
  const collection = writableSeatCollection(filePath);
  const resolve = projectAliasResolver();
  let outcome: SeatStoreMutation<R> | undefined;
  let pending: Omit<SeatStoreCommit, "signature" | "previousSignature"> | null = null;
  let readRevision: number | null = null;
  let committedRevision: number | null = null;
  let identity: string | null = null;
  collection.patchSync(() => {
    writeHookForTests?.("in-lease");
    const state = writableState(database, resolve);
    identity = state.snapshot.identity;
    readRevision = state.snapshot.revision;
    const working = workingCopy(state);
    outcome = operation(working.file);
    if (!outcome.write) return { records: [] };
    const patch = rowsPatch(state, working.file, working.keys);
    pending = { previous: state.view.file, file: working.file, addedRevocations: patch.addedRevocations };
    return { records: patch.records, deleteKeys: patch.deleteKeys };
  }, {
    afterPersist: (db) => {
      committedRevision = db.query<{ revision: number }, [string]>("SELECT revision FROM state_collections WHERE collection = ?")
        .get(ORCHESTRATOR_SEAT_COLLECTION)?.revision ?? null;
    },
  });
  const done = pending as Omit<SeatStoreCommit, "signature" | "previousSignature"> | null;
  if (done && committedRevision !== null && identity !== null) {
    afterCommit?.({
      ...done,
      signature: `sqlite:${database}:${identity}:${committedRevision}`,
      previousSignature: `sqlite:${database}:${identity}:${readRevision}`,
    });
  }
  return outcome!.result;
}

/* ------------------------------------------------- import and rollback */

interface LegacySeatBody {
  /** The file without the mirror marker, as parsed. */
  raw: Record<string, unknown>;
  /** The record normalized with the project keys as written. */
  file: OrchestratorSeatFile;
  /** The SQLite revision of the rollback mirror this file descends from. */
  mirrorOf: number | null;
  /** What the import dropped that the strict reader would have refused. */
  dropped: string | null;
}

const asWritten: ProjectResolver = (project) => project;

function withoutMirrorMarker(raw: Record<string, unknown>): { raw: Record<string, unknown>; mirrorOf: number | null } {
  if (!Array.isArray(raw.seatLineage)) return { raw, mirrorOf: null };
  let mirrorOf: number | null = null;
  const seatLineage = raw.seatLineage.filter((entry) => {
    const candidate = entry as Partial<SeatLineageEntry> | null;
    if (candidate?.project !== MIRROR_MARKER_PROJECT) return true;
    const revision = typeof candidate.conversationId === "string" && candidate.conversationId.startsWith(MIRROR_MARKER_CONVERSATION)
      ? Number(candidate.conversationId.slice(MIRROR_MARKER_CONVERSATION.length)) : NaN;
    if (Number.isSafeInteger(revision) && revision >= 0) mirrorOf = revision;
    return false;
  });
  return { raw: { ...raw, seatLineage }, mirrorOf };
}

function droppedRows(raw: Record<string, unknown>, file: OrchestratorSeatFile): string {
  const count = (value: unknown) => Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0;
  const parts = ([
    ["seats", count(raw.seats), Object.keys(file.seats).length],
    ["pending", count(raw.pending), Object.keys(file.pending).length],
    ["rollbacks", count(raw.rollbacks), Object.keys(file.rollbacks).length],
    ["revocations", count(raw.revocations), file.revocations.length],
    ["history", count(raw.history), file.history.length],
  ] as const).filter(([, before, after]) => before !== after).map(([name, before, after]) => `${name} ${before}→${after}`);
  return parts.length
    ? `rows the strict seat reader refuses were dropped (${parts.join(", ")})`
    : "the strict seat reader refuses this file; its rows were normalized";
}

function parseLegacySeats(value: unknown): LegacySeatBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("orchestrator seat state is not an object");
  const parsed = value as Record<string, unknown>;
  if (parsed.schemaVersion !== ORCHESTRATOR_SEATS_SCHEMA_VERSION) {
    throw new Error(`unsupported orchestrator seat schema: ${String(parsed.schemaVersion)}`);
  }
  const { raw, mirrorOf } = withoutMirrorMarker(parsed);
  const file = normalizeOrchestratorSeatDocument(raw, asWritten);
  if (!file) throw new Error("orchestrator seat state could not be normalized");
  let dropped: string | null = null;
  try { strictOrchestratorSeatDocument(raw, asWritten); }
  catch { dropped = droppedRows(raw, file); }
  return { raw, file, mirrorOf, dropped };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** What an ordered element is, whichever side holds it. */
const SEQUENCE_IDENTITY: Record<Sequence, (element: object) => string> = {
  revocations: (element) => {
    const entry = element as OrchestratorRevocation;
    return JSON.stringify([entry.project, entry.conversationId, entry.seatEpoch, entry.revokedAt]);
  },
  seatLineage: (element) => {
    const entry = element as SeatLineageEntry;
    return JSON.stringify([entry.project, entry.conversationId, entry.seatEpoch]);
  },
  history: (element) => {
    const entry = element as OrchestratorSeatTerminalization;
    return JSON.stringify([entry.seat.project, entry.seat.seatEpoch, entry.seat.intent.clientRequestId, entry.reason, entry.terminalizedAt]);
  },
};

const SEQUENCE_CLONE: Record<Sequence, (element: object) => object> = {
  revocations: (element) => cloneOrchestratorRevocation(element as OrchestratorRevocation),
  seatLineage: (element) => ({ ...(element as SeatLineageEntry) }),
  history: (element) => cloneOrchestratorSeatTerminalization(element as OrchestratorSeatTerminalization),
};

/**
 * Fold a legacy file that changed after the import (a rollback release wrote
 * it, or an older writer raced a fence) back into the collection.
 *
 * Rows are matched by what they are: a slot by its canonical project, a
 * revocation, lineage entry or history entry by its identity. A row SQLite has
 * not rewritten since the file's baseline is the file's to change, and its
 * absence from a file that carries the recorded mirror's marker removes it. A
 * row SQLite rewrote since then stays, unless the file holds a strictly newer
 * epoch for that slot; either way it is listed as a conflict. A file without
 * the marker removes nothing: the rows it lacks are spared.
 */
function mergeLegacySeats(filePath: string, body: LegacySeatBody, baseline: StateImportRecord, options: { fenceOwner: boolean; consumedSha256?: string }): LegacyReconcileSummary {
  const database = storeDatabase(filePath);
  const collection = openSeatCollection(database);
  const since = legacyBaselineRevision(baseline);
  const descends = baseline.mirrorRevision !== null && body.mirrorOf === baseline.mirrorRevision;
  const summary: LegacyReconcileSummary = { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
  const resolve = projectAliasResolver();
  collection.patchSync(() => {
    const state = writableState(database, resolve);
    const incoming = normalizeOrchestratorSeatDocument(body.raw, resolve) ?? emptyOrchestratorSeatFile();
    const working = workingCopy(state);
    const next = working.file;
    const held = state.view.file ?? emptyOrchestratorSeatFile();
    const revisionOf = (keys: readonly string[] | undefined) => Math.max(0, ...(keys ?? []).map((key) => state.stored.get(key)?.rowRevision ?? 0));

    for (const slot of SLOTS) {
      for (const project of new Set([...Object.keys(incoming[slot]), ...Object.keys(held[slot])])) {
        const label = `${SLOT_PREFIX[slot]}${project}`;
        const fileSeat = incoming[slot][project];
        const heldSeat = held[slot][project];
        const changedSince = revisionOf(state.view.slotKeys.get(label)) > since;
        if (fileSeat && heldSeat) {
          if (sameJson(fileSeat, heldSeat)) continue;
          if (changedSince) {
            summary.conflicts.push(label);
            if (fileSeat.seatEpoch <= heldSeat.seatEpoch) { summary.kept += 1; continue; }
          }
          next[slot][project] = cloneOrchestratorSeat(fileSeat);
          summary.replaced += 1;
          summary.keys.push(label);
        } else if (fileSeat) {
          next[slot][project] = cloneOrchestratorSeat(fileSeat);
          summary.added += 1;
          summary.keys.push(label);
        } else if (heldSeat) {
          if (!descends) { summary.spared.push(label); continue; }
          if (changedSince) { summary.conflicts.push(label); summary.kept += 1; continue; }
          delete next[slot][project];
          summary.removed += 1;
          summary.keys.push(label);
        }
      }
    }

    for (const section of SEQUENCES) {
      const identity = SEQUENCE_IDENTITY[section];
      const clone = SEQUENCE_CLONE[section];
      const elements = (section === "seatLineage" ? next.seatLineage ?? [] : next[section]) as object[];
      const byIdentity = new Map<string, number>();
      elements.forEach((element, index) => { if (!byIdentity.has(identity(element))) byIdentity.set(identity(element), index); });
      const fileIdentities = new Set<string>();
      const appended: object[] = [];
      for (const element of (section === "seatLineage" ? incoming.seatLineage ?? [] : incoming[section]) as object[]) {
        const id = identity(element);
        if (fileIdentities.has(id)) continue;
        fileIdentities.add(id);
        const index = byIdentity.get(id);
        const label = `${SEQUENCE_PREFIX[section]}${id}`;
        if (index === undefined) {
          appended.push(clone(element));
          summary.added += 1;
          summary.keys.push(label);
          continue;
        }
        const current = elements[index]!;
        if (sameJson(current, element)) continue;
        const key = working.keys.get(current);
        if (key && (state.stored.get(key)?.rowRevision ?? 0) > since) {
          summary.conflicts.push(label);
          summary.kept += 1;
          continue;
        }
        const replacement = clone(element);
        if (key) working.keys.set(replacement, key);
        elements[index] = replacement;
        summary.replaced += 1;
        summary.keys.push(label);
      }
      const kept = elements.filter((element) => {
        const id = identity(element);
        if (fileIdentities.has(id)) return true;
        const label = `${SEQUENCE_PREFIX[section]}${id}`;
        const key = working.keys.get(element);
        if (!key) return true;
        if (!descends) { summary.spared.push(label); return true; }
        if ((state.stored.get(key)?.rowRevision ?? 0) > since) { summary.conflicts.push(label); summary.kept += 1; return true; }
        summary.removed += 1;
        summary.keys.push(label);
        return false;
      });
      const merged = [...kept, ...appended];
      if (section === "seatLineage") next.seatLineage = merged as SeatLineageEntry[];
      else if (section === "revocations") next.revocations = merged as OrchestratorRevocation[];
      else next.history = merged as OrchestratorSeatTerminalization[];
    }
    if (next.history.length > ORCHESTRATOR_SEAT_HISTORY_CAP) next.history.splice(0, next.history.length - ORCHESTRATOR_SEAT_HISTORY_CAP);
    next.nextSeatEpoch = Math.max(next.nextSeatEpoch, incoming.nextSeatEpoch);
    const patch = rowsPatch(state, next, working.keys);
    return { records: patch.records, deleteKeys: patch.deleteKeys };
  }, {
    fenceOwner: options.fenceOwner,
    ...(options.consumedSha256 ? { afterPersist: (db) => {
      const result = db.query("UPDATE state_imports SET reconciled_sha256 = ? WHERE collection = ?").run(options.consumedSha256!, ORCHESTRATOR_SEAT_COLLECTION);
      if (result.changes !== 1) throw new Error(`missing import evidence for ${ORCHESTRATOR_SEAT_COLLECTION} reconciliation`);
    } } : {}),
  });
  return summary;
}

/** The legacy file body for a rollback release, carrying the mirror marker. */
function mirrorDocument(database: string, rows: readonly SeatRow[], revision: number): unknown {
  const snapshot: StoreSnapshot = {
    database: "", identity: "", revision, importGap: null, meta: null, parts: new Map(ALL_SEAT_PARTS.map((part) => [part, []])),
    textKeys: null, bytes: 0, view: null,
  };
  const texts = new Map<string, string>();
  for (const row of rows) {
    const part = partOf(row.key);
    const stored: StoredRow = { key: row.key, json: "", value: row.value, rowRevision: revision };
    if (part === "meta") snapshot.meta = stored;
    else if (part === "text") { if (typeof row.value === "string") texts.set(row.key.slice(TEXT_PREFIX.length), row.value); }
    else if (part !== null) snapshot.parts.get(part)!.push(stored);
  }
  for (const [digest, text] of texts) rememberText(digest, text);
  const gap = readStateImport(database, ORCHESTRATOR_SEAT_COLLECTION)?.gap ?? null;
  snapshot.importGap = gap;
  const shaped = snapshotDocument(snapshot);
  const file = shaped === "gap" || shaped === "meta" ? null
    : normalizeOrchestratorSeatDocument(shaped.document, projectAliasResolver());
  /* An unestablished record mirrors as one the rollback release also reads as
     unknown, never as a record that holds no seats. */
  if (!file) return { schemaVersion: 0, unestablished: "the orchestrator seat record could not be established; see the kept legacy copies" };
  return {
    schemaVersion: file.schemaVersion,
    nextSeatEpoch: file.nextSeatEpoch,
    seats: file.seats,
    seatLineage: [...file.seatLineage ?? [], { project: MIRROR_MARKER_PROJECT, conversationId: `${MIRROR_MARKER_CONVERSATION}${revision}`, seatEpoch: 1 }],
    pending: file.pending,
    revocations: file.revocations,
    history: file.history,
    rollbacks: file.rollbacks,
  };
}

/** The seat store's legacy import spec, for the import driver and its tests. */
export function orchestratorSeatLegacyCollection(filePath = orchestratorSeatsLegacyPath()): LegacyCollectionSpec<LegacySeatBody> {
  return {
    collection: ORCHESTRATOR_SEAT_COLLECTION,
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    legacyPath: filePath,
    parse: parseLegacySeats,
    toRows: (body) => importRows(body.file),
    repairs: (body) => body.dropped,
    reconcile: (body, baseline, options) => mergeLegacySeats(filePath, body, baseline, options),
    mirrorBody: () => {
      const database = storeDatabase(filePath);
      const collection = openSeatCollection(database);
      let mirror: { body: unknown; revision: number } | null = null;
      collection.checkpointMirror((rows, revision) => {
        mirror = { body: mirrorDocument(database, rows, revision), revision };
      });
      return mirror!;
    },
  };
}

/** Import `orchestrator-seats.json` now. The Viewer's activation calls this
    with `reconcile: true`; tests drive the crash seams through `hooks`. */
export function importLegacyOrchestratorSeats(
  filePath = orchestratorSeatsLegacyPath(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return importLegacyCollection(orchestratorSeatLegacyCollection(filePath), options);
}

/** Write `orchestrator-seats.json` from SQLite for a rollback release that
    predates the move. */
export function checkpointOrchestratorSeatRollbackMirrorForDemotion(filePath = orchestratorSeatsLegacyPath()): void {
  writeLegacyRollbackMirror(orchestratorSeatLegacyCollection(filePath));
}

/** Test seam: forget every cached read and open collection, the way a
    restarted process would. */
export function resetOrchestratorSeatStoreForTests(): void {
  for (const { collection } of seatCollections.values()) collection.close();
  seatCollections.clear();
  const cache = caches();
  cache.snapshots.clear();
  cache.legacy.clear();
  cache.texts.clear();
  cache.textBytes = 0;
  cache.digests.clear();
  revisionProbes.clear();
}

/** Test seam: the open write collection, for fixtures that seed or damage
    the stored record directly. */
export function orchestratorSeatCollectionForTests(): SqliteStateCollection<SeatRow> {
  return writableSeatCollection(orchestratorSeatsLegacyPath());
}

/** Test seam: the rows a record would be stored as. */
export function orchestratorSeatRowsForTests(file: OrchestratorSeatFile): SeatRow[] {
  return importRows(file).map((row) => row.value as SeatRow);
}
