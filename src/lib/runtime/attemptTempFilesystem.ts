import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { measureTempBytes, resolvePhysicalPath, type ProcessScan, isUvCacheMarker } from "@/lib/tempSweep";

const exec = promisify(execFile);
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
const run = (command: string, args: string[], timeout = 15_000) => exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
async function repositoryLinks(directory: string, timeout?: number): Promise<string[]> {
  if (process.platform !== "win32") return (await run("find", [directory, "-xdev", "-name", ".git", "-type", "d", "-prune", "-o", "-type", "l", "-print0"], timeout)).stdout.split("\0").filter(Boolean);
  const pending = [directory], links: string[] = []; let visited = 0;
  while (pending.length) for (const entry of await fs.promises.readdir(pending.pop()!, { withFileTypes: true })) {
    if (++visited > 200_000) throw new Error("partial inbound-link inventory");
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) links.push(file);
    else if (entry.isDirectory() && entry.name !== ".git") pending.push(file);
  }
  return links;
}

/** Each link's lexical and physical targets, including dangling links. */
async function repositoryLinkTargets(repository: string, timeout?: number): Promise<string[]> {
  const targets: string[] = [];
  for (const link of await repositoryLinks(repository, timeout)) {
    let target: string;
    try { target = path.resolve(path.dirname(link), fs.readlinkSync(link)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    targets.push(target, resolvePhysicalPath(target));
  }
  return targets;
}

/** One tick's checkout link inventory, shared by every root the tick examines,
 * so the cost is one walk per checkout rather than one per checkout per root.
 * A read older than `freshMs` is repeated, and every walk ends by the tick's
 * budget; past it the remaining roots are held until the next tick. */
export class RepositoryLinkInventory {
  private readonly reads = new Map<string, { at: number; targets: Promise<string[]> }>();
  private readonly repositoriesOf = new Map<string, string | null>();
  private readonly deadline: number;
  readonly walks: string[] = [];
  constructor(private readonly options: { now?: () => number; budgetMs?: number; freshMs?: number } = {}) {
    this.deadline = this.now() + (options.budgetMs ?? 30_000);
  }
  private now() { return (this.options.now ?? Date.now)(); }
  /** The nearest enclosing checkout of a process cwd. */
  repositoryOf(cwd: string): string | null {
    if (this.repositoriesOf.has(cwd)) return this.repositoriesOf.get(cwd)!;
    let repository: string | null = null;
    for (let current = cwd, depth = 0; depth < 64 && current !== path.dirname(current); depth++, current = path.dirname(current)) {
      if (fs.existsSync(path.join(current, ".git"))) { repository = current; break; }
    }
    this.repositoriesOf.set(cwd, repository);
    return repository;
  }
  targets(repository: string): Promise<string[]> {
    const now = this.now(), cached = this.reads.get(repository);
    if (cached && now - cached.at <= (this.options.freshMs ?? 10_000)) return cached.targets;
    const remaining = this.deadline - now;
    const targets = remaining > 0 ? repositoryLinkTargets(repository, Math.min(15_000, remaining))
      : Promise.reject(new Error("checkout link inventory exceeded its tick budget"));
    this.walks.push(repository);
    this.reads.set(repository, { at: now, targets });
    return targets;
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
  for (const process of scan.processes) {
    const cwd = process.paths[0];
    const repository = cwd?.startsWith(path.sep) ? inventory.repositoryOf(cwd) : null;
    if (repository) repositories.add(repository);
  }
  for (const repository of [...repositories].sort()) {
    if (await repositoryReferencesAttemptTemp(repository, original, current, inventory)) return false;
  }
  return process.platform !== "linux" || await containers([original, current]);
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
const noEvidence = 'found=$(find /attempt -xdev "(" -name .artifacts -o -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.webp" -o -iname "*.gif" -o -iname "*.avif" -o -iname "*.svg" -o -iname "*.pdf" -o -iname "*.mp4" -o -iname "*.webm" ")" -print -quit) || exit; test -z "$found" || exit 75; ';

async function containerCommand(directory: string, operation: "inspect" | "remove" | "measure" | "evidence", original = directory,
  guard?: () => Promise<boolean>, requireNoEvidence = false) {
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
  // Only this owned tree is writable. No pull, network, socket, privileged
  // mode or host namespace is granted to the cleanup container.
  return run("docker", ["run", "--rm", "--pull=never", "--network=none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=1m",
    "--cap-drop=ALL", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER", "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m", "--cpus=1", "--user=0",
    "--mount", `type=bind,source=${directory},target=/attempt${operation !== "remove" ? ",readonly" : ""}`,
    "--entrypoint", "timeout", image, "12", "/bin/sh", "-c", script, "sh", identity, original, ...markers]);
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

export async function removeAttemptTree(directory: string, original = directory, guard?: () => Promise<boolean>, requireNoEvidence = false): Promise<void> {
  if (requireNoEvidence) {
    await containerCommand(directory, "remove", original, guard, true);
    await fs.promises.rmdir(directory);
    return;
  }
  try { await fs.promises.rm(directory, { recursive: true, force: true }); }
  catch (error) {
    if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || process.platform !== "linux") throw error;
    await containerCommand(directory, "remove", original, guard, true);
    await fs.promises.rmdir(directory);
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
