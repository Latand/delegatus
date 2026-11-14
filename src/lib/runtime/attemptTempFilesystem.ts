import { attemptTempRemaining, checkAttemptTempDeadline } from "./attemptTempDeadline";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { measureTempBytes, resolvePhysicalPath, type ProcessScan, isUvCacheMarker } from "@/lib/tempSweep";
import { reportMediaIndex } from "@/lib/reportMedia/lookup";
import { recordedRootHeld } from "@/lib/recordedChecks/store";
import { AttemptTempBudgetDeferred, attemptTempFailureDetail } from "./attemptTempDiagnostics";
import { attemptPathWatches, type AttemptMutationWatch } from "./attemptMutationFence";

const exec = promisify(execFile);
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
const run = async (command: string, args: string[], timeout = 15_000) => {
  checkAttemptTempDeadline();
  try {
    const result = await exec(command, args, { timeout: Math.max(1, Math.floor(attemptTempRemaining(timeout))),
      killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
    if (attemptTempRemaining() <= 0) throw Object.assign(new AttemptTempBudgetDeferred("tick deadline exhausted; retry next tick"),
      { stdout: result.stdout });
    return result;
  } catch (error) {
    if (attemptTempRemaining() <= 0 && !(error instanceof AttemptTempBudgetDeferred))
      throw Object.assign(new AttemptTempBudgetDeferred("tick deadline exhausted; retry next tick"),
        { cause: error, stdout: (error as { stdout?: unknown }).stdout });
    throw error;
  }
};
/** `mount` marks a directory on another device. The walk never enters it, so
 * its own timestamps say nothing about the checkout; its identity does: an
 * unmount or a new mount there changes the device and uncovers other entries. */
type RepositoryDirectoryVersion = { path: string; identity: string; mtimeMs: number; ctimeMs: number; mount?: true };
const directoryVersionHolds = (directory: RepositoryDirectoryVersion, current: fs.Stats | undefined) =>
  !!current?.isDirectory() && !current.isSymbolicLink()
  && `${current.dev}:${current.ino}` === directory.identity
  && (directory.mount || current.mtimeMs === directory.mtimeMs && current.ctimeMs === directory.ctimeMs);
type RepositoryLinkSnapshot = { lexicalTargets: string[]; directories: RepositoryDirectoryVersion[] };
type RepositoryLinkRead = { at: number; targets: Promise<string[]>; directories?: RepositoryDirectoryVersion[]; physicalTargets?: string[]; validatedAt?: number };
type RepositoryDiscovery = { repository: string | null; signature: string };
/** Completed checkout reads that outlive one tick, keyed by checkout. Each is
 * used again only while every directory it lists still validates. */
export type RetainedCheckoutReads = Map<string, { at: number; lexicalTargets: string[]; directories: RepositoryDirectoryVersion[] }>;
/** A retained read older than this is repeated in full. */
export const RETAINED_CHECKOUT_READ_MAX_AGE_MS = 10 * 60_000;
const sameStrings = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sameRepositoryDiscovery = (left: RepositoryDiscovery, right: RepositoryDiscovery) =>
  left.repository === right.repository && left.signature === right.signature;
const UNRESOLVED_LINK_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);
const vanished = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
/** Only a process the scan read from `/proc` (it has a namespace there) whose
 * entry is gone now has provably exited. Off Linux, without that proof (null),
 * or when the pid is present again, the process counts as alive. */
const allExited = (pids: readonly (number | null)[] | undefined) => process.platform === "linux" && !!pids?.length
  && pids.every(pid => pid !== null && !fs.existsSync(`/proc/${pid}`));
const LINK_HOP_LIMIT = 256;
const segments = (file: string) => file.split(path.sep).filter(Boolean);

/** Walks a path the way the kernel does, one component at a time, where the
 * kernel itself gives no answer: a dangling link, a loop, a chain longer than
 * the kernel follows. `..` is applied to the directory actually reached.
 * Returns every link the walk passed and the place where it ended, so a chain
 * that enters an attempt root at any hop names a path inside that root. A
 * cycle ends the walk once every hop of it is listed. A chain longer than the
 * hop limit throws: the caller then holds the root. */
function followLinkChain(candidate: string): string[] {
  const top = path.parse(candidate).root, pending = segments(candidate.slice(top.length));
  const places: string[] = [], seen = new Set<string>();
  let reached = top;
  while (pending.length) {
    checkAttemptTempDeadline();
    const name = pending.shift()!;
    if (name === ".") continue;
    if (name === "..") { reached = path.dirname(reached); continue; }
    const current = path.join(reached, name);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      return [...places, path.join(current, ...pending)];
    }
    if (!stat.isSymbolicLink()) { reached = current; continue; }
    const state = `${current}\0${pending.join(path.sep)}`;
    if (seen.has(state)) return places;
    seen.add(state);
    if (seen.size > LINK_HOP_LIMIT) throw new Error("checkout link chain exceeded its hop limit");
    places.push(current);
    const link = fs.readlinkSync(current);
    if (path.isAbsolute(link)) reached = path.parse(link).root;
    pending.unshift(...segments(path.isAbsolute(link) ? link.slice(reached.length) : link));
  }
  return [...places, reached];
}

/** The physical places a link target names. The kernel answers for a path
 * that resolves and holds no `..`; this runtime's realpath collapses `..`
 * before it resolves links, so such a path, like every path the kernel
 * refuses, is walked by hand. */
function resolveObservedPhysicalPaths(candidate: string): string[] {
  const target = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
  if (!segments(target).includes("..")) {
    try { return [fs.realpathSync(target)]; }
    catch (error) {
      if (!UNRESOLVED_LINK_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return followLinkChain(target);
}
/** A link target under its lexical name and under each physical one. */
const observedTargets = (targets: readonly string[]) =>
  targets.flatMap(target => {
    checkAttemptTempDeadline();
    return [path.resolve(target), ...resolveObservedPhysicalPaths(target)];
  });

/** A relative link target, joined to the link's directory without collapsing
 * `..` across a component that may itself be a link. Leading `..` inside the
 * checkout climbs directories the walk listed as real ones, each tracked by
 * identity, so those are applied here and the common relative link keeps the
 * kernel's fast answer. */
function uncollapsedLinkTarget(repository: string, link: string, value: string): string {
  if (path.isAbsolute(value)) return value;
  let directory = path.dirname(link);
  const names = value.split(path.sep);
  while (names.length && (names[0] === "." || names[0] === ".." && directory !== repository && inside(directory, repository))) {
    if (names.shift() === "..") directory = path.dirname(directory);
  }
  return [directory, ...names].join(path.sep);
}

/** Longer than one tick of the kernel's coarse clock at any common HZ. */
const TIMESTAMP_GRANULE_MS = 20;
/** Covers a file system that stores whole seconds, with room for clock skew. */
const COARSE_TIMESTAMP_GRANULE_MS = 2_000;
/** Timestamps with no sub-second part are taken as whole-second storage. A
 * finer file system shows them by chance once in a thousand directories and
 * only waits longer for it. */
const timestampGranuleMs = (stat: fs.Stats) =>
  stat.mtimeMs % 1_000 === 0 && stat.ctimeMs % 1_000 === 0 ? COARSE_TIMESTAMP_GRANULE_MS : TIMESTAMP_GRANULE_MS;
/** How long until the directory's last change is a full granule old. */
const granuleRemainingMs = (stat: fs.Stats, now: number) => {
  const granule = timestampGranuleMs(stat);
  return Math.max(0, granule - Math.abs(now - stat.ctimeMs), granule - Math.abs(now - stat.mtimeMs));
};

async function repositoryLinks(directory: string, timeout?: number): Promise<{ links: string[]; directories: RepositoryDirectoryVersion[] }> {
  const deadline = performance.now() + attemptTempRemaining(timeout ?? 15_000);
  // An unreadable checkout, including an absent one, proves nothing about
  // its links. Let the failed read retain this root until a later sweep.
  const rootStat = fs.lstatSync(directory);
  const rootDevice = rootStat.dev;
  const links: string[] = [], directories: RepositoryDirectoryVersion[] = [];
  const checkBudget = () => {
    checkAttemptTempDeadline();
    if (attemptTempRemaining(deadline - performance.now()) <= 0) throw new AttemptTempBudgetDeferred("checkout link inventory exceeded its time budget");
  };
  const readEntries = async (current: string) => {
    const remaining = attemptTempRemaining(deadline - performance.now());
    if (remaining <= 0) throw new AttemptTempBudgetDeferred("checkout link inventory exceeded its time budget");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fs.promises.readdir(current, { withFileTypes: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AttemptTempBudgetDeferred("checkout link inventory exceeded its time budget")), remaining); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const visit = async (current: string): Promise<void> => {
    let before = fs.lstatSync(current);
    const skipMount = () => {
      if (before.dev === rootDevice) return false;
      directories.push({ path: current, identity: `${before.dev}:${before.ino}`, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, mount: true });
      return true;
    };
    if (skipMount()) return;
    // The kernel stamps a directory from a coarse clock, and some file systems
    // store whole seconds. An entry made in the same granule as the
    // directory's previous change leaves its timestamps as they were, so a
    // list read inside that granule could pair with timestamps that a later
    // link shares. Such a list is read again once the granule passed; from
    // then on every change moves the timestamps and the validators see it.
    for (let wait = granuleRemainingMs(before, Date.now()); wait > 0; wait = granuleRemainingMs(before, Date.now())) {
      checkBudget();
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(attemptTempRemaining(), Math.max(wait, TIMESTAMP_GRANULE_MS)))));
      before = fs.lstatSync(current);
      if (skipMount()) return;
    }
    const entries = await readEntries(current);
    checkBudget();
    const after = fs.lstatSync(current, { throwIfNoEntry: false });
    // The entry list and its cache validator must describe the same directory
    // version. A link created after readdir but before lstat would otherwise
    // pair a negative list with the new directory timestamps.
    if (!after?.isDirectory() || after.isSymbolicLink()
      || `${before.dev}:${before.ino}` !== `${after.dev}:${after.ino}`
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new AttemptTempBudgetDeferred("checkout changed during link inventory; retry next tick");
    }
    directories.push({ path: current, identity: `${after.dev}:${after.ino}`, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs });
    for (const entry of entries) {
      checkBudget();
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) links.push(file);
      else if (entry.isDirectory() && entry.name !== ".git") await visit(file);
    }
  };
  try { await visit(directory); }
  catch (error) {
    if (error instanceof AttemptTempBudgetDeferred) throw error;
    // A checkout removed during the walk keeps its code, so a caller can tell
    // it from an unreadable one.
    throw Object.assign(new Error(attemptTempFailureDetail(error), { cause: error }),
      vanished(error) ? { code: (error as NodeJS.ErrnoException).code } : {});
  }
  return { links, directories };
}

/** Each link's target as written, including dangling links. */
async function repositoryLinkTargets(repository: string, timeout?: number): Promise<RepositoryLinkSnapshot> {
  const deadline = performance.now() + attemptTempRemaining(timeout ?? 15_000);
  const inventory = await repositoryLinks(repository, timeout), lexicalTargets: string[] = [];
  for (const link of inventory.links) {
    checkAttemptTempDeadline();
    let target: string;
    try { target = uncollapsedLinkTarget(repository, link, fs.readlinkSync(link)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    lexicalTargets.push(target);
  }
  // A nested directory can change after its own readdir/lstat pair while the
  // remainder of this checkout is still being traversed. Revalidate the full
  // inventory at the authority boundary so that such a late link cannot turn
  // an earlier negative into deletion permission.
  for (const directory of inventory.directories) {
    if (attemptTempRemaining(deadline - performance.now()) <= 0)
      throw new AttemptTempBudgetDeferred("checkout link inventory exceeded its time budget");
    const current = fs.lstatSync(directory.path, { throwIfNoEntry: false });
    if (!directoryVersionHolds(directory, current)) {
      throw new AttemptTempBudgetDeferred("checkout changed during link inventory; retry next tick");
    }
  }
  return { lexicalTargets, directories: inventory.directories };
}

/** One tick's checkout link inventory, shared by every root the tick examines,
 * so the cost is one walk per checkout rather than one per checkout per root.
 * Directory identity and change timestamps invalidate a negative result as
 * soon as any inventoried directory changes. Older reads are also repeated;
 * every walk ends by the tick's budget, then remaining roots are deferred.
 *
 * One pass over every consumer checkout of a busy machine takes longer than
 * the ten-second age and can take longer than a whole tick. A caller that
 * lives across ticks passes `retained`: completed reads are kept there and
 * serve later ticks for `RETAINED_CHECKOUT_READ_MAX_AGE_MS`, under the same
 * directory validation, so a pass finishes over several ticks and an
 * unchanged checkout is walked once per that age.
 *
 * Validation reads every inventoried directory. One reference observation
 * asks for it several times per checkout, and a sweep makes several such
 * observations per root. With `validationReuseMs`, a validation that just
 * succeeded answers those repeats. `unchangedAll` never reuses one: it is the
 * synchronous fence a sweep holds before each destructive step, and a
 * directory that passes it also passed every earlier check of the same read. */
export class RepositoryLinkInventory {
  private readonly reads = new Map<string, RepositoryLinkRead>();
  private readonly repositoriesOf = new Map<string, RepositoryDiscovery>();
  private readonly holders = new Map<string, readonly (number | null)[]>();
  private readonly direct = new Set<string>();
  private readonly deadline: number;
  readonly walks: string[] = [];
  private readonly freshMs: number;
  constructor(private readonly options: { now?: () => number; budgetMs?: number; freshMs?: number; retained?: RetainedCheckoutReads; validationReuseMs?: number } = {}) {
    this.deadline = this.now() + attemptTempRemaining(options.budgetMs ?? 30_000);
    this.freshMs = options.freshMs ?? (options.retained ? RETAINED_CHECKOUT_READ_MAX_AGE_MS : 10_000);
    // A checkout that stopped being a consumer is never asked for again.
    const now = this.now();
    for (const [repository, kept] of options.retained ?? []) {
      if (now - kept.at > this.freshMs || now < kept.at) options.retained!.delete(repository);
    }
  }
  /** A read kept from an earlier tick enters this one as its cached read. Its
   * age and its directories are judged by the same rule as any cached read. */
  private retainedRead(repository: string, now: number): RepositoryLinkRead | undefined {
    const kept = this.options.retained?.get(repository);
    if (!kept || now - kept.at > this.freshMs || now < kept.at) return undefined;
    const read: RepositoryLinkRead = { at: kept.at, targets: Promise.resolve(kept.lexicalTargets), directories: kept.directories };
    this.lexicalTargets.set(read, kept.lexicalTargets);
    this.reads.set(repository, read);
    return read;
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private directoriesUnchanged(directories: readonly RepositoryDirectoryVersion[]) {
    return directories.every(directory => {
      checkAttemptTempDeadline();
      return directoryVersionHolds(directory, fs.lstatSync(directory.path, { throwIfNoEntry: false }));
    });
  }
  /** Validates a completed read and records when it last held. */
  private readUnchanged(read: RepositoryLinkRead, reuse: boolean) {
    if (!read.directories) return false;
    const reuseMs = this.options.validationReuseMs ?? 0;
    if (reuse && reuseMs > 0 && read.validatedAt !== undefined && performance.now() - read.validatedAt <= reuseMs) return true;
    const unchanged = this.directoriesUnchanged(read.directories);
    read.validatedAt = unchanged ? performance.now() : undefined;
    return unchanged;
  }
  /** Synchronous last check after the inventory's asynchronous observations. */
  unchanged(repository: string) {
    const read = this.reads.get(repository);
    return !!read && this.readUnchanged(read, true);
  }
  /** Last synchronous fence for every checkout observed during this sweep. */
  unchangedAll() {
    checkAttemptTempDeadline();
    for (const [repository, read] of this.reads) {
      if (this.released(repository)) continue;
      if (!this.readUnchanged(read, false) || !read.physicalTargets) return false;
      const lexical = this.lexicalTargets.get(read);
      if (!lexical) return false;
      try {
        if (!sameStrings(read.physicalTargets, observedTargets(lexical))) return false;
      } catch { return false; }
    }
    for (const [cwd, observed] of this.repositoriesOf) {
      checkAttemptTempDeadline();
      let same = false;
      try { same = sameRepositoryDiscovery(observed, this.discoverRepository(cwd)); }
      catch { /* Judged below with every other change. */ }
      if (!same && !this.abandoned(cwd)) return false;
    }
    return true;
  }
  abandoned(cwd: string) { return allExited(this.holders.get(cwd)); }
  private released(repository: string) {
    if (this.direct.has(repository) || fs.existsSync(repository)) return false;
    const cwds = [...this.repositoriesOf].filter(([, discovery]) => discovery.repository === repository).map(([cwd]) => cwd);
    return cwds.length > 0 && cwds.every(cwd => this.abandoned(cwd));
  }
  /** Directory proofs used by the final synchronous mutation fence. Include
   * negative checkout discoveries, whose missing .git can become present. */
  mutationDirectories(): AttemptMutationWatch[] {
    const paths: AttemptMutationWatch[] = [];
    for (const read of this.reads.values()) {
      for (const directory of read.directories ?? []) paths.push({ directory: directory.path, content: false });
      paths.push(...attemptPathWatches([...(this.lexicalTargets.get(read) ?? []), ...(read.physicalTargets ?? [])]));
    }
    for (const [cwd, observed] of this.repositoriesOf) {
      paths.push(...attemptPathWatches([cwd]));
      for (let current = cwd;; current = path.dirname(current)) {
        paths.push({ directory: current, entries: [".git"] });
        if (current === observed.repository || current === path.dirname(current)) break;
      }
    }
    return paths;
  }
  private readonly lexicalTargets = new WeakMap<object, string[]>();
  /** The signature lists what decides the answer: for each directory from the
   * cwd upward its identity and birth time, and for its `.git` marker the
   * identity, birth time and kind, plus the size and modification time of a
   * marker file. A file system hands the inode of a removed directory to the
   * next one made, so identity alone would match a directory that was removed
   * and made again; the birth time tells the two apart. A marker file is
   * rewritten in place when a worktree is moved or repaired, and it changes
   * rarely. A directory's own change timestamps are left out. They move
   * whenever any entry is made in it, and a cwd outside every checkout has
   * ancestors that are written all the time (the state directory, a temp
   * root), so a signature with them refused every fence on a busy machine. A
   * new marker is read directly here, and the directories of a checkout found
   * here are versioned by its link inventory. */
  private discoverRepository(cwd: string): RepositoryDiscovery {
    const cwdStat = fs.statSync(cwd);
    if (!cwdStat.isDirectory()) throw new Error(`process cwd is not a directory: ${cwd}`);
    const versions: string[] = [];
    let repository: string | null = null;
    let current = path.resolve(cwd);
    for (let depth = 0; depth < 64; depth++) {
      checkAttemptTempDeadline();
      const stat = fs.statSync(current);
      versions.push(`${current}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
      try {
        const markerPath = path.join(current, ".git");
        const marker = fs.lstatSync(markerPath);
        versions.push(`${markerPath}:${marker.dev}:${marker.ino}:${marker.birthtimeMs}:${marker.isDirectory()
          ? "directory" : `file:${marker.size}:${marker.mtimeMs}`}`);
        repository = current;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        versions.push(`${path.join(current, ".git")}:absent`);
      }
      const parent = path.dirname(current);
      if (parent === current) return { repository, signature: JSON.stringify(versions) };
      current = parent;
    }
    if (!repository) throw new Error("process checkout ancestry exceeded its limit");
    return { repository, signature: JSON.stringify(versions) };
  }
  /** Keeps the recorded discoveries of these cwds and forgets the others. A
   * cwd that no process of the current scan holds belongs to a process that
   * exited; its directory may be gone, and it can no longer reach any root. */
  retainDiscoveries(cwds: readonly string[]) {
    const current = new Set(cwds);
    for (const cwd of this.repositoriesOf.keys()) if (!current.has(cwd)) this.repositoriesOf.delete(cwd);
    for (const cwd of this.holders.keys()) if (!current.has(cwd)) this.holders.delete(cwd);
  }
  /** The nearest enclosing checkout of a process cwd, held by `pids` in the scan. */
  repositoryOf(cwd: string, pids: readonly (number | null)[] = []): string | null {
    if (pids.length) this.holders.set(cwd, pids);
    // Record negative results too: an existing cwd outside a checkout can
    // become a checkout while another awaited observation is in flight.
    let discovery: RepositoryDiscovery;
    try { discovery = this.discoverRepository(cwd); }
    catch (error) {
      if (vanished(error) && this.abandoned(cwd)) { this.repositoriesOf.delete(cwd); return null; }
      throw error;
    }
    this.repositoriesOf.set(cwd, discovery);
    return discovery.repository;
  }
  async targets(repository: string, discovered = false): Promise<string[]> {
    checkAttemptTempDeadline();
    if (!discovered) this.direct.add(repository);
    const now = this.now(), cached = this.reads.get(repository) ?? this.retainedRead(repository, now);
    if (cached && now - cached.at <= this.freshMs
      && (!cached.directories || this.readUnchanged(cached, true))) {
      // A link can point through an external alias whose own directory is
      // outside the checkout. Re-resolve its physical destination on every
      // use; checkout directory metadata cannot invalidate that alias change.
      const lexical = await cached.targets;
      const physical = observedTargets(lexical);
      cached.physicalTargets = physical;
      return physical;
    }
    this.options.retained?.delete(repository);
    const remaining = attemptTempRemaining(this.deadline - now);
    if (remaining <= 0) return Promise.reject(new AttemptTempBudgetDeferred());
    const snapshot = repositoryLinkTargets(repository, Math.min(15_000, remaining));
    const targets = snapshot.then(result => result.lexicalTargets);
    const observed: Promise<string[]> = targets.catch(error => {
      // A refused read is not a cache entry. The next root can observe a
      // recovered checkout in this same process.
      if (this.reads.get(repository)?.targets === observed) this.reads.delete(repository);
      if (this.now() >= this.deadline) throw new AttemptTempBudgetDeferred(`checkout link inventory exceeded its tick budget; ${attemptTempFailureDetail(error)}`);
      throw error;
    });
    const read: RepositoryLinkRead = { at: now, targets: observed };
    this.reads.set(repository, read);
    void snapshot.then(result => {
      if (this.reads.get(repository) === read) {
        read.directories = result.directories;
        this.lexicalTargets.set(read, result.lexicalTargets);
        read.at = this.now();
        this.options.retained?.set(repository, { at: read.at, lexicalTargets: result.lexicalTargets, directories: result.directories });
      }
    }, () => undefined);
    this.walks.push(repository);
    const lexical = await observed;
    const physical = observedTargets(lexical);
    read.physicalTargets = physical;
    return physical;
  }
}

const referencesRoot = (roots: readonly string[]) => (target: string) => roots.some(root => inside(target, root));
const attemptRoots = (original: string, current: string) =>
  [...new Set([original, current, resolvePhysicalPath(original), resolvePhysicalPath(current)])];

/** A durable checkout link remains a dependency while its lane is open,
 * including between stages when no process has that checkout as its cwd. */
export async function repositoryReferencesAttemptTemp(repository: string, original: string, current = original,
  inventory = new RepositoryLinkInventory(), discovered = false): Promise<boolean> {
  return (await inventory.targets(repository, discovered)).some(referencesRoot(attemptRoots(original, current)));
}

/** Idle processes can still depend on a symlink in their checkout. Resolve
 * links without descending through them, including currently dangling links.
 * Every checkout that holds a live process is read; there is no count at
 * which the check gives up and holds everything. */
export async function attemptReferencesClear(original: string, current: string, scan: ProcessScan,
  containers: (roots: readonly string[]) => Promise<boolean> = containerMountsClear,
  inventory = new RepositoryLinkInventory()): Promise<boolean> {
  const roots = attemptRoots(original, current);
  const referenced = (file: string) => [file, resolvePhysicalPath(file)].some(referencesRoot(roots));
  if (scan.processes.some(process => process.paths.some(referenced))) return false;
  if (process.platform === "linux") {
    for (const line of fs.readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)) {
      const socket = line.trim().split(/\s+/).slice(7).join(" ");
      if (socket.startsWith(path.sep) && referenced(socket)) return false;
    }
  }
  const repositories = new Set<string>();
  const processCwds: string[] = [];
  const holders = new Map<string, (number | null)[]>(), consumers = new Map<string, Set<string>>();
  for (const process of scan.processes) {
    checkAttemptTempDeadline();
    const cwd = process.paths[0];
    if (!cwd?.startsWith(path.sep)) continue;
    processCwds.push(cwd);
    holders.set(cwd, [...holders.get(cwd) ?? [], process.namespace ? process.pid : null]);
  }
  // The scan is the list of live processes. Discoveries recorded for an
  // earlier root of this tick stay only for cwds a live process still holds.
  inventory.retainDiscoveries(processCwds);
  const discover = () => {
    for (const cwd of processCwds) {
      const repository = inventory.repositoryOf(cwd, holders.get(cwd));
      if (!repository) continue;
      repositories.add(repository);
      consumers.set(repository, (consumers.get(repository) ?? new Set()).add(cwd));
    }
  };
  const checkoutLinksIn = async () => {
    for (const repository of [...repositories].sort()) {
      try { if (await repositoryReferencesAttemptTemp(repository, original, current, inventory, true)) return true; }
      catch (error) {
        // A checkout removed after every process in it exited holds no link.
        if (!vanished(error) || ![...consumers.get(repository) ?? []].every(cwd => inventory.abandoned(cwd))) throw error;
        repositories.delete(repository);
      }
    }
    return false;
  };
  discover();
  if (await checkoutLinksIn()) return false;
  if (process.platform === "linux" && !await containers([original, current])) return false;
  // The container query yields. Re-resolve every consumer checkout and links
  // after it, then synchronously validate the directory snapshots so a late
  // disappearance, permission change, replacement, or link creation cannot
  // ride on the earlier negative inventory.
  discover();
  if (await checkoutLinksIn()) return false;
  return [...repositories].every(repository => inventory.unchanged(repository));
}

async function containerMountsClear(roots: readonly string[], remaining?: () => number): Promise<boolean> {
  const physicalRoots = [...new Set(roots.flatMap(root => [root, resolvePhysicalPath(root)]))];
  let active: string[];
  try { active = (await run("docker", ["ps", "-q"], remaining?.())).stdout.trim().split(/\s+/).filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  if (active.length > 1024 || new Set(active).size !== active.length) return false;
  for (let offset = 0; offset < active.length; offset += 32) {
    const ids = active.slice(offset, offset + 32);
    // Read only ownership metadata, in bounded replies. Whole inspect output
    // also includes credentials and unrelated configuration.
    const output = (await run("docker", ["inspect", "--format", '{"Id":{{json .Id}},"Mounts":{{json .Mounts}}}', ...ids], remaining?.())).stdout;
    const containers = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (containers.length !== ids.length) return false;
    if (!ids.every(id => {
      const matches = containers.filter(container => typeof container?.Id === "string" && container.Id.startsWith(id));
      if (matches.length !== 1 || !Array.isArray(matches[0].Mounts)) return false;
      return matches[0].Mounts.every((mount: { Type?: string; Source?: string }) => {
        if (mount.Type === "tmpfs") return true;
        return typeof mount.Source === "string" && path.isAbsolute(mount.Source)
          && ![mount.Source, resolvePhysicalPath(mount.Source)].some(source => physicalRoots.some(root => inside(source, root) || inside(root, source)));
      });
    })) return false;
  }
  return true;
}

const markers = ["(", "-name", ".delegatus-keep", "-o", "-path", "*/worktrees/*/gitdir",
  "-o", "-name", ".git", "!", "-type", "d", ")"];
const MARKER_LIMIT = 10_000;
const protectionMarker = (file: string, isDirectory: boolean) => path.basename(file) === ".delegatus-keep"
  || path.basename(file) === ".git" && !isDirectory
  || path.basename(file) === "gitdir" && /(?:^|\/)worktrees\/.*\/gitdir$/.test(file.replaceAll(path.sep, "/"));
function markerContent(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    // Bound the read even if a writer grows or replaces the marker after stat.
    const content = Buffer.alloc(4097);
    return content.subarray(0, fs.readSync(fd, content, 0, content.length, 0));
  } finally { fs.closeSync(fd); }
}
function markerHolds(file: string, directory: string, original: string): boolean {
  if (path.basename(file) === ".delegatus-keep") return true;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 4096) return true;
  const content = fs.readFileSync(file, "utf8");
  if (path.basename(file) === ".git" && stat.size === 0 && isUvCacheMarker(file)) return false;
  const pointer = path.basename(file) === "gitdir" ? content.trim()
    : /^gitdir: (.+)\s*$/.exec(content)?.[1]?.trim();
  if (!pointer) return true;
  const lexical = path.resolve(path.dirname(file), pointer);
  // Quarantine moves the whole root; absolute fixture links still name its
  // original location. Translate only that exact containment boundary.
  const target = inside(lexical, original) ? directory + lexical.slice(original.length) : lexical;
  try { return !inside(target, directory) || !inside(fs.realpathSync(target), fs.realpathSync(directory)); }
  catch { return true; }
}

// Same bounded classifier inside the narrowly mounted cleanup namespace.
// find supplies file names as argv, so whitespace and newlines stay literal.
const containerClassifier = `
  for file do
    test "$(basename "$file")" != .delegatus-keep || exit 75
    test -f "$file" && test ! -L "$file" || exit 75
    size=$(stat -c %s "$file") || exit
    test "$size" -le 4096 || exit 75
    if test "$(basename "$file")" = .git && test "$size" = 0; then
      printf '%s\\n' "$(dirname "$file")" | grep -Eq '/sdists-v[0-9]+(/|$)' && continue
    fi
    value=$(cat "$file") || exit
    case "$file" in */worktrees/*/gitdir) target=$value;;
      *) case "$value" in "gitdir: "*) target=\${value#gitdir: };; *) exit 75;; esac;; esac
    case "$target" in "$ORIGINAL"/*) target=/attempt\${target#"$ORIGINAL"};;
      /*) ;; *) target=$(dirname "$file")/$target;; esac
    case "$target" in /attempt/*) ;; *) exit 75;; esac
    test -e "$target" || exit 75
    target=$(readlink -f "$target") || exit 75
    case "$target" in /attempt/*) ;; *) exit 75;; esac
  done`;
const utilityImages = ["busybox:*", "alpine:*", "debian:*", "ubuntu:*", "postgres:*", "redis:*"];
export async function attemptTempUtilityImage(remaining?: () => number): Promise<string> {
  if (process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE) return process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
  for (const pattern of utilityImages) {
    const found = (await run("docker", ["image", "ls", "--filter", `reference=${pattern}`, "--format", "{{.ID}}"], remaining?.())).stdout.trim().split(/\s+/)[0];
    if (found) return found;
  }
  throw new Error("no installed container cleanup utility image");
}
/** The files of an attempt root that the evidence ledger links, relative to
 * it: pictures a stage report, a bridge report or a task named by their path
 * in the root (the report picture index). A root that recorded-check custody
 * still holds counts as evidence whole. Only these count in the namespace's
 * no-evidence proof; an image of a checked-out source tree is no recorded
 * evidence and no longer blocks a tree this user cannot read. An unreadable
 * index proves nothing. */
export function ledgerLinkedEvidence(original: string): string[] {
  if (recordedRootHeld(original)) throw new Error("recorded-check custody holds this root; the no-evidence proof refuses");
  const rows = reportMediaIndex();
  if (rows === null) throw new Error("report picture index is unreadable; the no-evidence proof cannot run");
  const roots = [path.resolve(original)];
  try { roots.push(path.join(fs.realpathSync(path.dirname(original)), path.basename(original))); }
  catch { /* A quarantined original keeps its lexical name. */ }
  const linked = new Set<string>();
  for (const row of rows) {
    const named = path.resolve(row.path), root = roots.find(candidate => named.startsWith(candidate + path.sep));
    if (!root) continue;
    linked.add(path.relative(root, named));
  }
  return [...linked];
}
/** Consumes the linked paths the command passes first: `linked` is 1 when any
 * of them exists in the mounted tree. */
const linkedEvidence = 'count=$1; shift; linked=0; while test "$count" -gt 0; do '
  + 'if test -e "/attempt/$1" || test -L "/attempt/$1"; then linked=1; fi; shift; count=$((count - 1)); done; ';
const noEvidence = 'test "$linked" = 0 || exit 75; ';
/** The cleanup container cannot run at all: no docker, no installed utility
 * image, or a refusal by the daemon or the image (exit 125 to 127). Retrying
 * does not help; the sweep holds the root for the operator. */
export const PRIVILEGED_CLEANUP_UNAVAILABLE = "privileged cleanup unavailable";
const unavailable = (detail: string) => new Error(`${PRIVILEGED_CLEANUP_UNAVAILABLE}: ${detail}`);
export const privilegedCleanupUnavailable = (error: unknown) => String((error as Error)?.message ?? error).includes(PRIVILEGED_CLEANUP_UNAVAILABLE);

// The same utility computes and verifies this digest. Include sub-second
// directory timestamps, modes and identities without parsing file names.
// Each command writes separately so a failed find/stat/sort cannot be hidden
// by a successful last command in a pipeline.
const namespaceSnapshot = "find /attempt -xdev -type d -exec stat -c '%d:%i:%f:%y:%z' {} + > /tmp/directories || exit; "
  + 'test "$(wc -l < /tmp/directories)" -le 10000 || exit 75; '
  + 'LC_ALL=C sort /tmp/directories > /tmp/sorted || exit; '
  + 'sha256sum /tmp/sorted > /tmp/digest || exit; read digest rest < /tmp/digest; ';
export type AttemptNamespaceProtection = { digest: string };
type NamespaceBudget = { budgetMs?: number; bytes?: number };
type AttemptRemovalSettings = NamespaceBudget & {
  /** Called when native deletion starts or the cleanup namespace reaches its delete command. */
  mutationStarted?: () => void;
  /** Synchronous entry authority; full checkout validation brackets repair. */
  permissionAuthority?: () => boolean;
  permissionChange?: AttemptProtection["permissionChange"];
};
function namespaceTimeout(settings: NamespaceBudget): number {
  // At least five seconds, then one second per 16 MiB, clipped to the
  // caller's remaining observation budget. Large trees get the whole bound.
  const bytes = settings.bytes && settings.bytes > 0 ? settings.bytes : 512 * 1024 ** 2;
  const sized = 5_000 + Math.ceil(bytes / (16 * 1024 ** 2)) * 1_000;
  return Math.max(0, Math.min(30_000, settings.budgetMs ?? 30_000, sized));
}

async function containerCommand(directory: string, operation: "inspect" | "remove" | "measure" | "evidence" | "snapshot", original = directory,
  guard?: () => Promise<boolean>, requireNoEvidence = false, dispatchGuard?: () => boolean,
  settings: NamespaceBudget = {}, protection?: AttemptNamespaceProtection, mutationStarted?: () => void): Promise<{ identity: string; stdout: string }> {
  // A measurement has no trustworthy size yet: use the remaining maximum.
  const until = performance.now() + attemptTempRemaining(namespaceTimeout(operation === "measure" ? { budgetMs: settings.budgetMs } : settings));
  const remaining = () => {
    const ms = Math.floor(attemptTempRemaining(until - performance.now()));
    if (ms <= 0) throw new AttemptTempBudgetDeferred("attempt namespace time budget exhausted");
    return ms;
  };
  const initial = fs.lstatSync(directory);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error("attempt namespace root changed");
  const identity = `${initial.dev}:${initial.ino}`;
  // Running containers may hold files through mount aliases that an ordinary
  // proc observer cannot read. Never stop or exec into one for reclamation.
  if (!await containerMountsClear([directory, original], remaining)) throw new Error("container ownership could not be cleared for the attempt tree");
  let image: string;
  try { image = await attemptTempUtilityImage(remaining); }
  catch (error) { throw unavailable(attemptTempFailureDetail(error)); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image) || directory.includes(",")) throw unavailable("invalid container cleanup input");
  const inspection = 'export ORIGINAL=$1; shift; find /attempt -xdev "$@" -print > /tmp/markers || exit; '
    + 'test "$(wc -l < /tmp/markers)" -le 10000 || exit 75; '
    + `find /attempt -xdev "$@" -exec /bin/sh -c ${"'" + containerClassifier.replaceAll("'", "'\\''") + "'"} sh {} + || exit; `;
  const body = operation === "snapshot" ? namespaceSnapshot + 'printf "%s\\n" "$digest"'
    : operation === "measure" ? 'exec du -skx /attempt'
    : operation === "evidence" ? noEvidence
      : inspection + (requireNoEvidence ? noEvidence : "")
        + (operation === "remove" ? 'printf "%s\\n" "DELEGATUS_REMOVAL_STARTED"; exec find /attempt -xdev -depth -mindepth 1 -delete' : 'exit 0');
  if (protection && !/^[a-f0-9]{64}$/.test(protection.digest)) throw new Error("invalid attempt namespace snapshot");
  const verify = protection ? namespaceSnapshot + `test "$digest" = '${protection.digest}' || exit 75; ` : "";
  const script = 'identity=$1; shift; test "$(stat -c %d:%i /attempt)" = "$identity" || exit 75; ' + linkedEvidence + verify + body;
  if (guard && !await guard()) throw new Error("attempt authority changed before namespace removal");
  // Read after the guard's awaits, so a picture named meanwhile still counts.
  const linked = operation === "evidence" || requireNoEvidence ? ledgerLinkedEvidence(original) : [];
  const final = fs.lstatSync(directory);
  if (!final.isDirectory() || final.isSymbolicLink() || `${final.dev}:${final.ino}` !== identity)
    throw new Error("attempt identity changed before namespace dispatch");
  if (operation === "remove" && dispatchGuard && !dispatchGuard())
    throw new Error("attempt temp deferred: authority changed before namespace removal");
  // Only this owned tree is writable. No pull, network, socket, privileged
  // mode or host namespace is granted to the cleanup container.
  const timeout = remaining();
  let result: { stdout: string };
  try {
    result = await run("docker", ["run", "--rm", "--pull=never", "--network=none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=4m",
    "--cap-drop=ALL", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER", "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m", "--cpus=1", "--user=0",
      "--mount", `type=bind,source=${directory},target=/attempt${operation !== "remove" ? ",readonly" : ""}`,
      "--entrypoint", "timeout", image, String(Math.max(1, Math.floor(timeout / 1000))), "/bin/sh", "-c", script, "sh", identity,
      String(linked.length), ...linked, original, ...markers], timeout);
  }
  catch (error) {
    if (operation === "remove" && String((error as { stdout?: unknown }).stdout ?? "").includes("DELEGATUS_REMOVAL_STARTED")) mutationStarted?.();
    const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
    if (code === "ENOENT" || [125, 126, 127].includes(Number(code))) throw unavailable(attemptTempFailureDetail(error));
    throw new Error(attemptTempFailureDetail(error), { cause: error });
  }
  if (operation === "remove" && result.stdout.includes("DELEGATUS_REMOVAL_STARTED")) mutationStarted?.();
  return { identity, stdout: result.stdout };
}

function removeEmptyNamespaceRoot(directory: string, identity: string, postDeleteGuard?: () => boolean) {
  const current = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!current?.isDirectory() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== identity)
    throw new Error("attempt identity changed before namespace rmdir");
  if (postDeleteGuard && !postDeleteGuard()) throw new Error("attempt temp deferred: authority changed before namespace rmdir");
  fs.rmdirSync(directory);
}

/** Native find streams an arbitrarily large owned tree; the owned worker and
 * each command impose time bounds instead of permanently retaining it at an
 * entry-count ceiling. Linked worktrees remain with their preservation owner. */
export async function inspectAttemptTree(directory: string, original = directory, settings: NamespaceBudget = {}): Promise<boolean> {
  if (process.platform === "win32") {
    const pending = [directory]; let found = 0;
    while (pending.length) {
      const current = pending.pop()!;
      for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        const marker = protectionMarker(file, entry.isDirectory());
        if (marker && (++found > MARKER_LIMIT || markerHolds(file, directory, original))) return false;
        if (entry.isDirectory()) pending.push(file);
      }
    }
    return true;
  }
  const until = performance.now() + attemptTempRemaining(namespaceTimeout(settings));
  try {
    const found = (await run("find", [directory, "-xdev", ...markers, "-print0"], Math.max(1, Math.min(15_000, Math.floor(attemptTempRemaining(until - performance.now())))))).stdout.split("\0").filter(Boolean);
    return found.length <= MARKER_LIMIT && !found.some(file => markerHolds(file, directory, original));
  }
  catch (error) {
    if (error instanceof AttemptTempBudgetDeferred || process.platform !== "linux") throw error;
    try { await containerCommand(directory, "inspect", original, undefined, false, undefined,
      { ...settings, budgetMs: attemptTempRemaining(until - performance.now()) }); return true; }
    catch (fallbackError) { if (fallbackError instanceof AttemptTempBudgetDeferred) throw fallbackError; return false; }
  }
}

export type AttemptProtection = {
  current: () => boolean;
  mutationDirectories?: readonly AttemptMutationWatch[];
  namespace?: AttemptNamespaceProtection;
  permissionChange?: (file: string, mode: number, apply: () => void) => void;
};
/** An independent directory and marker snapshot protects both new markers and
 * in-place rewrites even when expired evidence is deliberately discarded. Native metadata is checked synchronously
 * after awaited observations. Opaque descendants also require their digest
 * to be checked inside the removal namespace. Never follow links. */
export async function snapshotAttemptProtection(directory: string, budgetMs = 30_000, namespaceRemoval = false, bytes?: number):
  Promise<AttemptProtection> {
  const until = performance.now() + attemptTempRemaining(Math.max(0, Math.min(30_000, budgetMs)));
  const directories = new Map<string, string>();
  const markerFiles = new Map<string, { version: string; content?: Buffer }>();
  const readableDirectories: string[] = [];
  const signature = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
  const pending = [directory];
  const device = fs.lstatSync(directory).dev;
  let inaccessible = false;
  while (pending.length) {
    if (attemptTempRemaining(until - performance.now()) <= 0 || directories.size >= 10000) throw new AttemptTempBudgetDeferred("attempt protection snapshot budget exceeded");
    const current = pending.pop()!, stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("attempt protection directory changed");
    directories.set(current, signature(stat));
    if (stat.dev !== BigInt(device)) continue;
    let entries: fs.Dir | undefined;
    try {
      entries = fs.opendirSync(current);
      for (let entry; (entry = entries.readSync());) {
        if (attemptTempRemaining(until - performance.now()) <= 0 || pending.length + directories.size >= 10000)
          throw new AttemptTempBudgetDeferred("attempt protection snapshot budget exceeded");
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
        const file = path.join(current, entry.name);
        if (protectionMarker(file, entry.isDirectory())) {
          if (markerFiles.size >= MARKER_LIMIT) throw new AttemptTempBudgetDeferred("attempt protection marker budget exceeded");
          const marker = fs.lstatSync(file, { bigint: true });
          markerFiles.set(file, { version: signature(marker),
            content: marker.isFile() && marker.size <= BigInt(4096) ? markerContent(file) : undefined });
        }
      }
      // Some runtimes open the directory on the first read. Only a completed
      // iteration proves this directory can also be watched from the host.
      readableDirectories.push(current);
    } catch (error) {
      if (process.platform !== "linux" || !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      inaccessible = true;
    } finally { entries?.closeSync(); }
  }
  let namespace: AttemptNamespaceProtection | undefined;
  if (inaccessible) {
    const result = await containerCommand(directory, "snapshot", directory, undefined, false, undefined,
      { budgetMs: attemptTempRemaining(until - performance.now()), bytes });
    const digest = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid attempt namespace protection reply");
    namespace = { digest };
  }
  const current = () => {
    // Callers using native deletion cannot validate opaque descendants.
    // The retention adapter opts in only when it passes the digest to the
    // removal namespace, which rechecks every directory before deletion.
    if (namespace && !namespaceRemoval) return false;
    try {
      for (const [file, before] of directories) if (signature(fs.lstatSync(file, { bigint: true })) !== before) return false;
      for (const [file, before] of markerFiles) {
        if (signature(fs.lstatSync(file, { bigint: true })) !== before.version
          || before.content && !markerContent(file).equals(before.content)) return false;
      }
      return true;
    } catch { return false; }
  };
  return { namespace, current, mutationDirectories: [...readableDirectories, ...[...markerFiles.keys()].map(file => ({ file }))], permissionChange: (file, mode, apply) => {
    if (namespace || !current()) throw new AttemptTempBudgetDeferred("protection changed before permission repair");
    const before = fs.lstatSync(file, { bigint: true });
    apply();
    const after = fs.lstatSync(file, { bigint: true });
    // Only our chmod may advance ctime/mode. A new entry changes mtime;
    // replacement, ownership and link changes are never absorbed into proof.
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
      || before.uid !== after.uid || before.gid !== after.gid || before.nlink !== after.nlink
      || after.mode !== (before.mode & ~BigInt(0o7777) | BigInt(mode)))
      throw new AttemptTempBudgetDeferred("directory changed during permission repair");
    if (before.isDirectory()) directories.set(file, signature(after));
    if (!current()) throw new AttemptTempBudgetDeferred("protection changed during permission repair");
  } };
}

/** Refuse even same-device bind mounts, including mounts added while an
 * awaited guard was running. An unreadable mount table grants no permission. */
function assertAttemptMountsClear(directory: string) {
  if (process.platform !== "linux") return;
  for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n")) {
    const encoded = line.split(" ")[4];
    if (!encoded) throw new Error("attempt mount inventory is invalid");
    const mount = encoded.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (inside(mount, directory)) throw new AttemptTempBudgetDeferred("mount boundary changed before attempt removal");
  }
}
const descriptorMount = (fd: number) => {
  const id = /^mnt_id:\s*(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
  if (!id) throw new Error("attempt descriptor mount identity unavailable");
  return id;
};

/** Repair only directories in an admitted, expired tree. Pin each entry without
 * following a symlink, then chmod directory descriptors. O_PATH opens mode 000;
 * the proc descriptor names that inode even if its directory entry changes.
 * All child paths are relative to a held parent, on the root's device. */
function repairAttemptPermissions(directory: string, authority: () => boolean, budgetMs: number, permissionChange?: AttemptProtection["permissionChange"], dispatchGuard?: () => boolean) {
  // Descendant lookup through these pinned descriptors requires Linux procfs.
  // Other platforms keep their existing native removal path.
  if (process.platform !== "linux") return { rollback() {}, release() {} };
  const until = performance.now() + attemptTempRemaining(Math.max(0, Math.min(30_000, budgetMs)));
  const uid = process.getuid?.();
  if (uid === undefined) return { rollback() {}, release() {} };
  const initial = fs.lstatSync(directory);
  const physicalRoot = fs.realpathSync(directory);
  assertAttemptMountsClear(physicalRoot);
  let rootMount: string | undefined;
  const check = () => {
    if (attemptTempRemaining(until - performance.now()) <= 0) throw new AttemptTempBudgetDeferred("attempt permission repair time budget exhausted");
    if (!authority()) throw new AttemptTempBudgetDeferred("authority changed before permission repair");
  };
  type Entry = { fd: number; pinned: string; expected: string; identity: string };
  const stack: Array<Entry & { entries: fs.Dir }> = [];
  const changed: Array<{ fd: number; mode: number }> = [];
  const retainedFds = new Set<number>();
  const bound = (entry: Entry) => {
    const mount = descriptorMount(entry.fd);
    const linked = fs.lstatSync(entry.expected, { throwIfNoEntry: false });
    if (fs.readlinkSync(entry.pinned) !== entry.expected || !linked || linked.isSymbolicLink()
      || `${linked.dev}:${linked.ino}` !== entry.identity || mount !== rootMount)
      throw new AttemptTempBudgetDeferred("permission repair entry left its admitted root or mount");
  };
  const enter = (file: string, expected: string, root = false) => {
    check();
    // O_PATH is Linux-specific and is intentionally combined with O_NOFOLLOW:
    // a symlink descriptor is classified and closed without touching its target.
    const fd = fs.openSync(file, 0x200000 | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let keepDescriptor = false;
    try {
      const stat = fs.fstatSync(fd);
      // File modes do not prevent unlink from a writable parent. A file can
      // gain an external hardlink after fstat, so never chmod regular files.
      if (stat.isSymbolicLink() || stat.dev !== initial.dev || stat.uid !== uid || !stat.isDirectory()) return;
      if (root && `${stat.dev}:${stat.ino}` !== `${initial.dev}:${initial.ino}`) throw new Error("attempt permission repair root changed");
      const mode = stat.mode | 0o700;
      const pinned = `/proc/self/fd/${fd}`;
      if (root) rootMount = descriptorMount(fd);
      const entry = { fd, pinned, expected, identity: `${stat.dev}:${stat.ino}` };
      const validate = () => {
        // Inventory can be slow. Recheck the pinned binding and authority
        // after it, before granting any permission change.
        assertAttemptMountsClear(physicalRoot);
        for (const parent of stack) bound(parent);
        bound(entry);
        check();
      };
      validate();
      if (mode !== stat.mode) {
        validate();
        const apply = () => {
          check();
          // Every permission write uses the same final fence as removal.
          // Complete descriptor/mount/protection observations before it;
          // no filesystem read may follow admission before this write.
          if (dispatchGuard && !dispatchGuard()) throw new AttemptTempBudgetDeferred("authority changed before permission repair");
          fs.chmodSync(pinned, mode & 0o7777);
          changed.push({ fd, mode: stat.mode & 0o7777 });
          retainedFds.add(fd);
        };
        if (permissionChange) permissionChange(path.join(directory, path.relative(physicalRoot, expected)), mode & 0o7777, apply);
        else apply();
      }
      validate();
      stack.push({ ...entry, entries: fs.opendirSync(pinned) });
      keepDescriptor = true;
    } finally { if (!keepDescriptor && !retainedFds.has(fd)) fs.closeSync(fd); }
  };
  const cleanupFailures: unknown[] = [];
  const close = () => {
    const frame = stack.pop()!;
    try { frame.entries.closeSync(); } catch (error) { cleanupFailures.push(error); }
    if (!retainedFds.has(frame.fd)) {
      try { fs.closeSync(frame.fd); } catch (error) { cleanupFailures.push(error); }
    }
  };
  const closeRetained = (entries: Array<{ fd: number; mode: number }>) => {
    for (const { fd } of entries) {
      retainedFds.delete(fd);
      try { fs.closeSync(fd); } catch (error) { cleanupFailures.push(error); }
    }
  };
  const release = () => {
    closeRetained(changed.splice(0));
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures.splice(0), "attempt permission descriptor cleanup failed");
  };
  const rollback = () => {
    const failures: unknown[] = [];
    const entries = changed.splice(0).reverse();
    for (const entry of entries) {
      try { fs.chmodSync(`/proc/self/fd/${entry.fd}`, entry.mode); }
      catch (error) { failures.push(error); }
    }
    closeRetained(entries);
    failures.push(...cleanupFailures.splice(0));
    if (failures.length) throw new AggregateError(failures, "attempt permission rollback failed");
  };
  try {
    enter(directory, physicalRoot, true);
    while (stack.length) {
      check();
      const frame = stack[stack.length - 1];
      for (const parent of stack) bound(parent);
      const entry = frame.entries.readSync();
      if (entry) enter(path.join(frame.pinned, entry.name), path.join(frame.expected, entry.name));
      else close();
    }
  } catch (error) {
    while (stack.length) close();
    try { rollback(); } catch (rollbackError) {
      throw new Error(`${attemptTempFailureDetail(error)}; attempt permission rollback or descriptor cleanup failed: ${attemptTempFailureDetail(rollbackError)}`, { cause: error });
    }
    throw error;
  } finally { while (stack.length) close(); }
  return { rollback, release };
}

/** An unreadable tree can retire only when the readonly namespace proves it
 * has no captures. The deletion namespace repeats that proof at dispatch. */
export async function attemptTreeHasNoEvidence(directory: string, original: string): Promise<void> {
  await containerCommand(directory, "evidence", original);
}

export async function removeAttemptTree(directory: string, original = directory, guard?: () => Promise<boolean>, requireNoEvidence = false,
  dispatchGuard?: () => boolean, postDeleteGuard = dispatchGuard, discardExpiredEvidence = false,
  protection?: AttemptNamespaceProtection, settings: AttemptRemovalSettings = {}): Promise<void> {
  let repair: ReturnType<typeof repairAttemptPermissions> | undefined;
  let mutationStarted = false;
  try {
    if (requireNoEvidence || protection) {
      const { identity } = await containerCommand(directory, "remove", original, guard, requireNoEvidence || !discardExpiredEvidence, dispatchGuard, settings, protection,
        settings.mutationStarted);
      removeEmptyNamespaceRoot(directory, identity, postDeleteGuard);
      return;
    }
    if (dispatchGuard && !dispatchGuard()) throw new Error("attempt temp deferred: authority changed before native removal");
    if (discardExpiredEvidence && guard && dispatchGuard && postDeleteGuard) {
      repair = repairAttemptPermissions(directory, settings.permissionAuthority ?? postDeleteGuard, settings.budgetMs ?? 30_000, settings.permissionChange, dispatchGuard);
      // Repeat all observations after repair, including checkout references,
      // and reauthorize after the last await.
      if (!await guard() || !dispatchGuard()) throw new AttemptTempBudgetDeferred("authority changed after permission repair");
    }
    assertAttemptMountsClear(fs.realpathSync(directory));
    // Mount and physical-path reads may observe a changed root or protection.
    // Admit from the final synchronous snapshots immediately before native rm.
    if (dispatchGuard && !dispatchGuard()) throw new AttemptTempBudgetDeferred("authority changed before native removal");
    mutationStarted = true;
    settings.mutationStarted?.();
    try { await fs.promises.rm(directory, { recursive: true, force: true }); repair?.release(); }
    catch (error) {
      repair?.release();
      if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || process.platform !== "linux") throw error;
      const { identity } = await containerCommand(directory, "remove", original, guard, !discardExpiredEvidence, dispatchGuard, settings, protection);
      removeEmptyNamespaceRoot(directory, identity, postDeleteGuard);
    }
  } catch (error) {
    // Permission repair changes no data. Until deletion dispatch, restore every
    // changed directory mode before the quarantine owner restores its path.
    // Once deletion starts, retain the journal because removal may be partial.
    if (!mutationStarted) repair?.rollback();
    if (error instanceof AttemptTempBudgetDeferred) throw error;
    throw new Error(attemptTempFailureDetail(error), { cause: error });
  }
}

const kibibytes = (output: string | undefined) => {
  const field = output?.trim().split(/\s+/)[0];
  const value = field ? Number(field) : NaN;
  return Number.isFinite(value) && value >= 0 ? value * 1024 : null;
};

export async function measureAttemptAllocation(directory: string, settings: NamespaceBudget = {}): Promise<{ bytes: number; unreadable: boolean }> {
  if (process.platform === "win32") return { bytes: await measureTempBytes(directory), unreadable: false };
  const until = performance.now() + attemptTempRemaining(Math.max(0, Math.min(30_000, settings.budgetMs ?? 30_000)));
  if (attemptTempRemaining(until - performance.now()) <= 0) throw new AttemptTempBudgetDeferred("attempt measurement time budget exhausted");
  let partial: number | null = null;
  try {
    const bytes = kibibytes((await run("du", ["-skx", "--", directory], Math.max(1, Math.floor(attemptTempRemaining(until - performance.now()))))).stdout);
    if (bytes !== null) return { bytes, unreadable: false };
  } catch (error) { partial = kibibytes((error as { stdout?: string }).stdout); }
  let bytes = partial ?? fs.lstatSync(directory).blocks * 512;
  if (process.platform === "linux" && performance.now() < until) {
    try { bytes = Math.max(bytes, kibibytes((await containerCommand(directory, "measure", directory, undefined, false, undefined,
      { ...settings, budgetMs: attemptTempRemaining(until - performance.now()) })).stdout) ?? 0); }
    catch { /* Keep the readable lower bound. */ }
  }
  return { bytes, unreadable: true };
}

export async function allocatedAttemptBytes(directory: string, settings: NamespaceBudget = {}): Promise<number> {
  return (await measureAttemptAllocation(directory, settings)).bytes;
}

/** A directory inside an attempt tree that this user cannot list or empty.
 * Containers that ran as another user leave them: database data, browser
 * profiles, lock directories. Removing one needs privileges the sweep does not
 * use, so it is reported for the operator. `bytes` is what du could read in it. */
export type BlockedSubtree = { path: string; uid: number; mode: string; bytes: number; unreadable: boolean };
/** Entries one root reports in full; `count` still counts every one. */
export const BLOCKED_SUBTREE_REPORT_LIMIT = 16;

/** Every directory under `directory` that native removal would fail on, each
 * reported once at its top: it is not listable, not searchable or not
 * writable for this user, and not empty. */
export async function blockedSubtrees(directory: string, limit = BLOCKED_SUBTREE_REPORT_LIMIT): Promise<{ count: number; entries: BlockedSubtree[] }> {
  if (process.platform === "win32") return { count: 0, entries: [] };
  let output: string;
  try {
    output = (await run("find", [directory, "-xdev", "-mindepth", "1", "-type", "d",
      "(", "!", "-readable", "-o", "!", "-writable", "-o", "!", "-executable", ")", "-prune", "-printf", "%U\\0%m\\0%p\\0"])).stdout;
  } catch (error) {
    // find exits 1 when something below vanished or refused; what it printed
    // stands, and a refused directory is pruned above before it is entered.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout !== "string") throw error;
    output = stdout;
  }
  const fields = output.split("\0");
  const found: Array<{ path: string; uid: number; mode: string }> = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [uid, mode, file] = [Number(fields[index]), fields[index + 1]!, fields[index + 2]!];
    if (!file || !Number.isInteger(uid)) continue;
    // An empty directory is removed by its parent however it is owned.
    try { if (fs.readdirSync(file).length === 0) continue; } catch { /* Not listable: it stays reported. */ }
    found.push({ path: file, uid, mode });
  }
  const entries: BlockedSubtree[] = [];
  for (const entry of found.slice(0, limit)) {
    const measured = await measureAttemptAllocation(entry.path).catch(() => ({ bytes: 0, unreadable: true }));
    entries.push({ ...entry, ...measured });
  }
  return { count: found.length, entries };
}
