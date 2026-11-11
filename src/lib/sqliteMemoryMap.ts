/**
 * Memory-mapped reads for the state databases, in the serving Viewer.
 *
 * SQLite reads every large stored value straight from the file, past its page
 * cache, and in WAL mode a commit by any connection empties the page cache of
 * every other one. A Viewer beside busy writers therefore issued tens of
 * thousands of 4 KiB `pread` calls a second on its main thread, and a larger
 * `cache_size` changes neither path. With `mmap_size` set, those reads copy
 * from the mapping, which the operating system shares between connections and
 * processes.
 *
 * Only a process that asked for it maps anything. Mapped file pages count in
 * a process's resident set once per connection that touched them, and worker
 * processes are retired on their resident set, so they keep reading as before.
 *
 * `LLV_SQLITE_MMAP_MB` sets the size per connection; `0` turns it off. The
 * default applies on Linux alone: on Windows a mapped file cannot be shortened
 * by another process's checkpoint, and macOS runs the SQLite Apple ships.
 * SQLite caps the value at its own build limit (2 GiB less 64 KiB in Bun's),
 * and reads past the mapping keep using read calls.
 */

export const SQLITE_MMAP_ENV = "LLV_SQLITE_MMAP_MB";
const DEFAULT_LINUX_MB = 2047;
const MIB = 1024 * 1024;

/* The Viewer loads modules through more than one bundle; the choice is the
   process's, so it lives on the global object. */
const owner = globalThis as typeof globalThis & { __llvSqliteMemoryMap?: boolean };

/** Called once by the serving Viewer before it opens its databases. */
export function enableSqliteMemoryMap(enabled = true): void {
  owner.__llvSqliteMemoryMap = enabled;
}

export function sqliteMemoryMapBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): number {
  if (!owner.__llvSqliteMemoryMap) return 0;
  const raw = env[SQLITE_MMAP_ENV]?.trim();
  if (!raw) return platform === "linux" ? DEFAULT_LINUX_MB * MIB : 0;
  const megabytes = Number(raw);
  return Number.isFinite(megabytes) && megabytes > 0 ? Math.floor(megabytes) * MIB : 0;
}

/** Ask a freshly opened connection to map its database file for reads. */
export function applySqliteMemoryMap(db: { exec(sql: string): unknown }): void {
  const bytes = sqliteMemoryMapBytes();
  if (!bytes) return;
  try { db.exec(`PRAGMA mmap_size = ${bytes}`); } catch { /* the connection keeps reading through read calls */ }
}
