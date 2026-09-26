import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { FileTransactionBusyError, withFileTransactionSync } from "@/lib/state/fileTransaction";
import { hotStateWriterRevision, readHotStateReleaseTarget } from "@/lib/state/hotStateAuthority";
import {
  importLegacyCollection,
  lazyReconcileAllowed,
  legacyDatabasePath,
  legacyImportAllowed,
  TOMBSTONE_README,
  writeLegacyRollbackMirror,
  type LegacyCollectionSpec,
  type LegacyImportHooks,
  type LegacyImportOutcome,
  type LegacyReconcileSummary,
} from "@/lib/state/legacyImport";
import {
  importStateCollection,
  readStateImport,
  recordStateImportMirror,
  reimportStateCollection,
  SqliteStateCollection,
  type StateImportRecord,
  type StateImportRow,
} from "@/lib/state/sqliteStateStore";
import { assertStateMutationAllowed } from "@/lib/state/stateMutationBarrier";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { hardenedRedact } from "@/lib/view/compactText";

import {
  BRIDGE_ANSWERED_REF_CAPACITY,
  BRIDGE_CHANNEL_SCHEMA_VERSION,
  BRIDGE_DRAIN_BATCH_MAX,
  BRIDGE_REPORT_BODY_MAX_BYTES,
  BRIDGE_REPORT_CAPACITY,
  BRIDGE_REPORT_LOG_SCHEMA_VERSION,
  BRIDGE_RETIRED_ID_CAPACITY,
  isBridgeDecisionRequestClass,
  isStoredBridgeReportClass,
  LEGACY_CONFIRMATION_CLASS,
  MANAGER_RECORD_REF,
  type BridgeChannelV1,
  type BridgeChannelScope,
  type BridgePendingAnswerV1,
  type BridgeReportBatch,
  type BridgeReportInput,
  type BridgeReportLogV1,
  type BridgeReportOrigin,
  type BridgeReportTelegram,
  type BridgeReportTelegramState,
  type BridgeReportV1,
  type CanonicalSeatConversationId,
} from "./types";

/**
 * The bridge's durable half: channel state (which root, which manager record,
 * how far the gateway has read) and the append-only report log.
 *
 * Modelled on `src/lib/lifecycle/journal.ts` deliberately — monotonic seq,
 * idempotent append keyed by a caller-stable string, capacity trim with retired
 * ids, one transaction per write. That journal is the tested shape for "an
 * append-only record a late replay cannot duplicate", and the bridge needs
 * exactly that property for a manager that retries a report after its host died.
 *
 * Two collections rather than one, because they have different writers and
 * different failure meanings: the manager appends reports, the gateway advances
 * the cursor, and a busy log must not block a cursor write.
 *
 * Both live in the `state.sqlite` beside the legacy files (#1870, slice 4):
 *
 * - `bridge_reports`, imported once from `bridge-reports.json`: `meta` holds
 *   lastSeq and the trim marks, `e:<id>` is one report (the journal shape of
 *   design §4.4), `x:<id>` a retired id in retirement order, `answer:<ref>` a
 *   recorded answer and `pending:<ref>` a parked one.
 * - `bridge_channels`, imported once from `bridge.json` (row `manager`) and
 *   every `bridge-channels/<hash>.json` (row `channel:<hash>`).
 *
 * Each imported file is kept as `<name>.imported-<release>` and a tombstone
 * directory takes its place, so an older release fails visibly instead of
 * writing a file nothing reads (src/lib/state/legacyImport.ts).
 */

const BRIDGE_CHANNEL_BUSY = "bridge channel is busy";
const BRIDGE_LOG_BUSY = "bridge report log is busy";
const REPORTS_COLLECTION = "bridge_reports";
const CHANNELS_COLLECTION = "bridge_channels";
const MANAGER_CHANNEL_ROW = "manager";
const CHANNEL_FILE = /^([0-9a-f]{32})\.json$/;

function bridgeChannelKey(scope: BridgeChannelScope): string {
  return crypto.createHash("sha256")
    .update(`${scope.project}\0${scope.seatConversationId}`)
    .digest("hex")
    .slice(0, 32);
}

/** The legacy file a channel was stored in before #1870; now the path its
    import reads and its rollback mirror writes. */
export function bridgeChannelPath(scope?: BridgeChannelScope): string {
  return scope
    ? statePath("bridge-channels", `${bridgeChannelKey(scope)}.json`)
    : statePath("bridge.json");
}

/** The legacy report log, likewise. */
export function bridgeReportLogPath(): string {
  return statePath("bridge-reports.json");
}

/**
 * Raised when bridge state exists but cannot be read as one. Fatal by design,
 * for the reason `LifecycleJournalCorruptError` is: a truncated write that read
 * as "nothing here yet" would restart `lastSeq` at 0, and a gateway cursor
 * sitting above a reset `lastSeq` is permanently deaf to the manager with
 * nothing anywhere saying so.
 */
export class BridgeStateCorruptError extends Error {
  readonly statePath: string;

  constructor(target: string, detail: string) {
    super(`the bridge state at ${target} is unreadable (${detail}); move it aside to start a new one`);
    this.name = "BridgeStateCorruptError";
    this.statePath = target;
  }
}

export function bridgeReportId(key: string): string {
  return `rpt_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/**
 * A report's id, scoped by its project (docs/design/orchestrator-reports.md
 * §1.9). The tick gives keys like `digest:2026-09-25T15:30` to every project
 * it checks in one pass, and an id hashed from the key alone made the second
 * project's report a "replay" of the first. A report no project resolves for
 * keeps the unscoped id.
 */
export function scopedReportId(project: string | null | undefined, key: string): string {
  return project ? bridgeReportId(`${project}\0${key}`) : bridgeReportId(key);
}

/**
 * Bodies are prose the gateway may read aloud, so unlike a lifecycle summary
 * this keeps the manager's own line structure. What it does not keep: secrets,
 * and anything past the byte cap.
 */
export function bridgeReportBody(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const redacted = hardenedRedact(value).trim();
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= BRIDGE_REPORT_BODY_MAX_BYTES) return redacted;
  /* Truncate on a scalar boundary: `toString` on a slice that splits a
     multi-byte sequence yields U+FFFD, which would be a silent corruption of
     text the gateway is about to speak. The ellipsis has to fit too. */
  const marker = "…";
  const budget = BRIDGE_REPORT_BODY_MAX_BYTES - Buffer.byteLength(marker, "utf8");
  let end = budget;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

function readJsonFile(target: string): unknown | null {
  let contents: string;
  try {
    contents = fs.readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BridgeStateCorruptError(target, `it could not be read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new BridgeStateCorruptError(target, "it is not valid JSON — the last write was truncated");
  }
}

function normalizeOrigin(value: unknown): BridgeReportOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { kind?: unknown; conversationId?: unknown; role?: unknown; via?: unknown };
  if (candidate.kind !== "manager" && candidate.kind !== "agent" && candidate.kind !== "gateway" && candidate.kind !== "unidentified") return undefined;
  if (candidate.kind === "unidentified") return { kind: "unidentified", conversationId: null, role: null };
  const deputy = candidate.via && typeof candidate.via === "object" ? (candidate.via as { deputy?: unknown }).deputy : undefined;
  return {
    kind: candidate.kind,
    conversationId: typeof candidate.conversationId === "string" ? candidate.conversationId : null,
    role: typeof candidate.role === "string" ? candidate.role : null,
    ...(typeof deputy === "string" && deputy ? { via: { deputy } } : {}),
  };
}

function normalizeTelegram(value: unknown): BridgeReportTelegram | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<BridgeReportTelegram>;
  if (typeof raw.chat !== "string" || typeof raw.html !== "string" || typeof raw.at !== "string") return undefined;
  if (raw.state !== "pending" && raw.state !== "sent" && raw.state !== "failed" && raw.state !== "uncertain") return undefined;
  return {
    chat: raw.chat,
    html: raw.html,
    state: raw.state,
    ...(Array.isArray(raw.messageIds) ? { messageIds: raw.messageIds.filter((id): id is number => Number.isInteger(id)) } : {}),
    ...(typeof raw.code === "string" ? { code: raw.code } : {}),
    attempts: Number.isInteger(raw.attempts) && (raw.attempts as number) >= 0 ? raw.attempts as number : 0,
    at: raw.at,
  };
}

function normalizeReport(value: unknown): BridgeReportV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<BridgeReportV1>;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  if (!Number.isInteger(candidate.seq) || (candidate.seq as number) < 1) return null;
  if (typeof candidate.at !== "string" || !candidate.at) return null;
  /* Legacy `confirmation_request` rows (the retired operator-confirmation
     round trip) still parse so old logs keep reading; their authorization
     payloads are dead machinery and are dropped here. */
  if (!isStoredBridgeReportClass(candidate.class)) return null;
  const origin = normalizeOrigin(candidate.origin);
  const project = typeof candidate.project === "string"
    ? candidate.project
    : candidate.project === null ? null : undefined;
  const targetSeatConversationId = typeof candidate.targetSeatConversationId === "string"
    ? candidate.targetSeatConversationId
    : candidate.targetSeatConversationId === null ? null : undefined;
  return {
    id: candidate.id,
    seq: candidate.seq as number,
    at: candidate.at,
    class: candidate.class,
    ...(typeof candidate.key === "string" && candidate.key ? { key: candidate.key } : {}),
    body: typeof candidate.body === "string" ? candidate.body : "",
    ...(origin ? { origin } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(targetSeatConversationId !== undefined ? { targetSeatConversationId } : {}),
    ...(typeof candidate.correlatesDirective === "string" ? { correlatesDirective: candidate.correlatesDirective } : {}),
    ...(Array.isArray(candidate.covers) ? { covers: candidate.covers.filter((id): id is string => typeof id === "string") } : {}),
    ...(typeof candidate.coversOwedAt === "string" ? { coversOwedAt: candidate.coversOwedAt } : {}),
    ...(normalizeTelegram(candidate.telegram) ? { telegram: normalizeTelegram(candidate.telegram) } : {}),
  };
}

function emptyLog(): BridgeReportLogV1 {
  return {
    schemaVersion: BRIDGE_REPORT_LOG_SCHEMA_VERSION,
    lastSeq: 0,
    trimmedThroughSeq: 0,
    trimmedThroughByChannel: {},
    reports: [],
    retired: [],
    answeredRefs: [],
    pendingAnswers: [],
  };
}

/** Recorded answers, sorted and bounded. Unlike a report row a malformed entry
    here is noise rather than damage — it can only fail to clear an ask, never
    invent one — so it drops instead of stopping the read. */
function normalizeAnsweredRefs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const refs = new Set<number>();
  for (const entry of value) {
    if (Number.isInteger(entry) && (entry as number) > 0) refs.add(entry as number);
  }
  return [...refs].sort((left, right) => left - right).slice(-BRIDGE_ANSWERED_REF_CAPACITY);
}

/** Parked answers, bounded and de-duplicated by ref. Noise rather than damage
    for the same reason recorded answers are: a malformed entry can only fail to
    clear an ask, never invent one. */
function normalizePendingAnswers(value: unknown, answered: readonly number[]): BridgePendingAnswerV1[] {
  if (!Array.isArray(value)) return [];
  const settled = new Set(answered);
  const pending = new Map<number, BridgePendingAnswerV1>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Partial<BridgePendingAnswerV1>;
    if (!Number.isInteger(candidate.ref) || (candidate.ref as number) < 1) continue;
    if (typeof candidate.operationId !== "string" || !candidate.operationId) continue;
    if (typeof candidate.project !== "string" || !candidate.project) continue;
    if (typeof candidate.seatConversationId !== "string" || !candidate.seatConversationId) continue;
    /* A ref already recorded as answered needs no pending row: whichever
       directive got there first settled it, and once is the contract. */
    if (settled.has(candidate.ref as number)) continue;
    pending.set(candidate.ref as number, {
      ref: candidate.ref as number,
      operationId: candidate.operationId,
      project: candidate.project,
      seatConversationId: candidate.seatConversationId,
    });
  }
  return [...pending.values()].sort((left, right) => left.ref - right.ref).slice(-BRIDGE_ANSWERED_REF_CAPACITY);
}

/** Every recorded row must survive the round trip. A row that does not is
    damage, not noise: dropping it silently would rewrite the manager's history
    on the next append, so it stops the read instead. */
function normalizeLog(value: unknown, target: string): BridgeReportLogV1 {
  if (value === null) return emptyLog();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeStateCorruptError(target, "its contents are not a report log object");
  }
  const file = value as Partial<BridgeReportLogV1>;
  if (file.reports !== undefined && !Array.isArray(file.reports)) {
    throw new BridgeStateCorruptError(target, "its reports field is not an array");
  }
  const raw = file.reports ?? [];
  const reports: BridgeReportV1[] = [];
  for (const [index, candidate] of raw.entries()) {
    const report = normalizeReport(candidate);
    if (!report) throw new BridgeStateCorruptError(target, `recorded report ${index + 1} of ${raw.length} is malformed`);
    reports.push(report);
  }
  reports.sort((left, right) => left.seq - right.seq);
  const highest = reports.at(-1)?.seq ?? 0;
  const oldest = reports[0]?.seq ?? 0;
  const recordedTrim = Number.isInteger(file.trimmedThroughSeq) ? file.trimmedThroughSeq as number : 0;
  const answeredRefs = normalizeAnsweredRefs(file.answeredRefs);
  return {
    schemaVersion: BRIDGE_REPORT_LOG_SCHEMA_VERSION,
    lastSeq: Math.max(Number.isInteger(file.lastSeq) ? file.lastSeq as number : 0, highest),
    /* The oldest retained seq is the authority on what was trimmed: a recorded
       value that disagrees would let a gap pass unannounced. */
    trimmedThroughSeq: Math.max(recordedTrim, oldest > 0 ? oldest - 1 : 0),
    trimmedThroughByChannel: file.trimmedThroughByChannel
      && typeof file.trimmedThroughByChannel === "object"
      && !Array.isArray(file.trimmedThroughByChannel)
      ? Object.fromEntries(Object.entries(file.trimmedThroughByChannel)
        .filter((entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && entry[1] > 0))
      : {},
    reports,
    retired: Array.isArray(file.retired) ? file.retired.filter((id): id is string => typeof id === "string") : [],
    answeredRefs,
    pendingAnswers: normalizePendingAnswers(file.pendingAnswers, answeredRefs),
  };
}

function normalizeChannel(
  value: unknown,
  target: string,
  scope?: BridgeChannelScope,
): BridgeChannelV1 | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeStateCorruptError(target, "its contents are not a channel object");
  }
  const file = value as Partial<BridgeChannelV1>;
  if (typeof file.rootId !== "string" || !file.rootId) return null;
  if (scope && (file.project !== scope.project || file.seatConversationId !== scope.seatConversationId)) {
    throw new BridgeStateCorruptError(target, "its project or seat does not match the scoped channel path");
  }
  const outstanding = file.outstanding;
  return {
    schemaVersion: BRIDGE_CHANNEL_SCHEMA_VERSION,
    rootId: file.rootId,
    ...(scope
      ? { project: scope.project, seatConversationId: scope.seatConversationId }
      : {
        ...(typeof file.project === "string" ? { project: file.project } : {}),
        ...(typeof file.seatConversationId === "string"
          ? { seatConversationId: file.seatConversationId }
          : {}),
      }),
    managerRecordRef: MANAGER_RECORD_REF,
    managerReportCursor: Number.isInteger(file.managerReportCursor) && (file.managerReportCursor as number) > 0
      ? file.managerReportCursor as number
      : 0,
    updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : new Date(0).toISOString(),
    ...(outstanding
      && typeof outstanding === "object"
      && typeof (outstanding as { token?: unknown }).token === "string"
      && Number.isInteger((outstanding as { throughSeq?: unknown }).throughSeq)
      ? { outstanding: outstanding as { token: string; throughSeq: number; issuedAt: string } }
      : {}),
  };
}

/* ── SQLite storage (#1870, slice 4) ─────────────────────────────────────── */

/** One stored row of either collection. */
type BridgeRow = { k: string; v: unknown };

function isBridgeRow(value: unknown): value is BridgeRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as BridgeRow).k === "string" && Boolean((value as BridgeRow).k)
    && Object.hasOwn(value as object, "v");
}

function databaseIdentity(database: string): string {
  try {
    const stat = fs.statSync(database);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "absent";
  }
}

/* Cached per database and collection, and validated against the file's
   identity rather than its name: a test that removes its state directory and
   starts over must not be served by a connection to the file that used to be
   there. */
const collections = new Map<string, { identity: string; collection: SqliteStateCollection<BridgeRow> }>();

function openCollection(database: string, name: string): SqliteStateCollection<BridgeRow> {
  const cacheKey = `${database}\0${name}`;
  const held = collections.get(cacheKey);
  if (held && held.identity === databaseIdentity(database)) return held.collection;
  const collection = new SqliteStateCollection<BridgeRow>(database, {
    collection: name,
    schemaVersion: 1,
    busyMessage: name === REPORTS_COLLECTION ? BRIDGE_LOG_BUSY : BRIDGE_CHANNEL_BUSY,
    key: (row) => row.k,
    decode: (value) => (isBridgeRow(value) ? value : null),
    clone: (row) => structuredClone(row),
    strictDecode: true,
    decodeError: (error) => Object.assign(
      new BridgeStateCorruptError(`${database}#${name}`, "a stored row is malformed"),
      { cause: error },
    ),
  });
  collections.set(cacheKey, { identity: databaseIdentity(database), collection });
  return collection;
}

function cachedCollection(database: string, name: string): SqliteStateCollection<BridgeRow> | null {
  const held = collections.get(`${database}\0${name}`);
  return held && held.identity === databaseIdentity(database) ? held.collection : null;
}

/** Drops this process's cached handles. Tests that rebuild a state directory
    under one path call it; nothing in the product does. */
export function resetBridgeCollectionsForTests(): void {
  collections.clear();
}

/** The report collection, importing the legacy log on first use. Null only for
    a read before the import may run (a release that has not been promoted):
    the caller then reads the legacy file, which is what every reader did before
    the collection existed. */
function reportsCollection(purpose: "read" | "write"): SqliteStateCollection<BridgeRow> | null {
  const legacyPath = bridgeReportLogPath();
  const database = legacyDatabasePath(legacyPath);
  const cached = cachedCollection(database, REPORTS_COLLECTION);
  if (cached) return cached;
  if (!readStateImport(database, REPORTS_COLLECTION)) {
    /* Nothing above this line writes: a read that arrives here from a module
       load the barrier refuses (#1905) leaves the state directory as it was. */
    if (!legacyImportAllowed(legacyPath)) {
      if (purpose === "read") return null;
      throw new FileTransactionBusyError("bridge report log is waiting for release promotion");
    }
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true, mode: 0o700 });
    importLegacyBridgeReports(legacyPath, { reconcile: lazyReconcileAllowed(legacyPath) });
  }
  return openCollection(database, REPORTS_COLLECTION);
}

/** The channel collection, likewise. */
function channelsCollection(purpose: "read" | "write"): SqliteStateCollection<BridgeRow> | null {
  const directory = path.dirname(bridgeChannelPath());
  const database = path.join(directory, "state.sqlite");
  const cached = cachedCollection(database, CHANNELS_COLLECTION);
  if (cached) return cached;
  if (!readStateImport(database, CHANNELS_COLLECTION)) {
    if (!legacyImportAllowed(bridgeChannelPath())) {
      if (purpose === "read") return null;
      throw new FileTransactionBusyError("bridge channel is waiting for release promotion");
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    importLegacyBridgeChannels(directory, { reconcile: lazyReconcileAllowed(bridgeChannelPath()) });
  }
  return openCollection(database, CHANNELS_COLLECTION);
}

/* ── The report log as rows ─────────────────────────────────────────────── */

type LogMeta = Pick<BridgeReportLogV1, "lastSeq" | "trimmedThroughSeq" | "trimmedThroughByChannel">;

/** The log as rows, in the order they are stored: meta, reports by seq, retired
    ids oldest first, answers, parked answers. A duplicate id in a file older
    code wrote keeps its first row, because a key names one row. */
function rowsFromLog(log: BridgeReportLogV1): BridgeRow[] {
  const meta: LogMeta = {
    lastSeq: log.lastSeq,
    trimmedThroughSeq: log.trimmedThroughSeq,
    trimmedThroughByChannel: log.trimmedThroughByChannel ?? {},
  };
  const rows: BridgeRow[] = [{ k: "meta", v: meta }];
  const seen = new Set<string>();
  const push = (row: BridgeRow) => {
    if (seen.has(row.k)) return;
    seen.add(row.k);
    rows.push(row);
  };
  for (const report of [...log.reports].sort((left, right) => left.seq - right.seq)) push({ k: `e:${report.id}`, v: report });
  for (const id of log.retired) push({ k: `x:${id}`, v: { id } });
  for (const ref of log.answeredRefs ?? []) push({ k: `answer:${ref}`, v: ref });
  for (const pending of log.pendingAnswers ?? []) push({ k: `pending:${pending.ref}`, v: pending });
  return rows;
}

function logFromRows(rows: readonly BridgeRow[], target: string): BridgeReportLogV1 {
  const log = emptyLog();
  const answered: unknown[] = [];
  const pending: unknown[] = [];
  for (const row of rows) {
    if (row.k === "meta") {
      const meta = row.v as Partial<LogMeta>;
      log.lastSeq = Number.isInteger(meta.lastSeq) ? meta.lastSeq as number : 0;
      log.trimmedThroughSeq = Number.isInteger(meta.trimmedThroughSeq) ? meta.trimmedThroughSeq as number : 0;
      log.trimmedThroughByChannel = meta.trimmedThroughByChannel ?? {};
    } else if (row.k.startsWith("e:")) {
      const report = normalizeReport(row.v);
      if (!report) throw new BridgeStateCorruptError(target, `stored report ${row.k} is malformed`);
      log.reports.push(report);
    } else if (row.k.startsWith("x:")) {
      log.retired.push(row.k.slice(2));
    } else if (row.k.startsWith("answer:")) {
      answered.push(row.v);
    } else if (row.k.startsWith("pending:")) {
      pending.push(row.v);
    }
  }
  log.reports.sort((left, right) => left.seq - right.seq);
  log.lastSeq = Math.max(log.lastSeq, log.reports.at(-1)?.seq ?? 0);
  log.answeredRefs = normalizeAnsweredRefs(answered);
  log.pendingAnswers = normalizePendingAnswers(pending, log.answeredRefs);
  return log;
}

/** The rows that changed between two row sets, as one patch. */
function diffRows(previous: readonly BridgeRow[], next: readonly BridgeRow[]): { records: BridgeRow[]; deleteKeys: string[] } {
  const held = new Map(previous.map((row) => [row.k, JSON.stringify(row)] as const));
  const nextKeys = new Set(next.map((row) => row.k));
  return {
    records: next.filter((row) => held.get(row.k) !== JSON.stringify(row)),
    deleteKeys: previous.map((row) => row.k).filter((key) => !nextKeys.has(key)),
  };
}

function readLog(): BridgeReportLogV1 {
  const collection = reportsCollection("read");
  if (!collection) {
    const target = bridgeReportLogPath();
    return normalizeLog(readJsonFile(target), target);
  }
  return logFromRows(collection.snapshot(), `${collection.filename}#${REPORTS_COLLECTION}`);
}

/**
 * A signature that moves whenever the report log does, for a cache keyed on it
 * (the files projection, whose seat asks derive from this log). It opens the
 * log the way a read does, lazy import included, so the first request and the
 * next one see the same signature; before the import may run it is the legacy
 * file's, and a log that cannot be opened keys on the file rather than failing
 * the caller.
 */
export function bridgeReportLogSignature(): string {
  try {
    const collection = reportsCollection("read");
    if (collection) return `${REPORTS_COLLECTION}:sqlite:${collection.revision()}`;
  } catch { /* keyed on the legacy file below */ }
  const target = bridgeReportLogPath();
  try {
    const stat = fs.statSync(target);
    return `${target}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${target}:missing`;
  }
}

/** The durable report log exactly as stored. */
export function readBridgeReportLog(): BridgeReportLogV1 {
  return readLog();
}

/** The most one page of the report log holds (#2146). */
export const BRIDGE_REPORT_PAGE_MAX = 100;

/**
 * One page of a project's reports, newest first, for the operator's report log
 * (#2146). `inProject` decides which rows belong, because a row keeps the key
 * its project had when it was written. `before` pages back by seq.
 *
 * A read and nothing else: no channel is opened and no cursor moves, so the
 * voice relay's own delivery is exactly what it was before anybody looked.
 * Legacy confirmation rows are retired authorization state and are left out.
 */
export function pageBridgeReports(options: {
  inProject: (project: string) => boolean;
  before?: number | null;
  limit?: number;
}): { reports: BridgeReportV1[]; nextBefore: number | null } {
  const limit = Math.max(1, Math.min(BRIDGE_REPORT_PAGE_MAX, Math.floor(options.limit ?? 30)));
  const before = typeof options.before === "number" && Number.isFinite(options.before) ? options.before : Number.POSITIVE_INFINITY;
  const matching = readLog().reports.filter((report) =>
    report.seq < before
    && report.class !== LEGACY_CONFIRMATION_CLASS
    && typeof report.project === "string"
    && options.inProject(report.project));
  const reports = matching.slice(-limit).reverse();
  return {
    reports,
    nextBefore: matching.length > limit ? reports.at(-1)!.seq : null,
  };
}

/** One serialized read-modify-write of the log. `mutate` edits the log it is
    handed and says whether it changed anything; only changed rows are written,
    and an unchanged log writes nothing, so its revision stays put. */
function mutateLog<R>(mutate: (log: BridgeReportLogV1) => { result: R; changed: boolean }): R {
  const collection = reportsCollection("write")!;
  let result: R;
  collection.patchSync(() => {
    const rows = collection.snapshot();
    const log = logFromRows(rows, `${collection.filename}#${REPORTS_COLLECTION}`);
    const outcome = mutate(log);
    result = outcome.result;
    return outcome.changed ? diffRows(rows, rowsFromLog(log)) : { records: [] };
  });
  return result!;
}

/* ── Channels as rows ───────────────────────────────────────────────────── */

function channelRowKey(scope?: BridgeChannelScope): string {
  return scope ? `channel:${bridgeChannelKey(scope)}` : MANAGER_CHANNEL_ROW;
}

function channelFileFor(directory: string, rowKey: string): string {
  return rowKey === MANAGER_CHANNEL_ROW
    ? path.join(directory, "bridge.json")
    : path.join(directory, "bridge-channels", `${rowKey.slice("channel:".length)}.json`);
}

function readChannelRow(rowKey: string, scope?: BridgeChannelScope): BridgeChannelV1 | null {
  const collection = channelsCollection("read");
  if (!collection) {
    const target = channelFileFor(path.dirname(bridgeChannelPath()), rowKey);
    return normalizeChannel(readJsonFile(target), target, scope);
  }
  const row = collection.get(rowKey);
  return row ? normalizeChannel(row.v, `${collection.filename}#${rowKey}`, scope) : null;
}

/** One serialized read-modify-write of one channel row. */
function mutateChannel<R>(
  rowKey: string,
  mutate: (read: () => BridgeChannelV1 | null) => { result: R; next?: BridgeChannelV1 },
  scope?: BridgeChannelScope,
): R {
  const collection = channelsCollection("write")!;
  let result: R;
  collection.patchSync(() => {
    const outcome = mutate(() => {
      const row = collection.get(rowKey);
      return row ? normalizeChannel(row.v, `${collection.filename}#${rowKey}`, scope) : null;
    });
    result = outcome.result;
    return { records: outcome.next ? [{ k: rowKey, v: outcome.next }] : [] };
  });
  return result!;
}

/**
 * Record the batch just handed out and mint the token that settles it.
 *
 * Overwrites any previous outstanding batch: a handout supersedes the one before it,
 * and the cursor is monotonic anyway, so a stale token can only ever try to settle a
 * position already passed.
 */
export function issueBridgeAckToken(
  throughSeq: number,
  now = new Date(),
  scope?: BridgeChannelScope,
): string {
  return mutateChannel(channelRowKey(scope), (read) => {
    const current = read();
    if (!current) throw new Error("the bridge channel is not open");
    const token = scope
      ? `ack_${bridgeChannelKey(scope)}_${crypto.randomBytes(18).toString("hex")}`
      : `ack_${crypto.randomBytes(18).toString("hex")}`;
    return {
      result: token,
      next: { ...current, outstanding: { token, throughSeq, issuedAt: now.toISOString() } },
    };
  }, scope);
}

/**
 * Settle the outstanding batch by its token.
 *
 * The seq comes from what was HANDED OUT, never from the caller — so a caller cannot
 * retire reports it never received by naming their sequence.
 */
export function redeemBridgeAckToken(token: string, now = new Date()): { ok: boolean; throughSeq: number } {
  const scopedKey = /^ack_([0-9a-f]{32})_[0-9a-f]{36}$/.exec(token)?.[1];
  const rowKey = scopedKey ? `channel:${scopedKey}` : MANAGER_CHANNEL_ROW;
  return mutateChannel<{ ok: boolean; throughSeq: number }>(rowKey, (read) => {
    const current = read();
    if (scopedKey && current && (
      !current.project
      || !current.seatConversationId
      || bridgeChannelKey({
        project: current.project,
        seatConversationId: current.seatConversationId,
      }) !== scopedKey
    )) {
      throw new BridgeStateCorruptError(rowKey, "its stored scope does not match its acknowledgement token");
    }
    if (!current?.outstanding || current.outstanding.token !== token) {
      return { result: { ok: false, throughSeq: current?.managerReportCursor ?? 0 } };
    }
    const throughSeq = Math.max(current.managerReportCursor, current.outstanding.throughSeq);
    const next: BridgeChannelV1 = {
      ...current,
      managerReportCursor: throughSeq,
      updatedAt: now.toISOString(),
    };
    delete next.outstanding;
    return { result: { ok: true, throughSeq }, next };
  });
}

/** Channel state as stored, or null when the bridge was never opened. */
export function readBridgeChannel(scope?: BridgeChannelScope): BridgeChannelV1 | null {
  return readChannelRow(channelRowKey(scope), scope);
}

/**
 * Resolve the channel for this root, creating it on first sight.
 *
 * Idempotent and cursor-preserving: the gateway calls this on every start, and a
 * root rollover calls it with the same `rootId` the lineage minted once — so
 * neither event may reset how far the manager's reports have been consumed.
 */
export function openBridgeChannel(
  rootId: string,
  now = new Date(),
  scope?: BridgeChannelScope,
): BridgeChannelV1 {
  if (!rootId.trim()) throw new Error("bridge channel requires a root identity");
  return mutateChannel(channelRowKey(scope), (read) => {
    const current = read();
    /* The project seat owns the durable channel and cursor. Root identity
       records its first opener; additional roots preserve the position. */
    if (current) return { result: current };
    const channel: BridgeChannelV1 = {
      schemaVersion: BRIDGE_CHANNEL_SCHEMA_VERSION,
      rootId,
      ...(scope ? { project: scope.project, seatConversationId: scope.seatConversationId } : {}),
      managerRecordRef: MANAGER_RECORD_REF,
      managerReportCursor: 0,
      updatedAt: now.toISOString(),
    };
    return { result: channel, next: channel };
  }, scope);
}

/**
 * Retire reports past the capacity, oldest first, except the quarantine.
 * Mutates `file`.
 */
function trimToCapacity(file: BridgeReportLogV1, legacyCursor: number): void {
  if (file.reports.length <= BRIDGE_REPORT_CAPACITY) return;
  let remaining = file.reports.length - BRIDGE_REPORT_CAPACITY;
  const trimmed: BridgeReportV1[] = [];
  const retained: BridgeReportV1[] = [];
  for (const report of file.reports) {
    /* Unrouted rows are the quarantine. Trimming them would turn "visible
       and waiting" into silent loss, including every pre-#787 row whose
       intended project cannot be reconstructed safely. */
    const quarantined = !report.targetSeatConversationId
      || (report.project == null && report.seq > legacyCursor);
    if (remaining > 0 && !quarantined) {
      trimmed.push(report);
      remaining -= 1;
    } else {
      retained.push(report);
    }
  }
  file.reports = retained;
  const oldestRetained = retained[0]?.seq ?? file.lastSeq + 1;
  file.trimmedThroughSeq = Math.max(file.trimmedThroughSeq, oldestRetained - 1);
  file.trimmedThroughByChannel ??= {};
  for (const report of trimmed) {
    if (!report.project || !report.targetSeatConversationId) continue;
    const key = bridgeChannelKey({
      project: report.project,
      seatConversationId: report.targetSeatConversationId,
    });
    file.trimmedThroughByChannel[key] = Math.max(
      file.trimmedThroughByChannel[key] ?? 0,
      report.seq,
    );
  }
  file.retired = [...file.retired, ...trimmed.map((report) => report.id)].slice(-BRIDGE_RETIRED_ID_CAPACITY);
}

/**
 * Append every report whose id is not already recorded (or already retired by
 * trimming), in one transaction. Returns what was actually added, so a
 * manager can tell a genuinely new report from a replay of one it already sent.
 */
export function appendBridgeReports(
  inputs: readonly BridgeReportInput[],
): { appended: BridgeReportV1[]; skipped: number } {
  if (inputs.length === 0) return { appended: [], skipped: 0 };
  return mutateLog((file) => {
    const known = new Set<string>([...file.reports.map((report) => report.id), ...file.retired]);
    const appended: BridgeReportV1[] = [];
    let skipped = 0;
    for (const input of inputs) {
      const project = typeof input.project === "string" ? input.project : null;
      const id = scopedReportId(project, input.key);
      /* A row filed before ids were scoped carries the key's unscoped id, and a
         late replay of it is still a replay. */
      if (known.has(id) || (project !== null && known.has(bridgeReportId(input.key)))) {
        skipped += 1;
        continue;
      }
      known.add(id);
      file.lastSeq += 1;
      const report: BridgeReportV1 = {
        id,
        seq: file.lastSeq,
        at: input.at,
        class: input.class,
        /* The verbatim key is kept for the classes that become an attention
           item and for no others (#1168): a `status` row is identified by its
           hashed `id` exactly as it was before this field existed. */
        ...(isBridgeDecisionRequestClass(input.class) ? { key: input.key } : {}),
        body: bridgeReportBody(input.body),
        ...(input.origin ? { origin: normalizeOrigin(input.origin) } : {}),
        ...("project" in input ? { project: typeof input.project === "string" ? input.project : null } : {}),
        ...("targetSeatConversationId" in input
          ? {
            targetSeatConversationId: typeof input.targetSeatConversationId === "string"
              ? input.targetSeatConversationId
              : null,
          }
          : {}),
        ...(input.correlatesDirective ? { correlatesDirective: input.correlatesDirective } : {}),
        ...(input.covers?.length ? { covers: [...new Set(input.covers.map((key) => scopedReportId(project, key)))] } : {}),
        ...(input.coversOwed ? { coversOwedAt: input.at } : {}),
        ...(input.telegram
          ? { telegram: { chat: input.telegram.chat, html: input.telegram.html, state: "pending" as const, attempts: 0, at: input.at } }
          : {}),
      };
      file.reports.push(report);
      appended.push(report);
    }
    if (appended.length === 0) return { result: { appended, skipped }, changed: false };
    trimToCapacity(file, readBridgeChannel()?.managerReportCursor ?? 0);
    return { result: { appended, skipped }, changed: true };
  });
}

/**
 * What became of a report's Telegram copy (docs/design/orchestrator-reports.md
 * §5.5). Only the delivery fields move; the stored HTML never changes, so a
 * retry re-sends exactly what was prepared beside the bridge row. Null when
 * the row is gone or carries no Telegram copy.
 */
export function recordBridgeReportTelegram(
  id: string,
  outcome: { state: BridgeReportTelegramState; messageIds?: readonly number[]; code?: string | null; at: string; attempted?: boolean },
): BridgeReportV1 | null {
  return mutateLog((file) => {
    const report = file.reports.find((candidate) => candidate.id === id);
    if (!report?.telegram) return { result: null, changed: false };
    const { code: _previous, ...held } = report.telegram;
    report.telegram = {
      ...held,
      state: outcome.state,
      ...(outcome.messageIds?.length ? { messageIds: [...outcome.messageIds] } : held.messageIds ? { messageIds: held.messageIds } : {}),
      ...(outcome.code ? { code: outcome.code } : {}),
      attempts: held.attempts + (outcome.attempted === false ? 0 : 1),
      at: outcome.at,
    };
    return { result: structuredClone(report), changed: true };
  });
}

/** The stored row for an id, or null. */
export function findBridgeReport(id: string): BridgeReportV1 | null {
  return readBridgeReportLog().reports.find((report) => report.id === id) ?? null;
}

/**
 * Record that `scope`'s directive answered report `ref` (#1168).
 *
 * The gateway's trailer is the only thing that can say a `question` was
 * ANSWERED — the cursor says only that it was read aloud — so the answer has to
 * outlive the turn that carried it. It lands in the report log rather than in a
 * channel: the seq it names is already log-global, and the attention queue then
 * needs exactly one collection to know whether a report is still asking.
 *
 * Log-global is also why the seq alone may never be taken at face value. The
 * ref is resolved against the log INSIDE the write transaction and recorded only
 * when it names a decision request this directive's own seat filed:
 *
 * - a ref naming nothing yet would sit in the log waiting to pre-answer
 *   whatever report later takes that seq, silencing a question nobody replied to;
 * - a ref naming another project's row would let one project's directive clear
 *   another project's ask, because the number carries no ownership of its own;
 * - a ref naming a `status` row settles nothing that was ever asking.
 *
 * The seat fence compares CANONICAL identities on both sides, through the
 * caller's resolver. The recorded seat is whatever the conversation was called
 * when the report was routed and the scope's is whatever the seat authority
 * calls it now, so raw equality fails after an account migration rekeys it —
 * and it fails on the one side that matters, because the attention projection
 * canonicalizes too and had already moved the ask onto the live card. The
 * resolver travels in rather than being read here so this stays a pure durable
 * store; passing it is not optional, because an identity resolver nobody
 * supplied is exactly the raw comparison this fence exists to stop being.
 *
 * Idempotent, so a directive retry under the same derived id costs nothing.
 */
export function recordBridgeDirectiveAnswer(
  ref: number,
  scope: BridgeChannelScope,
  canonicalSeatConversationId: CanonicalSeatConversationId,
): void {
  if (!Number.isInteger(ref) || ref < 1) return;
  mutateLog((file) => {
    if (!directiveMayAnswer(file, ref, scope, canonicalSeatConversationId)) return { result: undefined, changed: false };
    const refs = file.answeredRefs ?? [];
    if (refs.includes(ref)) return { result: undefined, changed: false };
    file.answeredRefs = normalizeAnsweredRefs([...refs, ref]);
    /* The parked row has served its purpose the moment the answer is recorded
       for real; leaving it would keep a settled ref waiting on a delivery. */
    file.pendingAnswers = (file.pendingAnswers ?? []).filter((entry) => entry.ref !== ref);
    return { result: undefined, changed: true };
  });
}

/** The fence both recorded and parked answers pass, resolved INSIDE the write
    transaction against the log itself — see {@link recordBridgeDirectiveAnswer}
    for why a log-global seq may never be taken at face value. */
function directiveMayAnswer(
  file: BridgeReportLogV1,
  ref: number,
  scope: BridgeChannelScope,
  canonicalSeatConversationId: CanonicalSeatConversationId,
): boolean {
  const answered = file.reports.find((report) => report.seq === ref);
  if (!answered || !isBridgeDecisionRequestClass(answered.class)) return false;
  if (answered.project !== scope.project) return false;
  const recordedSeat = answered.targetSeatConversationId;
  /* An unrouted row is the log's quarantine: it opened no ask, so there is
     nothing here for a directive to settle. */
  if (!recordedSeat) return false;
  return canonicalSeatConversationId(recordedSeat) === canonicalSeatConversationId(scope.seatConversationId);
}

/**
 * Park an answer against the send that still has to arrive (#1131).
 *
 * A directive the runtime merely ACCEPTED has reached nobody: the manager is
 * mid-turn and the message is queued behind it. Recording the answer then would
 * clear a decision request the manager never read, and a delivery that is then
 * dropped leaves the operator with no ask and no instruction. So the ref waits
 * here on the operation id the send returned, and the ask projection clears it
 * once the durable delivery record says that operation was delivered — which
 * also means a send that ends `failed` leaves the ask standing.
 *
 * The same fence as a recorded answer, so a parked ref can no more pre-answer
 * another project's report than a recorded one can. Idempotent by ref.
 */
export function recordBridgeDirectivePendingAnswer(
  ref: number,
  scope: BridgeChannelScope,
  operationId: string,
  canonicalSeatConversationId: CanonicalSeatConversationId,
): void {
  if (!Number.isInteger(ref) || ref < 1 || !operationId) return;
  mutateLog((file) => {
    if (!directiveMayAnswer(file, ref, scope, canonicalSeatConversationId)) return { result: undefined, changed: false };
    if ((file.answeredRefs ?? []).includes(ref)) return { result: undefined, changed: false };
    file.pendingAnswers = normalizePendingAnswers([
      ...(file.pendingAnswers ?? []).filter((entry) => entry.ref !== ref),
      { ref, operationId, project: scope.project, seatConversationId: scope.seatConversationId },
    ], file.answeredRefs ?? []);
    return { result: undefined, changed: true };
  });
}

function gapNotice(cursor: number, resumedAtSeq: number, missedThroughSeq: number, at: string): BridgeReportV1 {
  const missed = missedThroughSeq - cursor;
  return {
    id: `rpt_gap_${missedThroughSeq}`,
    /* The notice carries the trimmed head's seq, so acknowledging the batch
       lands the cursor exactly where the surviving history starts. */
    seq: missedThroughSeq,
    at,
    class: "status",
    body: `The bridge report log was trimmed past this conversation's position: ${missed} earlier report(s) are no longer available. Resuming at report ${resumedAtSeq}.`,
    synthetic: true,
  };
}

/**
 * The pending batch for the gateway: oldest first, bounded, from the durable
 * cursor.
 *
 * Read-only — draining does not advance anything. The cursor moves in
 * {@link acknowledgeBridgeReports}, and only after the consumer has actually
 * taken delivery, because a batch lost between here and the call must arrive
 * again rather than vanish.
 */
export function drainBridgeReports(
  options: { limit?: number; now?: Date; scope?: BridgeChannelScope } = {},
): BridgeReportBatch {
  const scope = options.scope;
  const limit = Math.max(1, Math.min(BRIDGE_DRAIN_BATCH_MAX, options.limit ?? BRIDGE_DRAIN_BATCH_MAX));
  const cursor = readBridgeChannel(scope)?.managerReportCursor ?? 0;
  const file = readLog();
  /* Legacy `confirmation_request` rows are retired authorization state, never
     conversation. Nothing prompts the operator about a deploy anymore; handing
     one back would resurrect exactly the confirmation step #795 removed. */
  const pending = file.reports.filter((report) =>
    report.seq > cursor
    && report.class !== LEGACY_CONFIRMATION_CLASS
    && (!scope
      || (
        report.project === scope.project
        && report.targetSeatConversationId === scope.seatConversationId
      )));
  const legacyCursor = readBridgeChannel()?.managerReportCursor ?? 0;
  const legacyUnrouted = scope
    ? file.reports.filter((report) =>
      report.project == null && report.seq > legacyCursor).length
    : 0;
  const projectUnrouted = scope
    ? file.reports.filter((report) =>
      report.project === scope.project
      && !report.targetSeatConversationId).length
    : 0;

  /* §7.12 — the log outran this consumer. Resuming at the head is the only
     option left, so the batch says so in a row the gateway will read out rather
     than skipping history in silence. */
  const trimmedThrough = scope
    ? file.trimmedThroughByChannel?.[bridgeChannelKey(scope)] ?? 0
    : file.trimmedThroughSeq;
  const gap = cursor < trimmedThrough
    ? { resumedAtSeq: trimmedThrough + 1, missedThroughSeq: trimmedThrough }
    : null;
  const notice = gap
    ? [gapNotice(cursor, gap.resumedAtSeq, gap.missedThroughSeq, (options.now ?? new Date()).toISOString())]
    : [];
  const reports = [...notice, ...pending].slice(0, limit);
  const throughSeq = reports.reduce((highest, report) => Math.max(highest, report.seq), cursor);
  return {
    reports,
    throughSeq,
    remaining: notice.length + pending.length - reports.length,
    gap,
    ...(scope
      ? {
        unrouted: {
          count: legacyUnrouted + projectUnrouted,
          legacy: legacyUnrouted,
          forProject: projectUnrouted,
        },
      }
      : {}),
  };
}

/**
 * Advance the gateway's durable cursor. Monotonic: a late acknowledgement from a
 * batch that a newer one already superseded must not re-open reports the user
 * has already heard.
 */
export function acknowledgeBridgeReports(
  throughSeq: number,
  now = new Date(),
  scope?: BridgeChannelScope,
): BridgeChannelV1 | null {
  if (!Number.isInteger(throughSeq) || throughSeq < 1) return readBridgeChannel(scope);
  return mutateChannel(channelRowKey(scope), (read) => {
    const current = read();
    if (!current) return { result: null };
    if (throughSeq <= current.managerReportCursor) return { result: current };
    const next: BridgeChannelV1 = { ...current, managerReportCursor: throughSeq, updatedAt: now.toISOString() };
    return { result: next, next };
  }, scope);
}

/* ── Import of bridge-reports.json (design §6.2, the slice 1 helper) ────── */

/**
 * Fold a report log that changed after the import back in: a rollback release
 * ran on the mirror, or an older writer raced the fence. The log is a journal,
 * so nothing is deleted by absence: a report the file adds joins (keeping its
 * seq when it lies past everything SQLite holds, otherwise taking the next one,
 * so no cursor has already passed it), an id the file retired is retired here
 * too, answers and parked answers are unioned, and the trim marks take the
 * higher value.
 */
function mergeLegacyLog(legacyPath: string, body: BridgeReportLogV1, options: { fenceOwner: boolean }): LegacyReconcileSummary {
  const collection = openCollection(legacyDatabasePath(legacyPath), REPORTS_COLLECTION);
  const summary: LegacyReconcileSummary = { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
  collection.patchSync(() => {
    const rows = collection.snapshot();
    const log = logFromRows(rows, `${collection.filename}#${REPORTS_COLLECTION}`);
    const live = new Map(log.reports.map((report) => [report.id, report] as const));
    const retired = new Set(log.retired);
    for (const id of body.retired) {
      if (retired.has(id)) continue;
      if (live.delete(id)) {
        summary.removed += 1;
        summary.keys.push(`e:${id}`);
      }
      log.retired.push(id);
      retired.add(id);
    }
    log.reports = [...live.values()];
    for (const report of body.reports) {
      if (live.has(report.id) || retired.has(report.id)) continue;
      if (report.seq > log.lastSeq) {
        log.lastSeq = report.seq;
        log.reports.push(report);
      } else {
        log.lastSeq += 1;
        log.reports.push({ ...report, seq: log.lastSeq });
        summary.conflicts.push(`e:${report.id}`);
      }
      live.set(report.id, report);
      summary.added += 1;
      summary.keys.push(`e:${report.id}`);
    }
    log.reports.sort((left, right) => left.seq - right.seq);
    log.lastSeq = Math.max(log.lastSeq, body.lastSeq);
    log.trimmedThroughSeq = Math.max(log.trimmedThroughSeq, body.trimmedThroughSeq);
    for (const [key, seq] of Object.entries(body.trimmedThroughByChannel ?? {})) {
      log.trimmedThroughByChannel![key] = Math.max(log.trimmedThroughByChannel![key] ?? 0, seq);
    }
    log.answeredRefs = normalizeAnsweredRefs([...(log.answeredRefs ?? []), ...(body.answeredRefs ?? [])]);
    log.pendingAnswers = normalizePendingAnswers([...(body.pendingAnswers ?? []), ...(log.pendingAnswers ?? [])], log.answeredRefs);
    trimToCapacity(log, readBridgeChannel()?.managerReportCursor ?? 0);
    log.retired = log.retired.slice(-BRIDGE_RETIRED_ID_CAPACITY);
    return diffRows(rows, rowsFromLog(log));
  }, { fenceOwner: options.fenceOwner });
  return summary;
}

/** The report log's legacy import spec, for the import driver and its tests. */
export function bridgeReportsLegacyCollection(legacyPath = bridgeReportLogPath()): LegacyCollectionSpec<BridgeReportLogV1> {
  return {
    collection: REPORTS_COLLECTION,
    schemaVersion: 1,
    migrationId: "bridge-reports-json-v1",
    legacyPath,
    /* A log whose recorded rows do not survive the round trip refuses the
       import and leaves the file untouched, as the JSON store refused to read it. */
    parse: (raw) => normalizeLog(raw, legacyPath),
    toRows: (body): StateImportRow[] => rowsFromLog(body)
      .map((row) => ({ key: row.k, value: row, controllerActive: true })),
    reconcile: (body, _baseline, options) => mergeLegacyLog(legacyPath, body, options),
    mirrorBody: () => {
      const collection = openCollection(legacyDatabasePath(legacyPath), REPORTS_COLLECTION);
      let mirror: { body: unknown; revision: number } | null = null;
      collection.checkpointMirror((rows, revision) => {
        mirror = { body: logFromRows(rows, `${collection.filename}#${REPORTS_COLLECTION}`), revision };
      });
      return mirror!;
    },
  };
}

/** The highest position any gateway cursor has reached, read leniently: it
    only raises a floor, so a channel that cannot be read contributes nothing. */
function highestKnownCursor(directory: string): number {
  const positions: number[] = [];
  const consider = (value: unknown) => {
    try {
      const channel = normalizeChannel(value, directory);
      if (!channel) return;
      positions.push(channel.managerReportCursor, channel.outstanding?.throughSeq ?? 0);
    } catch { /* unreadable: no floor from it */ }
  };
  try {
    const collection = channelsCollection("read");
    if (collection) {
      for (const row of collection.snapshot()) consider(row.v);
      return Math.max(0, ...positions);
    }
  } catch { /* fall back to the files */ }
  for (const source of listChannelSources(directory)) {
    try { consider(JSON.parse(fs.readFileSync(source.file, "utf8"))); } catch { /* skip */ }
  }
  return Math.max(0, ...positions);
}

/**
 * Import `bridge-reports.json` into SQLite now. The Viewer's activation calls
 * this with `reconcile: true`; tests drive the helper's crash seams through
 * `hooks`.
 *
 * A log that could not be read imports empty with a recorded gap, as the
 * design prescribes for every store. For this one store that alone would
 * restart seq at 1 below every gateway cursor, which is the permanent deafness
 * `BridgeStateCorruptError` was written to prevent — so the empty log's seq
 * starts at the highest cursor any channel holds, and the next report reaches
 * every gateway.
 */
export function importLegacyBridgeReports(
  legacyPath = bridgeReportLogPath(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  const outcome = importLegacyCollection(bridgeReportsLegacyCollection(legacyPath), options);
  if ((outcome.state === "imported" || outcome.state === "reimported") && outcome.record.gap) {
    const floor = highestKnownCursor(path.dirname(legacyPath));
    if (floor > 0) {
      const collection = openCollection(legacyDatabasePath(legacyPath), REPORTS_COLLECTION);
      collection.patchSync(() => {
        const rows = collection.snapshot();
        const log = logFromRows(rows, `${collection.filename}#${REPORTS_COLLECTION}`);
        if (log.lastSeq >= floor) return { records: [] };
        log.lastSeq = floor;
        return diffRows(rows, rowsFromLog(log));
      });
    }
  }
  return outcome;
}

/* ── Import of bridge.json and bridge-channels/ ─────────────────────────── */

type ChannelSource = { rowKey: string; file: string };
type ChannelRead =
  | { kind: "missing" }
  | { kind: "tombstone" }
  | { kind: "unreadable"; bytes: Buffer }
  | { kind: "channel"; bytes: Buffer; channel: BridgeChannelV1 | null };

/** `bridge.json` and every `<hash>.json` under `bridge-channels/`. The lock
    directories the legacy writers leave (`<file>.write-lock`, `.write-locks`)
    and tombstones do not end in `.json` as files, so they are not sources. */
function listChannelSources(directory: string): ChannelSource[] {
  const sources: ChannelSource[] = [{ rowKey: MANAGER_CHANNEL_ROW, file: path.join(directory, "bridge.json") }];
  const root = path.join(directory, "bridge-channels");
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { /* no scoped channel yet */ }
  for (const name of names.sort()) {
    const match = CHANNEL_FILE.exec(name);
    if (match) sources.push({ rowKey: `channel:${match[1]}`, file: path.join(root, name) });
  }
  return sources;
}

function readChannelSource(source: ChannelSource): ChannelRead {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new FileTransactionBusyError(`a bridge channel is unreadable for now: ${(error as Error).message}`);
  }
  if (stat.isDirectory()) return { kind: "tombstone" };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(source.file);
  } catch (error) {
    // EIO, EACCES and the like may be transient: retry later, never import empty.
    throw new FileTransactionBusyError(`a bridge channel is unreadable for now: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return { kind: "unreadable", bytes };
  }
  /* JSON that is not a channel, or a scoped file whose stored project or seat
     does not hash to its own name, is that one channel's damage. Before the
     move it failed only that scope's reads, so it is kept aside as unreadable
     with a gap for that row, never a refusal that takes every channel down. */
  try {
    const channel = normalizeChannel(parsed, source.file);
    if (channel && source.rowKey !== MANAGER_CHANNEL_ROW && (
      !channel.project || !channel.seatConversationId
      || `channel:${bridgeChannelKey({ project: channel.project, seatConversationId: channel.seatConversationId })}` !== source.rowKey
    )) {
      throw new BridgeStateCorruptError(source.file, "its project or seat does not match the scoped channel path");
    }
    return { kind: "channel", bytes, channel };
  } catch (error) {
    if (error instanceof BridgeStateCorruptError) return { kind: "unreadable", bytes };
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function freeName(base: string): string {
  return fs.existsSync(base) ? `${base}-${stamp()}` : base;
}

function channelTombstone(file: string): void {
  fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  const readme = path.join(file, TOMBSTONE_README);
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      `${path.basename(file)} moved into SQLite.`,
      `It now lives in the "${CHANNELS_COLLECTION}" collection of state.sqlite in the state directory.`,
      "This directory stands in its place so that an older release fails visibly instead of writing a file nothing reads.",
      "",
    ].join("\n"), { mode: 0o600 });
  }
  fsyncDirectory(path.dirname(file));
}

/** Rename a channel file to its kept copy (or aside as unreadable), or delete
    it when it is only an untouched rollback mirror (`suffix` null), and leave
    the tombstone in its place. */
function retireChannelFile(file: string, suffix: string | null): string | null {
  let preservedAs: string | null = null;
  try {
    if (fs.lstatSync(file).isFile()) {
      if (suffix === null) {
        fs.rmSync(file, { force: true });
      } else {
        preservedAs = freeName(`${file}.${suffix}`);
        fs.renameSync(file, preservedAs);
      }
      fsyncDirectory(path.dirname(file));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  channelTombstone(file);
  return preservedAs;
}

/** One digest over every channel file standing, by name and bytes, in source
    order: the import evidence, and what a rollback mirror records so the
    roll-forward can tell an untouched mirror from one a rollback release
    changed. Null when no file stands. */
function channelFilesDigest(entries: readonly { source: ChannelSource; bytes: Buffer }[]): { sha256: string | null; bytes: number } {
  const digest = crypto.createHash("sha256");
  let bytes = 0;
  for (const { source, bytes: body } of entries) {
    bytes += body.length;
    digest.update(path.basename(source.file)).update("\0").update(body);
  }
  return { sha256: entries.length > 0 ? digest.digest("hex") : null, bytes };
}

/** The shared helper's stray-record test (legacyImport.ts), for this
    collection: a record naming no release, with no rollback mirror, in a state
    directory that has a release target, was written by something that was not
    the release — #1905's build — and the files standing beside it are what
    the serving release has been writing since. */
function strayChannelRecord(directory: string, record: StateImportRecord): boolean {
  if (record.release !== null || record.mirrorSha256 !== null || record.mirrorRevision !== null) return false;
  try {
    return readHotStateReleaseTarget(directory) !== null;
  } catch {
    return false;
  }
}

function releaseTag(directory: string): string | null {
  try {
    return hotStateWriterRevision(directory)?.slice(0, 12) ?? null;
  } catch {
    return null;
  }
}

/**
 * Import every channel once, verified, then retire each file behind a
 * tombstone. `bridge.json` becomes the `manager` row and each scoped file its
 * `channel:<hash>` row; the collection's import evidence digests every source
 * by name and bytes, as the conversation-migration journal roots do (slice 7).
 *
 * Runs under `bridge.json`'s own write lock and the channel root's, so two
 * importers queue and import once. A file that is not JSON at all, or not a
 * channel, or a scoped file whose stored scope does not match its name,
 * imports as a recorded gap for that one row and is kept aside as
 * `.unreadable-*`; every other channel imports.
 *
 * A record that already stands with channel files beside it is the rollback
 * window closing (or an older writer that raced it). An untouched mirror is
 * deleted. A stray record (no release, no mirror, a release target present) is
 * rebuilt from the files, as the shared helper rebuilds one. Otherwise each
 * readable file folds in where its cursor is ahead of the row — the cursor is
 * monotonic, so ahead is the only direction that can be news — or where no row
 * exists, and then the tombstones return. An unreadable file there changes
 * nothing.
 */
export function importLegacyBridgeChannels(
  directory = path.dirname(bridgeChannelPath()),
  options: { reconcile: boolean; hooks?: Pick<LegacyImportHooks, "afterCommit"> } = { reconcile: true },
): LegacyImportOutcome {
  assertStateMutationAllowed(directory);
  assertStateStartupMutation(directory, `${CHANNELS_COLLECTION} import`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = path.join(directory, "state.sqlite");
  const managerFile = path.join(directory, "bridge.json");
  const root = path.join(directory, "bridge-channels");
  return withFileTransactionSync(managerFile, BRIDGE_CHANNEL_BUSY, () =>
    withFileTransactionSync(root, BRIDGE_CHANNEL_BUSY, () => {
      const sources = listChannelSources(directory).map((source) => ({ source, read: readChannelSource(source) }));
      const held = readStateImport(database, CHANNELS_COLLECTION);
      const tag = releaseTag(directory) ?? stamp();
      if (held) {
        const files = sources.filter(({ read }) => read.kind === "channel" || read.kind === "unreadable");
        if (files.length === 0) {
          channelTombstone(managerFile);
          return { state: "already-imported", record: held, incident: null };
        }
        if (!options.reconcile) return { state: "reconcile-deferred", record: held, incident: null };
        const collection = openCollection(database, CHANNELS_COLLECTION);
        const standing = channelFilesDigest(files.map(({ source, read }) => ({
          source,
          bytes: (read as { bytes: Buffer }).bytes,
        })));
        if (standing.sha256 !== null && standing.sha256 === held.mirrorSha256) {
          /* The rollback mirror exactly as written: nothing to fold, and the
             collection already holds every byte of it, so no copy is kept. */
          for (const { source } of files) retireChannelFile(source.file, null);
          channelTombstone(managerFile);
          return { state: "already-imported", record: held, incident: null };
        }
        if (strayChannelRecord(directory, held)) {
          /* Rebuilt from the files, as the helper rebuilds a stray import: a
             standing file replaces its row whatever its cursor, and a row
             whose file was retired stays. */
          const rows = new Map(collection.snapshot().map((row) => [row.k, row] as const));
          for (const { source, read } of files) {
            if (read.kind === "channel" && read.channel) rows.set(source.rowKey, { k: source.rowKey, v: read.channel });
          }
          const { record } = reimportStateCollection(database, {
            collection: CHANNELS_COLLECTION,
            schemaVersion: 1,
            migrationId: "bridge-channels-json-v1",
            rows: [...rows.values()].map((row) => ({ key: row.k, value: row, controllerActive: true })),
            sourceName: "bridge.json+bridge-channels",
            sourceSha256: standing.sha256,
            sourceBytes: standing.bytes,
            gap: null,
            release: releaseTag(directory),
          });
          for (const { source, read } of files) {
            retireChannelFile(source.file, read.kind === "unreadable" ? `unreadable-${stamp()}` : `imported-${tag}`);
          }
          channelTombstone(managerFile);
          console.error(`[state import] stale-import-replaced ${CHANNELS_COLLECTION}: channel files stood beside an import recorded at `
            + `${held.importedAt} with no release and no rollback mirror; rebuilt ${record.rowCount} row(s) from them`);
          return { state: "reimported", record, incident: null };
        }
        /* The cursor is the only field that can carry news here. It is
           monotonic, so a file whose cursor is not ahead holds nothing SQLite
           lacks: `rootId` records the first opener and never changes after the
           open, and an `outstanding` token SQLite rewrote at the same cursor is
           the newer handout — a stale one could only fail to redeem, and the
           gateway then drains the same batch again. */
        let folded = 0;
        collection.patchSync(() => {
          const records: BridgeRow[] = [];
          for (const { source, read } of files) {
            if (read.kind !== "channel" || !read.channel) continue;
            const row = collection.get(source.rowKey);
            const current = row ? normalizeChannel(row.v, source.rowKey) : null;
            if (current && read.channel.managerReportCursor <= current.managerReportCursor) continue;
            records.push({ k: source.rowKey, v: read.channel });
          }
          folded = records.length;
          return { records };
        }, { fenceOwner: true });
        for (const { source, read } of files) {
          const preservedAs = retireChannelFile(source.file, read.kind === "unreadable" ? `unreadable-${stamp()}` : `imported-${tag}`);
          if (read.kind === "unreadable") {
            console.error(`[state import] legacy-unreadable ${CHANNELS_COLLECTION}: ${path.basename(source.file)} reappeared unreadable `
              + `after the import; kept as ${preservedAs ? path.basename(preservedAs) : "nothing"}, SQLite unchanged`);
          }
        }
        channelTombstone(managerFile);
        if (folded > 0) {
          console.error(`[state import] legacy-reconciled ${CHANNELS_COLLECTION}: folded ${folded} channel(s) a rollback release or an older writer advanced`);
        }
        return { state: "already-imported", record: held, incident: null };
      }

      const rows: StateImportRow[] = [];
      const unreadable: string[] = [];
      const present: { source: ChannelSource; bytes: Buffer }[] = [];
      for (const { source, read } of sources) {
        if (read.kind === "missing" || read.kind === "tombstone") continue;
        present.push({ source, bytes: read.bytes });
        if (read.kind === "unreadable") {
          unreadable.push(path.basename(source.file));
          continue;
        }
        if (read.channel) rows.push({ key: source.rowKey, value: { k: source.rowKey, v: read.channel }, controllerActive: true });
      }
      const { record } = importStateCollection(database, {
        collection: CHANNELS_COLLECTION,
        schemaVersion: 1,
        migrationId: "bridge-channels-json-v1",
        rows,
        sourceName: "bridge.json+bridge-channels",
        sourceSha256: channelFilesDigest(present).sha256,
        sourceBytes: channelFilesDigest(present).bytes,
        gap: unreadable.length > 0 ? `legacy-unreadable: ${unreadable.join(", ")}` : null,
        release: releaseTag(directory),
      });
      options.hooks?.afterCommit?.();
      for (const { source, read } of sources) {
        if (read.kind === "missing" || read.kind === "tombstone") continue;
        const preservedAs = retireChannelFile(source.file, read.kind === "unreadable" ? `unreadable-${stamp()}` : `imported-${tag}`);
        if (read.kind === "unreadable") {
          console.error(`[state import] legacy-unreadable ${CHANNELS_COLLECTION}: ${path.basename(source.file)} could not be parsed; `
            + `the channel starts unopened and the file is kept as ${preservedAs ? path.basename(preservedAs) : "nothing"}`);
        }
      }
      channelTombstone(managerFile);
      return { state: "imported", record, incident: null };
    }));
}

/* ── Rollback mirrors (§6.4) ────────────────────────────────────────────── */

/**
 * Write every channel back as the file a rollback release reads, from one
 * collection revision. A row's tombstone goes and its file lands durably; a
 * `bridge.json` the collection holds nothing for is left empty rather than
 * tombstoned, because an install that never opened the unscoped channel is what
 * the rollback release must find. The fold-back compares cursors row by row, so
 * the mirror records its revision and no digest.
 */
export function checkpointBridgeChannelsRollbackMirrorForDemotion(directory = path.dirname(bridgeChannelPath())): void {
  const database = path.join(directory, "state.sqlite");
  if (!readStateImport(database, CHANNELS_COLLECTION)) return;
  assertStateMutationAllowed(directory);
  const managerFile = path.join(directory, "bridge.json");
  const root = path.join(directory, "bridge-channels");
  withFileTransactionSync(managerFile, BRIDGE_CHANNEL_BUSY, () =>
    withFileTransactionSync(root, BRIDGE_CHANNEL_BUSY, () => {
      const collection = openCollection(database, CHANNELS_COLLECTION);
      const clear = (file: string) => {
        try { if (fs.lstatSync(file).isDirectory()) fs.rmSync(file, { recursive: true, force: true }); }
        catch { /* nothing at the path */ }
      };
      const revision = collection.checkpointMirrorForDemotion((rows) => {
        clear(managerFile);
        for (const row of rows) {
          const file = channelFileFor(directory, row.k);
          clear(file);
          writeJsonDurably(file, row.v);
        }
      });
      /* The digest of what was written, so a roll-forward that finds the
         mirror untouched deletes it instead of keeping another copy. */
      const written = listChannelSources(directory).flatMap((source) => {
        try {
          return fs.lstatSync(source.file).isFile() ? [{ source, bytes: fs.readFileSync(source.file) }] : [];
        } catch { return []; }
      });
      recordStateImportMirror(database, CHANNELS_COLLECTION, channelFilesDigest(written).sha256, revision);
    }));
}

/** Write `bridge-reports.json` from SQLite for a rollback release that predates #1870. */
export function checkpointBridgeReportsRollbackMirrorForDemotion(legacyPath = bridgeReportLogPath()): void {
  writeLegacyRollbackMirror(bridgeReportsLegacyCollection(legacyPath));
}

/** Both bridge mirrors, for the demotion checkpoint. */
export function checkpointBridgeRollbackMirrorsForDemotion(directory = path.dirname(bridgeReportLogPath())): void {
  checkpointBridgeReportsRollbackMirrorForDemotion(path.join(directory, "bridge-reports.json"));
  checkpointBridgeChannelsRollbackMirrorForDemotion(directory);
}
