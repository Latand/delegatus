import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { measureTempBytes, resolvePhysicalPath, type ProcessScan, isUvCacheMarker } from "@/lib/tempSweep";
import { PRESERVED_MEDIA_EXTENSIONS } from "@/lib/artifact/evidenceFormats";
import { AttemptTempBudgetDeferred, attemptTempFailureDetail } from "./attemptTempDiagnostics";

const exec = promisify(execFile);
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
const run = (command: string, args: string[], timeout = 15_000) => exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
type RepositoryDirectoryVersion = { path: string; identity: string; mtimeMs: number; ctimeMs: number };
type RepositoryLinkSnapshot = { lexicalTargets: string[]; directories: RepositoryDirectoryVersion[] };
type RepositoryLinkRead = { at: number; targets: Promise<string[]>; directories?: RepositoryDirectoryVersion[]; physicalTargets?: string[] };
type RepositoryDiscovery = { repository: string | null; signature: string };
const sameStrings = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sameRepositoryDiscovery = (left: RepositoryDiscovery, right: RepositoryDiscovery) =>
  left.repository === right.repository && left.signature === right.signature;
function resolveObservedPhysicalPath(candidate: string): string {
  const original = path.resolve(candidate);
  let current = original;
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...suffix); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return original;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

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
    const before = fs.lstatSync(current);
    if (before.dev !== rootDevice) return;
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
    throw new Error(attemptTempFailureDetail(error), { cause: error });
  }
  return { links, directories };
}

/** Each link's lexical and physical targets, including dangling links. */
async function repositoryLinkTargets(repository: string, timeout?: number): Promise<RepositoryLinkSnapshot> {
  const deadline = performance.now() + (timeout ?? 15_000);
  const inventory = await repositoryLinks(repository, timeout), lexicalTargets: string[] = [];
  for (const link of inventory.links) {
    let target: string;
    try { target = path.resolve(path.dirname(link), fs.readlinkSync(link)); }
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
    if (!current?.isDirectory() || current.isSymbolicLink()
      || `${current.dev}:${current.ino}` !== directory.identity
      || current.mtimeMs !== directory.mtimeMs || current.ctimeMs !== directory.ctimeMs) {
      throw new AttemptTempBudgetDeferred("checkout changed during link inventory; retry next tick");
    }
  }
  return { lexicalTargets, directories: inventory.directories };
}

/** One tick's checkout link inventory, shared by every root the tick examines,
 * so the cost is one walk per checkout rather than one per checkout per root.
 * Directory identity and change timestamps invalidate a negative result as
 * soon as any inventoried directory changes. Older reads are also repeated;
 * every walk ends by the tick's budget, then remaining roots are deferred. */
export class RepositoryLinkInventory {
  private readonly reads = new Map<string, RepositoryLinkRead>();
  private readonly repositoriesOf = new Map<string, RepositoryDiscovery>();
  private readonly deadline: number;
  readonly walks: string[] = [];
  constructor(private readonly options: { now?: () => number; budgetMs?: number; freshMs?: number } = {}) {
    this.deadline = this.now() + (options.budgetMs ?? 30_000);
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private directoriesUnchanged(directories: readonly RepositoryDirectoryVersion[]) {
    return directories.every(directory => {
      const current = fs.lstatSync(directory.path, { throwIfNoEntry: false });
      return !!current?.isDirectory() && !current.isSymbolicLink()
        && `${current.dev}:${current.ino}` === directory.identity
        && current.mtimeMs === directory.mtimeMs && current.ctimeMs === directory.ctimeMs;
    });
  }
  /** Synchronous last check after the inventory's asynchronous observations. */
  unchanged(repository: string) {
    const read = this.reads.get(repository);
    return !!read?.directories && this.directoriesUnchanged(read.directories);
  }
  /** Last synchronous fence for every checkout observed during this sweep. */
  unchangedAll() {
    for (const read of this.reads.values()) {
      if (!read.directories || !this.directoriesUnchanged(read.directories) || !read.physicalTargets) return false;
      const lexical = this.lexicalTargets.get(read);
      if (!lexical) return false;
      try {
        if (!sameStrings(read.physicalTargets, lexical.flatMap(target => [target, resolveObservedPhysicalPath(target)]))) return false;
      } catch { return false; }
    }
    for (const [cwd, observed] of this.repositoriesOf) {
      try {
        if (!sameRepositoryDiscovery(observed, this.discoverRepository(cwd))) return false;
      } catch { return false; }
    }
    return true;
  }
  private readonly lexicalTargets = new WeakMap<object, string[]>();
  private discoverRepository(cwd: string): RepositoryDiscovery {
    const cwdStat = fs.statSync(cwd);
    if (!cwdStat.isDirectory()) throw new Error(`process cwd is not a directory: ${cwd}`);
    const versions: string[] = [];
    let repository: string | null = null;
    let current = path.resolve(cwd);
    for (let depth = 0; depth < 64; depth++) {
      const stat = fs.statSync(current);
      versions.push(`${current}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`);
      try {
        const markerPath = path.join(current, ".git");
        const marker = fs.lstatSync(markerPath);
        versions.push(`${markerPath}:${marker.dev}:${marker.ino}:${marker.mtimeMs}:${marker.ctimeMs}`);
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
  /** The nearest enclosing checkout of a process cwd. */
  repositoryOf(cwd: string): string | null {
    // Record negative results too: an existing cwd outside a checkout can
    // become a checkout while another awaited observation is in flight.
    const discovery = this.discoverRepository(cwd);
    this.repositoriesOf.set(cwd, discovery);
    return discovery.repository;
  }
  async targets(repository: string): Promise<string[]> {
    const now = this.now(), cached = this.reads.get(repository);
    if (cached && now - cached.at <= (this.options.freshMs ?? 10_000)
      && (!cached.directories || this.directoriesUnchanged(cached.directories))) {
      // A link can point through an external alias whose own directory is
      // outside the checkout. Re-resolve its physical destination on every
      // use; checkout directory metadata cannot invalidate that alias change.
      const lexical = await cached.targets;
      const physical = lexical.flatMap(target => [target, resolveObservedPhysicalPath(target)]);
      cached.physicalTargets = physical;
      return physical;
    }
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
      }
    }, () => undefined);
    this.walks.push(repository);
    const lexical = await observed;
    const physical = lexical.flatMap(target => [target, resolveObservedPhysicalPath(target)]);
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
  inventory = new RepositoryLinkInventory()): Promise<boolean> {
  return (await inventory.targets(repository)).some(referencesRoot(attemptRoots(original, current)));
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
  for (const process of scan.processes) {
    const cwd = process.paths[0];
    if (cwd?.startsWith(path.sep)) processCwds.push(cwd);
    const repository = cwd?.startsWith(path.sep) ? inventory.repositoryOf(cwd) : null;
    if (repository) repositories.add(repository);
  }
  for (const repository of [...repositories].sort()) {
    if (await repositoryReferencesAttemptTemp(repository, original, current, inventory)) return false;
  }
  if (process.platform === "linux" && !await containers([original, current])) return false;
  // The container query yields. Re-resolve every consumer checkout and links
  // after it, then synchronously validate the directory snapshots so a late
  // disappearance, permission change, replacement, or link creation cannot
  // ride on the earlier negative inventory.
  for (const cwd of processCwds) {
    const repository = inventory.repositoryOf(cwd);
    if (repository) repositories.add(repository);
  }
  for (const repository of [...repositories].sort()) {
    if (await repositoryReferencesAttemptTemp(repository, original, current, inventory)) return false;
  }
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
export async function attemptTempUtilityImage(): Promise<string> {
  if (process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE) return process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
  for (const pattern of utilityImages) {
    const found = (await run("docker", ["image", "ls", "--filter", `reference=${pattern}`, "--format", "{{.ID}}"])).stdout.trim().split(/\s+/)[0];
    if (found) return found;
  }
  throw new Error("no installed container cleanup utility image");
}
const noEvidence = 'found=$(find /attempt -xdev "(" -name .artifacts'
  + PRESERVED_MEDIA_EXTENSIONS.map(extension => ` -o -iname "*.${extension}"`).join("")
  + ' ")" -print -quit) || exit; test -z "$found" || exit 75; ';

async function containerCommand(directory: string, operation: "inspect" | "remove" | "measure" | "evidence", original = directory,
  guard?: () => Promise<boolean>, requireNoEvidence = false, dispatchGuard?: () => boolean): Promise<{ identity: string; stdout: string }> {
  const initial = fs.lstatSync(directory);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error("attempt namespace root changed");
  const identity = `${initial.dev}:${initial.ino}`;
  // Running containers may hold files through mount aliases that an ordinary
  // proc observer cannot read. Never stop or exec into one for reclamation.
  if (!await containerMountsClear([directory, original])) throw new Error("container ownership could not be cleared for the attempt tree");
  const image = await attemptTempUtilityImage();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image) || directory.includes(",")) throw new Error("invalid container cleanup input");
  const inspection = 'export ORIGINAL=$1; shift; find /attempt -xdev "$@" -print > /tmp/markers || exit; '
    + 'test "$(wc -l < /tmp/markers)" -le 10000 || exit 75; '
    + `find /attempt -xdev "$@" -exec /bin/sh -c ${"'" + containerClassifier.replaceAll("'", "'\\''") + "'"} sh {} + || exit; `;
  const body = operation === "measure" ? 'exec du -skx /attempt'
    : operation === "evidence" ? noEvidence
      : inspection + (requireNoEvidence ? noEvidence : "")
        + (operation === "remove" ? 'exec find /attempt -xdev -depth -mindepth 1 -delete' : 'exit 0');
  const script = 'identity=$1; shift; test "$(stat -c %d:%i /attempt)" = "$identity" || exit 75; ' + body;
  if (guard && !await guard()) throw new Error("attempt authority changed before namespace removal");
  const final = fs.lstatSync(directory);
  if (!final.isDirectory() || final.isSymbolicLink() || `${final.dev}:${final.ino}` !== identity)
    throw new Error("attempt identity changed before namespace dispatch");
  if (operation === "remove" && dispatchGuard && !dispatchGuard())
    throw new Error("attempt temp deferred: authority changed before namespace removal");
  // Only this owned tree is writable. No pull, network, socket, privileged
  // mode or host namespace is granted to the cleanup container.
  const result = await run("docker", ["run", "--rm", "--pull=never", "--network=none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=1m",
    "--cap-drop=ALL", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER", "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m", "--cpus=1", "--user=0",
    "--mount", `type=bind,source=${directory},target=/attempt${operation !== "remove" ? ",readonly" : ""}`,
    "--entrypoint", "timeout", image, "12", "/bin/sh", "-c", script, "sh", identity, original, ...markers]);
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
  try {
    const found = (await run("find", [directory, "-xdev", ...markers, "-print0"])).stdout.split("\0").filter(Boolean);
    return found.length <= MARKER_LIMIT && !found.some(file => markerHolds(file, directory, original));
  }
  catch (error) {
    if (process.platform !== "linux") throw error;
    try { await containerCommand(directory, "inspect", original); return true; }
    catch { return false; }
  }
}

/** An unreadable tree can retire only when the readonly namespace proves it
 * has no captures. The deletion namespace repeats that proof at dispatch. */
export async function attemptTreeHasNoEvidence(directory: string, original: string): Promise<void> {
  await containerCommand(directory, "evidence", original);
}

export async function removeAttemptTree(directory: string, original = directory, guard?: () => Promise<boolean>, requireNoEvidence = false,
  dispatchGuard?: () => boolean, postDeleteGuard = dispatchGuard): Promise<void> {
  if (requireNoEvidence) {
    const { identity } = await containerCommand(directory, "remove", original, guard, true, dispatchGuard);
    removeEmptyNamespaceRoot(directory, identity, postDeleteGuard);
    return;
  }
  if (dispatchGuard && !dispatchGuard()) throw new Error("attempt temp deferred: authority changed before native removal");
  try { await fs.promises.rm(directory, { recursive: true, force: true }); }
  catch (error) {
    if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || process.platform !== "linux") throw error;
    const { identity } = await containerCommand(directory, "remove", original, guard, true, dispatchGuard);
    removeEmptyNamespaceRoot(directory, identity, postDeleteGuard);
  }
}

export async function allocatedAttemptBytes(directory: string): Promise<number> {
  if (process.platform === "win32") return measureTempBytes(directory);
  let output: string | undefined;
  try { output = (await run("du", ["-skx", "--", directory])).stdout; }
  catch {
    if (process.platform === "linux") {
      try { output = (await containerCommand(directory, "measure")).stdout; }
      catch { /* Preserve a lower bound if namespace measurement is unavailable. */ }
    }
  }
  const value = Number(output?.trim().split(/\s+/)[0] ?? NaN);
  if (Number.isFinite(value) && value >= 0) return value * 1024;
  return fs.lstatSync(directory).blocks * 512;
}
