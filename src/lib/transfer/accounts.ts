import crypto from "node:crypto";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";

import type { StoredRow } from "./stores";
import type { AccountPlan, AccountReportRow, BundleAccount } from "./types";

/* Accounts (docs/design/install-memory-transfer.md §3, operator decision Q1):
   every account the source uses travels as its registry facts only (engine,
   id, label, kind, active flag, project bindings) plus a hash of the login
   identity the provider reported. No credential is read. On the target each
   arrives signed out through the existing account setup, its bindings apply
   at once so a bound project parks rather than widens, and the operator signs
   it in from the accounts panel's checklist. A live limit read (`transfer-verify`)
   makes a row Usable; the source's active account becomes active here then. */

export type TransferEngine = "claude" | "codex" | "copilot";

/** What the export and the verification ask an account: the login identity the provider reports, or null. */
export type IdentityReader = (engine: TransferEngine, account: { id: string; home: string; kind: "legacy" | "managed" }) => Promise<string | null>;

export function identityHash(exportId: string, identity: string | null): string | null {
  const normalized = identity?.trim().toLowerCase();
  return normalized ? crypto.createHash("sha256").update(`delegatus-transfer-identity\0${exportId}\0${normalized}`).digest("hex") : null;
}

/** The provider's own answer, through the product's existing reads: `claude auth status` in the account's home, the Codex app server's account read, the Copilot CLI's signed-in user. */
export const productionIdentityReader: IdentityReader = async (engine, account) => {
  try {
    if (engine === "claude") {
      const { realClaudeLoginPorts } = await import("@/lib/accounts/claudeLogin");
      const status = await realClaudeLoginPorts.status(account.home);
      return status.loggedIn ? status.email : null;
    }
    if (engine === "codex") {
      const { CodexAppServerClient } = await import("@/lib/accounts/codexAppServer");
      const client = await CodexAppServerClient.start({ home: account.home });
      try { return (await client.readAccount()).account?.email ?? null; }
      finally { client.close(); }
    }
    const { copilotSignedInIdentity } = await import("@/lib/accounts/copilot");
    const signed = copilotSignedInIdentity(account.home);
    return signed ? `${signed.host}/${signed.login}` : null;
  } catch { return null; }
};

interface SourceAccount { id: string; label: string; kind: "legacy" | "managed"; home: string; signedIn: boolean; provider?: unknown }

async function listSourceAccounts(): Promise<{ engine: TransferEngine; active: string | null; accounts: SourceAccount[] }[]> {
  const { activeClaudeAccountId, listClaudeAccounts } = await import("@/lib/accounts/claude");
  const { activeCodexAccountId, listCodexAccounts } = await import("@/lib/accounts/codex");
  const { activeCopilotAccountId, listCopilotAccounts } = await import("@/lib/accounts/copilot");
  return [
    { engine: "claude", active: activeClaudeAccountId(), accounts: listClaudeAccounts().map(account => ({ id: account.id, label: account.label, kind: account.kind, home: account.home, signedIn: account.authPresent, ...(account.provider ? { provider: account.provider } : {}) })) },
    { engine: "codex", active: activeCodexAccountId(), accounts: listCodexAccounts().map(account => ({ id: account.id, label: account.label, kind: account.kind, home: account.home, signedIn: account.authPresent })) },
    { engine: "copilot", active: activeCopilotAccountId(), accounts: listCopilotAccounts().map(account => ({ id: account.id, label: account.label, kind: account.kind, home: account.home, signedIn: account.auth === "signed_in" })) },
  ];
}

export interface AccountRecordValue {
  engine: TransferEngine;
  id: string;
  label: string;
  kind: "legacy" | "managed";
  active: boolean;
  identity: string | null;
  /** A Claude custom provider's settings, without its token. */
  provider?: unknown;
}

export interface BindingRecordValue { engine: "claude" | "codex"; accountId: string; project: string }

export interface AccountExportDeps {
  list?: typeof listSourceAccounts;
  bindings?: () => Promise<BindingRecordValue[]>;
  identity?: IdentityReader;
}

/** The section and the header's account list. An account travels when it is
    signed in or bound to a project: the accounts this install uses. */
export function accountExporter(exportId: string, deps: AccountExportDeps = {}) {
  return async (): Promise<{ header: BundleAccount[]; records: StoredRow[] }> => {
    const engines = await (deps.list ?? listSourceAccounts)();
    const bindings = await (deps.bindings ?? (async () => {
      const { accountProjectBindings } = await import("@/lib/accounts/projectBindings");
      return accountProjectBindings().map(binding => ({ engine: binding.engine, accountId: binding.accountId, project: binding.project }));
    }))();
    const reader = deps.identity ?? productionIdentityReader;
    const header: BundleAccount[] = [];
    const records: StoredRow[] = [];
    for (const { engine, active, accounts } of engines) {
      for (const account of accounts) {
        const bound = bindings.some(binding => binding.engine === engine && binding.accountId === account.id);
        if (!account.signedIn && !bound) continue;
        const identity = account.signedIn ? identityHash(exportId, await reader(engine, account)) : null;
        const value: AccountRecordValue = { engine, id: account.id, label: account.label, kind: account.kind, active: account.id === active, identity, ...(account.provider ? { provider: account.provider } : {}) };
        header.push({ engine, id: account.id, label: account.label, kind: account.kind, active: value.active, identity });
        records.push({ key: `account:${engine}:${account.id}`, value });
      }
    }
    for (const binding of bindings) records.push({ key: `binding:${binding.engine}:${binding.accountId}:${binding.project}`, value: binding });
    return { header, records };
  };
}

/* ── Target: the checklist rows ───────────────────────────────────────── */

export interface ImportedAccountRow {
  kind: "account";
  importId: string;
  exportId: string;
  engine: TransferEngine;
  sourceId: string;
  targetId: string | null;
  label: string;
  sourceKind: "legacy" | "managed";
  activeOnSource: boolean;
  identity: string | null;
  bindings: string[];
  state: AccountReportRow["state"];
  detail?: string;
  /** The operator confirmed a different signed-in identity is the right account here. */
  confirmedDifferent?: boolean;
  checkedAt?: string;
}

const SEED = { collection: "transfer_accounts", schemaVersion: 1, migrationId: "transfer-accounts-v1", key: (row: ImportedAccountRow) => `${row.engine}:${row.sourceId}`, loadRecords: (): ImportedAccountRow[] => [] };

function collection(create: boolean): SqliteStateCollection<ImportedAccountRow> | null {
  const file = path.join(stateDir(), "state.sqlite");
  if (!create && !stateCollectionsInitialized(file, [SEED])) return null;
  if (create) initializeStateCollections(file, [SEED]);
  return new SqliteStateCollection<ImportedAccountRow>(file, {
    collection: SEED.collection, schemaVersion: 1, busyMessage: "transfer accounts busy", key: SEED.key, clone: structuredClone, strictDecode: true,
    decode: value => value && typeof value === "object" && (value as ImportedAccountRow).kind === "account" ? value as ImportedAccountRow : null,
  });
}

export function importedAccountRows(): ImportedAccountRow[] {
  const held = collection(false);
  if (!held) return [];
  try { return [...held.snapshot()]; } finally { held.close(); }
}

function putRows(rows: readonly ImportedAccountRow[]): void {
  if (!rows.length) return;
  const held = collection(true)!;
  try { held.patchSync(() => ({ records: rows })); } finally { held.close(); }
}

/* ── Target: planning and applying ───────────────────────────────────── */

export interface TargetAccount { id: string; label: string; kind: "legacy" | "managed"; home: string; signedIn: boolean }

export interface AccountTargetDeps {
  list?: (engine: TransferEngine) => Promise<TargetAccount[]>;
  create?: (engine: TransferEngine, label: string) => Promise<string>;
  bind?: (engine: "claude" | "codex", accountId: string, project: string) => Promise<boolean>;
  identity?: IdentityReader;
}

async function listTarget(engine: TransferEngine): Promise<TargetAccount[]> {
  const engines = await listSourceAccounts();
  return engines.find(entry => entry.engine === engine)!.accounts;
}

async function createTarget(engine: TransferEngine, label: string): Promise<string> {
  if (engine === "claude") return (await import("@/lib/accounts/claude")).createManagedClaudeAccount(label).id;
  if (engine === "codex") return (await import("@/lib/accounts/codex")).createManagedCodexAccount(label).id;
  return (await import("@/lib/accounts/copilot")).createManagedCopilotAccount(label).id;
}

async function bindTarget(engine: "claude" | "codex", accountId: string, project: string): Promise<boolean> {
  const { bindAccountToProject } = await import("@/lib/accounts/projectBindings");
  return bindAccountToProject(engine, accountId, project).ok;
}

const isEngine = (value: unknown): value is TransferEngine => value === "claude" || value === "codex" || value === "copilot";

export function validAccountRecord(key: string, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (key.startsWith("account:")) {
    return isEngine(record.engine) && typeof record.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(record.id) && key === `account:${record.engine}:${record.id}`
      && typeof record.label === "string" && !!record.label.trim() && record.label.length <= 80 && (record.kind === "legacy" || record.kind === "managed")
      && typeof record.active === "boolean" && (record.identity === null || typeof record.identity === "string");
  }
  if (key.startsWith("binding:")) {
    return (record.engine === "claude" || record.engine === "codex") && typeof record.accountId === "string" && typeof record.project === "string"
      && key === `binding:${record.engine}:${record.accountId}:${record.project}`;
  }
  return false;
}

/** What apply will do with each account, against this install now. Read-only. */
export async function planAccounts(records: readonly StoredRow[], exportId: string, deps: AccountTargetDeps = {}): Promise<AccountPlan[]> {
  const list = deps.list ?? listTarget;
  const identity = deps.identity ?? productionIdentityReader;
  const accounts = records.filter(row => row.key.startsWith("account:")).map(row => row.value as AccountRecordValue);
  const bindings = records.filter(row => row.key.startsWith("binding:")).map(row => row.value as BindingRecordValue);
  const previous = new Map(importedAccountRows().map(row => [`${row.engine}:${row.sourceId}`, row] as const));
  const plans: AccountPlan[] = [];
  for (const account of accounts) {
    const here = await list(account.engine);
    const bound = bindings.filter(binding => binding.engine === account.engine && binding.accountId === account.id).map(binding => binding.project);
    const base = { engine: account.engine, sourceId: account.id, label: account.label, kind: account.kind, sourceActive: account.active, bindings: bound };
    const earlier = previous.get(`${account.engine}:${account.id}`);
    if (earlier?.targetId && here.some(candidate => candidate.id === earlier.targetId)) {
      plans.push({ ...base, action: "existing", plannedId: earlier.targetId });
      continue;
    }
    if (account.engine === "claude" && account.provider) {
      plans.push({ ...base, action: "skip", plannedId: null, reason: "provider-account" });
      continue;
    }
    if (account.kind === "legacy") {
      /* The target's own engine home stands in while it is signed out or
         signed into the same identity (§2.3); otherwise a managed account. */
      const legacy = here.find(candidate => candidate.kind === "legacy");
      if (legacy && (!legacy.signedIn || (account.identity && identityHash(exportId, await identity(account.engine, legacy)) === account.identity))) {
        plans.push({ ...base, action: "legacy", plannedId: legacy.id });
        continue;
      }
    }
    const same = here.find(candidate => candidate.id === account.id && candidate.kind === "managed");
    if (same && account.kind === "managed") { plans.push({ ...base, action: "existing", plannedId: same.id }); continue; }
    plans.push({ ...base, action: "create", plannedId: null });
  }
  return plans;
}

/** After the import's commit: create each account signed out through the
    existing setup, apply its bindings at once, and record the checklist rows.
    Idempotent: an account already created for this source account is reused. */
export async function applyAccounts(importId: string, exportId: string, records: readonly StoredRow[], deps: AccountTargetDeps = {}): Promise<ImportedAccountRow[]> {
  const plans = await planAccounts(records, exportId, deps);
  const previous = new Map(importedAccountRows().map(row => [`${row.engine}:${row.sourceId}`, row] as const));
  const accounts = new Map(records.filter(row => row.key.startsWith("account:")).map(row => [row.key, row.value as AccountRecordValue] as const));
  const bindings = records.filter(row => row.key.startsWith("binding:")).map(row => row.value as BindingRecordValue);
  const list = deps.list ?? listTarget;
  const rows: ImportedAccountRow[] = [];
  const mapped = new Map<string, string>();
  for (const plan of plans) {
    const source = accounts.get(`account:${plan.engine}:${plan.sourceId}`)!;
    let targetId = plan.plannedId;
    let state: ImportedAccountRow["state"] = "signed_out";
    let detail: string | undefined;
    if (plan.action === "skip") { state = "not_created"; detail = plan.reason; targetId = null; }
    else if (!targetId) {
      try { targetId = await (deps.create ?? createTarget)(plan.engine, plan.label); }
      catch (error) { state = "not_created"; detail = error instanceof Error ? error.name : "create-failed"; }
    }
    if (targetId) {
      mapped.set(`${plan.engine}:${plan.sourceId}`, targetId);
      /* A signed-in account waits for its live read; a re-import keeps the
         state a check already settled. */
      const earlier = previous.get(`${plan.engine}:${plan.sourceId}`);
      const signedIn = (await list(plan.engine)).find(candidate => candidate.id === targetId)?.signedIn ?? false;
      if (earlier?.targetId === targetId && earlier.state !== "not_created") { state = earlier.state; detail = earlier.detail; }
      else if (signedIn) state = "unchecked";
    }
    const earlier = previous.get(`${plan.engine}:${plan.sourceId}`);
    rows.push({ kind: "account", importId, exportId, engine: plan.engine, sourceId: plan.sourceId, targetId, label: plan.label, sourceKind: plan.kind,
      activeOnSource: plan.sourceActive, identity: source.identity, bindings: plan.bindings, state, ...(detail ? { detail } : {}),
      ...(earlier?.targetId === targetId && earlier.confirmedDifferent ? { confirmedDifferent: true } : {}) });
  }
  /* Bindings at once, before any account signs in: a binding is what keeps a
     project's work off every other account, so a missing one would widen it.
     An account that could not be made keeps its source id, which matches no
     account here, so the project parks until it is. */
  for (const binding of bindings) {
    const accountId = mapped.get(`${binding.engine}:${binding.accountId}`) ?? binding.accountId;
    await (deps.bind ?? bindTarget)(binding.engine, accountId, binding.project);
  }
  putRows(rows);
  return rows;
}

/* ── Verification ────────────────────────────────────────────────────── */

export interface VerifyDeps {
  list?: (engine: TransferEngine) => Promise<TargetAccount[]>;
  identity?: IdentityReader;
  /** The live limit read; production is `refreshAccountLimits` with phase `transfer-verify`. */
  readLimits?: (engine: "claude" | "codex", accountId: string) => Promise<{ ok: true; windows: boolean; authenticated: boolean } | { ok: false; detail: string }>;
  select?: (engine: TransferEngine, accountId: string) => Promise<void>;
  now?: () => Date;
}

async function readLimitsLive(engine: "claude" | "codex", accountId: string) {
  const { refreshAccountLimits } = await import("@/lib/accounts/liveLimits");
  const result = await refreshAccountLimits(engine, accountId, { phase: "transfer-verify" });
  if (result.kind === "refreshed") {
    const limits = result.observation.limits as { session?: unknown; weekly?: unknown } | null;
    return { ok: true as const, authenticated: result.observation.authenticated, windows: !!limits && !!(limits.session || limits.weekly) };
  }
  return { ok: false as const, detail: result.kind === "unknown_account" ? "unknown account" : result.detail };
}

async function selectLive(engine: TransferEngine, accountId: string) {
  const { selectAccount } = await import("@/lib/accounts/manager");
  await selectAccount(engine, accountId);
}

/** One account's §5.2 check: signed in, its limits read live with a plan and windows, its identity the source's. */
export async function verifyImportedAccount(row: ImportedAccountRow, deps: VerifyDeps = {}): Promise<ImportedAccountRow> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  if (row.state === "not_needed" || row.state === "not_created" || !row.targetId) return row;
  const account = (await (deps.list ?? listTarget)(row.engine)).find(candidate => candidate.id === row.targetId);
  if (!account) return { ...row, state: "not_created", detail: "the account is no longer on this install", checkedAt: now };
  if (!account.signedIn) return { ...row, state: "signed_out", detail: undefined, checkedAt: now };
  if (row.engine !== "copilot") {
    const read = await (deps.readLimits ?? readLimitsLive)(row.engine, row.targetId);
    if (!read.ok) return { ...row, state: "read_failed", detail: read.detail, checkedAt: now };
    if (!read.authenticated) return { ...row, state: "signed_out", detail: undefined, checkedAt: now };
    if (!read.windows) return { ...row, state: "read_failed", detail: "no limit windows in the reading", checkedAt: now };
  }
  const here = identityHash(row.exportId, await (deps.identity ?? productionIdentityReader)(row.engine, account));
  if (row.identity && here && here !== row.identity && !row.confirmedDifferent) return { ...row, state: "different_account", detail: undefined, checkedAt: now };
  const usable: ImportedAccountRow = { ...row, state: "usable", detail: undefined, checkedAt: now };
  /* §3.5: the source's active account becomes active here once it is usable. */
  if (row.activeOnSource) await (deps.select ?? selectLive)(row.engine, row.targetId);
  return usable;
}

export async function verifyImportedAccounts(filter: { engine?: TransferEngine; sourceId?: string } = {}, deps: VerifyDeps = {}): Promise<ImportedAccountRow[]> {
  const rows = importedAccountRows().filter(row => (!filter.engine || row.engine === filter.engine) && (!filter.sourceId || row.sourceId === filter.sourceId));
  const checked: ImportedAccountRow[] = [];
  for (const row of rows) checked.push(await verifyImportedAccount(row, deps));
  putRows(checked);
  return checked;
}

/** The operator's two answers on a row: «not needed here», and «this is the right account» for a different identity. */
export function markImportedAccount(engine: TransferEngine, sourceId: string, mark: "not_needed" | "confirm_identity"): ImportedAccountRow | null {
  const row = importedAccountRows().find(candidate => candidate.engine === engine && candidate.sourceId === sourceId);
  if (!row) return null;
  const next: ImportedAccountRow = mark === "not_needed" ? { ...row, state: "not_needed" } : { ...row, confirmedDifferent: true };
  putRows([next]);
  return next;
}

/** A signed-in account settles its checklist row at once (called after a login's own live read). */
export async function settleImportedAccountSignIn(engine: TransferEngine, targetId: string, deps: VerifyDeps = {}): Promise<void> {
  const row = importedAccountRows().find(candidate => candidate.engine === engine && candidate.targetId === targetId);
  if (!row || row.state === "not_needed") return;
  putRows([await verifyImportedAccount(row, deps)]);
}

export function accountReportRows(rows: readonly ImportedAccountRow[] = importedAccountRows()): AccountReportRow[] {
  return rows.map(row => ({
    engine: row.engine, sourceId: row.sourceId, targetId: row.targetId, label: row.label,
    state: row.state, ...(row.detail ? { detail: row.detail } : {}),
    bindings: row.bindings, activeOnSource: row.activeOnSource,
  }));
}

export function accountsReady(rows: readonly AccountReportRow[]): boolean {
  /* An unchecked row is not ready: the import is done when every account read its limits here or is not needed. */
  return rows.every(row => row.state === "usable" || row.state === "not_needed");
}
