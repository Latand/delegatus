import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";

import type { DoneItemV1, DoneLimitEpisode, DoneLimitEpisodes } from "./types";

/*
 * The «Готово» store (docs/design/done-section.md §3): the `done_items`
 * collection of `state.sqlite`, one row per item keyed by its deterministic
 * key, holding the item and its acknowledgement together, plus one meta row
 * with the instant the store was first written and one row with the limit
 * episodes the projector remembers. A row is never re-created: an
 * acknowledged key stays acknowledged whatever its source does next. Removing
 * an acknowledged row leaves a settled row under its key in the same
 * transaction, and a settled key is never inserted again, so a pruned
 * acknowledgement cannot come back while every other key stays eligible.
 */

export const DONE_ITEMS_COLLECTION = "done_items";
export const DONE_META_KEY = "meta";
export const DONE_LIMIT_EPISODES_KEY = "limit-episodes";
const SETTLED_PREFIX = "settled:";
/** Acknowledged rows are kept this long after their acknowledgement. */
export const DONE_ACKNOWLEDGED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Past this many rows the acknowledged rows with the oldest events go first. */
export const DONE_MAX_ROWS = 2_000;
/** A limit episode is forgotten this long after its last sample at no room
    left; the limits history itself keeps 8 days. */
export const DONE_LIMIT_EPISODE_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
/** A settled row is kept until its event is this old; retiring it raises the
    meta row's `retiredThrough` to that event, so only an outcome older than
    this that no projection saw in all that time is no longer inserted. */
export const DONE_SETTLED_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

interface DoneMetaV1 {
  key: typeof DONE_META_KEY;
  activation: string;
  /** The newest event time of a retired settled row. */
  retiredThrough?: string | null;
}

/** What is left of an acknowledged row retention removed: its key and its
    event time. */
interface DoneSettledV1 {
  key: `${typeof SETTLED_PREFIX}${string}`;
  at: string;
}

interface DoneEpisodesV1 {
  key: typeof DONE_LIMIT_EPISODES_KEY;
  series: DoneLimitEpisodes;
}

type DoneRow = DoneItemV1 | DoneMetaV1 | DoneSettledV1 | DoneEpisodesV1;

const isMeta = (row: DoneRow): row is DoneMetaV1 => row.key === DONE_META_KEY;
const isSettled = (row: DoneRow): row is DoneSettledV1 => row.key.startsWith(SETTLED_PREFIX);
const isEpisodes = (row: DoneRow): row is DoneEpisodesV1 => row.key === DONE_LIMIT_EPISODES_KEY;
const isItem = (row: DoneRow): row is DoneItemV1 => !isMeta(row) && !isSettled(row) && !isEpisodes(row);
const settledKey = (key: string) => `${SETTLED_PREFIX}${key}` as const;

function episodesOf(value: unknown): DoneLimitEpisodes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: DoneLimitEpisodes = {};
  for (const [series, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((episode): episode is DoneLimitEpisode => Boolean(episode) && Number.isFinite(episode.start) && Number.isFinite(episode.lastZero)
      && (episode.close === null || Number.isFinite(episode.close)));
    if (kept.length) out[series] = kept.map((episode) => ({ start: episode.start, lastZero: episode.lastZero, close: episode.close }));
  }
  return out;
}

function decode(value: unknown): DoneRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Omit<Partial<DoneItemV1> & Partial<DoneMetaV1> & Partial<DoneEpisodesV1>, "key"> & { key?: unknown };
  if (row.key === DONE_META_KEY) {
    if (typeof row.activation !== "string") return null;
    return { key: DONE_META_KEY, activation: row.activation, retiredThrough: typeof row.retiredThrough === "string" ? row.retiredThrough : null };
  }
  if (row.key === DONE_LIMIT_EPISODES_KEY) return { key: DONE_LIMIT_EPISODES_KEY, series: episodesOf(row.series) };
  if (typeof row.key === "string" && row.key.startsWith(SETTLED_PREFIX)) {
    return typeof row.at === "string" ? { key: row.key as DoneSettledV1["key"], at: row.at } : null;
  }
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
  return (collection("read")?.snapshot() ?? []).filter(isItem);
}

/** What the projector needs besides the item rows: the keys retention
    settled and the limit episodes it remembers. */
export function readDoneMemory(): { settled: Set<string>; limitEpisodes: DoneLimitEpisodes } {
  const settled = new Set<string>();
  let limitEpisodes: DoneLimitEpisodes = {};
  for (const row of collection("read")?.snapshot() ?? []) {
    if (isSettled(row)) settled.add(row.key.slice(SETTLED_PREFIX.length));
    else if (isEpisodes(row)) limitEpisodes = row.series;
  }
  return { settled, limitEpisodes };
}

/** The items still waiting on the operator, newest event first. */
export function unacknowledgedDoneItems(): DoneItemV1[] {
  return readDoneRows().filter((row) => !row.acknowledgedAt).sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || left.key.localeCompare(right.key));
}

function meta(store: SqliteStateCollection<DoneRow>): DoneMetaV1 | null {
  const held = store.get(DONE_META_KEY);
  return held && isMeta(held) ? held : null;
}

/** The instant the store was first written, recorded on the first call. */
export function doneActivation(now: number): string {
  const store = collection("write")!;
  const held = meta(store);
  if (held) return held.activation;
  let activation = new Date(now).toISOString();
  store.patchSync(() => {
    const current = meta(store);
    if (current) {
      activation = current.activation;
      return { records: [] };
    }
    return { records: [{ key: DONE_META_KEY, activation, retiredThrough: null }] };
  });
  return activation;
}

/** Epoch ms: the earliest event the projection may still insert as a new
    key. Nothing before the store's activation, and nothing at or before the
    event of a settled row retired after 400 days (§3). There is no rolling
    window: an outcome nobody has read yet stays eligible however long ago it
    happened. */
export function doneFloor(now: number): number {
  const activation = Date.parse(doneActivation(now));
  const retired = Date.parse(meta(collection("write")!)?.retiredThrough ?? "");
  return Number.isFinite(retired) ? Math.max(activation, retired + 1) : activation;
}

export interface DoneWrite {
  /** Rows the projection inserts or refreshes. */
  upserts: readonly DoneItemV1[];
  /** The limit episodes with this projection's samples folded in. */
  limitEpisodes?: DoneLimitEpisodes;
}

/**
 * Write one projection: a key the store has never seen is inserted, an
 * unacknowledged row is refreshed (its title, its limit text and its frame),
 * and an acknowledged or settled key is left exactly as it is. The limit
 * episodes and retention are written in the same transaction. Answers how
 * many rows changed.
 */
export function writeDoneProjection(write: DoneWrite, now: number): { inserted: number; updated: number; deleted: number; removedKeys: string[] } {
  const store = collection("write")!;
  let removedKeys: string[] = [];
  let counts = { inserted: 0, updated: 0, deleted: 0 };
  store.patchSync(() => {
    const snapshot = store.snapshot();
    const rows = new Map(snapshot.filter(isItem).map((row) => [row.key, row] as const));
    const settled = new Map(snapshot.filter(isSettled).map((row) => [row.key, row] as const));
    const records: DoneRow[] = [];
    const deleteKeys: string[] = [];
    const current = meta(store);
    const retired = Date.parse(current?.retiredThrough ?? "");
    counts = { inserted: 0, updated: 0, deleted: 0 };
    for (const next of write.upserts) {
      const held = rows.get(next.key);
      if (!held) {
        /* Retention removed this key after its acknowledgement, or retired
           every settled row this old. */
        if (settled.has(settledKey(next.key)) || (Number.isFinite(retired) && !(Date.parse(next.at) > retired))) continue;
        records.push(next);
        rows.set(next.key, next);
        counts.inserted += 1;
        continue;
      }
      if (held.acknowledgedAt) continue;
      const storedFrame = held.frame?.unavailable || held.frame?.src.startsWith("/api/image?done=");
      const mayPromote = Boolean(held.frame?.src.startsWith("/api/image?done=") && !held.frameCheckedAt && next.frameCheckedAt
        && (!next.frame || Date.parse(next.frameCheckedAt) >= Date.parse(held.at)));
      const retainedFrame = storedFrame && !mayPromote;
      const refreshed: DoneItemV1 = {
        ...held,
        title: next.title,
        look: next.look,
        refs: next.refs,
        frame: retainedFrame ? held.frame : next.frame,
        frameCheckedAt: retainedFrame ? held.frameCheckedAt : next.frameCheckedAt,
      };
      if (JSON.stringify(refreshed) === JSON.stringify(held)) continue;
      records.push(refreshed);
      rows.set(next.key, refreshed);
      counts.updated += 1;
    }
    if (write.limitEpisodes) {
      const held = snapshot.find(isEpisodes)?.series ?? {};
      const merged = mergeEpisodes(held, write.limitEpisodes, now);
      if (JSON.stringify(merged) !== JSON.stringify(held)) records.push({ key: DONE_LIMIT_EPISODES_KEY, series: merged });
    }
    /* Every removed key leaves a settled row in the same transaction. */
    const gone = retained([...rows.values()], now);
    removedKeys = gone.map(row => row.key);
    counts.deleted = gone.length;
    for (const row of gone) {
      deleteKeys.push(row.key);
      records.push({ key: settledKey(row.key), at: row.at });
    }
    /* A settled row retires once its event is 400 days old; the floor moves
       up to it, so the key still cannot come back. */
    const old = [...settled.values()].filter((row) => now - Date.parse(row.at) > DONE_SETTLED_RETENTION_MS);
    if (old.length) {
      const through = Math.max(Number.isFinite(retired) ? retired : Number.NEGATIVE_INFINITY, ...old.map((row) => Date.parse(row.at)));
      if (current && Number.isFinite(through) && through !== retired) records.push({ ...current, retiredThrough: new Date(through).toISOString() });
      deleteKeys.push(...old.map((row) => row.key));
    }
    return { records, deleteKeys };
  });
  return { ...counts, removedKeys };
}

/** The episodes this projection computed, plus any another writer recorded
    since it read them: one per start, the latest sample and the reset kept.
    An episode is forgotten 30 days after its last sample at no room left. */
function mergeEpisodes(held: DoneLimitEpisodes, next: DoneLimitEpisodes, now: number): DoneLimitEpisodes {
  const out: DoneLimitEpisodes = {};
  for (const series of new Set([...Object.keys(held), ...Object.keys(next)])) {
    const byStart = new Map<number, DoneLimitEpisode>();
    for (const episode of [...(held[series] ?? []), ...(next[series] ?? [])]) {
      const mine = byStart.get(episode.start);
      if (!mine) byStart.set(episode.start, { ...episode });
      else {
        mine.lastZero = Math.max(mine.lastZero, episode.lastZero);
        mine.close ??= episode.close;
      }
    }
    const kept = [...byStart.values()].filter((episode) => now - episode.lastZero * 1_000 <= DONE_LIMIT_EPISODE_MEMORY_MS);
    if (kept.length) out[series] = kept.sort((left, right) => left.start - right.start);
  }
  return out;
}

/** Rows retention removes, acknowledged ones only: past the 30 days after
    their acknowledgement, then, beyond the row cap, those with the oldest
    events. An unacknowledged row is never removed. */
function retained(rows: readonly DoneItemV1[], now: number): DoneItemV1[] {
  const gone = new Map<string, DoneItemV1>();
  for (const row of rows) {
    if (row.acknowledgedAt && now - Date.parse(row.acknowledgedAt) > DONE_ACKNOWLEDGED_RETENTION_MS) gone.set(row.key, row);
  }
  const left = rows.length - gone.size;
  if (left > DONE_MAX_ROWS) {
    const oldest = rows.filter((row) => row.acknowledgedAt && !gone.has(row.key))
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.key.localeCompare(right.key));
    for (const row of oldest.slice(0, left - DONE_MAX_ROWS)) gone.set(row.key, row);
  }
  return [...gone.values()];
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
      const row = store.get(key);
      if (!row || !isItem(row)) continue;
      if (options.undo ? !row.acknowledgedAt : row.acknowledgedAt) continue;
      changed.push(options.undo
        ? { ...row, acknowledgedAt: null, acknowledgedBy: null }
        : { ...row, acknowledgedAt: at, acknowledgedBy: { kind: "operator", surface: options.surface } });
    }
    return { records: changed };
  });
  return changed;
}
