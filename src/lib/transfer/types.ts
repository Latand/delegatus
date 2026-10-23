/* The transfer bundle (docs/design/install-memory-transfer.md §2.1) and the
   shapes the dry run, apply and report hand to callers. Text only: nothing
   here touches the disk, so the CLI's JSON and a browser page can read it. */

export const TRANSFER_FORMAT = "delegatus-transfer";
export const TRANSFER_VERSION = 1;

/** Sections this release writes and reads, in bundle order. `seats`, `board`,
    `history` and `browser` belong to later slices; a bundle that carries one
    is shown as "needs a newer Delegatus" and skipped. */
export const SECTION_NAMES = [
  "memory.role",
  "memory.profile",
  "memory.settings",
  "memory.calls",
  "settings.seat",
  "settings.roles",
  "settings.limits",
  "settings.projects",
  "settings.operator",
  "settings.voice",
  "settings.forge",
  "settings.relay",
  "settings.telegram",
  "accounts",
] as const;
export type SectionName = typeof SECTION_NAMES[number];

export const isSectionName = (value: unknown): value is SectionName => (SECTION_NAMES as readonly unknown[]).includes(value);

export interface SectionHeader {
  name: string;
  schema: number;
  records: number;
  bytes: number;
  sha256: string;
  summary: Record<string, unknown>;
}

/** A project the bundle names, listed once with its current key on the source. */
export interface BundleProject {
  key: string;
  /** `repository`: a key from an origin remote, the same on every machine.
      `folder`: a key from a path (a folder, or a repository without origin),
      which the target must map to a folder of its own. */
  kind: "repository" | "folder";
  displayName: string;
  remote?: string;
}

export interface BundleAccount {
  engine: "claude" | "codex" | "copilot";
  id: string;
  label: string;
  kind: "legacy" | "managed";
  active: boolean;
  /** SHA-256 of the login identity the provider reported to the source, or null when none was read. */
  identity: string | null;
}

export interface BundleEnvironmentEntry {
  name: string;
  value?: string;
}

export interface BundleNotice {
  code: "engine_memory_not_imported";
  files: number;
  /** `import`: this install already uses Delegatus memory, and these files are
      not among what its import from the engines took in (added or changed
      since, or the choice arrived by an earlier transfer). Absent: it never
      switched. Either way the memory source import takes them in. */
  since?: "import";
}

export interface BundleHeader {
  format: typeof TRANSFER_FORMAT;
  version: typeof TRANSFER_VERSION;
  exportId: string;
  createdAt: string;
  product: string;
  /** Uncompressed bytes of the whole bundle, trailer included: the import's decompression bound. */
  bytes: number;
  sections: SectionHeader[];
  projects: BundleProject[];
  accounts: BundleAccount[];
  environment: BundleEnvironmentEntry[];
  notices: BundleNotice[];
}

export interface BundleRecord {
  s: string;
  /** `<part>|<key within the part>`. */
  k: string;
  v: unknown;
}

export interface DecodedBundle {
  header: BundleHeader;
  records: BundleRecord[];
  /** SHA-256 of the plain bundle bytes as received: the import's identity for this bundle. */
  sha256: string;
}

export type RecordOutcome = "new" | "same" | "conflict" | "skipped";

export interface SectionPlan {
  name: string;
  records: number;
  new: number;
  same: number;
  conflict: number;
  skipped: number;
  /** Count of skipped records per reason. */
  skippedReasons: Record<string, number>;
  /** The keys in conflict and what apply will do with each. */
  conflicts: { key: string; action: "kept-target" | "took-source" | "stored-as-version" | "merged" }[];
  /** Records kept in the import record until their target connects (relay, Telegram, voice tools). */
  pending: number;
  replace: boolean;
}

export interface ProjectPlan extends BundleProject {
  /** The key records arrive under on this install, or null while a folder key is unmapped. */
  target: string | null;
  state: "repository" | "mapped" | "unmapped" | "remembered";
}

export interface ScopeFigures {
  rules: number;
  active: number;
  codePoints: number;
  history: number;
}

export interface AccountPlan {
  engine: BundleAccount["engine"];
  sourceId: string;
  label: string;
  kind: BundleAccount["kind"];
  sourceActive: boolean;
  /** `create`: a managed account made signed out; `legacy`: the target's own engine home;
      `existing`: a target account with this id is already there. */
  action: "create" | "legacy" | "existing" | "skip";
  plannedId: string | null;
  bindings: string[];
  reason?: string;
}

export interface RedoItem {
  code:
    | "account_sign_in" | "api_keys" | "telegram_bot" | "relay_pairing" | "forge_app_credential"
    | "access_and_team" | "voice_tools" | "subscription_consent" | "environment" | "unmapped_project"
    | "manual_project_folder" | "memory_source" | "machine_worker_limit" | "browser_preferences";
  detail?: string;
  count?: number;
}

export interface TransferPlan {
  bundleSha256: string;
  exportId: string;
  createdAt: string;
  sourceProduct: string;
  sections: SectionPlan[];
  unknownSections: string[];
  projects: ProjectPlan[];
  accounts: AccountPlan[];
  overBudgetScopes: { scope: string; codePoints: number }[];
  redo: RedoItem[];
  environment: BundleEnvironmentEntry[];
  notices: BundleNotice[];
  /** Target revision per store the import will write, as read by this dry run. */
  revisions: Record<string, string>;
  /** Present when this exact bundle was imported before. */
  previousImport: { importId: string; at: string } | null;
}

export interface TransferImportRequest {
  bundleSha256: string;
  revisions: Record<string, string>;
  /** Source folder key → a folder on this install. */
  mappings?: Record<string, string>;
  /** Sections whose conflicting records take the source's value. */
  replace?: string[];
}

export interface AccountReportRow {
  engine: BundleAccount["engine"];
  sourceId: string;
  targetId: string | null;
  label: string;
  /** `unchecked`: signed in here, its live limit read not taken yet.
      `not_created`: the account could not be made here (a provider account
      needs its token; a failed setup names its cause in `detail`). */
  state: "signed_out" | "unchecked" | "usable" | "different_account" | "read_failed" | "not_needed" | "not_created";
  detail?: string;
  bindings: string[];
  activeOnSource: boolean;
  /** A `not_created` row whose reserved account «Try again» can still make. */
  retry?: boolean;
}

export interface SectionReport {
  name: string;
  records: number;
  new: number;
  same: number;
  conflict: number;
  skipped: number;
  pending: number;
  /** Records = new + same + conflict + skipped; false fails the section in the report. */
  balanced: boolean;
}

export interface TransferReport {
  importId: string;
  bundleSha256: string;
  exportId: string;
  sourceProduct: string;
  appliedAt: string;
  /** Milliseconds from the start of apply: to the end of apply in the answer,
      to the start of the commit in the stored import record. */
  applyMs: number;
  sections: SectionReport[];
  scopes: { scope: string; source: ScopeFigures; target: ScopeFigures; ok: boolean; overBudget: boolean }[];
  accounts: AccountReportRow[];
  redo: RedoItem[];
  mappings: Record<string, string>;
  /** Every section balanced and every scope's active rules present (§5.1). */
  complete: boolean;
  /** Every account usable here or marked not needed (§5.2); the import is done when this holds too. */
  accountsReady: boolean;
}
