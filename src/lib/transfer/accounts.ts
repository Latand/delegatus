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
  /** The id is reserved and the import's bindings name it; the account itself
      is made after the commit, and again by recovery or «Try again» until it is. */
  pendingCreate?: boolean;
  /** The operator confirmed a different signed-in identity is the right account here. */
  confirmedDifferent?: boolean;
  checkedAt?: string;
}

export const TRANSFER_ACCOUNTS_COLLECTION = "transfer_accounts";
/** One row per account here and the source account it stands for: a source id
    seen again in a later import maps to the same row only when it maps to the
    same account here, so an earlier row is never answered for another login. */
export const transferAccountKey = (row: Pick<ImportedAccountRow, "engine" | "sourceId" | "targetId">) => `${row.engine}:${row.sourceId}:${row.targetId ?? "-"}`;
export const TRANSFER_ACCOUNTS_SEED = { collection: TRANSFER_ACCOUNTS_COLLECTION, schemaVersion: 1, migrationId: "transfer-accounts-v1", key: transferAccountKey, loadRecords: (): ImportedAccountRow[] => [] };
const SEED = TRANSFER_ACCOUNTS_SEED;

function collection(create: boolean): SqliteStateCollection<ImportedAccountRow> | null {
  const file = path.join(stateDir(), "state.sqlite");
  if (!create && !stateCollectionsInitialized(file, [SEED])) return null;
  if (create) initializeStateCollections(file, [SEED]);
  return new SqliteStateCollection<ImportedAccountRow>(file, {
    collection: SEED.collection, schemaVersion: 1, busyMessage: "transfer accounts busy", key: SEED.key, clone: structuredClone, strictDecode: true,
    decode: value => value && typeof value === "object" && (value as ImportedAccountRow).kind === "account" ? value as ImportedAccountRow : null,
  });
}

/** Creates the checklist collection before an import's commit writes into it. */
export function initializeImportedAccountRows(): void { collection(true)?.close(); }

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
  /** Makes the account under the id the import reserved; idempotent for that id. */
  create?: (engine: TransferEngine, label: string, id: string) => Promise<string>;
  /** Holds a fresh id with an empty home, so no other account setup takes it. */
  reserve?: (engine: TransferEngine, label: string, taken: ReadonlySet<string>) => Promise<string>;
  /** Gives back a reservation an uncommitted import made. */
  release?: (engine: TransferEngine, id: string) => Promise<void>;
  identity?: IdentityReader;
}

async function listTarget(engine: TransferEngine): Promise<TargetAccount[]> {
  const engines = await listSourceAccounts();
  return engines.find(entry => entry.engine === engine)!.accounts;
}

async function createTarget(engine: TransferEngine, label: string, id: string): Promise<string> {
  if (engine === "claude") return (await import("@/lib/accounts/claude")).createManagedClaudeAccount(label, undefined, { id }).id;
  if (engine === "codex") return (await import("@/lib/accounts/codex")).createManagedCodexAccount(label, { id }).id;
  return (await import("@/lib/accounts/copilot")).createManagedCopilotAccount(label, { id }).id;
}

async function reserveTarget(engine: TransferEngine, label: string, taken: ReadonlySet<string>): Promise<string> {
  if (engine === "claude") return (await import("@/lib/accounts/claude")).reserveManagedClaudeAccountId(label, taken).id;
  if (engine === "codex") return (await import("@/lib/accounts/codex")).reserveManagedCodexAccountId(label, taken).id;
  return (await import("@/lib/accounts/copilot")).reserveManagedCopilotAccountId(label, taken).id;
}

async function releaseTarget(engine: TransferEngine, id: string): Promise<void> {
  if (engine === "claude") (await import("@/lib/accounts/claude")).releaseManagedClaudeAccountReservation(id);
  else if (engine === "codex") (await import("@/lib/accounts/codex")).releaseManagedCodexAccountReservation(id);
  else (await import("@/lib/accounts/copilot")).releaseManagedCopilotAccountReservation(id);
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

/** The account a binding names when its source account could not be made
    here. No account id can have a dot, so the binding authorizes nothing and
    the project's work parks rather than widening to every account. */
export function unavailableAccountId(sourceId: string): string {
  return `transfer-unavailable.${sourceId.replace(/[^A-Za-z0-9-]/g, "-")}`;
}

/** What apply will do with each account, against this install now. Read-only.
    A target account stands in for a source account only when it is proven to
    be the same: the account an import of this very export made (the same
    bundle again), or one signed in here into the identity this export
    reports. A row an earlier import left is no proof by itself: the same
    source id can name another login on another install, or after the source
    signed in again, and each export salts its identity hash anew, so an
    earlier hash cannot be compared with this one. Anything else gets an
    account of its own. */
export async function planAccounts(records: readonly StoredRow[], exportId: string, deps: AccountTargetDeps = {}): Promise<AccountPlan[]> {
  const list = deps.list ?? listTarget;
  const identity = deps.identity ?? productionIdentityReader;
  const accounts = records.filter(row => row.key.startsWith("account:")).map(row => row.value as AccountRecordValue);
  const bindings = records.filter(row => row.key.startsWith("binding:")).map(row => row.value as BindingRecordValue);
  const previous = importedAccountRows();
  const sameIdentity = async (account: AccountRecordValue, candidate: TargetAccount) =>
    !!account.identity && candidate.signedIn && identityHash(exportId, await identity(account.engine, candidate)) === account.identity;
  const plans: AccountPlan[] = [];
  for (const account of accounts) {
    const here = await list(account.engine);
    const bound = bindings.filter(binding => binding.engine === account.engine && binding.accountId === account.id).map(binding => binding.project);
    const base = { engine: account.engine, sourceId: account.id, label: account.label, kind: account.kind, sourceActive: account.active, bindings: bound };
    const earlier = previous.filter(row => row.engine === account.engine && row.sourceId === account.id && row.targetId);
    /* This export again: the account its earlier import made, or the reservation it has not made yet. */
    const replay = earlier.find(row => row.exportId === exportId && row.identity === account.identity);
    if (replay && here.some(candidate => candidate.id === replay.targetId)) { plans.push({ ...base, action: "existing", plannedId: replay.targetId }); continue; }
    if (replay?.pendingCreate) { plans.push({ ...base, action: "create", plannedId: replay.targetId }); continue; }
    /* Another export: an account an earlier import made stands in only when it is signed into this export's identity. */
    let proven: string | null = null;
    for (const row of earlier) {
      const candidate = here.find(entry => entry.id === row.targetId);
      if (candidate && await sameIdentity(account, candidate)) { proven = candidate.id; break; }
    }
    if (proven) { plans.push({ ...base, action: "existing", plannedId: proven }); continue; }
    if (account.engine === "claude" && account.provider) {
      plans.push({ ...base, action: "skip", plannedId: null, reason: "provider-account" });
      continue;
    }
    if (account.kind === "legacy") {
      /* The target's own engine home stands in while it is signed out or
         signed into the same identity (§2.3); otherwise a managed account. */
      const legacy = here.find(candidate => candidate.kind === "legacy");
      if (legacy && (!legacy.signedIn || await sameIdentity(account, legacy))) {
        plans.push({ ...base, action: "legacy", plannedId: legacy.id });
        continue;
      }
    }
    const same = here.find(candidate => candidate.id === account.id && candidate.kind === "managed");
    if (same && account.kind === "managed" && await sameIdentity(account, same)) { plans.push({ ...base, action: "existing", plannedId: same.id }); continue; }
    plans.push({ ...base, action: "create", plannedId: null });
  }
  return plans;
}

/** Inside apply, before anything is written: a reserved id for every account
    to be made, so the commit can bind projects to it. Each reservation is
    reported as it is made, for the journal that gives it back on a rollback. */
export async function reserveAccounts(plans: AccountPlan[], deps: AccountTargetDeps = {}, reserved: (engine: TransferEngine, id: string) => void = () => {}): Promise<void> {
  const taken = new Map<TransferEngine, Set<string>>();
  for (const plan of plans) if (plan.plannedId) (taken.get(plan.engine) ?? taken.set(plan.engine, new Set()).get(plan.engine)!).add(plan.plannedId);
  for (const plan of plans) {
    if (plan.action !== "create" || plan.plannedId) continue;
    const engineTaken = taken.get(plan.engine) ?? taken.set(plan.engine, new Set()).get(plan.engine)!;
    const id = await (deps.reserve ?? reserveTarget)(plan.engine, plan.label, engineTaken);
    engineTaken.add(id);
    plan.plannedId = id;
    reserved(plan.engine, id);
  }
}

export async function releaseReservation(engine: TransferEngine, id: string, deps: AccountTargetDeps = {}): Promise<void> {
  await (deps.release ?? releaseTarget)(engine, id);
}

/** What the commit writes for the accounts: the checklist rows and every
    binding, each naming the account it maps to here. Computed after the
    reservations, so no binding ever falls back to a source id. */
export async function accountCommitRows(importId: string, exportId: string, records: readonly StoredRow[], plans: readonly AccountPlan[], options: { now: string; canonical: (project: string) => string; deps?: AccountTargetDeps }): Promise<{ rows: ImportedAccountRow[]; bindings: { engine: "claude" | "codex"; accountId: string; project: string; createdAt: string }[] }> {
  const list = options.deps?.list ?? listTarget;
  const previous = importedAccountRows();
  const accounts = new Map(records.filter(row => row.key.startsWith("account:")).map(row => [row.key, row.value as AccountRecordValue] as const));
  const mapped = new Map<string, string>();
  const rows: ImportedAccountRow[] = [];
  for (const plan of plans) {
    const source = accounts.get(`account:${plan.engine}:${plan.sourceId}`)!;
    const targetId = plan.action === "skip" ? null : plan.plannedId;
    /* Only this same export may keep what a check settled: its identity hash is
       the one that check compared. Any other export is checked anew, and a
       confirmation given for one login never carries to another. */
    const earlier = targetId === null ? undefined : previous.find(row => row.engine === plan.engine && row.sourceId === plan.sourceId && row.targetId === targetId
      && row.exportId === exportId && row.identity === source.identity);
    let state: ImportedAccountRow["state"] = "signed_out";
    let detail: string | undefined = plan.action === "skip" ? plan.reason : undefined;
    if (plan.action === "skip") state = "not_created";
    else if (plan.action !== "create") {
      /* A signed-in account waits for its live read. */
      const signedIn = (await list(plan.engine)).find(candidate => candidate.id === targetId)?.signedIn ?? false;
      if (earlier && earlier.state !== "not_created") { state = earlier.state; detail = earlier.detail; }
      else if (signedIn) state = "unchecked";
    }
    mapped.set(`${plan.engine}:${plan.sourceId}`, targetId ?? unavailableAccountId(plan.sourceId));
    rows.push({ kind: "account", importId, exportId, engine: plan.engine, sourceId: plan.sourceId, targetId, label: plan.label, sourceKind: plan.kind,
      activeOnSource: plan.sourceActive, identity: source.identity, bindings: plan.bindings, state, ...(detail ? { detail } : {}),
      ...(plan.action === "create" ? { pendingCreate: true } : {}),
      ...(earlier?.confirmedDifferent ? { confirmedDifferent: true } : {}) });
  }
  const bindings = records.filter(row => row.key.startsWith("binding:")).map(row => row.value as BindingRecordValue).map(binding => ({
    engine: binding.engine,
    accountId: mapped.get(`${binding.engine}:${binding.accountId}`) ?? unavailableAccountId(binding.accountId),
    project: options.canonical(binding.project),
    createdAt: options.now,
  }));
  return { rows, bindings };
}

/** After the commit, and again at recovery: make every reserved account of
    this import. A failed setup leaves its row «Not created» with the cause and
    its reservation, which «Try again» and the next recovery take up. */
/** Which checklist rows an action names: an engine, a source id, and the account here it maps to. */
export interface AccountRowFilter { engine?: TransferEngine; sourceId?: string; targetId?: string | null }

const matches = (row: ImportedAccountRow, filter: AccountRowFilter) => (!filter.engine || row.engine === filter.engine)
  && (!filter.sourceId || row.sourceId === filter.sourceId) && (filter.targetId === undefined || row.targetId === filter.targetId);

/** The one row an action on one account names; null when none, or when a
    source id alone names more than one (two imports mapped it to two accounts). */
function oneRow(filter: AccountRowFilter): ImportedAccountRow | null {
  const found = importedAccountRows().filter(row => matches(row, filter));
  return found.length === 1 ? found[0]! : null;
}

export async function finishAccountCreation(filter: AccountRowFilter & { importId?: string }, deps: AccountTargetDeps = {}): Promise<ImportedAccountRow[]> {
  const pending = importedAccountRows().filter(row => row.pendingCreate && row.targetId
    && (!filter.importId || row.importId === filter.importId) && matches(row, filter));
  const done: ImportedAccountRow[] = [];
  for (const row of pending) {
    try {
      const made = await (deps.create ?? createTarget)(row.engine, row.label, row.targetId!);
      if (made !== row.targetId) throw new Error("the account was made under another id");
      const settled: ImportedAccountRow = { ...row, state: "signed_out", detail: undefined };
      delete settled.pendingCreate;
      done.push(settled);
    } catch (error) {
      done.push({ ...row, state: "not_created", detail: error instanceof Error && error.name !== "Error" ? error.name : "create-failed" });
    }
    putRows([done.at(-1)!]);
  }
  return done;
}

/* ── Verification ────────────────────────────────────────────────────── */

/** What one limit read observed, as the verification judges it (§5.2). */
export interface LimitsEvidence {
  authenticated: boolean;
  /** Where the numbers came from: only `live` is the provider's answer to this read. */
  source: string;
  staleSince: string | null;
  observedAt: string;
  plan: string | null;
  windows: boolean;
}

export type LimitsRead = { ok: true; evidence: LimitsEvidence } | { ok: false; detail: string };

export interface VerifyDeps {
  list?: (engine: TransferEngine) => Promise<TargetAccount[]>;
  identity?: IdentityReader;
  /** The live limit read; production is {@link transferLimitsReader}. */
  readLimits?: (engine: "claude" | "codex", accountId: string) => Promise<LimitsRead>;
  select?: (engine: TransferEngine, accountId: string) => Promise<void>;
  now?: () => Date;
}

/** How old the observation a verification read may be: it is taken by that read. */
export const VERIFY_OBSERVATION_MAX_AGE_MS = 2 * 60_000;

/** The production read: `refreshAccountLimits` with phase `transfer-verify`,
    its observation handed on whole, so a reading the provider did not give
    now (a cached or carried one, one without a plan) cannot pass for one. */
export function transferLimitsReader(liveDeps: import("@/lib/accounts/liveLimits").LiveLimitsDeps = {}) {
  return async (engine: "claude" | "codex", accountId: string): Promise<LimitsRead> => {
    const { refreshAccountLimits } = await import("@/lib/accounts/liveLimits");
    const result = await refreshAccountLimits(engine, accountId, { ...liveDeps, phase: "transfer-verify" });
    if (result.kind !== "refreshed") return { ok: false, detail: result.kind === "unknown_account" ? "unknown account" : result.detail };
    const { observation } = result;
    const limits = observation.limits;
    return { ok: true, evidence: {
      authenticated: observation.authenticated,
      source: observation.provenance.source,
      staleSince: observation.provenance.staleSince,
      observedAt: observation.observedAt,
      plan: limits?.plan ?? null,
      windows: !!limits && !!(limits.session || limits.weekly),
    } };
  };
}

/** Why a read is no evidence that the account works here, or null when it is. */
function limitsRefusal(evidence: LimitsEvidence, now: number): string | null {
  if (evidence.source !== "live" || evidence.staleSince !== null) return "limits-not-live";
  const age = now - Date.parse(evidence.observedAt);
  if (!Number.isFinite(age) || age > VERIFY_OBSERVATION_MAX_AGE_MS || age < -VERIFY_OBSERVATION_MAX_AGE_MS) return "limits-stale";
  if (!evidence.plan?.trim()) return "no-plan";
  if (!evidence.windows) return "no-limit-windows";
  return null;
}

async function selectLive(engine: TransferEngine, accountId: string) {
  const { selectAccount } = await import("@/lib/accounts/manager");
  await selectAccount(engine, accountId);
}

/** One account's §5.2 check: signed in, its limits read live with a plan and windows, its identity the source's. */
export async function verifyImportedAccount(row: ImportedAccountRow, deps: VerifyDeps = {}): Promise<ImportedAccountRow> {
  const clock = (deps.now ?? (() => new Date()))();
  const now = clock.toISOString();
  if (row.state === "not_needed" || row.state === "not_created" || !row.targetId) return row;
  const account = (await (deps.list ?? listTarget)(row.engine)).find(candidate => candidate.id === row.targetId);
  if (!account) return { ...row, state: "not_created", detail: "account-missing", checkedAt: now };
  if (!account.signedIn) return { ...row, state: "signed_out", detail: undefined, checkedAt: now };
  if (row.engine !== "copilot") {
    const read = await (deps.readLimits ?? transferLimitsReader())(row.engine, row.targetId);
    if (!read.ok) return { ...row, state: "read_failed", detail: read.detail, checkedAt: now };
    if (!read.evidence.authenticated) return { ...row, state: "signed_out", detail: undefined, checkedAt: now };
    /* §5.2: usable means this read returned a fresh observation with a plan and windows. */
    const refusal = limitsRefusal(read.evidence, clock.getTime());
    if (refusal) return { ...row, state: "read_failed", detail: refusal, checkedAt: now };
  }
  /* The source reported an identity: this account is the same one only when
     the provider says so here too. An identity this install cannot read is no
     evidence either way, so the row waits, unselected, until a read answers or
     the operator confirms the account. */
  if (row.identity && !row.confirmedDifferent) {
    const read = await (deps.identity ?? productionIdentityReader)(row.engine, account);
    if (read === null) return { ...row, state: "read_failed", detail: "identity-unreadable", checkedAt: now };
    if (identityHash(row.exportId, read) !== row.identity) return { ...row, state: "different_account", detail: undefined, checkedAt: now };
  }
  const usable: ImportedAccountRow = { ...row, state: "usable", detail: undefined, checkedAt: now };
  /* §3.5: the source's active account becomes active here once it is usable. */
  if (row.activeOnSource) await (deps.select ?? selectLive)(row.engine, row.targetId);
  return usable;
}

export async function verifyImportedAccounts(filter: AccountRowFilter = {}, deps: VerifyDeps = {}): Promise<ImportedAccountRow[]> {
  const rows = importedAccountRows().filter(row => matches(row, filter));
  const checked: ImportedAccountRow[] = [];
  for (const row of rows) checked.push(await verifyImportedAccount(row, deps));
  putRows(checked);
  return checked;
}

/** The operator's two answers on a row: «not needed here», and «this is the right account» for a different identity. */
export function markImportedAccount(engine: TransferEngine, sourceId: string, mark: "not_needed" | "confirm_identity", targetId?: string | null): ImportedAccountRow | null {
  const row = oneRow({ engine, sourceId, targetId });
  if (!row) return null;
  /* «Not needed here» also stops the account from being made later; its reservation and bindings stay, so its projects still park. */
  const next: ImportedAccountRow = mark === "not_needed" ? { ...row, state: "not_needed" } : { ...row, confirmedDifferent: true };
  if (mark === "not_needed") delete next.pendingCreate;
  putRows([next]);
  return next;
}

/** «Try again» on a row whose account could not be made: the same reserved id. */
export async function retryImportedAccount(engine: TransferEngine, sourceId: string, deps: AccountTargetDeps = {}, targetId?: string | null): Promise<ImportedAccountRow | null> {
  const row = oneRow({ engine, sourceId, targetId });
  if (!row) return null;
  if (!row.pendingCreate) return row;
  const { withAccountMutationLockAsync } = await import("@/lib/accounts/accountMutation");
  const [done] = await withAccountMutationLockAsync(() => finishAccountCreation({ engine, sourceId, targetId: row.targetId }, deps), { holder: "install transfer account retry" });
  return done ?? row;
}

/** A signed-in account settles its checklist row at once (called after a login's own live read). */
export async function settleImportedAccountSignIn(engine: TransferEngine, targetId: string, deps: VerifyDeps = {}): Promise<void> {
  const rows = importedAccountRows().filter(candidate => candidate.engine === engine && candidate.targetId === targetId && candidate.state !== "not_needed");
  const checked: ImportedAccountRow[] = [];
  for (const row of rows) checked.push(await verifyImportedAccount(row, deps));
  putRows(checked);
}

export function accountReportRows(rows: readonly ImportedAccountRow[] = importedAccountRows()): AccountReportRow[] {
  return rows.map(row => ({
    engine: row.engine, sourceId: row.sourceId, targetId: row.targetId, label: row.label,
    state: row.state, ...(row.detail ? { detail: row.detail } : {}),
    bindings: row.bindings, activeOnSource: row.activeOnSource,
    ...(row.state === "not_created" && row.pendingCreate ? { retry: true } : {}),
  }));
}

export function accountsReady(rows: readonly AccountReportRow[]): boolean {
  /* An unchecked row is not ready: the import is done when every account read its limits here or is not needed. */
  return rows.every(row => row.state === "usable" || row.state === "not_needed");
}
