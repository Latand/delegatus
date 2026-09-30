import { randomUUID } from "node:crypto";

import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import type { SharedProject } from "./state";

/** A's task cursors for one link (M.3 "Link state"): what it has pulled from
    and pushed to the peer store named by `store`, and the linked projects
    whose rows have fully crossed each way. */
export type TaskCursor = { pull: [number] | [number, string] | null; pushed: [number] | [number, string] | null; pullCovered: string[]; pushCovered: string[] };
type BoardLink = { key: string; store: string; shared: SharedProject[]; cursor?: TaskCursor; taskWireVersion?: number };
const seed = { collection: "board_links", schemaVersion: 1, migrationId: "linked-boards-m1", key: (row: BoardLink) => row.key, loadRecords: (): BoardLink[] => [] };
const cache = new Map<string, SqliteStateCollection<BoardLink>>();

function collection(create: boolean): SqliteStateCollection<BoardLink> | null {
  const file = statePath("state.sqlite");
  const held = cache.get(file);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const opened = new SqliteStateCollection<BoardLink>(file, {
    collection: "board_links", schemaVersion: 1, busyMessage: "board links busy", key: (row) => row.key,
    decode: (value) => value && typeof value === "object" && typeof (value as BoardLink).key === "string" &&
      typeof (value as BoardLink).store === "string" && Array.isArray((value as BoardLink).shared) ? value as BoardLink : null,
    clone: structuredClone, strictDecode: true,
  });
  cache.set(file, opened);
  return opened;
}

/* Point reads are answered from memory while the collection revision holds;
   the revision comes from the store's cached file signature, so an idle sync
   call reads no row on either side (M.9 "Idle call, work"). */
const rows = new WeakMap<SqliteStateCollection<BoardLink>, { revision: number; rows: Map<string, BoardLink | null> }>();
function readRow(key: string, opened = collection(false)): BoardLink | null {
  if (!opened) return null;
  const revision = opened.revision();
  let held = rows.get(opened);
  if (held?.revision !== revision) { held = { revision, rows: new Map() }; rows.set(opened, held); }
  if (!held.rows.has(key)) held.rows.set(key, opened.get(key));
  const row = held.rows.get(key)!;
  return row && structuredClone(row);
}

/** Changes whenever a link row does; the linked-project cache keys on it. */
export function boardLinksRevision(): number { return collection(false)?.revision() ?? -1; }

export function remoteProjects(id: string): SharedProject[] { return readRow(`peer:${id}`)?.shared ?? []; }
export function remoteStore(id: string): string | null { return readRow(`peer:${id}`)?.store ?? null; }

/** The board store has its own identity, separate from the install's self.json id. */
export function ownBoardStoreId(): string {
  const opened = collection(true)!;
  const held = readRow("self", opened);
  if (held) return held.store;
  return opened.boundedPatch(2, (tx) => {
    const current = tx.get("self");
    if (current) return current.store;
    const store = randomUUID();
    tx.put({ key: "self", store, shared: [] });
    return store;
  });
}

/** The first exchange records the store; an identical idle exchange writes nothing. */
export function updateRemoteProjects(id: string, list: SharedProject[], store: string): boolean {
  const key = `peer:${id}`;
  const current = readRow(key);
  if (current?.store === store && JSON.stringify(current.shared) === JSON.stringify(list)) return false;
  const opened = collection(true)!;
  return opened.boundedPatch(2, (tx) => {
    const held = tx.get(key);
    if (held?.store === store && JSON.stringify(held.shared) === JSON.stringify(list)) return false;
    tx.put({ key, store, shared: list });
    return true;
  });
}

export function dropRemoteProjects(id: string): void {
  const keys = [`peer:${id}`, `tasks:${id}`];
  const opened = collection(false);
  if (!keys.some((key) => readRow(key, opened))) return;
  opened!.boundedPatch(4, (tx) => { for (const key of keys) if (tx.get(key)) tx.delete(key); });
}

export function readTaskCursor(id: string, store: string): TaskCursor | null {
  const row = readRow(`tasks:${id}`);
  // The first v2 exchange scans both ways to restore previously withheld titles.
  return row?.cursor && row.store === store && row.taskWireVersion === 2 ? row.cursor : null;
}

/** Writes only a changed cursor. */
export function writeTaskCursor(id: string, store: string, cursor: TaskCursor): void {
  const key = `tasks:${id}`;
  const next: BoardLink = { key, store, shared: [], cursor, taskWireVersion: 2 };
  const held = readRow(key);
  if (held && JSON.stringify(held) === JSON.stringify(next)) return;
  collection(true)!.boundedPatch(2, (tx) => {
    const current = tx.get(key);
    if (current && JSON.stringify(current) === JSON.stringify(next)) return;
    tx.put(next);
  });
}
