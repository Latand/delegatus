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

function readText(file: string, limit = MAX_SETTINGS_FILE_BYTES): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > limit) return null;
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
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

/** The target's file as text, or null when absent. */
export function readTargetText(root: "state" | "config", relative: string): string | null {
  return readText(path.join(targetRoot(root), relative));
}

/** A file's revision for the dry run: absent, or a hash of its bytes. A hash
    rather than a time, so a file put back by a rolled-back import still reads
    as the file the dry run saw. */
export function fileRevision(root: "state" | "config", relative: string): string {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(targetRoot(root), relative))).digest("hex"); }
  catch { return "absent"; }
}

/** Write through a temporary file and a rename, owner-only, then fsync the file and its directory. */
export function writeFileAtomic(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.transfer.tmp`);
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
