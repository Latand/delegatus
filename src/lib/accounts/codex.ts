import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stateDir, statePath } from "@/lib/configDir";
import { isShellCommand } from "@/lib/status";
import { withAccountMutationLock } from "./accountMutation";
import { AccountHistoryInventoryBlockedError, accountHistoryInventory, accountRemovalBlockers, accountRemovalInFlight, normalizeAccountRemovalJournal, recoverManagedAccountRemoval, removeHistoryFreeAccountHome, removeManagedAccountIntoArchive, retiredAccountArchive, scrubAccountHomeToRetainedHistory, withAccountRemovalJournal, type AccountArchiveRemovalReport, type AccountHistoryInventoryReport, type AccountOrphanCleanupReport, type AccountRemovalJournalEntry } from "./removal";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_ID = "default";
const REGISTRY_VERSION = 1;
const REGISTRY_LOCK_WAIT_MS = 5_000;
const REGISTRY_LOCK_STALE_MS = 30_000;
export const LOGIN_STARTUP_GRACE_MS = 15_000;
/* Shared, read-mostly capability state. Account tokens, sessions, plugin data,
   and MCP OAuth state deliberately have no link and remain home-local. */
const OVERLAY_LINKS = ["skills", "prompts", "config.toml", "AGENTS.md", "memories", "rules"] as const;

export interface LoginPane {
  paneId: string;
  windowName: string;
  startedAt: number;
}

export interface CodexAccount {
  id: string;
  label: string;
  kind: "legacy" | "managed";
  home: string;
  sessionsDir: string;
  authPresent: boolean;
  loginPane: LoginPane | null;
  createdAt: number;
}

interface StoredAccount {
  id: string;
  label: string;
  kind: "managed";
  createdAt: number;
  loginPane?: LoginPane | null;
}

/** A removed account. `archived` leftovers live in the shared archive
    (issue #1857); older records kept their session tree in the home (#643). */
interface RetiredAccount {
  id: string;
  label: string;
  retiredAt: number;
  archived?: true;
}

interface Registry {
  version: number;
  active: string;
  accounts: StoredAccount[];
  retired: RetiredAccount[];
  /** Account removals in flight (issue #1857). */
  removals: AccountRemovalJournalEntry[];
}

interface CachedRegistry {
  key: string;
  loaded: LoadedRegistry;
}

interface LoadedRegistry {
  registry: Registry;
  corrupt: boolean;
}

let cached: CachedRegistry | null = null;
const reportedStoreErrors = new Set<string>();

export class UnknownAccountError extends Error {
  constructor(id: string) {
    super(`unknown Codex account: ${id}`);
    this.name = "UnknownAccountError";
  }
}

export class InvalidAccountLabelError extends Error {
  constructor() {
    super("account label must contain visible text and be at most 80 characters");
    this.name = "InvalidAccountLabelError";
  }
}

/** The catalog remains readable as default-only until an operator repairs it. */
export class CorruptCodexAccountsError extends Error {
  constructor() {
    super("Codex account registry is corrupt; repair or remove it before changing accounts");
    this.name = "CorruptCodexAccountsError";
  }
}

export class UnsafeCodexHomeError extends Error {
  constructor() {
    super("managed Codex home failed safety checks");
    this.name = "UnsafeCodexHomeError";
  }
}

function legacyHome(): string {
  return path.resolve(process.env.LLV_CODEX_HOME || path.join(os.homedir(), ".codex"));
}

export function codexAccountsRoot(): string {
  return path.join(path.dirname(stateDir()), "accounts", "codex");
}

function registryPath(): string {
  return statePath("codex-accounts.json");
}

function defaultRegistry(): Registry {
  return { version: REGISTRY_VERSION, active: DEFAULT_ID, accounts: [], retired: [], removals: [] };
}

function storeKey(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function reportStoreErrorOnce(key: string, message: string): void {
  if (reportedStoreErrors.has(key)) return;
  reportedStoreErrors.add(key);
  console.error(`[codex accounts] ${message}`);
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<StoredAccount>;
  return (
    typeof account.id === "string" &&
    typeof account.label === "string" &&
    account.kind === "managed" &&
    typeof account.createdAt === "number" &&
    (account.loginPane === undefined || account.loginPane === null || (
      typeof account.loginPane === "object" &&
      typeof account.loginPane.paneId === "string" &&
      typeof account.loginPane.windowName === "string" &&
      (account.loginPane.startedAt === undefined || typeof account.loginPane.startedAt === "number")
    ))
  );
}

function isRetiredAccount(value: unknown): value is RetiredAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<RetiredAccount>;
  return typeof account.id === "string" && typeof account.label === "string" && typeof account.retiredAt === "number"
    && (account.archived === undefined || account.archived === true);
}

function managedHome(id: string): string {
  return path.join(codexAccountsRoot(), id);
}

function managedHomeIsSafe(id: string, requireExisting = false): boolean {
  if (!ACCOUNT_ID.test(id) || id === DEFAULT_ID) return false;
  const root = path.resolve(codexAccountsRoot());
  const home = path.resolve(managedHome(id));
  if (path.dirname(home) !== root) return false;
  try {
    const rootStat = fs.lstatSync(root);
    const stat = fs.lstatSync(home);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    const rootReal = fs.realpathSync(root);
    return path.dirname(fs.realpathSync(home)) === rootReal;
  } catch {
    return !requireExisting;
  }
}

function normalizeRegistry(value: unknown, sourceKey: string): LoadedRegistry {
  if (!value || typeof value !== "object") {
    reportStoreErrorOnce(sourceKey, "registry is invalid; serving the default account");
    return { registry: defaultRegistry(), corrupt: true };
  }
  const raw = value as Partial<Registry>;
  if (raw.version !== REGISTRY_VERSION || typeof raw.active !== "string" || !Array.isArray(raw.accounts)) {
    reportStoreErrorOnce(sourceKey, "registry has an unsupported shape; serving the default account");
    return { registry: defaultRegistry(), corrupt: true };
  }
  /* `retired` post-dates version 1; a registry written before it is complete, not corrupt. */
  if (raw.retired !== undefined && !Array.isArray(raw.retired)) {
    reportStoreErrorOnce(sourceKey, "registry has an unsupported shape; serving the default account");
    return { registry: defaultRegistry(), corrupt: true };
  }
  const seen = new Set<string>();
  const accounts: StoredAccount[] = [];
  let rejected = false;
  for (const account of raw.accounts) {
    if (!isStoredAccount(account) || seen.has(account.id) || !managedHomeIsSafe(account.id)) {
      reportStoreErrorOnce(`${sourceKey}:${typeof account === "object" && account ? "invalid-account" : "invalid-entry"}`, "ignored an invalid managed account record");
      rejected = true;
      continue;
    }
    seen.add(account.id);
    accounts.push({
      id: account.id,
      label: account.label,
      kind: "managed",
      createdAt: account.createdAt,
      loginPane: account.loginPane ? { ...account.loginPane, startedAt: account.loginPane.startedAt ?? 0 } : null,
    });
  }
  const retired: RetiredAccount[] = [];
  for (const account of raw.retired ?? []) {
    if (!isRetiredAccount(account) || seen.has(account.id) || !managedHomeIsSafe(account.id)) {
      reportStoreErrorOnce(`${sourceKey}:invalid-retired`, "ignored an invalid retired account record");
      rejected = true;
      continue;
    }
    seen.add(account.id);
    retired.push({ id: account.id, label: account.label, retiredAt: account.retiredAt, ...(account.archived ? { archived: true as const } : {}) });
  }
  const removals = normalizeAccountRemovalJournal(raw.removals, (id) => ACCOUNT_ID.test(id) && id !== DEFAULT_ID);
  if (!removals) {
    reportStoreErrorOnce(`${sourceKey}:invalid-removals`, "registry has an unreadable removal journal; serving the default account");
    return { registry: defaultRegistry(), corrupt: true };
  }
  return { registry: { version: REGISTRY_VERSION, active: raw.active, accounts, retired, removals }, corrupt: rejected };
}

function readRegistry(): LoadedRegistry {
  const file = registryPath();
  const key = `${file}:${storeKey(file)}`;
  if (cached?.key === key) return cached.loaded;
  let loaded: LoadedRegistry;
  try {
    if (!fs.existsSync(file)) loaded = { registry: defaultRegistry(), corrupt: false };
    else loaded = normalizeRegistry(JSON.parse(fs.readFileSync(file, "utf8")), key);
  } catch {
    reportStoreErrorOnce(key, "registry cannot be read; serving the default account");
    loaded = { registry: defaultRegistry(), corrupt: true };
  }
  cached = { key, loaded };
  return loaded;
}

function mutableRegistry(): Registry {
  const loaded = readRegistry();
  if (loaded.corrupt) throw new CorruptCodexAccountsError();
  return loaded.registry;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function registryLockPath(): string {
  return `${registryPath()}.lock`;
}

/* The file lock is only ever taken inside the account mutation lock, so a lock
   left by a process that died (a crash mid-removal, #1857) is released at once
   instead of stalling every account mutation for the staleness window. */
function registryLockOwnerGone(lock: string): boolean {
  try {
    const pid = Number.parseInt(fs.readFileSync(lock, "utf8"), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function withRegistryLock<T>(operation: () => T): T {
  return withAccountMutationLock(() => {
    const lock = registryLockPath();
    const started = Date.now();
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    for (;;) {
      let fd: number;
      try {
        fd = fs.openSync(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (registryLockOwnerGone(lock) || Date.now() - fs.statSync(lock).mtimeMs > REGISTRY_LOCK_STALE_MS) {
            fs.rmSync(lock, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - started >= REGISTRY_LOCK_WAIT_MS) throw new Error("Codex account registry is busy; retry shortly");
        sleep(10);
        continue;
      }
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
        return operation();
      } finally {
        fs.closeSync(fd);
        fs.rmSync(lock, { force: true });
      }
    }
  });
}

/** True when the registry is degraded and any persistence would throw
 *  `CorruptCodexAccountsError`. Lets read paths (e.g. `GET /api/accounts`)
 *  skip best-effort writes instead of turning a readable store into a 500. */
export function codexAccountsMutationLocked(): boolean {
  return readRegistry().corrupt;
}

function writeRegistry(registry: Registry): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    cached = null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function authPresent(home: string): boolean {
  try {
    return fs.statSync(path.join(home, "auth.json")).isFile();
  } catch {
    return false;
  }
}

function asAccount(stored: StoredAccount): CodexAccount {
  const home = managedHome(stored.id);
  return {
    id: stored.id,
    label: stored.label,
    kind: "managed",
    home,
    sessionsDir: path.join(home, "sessions"),
    authPresent: authPresent(home),
    loginPane: stored.loginPane ?? null,
    createdAt: stored.createdAt,
  };
}

function defaultAccount(): CodexAccount {
  const home = legacyHome();
  return {
    id: DEFAULT_ID,
    label: "Main",
    kind: "legacy",
    home,
    sessionsDir: path.join(home, "sessions"),
    authPresent: authPresent(home),
    loginPane: null,
    createdAt: 0,
  };
}

export function listCodexAccounts(): CodexAccount[] {
  recoverRemovalsAtStartup();
  return [defaultAccount(), ...readRegistry().registry.accounts.map(asAccount)];
}

export function activeCodexAccountId(): string {
  const active = readRegistry().registry.active;
  return listCodexAccounts().some((account) => account.id === active) ? active : DEFAULT_ID;
}

export function accountForSpawn(requested?: string | null): Pick<CodexAccount, "id" | "kind" | "home" | "sessionsDir"> {
  const id = requested ?? activeCodexAccountId();
  const account = listCodexAccounts().find((candidate) => candidate.id === id);
  if (!account) throw new UnknownAccountError(id);
  return { id: account.id, kind: account.kind, home: account.home, sessionsDir: account.sessionsDir };
}

export function isManagedCodexHome(home: string): boolean {
  return listCodexAccounts().some((account) => account.kind === "managed" && account.home === home);
}

export function setActiveCodexAccount(id: string): void {
  withRegistryLock(() => {
    cached = null;
    const registry = mutableRegistry();
    if (!listCodexAccounts().some((account) => account.id === id)) throw new UnknownAccountError(id);
    writeRegistry({ ...registry, active: id });
  });
}

/** Session trees kept by removed accounts: the shared archive (issue #1857),
    or the home itself for accounts retired in place before it (issue #643).
    Both the scanner and `/api/log` admission read these roots. */
export function retiredCodexSessionRoots(): string[] {
  return readRegistry().registry.retired.map((account) => path.join(account.archived ? retiredAccountArchive("codex", account.id) : managedHome(account.id), "sessions"));
}

/** Every Codex session root the scanner reads: live accounts first, then retained archives. */
export function codexSessionRoots(): string[] {
  return [...new Set([...listCodexAccounts().map((account) => account.sessionsDir), ...retiredCodexSessionRoots()])];
}

export function codexHomeOwningSessionPath(pathname: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(pathname);
  } catch {
    return null;
  }
  for (const account of listCodexAccounts()) {
    try {
      const root = fs.realpathSync(account.sessionsDir);
      if (real.startsWith(root + path.sep)) return account.home;
    } catch {
      continue;
    }
  }
  return null;
}

function accountIdForLabel(label: string, existing: Set<string>): string {
  const base = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "account";
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base.slice(0, 32 - String(suffix).length - 1)}-${suffix}`;
    if (ACCOUNT_ID.test(candidate) && candidate !== DEFAULT_ID && !existing.has(candidate) && !fs.existsSync(managedHome(candidate)) && !fs.existsSync(retiredAccountArchive("codex", candidate))) return candidate;
  }
}

export function createManagedCodexAccount(label: string): CodexAccount {
  const cleanLabel = label.trim();
  if (!cleanLabel || cleanLabel.length > 80 || /[\u0000-\u001f\u007f]/.test(cleanLabel)) throw new InvalidAccountLabelError();
  return withRegistryLock(() => {
    cached = null;
    const registry = mutableRegistry();
    const id = accountIdForLabel(cleanLabel, new Set([...listCodexAccounts().map((account) => account.id), ...registry.retired.map((account) => account.id)]));
    const home = managedHome(id);
    let createdHome = false;
    try {
      fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
      fs.mkdirSync(home, { recursive: false, mode: 0o700 });
      createdHome = true;
      fs.chmodSync(home, 0o700);
      for (const entry of OVERLAY_LINKS) fs.symlinkSync(path.join(legacyHome(), entry), path.join(home, entry));
      fs.mkdirSync(path.join(home, "plugins"), { mode: 0o700 });
      fs.symlinkSync(path.join(legacyHome(), "plugins", "cache"), path.join(home, "plugins", "cache"));
      const stored: StoredAccount = { id, label: cleanLabel, kind: "managed", createdAt: Date.now(), loginPane: null };
      writeRegistry({ ...registry, accounts: [...registry.accounts, stored] });
      return asAccount(stored);
    } catch (error) {
      if (createdHome) {
        try {
          if (!removeHistoryFreeAccountHome("codex", id, home)) console.warn("[codex accounts] failed-account home cleanup is incomplete");
        } catch (cleanupError) {
          console.warn("[codex accounts] preserving failed-account home after history cleanup refusal");
          if (cleanupError instanceof AccountHistoryInventoryBlockedError) throw cleanupError;
        }
      }
      throw error;
    }
  });
}

function historyFitsRetainedSessions(report: AccountHistoryInventoryReport): boolean {
  return report.artifacts.filter((artifact) => artifact.history).every((artifact) => artifact.path.startsWith(`sessions${path.sep}`));
}

function writeJournal(id: string, phase: "archiving" | "scrubbing" | null): void {
  cached = null;
  const current = mutableRegistry();
  writeRegistry({ ...current, removals: withAccountRemovalJournal(current.removals, id, phase) });
}

function recoverRemovalsLocked(): { recovered: string[]; unresolved: string[] } {
  cached = null;
  const registry = mutableRegistry();
  const recovered: string[] = [];
  const unresolved: string[] = [];
  for (const entry of registry.removals) {
    if (accountRemovalInFlight("codex", entry.id)) continue;
    let settled = false;
    try {
      settled = recoverManagedAccountRemoval({
        engine: "codex",
        accountId: entry.id,
        home: managedHome(entry.id),
        phase: entry.phase,
        listed: registry.accounts.some((account) => account.id === entry.id),
        clearJournal: () => writeJournal(entry.id, null),
      });
    } catch {
      /* stays journaled; one stuck record never blocks another account */
    }
    (settled ? recovered : unresolved).push(entry.id);
  }
  return { recovered, unresolved };
}

/** Settles removals a crash interrupted (issue #1857): an unfinished move is
    undone, a committed one is finished. */
export function recoverInterruptedCodexAccountRemovals(): { recovered: string[]; unresolved: string[] } {
  return withRegistryLock(() => recoverRemovalsLocked());
}

let startupRecoveryDone = false;
/** Runs recovery once per process, on the first listing. A held registry lock
    means another mutation is running; the next listing tries again. */
function recoverRemovalsAtStartup(): void {
  if (startupRecoveryDone) return;
  const loaded = readRegistry();
  if (loaded.corrupt || loaded.registry.removals.length === 0) {
    startupRecoveryDone = true;
    return;
  }
  if (fs.existsSync(registryLockPath()) && !registryLockOwnerGone(registryLockPath())) return;
  try {
    recoverInterruptedCodexAccountRemovals();
    startupRecoveryDone = true;
  } catch {
    /* busy: retried by the next listing */
  }
}

/**
 * Removes a managed account (issue #1857). The whole home, rollouts and
 * provider state included, moves in one rename into
 * `shared/codex/retired/<id>/`; registry paths move with it, the scanner and
 * `/api/log` keep reading `sessions/` there, and only `auth.json` and the
 * Viewer's overlay links are deleted.
 */
export function removeManagedCodexAccount(id: string): AccountArchiveRemovalReport {
  return withRegistryLock(() => {
    recoverRemovalsLocked();
    cached = null;
    const registry = mutableRegistry();
    const existing = registry.accounts.find((account) => account.id === id);
    if (!existing) throw new UnknownAccountError(id);
    const before: Registry = { ...registry, removals: withAccountRemovalJournal(registry.removals, id, null) };
    return removeManagedAccountIntoArchive({
      engine: "codex",
      accountId: id,
      home: managedHome(id),
      homeIsSafe: () => managedHomeIsSafe(id, true),
      unsafeHome: () => new UnsafeCodexHomeError(),
      rewrites: (home, archive) => {
        const spellings = [home];
        try { const real = fs.realpathSync(home); if (real !== home) spellings.push(real); } catch { /* the lexical spelling still applies */ }
        return spellings.map((spelling) => ({ from: spelling, to: archive }));
      },
      registry: {
        journal: (phase) => writeJournal(id, phase),
        commitRetired: () => writeRegistry({
          ...before,
          active: before.active === id ? DEFAULT_ID : before.active,
          accounts: before.accounts.filter((account) => account.id !== id),
          retired: [...before.retired.filter((account) => account.id !== id), { id, label: existing.label, retiredAt: Date.now(), archived: true }],
          removals: withAccountRemovalJournal(before.removals, id, "scrubbing"),
        }),
        restore: () => writeRegistry(before),
      },
    });
  });
}

/** Removes failed-login homes that have no registry owner. Only safe direct
 *  children qualify. Retired archives are never deleted — their sessions are
 *  the point — but a strip left incomplete by an earlier removal is retried. */
export function cleanupOrphanedCodexHomes(): AccountOrphanCleanupReport {
  return withRegistryLock(() => {
    recoverRemovalsLocked();
    cached = null;
    const registry = mutableRegistry();
    const registered = new Set(registry.accounts.map((account) => account.id));
    const retired = new Set(registry.retired.map((account) => account.id));
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(codexAccountsRoot(), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: [], unresolved: [] }; throw error; }
    const removed: string[] = [];
    const unresolved: string[] = [];
    const historyReports: Record<string, AccountHistoryInventoryReport> = {};
    for (const entry of entries) {
      if (registered.has(entry.name)) continue;
      if (accountRemovalBlockers("codex", entry.name).length > 0) { unresolved.push(entry.name); continue; }
      if (!entry.isDirectory() || !managedHomeIsSafe(entry.name, true)) { unresolved.push(entry.name); continue; }
      let history: AccountHistoryInventoryReport;
      try { history = accountHistoryInventory("codex", entry.name, managedHome(entry.name)); }
      catch (error) {
        if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
        unresolved.push(entry.name); continue;
      }
      if (retired.has(entry.name)) {
        if (!history.artifacts.some((artifact) => artifact.history)) {
          try {
            if (removeHistoryFreeAccountHome("codex", entry.name, managedHome(entry.name))) removed.push(entry.name);
            else unresolved.push(entry.name);
          } catch (error) {
            if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
            unresolved.push(entry.name);
          }
          continue;
        }
        if (!historyFitsRetainedSessions(history)) { historyReports[entry.name] = history; unresolved.push(entry.name); continue; }
        try {
          const scrub = scrubAccountHomeToRetainedHistory("codex", entry.name, managedHome(entry.name), "sessions");
          if (!scrub.complete) unresolved.push(entry.name);
          else if (scrub.changed) removed.push(entry.name);
        } catch (error) {
          if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
          unresolved.push(entry.name);
        }
        continue;
      }
      if (history.artifacts.some((artifact) => artifact.history)) { historyReports[entry.name] = history; unresolved.push(entry.name); continue; }
      try {
        if (removeHistoryFreeAccountHome("codex", entry.name, managedHome(entry.name))) removed.push(entry.name);
        else unresolved.push(entry.name);
      }
      catch (error) {
        if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
        unresolved.push(entry.name);
      }
    }
    return {
      removed: removed.sort(),
      unresolved: unresolved.sort(),
      ...(Object.keys(historyReports).length > 0 ? { history: historyReports } : {}),
    };
  });
}

export function setCodexAccountLoginPane(id: string, loginPane: LoginPane | null): void {
  withRegistryLock(() => {
    cached = null;
    const registry = mutableRegistry();
    const index = registry.accounts.findIndex((account) => account.id === id);
    if (index < 0) throw new UnknownAccountError(id);
    const accounts = [...registry.accounts];
    accounts[index] = { ...accounts[index]!, loginPane };
    writeRegistry({ ...registry, accounts });
  });
}

export type CodexLoginState = "pending" | "idle" | "authenticated";

/** Pure reconciliation rule for the tracked device-login pane. */
export function codexLoginPaneStatus(
  authPresent: boolean,
  loginPane: LoginPane | null,
  pane: Pick<{ windowName: string; command: string }, "windowName" | "command"> | null,
  now = Date.now(),
): { state: CodexLoginState; clear: boolean } {
  if (authPresent) return { state: "authenticated", clear: loginPane !== null };
  if (!loginPane) return { state: "idle", clear: false };
  const withinGrace = now - loginPane.startedAt < LOGIN_STARTUP_GRACE_MS;
  // A null pane can mean a transient tmux failure (nsenter wrapper hiccup, non-zero
  // exit) as easily as a genuinely dead window. During the startup grace keep the
  // login pending so one blip can't permanently strand a device login; only at or
  // past the deadline does a missing pane become idle and clear the tracked pane.
  if (!pane) return withinGrace ? { state: "pending", clear: false } : { state: "idle", clear: true };
  if (pane.windowName !== loginPane.windowName) return { state: "idle", clear: true };
  if (isShellCommand(pane.command)) {
    return withinGrace ? { state: "pending", clear: false } : { state: "idle", clear: true };
  }
  return { state: "pending", clear: false };
}
