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
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { assertStateStartupMutation } from "@/lib/stateOwnership";

import { accountReportRows, accountsReady, applyAccounts, importedAccountRows, planAccounts, validAccountRecord, type AccountTargetDeps } from "./accounts";
import { decodeBundle, splitRecordKey } from "./bundle";
import { remapText, resolveAliasChain } from "./projectKeys";
import { planRoleMemory, scopeFigures, validRoleRecord } from "./roleMemory";
import { partById, PARTS, type MapPart, type Part, type RowsPart } from "./sections";
import { fileRevision, legacyStoreImported, readTargetRows, readTargetText, targetRoot, writeFileAtomic, type StoredRow } from "./stores";
import {
  isSectionName,
  type AccountPlan, type BundleProject, type DecodedBundle, type ProjectPlan, type RedoItem, type ScopeFigures,
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
  constructor(readonly code: "not_staged" | "target_changed" | "bad_mapping" | "unknown_import", message: string) {
    super(message);
    this.name = "TransferImportError";
  }
}

export type TransferFault = "file-step" | "sqlite" | "die-after-checkpoint" | "die-after-files" | "die-after-commit";

/** Fault injection for the exit tests; read only under `bun test`. */
function injectedFault(): TransferFault | null {
  if (process.env.NODE_ENV !== "test") return null;
  const value = process.env.LLV_TRANSFER_TEST_FAULT ?? "";
  return (["file-step", "sqlite", "die-after-checkpoint", "die-after-files", "die-after-commit"] as const).find(fault => fault === value) ?? null;
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
  /** The source's history of every scope merged into one this install already had. */
  scopeHistories: Record<string, unknown[]>;
  accounts: AccountPlan[];
  /** Account and binding records, applied after the commit; kept so an
      interrupted apply can finish them without the bundle. */
  accountRecords: StoredRow[];
  accountsApplied: boolean;
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

function readImportRecord(importId: string): LedgerRow | null {
  const held = ledgerCollection(false);
  if (!held) return null;
  try { return held.get(`i:${importId}`); }
  finally { held.close(); }
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

interface PlannedWrites {
  rows: Map<string, { part: RowsPart | null; records: { key: string; value: unknown }[] }>;
  files: Map<string, { root: "state" | "config"; relative: string; text: string }>;
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
  accountRecords: StoredRow[];
}

interface Built {
  plan: TransferPlan;
  writes: PlannedWrites;
  sourceScopes: Record<string, ScopeFigures>;
}

function emptySectionPlan(name: string, records: number, replace: boolean): SectionPlan {
  return { name, records, new: 0, same: 0, conflict: 0, skipped: 0, skippedReasons: {}, conflicts: [], pending: 0, replace };
}

function count(plan: SectionPlan, outcome: "new" | "same" | "conflict" | "skipped", key: string, detail?: string, action?: SectionPlan["conflicts"][number]["action"]) {
  plan[outcome] += 1;
  if (outcome === "skipped") plan.skippedReasons[detail ?? "skipped"] = (plan.skippedReasons[detail ?? "skipped"] ?? 0) + 1;
  if (outcome === "conflict") plan.conflicts.push({ key, action: action ?? "kept-target" });
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
  const writes: PlannedWrites = { rows: new Map(), files: new Map(), pending: [], versions: {}, aliases: [], roleRowsAfter: [], sourceActive: new Map(), keptAsVersion: new Set(), scopeHistories: {}, accountRecords: [] };
  const sectionPlans = new Map<string, SectionPlan>();
  const unknownSections = decoded.header.sections.filter(section => !isSectionName(section.name) || section.schema !== 1).map(section => section.name);
  for (const section of decoded.header.sections) sectionPlans.set(section.name, emptySectionPlan(section.name, section.records, replace.has(section.name as never)));

  const byPart = new Map<string, { section: string; rows: StoredRow[] }>();
  for (const record of decoded.records) {
    const sectionPlan = sectionPlans.get(record.s)!;
    if (unknownSections.includes(record.s)) { count(sectionPlan, "skipped", record.k, "needs-newer-delegatus"); continue; }
    const { part, key } = splitRecordKey(record.k);
    const row = { key: remap(key), value: JSON.parse(remap(JSON.stringify(record.v))) as unknown };
    if (record.s === "accounts") {
      /* Counted new here; the account plan, which reads this install's
         accounts, settles which already exist (§3). */
      if (part !== "accounts" || !validAccountRecord(row.key, row.value)) { count(sectionPlan, "skipped", record.k, "invalid-record"); continue; }
      writes.accountRecords.push(row);
      count(sectionPlan, "new", record.k);
      continue;
    }
    if (!partById.has(part) || partById.get(part)!.section !== record.s) { count(sectionPlan, "skipped", record.k, "unknown-part"); continue; }
    const entry = byPart.get(part) ?? { section: record.s, rows: [] };
    entry.rows.push(row);
    byPart.set(part, entry);
  }

  /* Files are planned per file, since several parts can share one. */
  const fileState = new Map<string, { root: "state" | "config"; relative: string; object: Record<string, unknown> | unknown[] | string | null; original: unknown; changed: boolean }>();
  const fileFor = (root: "state" | "config", relative: string, parse: "json" | "text") => {
    const id = `${root}:${relative}`;
    let state = fileState.get(id);
    if (!state) {
      const text = readTargetText(root, relative);
      let object: Record<string, unknown> | unknown[] | string | null = null;
      if (text !== null) {
        if (parse === "text") object = text;
        else { try { object = JSON.parse(text) as Record<string, unknown>; } catch { object = null; } }
      }
      state = { root, relative, object, original: structuredClone(object), changed: false };
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
          count(plan, "skipped", `${part.id}|${row.key}`, `pending:${part.reason}`);
          plan.pending += 1;
          writes.pending.push({ part: part.id, key: row.key, value: row.value });
        }
        break;
      case "rows":
        planRows(part, entry.rows, plan, take, writes, revisions, folders, now);
        break;
      case "map": {
        const file = fileFor(part.root, part.file, "json");
        if (file.object !== null && !isRecordObject(file.object)) {
          for (const row of entry.rows) count(plan, "skipped", `${part.id}|${row.key}`, "target-file-unreadable");
          break;
        }
        /* What the target held before this import: an absent file holds
           nothing, whatever defaults its skeleton writes. */
        const original = file.original === null ? undefined : at(file.original, part.path);
        for (const row of entry.rows) {
          if (!part.accept?.(row.key, row.value)) { count(plan, "skipped", `${part.id}|${row.key}`, "invalid-record"); continue; }
          const container = mapContainer(file, part);
          const held = isRecordObject(original) ? original[row.key] : undefined;
          const outcome = planValue(held, row.value, part.merge, take);
          count(plan, outcome.outcome, `${part.id}|${row.key}`, undefined, outcome.action);
          if (outcome.write) { container[row.key] = row.value; file.changed = true; }
        }
        break;
      }
      case "set": {
        const file = fileFor(part.root, part.file, "json");
        if (file.object !== null && !Array.isArray(file.object)) {
          for (const row of entry.rows) count(plan, "skipped", `${part.id}|${row.key}`, "target-file-unreadable");
          break;
        }
        const list = (file.object ??= []) as unknown[];
        for (const row of entry.rows) {
          if (typeof row.value !== "string" || !part.accept?.(row.key, row.value)) { count(plan, "skipped", `${part.id}|${row.key}`, "invalid-record"); continue; }
          if (list.includes(row.value)) count(plan, "same", row.key);
          else { list.push(row.value); file.changed = true; count(plan, "new", row.key); }
        }
        break;
      }
      case "text":
        for (const row of entry.rows) {
          const relative = part.fileOf(row.key);
          if (typeof row.value !== "string" || !part.accept?.(row.key, row.value) || row.key.includes("..") || path.isAbsolute(row.key) || path.normalize(relative) !== relative) {
            count(plan, "skipped", `${part.id}|${row.key}`, "invalid-record");
            continue;
          }
          const file = fileFor(part.root, relative, "text");
          const outcome = planValue(file.object === null ? undefined : file.object, row.value, part.merge, take);
          count(plan, outcome.outcome, `${part.id}|${row.key}`, undefined, outcome.action);
          if (outcome.write) { file.object = row.value; file.changed = true; }
        }
        break;
    }
  }

  for (const state of fileState.values()) {
    if (!state.changed) continue;
    const text = typeof state.object === "string" ? state.object : `${JSON.stringify(state.object, null, 2)}\n`;
    writes.files.set(`${state.root}:${state.relative}`, { root: state.root, relative: state.relative, text });
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
  part: RowsPart, rows: readonly StoredRow[], plan: SectionPlan, take: boolean, writes: PlannedWrites,
  revisions: Record<string, string>, folders: ReadonlyMap<string, string>, now: string,
) {
  if (part.legacyDocument && !legacyStoreImported(part.collection)) {
    for (const row of rows) count(plan, "skipped", `${part.id}|${row.key}`, "target-store-not-migrated");
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
    if (!ok) count(plan, "skipped", `${part.id}|${row.key}`, "invalid-record");
    return ok;
  });
  if (part.merge === "role-memory") {
    const role = planRoleMemory(valid, held, { now });
    for (const outcome of role.outcomes) count(plan, outcome.outcome, `${part.id}|${outcome.key}`, undefined, outcome.action);
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
      if (!folder) { count(plan, "skipped", `${part.id}|${row.key}`, "manual-project-without-folder"); continue; }
      value = { ...document, value: { ...document.value, entry: { ...document.value.entry, root: folder } } };
    }
    const current = held.get(row.key);
    const currentValue = current === undefined ? undefined : JSON.parse(current) as unknown;
    if (part.merge === "curation" && currentValue !== undefined && isRecordObject(currentValue) && isRecordObject(value)) {
      if (sameValue(currentValue, value)) { count(plan, "same", row.key); continue; }
      const later = typeof value.lastAt === "string" && (typeof currentValue.lastAt !== "string" || value.lastAt > currentValue.lastAt);
      if (later) out.records.push({ key: row.key, value: { ...currentValue, lastAt: value.lastAt } });
      count(plan, "conflict", `${part.id}|${row.key}`, undefined, later ? "merged" : "kept-target");
      continue;
    }
    const outcome = planValue(currentValue, value, part.merge === "absent-only" ? "absent-only" : "default", take);
    count(plan, outcome.outcome, `${part.id}|${row.key}`, undefined, outcome.action);
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
  const plans = await planAccounts(built.writes.accountRecords, deps);
  const section = built.plan.sections.find(candidate => candidate.name === "accounts");
  for (const account of plans) {
    if (!section) break;
    if (account.action === "existing") { section.new -= 1; section.same += 1; }
    else if (account.action === "skip") { section.new -= 1; count(section, "skipped", `accounts|account:${account.engine}:${account.sourceId}`, account.reason ?? "skipped"); }
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

/** After the commit: the accounts, signed out, and their bindings (§3.5); then the record says so. */
async function finishAccounts(ledger: LedgerRow, deps: AccountTargetDeps | undefined): Promise<void> {
  if (ledger.accountsApplied) return;
  await applyAccounts(ledger.importId, ledger.exportId, ledger.accountRecords, deps);
  const held = ledgerCollection(true)!;
  try { held.patchSync(() => ({ records: [{ ...ledger, accountsApplied: true }] })); }
  finally { held.close(); }
  ledger.accountsApplied = true;
}

/* ── Apply ───────────────────────────────────────────────────────────── */

interface Journal {
  importId: string;
  state: "writing" | "done" | "rolled-back";
  at: string;
  replaced: { root: "state" | "config"; relative: string; backup: string }[];
  created: { root: "state" | "config"; relative: string }[];
}

function writeJournal(directory: string, journal: Journal): void {
  writeFileAtomic(path.join(directory, "journal.json"), `${JSON.stringify(journal)}\n`);
}

function readJournal(directory: string): Journal | null {
  try { return JSON.parse(fs.readFileSync(path.join(directory, "journal.json"), "utf8")) as Journal; }
  catch { return null; }
}

/** Put every replaced file back and remove every created one. */
function restoreFromCheckpoint(directory: string, journal: Journal): void {
  for (const entry of journal.replaced) {
    const backup = path.join(directory, "checkpoint", entry.backup);
    writeFileAtomic(path.join(targetRoot(entry.root), entry.relative), fs.readFileSync(backup, "utf8"));
  }
  for (const entry of journal.created) fs.rmSync(path.join(targetRoot(entry.root), entry.relative), { force: true });
  writeJournal(directory, { ...journal, state: "rolled-back" });
  fs.rmSync(path.join(directory, "checkpoint"), { recursive: true, force: true });
}

function finishCommitted(directory: string, journal: Journal): void {
  fs.rmSync(path.join(directory, "checkpoint"), { recursive: true, force: true });
  writeJournal(directory, { ...journal, state: "done" });
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
      beforeCommit: () => { if (fault === "sqlite") throw new Error("injected SQLite failure"); },
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
  const fault = injectedFault();
  const importId = crypto.randomUUID();
  const directory = importDirectory(importId);
  fs.mkdirSync(path.join(directory, "checkpoint"), { recursive: true, mode: 0o700 });
  const journal: Journal = { importId, state: "writing", at: now, replaced: [], created: [] };
  for (const [index, file] of [...built.writes.files.values()].entries()) {
    const target = path.join(targetRoot(file.root), file.relative);
    if (fs.existsSync(target)) {
      const backup = `${index}`;
      fs.copyFileSync(target, path.join(directory, "checkpoint", backup));
      fsyncPath(path.join(directory, "checkpoint", backup));
      journal.replaced.push({ root: file.root, relative: file.relative, backup });
    } else journal.created.push({ root: file.root, relative: file.relative });
  }
  fsyncPath(path.join(directory, "checkpoint"));
  writeJournal(directory, journal);
  if (fault === "die-after-checkpoint") dieForTest();

  const sections: SectionReport[] = built.plan.sections.map(section => ({
    name: section.name, records: section.records, new: section.new, same: section.same, conflict: section.conflict, skipped: section.skipped, pending: section.pending,
    balanced: section.new + section.same + section.conflict + section.skipped === section.records,
  }));
  const targetScopes = scopeFigures(built.writes.roleRowsAfter);
  const scopes = Object.entries(built.sourceScopes).sort(([a], [b]) => a.localeCompare(b)).map(([scope, source]) => {
    const target = targetScopes.get(scope) ?? { rules: 0, active: 0, codePoints: 0, history: 0 };
    /* §5.1: every source active id is active here or kept as a version of
       this install's rule, and nothing was lost from the active count. */
    const activeHere = new Set(built.writes.roleRowsAfter.find((row): row is Extract<RoleMemoryRow, { kind: "scope" }> => row.kind === "scope" && row.scope === scope)?.active ?? []);
    const everyActive = (built.writes.sourceActive.get(scope) ?? []).every(id => activeHere.has(id) || built.writes.keptAsVersion.has(id));
    return { scope, source, target, ok: everyActive && target.active >= source.active, overBudget: target.codePoints > 10_000 };
  });
  const report: Omit<TransferReport, "accounts" | "accountsReady"> = {
    importId, bundleSha256: decoded.sha256, exportId: decoded.header.exportId, sourceProduct: decoded.header.product,
    appliedAt: now, applyMs: 0, sections, scopes, redo: built.plan.redo, mappings: request.mappings ?? {},
    complete: sections.every(section => section.balanced) && scopes.every(scope => scope.ok),
  };
  const ledger: LedgerRow = {
    kind: "import", importId, bundleSha256: decoded.sha256, exportId: decoded.header.exportId, sourceProduct: decoded.header.product,
    appliedAt: now, mappings: request.mappings ?? {}, aliases: built.writes.aliases, pending: built.writes.pending,
    versions: built.writes.versions, scopeHistories: built.writes.scopeHistories, accounts: built.plan.accounts, report,
    accountRecords: built.writes.accountRecords, accountsApplied: built.writes.accountRecords.length === 0,
  };
  try {
    let first = true;
    for (const file of built.writes.files.values()) {
      const target = path.join(targetRoot(file.root), file.relative);
      /* Under the file's own write lock, which its store's writers take too,
         and only while it still holds what the dry run read. */
      withFileTransactionSync(target, "the install transfer is waiting for a settings file", () => {
        if (fileRevision(file.root, file.relative) !== built.plan.revisions[`file:${file.root}:${file.relative}`]) {
          throw new TransferImportError("target_changed", "this install changed since the preview; preview again");
        }
        writeFileAtomic(target, file.text);
      });
      if (first && fault === "file-step") throw new Error("injected file step failure");
      first = false;
    }
    if (fault === "die-after-files") dieForTest();
    report.applyMs = Math.round(performance.now() - started);
    writeCollections(built.writes, ledger, built.plan.revisions, fault);
  } catch (error) {
    restoreFromCheckpoint(directory, journal);
    throw error;
  }
  if (fault === "die-after-commit") dieForTest();
  finishCommitted(directory, journal);
  fs.rmSync(stagedPath(decoded.sha256), { force: true });
  /* §4.8: the publication gate reads every stored lesson as a known value and
     refuses a push while that file is missing. */
  if (built.writes.rows.get("role_memory")?.records.length) {
    try { refreshLessonKnownValues(); } catch { /* removed on failure; the gate refuses until the next lesson rewrites it */ }
  }
  await finishAccounts(ledger, options.accounts);
  await options.afterCommit?.(ledger);
  /* The import record holds the time up to its own commit; the caller gets
     the whole apply, the commit and the cleanup included. */
  const accounts = accountReportRows(importedAccountRows().filter(row => row.importId === importId));
  return { report: { ...report, applyMs: Math.round(performance.now() - started), accounts, accountsReady: accountsReady(accounts) }, ledger };
}

/* ── Recovery ────────────────────────────────────────────────────────── */

export interface RecoveryOutcome { importId: string; outcome: "finished" | "rolled-back" }

/** Settle every import a stopped worker or Viewer left between its checkpoint
    and its cleanup: committed (its ledger row exists) → finish; not → restore.
    A committed import whose accounts were not made yet gets them now. */
export async function recoverTransferImports(deps?: AccountTargetDeps): Promise<RecoveryOutcome[]> {
  const root = path.join(transferRoot(), "imports");
  let names: string[] = [];
  try { names = fs.readdirSync(root).sort(); } catch { names = []; }
  const outcomes: RecoveryOutcome[] = [];
  for (const name of names) {
    const directory = path.join(root, name);
    const journal = readJournal(directory);
    if (!journal || journal.state !== "writing") continue;
    if (readImportRecord(journal.importId)) {
      finishCommitted(directory, journal);
      outcomes.push({ importId: journal.importId, outcome: "finished" });
    } else {
      restoreFromCheckpoint(directory, journal);
      outcomes.push({ importId: journal.importId, outcome: "rolled-back" });
    }
  }
  for (const row of readImportRecords()) if (row.accountsApplied === false) await finishAccounts(row, deps);
  return outcomes;
}

/** The Viewer's startup step, under the release fence. */
export async function recoverTransferImportsAtStartup(): Promise<RecoveryOutcome[]> {
  const directory = stateDir();
  if (!fs.existsSync(path.join(directory, "transfer", "imports"))) return [];
  assertStateStartupMutation(directory, "install transfer recovery");
  return recoverTransferImports();
}

export function readTransferReport(importId?: string): LedgerRow | null {
  const rows = readImportRecords();
  const row = importId ? rows.find(candidate => candidate.importId === importId) : rows.at(-1);
  if (importId && !row) throw new TransferImportError("unknown_import", "no import with that id on this install");
  return row ?? null;
}
