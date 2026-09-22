/**
 * Row-level deltas between two `/api/files` representations (#1994).
 *
 * A changed board revision usually touches one conversation row, one pipeline
 * and one task out of megabytes of retained history. Resending the whole
 * representation for that cost a phone tens of megabytes per minute. A delta
 * names the representation it applies to by its strong ETag and carries only
 * what changed: keyed rows that differ or are new, the new row order as runs of
 * the old one, changed entries of the record fields, and any other top-level
 * field that differs, whole.
 *
 * The server builds deltas off the request thread; the client applies them to
 * the exact representation it certified under that ETag. Applying is strict: a
 * delta that does not fit its base throws, and the client falls back to one
 * full representation.
 */

/** The identity of each keyed row collection. */
export const FILES_DELTA_ROW_KEYS: Readonly<Record<string, string>> = {
  files: "path",
  projectCatalog: "project",
  flows: "id",
  pipelines: "id",
  workflows: "id",
  tasks: "id",
};

/** Request header a client sends to accept a delta against its If-None-Match. */
export const FILES_DELTA_ACCEPT_HEADER = "x-llv-files-delta";
/** Response header naming the ETag the delta body applies to. */
export const FILES_DELTA_BASE_HEADER = "x-llv-files-delta-base";

/** A run of `length` rows copied from the base order starting at `start`. */
type OrderRun = [start: number, length: number];

interface RowsDelta {
  count: number;
  /** New order, omitted when the keys and their order did not change. A string
      is a row carried in `upsert`; a pair is a run of base rows. */
  order?: Array<string | OrderRun>;
  upsert?: Array<[string, unknown]>;
}

interface EntriesDelta {
  upsert?: Array<[string, unknown]>;
  remove?: string[];
}

export interface FilesDelta {
  v: 1;
  base: string;
  etag: string;
  set?: Array<[string, unknown]>;
  unset?: string[];
  rows?: Array<[string, RowsDelta]>;
  entries?: Array<[string, EntriesDelta]>;
}

type Json = Record<string, unknown>;

function plainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyedRows(value: unknown, key: string): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    const id = plainObject(row) ? row[key] : undefined;
    if (typeof id !== "string" || seen.has(id)) return null;
    seen.add(id);
    keys.push(id);
  }
  return keys;
}

function diffRows(previous: Json[], next: Json[], previousKeys: string[], nextKeys: string[]): RowsDelta | null {
  const previousIndex = new Map(previousKeys.map((key, index) => [key, index] as const));
  const upsert: Array<[string, unknown]> = [];
  const order: Array<string | OrderRun> = [];
  let run: OrderRun | null = null;
  for (let index = 0; index < next.length; index += 1) {
    const key = nextKeys[index];
    const at = previousIndex.get(key);
    if (at === undefined || JSON.stringify(previous[at]) !== JSON.stringify(next[index])) {
      upsert.push([key, next[index]]);
    }
    if (at === undefined) {
      run = null;
      order.push(key);
    } else if (run && run[0] + run[1] === at) {
      run[1] += 1;
    } else {
      run = [at, 1];
      order.push(run);
    }
  }
  const sameOrder = next.length === previous.length
    && order.length === 1 && typeof order[0] !== "string" && order[0][0] === 0;
  if (!upsert.length && (sameOrder || (!next.length && !previous.length))) return null;
  return {
    count: next.length,
    ...(sameOrder ? {} : { order }),
    ...(upsert.length ? { upsert } : {}),
  };
}

function diffEntries(previous: Json, next: Json): EntriesDelta | null {
  const upsert: Array<[string, unknown]> = [];
  const remove: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (!Object.hasOwn(previous, key) || JSON.stringify(previous[key]) !== JSON.stringify(value)) upsert.push([key, value]);
  }
  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(next, key)) remove.push(key);
  }
  if (!upsert.length && !remove.length) return null;
  return { ...(upsert.length ? { upsert } : {}), ...(remove.length ? { remove } : {}) };
}

/** Everything that turns representation `previous` into `next`. */
export function diffFilesRepresentations(previous: Json, next: Json, base: string, etag: string): FilesDelta {
  const delta: FilesDelta = { v: 1, base, etag };
  const set: Array<[string, unknown]> = [];
  const rows: Array<[string, RowsDelta]> = [];
  const entries: Array<[string, EntriesDelta]> = [];
  for (const [field, value] of Object.entries(next)) {
    const before = previous[field];
    const rowKey = FILES_DELTA_ROW_KEYS[field];
    const previousKeys = rowKey ? keyedRows(before, rowKey) : null;
    const nextKeys = rowKey ? keyedRows(value, rowKey) : null;
    if (previousKeys && nextKeys) {
      const change = diffRows(before as Json[], value as Json[], previousKeys, nextKeys);
      if (change) rows.push([field, change]);
      continue;
    }
    if (!rowKey && plainObject(before) && plainObject(value)) {
      const change = diffEntries(before, value);
      if (change) entries.push([field, change]);
      continue;
    }
    if (!Object.hasOwn(previous, field) || JSON.stringify(before) !== JSON.stringify(value)) set.push([field, value]);
  }
  const unset = Object.keys(previous).filter((field) => !Object.hasOwn(next, field));
  if (set.length) delta.set = set;
  if (unset.length) delta.unset = unset;
  if (rows.length) delta.rows = rows;
  if (entries.length) delta.entries = entries;
  return delta;
}

/** Serialised delta between two serialised representations. */
export function diffFilesBodies(previousBody: string, nextBody: string, base: string, etag: string): string {
  return JSON.stringify(diffFilesRepresentations(
    JSON.parse(previousBody) as Json,
    JSON.parse(nextBody) as Json,
    base,
    etag,
  ));
}

function applyRows(previous: unknown, key: string, change: RowsDelta): unknown[] {
  if (!Array.isArray(previous)) throw new Error("files delta targets a missing row collection");
  const previousRows = previous as Json[];
  const upsert = new Map(change.upsert ?? []);
  let next: unknown[];
  if (!change.order) {
    next = previousRows.map((row) => {
      const id = row[key];
      return typeof id === "string" && upsert.has(id) ? upsert.get(id) : row;
    });
  } else {
    next = [];
    for (const item of change.order) {
      if (typeof item === "string") {
        if (!upsert.has(item)) throw new Error("files delta names a row it does not carry");
        next.push(upsert.get(item));
        continue;
      }
      const [start, length] = item;
      if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 1 || start + length > previousRows.length) {
        throw new Error("files delta run is outside its base");
      }
      for (let index = start; index < start + length; index += 1) {
        const row = previousRows[index];
        const id = row[key];
        next.push(typeof id === "string" && upsert.has(id) ? upsert.get(id) : row);
      }
    }
  }
  if (next.length !== change.count) throw new Error("files delta row count mismatch");
  return next;
}

function applyEntries(previous: unknown, change: EntriesDelta): Json {
  if (!plainObject(previous)) throw new Error("files delta targets a missing record");
  const upsert = new Map(change.upsert ?? []);
  const remove = new Set(change.remove ?? []);
  const kept = Object.entries(previous)
    .filter(([key]) => !remove.has(key))
    .map(([key, value]) => {
      if (!upsert.has(key)) return [key, value] as const;
      const replaced = upsert.get(key);
      upsert.delete(key);
      return [key, replaced] as const;
    });
  /* Object.fromEntries defines own data properties, so a key such as
     `__proto__` stays a key and never reaches the prototype. */
  return Object.fromEntries([...kept, ...upsert]);
}

/**
 * Apply one delta to the representation it was built against. Rows the delta
 * does not name keep their identity, so a consumer comparing references sees
 * only what changed. Throws when the delta does not fit.
 */
export function applyFilesDelta(previous: Json, delta: FilesDelta): Json {
  if (delta?.v !== 1) throw new Error("files delta version is not supported");
  const next: Json = { ...previous };
  for (const field of delta.unset ?? []) delete next[field];
  for (const [field, value] of delta.set ?? []) {
    Object.defineProperty(next, field, { value, enumerable: true, writable: true, configurable: true });
  }
  for (const [field, change] of delta.rows ?? []) {
    const key = FILES_DELTA_ROW_KEYS[field];
    if (!key) throw new Error("files delta names an unkeyed collection");
    next[field] = applyRows(previous[field], key, change);
  }
  for (const [field, change] of delta.entries ?? []) {
    next[field] = applyEntries(previous[field], change);
  }
  return next;
}
