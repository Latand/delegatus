import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { measureTempBytes, resolvePhysicalPath, type ProcessScan, isUvCacheMarker } from "@/lib/tempSweep";
import { AttemptTempBudgetDeferred, attemptTempFailureDetail } from "./attemptTempDiagnostics";

const exec = promisify(execFile);
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
const run = (command: string, args: string[], timeout = 15_000) => exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
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
  targets.flatMap(target => [path.resolve(target), ...resolveObservedPhysicalPaths(target)]);

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
  const deadline = performance.now() + (timeout ?? 15_000);
  // An unreadable checkout, including an absent one, proves nothing about
  // its links. Let the failed read retain this root until a later sweep.
  const rootStat = fs.lstatSync(directory);
  const rootDevice = rootStat.dev;
  const links: string[] = [], directories: RepositoryDirectoryVersion[] = [];
  const checkBudget = () => {
    if (performance.now() >= deadline) throw new AttemptTempBudgetDeferred("checkout link inventory exceeded its time budget");
  };
  const readEntries = async (current: string) => {
    const remaining = deadline - performance.now();
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
      await new Promise(resolve => setTimeout(resolve, Math.max(wait, TIMESTAMP_GRANULE_MS)));
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
  const deadline = performance.now() + (timeout ?? 15_000);
  const inventory = await repositoryLinks(repository, timeout), lexicalTargets: string[] = [];
  for (const link of inventory.links) {
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
    if (performance.now() >= deadline)
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
  private readonly deadline: number;
  readonly walks: string[] = [];
  private readonly freshMs: number;
  constructor(private readonly options: { now?: () => number; budgetMs?: number; freshMs?: number; retained?: RetainedCheckoutReads; validationReuseMs?: number } = {}) {
    this.deadline = this.now() + (options.budgetMs ?? 30_000);
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
    return directories.every(directory => directoryVersionHolds(directory, fs.lstatSync(directory.path, { throwIfNoEntry: false })));
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
      let same = false;
      try { same = sameRepositoryDiscovery(observed, this.discoverRepository(cwd)); }
      catch { /* Judged below with every other change. */ }
      if (!same && !this.abandoned(cwd)) return false;
    }
    return true;
  }
  /** Every process that held this cwd in the scan has exited since, so the cwd
   * reaches no root; the same rule `retainDiscoveries` applies to a cwd absent
   * from the next scan. Test runs and gate checks remove their cwd right after
   * they exit, which used to hold every root observed at that moment. */
  abandoned(cwd: string) { return allExited(this.holders.get(cwd)); }
  private readonly holders = new Map<string, readonly (number | null)[]>();
  /** Checkouts read directly, such as a lane's worktree. A checkout found only
   * through the cwd of a scanned process is absent here. */
  private readonly direct = new Set<string>();
  /** A checkout that is gone, read only because scanned processes were in it,
   * all of which have exited: no process can use a link in it any more. */
  private released(repository: string) {
    if (this.direct.has(repository) || fs.existsSync(repository)) return false;
    const cwds = [...this.repositoriesOf].filter(([, discovery]) => discovery.repository === repository).map(([cwd]) => cwd);
    return cwds.length > 0 && cwds.every(cwd => this.abandoned(cwd));
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
    const remaining = this.deadline - now;
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

async function containerMountsClear(roots: readonly string[]): Promise<boolean> {
  const physicalRoots = [...new Set(roots.flatMap(root => [root, resolvePhysicalPath(root)]))];
  let active: string[];
  try { active = (await run("docker", ["ps", "-q"])).stdout.trim().split(/\s+/).filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  if (active.length > 1024 || new Set(active).size !== active.length) return false;
  for (let offset = 0; offset < active.length; offset += 32) {
    const ids = active.slice(offset, offset + 32);
    // Read only ownership metadata, in bounded replies. Whole inspect output
    // also includes credentials and unrelated configuration.
    const output = (await run("docker", ["inspect", "--format", '{"Id":{{json .Id}},"Mounts":{{json .Mounts}}}', ...ids])).stdout;
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

/** Native find streams an arbitrarily large owned tree; the owned worker and
 * each command impose time bounds instead of permanently retaining it at an
 * entry-count ceiling. Linked worktrees remain with their preservation owner. */
export async function inspectAttemptTree(directory: string, original = directory): Promise<boolean> {
  if (process.platform === "win32") {
    const pending = [directory]; let found = 0;
    while (pending.length) {
      const current = pending.pop()!;
      for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        const marker = entry.name === ".delegatus-keep" || entry.name === ".git" && !entry.isDirectory()
          || entry.name === "gitdir" && /(?:^|\/)worktrees\/.*\/gitdir$/.test(file.replaceAll(path.sep, "/"));
        if (marker && (++found > MARKER_LIMIT || markerHolds(file, directory, original))) return false;
        if (entry.isDirectory()) pending.push(file);
      }
    }
    return true;
  }
  // A tree find cannot read whole is held for the operator before it gets
  // here; one that turns unreadable meanwhile is held, never read with
  // privileges.
  try {
    const found = (await run("find", [directory, "-xdev", ...markers, "-print0"])).stdout.split("\0").filter(Boolean);
    return found.length <= MARKER_LIMIT && !found.some(file => markerHolds(file, directory, original));
  }
  catch { return false; }
}

/** An independent directory snapshot protects new markers even when expired
 * evidence is deliberately discarded. Check it synchronously after every
 * awaited observation and again at removal dispatch. Never follow links. */
export async function snapshotAttemptProtection(directory: string, budgetMs = 30_000): Promise<{ current: () => boolean }> {
  const until = performance.now() + Math.max(0, Math.min(30_000, budgetMs));
  const directories = new Map<string, string>();
  const signature = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
  const pending = [directory];
  while (pending.length) {
    if (performance.now() >= until || directories.size >= 10000) throw new AttemptTempBudgetDeferred("attempt protection snapshot budget exceeded");
    const current = pending.pop()!, stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("attempt protection directory changed");
    directories.set(current, signature(stat));
    const entries = fs.opendirSync(current);
    try {
      for (let entry; (entry = entries.readSync());) {
        if (performance.now() >= until || pending.length + directories.size >= 10000)
          throw new AttemptTempBudgetDeferred("attempt protection snapshot budget exceeded");
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    } finally { entries.closeSync(); }
  }
  return { current: () => {
    try {
      for (const [file, before] of directories) if (signature(fs.lstatSync(file, { bigint: true })) !== before) return false;
      return true;
    } catch { return false; }
  } };
}

/** Removes an attempt tree with this user's own rights. A directory it cannot
 * list or empty, left by a container that ran as another user, needs
 * privileges the Viewer does not have: the sweep holds such a root for the
 * operator before it gets here, and a removal that still meets one fails. */
export async function removeAttemptTree(directory: string, dispatchGuard?: () => boolean): Promise<void> {
  if (dispatchGuard && !dispatchGuard()) throw new Error("attempt temp deferred: authority changed before native removal");
  await fs.promises.rm(directory, { recursive: true, force: true });
}

const kibibytes = (output: string | undefined) => {
  const field = output?.trim().split(/\s+/)[0];
  const value = field ? Number(field) : NaN;
  return Number.isFinite(value) && value >= 0 ? value * 1024 : null;
};

/** What `du` can read, and whether part of the tree was unreadable. `du`
 * totals what it can read and exits 1 when a subtree is unreadable; that total
 * is the measurement, flagged. The old fallback kept only the root's own
 * inode and recorded a 51 GiB tree as 4 KiB. Nothing is read with privileges. */
export async function measureAttemptAllocation(directory: string): Promise<{ bytes: number; unreadable: boolean }> {
  if (process.platform === "win32") return { bytes: await measureTempBytes(directory), unreadable: false };
  try {
    const bytes = kibibytes((await run("du", ["-skx", "--", directory])).stdout);
    if (bytes !== null) return { bytes, unreadable: false };
  } catch (error) {
    const bytes = kibibytes((error as { stdout?: string }).stdout);
    if (bytes !== null) return { bytes, unreadable: true };
  }
  return { bytes: fs.lstatSync(directory).blocks * 512, unreadable: true };
}

export async function allocatedAttemptBytes(directory: string): Promise<number> {
  return (await measureAttemptAllocation(directory)).bytes;
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
