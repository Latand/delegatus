import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertStateStartupMutation, isOperatorOwnedDirectory, ownsStateStartupMutation } from "@/lib/stateOwnership";

import { FileTransactionBusyError, withFileTransactionSync } from "./fileTransaction";
import { assertStateMutationAllowed, stateMutationRefusal } from "./stateMutationBarrier";
import { hotStateSqliteWriterReady, hotStateWriterRevision, readHotStateReleaseTarget } from "./hotStateAuthority";
import {
  importStateCollection,
  readStateImport,
  recordStateImportMirror,
  reimportStateCollection,
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
  /** What `toRows` repaired in a file older code wrote (duplicates it
      dropped), or null. Reported as an incident; the digest covers the
      repaired rows. */
  repairs?(parsed: P): string | null;
  /** Fold a legacy file that changed after the import back into the collection.
      Runs under the legacy file lock; writes through the store's collection.
      `baseline` names the revision the file was last written from, so a row
      SQLite has not rewritten since is the file's to change or delete.
      `fenceOwner` admits the write during this release's own rollback fence. */
  reconcile(parsed: P, baseline: StateImportRecord, options: { fenceOwner: boolean }): LegacyReconcileSummary;
  /** The whole collection as the legacy file body, for a rollback mirror. */
  mirrorBody(): { body: unknown; revision: number };
}

export interface LegacyReconcileSummary {
  added: number;
  replaced: number;
  removed: number;
  kept: number;
  /** Rows the file added, replaced or removed. */
  keys: string[];
  /** Rows SQLite changed after the mirror that the file holds differently or
      dropped: SQLite kept them unless the file's row is strictly newer. */
  conflicts: string[];
  /** Rows the file lacks that stayed because the file does not carry the
      recorded mirror's marker, so its lack of them proves no deletion. */
  spared: string[];
}

export interface StateIncident {
  kind: "legacy-unreadable" | "legacy-reconciled" | "legacy-repaired" | "tombstone-without-import" | "stale-import-replaced";
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
  /** The recorded import was stale — the legacy file stood where the tombstone
      belongs and no rollback mirror ever put it there — so the collection was
      rebuilt from the file. Treated as a first import by every caller that
      settles siblings or records gaps. */
  | { state: "reimported"; record: StateImportRecord; incident: StateIncident | null }
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

/**
 * Whether this process may import on the lazy path a store read takes.
 *
 * Three questions, and all three have to answer yes (#1905). The barrier asks
 * whether this process may mutate state at all: never during a `next build`
 * phase, whatever else is true, and outside the serving Viewer's activation
 * only against a state directory the caller named. Ownership asks whether a
 * process that declares no owner is reaching the operator's own directories.
 * The hot-state writer asks whether this release is the one that may write —
 * or whether there is no release target at all (npm, source, tests).
 *
 * A read that lands here while any of them says no returns "the import has not
 * run" and falls back to the legacy file, which is what every reader did
 * before the store existed.
 */
export function legacyImportAllowed(legacyPath: string): boolean {
  const directory = path.dirname(legacyPath);
  if (stateMutationRefusal(directory) !== null) return false;
  if (!ownsStateStartupMutation() && isOperatorOwnedDirectory(directory)) return false;
  return hotStateSqliteWriterReady(directory);
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

/** The most recently written `<file>.imported-*` copy beside the legacy path. */
function newestKeptCopy(legacyPath: string): string | null {
  const prefix = `${path.basename(legacyPath)}.imported-`;
  const directory = path.dirname(legacyPath);
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(directory, name);
    try {
      const { mtimeMs } = fs.statSync(file);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    } catch {
      continue;
    }
  }
  return newest?.file ?? null;
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
  /* The first-boot import is the state-mutating startup step that #1905 was
     filed for: a lane's `next build` loaded a route module, the module reached
     a store, and this ran against the operator's live account files. Both
     gates apply, and the barrier goes first because its refusal holds for a
     process that IS an owner: inside the serving container `LLV_STATE_OWNER`
     is already set, so a `next build` run there would pass ownership while
     still being a module load that may never rename live state away. */
  assertStateMutationAllowed(path.dirname(spec.legacyPath));
  assertStateStartupMutation(path.dirname(spec.legacyPath), `${spec.collection} import`);
  return withFileTransactionSync(spec.legacyPath, `${spec.collection} import is busy`, () => {
    const held = readStateImport(database, spec.collection);
    const legacy = readLegacy(spec.legacyPath);
    if (held) return finishImported(spec, held, legacy, options.reconcile, hooks);

    let rows: StateImportRow[] = [];
    let gap: string | null = null;
    let incident: StateIncident | null = null;
    let unreadable = false;
    let repaired: string | null = null;
    if (legacy.kind === "tombstone") {
      gap = "tombstone-without-import";
      const kept = newestKeptCopy(spec.legacyPath);
      incident = raise({
        kind: "tombstone-without-import",
        collection: spec.collection,
        ...(kept ? { preservedAs: kept } : {}),
        message: `${spec.legacyPath} is a tombstone but ${database} has no import record; starting empty`
          + (kept ? `. The newest kept copy of the legacy file is ${path.basename(kept)}; restore the newest backup or re-import that copy.` : ""),
      });
    } else if (legacy.kind === "file") {
      const parsed = parseJsonBytes(legacy.bytes);
      if (parsed.ok) {
        const body = spec.parse(parsed.value);
        rows = spec.toRows(body);
        repaired = spec.repairs?.(body) ?? null;
      } else {
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
    if (repaired) {
      incident = raise({
        kind: "legacy-repaired",
        collection: spec.collection,
        message: `${path.basename(spec.legacyPath)} imported after a repair: ${repaired}`,
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
  if (strayImportRecord(spec.legacyPath, record)) {
    return replaceStaleImport(spec, record, legacy.bytes, hooks);
  }
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
  const incident = reconcileChangedLegacy(spec, record, legacy.bytes, { fenceOwner: false }, hooks);
  writeTombstone(spec);
  return { state: "already-imported", record, incident };
}

/**
 * Whether a recorded import was written by a process that did not own the
 * release, so neither the record nor the rows behind it are evidence that the
 * move happened.
 *
 * #1905: a lane's `next build` imported production's account files. It reached
 * `hotStateSqliteWriterReady` through the branch that admits an unidentified
 * local client — no `PORT`, no release revision — which is the same branch
 * that leaves {@link releaseTag} null. So a record that names NO release, in a
 * state directory that HAS a release target, was written by something that was
 * not the release. The legacy file still standing beside it is what the
 * release actually serving the machine has been reading and writing since, and
 * the rows are rebuilt from it rather than merged into: a merge would spare
 * every row the file no longer has, resurrecting state the operator deleted.
 *
 * A record that carries a rollback mirror is excluded whatever else is true:
 * that file is one this release wrote back on purpose, and §6.4's merge owns
 * it. So is any record made where no release target exists at all (an npm or
 * source install, a test), where a null release means only that nobody
 * deployed anything — and where an old writer that found the path empty may
 * have made a fresh file out of nothing, which must never delete a board.
 */
function strayImportRecord(legacyPath: string, record: StateImportRecord): boolean {
  if (record.release !== null) return false;
  if (record.mirrorSha256 !== null || record.mirrorRevision !== null) return false;
  try {
    return readHotStateReleaseTarget(path.dirname(legacyPath)) !== null;
  } catch {
    return false;
  }
}

/**
 * Rebuild the collection from a legacy file that outlived its own import
 * record, replacing the rows the stale record covers. The file is parsed and
 * verified before anything is deleted, so a file that no longer parses leaves
 * both the database and the file exactly as they were.
 */
function replaceStaleImport<P>(
  spec: LegacyCollectionSpec<P>,
  stale: StateImportRecord,
  bytes: Buffer,
  hooks: LegacyImportHooks,
): LegacyImportOutcome {
  const parsed = parseJsonBytes(bytes);
  if (!parsed.ok) {
    const preservedAs = preserveUnreadable(spec);
    const incident = raise({
      kind: "legacy-unreadable",
      collection: spec.collection,
      preservedAs,
      message: `${path.basename(spec.legacyPath)} stood beside a stale import record and could not be parsed; `
        + `kept as ${path.basename(preservedAs)}, the recorded import is unchanged`,
    });
    writeTombstone(spec);
    return { state: "already-imported", record: stale, incident };
  }
  const body = spec.parse(parsed.value);
  const rows = spec.toRows(body);
  const repaired = spec.repairs?.(body) ?? null;
  const { record } = reimportStateCollection(legacyDatabasePath(spec.legacyPath), {
    collection: spec.collection,
    schemaVersion: spec.schemaVersion,
    migrationId: spec.migrationId,
    rows,
    sourceName: path.basename(spec.legacyPath),
    sourceSha256: sha256(bytes),
    sourceBytes: bytes.length,
    gap: null,
    release: releaseTag(spec.legacyPath),
    ...(hooks.beforeVerify ? { beforeVerify: hooks.beforeVerify } : {}),
  });
  hooks.afterCommit?.();
  const incident = raise({
    kind: "stale-import-replaced",
    collection: spec.collection,
    message: `${path.basename(spec.legacyPath)} was still a file beside an import recorded at ${stale.importedAt} `
      + `with no rollback mirror; re-imported ${record.rowCount} row(s) over the ${stale.rowCount} stale one(s)`
      + (repaired ? `; ${repaired}` : ""),
  });
  retire(spec, "keep", hooks);
  return { state: "reimported", record, incident };
}

/** The baseline revision a legacy file was last written from: its mirror, or
    the import itself when no mirror was ever written. */
export function legacyBaselineRevision(record: StateImportRecord): number {
  return record.mirrorRevision ?? (record.rowCount > 0 ? 1 : 0);
}

/** Merge a legacy file that differs from both the import source and the last
    mirror, keep it aside, and raise the incident. Leaves the path empty or
    holding the tombstone. */
function reconcileChangedLegacy<P>(
  spec: LegacyCollectionSpec<P>,
  record: StateImportRecord,
  bytes: Buffer,
  options: { fenceOwner: boolean },
  hooks: LegacyImportHooks,
): StateIncident {
  const parsed = parseJsonBytes(bytes);
  if (!parsed.ok) {
    const preservedAs = preserveUnreadable(spec);
    return raise({
      kind: "legacy-unreadable",
      collection: spec.collection,
      preservedAs,
      message: `${path.basename(spec.legacyPath)} reappeared unreadable after the import; kept as ${path.basename(preservedAs)}, SQLite unchanged`,
    });
  }
  const body = spec.parse(parsed.value);
  const summary = spec.reconcile(body, record, options);
  const repaired = spec.repairs?.(body) ?? null;
  const preservedAs = retire(spec, "keep", hooks);
  return raise({
    kind: "legacy-reconciled",
    collection: spec.collection,
    summary,
    ...(preservedAs ? { preservedAs } : {}),
    message: `${path.basename(spec.legacyPath)} changed after the import (a rollback release or an older writer); `
      + `merged ${summary.added} added, ${summary.replaced} replaced and ${summary.removed} removed rows, `
      + `kept ${summary.kept} SQLite rows changed since the mirror`
      + (summary.spared.length
        ? `; the file does not carry the recorded mirror's marker, so no row was deleted (${summary.spared.length} rows it lacks were kept)`
        : "")
      + (repaired ? `; ${repaired}` : ""),
  });
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
  assertStateMutationAllowed(path.dirname(spec.legacyPath));
  withFileTransactionSync(spec.legacyPath, `${spec.collection} import is busy`, () => {
    /* A writable legacy file outlives a fence that was withdrawn, and an older
       release's MCP process may have written it since. Fold those writes in
       before the new mirror replaces the file. */
    const record = readStateImport(database, spec.collection)!;
    const legacy = readLegacy(spec.legacyPath);
    if (legacy.kind === "file") {
      const digest = sha256(legacy.bytes);
      if (digest !== record.mirrorSha256 && digest !== record.sourceSha256) {
        reconcileChangedLegacy(spec, record, legacy.bytes, { fenceOwner: true }, {});
      }
    }
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
