import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { FileTransactionBusyError, withFileTransactionSync } from "./fileTransaction";
import { hotStateSqliteWriterReady, hotStateWriterRevision, readHotStateReleaseTarget } from "./hotStateAuthority";
import {
  importStateCollection,
  readStateImport,
  recordStateImportMirror,
  type StateImportRecord,
  type StateImportRow,
} from "./sqliteStateStore";

/**
 * First-boot import of one legacy JSON store into `state.sqlite` (#1870,
 * docs/design/state-sqlite-migration.md §6.2). Every store that moves reuses
 * this helper; the store supplies how its file parses into rows and how a
 * changed legacy file merges back into its collection.
 */
export interface LegacyCollectionSpec<P> {
  collection: string;
  schemaVersion: number;
  migrationId: string;
  /** The legacy file. The database is `state.sqlite` beside it. */
  legacyPath: string;
  /** Validate parsed JSON. Throwing refuses the import and leaves the file untouched. */
  parse(raw: unknown): P;
  toRows(parsed: P): StateImportRow[];
  /** Fold a legacy file that changed after the import back into the collection.
      Runs under the legacy file lock; writes through the store's collection. */
  reconcile(parsed: P): LegacyReconcileSummary;
  /** The whole collection as the legacy file body, for a rollback mirror. */
  mirrorBody(): { body: unknown; revision: number };
}

export interface LegacyReconcileSummary {
  added: number;
  replaced: number;
  kept: number;
  keys: string[];
}

export interface StateIncident {
  kind: "legacy-unreadable" | "legacy-reconciled" | "tombstone-without-import";
  collection: string;
  message: string;
  preservedAs?: string;
  summary?: LegacyReconcileSummary;
  at: string;
}

export interface LegacyImportHooks {
  beforeVerify?: Parameters<typeof importStateCollection>[1]["beforeVerify"];
  afterCommit?: () => void;
  afterRename?: () => void;
}

export type LegacyImportOutcome =
  | { state: "imported"; record: StateImportRecord; incident: StateIncident | null }
  | { state: "already-imported"; record: StateImportRecord; incident: StateIncident | null }
  | { state: "reconcile-deferred"; record: StateImportRecord; incident: null };

export const TOMBSTONE_README = "README";
const incidents: StateIncident[] = [];

/** Incidents raised by this process's imports, newest last. The durable record
    is `state_imports.gap` and the preserved file beside the tombstone. */
export function stateImportIncidents(): readonly StateIncident[] {
  return incidents;
}

function raise(incident: Omit<StateIncident, "at">): StateIncident {
  const raised = { ...incident, at: new Date().toISOString() };
  incidents.push(raised);
  if (incidents.length > 100) incidents.splice(0, incidents.length - 100);
  console.error(`[state import] ${raised.kind} ${raised.collection}: ${raised.message}`);
  return raised;
}

export function legacyDatabasePath(legacyPath: string): string {
  return path.join(path.dirname(legacyPath), "state.sqlite");
}

/** Whether this process may import: the activated release, or any process
    when no release target exists (npm, source, tests). */
export function legacyImportAllowed(legacyPath: string): boolean {
  return hotStateSqliteWriterReady(path.dirname(legacyPath));
}

/** A reconcile renames the legacy file away. Only the activation of a release,
    or an install with no release target, may do that: under a rollback the
    older release is running on that file. */
export function lazyReconcileAllowed(legacyPath: string): boolean {
  return readHotStateReleaseTarget(path.dirname(legacyPath)) === null;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function releaseTag(legacyPath: string): string | null {
  try {
    return hotStateWriterRevision(path.dirname(legacyPath))?.slice(0, 12) ?? null;
  } catch {
    return null;
  }
}

function freeName(base: string): string {
  if (!fs.existsSync(base)) return base;
  return `${base}-${stamp()}`;
}

type LegacyRead =
  | { kind: "missing" }
  | { kind: "tombstone" }
  | { kind: "file"; bytes: Buffer };

function readLegacy(legacyPath: string): LegacyRead {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(legacyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new FileTransactionBusyError(`legacy state is unreadable for now: ${(error as Error).message}`);
  }
  if (stat.isDirectory()) return { kind: "tombstone" };
  try {
    return { kind: "file", bytes: fs.readFileSync(legacyPath) };
  } catch (error) {
    // EIO, EACCES and the like may be transient: retry later, never import empty.
    throw new FileTransactionBusyError(`legacy state is unreadable for now: ${(error as Error).message}`);
  }
}

/** Bytes that cannot be JSON at all: empty, NUL-filled or truncated. Valid JSON
    whose content fails validation is not a gap; that refuses the import. */
function parseJsonBytes(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

function writeTombstone<P>(spec: LegacyCollectionSpec<P>): void {
  const directory = path.dirname(spec.legacyPath);
  fs.mkdirSync(spec.legacyPath, { recursive: true, mode: 0o700 });
  const readme = path.join(spec.legacyPath, TOMBSTONE_README);
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      `${path.basename(spec.legacyPath)} moved into SQLite.`,
      `It now lives in the "${spec.collection}" collection of ${path.basename(legacyDatabasePath(spec.legacyPath))} in this directory.`,
      "This directory stands in its place so that an older release fails visibly instead of writing a file nothing reads.",
      "",
    ].join("\n"), { mode: 0o600 });
  }
  fsyncDirectory(directory);
}

/** Rename the legacy file to its kept copy, or delete it when it is only a
    rollback mirror of what SQLite already holds, then leave the tombstone. */
function retire<P>(spec: LegacyCollectionSpec<P>, mode: "keep" | "delete", hooks: LegacyImportHooks): string | null {
  let preservedAs: string | null = null;
  if (fs.existsSync(spec.legacyPath) && !fs.lstatSync(spec.legacyPath).isDirectory()) {
    if (mode === "delete") {
      fs.rmSync(spec.legacyPath, { force: true });
    } else {
      preservedAs = freeName(`${spec.legacyPath}.imported-${releaseTag(spec.legacyPath) ?? stamp()}`);
      fs.renameSync(spec.legacyPath, preservedAs);
    }
    fsyncDirectory(path.dirname(spec.legacyPath));
  }
  hooks.afterRename?.();
  writeTombstone(spec);
  return preservedAs;
}

function preserveUnreadable<P>(spec: LegacyCollectionSpec<P>): string {
  const preservedAs = freeName(`${spec.legacyPath}.unreadable-${stamp()}`);
  fs.renameSync(spec.legacyPath, preservedAs);
  fsyncDirectory(path.dirname(spec.legacyPath));
  return preservedAs;
}

/**
 * Import `spec.legacyPath` once, verified, then retire the file behind a
 * tombstone directory. Runs under the legacy store's own file lock, which
 * every legacy writer (old releases included) also takes, so no legacy write
 * can interleave with the import.
 */
export function importLegacyCollection<P>(
  spec: LegacyCollectionSpec<P>,
  options: { reconcile: boolean; hooks?: LegacyImportHooks },
): LegacyImportOutcome {
  const hooks = options.hooks ?? {};
  const database = legacyDatabasePath(spec.legacyPath);
  return withFileTransactionSync(spec.legacyPath, `${spec.collection} import is busy`, () => {
    const held = readStateImport(database, spec.collection);
    const legacy = readLegacy(spec.legacyPath);
    if (held) return finishImported(spec, held, legacy, options.reconcile, hooks);

    let rows: StateImportRow[] = [];
    let gap: string | null = null;
    let incident: StateIncident | null = null;
    let unreadable = false;
    if (legacy.kind === "tombstone") {
      gap = "tombstone-without-import";
      incident = raise({
        kind: "tombstone-without-import",
        collection: spec.collection,
        message: `${spec.legacyPath} is a tombstone but ${database} has no import record; starting empty`,
      });
    } else if (legacy.kind === "file") {
      const parsed = parseJsonBytes(legacy.bytes);
      if (parsed.ok) rows = spec.toRows(spec.parse(parsed.value));
      else {
        gap = "legacy-unreadable";
        unreadable = true;
      }
    }
    const { record } = importStateCollection(database, {
      collection: spec.collection,
      schemaVersion: spec.schemaVersion,
      migrationId: spec.migrationId,
      rows,
      sourceName: path.basename(spec.legacyPath),
      sourceSha256: legacy.kind === "file" ? sha256(legacy.bytes) : null,
      sourceBytes: legacy.kind === "file" ? legacy.bytes.length : 0,
      gap,
      release: releaseTag(spec.legacyPath),
      ...(hooks.beforeVerify ? { beforeVerify: hooks.beforeVerify } : {}),
    });
    hooks.afterCommit?.();
    if (unreadable) {
      const preservedAs = preserveUnreadable(spec);
      incident = raise({
        kind: "legacy-unreadable",
        collection: spec.collection,
        preservedAs,
        message: `${path.basename(spec.legacyPath)} could not be parsed (${legacy.kind === "file" ? legacy.bytes.length : 0} bytes); `
          + `the collection starts empty and the file is kept as ${path.basename(preservedAs)}. Restore from the newest backup to recover it.`,
      });
    }
    retire(spec, "keep", hooks);
    return { state: "imported", record, incident };
  });
}

function finishImported<P>(
  spec: LegacyCollectionSpec<P>,
  record: StateImportRecord,
  legacy: LegacyRead,
  reconcile: boolean,
  hooks: LegacyImportHooks,
): LegacyImportOutcome {
  if (legacy.kind === "tombstone") return { state: "already-imported", record, incident: null };
  if (legacy.kind === "missing") {
    // A crash between the rename and the tombstone.
    writeTombstone(spec);
    return { state: "already-imported", record, incident: null };
  }
  if (!reconcile) return { state: "reconcile-deferred", record, incident: null };
  const digest = sha256(legacy.bytes);
  if (digest === record.mirrorSha256) {
    retire(spec, "delete", hooks);
    return { state: "already-imported", record, incident: null };
  }
  if (digest === record.sourceSha256) {
    // A crash between COMMIT and the rename: the file is what was imported.
    if (record.gap === "legacy-unreadable") preserveUnreadable(spec);
    retire(spec, "keep", hooks);
    return { state: "already-imported", record, incident: null };
  }
  const parsed = parseJsonBytes(legacy.bytes);
  if (!parsed.ok) {
    const preservedAs = preserveUnreadable(spec);
    writeTombstone(spec);
    const incident = raise({
      kind: "legacy-unreadable",
      collection: spec.collection,
      preservedAs,
      message: `${path.basename(spec.legacyPath)} reappeared unreadable after the import; kept as ${path.basename(preservedAs)}, SQLite unchanged`,
    });
    return { state: "already-imported", record, incident };
  }
  const summary = spec.reconcile(spec.parse(parsed.value));
  const preservedAs = retire(spec, "keep", hooks);
  const incident = raise({
    kind: "legacy-reconciled",
    collection: spec.collection,
    summary,
    ...(preservedAs ? { preservedAs } : {}),
    message: `${path.basename(spec.legacyPath)} changed after the import (a rollback release or a racing writer); `
      + `merged ${summary.added} added and ${summary.replaced} replaced rows, kept ${summary.kept} SQLite rows`,
  });
  return { state: "already-imported", record, incident };
}

/**
 * Write the legacy file from one SQLite revision so a rollback release that
 * predates the move runs on its JSON (§6.4). The tombstone is removed and the
 * mirror's digest recorded, so the next activation can tell an untouched
 * mirror from one the rollback release changed.
 */
export function writeLegacyRollbackMirror<P>(spec: LegacyCollectionSpec<P>): void {
  const database = legacyDatabasePath(spec.legacyPath);
  if (!readStateImport(database, spec.collection)) return;
  withFileTransactionSync(spec.legacyPath, `${spec.collection} import is busy`, () => {
    const { body, revision } = spec.mirrorBody();
    const text = `${JSON.stringify(body, null, 2)}\n`;
    const directory = path.dirname(spec.legacyPath);
    const temp = path.join(directory, `.${path.basename(spec.legacyPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const descriptor = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, text, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      if (fs.existsSync(spec.legacyPath) && fs.lstatSync(spec.legacyPath).isDirectory()) {
        fs.rmSync(spec.legacyPath, { recursive: true, force: true });
      }
      fs.renameSync(temp, spec.legacyPath);
      fsyncDirectory(directory);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    recordStateImportMirror(database, spec.collection, sha256(Buffer.from(text, "utf8")), revision);
  });
}
