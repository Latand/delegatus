import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import type { ImportCandidate, ImportRecord } from "./importTypes";
import { validateImportId } from "./importTypes";
import { repositoryRootForPath } from "@/lib/projects/identity";

type Row = ImportCandidate | ImportRecord;
const key = (row: Row) => row.kind === "import" ? `i:${row.id}` : `c:${row.importId}:${row.group}:${String(row.part.index).padStart(8, "0")}`;
const seed = { collection: "role_memory_import", schemaVersion: 1, migrationId: "role-memory-import-v1", key, loadRecords: (): Row[] => [] };
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
function collection(create: boolean) {
  const file = statePath("state.sqlite");
  assertPrivateImportDatabaseFiles(file);
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  return new SqliteStateCollection<Row>(file, { collection: seed.collection, schemaVersion: 1, key, clone: structuredClone, strictDecode: true, busyMessage: "memory import busy",
    decode: value => {
      if (!value || typeof value !== "object") return null;
      const row = value as Row;
      if (typeof row.id !== "string") return null;
      if (row.kind === "import") return ["copying", "ready", "failed"].includes(row.state) ? row : null;
      return row.kind === "candidate" && typeof row.importId === "string" && typeof row.group === "string" && typeof row.body === "string" && Array.isArray(row.occurrences) && row.occurrences.length > 0 ? row : null;
    },
  });
}

export function readImportRecord(id: string): ImportRecord | null {
  validateImportId(id);
  const row = collection(false)?.get(`i:${id}`);
  return row?.kind === "import" ? row : null;
}

/** Private server read for the curator integration. No route, search index,
 * publication matcher or prompt renderer consumes this collection. Keyset
 * pages select one import before decoding; unfinished imports expose no text. */
export function readImportCandidates(id: string, cursor = "", limit = 40): { candidates: ImportCandidate[]; cursor: string | null } {
  validateImportId(id);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40) throw Error("invalid memory import page");
  const prefix = `c:${id}:`;
  if (cursor && (!cursor.startsWith(prefix) || cursor.length > 300)) throw Error("invalid memory import cursor");
  if (readImportRecord(id)?.state !== "ready") return { candidates: [], cursor: null };
  const held = collection(false)!;
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
export async function writeImportRows(rows: readonly Row[], guard: () => void = () => {}) {
  await waitForStateLock("memory.import", () => {
    guard();
    collection(true)!.boundedPatch(rows.length, tx => { guard(); for (const row of rows) tx.put(row); });
  });
}
