import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";

import type { DoneItemV1 } from "./types";

/*
 * The «Готово» store (docs/design/done-section.md §3): the `done_items`
 * collection of `state.sqlite`, one row per item keyed by its deterministic
 * key, holding the item and its acknowledgement together, plus one meta row
 * with the instant the store was first written. A row is never re-created: an
 * acknowledged key stays acknowledged whatever its source does next, and it is
 * kept 30 days past its acknowledgement, longer than the 7-day window any
 * source is read over, so its event cannot come back as a new item.
 */

export const DONE_ITEMS_COLLECTION = "done_items";
export const DONE_META_KEY = "meta";
/** Acknowledged rows are kept this long after their acknowledgement. */
export const DONE_ACKNOWLEDGED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Past this many rows the oldest acknowledged go first. */
export const DONE_MAX_ROWS = 2_000;

interface DoneMetaV1 {
  key: typeof DONE_META_KEY;
  activation: string;
}

type DoneRow = DoneItemV1 | DoneMetaV1;

const isMeta = (row: DoneRow): row is DoneMetaV1 => row.key === DONE_META_KEY;

function decode(value: unknown): DoneRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<DoneItemV1> & Partial<DoneMetaV1>;
  if (row.key === DONE_META_KEY) return typeof row.activation === "string" ? { key: DONE_META_KEY, activation: row.activation } : null;
  if (typeof row.key !== "string" || typeof row.kind !== "string" || typeof row.look !== "string" || typeof row.at !== "string"
    || typeof row.createdAt !== "string" || typeof row.title !== "string" || !row.refs || typeof row.refs !== "object") return null;
  return row as DoneItemV1;
}

const SEED: StateCollectionSeed<unknown> = {
  collection: DONE_ITEMS_COLLECTION,
  schemaVersion: 1,
  migrationId: "done-items-v1",
  key: (raw) => (raw as DoneRow).key,
  loadRecords: () => [],
};

const collections = new Map<string, { identity: string; collection: SqliteStateCollection<DoneRow> }>();

function identity(filename: string): string {
  try {
    const stat = fs.statSync(filename);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "absent";
  }
}

export function doneDatabase(): string {
  return statePath("state.sqlite");
}

/** The collection, created on first write. A read before any write answers
    null: nothing has been projected yet. */
function collection(purpose: "read" | "write", filename = doneDatabase()): SqliteStateCollection<DoneRow> | null {
  const held = collections.get(filename);
  if (held && held.identity === identity(filename)) return held.collection;
  if (purpose === "read" && !stateCollectionsInitialized(filename, [SEED])) return null;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  initializeStateCollections(filename, [SEED]);
  const opened = new SqliteStateCollection<DoneRow>(filename, {
    collection: DONE_ITEMS_COLLECTION,
    schemaVersion: 1,
    busyMessage: "the done items are busy",
    key: (row) => row.key,
    decode,
    clone: structuredClone,
    strictDecode: false,
  });
  collections.set(filename, { identity: identity(filename), collection: opened });
  return opened;
}

export function resetDoneCollectionsForTests(): void {
  collections.clear();
}

export function doneRevision(): number {
  return collection("read")?.revision() ?? 0;
}

/** Every item row, acknowledged or not. */
export function readDoneRows(): DoneItemV1[] {
  return (collection("read")?.snapshot() ?? []).filter((row): row is DoneItemV1 => !isMeta(row));
}

/** The items still waiting on the operator, newest event first. */
export function unacknowledgedDoneItems(): DoneItemV1[] {
  return readDoneRows().filter((row) => !row.acknowledgedAt).sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || left.key.localeCompare(right.key));
}

/** The instant the store was first written, recorded on the first call. */
export function doneActivation(now: number): string {
  const store = collection("write")!;
  const held = store.get(DONE_META_KEY);
  if (held && isMeta(held)) return held.activation;
  let activation = new Date(now).toISOString();
  store.patchSync(() => {
    const current = store.get(DONE_META_KEY);
    if (current && isMeta(current)) {
      activation = current.activation;
      return { records: [] };
    }
    return { records: [{ key: DONE_META_KEY, activation }] };
  });
  return activation;
}

export interface DoneWrite {
  /** Rows the projection inserts or refreshes. */
  upserts: readonly DoneItemV1[];
}

/**
 * Write one projection: a key the store has never seen is inserted, an
 * unacknowledged row is refreshed (its title, its limit text and its frame),
 * and an acknowledged row is left exactly as it is. Retention runs in the
 * same write. Answers how many rows changed.
 */
export function writeDoneProjection(write: DoneWrite, now: number): { inserted: number; updated: number; deleted: number } {
  const store = collection("write")!;
  let counts = { inserted: 0, updated: 0, deleted: 0 };
  store.patchSync(() => {
    const rows = new Map(store.snapshot().filter((row): row is DoneItemV1 => !isMeta(row)).map((row) => [row.key, row] as const));
    const records: DoneItemV1[] = [];
    counts = { inserted: 0, updated: 0, deleted: 0 };
    for (const next of write.upserts) {
      const held = rows.get(next.key);
      if (!held) {
        records.push(next);
        rows.set(next.key, next);
        counts.inserted += 1;
        continue;
      }
      if (held.acknowledgedAt) continue;
      const refreshed: DoneItemV1 = {
        ...held,
        title: next.title,
        look: next.look,
        refs: next.refs,
        frame: next.frame,
        frameCheckedAt: next.frameCheckedAt,
      };
      if (JSON.stringify(refreshed) === JSON.stringify(held)) continue;
      records.push(refreshed);
      rows.set(next.key, refreshed);
      counts.updated += 1;
    }
    const deleteKeys = retained([...rows.values()], now);
    counts.deleted = deleteKeys.length;
    return { records, deleteKeys };
  });
  return counts;
}

/** Keys retention removes: acknowledged past the 30 days, then the oldest
    acknowledged beyond the row cap. An unacknowledged row is never removed. */
function retained(rows: readonly DoneItemV1[], now: number): string[] {
  const gone = new Set<string>();
  for (const row of rows) {
    if (row.acknowledgedAt && now - Date.parse(row.acknowledgedAt) > DONE_ACKNOWLEDGED_RETENTION_MS) gone.add(row.key);
  }
  const left = rows.length - gone.size;
  if (left > DONE_MAX_ROWS) {
    const oldest = rows.filter((row) => row.acknowledgedAt && !gone.has(row.key))
      .sort((left, right) => Date.parse(left.acknowledgedAt!) - Date.parse(right.acknowledgedAt!));
    for (const row of oldest.slice(0, left - DONE_MAX_ROWS)) gone.add(row.key);
  }
  return [...gone];
}

/** The operator acknowledges, or takes an acknowledgement back. Answers the
    rows it changed; a key the store does not hold changes nothing. */
export function acknowledgeDoneItems(keys: readonly string[], options: { undo: boolean; surface: "desktop" | "phone"; now: number }): DoneItemV1[] {
  const store = collection("write")!;
  const changed: DoneItemV1[] = [];
  const at = new Date(options.now).toISOString();
  store.patchSync(() => {
    changed.length = 0;
    for (const key of new Set(keys)) {
      if (key === DONE_META_KEY) continue;
      const row = store.get(key);
      if (!row || isMeta(row)) continue;
      if (options.undo ? !row.acknowledgedAt : row.acknowledgedAt) continue;
      changed.push(options.undo
        ? { ...row, acknowledgedAt: null, acknowledgedBy: null }
        : { ...row, acknowledgedAt: at, acknowledgedBy: { kind: "operator", surface: options.surface } });
    }
    return { records: changed };
  });
  return changed;
}
