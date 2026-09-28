/**
 * `task_tombstones` (docs/design/linked-installs.md M.3): deletes of linked
 * tasks, the per-project stamp floor, and the withheld stubs a peer sent. A
 * separate collection, so a rollback release that reads only `tasks` keeps
 * loading its task list.
 */
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";

import { isStamp } from "./stamp";

/* A stored row carries no copy of its key, which is derived from its fields,
   so a tombstone stays inside the 200 bytes of M.9. `last`, the largest stamp
   seen for the id, is stored only when it is above `gone`. */
export type TaskTombstone = { id: string; project: string; gone: string; last?: string; o: string };
export type ProjectFloor = { project: string; floor: string };
export type WithheldStub = { id: string; project: string; withheld: string };
export type TombstoneRow = TaskTombstone | ProjectFloor | WithheldStub;

export const tombstoneKey = (id: string) => `g:${id}`;
export const floorKey = (project: string) => `floor:${project}`;
export const stubKey = (id: string) => `w:${id}`;
export const isTombstone = (row: TombstoneRow | null | undefined): row is TaskTombstone => !!row && "gone" in row;
export const isFloor = (row: TombstoneRow | null | undefined): row is ProjectFloor => !!row && "floor" in row;
export const isStub = (row: TombstoneRow | null | undefined): row is WithheldStub => !!row && "withheld" in row;
export const tombstoneRowKey = (row: TombstoneRow): string => isTombstone(row) ? tombstoneKey(row.id) : isFloor(row) ? floorKey(row.project) : stubKey(row.id);

const seed = { collection: "task_tombstones", schemaVersion: 1, migrationId: "linked-boards-m2", key: tombstoneRowKey, loadRecords: (): TombstoneRow[] => [] };
const cache = new Map<string, SqliteStateCollection<TombstoneRow>>();

function decode(value: unknown): TombstoneRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.project !== "string") return null;
  const kinds = ["gone", "floor", "withheld"].filter((field) => field in row);
  if (kinds.length !== 1) return null;
  if (kinds[0] === "gone") return typeof row.id === "string" && isStamp(row.gone) && (row.last === undefined || isStamp(row.last)) && typeof row.o === "string" ? row as TaskTombstone : null;
  if (kinds[0] === "floor") return isStamp(row.floor) ? row as ProjectFloor : null;
  return typeof row.id === "string" && isStamp(row.withheld) ? row as WithheldStub : null;
}

/** The collection beside `tasks` in `database`; `create` initializes it. */
export function tombstoneCollection(database: string, create: boolean): SqliteStateCollection<TombstoneRow> | null {
  const held = cache.get(database);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(database, [seed])) return null;
  if (create) initializeStateCollections(database, [seed]);
  const opened = new SqliteStateCollection<TombstoneRow>(database, {
    collection: "task_tombstones", schemaVersion: 1, busyMessage: "task tombstones busy", key: tombstoneRowKey,
    decode, clone: structuredClone, strictDecode: true,
  });
  cache.set(database, opened);
  return opened;
}
