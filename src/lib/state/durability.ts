import type { Database as BunDatabase } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { assertStateStartupMutation } from "@/lib/stateOwnership";

import { databaseFileIdentity, databaseSwapMarker } from "./currentDatabase";
import { fsyncPath, writeJsonDurably } from "./durableJson";

/**
 * The state databases survive a crash (#1870 slice 10,
 * docs/design/state-sqlite-migration.md §7).
 *
 * - At activation, each database is checked before this release's stores open
 *   it. One that fails to open or to pass its check is moved aside (never
 *   deleted) and replaced by the newest backup that passes `integrity_check`,
 *   or, when none does, left absent so its store creates a fresh empty one and
 *   serves an empty store instead of errors. Other processes may hold it open;
 *   their connections are bound to the file at the name (currentDatabase.ts),
 *   and the swap holds the damaged file's write lock, so none of them commits
 *   into the files set aside.
 * - While the release owns traffic, a timer finds each database due for a copy
 *   that changed since its last one, and a worker process takes the
 *   `VACUUM INTO` backups and prunes the generations to the retention tiers
 *   and a size budget, off the Viewer's thread.
 * - Every fallback, a failed one, a refused backup and a failing backup are recorded in
 *   `storage-incidents.json`. That record has to live outside the databases it
 *   describes; the files route reads it into `systemHealth.storage`, and the
 *   activation raises a board card for each fallback.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const BACKUP_DIRECTORY = path.join("backups", "sqlite");
export const STORAGE_INCIDENTS_FILE = "storage-incidents.json";
export const BACKUP_BUDGET_BYTES = 2 * 1024 ** 3;
/** Backups are never evicted below this many per database, even over budget. */
const PROTECTED_GENERATIONS = 3;
const INCIDENT_VISIBLE_MS = 7 * DAY;
const INCIDENT_RECORD_CAP = 50;
/** A temp file younger than this is never swept: its writer may be alive in a
    PID namespace this process cannot see (MCP processes run on the host). */
const TEMP_SWEEP_MIN_AGE_MS = HOUR;
/** Linux `pid_max` ceiling; a longer digit run in a temp name is a timestamp. */
const PID_MAX = 4_194_304;

export type BackupRetention =
  /** The newest 6, then one per 4 hours for 24 hours, then one per day for 3 days. */
  | { kind: "tiered" }
  | { kind: "newest"; count: number };

export interface StateDatabase {
  name: string;
  filename: string;
  check: "integrity_check" | "quick_check";
  backup: { intervalMs: number; retention: BackupRetention } | null;
  /** A content revision, so an unchanged database is not copied again. When it
      is null or fails, the file signature stands in. */
  revisionSql: string | null;
}

export function stateDatabases(stateDirectory: string): StateDatabase[] {
  const at = (name: string) => path.join(stateDirectory, name);
  return [
    {
      name: "state.sqlite",
      filename: at("state.sqlite"),
      check: "integrity_check",
      backup: { intervalMs: 10 * MINUTE, retention: { kind: "tiered" } },
      revisionSql: "SELECT (SELECT COUNT(*) FROM state_collections) || ':' || (SELECT COALESCE(SUM(revision), 0) FROM state_collections) AS revision",
    },
    {
      name: "agent-registry.sqlite",
      filename: at("agent-registry.sqlite"),
      check: "integrity_check",
      backup: { intervalMs: 10 * MINUTE, retention: { kind: "tiered" } },
      revisionSql: "SELECT value AS revision FROM registry_meta WHERE key = 'revision'",
    },
    {
      name: "mcp-receipts.sqlite",
      filename: at("mcp-receipts.sqlite"),
      check: "quick_check",
      backup: { intervalMs: DAY, retention: { kind: "newest", count: 3 } },
      revisionSql: null,
    },
    {
      name: "handoff-queue.sqlite",
      filename: at("handoff-queue.sqlite"),
      check: "quick_check",
      backup: null,
      revisionSql: null,
    },
  ];
}

export interface StorageIncident {
  kind: "database-restored" | "database-fresh" | "database-fallback-failed" | "backup-skipped-low-space" | "backup-failed";
  database: string;
  at: string;
  message: string;
  /** The damaged files, kept beside the database (names in the state directory). */
  corruptFiles: string[];
  /** The backup the database was restored from (a name in `backups/sqlite`). */
  backup: string | null;
  backupAt: string | null;
  backupAgeMs: number | null;
  /** What the check or the open reported. */
  detail: string | null;
}

/* ---- the SQLite seam ------------------------------------------------------ */

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("state database durability requires the Bun runtime");
  return sqlite.Database;
}

type Verdict = { verdict: "ok" } | { verdict: "corrupt"; detail: string } | { verdict: "unknown"; detail: string };

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code ? `${code}: ${error.message}` : error.message;
}

/** Only damage counts as damage. A busy, locked or unreadable file is left
    alone: moving a healthy database aside would be the outage itself. */
function isCorruptionError(error: unknown): boolean {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^SQLITE_(CORRUPT|NOTADB)/.test(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database disk image is malformed|file is not a database/i.test(message);
}

function inspect(filename: string, pragma: StateDatabase["check"], readonly: boolean): Verdict {
  let db: BunDatabase | null = null;
  try {
    const Database = sqliteDatabase();
    db = readonly ? new Database(filename, { readonly: true }) : new Database(filename, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = db.query<Record<string, unknown>, []>(`PRAGMA ${pragma}`).all();
    const messages = rows.map((row) => String(Object.values(row)[0]));
    if (messages.length === 1 && messages[0] === "ok") return { verdict: "ok" };
    return { verdict: "corrupt", detail: `${pragma}: ${messages.slice(0, 5).join("; ") || "no result"}` };
  } catch (error) {
    return isCorruptionError(error)
      ? { verdict: "corrupt", detail: errorText(error) }
      : { verdict: "unknown", detail: errorText(error) };
  } finally {
    db?.close();
  }
}

function readRevision(database: StateDatabase): string {
  if (database.revisionSql) {
    let db: BunDatabase | null = null;
    try {
      db = new (sqliteDatabase())(database.filename, { readonly: true });
      db.exec("PRAGMA busy_timeout = 5000");
      const row = db.query<{ revision: unknown }, []>(database.revisionSql).get();
      if (row && row.revision !== null && row.revision !== undefined) return `rev:${String(row.revision)}`;
    } catch {
      /* A database without the table yet: the signature stands in. */
    } finally {
      db?.close();
    }
  }
  return `sig:${fileSignature(database.filename)}`;
}

function fileSignature(filename: string): string {
  const parts: string[] = [];
  for (const candidate of [filename, `${filename}-wal`]) {
    try {
      const stat = fs.statSync(candidate, { bigint: true });
      parts.push(`${stat.size}@${stat.mtimeNs}`);
    } catch {
      parts.push("missing");
    }
  }
  return parts.join("|");
}

/* ---- files ---------------------------------------------------------------- */

function removeTrio(filename: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${filename}${suffix}`, { force: true });
}

function exists(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch {
    return false;
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

const STAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

function parseStamp(value: string): number | null {
  const match = STAMP_PATTERN.exec(value);
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function backupPrefix(database: string): string {
  return `${database.replace(/\.sqlite$/, "")}-`;
}

interface BackupFile {
  name: string;
  file: string;
  at: number;
  bytes: number;
}

/** A database's completed backups, newest first. */
export function listBackups(backupDirectory: string, database: string): BackupFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDirectory);
  } catch {
    return [];
  }
  const prefix = backupPrefix(database);
  const found: BackupFile[] = [];
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".sqlite")) continue;
    const at = parseStamp(name.slice(prefix.length, -".sqlite".length));
    if (at === null) continue;
    const file = path.join(backupDirectory, name);
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { continue; }
    found.push({ name, file, at, bytes });
  }
  return found.sort((left, right) => right.at - left.at);
}

/* ---- incidents ------------------------------------------------------------ */

function incidentsFile(stateDirectory: string): string {
  return path.join(stateDirectory, STORAGE_INCIDENTS_FILE);
}

/** The record cannot be rebuilt, so a file that does not parse is kept aside
    as `.unreadable-<ts>` (the cache discard would erase the evidence). */
function readIncidentRecord(stateDirectory: string): StorageIncident[] {
  const file = incidentsFile(stateDirectory);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const kept = `${file}.unreadable-${stamp(new Date())}`;
    try {
      fs.renameSync(file, kept);
      console.error(`[state durability] ${STORAGE_INCIDENTS_FILE} did not parse (${errorText(error)}); kept as ${path.basename(kept)}`);
    } catch {
      /* Renamed by another reader meanwhile. */
    }
    return [];
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { incidents?: unknown }).incidents)) return [];
  return ((raw as { incidents: unknown[] }).incidents).filter((incident): incident is StorageIncident =>
    Boolean(incident) && typeof incident === "object"
    && typeof (incident as StorageIncident).kind === "string"
    && typeof (incident as StorageIncident).database === "string"
    && typeof (incident as StorageIncident).at === "string");
}

function recordIncident(stateDirectory: string, incident: StorageIncident): void {
  const incidents = [...readIncidentRecord(stateDirectory), incident].slice(-INCIDENT_RECORD_CAP);
  try {
    writeJsonDurably(incidentsFile(stateDirectory), { version: 1, incidents });
  } catch (error) {
    console.error(`[state durability] could not record the incident: ${errorText(error)}`);
  }
  console.error(`[state durability] ${incident.kind} ${incident.database}: ${incident.message}`);
}

/** The incidents of the last week, oldest first: `systemHealth.storage`. */
export function readStorageIncidents(stateDirectory: string, options: { now?: Date } = {}): StorageIncident[] {
  const now = (options.now ?? new Date()).getTime();
  return readIncidentRecord(stateDirectory).filter((incident) => {
    const at = Date.parse(incident.at);
    return Number.isFinite(at) && now - at <= INCIDENT_VISIBLE_MS;
  });
}

/** Record an incident unless one of its kind for its database was recorded
    in the last day: once a day is enough to say backups are not being taken. */
function recordIncidentDaily(stateDirectory: string, incident: StorageIncident, now: Date): void {
  const previous = readIncidentRecord(stateDirectory).findLast((recorded) =>
    recorded.kind === incident.kind && recorded.database === incident.database);
  if (!previous || now.getTime() - Date.parse(previous.at) >= DAY) recordIncident(stateDirectory, incident);
}

/* ---- activation: check and fall back -------------------------------------- */

export type DatabaseCheckOutcome =
  | { state: "absent" }
  | { state: "ok" }
  | { state: "unchecked"; detail: string }
  | { state: "restored" | "fresh" | "failed"; incident: StorageIncident };

/** Test seam: runs before each step of the swap, so a test can fail one. */
export type SwapStepHook = (step: "set-aside-main" | "set-aside-wal" | "set-aside-shm" | "restore") => void;

export function checkDatabaseAtActivation(
  database: StateDatabase,
  options: { stateDirectory: string; backupDirectory?: string; now?: Date; beforeSwapStep?: SwapStepHook },
): DatabaseCheckOutcome {
  /* A marker left by a swap that died would refuse every open until it aged. */
  fs.rmSync(databaseSwapMarker(database.filename), { force: true });
  if (!exists(database.filename)) return { state: "absent" };
  const verdict = inspect(database.filename, database.check, true);
  if (verdict.verdict === "ok") return { state: "ok" };
  if (verdict.verdict === "unknown") {
    console.error(`[state durability] ${database.name} could not be checked, left as it is: ${verdict.detail}`);
    return { state: "unchecked", detail: verdict.detail };
  }
  const now = options.now ?? new Date();
  const backups = options.backupDirectory ?? path.join(options.stateDirectory, BACKUP_DIRECTORY);
  const base = { database: database.name, at: now.toISOString(), detail: verdict.detail };
  /* The replacement is copied and checked before the damaged files are touched. */
  const restored = prepareNewestGoodBackup(database, backups);
  const swap = swapDamagedDatabase(database.filename, now, restored ? restoringName(database.filename) : null, options.beforeSwapStep);
  if (swap.error !== null) {
    removeTrio(restoringName(database.filename));
    const left = exists(database.filename);
    const incident: StorageIncident = {
      ...base,
      kind: "database-fallback-failed",
      corruptFiles: swap.corruptFiles,
      backup: null,
      backupAt: null,
      backupAgeMs: null,
      message: `${database.name} was damaged (${verdict.detail}) and the fallback failed (${swap.error}). `
        + (left
          ? "The damaged database is still in place and may keep failing."
          : "It starts empty.")
        + (swap.corruptFiles.length ? ` The damaged files are kept as ${swap.corruptFiles.join(", ")}.` : ""),
    };
    recordIncident(options.stateDirectory, incident);
    return { state: "failed", incident };
  }
  const corruptFiles = swap.corruptFiles;
  if (restored) {
    const backupAt = new Date(restored.at).toISOString();
    const incident: StorageIncident = {
      ...base,
      corruptFiles,
      kind: "database-restored",
      backup: restored.name,
      backupAt,
      backupAgeMs: now.getTime() - restored.at,
      message: `${database.name} was damaged (${verdict.detail}) and was restored from the backup taken at ${backupAt}. `
        + `Changes written after ${backupAt} are lost. The damaged files are kept as ${corruptFiles.join(", ")}.`,
    };
    recordIncident(options.stateDirectory, incident);
    return { state: "restored", incident };
  }
  const incident: StorageIncident = {
    ...base,
    corruptFiles,
    kind: "database-fresh",
    backup: null,
    backupAt: null,
    backupAgeMs: null,
    message: `${database.name} was damaged (${verdict.detail}) and no backup passed its check, so it starts empty. `
      + `The damaged files are kept as ${corruptFiles.join(", ")}.`,
  };
  recordIncident(options.stateDirectory, incident);
  return { state: "fresh", incident };
}

function restoringName(filename: string): string {
  return `${filename}.restoring`;
}

/** Copy the newest backup that passes `integrity_check` to `<db>.restoring`,
    ready to be renamed over the damaged file. */
function prepareNewestGoodBackup(database: StateDatabase, backupDirectory: string): BackupFile | null {
  const restoring = restoringName(database.filename);
  for (const candidate of listBackups(backupDirectory, database.name)) {
    removeTrio(restoring);
    try {
      fs.copyFileSync(candidate.file, restoring);
      const verdict = inspect(restoring, "integrity_check", false);
      if (verdict.verdict !== "ok" || exists(`${restoring}-wal`)) {
        throw new Error(verdict.verdict === "ok" ? "it left a WAL behind" : verdict.detail);
      }
      fs.rmSync(`${restoring}-shm`, { force: true });
      fs.chmodSync(restoring, 0o600);
      fsyncPath(restoring);
      return candidate;
    } catch (error) {
      console.error(`[state durability] backup ${candidate.name} refused: ${errorText(error)}`);
    }
  }
  removeTrio(restoring);
  return null;
}

/**
 * Move the damaged database aside as `<db>.corrupt-<ts>{,-wal,-shm}` and put
 * the prepared copy (if any) under its name. Other processes may hold the
 * damaged file open, so while the files move:
 * - a marker makes every guarded open refuse (currentDatabase.ts), so nothing
 *   opens the damaged main file without its WAL and leaves a foreign WAL
 *   beside the restored one;
 * - this process holds the damaged file's write lock, so a writer that began
 *   before the marker commits before the move, and one blocked behind the lock
 *   finds the file replaced and rolls back.
 * The damaged main file is hard-linked aside and the copy renamed over its
 * name, so the name is never absent while a restore is under way.
 */
function swapDamagedDatabase(
  filename: string,
  now: Date,
  restoring: string | null,
  beforeStep: SwapStepHook | undefined,
): { corruptFiles: string[]; error: string | null } {
  const target = `${filename}.corrupt-${stamp(now)}`;
  const corruptFiles: string[] = [];
  const marker = databaseSwapMarker(filename);
  let lock: BunDatabase | null = null;
  let error: string | null = null;
  try {
    fs.writeFileSync(marker, `${process.pid}\n`, { mode: 0o600 });
    lock = holdWriteLock(filename);
    let mainAside = false;
    if (restoring) {
      beforeStep?.("set-aside-main");
      try {
        fs.linkSync(filename, target);
      } catch {
        fs.renameSync(filename, target);
      }
      mainAside = true;
      corruptFiles.push(path.basename(target));
    }
    for (const suffix of ["-wal", "-shm"] as const) {
      if (!exists(`${filename}${suffix}`)) continue;
      beforeStep?.(suffix === "-wal" ? "set-aside-wal" : "set-aside-shm");
      fs.renameSync(`${filename}${suffix}`, `${target}${suffix}`);
      corruptFiles.push(path.basename(`${target}${suffix}`));
    }
    if (restoring) {
      beforeStep?.("restore");
      fs.renameSync(restoring, filename);
    } else if (!mainAside) {
      beforeStep?.("set-aside-main");
      fs.renameSync(filename, target);
      corruptFiles.unshift(path.basename(target));
    }
  } catch (caught) {
    error = errorText(caught);
    /* Never leave the damaged main file without its WAL under the name: it
       is set aside too, so the store starts empty rather than half-read. */
    try {
      if (exists(filename) && databaseFileIdentity(filename) === databaseFileIdentity(target)) {
        fs.unlinkSync(filename);
      } else if (exists(filename) && !exists(target) && corruptFiles.length) {
        fs.renameSync(filename, target);
        corruptFiles.unshift(path.basename(target));
      }
    } catch (cleanup) {
      error = `${error}; setting the damaged file aside also failed: ${errorText(cleanup)}`;
    }
  } finally {
    if (lock) {
      try { lock.exec("ROLLBACK"); } catch { /* no transaction */ }
      /* The file has moved, so SQLite neither checkpoints nor deletes a WAL. */
      try { lock.close(); } catch { /* already closed */ }
    }
    fs.rmSync(marker, { force: true });
    try {
      fsyncPath(path.dirname(filename));
    } catch (caught) {
      console.error(`[state durability] the state directory could not be synced after the swap: ${errorText(caught)}`);
    }
  }
  return { corruptFiles, error };
}

/** The damaged file's write lock, when its header still opens. A file whose
    header is gone cannot be written by anyone, so there is nothing to hold. */
function holdWriteLock(filename: string): BunDatabase | null {
  let db: BunDatabase | null = null;
  try {
    db = new (sqliteDatabase())(filename, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* not open */ }
    if (!isCorruptionError(error)) console.error(`[state durability] ${path.basename(filename)} write lock not taken: ${errorText(error)}`);
    return null;
  }
}

/** Check every state database before any store opens one. Returns the
    fallbacks taken; each is already recorded durably. */
export function checkStateDatabasesAtActivation(
  stateDirectory: string,
  options: { now?: Date; backupDirectory?: string; beforeSwapStep?: SwapStepHook } = {},
): StorageIncident[] {
  /* Swapping a damaged database aside is a startup mutation: against the
     operator's own directory it belongs to the activating Viewer (#1905). */
  assertStateStartupMutation(stateDirectory, "state database activation check");
  const incidents: StorageIncident[] = [];
  for (const database of stateDatabases(stateDirectory)) {
    try {
      const outcome = checkDatabaseAtActivation(database, { stateDirectory, ...options });
      if ("incident" in outcome) incidents.push(outcome.incident);
    } catch (error) {
      console.error(`[state durability] ${database.name} check failed: ${errorText(error)}`);
    }
  }
  return incidents;
}

/* ---- backups -------------------------------------------------------------- */

export type BackupOutcome =
  | { state: "disabled" | "absent" | "not-due" }
  | { state: "unchanged"; revision: string }
  | { state: "taken"; file: string; revision: string; bytes: number }
  | { state: "skipped-low-space"; incident: StorageIncident }
  | { state: "failed"; detail: string };

function defaultFreeBytes(directory: string): number | null {
  try {
    const stats = fs.statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function backupDatabase(
  database: StateDatabase,
  options: {
    backupDirectory: string;
    now?: Date;
    /** The revision of this database's last backup, when this process knows it. */
    lastRevision?: string | null;
    freeBytes?: (directory: string) => number | null;
  },
): BackupOutcome {
  if (!database.backup) return { state: "disabled" };
  if (!exists(database.filename)) return { state: "absent" };
  const now = options.now ?? new Date();
  const newest = listBackups(options.backupDirectory, database.name)[0];
  if (newest && now.getTime() - newest.at < database.backup.intervalMs) return { state: "not-due" };
  const revision = readRevision(database);
  if (options.lastRevision && options.lastRevision === revision) return { state: "unchanged", revision };

  fs.mkdirSync(options.backupDirectory, { recursive: true, mode: 0o700 });
  let size = 0;
  for (const suffix of ["", "-wal"]) {
    try { size += fs.statSync(`${database.filename}${suffix}`).size; } catch { /* no WAL */ }
  }
  const free = (options.freeBytes ?? defaultFreeBytes)(options.backupDirectory);
  if (free !== null && free < 2 * size) {
    const incident: StorageIncident = {
      kind: "backup-skipped-low-space",
      database: database.name,
      at: now.toISOString(),
      message: `The backup of ${database.name} was skipped: ${free} bytes are free and it needs twice the database (${2 * size} bytes).`
        + (newest ? ` The newest backup is from ${new Date(newest.at).toISOString()}.` : " There is no backup yet."),
      corruptFiles: [],
      backup: newest?.name ?? null,
      backupAt: newest ? new Date(newest.at).toISOString() : null,
      backupAgeMs: newest ? now.getTime() - newest.at : null,
      detail: null,
    };
    recordIncidentDaily(path.dirname(database.filename), incident, now);
    return { state: "skipped-low-space", incident };
  }

  const name = `${backupPrefix(database.name)}${stamp(now)}.sqlite`;
  const target = path.join(options.backupDirectory, name);
  const partial = `${target}.partial`;
  removeTrio(partial);
  let source: BunDatabase | null = null;
  try {
    /* `VACUUM INTO` holds only a read transaction: writers carry on. */
    source = new (sqliteDatabase())(database.filename, { readonly: true });
    source.exec("PRAGMA busy_timeout = 5000");
    source.query("VACUUM INTO ?").run(partial);
  } catch (error) {
    removeTrio(partial);
    return { state: "failed", detail: errorText(error) };
  } finally {
    source?.close();
  }
  try {
    /* A backup is one self-contained file: no WAL to lose beside it. */
    const copy = new (sqliteDatabase())(partial, { readwrite: true });
    try { copy.exec("PRAGMA journal_mode = DELETE"); } finally { copy.close(); }
    const verdict = inspect(partial, "integrity_check", false);
    if (verdict.verdict !== "ok") throw new Error(`the copy failed its check: ${verdict.verdict === "corrupt" ? verdict.detail : verdict.detail}`);
    fs.rmSync(`${partial}-shm`, { force: true });
    fs.chmodSync(partial, 0o600);
    fsyncPath(partial);
    fs.renameSync(partial, target);
    fsyncPath(options.backupDirectory);
  } catch (error) {
    removeTrio(partial);
    return { state: "failed", detail: errorText(error) };
  }
  return { state: "taken", file: target, revision, bytes: fs.statSync(target).size };
}

/** Apply each database's retention, then the shared size budget: the oldest
    generations go first and the newest three of each database never do. */
export function pruneBackups(
  backupDirectory: string,
  databases: readonly StateDatabase[],
  options: { now?: Date; budgetBytes?: number } = {},
): string[] {
  const now = (options.now ?? new Date()).getTime();
  const budget = options.budgetBytes ?? BACKUP_BUDGET_BYTES;
  const removed: string[] = [];
  const remove = (backup: BackupFile) => {
    try {
      fs.rmSync(backup.file, { force: true });
      removed.push(backup.name);
    } catch (error) {
      console.error(`[state durability] could not evict ${backup.name}: ${errorText(error)}`);
    }
  };
  const kept: { backup: BackupFile; evictable: boolean }[] = [];
  for (const database of databases) {
    if (!database.backup) continue;
    const backups = listBackups(backupDirectory, database.name);
    const keep = retained(backups, database.backup.retention, now);
    backups.forEach((backup, index) => {
      if (!keep.has(backup)) remove(backup);
      else kept.push({ backup, evictable: index >= PROTECTED_GENERATIONS });
    });
  }
  let total = kept.reduce((sum, entry) => sum + entry.backup.bytes, 0);
  const evictable = kept.filter((entry) => entry.evictable).sort((left, right) => left.backup.at - right.backup.at);
  for (const entry of evictable) {
    if (total <= budget) break;
    remove(entry.backup);
    total -= entry.backup.bytes;
  }
  return removed;
}

function retained(backups: readonly BackupFile[], retention: BackupRetention, now: number): Set<BackupFile> {
  if (retention.kind === "newest") return new Set(backups.slice(0, retention.count));
  const keep = new Set(backups.slice(0, 6));
  const fourHourly = new Set<number>();
  const daily = new Set<number>();
  for (const backup of backups.slice(6)) {
    const age = now - backup.at;
    if (age <= DAY) {
      const bucket = Math.floor(backup.at / (4 * HOUR));
      if (fourHourly.size < 6 && !fourHourly.has(bucket)) {
        fourHourly.add(bucket);
        keep.add(backup);
      }
    } else if (age <= 4 * DAY) {
      const bucket = Math.floor(backup.at / DAY);
      if (daily.size < 3 && !daily.has(bucket)) {
        daily.add(bucket);
        keep.add(backup);
      }
    }
  }
  return keep;
}

/* ---- dead files ----------------------------------------------------------- */

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The writer PID a temp file name carries (`…<name>.<pid>.<nonce>.tmp`,
    `…<name>.<pid>.tmp`, `…<name>.<pid>-<ms>.tmp`), or null. */
function tempOwnerPid(name: string): number | null {
  for (const segment of name.slice(0, -".tmp".length).split(".")) {
    const match = /^(\d{1,7})(?:-\d+)?$/.exec(segment);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid > 0 && pid <= PID_MAX) return pid;
  }
  return null;
}

/** Remove temp files left in the state directory by killed writers: the
    owner PID is dead and the file is at least an hour old. */
export function sweepStaleTempFiles(
  directory: string,
  options: { now?: number; pidAlive?: (pid: number) => boolean; minAgeMs?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const alive = options.pidAlive ?? defaultPidAlive;
  const minAge = options.minAgeMs ?? TEMP_SWEEP_MIN_AGE_MS;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
    const pid = tempOwnerPid(entry.name);
    if (pid === null) continue;
    const file = path.join(directory, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs < minAge) continue;
      if (alive(pid)) continue;
      fs.unlinkSync(file);
      removed.push(entry.name);
    } catch {
      /* Renamed or removed by its writer meanwhile. */
    }
  }
  return removed;
}

/** Files nothing reads any more (design §2.3): `orchestrator.json`, and the
    zero-byte `pipelines.sqlite` and `registry.sqlite`. */
export function removeDeadStateFiles(directory: string): string[] {
  const removed: string[] = [];
  const dead: { name: string; onlyEmpty: boolean }[] = [
    { name: "orchestrator.json", onlyEmpty: false },
    { name: "pipelines.sqlite", onlyEmpty: true },
    { name: "registry.sqlite", onlyEmpty: true },
  ];
  for (const { name, onlyEmpty } of dead) {
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || (onlyEmpty && stat.size !== 0)) continue;
      fs.unlinkSync(file);
      removed.push(name);
    } catch {
      /* Absent. */
    }
  }
  return removed;
}

/* ---- the running release -------------------------------------------------- */

/** One backup pass over every database, then retention. `lastRevisions`
    carries what this process last copied, so an unchanged database is skipped. */
export function runBackupPass(
  stateDirectory: string,
  lastRevisions: Map<string, string>,
  options: { now?: Date; freeBytes?: (directory: string) => number | null; budgetBytes?: number } = {},
): Map<string, BackupOutcome> {
  assertStateStartupMutation(stateDirectory, "state backup pass");
  const databases = stateDatabases(stateDirectory);
  const backupDirectory = path.join(stateDirectory, BACKUP_DIRECTORY);
  const outcomes = new Map<string, BackupOutcome>();
  for (const database of databases) {
    let outcome: BackupOutcome;
    try {
      outcome = backupDatabase(database, {
        backupDirectory,
        ...(options.now ? { now: options.now } : {}),
        ...(options.freeBytes ? { freeBytes: options.freeBytes } : {}),
        lastRevision: lastRevisions.get(database.name) ?? null,
      });
    } catch (error) {
      outcome = { state: "failed", detail: errorText(error) };
    }
    if (outcome.state === "taken" || outcome.state === "unchanged") lastRevisions.set(database.name, outcome.revision);
    if (outcome.state === "failed") {
      const now = options.now ?? new Date();
      const newest = listBackups(backupDirectory, database.name)[0];
      recordIncidentDaily(stateDirectory, {
        kind: "backup-failed",
        database: database.name,
        at: now.toISOString(),
        message: `The backup of ${database.name} failed: ${outcome.detail}.`
          + (newest ? ` The newest good backup is from ${new Date(newest.at).toISOString()}.` : " There is no backup yet."),
        corruptFiles: [],
        backup: newest?.name ?? null,
        backupAt: newest ? new Date(newest.at).toISOString() : null,
        backupAgeMs: newest ? now.getTime() - newest.at : null,
        detail: outcome.detail,
      }, now);
    }
    outcomes.set(database.name, outcome);
  }
  try {
    pruneBackups(backupDirectory, databases, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.budgetBytes !== undefined ? { budgetBytes: options.budgetBytes } : {}),
    });
    sweepStalePartials(backupDirectory, (options.now ?? new Date()).getTime());
  } catch (error) {
    console.error(`[state durability] backup retention failed: ${errorText(error)}`);
  }
  return outcomes;
}

/** The databases due for a copy that changed since this process last copied
    them. This is the cheap part of a pass (a directory listing and one
    revision query each), so the Viewer runs it on its own thread and starts
    the backup worker only when something needs copying. */
export function backupsDue(stateDirectory: string, lastRevisions: ReadonlyMap<string, string>, now = new Date()): string[] {
  const backupDirectory = path.join(stateDirectory, BACKUP_DIRECTORY);
  return stateDatabases(stateDirectory).filter((database) => {
    if (!database.backup || !exists(database.filename)) return false;
    const newest = listBackups(backupDirectory, database.name)[0];
    if (newest && now.getTime() - newest.at < database.backup.intervalMs) return false;
    const last = lastRevisions.get(database.name);
    return !last || last !== readRevision(database);
  }).map((database) => database.name);
}

export interface BackupWorkerRequest {
  stateDirectory: string;
  lastRevisions: [string, string][];
}

export interface BackupWorkerResponse {
  outcomes: [string, BackupOutcome][];
}

/** The worker's side: one pass over the request, answered as one JSON line. */
export function answerBackupWorkerRequest(request: BackupWorkerRequest): BackupWorkerResponse {
  const outcomes = runBackupPass(request.stateDirectory, new Map(request.lastRevisions));
  return { outcomes: [...outcomes] };
}

const BACKUP_WORKER_TIMEOUT_MS = 15 * MINUTE;

export function stateBackupWorkerLaunch(cwd = process.cwd()): { executable: string; workerPath: string } {
  const source = path.join(cwd, "src/lib/stateBackup.worker.ts");
  const bundled = path.join(cwd, ".next/server/state-backup-worker.js");
  const bunContainer = "/usr/local/bin/bun-container";
  if (fs.existsSync(source) && fs.existsSync(bunContainer)) return { executable: bunContainer, workerPath: source };
  if (fs.existsSync(bundled)) {
    return { executable: process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun"), workerPath: bundled };
  }
  return { executable: process.execPath, workerPath: source };
}

/**
 * One backup pass in a process of its own. `VACUUM INTO`, the copy's
 * `integrity_check` and the fsync are synchronous SQLite and file calls that
 * take most of a second on the live databases; on the Viewer's thread they
 * would stall every request that long. Updates `lastRevisions` from what the
 * worker copied.
 */
export async function runBackupPassInWorker(
  stateDirectory: string,
  lastRevisions: Map<string, string>,
  options: { launch?: { executable: string; workerPath: string } } = {},
): Promise<Map<string, BackupOutcome>> {
  const launch = options.launch ?? stateBackupWorkerLaunch();
  const { spawn } = await import("node:child_process");
  const useNice = fs.existsSync("/usr/bin/nice");
  const child = spawn(useNice ? "/usr/bin/nice" : launch.executable, [
    ...(useNice ? ["-n", "10", launch.executable] : []),
    launch.workerPath,
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"], env: process.env });
  const request: BackupWorkerRequest = { stateDirectory, lastRevisions: [...lastRevisions] };
  const response = await new Promise<BackupWorkerResponse>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the backup worker ran past ${BACKUP_WORKER_TIMEOUT_MS} ms and was stopped`));
    }, BACKUP_WORKER_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stdin.on("error", () => { /* the exit below reports it */ });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error(`the backup worker exited with ${code ?? signal}`);
        resolve(JSON.parse(output.trim().split("\n").at(-1) ?? "") as BackupWorkerResponse);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
  const outcomes = new Map(response.outcomes);
  for (const [name, outcome] of outcomes) {
    if (outcome.state === "taken" || outcome.state === "unchanged") lastRevisions.set(name, outcome.revision);
  }
  return outcomes;
}

/** A `.partial` backup whose writer died mid-copy. */
function sweepStalePartials(backupDirectory: string, now: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDirectory);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/\.sqlite\.partial(-wal|-shm|-journal)?$/.test(name)) continue;
    const file = path.join(backupDirectory, name);
    try {
      if (now - fs.statSync(file).mtimeMs >= TEMP_SWEEP_MIN_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      /* Gone meanwhile. */
    }
  }
}

/** The board card for a fallback: the operator sees it where they look. */
export function storageIncidentTaskText(incident: StorageIncident): string {
  const title = incident.kind === "database-restored"
    ? `State database ${incident.database} was restored from a backup`
    : incident.kind === "database-fallback-failed"
      ? `State database ${incident.database} was damaged and could not be restored`
      : `State database ${incident.database} was damaged and started empty`;
  return `${title}\n\n${incident.message}`;
}

export function storageIncidentClientRequestId(incident: StorageIncident): string {
  return `storage-incident:${incident.database}:${incident.at}`;
}

interface DurabilityTimerStore {
  __llvStateDurabilityTimer?: ReturnType<typeof setInterval>;
}

const BACKUP_TICK_MS = MINUTE;

/**
 * After activation: sweep dead files, raise the board card for each fallback,
 * and arm the backup timer. The timer belongs to the release that owns
 * traffic; each tick asks, and a demoted release stops its own clock.
 */
export function startStateDurability(options: {
  stateDirectory: string;
  incidents: readonly StorageIncident[];
  ownsTraffic: () => boolean;
  raiseBoardCard?: (incident: StorageIncident) => Promise<void>;
  tickMs?: number;
  /** Test seam; the Viewer runs each pass in the backup worker. */
  runPass?: (stateDirectory: string, lastRevisions: Map<string, string>) => Promise<unknown>;
}): { stop(): void } {
  assertStateStartupMutation(options.stateDirectory, "state durability sweep");
  const store = globalThis as DurabilityTimerStore;
  if (store.__llvStateDurabilityTimer) clearInterval(store.__llvStateDurabilityTimer);
  try {
    sweepStaleTempFiles(options.stateDirectory);
    removeDeadStateFiles(options.stateDirectory);
  } catch (error) {
    console.error(`[state durability] cleanup failed: ${errorText(error)}`);
  }
  const raise = options.raiseBoardCard ?? ((incident) => raiseStorageIncidentCard(options.stateDirectory, incident));
  for (const incident of options.incidents) {
    void raise(incident).catch((error) => console.error(`[state durability] board card for ${incident.database} failed: ${errorText(error)}`));
  }
  const lastRevisions = new Map<string, string>();
  const runPass = options.runPass ?? runBackupPassInWorker;
  let running = false;
  const timer = setInterval(() => {
    if (!options.ownsTraffic()) {
      clearInterval(timer);
      if (store.__llvStateDurabilityTimer === timer) delete store.__llvStateDurabilityTimer;
      return;
    }
    if (running) return;
    let due: string[];
    try {
      due = backupsDue(options.stateDirectory, lastRevisions);
    } catch (error) {
      console.error(`[state durability] backup schedule failed: ${errorText(error)}`);
      return;
    }
    if (!due.length) return;
    running = true;
    void runPass(options.stateDirectory, lastRevisions)
      .catch((error: unknown) => console.error(`[state durability] backup pass failed: ${errorText(error)}`))
      .finally(() => { running = false; });
  }, options.tickMs ?? BACKUP_TICK_MS);
  timer.unref?.();
  store.__llvStateDurabilityTimer = timer;
  return {
    stop() {
      clearInterval(timer);
      if (store.__llvStateDurabilityTimer === timer) delete store.__llvStateDurabilityTimer;
    },
  };
}

/** The Viewer's own project, the one its board incident cards belong to. */
async function viewerProject(): Promise<string | null> {
  const [{ default: manifest }, { projectIdentityFromRemote }, { canonicalOrchestratorProject }] = await Promise.all([
    import("../../../package.json"),
    import("@/lib/projects/identity"),
    import("@/lib/orchestrator/seats"),
  ]);
  const remote = process.env.LLV_VIEWER_CANONICAL_REMOTE?.trim() || manifest.repository.url.trim();
  const project = projectIdentityFromRemote(remote, process.cwd())?.project ?? null;
  return project ? canonicalOrchestratorProject(project) : null;
}

export async function raiseStorageIncidentCard(
  stateDirectory: string,
  incident: StorageIncident,
  project?: string | null,
): Promise<void> {
  const owner = project === undefined ? await viewerProject() : project;
  if (!owner) {
    console.error(`[state durability] no Viewer project to put the ${incident.database} incident card on`);
    return;
  }
  const [{ mutateTasksFile }, { createTask }] = await Promise.all([
    import("@/lib/tasks/store"),
    import("@/lib/tasks/commands"),
  ]);
  mutateTasksFile((state) => {
    const created = createTask(state.tasks, {
      project: owner,
      text: storageIncidentTaskText(incident),
      placement: "unplaced",
      clientRequestId: storageIncidentClientRequestId(incident),
    }, state.recentCreates);
    if (!created.ok || created.replay) return { state: undefined, result: undefined };
    return { state: { ...state, tasks: created.tasks, recentCreates: created.recentCreates }, result: undefined };
  }, path.join(stateDirectory, "tasks.json"));
}
