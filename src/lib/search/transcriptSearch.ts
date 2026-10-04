import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import type { Database as BunDatabase } from "bun:sqlite";

import { statePath } from "@/lib/configDir";
import { SNIPPET_MATCH_CLOSE, SNIPPET_MATCH_OPEN } from "./snippet";
import { isFunctionWord, queryUnits, widerExpression, type QueryUnit } from "./queryUnits";
import { resolveProjectScope, type ProjectScope } from "./projectScope";

export const TRANSCRIPT_SEARCH_TOKENIZER = "FTS5 unicode61, remove_diacritics=0, tokenchars=#_";
/** Library pages reserve room for titles in HTTP and decoded MCP pages. */
export const TRANSCRIPT_RELEVANCE_PAGE_BYTES = 12 * 1024;
const RELEVANCE_SNIPPET_BYTES = 512;

export class TranscriptSearchPageTooLargeError extends Error {
  constructor() {
    super("transcript search metadata exceeds the page byte budget; refine the query or project scope");
    this.name = "TranscriptSearchPageTooLargeError";
  }
}

export const TRANSCRIPT_SEARCH_FIELDS = ["message.body"] as const;

export interface TranscriptIndexSource {
  path: string;
  project: string;
  engine: "claude" | "codex" | "copilot";
  size: number;
  mtimeMs: number;
}

/** Who authored an indexed message. The operator's own prompts are `user`. */
export type TranscriptSpeaker = "user" | "assistant";

export interface TranscriptSearchItem {
  snippet: string;
  speaker: TranscriptSpeaker;
  /** Number of indexed occurrences collapsed into this result. */
  duplicateCount: number;
  /** Unix seconds; undated records use the file time captured when first indexed. */
  timestamp: number | null;
  transcriptPath: string;
  byteOffset: number;
  lineNumber: number;
  project: string;
  engine: "claude" | "codex" | "copilot";
  matched?: string[];
  missing?: string[];
  fragments?: Array<Pick<TranscriptSearchItem, "snippet" | "speaker" | "timestamp" | "byteOffset" | "lineNumber">>;
  alsoIn?: { count: number; transcriptPaths: string[] };
}

export interface TranscriptCorpusStats {
  conversationsIndexed: number;
  messagesIndexed: number;
  fieldsSearched: readonly string[];
  tokenizer: string;
}

export interface TranscriptSearchResult {
  items: TranscriptSearchItem[];
  nextCursor: string | null;
  total: number;
  stats: TranscriptCorpusStats;
  order?: "newest" | "relevance";
  interpretedAs?: { units: string[]; ignored: string[] };
  projectScope?: ProjectScope;
  /** Conversations covering at least 60% of interpreted units, before folding. */
  strongTotal?: number;
}

export interface ParsedTranscriptMessage {
  body: string;
  speaker: "user" | "assistant";
  timestamp: number | null;
  byteOffset: number;
  lineNumber: number;
}

export type TranscriptMessageReader = (
  source: TranscriptIndexSource,
) => AsyncIterable<ParsedTranscriptMessage>;

export interface TranscriptIndexOptions {
  complete?: boolean;
  readMessages?: TranscriptMessageReader;
}

export interface TranscriptIndexResult {
  filesRead: number;
  filesSkipped: number;
  messagesIndexed: number;
  failures: Array<{ path: string; error: string }>;
}

export class InvalidTranscriptSearchCursorError extends Error {
  constructor() {
    super("transcript search cursor is invalid or belongs to another query");
    this.name = "InvalidTranscriptSearchCursorError";
  }
}

type Database = BunDatabase;

type FileIdentityRow = {
  size: number;
  mtime_ms: number;
  project: string;
  engine: string;
};

/** One matched message as the ranking pass reads it: `values()` tuples,
    because a common word matches a third of the corpus and the objects would
    cost more than the query. */
type HitRow = [
  id: number,
  speaker: TranscriptSpeaker,
  bodyHash: string,
  timestamp: number,
  transcriptPath: string,
];

type TranscriptFileRow = {
  project: string;
  engine: "claude" | "codex" | "copilot";
  mtime_ms: number;
};

interface RankedHit {
  id: number;
  speaker: TranscriptSpeaker;
  timestamp: number;
  transcriptPath: string;
}

/** One result row: the newest occurrence of a body, and how many the index
    holds for that speaker. */
interface CollapsedHit {
  newest: RankedHit;
  duplicateCount: number;
}

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("Transcript search requires the Bun runtime");
  return sqlite.Database;
}

const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 5;
const TRANSCRIPT_SEARCH_MIGRATION_BATCH_SIZE = 256;
const scheduledSearchIndexes = new Set<string>();
const readySearchDatabases = new WeakSet<Database>();
// Readiness is schema metadata. Invalidate on either replacement of the file
// or a schema change; ordinary appends keep the same readiness. Bound the cache
// because tests and offline tools can choose many independent state roots.
const searchSchemas = new Map<string, { identity: string; schema: number; version: number; hit: number; vocabulary: number }>();
const newestExpressions = new Map<string, string>();

function normalizedBodyHash(body: string): string {
  const normalized = body.trim().replace(/\s+/gu, " ");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function schemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

function hasBodyHashColumn(db: Database): boolean {
  return db.query<{ name: string }, []>("PRAGMA table_info(transcript_messages)").all()
    .some((column) => column.name === "body_hash");
}

function migrateSearchSchema(db: Database): void {
  const currentVersion = schemaVersion(db);
  if (currentVersion >= TRANSCRIPT_SEARCH_SCHEMA_VERSION && hasBodyHashColumn(db)) return;
  if (currentVersion < 4) db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!hasBodyHashColumn(db)) db.exec("ALTER TABLE transcript_messages ADD COLUMN body_hash TEXT");
    const pendingMessages = db.query<{ id: number; body: string }, [number, number]>(`
      SELECT id, body FROM transcript_messages WHERE body_hash IS NULL AND id > ?
      ORDER BY id
      LIMIT ?
    `);
    const update = db.query("UPDATE transcript_messages SET body_hash = ? WHERE id = ?");
    let lastId = 0;
    while (true) {
      const messages = pendingMessages.all(lastId, TRANSCRIPT_SEARCH_MIGRATION_BATCH_SIZE);
      for (const message of messages) update.run(normalizedBodyHash(message.body), message.id);
      if (messages.length < TRANSCRIPT_SEARCH_MIGRATION_BATCH_SIZE) break;
      lastId = messages.at(-1)!.id;
    }
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(transcript_messages)").all();
    if (!columns.some((column) => column.name === "sort_timestamp")) {
      // Adding the nullable column is metadata-only. Backfilling every row
      // belongs to background work; readers use timestamp/file time meanwhile.
      db.exec("ALTER TABLE transcript_messages ADD COLUMN sort_timestamp REAL");
    }
    if (currentVersion < 4) {
      db.exec(`
        ALTER TABLE transcript_messages RENAME TO transcript_messages_previous;
        ALTER TABLE transcript_files RENAME TO transcript_files_previous;
        CREATE TABLE transcript_files (
          path TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          project TEXT NOT NULL,
          engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex', 'copilot')),
          messages_count INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        );
        INSERT INTO transcript_files SELECT * FROM transcript_files_previous;
        CREATE TABLE transcript_messages (
          id INTEGER PRIMARY KEY,
          transcript_path TEXT NOT NULL,
          message_index INTEGER NOT NULL,
          speaker TEXT NOT NULL CHECK(speaker IN ('user', 'assistant')),
          timestamp INTEGER,
          byte_offset INTEGER NOT NULL,
          line_number INTEGER NOT NULL,
          body TEXT NOT NULL,
          body_hash TEXT NOT NULL,
          sort_timestamp REAL,
          UNIQUE(transcript_path, message_index),
          FOREIGN KEY(transcript_path) REFERENCES transcript_files(path) ON DELETE CASCADE
        );
        INSERT INTO transcript_messages SELECT * FROM transcript_messages_previous;
        DROP TABLE transcript_messages_previous;
        DROP TABLE transcript_files_previous;
        CREATE INDEX IF NOT EXISTS transcript_messages_path
          ON transcript_messages(transcript_path, message_index);
        UPDATE transcript_messages
          SET sort_timestamp = COALESCE(timestamp,
            (SELECT mtime_ms / 1000.0 FROM transcript_files WHERE path = transcript_path))
          WHERE sort_timestamp IS NULL;
      `);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_search_sequence (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), last_id INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO transcript_search_sequence VALUES
        (1, (SELECT COALESCE(MAX(id), 0) FROM transcript_messages));
      PRAGMA user_version = ${Math.max(currentVersion, TRANSCRIPT_SEARCH_SCHEMA_VERSION)};
      COMMIT;
    `);
    if (currentVersion < 4) db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
    if (currentVersion < 4) db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function openWriterDatabase(): Database {
  const filename = statePath("transcript-search.sqlite");
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const Database = sqliteDatabase();
  const db = new Database(filename, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        project TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex', 'copilot')),
        messages_count INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_messages (
        id INTEGER PRIMARY KEY,
        transcript_path TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        speaker TEXT NOT NULL CHECK(speaker IN ('user', 'assistant')),
        timestamp INTEGER,
        byte_offset INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        UNIQUE(transcript_path, message_index),
        FOREIGN KEY(transcript_path) REFERENCES transcript_files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS transcript_messages_path
        ON transcript_messages(transcript_path, message_index);
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_messages_fts USING fts5(
        body,
        tokenize = "unicode61 remove_diacritics 0 tokenchars '#_'"
      );
    `);
    migrateSearchSchema(db);
    if (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM transcript_messages").get()!.n === 0) {
      /* Empty fresh indexes are cheap to create before the first indexing pass. */
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS transcript_messages_vocab
          USING fts5vocab(transcript_messages_fts, row);
        CREATE INDEX IF NOT EXISTS transcript_messages_search_hit
          ON transcript_messages(id, speaker, body_hash, sort_timestamp, transcript_path);
        CREATE INDEX IF NOT EXISTS transcript_messages_time
          ON transcript_messages(sort_timestamp, speaker, transcript_path, timestamp);
      `);
    }
    secureDatabaseFiles(filename);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Upgrade a legacy index and build its read accelerators outside the request thread. */
export function prepareTranscriptSearchIndexInBackground(): void {
  const filename = statePath("transcript-search.sqlite");
  const db = openWriterDatabase();
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_messages_vocab
        USING fts5vocab(transcript_messages_fts, row);
      UPDATE transcript_messages
      SET sort_timestamp = COALESCE(timestamp,
        (SELECT mtime_ms / 1000.0 FROM transcript_files WHERE path = transcript_path))
      WHERE sort_timestamp IS NULL;
      CREATE INDEX IF NOT EXISTS transcript_messages_search_hit
        ON transcript_messages(id, speaker, body_hash, sort_timestamp, transcript_path);
      CREATE INDEX IF NOT EXISTS transcript_messages_time
        ON transcript_messages(sort_timestamp, speaker, transcript_path, timestamp);
      CREATE INDEX IF NOT EXISTS transcript_messages_body_hash
        ON transcript_messages(speaker, body_hash);
    `);
    secureDatabaseFiles(filename);
  } finally {
    db.close();
  }
}

function openQueryDatabase(): Database {
  const filename = statePath("transcript-search.sqlite");
  let stat: fs.Stats;
  try { stat = fs.statSync(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return openWriterDatabase();
    throw error;
  }
  const Database = sqliteDatabase();
  const db = new Database(filename, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA query_only = ON; PRAGMA foreign_keys = ON;");
    const identity = `${stat.dev}:${stat.ino}`;
    const schema = db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version;
    const cached = searchSchemas.get(filename);
    const metadata = cached?.identity === identity && cached.schema === schema ? cached : db.query<{ version: number; hit: number; vocabulary: number }, []>(`
      SELECT user_version AS version,
        EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='transcript_messages_search_hit') AS hit,
        EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_messages_vocab') AS vocabulary
      FROM pragma_user_version
    `).get()!;
    if (metadata !== cached) {
      if (searchSchemas.size >= 16) searchSchemas.delete(searchSchemas.keys().next().value!);
      searchSchemas.set(filename, { ...metadata, identity, schema });
    }
    const currentVersion = metadata.version;
    // Pre-v4 schemas need table reshaping before they can be read. Close the
    // reader before that compatibility upgrade; v4 work stays off-thread.
    if (currentVersion < 4) {
      db.close();
      openWriterDatabase().close();
      return openQueryDatabase();
    }
    if (metadata.hit && metadata.vocabulary) readySearchDatabases.add(db);
    if (currentVersion < TRANSCRIPT_SEARCH_SCHEMA_VERSION || !metadata.hit || !metadata.vocabulary) scheduleSearchIndexBuild(filename);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function scheduleSearchIndexBuild(filename: string): void {
  if (scheduledSearchIndexes.has(filename)) return;
  scheduledSearchIndexes.add(filename);
  try {
    const proc = Bun.spawn([process.execPath, transcriptSearchWorkerPath()], {
      env: { ...process.env, LLV_STATE_DIR: path.dirname(filename) },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    void proc.exited.then((code) => {
      if (code !== 0) console.error(`[transcript-search] index worker exited with status ${code}; migration will retry on the next search`);
    }, () => {
      console.error("[transcript-search] index worker failed; migration will retry on the next search");
    }).finally(() => scheduledSearchIndexes.delete(filename));
    proc.unref();
  } catch {
    scheduledSearchIndexes.delete(filename);
    console.error("[transcript-search] could not start index worker; migration will retry on the next search");
  }
}

export function transcriptSearchWorkerPath(cwd = process.cwd()): string {
  const bundled = path.join(cwd, ".next/server/transcript-search-index-worker.js");
  return fs.existsSync(bundled) ? bundled : path.join(cwd, "src/lib/transcriptSearchIndex.worker.ts");
}

function secureDatabaseFiles(filename: string): void {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    try {
      fs.chmodSync(candidate, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => record(item) !== null)
    : [];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return records(value)
    .filter((part) => part.type === "text" || part.type === "input_text" || part.type === "output_text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function unixTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1_000) : null;
}

function messageFromRecord(
  parsed: Record<string, unknown>,
  source: TranscriptIndexSource,
  byteOffset: number,
  lineNumber: number,
): (ParsedTranscriptMessage & { representation: "claude" | "response" | "event" | "copilot" }) | null {
  let speaker: "user" | "assistant" | null = null;
  let body = "";
  let representation: "claude" | "response" | "event" | "copilot" = "claude";
  if (source.engine === "claude" && (parsed.type === "user" || parsed.type === "assistant")) {
    speaker = parsed.type;
    body = textContent(record(parsed.message)?.content);
  } else if (source.engine === "codex" && parsed.type === "response_item") {
    representation = "response";
    const payload = record(parsed.payload);
    if (payload?.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      speaker = payload.role;
      body = textContent(payload.content);
    } else if (payload?.type === "agent_message") {
      speaker = "assistant";
      body = textContent(payload.content);
    }
  } else if (source.engine === "codex" && parsed.type === "event_msg") {
    representation = "event";
    const payload = record(parsed.payload);
    if (payload?.type === "user_message") {
      speaker = "user";
      body = typeof payload.message === "string" ? payload.message.trim() : "";
    } else if (payload?.type === "agent_message") {
      speaker = "assistant";
      body = typeof payload.message === "string" ? payload.message.trim() : "";
    }
  } else if (source.engine === "copilot" && (parsed.type === "user.message" || parsed.type === "assistant.message")) {
    representation = "copilot";
    speaker = parsed.type === "user.message" ? "user" : "assistant";
    body = textContent(record(parsed.data)?.content);
  }
  if (!speaker || !body) return null;
  return {
    body,
    speaker,
    timestamp: unixTimestamp(parsed.timestamp ?? parsed.created_at),
    byteOffset,
    lineNumber,
    representation,
  };
}

async function* transcriptLines(pathname: string): AsyncGenerator<{ bytes: Buffer; byteOffset: number; lineNumber: number }> {
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let lineOffset = 0;
  let lineNumber = 1;
  let streamOffset = 0;
  for await (const chunk of fs.createReadStream(pathname)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (true) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) break;
      const tail = bytes.subarray(start, newline);
      const totalBytes = fragmentBytes + tail.length;
      const combined = fragments.length
        ? Buffer.concat(tail.length ? [...fragments, tail] : fragments, totalBytes)
        : tail;
      const line = combined.at(-1) === 0x0d ? combined.subarray(0, -1) : combined;
      yield { bytes: line, byteOffset: lineOffset, lineNumber };
      lineNumber += 1;
      fragments = [];
      fragmentBytes = 0;
      start = newline + 1;
      lineOffset = streamOffset + start;
    }
    if (start < bytes.length) {
      const remainder = bytes.subarray(start);
      fragments.push(remainder);
      fragmentBytes += remainder.length;
    }
    streamOffset += bytes.length;
  }
  if (fragmentBytes) {
    const combined = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, fragmentBytes);
    const line = combined.at(-1) === 0x0d ? combined.subarray(0, -1) : combined;
    yield { bytes: line, byteOffset: lineOffset, lineNumber };
  }
}

async function* readTranscriptMessages(source: TranscriptIndexSource): AsyncGenerator<ParsedTranscriptMessage> {
  type RecentMessage = { representation: "response" | "event" | "copilot"; timestamp: number | null; lineNumber: number };
  const recent = new Map<string, RecentMessage>();
  const recentOrder: Array<{ key: string; message: RecentMessage }> = [];
  for await (const line of transcriptLines(source.path)) {
    if (!line.bytes.length) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.bytes.toString("utf8"));
    } catch {
      continue;
    }
    const message = messageFromRecord(record(parsed) ?? {}, source, line.byteOffset, line.lineNumber);
    if (!message) continue;
    if (message.representation !== "claude") {
      const key = `${message.speaker}\0${message.body}`;
      const previous = recent.get(key);
      const closeInTime = previous
        && (message.timestamp !== null && previous.timestamp !== null
          ? Math.abs(message.timestamp - previous.timestamp) <= 2
          : message.lineNumber - previous.lineNumber <= 2);
      if (previous && previous.representation !== message.representation && closeInTime) continue;
      const remembered = {
        representation: message.representation,
        timestamp: message.timestamp,
        lineNumber: message.lineNumber,
      };
      recent.set(key, remembered);
      recentOrder.push({ key, message: remembered });
      while (recentOrder.length > 8) {
        const expired = recentOrder.shift()!;
        if (recent.get(expired.key) === expired.message) recent.delete(expired.key);
      }
    }
    const { representation: _representation, ...indexed } = message;
    yield indexed;
  }
}

function removeTranscript(db: Database, pathname: string): void {
  db.query("DELETE FROM transcript_messages_fts WHERE rowid IN (SELECT id FROM transcript_messages WHERE transcript_path = ?)")
    .run(pathname);
  db.query("DELETE FROM transcript_messages WHERE transcript_path = ?").run(pathname);
  db.query("DELETE FROM transcript_files WHERE path = ?").run(pathname);
}

export async function indexTranscriptSources(
  sources: readonly TranscriptIndexSource[],
  options: TranscriptIndexOptions = {},
): Promise<TranscriptIndexResult> {
  const db = openWriterDatabase();
  const readMessages = options.readMessages ?? readTranscriptMessages;
  let filesRead = 0;
  let filesSkipped = 0;
  let messagesIndexed = 0;
  const failures: TranscriptIndexResult["failures"] = [];
  try {
    const identity = db.query<FileIdentityRow, [string]>(
      "SELECT size, mtime_ms, project, engine FROM transcript_files WHERE path = ?",
    );
    const updateMetadata = db.query(
      "UPDATE transcript_files SET project = ?, engine = ? WHERE path = ?",
    );
    for (const source of sources) {
      const current = identity.get(source.path);
      if (current?.size === source.size && current.mtime_ms === source.mtimeMs) {
        if (current.project !== source.project || current.engine !== source.engine) {
          updateMetadata.run(source.project, source.engine, source.path);
        }
        filesSkipped += 1;
        continue;
      }
      filesRead += 1;
      db.exec("BEGIN IMMEDIATE");
      try {
        // Retain unchanged rows when a transcript grows: their IDs and undated
        // fallback times belong to existing paging snapshots. New IDs never reuse
        // deleted IDs, including after a complete prune of the index.
        db.query(`
          INSERT INTO transcript_files(path, size, mtime_ms, project, engine, messages_count, indexed_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
            project = excluded.project, engine = excluded.engine, indexed_at = excluded.indexed_at
        `).run(source.path, source.size, source.mtimeMs, source.project, source.engine, Math.floor(Date.now() / 1_000));
        let lastId = db.query<{ last_id: number }, []>("SELECT last_id FROM transcript_search_sequence WHERE singleton = 1").get()!.last_id;
        const existing = db.query<{ id: number; speaker: string; timestamp: number | null; byte_offset: number; line_number: number; body: string }, [string, number]>(
          "SELECT id, speaker, timestamp, byte_offset, line_number, body FROM transcript_messages WHERE transcript_path = ? AND message_index = ?",
        );
        const insert = db.query(`
          INSERT INTO transcript_messages(id, transcript_path, message_index, speaker, timestamp, byte_offset, line_number, body, body_hash, sort_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        let messageIndex = 0;
        for await (const message of readMessages(source)) {
          const prior = existing.get(source.path, messageIndex);
          if (prior && prior.body === message.body && prior.speaker === message.speaker
            && prior.timestamp === message.timestamp && prior.byte_offset === message.byteOffset
            && prior.line_number === message.lineNumber) {
            messageIndex += 1;
            continue;
          }
          if (prior) {
            db.query("DELETE FROM transcript_messages_fts WHERE rowid = ?").run(prior.id);
            db.query("DELETE FROM transcript_messages WHERE id = ?").run(prior.id);
          }
          const id = ++lastId;
          insert.run(id, source.path, messageIndex, message.speaker, message.timestamp,
            message.byteOffset, message.lineNumber, message.body, normalizedBodyHash(message.body),
            message.timestamp ?? source.mtimeMs / 1000);
          db.query("INSERT INTO transcript_messages_fts(rowid, body) VALUES (?, ?)").run(id, message.body);
          messageIndex += 1;
        }
        db.query(`DELETE FROM transcript_messages_fts WHERE rowid IN (
          SELECT id FROM transcript_messages WHERE transcript_path = ? AND message_index >= ?
        )`).run(source.path, messageIndex);
        db.query("DELETE FROM transcript_messages WHERE transcript_path = ? AND message_index >= ?").run(source.path, messageIndex);
        db.query("UPDATE transcript_search_sequence SET last_id = ? WHERE singleton = 1").run(lastId);
        db.query("UPDATE transcript_files SET messages_count = ? WHERE path = ?").run(messageIndex, source.path);
        db.exec("COMMIT");
        messagesIndexed += messageIndex;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
        failures.push({
          path: source.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (options.complete) {
      const currentPaths = new Set(sources.map((source) => source.path));
      const indexed = db.query<{ path: string }, []>("SELECT path FROM transcript_files").all();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of indexed) {
          if (!currentPaths.has(row.path)) removeTranscript(db, row.path);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
        throw error;
      }
      // Release the write lock and yield between bounded FTS merge steps.
      if (!failures.length) {
        while (true) {
          const before = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
          db.query("INSERT INTO transcript_messages_fts(transcript_messages_fts, rank) VALUES('merge', 256)").run();
          const after = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
          if (after - before <= 1) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }
    return { filesRead, filesSkipped, messagesIndexed, failures };
  } finally {
    db.close();
  }
}

/* Cursors bind the query and filters, a high-water message ID, and the last
   (effective timestamp, ID) sort key. Indexing later arrivals cannot change the
   duplicate representatives or insert backfilled messages into this traversal. */
function cursorScope(query: string, project: string | undefined, speaker: TranscriptSpeaker | undefined): string {
  return crypto.createHash("sha256")
    .update(query)
    .update("\0")
    .update(project ?? "")
    .update("\0")
    .update(speaker ?? "")
    .digest("base64url")
    .slice(0, 16);
}

interface SearchCursor {
  version: 2;
  scope: string;
  throughId: number;
  timestamp: number;
  id: number;
}

function encodeCursor(hit: RankedHit, throughId: number, scope: string): string {
  return Buffer.from(JSON.stringify({ version: 2, throughId, timestamp: hit.timestamp, id: hit.id, scope })).toString("base64url");
}

function decodeCursor(value: string | null | undefined, scope: string): SearchCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SearchCursor;
    if (parsed.version !== 2 || parsed.scope !== scope
      || !Number.isSafeInteger(parsed.throughId) || parsed.throughId < 1
      || !Number.isSafeInteger(parsed.id) || parsed.id < 1 || parsed.id > parsed.throughId
      || typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) {
      throw new InvalidTranscriptSearchCursorError();
    }
    return parsed;
  } catch {
    throw new InvalidTranscriptSearchCursorError();
  }
}

function corpusStats(db: Database): TranscriptCorpusStats {
  /* Every transcript's `messages_count` is committed with its rows, so one
     pass over the files table answers exactly what `COUNT(*)` over the message
     table did — minus the ~12 ms that walk cost every search, one-hit searches
     included. */
  const row = db.query<{ conversations: number; messages: number | null }, []>(
    "SELECT COUNT(*) AS conversations, SUM(messages_count) AS messages FROM transcript_files",
  ).get();
  return {
    conversationsIndexed: row?.conversations ?? 0,
    messagesIndexed: row?.messages ?? 0,
    fieldsSearched: TRANSCRIPT_SEARCH_FIELDS,
    tokenizer: TRANSCRIPT_SEARCH_TOKENIZER,
  };
}

/* Past this many distinct transcripts, reading the whole files table once
   (thousands of short rows) is cheaper than one keyed lookup per path. */
const TRANSCRIPT_FILE_LOOKUP_CAP = 512;

function transcriptFiles(db: Database, paths: ReadonlySet<string>): Map<string, TranscriptFileRow> {
  const files = new Map<string, TranscriptFileRow>();
  if (!paths.size) return files;
  if (paths.size <= TRANSCRIPT_FILE_LOOKUP_CAP) {
    const lookup = db.query<TranscriptFileRow, [string]>(
      "SELECT project, engine, mtime_ms FROM transcript_files WHERE path = ?",
    );
    for (const pathname of paths) {
      const file = lookup.get(pathname);
      if (file) files.set(pathname, file);
    }
    return files;
  }
  const rows = db.query("SELECT path, project, engine, mtime_ms FROM transcript_files").values() as Array<
    [string, string, "claude" | "codex" | "copilot", number]
  >;
  for (const [pathname, project, engine, mtime_ms] of rows) {
    if (paths.has(pathname)) files.set(pathname, { project, engine, mtime_ms });
  }
  return files;
}

/** Effective message time descending, then the persistent row ID descending. */
function newerFirst(a: Pick<RankedHit, "timestamp" | "id">, b: Pick<RankedHit, "timestamp" | "id">): number {
  return b.timestamp - a.timestamp || b.id - a.id;
}

/** A worst-first heap retains only limit + 1 groups. Common terms still need a
    linear match scan for exact collapse/counts, but never a full result sort. */
function newestPage(groups: Iterable<CollapsedHit>, cursor: SearchCursor | null, limit: number): CollapsedHit[] {
  const heap: CollapsedHit[] = [];
  const compare = (a: CollapsedHit, b: CollapsedHit) => newerFirst(a.newest, b.newest);
  for (const group of groups) {
    if (cursor && newerFirst(group.newest, cursor) <= 0) continue;
    if (heap.length < limit) {
      heap.push(group);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >>> 1;
        if (compare(heap[parent], heap[child]) >= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
    } else if (compare(group, heap[0]) < 0) {
      heap[0] = group;
      let parent = 0;
      while (parent * 2 + 1 < heap.length) {
        let child = parent * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child += 1;
        if (compare(heap[parent], heap[child]) >= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        parent = child;
      }
    }
  }
  return heap.sort(compare);
}

function pageItems(
  db: Database,
  query: string,
  page: readonly CollapsedHit[],
  files: ReadonlyMap<string, TranscriptFileRow>,
  tokens = 24,
): TranscriptSearchItem[] {
  if (!page.length) return [];
  const ids = page.map((group) => group.newest.id);
  /* `+rowid` keeps FTS5 from turning the id list into one doclist seek per row,
     which on a common term costs ~14 ms EACH; an ordinary match scan filtered
     in place is a fraction of that, and `snippet` runs only for the rows that
     pass the filter. */
  const snippets = new Map<number, string>();
  const snippetRows = db.query(`
    SELECT rowid, snippet(transcript_messages_fts, 0, '${SNIPPET_MATCH_OPEN}', '${SNIPPET_MATCH_CLOSE}', '…', ${tokens})
    FROM transcript_messages_fts
    WHERE transcript_messages_fts MATCH ? AND +rowid IN (${ids.map(() => "?").join(", ")})
  `).values(query, ...ids) as Array<[number, string]>;
  for (const [id, snippet] of snippetRows) snippets.set(id, snippet);
  const location = db.query<{ byte_offset: number; line_number: number }, [number]>(
    "SELECT byte_offset, line_number FROM transcript_messages WHERE id = ?",
  );
  return page.map(({ newest, duplicateCount }) => {
    const where = location.get(newest.id);
    const file = files.get(newest.transcriptPath);
    if (!where || !file) throw new Error("transcript search page row vanished within its read snapshot");
    return {
      snippet: snippets.get(newest.id) ?? "",
      speaker: newest.speaker,
      duplicateCount,
      timestamp: newest.timestamp,
      transcriptPath: newest.transcriptPath,
      byteOffset: where.byte_offset,
      lineNumber: where.line_number,
      project: file.project,
      engine: file.engine,
    };
  });
}

export interface TranscriptActivityRow {
  transcriptPath: string;
  speaker: TranscriptSpeaker;
  atMs: number;
  /** Row order among messages that share a second. */
  seq: number;
}

export interface TranscriptActivityRead {
  /** False when no index exists yet: nothing has been scanned. */
  available: boolean;
  rows: TranscriptActivityRow[];
  files: Map<string, { project: string; engine: "claude" | "codex" | "copilot" }>;
  /** When the newest transcript was indexed, in milliseconds. */
  indexedAtMs: number | null;
}

/**
 * Dated message rows with `fromSec <= timestamp <= toSec`, for the activity
 * dashboard: path, speaker and time only. The body is never selected. An
 * absent index is reported as unavailable, and this read never creates one.
 */
export function readTranscriptActivity(fromSec: number, toSec: number): TranscriptActivityRead {
  if (!fs.existsSync(statePath("transcript-search.sqlite"))) {
    return { available: false, rows: [], files: new Map(), indexedAtMs: null };
  }
  const db = openQueryDatabase();
  try {
    db.exec("BEGIN");
    try {
      const ready = readySearchDatabases.has(db);
      const hasSortTimestamp = ready || db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info('transcript_messages') WHERE name = ?").get("sort_timestamp");
      const activityTime = ready ? "m.sort_timestamp" : hasSortTimestamp ? "COALESCE(m.sort_timestamp, m.timestamp, f.mtime_ms / 1000.0)" : "COALESCE(m.timestamp, f.mtime_ms / 1000.0)";
      const values = db.query(`
        SELECT m.id, m.speaker, m.transcript_path, m.timestamp FROM transcript_messages AS m
        ${ready ? "" : "JOIN transcript_files AS f ON f.path = m.transcript_path"}
        WHERE ${activityTime} BETWEEN ? AND ? AND m.timestamp IS NOT NULL
      `).values(fromSec, toSec) as Array<[number, TranscriptSpeaker, string, number]>;
      const rows: TranscriptActivityRow[] = [];
      const paths = new Set<string>();
      for (const [id, speaker, transcriptPath, timestamp] of values) {
        rows.push({ transcriptPath, speaker, atMs: timestamp * 1_000, seq: id });
        paths.add(transcriptPath);
      }
      const files = new Map<string, { project: string; engine: "claude" | "codex" | "copilot" }>();
      for (const [pathname, file] of transcriptFiles(db, paths)) files.set(pathname, { project: file.project, engine: file.engine });
      const newest = db.query<{ newest: number | null }, []>("SELECT MAX(indexed_at) AS newest FROM transcript_files").get()?.newest ?? null;
      return { available: true, rows, files, indexedAtMs: newest === null ? null : newest * 1_000 };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

/**
 * Scan the FTS match set once, collapse by speaker/body in memory, and select
 * at most limit + 1 groups with a heap. Cost: O(M + G log L), with O(M + G)
 * match/group storage and O(L) ranking storage (L <= 101); only page rows get
 * snippets. No corpus-wide join or full group sort. The file lookup and read
 * transaction preserve the bounded hydration introduced in #1429.
 *
 * A cursor fences later indexed rows before collapse. Unchanged rows survive
 * append/reindex, so new occurrences cannot move an existing group across the
 * cursor. Deleted or edited messages leave the result set; this is not an
 * archive of removed transcript content.
 */
export interface TranscriptSearchOptions {
  query: string;
  project?: string;
  /** Restrict to one side of the conversation; omitted searches both. */
  speaker?: TranscriptSpeaker;
  limit?: number;
  cursor?: string | null;
  order?: "newest" | "relevance";
  /** Offline replay only: the HTTP/MCP surfaces never accept this fence. */
  fence?: { timestamp: number; excludeTranscript: string };
}

interface RelevanceCursor {
  version: 6;
  scope: string;
  throughId: number;
  seen: string;
  now: number;
  units: QueryUnit[];
  weights: number[];
  ignored: string[];
  /** During migration only a bounded subset is retrieved; coverage keeps all units. */
  retrieve?: number[];
}

/** Delta varints keep a large traversal compact without retaining server state. */
function encodeSeenFiles(ids: ReadonlySet<number>): string {
  const bytes: number[] = [];
  let previous = 0;
  for (const id of [...ids].sort((a, b) => a - b)) {
    let delta = id - previous;
    previous = id;
    do {
      const byte = delta % 128;
      delta = Math.floor(delta / 128);
      bytes.push(byte + (delta ? 128 : 0));
    } while (delta);
  }
  return deflateRawSync(Buffer.from(bytes)).toString("base64url");
}

function decodeSeenFiles(encoded: string): Set<number> {
  const bytes = inflateRawSync(Buffer.from(encoded, "base64url"), { maxOutputLength: 128 * 1024 });
  const seen = new Set<number>();
  let previous = 0, delta = 0, scale = 1;
  for (const byte of bytes) {
    delta += (byte % 128) * scale;
    if (byte < 128) {
      const id = previous + delta;
      if (!Number.isSafeInteger(id) || id <= previous) throw new InvalidTranscriptSearchCursorError();
      seen.add(id); previous = id; delta = 0; scale = 1;
    } else {
      scale *= 128;
      if (scale > Number.MAX_SAFE_INTEGER) throw new InvalidTranscriptSearchCursorError();
    }
  }
  if (scale !== 1) throw new InvalidTranscriptSearchCursorError();
  return seen;
}

function unitFrequency(db: Database): (term: string, prefix: boolean) => number {
  const cache = new Map<string, number>();
  const exact = db.query<{ n: number | null }, [string]>("SELECT doc AS n FROM transcript_messages_vocab WHERE term = ?");
  const range = db.query<{ n: number | null }, [string, string]>("SELECT SUM(doc) AS n FROM transcript_messages_vocab WHERE term >= ? AND term < ?");
  const tokenized = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM transcript_messages_fts WHERE transcript_messages_fts MATCH ?");
  return (term, prefix) => {
    const key = term + (prefix ? "*" : "");
    if (!cache.has(key)) {
      let frequency = (prefix ? range.get(term, term + "\uffff") : exact.get(term))?.n ?? 0;
      // unicode61 has case folds that JavaScript lowercasing does not share.
      // Let FTS tokenize an absent vocabulary key before excluding the unit.
      if (!frequency) frequency = tokenized.get(`"${term.replaceAll('"', '""')}"${prefix ? "*" : ""}`)?.n ?? 0;
      cache.set(key, frequency);
    }
    return cache.get(key)!;
  };
}

/** Count JSON escapes too, and keep Unicode scalar values intact. */
function boundedRelevanceSnippet(snippet: string): string {
  if (Buffer.byteLength(JSON.stringify(snippet)) <= RELEVANCE_SNIPPET_BYTES) return snippet;
  const scalars = Array.from(snippet);
  let low = 0, high = Math.min(scalars.length, RELEVANCE_SNIPPET_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(scalars.slice(0, mid).join("") + "…")) <= RELEVANCE_SNIPPET_BYTES) low = mid;
    else high = mid - 1;
  }
  let text = scalars.slice(0, low).join("");
  // Do not leave an unmatched highlight sentinel at the truncation boundary.
  if (text.lastIndexOf(SNIPPET_MATCH_OPEN) > text.lastIndexOf(SNIPPET_MATCH_CLOSE)) {
    text = text.slice(0, text.lastIndexOf(SNIPPET_MATCH_OPEN));
  }
  return text + "…";
}

/** Cursor JSON is caller input; only expressions built from literal units execute. */
function validCursorUnit(unit: QueryUnit): boolean {
  if (!unit || typeof unit.label !== "string" || typeof unit.phrase !== "boolean"
    || !Array.isArray(unit.terms) || !unit.terms.length
    || !unit.terms.every((term) => term && typeof term.term === "string"
      && /^[\p{L}\p{N}\p{M}\p{Co}_#]+$/u.test(term.term) && typeof term.prefix === "boolean")) return false;
  const quote = (term: string) => `"${term.replaceAll('"', '""')}"`;
  if (unit.phrase && !unit.terms.every((term) => !term.prefix)) return false;
  const terms = unit.terms.map((term) => quote(term.term) + (term.prefix ? "*" : "")).join(" OR ");
  const literal = unit.phrase ? quote(unit.terms.map((term) => term.term).join(" "))
    : unit.terms.length > 1 ? `(${terms})` : terms;
  // A widened unit is rebuilt from its literal terms; no other wide expression runs.
  if (unit.wide !== undefined) return unit.wide === true && unit.quoted === undefined
    && unit.expression === widerExpression({ ...unit, expression: literal });
  return unit.expression === literal;
}

function relevanceSearch(
  db: Database,
  options: TranscriptSearchOptions,
  stats: TranscriptCorpusStats,
  projectScope?: ProjectScope,
  /** Second pass: widen the units that have a wider form; null when none has. */
  widen = false,
): TranscriptSearchResult | null {
  const scope = cursorScope(options.query.trim() + "\0relevance", options.project, options.speaker);
  let cursor: RelevanceCursor | undefined;
  let seen = new Set<number>();
  if (options.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (!cursor || cursor.version !== 6 || cursor.scope !== scope
        || !Number.isSafeInteger(cursor.throughId) || cursor.throughId < 0
        || typeof cursor.seen !== "string" || cursor.seen.length > 64 * 1024
        || !Number.isFinite(cursor.now) || !Array.isArray(cursor.units) || !Array.isArray(cursor.weights)
        || cursor.units.length !== cursor.weights.length || !cursor.weights.every((n) => Number.isFinite(n) && n > 0)
        || !Array.isArray(cursor.ignored) || !cursor.ignored.every((s) => typeof s === "string")
        || !cursor.units.every(validCursorUnit)
        || (cursor.retrieve !== undefined && (!Array.isArray(cursor.retrieve)
          || !cursor.retrieve.every((i) => Number.isSafeInteger(i) && i >= 0 && i < cursor!.units.length)))) {
        throw new InvalidTranscriptSearchCursorError();
      }
      seen = decodeSeenFiles(cursor.seen);
    } catch { throw new InvalidTranscriptSearchCursorError(); }
  }
  const hasSequence = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_search_sequence'").get());
  const throughId = cursor?.throughId ?? (hasSequence
    ? db.query<{ last_id: number }, []>("SELECT last_id FROM transcript_search_sequence WHERE singleton = 1").get()!.last_id
    : db.query<{ last_id: number }, []>("SELECT COALESCE(MAX(id), 0) AS last_id FROM transcript_messages").get()!.last_id);
  const now = cursor?.now ?? options.fence?.timestamp ?? Date.now() / 1000;
  const hasVocabulary = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_messages_vocab'").get());
  if (widen && !hasVocabulary) return null;
  const frequency = hasVocabulary ? unitFrequency(db) : () => 0;
  const raw = cursor?.units ?? queryUnits(options.query, hasVocabulary ? frequency : undefined, stats.messagesIndexed);
  const ignored: string[] = cursor?.ignored ?? [];
  let units = raw;
  let weights = cursor?.weights ?? [];
  let retrieve = cursor?.retrieve;
  if (!cursor) {
    const candidates = raw.filter((u) => !isFunctionWord(u));
    if (!hasVocabulary) {
      // Until the vocabulary builder finishes, use one likely-specific term
      // so an ordinary first request does not scan the entire corpus for each
      // word in a long prompt.
      units = candidates;
      const selected = candidates.slice().sort((a, b) => {
        const aLength = a.terms.reduce((length, term) => Math.max(length, term.term.length), 0);
        const bLength = b.terms.reduce((length, term) => Math.max(length, term.term.length), 0);
        return bLength - aLength;
      })[0];
      retrieve = selected ? [units.indexOf(selected)] : [];
      weights = units.map(() => 1);
      ignored.push(...raw.filter((u) => !units.includes(u)).map((u) => u.label));
    } else {
      // A phrase's words may each be common while the atomic phrase is rare.
      const phraseFrequency = db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM transcript_messages_fts WHERE transcript_messages_fts MATCH ?",
      );
      const counts = candidates.map((u) => Math.min(stats.messagesIndexed,
        u.phrase ? phraseFrequency.get(u.expression)!.n
          : u.terms.reduce((n, t) => n + frequency(t.term, t.prefix), 0)));
      const indexed = candidates.map((_, i) => i).filter((i) => counts[i] > 0);
      let kept = indexed.filter((i) => counts[i] <= stats.messagesIndexed * 0.05);
      if (!kept.length && indexed.length) {
        kept = [indexed.reduce((best, i) => counts[i] < counts[best] ? i : best)];
      }
      if (widen) {
        // Kept and absent units may gain a wider form. Common units stay
        // ignored, no unit is dropped, and the denominator can only grow.
        const limit = stats.messagesIndexed * 0.05;
        const replaced = new Map<QueryUnit, QueryUnit>();
        for (const [i, unit] of candidates.entries()) {
          if (counts[i] > 0 && !kept.includes(i)) continue;
          const expression = widerExpression(unit);
          if (!expression) continue;
          const n = Math.min(stats.messagesIndexed, phraseFrequency.get(expression)!.n);
          if (!n || n > limit || n <= phraseFrequency.get(unit.expression)!.n) continue;
          if (!counts[i]) kept.push(i);
          counts[i] = n;
          candidates[i] = { ...unit, expression, label: `${unit.label}~`, wide: true };
          replaced.set(unit, candidates[i]);
        }
        if (!replaced.size) return null;
        kept.sort((a, b) => a - b);
        for (const [i, unit] of raw.entries()) raw[i] = replaced.get(unit) ?? unit;
      }
      units = kept.map((i) => candidates[i]);
      if (!units.length && !candidates.length && raw.length) units = [raw[0]];
      ignored.push(...raw.filter((u) => !units.includes(u)).map((u) => u.label));
      weights = units.map((u) => {
        const i = candidates.indexOf(u);
        const df = i >= 0 ? counts[i] : stats.messagesIndexed;
        return Math.log(1 + (stats.messagesIndexed - df + 0.5) / (df + 0.5));
      });
    }
  }
  const interpretedAs = { units: units.map((u) => u.label), ignored };
  if (!units.length) return { items: [], total: 0, strongTotal: 0, nextCursor: null, stats, order: "relevance", interpretedAs, ...(projectScope ? { projectScope } : {}) };
  interface Message extends RankedHit { bodyHash: string; units: Set<number>; weight: number }
  interface Conversation { path: string; messages: Map<number, Message>; units: Set<number>; newest: number; score: number; fragments: Message[] }
  const conversations = new Map<string, Conversation>();
  const hasSortTimestamp = Boolean(db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info('transcript_messages') WHERE name = ?").get("sort_timestamp"));
  const timestampExpr = hasSortTimestamp
    ? "COALESCE(m.sort_timestamp, m.timestamp, f.mtime_ms / 1000.0)"
    : "COALESCE(m.timestamp, f.mtime_ms / 1000.0)";
  const filters = `${options.speaker ? " AND m.speaker = ?" : ""}${options.project ? " AND f.project = ?" : ""}${options.fence ? ` AND ${timestampExpr} <= ? AND m.transcript_path != ?` : ""}`;
  const rows = db.query(`
    SELECT m.id, m.speaker, m.body_hash, ${timestampExpr}, m.transcript_path
    FROM transcript_messages_fts JOIN transcript_messages m ON m.id = transcript_messages_fts.rowid
    JOIN transcript_files f ON f.path = m.transcript_path
    WHERE transcript_messages_fts MATCH ? AND m.id <= ?${filters}
  `);
  for (const [i, unit] of units.entries()) {
    if (retrieve && !retrieve.includes(i)) continue;
    const args: Array<string | number> = [unit.expression, throughId];
    if (options.speaker) args.push(options.speaker);
    if (options.project) args.push(options.project);
    if (options.fence) args.push(options.fence.timestamp, options.fence.excludeTranscript);
    for (const [id, speaker, bodyHash, timestamp, transcriptPath] of rows.values(...args) as HitRow[]) {
      let conversation = conversations.get(transcriptPath);
      if (!conversation) {
        conversation = { path: transcriptPath, messages: new Map(), units: new Set(), newest: timestamp, score: 0, fragments: [] };
        conversations.set(transcriptPath, conversation);
      }
      conversation.units.add(i);
      conversation.newest = Math.max(conversation.newest, timestamp);
      let message = conversation.messages.get(id);
      if (!message) {
        message = { id, speaker, bodyHash, timestamp, transcriptPath, units: new Set(), weight: 0 };
        conversation.messages.set(id, message);
      }
      message.units.add(i);
      message.weight += weights[i];
    }
  }
  const files = transcriptFiles(db, new Set(conversations.keys()));
  const sizeRows = cursor
    ? db.query<{ path: string; messages_count: number }, [number]>(`
      SELECT f.path, (SELECT COUNT(*) FROM transcript_messages m
        WHERE m.transcript_path = f.path AND m.id <= ?) AS messages_count FROM transcript_files f
    `).all(throughId)
    : db.query<{ path: string; messages_count: number }, []>("SELECT path, messages_count FROM transcript_files").all();
  const sizes = new Map(sizeRows.map((r) => [r.path, r.messages_count]));
  const fileIds = new Map(db.query<{ path: string; id: number }, []>("SELECT path, rowid AS id FROM transcript_files").all().map((row) => [row.path, row.id]));
  const weight = (found: Iterable<number>) => [...found].reduce((sum, i) => sum + weights[i], 0);
  const sum = weight(units.keys());
  for (const conversation of conversations.values()) {
    const messages = [...conversation.messages.values()];
    const best = messages.reduce((best, m) => Math.max(best, m.weight), 0);
    const damp = 1 / (1 + 0.15 * Math.log10(Math.max(1, sizes.get(conversation.path) ?? 1)));
    conversation.score = (weight(conversation.units) * damp + best) / (2 * sum)
      * (1 + 0.6 * Math.exp(-Math.max(0, now - conversation.newest) / 86400 / 14));
    const covered = new Set<number>();
    for (let pick = 0; pick < 3; pick++) {
      let selected: Message | undefined;
      let gain = 0;
      for (const message of messages) {
        const added = weight([...message.units].filter((u) => !covered.has(u)));
        if (added > gain || (added > 0 && added === gain && selected && newerFirst(message, selected) < 0)) {
          selected = message; gain = added;
        }
      }
      if (!selected) break;
      conversation.fragments.push(selected);
      for (const u of selected.units) covered.add(u);
    }
  }
  const compare = (a: { score: number; newest: number; path: string }, b: { score: number; newest: number; path: string }) =>
    b.score - a.score || b.newest - a.newest || a.path.localeCompare(b.path);
  const ranked = [...conversations.values()].sort(compare);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 6)));
  const expression = units.map((u) => u.expression).join(" OR ");
  // Exact body copies need just one snippet signature. A single FTS scan
  // computes the signatures of the remaining leads before grouping, so copies
  // with different text outside the snippet fold across page boundaries too.
  const leads = new Map<string, Message>();
  for (const conversation of ranked) {
    const lead = conversation.fragments[0]!;
    leads.set(`${lead.speaker}\0${lead.bodyHash}`, lead);
  }
  const signatures = new Map<number, string>();
  if (leads.size) {
    const rows = db.query(`SELECT rowid,
      snippet(transcript_messages_fts, 0, '${SNIPPET_MATCH_OPEN}', '${SNIPPET_MATCH_CLOSE}', '…', 16)
      FROM transcript_messages_fts WHERE transcript_messages_fts MATCH ?
      AND +rowid IN (SELECT value FROM json_each(?))
    `).values(expression, JSON.stringify([...leads.values()].map((lead) => lead.id))) as Array<[number, string]>;
    for (const [id, snippet] of rows) signatures.set(id, snippet);
  }
  const groups = new Map<string, Conversation[]>();
  for (const conversation of ranked) {
    const lead = conversation.fragments[0]!;
    const representative = leads.get(`${lead.speaker}\0${lead.bodyHash}`)!;
    const key = `${lead.speaker}\0${signatures.get(representative.id)}`;
    const group = groups.get(key);
    if (group) group.push(conversation);
    else groups.set(key, [conversation]);
  }
  // A file keeps its rowid through indexing upserts. Traversing by consumed
  // identities survives score changes when unrelated messages are pruned.
  const groupRows = [...groups.values()].map((group) => {
    const unvisited = group.filter((conversation) => !seen.has(fileIds.get(conversation.path)!));
    return unvisited.length ? [...unvisited, ...group.filter((conversation) => seen.has(fileIds.get(conversation.path)!))] : [];
  }).filter((group) => group.length);
  const pageGroups = groupRows.slice(0, limit);
  // Snippet work stays bounded by this page and its at-most-three fragments.
  const messages = pageGroups.flatMap((group) => group[0]!.fragments);
  const snippets = pageItems(db, expression, messages.map((m) => ({ newest: m, duplicateCount: 1 })), files, 16);
  const byId = new Map(messages.map((m, i) => [m.id, snippets[i]]));
  const items: TranscriptSearchItem[] = [];
  for (const group of pageGroups) {
    const conversation = group[0]!;
    const lead = byId.get(conversation.fragments[0].id)!;
    const item: TranscriptSearchItem = {
      ...lead,
      snippet: boundedRelevanceSnippet(lead.snippet),
      duplicateCount: group.length,
      matched: [...conversation.units].sort((a, b) => a - b).map((i) => units[i].label),
      missing: units.filter((_, i) => !conversation.units.has(i)).map((u) => u.label),
      fragments: conversation.fragments.slice(1).map((m) => {
        const { snippet, speaker, timestamp, byteOffset, lineNumber } = byId.get(m.id)!;
        return { snippet: boundedRelevanceSnippet(snippet), speaker, timestamp, byteOffset, lineNumber };
      }),
      alsoIn: { count: group.length - 1, transcriptPaths: group.slice(1, 4).map((copy) => copy.path) },
    };
    items.push(item);
  }
  const strongTotal = ranked.filter((c) => c.units.size >= Math.ceil(units.length * 0.6)).length;
  const page: TranscriptSearchResult = {
    items, total: conversations.size, strongTotal, stats, order: "relevance", interpretedAs,
    ...(projectScope ? { projectScope } : {}), nextCursor: null,
  };
  const nextCursor = () => {
    if (!items.length || items.length === groupRows.length) return null;
    const visited = new Set(seen);
    for (const group of pageGroups.slice(0, items.length)) {
      for (const conversation of group) visited.add(fileIds.get(conversation.path)!);
    }
    return Buffer.from(JSON.stringify({ version: 6, scope, throughId, seen: encodeSeenFiles(visited),
      now, units, weights, ignored, retrieve } satisfies RelevanceCursor)).toString("base64url");
  };
  page.nextCursor = nextCursor();
  // Reserve 610 bytes per item for the route's title (100 UTF-16 units, each
  // at most six JSON bytes). Page by bytes as well as conversation count.
  // The cursor moves
  // only over returned groups, so trimming the tail never loses a result.
  while (Buffer.byteLength(JSON.stringify(page)) + items.length * 610 > TRANSCRIPT_RELEVANCE_PAGE_BYTES) {
    if (items.length <= 1) throw new TranscriptSearchPageTooLargeError();
    items.pop();
    page.nextCursor = nextCursor();
  }
  return page;
}

export function searchTranscripts(options: TranscriptSearchOptions): TranscriptSearchResult {
  const db = openQueryDatabase();
  try {
    db.exec("BEGIN");
    try {
      const stats = corpusStats(db);
      let projectScope: ProjectScope | undefined;
      if (options.project) {
        projectScope = resolveProjectScope(options.project, new Set(db.query<{ project: string }, []>("SELECT DISTINCT project FROM transcript_files").all().map((r) => r.project)));
        options = { ...options, project: projectScope.resolved ?? undefined };
      }
      if (options.order === "relevance") {
        let page = relevanceSearch(db, options, stats, projectScope)!;
        if (!options.cursor && !page.strongTotal) {
          // No strong match: compound terms and identifiers get one wider pass.
          // Its page replaces the literal one only when it holds a strong match.
          try {
            const wider = relevanceSearch(db, options, stats, projectScope, true);
            if (wider?.strongTotal) page = wider;
          } catch (error) {
            // A wider page that cannot fit never costs the literal answer.
            if (!(error instanceof TranscriptSearchPageTooLargeError)) throw error;
          }
        }
        if (Buffer.byteLength(JSON.stringify(page)) > TRANSCRIPT_RELEVANCE_PAGE_BYTES) throw new TranscriptSearchPageTooLargeError();
        return page;
      }
      const units = queryUnits(options.query);
      const originalQuery = units.map((u) => u.expression).join(" AND ");
      if (!originalQuery) return { items: [], nextCursor: null, total: 0, stats, order: "newest", ...(projectScope ? { projectScope } : {}) };
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
      const scope = cursorScope(originalQuery, options.project, options.speaker);
      const cursor = decodeCursor(options.cursor, scope);
      const ready = readySearchDatabases.has(db);
      const hasSequence = ready || Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_search_sequence'").get());
      const throughId = cursor?.throughId ?? (hasSequence
        ? db.query<{ last_id: number }, []>("SELECT last_id FROM transcript_search_sequence WHERE singleton = 1").get()!.last_id
        : db.query<{ last_id: number }, []>("SELECT COALESCE(MAX(id), 0) AS last_id FROM transcript_messages").get()!.last_id);
      // FTS5 constructs a prefix doclist even when just one dictionary word
      // matches. Small exact unions preserve prefix semantics at lower cost.
      // Scope stays bound to the original units as the vocabulary grows.
      // The high-water ID changes whenever indexing adds vocabulary. Deletes
      // can leave harmless extra exact terms in the union, but cannot add a
      // missing term. Bound retained expressions across query/state roots.
      const metadata = searchSchemas.get(db.filename);
      const expressionKey = ready && originalQuery.length <= 4096
        ? JSON.stringify([db.filename, metadata?.identity, metadata?.schema, throughId, originalQuery]) : undefined;
      const cachedExpression = expressionKey ? newestExpressions.get(expressionKey) : undefined;
      const expansion = ready && !cachedExpression ? db.query<{ term: string }, [string, string]>(
        "SELECT term FROM transcript_messages_vocab WHERE term >= ? AND term < ? LIMIT 17",
      ) : undefined;
      const query = cachedExpression ?? (expansion ? units.map((unit) => {
        if (unit.phrase) return unit.expression;
        const terms = unit.terms.flatMap((term) => {
          if (!term.prefix) return [`"${term.term.replaceAll('"', '""')}"`];
          const words = expansion.all(term.term, term.term + "\uffff");
          if (!words.length || words.length > 16) return [`"${term.term.replaceAll('"', '""')}"*`];
          return words.map(({ term }) => `"${term.replaceAll('"', '""')}"`);
        });
        return `(${terms.join(" OR ")})`;
      }).join(" AND ") : originalQuery);
      if (expressionKey && !cachedExpression && query.length <= 8192) {
        if (newestExpressions.size >= 128) newestExpressions.delete(newestExpressions.keys().next().value!);
        newestExpressions.set(expressionKey, query);
      }
      const hasSortTimestamp = ready || Boolean(db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info('transcript_messages') WHERE name = ?").get("sort_timestamp"));
      const timestampExpr = ready ? "m.sort_timestamp" : hasSortTimestamp
        ? "COALESCE(m.sort_timestamp, m.timestamp, f.mtime_ms / 1000.0)"
        : "COALESCE(m.timestamp, f.mtime_ms / 1000.0)";
      const hits = db.query(`
        SELECT transcript_messages_fts.rowid, m.speaker, m.body_hash,
          ${timestampExpr}, m.transcript_path
        FROM transcript_messages_fts
        JOIN transcript_messages AS m ON m.id = transcript_messages_fts.rowid
        ${ready ? "" : "JOIN transcript_files AS f ON f.path = m.transcript_path"}
        WHERE transcript_messages_fts MATCH ? AND m.id <= ?${options.speaker ? " AND m.speaker = ?" : ""}
      `).values(...(options.speaker ? [query, throughId, options.speaker] : [query, throughId])) as HitRow[];
      const paths = new Set<string>();
      for (const hit of hits) paths.add(hit[4]);
      const files = transcriptFiles(db, paths);
      const groups = new Map<string, CollapsedHit>();
      for (const [id, speaker, bodyHash, timestamp, transcriptPath] of hits) {
        const file = files.get(transcriptPath);
        /* A message whose transcript row is gone, or outside the requested
           project, is not a result — the inner join used to drop it. */
        if (!file || (options.project && file.project !== options.project)) continue;
        const hit: RankedHit = { id, speaker, timestamp, transcriptPath };
        const key = `${speaker}\0${bodyHash}`;
        const group = groups.get(key);
        if (!group) {
          groups.set(key, { newest: hit, duplicateCount: 1 });
          continue;
        }
        group.duplicateCount += 1;
        if (newerFirst(hit, group.newest) < 0) group.newest = hit;
      }
      const ranked = newestPage(groups.values(), cursor, limit + 1);
      const total = groups.size;
      const page = ranked.slice(0, limit);
      const items = pageItems(db, query, page, files);
      return {
        items,
        nextCursor: ranked.length > limit ? encodeCursor(page.at(-1)!.newest, throughId, scope) : null,
        total,
        stats,
        order: "newest",
        ...(projectScope ? { projectScope } : {}),
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}
