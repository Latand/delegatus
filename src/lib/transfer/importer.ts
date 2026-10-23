import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { memoryProfileCollection } from "@/lib/memory/profileStore";
import { curationCollection } from "@/lib/memory/curation/store";
import { refreshLessonKnownValues, roleMemoryCollection } from "@/lib/memory/roleStore";
import type { RoleMemoryRow } from "@/lib/memory/roleTypes";
import { projectIdentityFromDirectory, projectIdentityFromRepositoryRoot, repositoryRootForPath } from "@/lib/projects/identity";
import { fsyncPath } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { canonicalProject } from "@/lib/projects/aliases";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { assertStateStartupMutation } from "@/lib/stateOwnership";

import {
  accountCommitRows, accountReportRows, accountsReady, finishAccountCreation, importedAccountRows, initializeImportedAccountRows, planAccounts, releaseReservation,
  reserveAccounts, TRANSFER_ACCOUNTS_COLLECTION, transferAccountKey, validAccountRecord, type AccountTargetDeps, type ImportedAccountRow, type TransferEngine,
} from "./accounts";
import { decodeBundle, splitRecordKey } from "./bundle";
import { remapText, resolveAliasChain } from "./projectKeys";
import { planRoleMemory, scopeFigures, validRoleRecord } from "./roleMemory";
import { partById, PARTS, type MapPart, type Part, type RowsPart } from "./sections";
import {
  createFileExclusive, fileRevision, legacyStoreImported, readRegularFile, readTargetRows, readTargetText, targetFileKind, targetRoot, targetRowCommitted, writeFileAtomic,
  type StoredRow,
} from "./stores";
import {
  isSectionName,
  type AccountPlan, type BundleProject, type ConflictAction, type ConflictVersion, type DecodedBundle, type ProjectPlan, type RedoItem, type ScopeFigures,
  type SectionPlan, type SectionReport, type TransferImportRequest, type TransferPlan, type TransferReport,
} from "./types";

/* Import (docs/design/install-memory-transfer.md §4.5–§4.8). A dry run
   computes, per record, what apply would do against this install's current
   state and records each store's revision. Apply recomputes the same plan,
   refuses if any revision moved, checkpoints every file it will replace,
   writes the files, then commits every SQLite row and the import record in
   one transaction: that commit is the point of no return. Every exit before
   it leaves this install as it was. */

export class TransferImportError extends Error {
  constructor(readonly code: "not_staged" | "target_changed" | "bad_mapping" | "unknown_import" | "target_unreadable" | "recovery_unreadable", message: string) {
    super(message);
    this.name = "TransferImportError";
  }
}

export type TransferFault = "file-step" | "disk-full" | "sqlite" | "hang" | "die-after-reservations" | "die-after-checkpoint" | "die-before-link" | "die-after-files" | "die-after-commit" | "die-after-accounts";

/** Fault injection for the exit tests; read only under `bun test`. */
function injectedFault(): TransferFault | null {
  if (process.env.NODE_ENV !== "test") return null;
  const value = process.env.LLV_TRANSFER_TEST_FAULT ?? "";
  return (["file-step", "disk-full", "sqlite", "hang", "die-after-reservations", "die-after-checkpoint", "die-before-link", "die-after-files", "die-after-commit", "die-after-accounts"] as const).find(fault => fault === value) ?? null;
}

/** `disk-full`: once the first file is written, every write that allocates
    space fails as a full disk does, for the rest of the process, recovery
    included. Renames, links and removals still work, as they do on a full disk. */
let diskFull = false;
function allocate(): void {
  if (diskFull) throw Object.assign(new Error("ENOSPC: no space left on device (injected)"), { code: "ENOSPC" });
}
function writeAtomic(target: string, text: string, staging?: string): void {
  allocate();
  writeFileAtomic(target, text, staging);
}

/** `LLV_TRANSFER_TEST_SPLIT_ROOTS=1`: the state and config roots behave as two
    file systems, so a link or rename from one into the other fails as it does
    there (EXDEV). */
function crossesRoots(from: string, to: string): boolean {
  if (process.env.NODE_ENV !== "test" || process.env.LLV_TRANSFER_TEST_SPLIT_ROOTS !== "1") return false;
  const rootOf = (file: string) => {
    const state = stateDir();
    return file === state || file.startsWith(`${state}${path.sep}`) ? "state" : "config";
  };
  return rootOf(from) !== rootOf(to);
}
function crossDevice(): never {
  throw Object.assign(new Error("EXDEV: cross-device link not permitted (injected)"), { code: "EXDEV" });
}
function linkFile(from: string, to: string): void {
  if (crossesRoots(from, to)) crossDevice();
  fs.linkSync(from, to);
}
function moveFile(from: string, to: string): void {
  if (crossesRoots(from, to)) crossDevice();
  fs.renameSync(from, to);
}

/** `LLV_TRANSFER_TEST_READ_FAULT`: the recovery metadata read fails as an I/O error does. */
function readFault(what: "journal" | "imports" | "ledger"): void {
  if (process.env.NODE_ENV === "test" && process.env.LLV_TRANSFER_TEST_READ_FAULT === what) {
    throw Object.assign(new Error("EIO: i/o error (injected)"), { code: "EIO" });
  }
}

function dieForTest(): never {
  // A hard stop: no finally block, no exit handler, as a crash or a kill would end it.
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
}

/* ── Ledger: one row per applied import, in the same transaction as its rows ── */

export const LEDGER_COLLECTION = "transfer_imports";
const LEDGER_SEED = { collection: LEDGER_COLLECTION, schemaVersion: 1, migrationId: "transfer-imports-v1", key: (row: LedgerRow) => `i:${row.importId}`, loadRecords: (): LedgerRow[] => [] };

export interface LedgerRow {
  kind: "import";
  importId: string;
  bundleSha256: string;
  exportId: string;
  sourceProduct: string;
  appliedAt: string;
  mappings: Record<string, string>;
  /** Aliases this import wrote, each confirmed by the operator in the dry run. */
  aliases: { source: string; target: string; origin: "transfer" }[];
  /** Records that wait for their target to connect (relay, Telegram, voice tools) or for the operator. */
  pending: { part: string; key: string; value: unknown }[];
  /** Fresh rule version id → the source's rule id. */
  versions: Record<string, string>;
  /** The bundle records this import did not apply, by record id: skipped, or
      a conflict where this install kept its own value. It applied every other
      record of the bundle. A later import of the same bundle plans only the
      records no earlier import of it applied (§4.8). */
  unapplied?: string[];
  /** The source's history of every scope merged into one this install already had. */
  scopeHistories: Record<string, unknown[]>;
  accounts: AccountPlan[];
  /** The checklist row of every account the bundle names (`transferAccountKey`),
      the ones an earlier import of this bundle already brought included: the
      report reads these, whichever import last wrote the row. */
  accountKeys?: string[];
  /** Work after the commit that recovery finishes when a stop cut it short:
      the lesson known values the publication gate reads, and the accounts
      whose ids the commit reserved and bound. */
  followUp: { knownValues: boolean; accounts: boolean };
  report: Omit<TransferReport, "accounts" | "accountsReady">;
}

function ledgerCollection(create: boolean): SqliteStateCollection<LedgerRow> | null {
  const file = path.join(stateDir(), "state.sqlite");
  if (!create && !stateCollectionsInitialized(file, [LEDGER_SEED])) return null;
  if (create) initializeStateCollections(file, [LEDGER_SEED]);
  return new SqliteStateCollection<LedgerRow>(file, {
    collection: LEDGER_COLLECTION, schemaVersion: 1, busyMessage: "transfer imports busy", key: LEDGER_SEED.key, clone: structuredClone, strictDecode: true,
    decode: value => value && typeof value === "object" && (value as LedgerRow).kind === "import" && typeof (value as LedgerRow).importId === "string" ? value as LedgerRow : null,
  });
}

export function readImportRecords(): LedgerRow[] {
  const held = ledgerCollection(false);
  if (!held) return [];
  try { return [...held.snapshot()].sort((a, b) => a.appliedAt.localeCompare(b.appliedAt)); }
  finally { held.close(); }
}

/** Whether an import's commit landed: its ledger row is the commit's own
    witness. A database that cannot answer throws, so no caller undoes a
    commit on a guess. */
function importCommitted(importId: string): boolean {
  readFault("ledger");
  return targetRowCommitted(LEDGER_COLLECTION, `i:${importId}`);
}

/** The checklist rows an import's report shows. */
export function importAccountRows(ledger: Pick<LedgerRow, "importId" | "accountKeys">, rows: readonly ImportedAccountRow[] = importedAccountRows()): ImportedAccountRow[] {
  if (!ledger.accountKeys) return rows.filter(row => row.importId === ledger.importId);
  const keys = new Set(ledger.accountKeys);
  return rows.filter(row => keys.has(transferAccountKey(row)));
}

/* ── Staging ─────────────────────────────────────────────────────────── */

const transferRoot = () => path.join(stateDir(), "transfer");
const stagedPath = (sha: string) => path.join(transferRoot(), "staged", `${sha}.dlgt`);
const importDirectory = (importId: string) => path.join(transferRoot(), "imports", importId);

/** Keep the plain bundle for apply, owner-only. The dry run and apply read the same bytes. */
const STAGED_RETENTION_MS = 24 * 60 * 60_000;

/** Staged bundles nobody applied leave after a day; an applied one leaves at once. */
function pruneStaged(now = Date.now()): void {
  const directory = path.join(transferRoot(), "staged");
  let names: string[] = [];
  try { names = fs.readdirSync(directory); } catch { return; }
  for (const name of names) {
    const file = path.join(directory, name);
    try { if (now - fs.statSync(file).mtimeMs > STAGED_RETENTION_MS) fs.rmSync(file, { force: true }); } catch { /* gone already */ }
  }
}

export async function stageBundle(bytes: Uint8Array): Promise<DecodedBundle> {
  const decoded = await decodeBundle(bytes);
  pruneStaged();
  const file = stagedPath(decoded.sha256);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      fsyncPath(temporary);
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return decoded;
}

async function readStaged(sha: string): Promise<DecodedBundle> {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new TransferImportError("not_staged", "no staged bundle has that hash");
  let bytes: Buffer;
  try { bytes = fs.readFileSync(stagedPath(sha)); }
  catch { throw new TransferImportError("not_staged", "this bundle was not previewed here; preview it again"); }
  const decoded = await decodeBundle(bytes);
  if (decoded.sha256 !== sha) throw new TransferImportError("not_staged", "the staged bundle changed; preview it again");
  return decoded;
}

/* ── Planning ────────────────────────────────────────────────────────── */

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const sameValue = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

const isRecordObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function folderKey(folder: string): { key: string; folder: string } {
  let real: string;
  try { real = fs.realpathSync.native(folder); }
  catch { throw new TransferImportError("bad_mapping", "a mapped folder does not exist on this install"); }
  if (!fs.statSync(real).isDirectory()) throw new TransferImportError("bad_mapping", "a mapped folder is not a directory");
  const root = repositoryRootForPath(real);
  const key = (root ? projectIdentityFromRepositoryRoot(root)?.project : null) ?? projectIdentityFromDirectory(real)?.project;
  if (!key) throw new TransferImportError("bad_mapping", "a mapped folder has no project identity");
  return { key, folder: real };
}

interface TargetAliases { aliases: Record<string, string> }

function targetAliasSnapshot(): TargetAliases {
  const rows = readTargetRows("project_aliases");
  const aliases: Record<string, string> = {};
  for (const [key, json] of rows?.rows ?? []) {
    if (!key.startsWith("alias:")) continue;
    const row = JSON.parse(json) as { value?: unknown };
    if (typeof row.value === "string") aliases[key.slice("alias:".length)] = row.value;
  }
  return { aliases };
}

function planProjects(projects: readonly BundleProject[], mappings: Record<string, string>, aliases: TargetAliases): { plans: ProjectPlan[]; folders: Map<string, string>; newAliases: { source: string; target: string; displayName: string }[] } {
  const folders = new Map<string, string>();
  const newAliases: { source: string; target: string; displayName: string }[] = [];
  for (const key of Object.keys(mappings)) if (!projects.some(project => project.key === key && project.kind === "folder")) {
    throw new TransferImportError("bad_mapping", "a mapping names a folder key this bundle does not hold");
  }
  const plans = projects.map((project): ProjectPlan => {
    if (project.kind === "repository") return { ...project, target: resolveAliasChain(project.key, aliases.aliases), state: "repository" };
    const mapped = mappings[project.key];
    if (mapped) {
      const { key, folder } = folderKey(mapped);
      folders.set(key, folder);
      if (key !== project.key) newAliases.push({ source: project.key, target: key, displayName: project.displayName });
      return { ...project, target: key, state: "mapped" };
    }
    const remembered = resolveAliasChain(project.key, aliases.aliases);
    if (remembered !== project.key) return { ...project, target: remembered, state: "remembered" };
    return { ...project, target: null, state: "unmapped" };
  });
  return { plans, folders, newAliases };
}

/** One value this import puts into a JSON file, so a rollback after a later
    writer touched the same file undoes only what is still this import's. */
export type FileChange =
  | { kind: "set"; path: string[]; before?: unknown; after: unknown }
  | { kind: "append"; item: unknown };

interface PlannedFile { root: "state" | "config"; relative: string; text: string; changes: FileChange[] | null }

/** A record on its way to the target: its key and value remapped, its id as the bundle holds it. */
type PlanRow = StoredRow & { rid: string };

interface PlannedWrites {
  rows: Map<string, { part: RowsPart | null; records: { key: string; value: unknown }[] }>;
  files: Map<string, PlannedFile>;
  pending: LedgerRow["pending"];
  versions: Record<string, string>;
  aliases: LedgerRow["aliases"];
  /** Target role memory after the import, for the report's scope figures. */
  roleRowsAfter: RoleMemoryRow[];
  /** Per incoming scope, its active ids as the source held them. */
  sourceActive: Map<string, string[]>;
  /** Source rule ids whose text this install keeps as a version of its own rule. */
  keptAsVersion: Set<string>;
  /** The source's history of each scope merged into an existing one, kept in the import record. */
  scopeHistories: Record<string, unknown[]>;
  /** Account and binding records, project keys remapped, applied after the commit. */
  accountRecords: PlanRow[];
  /** Scopes whose record an earlier import of this bundle applied (§4.8): checked then. */
  scopesImportedBefore: Set<string>;
  /** Checklist rows of accounts an earlier import of this bundle brought: still this import's to report. */
  replayedAccountKeys: Set<string>;
}

interface Built {
  plan: TransferPlan;
  writes: PlannedWrites;
  sourceScopes: Record<string, ScopeFigures>;
}

function emptySectionPlan(name: string, records: number, replace: boolean): SectionPlan {
  return { name, records, new: 0, same: 0, conflict: 0, skipped: 0, skippedReasons: {}, skippedRecords: [], conflicts: [], pending: 0, replace };
}

/** The bundle records each section plan does not apply, by record id
    (`<section>|<part>|<key>` as the bundle holds it): the ones it skips, and
    the conflicts where this install keeps its own value, so nothing of the
    record is written. A later import of the same bundle may still apply
    these, a section's «take the source's» included; every other record of
    it has arrived. */
const unappliedRecords = new WeakMap<SectionPlan, Set<string>>();

function unapplied(plan: SectionPlan, rid: string): void {
  const held = unappliedRecords.get(plan) ?? new Set<string>();
  held.add(rid);
  unappliedRecords.set(plan, held);
}

/** A bundle record's id, before any project key is remapped. */
const recordId = (record: { s: string; k: string }) => `${record.s}|${record.k}`;

const AT_FIELDS = ["changedAt", "updatedAt", "lastAt", "savedAt", "at", "createdAt"] as const;

/** When a value says it last changed: its own time field, or its document's. */
function valueTime(value: unknown): string | null {
  for (const holder of [value, isRecordObject(value) ? value.value : undefined, isRecordObject(value) ? value.v : undefined]) {
    if (!isRecordObject(holder)) continue;
    for (const field of AT_FIELDS) if (typeof holder[field] === "string") return holder[field] as string;
  }
  return null;
}

/** One side of a conflict as the dry run shows it: kind and time, and the text of a rule. */
function conflictVersion(value: unknown): ConflictVersion {
  if (isRecordObject(value) && value.kind === "rule" && typeof value.rule === "string") {
    const origin = isRecordObject(value.source) && typeof value.source.origin === "string" ? value.source.origin : undefined;
    return { kind: "rule", ...(origin ? { origin } : {}), ...(typeof value.state === "string" ? { state: value.state } : {}), at: typeof value.changedAt === "string" ? value.changedAt : null, text: value.rule };
  }
  if (isRecordObject(value) && value.kind === "scope" && Array.isArray(value.history)) {
    const last = value.history.at(-1);
    return { kind: "scope", at: isRecordObject(last) && typeof last.at === "string" ? last.at : null, value: { active: Array.isArray(value.active) ? value.active.length : 0, history: value.history.length } };
  }
  if (typeof value === "string") {
    /* A text file that holds a JSON document says when it changed. */
    let parsed: unknown = null;
    try { parsed = JSON.parse(value); } catch { parsed = null; }
    return { kind: "text", at: valueTime(parsed), text: value };
  }
  return { kind: Array.isArray(value) ? "list" : isRecordObject(value) && typeof value.kind === "string" ? value.kind : value === null ? "null" : typeof value, at: valueTime(value), value };
}

function count(plan: SectionPlan, outcome: "new" | "same" | "conflict" | "skipped", key: string, detail?: string, action?: ConflictAction, versions?: { source: unknown; target: unknown }) {
  plan[outcome] += 1;
  if (outcome === "skipped") {
    const reason = detail ?? "skipped";
    unapplied(plan, key);
    plan.skippedReasons[reason] = (plan.skippedReasons[reason] ?? 0) + 1;
    plan.skippedRecords.push({ key, reason });
  }
  if (outcome === "conflict") {
    plan.conflicts.push({ key, action: action ?? "kept-target", ...(versions ? { source: conflictVersion(versions.source), target: conflictVersion(versions.target) } : {}) });
  }
}

/** "absent" for a collection with no rows and no write yet, so one an owner
    initialized empty since the dry run still matches it. */
function collectionRevision(rows: ReturnType<typeof readTargetRows>): string {
  return !rows || (rows.revision === 0 && rows.rows.size === 0) ? "absent" : String(rows.revision);
}

function rowsRevision(collection: string): string {
  return collectionRevision(readTargetRows(collection));
}

const ROLE_SEED_INITIALIZERS: Record<string, () => void> = {
  role_memory: () => { roleMemoryCollection(true); },
  role_memory_curation: () => { curationCollection(true); },
  memory_profile: () => { memoryProfileCollection(true)?.close(); },
};

/** The plan for one bundle against this install now, and every write it implies. */
export function buildPlan(decoded: DecodedBundle, request: { mappings?: Record<string, string>; replace?: readonly string[] }, now: string, ledger: readonly LedgerRow[] = readImportRecords()): Built {
  const replace = new Set((request.replace ?? []).filter(isSectionName));
  const mappings = request.mappings ?? {};
  const { plans: projectPlans, folders, newAliases } = planProjects(decoded.header.projects, mappings, targetAliasSnapshot());
  const projectTarget = new Map(projectPlans.map(project => [project.key, project.target ?? project.key] as const));
  const remap = (text: string) => remapText(text, key => projectTarget.get(key) ?? key);
  const revisions: Record<string, string> = {};
  const writes: PlannedWrites = { rows: new Map(), files: new Map(), pending: [], versions: {}, aliases: [], roleRowsAfter: [], sourceActive: new Map(), keptAsVersion: new Set(), scopeHistories: {}, accountRecords: [], scopesImportedBefore: new Set(), replayedAccountKeys: new Set() };
  const sectionPlans = new Map<string, SectionPlan>();
  const unknownSections = decoded.header.sections.filter(section => !isSectionName(section.name) || section.schema !== 1).map(section => section.name);
  for (const section of decoded.header.sections) sectionPlans.set(section.name, emptySectionPlan(section.name, section.records, replace.has(section.name as never)));

  /* §4.8: importing the same bundle again applies only what no earlier import
     of it applied. A record one of them applied (new, same, or a conflict
     whose rule wrote something of it: a rule text kept as a version, a merged
     scope or setting) is left as this install now holds it, whatever happened
     to it since; it is counted skipped as already imported. */
  const earlier = ledger.filter(row => row.bundleSha256 === decoded.sha256);
  const earlierUnapplied = earlier.map(row => new Set(row.unapplied ?? []));
  const importedBefore = (rid: string) => earlier.some((row, index) => row.unapplied !== undefined && !earlierUnapplied[index]!.has(rid));

  const byPart = new Map<string, { section: string; rows: PlanRow[] }>();
  for (const record of decoded.records) {
    const sectionPlan = sectionPlans.get(record.s)!;
    const rid = recordId(record);
    if (unknownSections.includes(record.s)) { count(sectionPlan, "skipped", rid, "needs-newer-delegatus"); continue; }
    const { part, key } = splitRecordKey(record.k);
    const row: PlanRow = { key: remap(key), value: JSON.parse(remap(JSON.stringify(record.v))) as unknown, rid };
    if (importedBefore(rid)) {
      if (part === "rows:role_memory" && row.key.startsWith("s:") && isRecordObject(row.value) && typeof row.value.scope === "string") writes.scopesImportedBefore.add(row.value.scope);
      /* An account brought before stays on this import's checklist: the row the latest earlier import planned for it. */
      if (record.s === "accounts" && part === "accounts" && key.startsWith("account:")) {
        const planned = [...earlier].reverse().map(previous => previous.accounts?.find(account => `account:${account.engine}:${account.sourceId}` === key)).find(Boolean);
        if (planned) writes.replayedAccountKeys.add(transferAccountKey({ engine: planned.engine, sourceId: planned.sourceId, targetId: planned.action === "skip" ? null : planned.plannedId }));
      }
      count(sectionPlan, "skipped", rid, "already-imported");
      continue;
    }
    if (record.s === "accounts") {
      /* Counted new here; the account plan, which reads this install's
         accounts, settles which already exist (§3). */
      if (part !== "accounts" || !validAccountRecord(row.key, row.value)) { count(sectionPlan, "skipped", rid, "invalid-record"); continue; }
      writes.accountRecords.push(row);
      count(sectionPlan, "new", rid);
      continue;
    }
    if (!partById.has(part) || partById.get(part)!.section !== record.s) { count(sectionPlan, "skipped", rid, "unknown-part"); continue; }
    const entry = byPart.get(part) ?? { section: record.s, rows: [] };
    entry.rows.push(row);
    byPart.set(part, entry);
  }

  /* Files are planned per file, since several parts can share one. */
  const fileState = new Map<string, { root: "state" | "config"; relative: string; object: Record<string, unknown> | unknown[] | string | null; original: unknown; unreadable: boolean; changed: boolean; changes: FileChange[] | null }>();
  const fileFor = (root: "state" | "config", relative: string, parse: "json" | "text") => {
    const id = `${root}:${relative}`;
    let state = fileState.get(id);
    if (!state) {
      const read = readTargetText(root, relative);
      let object: Record<string, unknown> | unknown[] | string | null = null;
      /* A file that is there and does not parse is never replaced: its store
         reports it damaged, and the operator repairs it. So is one the import
         does not read at all (a link, an oversized file): it is not absent. */
      let unreadable = read.kind === "unsupported";
      if (read.kind === "text") {
        if (parse === "text") object = read.text;
        else { try { object = JSON.parse(read.text) as Record<string, unknown>; } catch { unreadable = true; } }
      }
      state = { root, relative, object, original: structuredClone(object), unreadable, changed: false, changes: parse === "json" ? [] : null };
      fileState.set(id, state);
      revisions[`file:${id}`] = fileRevision(root, relative);
    }
    return state;
  };

  for (const part of PARTS) {
    const entry = byPart.get(part.id);
    if (!entry) continue;
    const plan = sectionPlans.get(entry.section)!;
    const take = plan.replace;
    switch (part.kind) {
      case "pending":
        for (const row of entry.rows) {
          count(plan, "skipped", row.rid, `pending:${part.reason}`);
          plan.pending += 1;
          writes.pending.push({ part: part.id, key: row.key, value: row.value });
        }
        break;
      case "rows":
        planRows(part, entry.rows, plan, take, writes, revisions, folders, now);
        break;
      case "map": {
        const file = fileFor(part.root, part.file, "json");
        if (file.unreadable || (file.object !== null && !isRecordObject(file.object))) {
          for (const row of entry.rows) count(plan, "skipped", row.rid, "target-file-unreadable");
          break;
        }
        /* What the target held before this import: an absent file holds
           nothing, whatever defaults its skeleton writes. */
        const original = file.original === null ? undefined : at(file.original, part.path);
        for (const row of entry.rows) {
          if (!part.accept?.(row.key, row.value)) { count(plan, "skipped", row.rid, "invalid-record"); continue; }
          const container = mapContainer(file, part);
          const held = isRecordObject(original) ? original[row.key] : undefined;
          if (part.fields && isRecordObject(held) && isRecordObject(row.value)) {
            /* One record holds several settings: each field is one choice, kept
               on the target when it made it, taken from the source when it did not. */
            const next: Record<string, unknown> = isRecordObject(container[row.key]) ? { ...(container[row.key] as Record<string, unknown>) } : {};
            let added = 0, differing = 0;
            for (const [field, value] of Object.entries(row.value)) {
              const was = held[field];
              if (was !== undefined && sameValue(was, value)) continue;
              if (was === undefined) added += 1; else differing += 1;
              if (was !== undefined && !take) continue;
              next[field] = value;
              file.changes!.push({ kind: "set", path: [...part.path, row.key, field], ...(was === undefined ? {} : { before: was }), after: value });
            }
            if (!added && !differing) { count(plan, "same", `${part.id}|${row.key}`); continue; }
            count(plan, "conflict", `${part.id}|${row.key}`, undefined, differing && take ? "took-source" : added ? "merged" : "kept-target", { source: row.value, target: held });
            if (differing && !take) unapplied(plan, row.rid);
            if (added || take) { container[row.key] = next; file.changed = true; }
            continue;
          }
          const outcome = planValue(held, row.value, part.merge, take);
          count(plan, outcome.outcome, `${part.id}|${row.key}`, undefined, outcome.action, { source: row.value, target: held });
          if (outcome.action === "kept-target") unapplied(plan, row.rid);
          if (outcome.write) {
            container[row.key] = row.value;
            file.changed = true;
            file.changes!.push({ kind: "set", path: [...part.path, row.key], ...(held === undefined ? {} : { before: held }), after: row.value });
          }
        }
        break;
      }
      case "set": {
        const file = fileFor(part.root, part.file, "json");
        if (file.unreadable || (file.object !== null && !Array.isArray(file.object))) {
          for (const row of entry.rows) count(plan, "skipped", row.rid, "target-file-unreadable");
          break;
        }
        const list = (file.object ??= []) as unknown[];
        for (const row of entry.rows) {
          if (typeof row.value !== "string" || !part.accept?.(row.key, row.value)) { count(plan, "skipped", row.rid, "invalid-record"); continue; }
          if (list.includes(row.value)) count(plan, "same", row.key);
          else { list.push(row.value); file.changed = true; file.changes!.push({ kind: "append", item: row.value }); count(plan, "new", row.key); }
        }
        break;
      }
      case "text":
        for (const row of entry.rows) {
          const relative = part.fileOf(row.key);
          if (typeof row.value !== "string" || !part.accept?.(row.key, row.value) || row.key.includes("..") || path.isAbsolute(row.key) || path.normalize(relative) !== relative) {
            count(plan, "skipped", row.rid, "invalid-record");
            continue;
          }
          const file = fileFor(part.root, relative, "text");
          if (file.unreadable) { count(plan, "skipped", row.rid, "target-file-unreadable"); continue; }
          const outcome = planValue(file.object === null ? undefined : file.object, row.value, part.merge, take);
          count(plan, outcome.outcome, `${part.id}|${row.key}`, undefined, outcome.action, { source: row.value, target: file.object });
          if (outcome.action === "kept-target") unapplied(plan, row.rid);
          if (outcome.write) { file.object = row.value; file.changed = true; }
        }
        break;
    }
  }

  /* With no role record left to plan (all imported before), the figures are this install's own rows. */
  if (!byPart.has("rows:role_memory")) {
    writes.roleRowsAfter = [...(readTargetRows("role_memory")?.rows ?? new Map<string, string>())]
      .filter(([key]) => key.startsWith("r:") || key.startsWith("s:")).map(([, json]) => JSON.parse(json) as RoleMemoryRow);
  }

  for (const state of fileState.values()) {
    if (!state.changed) continue;
    const text = typeof state.object === "string" ? state.object : `${JSON.stringify(state.object, null, 2)}\n`;
    writes.files.set(`${state.root}:${state.relative}`, { root: state.root, relative: state.relative, text, changes: state.changes });
  }

  if (newAliases.length) {
    if (!legacyStoreImported("project_aliases")) throw new TransferImportError("bad_mapping", "this install has not migrated its project aliases yet; restart Delegatus, then import");
    revisions["rows:project_aliases"] ??= rowsRevision("project_aliases");
    const aliasRows = writes.rows.get("project_aliases") ?? { part: null, records: [] };
    for (const alias of newAliases) {
      aliasRows.records.push({ key: `alias:${alias.source}`, value: { key: `alias:${alias.source}`, value: alias.target } });
      writes.aliases.push({ source: alias.source, target: alias.target, origin: "transfer" });
    }
    writes.rows.set("project_aliases", aliasRows);
  }

  const sourceScopes = (decoded.header.sections.find(section => section.name === "memory.role")?.summary.scopes ?? {}) as Record<string, ScopeFigures>;
  const remappedSourceScopes = Object.fromEntries(Object.entries(sourceScopes).map(([scope, figures]) => [remap(scope), figures]));
  const overBudgetScopes = [...scopeFigures(writes.roleRowsAfter)].filter(([, figures]) => figures.codePoints > 10_000)
    .map(([scope, figures]) => ({ scope, codePoints: figures.codePoints })).sort((a, b) => a.scope.localeCompare(b.scope));

  const previous = ledger.find(row => row.bundleSha256 === decoded.sha256) ?? null;
  const plan: TransferPlan = {
    bundleSha256: decoded.sha256,
    exportId: decoded.header.exportId,
    createdAt: decoded.header.createdAt,
    sourceProduct: decoded.header.product,
    sections: [...sectionPlans.values()],
    unknownSections,
    projects: projectPlans,
    accounts: [],
    overBudgetScopes,
    redo: redoList(projectPlans, writes, decoded, [...sectionPlans.values()]),
    environment: decoded.header.environment,
    notices: decoded.header.notices,
    revisions,
    previousImport: previous ? { importId: previous.importId, at: previous.appliedAt } : null,
  };
  return { plan, writes, sourceScopes: remappedSourceScopes };
}

function at(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) current = isRecordObject(current) ? current[key] : undefined;
  return current;
}

function mapContainer(file: { object: Record<string, unknown> | unknown[] | string | null }, part: MapPart): Record<string, unknown> {
  if (file.object === null) file.object = part.skeleton();
  let container = file.object as Record<string, unknown>;
  for (const key of part.path) {
    if (!isRecordObject(container[key])) container[key] = {};
    container = container[key] as Record<string, unknown>;
  }
  return container;
}

function planValue(held: unknown, incoming: unknown, merge: Part extends never ? never : MapPart["merge"], take: boolean): { outcome: "new" | "same" | "conflict"; write: boolean; action?: SectionPlan["conflicts"][number]["action"] } {
  if (held === undefined) return { outcome: "new", write: true };
  if (sameValue(held, incoming)) return { outcome: "same", write: false };
  if (merge === "absent-only" || !take) return { outcome: "conflict", write: false, action: "kept-target" };
  return { outcome: "conflict", write: true, action: "took-source" };
}

function planRows(
  part: RowsPart, rows: readonly PlanRow[], plan: SectionPlan, take: boolean, writes: PlannedWrites,
  revisions: Record<string, string>, folders: ReadonlyMap<string, string>, now: string,
) {
  if (part.legacyDocument && !legacyStoreImported(part.collection)) {
    for (const row of rows) count(plan, "skipped", row.rid, "target-store-not-migrated");
    return;
  }
  const target = readTargetRows(part.collection);
  revisions[`rows:${part.collection}`] = collectionRevision(target);
  const held = target?.rows ?? new Map<string, string>();
  const out = writes.rows.get(part.collection) ?? { part, records: [] };
  writes.rows.set(part.collection, out);
  const valid = rows.filter(row => {
    const ok = part.collection === "role_memory" ? validRoleRecord(row.key, row.value)
      : part.accept ? part.accept(row.key, row.value) : false;
    if (!ok) count(plan, "skipped", row.rid, "invalid-record");
    return ok;
  });
  if (part.merge === "role-memory") {
    const role = planRoleMemory(valid, held, { now });
    for (const outcome of role.outcomes) count(plan, outcome.outcome, `${part.id}|${outcome.key}`, undefined, outcome.action, outcome.versions);
    for (const row of valid) {
      if (!row.key.startsWith("s:")) continue;
      const scope = row.value as { scope: string; active: string[]; history: unknown[] };
      writes.sourceActive.set(scope.scope, [...scope.active]);
      if (role.outcomes.some(outcome => outcome.key === row.key && outcome.action === "merged")) writes.scopeHistories[scope.scope] = scope.history;
    }
    for (const outcome of role.outcomes) if (outcome.action === "stored-as-version") writes.keptAsVersion.add(outcome.key.slice("r:".length));
    out.records.push(...role.writes);
    Object.assign(writes.versions, role.versions);
    const after = new Map<string, RoleMemoryRow>();
    for (const [key, json] of held) if (key.startsWith("r:") || key.startsWith("s:")) after.set(key, JSON.parse(json) as RoleMemoryRow);
    for (const write of role.writes) after.set(write.key, write.value);
    writes.roleRowsAfter = [...after.values()];
    return;
  }
  for (const row of valid) {
    let value = row.value;
    if (part.collection === "project_curation" && row.key.startsWith("manual:")) {
      const document = value as { key: string; value: { entry: { project: string; root: string }; order: number } };
      const folder = folders.get(document.value.entry.project);
      if (!folder) { count(plan, "skipped", row.rid, "manual-project-without-folder"); continue; }
      value = { ...document, value: { ...document.value, entry: { ...document.value.entry, root: folder } } };
    }
    const current = held.get(row.key);
    const currentValue = current === undefined ? undefined : JSON.parse(current) as unknown;
    if (part.merge === "curation" && currentValue !== undefined && isRecordObject(currentValue) && isRecordObject(value)) {
      if (sameValue(currentValue, value)) { count(plan, "same", row.key); continue; }
      const later = typeof value.lastAt === "string" && (typeof currentValue.lastAt !== "string" || value.lastAt > currentValue.lastAt);
      if (later) out.records.push({ key: row.key, value: { ...currentValue, lastAt: value.lastAt } });
      count(plan, "conflict", `${part.id}|${row.key}`, undefined, later ? "merged" : "kept-target", { source: value, target: currentValue });
      if (!later) unapplied(plan, row.rid);
      continue;
    }
    const outcome = planValue(currentValue, value, part.merge === "absent-only" ? "absent-only" : "default", take);
    count(plan, outcome.outcome, `${part.id}|${row.key}`, undefined, outcome.action, { source: value, target: currentValue });
    if (outcome.action === "kept-target") unapplied(plan, row.rid);
    if (outcome.write) out.records.push({ key: row.key, value });
  }
}

function redoList(projects: readonly ProjectPlan[], writes: PlannedWrites, decoded: DecodedBundle, sections: readonly SectionPlan[]): RedoItem[] {
  const redo: RedoItem[] = [];
  const accounts = decoded.header.accounts.length;
  if (accounts) redo.push({ code: "account_sign_in", count: accounts });
  redo.push({ code: "api_keys" });
  const pendingCount = (part: string) => writes.pending.filter(item => item.part === part).length;
  if (pendingCount("pending:telegram-chats") || sections.some(section => section.name === "settings.telegram")) redo.push({ code: "telegram_bot", count: pendingCount("pending:telegram-chats") });
  if (pendingCount("pending:relay-targets")) redo.push({ code: "relay_pairing", count: pendingCount("pending:relay-targets") });
  const forge = sections.find(section => section.name === "settings.forge");
  if (forge && forge.records) redo.push({ code: "forge_app_credential", count: forge.records });
  redo.push({ code: "access_and_team" });
  if (pendingCount("pending:voice-tools")) redo.push({ code: "voice_tools", count: pendingCount("pending:voice-tools") });
  if (pendingCount("pending:subscription-consent")) redo.push({ code: "subscription_consent" });
  const environment = decoded.header.environment;
  if (environment.length) redo.push({ code: "environment", count: environment.length, detail: environment.map(entry => entry.value === undefined ? entry.name : `${entry.name}=${entry.value}`).join(", ") });
  const unmapped = projects.filter(project => project.state === "unmapped");
  if (unmapped.length) redo.push({ code: "unmapped_project", count: unmapped.length, detail: unmapped.map(project => project.displayName).join(", ") });
  const manual = sections.flatMap(section => Object.entries(section.skippedReasons)).filter(([reason]) => reason === "manual-project-without-folder").reduce((sum, [, n]) => sum + n, 0);
  if (manual) redo.push({ code: "manual_project_folder", count: manual });
  const source = writes.pending.find(item => item.part === "pending:memory-source");
  if (source) redo.push({ code: "memory_source", detail: String(source.value) });
  const machine = writes.pending.find(item => item.part === "pending:machine-worker-limit");
  if (machine) redo.push({ code: "machine_worker_limit", detail: String(machine.value) });
  redo.push({ code: "browser_preferences" });
  return redo;
}

/* ── Dry run ─────────────────────────────────────────────────────────── */

/** The account plan against this install, and the accounts section's counts moved to match it. */
async function withAccountPlan(built: Built, deps: AccountTargetDeps | undefined): Promise<Built> {
  if (!built.writes.accountRecords.length) return built;
  const plans = await planAccounts(built.writes.accountRecords, built.plan.exportId, deps);
  const section = built.plan.sections.find(candidate => candidate.name === "accounts");
  for (const account of plans) {
    if (!section) break;
    if (account.action === "existing") { section.new -= 1; section.same += 1; }
    else if (account.action === "skip") { section.new -= 1; count(section, "skipped", `accounts|accounts|account:${account.engine}:${account.sourceId}`, account.reason ?? "skipped"); }
  }
  built.plan.accounts = plans;
  return built;
}

export async function previewTransferImport(
  bytes: Uint8Array, request: { mappings?: Record<string, string>; replace?: readonly string[] } = {},
  options: { now?: Date; accounts?: AccountTargetDeps } = {},
): Promise<TransferPlan> {
  const decoded = await stageBundle(bytes);
  return (await withAccountPlan(buildPlan(decoded, request, (options.now ?? new Date()).toISOString()), options.accounts)).plan;
}

/* ── Apply ───────────────────────────────────────────────────────────── */

/** One file the import writes, as the journal records it before the first write. */
interface JournalFile {
  root: "state" | "config";
  relative: string;
  /** SHA-256 of the file before the import, or null when it was absent. */
  before: string | null;
  /** SHA-256 of what the import writes. */
  written: string;
  /** The original, kept beside the file under a name of this import (same
      root, same directory): a hard link to the same bytes, or a copy where the
      file system refuses links. Putting it back is a rename inside one
      directory, so it needs no free space and never crosses a file system,
      wherever the state and config roots live. */
  backup: { relative: string } | null;
  changes: FileChange[] | null;
}

interface Journal {
  importId: string;
  state: "writing" | "done" | "rolled-back";
  at: string;
  files: JournalFile[];
  /** Account ids this import reserved before its commit, given back on a rollback. */
  reservations: { engine: TransferEngine; id: string }[];
}

const sha256Of = (bytes: string | Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A file's hash, null when absent; a file the import never reads (a link, a
    FIFO, past the bound) answers its kind without being opened, which matches
    no hash the journal holds. */
function currentHash(file: string): string | null {
  const read = readRegularFile(file);
  if (read.kind === "absent") return null;
  if (read.kind === "unsupported") return `unsupported:${read.reason}`;
  return sha256Of(read.bytes);
}

function writeJournal(directory: string, journal: Journal): void {
  writeAtomic(path.join(directory, "journal.json"), `${JSON.stringify(journal)}\n`);
}

const isJournalFile = (value: unknown): value is JournalFile => {
  if (!isRecordObject(value)) return false;
  const backup = value.backup;
  return (value.root === "state" || value.root === "config") && typeof value.relative === "string" && !!value.relative
    && (value.before === null || typeof value.before === "string") && typeof value.written === "string"
    && (backup === null || (isRecordObject(backup) && typeof backup.relative === "string" && !!backup.relative))
    && (value.changes === null || Array.isArray(value.changes));
};

/** The journal of one import directory. Null only when it was never written:
    apply writes it before any file, reservation or row, so a directory
    without one holds nothing to settle. Anything else that cannot be read or
    does not decode refuses, and the directory stays for the next attempt: a
    journal read as absent would let the Viewer admit work over an import
    that is still half applied. */
function readJournal(directory: string): Journal | null {
  const file = path.join(directory, "journal.json");
  let text: string;
  try {
    readFault("journal");
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new TransferImportError("recovery_unreadable", `the journal of import ${path.basename(directory)} cannot be read (${code ?? "error"}); it is kept for the next attempt`);
  }
  let journal: unknown;
  try { journal = JSON.parse(text); } catch { journal = null; }
  /* A settled journal is never acted on; an unsettled one must decode whole, since recovery acts on every entry. */
  const valid = isRecordObject(journal) && typeof journal.importId === "string" && ["writing", "done", "rolled-back"].includes(journal.state as string)
    && (journal.state !== "writing" || (Array.isArray(journal.files) && journal.files.every(isJournalFile)
      && Array.isArray(journal.reservations) && journal.reservations.every(item => isRecordObject(item) && typeof item.engine === "string" && typeof item.id === "string")));
  if (!valid) throw new TransferImportError("recovery_unreadable", `the journal of import ${path.basename(directory)} is damaged; it is kept for the next attempt`);
  return journal as unknown as Journal;
}

/** Where an import keeps the original of a file it replaces: beside it. */
const backupRelative = (relative: string, importId: string) => path.join(path.dirname(relative), `.${path.basename(relative)}.${importId}.transfer-original`);
/** Where an import writes a file's new bytes before they take its name: beside
    it, under a name of the import, so what a stop left there is removed when
    the journal settles. */
const stagingPath = (entry: Pick<JournalFile, "root" | "relative">, importId: string) =>
  path.join(targetRoot(entry.root), path.dirname(entry.relative), `.${path.basename(entry.relative)}.${importId}.transfer-new`);

/** Runs `operation` holding the shared write lock of every file the import
    touches, taken in path order: a store writer that takes its file's lock
    waits until the import committed or rolled back. */
function withFileLocks<T>(targets: readonly string[], operation: () => T): T {
  const ordered = [...new Set(targets)].sort();
  const hold = (index: number): T => index === ordered.length
    ? operation()
    : withFileTransactionSync(ordered[index]!, "the install transfer is waiting for a settings file", () => hold(index + 1));
  return hold(0);
}

const journalTarget = (entry: Pick<JournalFile, "root" | "relative">) => path.join(targetRoot(entry.root), entry.relative);

function setAt(object: Record<string, unknown>, keys: readonly string[], value: unknown): void {
  let container = object;
  for (const key of keys.slice(0, -1)) {
    if (!isRecordObject(container[key])) return;
    container = container[key] as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (value === undefined) delete container[last]; else container[last] = value;
}

/** Undo this import's own values in a JSON file a later writer has since
    rewritten: a value that still holds what the import put there goes back to
    what was there before, and everything else is the later writer's and stays. */
function undoChanges(file: string, changes: readonly FileChange[]): boolean {
  let parsed: unknown;
  const read = readRegularFile(file);
  if (read.kind !== "bytes") return false;
  try { parsed = JSON.parse(read.bytes.toString("utf8")); } catch { return false; }
  let changed = false;
  for (const change of [...changes].reverse()) {
    if (change.kind === "append") {
      if (!Array.isArray(parsed)) continue;
      const index = parsed.findIndex(item => sameValue(item, change.item));
      if (index >= 0) { parsed.splice(index, 1); changed = true; }
      continue;
    }
    if (!isRecordObject(parsed) || !sameValue(at(parsed, change.path), change.after)) continue;
    setAt(parsed, change.path, change.before);
    changed = true;
  }
  if (changed) writeAtomic(file, typeof parsed === "string" ? parsed : `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

export interface RestoreOutcome { kept: string[] }

/** An empty file set just before the import replaces file `index`: after a
    stop, only a file with its marker can hold the import's bytes. Empty, so
    it needs no free space beyond its name. */
const writingMarker = (directory: string, index: number) => path.join(directory, "checkpoint", `${index}.writing`);

/** Put back what this import wrote and nothing else. A file that still holds
    exactly the import's bytes gets its original back by a rename (or loses
    the file the import created); a file that holds its original is left; a
    file a later writer rewrote keeps that writer's values, and only the
    values that are still the import's own are undone. Idempotent, so a stop
    in the middle is finished by the next recovery. Called under the files' locks. */
function restoreFiles(directory: string, journal: Journal, wrote?: ReadonlySet<number>): RestoreOutcome {
  const kept: string[] = [];
  for (const [index, entry] of journal.files.entries()) {
    const target = journalTarget(entry);
    const now = currentHash(target);
    if (now === entry.before) continue;
    /* A file the import never reached is someone else's, whatever it holds now. */
    if (!(wrote ? wrote.has(index) : fs.existsSync(writingMarker(directory, index)))) continue;
    if (now === entry.written) {
      if (entry.before === null) { fs.rmSync(target, { force: true }); fsyncPath(path.dirname(target)); continue; }
      const backup = entry.backup ? path.join(targetRoot(entry.root), entry.backup.relative) : null;
      if (!backup || !fs.existsSync(backup)) throw new Error(`the checkpoint copy of ${entry.relative} is missing; the import cannot be undone`);
      /* One directory: a rename, which allocates nothing and cannot cross a file system. */
      moveFile(backup, target);
      fsyncPath(path.dirname(target));
      continue;
    }
    /* Rewritten after the import's own write. */
    if (now !== null && entry.changes && undoChanges(target, entry.changes)) { kept.push(entry.relative); continue; }
    kept.push(entry.relative);
  }
  return { kept };
}

/** The journal's final word, written when it can be: on a full disk it stays
    `writing`, and the next recovery finds nothing left to restore. */
function settleJournal(directory: string, journal: Journal, state: "done" | "rolled-back"): void {
  try { writeJournal(directory, { ...journal, state }); } catch { /* the next recovery settles it */ }
  /* Originals a rollback put back are gone already; the rest are this import's own names, as is a staged write a stop left. */
  for (const entry of journal.files) {
    if (entry.backup) fs.rmSync(path.join(targetRoot(entry.root), entry.backup.relative), { force: true });
    fs.rmSync(stagingPath(entry, journal.importId), { force: true });
  }
  fs.rmSync(path.join(directory, "checkpoint"), { recursive: true, force: true });
}

async function rollBack(directory: string, journal: Journal, deps: AccountTargetDeps | undefined): Promise<RestoreOutcome> {
  const outcome = withFileLocks(journal.files.map(journalTarget), () => restoreFiles(directory, journal));
  for (const reservation of journal.reservations) await releaseReservation(reservation.engine, reservation.id, deps);
  settleJournal(directory, journal, "rolled-back");
  return outcome;
}

/** The bindings record must be one this install can read and add to: a
    damaged record refuses here rather than lose the fences it holds. */
function bindingsCollectionReady(): { schemaVersion: number; headPresent: boolean } {
  if (!legacyStoreImported("accounts")) throw new TransferImportError("target_unreadable", "this install has not migrated its accounts yet; restart Delegatus, then import");
  const rows = readTargetRows("accounts");
  if (!rows) throw new TransferImportError("target_unreadable", "this install's account store is missing; restart Delegatus, then import");
  if (rows.rows.has("raw:account-project-bindings.json") || rows.rows.has("gap:binding")) {
    throw new TransferImportError("target_unreadable", "this install's account-project binding record is unreadable; repair it, then import");
  }
  const head = rows.rows.get("meta:binding");
  if (head !== undefined) {
    const value = (JSON.parse(head) as { v?: { schemaVersion?: unknown } }).v;
    if (value?.schemaVersion !== 1) throw new TransferImportError("target_unreadable", "this install's account-project binding record has an unsupported version");
  }
  return { schemaVersion: rows.schemaVersion, headPresent: head !== undefined };
}

function writeCollections(writes: PlannedWrites, ledger: LedgerRow, expected: Record<string, string>, fault: TransferFault | null): void {
  const file = path.join(stateDir(), "state.sqlite");
  const opened: SqliteStateCollection<unknown>[] = [];
  try {
    const patches: { collection: SqliteStateCollection<unknown>; records: unknown[] }[] = [];
    for (const [collection, entry] of writes.rows) {
      if (!entry.records.length) continue;
      ROLE_SEED_INITIALIZERS[collection]?.();
      const meta = readTargetRows(collection);
      if (!meta) throw new TransferImportError("target_changed", `the ${collection} store is missing on this install`);
      const keys = new WeakMap<object, string>();
      const records = entry.records.map(record => { const value = structuredClone(record.value) as object; keys.set(value, record.key); return value; });
      const held = new SqliteStateCollection<unknown>(file, {
        collection, schemaVersion: meta.schemaVersion, busyMessage: `${collection} busy`,
        key: record => keys.get(record as object)!, decode: value => value, clone: structuredClone,
      });
      opened.push(held);
      patches.push({ collection: held, records });
    }
    const ledgerHeld = ledgerCollection(true)!;
    opened.push(ledgerHeld as SqliteStateCollection<unknown>);
    patches.push({ collection: ledgerHeld as SqliteStateCollection<unknown>, records: [ledger] });
    SqliteStateCollection.commitPatchesSync(patches, {
      busyMessage: "the install transfer is waiting for state",
      beforeMerge: read => {
        for (const [store, revision] of Object.entries(expected)) {
          if (!store.startsWith("rows:")) continue;
          const collection = store.slice("rows:".length);
          const now = read.revision(collection);
          /* A collection the preview found absent was created just above by its
             owner; it still holds nothing another writer put there. */
          const unchanged = revision === "absent" ? now === null || read.rows(collection) === 0 : String(now) === revision;
          if (!unchanged) throw new TransferImportError("target_changed", "this install changed since the preview; preview again");
        }
      },
      beforeCommit: () => {
        if (fault === "sqlite") throw new Error("injected SQLite failure");
        /* A full disk refuses the commit too. */
        allocate();
      },
    });
  } finally {
    for (const held of opened) held.close();
  }
}

export interface ApplyOptions {
  now?: () => Date;
  accounts?: AccountTargetDeps;
  /** Runs after the commit, before the report is returned (known values, accounts). */
  afterCommit?: (ledger: LedgerRow) => Promise<void> | void;
  /** Test seam: runs inside the files' locks after each file this import writes. */
  afterFileWrite?: (index: number) => void;
  /** Test seam: runs inside the files' locks after a file's last check, just before it is written. */
  beforeFileWrite?: (index: number) => void;
}

function hangForTest(directory: string): never {
  fs.writeFileSync(path.join(directory, "hanging"), `${process.pid}\n`);
  // eslint-disable-next-line no-restricted-syntax -- a deliberately hung apply for the external deadline test; never outside `bun test`.
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}

export async function applyTransferImport(request: TransferImportRequest, options: ApplyOptions = {}): Promise<{ report: TransferReport; ledger: LedgerRow }> {
  const clock = options.now ?? (() => new Date());
  const started = performance.now();
  const decoded = await readStaged(request.bundleSha256);
  const now = clock().toISOString();
  const built = await withAccountPlan(buildPlan(decoded, { mappings: request.mappings, replace: request.replace }, now), options.accounts);
  for (const [store, revision] of Object.entries(built.plan.revisions)) {
    if (request.revisions[store] !== revision) throw new TransferImportError("target_changed", "this install changed since the preview; preview again");
  }
  if (built.writes.accountRecords.length) bindingsCollectionReady();
  const fault = injectedFault();
  const importId = crypto.randomUUID();
  const directory = importDirectory(importId);
  fs.mkdirSync(path.join(directory, "checkpoint"), { recursive: true, mode: 0o700 });
  const journal: Journal = { importId, state: "writing", at: now, files: [], reservations: [] };
  writeJournal(directory, journal);
  if (fault === "hang") hangForTest(directory);

  /* §5.1: each record not plainly applied stays named with its reason or its
     decision, without the versions' content, which the dry run alone shows. */
  const sections: SectionReport[] = built.plan.sections.map(section => ({
    name: section.name, records: section.records, new: section.new, same: section.same, conflict: section.conflict, skipped: section.skipped, pending: section.pending,
    skippedReasons: { ...section.skippedReasons },
    skippedRecords: section.skippedRecords.map(entry => ({ ...entry })),
    conflicts: section.conflicts.map(({ key, action }) => ({ key, action })),
    balanced: section.new + section.same + section.conflict + section.skipped === section.records
      && section.skippedRecords.length === section.skipped && section.conflicts.length === section.conflict,
  }));
  const targetScopes = scopeFigures(built.writes.roleRowsAfter);
  const scopes = Object.entries(built.sourceScopes).sort(([a], [b]) => a.localeCompare(b)).map(([scope, source]) => {
    const target = targetScopes.get(scope) ?? { rules: 0, active: 0, codePoints: 0, history: 0 };
    /* §5.1: every source active id is active here or kept as a version of
       this install's rule, and nothing was lost from the active count. */
    const activeHere = new Set(built.writes.roleRowsAfter.find((row): row is Extract<RoleMemoryRow, { kind: "scope" }> => row.kind === "scope" && row.scope === scope)?.active ?? []);
    const everyActive = (built.writes.sourceActive.get(scope) ?? []).every(id => activeHere.has(id) || built.writes.keptAsVersion.has(id));
    /* A scope an earlier import of this bundle brought was checked then; what
       curation did to it since is this install's own. */
    if (built.writes.scopesImportedBefore.has(scope)) return { scope, source, target, ok: true, overBudget: target.codePoints > 10_000 };
    return { scope, source, target, ok: everyActive && target.active >= source.active, overBudget: target.codePoints > 10_000 };
  });
  const report: Omit<TransferReport, "accounts" | "accountsReady"> = {
    importId, bundleSha256: decoded.sha256, exportId: decoded.header.exportId, sourceProduct: decoded.header.product,
    appliedAt: now, applyMs: 0, sections, scopes, redo: built.plan.redo, mappings: request.mappings ?? {},
    complete: sections.every(section => section.balanced) && scopes.every(scope => scope.ok),
  };
  const knownValues = (built.writes.rows.get("role_memory")?.records.length ?? 0) > 0;
  const ledger: LedgerRow = {
    kind: "import", importId, bundleSha256: decoded.sha256, exportId: decoded.header.exportId, sourceProduct: decoded.header.product,
    appliedAt: now, mappings: request.mappings ?? {}, aliases: built.writes.aliases, pending: built.writes.pending,
    versions: built.writes.versions, scopeHistories: built.writes.scopeHistories, accounts: built.plan.accounts, report,
    unapplied: built.plan.sections.flatMap(section => [...unappliedRecords.get(section) ?? []]).sort(),
    followUp: { knownValues, accounts: built.plan.accounts.some(account => account.action === "create") },
  };

  let committed = false;
  let restoreFailed = false;
  /* The commit threw and whether it landed could not be read: nothing is
     undone here, and recovery decides once the database answers. */
  let commitUnknown = false;
  let committedBindings: { engine: "claude" | "codex"; accountId: string; project: string }[] = [];
  const wrote = new Set<number>();
  diskFull = false;
  try {
    /* Accounts first, before any file: every account to be made gets its id
       now, held by an empty home, so the commit can bind projects to it and a
       stop after the commit makes exactly that account (§4.7, §3.5). */
    if (built.writes.accountRecords.length) {
      await reserveAccounts(built.plan.accounts, options.accounts, (engine, id) => { journal.reservations.push({ engine, id }); writeJournal(directory, journal); });
      if (fault === "die-after-reservations") dieForTest();
      initializeImportedAccountRows();
      const { rows, bindings } = await accountCommitRows(importId, decoded.header.exportId, built.writes.accountRecords, built.plan.accounts, {
        now, canonical: project => canonicalProject(project.trim()), deps: options.accounts,
      });
      const ready = bindingsCollectionReady();
      const held = readTargetRows("accounts")?.rows ?? new Map<string, string>();
      const accountRows: StoredRow[] = [];
      if (!ready.headPresent && bindings.length) accountRows.push({ key: "meta:binding", value: { k: "meta:binding", v: { schemaVersion: 1 } } });
      for (const binding of bindings) {
        const key = `binding:${binding.engine}:${binding.accountId}:${binding.project}`;
        if (!held.has(key) && !accountRows.some(row => row.key === key)) accountRows.push({ key, value: { k: key, v: binding } });
      }
      if (accountRows.length) built.writes.rows.set("accounts", { part: null, records: accountRows });
      committedBindings = bindings;
      built.writes.rows.set(TRANSFER_ACCOUNTS_COLLECTION, { part: null, records: rows.map(row => ({ key: transferAccountKey(row), value: row })) });
    }
    ledger.accountKeys = [...new Set([
      ...built.plan.accounts.map(account => transferAccountKey({ engine: account.engine, sourceId: account.sourceId, targetId: account.action === "skip" ? null : account.plannedId })),
      ...built.writes.replayedAccountKeys,
    ])].sort();

    const files = [...built.writes.files.values()];
    withFileLocks(files.map(file => path.join(targetRoot(file.root), file.relative)), () => {
      try {
        /* Every file still holds what the dry run read, checked under its lock
           before the first byte is written, so a writer that came between
           refuses the import with nothing written. */
        const asPlanned = (file: PlannedFile) => fileRevision(file.root, file.relative) === built.plan.revisions[`file:${file.root}:${file.relative}`]
          && targetFileKind(file.root, file.relative) !== "unsupported";
        for (const file of files) {
          if (!asPlanned(file)) throw new TransferImportError("target_changed", "this install changed since the preview; preview again");
        }
        /* The journal names every original before the first is made, so a stop
           in between leaves no name recovery does not know to remove. */
        for (const file of files) {
          const before = currentHash(path.join(targetRoot(file.root), file.relative));
          journal.files.push({ root: file.root, relative: file.relative, before, written: sha256Of(file.text), backup: before === null ? null : { relative: backupRelative(file.relative, importId) }, changes: file.changes });
        }
        writeJournal(directory, journal);
        for (const entry of journal.files) {
          if (!entry.backup) continue;
          const target = journalTarget(entry);
          const copy = path.join(targetRoot(entry.root), entry.backup.relative);
          try { linkFile(target, copy); }
          catch { allocate(); fs.copyFileSync(target, copy, fs.constants.COPYFILE_EXCL); fsyncPath(copy); }
        }
        for (const directoryOfBackup of new Set(journal.files.filter(entry => entry.backup).map(entry => path.dirname(journalTarget(entry))))) fsyncPath(directoryOfBackup);
        if (fault === "die-after-checkpoint") dieForTest();
        for (const [index, file] of files.entries()) {
          /* Again just before the write: a writer that skips the lock and came
             in since refuses the import, and keeps what it wrote. Every writer
             of these files in this product takes the same lock, so none can
             come in between this check and the rename. */
          if (!asPlanned(file)) throw new TransferImportError("target_changed", "this install changed since the preview; preview again");
          options.beforeFileWrite?.(index);
          fs.writeFileSync(writingMarker(directory, index), "", { flag: "wx", mode: 0o600 });
          const target = path.join(targetRoot(file.root), file.relative);
          if (journal.files[index]!.before === null) {
            /* A file the dry run found absent is created only if it still is:
               a writer that made it since, lock or no lock, keeps it. */
            try {
              allocate();
              createFileExclusive(target, file.text, { staging: stagingPath(file, importId), beforeLink: () => { if (fault === "die-before-link") dieForTest(); } });
            }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") { wrote.add(index); throw error; }
              fs.rmSync(writingMarker(directory, index), { force: true });
              throw new TransferImportError("target_changed", "this install changed since the preview; preview again");
            }
            wrote.add(index);
          } else {
            wrote.add(index);
            writeAtomic(target, file.text, stagingPath(file, importId));
          }
          if (index === 0 && fault === "file-step") throw new Error("injected file step failure");
          if (index === 0 && fault === "disk-full") diskFull = true;
          options.afterFileWrite?.(index);
        }
        if (fault === "die-after-files") dieForTest();
        report.applyMs = Math.round(performance.now() - started);
        try { writeCollections(built.writes, ledger, built.plan.revisions, fault); }
        catch (error) {
          /* A step after COMMIT can throw too (securing the database files):
             the ledger row, committed with every other row, decides whether
             this import stands, never the throw. */
          let landed: boolean;
          try { landed = importCommitted(importId); }
          catch (readError) {
            commitUnknown = true;
            throw new Error(`the import's commit failed and whether it landed cannot be read yet (${readError instanceof Error ? readError.message : String(readError)}); recovery settles it`, { cause: error });
          }
          if (!landed) throw error;
        }
        committed = true;
      } catch (error) {
        /* Undone under the same locks, before any waiting writer runs. An
           undo that fails leaves the journal open: recovery finishes it, and
           the Viewer admits no work until it has. */
        if (!committed && !commitUnknown) {
          try { restoreFiles(directory, journal, wrote); }
          catch (restoreError) { restoreFailed = true; throw new Error(`the import failed and could not be undone yet: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, { cause: error }); }
        }
        throw error;
      }
    });
  } catch (error) {
    if (!committed && !restoreFailed && !commitUnknown) {
      for (const reservation of journal.reservations) {
        try { await releaseReservation(reservation.engine, reservation.id, options.accounts); } catch { /* kept: an empty home blocks only its own id */ }
      }
      settleJournal(directory, journal, "rolled-back");
    }
    throw error;
  }
  if (fault === "die-after-commit") dieForTest();
  settleJournal(directory, journal, "done");
  /* The fences are read back from the owner's own reader before the report
     may say the import is complete. */
  if (committedBindings.length) {
    const { accountProjectBindings } = await import("@/lib/accounts/projectBindings");
    const held = accountProjectBindings();
    const confirmed = committedBindings.every(binding => held.some(row => row.engine === binding.engine && row.accountId === binding.accountId && row.project === binding.project));
    if (!confirmed) { report.complete = false; patchLedger(ledger); }
  }
  fs.rmSync(stagedPath(decoded.sha256), { force: true });
  await finishFollowUp(ledger, options.accounts, fault);
  await options.afterCommit?.(ledger);
  /* The import record holds the time up to its own commit; the caller gets
     the whole apply, the commit and the cleanup included. */
  const accounts = accountReportRows(importAccountRows(ledger));
  return { report: { ...report, applyMs: Math.round(performance.now() - started), accounts, accountsReady: accountsReady(accounts) }, ledger };
}

/** The work after a commit, each step recorded done in the import record once
    it is: the lesson known values (§4.8: the publication gate reads every
    stored lesson, and refuses while the file is missing) and the accounts the
    commit reserved. A step that fails stays recorded for the next recovery. */
async function finishFollowUp(ledger: LedgerRow, deps: AccountTargetDeps | undefined, fault: TransferFault | null = null): Promise<void> {
  if (ledger.followUp.knownValues) {
    try {
      refreshLessonKnownValues();
      ledger.followUp = { ...ledger.followUp, knownValues: false };
      patchLedger(ledger);
    } catch { /* removed on failure, so the gate refuses until it is rewritten; the next recovery tries again */ }
  }
  if (ledger.followUp.accounts) {
    await finishAccountCreation({ importId: ledger.importId }, deps);
    if (fault === "die-after-accounts") dieForTest();
    ledger.followUp = { ...ledger.followUp, accounts: false };
    patchLedger(ledger);
  }
}

function patchLedger(ledger: LedgerRow): void {
  const held = ledgerCollection(true)!;
  try { held.patchSync(() => ({ records: [ledger] })); }
  finally { held.close(); }
}

/* ── Recovery ────────────────────────────────────────────────────────── */

export interface RecoveryOutcome { importId: string; outcome: "finished" | "rolled-back"; kept?: string[] }

/** Settle every import a stopped worker or Viewer left between its first
    write and its cleanup: committed (its ledger row exists) → finish;
    not → undo what it wrote and give back its reservations. Then finish the
    work after every commit that a stop cut short. Idempotent; a failure
    throws, and the journal stays for the next attempt. */
export async function recoverTransferImports(deps?: AccountTargetDeps): Promise<RecoveryOutcome[]> {
  const root = path.join(transferRoot(), "imports");
  let names: string[];
  try {
    readFault("imports");
    names = fs.readdirSync(root).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new TransferImportError("recovery_unreadable", `the list of interrupted imports cannot be read (${code ?? "error"})`);
    names = [];
  }
  const outcomes: RecoveryOutcome[] = [];
  for (const name of names) {
    const directory = path.join(root, name);
    const journal = readJournal(directory);
    if (!journal || journal.state !== "writing") continue;
    let committed: boolean;
    try { committed = importCommitted(journal.importId); }
    catch (error) {
      throw new TransferImportError("recovery_unreadable", `whether import ${journal.importId} committed cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}); it is kept for the next attempt`);
    }
    if (committed) {
      settleJournal(directory, journal, "done");
      outcomes.push({ importId: journal.importId, outcome: "finished" });
    } else {
      const { kept } = await rollBack(directory, journal, deps);
      outcomes.push({ importId: journal.importId, outcome: "rolled-back", ...(kept.length ? { kept } : {}) });
    }
  }
  for (const row of readImportRecords()) {
    if (row.followUp?.knownValues || row.followUp?.accounts) await finishFollowUp(row, deps);
  }
  /* An account whose setup failed after an earlier commit is tried again
     here too, under the same reserved id, so no operator step is needed. */
  if (importedAccountRows().some(row => row.pendingCreate)) await finishAccountCreation({}, deps);
  return outcomes;
}

/** The Viewer's startup step, under the release fence and the account lock
    spawn admission takes. Its failure is the Viewer's: activation stops
    until the same journal settles (`registerViewerRuntime`). */
export async function recoverTransferImportsAtStartup(deps?: AccountTargetDeps): Promise<RecoveryOutcome[]> {
  const directory = stateDir();
  if (!fs.existsSync(path.join(directory, "transfer", "imports"))) return [];
  assertStateStartupMutation(directory, "install transfer recovery");
  const { withAccountMutationLockAsync } = await import("@/lib/accounts/accountMutation");
  return withAccountMutationLockAsync(() => recoverTransferImports(deps), { holder: "install transfer recovery" });
}

export function readTransferReport(importId?: string): LedgerRow | null {
  const rows = readImportRecords();
  const row = importId ? rows.find(candidate => candidate.importId === importId) : rows.at(-1);
  if (importId && !row) throw new TransferImportError("unknown_import", "no import with that id on this install");
  return row ?? null;
}
