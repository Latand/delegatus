import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { accountHasLiveSessions, liveAccountConversationIds, type AccountLivenessOptions, type ManagedAccountEngine } from "@/lib/agent/accountLiveness";
import { agentRegistry, type AccountPathRewrite, type AccountRetirementReport } from "@/lib/agent/registry";

export type { ManagedAccountEngine };
export type AccountRemovalBlocker = "live_sessions" | "current_conversations";

export type AccountInventoryArtifact =
  | { path: string; classification: "owned"; history: boolean }
  | { path: string; classification: "history"; history: true }
  | { path: string; classification: "unknown"; history: false };

export interface AccountHistoryInventoryReport {
  home: string;
  artifacts: AccountInventoryArtifact[];
  error?: { path: string; message: string };
}

export interface AccountSidecarCleanupReport {
  removed: string[];
  unresolved: string[];
}

export interface AccountOrphanCleanupReport {
  removed: string[];
  unresolved: string[];
  history?: Record<string, AccountHistoryInventoryReport>;
}

export class AccountHistoryInventoryBlockedError extends Error {
  constructor(readonly report: AccountHistoryInventoryReport) {
    super("account history inventory blocked removal");
    this.name = "AccountHistoryInventoryBlockedError";
  }
}

export function accountHomeExistsForRemoval(home: string): boolean {
  const resolvedHome = path.resolve(home);
  try { fs.lstatSync(resolvedHome); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AccountHistoryInventoryBlockedError({
      home: resolvedHome,
      artifacts: [],
      error: { path: ".", message: errorMessage(error) },
    });
  }
}

const HISTORY_DIRECTORY_ROOTS: Record<ManagedAccountEngine, ReadonlySet<string>> = {
  claude: new Set(["projects", "file-history", "session-env", "shell-snapshots", "todos", "debug", "backups", "paste-cache"]),
  codex: new Set(["sessions", "archived_sessions", "log", "shell_snapshots"]),
};
const OWNED_REGULAR_FILES: Record<ManagedAccountEngine, ReadonlySet<string>> = {
  claude: new Set([".credentials.json", ".claude.json"]),
  codex: new Set(["auth.json"]),
};
const OWNED_SYMLINKS: Record<ManagedAccountEngine, ReadonlySet<string>> = {
  claude: new Set(["skills", "commands", "agents"]),
  codex: new Set(["skills", "prompts", "config.toml", "AGENTS.md", "memories", "rules", path.join("plugins", "cache")]),
};
const OWNED_DIRECTORY_ROOTS: Record<ManagedAccountEngine, ReadonlySet<string>> = {
  claude: new Set(["cache", "plugins"]),
  codex: new Set([".tmp", "mcp-oauth", path.join("plugins", "data")]),
};
const SAFE_ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function registryHistoryPaths(engine: ManagedAccountEngine, accountId: string): Set<string> {
  const paths = new Set<string>();
  for (const conversation of Object.values(agentRegistry().readOnlySnapshot().conversations)) {
    if (conversation.engine !== engine) continue;
    const ownedGenerations = conversation.generations.filter((generation) => generation.accountId === accountId);
    for (const generation of ownedGenerations) paths.add(path.resolve(generation.path));
    if (ownedGenerations.length === 0) continue;
    for (const pathname of [
      ...conversation.continuityPaths,
      ...conversation.abandonedContinuityPaths,
      ...conversation.providerForkPaths,
      ...(conversation.migration?.pendingContinuityPaths ?? []),
      ...(conversation.migration?.providerReceipt?.continuityPaths ?? []),
      ...(conversation.migration?.providerReceipt ? [conversation.migration.providerReceipt.path] : []),
    ]) paths.add(path.resolve(pathname));
  }
  return paths;
}

function isHistoryPath(engine: ManagedAccountEngine, relative: string): boolean {
  const topLevel = relative.split(path.sep)[0]!;
  const basename = path.basename(relative);
  return HISTORY_DIRECTORY_ROOTS[engine].has(topLevel)
    || topLevel === "history.jsonl"
    || basename.endsWith(".jsonl")
    || engine === "codex" && /\.sqlite3?(?:-(?:shm|wal))?$/.test(basename);
}

function atOrBelow(relative: string, root: string): boolean {
  return relative === root || relative.startsWith(`${root}${path.sep}`);
}

function isOwnedDirectoryPath(engine: ManagedAccountEngine, relative: string): boolean {
  if (engine === "claude" && atOrBelow(relative, path.join("plugins", "data"))) return false;
  for (const root of OWNED_DIRECTORY_ROOTS[engine]) if (atOrBelow(relative, root)) return true;
  return false;
}

function isHistoryDirectoryPath(engine: ManagedAccountEngine, relative: string): boolean {
  for (const root of HISTORY_DIRECTORY_ROOTS[engine]) if (atOrBelow(relative, root)) return true;
  return false;
}

function classifyArtifact(
  engine: ManagedAccountEngine,
  relative: string,
  absolute: string,
  stat: fs.Stats,
  ownedPaths: ReadonlySet<string>,
): AccountInventoryArtifact {
  const history = isHistoryPath(engine, relative);
  if (stat.isSymbolicLink()) {
    if (OWNED_SYMLINKS[engine].has(relative)) return { path: relative, classification: "owned", history: false };
    if (history) return { path: relative, classification: "history", history: true };
    return { path: relative, classification: "unknown", history: false };
  }
  if (stat.isDirectory()) {
    const ownedContainer = isHistoryDirectoryPath(engine, relative)
      || isOwnedDirectoryPath(engine, relative)
      || engine === "codex" && relative === "plugins";
    if (ownedContainer) return { path: relative, classification: "owned", history: false };
    return { path: relative, classification: "unknown", history: false };
  }
  if (stat.isFile() && ownedPaths.has(path.resolve(absolute))) {
    return { path: relative, classification: "owned", history: true };
  }
  if (history) return { path: relative, classification: "history", history: true };
  if (stat.isFile() && (OWNED_REGULAR_FILES[engine].has(relative) || isOwnedDirectoryPath(engine, relative))) {
    return { path: relative, classification: "owned", history: false };
  }
  return { path: relative, classification: "unknown", history: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "filesystem inventory failed";
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function mountedPaths(): ReadonlySet<string> {
  if (process.platform !== "linux") return new Set();
  const mounts = new Set<string>();
  for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    if (!line) continue;
    const mountPoint = line.split(" ")[4];
    if (!mountPoint) throw new Error("filesystem mount inventory is malformed");
    mounts.add(path.resolve(decodeMountInfoPath(mountPoint)));
  }
  return mounts;
}

/**
 * Classifies every entry below an already-validated managed home without
 * crossing a symlink or filesystem boundary. Exact provider state and regular
 * files named by the account's registry history are owned. Known unowned
 * history, unknown entries, and incomplete traversal all block deletion with
 * the paths that caused the refusal.
 */
export function accountHistoryInventory(
  engine: ManagedAccountEngine,
  accountId: string,
  home: string,
): AccountHistoryInventoryReport {
  const resolvedHome = path.resolve(home);
  const artifacts: AccountInventoryArtifact[] = [];
  let failingPath = ".";
  try {
    const homeStat = fs.lstatSync(resolvedHome);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("managed account home is not a safe directory");
    const expectedUid = process.getuid?.() ?? homeStat.uid;
    if (homeStat.uid !== expectedUid || (homeStat.mode & 0o022) !== 0) throw new Error("managed account home has unsafe ownership or permissions");
    const mounts = mountedPaths();
    if (mounts.has(resolvedHome)) throw new Error("managed account home is an external mount");
    const ownedPaths = registryHistoryPaths(engine, accountId);
    const visit = (directory: string, relativeDirectory: string): void => {
      failingPath = relativeDirectory || ".";
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const pathname = path.join(directory, entry.name);
        const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
        failingPath = relative;
        const stat = fs.lstatSync(pathname);
        if (mounts.has(path.resolve(pathname))) throw new Error(`history inventory reached an external mount at ${relative}`);
        if (stat.dev !== homeStat.dev) throw new Error(`history inventory crossed a filesystem boundary at ${relative}`);
        if (stat.uid !== expectedUid || !stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) {
          throw new Error(`history inventory found unsafe ownership or permissions at ${relative}`);
        }
        artifacts.push(classifyArtifact(engine, relative, pathname, stat, ownedPaths));
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          visit(pathname, relative);
          continue;
        }
      }
    };
    visit(resolvedHome, "");
  } catch (error) {
    throw new AccountHistoryInventoryBlockedError({
      home: resolvedHome,
      artifacts,
      error: { path: failingPath, message: errorMessage(error) },
    });
  }
  const report = { home: resolvedHome, artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)) };
  if (report.artifacts.some((artifact) => artifact.classification !== "owned")) {
    throw new AccountHistoryInventoryBlockedError(report);
  }
  return report;
}

function blockedInventory(report: AccountHistoryInventoryReport, path: string, message: string): AccountHistoryInventoryBlockedError {
  return new AccountHistoryInventoryBlockedError({ ...report, error: { path, message } });
}

function validatedHomeRemovalContext(
  engine: ManagedAccountEngine,
  accountId: string,
  home: string,
): { root: string; stat: fs.Stats; uid: number; mounts: ReadonlySet<string>; ownedPaths: ReadonlySet<string> } {
  const root = path.resolve(home);
  const stat = fs.lstatSync(root);
  const uid = process.getuid?.() ?? stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new Error("managed account home is not a safe directory");
  }
  const mounts = mountedPaths();
  if (mounts.has(root)) throw new Error("managed account home is an external mount");
  return { root, stat, uid, mounts, ownedPaths: registryHistoryPaths(engine, accountId) };
}

type TreeRemovalResult = { complete: boolean; changed: boolean };

function entryPassesRemovalChecks(
  context: ReturnType<typeof validatedHomeRemovalContext>,
  stat: fs.Stats,
  absolutePath: string,
): boolean {
  return !context.mounts.has(path.resolve(absolutePath))
    && stat.dev === context.stat.dev
    && stat.uid === context.uid
    && (stat.isSymbolicLink() || (stat.mode & 0o022) === 0);
}

/**
 * Linux deletion is anchored to opened directory identities. Every child path
 * is resolved through `/proc/self/fd`, so replacing a validated directory with
 * a symlink cannot redirect traversal. Other platforms leave directory trees
 * pending instead of attempting an unfenced path walk.
 */
function removeNonHistoryTree(
  engine: ManagedAccountEngine,
  accountId: string,
  home: string,
  context: ReturnType<typeof validatedHomeRemovalContext>,
  directory: string,
  relativeDirectory: string,
  expectedDirectory: fs.Stats,
  retainedTopLevel: string | null,
): TreeRemovalResult {
  if (process.platform !== "linux") return { complete: false, changed: false };
  let descriptor: number;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const current = accountHistoryInventory(engine, accountId, home);
    throw blockedInventory(current, relativeDirectory || ".", errorMessage(error));
  }
  try {
    const opened = fs.fstatSync(descriptor);
    const absoluteDirectory = relativeDirectory ? path.join(context.root, relativeDirectory) : context.root;
    if (opened.dev !== expectedDirectory.dev || opened.ino !== expectedDirectory.ino
      || !entryPassesRemovalChecks(context, opened, absoluteDirectory)) {
      const current = accountHistoryInventory(engine, accountId, home);
      throw blockedInventory(current, relativeDirectory || ".", "account-home directory identity changed during removal");
    }
    const anchor = `/proc/self/fd/${descriptor}`;
    let complete = true;
    let changed = false;
    for (const entry of fs.readdirSync(anchor, { withFileTypes: true })) {
      if (!relativeDirectory && retainedTopLevel === entry.name) continue;
      const pathname = path.join(anchor, entry.name);
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(pathname); }
      catch (error) {
        const current = accountHistoryInventory(engine, accountId, home);
        throw blockedInventory(current, relative, errorMessage(error));
      }
      if (!entryPassesRemovalChecks(context, stat, path.join(context.root, relative))) {
        const current = accountHistoryInventory(engine, accountId, home);
        throw blockedInventory(current, relative, "account-home entry failed removal safety checks");
      }
      const artifact = classifyArtifact(engine, relative, path.join(context.root, relative), stat, context.ownedPaths);
      if (artifact.classification !== "owned" || artifact.history) {
        const current = accountHistoryInventory(engine, accountId, home);
        throw blockedInventory(current, relative, "account-home entry is outside deletion ownership");
      }
      if (stat.isSymbolicLink()) {
        try { fs.rmSync(pathname, { force: true }); changed = true; }
        catch { complete = false; }
        continue;
      }
      if (stat.isDirectory()) {
        const child = removeNonHistoryTree(engine, accountId, home, context, pathname, relative, stat, retainedTopLevel);
        if (!child.complete) complete = false;
        if (child.changed) changed = true;
        try { fs.rmdirSync(pathname); changed = true; }
        catch (error) {
          const current = accountHistoryInventory(engine, accountId, home);
          if (current.artifacts.some((artifact) => artifact.history && (artifact.path === relative || artifact.path.startsWith(`${relative}${path.sep}`)))) {
            throw blockedInventory(current, relative, "history appeared during account-home removal");
          }
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
        }
        continue;
      }
      try { fs.rmSync(pathname, { force: true }); changed = true; }
      catch { complete = false; }
    }
    return { complete, changed };
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Deletes a history-free home without a recursive filesystem operation. */
export function removeHistoryFreeAccountHome(engine: ManagedAccountEngine, accountId: string, home: string): boolean {
  const initial = accountHistoryInventory(engine, accountId, home);
  if (initial.artifacts.some((artifact) => artifact.history)) throw new AccountHistoryInventoryBlockedError(initial);
  if (process.platform !== "linux") return false;
  let context: ReturnType<typeof validatedHomeRemovalContext>;
  try { context = validatedHomeRemovalContext(engine, accountId, home); }
  catch (error) { throw blockedInventory(initial, ".", errorMessage(error)); }
  const removal = removeNonHistoryTree(engine, accountId, home, context, context.root, "", context.stat, null);
  try { fs.rmdirSync(context.root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const current = accountHistoryInventory(engine, accountId, home);
      if (current.artifacts.some((artifact) => artifact.history)) throw blockedInventory(current, ".", "history appeared during account-home removal");
      return false;
    }
  }
  try { return removal.complete && !accountHomeExistsForRemoval(context.root); }
  catch { return false; }
}

/** Scrubs credentials and runtime state while leaving one retained history tree untouched. */
export function scrubAccountHomeToRetainedHistory(
  engine: ManagedAccountEngine,
  accountId: string,
  home: string,
  retainedName: string,
): TreeRemovalResult {
  const initial = accountHistoryInventory(engine, accountId, home);
  let context: ReturnType<typeof validatedHomeRemovalContext>;
  try { context = validatedHomeRemovalContext(engine, accountId, home); }
  catch (error) { throw blockedInventory(initial, ".", errorMessage(error)); }
  const removal = removeNonHistoryTree(engine, accountId, home, context, context.root, "", context.stat, retainedName);
  const current = accountHistoryInventory(engine, accountId, home);
  const before = initial.artifacts.filter((artifact) => artifact.history).map((artifact) => `${artifact.path}:${artifact.classification}`).sort();
  const after = current.artifacts.filter((artifact) => artifact.history).map((artifact) => `${artifact.path}:${artifact.classification}`).sort();
  if (before.length !== after.length || before.some((value, index) => value !== after[index])) {
    throw blockedInventory(current, retainedName, "history changed during account-home cleanup");
  }
  return removal;
}

function sidecarTreeIsSafe(
  pathname: string,
  absolutePath: string,
  rootStat: fs.Stats,
  expectedUid: number,
  mounts: ReadonlySet<string>,
): boolean {
  const stat = fs.lstatSync(pathname);
  if (mounts.has(path.resolve(absolutePath)) || stat.isSymbolicLink() || stat.dev !== rootStat.dev || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) return false;
  if (!stat.isDirectory()) return stat.isFile();
  if (process.platform !== "linux") return false;
  let descriptor: number;
  try { descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
  catch { return false; }
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return false;
    const anchor = `/proc/self/fd/${descriptor}`;
    for (const entry of fs.readdirSync(anchor, { withFileTypes: true })) {
      if (!sidecarTreeIsSafe(path.join(anchor, entry.name), path.join(absolutePath, entry.name), rootStat, expectedUid, mounts)) return false;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

/** Removes exact provider-owned siblings while refusing links and filesystem escapes. */
export function cleanupAccountProviderSidecars(
  accountRoot: string,
  accountId: string,
  suffixes: readonly string[],
): AccountSidecarCleanupReport {
  const removed: string[] = [];
  const unresolved: string[] = [];
  if (!SAFE_ACCOUNT_ID.test(accountId)) return { removed, unresolved: suffixes.map((suffix) => `${accountId}${suffix}`) };
  const root = path.resolve(accountRoot);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
    const expectedUid = process.getuid?.() ?? rootStat.uid;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== expectedUid || (rootStat.mode & 0o022) !== 0) throw new Error("unsafe account root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed, unresolved };
    return { removed, unresolved: suffixes.map((suffix) => `${accountId}${suffix}`) };
  }
  const expectedUid = process.getuid?.() ?? rootStat.uid;
  let mounts: ReadonlySet<string>;
  try { mounts = mountedPaths(); }
  catch { return { removed, unresolved: suffixes.map((suffix) => `${accountId}${suffix}`) }; }
  if (process.platform !== "linux") {
    for (const suffix of suffixes) {
      const name = `${accountId}${suffix}`;
      try { fs.lstatSync(path.join(root, name)); unresolved.push(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unresolved.push(name); }
    }
    return { removed, unresolved: unresolved.sort() };
  }
  let rootDescriptor: number;
  try {
    rootDescriptor = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(rootDescriptor);
    if (opened.dev !== rootStat.dev || opened.ino !== rootStat.ino) throw new Error("account root identity changed");
  } catch {
    return { removed, unresolved: suffixes.map((suffix) => `${accountId}${suffix}`) };
  }
  try {
    const anchor = `/proc/self/fd/${rootDescriptor}`;
    for (const suffix of suffixes) {
      const name = `${accountId}${suffix}`;
      const candidate = path.join(anchor, name);
      const absoluteCandidate = path.join(root, name);
      try {
        fs.lstatSync(candidate);
        if (!sidecarTreeIsSafe(candidate, absoluteCandidate, rootStat, expectedUid, mounts)) { unresolved.push(name); continue; }
        fs.rmSync(candidate, { recursive: true, force: false });
        try { fs.lstatSync(candidate); unresolved.push(name); }
        catch (postError) {
          if ((postError as NodeJS.ErrnoException).code === "ENOENT") removed.push(name);
          else unresolved.push(name);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try { fs.lstatSync(candidate); unresolved.push(name); }
          catch (postError) { if ((postError as NodeJS.ErrnoException).code !== "ENOENT") unresolved.push(name); }
          continue;
        }
        unresolved.push(name);
      }
    }
  } finally {
    fs.closeSync(rootDescriptor);
  }
  return { removed: removed.sort(), unresolved: unresolved.sort() };
}

/** Registry-liveness half of account-removal safety. Genuinely live ownership
 *  blocks here (issue #643): a registered host whose process answers a probe,
 *  an in-flight launch receipt, a queued account pin, or a migration still in
 *  flight. Terminal, unhosted history, `starting` entries/receipts whose
 *  process is provably gone, parked `failed-recoverable` migrations and owed
 *  deliveries no host can take are not (issue #1857): removal settles them. */
export function accountRemovalBlockers(
  engine: ManagedAccountEngine,
  accountId: string,
  options: AccountLivenessOptions = {},
): AccountRemovalBlocker[] {
  const snapshot = agentRegistry().readOnlySnapshot();
  return [
    ...(accountHasLiveSessions(snapshot, engine, accountId, options) ? ["live_sessions" as const] : []),
    ...(liveAccountConversationIds(snapshot, engine, accountId, options).length > 0 ? ["current_conversations" as const] : []),
  ];
}

/* ---- Removal into the shared archive (issue #1857) ----
 *
 * A used home always holds something the #314 inventory refuses: prompt
 * history, shell snapshots, provider SQLite, stray rollouts. Removal therefore
 * judges nothing entry by entry. It moves the whole home with one rename(2)
 * into `shared/<engine>/retired/<id>/`, moves the registry paths with it, and
 * deletes only credentials and the Viewer's own links, by exact name. Every
 * step is journaled in the accounts registry so a crash at any point is either
 * undone (home renamed back) or finished at startup.
 */

export type AccountRemovalCheckpoint = "journaled" | "renamed" | "registry-retired" | "accounts-committed";
/** `archiving`: the home may have moved, nothing else did; recovery undoes it.
    `retiring`: the agent registry may have retired the account; recovery
    finishes the removal with the journaled path moves, since undoing the
    paths alone would leave the pins, deliveries and default it settled gone.
    `scrubbing`: the account left the accounts registry; recovery finishes. */
export type AccountRemovalJournalPhase = "archiving" | "retiring" | "scrubbing";
export interface AccountRemovalJournalEntry {
  id: string;
  phase: AccountRemovalJournalPhase;
  startedAt: number;
  /** The registry path moves, recorded with `retiring` so recovery can
      redo the retirement after the home is gone. */
  rewrites?: AccountPathRewrite[];
}

export interface AccountArchiveRemovalReport extends AccountRetirementReport {
  /** Where the leftovers now live; null when the account had no home on disk. */
  archive: string | null;
  /** Regular files and their bytes kept in the archive (credentials excluded). */
  files: number;
  bytes: number;
  /** A credential or Viewer link is still in the archive; recovery retries it. */
  cleanupPending: boolean;
}

/** The accounts-registry half of a removal, supplied by each engine. */
export interface AccountRemovalRegistryPort {
  /** Writes or clears (null) this account's journal record. */
  journal(phase: AccountRemovalJournalPhase | null, rewrites?: readonly AccountPathRewrite[]): void;
  /** One write: the account leaves, a retired record points at its archive,
      and the journal moves to `scrubbing`. */
  commitRetired(): void;
  /** Rewrites the registry as it stood before the removal began. */
  restore(): void;
}

export interface ManagedAccountArchiveRemoval {
  engine: ManagedAccountEngine;
  accountId: string;
  home: string;
  homeIsSafe(): boolean;
  unsafeHome(): Error;
  /** Registry path moves for this home, read before the home moves. */
  rewrites(home: string, archive: string): AccountPathRewrite[];
  registry: AccountRemovalRegistryPort;
}

export class AccountArchiveUnavailableError extends Error {
  constructor(readonly archive: string, message: string) {
    super(message);
    this.name = "AccountArchiveUnavailableError";
  }
}

export class AccountRemovalBlockedError extends Error {
  constructor(readonly blockers: AccountRemovalBlocker[]) {
    super("account has active sessions or conversations");
    this.name = "AccountRemovalBlockedError";
  }
}

const ARCHIVE_CREDENTIALS: Record<ManagedAccountEngine, readonly string[]> = {
  claude: [".credentials.json"],
  codex: ["auth.json"],
};
/* Links the Viewer placed in the home. `projects` is the shared-store link
   (#891); a real `projects` directory is history and stays. */
const ARCHIVE_LINKS: Record<ManagedAccountEngine, readonly string[]> = {
  claude: [...OWNED_SYMLINKS.claude, "projects"],
  codex: [...OWNED_SYMLINKS.codex],
};

let checkpointHook: ((checkpoint: AccountRemovalCheckpoint) => void) | null = null;
/** Test seam: observe (or crash at) each durable step of a removal. */
export function setAccountRemovalCheckpointForTests(hook: ((checkpoint: AccountRemovalCheckpoint) => void) | null): void {
  checkpointHook = hook;
}
function reach(checkpoint: AccountRemovalCheckpoint): void { checkpointHook?.(checkpoint); }

/* Removals running in this process, shared across bundled copies of this
   module, so startup recovery never undoes a removal that is still running. */
const inFlight: Set<string> = ((globalThis as unknown as { __llvAccountRemovalsInFlight?: Set<string> }).__llvAccountRemovalsInFlight ??= new Set());
export function accountRemovalInFlight(engine: ManagedAccountEngine, accountId: string): boolean {
  return inFlight.has(`${engine}:${accountId}`);
}

export function retiredAccountArchive(engine: ManagedAccountEngine, accountId: string): string {
  return path.join(path.dirname(stateDir()), "shared", engine, "retired", accountId);
}

function lstatOrNull(pathname: string): fs.Stats | null {
  try { return fs.lstatSync(pathname); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function nearestExistingAncestor(pathname: string): string {
  let current = path.resolve(pathname);
  for (;;) {
    if (lstatOrNull(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function openDirectoryNoFollow(pathname: string): number {
  const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  if (!fs.fstatSync(descriptor).isDirectory()) { fs.closeSync(descriptor); throw new Error("not a directory"); }
  return descriptor;
}

/** Unlinks one exact entry below `root` through directory descriptors, never
    following a link on the way. `remove` decides from the entry's own lstat. */
function unlinkExact(root: string, relative: string, remove: (stat: fs.Stats) => boolean): boolean {
  const parts = relative.split(path.sep);
  const descriptors: number[] = [];
  try {
    descriptors.push(openDirectoryNoFollow(root));
    for (const part of parts.slice(0, -1)) {
      const next = path.join(`/proc/self/fd/${descriptors.at(-1)}`, part);
      try { descriptors.push(openDirectoryNoFollow(next)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
      }
    }
    const target = path.join(`/proc/self/fd/${descriptors.at(-1)}`, parts.at(-1)!);
    const stat = lstatOrNull(target);
    if (!stat || !remove(stat)) return true;
    try { fs.unlinkSync(target); } catch { return false; }
    return lstatOrNull(target) === null;
  } catch {
    return false;
  } finally {
    for (const descriptor of descriptors.reverse()) fs.closeSync(descriptor);
  }
}

/** Step 6: credentials and the Viewer's links leave the archive by exact name. */
function scrubAccountArchive(engine: ManagedAccountEngine, archive: string): boolean {
  if (!lstatOrNull(archive)) return true;
  if (process.platform !== "linux") return false;
  let complete = true;
  for (const name of ARCHIVE_CREDENTIALS[engine]) {
    if (!unlinkExact(archive, name, (stat) => stat.isFile() || stat.isSymbolicLink())) complete = false;
  }
  for (const name of ARCHIVE_LINKS[engine]) {
    if (!unlinkExact(archive, name, (stat) => stat.isSymbolicLink())) complete = false;
  }
  return complete;
}

function measureArchive(archive: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const pathname = path.join(directory, entry.name);
      const stat = lstatOrNull(pathname);
      if (!stat) continue;
      if (stat.isDirectory()) visit(pathname);
      else if (stat.isFile()) { files += 1; bytes += stat.size; }
    }
  };
  if (lstatOrNull(archive)?.isDirectory()) visit(archive);
  return { files, bytes };
}

/** Removes directories left empty (rmdir never deletes content). */
function pruneEmptyDirectories(directory: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const pathname = path.join(directory, entry.name);
    if (lstatOrNull(pathname)?.isDirectory()) pruneEmptyDirectories(pathname);
  }
  try { fs.rmdirSync(directory); } catch { /* not empty */ }
}

function finishArchive(engine: ManagedAccountEngine, archive: string): { complete: boolean; files: number; bytes: number } {
  const complete = scrubAccountArchive(engine, archive);
  const measured = measureArchive(archive);
  pruneEmptyDirectories(archive);
  return { complete, ...measured };
}

/**
 * Removes a managed account by moving its home into the shared archive
 * (issue #1857, section 6 of docs/investigations/1857-account-removal.md).
 * The caller holds the account mutation lock and its engine registry lock.
 */
export function removeManagedAccountIntoArchive(spec: ManagedAccountArchiveRemoval): AccountArchiveRemovalReport {
  const { engine, accountId } = spec;
  const home = path.resolve(spec.home);
  const archive = retiredAccountArchive(engine, accountId);

  /* 1. Preflight, no writes. */
  const blockers = accountRemovalBlockers(engine, accountId);
  if (blockers.length > 0) throw new AccountRemovalBlockedError(blockers);
  let homeStat: fs.Stats | null;
  try { homeStat = lstatOrNull(home); } catch { throw spec.unsafeHome(); }
  if (homeStat) {
    if (!spec.homeIsSafe()) throw spec.unsafeHome();
    let mounts: ReadonlySet<string>;
    try { mounts = mountedPaths(); } catch { throw spec.unsafeHome(); }
    if (mounts.has(home)) throw spec.unsafeHome();
    if (lstatOrNull(archive)) throw new AccountArchiveUnavailableError(archive, "archive destination already exists");
    if (fs.statSync(nearestExistingAncestor(path.dirname(archive))).dev !== homeStat.dev) {
      throw new AccountArchiveUnavailableError(archive, "archive is on another filesystem than the account home");
    }
  }
  const rewrites = homeStat ? spec.rewrites(home, archive) : [];
  const key = `${engine}:${accountId}`;
  inFlight.add(key);
  try {
    /* 2. Journal the intent. */
    spec.registry.journal("archiving");
    reach("journaled");

    /* 3. One rename moves the home, credentials included. */
    const putHomeBack = (): void => { if (homeStat) fs.renameSync(archive, home); };
    if (homeStat) {
      try {
        fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
        fs.renameSync(home, archive);
      } catch (error) {
        spec.registry.journal(null);
        if ((error as NodeJS.ErrnoException).code === "EXDEV") throw new AccountArchiveUnavailableError(archive, "archive is on another filesystem than the account home");
        throw error;
      }
      reach("renamed");
    }

    /* 4. One agent-registry mutation; it re-checks liveness inside. From
       here a crash is finished, never undone, so the journal first records
       the path moves recovery needs to redo it. */
    try {
      spec.registry.journal("retiring", rewrites);
    } catch (error) {
      putHomeBack();
      try { spec.registry.journal(null); } catch { /* `archiving` with the home in place: recovery clears it */ }
      throw error;
    }
    const registry = agentRegistry();
    const beforeRetirement = registry.readOnlySnapshot();
    let retirement: AccountRetirementReport;
    try {
      retirement = registry.retireAccount(engine, accountId, "default", {}, { rewrite: rewrites });
    } catch (error) {
      putHomeBack();
      spec.registry.journal(null);
      if (error instanceof Error && error.message === "account has live sessions") throw new AccountRemovalBlockedError(["live_sessions"]);
      if (error instanceof Error && error.message === "account has current conversations") throw new AccountRemovalBlockedError(["current_conversations"]);
      throw error;
    }
    reach("registry-retired");

    /* 5. Commit the accounts registry. */
    const retired = registry.readOnlySnapshot();
    try {
      spec.registry.commitRetired();
    } catch (error) {
      registry.restoreSnapshot(retired, beforeRetirement);
      putHomeBack();
      /* If this write fails too, the journal still says `archiving` with the
         home in place, which recovery clears. */
      try { spec.registry.restore(); } catch { /* recovered at startup */ }
      throw error;
    }
    reach("accounts-committed");

    /* 6. Credentials and links leave by exact name. */
    const finished = homeStat ? finishArchive(engine, archive) : { complete: true, files: 0, bytes: 0 };
    let cleanupPending = !finished.complete;
    if (!cleanupPending) {
      try { spec.registry.journal(null); } catch { cleanupPending = true; }
    }

    /* 7. What moved. */
    return { archive: homeStat ? archive : null, files: finished.files, bytes: finished.bytes, ...retirement, cleanupPending };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Settles one journaled removal after a crash or a failed step. `archiving`
 * is undone: the home is renamed back and any registry path already moved
 * follows it. `retiring` is finished: the agent-registry retirement is redone
 * (it is idempotent) and the account leaves the accounts registry, so pins,
 * deliveries and the engine default it settled never outlive a restored home.
 * `scrubbing` (the account already left the registry) is finished.
 * Returns "retired" or "restored" once settled, and null while the record
 * needs a person: both the home and the archive exist, the journal disagrees
 * with the accounts registry, or the retirement is refused.
 */
export function recoverManagedAccountRemoval(input: {
  engine: ManagedAccountEngine;
  accountId: string;
  home: string;
  entry: AccountRemovalJournalEntry;
  listed: boolean;
  /** The accounts-registry commit of a finished removal: the account leaves,
      a retired record points at its archive, the journal moves to `scrubbing`. */
  commitRetired(): void;
  clearJournal(): void;
}): "retired" | "restored" | null {
  const home = path.resolve(input.home);
  const archive = retiredAccountArchive(input.engine, input.accountId);
  const scrub = (): "retired" | null => {
    if (!finishArchive(input.engine, archive).complete) return null;
    input.clearJournal();
    return "retired";
  };
  if (input.entry.phase === "scrubbing") return scrub();
  const homeExists = lstatOrNull(home) !== null;
  const archiveExists = lstatOrNull(archive) !== null;
  if (homeExists && archiveExists) return null;
  if (input.entry.phase === "retiring") {
    /* A home in place means the failed step already undid the retirement. */
    if (homeExists) { input.clearJournal(); return "restored"; }
    if (!input.listed) return scrub();
    try {
      agentRegistry().retireAccount(input.engine, input.accountId, "default", {}, { rewrite: input.entry.rewrites ?? [] });
    } catch {
      return null;
    }
    reach("registry-retired");
    input.commitRetired();
    reach("accounts-committed");
    return scrub();
  }
  if (!homeExists && archiveExists) {
    if (!input.listed) return null;
    fs.renameSync(archive, home);
    agentRegistry().rewriteAccountPaths(input.engine, [{ from: archive, to: home }]);
  }
  input.clearJournal();
  return "restored";
}

export function normalizeAccountRemovalJournal(value: unknown, validId: (id: string) => boolean): AccountRemovalJournalEntry[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const entries: AccountRemovalJournalEntry[] = [];
  for (const item of value) {
    const entry = item as Partial<AccountRemovalJournalEntry> | null;
    if (!entry || typeof entry.id !== "string" || !validId(entry.id) || (entry.phase !== "archiving" && entry.phase !== "retiring" && entry.phase !== "scrubbing") || typeof entry.startedAt !== "number") return null;
    if (entries.some((existing) => existing.id === entry.id)) return null;
    let rewrites: AccountPathRewrite[] | undefined;
    if (entry.rewrites !== undefined) {
      if (!Array.isArray(entry.rewrites)) return null;
      rewrites = [];
      for (const move of entry.rewrites as unknown[]) {
        const { from, to } = (move ?? {}) as Partial<AccountPathRewrite>;
        if (typeof from !== "string" || typeof to !== "string" || !path.isAbsolute(from) || !path.isAbsolute(to)) return null;
        rewrites.push({ from, to });
      }
    }
    entries.push({ id: entry.id, phase: entry.phase, startedAt: entry.startedAt, ...(rewrites ? { rewrites } : {}) });
  }
  return entries;
}

export function withAccountRemovalJournal(
  entries: readonly AccountRemovalJournalEntry[],
  accountId: string,
  phase: AccountRemovalJournalPhase | null,
  rewrites?: readonly AccountPathRewrite[],
): AccountRemovalJournalEntry[] {
  const others = entries.filter((entry) => entry.id !== accountId);
  if (!phase) return others;
  const startedAt = entries.find((entry) => entry.id === accountId)?.startedAt ?? Date.now();
  return [...others, { id: accountId, phase, startedAt, ...(rewrites ? { rewrites: rewrites.map(({ from, to }) => ({ from, to })) } : {}) }];
}

/** The DELETE answer: what moved, so the dialog can say it (issue #1857). */
export function removalResponse(accountId: string, removal: AccountArchiveRemovalReport) {
  return {
    removed: { id: accountId },
    cleanupPending: removal.cleanupPending,
    moved: { archive: removal.archive, files: removal.files, bytes: removal.bytes },
    conversationsRewritten: removal.conversationsRewritten,
    pinsCleared: removal.pinsCleared,
    deliveriesDropped: removal.deliveriesDropped,
    migrationsSettled: removal.migrationsSettled,
  };
}

/** The errno of a failed filesystem step, for a 500 that says what failed. */
export function removalErrno(error: unknown): { errno?: string } {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? { errno: code } : {};
}
