/**
 * `task_tombstones` (docs/design/linked-installs.md M.3): deletes of linked
 * tasks, the per-project stamp floor, and the withheld stubs a peer sent. A
 * separate collection, so a rollback release that reads only `tasks` keeps
 * loading its task list.
 */
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";

import { isStamp } from "./stamp";

export type TaskTombstone = { key: string; id: string; project: string; gone: string; last: string; o: string };
export type ProjectFloor = { key: string; project: string; floor: string };
export type WithheldStub = { key: string; id: string; project: string; withheld: string };
export type TombstoneRow = TaskTombstone | ProjectFloor | WithheldStub;

export const tombstoneKey = (id: string) => `g:${id}`;
export const floorKey = (project: string) => `floor:${project}`;
export const stubKey = (id: string) => `w:${id}`;
export const isTombstone = (row: TombstoneRow | null | undefined): row is TaskTombstone => !!row && row.key.startsWith("g:");
export const isFloor = (row: TombstoneRow | null | undefined): row is ProjectFloor => !!row && row.key.startsWith("floor:");
export const isStub = (row: TombstoneRow | null | undefined): row is WithheldStub => !!row && row.key.startsWith("w:");

const seed = { collection: "task_tombstones", schemaVersion: 1, migrationId: "linked-boards-m2", key: (row: TombstoneRow) => row.key, loadRecords: (): TombstoneRow[] => [] };
const cache = new Map<string, SqliteStateCollection<TombstoneRow>>();

function decode(value: unknown): TombstoneRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.key !== "string" || typeof row.project !== "string") return null;
  if (row.key.startsWith("g:")) return typeof row.id === "string" && isStamp(row.gone) && isStamp(row.last) && typeof row.o === "string" ? row as TaskTombstone : null;
  if (row.key.startsWith("floor:")) return isStamp(row.floor) ? row as ProjectFloor : null;
  if (row.key.startsWith("w:")) return typeof row.id === "string" && isStamp(row.withheld) ? row as WithheldStub : null;
  return null;
}

/** The collection beside `tasks` in `database`; `create` initializes it. */
export function tombstoneCollection(database: string, create: boolean): SqliteStateCollection<TombstoneRow> | null {
  const held = cache.get(database);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(database, [seed])) return null;
  if (create) initializeStateCollections(database, [seed]);
  const opened = new SqliteStateCollection<TombstoneRow>(database, {
    collection: "task_tombstones", schemaVersion: 1, busyMessage: "task tombstones busy", key: (row) => row.key,
    decode, clone: structuredClone, strictDecode: true,
  });
  cache.set(database, opened);
  return opened;
}
