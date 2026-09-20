import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
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
} from "@/lib/state/legacyImport";
import { readStateImport, SqliteStateCollection, type StateImportRecord, type StateImportRow } from "@/lib/state/sqliteStateStore";

import { type BoardCausalHistory, canonicalizeKeyRevisions, stampKeyRevisions } from "@/lib/board/keys";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import { DEFAULT_BOARD_IDLE_COLLAPSE_MINUTES, MAX_BOARD_IDLE_COLLAPSE_MINUTES } from "@/lib/board/types";
import type { BoardFileV1, BoardProjectStateV1 } from "@/lib/view/types";

export const BOARD_FILE = statePath("board.json");
const EMPTY_PREFS: BoardProjectStateV1["prefs"] = { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], seenAt: {}, idleCollapseMinutes: DEFAULT_BOARD_IDLE_COLLAPSE_MINUTES, viewMode: null, taskPanelOpen: false };
let boardFileForTests: string | null = null;

export class BoardStoreError extends Error {
  constructor(message = "board state unavailable", options?: ErrorOptions) { super(message, options); }
}

export function setBoardFileForTests(filePath: string | null): void {
  boardFileForTests = filePath;
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function aliases(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}
/** Acknowledgement stamps: epoch seconds, so any finite non-negative number. */
function seenStamps(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item) && (item as number) >= 0);
}
function keyRevisions(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => Number.isInteger(item) && (item as number) >= 0);
}
function projectState(value: unknown): value is BoardProjectStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<BoardProjectStateV1>;
  const prefs = state.prefs;
  return state.schemaVersion === 1 && Number.isInteger(state.revision) && state.revision! >= 0 && typeof state.updatedAt === "string" && Boolean(prefs) &&
    stringArray(prefs!.manual) && stringArray(prefs!.hidden) && stringArray(prefs!.expanded) &&
    (prefs!.favorites === undefined || stringArray(prefs!.favorites)) &&
    (prefs!.foldedEngineChildIds === undefined || stringArray(prefs!.foldedEngineChildIds)) &&
    (prefs!.expandedEngineTrayParentIds === undefined || stringArray(prefs!.expandedEngineTrayParentIds)) &&
    (prefs!.seenAt === undefined || seenStamps(prefs!.seenAt)) &&
    (prefs!.idleCollapseMinutes === undefined || prefs!.idleCollapseMinutes === null
      || (Number.isInteger(prefs!.idleCollapseMinutes) && prefs!.idleCollapseMinutes! > 0 && prefs!.idleCollapseMinutes! <= MAX_BOARD_IDLE_COLLAPSE_MINUTES)) &&
    (state.explicitManual === undefined || stringArray(state.explicitManual)) &&
    (state.pathAliases === undefined || aliases(state.pathAliases)) &&
    (state.keyRevisions === undefined || keyRevisions(state.keyRevisions)) &&
    (state.keyRevisionFloor === undefined || (Number.isInteger(state.keyRevisionFloor) && state.keyRevisionFloor! >= 0)) &&
    (prefs!.viewMode === null || prefs!.viewMode === "scheme" || prefs!.viewMode === "list") &&
    /* Any string: a face a later build names must not make this file unreadable. */
    (prefs!.desktopBoard === undefined || prefs!.desktopBoard === null || typeof prefs!.desktopBoard === "string") && typeof prefs!.taskPanelOpen === "boolean";
}

/** Union of acknowledgement maps, newest stamp per conversation identity. */
function mergeSeenAt(maps: readonly (Record<string, number> | undefined)[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    for (const [id, at] of Object.entries(map ?? {})) merged[id] = Math.max(merged[id] ?? 0, at);
  }
  return merged;
}

function emptyBoard(): BoardProjectStateV1 {
  return { schemaVersion: 1, revision: 0, updatedAt: new Date(0).toISOString(), pathAliases: {}, explicitManual: [], keyRevisions: {}, keyRevisionFloor: 0, prefs: { ...EMPTY_PREFS, manual: [], hidden: [], expanded: [] } };
}

/** The durable form of a reduction: the new revision, plus a causal revision
    stamped onto every key this write changed. Every write path goes through
    here, so no path can advance the board without advancing its keys — a key
    that changed without its revision moving is a silent hole in the fence. */
function committed(
  current: BoardProjectStateV1,
  reduced: BoardProjectStateV1,
  revision: number,
  inherited: readonly BoardCausalHistory[] = [],
): BoardProjectStateV1 {
  return {
    ...reduced,
    schemaVersion: 1,
    revision,
    updatedAt: new Date().toISOString(),
    pathAliases: reduced.pathAliases ?? {},
    ...stampKeyRevisions(current, reduced, revision, inherited),
  };
}

/** Two boards carry the same durable causal history. A migration that moves no
    content can still move history, and that has to be persisted — otherwise the
    source's clocks are silently discarded on the "nothing changed" path. */
function sameCausalHistory(left: BoardProjectStateV1, right: BoardProjectStateV1): boolean {
  return JSON.stringify({ keys: left.keyRevisions ?? {}, floor: left.keyRevisionFloor ?? 0 })
    === JSON.stringify({ keys: right.keyRevisions ?? {}, floor: right.keyRevisionFloor ?? 0 });
}

/** One stored project state as the board hands it out: fields later builds
    added default here, and the causal map collapses onto its alias classes. */
function normalizedProject(state: BoardProjectStateV1): BoardProjectStateV1 {
  return {
    ...state,
    pathAliases: state.pathAliases ?? {},
    explicitManual: state.explicitManual ?? state.prefs.manual,
    /* A board written before per-key causal revisions existed reads back with
       an empty map: every key then looks never-written, which is exactly right
       — no client can hold intent that predates a revision nobody recorded. */
    /* Canonicalized on read: an alias source must never keep a clock of its
       own, or two names for one conversation carry independent causal history
       and a stale writer holding the old name looks unopposed. */
    keyRevisions: canonicalizeKeyRevisions(state.keyRevisions ?? {}, state.pathAliases ?? {}),
    keyRevisionFloor: state.keyRevisionFloor ?? 0,
    /* Boards written before favorites / tray intent existed lack the fields;
       default them so every GET response and reducer input carries the
       durable-id lists (issue #185 favorites, issue #142 tray pins). */
    prefs: {
      ...state.prefs,
      favorites: state.prefs.favorites ?? [],
      foldedEngineChildIds: state.prefs.foldedEngineChildIds ?? [],
      expandedEngineTrayParentIds: state.prefs.expandedEngineTrayParentIds ?? [],
      seenAt: state.prefs.seenAt ?? {},
      idleCollapseMinutes: state.prefs.idleCollapseMinutes === undefined
        ? DEFAULT_BOARD_IDLE_COLLAPSE_MINUTES
        : state.prefs.idleCollapseMinutes,
    },
  };
}

/* ---- SQLite storage (#1870) -------------------------------------------------
   The board is one `board` collection in the `state.sqlite` beside `filePath`,
   with one row per project keyed `p:<project>`: an edit rewrites that project's
   ~40 KB instead of the whole 2.5 MB file, and a project nobody touched keeps
   the bytes it was stored with. `board.json` itself is imported once and then
   replaced by a tombstone directory (src/lib/state/legacyImport.ts). */

const BOARD_COLLECTION = "board";
const BOARD_BUSY = "board state is busy";

/** A stored row. The project name lives beside the document because the board
    document itself never carried it, and the row key is derived from it. */
type BoardRow = { project: string; state: BoardProjectStateV1 };

function projectRowKey(project: string): string {
  return project ? `p:${project}` : "";
}

function boardRowKey(row: BoardRow): string {
  return projectRowKey(row.project);
}

function isBoardRow(value: unknown): value is BoardRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<BoardRow>;
  return typeof row.project === "string" && row.project.length > 0 && projectState(row.state);
}

/* The shared import reader opens read-only with `busy_timeout = 0` and runs
   its SELECT once (sqliteStateStore.ts), so a writer holding the file lock
   makes the import-marker probe below raise SQLITE_BUSY on the first touch of
   the board in a process. The board.json store queued on its own write lock
   and never dropped that write, so the probe retries on the same bounded
   schedule the collection's own writes use, in application code, with the
   connection's timeout left at zero. */
const BOARD_BUSY_ATTEMPTS = 6_000;
const BOARD_BUSY_WAIT_MS = 5;
const BOARD_BUSY_SLEEP = new Int32Array(new SharedArrayBuffer(4));
let boardBusyAttemptsForTests: number | null = null;

/** Test seam: bounds the probe's retry so a lock nobody releases fails fast. */
export function setBoardBusyRetryForTests(attempts: number | null): void {
  boardBusyAttemptsForTests = attempts;
}

function isBusyError(error: unknown): boolean {
  return /database is (?:locked|busy)|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error));
}

function readBoardImportMarker(database: string): StateImportRecord | null {
  const attempts = boardBusyAttemptsForTests ?? BOARD_BUSY_ATTEMPTS;
  let busy: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return readStateImport(database, BOARD_COLLECTION);
    } catch (error) {
      if (!isBusyError(error)) throw error;
      busy = error;
      Atomics.wait(BOARD_BUSY_SLEEP, 0, 0, BOARD_BUSY_WAIT_MS);
    }
  }
  throw new BoardStoreError(BOARD_BUSY, { cause: busy });
}

const boardCollections = new Map<string, SqliteStateCollection<BoardRow>>();

function openBoardCollection(database: string): SqliteStateCollection<BoardRow> {
  const held = boardCollections.get(database);
  if (held) return held;
  const collection = new SqliteStateCollection<BoardRow>(database, {
    collection: BOARD_COLLECTION,
    schemaVersion: 1,
    busyMessage: BOARD_BUSY,
    key: boardRowKey,
    decode: (value) => isBoardRow(value) ? value : null,
    clone: (row) => structuredClone(row),
    strictDecode: true,
    decodeError: (error) => new BoardStoreError("invalid board project state", { cause: error }),
  });
  boardCollections.set(database, collection);
  return collection;
}

/* A rollback mirror names the SQLite revision it was written from in a reserved
   project entry. An older release reads the mirror into `{ projects }` and
   writes every entry back, unknown ones included, so a file that still holds
   the marker of the recorded mirror descends from it and its missing projects
   are deletions. A file without it (an old writer that found the path empty
   while an import or a mirror was mid-retire) proves nothing about what it
   lacks. The key cannot collide with a project key, which is a path or a
   remote id, and the marker never becomes a board row. */
const MIRROR_MARKER_PROJECT = " sqlite-mirror-revision";

function mirrorMarkerState(revision: number): BoardProjectStateV1 {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: new Date(0).toISOString(),
    pathAliases: {},
    prefs: { manual: [], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false },
  };
}

type LegacyBoardBody = { projects: Record<string, BoardProjectStateV1>; mirrorOf: number | null };

/** Validate a legacy-shaped body. Throwing refuses the import and leaves the
    file untouched, which is what the JSON store did with an unusable board. */
function parseLegacyBoard(raw: unknown): LegacyBoardBody {
  if (raw === undefined) return { projects: {}, mirrorOf: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BoardStoreError("invalid board state");
  const stored = (raw as Partial<BoardFileV1>).projects;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new BoardStoreError("invalid board state");
  const { [MIRROR_MARKER_PROJECT]: marker, ...projects } = stored as Record<string, unknown>;
  if (!Object.values(projects).every(projectState)) throw new BoardStoreError("invalid board project state");
  return {
    projects: projects as Record<string, BoardProjectStateV1>,
    mirrorOf: projectState(marker) && Number.isInteger(marker.revision) ? marker.revision : null,
  };
}

function boardRows(projects: Record<string, BoardProjectStateV1>): BoardRow[] {
  return Object.entries(projects).map(([project, state]) => ({ project, state }));
}

function fileFromRows(rows: readonly BoardRow[]): BoardFileV1 {
  return { projects: Object.fromEntries(rows.map((row) => [row.project, normalizedProject(row.state)])) };
}

/** Merge a `board.json` that changed after the import (a rollback release wrote
    it, or an older writer raced a fence). Who changed a project is read from
    row revisions: a SQLite row not rewritten since `baseline` is the one the
    file was written from, so the file's project wins and its absence deletes
    it. A row SQLite rewrote since then stays unless the file holds a strictly
    higher board revision for it; either way it is listed as a conflict. A
    project only the file holds is added. A file that does not carry the
    recorded mirror's marker deletes nothing: its missing projects are spared. */
function mergeLegacyBoard(filePath: string, body: LegacyBoardBody, baseline: StateImportRecord, options: { fenceOwner: boolean }): LegacyReconcileSummary {
  const collection = openBoardCollection(legacyDatabasePath(filePath));
  const since = legacyBaselineRevision(baseline);
  const descends = baseline.mirrorRevision !== null && body.mirrorOf === baseline.mirrorRevision;
  const summary: LegacyReconcileSummary = { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
  collection.patchSync(() => {
    const current = new Map(collection.snapshot().map((row) => [boardRowKey(row), row] as const));
    const revisions = collection.rowRevisions();
    const incoming = boardRows(body.projects);
    const incomingKeys = new Set(incoming.map(boardRowKey));
    const records: BoardRow[] = [];
    for (const row of incoming) {
      const key = boardRowKey(row);
      const held = current.get(key);
      if (!held) {
        records.push(row);
        summary.added += 1;
        summary.keys.push(key);
        continue;
      }
      if (JSON.stringify(held) === JSON.stringify(row)) continue;
      if ((revisions.get(key) ?? 0) > since) {
        summary.conflicts.push(key);
        if (row.state.revision <= held.state.revision) {
          summary.kept += 1;
          continue;
        }
      }
      records.push(row);
      summary.replaced += 1;
      summary.keys.push(key);
    }
    const deleteKeys: string[] = [];
    for (const key of current.keys()) {
      if (incomingKeys.has(key)) continue;
      if (!descends) {
        summary.spared.push(key);
        continue;
      }
      if ((revisions.get(key) ?? 0) > since) {
        summary.conflicts.push(key);
        summary.kept += 1;
        continue;
      }
      deleteKeys.push(key);
      summary.removed += 1;
      summary.keys.push(key);
    }
    return { records, deleteKeys };
  }, { fenceOwner: options.fenceOwner });
  return summary;
}

/** The board store's legacy import spec, for the import driver and its tests. */
export function boardLegacyCollection(filePath = boardFileForTests ?? BOARD_FILE): LegacyCollectionSpec<LegacyBoardBody> {
  return {
    collection: BOARD_COLLECTION,
    schemaVersion: 1,
    migrationId: "board-json-v1",
    legacyPath: filePath,
    parse: parseLegacyBoard,
    toRows: (body): StateImportRow[] => boardRows(body.projects)
      .map((row) => ({ key: boardRowKey(row), value: row, controllerActive: true })),
    reconcile: (body, baseline, options) => mergeLegacyBoard(filePath, body, baseline, options),
    mirrorBody: () => {
      const collection = openBoardCollection(legacyDatabasePath(filePath));
      let mirror: { body: unknown; revision: number } | null = null;
      collection.checkpointMirror((rows, revision) => {
        mirror = {
          body: {
            projects: {
              ...Object.fromEntries(rows.map((row) => [row.project, row.state])),
              [MIRROR_MARKER_PROJECT]: mirrorMarkerState(revision),
            },
          },
          revision,
        };
      });
      return mirror!;
    },
  };
}

/** Import `board.json` into SQLite now. The Viewer's activation calls this with
    `reconcile: true`; tests drive the crash seams through `hooks`. */
export function importLegacyBoard(
  filePath = boardFileForTests ?? BOARD_FILE,
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return importLegacyCollection(boardLegacyCollection(filePath), options);
}

/** Write `board.json` from SQLite for a rollback release that predates #1870. */
export function checkpointBoardRollbackMirrorForDemotion(filePath = boardFileForTests ?? BOARD_FILE): void {
  writeLegacyRollbackMirror(boardLegacyCollection(filePath));
}

/* The store has always reported every failure as a `BoardStoreError`, and the
   board route answers 500 for it and nothing else. A collection that is busy,
   or a release that may not import yet, keeps that contract. */
function asBoardStoreError<R>(operation: () => R): R {
  try {
    return operation();
  } catch (error) {
    if (error instanceof BoardStoreError) throw error;
    if (error instanceof FileTransactionBusyError) throw new BoardStoreError(error.message, { cause: error });
    /* A SQLITE_BUSY that escaped the collection is that same failure wearing
       another class: the board route answers the store's documented error for
       it, never a raw SQLiteError the caller cannot classify. */
    if (isBusyError(error)) throw new BoardStoreError(BOARD_BUSY, { cause: error });
    throw error;
  }
}

/** The collection for `filePath`, importing the legacy file on first use. Null
    only for a read before the import may run (an unpromoted release): the read
    then parses the legacy file without writing anything. */
function boardCollection(filePath: string, purpose: "read" | "write"): SqliteStateCollection<BoardRow> | null {
  const database = legacyDatabasePath(filePath);
  if (boardCollections.has(database)) return boardCollections.get(database)!;
  if (!readBoardImportMarker(database)) {
    if (!legacyImportAllowed(filePath)) {
      if (purpose === "read") return null;
      throw new BoardStoreError("board state is waiting for release promotion");
    }
    importLegacyBoard(filePath, { reconcile: lazyReconcileAllowed(filePath) });
  }
  return openBoardCollection(database);
}

/** The legacy file as the board, for a release that may not import yet. */
function readLegacyBoardFile(filePath: string): BoardFileV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    throw new BoardStoreError();
  }
  return fileFromRows(boardRows(parseLegacyBoard(raw).projects));
}

/* Test seam around the two points a competing writer can arrive at: before the
   collection lease is taken (a call that started against an older board), and
   while it is held (a writer killed mid-write, #1870 failure matrix case (a)). */
export type BoardWritePhase = "before-lease" | "in-lease";
let writeHookForTests: ((phase: BoardWritePhase) => void) | null = null;
export function setBoardWriteHookForTests(hook: ((phase: BoardWritePhase) => void) | null): void {
  writeHookForTests = hook;
}

/** One serialized read-modify-write over the board. The prepare step reads the
    committed projects under the collection lease and names the projects it
    changed and the ones it folded away; only those rows are written. */
function writeBoardState<R>(
  filePath: string,
  prepare: (file: BoardFileV1) => { changed?: Record<string, BoardProjectStateV1>; deleted?: readonly string[]; result: R },
): R {
  return asBoardStoreError(() => {
    const collection = boardCollection(filePath, "write")!;
    writeHookForTests?.("before-lease");
    let result: R;
    collection.patchSync(() => {
      writeHookForTests?.("in-lease");
      const outcome = prepare(fileFromRows(collection.snapshot()));
      result = outcome.result;
      return {
        records: boardRows(outcome.changed ?? {}),
        deleteKeys: (outcome.deleted ?? []).map(projectRowKey),
      };
    });
    return result!;
  });
}

export function boardFor(project: string, filePath = boardFileForTests ?? BOARD_FILE): BoardProjectStateV1 {
  return asBoardStoreError(() => {
    const canonical = canonicalProject(project);
    const collection = boardCollection(filePath, "read");
    if (!collection) return readLegacyBoardFile(filePath).projects[canonical] ?? emptyBoard();
    const row = collection.get(projectRowKey(canonical));
    return row ? normalizedProject(row.state) : emptyBoard();
  });
}
export type BoardPatch = Partial<BoardProjectStateV1["prefs"]>;
/* `applied` distinguishes a write that committed from one the reducer turned
   into a no-op. A no-op is accepted from ANY base revision, so an accepted
   response can carry a board a DIFFERENT writer produced — and when both writers
   made the same change the two boards are indistinguishable by content. Only the
   server knows which happened, so it says so, and the client uses it to decide
   whether the response is its own work or a foreign adoption (#38). */
type BoardWriteResult =
  | { ok: true; applied: boolean; board: BoardProjectStateV1 }
  | { ok: false; board: BoardProjectStateV1 };

function applyLegacyPatch(current: BoardProjectStateV1, patch: BoardPatch): BoardProjectStateV1 {
  const hidden = patch.hidden === undefined
    ? current.prefs.hidden
    : [...new Set([...current.prefs.hidden, ...patch.hidden])];
  return applyBoardMutations({
    ...current,
    explicitManual: patch.manual === undefined ? current.explicitManual : patch.manual,
    prefs: { ...current.prefs, ...patch, hidden },
  }, []);
}

function sameReduced(left: BoardProjectStateV1, right: BoardProjectStateV1): boolean {
  return JSON.stringify({ prefs: left.prefs, pathAliases: left.pathAliases ?? {}, explicitManual: left.explicitManual ?? [] })
    === JSON.stringify({ prefs: right.prefs, pathAliases: right.pathAliases ?? {}, explicitManual: right.explicitManual ?? [] });
}

function writeReduced(project: string, baseRevision: number, reduce: (current: BoardProjectStateV1) => BoardProjectStateV1, filePath: string): BoardWriteResult {
  return writeBoardState<BoardWriteResult>(filePath, (value) => {
    const current = value.projects[project] ?? emptyBoard();
    const reduced = reduce(current);
    if (sameReduced(current, reduced)) return { result: { ok: true, applied: false, board: current } };
    if (current.revision !== baseRevision) return { result: { ok: false, board: current } };
    const next = committed(current, reduced, current.revision + 1);
    return { changed: { [project]: next }, result: { ok: true, applied: true, board: next } };
  });
}

function writeLatest(project: string, reduce: (current: BoardProjectStateV1) => BoardProjectStateV1, filePath: string): BoardProjectStateV1 {
  return writeBoardState(filePath, (value) => {
    const current = value.projects[project] ?? emptyBoard();
    const reduced = reduce(current);
    if (sameReduced(current, reduced)) return { result: current };
    const next = committed(current, reduced, current.revision + 1);
    return { changed: { [project]: next }, result: next };
  });
}

export function patchBoard(project: string, baseRevision: number, patch: BoardPatch, filePath = boardFileForTests ?? BOARD_FILE): BoardWriteResult {
  return writeReduced(canonicalProject(project), baseRevision, (current) => applyLegacyPatch(current, patch), filePath);
}

export function mutateBoard(project: string, baseRevision: number, mutations: readonly BoardMutationV1[], filePath = boardFileForTests ?? BOARD_FILE): BoardWriteResult {
  return writeReduced(canonicalProject(project), baseRevision, (current) => applyBoardMutations(current, mutations), filePath);
}

export function remapBoardPaths(
  project: string,
  pairs: Extract<BoardMutationV1, { kind: "remap-paths" }>["pairs"],
  options: { provisionalManual?: readonly string[]; targetPlacementAuthoritative?: boolean; filePath?: string } = {},
): BoardProjectStateV1 {
  const filePath = options.filePath ?? boardFileForTests ?? BOARD_FILE;
  return writeLatest(canonicalProject(project), (current) => {
    if (pairs.length === 0 || pairs.every(({ from, to }) => current.pathAliases?.[from] === to)) return current;
    const provisionalManual = options.provisionalManual?.filter((pathname) => (
      current.pathAliases?.[pathname] === undefined && current.prefs.manual.includes(pathname)
    )) ?? [];
    const mutations: BoardMutationV1[] = [];
    if (provisionalManual.length) {
      mutations.push({ kind: "reconcile-roots", roots: [], removeManual: provisionalManual });
    }
    mutations.push({ kind: "remap-paths", pairs, targetPlacementAuthoritative: options.targetPlacementAuthoritative });
    return applyBoardMutations(current, mutations);
  }, filePath);
}

export function transferBoardPathPlacements(
  transfers: readonly { fromProject: string; toProject: string; paths: readonly string[] }[],
  filePath = boardFileForTests ?? BOARD_FILE,
): void {
  if (transfers.length === 0) return;
  writeBoardState(filePath, (value) => {
    const changed: Record<string, BoardProjectStateV1> = {};
    for (const transfer of transfers) {
      if (transfer.fromProject === transfer.toProject) continue;
      const storedSource = changed[transfer.fromProject] ?? value.projects[transfer.fromProject];
      if (!storedSource) continue;
      let source = applyBoardMutations(storedSource, []);
      const storedTarget = changed[transfer.toProject] ?? value.projects[transfer.toProject] ?? emptyBoard();
      let target = applyBoardMutations(storedTarget, []);
      for (const pathname of [...new Set(transfer.paths)]) {
        const sourceAliasEntries = Object.entries(source.pathAliases ?? {}).filter(([, targetPath]) => targetPath === pathname);
        if (sourceAliasEntries.length > 0) {
          target = applyBoardMutations({
            ...target,
            pathAliases: {
              ...(target.pathAliases ?? {}),
              ...Object.fromEntries(sourceAliasEntries),
            },
          }, []);
        }
        const sourceHasMembership = source.prefs.hidden.includes(pathname)
          || source.prefs.expanded.includes(pathname)
          || source.prefs.manual.includes(pathname);
        if (!sourceHasMembership && sourceAliasEntries.length === 0) continue;
        const sourcePlacement = source.prefs.hidden.includes(pathname)
          ? "hidden"
          : source.prefs.expanded.includes(pathname)
            ? "expanded"
            : source.prefs.manual.includes(pathname)
              ? "manual"
              : "auto";
        const destinationPlacement = target.prefs.hidden.includes(pathname)
          ? "hidden"
          : target.prefs.expanded.includes(pathname)
            ? "expanded"
            : target.prefs.manual.includes(pathname)
              ? "manual"
              : "auto";
        const placement = sourcePlacement === "hidden" || destinationPlacement === "hidden"
          ? "hidden"
          : destinationPlacement !== "auto"
            ? destinationPlacement
            : sourcePlacement;
        const explicitManual = (source.explicitManual ?? []).includes(pathname)
          || (target.explicitManual ?? []).includes(pathname);
        source = {
          ...source,
          explicitManual: (source.explicitManual ?? []).filter((item) => item !== pathname),
          pathAliases: Object.fromEntries(
            Object.entries(source.pathAliases ?? {}).filter(([, targetPath]) => targetPath !== pathname),
          ),
          prefs: {
            ...source.prefs,
            manual: source.prefs.manual.filter((item) => item !== pathname),
            hidden: source.prefs.hidden.filter((item) => item !== pathname),
            expanded: source.prefs.expanded.filter((item) => item !== pathname),
          },
        };
        const targetPrefs = {
          ...target.prefs,
          manual: target.prefs.manual.filter((item) => item !== pathname),
          hidden: target.prefs.hidden.filter((item) => item !== pathname),
          expanded: target.prefs.expanded.filter((item) => item !== pathname),
        };
        target = {
          ...target,
          explicitManual: placement === "manual" && explicitManual
            ? [...(target.explicitManual ?? []).filter((item) => item !== pathname), pathname]
            : (target.explicitManual ?? []).filter((item) => item !== pathname),
          prefs: placement === "hidden"
            ? { ...targetPrefs, hidden: [...targetPrefs.hidden, pathname] }
            : placement === "expanded"
              ? { ...targetPrefs, expanded: [...targetPrefs.expanded, pathname] }
              : placement === "manual"
                ? { ...targetPrefs, manual: [...targetPrefs.manual, pathname] }
                : targetPrefs,
        };
      }
      if (!sameReduced(storedSource, source)) {
        changed[transfer.fromProject] = committed(storedSource, source, storedSource.revision + 1);
      }
      if (!sameReduced(storedTarget, target)) {
        changed[transfer.toProject] = committed(storedTarget, target, storedTarget.revision + 1);
      }
    }
    return { changed, result: undefined };
  });
}

function mergedBoards(states: readonly BoardProjectStateV1[]): BoardProjectStateV1 {
  const ordered = states
    .map((state, index) => ({ state, index, timestamp: Date.parse(state.updatedAt) }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : 0;
      const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : 0;
      return leftTime - rightTime || left.index - right.index;
    })
    .map(({ state }) => state);
  const aliases = ordered.reduce<Record<string, string>>(
    (combined, state) => ({ ...combined, ...(state.pathAliases ?? {}) }),
    {},
  );
  const roles = new Map<string, "manual" | "hidden" | "expanded">();
  let viewMode: BoardProjectStateV1["prefs"]["viewMode"] = null;
  let desktopBoard: BoardProjectStateV1["prefs"]["desktopBoard"] = null;
  let taskPanelOpen = false;
  let normalizedAliases: Record<string, string> = aliases;
  for (const state of ordered) {
    const normalized = applyBoardMutations({ ...state, pathAliases: aliases }, []);
    normalizedAliases = normalized.pathAliases ?? {};
    for (const role of ["manual", "hidden", "expanded"] as const) {
      for (const pathname of normalized.prefs[role]) {
        roles.delete(pathname);
        roles.set(pathname, role);
      }
    }
    viewMode = normalized.prefs.viewMode;
    desktopBoard = normalized.prefs.desktopBoard ?? null;
    taskPanelOpen = normalized.prefs.taskPanelOpen;
  }
  const prefs = {
    manual: [] as string[],
    hidden: [] as string[],
    expanded: [] as string[],
    /* Durable-id favorites union across the merged project states — they carry
       no path role, so they merge independently of the manual/hidden/expanded
       reconciliation. */
    favorites: [...new Set(ordered.flatMap((state) => state.prefs.favorites ?? []))],
    /* Identity-keyed tray intent unions independently of the path-role
       reconciliation, exactly like favorites (issue #142 S2). */
    foldedEngineChildIds: [...new Set(ordered.flatMap((state) => state.prefs.foldedEngineChildIds ?? []))],
    expandedEngineTrayParentIds: [...new Set(ordered.flatMap((state) => state.prefs.expandedEngineTrayParentIds ?? []))],
    /* Acknowledgements merge by MAXIMUM (issue #1244): two projects folding
       together must not un-see an outcome one of them had already seen. */
    seenAt: mergeSeenAt(ordered.map((state) => state.prefs.seenAt)),
    viewMode,
    ...(desktopBoard ? { desktopBoard } : {}),
    taskPanelOpen,
  };
  for (const [pathname, role] of roles) prefs[role].push(pathname);
  const manualSet = new Set(prefs.manual);
  const explicitManual = [...new Set(ordered.flatMap((state) => state.explicitManual ?? []))]
    .map((pathname) => normalizedAliases[pathname] ?? pathname)
    .filter((pathname) => manualSet.has(pathname));
  return { ...ordered.at(-1)!, pathAliases: normalizedAliases, explicitManual, prefs };
}

/** Group a catalog's migrations by the project each source finally lands on.

    The catalog hands this store chains: `migrationPlan` stops walking one at
    an intermediate that has conversations of its own, and durable alias
    candidates are merged into the same map afterwards, so a single call can
    carry both `A -> B` and `B -> C`. Every source has to reach the END of its
    chain before the groups are formed. Folding group by group over a snapshot
    that never sees the earlier groups' edits strands A's placements on a
    project the catalog just migrated away from, and it can name B in the same
    patch as both a written row and a deleted one, which the collection rejects
    outright. Resolving first also makes the outcome independent of the map's
    iteration order.

    A cycle names no final target, so its members — and anything whose chain
    runs into it — are left intact and the call reports incomplete, which is
    the store's standing answer when a fold cannot preserve its invariants. */
function resolvedMigrations(migrations: ReadonlyMap<string, string>): {
  sourcesByTarget: Map<string, string[]>;
  complete: boolean;
} {
  const moves = new Map([...migrations].filter(([source, target]) => source !== target));
  const sourcesByTarget = new Map<string, string[]>();
  let complete = true;
  for (const source of moves.keys()) {
    let target = moves.get(source)!;
    const seen = new Set([source]);
    while (moves.has(target) && !seen.has(target)) {
      seen.add(target);
      target = moves.get(target)!;
    }
    if (moves.has(target)) {
      complete = false;
      continue;
    }
    sourcesByTarget.set(target, [...(sourcesByTarget.get(target) ?? []), source]);
  }
  return { sourcesByTarget, complete };
}

/** Move durable board preferences along with catalog project-key repairs.
    Sources remain intact whenever a merge cannot preserve board invariants. */
export function migrateBoardProjects(
  migrations: ReadonlyMap<string, string>,
  /* Resolved per call, not from {@link BOARD_FILE}: the scanner runs in
     processes that settle their state directory after this module loads. */
  filePath = boardFileForTests ?? statePath("board.json"),
): boolean {
  if (migrations.size === 0) return true;
  const plan = resolvedMigrations(migrations);
  return writeBoardState(filePath, (value) => {
    const changed: Record<string, BoardProjectStateV1> = {};
    const deleted: string[] = [];
    let complete = plan.complete;
    for (const [targetProject, sourceProjects] of plan.sourcesByTarget) {
      const present = sourceProjects.filter((project) => value.projects[project]);
      const sources = present.map((project) => value.projects[project]!);
      if (sources.length === 0) continue;
      const target = value.projects[targetProject];
      if (!target && sources.length === 1) {
        changed[targetProject] = sources[0]!;
        deleted.push(...present);
        continue;
      }
      try {
        const states = target ? [target, ...sources] : sources;
        const merged = mergedBoards(states);
        /* The sources' causal history comes along. A migrated key is the SAME
           logical key, so dropping the clocks of the boards being folded in
           rewinds those keys past writes that really happened and un-fences
           intent formed before them. Merged by maximum, so the unified board is
           never behind any contributor. Note this can differ from the target
           even when the CONTENT is identical, which is exactly the case that was
           silently losing history. */
        const next = committed(
          target ?? emptyBoard(),
          merged,
          Math.max(...states.map((state) => state.revision)) + 1,
          sources,
        );
        if (!(target && sameReduced(target, next) && sameCausalHistory(target, next))) changed[targetProject] = next;
        deleted.push(...present);
      } catch {
        complete = false;
        continue;
      }
    }
    return { changed, deleted, result: complete };
  });
}
