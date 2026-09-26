import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { stateDir, statePath } from "@/lib/configDir";
import { CLAUDE_ACCOUNTS_SOURCE, readAccountSource, writeAccountSource } from "./accountsStore";
import { claudeCredentialFileState, readClaudeCredentials, type ClaudeCredentialRead } from "./claudeCredentials";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";
import { withAccountMutationLock } from "./accountMutation";
import { providerSecretsAtHome, retainProviderRedactionSecrets } from "./providerSecretRedaction";
import { AccountHistoryInventoryBlockedError, accountHistoryInventory, accountRemovalBlockers, accountRemovalInFlight, cleanupAccountProviderSidecars, normalizeAccountRemovalJournal, recoverManagedAccountRemoval, removeHistoryFreeAccountHome, removeManagedAccountIntoArchive, retiredAccountArchive, scrubAccountHomeToRetainedHistory, withAccountRemovalJournal, type AccountArchiveRemovalReport, type AccountHistoryInventoryReport, type AccountOrphanCleanupReport, type AccountRemovalJournalEntry, type AccountRemovalJournalPhase } from "./removal";
import type { AccountPathRewrite } from "@/lib/agent/registry";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_ID = "default";
const VERSION = 1;
const CAPABILITY_DIRS = ["skills", "commands", "agents"] as const;
const CAPABILITY_FILES = ["settings.json"] as const;
const PRIVATE_NAMES = new Set([".credentials.json", ".provider-token", ".provider-headers", ".provider-runtime", ".claude.json", "projects", "history.jsonl", "session-env", "shell-snapshots", "file-history", "todos", "cache", "debug", "backups", "paste-cache", "plugins", "mcp.json", "settings.local.json"]);
const MAX_CAPABILITY_FILES = 2_000;
const MAX_CAPABILITY_BYTES = 16 * 1024 * 1024;
const REGISTRY_LOCK_WAIT_MS = 5_000;
const REGISTRY_LOCK_STALE_MS = 30_000;

export type ClaudeAccount = {
  id: string;
  label: string;
  kind: "legacy" | "managed";
  home: string;
  projectsDir: string;
  authPresent: boolean;
  credentialState?: ClaudeCredentialRead["state"];
  /** Secret-free configuration for an Anthropic Messages compatible endpoint. */
  provider?: ClaudeProviderConfig;
  createdAt: number;
};

export type ClaudeProviderConfig = { baseUrl: string; model: string; smallFastModel: string | null; customHeaderNames?: string[] };
type StoredAccount = { id: string; label: string; kind: "managed"; createdAt: number; provider?: ClaudeProviderConfig };
/** A removed account. `archived` leftovers live in the shared archive
    (issue #1857); older records kept their transcript tree in the home (#643). */
type RetiredAccount = { id: string; label: string; retiredAt: number; archived?: true };
/** `removals` journals account removals in flight (issue #1857). */
type Registry = { version: number; active: string; accounts: StoredAccount[]; retired: RetiredAccount[]; removals: AccountRemovalJournalEntry[] };
type Loaded = { registry: Registry; corrupt: boolean };

export class UnknownClaudeAccountError extends Error { constructor(id: string) { super(`unknown Claude account: ${id}`); this.name = "UnknownClaudeAccountError"; } }
export class InvalidClaudeAccountLabelError extends Error { constructor() { super("account label must contain visible text and be at most 80 characters"); this.name = "InvalidClaudeAccountLabelError"; } }
export class CorruptClaudeAccountsError extends Error { constructor() { super("Claude account registry is corrupt; repair or remove it before changing accounts"); this.name = "CorruptClaudeAccountsError"; } }
export class UnsafeClaudeHomeError extends Error { constructor() { super("managed Claude home failed safety checks"); this.name = "UnsafeClaudeHomeError"; } }

export function legacyClaudeHome(): string { return path.resolve(process.env.LLV_CLAUDE_HOME || path.join(os.homedir(), ".claude")); }
export function claudeAccountsRoot(): string { return path.join(path.dirname(stateDir()), "accounts", "claude"); }
export function claudeRegistryPath(): string { return statePath("claude-accounts.json"); }
export function claudeCapabilitiesRoot(): string { return path.join(path.dirname(stateDir()), "shared", "claude"); }

/* Shared transcript store (issue #891, phase 1). Transcripts are viewer data,
   not credentials — the per-account layout was a side effect of per-account
   CLI config homes, never an isolation requirement. When an account home's
   `projects` is a symlink into this root, the account reports the canonical
   shared path: every consumer (scanner, spawn specs, migration provider)
   then addresses one store while the CLI keeps writing through its own
   $CLAUDE_CONFIG_DIR/projects. Homes not yet cut over keep their local dir,
   so the store can be adopted per account. */
export function sharedClaudeProjectsRoot(): string { return path.join(claudeCapabilitiesRoot(), "projects"); }

function projectsDirFor(home: string): string {
  const local = path.join(home, "projects");
  try {
    if (!fs.lstatSync(local).isSymbolicLink()) return local;
    const shared = sharedClaudeProjectsRoot();
    if (fs.realpathSync(local) === fs.realpathSync(shared)) return shared;
  } catch { /* unresolved link or missing dir: treat as not cut over */ }
  return local;
}
function managedHome(id: string): string { return path.join(claudeAccountsRoot(), id); }
function defaults(): Registry { return { version: VERSION, active: DEFAULT_ID, accounts: [], retired: [], removals: [] }; }
function safeMode(mode: number, required: number): boolean { return (mode & 0o077) === 0 && (mode & 0o777) === required; }

/** Never trust an on-disk registry path: ids derive the only valid managed home. */
export function managedClaudeHomeIsSafe(id: string, requireExisting = false): boolean {
  if (!ACCOUNT_ID.test(id) || id === DEFAULT_ID) return false;
  const root = path.resolve(claudeAccountsRoot());
  const home = path.resolve(managedHome(id));
  if (path.dirname(home) !== root) return false;
  try {
    const rootStat = fs.lstatSync(root);
    const homeStat = fs.lstatSync(home);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !homeStat.isDirectory() || homeStat.isSymbolicLink() || !safeMode(homeStat.mode, 0o700)) return false;
    return path.dirname(fs.realpathSync(home)) === fs.realpathSync(root);
  } catch { return !requireExisting; }
}

function validStored(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredAccount>;
  return typeof item.id === "string" && typeof item.label === "string" && item.kind === "managed" && typeof item.createdAt === "number" && managedClaudeHomeIsSafe(item.id)
    && (item.provider === undefined || validProviderConfig(item.provider));
}

function validProviderConfig(value: unknown): value is ClaudeProviderConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<ClaudeProviderConfig>;
  if (typeof config.baseUrl !== "string" || typeof config.model !== "string"
    || !(config.smallFastModel === null || typeof config.smallFastModel === "string")) return false;
  try { validateProviderConfig(config as ClaudeProviderConfig); return true; } catch { return false; }
}

export function validateProviderConfig(config: ClaudeProviderConfig): ClaudeProviderConfig {
  const url = new URL(config.baseUrl);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || !url.pathname) throw new Error("Invalid provider base URL");
  const modelId = (value: string) => value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) && value.trim() === value;
  if (!modelId(config.model) || (config.smallFastModel !== null && !modelId(config.smallFastModel))) throw new Error("Invalid provider model id");
  const names = config.customHeaderNames ?? [];
  if (!Array.isArray(names) || names.length > 16 || names.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/i.test(name)
    || ["authorization", "proxy-authorization", "x-api-key", "host", "x-opencode-session", "user-agent", "connection", "transfer-encoding", "content-length", "content-encoding", "accept-encoding"].includes(name.toLowerCase()))
    || new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error("Invalid provider header names");
  return { baseUrl: url.href.replace(/\/$/, ""), model: config.model, smallFastModel: config.smallFastModel,
    ...(names.length ? { customHeaderNames: names.map((name) => name.toLowerCase()) } : {}) };
}

// OpenCode Go documents these IDs on its Anthropic Messages endpoint.
const GO_MESSAGES_MODELS = new Set(["minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus"]);
export function isOpenCodeGo(config: ClaudeProviderConfig): boolean {
  return config.baseUrl === "https://opencode.ai/zen/go";
}
export function claudeProviderModelChoices(config: ClaudeProviderConfig, models: string[]): string[] {
  return isOpenCodeGo(config) ? models.filter((model) => GO_MESSAGES_MODELS.has(model)) : models;
}
export function validateClaudeProviderModelRoute(config: ClaudeProviderConfig): void {
  if (isOpenCodeGo(config) && (!GO_MESSAGES_MODELS.has(config.model)
    || (config.smallFastModel !== null && !GO_MESSAGES_MODELS.has(config.smallFastModel)))) {
    throw new Error("OpenCode Go model must support Anthropic Messages");
  }
}

export function validateClaudeProviderHeaders(value: Record<string, string>): Record<string, string> {
  const names = Object.keys(value);
  validateProviderConfig({ baseUrl: "http://127.0.0.1", model: "validation", smallFastModel: null, customHeaderNames: names });
  if (names.some((name) => typeof value[name] !== "string" || value[name]!.length < 8 || value[name]!.length > 4096 || /[\r\n\u0000-\u001f\u007f]/.test(value[name]!))) throw new Error("Provider header values must be at least eight characters");
  return Object.fromEntries(names.map((name) => [name.toLowerCase(), value[name]!]));
}

const PROVIDER_TOKEN_FILE = ".provider-token";
const PROVIDER_HEADERS_FILE = ".provider-headers";
const PROVIDER_RUNTIME_FILE = ".provider-runtime";
function providerTokenPath(home: string): string { return path.join(home, PROVIDER_TOKEN_FILE); }

export type ClaudeProviderRuntime = { config: ClaudeProviderConfig; token: string; headers: Record<string, string> };
function providerRuntimePath(home: string): string { return path.join(home, PROVIDER_RUNTIME_FILE); }
function writeProviderRuntime(home: string, runtime: ClaudeProviderRuntime): void {
  const config = validateProviderConfig(runtime.config);
  validateClaudeProviderModelRoute(config);
  const headers = validateClaudeProviderHeaders(runtime.headers);
  if (runtime.token.length < 8 || runtime.token.length > 4096 || /[\r\n\u0000]/.test(runtime.token)) throw new Error("Invalid provider token");
  const target = providerRuntimePath(home);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify({ config, token: runtime.token, headers }), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** The endpoint and credential are one atomic read; sidecars must agree. */
export function readClaudeProviderRuntime(home: string, expected?: ClaudeProviderConfig): ClaudeProviderRuntime {
  try {
    const file = providerRuntimePath(home);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 100_000) throw new UnsafeClaudeHomeError();
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ClaudeProviderRuntime;
    const config = validateProviderConfig(raw.config);
    validateClaudeProviderModelRoute(config);
    const headers = validateClaudeProviderHeaders(raw.headers);
    if (expected && JSON.stringify(config) !== JSON.stringify(validateProviderConfig(expected))) throw new UnsafeClaudeHomeError();
    if (readClaudeProviderToken(home) !== raw.token) throw new UnsafeClaudeHomeError();
    const sidecarHeaders = readClaudeProviderHeaders(home, config.customHeaderNames);
    if (Object.keys(sidecarHeaders).length !== Object.keys(headers).length
      || Object.entries(headers).some(([name, value]) => sidecarHeaders[name] !== value)) throw new UnsafeClaudeHomeError();
    return { config, token: raw.token, headers };
  } catch { throw new UnsafeClaudeHomeError(); }
}
export function readClaudeProviderHeaders(home: string, expectedNames: readonly string[] = []): Record<string, string> {
  const file = path.join(home, PROVIDER_HEADERS_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 70_000) throw new UnsafeClaudeHomeError();
    const headers = validateClaudeProviderHeaders(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>);
    if (expectedNames.length && (Object.keys(headers).length !== expectedNames.length
      || expectedNames.some((name) => headers[name.toLowerCase()] === undefined))) throw new UnsafeClaudeHomeError();
    return headers;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && expectedNames.length === 0) return {};
    throw new UnsafeClaudeHomeError();
  }
}
function writeProviderHeaders(home: string, headers: Record<string, string>): void {
  const checked = validateClaudeProviderHeaders(headers);
  const target = path.join(home, PROVIDER_HEADERS_FILE);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(checked), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function readClaudeProviderToken(home: string): string | null {
  try {
    const file = providerTokenPath(home);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) return null;
    const token = fs.readFileSync(file, "utf8");
    return token.length >= 8 && token.length <= 4096 && !/[\r\n\u0000]/.test(token) ? token : null;
  } catch { return null; }
}
function writeProviderToken(home: string, token: string): void {
  if (token.length < 8 || token.length > 4096 || /[\r\n\u0000]/.test(token)) throw new Error("Invalid provider token");
  const target = providerTokenPath(home);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, token, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function validRetired(value: unknown): value is RetiredAccount {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RetiredAccount>;
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.retiredAt === "number" && (item.archived === undefined || item.archived === true) && managedClaudeHomeIsSafe(item.id);
}

function normalize(value: unknown): Loaded {
  if (!value || typeof value !== "object") return { registry: defaults(), corrupt: true };
  const raw = value as Partial<Registry>;
  if (raw.version !== VERSION || typeof raw.active !== "string" || !Array.isArray(raw.accounts)) return { registry: defaults(), corrupt: true };
  /* `retired` post-dates version 1; a registry written before it is complete, not corrupt. */
  if (raw.retired !== undefined && !Array.isArray(raw.retired)) return { registry: defaults(), corrupt: true };
  const seen = new Set<string>();
  let corrupt = false;
  const accounts: StoredAccount[] = [];
  for (const item of raw.accounts) {
    if (!validStored(item) || seen.has(item.id)) { corrupt = true; continue; }
    seen.add(item.id); accounts.push(item);
  }
  const retired: RetiredAccount[] = [];
  for (const item of raw.retired ?? []) {
    if (!validRetired(item) || seen.has(item.id)) { corrupt = true; continue; }
    seen.add(item.id); retired.push(item);
  }
  const removals = normalizeAccountRemovalJournal(raw.removals, (id) => ACCOUNT_ID.test(id) && id !== DEFAULT_ID);
  if (!removals) return { registry: defaults(), corrupt: true };
  return { registry: { version: VERSION, active: raw.active, accounts, retired, removals }, corrupt };
}

/* The registry is the `accounts` collection of state.sqlite (#1870, slice 7).
   The rows hold what `claude-accounts.json` held, so every check below is the
   one it always was, including what counts as corrupt. */
function readRegistry(): Loaded {
  const read = readAccountSource(CLAUDE_ACCOUNTS_SOURCE);
  if (read.kind === "legacy") return readLegacyRegistryFile();
  /* A registry whose record could not be read is corrupt, never empty: Main is
     served and every mutation refuses, the same answer the unparseable file
     always gave. */
  if (read.kind === "gap") return { registry: defaults(), corrupt: true };
  return read.body === undefined ? { registry: defaults(), corrupt: false } : normalize(read.body);
}

/** The pre-#1870 read, for a release that is not yet allowed to import. */
function readLegacyRegistryFile(): Loaded {
  const file = claudeRegistryPath();
  try { return fs.existsSync(file) ? normalize(JSON.parse(fs.readFileSync(file, "utf8"))) : { registry: defaults(), corrupt: false }; }
  catch { return { registry: defaults(), corrupt: true }; }
}
function mutable(): Registry { const loaded = readRegistry(); if (loaded.corrupt) throw new CorruptClaudeAccountsError(); return loaded.registry; }
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function registryLockPath(): string { return `${claudeRegistryPath()}.lock`; }
/* The file lock is only ever taken inside the account mutation lock, so a lock
   left by a process that died (a crash mid-removal, #1857) is released at once
   instead of stalling every account mutation for the staleness window. */
function registryLockOwnerGone(lock: string): boolean {
  try {
    const pid = Number.parseInt(fs.readFileSync(lock, "utf8"), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function withRegistryLock<T>(operation: () => T): T {
  return withAccountMutationLock(() => {
    const lock = registryLockPath(); const started = Date.now(); fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        const fd = fs.openSync(lock, "wx", 0o600);
        try { fs.writeFileSync(fd, `${process.pid}\n`, "utf8"); return operation(); }
        finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try { if (registryLockOwnerGone(lock) || Date.now() - fs.statSync(lock).mtimeMs > REGISTRY_LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
        if (Date.now() - started >= REGISTRY_LOCK_WAIT_MS) throw new Error("Claude account registry is busy; retry shortly");
        sleep(10);
      }
    }
  });
}
/** One transaction: the account rows, the retired records and the removal
    journal step commit together, and the collection revision — the account
    mutation revision — advances with them (#1870). */
function write(registry: Registry): void {
  writeAccountSource(CLAUDE_ACCOUNTS_SOURCE, registry);
}

export function managedClaudeCredentialIsSafe(home: string, required = false): boolean {
  const state = claudeCredentialFileState(home);
  return state === "safe" || (!required && state === "absent");
}
function credentialPresence(home: string): Pick<ClaudeAccount, "authPresent" | "credentialState"> {
  const read = readClaudeCredentials(home);
  return { authPresent: read.state === "present", credentialState: read.state };
}
function account(stored: StoredAccount): ClaudeAccount { const home = managedHome(stored.id); return { ...stored, home, projectsDir: projectsDirFor(home), ...(stored.provider ? { authPresent: readClaudeProviderToken(home) !== null } : credentialPresence(home)) }; }
function main(): ClaudeAccount { const home = legacyClaudeHome(); return { id: DEFAULT_ID, label: "Main", kind: "legacy", home, projectsDir: projectsDirFor(home), ...credentialPresence(home), createdAt: 0 }; }
export function listClaudeAccounts(): ClaudeAccount[] { recoverRemovalsAtStartup(); return [main(), ...readRegistry().registry.accounts.map(account)]; }
/** Routing needs persisted membership only; credential discovery may spawn Keychain. */
export function activeClaudeAccountId(): string {
  const { active, accounts, removals } = readRegistry().registry;
  return !removals.some((item) => item.id === active) && accounts.some((item) => item.id === active) ? active : DEFAULT_ID;
}
export function claudeAccountsMutationLocked(): boolean { return readRegistry().corrupt; }
export function claudeAccountForSpawn(requested?: string | null): Pick<ClaudeAccount, "id" | "kind" | "home" | "projectsDir" | "provider"> { const found = listClaudeAccounts().find((item) => item.id === (requested ?? activeClaudeAccountId())); if (!found) throw new UnknownClaudeAccountError(requested ?? ""); if (found.kind === "managed" && (!managedClaudeHomeIsSafe(found.id, true) || (found.provider ? !found.authPresent : !managedClaudeCredentialIsSafe(found.home)))) throw new UnsafeClaudeHomeError(); return { id: found.id, kind: found.kind, home: found.home, projectsDir: found.projectsDir, provider: found.provider }; }
export function setActiveClaudeAccount(id: string): void {
  withAccountMutationLock(() => {
    const registry = mutable();
    if (id !== DEFAULT_ID && !registry.accounts.some((item) => item.id === id)) throw new UnknownClaudeAccountError(id);
    if (registry.removals.some((item) => item.id === id) || accountRemovalInFlight("claude", id)) throw new UnknownClaudeAccountError(id);
    write({ ...registry, active: id });
  });
}
/** Transcript trees kept by removed accounts: the shared archive (issue #1857),
    or the home itself for accounts retired in place before it (issue #643). */
export function retiredClaudeProjectRoots(): string[] { return readRegistry().registry.retired.map((item) => projectsDirFor(item.archived ? retiredAccountArchive("claude", item.id) : managedHome(item.id))); }
/** Every Claude transcript root the scanner reads: live accounts first, then retained archives. */
export function claudeProjectRoots(): string[] { return [...new Set([...listClaudeAccounts().map((item) => item.projectsDir), ...retiredClaudeProjectRoots()])]; }

/** Why a transcript names no owning Claude account, or which one it names. */
export type ClaudeTranscriptOwnership =
  | { kind: "owned"; accountId: string; home: string; source: "recorded" | "path" | "shared-store" }
  /** The path does not resolve — deleted, or a broken link. */
  | { kind: "unreadable" }
  /** It resolves outside every Claude transcript root the viewer knows. */
  | { kind: "foreign" };

/**
 * Which account owns a Claude transcript (issue #935).
 *
 * The shared transcript store (#891) removed the path-layout answer for every
 * transcript on a cut-over machine: each account's `projects` resolves to the
 * same root, so containment names no single owner and
 * {@link claudeHomeOwningTranscript} refuses rather than return whichever
 * account happens to list first. Refusing there left resume with no home at
 * all, and every Claude conversation on such a machine became unresumable.
 *
 * Ownership is resolved in this order:
 *  1. containment in a home that is NOT cut over to the shared store. There the
 *     layout is unambiguous AND load-bearing — `claude --resume <id>` reads the
 *     session out of that home's own projects dir, so the bytes decide;
 *  2. the account the registry recorded for this conversation. This is what
 *     answers inside the shared store, where every account reads the same
 *     transcripts and only the credentials differ;
 *  3. still inside the shared store with nothing recorded: the account new
 *     spawns route to, which is the same choice a fresh spawn would make.
 */
export function claudeTranscriptOwnership(pathname: string, recordedAccountId?: string | null): ClaudeTranscriptOwnership {
  let real: string; try { real = fs.realpathSync(pathname); } catch { return { kind: "unreadable" }; }
  const accounts = listClaudeAccounts();
  let shared: string | null = null;
  try { shared = fs.realpathSync(sharedClaudeProjectsRoot()); } catch { /* store not provisioned */ }
  for (const item of accounts) {
    try {
      const root = fs.realpathSync(item.projectsDir);
      /* A cut-over home shares its root with every other cut-over home, so
         containment there is evidence of nothing. Skip it and let recorded
         provenance answer below. */
      if (shared !== null && root === shared) continue;
      if (real.startsWith(root + path.sep)) return { kind: "owned", accountId: item.id, home: item.home, source: "path" };
    } catch { /* missing home */ }
  }
  const recorded = recordedAccountId ? accounts.find((item) => item.id === recordedAccountId) : undefined;
  if (recorded) return { kind: "owned", accountId: recorded.id, home: recorded.home, source: "recorded" };
  if (shared !== null && real.startsWith(shared + path.sep)) {
    const activeId = activeClaudeAccountId();
    const active = accounts.find((item) => item.id === activeId) ?? accounts[0];
    if (active) return { kind: "owned", accountId: active.id, home: active.home, source: "shared-store" };
  }
  return { kind: "foreign" };
}

/** Path-layout ownership only: the home whose transcript root physically
    contains this path. Null inside the shared store, where the layout names no
    owner — {@link claudeTranscriptOwnership} resolves that case. */
export function claudeHomeOwningTranscript(pathname: string): string | null {
  const ownership = claudeTranscriptOwnership(pathname);
  return ownership.kind === "owned" && ownership.source === "path" ? ownership.home : null;
}

/**
 * The shared-store equivalent of a transcript addressed through an account's
 * own `<home>/projects` (#1026). A Claude-engine agent knows its native
 * `~/.claude/projects/...` path — that is what the CLI writes and what its own
 * environment reports — while every viewer record addresses the one shared
 * store the home's `projects` symlink points into. The two name the same file,
 * so a caller that hands over the native path is answering correctly and only
 * needs the address translated.
 *
 * Returns the mirrored path only when that file actually exists: a home that is
 * not cut over to the shared store keeps its own transcripts, and inventing a
 * path there would trade a clear rejection for a phantom identity. Null when
 * the path is not under any account's native projects root, when it already is
 * the shared path, or when no mirrored file exists.
 */
export function mirroredClaudeTranscriptPath(pathname: string): string | null {
  const shared = sharedClaudeProjectsRoot();
  const resolved = path.resolve(pathname);
  if (resolved === shared || resolved.startsWith(shared + path.sep)) return null;
  for (const home of listClaudeAccounts().map((account) => account.home)) {
    const nativeRoot = path.join(home, "projects");
    if (!resolved.startsWith(nativeRoot + path.sep)) continue;
    const mirrored = path.join(shared, path.relative(nativeRoot, resolved));
    try {
      if (fs.statSync(mirrored).isFile()) return mirrored;
    } catch { /* nothing mirrored under the shared store */ }
    return null;
  }
  return null;
}

function nextId(label: string, used: Set<string>): string {
  const base = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "account";
  for (let n = 0; ; n += 1) { const suffix = n ? `-${n}` : ""; const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`; if (ACCOUNT_ID.test(candidate) && candidate !== DEFAULT_ID && !used.has(candidate) && !fs.existsSync(managedHome(candidate)) && !fs.existsSync(retiredAccountArchive("claude", candidate))) return candidate; }
}

function copyCapability(source: string, destination: string, budget: { files: number; bytes: number }): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return;
  if (stat.isFile()) { if (++budget.files > MAX_CAPABILITY_FILES || (budget.bytes += stat.size) > MAX_CAPABILITY_BYTES) throw new Error("Claude capability snapshot exceeds safety limit"); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.copyFileSync(source, destination); fs.chmodSync(destination, 0o600); return; }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) { if (PRIVATE_NAMES.has(entry.name)) continue; copyCapability(path.join(source, entry.name), path.join(destination, entry.name), budget); }
}

/** A viewer-owned, read-only capability snapshot avoids a managed home linking into legacy auth/runtime state.
    Only the capability entries are replaced: the same directory holds the
    shared transcript store and the removed-account archive (issue #1859). */
export function syncClaudeCapabilitySnapshot(): string {
  const root = claudeCapabilitiesRoot(); const tmp = `${root}.tmp-${process.pid}-${Date.now()}`; const budget = { files: 0, bytes: 0 };
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    for (const name of [...CAPABILITY_DIRS, ...CAPABILITY_FILES]) { const source = path.join(legacyClaudeHome(), name); if (fs.existsSync(source)) copyCapability(source, path.join(tmp, name), budget); }
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(root), 0o700);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
    for (const name of [...CAPABILITY_DIRS, ...CAPABILITY_FILES]) {
      const target = path.join(root, name);
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(path.join(tmp, name))) fs.renameSync(path.join(tmp, name), target);
    }
    return root;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function claudeSettingsPath(): string | null { const file = path.join(claudeCapabilitiesRoot(), "settings.json"); return fs.existsSync(file) ? file : null; }

export function createManagedClaudeAccount(label: string, provider?: { config: ClaudeProviderConfig; token: string; headers?: Record<string, string> }): ClaudeAccount {
  const clean = label.trim(); if (!clean || clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean)) throw new InvalidClaudeAccountLabelError();
  const config = provider ? validateProviderConfig({ ...provider.config, customHeaderNames: Object.keys(validateClaudeProviderHeaders(provider.headers ?? {})) }) : undefined;
  if (config) validateClaudeProviderModelRoute(config);
  return withRegistryLock(() => {
    const registry = mutable(); const id = nextId(clean, new Set([...listClaudeAccounts().map((item) => item.id), ...registry.retired.map((item) => item.id)])); const home = managedHome(id); let made = false;
    // A removed directory does not prove its platform credential is gone.
    // Refuse adoption of a previous account's store under a reused label.
    if (readClaudeCredentials(home).state !== "absent") throw new UnsafeClaudeHomeError();
    try {
      fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(home), 0o700); fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700); made = true;
      const shared = syncClaudeCapabilitySnapshot();
      for (const name of CAPABILITY_DIRS) { const source = path.join(shared, name); if (fs.existsSync(source)) fs.symlinkSync(source, path.join(home, name)); }
      fs.mkdirSync(path.join(home, "projects"), { mode: 0o700 });
      if (provider) {
        writeProviderToken(home, provider.token);
        writeProviderHeaders(home, provider.headers ?? {});
        writeProviderRuntime(home, { config: config!, token: provider.token, headers: provider.headers ?? {} });
        retainProviderRedactionSecrets([provider.token, ...Object.values(provider.headers ?? {})]);
      }
      const stored: StoredAccount = { id, label: clean, kind: "managed", createdAt: Date.now(), ...(config ? { provider: config } : {}) }; write({ ...registry, accounts: [...registry.accounts, stored] }); return account(stored);
    } catch (error) {
      if (made) {
        try {
          if (!removeHistoryFreeAccountHome("claude", id, home)) console.warn("[claude accounts] failed-account home cleanup is incomplete");
        } catch (cleanupError) {
          console.warn("[claude accounts] preserving failed-account home after history cleanup refusal");
          if (cleanupError instanceof AccountHistoryInventoryBlockedError) throw cleanupError;
        }
      }
      throw error;
    }
  });
}

export function updateProviderClaudeAccount(id: string, config: ClaudeProviderConfig, token?: string, label?: string, headers?: Record<string, string>): ClaudeAccount {
  const checked = validateProviderConfig(config);
  validateClaudeProviderModelRoute(checked);
  const clean = label?.trim();
  if (label !== undefined && (!clean || clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean))) throw new InvalidClaudeAccountLabelError();
  return withRegistryLock(() => {
    const registry = mutable();
    const index = registry.accounts.findIndex((item) => item.id === id && item.provider);
    if (index < 0) throw new UnknownClaudeAccountError(id);
    const previousConfig = registry.accounts[index]!.provider!;
    const changedBase = previousConfig.baseUrl !== checked.baseUrl;
    if (changedBase && token === undefined)
      throw new Error("Provider token is required when changing the base URL");
    const home = managedHome(id);
    if (!managedClaudeHomeIsSafe(id, true)) throw new UnsafeClaudeHomeError();
    const previousToken = readClaudeProviderToken(home);
    if (!previousToken && token === undefined) throw new UnsafeClaudeHomeError();
    let previousHeaders: Record<string, string> | null;
    try { previousHeaders = readClaudeProviderHeaders(home, previousConfig.customHeaderNames); }
    catch (error) { if (headers === undefined) throw error; previousHeaders = null; }
    const effectiveHeaders = headers === undefined ? changedBase ? {} : previousHeaders : validateClaudeProviderHeaders(headers);
    const stored = { ...registry.accounts[index]!, ...(clean ? { label: clean } : {}), provider: validateProviderConfig({ ...checked, customHeaderNames: Object.keys(effectiveHeaders!) }) };
    const previousRuntime = previousToken && previousHeaders ? { config: previousConfig, token: previousToken, headers: previousHeaders } : null;
    const nextRuntime = { config: stored.provider, token: token ?? previousToken!, headers: effectiveHeaders! };
    let runtimeChanged = false;
    let tokenChanged = false;
    let headersChanged = false;
    try {
      if (token !== undefined || headers !== undefined || changedBase)
        retainProviderRedactionSecrets([...providerSecretsAtHome(home), nextRuntime.token, ...Object.values(nextRuntime.headers)]);
      writeProviderRuntime(home, nextRuntime); runtimeChanged = true;
      if (token !== undefined) { writeProviderToken(home, token); tokenChanged = true; }
      if (headers !== undefined || changedBase) { writeProviderHeaders(home, effectiveHeaders!); headersChanged = true; }
      write({ ...registry, accounts: registry.accounts.map((item, n) => n === index ? stored : item) });
    } catch (error) {
      if (tokenChanged) {
        try { if (previousToken) writeProviderToken(home, previousToken); else fs.rmSync(providerTokenPath(home), { force: true }); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Provider account token rollback failed"); }
      }
      if (headersChanged) {
        try { if (previousHeaders) writeProviderHeaders(home, previousHeaders); else fs.rmSync(path.join(home, PROVIDER_HEADERS_FILE), { force: true }); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Provider account header rollback failed"); }
      }
      if (runtimeChanged) {
        try { if (previousRuntime) writeProviderRuntime(home, previousRuntime); else fs.rmSync(providerRuntimePath(home), { force: true }); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Provider account runtime rollback failed"); }
      }
      throw error;
    }
    return account(stored);
  });
}

export async function listClaudeProviderModels(config: ClaudeProviderConfig, token: string, headers: Record<string, string> = {}): Promise<string[] | null> {
  const checked = validateProviderConfig(config);
  if (token.length < 8 || token.length > 4096 || /[\r\n\u0000]/.test(token)) throw new Error("Invalid provider token");
  const customHeaders = validateClaudeProviderHeaders(headers);
  const response = await fetch(`${checked.baseUrl}/v1/models`, {
    headers: { ...customHeaders, Authorization: `Bearer ${token}`, "x-opencode-session": crypto.randomUUID(), "user-agent": "Delegatus/1.0 provider-catalog" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Provider authentication failed" : "Provider model list unavailable");
  const payload = await response.json() as { data?: unknown; models?: unknown };
  const models = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : null;
  if (!models) return null;
  const secrets = [...new Set([token, ...Object.values(customHeaders)].flatMap((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return [secret, escaped, secret.replaceAll("/", "\\/"), escaped.replaceAll("/", "\\/")];
  }))];
  return claudeProviderModelChoices(checked, models.flatMap((item) => typeof item === "object" && item !== null
    && typeof item.id === "string" && item.id.length <= 128 && !item.id.includes("\\")
    && !secrets.some((secret) => item.id.includes(secret)) ? [item.id] : []).slice(0, 500));
}

export function listSavedClaudeProviderModels(account: Pick<ClaudeAccount, "home" | "provider">): Promise<string[] | null> {
  if (!account.provider) throw new UnsafeClaudeHomeError();
  const runtime = readClaudeProviderRuntime(account.home, account.provider);
  return listClaudeProviderModels(runtime.config, runtime.token, runtime.headers);
}

function historyFitsRetainedProjects(report: AccountHistoryInventoryReport): boolean {
  return report.artifacts.filter((artifact) => artifact.history).every((artifact) => artifact.path.startsWith(`projects${path.sep}`));
}

const CLAUDE_SIDECAR_SUFFIXES = [".lock"] as const;

function cleanupClaudeSidecars(id: string): boolean {
  return cleanupAccountProviderSidecars(claudeAccountsRoot(), id, CLAUDE_SIDECAR_SUFFIXES).unresolved.length > 0;
}

/** Registry path moves for a Claude home entering the archive. A path through
    the home's shared-store link names a file in the shared store, so it moves
    there; everything else under the home moves with the home. */
function claudeArchiveRewrites(home: string, archive: string): Array<{ from: string; to: string }> {
  const spellings = [home];
  try { const real = fs.realpathSync(home); if (real !== home) spellings.push(real); } catch { /* the lexical spelling still applies */ }
  const shared = sharedClaudeProjectsRoot();
  const cutOver = projectsDirFor(home) === shared;
  return spellings.flatMap((spelling) => [
    ...(cutOver ? [{ from: path.join(spelling, "projects"), to: shared }] : []),
    { from: spelling, to: archive },
  ]);
}

function writeJournal(id: string, phase: AccountRemovalJournalPhase | null, rewrites?: readonly AccountPathRewrite[]): void {
  const current = mutable(); write({ ...current, removals: withAccountRemovalJournal(current.removals, id, phase, rewrites) });
}

/** The registry once `id` is removed: it leaves, a retired record points at
    its archive, and its journal record moves to `scrubbing`. */
function withAccountRetired(registry: Registry, id: string): Registry {
  const label = registry.accounts.find((item) => item.id === id)?.label ?? id;
  return {
    ...registry,
    active: registry.active === id ? DEFAULT_ID : registry.active,
    accounts: registry.accounts.filter((item) => item.id !== id),
    retired: [...registry.retired.filter((item) => item.id !== id), { id, label, retiredAt: Date.now(), archived: true }],
    removals: withAccountRemovalJournal(registry.removals, id, "scrubbing"),
  };
}

function recoverRemovalsLocked(): { recovered: string[]; unresolved: string[] } {
  const registry = mutable();
  const recovered: string[] = []; const unresolved: string[] = [];
  for (const entry of registry.removals) {
    if (accountRemovalInFlight("claude", entry.id)) continue;
    let settled: "retired" | "restored" | null = null;
    try {
      settled = recoverManagedAccountRemoval({
        engine: "claude",
        accountId: entry.id,
        home: managedHome(entry.id),
        entry,
        listed: registry.accounts.some((item) => item.id === entry.id),
        commitRetired: () => { write(withAccountRetired(mutable(), entry.id)); },
        clearJournal: () => writeJournal(entry.id, null),
      });
    } catch { /* stays journaled; one stuck record never blocks another account */ }
    if (settled === "retired") cleanupClaudeSidecars(entry.id);
    (settled ? recovered : unresolved).push(entry.id);
  }
  return { recovered, unresolved };
}

/** Settles removals a crash interrupted (issue #1857): an unfinished move is
    undone, a committed one is finished. */
export function recoverInterruptedClaudeAccountRemovals(): { recovered: string[]; unresolved: string[] } {
  return withRegistryLock(() => recoverRemovalsLocked());
}

let startupRecoveryDone = false;
/** Runs recovery once per process, on the first listing. A held registry lock
    means another mutation is running; the next listing tries again. */
function recoverRemovalsAtStartup(): void {
  if (startupRecoveryDone) return;
  const loaded = readRegistry();
  if (loaded.corrupt || loaded.registry.removals.length === 0) { startupRecoveryDone = true; return; }
  if (fs.existsSync(registryLockPath()) && !registryLockOwnerGone(registryLockPath())) return;
  try { recoverInterruptedClaudeAccountRemovals(); startupRecoveryDone = true; }
  catch { /* busy: retried by the next listing */ }
}

/**
 * Removes a managed account (issue #1857). The home moves in one rename into
 * `shared/claude/retired/<id>/`; transcripts already live in the shared store,
 * so what moves is CLI runtime state (prompt history, shell snapshots,
 * backups). Registry paths through the home move with it, the account leaves
 * the registry as a retired record pointing at the archive, and only the
 * credential file and the Viewer's links are deleted.
 */
export function removeManagedClaudeAccount(id: string): AccountArchiveRemovalReport {
  return withRegistryLock(() => {
    recoverRemovalsLocked();
    const registry = mutable(); const existing = registry.accounts.find((item) => item.id === id); if (!existing) throw new UnknownClaudeAccountError(id);
    if (existing.provider) retainProviderRedactionSecrets(providerSecretsAtHome(managedHome(id)));
    const before: Registry = { ...registry, removals: withAccountRemovalJournal(registry.removals, id, null) };
    const report = removeManagedAccountIntoArchive({
      engine: "claude",
      accountId: id,
      home: managedHome(id),
      homeIsSafe: () => managedClaudeHomeIsSafe(id, true),
      unsafeHome: () => new UnsafeClaudeHomeError(),
      rewrites: claudeArchiveRewrites,
      registry: {
        journal: (phase, rewrites) => writeJournal(id, phase, rewrites),
        commitRetired: () => write(withAccountRetired(before, id)),
        restore: () => write(before),
      },
    });
    return { ...report, cleanupPending: cleanupClaudeSidecars(id) || report.cleanupPending };
  });
}

/** Removes failed-login homes that have no registry owner. Only safe direct
 *  children qualify. Retired archives are never deleted — their transcripts are
 *  the point — but a strip left incomplete by an earlier removal is retried. */
export function cleanupOrphanedClaudeHomes(): AccountOrphanCleanupReport {
  return withRegistryLock(() => {
    /* A removal whose archive still holds its sign-in file stays journaled;
       it is named here so the dialog never reports that file deleted. */
    const recovery = recoverRemovalsLocked();
    const registry = mutable();
    const registered = new Set(registry.accounts.map((account) => account.id));
    const retired = new Set(registry.retired.map((account) => account.id));
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(claudeAccountsRoot(), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: [], unresolved: [...recovery.unresolved].sort() }; throw error; }
    const removed: string[] = [];
    const unresolved: string[] = [...recovery.unresolved];
    const historyReports: Record<string, AccountHistoryInventoryReport> = {};
    const cleanupSidecar = (accountId: string): void => {
      const sidecars = cleanupAccountProviderSidecars(claudeAccountsRoot(), accountId, CLAUDE_SIDECAR_SUFFIXES);
      for (const name of sidecars.removed) if (!removed.includes(name) && !unresolved.includes(name)) removed.push(name);
      for (const name of sidecars.unresolved) {
        const removedIndex = removed.indexOf(name);
        if (removedIndex >= 0) removed.splice(removedIndex, 1);
        if (!unresolved.includes(name)) unresolved.push(name);
      }
    };
    for (const entry of entries) {
      if (entry.name.endsWith(".lock")) {
        const accountId = entry.name.slice(0, -".lock".length);
        if (!ACCOUNT_ID.test(accountId) || accountId === DEFAULT_ID) { unresolved.push(entry.name); continue; }
        if (registered.has(accountId)) continue;
        if (accountRemovalBlockers("claude", accountId).length > 0) { unresolved.push(entry.name); continue; }
        cleanupSidecar(accountId);
        continue;
      }
      if (registered.has(entry.name)) continue;
      if (accountRemovalBlockers("claude", entry.name).length > 0) { unresolved.push(entry.name); continue; }
      if (!entry.isDirectory() || !managedClaudeHomeIsSafe(entry.name, true)) { unresolved.push(entry.name); continue; }
      let history: AccountHistoryInventoryReport;
      try { history = accountHistoryInventory("claude", entry.name, managedHome(entry.name)); }
      catch (error) {
        if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
        unresolved.push(entry.name); continue;
      }
      if (retired.has(entry.name)) {
        if (!history.artifacts.some((artifact) => artifact.history)) {
          try {
            if (removeHistoryFreeAccountHome("claude", entry.name, managedHome(entry.name))) removed.push(entry.name);
            else unresolved.push(entry.name);
          } catch (error) {
            if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
            unresolved.push(entry.name);
          }
          continue;
        }
        if (!historyFitsRetainedProjects(history)) { historyReports[entry.name] = history; unresolved.push(entry.name); continue; }
        try {
          const scrub = scrubAccountHomeToRetainedHistory("claude", entry.name, managedHome(entry.name), "projects");
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
        if (removeHistoryFreeAccountHome("claude", entry.name, managedHome(entry.name))) removed.push(entry.name);
        else unresolved.push(entry.name);
      }
      catch (error) {
        if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
        unresolved.push(entry.name);
      }
    }
    for (const entry of fs.readdirSync(claudeAccountsRoot(), { withFileTypes: true })) {
      if (!entry.name.endsWith(".lock")) continue;
      const accountId = entry.name.slice(0, -".lock".length);
      if (!ACCOUNT_ID.test(accountId) || accountId === DEFAULT_ID) {
        if (!unresolved.includes(entry.name)) unresolved.push(entry.name);
        continue;
      }
      if (!registered.has(accountId) && accountRemovalBlockers("claude", accountId).length === 0) cleanupSidecar(accountId);
      else if (!registered.has(accountId) && !unresolved.includes(entry.name)) unresolved.push(entry.name);
    }
    return {
      removed: removed.sort(),
      unresolved: unresolved.sort(),
      ...(Object.keys(historyReports).length > 0 ? { history: historyReports } : {}),
    };
  });
}

const SHADOWED_ENV = ["CLAUDE_SECURESTORAGE_CONFIG_DIR","ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEXAI_PROJECT", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
export function claudeManagedEnvironment(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = { ...withoutWakatimeCredential(base), CLAUDE_CONFIG_DIR: home }; for (const key of SHADOWED_ENV) delete env[key]; return env; }
export function claudeAccountEnvironment(account: Pick<ClaudeAccount, "home" | "provider">, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = claudeManagedEnvironment(account.home, base);
  if (account.provider) {
    const runtime = readClaudeProviderRuntime(account.home, account.provider);
    delete env.ANTHROPIC_MODEL;
    delete env.ANTHROPIC_SMALL_FAST_MODEL;
    delete env.ANTHROPIC_CUSTOM_HEADERS;
    env.ANTHROPIC_BASE_URL = runtime.config.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = runtime.token;
    env.ANTHROPIC_MODEL = runtime.config.model;
    if (runtime.config.smallFastModel) env.ANTHROPIC_SMALL_FAST_MODEL = runtime.config.smallFastModel;
  }
  return env;
}
export function claudeProviderForHome(home: string): ClaudeProviderConfig | null {
  const account = listClaudeAccounts().find((item) => item.home === home);
  if (account?.provider && !account.authPresent) throw new UnsafeClaudeHomeError();
  return account?.provider ?? null;
}
/** Publish the secret-free launcher into the account home shared by host and Viewer. */
export function claudeProviderLauncherPath(home: string): string {
  const owner = listClaudeAccounts().find((item) => item.home === home && item.provider);
  if (!owner || !managedClaudeHomeIsSafe(owner.id, true)) throw new UnsafeClaudeHomeError();
  const directory = path.join(home, ".llv");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new UnsafeClaudeHomeError();
  for (const name of ["claude-provider-relay.mjs", "claude-provider-launch.mjs"]) {
    const source = path.join(process.cwd(), "bin", name);
    const target = path.join(directory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, fs.readFileSync(source), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return path.join(directory, "claude-provider-launch.mjs");
}
export function isManagedClaudeHome(home: string): boolean { return listClaudeAccounts().some((item) => item.kind === "managed" && item.home === home && managedClaudeHomeIsSafe(item.id, true)); }
