import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { withFileTransactionAsync, withFileTransactionSync } from "@/lib/state/fileTransaction";
import { compactSeatTickTiming, sanitizeSeatTickTiming } from "./seatTickTiming";

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

export function appendSeatTickRecord(record: SeatTickRunRecord, filePath = seatTickJournalPath()): void {
  const projectFile = seatTickProjectJournalPath(record.project, filePath);
  const line = `${JSON.stringify(record.timing ? { ...record, timing: compactSeatTickTiming(record.timing) } : record)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // The global ring remains small. Each project's own ring is independent,
  // so unrelated checks cannot consume its diagnostic window.
  withViewerOperation("seat-tick.audit", () => withFileTransactionSync(filePath, "the seat tick journal is busy", () => {
    fs.mkdirSync(path.dirname(projectFile), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(projectFile)) {
      const legacy = readJournalRecords(SEAT_TICK_RUN_HISTORY, { filePath, sanitize: sanitizeSeatTickRecord })
        .filter(row => row.project === record.project);
      if (legacy.length) fs.writeFileSync(projectFile, `${legacy.map(row => JSON.stringify(row)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    }
    for (const target of [projectFile, filePath]) {
      fs.appendFileSync(target, line, { encoding: "utf8", mode: 0o600 });
      trim(target, SEAT_TICK_RUN_HISTORY);
    }
  }));
}

/** The check awaits durability, while file I/O stays off the Viewer thread.
 * Retention scans bytes backwards, avoiding decoding and copying every saved
 * phase in both rings on every append. Shares the legacy writer's lock. */
export async function appendSeatTickRecordAsync(record: SeatTickRunRecord, filePath = seatTickJournalPath()): Promise<void> {
  const projectFile = seatTickProjectJournalPath(record.project, filePath);
  const line = `${JSON.stringify(record.timing ? { ...record, timing: compactSeatTickTiming(record.timing) } : record)}\n`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await withFileTransactionAsync(filePath, "the seat tick journal is busy", async () => {
    await fs.promises.mkdir(path.dirname(projectFile), { recursive: true, mode: 0o700 });
    try { await fs.promises.access(projectFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let legacy = "";
      try { legacy = await fs.promises.readFile(filePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const rows = legacy.split("\n").flatMap(line => {
        try { const row = sanitizeSeatTickRecord(JSON.parse(line)); return row ? [row] : []; }
        catch { return []; }
      }).slice(-SEAT_TICK_RUN_HISTORY).filter(row => row.project === record.project);
      if (rows.length) await fs.promises.writeFile(projectFile, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
    }
    for (const target of [projectFile, filePath]) {
      await fs.promises.appendFile(target, line, { mode: 0o600 });
      const bytes = await fs.promises.readFile(target);
      let cursor = bytes.length - 1;
      for (let kept = 0; kept < SEAT_TICK_RUN_HISTORY && cursor >= 0; kept++) cursor = bytes.lastIndexOf(10, cursor - 1);
      if (cursor < 0) continue;
      const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temp, bytes.subarray(cursor + 1), { mode: 0o600 });
        await fs.promises.rename(temp, target);
      } finally { await fs.promises.rm(temp, { force: true }); }
    }
  }, { waitMs: 1_000 });
}

function seatTickProjectJournalPath(project: string, filePath: string): string {
  return path.join(`${filePath}.projects`, `${crypto.createHash("sha256").update(project).digest("hex")}.ndjson`);
}

/** The newest `limit` checks, oldest first, scoped before limiting. */
export function readSeatTickRecords(limit: number, filePath = seatTickJournalPath(), project?: string): SeatTickRunRecord[] {
  if (project !== undefined) {
    const scoped = seatTickProjectJournalPath(project, filePath);
    if (fs.existsSync(scoped)) return readJournalRecords(limit, { filePath: scoped, sanitize: sanitizeSeatTickRecord });
    // Existing installations keep their old journal until their first new check.
    return readJournalRecords(Number.MAX_SAFE_INTEGER, { filePath, sanitize: sanitizeSeatTickRecord })
      .filter(row => row.project === project).slice(-Math.max(0, limit));
  }
  return readJournalRecords(limit, { filePath, sanitize: sanitizeSeatTickRecord });
}

/** Read the compact fields needed to reconcile a check-error alarm. Skip each
 * record's potentially large timing value before JSON.parse so this post-check
 * bookkeeping never rebuilds the phase history on the Viewer thread. */
export function readSeatTickAlarmRecords(limit: number, filePath = seatTickJournalPath(), project?: string): SeatTickRunRecord[] {
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
