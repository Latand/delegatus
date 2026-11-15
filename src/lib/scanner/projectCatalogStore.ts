import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { displayNameFromProjectIdentity } from "@/lib/projects/identity";
import { fsyncPath } from "@/lib/state/durableJson";
import { hotStateWriterRevision } from "@/lib/state/hotStateAuthority";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import {
  lazyReconcileAllowed,
  legacyDatabasePath,
  legacyImportAllowed,
  type LegacyImportOutcome,
} from "@/lib/state/legacyImport";
import {
  importStateCollection,
  readStateCollectionFields,
  readStateCollectionRevision,
  readStateCollectionSelection,
  readStateImport,
  reimportStateCollection,
  SqliteStateCollection,
  type StateImportRow,
} from "@/lib/state/sqliteStateStore";
import { assertStateMutationAllowed } from "@/lib/state/stateMutationBarrier";
import { assertStateStartupMutation } from "@/lib/stateOwnership";

import type { Engine, Fmt } from "../types";
import type { RawEntry } from "./discover";

/*
 * The project catalog in `state.sqlite`: what the scanner learned about each
 * transcript it described, keyed by path, so a later scan describes only the
 * transcripts whose bytes moved. It used to be `project-catalog.json`, which
 * every persisting scan rewrote whole (15 MB on a busy install, about every two
 * minutes) and every reader parsed whole.
 *
 * Layout of the `project_catalog` collection, one row per key:
 *
 *   meta          { version, resolutionVersion, stateKey }
 *   f:<path>      one catalogued file, as the scan stored it
 *
 * Every row a complete scan writes was resolved under the same project
 * resolution state, so that state key is stored once, in `meta`. A file row
 * carries its own `stateKey` only when it differs (a row imported from a file
 * an older release wrote). A scan writes the rows whose record changed and
 * deletes the rows whose files vanished, in one transaction; a resolution
 * state that moved and re-projected nothing rewrites `meta` alone.
 *
 * The catalog is a cache. A missing or unreadable legacy file costs one full
 * rescan, so the legacy file is imported when it is there (the first scan
 * after the move stays incremental) and then deleted: no `.imported-*` copy,
 * no tombstone and no rollback mirror. An older release that finds no file
 * rescans once and writes its own. The activation imports a file such a
 * release left behind; an install with no release target imports it on the
 * next read.
 */

export const PROJECT_CATALOG_COLLECTION = "project_catalog";
export const PROJECT_CATALOG_FILE_NAME = "project-catalog.json";
const MIGRATION_ID = "project-catalog-json-v1";
const BUSY = "project catalog state is busy";
const META_KEY = "meta";
const FILE_PREFIX = "f:";

/** Project-summary semantic version. Bumped to 3 for issue #339 so a restart
    re-derives engine-native subagent titles and never replays a pre-#339
    generic title or a phantom bookkeeping card. */
export const PROJECT_SUMMARY_VERSION = 4 as const;

export type CachedProjectFile = {
  summaryVersion?: typeof PROJECT_SUMMARY_VERSION;
  summaryIncomplete?: true;
  rootName: RawEntry["rootName"];
  size: number;
  mtimeMs: number;
  sidecarSize?: number | null;
  sidecarMtimeMs?: number | null;
  /** Absent: the catalog's own state key (`meta.stateKey`). */
  stateKey?: string;
  project: string;
  projectName?: string;
  projectUnresolved?: true;
  projectRoot?: string | null;
  kind: string;
  session: boolean;
  worktree?: string;
  cwd?: string | null;
  sessionStartedAt?: string | null;
  nativeParentThreadId?: string | null;
  nativeForkSourceThreadId?: string | null;
  title?: string;
  engine?: Engine;
  fmt?: Fmt;
};

const FILE_FIELDS = [
  "summaryVersion", "summaryIncomplete", "rootName", "size", "mtimeMs", "sidecarSize", "sidecarMtimeMs",
  "project", "projectName", "projectUnresolved", "projectRoot", "kind", "session", "worktree", "cwd",
  "sessionStartedAt", "nativeParentThreadId", "nativeForkSourceThreadId", "title", "engine", "fmt",
] as const satisfies readonly (keyof CachedProjectFile)[];

export function isConversation(rootName: RawEntry["rootName"], kind: string): boolean {
  return rootName === "codex-sessions"
    || rootName === "openclaw-sessions"
    || rootName === "copilot-sessions"
    || (rootName === "claude-projects" && (kind === "session" || kind === "subagent"));
}

/** One stored record, as the scan reads it: null when it is not a record this
    release can reuse. A summary missing a field a later release added reads
    as incomplete, so the next scan describes it again. */
export function decodeCatalogFile(value: unknown): CachedProjectFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const file = value as Partial<CachedProjectFile>;
  if (
    (file.rootName !== "codex-sessions" && file.rootName !== "claude-projects" && file.rootName !== "claude-tasks" && file.rootName !== "openclaw-sessions" && file.rootName !== "copilot-sessions") ||
    typeof file.size !== "number" ||
    typeof file.mtimeMs !== "number" ||
    (file.stateKey !== undefined && typeof file.stateKey !== "string") ||
    typeof file.project !== "string" ||
    (file.projectName !== undefined && typeof file.projectName !== "string") ||
    (file.projectUnresolved !== undefined && file.projectUnresolved !== true) ||
    (file.projectRoot !== undefined && file.projectRoot !== null && typeof file.projectRoot !== "string") ||
    typeof file.kind !== "string"
  ) {
    return null;
  }
  const engine = file.engine === "codex" || file.engine === "claude" || file.engine === "shell" || file.engine === "openclaw" || file.engine === "copilot" ? file.engine : undefined;
  const fmt = file.fmt === "codex" || file.fmt === "claude" || file.fmt === "plain" || file.fmt === "openclaw" || file.fmt === "copilot" ? file.fmt : undefined;
  const nullable = <T>(field: unknown, kind: "string" | "number"): T | null | undefined =>
    typeof field === kind ? field as T : field === null ? null : undefined;
  const cwd = nullable<string>(file.cwd, "string");
  const sessionStartedAt = nullable<string>(file.sessionStartedAt, "string");
  const nativeParentThreadId = nullable<string>(file.nativeParentThreadId, "string");
  const nativeForkSourceThreadId = nullable<string>(file.nativeForkSourceThreadId, "string");
  const sidecarSize = nullable<number>(file.sidecarSize, "number");
  const sidecarMtimeMs = nullable<number>(file.sidecarMtimeMs, "number");
  const summaryComplete = file.summaryVersion === PROJECT_SUMMARY_VERSION
    && typeof file.title === "string"
    && typeof file.projectName === "string"
    && engine !== undefined
    && fmt !== undefined
    && cwd !== undefined
    && sessionStartedAt !== undefined
    && nativeParentThreadId !== undefined
    /* A summary written before the fork edge was carried (#708) is treated
       as incomplete rather than replayed: serving it would leave the edge
       absent and send migration reconciliation back to the transcript
       header for it on every restart. One re-derivation settles it. */
    && nativeForkSourceThreadId !== undefined
    && file.projectRoot !== undefined
    && sidecarSize !== undefined
    && sidecarMtimeMs !== undefined;
  return {
    summaryVersion: summaryComplete ? PROJECT_SUMMARY_VERSION : undefined,
    summaryIncomplete: !summaryComplete && file.summaryIncomplete === true ? true : undefined,
    rootName: file.rootName,
    size: file.size,
    mtimeMs: file.mtimeMs,
    sidecarSize,
    sidecarMtimeMs,
    ...(file.stateKey !== undefined ? { stateKey: file.stateKey } : {}),
    project: file.project,
    projectName: typeof file.projectName === "string"
      ? file.projectName
      : displayNameFromProjectIdentity(file.project),
    projectUnresolved: file.projectUnresolved === true ? true : undefined,
    projectRoot: typeof file.projectRoot === "string" ? file.projectRoot : file.projectRoot === null ? null : undefined,
    kind: file.kind,
    session: isConversation(file.rootName, file.kind),
    worktree: typeof file.worktree === "string" ? file.worktree : undefined,
    cwd,
    sessionStartedAt,
    nativeParentThreadId,
    nativeForkSourceThreadId,
    title: typeof file.title === "string" ? file.title : undefined,
    engine,
    fmt,
  };
}

/** The record a scan stores: the state key is left out when it is the
    catalog's own. */
function storedFile(file: CachedProjectFile, stateKey: string): CachedProjectFile {
  const stored: Partial<CachedProjectFile> = {};
  for (const field of FILE_FIELDS) {
    if (file[field] !== undefined) (stored as Record<string, unknown>)[field] = file[field];
  }
  if (file.stateKey !== undefined && file.stateKey !== stateKey) stored.stateKey = file.stateKey;
  return stored as CachedProjectFile;
}

/** Whether a stored record already holds `next`, stored under `stateKey`.
    A record that names no state key of its own takes the catalog's, so a
    write that moves `meta.stateKey` leaves such a record's row alone. */
function sameFile(held: CachedProjectFile, next: CachedProjectFile, stateKey: string): boolean {
  if (held.stateKey !== (next.stateKey === undefined || next.stateKey === stateKey ? undefined : next.stateKey)) return false;
  for (const field of FILE_FIELDS) if (held[field] !== next[field]) return false;
  return true;
}

/* ------------------------------------------------------------------ rows */

interface CatalogMeta {
  /** The legacy body's version: only 1 and 2 hold records a scan reuses. */
  version: number | null;
  resolutionVersion: number;
  stateKey: string | null;
}

function reusable(meta: CatalogMeta | null): boolean {
  return meta?.version === 1 || meta?.version === 2;
}

/** A stored row. `file` is the decoded record of a file row (null when this
    release cannot reuse it); `value` is that record, or the stored value as
    written when it does not decode, for the readers that only want its
    folders. */
interface CatalogRow {
  key: string;
  value: unknown;
  file?: CachedProjectFile | null;
}

function isRowShape(value: unknown): value is { key: string; value: unknown } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as CatalogRow).key === "string" && (value as CatalogRow).key.length > 0
    && Object.hasOwn(value as object, "value");
}

function decodeRow(value: unknown): CatalogRow | null {
  if (!isRowShape(value)) return null;
  if (!value.key.startsWith(FILE_PREFIX)) return { key: value.key, value: value.value };
  const file = decodeCatalogFile(value.value);
  return { key: value.key, value: file ?? value.value, file };
}

function decodeMeta(value: unknown): CatalogMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const meta = value as Partial<CatalogMeta>;
  return {
    version: typeof meta.version === "number" ? meta.version : null,
    resolutionVersion: typeof meta.resolutionVersion === "number" ? meta.resolutionVersion : 0,
    stateKey: typeof meta.stateKey === "string" ? meta.stateKey : null,
  };
}

/** Rows for a legacy file body: the most common state key moves to `meta`. */
function legacyRows(body: Record<string, unknown>): StateImportRow[] {
  const files = body.files as Record<string, unknown>;
  const counts = new Map<string, number>();
  for (const value of Object.values(files)) {
    const stateKey = (value as { stateKey?: unknown } | null)?.stateKey;
    if (typeof stateKey === "string") counts.set(stateKey, (counts.get(stateKey) ?? 0) + 1);
  }
  const stateKey = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  const meta: CatalogMeta = {
    version: typeof body.version === "number" ? body.version : null,
    resolutionVersion: typeof body.resolutionVersion === "number" ? body.resolutionVersion : 0,
    stateKey,
  };
  const rows: StateImportRow[] = [{ key: META_KEY, value: { key: META_KEY, value: meta }, controllerActive: true }];
  /* In the file's order, which the readers of folders keep. */
  for (const [pathname, value] of Object.entries(files)) {
    let stored = value;
    if (value && typeof value === "object" && !Array.isArray(value) && (value as { stateKey?: unknown }).stateKey === stateKey && stateKey !== null) {
      const { stateKey: _omitted, ...rest } = value as Record<string, unknown>;
      stored = rest;
    }
    const key = `${FILE_PREFIX}${pathname}`;
    rows.push({ key, value: { key, value: stored }, controllerActive: true });
  }
  return rows;
}

/** The legacy body, or null when it holds no records at all. A body of
    another version keeps its records for the readers of folders; the scan
    reuses none of them, as it never did. */
function legacyBody(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (!body.files || typeof body.files !== "object" || Array.isArray(body.files)) return null;
  return body;
}

/* ---------------------------------------------------------------- views */

/**
 * What one read of the catalog answers. Shared by every reader of the same
 * revision: never mutate it or the records it holds.
 */
export interface ProjectCatalogView {
  /** Moves with every committed change; a cache key for derived answers. */
  signature: string;
  /** Null: the catalog was never written (an empty answer). */
  resolutionVersion: number | null;
  /** The state key every record without its own was resolved under. */
  stateKey: string | null;
  /** Every record this release can reuse, by path. */
  files: ReadonlyMap<string, CachedProjectFile>;
  /** Every stored record by path, as decoded or, when it does not decode, as
      written, whatever version holds it: for readers of a record's project
      and folders, never for reuse. */
  records(): ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** The folders the records name, including records this release cannot
      reuse: `paths` holds each working directory and project root once, in
      record order. */
  folders(): CatalogFolders;
}

export interface CatalogFolders {
  paths: readonly string[];
  projectRoots: ReadonlySet<string>;
}

function emptyView(signature: string): ProjectCatalogView {
  return viewOf(signature, null, []);
}

type ViewRow = { path: string; value: unknown; file: CachedProjectFile | null };

/** A view and what a write compares against: the meta row and the paths of
    the rows the view does not reuse. */
interface HeldView extends ProjectCatalogView {
  /** The collection revision the rows were read at or after; -1 for a file. */
  revision: number;
  meta: CatalogMeta | null;
  unreusable: readonly string[];
}

function viewOf(signature: string, meta: CatalogMeta | null, rows: readonly ViewRow[], revision = -1): HeldView {
  const files = new Map<string, CachedProjectFile>();
  const unreusable: string[] = [];
  /* Only a body of a version this release reads holds records a scan reuses. */
  const reusableRows = reusable(meta);
  for (const row of rows) {
    if (reusableRows && row.file) files.set(row.path, row.file);
    else unreusable.push(row.path);
  }
  let folders: CatalogFolders | null = null;
  let records: Map<string, Readonly<Record<string, unknown>>> | null = null;
  return {
    revision,
    meta,
    unreusable,
    signature,
    resolutionVersion: meta || rows.length ? meta?.resolutionVersion ?? 0 : null,
    stateKey: meta?.stateKey ?? null,
    files,
    records: () => {
      if (records) return records;
      records = new Map();
      for (const row of rows) {
        if (row.value && typeof row.value === "object" && !Array.isArray(row.value)) records.set(row.path, row.value as Record<string, unknown>);
      }
      return records;
    },
    folders: () => {
      if (folders) return folders;
      const paths = new Set<string>();
      const projectRoots = new Set<string>();
      for (const { value } of rows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const { cwd, projectRoot } = value as { cwd?: unknown; projectRoot?: unknown };
        if (typeof cwd === "string" && cwd.trim()) paths.add(cwd);
        if (typeof projectRoot === "string" && projectRoot.trim()) {
          paths.add(projectRoot);
          projectRoots.add(projectRoot);
        }
      }
      folders = { paths: [...paths], projectRoots };
      return folders;
    },
  };
}

/* ------------------------------------------------------------ collection */

const holder = globalThis as typeof globalThis & {
  __delegatusProjectCatalogStoreV1__?: {
    collections: Map<string, { identity: string | null; collection: SqliteStateCollection<CatalogRow> }>;
    views: Map<string, { ordered: readonly CatalogRow[]; view: HeldView }>;
    legacy: Map<string, { signature: string; view: ProjectCatalogView }>;
    folders: Map<string, FolderIndex>;
  };
};
const runtime = holder.__delegatusProjectCatalogStoreV1__ ??= { collections: new Map(), views: new Map(), legacy: new Map(), folders: new Map() };

function databaseIdentity(database: string): string | null {
  const stat = fs.statSync(database, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

/** The open collection, or null while it does not exist. */
function openCatalog(database: string): SqliteStateCollection<CatalogRow> | null {
  const identity = databaseIdentity(database);
  const held = runtime.collections.get(database);
  if (held && held.identity === identity) return held.collection;
  held?.collection.close();
  runtime.collections.delete(database);
  runtime.views.delete(database);
  if (identity === null || readStateCollectionRevision(database, PROJECT_CATALOG_COLLECTION) === null) return null;
  const collection = new SqliteStateCollection<CatalogRow>(database, {
    collection: PROJECT_CATALOG_COLLECTION,
    schemaVersion: 1,
    busyMessage: BUSY,
    key: (row) => row.key,
    decode: decodeRow,
    clone: (row) => row,
  });
  runtime.collections.set(database, { identity, collection });
  return collection;
}

function collectionView(database: string, collection: SqliteStateCollection<CatalogRow>): HeldView {
  const held = runtime.views.get(database);
  /* The revision is read first: a view is never keyed newer than its rows. */
  const revision = collection.revision();
  const ordered = collection.loadReadonly();
  if (held?.ordered === ordered) return held.view;
  let meta: CatalogMeta | null = null;
  const files: ViewRow[] = [];
  for (const row of ordered) {
    if (row.key === META_KEY) meta = decodeMeta(row.value);
    else if (row.key.startsWith(FILE_PREFIX)) files.push({ path: row.key.slice(FILE_PREFIX.length), value: row.value, file: row.file ?? null });
  }
  const view = viewOf(`sqlite:${database}:${databaseIdentity(database)}:${revision}`, meta, files, revision);
  runtime.views.set(database, { ordered, view });
  return view;
}

function legacySignature(filePath: string): string | null {
  const stat = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? `legacy:${filePath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : null;
}

/** The legacy file, read the way the scanner always read it: anything that
    is not a catalog is an empty one. */
function legacyView(filePath: string): ProjectCatalogView {
  const signature = legacySignature(filePath);
  if (signature === null) return emptyView(`legacy:${filePath}:missing`);
  const held = runtime.legacy.get(filePath);
  if (held?.signature === signature) return held.view;
  let body: Record<string, unknown> | null = null;
  try {
    body = legacyBody(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    body = null;
  }
  let view: ProjectCatalogView;
  if (!body) view = emptyView(signature);
  else {
    const meta: CatalogMeta = {
      version: typeof body.version === "number" ? body.version : null,
      resolutionVersion: typeof body.resolutionVersion === "number" ? body.resolutionVersion : 0,
      stateKey: null,
    };
    view = viewOf(signature, meta, Object.entries(body.files as Record<string, unknown>).map(([pathname, value]) => {
      const file = decodeCatalogFile(value);
      return { path: pathname, value: file ?? value, file };
    }));
  }
  runtime.legacy.set(filePath, { signature, view });
  return view;
}

function isRegularFile(filePath: string): boolean {
  return fs.lstatSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
}

let importDiagnosticAt = Number.NEGATIVE_INFINITY;

/** Import a legacy file found beside the database when this process may. A
    process that may not reads the collection when it exists, else the file. */
function settleLegacyFile(filePath: string, database: string): void {
  if (!isRegularFile(filePath) || !legacyImportAllowed(filePath, database)) return;
  if (openCatalog(database) && !lazyReconcileAllowed(filePath, database)) return;
  try {
    importLegacyProjectCatalog(filePath);
  } catch (error) {
    const now = Date.now();
    if (now - importDiagnosticAt < 60_000) return;
    importDiagnosticAt = now;
    console.error(`[project catalog] legacy import deferred: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function projectCatalogLegacyPath(): string {
  return statePath(PROJECT_CATALOG_FILE_NAME);
}

/** The catalog as committed. Before the collection exists (a release that may
    not import yet), the legacy file. */
export function readProjectCatalog(filePath = projectCatalogLegacyPath()): ProjectCatalogView {
  const database = legacyDatabasePath(filePath);
  settleLegacyFile(filePath, database);
  const collection = openCatalog(database);
  return collection ? collectionView(database, collection) : legacyView(filePath);
}

/** Each record's working directory and project root, in row order: what a
    process that does not scan keeps to answer the folder readers. */
interface FolderIndex {
  identity: string | null;
  revision: number;
  byPath: Map<string, [cwd: string | null, projectRoot: string | null]>;
  folders: CatalogFolders | null;
}

const CHANGE_PAGE = 2_048;

function folderFields(value: unknown): [string | null, string | null] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [null, null];
  const { cwd, projectRoot } = value as { cwd?: unknown; projectRoot?: unknown };
  return [typeof cwd === "string" ? cwd : null, typeof projectRoot === "string" ? projectRoot : null];
}

function foldersOf(byPath: FolderIndex["byPath"]): CatalogFolders {
  const paths = new Set<string>();
  const projectRoots = new Set<string>();
  for (const [cwd, projectRoot] of byPath.values()) {
    if (cwd?.trim()) paths.add(cwd);
    if (projectRoot?.trim()) {
      paths.add(projectRoot);
      projectRoots.add(projectRoot);
    }
  }
  return { paths: [...paths], projectRoots };
}

/** Every record's two fields, extracted by SQLite in one snapshot. */
function loadFolderIndex(database: string, identity: string | null): FolderIndex | null {
  const selection = readStateCollectionFields(database, PROJECT_CATALOG_COLLECTION, FILE_PREFIX, ["$.value.cwd", "$.value.projectRoot"]);
  if (!selection) return null;
  const byPath: FolderIndex["byPath"] = new Map();
  for (const { key, values: [cwd, projectRoot] } of selection.rows) {
    byPath.set(key.slice(FILE_PREFIX.length), [typeof cwd === "string" ? cwd : null, typeof projectRoot === "string" ? projectRoot : null]);
  }
  return { identity, revision: selection.revision, byPath, folders: null };
}

/** Bring the index to the collection's revision from the change log: only the
    rows written or deleted since are read. False when the log no longer
    reaches back that far (a re-import, or a reader idle past its retention). */
function advanceFolderIndex(index: FolderIndex, collection: SqliteStateCollection<CatalogRow>): boolean {
  let after = index.revision;
  let afterKey = "";
  let changed = false;
  for (;;) {
    const page = collection.changesAfter(after, afterKey, CHANGE_PAGE);
    if (page.changeFloor > index.revision) return false;
    for (const entry of page.entries) {
      if (!entry.key.startsWith(FILE_PREFIX)) continue;
      const pathname = entry.key.slice(FILE_PREFIX.length);
      changed = true;
      if (entry.valueJson === null) {
        index.byPath.delete(pathname);
        continue;
      }
      let value: unknown = null;
      try { value = (JSON.parse(entry.valueJson) as { value?: unknown }).value; } catch { value = null; }
      /* A new key goes to the end, as its row does; a rewritten one keeps its place. */
      index.byPath.set(pathname, folderFields(value));
    }
    if (page.entries.length < CHANGE_PAGE) {
      index.revision = page.revision;
      if (changed) index.folders = null;
      return true;
    }
    const last = page.entries.at(-1)!;
    after = last.revision;
    afterKey = last.key;
  }
}

/**
 * The folders the stored records name, for the readers that want nothing
 * else (directory suggestions, artifact roots, the separate-Git-directory
 * owner search). These run on the Viewer's request thread, apart from the
 * scanning process. Such a process keeps each record's two folder fields,
 * read once by SQLite without decoding a record, and afterwards reads only the
 * rows the change log names: a scan that changed twenty records costs it
 * twenty rows. The process that scans answers from the catalog it holds.
 */
export function readProjectCatalogFolders(filePath = projectCatalogLegacyPath()): CatalogFolders {
  const database = legacyDatabasePath(filePath);
  settleLegacyFile(filePath, database);
  const collection = openCatalog(database);
  if (!collection) return legacyView(filePath).folders();
  const revision = collection.revision();
  const held = runtime.views.get(database)?.view;
  if (held && held.revision === revision) return held.folders();
  const identity = databaseIdentity(database);
  let index = runtime.folders.get(database);
  if (index && (index.identity !== identity || (index.revision !== revision && !advanceFolderIndex(index, collection)))) index = undefined;
  if (!index) {
    const loaded = loadFolderIndex(database, identity);
    if (!loaded) return emptyView(`sqlite:${database}:empty`).folders();
    index = loaded;
    runtime.folders.set(database, index);
  }
  return index.folders ??= foldersOf(index.byPath);
}

/**
 * Every stored record by path, read once and not kept: for a reader that
 * walks the whole catalog rarely (the worktree recovery at startup). Null
 * while no scan has written a catalog.
 */
export function readProjectCatalogRecords(filePath = projectCatalogLegacyPath()): ReadonlyMap<string, Readonly<Record<string, unknown>>> | null {
  const database = legacyDatabasePath(filePath);
  settleLegacyFile(filePath, database);
  const collection = openCatalog(database);
  if (!collection) {
    const view = legacyView(filePath);
    return view.resolutionVersion === null ? null : view.records();
  }
  const held = runtime.views.get(database)?.view;
  if (held && held.revision === readStateCollectionRevision(database, PROJECT_CATALOG_COLLECTION)) {
    return held.resolutionVersion === null ? null : held.records();
  }
  const selection = readStateCollectionSelection(database, PROJECT_CATALOG_COLLECTION, { prefixes: [FILE_PREFIX], keys: [META_KEY] });
  if (!selection) return null;
  const records = new Map<string, Readonly<Record<string, unknown>>>();
  let written = false;
  for (const row of selection.rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.valueJson); } catch { continue; }
    if (!isRowShape(parsed)) continue;
    written = true;
    if (row.key.startsWith(FILE_PREFIX) && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      records.set(row.key.slice(FILE_PREFIX.length), parsed.value as Record<string, unknown>);
    }
  }
  return written ? records : null;
}

/** The catalog's committed identity, for cache keys. */
export function projectCatalogSignature(filePath = projectCatalogLegacyPath()): string {
  const database = legacyDatabasePath(filePath);
  settleLegacyFile(filePath, database);
  if (openCatalog(database)) {
    const revision = readStateCollectionRevision(database, PROJECT_CATALOG_COLLECTION);
    if (revision !== null) return `sqlite:${database}:${databaseIdentity(database)}:${revision}`;
  }
  return legacySignature(filePath) ?? `legacy:${filePath}:missing`;
}

export interface ProjectCatalogWrite {
  resolutionVersion: number;
  stateKey: string;
  files: Readonly<Record<string, CachedProjectFile>>;
}

/** What one write changed. */
export interface ProjectCatalogWriteResult {
  upserted: number;
  deleted: number;
  bytes: number;
}

/**
 * Make the catalog hold exactly `next`: the rows whose record changed are
 * written, the rows of files no longer catalogued are deleted, and `meta`
 * moves when the resolution state did, all in one transaction under the
 * collection lease. Throws `FileTransactionBusyError` while this process may
 * not write the catalog (an unpromoted release) or the database is busy.
 */
export function writeProjectCatalog(next: ProjectCatalogWrite, filePath = projectCatalogLegacyPath()): ProjectCatalogWriteResult {
  const database = legacyDatabasePath(filePath);
  settleLegacyFile(filePath, database);
  let collection = openCatalog(database);
  if (!collection) {
    if (!legacyImportAllowed(filePath, database)) throw new FileTransactionBusyError("project catalog is waiting for release promotion");
    importLegacyProjectCatalog(filePath);
    collection = openCatalog(database);
    if (!collection) throw new FileTransactionBusyError("project catalog is not initialized");
  }
  /* The scan's write has always kept the state directory private. */
  fs.chmodSync(path.dirname(filePath), 0o700);
  const writable = collection;
  const result: ProjectCatalogWriteResult = { upserted: 0, deleted: 0, bytes: 0 };
  /* The rows to write, worked out from the view this process holds before
     the lease, so the database stays locked only for the write. Under the
     lease they are worked out again only if another writer moved the
     catalog in between. */
  const read = collectionView(database, writable);
  let plan = catalogWritePlan(read, next);
  writable.patchSync(() => {
    if (writable.revision() !== read.revision) plan = catalogWritePlan(collectionView(database, writable), next);
    result.upserted = plan.records.length;
    result.deleted = plan.deleteKeys.length;
    result.bytes = plan.records.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0);
    return plan;
  });
  return result;
}

/** The rows that make `held` hold exactly `next`. */
function catalogWritePlan(held: HeldView, next: ProjectCatalogWrite): { records: CatalogRow[]; deleteKeys: string[] } {
  const records: CatalogRow[] = [];
  const nextMeta: CatalogMeta = { version: 2, resolutionVersion: next.resolutionVersion, stateKey: next.stateKey };
  if (held.meta?.version !== 2 || held.meta.resolutionVersion !== nextMeta.resolutionVersion || held.meta.stateKey !== nextMeta.stateKey) {
    records.push({ key: META_KEY, value: nextMeta });
  }
  for (const [pathname, file] of Object.entries(next.files)) {
    const heldFile = held.files.get(pathname);
    if (heldFile && sameFile(heldFile, file, next.stateKey)) continue;
    const stored = storedFile(file, next.stateKey);
    /* A field the decoder normalizes is no change: compare as a read decodes it. */
    const decoded = heldFile ? decodeCatalogFile(stored) : null;
    if (heldFile && decoded && sameFile(heldFile, decoded, next.stateKey)) continue;
    records.push({ key: `${FILE_PREFIX}${pathname}`, value: stored });
  }
  const deleteKeys: string[] = [];
  for (const pathname of held.files.keys()) if (!Object.hasOwn(next.files, pathname)) deleteKeys.push(`${FILE_PREFIX}${pathname}`);
  for (const pathname of held.unreusable) if (!Object.hasOwn(next.files, pathname)) deleteKeys.push(`${FILE_PREFIX}${pathname}`);
  return { records, deleteKeys };
}

/* ------------------------------------------------------------ the import */

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** The importing release, for the import evidence, as the shared helper records it. */
function importingRelease(directory: string): string | null {
  try {
    return hotStateWriterRevision(directory)?.slice(0, 12) ?? null;
  } catch {
    return null;
  }
}

/**
 * Import `project-catalog.json` into the collection, creating the collection
 * (empty when there is no file), then delete the file. A file that does not
 * parse imports as empty: the next scan describes everything. A file found
 * after the collection exists replaces it, since it is what the release that
 * last scanned wrote; `reconcile: false` leaves such a file for later. The
 * Viewer's activation calls this; a process with no release target calls it
 * from the first read or write that finds the file.
 */
export function importLegacyProjectCatalog(
  filePath = projectCatalogLegacyPath(),
  options: { reconcile: boolean } = { reconcile: true },
): LegacyImportOutcome {
  const directory = path.dirname(filePath);
  assertStateMutationAllowed(directory);
  assertStateStartupMutation(directory, `${PROJECT_CATALOG_COLLECTION} import`);
  const database = legacyDatabasePath(filePath);
  const held = readStateImport(database, PROJECT_CATALOG_COLLECTION);
  let stat: fs.Stats | undefined;
  let bytes: Buffer | null = null;
  try {
    stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (stat?.isFile()) bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw new FileTransactionBusyError(`legacy project catalog is unreadable for now: ${(error as Error).message}`);
  }
  if (bytes === null) {
    if (held) return { state: "already-imported", record: held, incident: null };
    const { record } = importStateCollection(database, {
      collection: PROJECT_CATALOG_COLLECTION, schemaVersion: 1, migrationId: MIGRATION_ID, rows: [],
      sourceName: PROJECT_CATALOG_FILE_NAME, sourceSha256: null, sourceBytes: 0, gap: null, release: importingRelease(directory),
    });
    return { state: "imported", record, incident: null };
  }
  if (held && !options.reconcile) return { state: "reconcile-deferred", record: held, incident: null };
  let body: Record<string, unknown> | null = null;
  try {
    body = legacyBody(JSON.parse(bytes.toString("utf8")));
  } catch {
    body = null;
  }
  const input = {
    collection: PROJECT_CATALOG_COLLECTION,
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    rows: body ? legacyRows(body) : [],
    sourceName: PROJECT_CATALOG_FILE_NAME,
    sourceSha256: sha256(bytes),
    sourceBytes: bytes.length,
    gap: body ? null : "legacy-unreadable",
    release: importingRelease(directory),
  };
  const outcome: LegacyImportOutcome = held
    ? { state: "reimported", record: reimportStateCollection(database, input).record, incident: null }
    : { state: "imported", record: importStateCollection(database, input).record, incident: null };
  /* A rename that replaced the file since it was read put a newer catalog
     there: leave it for the next import. */
  const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (current?.isFile() && current.ino === stat!.ino && current.dev === stat!.dev) {
    fs.rmSync(filePath, { force: true });
    fsyncPath(directory);
  }
  runtime.views.delete(database);
  return outcome;
}

/** Test seam: forget every open collection and cached read, the way a
    restarted process would. */
export function resetProjectCatalogStoreForTests(): void {
  for (const { collection } of runtime.collections.values()) collection.close();
  runtime.collections.clear();
  runtime.views.clear();
  runtime.legacy.clear();
  runtime.folders.clear();
}

/** Test seam: store `body`, a catalog in the legacy file's shape, as the
    import of such a file stores it, and open this process's reader, so the
    state directory holds what it will hold while readers come and go. */
export function seedProjectCatalogForTests(body: unknown, filePath = projectCatalogLegacyPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(body), { mode: 0o600 });
  importLegacyProjectCatalog(filePath);
  readProjectCatalog(filePath);
}

/** Test seam: the catalog in the legacy file's shape, every stored record
    with its effective state key. */
export function projectCatalogDocumentForTests(filePath = projectCatalogLegacyPath()): {
  version: number; resolutionVersion: number; files: Record<string, Record<string, unknown>>;
} | null {
  const database = legacyDatabasePath(filePath);
  const collection = openCatalog(database);
  if (!collection) return null;
  let meta: CatalogMeta | null = null;
  const files: Record<string, Record<string, unknown>> = {};
  const raw: [string, Record<string, unknown>][] = [];
  for (const row of collection.loadReadonly()) {
    if (row.key === META_KEY) meta = decodeMeta(row.value);
    else if (row.key.startsWith(FILE_PREFIX)) raw.push([row.key.slice(FILE_PREFIX.length), row.value as Record<string, unknown>]);
  }
  for (const [pathname, value] of raw) {
    const record = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
    files[pathname] = { ...record, stateKey: (value as { stateKey?: string }).stateKey ?? meta?.stateKey ?? undefined };
  }
  return { version: meta?.version ?? 2, resolutionVersion: meta?.resolutionVersion ?? 0, files };
}
