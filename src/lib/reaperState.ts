import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { KeyedRows, type KeyedRowsView } from "@/lib/state/keyedRows";
import type { DocumentRow } from "@/lib/state/legacyDocumentStore";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { smallStore } from "@/lib/state/smallStore";

/*
 * The reaper's durable authorship evidence (#112, #125), in `state.sqlite`,
 * collection `reaper` (#1870 slice 8), imported once from `reaper-state.json`.
 *
 *   p:<transcript path>   { authored?: true, scannedAt?: <mtime seconds> }
 *
 * `authored` is sticky: a genuine owner message was seen in that transcript.
 * `scannedAt` is the path-scoped freshness stamp: the transcript mtime the
 * reaper observed when it last scanned the path to completion and found no
 * owner message. The legacy file kept the two as separate maps
 * (`userAuthoredPaths`, `scannedAt`) beside an always-empty
 * `firstObservedAt`; the rollback mirror writes that shape back.
 *
 * The file was rewritten whole on every reaper cycle (3 MB on a busy
 * installation). A cycle now writes the paths whose evidence changed, in one
 * transaction, and nothing when none did. The files projection keys on the
 * collection revision.
 */

export const REAPER_STATE_COLLECTION = "reaper";
export const REAPER_STATE_FILE_NAME = "reaper-state.json";
const PATH_PREFIX = "p:";

export function reaperStatePath(): string {
  return statePath(REAPER_STATE_FILE_NAME);
}

interface PathEvidence {
  authored?: true;
  scannedAt?: number;
}

export interface ReaperStateDocument {
  userAuthoredPaths: Record<string, true>;
  scannedAt: Record<string, number>;
}

/** What the reaper and the board ask of the evidence. */
export interface ReaperEvidence {
  authored(pathname: string): boolean;
  scannedAt(pathname: string): number | undefined;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function evidenceOf(value: unknown): PathEvidence {
  const raw = plainObject(value);
  const evidence: PathEvidence = {};
  if (raw?.authored === true) evidence.authored = true;
  if (typeof raw?.scannedAt === "number" && Number.isFinite(raw.scannedAt)) evidence.scannedAt = raw.scannedAt;
  return evidence;
}

/** The legacy file as the board read it: `userAuthoredPaths` and `scannedAt`
    each count only as a plain object, and a stamp only as a finite number. A
    file that is neither yields no evidence, which fails closed. */
function normalizeReaperState(value: unknown): ReaperStateDocument {
  const raw = plainObject(value);
  const authored = plainObject(raw?.userAuthoredPaths);
  const scanned = plainObject(raw?.scannedAt);
  const document: ReaperStateDocument = { userAuthoredPaths: {}, scannedAt: {} };
  for (const pathname of Object.keys(authored ?? {})) document.userAuthoredPaths[pathname] = true;
  for (const [pathname, stamp] of Object.entries(scanned ?? {})) {
    if (typeof stamp === "number" && Number.isFinite(stamp)) document.scannedAt[pathname] = stamp;
  }
  return document;
}

function reaperRows(document: ReaperStateDocument): DocumentRow[] {
  const paths = new Map<string, PathEvidence>();
  for (const pathname of Object.keys(document.userAuthoredPaths)) paths.set(pathname, { authored: true });
  for (const [pathname, stamp] of Object.entries(document.scannedAt)) paths.set(pathname, { ...paths.get(pathname), scannedAt: stamp });
  return [...paths].map(([pathname, evidence]) => ({ key: `${PATH_PREFIX}${pathname}`, value: evidence }));
}

function reaperDocument(rows: Iterable<readonly [string, PathEvidence]>): ReaperStateDocument {
  const document: ReaperStateDocument = { userAuthoredPaths: {}, scannedAt: {} };
  for (const [pathname, evidence] of rows) {
    if (evidence.authored) document.userAuthoredPaths[pathname] = true;
    if (evidence.scannedAt !== undefined) document.scannedAt[pathname] = evidence.scannedAt;
  }
  return document;
}

/** Import, reconcile and the rollback mirror. A path both sides hold merges:
    authorship stays sticky and the later stamp wins. */
export const reaperStateDocumentStore = smallStore<ReaperStateDocument>({
  collection: REAPER_STATE_COLLECTION,
  empty: () => ({ userAuthoredPaths: {}, scannedAt: {} }),
  parse: normalizeReaperState,
  toRows: reaperRows,
  fromRows: (rows) => reaperDocument(rows.flatMap((row) => row.key.startsWith(PATH_PREFIX)
    ? [[row.key.slice(PATH_PREFIX.length), evidenceOf(row.value)] as const] : [])),
  toFile: (document) => ({ version: 1, firstObservedAt: {}, userAuthoredPaths: document.userAuthoredPaths, scannedAt: document.scannedAt }),
  mergeRow: (_key, held, incoming) => {
    const left = evidenceOf(held), right = evidenceOf(incoming);
    const stamps = [left.scannedAt, right.scannedAt].filter((stamp): stamp is number => stamp !== undefined);
    return stored({ authored: left.authored || right.authored ? true : undefined, scannedAt: stamps.length ? Math.max(...stamps) : undefined });
  },
});

/** The stored form: fields in one order, so an unchanged path compares equal. */
function stored(evidence: PathEvidence): PathEvidence {
  const value: PathEvidence = {};
  if (evidence.authored) value.authored = true;
  if (evidence.scannedAt !== undefined) value.scannedAt = evidence.scannedAt;
  return value;
}

/* Constructed on first use: this module can be reached while the state
   modules are still initializing (an import cycle through the registry). */
let keyedRows: KeyedRows<PathEvidence> | null = null;
const rows = (): KeyedRows<PathEvidence> => keyedRows ??= new KeyedRows<PathEvidence>({
  collection: REAPER_STATE_COLLECTION,
  prefixes: [PATH_PREFIX],
  busyMessage: "reaper state is busy",
  // The legacy file was replaced without an fsync; so is this commit (keyedRows.ts).
  durability: "process",
  decode: (_key, value) => evidenceOf(value),
  importLegacy: (filePath, options) => reaperStateDocumentStore.importLegacy(filePath, options),
});

/* ----------------------------------------------------------------- reads */

let legacyRead: { filePath: string; signature: string; document: ReaperStateDocument } | null = null;

function legacySignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : "missing";
  } catch {
    return null;
  }
}

/** The legacy file, before the import. Missing or unreadable is no evidence. */
function readLegacyReaperState(filePath: string): ReaperStateDocument {
  const signature = legacySignature(filePath);
  if (signature !== null && legacyRead?.filePath === filePath && legacyRead.signature === signature) return legacyRead.document;
  let document: ReaperStateDocument = { userAuthoredPaths: {}, scannedAt: {} };
  try {
    document = normalizeReaperState(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch { /* first run, a tombstone or an unreadable file */ }
  if (signature !== null) legacyRead = { filePath, signature, document };
  return document;
}

function evidenceView(): KeyedRowsView<PathEvidence> | null {
  return rows().view(legacyDatabasePath(reaperStatePath()));
}

/**
 * The evidence as committed now. Every path is loaded once per process and
 * then followed through the change log, so the board's per-file lookups and a
 * reaper cycle cost a map lookup each. A store that cannot be read yields no
 * evidence, which pins every worker as unverified (fail closed).
 */
export function readReaperEvidence(): ReaperEvidence {
  try {
    const view = evidenceView();
    if (view) {
      view.rows();
      return {
        authored: (pathname) => view.get(`${PATH_PREFIX}${pathname}`)?.authored === true,
        scannedAt: (pathname) => view.get(`${PATH_PREFIX}${pathname}`)?.scannedAt,
      };
    }
    const document = readLegacyReaperState(reaperStatePath());
    return {
      authored: (pathname) => Object.hasOwn(document.userAuthoredPaths, pathname),
      scannedAt: (pathname) => Object.hasOwn(document.scannedAt, pathname) ? document.scannedAt[pathname] : undefined,
    };
  } catch (error) {
    console.error("[reaper] authorship evidence unavailable", error instanceof Error ? error.message : String(error));
    return { authored: () => false, scannedAt: () => undefined };
  }
}

/** The whole evidence in the legacy file's two maps. */
export function readReaperStateDocument(): ReaperStateDocument {
  const view = evidenceView();
  if (!view) return readLegacyReaperState(reaperStatePath());
  return reaperDocument([...view.rows()].map(([key, evidence]) => [key.slice(PATH_PREFIX.length), evidence] as const));
}

/* ---------------------------------------------------------------- writes */

/**
 * Record what one cycle proved: transcripts now known to carry an owner
 * message, and clean scans with the mtime each observed. Writes only these
 * paths, merged with what is stored under the lease.
 */
export function recordReaperEvidence(update: { authored: readonly string[]; scanned: readonly (readonly [string, number])[] }): void {
  if (!update.authored.length && !update.scanned.length) return;
  rows().write(reaperStatePath(), (read) => {
    const next = new Map<string, PathEvidence>();
    const current = (pathname: string) => next.get(pathname) ?? evidenceOf(read(`${PATH_PREFIX}${pathname}`));
    for (const pathname of update.authored) next.set(pathname, { ...current(pathname), authored: true });
    for (const [pathname, stamp] of update.scanned) next.set(pathname, { ...current(pathname), scannedAt: stamp });
    return { records: [...next].map(([pathname, evidence]) => ({ key: `${PATH_PREFIX}${pathname}`, value: stored(evidence) })) };
  });
}

/* ------------------------------------------------------- import, rollback */

/** Import `reaper-state.json` now. The Viewer's activation calls this with
    `reconcile: true`. */
export function importLegacyReaperState(filePath = reaperStatePath(), options: { reconcile: boolean } = { reconcile: true }) {
  return reaperStateDocumentStore.importLegacy(filePath, options);
}

/** Write `reaper-state.json` from SQLite for a rollback release that
    predates the move. */
export function checkpointReaperStateRollbackMirrorForDemotion(filePath = reaperStatePath()): void {
  reaperStateDocumentStore.checkpointRollbackMirror(filePath);
}

/** Test seam: forget every held row, the way a restarted process would. */
export function resetReaperStateForTests(): void {
  rows().resetForTests();
  legacyRead = null;
}
