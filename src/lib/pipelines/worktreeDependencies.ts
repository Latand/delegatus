import { constants, promises as fs, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Pipeline } from "./types";

const inputs = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", ".npmrc", ".yarnrc.yml"];
const unsupported = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"]);
async function entry(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function input(file: string): Promise<Buffer | null> {
  try { return await fs.readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Only identical, non-workspace dependency graphs can borrow an installation.
 * Local links and patches need their own install in the checkout they describe. */
export async function matchingDependencyInputs(source: string, lane: string): Promise<boolean> {
  for (const file of inputs) {
    const left = await input(path.join(source, file)), right = await input(path.join(lane, file));
    if (left === null ? right !== null : right === null || !left.equals(right)) return false;
  }
  const manifestBytes = await input(path.join(lane, "package.json"));
  if (!manifestBytes) return false;
  const manifest = JSON.parse(manifestBytes.toString());
  return !manifest.workspaces && !manifest.patchedDependencies
    && !/(?:"(?:file|link|workspace):|"\.{1,2}\/)/.test(manifestBytes.toString());
}

/** clonefile on APFS and FICLONE on supporting Linux filesystems. FORCE is
 * essential: ordinary copy fallback would silently duplicate the full tree. */
async function cloneTree(source: string, target: string, root: string, destination: string,
  copyFile: typeof fs.copyFile, signal?: AbortSignal, clone = true): Promise<void> {
  signal?.throwIfAborted();
  const stat = await fs.lstat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { mode: stat.mode });
    for (const name of await fs.readdir(source)) await cloneTree(path.join(source, name), path.join(target, name), root, destination, copyFile, signal, clone);
  } else if (stat.isSymbolicLink()) {
    const link = await fs.readlink(source);
    const relative = path.relative(root, path.resolve(path.dirname(source), link));
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw Object.assign(new Error("dependency link leaves the installation"), { code: "ENOTSUP" });
    }
    await fs.symlink(path.relative(path.dirname(target), path.join(destination, relative)) || ".", target);
  } else if (stat.isFile()) {
    await copyFile(source, target, clone ? constants.COPYFILE_FICLONE_FORCE : 0);
    await fs.chmod(target, stat.mode);
  } else throw Object.assign(new Error("unsupported dependency entry"), { code: "ENOTSUP" });
}

export type DependencySharing = "clone" | "copy" | "private-install" | "unchanged";
/** Called before a writer starts, including a stage whose access was changed
 * after provisioning. A private install or an unrelated link is preserved. */
export function isolateWorktreeDependencies(pipeline: Pick<Pipeline, "repoDir" | "worktreeDir">): void {
  const local = path.join(pipeline.worktreeDir, "node_modules");
  const target = path.resolve(pipeline.repoDir, "node_modules");
  if (path.resolve(local) === target) return;
  // Keep the small custody check and unlink in one event-loop turn. A later
  // private installation or unrelated link belongs to its writer.
  const stat = lstatSync(local, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink() || path.toNamespacedPath(path.resolve(path.dirname(local), readlinkSync(local))) !== path.toNamespacedPath(target)) return;
  const current = lstatSync(local, { throwIfNoEntry: false });
  if (current?.isSymbolicLink() && current.ino === stat.ino && current.dev === stat.dev) unlinkSync(local);
}

export async function prepareWorktreeDependencies(pipeline: Pick<Pipeline, "repoDir" | "worktreeDir" | "stages">,
  options: { platform?: NodeJS.Platform; copyFile?: typeof fs.copyFile; signal?: AbortSignal } = {}): Promise<DependencySharing> {
  const source = path.join(pipeline.repoDir, "node_modules"), local = path.join(pipeline.worktreeDir, "node_modules");
  if (path.resolve(source) === path.resolve(local) || await entry(local)) return "unchanged";
  if (!(await entry(source)) || !await matchingDependencyInputs(pipeline.repoDir, pipeline.worktreeDir)) return "private-install";
  const platform = options.platform ?? process.platform;
  if (platform === "darwin" || platform === "linux") {
    const scratch = await fs.mkdtemp(path.join(pipeline.worktreeDir, ".delegatus-dependencies-"));
    const cloned = path.join(scratch, "node_modules");
    try {
      const root = await fs.realpath(source);
      await cloneTree(root, cloned, root, cloned, options.copyFile ?? fs.copyFile, options.signal);
      options.signal?.throwIfAborted();
      if (!await matchingDependencyInputs(pipeline.repoDir, pipeline.worktreeDir)) return "private-install";
      if (await entry(local)) return "unchanged";
      await fs.rename(cloned, local);
      return "clone";
    } catch (error) {
      if (!unsupported.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Stages receive full filesystem access. Even a nominally read-only
      // verification command can write generated clients and caches beside a
      // package, so a fallback link would expose the source installation.
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
  // Without CoW, make a private writable tree instead of a link. Verification
  // commands can generate package files even in a read-only role stage.
  options.signal?.throwIfAborted();
  const scratch = await fs.mkdtemp(path.join(pipeline.worktreeDir, ".delegatus-dependencies-"));
  const copied = path.join(scratch, "node_modules");
  try {
    const root = await fs.realpath(source);
    try {
      await cloneTree(root, copied, root, copied, options.copyFile ?? fs.copyFile, options.signal, false);
      options.signal?.throwIfAborted();
      if (!await matchingDependencyInputs(pipeline.repoDir, pipeline.worktreeDir)) return "private-install";
      if (await entry(local)) return "unchanged";
      await fs.rename(copied, local);
      return "copy";
    } catch (error) {
      if (unsupported.has((error as NodeJS.ErrnoException).code ?? "")) return "private-install";
      throw error;
    }
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
