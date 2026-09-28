import { randomUUID } from "node:crypto";

import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import type { SharedProject } from "./state";

type BoardLink = { key: string; store: string; shared: SharedProject[] };
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

export function remoteProjects(id: string): SharedProject[] { return collection(false)?.get(`peer:${id}`)?.shared ?? []; }
export function remoteStore(id: string): string | null { return collection(false)?.get(`peer:${id}`)?.store ?? null; }

/** The board store has its own identity, separate from the install's self.json id. */
export function ownBoardStoreId(): string {
  const opened = collection(true)!;
  const held = opened.get("self");
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
  const current = collection(false)?.get(key);
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
  const key = `peer:${id}`;
  const opened = collection(false);
  if (!opened?.get(key)) return;
  opened.boundedPatch(2, (tx) => { if (tx.get(key)) tx.delete(key); });
}
