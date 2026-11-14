import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { fsyncPath, writeTextDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import {
  openJournalCollection,
  readableJournal,
  writableJournal,
  type JournalLocation,
  type JournalRow,
} from "@/lib/state/journalCollection";
import {
  importLegacyCollection,
  writeLegacyRollbackMirror,
  type LegacyCollectionSpec,
  type LegacyImportHooks,
  type LegacyImportOutcome,
  type LegacyReconcileSummary,
} from "@/lib/state/legacyImport";
import { waitForStateLock } from "@/lib/state/lockWait";
import { readStateRowsPage, type SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { compactSeatTickTiming, sanitizeSeatTickTiming } from "./seatTickTiming";
import { appendThroughSeatTickJournalWorker } from "./seatTickJournalWorker";

import {
  SEAT_TICK_WAKE_REASON_KINDS,
  type MonitorOutcome,
  type MonitorRunRecord,
  type MonitorSkip,
  type RequestState,
  type SeatTickRunRecord,
  type SeatTickVerdictKind,
  type SeatTickWakeReasonKind,
} from "./types";

/**
 * Server side of the audit journals (#741, #1245).
 *
 * Everything that opens a file descriptor for these lives here, inside the
 * Viewer, so a caller records a run by handing over a record rather than by
 * knowing where the file is or what shape it keeps.
 *
 * The property this file exists to guarantee: **a run always leaves a line.**
 * The mechanism #741 replaced wrote nothing on success, so an empty log meant
 * either flawless operation or total failure. Now "no line" means "no run",
 * and the seat tick inherits the same guarantee for its checks — which is what
 * makes the absence of a tick a readable fact rather than a silence.
 *
 * It used to guarantee a second thing: an atomic cross-process single-flight
 * claim, an `O_EXCL` create serialized through the shared file transaction, so
 * two CLI monitor processes could not both sweep one board. #1245 retired it
 * along with the CLI. There is one clock now and it lives in the release that
 * owns traffic, so the contention that lock existed for cannot arise — and a
 * lock file kept for a contender that no longer exists is a thing to leak, not
 * a safety net. A future driver that needs serialization states how it does
 * it in its own deps.
 */

/** Runs retained before the oldest are dropped. */
export const MONITOR_RUN_HISTORY = 200;
const DETAIL_LIMIT = 800;
const FINGERPRINTS_LIMIT = 500;

export function monitorJournalPath(): string {
  return process.env.LLV_MONITOR_AUDIT_FILE?.trim() || statePath(path.join("conversation-monitor", "runs.ndjson"));
}

const REQUEST_STATES: RequestState[] = ["completed", "in-flight", "stalled", "untracked", "awaiting-confirmation"];
const OUTCOMES: MonitorOutcome[] = ["clean", "failed", "skipped"];
const SKIP_REASONS: MonitorSkip["reason"][] = ["already-tracked", "card-budget", "dry-run"];

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Accept only a record shaped like an audit line, and keep only the fields the
 * journal is allowed to carry. A caller that tried to smuggle transcript text
 * or a path through an extra property loses it here, at the boundary, rather
 * than on the honour system.
 */
export function sanitizeRunRecord(value: unknown): MonitorRunRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const runId = text(raw.runId, 100);
  const outcome = OUTCOMES.find((candidate) => candidate === raw.outcome);
  if (raw.schemaVersion !== 1 || !runId || !outcome) return null;

  const window = (raw.window ?? {}) as Record<string, unknown>;
  const scope = (raw.scope ?? {}) as Record<string, unknown>;
  const orchestrator = (raw.orchestrator ?? {}) as Record<string, unknown>;
  const scanned = (raw.scanned ?? {}) as Record<string, unknown>;
  const found = (raw.found ?? {}) as Record<string, unknown>;
  const byStateRaw = (found.byState ?? {}) as Record<string, unknown>;
  const byState = Object.fromEntries(REQUEST_STATES.map((state) => [state, count(byStateRaw[state])])) as Record<RequestState, number>;

  const creations = Array.isArray(raw.created) ? raw.created : [];
  const skips = Array.isArray(raw.skipped) ? raw.skipped : [];

  return {
    schemaVersion: 1,
    runId,
    startedAt: text(raw.startedAt, 40) ?? "",
    finishedAt: text(raw.finishedAt, 40) ?? "",
    outcome,
    detail: text(raw.detail, DETAIL_LIMIT),
    window: { from: text(window.from, 40) ?? "", to: text(window.to, 40) ?? "", hours: count(window.hours) },
    scope: { project: text(scope.project, 200) },
    orchestrator: {
      resolution: (text(orchestrator.resolution, 40) ?? "unavailable") as MonitorRunRecord["orchestrator"]["resolution"],
      conversationId: text(orchestrator.conversationId, 100),
      delivered: orchestrator.delivered === true,
    },
    scanned: { conversations: count(scanned.conversations), operatorMessages: count(scanned.operatorMessages) },
    found: {
      total: count(found.total),
      byState,
      fingerprints: (Array.isArray(found.fingerprints) ? found.fingerprints : [])
        .filter((entry): entry is string => typeof entry === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(entry))
        .slice(0, FINGERPRINTS_LIMIT),
    },
    created: creations.flatMap((entry) => {
      const creation = (entry ?? {}) as Record<string, unknown>;
      const fingerprint = text(creation.fingerprint, 64);
      const taskId = text(creation.taskId, 100);
      if (!fingerprint || !taskId) return [];
      return [{ fingerprint, taskId, state: (text(creation.state, 40) ?? "untracked") as MonitorRunRecord["created"][number]["state"] }];
    }).slice(0, FINGERPRINTS_LIMIT),
    skipped: skips.flatMap((entry) => {
      const skip = (entry ?? {}) as Record<string, unknown>;
      const fingerprint = text(skip.fingerprint, 64);
      const reason = SKIP_REASONS.find((candidate) => candidate === skip.reason);
      if (!fingerprint || !reason) return [];
      return [{ fingerprint, reason }];
    }).slice(0, FINGERPRINTS_LIMIT),
  };
}

/**
 * The append half of an audit journal, for any record type.
 *
 * Generalized for the seat tick (#1245), which keeps its own journal of one
 * line per check under the same two guarantees this file exists to give: the
 * append is serialized against the retention rewrite, and every run leaves a
 * line so "no line" means "no run".
 */
export function appendJournalRecord(record: unknown, options: { filePath: string; retention: number; busyMessage: string }): void {
  fs.mkdirSync(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
  /* Serialized, so a concurrent append cannot interleave with the retention
     rewrite below and lose a line. */
  withFileTransactionSync(options.filePath, options.busyMessage, () => {
    fs.appendFileSync(options.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    trim(options.filePath, options.retention);
  });
}

/** The newest `limit` records, oldest first. A malformed line is skipped rather
    than allowed to hide the runs recorded around it. */
export function readJournalRecords<T>(limit: number, options: { filePath: string; sanitize: (value: unknown) => T | null }): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(options.filePath, "utf8");
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = options.sanitize(JSON.parse(line) as unknown);
      if (record) records.push(record);
    } catch {
      continue;
    }
  }
  return records.slice(-Math.max(0, limit));
}

export function appendRunRecord(record: MonitorRunRecord, filePath = monitorJournalPath()): void {
  appendJournalRecord(record, { filePath, retention: MONITOR_RUN_HISTORY, busyMessage: "the monitor journal is busy" });
}

function trim(filePath: string, retention: number): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return;
  }
  if (lines.length <= retention) return;
  const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${lines.slice(-retention).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}

export function readRunRecords(limit: number, filePath = monitorJournalPath()): MonitorRunRecord[] {
  return readJournalRecords(limit, { filePath, sanitize: sanitizeRunRecord });
}

/* ------------------------------------------------------------------------- *
 * The seat tick's own journal (#1245), on the same two guarantees.
 *
 * It answers the failure mode nothing on disk could answer before: absence. A
 * seat with no tick left no artifact, so a successor could not tell it was
 * missing one, and the operator could not tell how often the predecessor had
 * been ticking — the successor that finally found a predecessor's schedule
 * guessed both numbers from its transcript. Every check leaves a line here,
 * including a check that threw, a sweep refused for want of traffic authority
 * and every way a retained wake stops being outstanding — taken back from a
 * replaced seat, delivered by its holder after all, settled unsent, or retired
 * to the seat that has been superseded (#1594) — so "no line" means "no check"
 * and the cadence is a readable fact.
 * ------------------------------------------------------------------------- */

/** Checks retained before the oldest are dropped. At a five-minute cadence this
    is a bit over a day of history per project, which is the window anything
    diagnosing a tick actually looks at. */
export const SEAT_TICK_RUN_HISTORY = 500;

const SEAT_TICK_VERDICTS: SeatTickVerdictKind[] = [
  "quiet",
  "wake",
  "proactive",
  "no-seat",
  "skipped",
  "error",
  "refused",
  "revoked",
  "landed",
  "dropped",
  "uncertain",
  "retired",
];

export function seatTickJournalPath(): string {
  return process.env.LLV_SEAT_TICK_AUDIT_FILE?.trim() || statePath(path.join("seat-tick", "runs.ndjson"));
}

/**
 * Accept only a record shaped like a check line, and keep only the fields the
 * journal is allowed to carry — the same boundary {@link sanitizeRunRecord}
 * draws for a monitor run, for the same reason: a caller that tried to smuggle
 * transcript text, a path or an extra property through loses it here rather
 * than on the honour system.
 */
export function sanitizeSeatTickRecord(value: unknown): SeatTickRunRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const project = text(raw.project, 200) ?? "";
  const verdict = SEAT_TICK_VERDICTS.find((candidate) => candidate === raw.verdict);
  if (raw.schemaVersion !== 1 || !verdict) return null;
  /* Every line names the project it decided about — except a refusal, which is
     about the process and no project in particular. A nameless line of any
     other kind is a line nothing can be read out of. */
  if (!project && verdict !== "refused") return null;

  const delivery = (raw.delivery ?? null) as Record<string, unknown> | null;
  const clientMessageId = delivery ? text(delivery.clientMessageId, 200) : null;
  const outcome = delivery ? text(delivery.outcome, 60) : null;
  const timing = sanitizeSeatTickTiming(raw.timing);

  return {
    schemaVersion: 1,
    ...(timing ? { timing } : {}),
    at: text(raw.at, 40) ?? "",
    project,
    seatEpoch: typeof raw.seatEpoch === "number" && Number.isSafeInteger(raw.seatEpoch) ? raw.seatEpoch : null,
    verdict,
    reasons: (Array.isArray(raw.reasons) ? raw.reasons : [])
      .filter((entry): entry is SeatTickWakeReasonKind => SEAT_TICK_WAKE_REASON_KINDS.includes(entry as SeatTickWakeReasonKind)),
    items: count(raw.items),
    deferred: count(raw.deferred),
    eventsThrough: count(raw.eventsThrough),
    delivery: clientMessageId && outcome ? { clientMessageId, outcome } : null,
    detail: text(raw.detail, DETAIL_LIMIT),
  };
}

/* ------------------------------------------------------------------------- *
 * Where the seat tick journal lives (#1870 slice 8,
 * docs/design/state-sqlite-migration.md §4.4).
 *
 * The legacy form was two rings of ndjson, both rewritten on every check: the
 * global ring `runs.ndjson` (the newest 500 checks of every project) and one
 * `runs.ndjson.projects/<sha256(project)>.ndjson` per project (its newest 500).
 * On a busy installation that was 3.2 MB plus 48 MB, and every line carried a
 * phase timing about fourteen times the size of the check it timed.
 *
 * Layout of the `seat_tick_runs` collection in `state.sqlite`, one row per key:
 *
 *   meta                  { nextSeq }
 *   r:<project>:<seq>     one check without its timing (the sanitized line),
 *                         plus `i`, the identity of the legacy line it carries
 *   t:<project>:<seq>     that check's phase timing, compacted as on disk
 *
 * `<project>` is the sha256 the legacy file was named by and `<seq>` is
 * zero-padded, so a project's checks are one key range in check order, and the
 * row order across projects is the global check order. A check is kept while
 * it is among the newest 500 of its project or the newest 500 overall, the two
 * legacy rings; an append removes what fell out of both, in the same
 * transaction. A reader of one project's newest checks reads that range only,
 * and the alarm reader leaves the timing rows unread.
 *
 * A journal at another path (`LLV_SEAT_TICK_AUDIT_FILE`, or a path a caller
 * passes) is its own collection in the same database, named after the path.
 * ------------------------------------------------------------------------- */

export const SEAT_TICK_RUNS_COLLECTION = "seat_tick_runs";
const SEAT_TICK_BUSY = "the seat tick journal is busy";
const RUN_PREFIX = "r:";
const TIMING_PREFIX = "t:";
const RUN_META_KEY = "meta";
/** Checks of its own project an append may remove past the bound; one leaves per append. */
const RETENTION_PAGE = 16;

type StoredSeatTickRun = Omit<SeatTickRunRecord, "timing"> & { i: string };

function defaultSeatTickJournalPath(): string {
  return statePath(path.join("seat-tick", "runs.ndjson"));
}

function seatTickProjectKey(project: string): string {
  return crypto.createHash("sha256").update(project).digest("hex");
}

function runKey(projectKey: string, seq: number): string {
  return `${projectKey}:${String(seq).padStart(12, "0")}`;
}

function seatTickCollectionName(filePath: string): string {
  const resolved = path.resolve(filePath);
  return resolved === path.resolve(defaultSeatTickJournalPath())
    ? SEAT_TICK_RUNS_COLLECTION
    : `${SEAT_TICK_RUNS_COLLECTION}:${crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
}

function seatTickLocation(filePath: string): JournalLocation {
  return {
    collection: seatTickCollectionName(filePath),
    database: statePath("state.sqlite"),
    legacyPath: filePath,
    busyMessage: SEAT_TICK_BUSY,
    importLegacy: (options) => importLegacySeatTickJournal(filePath, options),
  };
}

/** The line a check is journaled as, split for storage: the sanitized check,
    its compacted timing, and the identity of that line. Null for a record no
    reader would show. */
function storedSeatTickRun(value: unknown): { run: StoredSeatTickRun; timing: unknown } | null {
  const sanitized = sanitizeSeatTickRecord(value);
  if (!sanitized) return null;
  const { timing, ...run } = sanitized;
  const compact = timing ? compactSeatTickTiming(timing) : null;
  const identity = crypto.createHash("sha256").update(JSON.stringify({ run, timing: compact })).digest("hex");
  return { run: { ...run, i: identity }, timing: compact };
}

/** The legacy line for a stored check, as the legacy writer wrote it. */
function seatTickLine(run: StoredSeatTickRun, timing: unknown): string {
  const check: Partial<StoredSeatTickRun> = { ...run };
  delete check.i;
  return JSON.stringify(timing ? { ...check, timing } : check);
}

function decodeStoredRun(valueJson: string | null | undefined): unknown {
  if (!valueJson) return null;
  const parsed = JSON.parse(valueJson) as unknown;
  return parsed && typeof parsed === "object" && "value" in parsed ? (parsed as { value: unknown }).value : null;
}

/** The newest `limit` checks (at most one ring's worth), oldest first. */
function readStoredSeatTickRuns(location: JournalLocation, limit: number, project: string | undefined, withTiming: boolean): SeatTickRunRecord[] {
  const bounded = limit > 0 ? Math.min(limit, SEAT_TICK_RUN_HISTORY) : SEAT_TICK_RUN_HISTORY;
  const page = readStateRowsPage(location.database, location.collection, {
    prefix: project === undefined ? RUN_PREFIX : `${RUN_PREFIX}${seatTickProjectKey(project)}:`,
    by: project === undefined ? "order" : "key",
    descending: true,
    limit: bounded,
    ...(withTiming ? { companion: { from: RUN_PREFIX, to: TIMING_PREFIX } } : {}),
  });
  if (!page) return [];
  const records: SeatTickRunRecord[] = [];
  for (const row of [...page.rows].reverse()) {
    try {
      const run = decodeStoredRun(row.valueJson) as Record<string, unknown> | null;
      if (!run || typeof run !== "object") continue;
      const timing = withTiming ? decodeStoredRun(row.companionJson) : null;
      if (timing) run.timing = timing;
      const record = sanitizeSeatTickRecord(run);
      if (record) records.push(record);
    } catch {
      /* A row that does not decode is skipped, as a torn line was. */
    }
  }
  return records;
}

/** Keys of one ring beyond `bound`, newest first. */
function ringOverflow(location: JournalLocation, prefix: string, by: "key" | "order", bound: number, limit: number): string[] {
  return readStateRowsPage(location.database, location.collection, { prefix, by, descending: true, offset: bound, limit, keysOnly: true })
    ?.rows.map((row) => row.key) ?? [];
}

/** The rows one append writes and removes. Runs inside the write transaction,
    so the rings it reads are the committed ones. */
function seatTickAppendPatch(
  location: JournalLocation,
  collection: SqliteStateCollection<JournalRow>,
  stored: { run: StoredSeatTickRun; timing: unknown },
): { records: JournalRow[]; deleteKeys: string[] } {
  const meta = collection.get(RUN_META_KEY)?.value as { nextSeq?: unknown } | undefined;
  const seq = Number.isSafeInteger(meta?.nextSeq) && (meta!.nextSeq as number) > 0 ? meta!.nextSeq as number : 1;
  const projectKey = seatTickProjectKey(stored.run.project);
  const key = runKey(projectKey, seq);
  const records: JournalRow[] = [{ key: `${RUN_PREFIX}${key}`, value: stored.run }];
  if (stored.timing) records.push({ key: `${TIMING_PREFIX}${key}`, value: stored.timing });
  records.push({ key: RUN_META_KEY, value: { nextSeq: seq + 1 } });
  /* The new check is the newest of both rings, so 499 committed checks stay
     beside it in each. A check of this project past that is past both rings.
     The one check this append pushes out of the global ring stays while its
     own project still keeps it; its project's later appends remove it. */
  const doomed = new Set(ringOverflow(location, `${RUN_PREFIX}${projectKey}:`, "key", SEAT_TICK_RUN_HISTORY - 1, RETENTION_PAGE));
  for (const candidate of ringOverflow(location, RUN_PREFIX, "order", SEAT_TICK_RUN_HISTORY - 1, 1)) {
    const owner = candidate.slice(RUN_PREFIX.length, candidate.lastIndexOf(":"));
    if (doomed.has(candidate) || owner === projectKey) continue;
    const ownBound = ringOverflow(location, `${RUN_PREFIX}${owner}:`, "key", SEAT_TICK_RUN_HISTORY, 1)[0];
    if (ownBound !== undefined && candidate <= ownBound) doomed.add(candidate);
  }
  const deleteKeys = [...doomed].flatMap((runRow) => [runRow, `${TIMING_PREFIX}${runRow.slice(RUN_PREFIX.length)}`]);
  return { records, deleteKeys };
}

/** The synchronous append, for settlement and refusal lines written where
 * they happen. Its commit does not wait for the disk, as the legacy append did
 * not; see `appendSeatTickRecordOnThisThread`. */
export function appendSeatTickRecord(record: SeatTickRunRecord, filePath = seatTickJournalPath()): void {
  const stored = storedSeatTickRun(record);
  if (!stored) return;
  const location = seatTickLocation(filePath);
  withViewerOperation("seat-tick.audit", () => {
    const collection = writableJournal(location);
    collection.patchSync(() => seatTickAppendPatch(location, collection, stored), { durability: "process" });
  });
}

/** The check awaits the append. In the Viewer it runs on the seat tick
 * journal's worker thread (`seatTickJournalWorker.ts`), so the transaction
 * never blocks the Viewer thread; elsewhere it runs here. */
export async function appendSeatTickRecordAsync(record: SeatTickRunRecord, filePath = seatTickJournalPath()): Promise<void> {
  const offThread = appendThroughSeatTickJournalWorker(record, filePath);
  if (offThread) return offThread;
  return appendSeatTickRecordOnThisThread(record, filePath);
}

/** The append on the calling thread. A busy database is waited for up to a
 * second, as the legacy file lock was, yielding between attempts. The commit
 * survives the process and does not wait for the disk: the legacy rings were
 * appended and trimmed without an fsync. */
export async function appendSeatTickRecordOnThisThread(record: SeatTickRunRecord, filePath = seatTickJournalPath()): Promise<void> {
  const stored = storedSeatTickRun(record);
  if (!stored) return;
  const location = seatTickLocation(filePath);
  await waitForStateLock("seat-tick.audit", () => {
    const collection = writableJournal(location);
    collection.patchSync(() => seatTickAppendPatch(location, collection, stored), { durability: "process" });
  }, { waitMs: 1_000, subject: location.collection });
}

function seatTickProjectJournalPath(project: string, filePath: string): string {
  return path.join(seatTickProjectsRoot(filePath), `${seatTickProjectKey(project)}.ndjson`);
}

function seatTickProjectsRoot(filePath: string): string {
  return `${filePath}.projects`;
}

/** The newest `limit` checks, oldest first, scoped before limiting. */
export function readSeatTickRecords(limit: number, filePath = seatTickJournalPath(), project?: string): SeatTickRunRecord[] {
  const location = seatTickLocation(filePath);
  if (readableJournal(location)) return readStoredSeatTickRuns(location, limit, project, true);
  return readLegacySeatTickRecords(limit, filePath, project);
}

/** The compact fields needed to reconcile a check-error alarm: the timing
 * rows are never read, so this post-check bookkeeping reads a few hundred
 * bytes per check and leaves its phase history unread. */
export function readSeatTickAlarmRecords(limit: number, filePath = seatTickJournalPath(), project?: string): SeatTickRunRecord[] {
  const location = seatTickLocation(filePath);
  if (readableJournal(location)) return readStoredSeatTickRuns(location, limit, project, false);
  return readLegacySeatTickAlarmRecords(limit, filePath, project);
}

/* ------------------------------------------------- legacy reads and import */

function readLegacySeatTickRecords(limit: number, filePath: string, project?: string): SeatTickRunRecord[] {
  if (project !== undefined) {
    const scoped = seatTickProjectJournalPath(project, filePath);
    if (fs.existsSync(scoped)) return readJournalRecords(limit, { filePath: scoped, sanitize: sanitizeSeatTickRecord });
    // Existing installations keep their old journal until their first new check.
    return readJournalRecords(Number.MAX_SAFE_INTEGER, { filePath, sanitize: sanitizeSeatTickRecord })
      .filter(row => row.project === project).slice(-Math.max(0, limit));
  }
  return readJournalRecords(limit, { filePath, sanitize: sanitizeSeatTickRecord });
}

/** Skip each record's potentially large timing value before JSON.parse. */
function readLegacySeatTickAlarmRecords(limit: number, filePath: string, project?: string): SeatTickRunRecord[] {
  const scoped = project === undefined ? filePath : seatTickProjectJournalPath(project, filePath);
  let source = scoped;
  if (project !== undefined && !fs.existsSync(scoped)) source = filePath;
  let raw: string;
  try { raw = fs.readFileSync(source, "utf8"); }
  catch { return []; }
  const rows: SeatTickRunRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const compact = omitTopLevelJsonProperty(line, "timing");
      const row = sanitizeSeatTickRecord(JSON.parse(compact));
      if (row && (project === undefined || row.project === project)) rows.push(row);
    } catch { /* A malformed line does not hide records around it. */ }
  }
  return rows.slice(-Math.max(0, limit));
}

/** Every readable line of an ndjson ring; a torn line is skipped, as readers did. */
function ndjsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line) as unknown); } catch { continue; }
  }
  return values;
}

type SeatTickImport = { runs: { run: StoredSeatTickRun; timing: unknown }[] };

/**
 * Both legacy rings as one list in check order. The global ring holds the
 * newest checks of every project in the order they were made, and each of its
 * lines is also the newest line of its project's ring; every other project
 * line is older than all of them. So those older lines come first, merged
 * across projects by check time with each project's own order kept, and the
 * global ring follows as it stood. A line that appears in both rings is one
 * check.
 */
function mergedSeatTickRings(globalValues: readonly unknown[], projectsRoot: string): SeatTickImport["runs"] {
  const global = globalValues.flatMap((value) => {
    const stored = storedSeatTickRun(value);
    return stored ? [stored] : [];
  });
  const covered = new Map<string, Map<string, number>>();
  for (const { run } of global) {
    const owner = seatTickProjectKey(run.project);
    const counts = covered.get(owner) ?? new Map<string, number>();
    counts.set(run.i, (counts.get(run.i) ?? 0) + 1);
    covered.set(owner, counts);
  }
  const older: SeatTickImport["runs"][] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(projectsRoot).filter((name) => /^[0-9a-f]{64}\.ndjson$/.test(name)).sort(); }
  catch { names = []; }
  for (const name of names) {
    let text: string;
    try { text = fs.readFileSync(path.join(projectsRoot, name), "utf8"); }
    catch { continue; }
    const runs = ndjsonValues(text).flatMap((value) => {
      const stored = storedSeatTickRun(value);
      return stored ? [stored] : [];
    });
    /* The global ring's lines of this project are its newest: match them from
       the end, one line each, and keep what came before. */
    const counts = new Map(covered.get(name.slice(0, 64)) ?? []);
    const kept: SeatTickImport["runs"] = [];
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const left = counts.get(runs[index]!.run.i) ?? 0;
      if (left > 0) { counts.set(runs[index]!.run.i, left - 1); continue; }
      kept.push(runs[index]!);
    }
    older.push(kept.reverse());
  }
  const merged: SeatTickImport["runs"] = [];
  const heads = older.map(() => 0);
  for (;;) {
    let pick = -1;
    for (let queue = 0; queue < older.length; queue += 1) {
      const candidate = older[queue]![heads[queue]!];
      if (!candidate) continue;
      if (pick < 0 || candidate.run.at < older[pick]![heads[pick]!]!.run.at) pick = queue;
    }
    if (pick < 0) break;
    merged.push(older[pick]![heads[pick]!]!);
    heads[pick] = heads[pick]! + 1;
  }
  return [...merged, ...global];
}

function seatTickRows(runs: SeatTickImport["runs"], firstSeq: number): JournalRow[] {
  const rows: JournalRow[] = [];
  runs.forEach(({ run, timing }, index) => {
    const key = runKey(seatTickProjectKey(run.project), firstSeq + index);
    rows.push({ key: `${RUN_PREFIX}${key}`, value: run });
    if (timing) rows.push({ key: `${TIMING_PREFIX}${key}`, value: timing });
  });
  return rows;
}

/** Rename the per-project rings aside with the global ring, or remove an
    untouched mirror of them. Nothing is left in their place: an older writer
    fails on the global ring's tombstone before any line counts as journaled. */
function retireSeatTickProjectRings(filePath: string, mode: "keep" | "delete", suffix: string): void {
  const root = seatTickProjectsRoot(filePath);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); }
  catch { return; }
  if (!stat.isDirectory()) return;
  if (mode === "delete") fs.rmSync(root, { recursive: true, force: true });
  else {
    const target = fs.existsSync(`${root}.${suffix}`) ? `${root}.${suffix}-${Date.now()}` : `${root}.${suffix}`;
    fs.renameSync(root, target);
  }
  fsyncPath(path.dirname(root));
}

/**
 * Fold rings a rollback release (or an older writer) appended to back into
 * the collection. Journal lines only accumulate, so this is a union: each line
 * the collection does not already hold, counted once per occurrence, joins
 * after every stored check in ring order. Nothing is removed.
 */
function mergeLegacySeatTickRings(filePath: string, imported: SeatTickImport, options: { fenceOwner: boolean; consumedSha256?: string }): LegacyReconcileSummary {
  const location = seatTickLocation(filePath);
  const collection = openJournalCollection(location);
  const summary: LegacyReconcileSummary = { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
  collection.patchSync(() => {
    const held = new Map<string, number>();
    for (let offset = 0; ; offset += 4096) {
      const page = readStateRowsPage(location.database, location.collection, { prefix: RUN_PREFIX, limit: 4096, offset });
      for (const row of page?.rows ?? []) {
        const run = decodeStoredRun(row.valueJson) as Partial<StoredSeatTickRun> | null;
        if (typeof run?.i === "string") held.set(run.i, (held.get(run.i) ?? 0) + 1);
      }
      if (!page || page.rows.length < 4096) break;
    }
    const added = imported.runs.filter(({ run }) => {
      const left = held.get(run.i) ?? 0;
      if (left > 0) { held.set(run.i, left - 1); summary.kept += 1; return false; }
      return true;
    });
    if (added.length === 0) return { records: [] };
    const meta = collection.get(RUN_META_KEY)?.value as { nextSeq?: unknown } | undefined;
    const firstSeq = Number.isSafeInteger(meta?.nextSeq) && (meta!.nextSeq as number) > 0 ? meta!.nextSeq as number : 1;
    const records = seatTickRows(added, firstSeq);
    summary.added = added.length;
    summary.keys.push(...records.filter((row) => row.key.startsWith(RUN_PREFIX)).map((row) => row.key));
    return { records: [...records, { key: RUN_META_KEY, value: { nextSeq: firstSeq + added.length } }] };
  }, {
    fenceOwner: options.fenceOwner,
    ...(options.consumedSha256 ? { afterPersist: (db) => {
      const result = db.query("UPDATE state_imports SET reconciled_sha256 = ? WHERE collection = ?").run(options.consumedSha256!, location.collection);
      if (result.changes !== 1) throw new Error(`missing import evidence for ${location.collection} reconciliation`);
    } } : {}),
  });
  return summary;
}

/** Both rings as files, from one collection revision, for a rollback release
    that predates the move: the per-project rings are written first, and the
    global ring is the body the shared helper publishes last. */
function seatTickMirror(filePath: string): { body: unknown; revision: number; text: string } {
  const location = seatTickLocation(filePath);
  const collection = openJournalCollection(location);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = collection.revision();
    const owners = new Set<string>();
    for (let offset = 0; ; offset += 4096) {
      const page = readStateRowsPage(location.database, location.collection, { prefix: RUN_PREFIX, limit: 4096, offset, keysOnly: true });
      for (const row of page?.rows ?? []) owners.add(row.key.slice(RUN_PREFIX.length, row.key.lastIndexOf(":")));
      if (!page || page.rows.length < 4096) break;
    }
    const lines = (prefix: string, by: "key" | "order", descending: boolean, limit: number) => {
      const page = readStateRowsPage(location.database, location.collection, {
        prefix, by, descending, limit, companion: { from: RUN_PREFIX, to: TIMING_PREFIX },
      });
      const rows = descending ? [...page?.rows ?? []].reverse() : page?.rows ?? [];
      return rows.flatMap((row) => {
        const run = decodeStoredRun(row.valueJson) as StoredSeatTickRun | null;
        return run ? [seatTickLine(run, decodeStoredRun(row.companionJson))] : [];
      });
    };
    const root = seatTickProjectsRoot(filePath);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const owner of [...owners].sort()) {
      const text = lines(`${RUN_PREFIX}${owner}:`, "key", false, SEAT_TICK_RUN_HISTORY);
      if (text.length) writeTextDurably(path.join(root, `${owner}.ndjson`), `${text.join("\n")}\n`);
    }
    fsyncPath(path.dirname(root));
    const global = lines(RUN_PREFIX, "order", true, SEAT_TICK_RUN_HISTORY);
    if (collection.revision() !== revision) continue;
    return { body: global, revision, text: global.length ? `${global.join("\n")}\n` : "" };
  }
  throw new Error(`${location.collection} rollback checkpoint did not converge`);
}

/** The seat tick journal's import spec, for the import driver and its tests. */
export function seatTickJournalLegacyCollection(filePath = seatTickJournalPath()): LegacyCollectionSpec<SeatTickImport> {
  const location = seatTickLocation(filePath);
  return {
    collection: location.collection,
    schemaVersion: 1,
    migrationId: "seat-tick-runs-ndjson-v1",
    legacyPath: filePath,
    databasePath: location.database,
    decode: (bytes) => ({ ok: true, value: ndjsonValues(bytes.toString("utf8")) }),
    /* The per-project rings are read here, under the global ring's lock,
       which every legacy writer held for both. */
    parse: (raw) => ({ runs: mergedSeatTickRings(Array.isArray(raw) ? raw : [], seatTickProjectsRoot(filePath)) }),
    toRows: ({ runs }) => [
      ...seatTickRows(runs, 1),
      { key: RUN_META_KEY, value: { nextSeq: runs.length + 1 } },
    ].map((row) => ({ key: row.key, value: row, controllerActive: true })),
    retireCompanions: (mode, suffix) => retireSeatTickProjectRings(filePath, mode, suffix),
    reconcile: (imported, _baseline, options) => mergeLegacySeatTickRings(filePath, imported, options),
    mirrorBody: () => seatTickMirror(filePath),
  };
}

/** Import the seat tick rings now. The Viewer's activation calls this with
    `reconcile: true`; tests drive the crash seams through `hooks`. */
export function importLegacySeatTickJournal(
  filePath = seatTickJournalPath(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return importLegacyCollection(seatTickJournalLegacyCollection(filePath), options);
}

/** Write both rings from SQLite for a rollback release that predates the move. */
export function checkpointSeatTickJournalRollbackMirrorForDemotion(filePath = seatTickJournalPath()): void {
  writeLegacyRollbackMirror(seatTickJournalLegacyCollection(filePath));
}

/** Remove one top-level JSON property without parsing its value. */
function omitTopLevelJsonProperty(json: string, property: string): string {
  let cursor = 1;
  while (cursor < json.length) {
    while (/[\s,]/.test(json[cursor] ?? "")) cursor++;
    if (json[cursor] === "}") return json;
    if (json[cursor] !== '"') return json;
    const keyStart = cursor;
    cursor++;
    let escaped = false;
    while (cursor < json.length) {
      const char = json[cursor++]!;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    const keyEnd = cursor;
    while (/\s/.test(json[cursor] ?? "")) cursor++;
    if (json[cursor++] !== ":") return json;
    while (/\s/.test(json[cursor] ?? "")) cursor++;
    const valueStart = cursor;
    if (json.slice(keyStart + 1, keyEnd - 1) === property) {
      cursor = skipJsonValue(json, cursor);
      let end = cursor;
      while (/\s/.test(json[end] ?? "")) end++;
      if (json[end] === ",") return json.slice(0, keyStart) + json.slice(end + 1);
      let start = keyStart;
      while (start > 0 && /\s/.test(json[start - 1]!)) start--;
      if (json[start - 1] === ",") start--;
      return json.slice(0, start) + json.slice(end);
    }
    cursor = skipJsonValue(json, valueStart);
    while (/\s/.test(json[cursor] ?? "")) cursor++;
    if (json[cursor] === "}") return json;
  }
  return json;
}

function skipJsonValue(json: string, start: number): number {
  if (json[start] === '"') {
    let escaped = false;
    for (let cursor = start + 1; cursor < json.length; cursor++) {
      const char = json[cursor]!;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') return cursor + 1;
    }
    return json.length;
  }
  if (json[start] !== "{" && json[start] !== "[") {
    let end = start;
    while (end < json.length && json[end] !== "," && json[end] !== "}") end++;
    return end;
  }
  const stack = [json[start] === "{" ? "}" : "]"];
  let quoted = false, escaped = false;
  for (let cursor = start + 1; cursor < json.length; cursor++) {
    const char = json[cursor]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() === char && stack.length === 0) return cursor + 1;
    }
  }
  return json.length;
}
