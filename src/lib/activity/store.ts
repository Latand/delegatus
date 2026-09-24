import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase } from "bun:sqlite";

import { statePath } from "@/lib/configDir";

import { EXCLUSION_REASONS, type ExclusionReason, type InputCandidate } from "./humanInput";
import type { AgentTurn, TranscriptFactsState } from "./transcriptExport";
import type { RequestKind, Surface } from "./method";

/*
 * Delegatus's own record of operator input (docs/design/activity-dashboard.md,
 * "Continuous ingest"): `<state>/activity/records.sqlite`.
 *
 * - `activity_inputs`: one row per operator input, keyed per host. This host's
 *   rows are written by the ingest as transcripts are indexed (host `''`);
 *   another host's rows arrive by pull under that host's id. A row holds opaque
 *   ids, a content hash, a time, a project, a kind, a surface and an opaque
 *   conversation digest, the fields an export keeps. No text and no path.
 * - `activity_input_ids`: which row each id of this host already names, so a
 *   copy of an input in a second store (a shared mirror, an account store, a
 *   resumed transcript) joins its row instead of writing another.
 * - `activity_files`: the ingest's durable cursor per transcript, the byte
 *   offset read up to and what the lines before it said, committed in the same
 *   transaction as the rows those lines produced.
 * - `activity_turns`: agent turns, one row per turn of a conversation, from
 *   what started it to its last record of work, with the conversation's
 *   project, engine, role and pipeline stage. A turn still running is stored
 *   as far as it has been read and extended by the next read.
 * - `activity_hosts`: what each host was read for, when, and what was excluded.
 *
 * `version` rises on every write of a row, so a reader that remembers the
 * highest version it saw receives each new or merged row exactly once more.
 */

export const LOCAL_HOST_KEY = "";
const SCHEMA_VERSION = 1;
const ID_DOMAIN = "delegatus-activity-record-v1";

type Database = BunDatabase;

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("The activity store requires the Bun runtime");
  return sqlite.Database;
}

export function activityStorePath(): string {
  return statePath("activity", "records.sqlite");
}

/** One stored input, as rows cross hosts. */
export interface StoredInput {
  key: string;
  version: number;
  at: number;
  project: string | null;
  kind: RequestKind;
  surface: Surface;
  hash: string;
  conversation: string;
  ids: string[];
}

/** One stored agent turn, as rows cross hosts. */
export interface StoredTurn {
  key: string;
  version: number;
  conversation: string;
  project: string | null;
  engine: "claude" | "codex";
  role: string;
  pipelineId: string | null;
  stageId: string | null;
  start: number;
  end: number;
}

/** What the ingest knows about the conversation a transcript belongs to. */
export interface TurnOwner {
  /** A stable identity: the registry conversation, else the session. */
  conversation: string;
  project: string | null;
  engine: "claude" | "codex";
  role: string;
  pipelineId: string | null;
  stageId: string | null;
}

export interface FileCursor {
  offset: number;
  size: number;
  mtimeMs: number;
  facts: TranscriptFactsState;
  prompted: boolean;
}

export interface HostState {
  coveredFrom: number | null;
  coveredUntil: number | null;
  /** The last read that finished: an ingest pass, or a pull that answered. */
  readAt: number | null;
  /** The last attempt, successful or not. */
  attemptAt: number | null;
  /** Why the last attempt did not read, as a short class; null when it did. */
  error: string | null;
  /** The highest remote version a pull has received. */
  cursor: number;
  excluded: Partial<Record<ExclusionReason, number>>;
}

type InputRow = {
  key: string; version: number; at: number; project: string | null; kind: string; surface: string;
  hash: string; conversation: string; ids: string;
};

type TurnRow = {
  key: string; version: number; conversation: string; project: string | null; engine: string; role: string;
  pipeline: string | null; stage: string | null; start: number; end: number;
};

function storedTurn(row: TurnRow): StoredTurn {
  return {
    key: row.key,
    version: row.version,
    conversation: row.conversation,
    project: row.project,
    engine: row.engine === "codex" ? "codex" : "claude",
    role: row.role,
    pipelineId: row.pipeline,
    stageId: row.stage,
    start: row.start,
    end: row.end,
  };
}

type HostRow = {
  covered_from: number | null; covered_until: number | null; read_at: number | null; attempt_at: number | null;
  error: string | null; cursor: number; excluded: string;
};

function parseIds(value: string): string[] {
  try {
    const ids = JSON.parse(value) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parseExcluded(value: string): Partial<Record<ExclusionReason, number>> {
  const out: Partial<Record<ExclusionReason, number>> = {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    for (const reason of EXCLUSION_REASONS) {
      const count = parsed?.[reason];
      if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) out[reason] = count;
    }
  } catch {
    /* An unreadable counter reads as nothing excluded. */
  }
  return out;
}

function storedInput(row: InputRow): StoredInput {
  return {
    key: row.key,
    version: row.version,
    at: row.at,
    project: row.project,
    kind: row.kind as RequestKind,
    surface: row.surface as Surface,
    hash: row.hash,
    conversation: row.conversation,
    ids: parseIds(row.ids),
  };
}

/** The opaque conversation identity a row carries: the fan-out rule needs to
    know two copies came from one conversation, never which one. */
export function conversationDigest(conversation: string): string {
  return crypto.createHash("sha256").update(`${ID_DOMAIN}\0conversation\0${conversation}`).digest("hex").slice(0, 32);
}

/** The key of a row no id names: its conversation, content and time. */
function contentKey(candidate: InputCandidate): string {
  return `k:${crypto.createHash("sha256").update(`${ID_DOMAIN}\0${candidate.conversation}\0${candidate.textHash}\0${candidate.at}`).digest("hex")}`;
}

export class ActivityStore {
  private constructor(readonly db: Database, readonly readonly: boolean) {}

  /** The writer: creates the file and its schema. */
  static open(file: string = activityStorePath()): ActivityStore {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const Database = sqliteDatabase();
    const db = new Database(file, { create: true, strict: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_inputs (
          host TEXT NOT NULL,
          key TEXT NOT NULL,
          version INTEGER NOT NULL,
          at INTEGER NOT NULL,
          project TEXT,
          kind TEXT NOT NULL,
          surface TEXT NOT NULL,
          hash TEXT NOT NULL,
          conversation TEXT NOT NULL,
          ids TEXT NOT NULL,
          PRIMARY KEY (host, key)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS activity_inputs_at ON activity_inputs(host, at);
        CREATE INDEX IF NOT EXISTS activity_inputs_version ON activity_inputs(host, version);
        CREATE TABLE IF NOT EXISTS activity_input_ids (
          host TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (host, id)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS activity_files (
          path TEXT PRIMARY KEY,
          offset INTEGER NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          facts TEXT NOT NULL,
          prompted INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activity_turns (
          host TEXT NOT NULL,
          key TEXT NOT NULL,
          version INTEGER NOT NULL,
          conversation TEXT NOT NULL,
          project TEXT,
          engine TEXT NOT NULL,
          role TEXT NOT NULL,
          pipeline TEXT,
          stage TEXT,
          start INTEGER NOT NULL,
          "end" INTEGER NOT NULL,
          PRIMARY KEY (host, key)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS activity_turns_time ON activity_turns(host, "end", start);
        CREATE INDEX IF NOT EXISTS activity_turns_version ON activity_turns(host, version);
        CREATE TABLE IF NOT EXISTS activity_hosts (
          host TEXT PRIMARY KEY,
          covered_from INTEGER,
          covered_until INTEGER,
          read_at INTEGER,
          attempt_at INTEGER,
          error TEXT,
          cursor INTEGER NOT NULL DEFAULT 0,
          excluded TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS activity_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO activity_meta VALUES (1, 0);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
        try { fs.chmodSync(candidate, 0o600); } catch { /* Not created yet. */ }
      }
      return new ActivityStore(db, false);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** A reader, or null when nothing was ever recorded here. */
  static openReadOnly(file: string = activityStorePath()): ActivityStore | null {
    if (!fs.existsSync(file)) return null;
    const Database = sqliteDatabase();
    const db = new Database(file, { readonly: true, strict: true });
    try {
      db.exec("PRAGMA busy_timeout = 250; PRAGMA query_only = ON;");
      if ((db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0) < SCHEMA_VERSION) {
        db.close();
        return null;
      }
      return new ActivityStore(db, true);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Never opened. */ }
      throw error;
    }
  }

  private nextVersion(): number {
    return this.db.query<{ version: number }, []>("UPDATE activity_meta SET version = version + 1 WHERE singleton = 1 RETURNING version").get()!.version;
  }

  fileCursor(file: string): FileCursor | null {
    const row = this.db.query<{ offset: number; size: number; mtime_ms: number; facts: string; prompted: number }, [string]>(
      "SELECT offset, size, mtime_ms, facts, prompted FROM activity_files WHERE path = ?",
    ).get(file);
    if (!row) return null;
    let facts: TranscriptFactsState;
    try {
      facts = JSON.parse(row.facts) as TranscriptFactsState;
    } catch {
      return null;
    }
    return { offset: row.offset, size: row.size, mtimeMs: row.mtime_ms, facts, prompted: row.prompted === 1 };
  }

  /** Every cursor path, for the pass that forgets transcripts gone from disk. */
  cursorPaths(): string[] {
    return this.db.query<{ path: string }, []>("SELECT path FROM activity_files").all().map((row) => row.path);
  }

  forgetFile(file: string): void {
    this.db.query("DELETE FROM activity_files WHERE path = ?").run(file);
  }

  /**
   * One piece of one transcript: its operator inputs, the counts it excluded,
   * the earliest record it held, and the cursor after it — all or nothing, so
   * a restart resumes exactly where the last commit ended.
   */
  commitFile(
    file: string,
    cursor: FileCursor,
    candidates: readonly InputCandidate[],
    excluded: Partial<Record<ExclusionReason, number>>,
    earliest: number | null,
    turns: { owner: TurnOwner; turns: readonly AgentTurn[] } | null = null,
  ): number {
    return this.transaction(() => {
      let written = 0;
      for (const candidate of candidates) if (this.recordLocal(candidate)) written += 1;
      if (turns) for (const turn of turns.turns) this.recordTurn(turns.owner, turn);
      this.db.query(`
        INSERT INTO activity_files(path, offset, size, mtime_ms, facts, prompted) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtime_ms = excluded.mtime_ms,
          facts = excluded.facts, prompted = excluded.prompted
      `).run(file, cursor.offset, cursor.size, cursor.mtimeMs, JSON.stringify(cursor.facts), cursor.prompted ? 1 : 0);
      const current = this.hostState(LOCAL_HOST_KEY);
      const counts = { ...(current?.excluded ?? {}) };
      for (const [reason, count] of Object.entries(excluded) as Array<[ExclusionReason, number]>) counts[reason] = (counts[reason] ?? 0) + count;
      if (!current) this.db.query("INSERT INTO activity_hosts(host) VALUES (?)").run(LOCAL_HOST_KEY);
      this.db.query("UPDATE activity_hosts SET excluded = ? WHERE host = ?").run(JSON.stringify(counts), LOCAL_HOST_KEY);
      if (earliest !== null) {
        this.db.query("UPDATE activity_hosts SET covered_from = MIN(COALESCE(covered_from, ?), ?) WHERE host = ?").run(earliest, earliest, LOCAL_HOST_KEY);
      }
      return written;
    });
  }

  /** Record one input of this host. A copy an id already names joins that
      row (the earliest time wins, the ids unite) and writes nothing new.
      Returns whether a new row was written. */
  private recordLocal(candidate: InputCandidate): boolean {
    const findId = this.db.query<{ key: string }, [string, string]>("SELECT key FROM activity_input_ids WHERE host = ? AND id = ?");
    let existing: string | null = null;
    for (const id of candidate.ids) {
      existing = findId.get(LOCAL_HOST_KEY, id)?.key ?? null;
      if (existing) break;
    }
    const conversation = conversationDigest(candidate.conversation);
    const addIds = (key: string) => {
      const insert = this.db.query("INSERT OR IGNORE INTO activity_input_ids(host, id, key) VALUES (?, ?, ?)");
      for (const id of candidate.ids) insert.run(LOCAL_HOST_KEY, id, key);
    };
    if (existing) {
      const row = this.db.query<InputRow, [string, string]>("SELECT * FROM activity_inputs WHERE host = ? AND key = ?").get(LOCAL_HOST_KEY, existing);
      if (!row) return false;
      const ids = [...new Set([...parseIds(row.ids), ...candidate.ids])].sort();
      const at = Math.min(row.at, candidate.at);
      if (ids.length !== parseIds(row.ids).length || at !== row.at) {
        this.db.query("UPDATE activity_inputs SET ids = ?, at = ?, version = ? WHERE host = ? AND key = ?")
          .run(JSON.stringify(ids), at, this.nextVersion(), LOCAL_HOST_KEY, existing);
      }
      addIds(existing);
      return false;
    }
    const key = candidate.ids.length ? [...candidate.ids].sort()[0]! : contentKey(candidate);
    const inserted = this.db.query(`
      INSERT OR IGNORE INTO activity_inputs(host, key, version, at, project, kind, surface, hash, conversation, ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(LOCAL_HOST_KEY, key, this.nextVersion(), candidate.at, candidate.project, candidate.kind, candidate.surface,
      candidate.textHash, conversation, JSON.stringify([...candidate.ids].sort()));
    addIds(key);
    return inserted.changes > 0;
  }

  /** Record one turn of this host. The same turn read from a second copy of
      the transcript, or read again further along, extends the one row. */
  private recordTurn(owner: TurnOwner, turn: AgentTurn): void {
    const conversation = conversationDigest(owner.conversation);
    const key = `t:${crypto.createHash("sha256").update(`${ID_DOMAIN}\0turn\0${conversation}\0${turn.start}`).digest("hex")}`;
    const current = this.db.query<{ end: number; project: string | null; role: string; pipeline: string | null; stage: string | null }, [string, string]>(
      `SELECT "end", project, role, pipeline, stage FROM activity_turns WHERE host = ? AND key = ?`,
    ).get(LOCAL_HOST_KEY, key);
    if (current && current.end >= turn.end && current.project === owner.project && current.role === owner.role
      && current.pipeline === owner.pipelineId && current.stage === owner.stageId) return;
    this.db.query(`
      INSERT INTO activity_turns(host, key, version, conversation, project, engine, role, pipeline, stage, start, "end")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host, key) DO UPDATE SET version = excluded.version, project = excluded.project, role = excluded.role,
        pipeline = excluded.pipeline, stage = excluded.stage, "end" = MAX(activity_turns."end", excluded."end")
    `).run(LOCAL_HOST_KEY, key, this.nextVersion(), conversation, owner.project, owner.engine, owner.role,
      owner.pipelineId, owner.stageId, turn.start, turn.end);
  }

  /** Turns another host sent, under that host's id, like its inputs. */
  upsertPulledTurns(host: string, turns: readonly StoredTurn[]): number {
    let changed = 0;
    const upsert = this.db.query(`
      INSERT INTO activity_turns(host, key, version, conversation, project, engine, role, pipeline, stage, start, "end")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host, key) DO UPDATE SET version = excluded.version, conversation = excluded.conversation,
        project = excluded.project, engine = excluded.engine, role = excluded.role, pipeline = excluded.pipeline,
        stage = excluded.stage, start = excluded.start, "end" = excluded."end"
      WHERE excluded.version > activity_turns.version
    `);
    for (const turn of turns) {
      changed += upsert.run(host, turn.key, turn.version, turn.conversation, turn.project, turn.engine, turn.role,
        turn.pipelineId, turn.stageId, turn.start, turn.end).changes;
    }
    return changed;
  }

  /** A host's turns that overlap [start, end]. */
  turns(host: string, start: number, end: number): StoredTurn[] {
    return this.db.query<TurnRow, [string, number, number]>(
      `SELECT key, version, conversation, project, engine, role, pipeline, stage, start, "end" FROM activity_turns
       WHERE host = ? AND "end" >= ? AND start <= ? ORDER BY start`,
    ).all(host, start, end).map(storedTurn);
  }

  /** This host's turns written after `version`, oldest write first. */
  localTurnsAfter(version: number, limit: number): StoredTurn[] {
    return this.db.query<TurnRow, [string, number, number]>(
      `SELECT key, version, conversation, project, engine, role, pipeline, stage, start, "end" FROM activity_turns
       WHERE host = ? AND version > ? ORDER BY version LIMIT ?`,
    ).all(LOCAL_HOST_KEY, version, limit).map(storedTurn);
  }

  /** Rows another host sent, under that host's id: new keys are written,
      known keys take the sender's newer version, and a replay changes nothing. */
  upsertPulled(host: string, rows: readonly StoredInput[]): number {
    let changed = 0;
    const upsert = this.db.query(`
      INSERT INTO activity_inputs(host, key, version, at, project, kind, surface, hash, conversation, ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host, key) DO UPDATE SET version = excluded.version, at = excluded.at, project = excluded.project,
        kind = excluded.kind, surface = excluded.surface, hash = excluded.hash, conversation = excluded.conversation, ids = excluded.ids
      WHERE excluded.version > activity_inputs.version
    `);
    for (const row of rows) {
      changed += upsert.run(host, row.key, row.version, row.at, row.project, row.kind, row.surface, row.hash, row.conversation,
        JSON.stringify([...row.ids].sort())).changes;
    }
    return changed;
  }

  /** A host's rows with `at` inside [start, end], as candidates for the
      dedupe rules. */
  candidates(host: string, start: number, end: number, label: string): InputCandidate[] {
    return this.db.query<InputRow, [string, number, number]>(
      "SELECT key, version, at, project, kind, surface, hash, conversation, ids FROM activity_inputs WHERE host = ? AND at >= ? AND at <= ? ORDER BY at",
    ).all(host, start, end).map((row) => {
      const input = storedInput(row);
      return {
        at: input.at, host: label, project: input.project, kind: input.kind, surface: input.surface,
        ids: input.ids, textHash: input.hash, conversation: input.conversation,
      };
    });
  }

  /** This host's rows written after `version`, oldest write first. */
  localRowsAfter(version: number, limit: number): StoredInput[] {
    return this.db.query<InputRow, [string, number, number]>(
      "SELECT key, version, at, project, kind, surface, hash, conversation, ids FROM activity_inputs WHERE host = ? AND version > ? ORDER BY version LIMIT ?",
    ).all(LOCAL_HOST_KEY, version, limit).map(storedInput);
  }

  count(host: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM activity_inputs WHERE host = ?").get(host)?.n ?? 0;
  }

  hostState(host: string): HostState | null {
    const row = this.db.query<HostRow, [string]>("SELECT * FROM activity_hosts WHERE host = ?").get(host);
    if (!row) return null;
    return {
      coveredFrom: row.covered_from,
      coveredUntil: row.covered_until,
      readAt: row.read_at,
      attemptAt: row.attempt_at,
      error: row.error,
      cursor: row.cursor,
      excluded: parseExcluded(row.excluded),
    };
  }

  setHostState(host: string, patch: Partial<HostState>): void {
    const current = this.hostState(host) ?? { coveredFrom: null, coveredUntil: null, readAt: null, attemptAt: null, error: null, cursor: 0, excluded: {} };
    const next = { ...current, ...patch };
    this.db.query(`
      INSERT INTO activity_hosts(host, covered_from, covered_until, read_at, attempt_at, error, cursor, excluded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET covered_from = excluded.covered_from, covered_until = excluded.covered_until,
        read_at = excluded.read_at, attempt_at = excluded.attempt_at, error = excluded.error, cursor = excluded.cursor,
        excluded = excluded.excluded
    `).run(host, next.coveredFrom, next.coveredUntil, next.readAt, next.attemptAt, next.error, next.cursor, JSON.stringify(next.excluded));
  }
}
