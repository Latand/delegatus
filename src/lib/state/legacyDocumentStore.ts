import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { stateLockAttempt } from "./lockWait";
import { FileTransactionBusyError } from "./fileTransaction";
import {
  importLegacyCollection,
  lazyReconcileAllowed,
  legacyBaselineRevision,
  legacyDatabasePath,
  legacyImportAllowed,
  writeLegacyRollbackMirror,
  type LegacyCollectionSpec,
  type LegacyImportHooks,
  type LegacyImportOutcome,
  type LegacyReconcileSummary,
} from "./legacyImport";
import { readStateImport, SqliteStateCollection, type StateImportRecord, type StateImportRow } from "./sqliteStateStore";

/**
 * A small operator-facing store whose legacy form is one JSON document, moved
 * into `state.sqlite` as keyed rows (#1870 slices 5 and 5b;
 * docs/design/state-sqlite-migration.md §2.1 rows 6–11).
 *
 * The store keeps its document shape and every rule it enforces on it; this
 * module only swaps where the document lives. `toRows` splits a document into
 * rows (a `meta` row for the store-level fields, one row per request, set,
 * admission or project), `fromRows` puts it back together, and a write stores
 * only the rows that changed. The document's own `revision` field travels in
 * its `meta` row, so the revision a caller sees continues from the one the
 * file held: the import neither resets it nor lets it run backwards.
 *
 * Import, reconcile and the rollback mirror are the slice 1 helper's
 * (`importLegacyCollection`), with the same barrier, ownership and
 * release-writer checks every shipped slice uses.
 */

/** One stored row: the key it lives under and the document part it holds. */
export interface DocumentRow {
  key: string;
  value: unknown;
}

export interface LegacyDocumentOptions<D> {
  collection: string;
  databasePath?(filePath: string): string;
  nonBlockingLock?: boolean;
  validateLegacyPath?(filePath: string): void;
  maxOpenCollections?: number;
  migrationId: string;
  busyMessage: string;
  /** Validate a parsed legacy file. Throwing refuses the import and leaves the
      file untouched; the store's own read of a legacy file uses the same rule. */
  parse(raw: unknown): D;
  toRows(document: D): DocumentRow[];
  fromRows(rows: readonly DocumentRow[]): D;
  /** The legacy file body for a document, for the rollback mirror. */
  toFile(document: D): unknown;
  /** How a legacy file row that differs from the held one merges, when the
      default (the file's row wins unless SQLite rewrote it since the file was
      written from it) is wrong for that row. Returns the value to keep. */
  mergeRow?(key: string, held: unknown, incoming: unknown): unknown;
  /** The store's read of a legacy file, for a release that may not import yet. */
  readLegacy(filePath: string): D;
  /** The store's own error for a row that does not decode. A busy collection
      and a release waiting for promotion are always `FileTransactionBusyError`,
      which callers answer as retryable. */
  error(message: string, cause?: unknown): Error;
}

function isDocumentRow(value: unknown): value is DocumentRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as DocumentRow).key === "string" && (value as DocumentRow).key.length > 0
    && Object.hasOwn(value as object, "value");
}

function isBusyError(error: unknown): boolean {
  return /database is (?:locked|busy)|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error));
}

// Marker probes use the same zero-timeout admission policy as collection writes.

let writeHookForTests: ((collection: string) => void) | null = null;

/** Test seam: runs before every document write, so a test can make the write
    fail the way a busy database or a full disk does. */
export function setLegacyDocumentWriteHookForTests(hook: ((collection: string) => void) | null): void {
  writeHookForTests = hook;
}

const stores = new Set<{ collections: Map<string, SqliteStateCollection<DocumentRow>> }>();

/** Test seam: forget every open collection, the way a restarted process would. */
export function resetLegacyDocumentStoresForTests(): void {
  for (const store of stores) {
    for (const collection of store.collections.values()) collection.close();
    store.collections.clear();
  }
}

export class LegacyDocumentStore<D> {
  readonly collections = new Map<string, SqliteStateCollection<DocumentRow>>();

  constructor(private readonly options: LegacyDocumentOptions<D>) {
    stores.add(this);
  }

  private databasePath(filePath: string): string {
    return this.options.databasePath?.(filePath) ?? legacyDatabasePath(filePath);
  }

  /** Read the committed import if present, otherwise the legacy document.
      Decoders already inside another SQLite transaction use this path: they
      must never start a first-boot import through a second writer. */
  readExisting(filePath: string): D {
    return this.guard(() => {
      const database = this.databasePath(filePath);
      return this.readMarker(database)
        ? this.options.fromRows(this.open(database).snapshot())
        : this.options.readLegacy(filePath);
    });
  }

  /** Narrow reads and writes for stores whose unrelated rows may grow. */
  readRow(filePath: string, key: string): DocumentRow | null {
    return this.guard(() => {
      const collection = this.collection(filePath, "read");
      return collection ? collection.get(key) : this.options.toRows(this.options.readLegacy(filePath)).find(row => row.key === key) ?? null;
    });
  }

  readPage(filePath: string, after: string, limit: number): DocumentRow[] {
    return this.guard(() => {
      const collection = this.collection(filePath, "read");
      return collection ? collection.keyPage(after, limit)
        : this.options.toRows(this.options.readLegacy(filePath)).filter(row => row.key > after).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).slice(0, limit);
    });
  }

  patchRows<R>(filePath: string, budget: number, operation: (tx: import("./sqliteStateStore").StateBoundedTransaction<DocumentRow>) => R): R {
    return this.guard(() => {
      writeHookForTests?.(this.options.collection);
      return this.collection(filePath, "write")!.boundedPatch(budget, operation);
    });
  }

  /** The store's legacy import spec, for the import driver and its tests. */
  legacyCollection(filePath: string): LegacyCollectionSpec<D> {
    return {
      collection: this.options.collection,
      schemaVersion: 1,
      migrationId: this.options.migrationId,
      legacyPath: filePath,
      databasePath: this.databasePath(filePath),
      nonBlockingLock: this.options.nonBlockingLock,
      validateLegacyPath: () => this.options.validateLegacyPath?.(filePath),
      parse: (raw) => this.options.parse(raw),
      toRows: (document): StateImportRow[] => this.options.toRows(document)
        .map((row) => ({ key: row.key, value: row, controllerActive: true })),
      reconcile: (document, baseline, reconcileOptions) => this.merge(filePath, document, baseline, reconcileOptions),
      mirrorBody: () => {
        let mirror: { body: unknown; revision: number } | null = null;
        this.open(this.databasePath(filePath)).checkpointMirror((rows, revision) => {
          mirror = { body: this.options.toFile(this.options.fromRows(rows)), revision };
        });
        return mirror!;
      },
    };
  }

  /** Import the legacy file now. The Viewer's activation calls this with
      `reconcile: true`; tests drive the crash seams through `hooks`. */
  importLegacy(filePath: string, options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true }): LegacyImportOutcome {
    return this.guard(() => importLegacyCollection(this.legacyCollection(filePath), options));
  }

  /** Write the legacy file from SQLite for a rollback release that predates the move. */
  checkpointRollbackMirror(filePath: string): void {
    this.guard(() => writeLegacyRollbackMirror(this.legacyCollection(filePath)));
  }

  /** The committed document. Before the import may run (an unpromoted
      release, a build, a process that does not own the directory) it is the
      legacy file, read the way the store always read it. */
  read(filePath: string): D {
    return this.guard(() => {
      const collection = this.collection(filePath, "read");
      if (!collection) return this.options.readLegacy(filePath);
      return this.options.fromRows(collection.snapshot());
    });
  }

  /**
   * One serialized read-modify-write. The callback reads the committed
   * document under the collection lease and returns the next one, or
   * `undefined` to write nothing. Only the rows that changed are written.
   */
  mutate<R>(filePath: string, mutate: (document: D) => { next: D | undefined; result: R }): R {
    return this.guard(() => {
      const collection = this.collection(filePath, "write")!;
      writeHookForTests?.(this.options.collection);
      let result: R;
      collection.patchSync(() => {
        const committed = collection.snapshot();
        const outcome = mutate(this.options.fromRows(committed));
        result = outcome.result;
        if (outcome.next === undefined) return { records: [] };
        return this.patch(committed, this.options.toRows(outcome.next));
      });
      return result!;
    });
  }

  /** Remove every row from a document collection. Used by owners whose legacy
      contract distinguishes an absent document from a saved empty one. */
  clear(filePath: string): void {
    this.guard(() => this.collection(filePath, "write")!.replaceSync([]));
  }

  /** The rows to write for `next` over `committed`: changed rows, deleted
      keys, and the changed rows that move behind rows they used to precede
      (a set replaced for its conversation becomes the newest). */
  private patch(committed: readonly DocumentRow[], next: readonly DocumentRow[]) {
    const held = new Map(committed.map((row) => [row.key, row] as const));
    const nextKeys = new Set(next.map((row) => row.key));
    const records = next.filter((row) => {
      const current = held.get(row.key);
      return !current || JSON.stringify(current) !== JSON.stringify(row);
    });
    const changed = new Set(records.map((row) => row.key));
    const kept = committed.map((row) => row.key).filter((key) => nextKeys.has(key));
    let inOrder = 0;
    while (inOrder < next.length && inOrder < kept.length && next[inOrder]!.key === kept[inOrder]) inOrder += 1;
    const appendKeys = next.slice(inOrder).map((row) => row.key).filter((key) => changed.has(key) && held.has(key));
    const deleteKeys = committed.map((row) => row.key).filter((key) => !nextKeys.has(key));
    return { records, deleteKeys, appendKeys };
  }

  /**
   * Merge a legacy file that changed after the import (a rollback release
   * wrote it, or an older writer raced a fence). A row SQLite has not
   * rewritten since the file's baseline is the file's to change; a row SQLite
   * rewrote since then stays and is listed as a conflict; a row only the file
   * holds is added. None of these stores' older releases carry a mirror marker
   * through their writes, so a file missing a row proves nothing: missing rows
   * are spared, never deleted: a set or request the rollback release removed
   * comes back at roll-forward. A store whose older writers do carry a marker
   * through their writes needs a merge of its own.
   */
  private merge(filePath: string, document: D, baseline: StateImportRecord, options: { fenceOwner: boolean }): LegacyReconcileSummary {
    const collection = this.open(this.databasePath(filePath));
    const since = legacyBaselineRevision(baseline);
    const summary: LegacyReconcileSummary = { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
    collection.patchSync(() => {
      const current = new Map(collection.snapshot().map((row) => [row.key, row] as const));
      const revisions = collection.rowRevisions();
      const incoming = this.options.toRows(document);
      const incomingKeys = new Set(incoming.map((row) => row.key));
      const records: DocumentRow[] = [];
      for (const row of incoming) {
        const held = current.get(row.key);
        if (!held) {
          records.push(row);
          summary.added += 1;
          summary.keys.push(row.key);
          continue;
        }
        if (JSON.stringify(held) === JSON.stringify(row)) continue;
        const merged = this.options.mergeRow?.(row.key, held.value, row.value);
        if (merged !== undefined) {
          if (JSON.stringify(merged) === JSON.stringify(held.value)) continue;
          records.push({ key: row.key, value: merged });
          summary.replaced += 1;
          summary.keys.push(row.key);
          continue;
        }
        if ((revisions.get(row.key) ?? 0) > since) {
          summary.conflicts.push(row.key);
          summary.kept += 1;
          continue;
        }
        records.push(row);
        summary.replaced += 1;
        summary.keys.push(row.key);
      }
      for (const key of current.keys()) if (!incomingKeys.has(key)) summary.spared.push(key);
      return { records };
    }, { fenceOwner: options.fenceOwner });
    return summary;
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

  private readMarker(database: string): StateImportRecord | null {
    return stateLockAttempt("state.marker.legacy", () => readStateImport(database, this.options.collection), this.options.collection);
  }

  private open(database: string): SqliteStateCollection<DocumentRow> {
    const held = this.collections.get(database);
    if (held) return held;
    const collection = new SqliteStateCollection<DocumentRow>(database, {
      collection: this.options.collection,
      schemaVersion: 1,
      busyMessage: this.options.busyMessage,
      key: (row) => row.key,
      decode: (value) => isDocumentRow(value) ? value : null,
      clone: (row) => structuredClone(row),
      strictDecode: true,
      readCacheKey: "legacy-document-v1",
      decodeError: (error) => this.options.error(`invalid ${this.options.collection} row`, error),
    });
    const max = this.options.maxOpenCollections;
    if (max !== undefined && this.collections.size >= max) {
      const oldest = this.collections.keys().next().value!;
      this.collections.get(oldest)!.close();
      this.collections.delete(oldest);
    }
    this.collections.set(database, collection);
    return collection;
  }

  /** The collection for `filePath`, importing the legacy file on first use.
      Null only for a read before the import may run. */
  private collection(filePath: string, purpose: "read" | "write"): SqliteStateCollection<DocumentRow> | null {
    const database = this.databasePath(filePath);
    if (this.collections.has(database) && this.readMarker(database)) return this.collections.get(database)!;
    this.collections.get(database)?.close();
    this.collections.delete(database);
    if (!this.readMarker(database)) {
      if (!legacyImportAllowed(filePath, database)) {
        if (purpose === "read") return null;
        throw new FileTransactionBusyError(`${this.options.collection} state is waiting for release promotion`);
      }
      this.importLegacy(filePath, { reconcile: lazyReconcileAllowed(filePath, database) });
    }
    return this.open(database);
  }
}
