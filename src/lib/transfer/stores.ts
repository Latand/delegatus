import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appConfigDir, stateDir } from "@/lib/configDir";
import { fsyncPath } from "@/lib/state/durableJson";
import { readStateImport } from "@/lib/state/sqliteStateStore";

/* Read access to a source install and file access on a target install for
   the transfer. The source is read from a `VACUUM INTO` copy of
   `state.sqlite` made in the OS temp directory, so an export holds only a read
   transaction on the live database for the copy's duration and every
   collection is read at one instant. Files are read as they are. */

type BunDatabase = import("bun:sqlite").Database;

function sqlite(): typeof import("bun:sqlite") {
  const builtin = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!builtin) throw new Error("the install transfer requires the Bun runtime");
  return builtin;
}

export interface StoredRow {
  key: string;
  value: unknown;
}

export const MAX_SETTINGS_FILE_BYTES = 64 * 1024 * 1024;

export type RegularFileRead =
  | { kind: "absent" }
  | { kind: "bytes"; bytes: Buffer }
  | { kind: "unsupported"; reason: "link" | "not-a-file" | "too-large" };

const READ_CHUNK_BYTES = 64 * 1024;

/** A regular file's bytes, at most `limit` of them, or why it is not read. A
    link, a FIFO, a device or a file past the bound is never opened for its
    content: the kind is checked before the open, the open neither follows a
    link nor waits on a FIFO, and the descriptor is checked again before the
    first byte is read, so a file swapped in between cannot block or overrun. */
export function readRegularFile(file: string, limit = MAX_SETTINGS_FILE_BYTES): RegularFileRead {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    /* A parent that is a file: nothing can be written beneath it. */
    if (code === "ENOTDIR") return { kind: "unsupported", reason: "not-a-file" };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: "unsupported", reason: "link" };
  if (!stat.isFile()) return { kind: "unsupported", reason: "not-a-file" };
  if (stat.size > limit) return { kind: "unsupported", reason: "too-large" };
  let descriptor: number;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP") return { kind: "unsupported", reason: "link" };
    if (code === "ENOTDIR" || code === "ENXIO") return { kind: "unsupported", reason: "not-a-file" };
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) return { kind: "unsupported", reason: "not-a-file" };
    if (opened.size > limit) return { kind: "unsupported", reason: "too-large" };
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (!read) break;
      total += read;
      /* Grown past the bound since the check. */
      if (total > limit) return { kind: "unsupported", reason: "too-large" };
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    return { kind: "bytes", bytes: Buffer.concat(chunks, total) };
  } finally { fs.closeSync(descriptor); }
}

function readText(file: string, limit = MAX_SETTINGS_FILE_BYTES): string | null {
  const read = readRegularFile(file, limit);
  return read.kind === "bytes" ? read.bytes.toString("utf8") : null;
}

function listNames(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
}

export interface TelegramChatRow {
  chat_id: string;
  type: string;
  title: string;
  alias: string | null;
  post_allowed: number;
}

export class SourceSnapshot {
  private readonly db: BunDatabase | null;

  constructor(readonly stateDirectory: string, readonly configDirectory: string, private readonly snapshotDirectory: string | null, snapshotFile: string | null) {
    this.db = snapshotFile ? new (sqlite().Database)(snapshotFile, { readonly: true, strict: true }) : null;
  }

  /** Every row of one collection in its stored order. */
  rows(collection: string): StoredRow[] {
    if (!this.db) return [];
    const table = this.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_rows'").get();
    if (!table) return [];
    return this.db.query<{ row_key: string; value_json: string }, [string]>(
      "SELECT row_key, value_json FROM state_rows WHERE collection = ? ORDER BY row_order, row_key",
    ).all(collection).map(row => ({ key: row.row_key, value: JSON.parse(row.value_json) as unknown }));
  }

  private readonly memos = new Map<string, unknown>();

  /** One computation per snapshot, for parts that must read the same thing. */
  memo<T>(key: string, compute: () => T): T {
    if (!this.memos.has(key)) this.memos.set(key, compute());
    return this.memos.get(key) as T;
  }

  stateText(relative: string): string | null { return readText(path.join(this.stateDirectory, relative)); }
  configText(relative: string): string | null { return readText(path.join(this.configDirectory, relative)); }
  stateNames(relativeDirectory: string): string[] { return listNames(path.join(this.stateDirectory, relativeDirectory)); }
  configNames(): string[] { return listNames(this.configDirectory); }

  /** Chats with an alias or posting permission, and the bot they belong to.
      Read-only from the bot's own database; the token file is never opened. */
  telegramChats(): { bot: string | null; chats: TelegramChatRow[] } {
    const file = path.join(this.stateDirectory, "telegram", "bot.sqlite");
    if (!fs.existsSync(file)) return { bot: null, chats: [] };
    const db = new (sqlite().Database)(file, { readonly: true, strict: true });
    try {
      const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      if (!tables.has("chats")) return { bot: null, chats: [] };
      const bot = tables.has("bot") ? db.query<{ username: string | null; name: string }, []>("SELECT username, name FROM bot WHERE id = 1").get() : null;
      const chats = db.query<TelegramChatRow, []>(
        "SELECT chat_id, type, title, alias, post_allowed FROM chats WHERE alias IS NOT NULL OR post_allowed = 1 ORDER BY chat_id",
      ).all();
      return { bot: bot?.username ?? bot?.name ?? null, chats };
    } finally { db.close(); }
  }

  close(): void {
    this.db?.close();
    if (this.snapshotDirectory) fs.rmSync(this.snapshotDirectory, { recursive: true, force: true });
  }
}

/** A `VACUUM INTO` copy of this install's state database in the OS temp
    directory; only a read transaction is held on the live file. */
export function takeSourceSnapshot(directory = stateDir(), configDirectory = appConfigDir()): SourceSnapshot {
  const live = path.join(directory, "state.sqlite");
  if (!fs.existsSync(live)) return new SourceSnapshot(directory, configDirectory, null, null);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-export-"));
  fs.chmodSync(scratch, 0o700);
  const copy = path.join(scratch, "state.sqlite");
  try {
    const source = new (sqlite().Database)(live, { readonly: true, strict: true });
    try {
      source.exec("PRAGMA busy_timeout = 5000");
      source.query("VACUUM INTO ?").run(copy);
    } finally { source.close(); }
    return new SourceSnapshot(directory, configDirectory, scratch, copy);
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/* ── Target side ─────────────────────────────────────────────────────── */

export function targetRoot(root: "state" | "config"): string {
  return root === "state" ? stateDir() : appConfigDir();
}

/** A target file as the import may read it. `unsupported` is a file that is
    there and that the import never reads or replaces: a link, something other
    than a regular file, or one past the size bound. Read as absent, it would be
    planned as new and overwritten with a fresh skeleton. */
export type TargetText =
  | { kind: "absent" }
  | { kind: "text"; text: string }
  | { kind: "unsupported"; reason: "link" | "not-a-file" | "too-large" };

export function readTargetText(root: "state" | "config", relative: string, limit = MAX_SETTINGS_FILE_BYTES): TargetText {
  const read = readRegularFile(path.join(targetRoot(root), relative), limit);
  return read.kind === "bytes" ? { kind: "text", text: read.bytes.toString("utf8") } : read;
}

/** A file's revision for the dry run: absent, a hash of its bytes, or, for a
    file the import never reads (§4.5: a link, not a regular file, past the
    bound), its kind alone, taken without opening it. A hash rather than a
    time, so a file put back by a rolled-back import still reads as the file
    the dry run saw. */
export function fileRevision(root: "state" | "config", relative: string): string {
  const read = readRegularFile(path.join(targetRoot(root), relative));
  if (read.kind === "absent") return "absent";
  if (read.kind === "unsupported") return `unsupported:${read.reason}`;
  return crypto.createHash("sha256").update(read.bytes).digest("hex");
}

/** What is at a target path, without reading it. */
export function targetFileKind(root: "state" | "config", relative: string): "absent" | "file" | "unsupported" {
  try {
    const stat = fs.lstatSync(path.join(targetRoot(root), relative));
    return stat.isFile() ? "file" : "unsupported";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code === "ENOTDIR") return "unsupported";
    throw error;
  }
}

/** Thrown when the file system refuses the link that puts a new file in
    place: the import is refused with nothing written to the target name. */
export class TransferLinkRefusedError extends Error {
  readonly code = "ETRANSFERLINK";
  constructor(cause: unknown) {
    super("this file system refuses hard links, so the import cannot create a new settings file whole; nothing was written", { cause });
    this.name = "TransferLinkRefusedError";
  }
}

/** Create a file that must not exist yet, whole or not at all: written aside,
    then linked into place, which fails with EEXIST when anything holds the
    name by then. A file system that refuses links refuses the creation: an
    exclusive create in place would show the name before its bytes, and a
    stop or a failed write in between would leave a partial file nobody could
    tell from a later writer's. */
export function createFileExclusive(target: string, text: string, options: { staging?: string; beforeLink?: () => void } = {}): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = options.staging ?? path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.transfer.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fsyncPath(temporary);
    options.beforeLink?.();
    try { fs.linkSync(temporary, target); }
    catch (error) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new TransferLinkRefusedError(error);
      throw error;
    }
    fsyncPath(path.dirname(target));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Whether one row is committed in `state.sqlite`, read from the database
    itself. Unlike the collections' own readers, which take an unreadable
    database for one not initialized yet, any failure to answer throws: a
    caller deciding between finishing and undoing a commit must not guess. */
export function targetRowCommitted(collection: string, key: string): boolean {
  const file = path.join(stateDir(), "state.sqlite");
  try { fs.statSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const db = new (sqlite().Database)(file, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const table = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_rows'").get();
    if (!table) return false;
    return !!db.query<{ found: number }, [string, string]>("SELECT 1 AS found FROM state_rows WHERE collection = ? AND row_key = ?").get(collection, key);
  } finally { db.close(); }
}

/** Write through a temporary file and a rename, owner-only, then fsync the file
    and its directory. `staging` names the temporary file, so whoever knows the
    name can remove what a stop left of it. */
export function writeFileAtomic(target: string, text: string, staging?: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = staging ?? path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.transfer.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fsyncPath(temporary);
    fs.renameSync(temporary, target);
    fsyncPath(path.dirname(target));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Rows of one collection on the target, read in one read transaction. Null when the collection does not exist yet. */
export function readTargetRows(collection: string): { revision: number; schemaVersion: number; rows: Map<string, string> } | null {
  const file = path.join(stateDir(), "state.sqlite");
  if (!fs.existsSync(file)) return null;
  const db = new (sqlite().Database)(file, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN");
    try {
      const meta = db.query<{ revision: number; schema_version: number }, [string]>(
        "SELECT revision, schema_version FROM state_collections WHERE collection = ?",
      ).get(collection);
      if (!meta) return null;
      const rows = new Map(db.query<{ row_key: string; value_json: string }, [string]>(
        "SELECT row_key, value_json FROM state_rows WHERE collection = ?",
      ).all(collection).map(row => [row.row_key, row.value_json] as const));
      return { revision: meta.revision, schemaVersion: meta.schema_version, rows };
    } finally { db.exec("COMMIT"); }
  } catch (error) {
    if (/no such table/.test(String(error))) return null;
    throw error;
  } finally { db.close(); }
}

/** Whether a legacy JSON store has been imported into `state.sqlite` on this install. */
export function legacyStoreImported(collection: string): boolean {
  return readStateImport(path.join(stateDir(), "state.sqlite"), collection) !== null;
}
