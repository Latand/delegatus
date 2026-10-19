import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import type { ImportCandidate, ImportRecord } from "./importTypes";
import { validateImportId } from "./importTypes";
import { repositoryRootForPath } from "@/lib/projects/identity";

export type ImportLookup = { kind: "lookup"; id: string; importId: string; key: string };
export type ImportRow = ImportCandidate | ImportRecord | ImportLookup;
const key = (row: ImportRow) => row.kind === "import" ? `i:${row.id}` : row.kind === "lookup" ? `d:${row.importId}:${row.id}` : `c:${row.importId}:${row.group}:${String(row.part.index).padStart(8, "0")}`;
const seed = { collection: "role_memory_import", schemaVersion: 1, migrationId: "role-memory-import-v1", key, loadRecords: (): ImportRow[] => [] };
export function assertPrivateImportDatabaseFiles(file = statePath("state.sqlite")) {
  const directory = path.dirname(path.resolve(file));
  for (const candidate of new Set([directory, (() => { try { return fs.realpathSync(directory); } catch { return directory; } })()])) {
    if (repositoryRootForPath(candidate)) throw Error("memory import: backup_refused");
  }
  for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    let stat: ReturnType<typeof fs.lstatSync>;
    try { stat = fs.lstatSync(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw Error("memory import: backup_refused");
  }
}
const owner = globalThis as typeof globalThis & { __delegatusImportCollection?: { file: string; held: SqliteStateCollection<ImportRow> } };
export function importCollection(create = false) {
  const file = statePath("state.sqlite");
  assertPrivateImportDatabaseFiles(file);
  const ready = stateCollectionsInitialized(file, [seed]);
  if (!ready && !create) return null;
  if (!ready) initializeStateCollections(file, [seed]);
  if (owner.__delegatusImportCollection?.file === file) return owner.__delegatusImportCollection.held;
  // Compiled Viewer entry points share one current collection owner. Its
  // connection follows a restored database through openCurrentDatabase.
  const held = new SqliteStateCollection<ImportRow>(file, { collection: seed.collection, schemaVersion: 1, key, clone: structuredClone, strictDecode: true, busyMessage: "memory import busy",
    decode: value => {
      if (!value || typeof value !== "object") return null;
      const row = value as ImportRow;
      if (typeof row.id !== "string") return null;
      if (row.kind === "lookup") return typeof row.key === "string" && typeof row.importId === "string" ? row : null;
      if (row.kind === "import") return ["copying", "ready", "failed"].includes(row.state) ? row : null;
      return row.kind === "candidate" && typeof row.importId === "string" && typeof row.group === "string" && typeof row.body === "string" && Array.isArray(row.occurrences) && row.occurrences.length > 0 ? row : null;
    },
  });
  owner.__delegatusImportCollection = { file, held };
  return held;
}

export function readImportRecord(id: string): ImportRecord | null {
  validateImportId(id);
  const row = importCollection(false)?.get(`i:${id}`);
  return row?.kind === "import" ? row : null;
}

/** Only the curator reads candidate bodies. Status routes read the separate
 * import record's counts. Keyset
 * pages select one import before decoding; unfinished imports expose no text. */
export function readImportCandidates(id: string, cursor = "", limit = 40): { candidates: ImportCandidate[]; cursor: string | null } {
  validateImportId(id);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40) throw Error("invalid memory import page");
  const prefix = `c:${id}:`;
  if (cursor && (!cursor.startsWith(prefix) || cursor.length > 300)) throw Error("invalid memory import cursor");
  if (readImportRecord(id)?.state !== "ready") return { candidates: [], cursor: null };
  const held = importCollection(false)!;
  const rows = held.keyRangeEntries(cursor || prefix, `${prefix}\uffff`, limit + 1);
  const candidates: ImportCandidate[] = [];
  let bytes = 0, next = cursor;
  for (const item of rows.slice(0, limit)) {
    if (item.value?.kind !== "candidate") throw Error("invalid memory import row");
    const size = Buffer.byteLength(item.value.body);
    if (bytes + size > 64 * 1024) break;
    bytes += size; candidates.push(item.value); next = item.key;
  }
  return { candidates, cursor: rows.length > candidates.length ? next : null };
}

/** Called only by the background job, with asynchronous state admission. The
 * ready record is committed last, so a stopped worker cannot expose a partial batch. */
export function withImportLookups(rows: readonly ImportRow[]): ImportRow[] {
  return rows.flatMap((row): ImportRow[] => row.kind === "candidate" ? [row, { kind: "lookup", id: row.id, importId: row.importId, key: key(row) }] : [row]);
}
export async function writeImportRows(rows: readonly ImportRow[], guard: () => void = () => {}) {
  await waitForStateLock("memory.import", () => {
    guard();
    const writes = withImportLookups(rows);
    importCollection(true)!.boundedPatch(writes.length, tx => { guard(); for (const row of writes) tx.put(row); });
  });
}
