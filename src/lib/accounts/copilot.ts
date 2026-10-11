import { withoutUnsupportedApiCredentials } from "@/lib/environmentIsolation";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stateDir, statePath } from "@/lib/configDir";

import type { AccountRetirementReport } from "@/lib/agent/registry";

import { withAccountMutationLock } from "./accountMutation";
import type { AccountContext } from "./contracts";
import { retireAccountInPlace } from "./removal";

/**
 * GitHub Copilot accounts (docs/design/copilot-engine.md 3.9).
 *
 * Each managed account is its own `COPILOT_HOME` under
 * `<config>/agent-log-viewer/accounts/copilot/<id>`, created 0700. The CLI
 * keeps its login, `session-state/` transcripts and settings inside that
 * home, which is what keeps two accounts apart. The legacy account is the
 * operator's own `$COPILOT_HOME` or `~/.copilot`: it is scanned when it
 * exists and launched into only when the operator selects it.
 *
 * Authentication and quota are read from the account's own config and
 * transcript. The token itself stays in the desktop keyring and is never read
 * by this module.
 */

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const COPILOT_LEGACY_ACCOUNT_ID = "default";

export interface CopilotAccount {
  id: string;
  label: string;
  kind: "legacy" | "managed";
  home: string;
  /** `<home>/session-state`, the transcript root the scanner reads. */
  sessionStateDir: string;
  createdAt: number;
  auth: "signed_in" | "signed_out" | "unknown";
}

export interface CopilotSignedInIdentity { host: string; login: string }

/** Return the listed last user from the CLI config without reading token data. */
export function copilotSignedInIdentity(home: string): CopilotSignedInIdentity | null {
  try {
    const text = fs.readFileSync(path.join(home, "config.json"), "utf8").replace(/^\s*\/\/.*(?:\r?\n|$)/gm, "");
    const parsed = JSON.parse(text) as {
      lastLoggedInUser?: { host?: unknown; login?: unknown };
      loggedInUsers?: Array<{ host?: unknown; login?: unknown }>;
    };
    const last = parsed.lastLoggedInUser;
    if (typeof last?.host !== "string" || typeof last.login !== "string" || !last.login.trim()) return null;
    return Array.isArray(parsed.loggedInUsers) && parsed.loggedInUsers.some((user) => user?.host === last.host && user.login === last.login)
      ? { host: last.host, login: last.login }
      : null;
  } catch { return null; }
}

/** The login recorded by the Copilot CLI, without exposing token material. */
export function copilotSignedInUser(home: string): string | null {
  return copilotSignedInIdentity(home)?.login ?? null;
}

interface StoredAccount { id: string; label: string; createdAt: number }
/** A removed managed account. Its home stays where it was, so its
    `session-state/` transcripts stay readable. */
interface RetiredAccount { id: string; label: string; retiredAt: number }
/** `legacyHidden`: the operator removed the default home from Delegatus; it is
    neither listed nor picked, and nothing in it is touched. */
interface Registry { version: 1; active: string | null; accounts: StoredAccount[]; retired?: RetiredAccount[]; legacyHidden?: true }

export class UnknownCopilotAccountError extends Error {
  constructor(id: string) {
    super(`unknown Copilot account: ${id}`);
    this.name = "UnknownCopilotAccountError";
  }
}

export class NoCopilotAccountError extends Error {
  constructor() {
    super("no GitHub Copilot account is set up; add one in Accounts and sign in with its login command");
    this.name = "NoCopilotAccountError";
  }
}

export function copilotAccountsRoot(): string {
  return path.join(path.dirname(stateDir()), "accounts", "copilot");
}

function registryPath(): string {
  return statePath("copilot-accounts.json");
}

function managedHome(id: string): string {
  return path.join(copilotAccountsRoot(), id);
}

export function copilotConfigCheckedAt(home: string): string | null {
  try { return fs.statSync(path.join(home, "config.json")).mtime.toISOString(); }
  catch { return null; }
}

function authState(home: string): CopilotAccount["auth"] {
  try {
    fs.accessSync(path.join(home, "config.json"));
  } catch { return "unknown"; }
  try {
    const raw = fs.readFileSync(path.join(home, "config.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    JSON.parse(raw);
  } catch { return "unknown"; }
  return copilotSignedInUser(home) ? "signed_in" : "signed_out";
}

/** The operator's own Copilot home: `$COPILOT_HOME`, else `~/.copilot`. */
export function legacyCopilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.COPILOT_HOME?.trim() || path.join(os.homedir(), ".copilot"));
}

function readRegistry(requireComplete = false): Registry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as Partial<Registry>;
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter((item): item is StoredAccount => !!item
        && typeof item.id === "string" && ACCOUNT_ID.test(item.id) && item.id !== COPILOT_LEGACY_ACCOUNT_ID
        && typeof item.label === "string" && typeof item.createdAt === "number")
      : [];
    if (requireComplete && (!Array.isArray(parsed.accounts) || accounts.length !== parsed.accounts.length)) throw new Error("Copilot account names are unreadable");
    const retired = Array.isArray(parsed.retired)
      ? parsed.retired.filter((item): item is RetiredAccount => !!item
        && typeof item.id === "string" && ACCOUNT_ID.test(item.id) && item.id !== COPILOT_LEGACY_ACCOUNT_ID
        && typeof item.label === "string" && typeof item.retiredAt === "number")
      : [];
    return {
      version: 1,
      active: typeof parsed.active === "string" ? parsed.active : null,
      accounts,
      ...(retired.length ? { retired } : {}),
      ...(parsed.legacyHidden === true ? { legacyHidden: true as const } : {}),
    };
  } catch (error) {
    if (requireComplete && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, active: null, accounts: [] };
  }
}

function writeRegistry(registry: Registry): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function legacyAccount(): CopilotAccount | null {
  const home = legacyCopilotHome();
  if (!fs.existsSync(home) || readRegistry().legacyHidden) return null;
  return {
    id: COPILOT_LEGACY_ACCOUNT_ID,
    label: "Default",
    kind: "legacy",
    home,
    sessionStateDir: path.join(home, "session-state"),
    createdAt: 0,
    auth: authState(home),
  };
}

/** Stored names for publication checks without opening account credentials. */
export function copilotAccountsForPrivacy(): readonly { id: string; label: string }[] {
  const registry = readRegistry(true);
  return [{ id: COPILOT_LEGACY_ACCOUNT_ID, label: "Default" }, ...registry.accounts, ...registry.retired ?? []];
}

export function listCopilotAccounts(): CopilotAccount[] {
  const managed = readRegistry().accounts.map((stored): CopilotAccount => ({
    id: stored.id,
    label: stored.label,
    kind: "managed",
    home: managedHome(stored.id),
    sessionStateDir: path.join(managedHome(stored.id), "session-state"),
    createdAt: stored.createdAt,
    auth: authState(managedHome(stored.id)),
  }));
  const legacy = legacyAccount();
  return legacy ? [legacy, ...managed] : managed;
}

/** The selected account; with none selected, the first managed account. The
    legacy home is never picked by default. */
export function activeCopilotAccountId(): string | null {
  const registry = readRegistry();
  const accounts = listCopilotAccounts();
  if (registry.active && accounts.some((account) => account.id === registry.active)) return registry.active;
  return accounts.find((account) => account.kind === "managed")?.id ?? null;
}

export function setActiveCopilotAccount(id: string): void {
  withAccountMutationLock(() => {
    if (!listCopilotAccounts().some((account) => account.id === id)) throw new UnknownCopilotAccountError(id);
    writeRegistry({ ...readRegistry(), active: id });
  });
}

export function createManagedCopilotAccount(label: string): CopilotAccount {
  const clean = label.trim();
  if (!clean || clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error("account label must contain visible text and be at most 80 characters");
  }
  return withAccountMutationLock(() => {
    const registry = readRegistry();
    const taken = new Set([COPILOT_LEGACY_ACCOUNT_ID, ...registry.accounts.map((account) => account.id), ...(registry.retired ?? []).map((account) => account.id)]);
    const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "account";
    let id = base;
    for (let suffix = 1; taken.has(id) || !ACCOUNT_ID.test(id) || fs.existsSync(managedHome(id)); suffix += 1) {
      id = `${base.slice(0, 32 - String(suffix).length - 1)}-${suffix}`;
    }
    const home = managedHome(id);
    fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
    fs.mkdirSync(home, { mode: 0o700 });
    fs.chmodSync(home, 0o700);
    const stored: StoredAccount = { id, label: clean, createdAt: Date.now() };
    writeRegistry({ ...registry, accounts: [...registry.accounts, stored] });
    return listCopilotAccounts().find((account) => account.id === id)!;
  });
}

/** Transcript roots of removed accounts: each retired home in place, and the
    default home once it is hidden. */
export function retiredCopilotSessionRoots(): string[] {
  const registry = readRegistry();
  return [
    ...(registry.legacyHidden ? [path.join(legacyCopilotHome(), "session-state")] : []),
    ...(registry.retired ?? []).map((account) => path.join(managedHome(account.id), "session-state")),
  ];
}

/** Every Copilot transcript root the scanner reads, resolved per call:
    live accounts first, then retained history. */
export function copilotSessionRoots(): string[] {
  return [...new Set([...listCopilotAccounts().map((account) => account.sessionStateDir), ...retiredCopilotSessionRoots()])];
}

/** What a Copilot removal did, for the DELETE answer. */
export type CopilotAccountRemoval = AccountRetirementReport & {
  /** The home whose transcripts stay readable where they are. */
  home: string;
  /** True for the default home, which Delegatus only stopped listing. */
  hidden: boolean;
  /** The sign-in file of a managed home could not be deleted. */
  cleanupPending: boolean;
};

/**
 * Removes a Copilot account from Delegatus. A managed account leaves the
 * list with a retired record; its home stays in place so `session-state/`
 * remains readable, and only its sign-in file (`config.json`, which holds the
 * token when the operator chose plaintext storage) is deleted. The default
 * home is only hidden: nothing in it is touched. Pins, owed deliveries and
 * routing aimed at the account settle as for every other engine.
 */
export function removeCopilotAccount(id: string): CopilotAccountRemoval {
  return withAccountMutationLock(() => {
    const account = listCopilotAccounts().find((candidate) => candidate.id === id);
    if (!account) throw new UnknownCopilotAccountError(id);
    const registry = readRegistry(true);
    const remaining = registry.accounts.filter((item) => item.id !== id);
    const retirement = retireAccountInPlace({
      engine: "copilot",
      accountId: id,
      fallbackAccountId: null,
      commit: () => writeRegistry(account.kind === "legacy"
        ? { ...registry, active: registry.active === id ? null : registry.active, legacyHidden: true }
        : {
          ...registry,
          active: registry.active === id ? null : registry.active,
          accounts: remaining,
          retired: [...(registry.retired ?? []).filter((item) => item.id !== id), { id, label: account.label, retiredAt: Date.now() }],
        }),
    });
    let cleanupPending = false;
    if (account.kind === "managed") {
      const credential = path.join(account.home, "config.json");
      try {
        const stat = fs.lstatSync(credential);
        if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(credential);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupPending = true;
      }
    }
    return { ...retirement, home: account.home, hidden: account.kind === "legacy", cleanupPending };
  });
}

/** True once the operator removed the default home from Delegatus. */
export function copilotLegacyAccountHidden(): boolean {
  return readRegistry().legacyHidden === true;
}

/** Lists the default home again after its removal; nothing in it was touched. */
export function restoreLegacyCopilotAccount(): void {
  withAccountMutationLock(() => {
    const { legacyHidden, ...registry } = readRegistry(true);
    if (!legacyHidden) throw new UnknownCopilotAccountError(COPILOT_LEGACY_ACCOUNT_ID);
    writeRegistry(registry);
  });
}

export function copilotHomeOwningSessionPath(pathname: string): string | null {
  let real: string;
  try { real = fs.realpathSync(pathname); } catch { return null; }
  for (const account of listCopilotAccounts()) {
    try {
      const root = fs.realpathSync(account.sessionStateDir);
      if (real.startsWith(root + path.sep)) return account.home;
    } catch { /* a root that does not exist yet owns nothing */ }
  }
  return null;
}

/** The spawn context for a Copilot account. The environment is the Viewer's;
    the host filters it down to an allowlist, so `GH_TOKEN` and friends never
    reach the child. */
export function copilotAccountContext(account: CopilotAccount): AccountContext {
  return {
    engine: "copilot",
    accountId: account.id,
    kind: account.kind,
    home: account.home,
    transcriptRoot: account.sessionStateDir,
    env: withoutUnsupportedApiCredentials(process.env),
  };
}

export function copilotAccountForSpawn(requested?: string | null): AccountContext {
  const id = requested ?? activeCopilotAccountId();
  if (!id) throw new NoCopilotAccountError();
  const account = listCopilotAccounts().find((candidate) => candidate.id === id);
  if (!account) throw new UnknownCopilotAccountError(id);
  return copilotAccountContext(account);
}

/** The copyable command that signs a managed account in, run in a terminal. */
export function copilotLoginCommand(home: string, binary = "copilot"): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return `COPILOT_HOME=${quote(home)} ${quote(binary)} login --device-code`;
}
