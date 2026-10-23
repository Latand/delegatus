import crypto from "node:crypto";

import { staticSensitiveClasses } from "@/lib/privacy/staticDetectors";
import type { RoleMemoryRow, RoleMemoryScopeRow } from "@/lib/memory/roleTypes";

import { encodeBundle, type EncodeSection } from "./bundle";
import { projectKeysIn, remapText, resolveAliasChain } from "./projectKeys";
import { scopeFigures } from "./roleMemory";
import { PARTS, type Part } from "./sections";
import { takeSourceSnapshot, type SourceSnapshot, type StoredRow } from "./stores";
import { SECTION_NAMES, type BundleAccount, type BundleEnvironmentEntry, type BundleNotice, type BundleProject, type SectionName } from "./types";

/* Export (docs/design/install-memory-transfer.md §2, §4.1): every chosen
   section read from one snapshot, every project key resolved through this
   install's aliases, and the finished records checked for secret-shaped
   strings before a byte is offered. */

export class TransferSecretError extends Error {
  constructor(readonly section: string, readonly key: string) {
    super(section === "header"
      ? `the export stopped: the bundle header's ${key} holds a secret-shaped string; clear that value on this install, then export again`
      : `the export stopped: a record in ${section} (${key}) holds a secret-shaped string; remove it from that record or leave the section out, then export again`);
    this.name = "TransferSecretError";
  }
}

/** Names whose values travel in the header's environment list. Every other
    `LLV_*` and `DELEGATUS_*` name travels without its value. */
const ENVIRONMENT_VALUE_ALLOWLIST = new Set(["LLV_AGENT_CPU", "LLV_CODEX_CREDIT_GUARD_USED_PERCENT", "LLV_LANG", "LLV_WORK_SCOPE_CPU_QUOTA"]);
/** Names the launcher and the Viewer set for themselves; they describe this process, not a setting. */
const ENVIRONMENT_INTERNAL = /^(?:LLV_STATE_OWNER|LLV_STATE_DIR|LLV_LAUNCHER_|LLV_SPAWN_CAPABILITY|LLV_RUNTIME_HOST_|LLV_VIEWER_GENERATION|LLV_BUN_EXECUTABLE|LLV_PRIVACY_)/;

export function environmentList(env: Readonly<Record<string, string | undefined>>): BundleEnvironmentEntry[] {
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const canonical = name.startsWith("DELEGATUS_") ? `LLV_${name.slice("DELEGATUS_".length)}` : name;
    if (!canonical.startsWith("LLV_") || ENVIRONMENT_INTERNAL.test(canonical)) continue;
    if (!names.has(canonical) || name.startsWith("DELEGATUS_")) names.set(canonical, value);
  }
  return [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ENVIRONMENT_VALUE_ALLOWLIST.has(name) ? { name, value } : { name });
}

export interface ProjectDirectory {
  aliases: Readonly<Record<string, string>>;
  displayNames: Readonly<Record<string, string>>;
  remotes: Readonly<Record<string, string>>;
}

export interface ExportOptions {
  sections?: readonly SectionName[];
  now?: Date;
  exportId?: string;
  product?: string;
  env?: Readonly<Record<string, string | undefined>>;
  projects?: ProjectDirectory;
  /** Engine memory files present and never imported into Delegatus memory (the export's notice). */
  engineMemoryNotImported?: () => Promise<BundleNotice | null>;
  /** Slice 2: the accounts section and the header's account list. */
  accounts?: (source: SourceSnapshot) => Promise<{ header: BundleAccount[]; records: StoredRow[] }>;
  snapshot?: () => SourceSnapshot;
}

export interface ExportResult {
  bytes: Buffer;
  exportId: string;
  sections: { name: string; records: number }[];
  notices: BundleNotice[];
}

function remapRows(rows: readonly StoredRow[], map: (key: string) => string, merge: (into: StoredRow, from: StoredRow) => void): StoredRow[] {
  const byKey = new Map<string, StoredRow>();
  for (const row of rows) {
    const key = remapText(row.key, map);
    const value = JSON.parse(remapText(JSON.stringify(row.value), map)) as unknown;
    const next = { key, value };
    const held = byKey.get(key);
    if (!held) { byKey.set(key, next); continue; }
    /* Two rows meet under one current key when a project moved and its old
       rows were not joined yet. The row already stored under the current key
       leads; a scope's lists are joined, as succession joins them. */
    if (row.key === key) { merge(next, held); byKey.set(key, next); }
    else merge(held, next);
  }
  return [...byKey.values()];
}

function joinScopes(into: StoredRow, from: StoredRow): void {
  const target = into.value as RoleMemoryRow;
  const source = from.value as RoleMemoryRow;
  if (target?.kind !== "scope" || source?.kind !== "scope") return;
  const scope = target as RoleMemoryScopeRow;
  const other = source as RoleMemoryScopeRow;
  scope.active = [...new Set([...scope.active, ...other.active])];
  scope.history = [...other.history, ...scope.history];
}

function walkStrings(value: unknown, visit: (text: string) => boolean): boolean {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) return value.some(item => walkStrings(item, visit));
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => visit(key) || walkStrings(item, visit));
  return false;
}

const secretShaped = (text: string) => text.length >= 12 && staticSensitiveClasses(text.normalize("NFKC")).has("credential");

/** A credential-shaped string anywhere in a record stops the export (§2.4 rule 2). */
export function assertNoSecrets(section: string, rows: readonly StoredRow[]): void {
  for (const row of rows) {
    if (walkStrings(row.value, secretShaped) || staticSensitiveClasses(row.key).has("credential")) {
      throw new TransferSecretError(section, row.key);
    }
  }
}

/** The same guard over the finished header: environment values, project names
    and remotes, account labels and notices travel outside the records. A hit
    names the field, never its value. */
export function assertHeaderHasNoSecrets(header: { projects: readonly BundleProject[]; accounts: readonly BundleAccount[]; environment: readonly BundleEnvironmentEntry[]; notices: readonly BundleNotice[]; [field: string]: unknown }): void {
  const fields: [string, unknown][] = [
    ...header.environment.map((entry): [string, unknown] => [`environment ${entry.name}`, entry]),
    ...header.projects.map((project): [string, unknown] => [`project ${project.key}`, project]),
    ...header.accounts.map((account): [string, unknown] => [`account ${account.engine}:${account.id}`, account]),
    ...header.notices.map((notice, index): [string, unknown] => [`notice ${index + 1}`, notice]),
    ...Object.entries(header).filter(([field]) => !["projects", "accounts", "environment", "notices", "sections"].includes(field)).map(([field, value]): [string, unknown] => [field, value]),
  ];
  for (const [field, value] of fields) if (walkStrings(value, secretShaped)) throw new TransferSecretError("header", field);
}

function sectionSummary(section: SectionName, records: readonly { k: string; v: unknown }[]): Record<string, unknown> {
  const parts: Record<string, number> = {};
  for (const record of records) {
    const part = record.k.slice(0, record.k.indexOf("|"));
    parts[part] = (parts[part] ?? 0) + 1;
  }
  if (section !== "memory.role") return { parts };
  const rows = records.filter(record => record.k.startsWith("rows:role_memory|")).map(record => record.v as RoleMemoryRow);
  return { parts, scopes: Object.fromEntries([...scopeFigures(rows)].sort(([a], [b]) => a.localeCompare(b))) };
}

export function projectDirectoryEntries(keys: Iterable<string>, directory: ProjectDirectory, manualNames: ReadonlyMap<string, string>): BundleProject[] {
  return [...new Set(keys)].sort().map(key => {
    const remote = directory.remotes[key];
    if (key.startsWith("repo-") && remote && !remote.startsWith("local:")) {
      return { key, kind: "repository", displayName: directory.displayNames[key] ?? remote.split("/").filter(Boolean).at(-1) ?? key, remote };
    }
    return { key, kind: "folder", displayName: directory.displayNames[key] ?? manualNames.get(key) ?? key };
  });
}

export async function exportTransferBundle(options: ExportOptions): Promise<ExportResult> {
  const chosen = new Set<SectionName>(options.sections ?? SECTION_NAMES);
  const now = options.now ?? new Date();
  const exportId = options.exportId ?? crypto.randomUUID();
  const directory = options.projects ?? { aliases: {}, displayNames: {}, remotes: {} };
  const canonical = (key: string) => resolveAliasChain(key, directory.aliases);
  const snapshot = (options.snapshot ?? takeSourceSnapshot)();
  try {
    const sections: EncodeSection[] = [];
    let accountHeader: BundleAccount[] = [];
    const manualNames = new Map<string, string>();
    for (const name of SECTION_NAMES) {
      if (!chosen.has(name)) continue;
      const records: { k: string; v: unknown }[] = [];
      const add = (partId: string, rows: readonly StoredRow[]) => {
        assertNoSecrets(name, rows);
        for (const row of rows) records.push({ k: `${partId}|${row.key}`, v: row.value });
      };
      if (name === "accounts") {
        if (!options.accounts) continue;
        const accounts = await options.accounts(snapshot);
        accountHeader = accounts.header;
        add("accounts", remapRows(accounts.records, canonical, () => {}));
      } else {
        for (const part of PARTS.filter((candidate: Part) => candidate.section === name)) {
          const rows = remapRows(part.collect(snapshot), canonical, part.id === "rows:role_memory" ? joinScopes : () => {});
          if (part.id === "rows:project_curation") {
            for (const row of rows) {
              const entry = (row.value as { value?: { entry?: { project?: unknown; displayName?: unknown } } }).value?.entry;
              if (typeof entry?.project === "string" && typeof entry.displayName === "string") manualNames.set(entry.project, entry.displayName);
            }
          }
          add(part.id, rows);
        }
      }
      sections.push({ name, schema: 1, summary: sectionSummary(name, records), records });
    }
    const keys = sections.flatMap(section => section.records.flatMap(record => [...projectKeysIn(record.k), ...projectKeysIn(JSON.stringify(record.v))]));
    const notices: BundleNotice[] = [];
    const engineMemory = await (options.engineMemoryNotImported?.() ?? Promise.resolve(null));
    if (engineMemory && engineMemory.files > 0) notices.push(engineMemory);
    const header = {
      exportId,
      createdAt: now.toISOString(),
      product: options.product ?? "unknown",
      projects: projectDirectoryEntries(keys, directory, manualNames),
      accounts: accountHeader,
      environment: environmentList(options.env ?? {}),
      notices,
    };
    assertHeaderHasNoSecrets(header);
    const bytes = encodeBundle({ ...header, sections });
    return { bytes, exportId, sections: sections.map(section => ({ name: section.name, records: section.records.length })), notices };
  } finally {
    snapshot.close();
  }
}
