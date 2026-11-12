import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { LegacyDocumentStore } from "@/lib/state/legacyDocumentStore";
import {
  lazyReconcileAllowed,
  legacyDatabasePath,
  legacyImportAllowed,
  type LegacyImportHooks,
  type LegacyImportOutcome,
} from "@/lib/state/legacyImport";
import { stateLockAttempt } from "@/lib/state/lockWait";
import { readStateCollectionRevision, readStateImport, SqliteStateCollection } from "@/lib/state/sqliteStateStore";

import type { ReportLogAsk } from "./types";

/*
 * What the "Asks you" classifier has decided (docs/research/attention-classifier.md
 * §7), in one store the Viewer alone writes (the classifier, and the memory
 * decisions that share its monthly cap):
 *
 *  - `asks`: every message it judged an ask, newest last. The newest per
 *    conversation is that conversation's open ask; each one is a line in its
 *    project's report log.
 *  - `seen`: the messages already sent (or skipped), so none is sent twice.
 *  - `scores`: each classified text's score by its hash, so the same words,
 *    repeated by the same agent or written by another, are judged again
 *    without a second call.
 *  - `spend`: this month's calls and their billed cost, against the cap.
 *
 * A send is recorded before its call, with its largest possible cost, and
 * settled after it (sweep.ts), so a write that fails after a call leaves the
 * cost counted and the message seen. A store nothing was ever written to is a
 * first run. A store that is there but cannot be read holds a month's spend
 * nobody can know: the classifier's read and every write refuse it, so the
 * sweep sends nothing and no write puts an empty store over the real one. The
 * board's reads (the overlay, the report log, the spend line) answer empty.
 */

export const OPERATOR_ASKS_SCHEMA_VERSION = 1 as const;
const ASK_CAPACITY = 1_000;
const ASK_RETENTION_MS = 30 * 24 * 3_600_000;
const SEEN_CAPACITY = 5_000;

export interface OperatorAskRecord {
  id: string;
  /** The durable conversation id, or the transcript path the registry does not know. */
  subject: string;
  conversationId: string | null;
  path: string;
  project: string;
  role: string | null;
  title: string | null;
  messageId: string;
  /** Epoch ms of the message that asks. */
  messageAt: number;
  gist: string;
  score: number;
  recordedAt: string;
}

export interface AsksSpend {
  /** UTC `YYYY-MM`. */
  month: string;
  usd: number;
  calls: number;
  /** Messages left unclassified because the cap was reached. */
  capped: number;
}

export interface OperatorAsksFileV1 {
  schemaVersion: typeof OPERATOR_ASKS_SCHEMA_VERSION;
  revision: number;
  spend: AsksSpend;
  seen: string[];
  /** Text hash → score, oldest first. Absent from files written before it. */
  scores: Record<string, number>;
  asks: OperatorAskRecord[];
}

export function operatorAsksFile(): string {
  return statePath("operator-asks.json");
}

export function spendMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function emptyFile(now: Date): OperatorAsksFileV1 {
  return { schemaVersion: OPERATOR_ASKS_SCHEMA_VERSION, revision: 0, spend: { month: spendMonth(now), usd: 0, calls: 0, capped: 0 }, seen: [], scores: {}, asks: [] };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableString = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function parseAsk(value: unknown): OperatorAskRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.subject !== "string" || typeof record.path !== "string") return null;
  if (typeof record.project !== "string" || typeof record.messageId !== "string" || typeof record.gist !== "string") return null;
  if (!finite(record.messageAt) || !finite(record.score) || typeof record.recordedAt !== "string") return null;
  return {
    id: record.id,
    subject: record.subject,
    conversationId: nullableString(record.conversationId),
    path: record.path,
    project: record.project,
    role: nullableString(record.role),
    title: nullableString(record.title),
    messageId: record.messageId,
    messageAt: record.messageAt,
    gist: record.gist,
    score: record.score,
    recordedAt: record.recordedAt,
  };
}

function parseScores(value: unknown): Record<string, number> {
  const scores: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return scores;
  for (const [key, score] of Object.entries(value)) {
    if (finite(score) && score >= 0 && score <= 1) scores[key] = score;
  }
  return scores;
}

/** The store is there, but what it holds cannot be known. */
export class OperatorAsksUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorAsksUnreadable";
  }
}

/** A legacy body as the classifier reads it, or `OperatorAsksUnreadable`. */
function parseOperatorAsks(raw: unknown, now: Date): OperatorAsksFileV1 {
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<OperatorAsksFileV1> : {};
  if (parsed.schemaVersion !== OPERATOR_ASKS_SCHEMA_VERSION) throw new OperatorAsksUnreadable(`schema ${String(parsed.schemaVersion)}`);
  return {
    schemaVersion: OPERATOR_ASKS_SCHEMA_VERSION,
    revision: Number.isInteger(parsed.revision) ? parsed.revision! : 0,
    spend: parseSpend(parsed.spend, now),
    seen: Array.isArray(parsed.seen) ? parsed.seen.filter((key): key is string => typeof key === "string") : [],
    scores: parseScores(parsed.scores),
    asks: Array.isArray(parsed.asks) ? parsed.asks.map(parseAsk).filter((ask): ask is OperatorAskRecord => ask !== null) : [],
  };
}

function parseSpend(value: unknown, now: Date): AsksSpend {
  const spend = value && typeof value === "object" ? value as Partial<AsksSpend> : {};
  return {
    month: typeof spend.month === "string" ? spend.month : spendMonth(now),
    usd: finite(spend.usd) && spend.usd >= 0 ? spend.usd : 0,
    calls: finite(spend.calls) ? spend.calls : 0,
    capped: finite(spend.capped) ? spend.capped : 0,
  };
}

/** The legacy file as the classifier read it before the store moved. */
function loadLegacyOperatorAsks(file: string, now: Date): OperatorAsksFileV1 {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile(now);
    throw new OperatorAsksUnreadable(`cannot read: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OperatorAsksUnreadable("cannot parse");
  }
  return parseOperatorAsks(raw, now);
}

/* ------------------------------------------------------- state.sqlite rows */

/*
 * The store lives in the `operator_asks` collection of `state.sqlite`, moved
 * out of `operator-asks.json`, which every send and every spend settlement
 * rewrote whole (1.5 MB on a busy installation, two writes for each memory
 * decision). One row per key:
 *
 *   meta            { schemaVersion, revision, spend }
 *   ask:<id>        one ask, oldest first
 *   seen:<key>      one message already sent or skipped, oldest first
 *   score:<hash>    one classified text's score, oldest first
 *
 * Rows keep the order they were written in, so the capacity trims drop the
 * oldest as the file's arrays did; a text scored again moves to the end. A
 * write stores the rows that changed: a spend settlement rewrites `meta`
 * alone. `revision` continues from the file's and moves on every write.
 *
 * A row that does not decode makes the whole store unreadable, as a torn file
 * did: the classifier's read and every write refuse it, the board reads
 * empty. A legacy file that cannot be read is never imported: it stays the
 * store, refused the same way, until it reads again.
 */

export const OPERATOR_ASKS_COLLECTION = "operator_asks";
const META_KEY = "meta";
const ASK_PREFIX = "ask:";
const SEEN_PREFIX = "seen:";
const SCORE_PREFIX = "score:";

interface OperatorAskRow {
  key: string;
  value: unknown;
}

function isRow(value: unknown): value is OperatorAskRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as OperatorAskRow).key === "string" && (value as OperatorAskRow).key.length > 0
    && Object.hasOwn(value as object, "value");
}

function toRows(file: OperatorAsksFileV1): OperatorAskRow[] {
  const rows: OperatorAskRow[] = [{ key: META_KEY, value: { schemaVersion: file.schemaVersion, revision: file.revision, spend: file.spend } }];
  const asks = new Set<string>();
  for (const ask of file.asks) {
    if (asks.has(ask.id)) continue;
    asks.add(ask.id);
    rows.push({ key: `${ASK_PREFIX}${ask.id}`, value: ask });
  }
  for (const key of new Set(file.seen)) rows.push({ key: `${SEEN_PREFIX}${key}`, value: 1 });
  for (const [key, score] of Object.entries(file.scores)) rows.push({ key: `${SCORE_PREFIX}${key}`, value: score });
  return rows;
}

/** The document the rows hold, or `OperatorAsksUnreadable` for a meta row of
    another schema. No meta row is a first run. */
function fromRows(rows: readonly OperatorAskRow[], now: Date): OperatorAsksFileV1 {
  let meta: OperatorAskRow | null = null;
  const asks: OperatorAskRecord[] = [];
  const seen: string[] = [];
  const scores: Record<string, number> = {};
  for (const row of rows) {
    if (row.key === META_KEY) meta = row;
    else if (row.key.startsWith(ASK_PREFIX)) {
      const ask = parseAsk(row.value);
      if (ask) asks.push(ask);
    } else if (row.key.startsWith(SEEN_PREFIX)) seen.push(row.key.slice(SEEN_PREFIX.length));
    else if (row.key.startsWith(SCORE_PREFIX)) {
      if (finite(row.value) && row.value >= 0 && row.value <= 1) scores[row.key.slice(SCORE_PREFIX.length)] = row.value;
    }
  }
  const document = meta ? parseOperatorAsks({ ...(meta.value as object), seen: [], scores: {}, asks: [] }, now) : emptyFile(now);
  return { ...document, seen, scores, asks };
}

/** A private copy a writer may change. Asks are copied; scores and seen keys
    are values. */
function workingCopy(file: OperatorAsksFileV1): OperatorAsksFileV1 {
  return {
    schemaVersion: file.schemaVersion,
    revision: file.revision,
    spend: { ...file.spend },
    seen: [...file.seen],
    scores: { ...file.scores },
    asks: file.asks.map((ask) => ({ ...ask })),
  };
}

const ASK_FIELDS = ["id", "subject", "conversationId", "path", "project", "role", "title", "messageId", "messageAt", "gist", "score", "recordedAt"] as const satisfies readonly (keyof OperatorAskRecord)[];

function sameAsk(left: OperatorAskRecord, right: OperatorAskRecord): boolean {
  return ASK_FIELDS.every((field) => left[field] === right[field]);
}

/** The rows that make `held` hold `next`. A score that changed moves to the
    end, as re-inserting it in the file's object did. */
function rowsPatch(held: OperatorAsksFileV1, next: OperatorAsksFileV1): { records: OperatorAskRow[]; deleteKeys: string[]; appendKeys: string[] } {
  const records: OperatorAskRow[] = [];
  const deleteKeys: string[] = [];
  const appendKeys: string[] = [];
  const meta = { schemaVersion: next.schemaVersion, revision: next.revision, spend: next.spend };
  if (JSON.stringify(meta) !== JSON.stringify({ schemaVersion: held.schemaVersion, revision: held.revision, spend: held.spend })) {
    records.push({ key: META_KEY, value: meta });
  }
  const heldAsks = new Map(held.asks.map((ask) => [ask.id, ask] as const));
  const nextAsks = new Set<string>();
  for (const ask of next.asks) {
    if (nextAsks.has(ask.id)) continue;
    nextAsks.add(ask.id);
    const prior = heldAsks.get(ask.id);
    if (!prior || !sameAsk(prior, ask)) records.push({ key: `${ASK_PREFIX}${ask.id}`, value: ask });
  }
  for (const id of heldAsks.keys()) if (!nextAsks.has(id)) deleteKeys.push(`${ASK_PREFIX}${id}`);
  const heldSeen = new Set(held.seen);
  const nextSeen = new Set(next.seen);
  for (const key of nextSeen) if (!heldSeen.has(key)) records.push({ key: `${SEEN_PREFIX}${key}`, value: 1 });
  for (const key of heldSeen) if (!nextSeen.has(key)) deleteKeys.push(`${SEEN_PREFIX}${key}`);
  for (const [key, score] of Object.entries(next.scores)) {
    const prior = held.scores[key];
    if (prior === score) continue;
    records.push({ key: `${SCORE_PREFIX}${key}`, value: score });
    if (prior !== undefined) appendKeys.push(`${SCORE_PREFIX}${key}`);
  }
  for (const key of Object.keys(held.scores)) if (!Object.hasOwn(next.scores, key)) deleteKeys.push(`${SCORE_PREFIX}${key}`);
  return { records, deleteKeys, appendKeys };
}

/* The import, the rollback mirror and the roll-forward merge are the shared
   legacy helper's; reads and writes go through this module's own collection. */
const legacyStore = new LegacyDocumentStore<OperatorAsksFileV1>({
  collection: OPERATOR_ASKS_COLLECTION,
  migrationId: "operator-asks-json-v1",
  busyMessage: "operator asks state is busy",
  /* A file that cannot be read holds a month's spend nobody can know: it is
     never imported as empty, and stays the store until it reads again. */
  validateLegacyPath: (filePath) => {
    if (readStateImport(legacyDatabasePath(filePath), OPERATOR_ASKS_COLLECTION)) return;
    if (!fs.lstatSync(filePath, { throwIfNoEntry: false })?.isFile()) return;
    loadLegacyOperatorAsks(filePath, new Date());
  },
  parse: (raw) => parseOperatorAsks(raw, new Date()),
  toRows,
  fromRows: (rows) => fromRows(rows, new Date()),
  toFile: (document) => document,
  readLegacy: (filePath) => loadLegacyOperatorAsks(filePath, new Date()),
  error: (message, cause) => new OperatorAsksUnreadable(cause instanceof Error ? `${message}: ${cause.message}` : message),
});

interface AskStoreRuntime {
  collections: Map<string, { identity: string | null; collection: SqliteStateCollection<OperatorAskRow> }>;
  documents: Map<string, { ordered: readonly OperatorAskRow[]; document: OperatorAsksFileV1 }>;
  indexes: WeakMap<OperatorAsksFileV1, Map<string, OperatorAskRecord>>;
}
const runtimeHost = globalThis as typeof globalThis & { __delegatusOperatorAsksStoreV1__?: AskStoreRuntime };
const runtime = runtimeHost.__delegatusOperatorAsksStoreV1__ ??= { collections: new Map(), documents: new Map(), indexes: new WeakMap() };

function databaseIdentity(database: string): string | null {
  const stat = fs.statSync(database, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

function readMarker(database: string) {
  return stateLockAttempt("state.marker.operator-asks", () => readStateImport(database, OPERATOR_ASKS_COLLECTION), OPERATOR_ASKS_COLLECTION);
}

/** The collection once the legacy file was imported, else null. */
function openCollection(database: string): SqliteStateCollection<OperatorAskRow> | null {
  const identity = databaseIdentity(database);
  const held = runtime.collections.get(database);
  if (held && held.identity === identity) return held.collection;
  held?.collection.close();
  runtime.collections.delete(database);
  runtime.documents.delete(database);
  if (identity === null || !readMarker(database)) return null;
  const collection = new SqliteStateCollection<OperatorAskRow>(database, {
    collection: OPERATOR_ASKS_COLLECTION,
    schemaVersion: 1,
    busyMessage: "operator asks state is busy",
    key: (row) => row.key,
    decode: (value) => isRow(value) ? value : null,
    clone: (row) => structuredClone(row),
    strictDecode: true,
    decodeError: () => new OperatorAsksUnreadable("a stored row cannot be read"),
  });
  runtime.collections.set(database, { identity, collection });
  return collection;
}

/** The committed document, read once per committed revision and shared. */
function committedDocument(database: string, collection: SqliteStateCollection<OperatorAskRow>, now: Date): OperatorAsksFileV1 {
  const ordered = collection.loadReadonly();
  const held = runtime.documents.get(database);
  if (held?.ordered === ordered) return held.document;
  const document = fromRows(ordered, now);
  runtime.documents.set(database, { ordered, document });
  return document;
}

/** The collection for a write, importing the legacy file first when this
    process may (no release target, or the activated release). */
function writableCollection(file: string): SqliteStateCollection<OperatorAskRow> {
  const database = legacyDatabasePath(file);
  const held = openCollection(database);
  if (held) return held;
  if (!legacyImportAllowed(file, database)) throw new FileTransactionBusyError("operator asks state is waiting for release promotion");
  legacyStore.importLegacy(file, { reconcile: lazyReconcileAllowed(file, database) });
  const collection = openCollection(database);
  if (!collection) throw new FileTransactionBusyError("operator asks state is not imported");
  return collection;
}

/** The committed document, shared, or the legacy file before the import. */
function sharedOperatorAsks(file: string, now: Date): OperatorAsksFileV1 {
  const database = legacyDatabasePath(file);
  const collection = openCollection(database);
  if (!collection) return loadLegacyOperatorAsks(file, now);
  try {
    return committedDocument(database, collection, now);
  } catch (error) {
    if (error instanceof OperatorAsksUnreadable || error instanceof FileTransactionBusyError) throw error;
    throw new OperatorAsksUnreadable(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The store as the classifier needs it: empty only when nothing was ever
 * recorded, and `OperatorAsksUnreadable` when it is there and cannot be read.
 * The caller gets its own copy.
 */
export function loadOperatorAsks(file = operatorAsksFile(), now = new Date()): OperatorAsksFileV1 {
  return workingCopy(sharedOperatorAsks(file, now));
}

/** The board's read: anything unreadable reads as empty. The answer is shared
    by every reader of the same revision: never change it. */
export function readOperatorAsks(file = operatorAsksFile(), now = new Date()): OperatorAsksFileV1 {
  try {
    return sharedOperatorAsks(file, now);
  } catch {
    return emptyFile(now);
  }
}

/** This month's spend: a new month starts from nothing. */
export function currentSpend(file: OperatorAsksFileV1, now: Date): AsksSpend {
  const month = spendMonth(now);
  return file.spend.month === month ? file.spend : { month, usd: 0, calls: 0, capped: 0 };
}

/** One read-modify-write under the collection lease: only the rows that
    changed are written. A store that cannot be read is left as it is: the
    write throws. */
export function mutateOperatorAsks(
  mutation: (current: OperatorAsksFileV1) => void,
  now = new Date(),
  file = operatorAsksFile(),
): OperatorAsksFileV1 {
  const database = legacyDatabasePath(file);
  const collection = writableCollection(file);
  let next: OperatorAsksFileV1 | null = null;
  /* Read before the lease, so under it the read takes only what changed since. */
  committedDocument(database, collection, now);
  collection.patchSync(() => {
    const held = committedDocument(database, collection, now);
    const current = workingCopy(held);
    current.spend = currentSpend(current, now);
    mutation(current);
    const floor = now.getTime() - ASK_RETENTION_MS;
    next = {
      ...current,
      revision: current.revision + 1,
      seen: current.seen.slice(-SEEN_CAPACITY),
      scores: Object.fromEntries(Object.entries(current.scores).slice(-SEEN_CAPACITY)),
      asks: current.asks.filter((ask) => ask.messageAt >= floor).slice(-ASK_CAPACITY),
    };
    return rowsPatch(held, next);
  });
  return next!;
}

/** Import `operator-asks.json` now. The Viewer's activation calls this with
    `reconcile: true`. */
export function importLegacyOperatorAsks(file = operatorAsksFile(), options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true }): LegacyImportOutcome {
  return legacyStore.importLegacy(file, options);
}

/** Write `operator-asks.json` from SQLite for a rollback release that
    predates the move. */
export function checkpointOperatorAsksRollbackMirrorForDemotion(file = operatorAsksFile()): void {
  legacyStore.checkpointRollbackMirror(file);
}

/** Test seam: forget every open collection and cached read, the way a
    restarted process would. */
export function resetOperatorAsksStoreForTests(): void {
  for (const { collection } of runtime.collections.values()) collection.close();
  runtime.collections.clear();
  runtime.documents.clear();
}

/** Each conversation's newest ask, by durable id and by transcript path.
    Built once per document: the board asks for it on every poll. */
export function openAskIndex(file: OperatorAsksFileV1): Map<string, OperatorAskRecord> {
  const held = runtime.indexes.get(file);
  if (held) return held;
  const index = new Map<string, OperatorAskRecord>();
  runtime.indexes.set(file, index);
  for (const ask of file.asks) {
    const held = index.get(ask.subject);
    if (held && held.messageAt > ask.messageAt) continue;
    index.set(ask.subject, ask);
    if (ask.conversationId) index.set(ask.conversationId, ask);
    index.set(ask.path, ask);
  }
  return index;
}

export function reportLogAsk(ask: OperatorAskRecord): ReportLogAsk {
  return {
    id: ask.id,
    at: new Date(ask.messageAt).toISOString(),
    conversationId: ask.conversationId,
    path: ask.path,
    role: ask.role,
    title: ask.title,
    gist: ask.gist,
  };
}

/** Moves whenever the store does, for the report log's `unchanged` answer:
    the collection revision, or the legacy file's stat before the import. */
export function operatorAsksSignature(file = operatorAsksFile()): string {
  const database = legacyDatabasePath(file);
  const revision = readStateCollectionRevision(database, OPERATOR_ASKS_COLLECTION);
  if (revision !== null) return `asks:sqlite:${databaseIdentity(database)}:${revision}`;
  try {
    const stat = fs.statSync(file);
    return `asks:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "asks:missing";
  }
}

/** Where the page after `ask` starts: its time, then its id for a tie. */
export function askCursor(ask: Pick<OperatorAskRecord, "messageAt" | "id">): string {
  return `${ask.messageAt}:${ask.id}`;
}

function parseAskCursor(cursor: string | null): { at: number; id: string } | null {
  if (!cursor) return null;
  const split = cursor.indexOf(":");
  const at = Number(cursor.slice(0, split));
  return split > 0 && Number.isFinite(at) ? { at, id: cursor.slice(split + 1) } : null;
}

/**
 * A project's ask lines, newest first, a page at a time: the lines past
 * `before` (a cursor from the page before, null for the newest), and the
 * cursor of the next page, null once none is older. Ask lines page on their
 * own cursor, apart from the reports, so every one is reachable however many
 * fall between two reports and on a project with no reports at all.
 */
export function projectReportLogAsks(
  inProject: (project: string) => boolean,
  before: string | null,
  limit: number,
  file: OperatorAsksFileV1 = readOperatorAsks(),
): { asks: ReportLogAsk[]; nextBefore: string | null } {
  const cursor = parseAskCursor(before);
  const older = file.asks
    .filter((ask) => inProject(ask.project)
      && (!cursor || ask.messageAt < cursor.at || (ask.messageAt === cursor.at && ask.id.localeCompare(cursor.id) > 0)))
    .sort((left, right) => right.messageAt - left.messageAt || left.id.localeCompare(right.id));
  const page = older.slice(0, Math.max(1, limit));
  return {
    asks: page.map(reportLogAsk),
    nextBefore: older.length > page.length ? askCursor(page.at(-1)!) : null,
  };
}

/** Test seam: the write collection, for fixtures that clear or damage the
    stored rows. */
export function operatorAsksCollectionForTests(file = operatorAsksFile()): SqliteStateCollection<{ key: string; value: unknown }> {
  return writableCollection(file);
}
