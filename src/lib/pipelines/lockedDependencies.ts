import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tryLockFenceExclusive } from "../../runtime-host/fenceLock";
import type { ExecPort } from "../workflows/provision";

const CACHE_VERSION = "v2";
const BUDGET_MS = 180_000;
const CONFIG = ["package.json", "bun.lock", "bun.lockb", ".npmrc", "bunfig.toml"];

// Bootstrap hooks must run with no installed packages and no application store.
// Keep this executor on built-ins; its type-only import loads no module graph.
export const worktreeDependencyExec: ExecPort = (command, args, cwd, env, options = {}) => new Promise(resolve => {
  if (options.signal?.aborted) { resolve({ code: null, stdout: "", stderr: "cancelled" }); return; }
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", ...(options.inheritFd === undefined ? [] : [options.inheritFd]), ...options.additionalInheritedFds ?? []] });
  let stdout = "", stderr = "", bytes = 0;
  let stopped: string | null = null;
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = reason;
    if (!child.pid) return;
    try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
  };
  const abort = () => stop("dependency command cancelled");
  const timer = setTimeout(() => stop("dependency command timed out"), options.timeoutMs ?? BUDGET_MS);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const append = (chunk: string, output: boolean) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) { stop("dependency command output exceeded its byte limit"); return; }
    if (output) stdout += chunk; else stderr += chunk;
  };
  child.stdout?.setEncoding("utf8").on("data", chunk => append(chunk, true));
  child.stderr?.setEncoding("utf8").on("data", chunk => append(chunk, false));
  child.on("error", () => { stopped ??= "dependency command could not start"; });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    resolve({ code: stopped ? null : code, signal, stdout, stderr: stopped ? `${stopped}${stderr ? `: ${stderr}` : ""}` : stderr });
  });
});

async function stat(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Only owned install trees reach this walker. Never follow package symlinks. */
async function dependencyPermissions(directory: string, writable: boolean, check?: () => void): Promise<void> {
  check?.();
  const entry = await stat(directory);
  if (!entry || entry.isSymbolicLink()) return;
  const mode = entry.mode & 0o777;
  if (entry.isDirectory()) {
    if (writable) await fs.chmod(directory, mode | 0o700);
    for (const name of await fs.readdir(directory)) await dependencyPermissions(path.join(directory, name), writable, check);
  }
  if (!entry.isDirectory() || !writable) await fs.chmod(directory, writable ? mode | 0o200 : mode & ~0o222);
}

async function dependencyTarget(link: string): Promise<string | null> {
  try { return await fs.realpath(link); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Scope the shared installation policy to this repository. Other projects
 * retain their existing private-write dependency policy. */
export async function usesLockedDependencies(cwd: string): Promise<boolean> {
  try { return JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8")).name === "delegatus-cli"; }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("stage environment: dependency preparation failed: invalid dependency manifest");
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("stage environment: dependency preparation failed: dependency manifest could not be read", { cause: error });
  }
}

/** Capture every byte used by Bun, including patches, before installing.
 * The receipt describes an installation, never just its neighbouring checkout. */
export async function lockedDependencyInputs(cwd: string) {
  const files = new Map<string, Buffer>();
  for (const name of CONFIG) {
    if (await stat(path.join(cwd, name))) files.set(name, await fs.readFile(path.join(cwd, name)));
  }
  if (!files.has("bun.lock") && !files.has("bun.lockb")) throw new Error("a committed Bun lockfile is required");
  const manifest = JSON.parse(files.get("package.json")!.toString());
  const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies, manifest.overrides];
  if (manifest.workspaces || dependencies.some(group => group && Object.values(group).some(value =>
    typeof value === "string" && /^(?:(?:file|link|workspace):|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|~[\\/])/.test(value)))) {
    throw new Error("shared dependency preparation requires registry dependencies");
  }
  for (const patch of Object.values(manifest.patchedDependencies ?? {}) as string[]) {
    if (typeof patch !== "string" || path.isAbsolute(patch) || patch.split(/[\\/]/).includes("..")) throw new Error("invalid dependency patch path");
    const resolved = await fs.realpath(path.join(cwd, patch));
    if (!resolved.startsWith(await fs.realpath(cwd) + path.sep)) throw new Error("dependency patch leaves the checkout");
    files.set(patch, await fs.readFile(resolved));
  }
  const hash = createHash("sha256").update(`${CACHE_VERSION}\0frozen-readonly\0${process.platform}\0${process.arch}\0${Bun.version}\0`);
  for (const [name, bytes] of [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    hash.update(`${name.length}:${name}:${bytes.length}:`).update(bytes);
  }
  return { key: hash.digest("hex"), files };
}

/** One cache owner per repository, fenced across processes and released by
 * the kernel on death. Published entries are never installed into again. */
export async function prepareLockedDependencies(cwd: string, options: { exec?: ExecPort; signal?: AbortSignal } = {}): Promise<boolean> {
  try {
    const prepared = await prepareDependencyInstallation(cwd, options);
    if (!prepared) return false;
    if (await fs.realpath(path.join(cwd, "node_modules")) !== prepared.modules) throw new Error("dependency installation changed during preparation; retry setup");
    if ((await lockedDependencyInputs(cwd)).key !== prepared.key) throw new Error("dependency inputs changed during preparation; retry setup");
    prepared.remaining();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("stage environment: dependency preparation failed:")) throw error;
    throw new Error(`stage environment: dependency preparation failed: ${error instanceof Error ? error.message : "unknown setup error"}`, { cause: error });
  }
}

async function prepareDependencyInstallation(cwd: string, options: { exec?: ExecPort; signal?: AbortSignal }): Promise<false | { key: string; modules: string; remaining: () => number }> {
  if (!await usesLockedDependencies(cwd)) return false;
  // A checkout's normal install remains its owner's. Only linked worktrees
  // use this policy, including after an agent merges a new lockfile.
  if (!(await stat(path.join(cwd, ".git")))?.isFile()) return false;
  const exec = options.exec ?? worktreeDependencyExec;
  const deadline = Date.now() + BUDGET_MS;
  const remaining = () => {
    options.signal?.throwIfAborted();
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("dependency preparation deadline exceeded");
    return ms;
  };
  const run = async (command: string, args: string[], directory = cwd, inheritFd?: number) => {
    const result = await exec(command, args, directory, { NODE_ENV: "development" }, { signal: options.signal, timeoutMs: remaining(), additionalInheritedFds: inheritFd === undefined ? [] : [inheritFd] });
    remaining();
    if (result.code !== 0) throw new Error(`${command === "bun" ? "frozen dependency installation" : "dependency repository lookup"} failed (exit ${result.code ?? "interrupted"})`);
    return result.stdout.trim();
  };
  try {
    const common = await fs.realpath(await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    await run("git", ["check-ignore", "--quiet", "node_modules"]);
    const cache = path.join(common, "delegatus-dependencies", CACHE_VERSION);
    await fs.mkdir(cache, { recursive: true, mode: 0o700 });
    const filename = path.join(cache, "owner.lock");
    const fd = await fs.open(filename, "a+");
    let held: ReturnType<typeof tryLockFenceExclusive> = null;
    try {
      while (!(held = tryLockFenceExclusive({ fd: fd.fd, filename }))) {
        await delay(Math.min(50, remaining()), undefined, { signal: options.signal });
      }
      const activeBuild = path.join(cache, "building.json");
      try {
        const interrupted = JSON.parse(await fs.readFile(activeBuild, "utf8"));
        if (typeof interrupted.key !== "string" || !/^[a-f0-9]{64}$/.test(interrupted.key)) throw new Error("invalid dependency build ownership record");
        // Windows' fence uses a separate kernel handle, not the inherited fd.
        // A surviving installer cannot be ruled out after its owner dies.
        if (process.platform === "win32") throw new Error("interrupted dependency build requires inspection before retry");
        await dependencyPermissions(path.join(cache, `building-${interrupted.key}`, "node_modules"), true);
        await fs.rm(path.join(cache, `building-${interrupted.key}`), { recursive: true, force: true });
        await fs.unlink(activeBuild);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Capture after acquiring ownership: a queued merge may have changed it.
      const plan = await lockedDependencyInputs(cwd);
      const target = path.join(cache, plan.key);
      const modules = path.join(target, "node_modules");
      const receipt = path.join(target, "installed.json");
      // Reserve room before publishing: even refused or interrupted setup
      // keeps at most four unused completed graphs in this repository.
      const prune = async (keep: number) => {
        const listing = await run("git", ["worktree", "list", "--porcelain", "-z"]);
        const referenced = new Set<string>([modules]);
        for (const row of listing.split("\0")) {
          if (row.startsWith("worktree ")) {
            const resolved = await dependencyTarget(path.join(row.slice(9), "node_modules"));
            if (resolved) referenced.add(resolved);
          }
        }
        const unused: { directory: string; used: number }[] = [];
        for (const name of await fs.readdir(cache)) {
          if (!/^[a-f0-9]{64}$/.test(name)) continue;
          const directory = path.join(cache, name);
          if (referenced.has(path.join(directory, "node_modules"))) continue;
          const record = path.join(directory, "installed.json");
          if (JSON.parse(await fs.readFile(record, "utf8")).key !== name) continue;
          unused.push({ directory, used: (await fs.stat(record)).mtimeMs });
        }
        unused.sort((a, b) => b.used - a.used || a.directory.localeCompare(b.directory));
        for (const old of unused.slice(keep)) {
          remaining();
          await fs.unlink(path.join(old.directory, "installed.json"));
          await dependencyPermissions(path.join(old.directory, "node_modules"), true);
          await fs.rm(old.directory, { recursive: true });
        }
      };
      let installed = false;
      try { installed = JSON.parse(await fs.readFile(receipt, "utf8")).key === plan.key && (await stat(modules))?.isDirectory() === true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!installed) {
        if (await stat(target)) throw new Error("incomplete shared dependency entry; preserve it for inspection");
        await prune(3);
        const build = path.join(cache, `building-${plan.key}`);
        if (await stat(build)) throw new Error("unowned dependency build directory; preserve it for inspection");
        await fs.writeFile(activeBuild, JSON.stringify({ key: plan.key }));
        await fs.mkdir(build);
        try {
          for (const [name, bytes] of plan.files) {
            await fs.mkdir(path.dirname(path.join(build, name)), { recursive: true });
            await fs.writeFile(path.join(build, name), bytes);
          }
          await run("bun", ["install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"], build, fd.fd);
          if (!(await stat(path.join(build, "node_modules")))?.isDirectory()) {
            // Bun creates no directory for a package without dependencies.
            await fs.mkdir(path.join(build, "node_modules"));
          }
          if ((await lockedDependencyInputs(build)).key !== plan.key) throw new Error("frozen installation changed dependency inputs");
          remaining();
          await dependencyPermissions(path.join(build, "node_modules"), false, remaining);
          remaining();
          await fs.writeFile(path.join(build, "installed.json"), JSON.stringify({ key: plan.key }));
          await fs.rename(build, target);
        } finally {
          await dependencyPermissions(path.join(build, "node_modules"), true);
          await fs.rm(build, { recursive: true, force: true });
          await fs.unlink(activeBuild);
        }
      }
      // Reassert the installation's read-only permissions before admission.
      if (((await fs.lstat(modules)).mode & 0o222) !== 0) await dependencyPermissions(modules, false, remaining);
      remaining();
      if ((await lockedDependencyInputs(cwd)).key !== plan.key) throw new Error("dependency inputs changed during preparation; retry setup");
      const local = path.join(cwd, "node_modules");
      const before = await stat(local);
      if (before?.isSymbolicLink() && await fs.realpath(local).catch(() => "") === modules) {
        return { key: plan.key, modules, remaining };
      }
      if (installed) {
        await prune(3);
        remaining();
        if ((await lockedDependencyInputs(cwd)).key !== plan.key) throw new Error("dependency inputs changed during preparation; retry setup");
      }
      const linkRoot = await fs.mkdtemp(path.join(cwd, ".delegatus-dependencies-"));
      try {
        const link = path.join(linkRoot, "node_modules");
        await fs.symlink(modules, link, process.platform === "win32" ? "junction" : "dir");
        const current = await stat(local);
        if (current?.ino !== before?.ino || current?.dev !== before?.dev) throw new Error("dependency installation changed during preparation");
        if (before && !before.isSymbolicLink()) {
          // Older provisions own real directories. Preserve their bytes outside
          // the worktree; never delete an installation whose provenance is unknown.
          const preserved = await fs.mkdtemp(path.join(cache, "preserved-"));
          await fs.rename(local, path.join(preserved, "node_modules"));
        }
        await fs.rename(link, local);
      } finally { await fs.rm(linkRoot, { recursive: true, force: true }); }
      if ((await lockedDependencyInputs(cwd)).key !== plan.key) throw new Error("dependency inputs changed while linking; retry setup");
      await prune(4);
      return { key: plan.key, modules, remaining };
    } finally { held?.release(); await fd.close(); }
  } catch (error) {
    throw new Error(`stage environment: dependency preparation failed: ${error instanceof Error ? error.message : "unknown setup error"}`);
  }
}
