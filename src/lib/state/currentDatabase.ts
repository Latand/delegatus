import type { Database as BunDatabase } from "bun:sqlite";
import fs from "node:fs";

/**
 * A connection that stays bound to the file at its name (#1870 slice 10).
 *
 * The activation fallback swaps a damaged state database for a backup under
 * the same name, while other processes (the runtime host, MCP stdio servers,
 * a previous release) may hold connections to it. Such a connection keeps its
 * descriptors on the damaged inode: left alone, it would read the old data
 * and commit into the `.corrupt-*` files, and its commits would be lost.
 *
 * Each access through the returned handle first compares the file at the name
 * with the one this connection opened, and refuses while a swap is under way:
 * - outside a transaction, a replaced file is reopened, so the next statement
 *   reads and writes the database that now carries the name;
 * - inside one, `exec` (which carries every `COMMIT` here) rolls the
 *   transaction back and throws, so no commit lands in the moved file. The
 *   swap holds the old file's write lock while it moves the files, so a
 *   writer blocked behind it reaches this check before it can commit.
 *
 * Closing a connection to a moved file is safe: SQLite sees the move and
 * neither checkpoints nor deletes the WAL by name.
 */

export const DATABASE_SWAP_MARKER_SUFFIX = ".swapping";
/** A marker older than this was left by a swap that died; it is ignored. */
const SWAP_MARKER_STALE_MS = 10 * 60_000;

export class DatabaseReplacedError extends Error {
  readonly code = "LLV_DATABASE_REPLACED";
  constructor(message: string) {
    super(message);
    this.name = "DatabaseReplacedError";
  }
}

export function databaseFileIdentity(filename: string): string | null {
  try {
    const stat = fs.statSync(filename, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

export function databaseSwapMarker(filename: string): string {
  return `${filename}${DATABASE_SWAP_MARKER_SUFFIX}`;
}

export function databaseSwapInProgress(filename: string, now = Date.now()): boolean {
  try {
    return now - fs.statSync(databaseSwapMarker(filename)).mtimeMs < SWAP_MARKER_STALE_MS;
  } catch {
    return false;
  }
}

const GUARDED = new Set<PropertyKey>(["exec", "run", "query", "prepare", "transaction", "serialize", "loadExtension", "fileControl"]);
const OPEN_ATTEMPTS = 3;

export function openCurrentDatabase<T extends BunDatabase>(
  filename: string,
  open: () => T,
  options: {
    /** Runs on a connection opened to replace a moved one, through the
        returned handle (a fresh database needs its schema again). */
    reopened?: (db: T) => void;
  } = {},
): T {
  const connect = (): { db: T; identity: string | null } => {
    for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
      if (databaseSwapInProgress(filename)) {
        throw new DatabaseReplacedError(`${filename} is being restored from a backup; try again`);
      }
      const before = databaseFileIdentity(filename);
      const db = open();
      const after = databaseFileIdentity(filename);
      if ((before === null || before === after) && !databaseSwapInProgress(filename)) return { db, identity: after };
      db.close();
    }
    throw new DatabaseReplacedError(`${filename} kept changing while it was opened`);
  };
  let current = connect();
  let handle: T;
  const isCurrent = () => !databaseSwapInProgress(filename) && databaseFileIdentity(filename) === current.identity;
  const ensureCurrent = (carriesCommit: boolean) => {
    const db = current.db;
    if (db.inTransaction) {
      if (!carriesCommit || isCurrent()) return;
      try { db.exec("ROLLBACK"); } catch { /* already closed */ }
      throw new DatabaseReplacedError(`${filename} was replaced while this transaction was open; it was rolled back`);
    }
    if (isCurrent()) return;
    const next = connect();
    try { db.close(); } catch { /* closing a moved file only drops its descriptors */ }
    current = next;
    options.reopened?.(handle);
  };
  handle = new Proxy(current.db, {
    get(_target, property) {
      if (GUARDED.has(property)) ensureCurrent(property === "exec");
      const value = Reflect.get(current.db, property, current.db) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(current.db) : value;
    },
    set(_target, property, value) {
      return Reflect.set(current.db, property, value, current.db);
    },
  });
  return handle;
}
