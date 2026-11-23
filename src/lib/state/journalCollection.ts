import fs from "node:fs";

import { FileTransactionBusyError } from "./fileTransaction";
import { lazyReconcileAllowed, legacyImportAllowed, type LegacyImportOutcome } from "./legacyImport";
import { stateLockAttempt } from "./lockWait";
import {
  readStateCollectionSelection,
  readStateImport,
  SqliteStateCollection,
  type StateImportRecord,
} from "./sqliteStateStore";

/**
 * The SQLite side of an append-only journal moved out of a legacy file
 * (#1870 slice 8, docs/design/state-sqlite-migration.md §4.4): the lifecycle
 * journal, the seat tick's run audit and the reset-credit ledger.
 *
 * Every row is `{ key, value }` under a key prefix the journal chooses. This
 * module opens the collection once per database, answers whether the legacy
 * file has been imported, imports it on a write where this process may, and
 * keeps a per-process copy of selected rows that follows the collection's
 * change log, so a reader of an unchanged journal reads no row and a reader
 * after an append reads only the rows that changed.
 */

export interface JournalRow {
  key: string;
  value: unknown;
}

export function isJournalRow(value: unknown): value is JournalRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as JournalRow).key === "string" && (value as JournalRow).key.length > 0
    && Object.hasOwn(value as object, "value");
}

/** Where one journal lives and how its legacy file imports. */
export interface JournalLocation {
  collection: string;
  database: string;
  legacyPath: string;
  busyMessage: string;
  importLegacy(options: { reconcile: boolean }): LegacyImportOutcome;
}

function databaseIdentity(database: string): string | null {
  const stat = fs.statSync(database, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

/* One open collection per database file and collection. A database replaced
   under the same path (a restore, a test sandbox made again) opens anew. */
const opened = new Map<string, { identity: string | null; collection: SqliteStateCollection<JournalRow> }>();

export function openJournalCollection(location: Pick<JournalLocation, "collection" | "database" | "busyMessage">): SqliteStateCollection<JournalRow> {
  const slot = `${location.database}\0${location.collection}`;
  const identity = databaseIdentity(location.database);
  const held = opened.get(slot);
  if (held && held.identity === identity) return held.collection;
  held?.collection.close();
  opened.delete(slot);
  const collection = new SqliteStateCollection<JournalRow>(location.database, {
    collection: location.collection,
    schemaVersion: 1,
    busyMessage: location.busyMessage,
    key: (row) => row.key,
    decode: (value) => isJournalRow(value) ? value : null,
    clone: (row) => structuredClone(row),
    strictDecode: true,
    decodeError: (error) => new Error(`invalid ${location.collection} row`, { cause: error }),
  });
  opened.set(slot, { identity, collection });
  return collection;
}

/** The import evidence, read with the zero-timeout admission every marker
    probe uses. Null until the legacy file has been imported. */
export function journalImportMarker(location: Pick<JournalLocation, "collection" | "database">): StateImportRecord | null {
  return stateLockAttempt(`state.marker.${location.collection}`, () => readStateImport(location.database, location.collection), location.collection);
}

/** The collection for a read, or null while the legacy file is still the
    journal. Nothing on the read path imports. */
export function readableJournal(location: JournalLocation): SqliteStateCollection<JournalRow> | null {
  if (!journalImportMarker(location)) return null;
  return openJournalCollection(location);
}

/** The collection for a write, importing the legacy file first when no
    release target exists or this is the activated release. Before that a
    write is refused as busy, as every moved store's writes are. */
export function writableJournal(location: JournalLocation): SqliteStateCollection<JournalRow> {
  if (!journalImportMarker(location)) {
    if (!legacyImportAllowed(location.legacyPath, location.database)) {
      throw new FileTransactionBusyError(`${location.collection} state is waiting for release promotion`);
    }
    location.importLegacy({ reconcile: lazyReconcileAllowed(location.legacyPath, location.database) });
  }
  return openJournalCollection(location);
}

/** Test seam: close every open journal collection, as a restarted process would. */
export function resetJournalCollectionsForTests(): void {
  for (const { collection } of opened.values()) collection.close();
  opened.clear();
}

/* ------------------------------------------------------------ row copies */

interface HeldCopy<V> {
  identity: string | null;
  revision: number;
  rows: Map<string, V>;
  /** Bumped on every change applied, so a caller can keep a derived view. */
  generation: number;
}

/**
 * A process-local copy of a journal's rows under the given prefixes (and
 * named keys), kept current through the collection's change log. The first
 * read selects the rows once; a later read at the same collection revision
 * costs the revision probe (two stats while nothing changed); a read after a
 * write applies only the changed rows. When the change log no longer reaches
 * back to the held revision, the copy is read again whole.
 */
export class JournalRowCopy<V> {
  private readonly held = new Map<string, HeldCopy<V>>();

  constructor(private readonly options: {
    prefixes: readonly string[];
    keys?: readonly string[];
    /** Decode one stored row; throw to refuse the whole read. */
    decode(key: string, value: unknown): V;
  }) {}

  private wanted(key: string): boolean {
    return (this.options.keys ?? []).includes(key) || this.options.prefixes.some((prefix) => key.startsWith(prefix));
  }

  private decodeJson(key: string, valueJson: string): V {
    const parsed = JSON.parse(valueJson) as unknown;
    if (!isJournalRow(parsed) || parsed.key !== key) throw new Error(`stored row ${key} does not name its own key`);
    return this.options.decode(key, parsed.value);
  }

  /** Every wanted row and the revision they were read at, in one snapshot. */
  private load(collection: SqliteStateCollection<JournalRow>, name: string, identity: string | null): HeldCopy<V> {
    const selection = readStateCollectionSelection(collection.filename, name, {
      prefixes: this.options.prefixes,
      keys: this.options.keys ?? [],
    });
    if (!selection) throw new FileTransactionBusyError(`${name} state is not imported`);
    const rows = new Map<string, V>();
    for (const row of selection.rows) rows.set(row.key, this.decodeJson(row.key, row.valueJson));
    return { identity, revision: selection.revision, rows, generation: 0 };
  }

  /** The rows at the collection's current revision. The map is shared and
      read-only; `generation` changes whenever its contents do. */
  read(collection: SqliteStateCollection<JournalRow>, name: string): HeldCopy<V> {
    const slot = `${collection.filename}\0${name}`;
    const identity = databaseIdentity(collection.filename);
    let held = this.held.get(slot);
    if (held && held.identity !== identity) held = undefined;
    const revision = collection.revision();
    if (held && held.revision === revision) return held;
    if (held) {
      const advanced = this.advance(collection, held);
      if (advanced) return advanced;
    }
    const loaded = this.load(collection, name, identity);
    loaded.generation = (held?.generation ?? 0) + 1;
    this.held.set(slot, loaded);
    return loaded;
  }

  /** Apply the change log after the held revision, or null when it no longer
      reaches back that far. */
  private advance(collection: SqliteStateCollection<JournalRow>, held: HeldCopy<V>): HeldCopy<V> | null {
    let revision = held.revision;
    let after = "";
    const changes = new Map<string, string | null>();
    let through = held.revision;
    for (;;) {
      const page = collection.changesAfter(revision, after, 4096);
      if (page.changeFloor > held.revision) return null;
      for (const entry of page.entries) {
        if (this.wanted(entry.key)) changes.set(entry.key, entry.valueJson);
      }
      through = page.revision;
      if (page.entries.length < 4096) break;
      const last = page.entries.at(-1)!;
      revision = last.revision;
      after = last.key;
    }
    for (const [key, valueJson] of changes) {
      if (valueJson === null) held.rows.delete(key);
      else held.rows.set(key, this.decodeJson(key, valueJson));
    }
    held.revision = through;
    if (changes.size > 0) held.generation += 1;
    return held;
  }

  /** Test seam: forget the held copies. */
  reset(): void {
    this.held.clear();
  }
}
