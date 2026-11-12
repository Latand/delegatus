import fs from "node:fs";

import { withViewerOperation } from "@/lib/viewerLoopMonitor";

import { FileTransactionBusyError } from "./fileTransaction";
import { lazyReconcileAllowed, legacyDatabasePath, legacyImportAllowed, type LegacyImportOutcome } from "./legacyImport";
import type { DocumentRow } from "./legacyDocumentStore";
import { readStateCollectionRevision, readStateCollectionSelection, SqliteStateCollection } from "./sqliteStateStore";

/**
 * Keyed rows of a store whose legacy form was one JSON document rewritten
 * whole (#1870 slice 8: the limits history, the reaper's authorship evidence
 * and the handoff lineage; docs/design/state-sqlite-migration.md §4.2).
 *
 * Each row is a `DocumentRow` (`{ key, value }`), the format
 * `LegacyDocumentStore` imports, mirrors for a rollback release and merges
 * back at roll-forward, so those three steps are that store's. This module
 * owns the two paths that run all the time:
 *
 * - **Reads** keep a per-process copy of the rows under the store's key
 *   prefixes that follows the collection's change log. A read of an unchanged
 *   collection costs two `stat` calls and no query, and within one
 *   synchronous run of the event loop not even those. After a write, a reader
 *   reads only the rows the change log names. A reader that asks for one key
 *   reads that row alone; one that asks for every row loads them once.
 * - **Writes** run one transaction under the collection lease that names the
 *   rows it changes. The callback reads the rows it needs as committed under
 *   the lease, and unchanged rows are not rewritten.
 *
 * Nothing on the read path imports the legacy file. Until the collection
 * exists, `view` answers null and the store reads its legacy file as before.
 * The Viewer's activation imports (`LEGACY_COLLECTIONS`); with no release
 * target, the first write does.
 */

export interface KeyedRowsOptions<V> {
  collection: string;
  /** Key prefixes the read index covers; a key outside them is never cached. */
  prefixes: readonly string[];
  busyMessage: string;
  /** The stored value as readers see it; undefined leaves the row out. */
  decode(key: string, value: unknown): V | undefined;
  /** Import the legacy file now (the owning `LegacyDocumentStore`). */
  importLegacy(filePath: string, options: { reconcile: boolean }): LegacyImportOutcome;
  /** `process`: a commit survives the process but not a power loss and does
      not wait for the disk, as the store's legacy file, renamed into place
      without an fsync, did not (`SqliteStateCollection.patchSync`). */
  durability?: "disk" | "process";
}

/** The rows as of one collection revision. A view held across a later read
    follows that read: it is one live copy per database, never a snapshot. */
export interface KeyedRowsView<V> {
  readonly revision: number;
  /** One row; reads only that row when the copy does not hold it yet. */
  get(key: string): V | undefined;
  /** Every row under the prefixes, in collection order; loads them once. */
  rows(): ReadonlyMap<string, V>;
}

export interface KeyedRowsPatch {
  records: DocumentRow[];
  deleteKeys?: string[];
}

interface IndexState<V> {
  identity: string;
  revision: number;
  /** Null: read and known to be absent. */
  rows: Map<string, V | null>;
  /** Every row under the prefixes is held, so a missing key is absent. */
  complete: boolean;
}

interface Probe {
  identity: string;
  signature: string;
  revision: number | null;
}

/* Decoded rows are shared by every compiled copy of a store in one process,
   as the seat store shares its snapshots. */
type IndexHost = typeof globalThis & { __delegatusKeyedRowsV1?: Map<string, IndexState<unknown>> };

function indexStates(): Map<string, IndexState<unknown>> {
  return ((globalThis as IndexHost).__delegatusKeyedRowsV1 ??= new Map());
}

function databaseSignature(database: string): { identity: string; signature: string } | null {
  const db = fs.statSync(database, { bigint: true, throwIfNoEntry: false });
  if (!db) return null;
  const wal = fs.statSync(`${database}-wal`, { bigint: true, throwIfNoEntry: false });
  const identity = `${db.dev}:${db.ino}`;
  return { identity, signature: `${identity}:${db.mtimeNs}:${db.size}:${wal ? `${wal.mtimeNs}:${wal.size}` : "-"}` };
}

function isBusyError(error: unknown): boolean {
  return /database is (?:locked|busy)|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error));
}

function prefixed(prefixes: readonly string[], key: string): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

const CHANGE_PAGE = 4096;
/* One database in production; a test process makes one per sandbox. Older
   ones are forgotten, and their connections closed. */
const MAX_DATABASES = 4;

function remember<K, T>(map: Map<K, T>, key: K, value: T, evict?: (value: T) => void): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_DATABASES) {
    const oldest = map.keys().next().value as K;
    evict?.(map.get(oldest)!);
    map.delete(oldest);
  }
}

export class KeyedRows<V> {
  /* The revision probe per database. `tick` holds the probes taken during the
     current synchronous run: a scan that looks up thousands of keys in one
     pass probes once. */
  private readonly probes = new Map<string, Probe>();
  private tick: Map<string, Probe> | null = null;
  /* The view answered during the current synchronous run, per database: a
     scan's thousands of lookups cost one map read each. */
  private tickViews: Map<string, KeyedRowsView<V>> | null = null;
  private readonly opened = new Map<string, { identity: string; collection: SqliteStateCollection<DocumentRow> }>();

  constructor(private readonly options: KeyedRowsOptions<V>) {}

  private stateKey(database: string): string {
    return JSON.stringify([this.options.collection, database]);
  }

  private probe(database: string, fresh = false): Probe | null {
    if (!fresh) {
      const held = this.tick?.get(database);
      if (held) return held;
    }
    const before = databaseSignature(database);
    if (!before) return null;
    let probe = this.probes.get(database);
    if (fresh || probe?.signature !== before.signature) {
      const revision = readStateCollectionRevision(database, this.options.collection);
      probe = { identity: before.identity, signature: before.signature, revision };
      // A probe raced by a commit is answered and not kept.
      if (databaseSignature(database)?.signature === before.signature) remember(this.probes, database, probe);
      else this.probes.delete(database);
    }
    if (!this.tick) {
      this.tick = new Map();
      queueMicrotask(() => { this.tick = null; this.tickViews = null; });
    }
    this.tick.set(database, probe);
    return probe;
  }

  private open(database: string, identity: string): SqliteStateCollection<DocumentRow> {
    const held = this.opened.get(database);
    if (held?.identity === identity) return held.collection;
    held?.collection.close();
    this.opened.delete(database);
    const collection = new SqliteStateCollection<DocumentRow>(database, {
      collection: this.options.collection,
      schemaVersion: 1,
      busyMessage: this.options.busyMessage,
      key: (row) => row.key,
      decode: (value) => (value && typeof value === "object" && !Array.isArray(value)
        && typeof (value as DocumentRow).key === "string" && Object.hasOwn(value as object, "value")) ? value as DocumentRow : null,
      clone: (row) => structuredClone(row),
      strictDecode: true,
      decodeError: (error) => new Error(`invalid ${this.options.collection} row`, { cause: error }),
    });
    remember(this.opened, database, { identity, collection }, (evicted) => evicted.collection.close());
    return collection;
  }

  private guard<R>(operation: () => R): R {
    try {
      return withViewerOperation("state.document", operation);
    } catch (error) {
      if (error instanceof FileTransactionBusyError) throw error;
      if (isBusyError(error)) throw new FileTransactionBusyError(this.options.busyMessage);
      throw error;
    }
  }

  private decodeJson(key: string, valueJson: string): V | undefined {
    const row = JSON.parse(valueJson) as unknown;
    if (!row || typeof row !== "object" || (row as DocumentRow).key !== key) return undefined;
    return this.options.decode(key, (row as DocumentRow).value);
  }

  /** Bring the held rows to the collection's current revision through the
      change log, reading only the rows it names; a log pruned past them
      starts the copy over. */
  private follow(state: IndexState<V>, collection: SqliteStateCollection<DocumentRow>): void {
    let after = state.revision;
    let key = "";
    for (;;) {
      const page = collection.changesAfter(after, key, CHANGE_PAGE);
      if (page.changeFloor > state.revision) {
        state.rows = new Map();
        state.complete = false;
        state.revision = page.revision;
        return;
      }
      for (const entry of page.entries) {
        if (!prefixed(this.options.prefixes, entry.key)) continue;
        if (!state.complete && !state.rows.has(entry.key)) continue;
        const value = entry.valueJson === null ? undefined : this.decodeJson(entry.key, entry.valueJson);
        if (value === undefined) {
          if (state.complete) state.rows.delete(entry.key);
          else state.rows.set(entry.key, null);
        } else {
          state.rows.set(entry.key, value);
        }
      }
      if (page.entries.length < CHANGE_PAGE) {
        state.revision = page.revision;
        return;
      }
      const last = page.entries.at(-1)!;
      after = last.revision;
      key = last.key;
    }
  }

  private load(database: string, state: IndexState<V>): void {
    const selection = readStateCollectionSelection(database, this.options.collection, { prefixes: this.options.prefixes });
    if (!selection) throw new FileTransactionBusyError(`${this.options.collection} state disappeared during the read`);
    const rows = new Map<string, V | null>();
    for (const row of selection.rows) {
      const value = this.decodeJson(row.key, row.valueJson);
      if (value !== undefined) rows.set(row.key, value);
    }
    state.rows = rows;
    state.complete = true;
    state.revision = selection.revision;
  }

  private pointRead(database: string, state: IndexState<V>, key: string): V | undefined {
    const selection = readStateCollectionSelection(database, this.options.collection, { keys: [key] });
    if (!selection) throw new FileTransactionBusyError(`${this.options.collection} state disappeared during the read`);
    const row = selection.rows[0];
    const value = row ? this.decodeJson(key, row.valueJson) : undefined;
    /* A value read at a later revision than the copy is still right: every
       change after the copy's revision is applied again when it follows the
       log, and the log carries each row's current value. */
    if (!state.complete) state.rows.set(key, value ?? null);
    return value;
  }

  /**
   * The rows of the collection in `database`, or null while the collection
   * does not exist (the legacy file is still the store). An unchanged
   * collection is answered from the copy this process holds.
   */
  view(database: string): KeyedRowsView<V> | null {
    const current = this.tickViews?.get(database);
    if (current) return current;
    return this.guard(() => {
      const probe = this.probe(database);
      if (!probe || probe.revision === null) return null;
      const states = indexStates();
      const slot = this.stateKey(database);
      let state = states.get(slot) as IndexState<V> | undefined;
      if (!state || state.identity !== probe.identity) {
        state = { identity: probe.identity, revision: probe.revision, rows: new Map(), complete: false };
        states.delete(slot);
        states.set(slot, state as IndexState<unknown>);
        const mine = [...states.keys()].filter((key) => (JSON.parse(key) as string[])[0] === this.options.collection);
        for (const key of mine.slice(0, Math.max(0, mine.length - MAX_DATABASES))) states.delete(key);
      } else if (state.revision < probe.revision) {
        this.follow(state, this.open(database, probe.identity));
      }
      const held = state;
      const view: KeyedRowsView<V> = {
        get revision() { return held.revision; },
        get: (key: string) => {
          const value = held.rows.get(key);
          if (value !== undefined) return value ?? undefined;
          if (held.complete || !prefixed(this.options.prefixes, key)) return undefined;
          return this.guard(() => this.pointRead(database, held, key));
        },
        rows: () => {
          if (!held.complete) this.guard(() => this.load(database, held));
          return held.rows as ReadonlyMap<string, V>;
        },
      };
      // `probe` opened this run's tick; the view lasts as long as it does.
      if (this.tick) (this.tickViews ??= new Map()).set(database, view);
      return view;
    });
  }

  /** The collection for a write, importing the legacy file first when no
      release target exists or this is the activated release. */
  private writable(filePath: string, database: string): SqliteStateCollection<DocumentRow> {
    let probe = this.probe(database, true);
    if (!probe || probe.revision === null) {
      if (!legacyImportAllowed(filePath, database)) {
        throw new FileTransactionBusyError(`${this.options.collection} state is waiting for release promotion`);
      }
      this.options.importLegacy(filePath, { reconcile: lazyReconcileAllowed(filePath, database) });
      probe = this.probe(database, true);
      if (!probe || probe.revision === null) throw new FileTransactionBusyError(`${this.options.collection} state is not imported`);
    }
    return this.open(database, probe.identity);
  }

  /**
   * One transaction under the collection lease. `prepare` reads the rows it
   * needs as committed (`read` answers the stored value, or undefined) and
   * returns the rows to write and the keys to delete; rows equal to what is
   * stored are not rewritten. Returns whether `prepare` asked for a change.
   */
  write(filePath: string, prepare: (read: (key: string) => unknown) => KeyedRowsPatch, database = legacyDatabasePath(filePath)): boolean {
    return this.guard(() => {
      const collection = this.writable(filePath, database);
      let changed = false;
      collection.patchSync(() => {
        /* The writer holds the database's write lock, so the shared reader
           sees exactly what is committed. One parse per row and no copy: a
           limits series is about 45 KB. */
        const patch = prepare((key) => {
          const row = readStateCollectionSelection(database, this.options.collection, { keys: [key] })?.rows[0];
          if (!row) return undefined;
          const parsed = JSON.parse(row.valueJson) as DocumentRow;
          return parsed && parsed.key === key ? parsed.value : undefined;
        });
        changed = patch.records.length > 0 || (patch.deleteKeys?.length ?? 0) > 0;
        return patch;
      }, { durability: this.options.durability ?? "disk" });
      // This process's next read probes again and follows its own commit.
      this.tick?.delete(database);
      this.tickViews?.delete(database);
      return changed;
    });
  }

  /** Test seam: forget every held row and open collection, the way a
      restarted process would. */
  resetForTests(): void {
    for (const { collection } of this.opened.values()) collection.close();
    this.opened.clear();
    this.probes.clear();
    this.tick = null;
    this.tickViews = null;
    for (const key of [...indexStates().keys()]) {
      if ((JSON.parse(key) as string[])[0] === this.options.collection) indexStates().delete(key);
    }
  }
}
