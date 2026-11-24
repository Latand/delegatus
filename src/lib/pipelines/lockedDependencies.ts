import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import filesystem, { chmodSync, constants, promises as fs, readlinkSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop, setTimeout as delay } from "node:timers/promises";
import { tryLockFenceExclusive } from "../../runtime-host/fenceLock";
import type { ExecPort, ExecResult } from "../workflows/provision";
import { dependencyPayloadScan } from "./dependencyPayloadScan";

const CACHE_VERSION = "v4";
const BUDGET_MS = 180_000;
const VALIDATION_RETRY_MS = 100;
const CONFIG = ["package.json", "bun.lock", "bun.lockb", ".npmrc", "bunfig.toml"];
type CliLink = { file: string; target: string };

function stageInstallConfig(bytes?: Buffer): string {
  try {
    const config: Record<string, unknown> = bytes ? Bun.TOML.parse(bytes.toString()) as Record<string, unknown> : {};
    const install = config.install ?? {};
    if (typeof install !== "object" || Array.isArray(install)) throw new Error("invalid install table");
    config.install = { ...install, production: false, dev: true };
    // The pinned Bun provides stringify; the bundled bun-types still omits it.
    return (Bun.TOML as typeof Bun.TOML & { stringify(value: object): string }).stringify(config);
  } catch { throw new Error("invalid Bun install configuration"); }
}

async function validateRequiredDependencies(modules: string, names: string[], check: () => void,
  observe?: (filename: string) => Promise<void>): Promise<void> {
  await inBatches(names, async name => {
    check();
    try {
      const filename = path.join(modules, name, "package.json");
      if (!filename.startsWith(modules + path.sep)) throw new Error("required dependency leaves the installation");
      await observe?.(filename);
      const resolved = await fs.realpath(filename);
      if (resolved.startsWith(modules + path.sep)) await observe?.(resolved);
      if (!resolved.startsWith(modules + path.sep) || !(await fs.stat(resolved)).isFile()) {
        throw new Error("required dependency leaves the installation");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("required dependency unavailable (ENOENT)");
      throw error;
    }
  });
}

async function inBatches<T>(values: readonly T[], visit: (value: T) => Promise<void>): Promise<void> {
  const batchSize = 32;
  for (let i = 0; i < values.length; i += batchSize) {
    // Settle peer reads before releasing the fence on a refusal.
    const results = await Promise.allSettled(values.slice(i, i + batchSize).map(visit));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    await yieldToEventLoop();
  }
}

/** Bootstrap can run without packages. Retain structured causes only: raw
 * installer output can contain registry credentials, source lines and paths. */
export function dependencyInstallFailure(result: ExecResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  const causes = ["ParserError", "EEXIST", "ENOSPC", "EACCES", "EPERM", "EROFS", "ENOENT", "ENOMEM",
    "ENOTDIR", "ENOTEMPTY", "EIO", "EMFILE", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND"]
    .filter(code => new RegExp(`\\b${code}\\b`).test(output));
  for (const [pattern, reason] of [
    [/lockfile had changes|lockfile.*(?:out of date|not up.to.date|does not match the manifest)/i, "frozen lockfile does not match the manifest"],
    [/no space left|disk full/i, "disk full"],
    [/permission denied|access denied/i, "permission denied"],
    [/timed out/i, "dependency command timed out"],
    [/cancelled/i, "dependency command cancelled"],
    [/could not start/i, "dependency command could not start"],
    [/output exceeded its byte limit/i, "dependency command output exceeded its byte limit"],
  ] as const) if (pattern.test(output)) causes.push(reason);
  const location = /\bbun\.lockb?:[0-9]{1,7}:[0-9]{1,7}\b/.exec(output)?.[0];
  if (location) causes.push(location);
  const diagnostic = causes.join("; ") || "installer diagnostic withheld (unrecognized cause)";
  return `stage environment: dependency preparation failed: frozen dependency installation failed (exit ${result.code ?? "interrupted"}): ${diagnostic}`;
}

// Bootstrap hooks must run with no installed packages and no application store.
// Keep this executor on built-ins; its type-only import loads no module graph.
function dependencyExec(detached: boolean): ExecPort {
  return (command, args, cwd, env, options = {}) => new Promise(resolve => {
    if (options.signal?.aborted) { resolve({ code: null, stdout: "", stderr: "cancelled" }); return; }
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: detached && process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", ...(options.inheritFd === undefined ? [] : [options.inheritFd]), ...options.additionalInheritedFds ?? []] });
    let stdout = "", stderr = "", bytes = 0;
    let stopped: string | null = null;
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      if (!child.pid) return;
      try { if (process.platform === "win32" || !detached) child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); }
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
}

export const worktreeDependencyExec = dependencyExec(true);
export const containedDependencyExec = dependencyExec(false);

async function stat(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function sameEntry(a: BigIntStats | undefined, b: BigIntStats | undefined): boolean {
  return a?.dev === b?.dev && a?.ino === b?.ino;
}

function sameVersion(a: BigIntStats | undefined, b: BigIntStats | undefined): boolean {
  return sameEntry(a, b) && a?.mode === b?.mode && a?.size === b?.size && a?.nlink === b?.nlink
    && a?.mtimeNs === b?.mtimeNs && a?.ctimeNs === b?.ctimeNs;
}

/** Pin the paths read by a validation, including symlink parents that Bun can
 * change in an otherwise sealed tree. A directory listing is unnecessary. */
class ValidationReads {
  private readonly entries = new Map<string, Promise<BigIntStats | undefined>>();
  private readonly observed = new Map<string, BigIntStats | undefined>();

  read(filename: string): Promise<BigIntStats | undefined> {
    let entry = this.entries.get(filename);
    if (!entry) {
      entry = fs.lstat(filename, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      }).then(value => {
        this.observed.set(filename, value);
        return value;
      });
      this.entries.set(filename, entry);
    }
    return entry;
  }

  async assertCurrent(message: string, check?: () => void): Promise<void> {
    const observed = [...this.observed];
    await inBatches(observed, async ([filename, seen]) => {
      check?.();
      if (!sameVersion(seen, await statBigInt(filename))) throw new Error(message);
      check?.();
    });
  }

  assertCurrentNow(message: string): void {
    for (const [filename, seen] of this.observed) {
      if (!sameVersion(seen, entryNow(filename))) throw new Error(message);
    }
  }

  snapshot(): IterableIterator<[string, BigIntStats | undefined]> { return this.observed.entries(); }
}

async function statBigInt(filename: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(filename, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function entryNow(filename: string): BigIntStats | undefined {
  return filesystem.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
}

/** Only owned install trees reach this walker. Never follow package symlinks. */
async function dependencyPermissions(directory: string, writable: boolean, check?: () => void, executables?: string[], cliLinks?: CliLink[]): Promise<void> {
  check?.();
  const entry = await stat(directory);
  if (!entry) return;
  if (entry.isSymbolicLink()) {
    if (path.basename(path.dirname(directory)) === ".bin") cliLinks?.push({ file: directory, target: await fs.readlink(directory) });
    return;
  }
  const mode = entry.mode & 0o777;
  if (entry.isDirectory()) {
    if (writable) {
      check?.();
      chmodSync(directory, mode | 0o700);
    }
    for (const name of await fs.readdir(directory)) await dependencyPermissions(path.join(directory, name), writable, check, executables, cliLinks);
  }
  if (!writable && entry.isFile() && (mode & 0o111) !== 0) executables?.push(directory);
  if (!entry.isDirectory() || !writable) {
    // Bun 1.4.0 replaces even correct CLI symlinks on a frozen reinstall.
    // Keep only node_modules/.bin directories owner-writable; package bytes
    // and their containing directories remain sealed against replacement.
    const binaries = entry.isDirectory() && path.basename(directory) === ".bin"
      && path.basename(path.dirname(directory)) === "node_modules";
    check?.();
    chmodSync(directory, writable ? mode | 0o200 : (mode & ~0o222) | (binaries ? 0o200 : 0));
  }
}

async function repairDependencyPermissions(modules: string, check: () => void, assertWriter: () => void): Promise<void> {
  const batchSize = 32;
  const pending = [modules];
  while (pending.length) {
    check();
    const entries = await Promise.allSettled(pending.splice(-batchSize).map(async file => {
      const entry = await fs.lstat(file, { bigint: true });
      if (entry.isSymbolicLink()) return;
      const names = entry.isDirectory() ? await fs.readdir(file) : [];
      const bin = entry.isDirectory() && path.basename(file) === ".bin" && path.basename(path.dirname(file)) === "node_modules";
      const mode = Number(entry.mode) & 0o777;
      const dirty = (mode & (bin ? 0o022 : 0o222)) !== 0;
      return { file, entry, names, dirty, mode: (mode & ~0o222) | (bin ? 0o200 : 0) };
    }));
    const changes = entries.flatMap(result => {
      if (result.status === "rejected") throw result.reason;
      if (!result.value) return [];
      const { file, names, dirty } = result.value;
      for (const name of names.sort()) pending.push(path.join(file, name));
      return dirty ? [result.value] : [];
    });
    if (!changes.length) continue;
    check();
    const handles = await Promise.allSettled(changes.map(async ({ file, entry, mode }) => {
      if ((!entry.isFile() && !entry.isDirectory()) || await fs.realpath(file) !== file) {
        throw new Error("dependency permission target changed during repair");
      }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!sameVersion(entry, await handle.stat({ bigint: true }))) {
          throw new Error("dependency permission target changed during repair");
        }
        return { handle, mode };
      } catch (error) {
        await handle.close();
        throw error;
      }
    }));
    try {
      const writes = handles.map(result => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      // Fence the actual writes once per batch, after all awaited reads. Use
      // the verified descriptors so a path swap cannot redirect a chmod.
      assertWriter();
      for (const result of await Promise.allSettled(writes.map(({ handle, mode }) => handle.chmod(mode)))) {
        if (result.status === "rejected") throw result.reason;
      }
    } finally {
      await Promise.allSettled(handles.map(result => result.status === "fulfilled" && result.value.handle.close()));
    }
  }
  check();
}

async function dependencyTarget(link: string): Promise<string | null> {
  try { return await fs.realpath(link); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function linksDirectlyTo(link: string, modules: string): boolean {
  try {
    const target = readlinkSync(link);
    return target === modules || target === path.toNamespacedPath(modules);
  } catch (error) {
    if (["ENOENT", "EINVAL", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
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
  const reads = new ValidationReads();
  const files = new Map<string, Buffer>();
  for (const name of CONFIG) {
    const filename = path.join(cwd, name);
    const entry = await reads.read(filename);
    if (entry) {
      const resolved = entry.isSymbolicLink() ? await fs.realpath(filename) : filename;
      await reads.read(resolved);
      files.set(name, await fs.readFile(resolved));
    }
  }
  if (!files.has("bun.lock") && !files.has("bun.lockb")) throw new Error("a committed Bun lockfile is required");
  const packageJson = files.get("package.json");
  if (!packageJson) throw new Error("dependency manifest is missing");
  const manifest = JSON.parse(packageJson.toString());
  const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies, manifest.overrides];
  if (manifest.workspaces || dependencies.some(group => group && Object.values(group).some(value =>
    typeof value === "string" && /^(?:(?:file|link|workspace):|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|~[\\/])/.test(value)))) {
    throw new Error("shared dependency preparation requires registry dependencies");
  }
  for (const patch of Object.values(manifest.patchedDependencies ?? {}) as string[]) {
    if (typeof patch !== "string" || path.isAbsolute(patch) || patch.split(/[\\/]/).includes("..")) throw new Error("invalid dependency patch path");
    const filename = path.join(cwd, patch);
    for (let part = filename; part !== cwd; part = path.dirname(part)) await reads.read(part);
    const resolved = await fs.realpath(filename);
    if (!resolved.startsWith(await fs.realpath(cwd) + path.sep)) throw new Error("dependency patch leaves the checkout");
    await reads.read(resolved);
    files.set(patch, await fs.readFile(resolved));
  }
  const hash = createHash("sha256").update(`${CACHE_VERSION}\0frozen-readonly\0${process.platform}\0${process.arch}\0${Bun.version}\0`);
  for (const [name, bytes] of [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    hash.update(`${name.length}:${name}:${bytes.length}:`).update(bytes);
  }
  const required = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(name => !Object.hasOwn(manifest.optionalDependencies ?? {}, name));
  return { key: hash.digest("hex"), files, required, reads, manifestName: manifest.name };
}

export type DependencyPreparationStep = "checkingDependencies" | "validatingSealedGraph" | "preparingToolchain";
export type DependencyPreparationEffect = "open-cache" | "prune-cache" | "prepare-cache" | "install-cache" | "publish-cache" | "link-cache";
type PreparationOptions = {
  exec?: ExecPort;
  payloadExec?: ExecPort;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  repository?: string;
  budgetMs?: number;
  onWriterWait?: () => void | Promise<void>;
  onStep?: (step: DependencyPreparationStep) => Promise<void>;
  beforeEffect?: (effect: DependencyPreparationEffect) => Promise<void>;
};
type DependencyPlan = Awaited<ReturnType<typeof lockedDependencyInputs>>;

function graphPaths(cache: string, key: string) {
  const target = path.join(cache, key);
  return { target, modules: path.join(target, "node_modules"), receipt: path.join(target, "installed.json"),
    payload: path.join(target, "payload.sha256"), content: path.join(target, "payload-content.sha256"),
    validation: path.join(target, "validated.sha256") };
}

type GraphPaths = ReturnType<typeof graphPaths>;

async function readDigest(filename: string, entry: BigIntStats | undefined): Promise<string | undefined> {
  if (!entry?.isFile() || Number(entry.size) !== 64) return;
  try {
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameVersion(entry, await handle.stat({ bigint: true }))) return;
      const bytes = Buffer.alloc(65);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const digest = bytes.toString("utf8", 0, bytesRead);
      if (bytesRead === 64 && /^[a-f0-9]{64}$/.test(digest) && sameVersion(entry, await handle.stat({ bigint: true }))) return digest;
    } finally { await handle.close(); }
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP", "EISDIR", "EACCES", "EPERM", "EIO"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function validationFingerprint(target: string, key: string, receipt: string,
  anchors: [string, BigIntStats | undefined][]): string {
  const hash = createHash("sha256").update(JSON.stringify(["validated-v2", key, receipt]));
  for (const [filename, entry] of anchors.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(JSON.stringify([path.relative(target, filename), entry && [
      entry.dev, entry.ino, entry.mode,
      // Writing the validation receipt updates its containing directory.
      ...(filename === target ? [] : [entry.size, entry.mtimeNs, entry.ctimeNs, entry.nlink]),
    ].map(String)]));
  }
  return hash.digest("hex");
}

type PayloadInventory = {
  metadata: string; payload: string | false; portable: string | false;
  reseal: boolean; executables: string[]; cliLinks: CliLink[];
};
type ScanPayload = (modules: string, content: boolean) => Promise<PayloadInventory>;

async function inspectGraph(graph: GraphPaths, plan: DependencyPlan, check: () => void, scan: ScanPayload, allowWalk: boolean) {
  const { target, modules, receipt, payload, content, validation } = graph;
  const reads = new ValidationReads();
  const [directory, root, seal, validationEntry, payloadEntry, contentEntry] = await Promise.all([
    statBigInt(target), reads.read(modules), reads.read(receipt), statBigInt(validation), statBigInt(payload),
    statBigInt(content),
  ]);
  check();
  if (!directory?.isDirectory() || !root?.isDirectory() || !seal?.isFile()) return null;
  if (!allowWalk && (!validationEntry?.isFile() || !payloadEntry?.isFile() || !contentEntry?.isFile())) return null;
  const [savedStamp, savedPayload, savedContent] = await Promise.all([
    readDigest(validation, validationEntry), readDigest(payload, payloadEntry), readDigest(content, contentEntry),
  ]);
  const receiptText = await fs.readFile(receipt, "utf8");
  check();
  const record = JSON.parse(receiptText);
  if (record?.key !== plan.key) return null;
  const installed = await lockedDependencyInputs(target);
  check();
  if (installed.key !== plan.key) throw new Error("shared dependency manifest does not match its receipt");
  const relative = (file: unknown): file is string => typeof file === "string"
    && !path.isAbsolute(file) && !file.split(/[\\/]/).some(part => !part || part === "." || part === "..");
  const executables: unknown = record.executables;
  const cliLinks: unknown = record.cliLinks;
  if (!Array.isArray(executables) || !executables.every(relative)) throw new Error("invalid dependency executable receipt");
  if (!Array.isArray(cliLinks) || cliLinks.some((link: CliLink) => !link || !relative(link.file)
    || path.basename(path.dirname(link.file)) !== ".bin" || typeof link.target !== "string"
    || !link.target || path.isAbsolute(link.target))) throw new Error("invalid dependency CLI link receipt");

  await reads.read(path.join(modules, ".bin"));
  const parents = async (filename: string) => {
    for (let parent = path.dirname(filename); parent !== modules; parent = path.dirname(parent)) {
      await reads.read(parent);
    }
  };
  await validateRequiredDependencies(modules, plan.required, check, async filename => {
    await parents(filename);
    await reads.read(filename);
  });
  await inBatches(executables, async file => {
    check();
    const filename = path.join(modules, file);
    await parents(filename);
    const entry = await reads.read(filename);
    if (!(await fs.realpath(filename)).startsWith(modules + path.sep)) throw new Error("dependency executable leaves the installation");
    if (!entry?.isFile() || Number(entry.nlink) !== 1) throw new Error("dependency executable changed during preparation");
  });
  await inBatches(cliLinks as CliLink[], async link => {
    check();
    const filename = path.join(modules, link.file);
    await parents(filename);
    const entry = await reads.read(filename);
    if (!entry) throw new Error("dependency CLI link unavailable (ENOENT); retry a frozen install");
    if (!entry.isSymbolicLink() || await fs.readlink(filename) !== link.target) {
      throw new Error("dependency CLI link changed; inspect the shared installation");
    }
    const resolved = await fs.realpath(filename);
    if (!resolved.startsWith(modules + path.sep)) throw new Error("dependency CLI link leaves the installation");
    await parents(resolved);
    const target = await reads.read(resolved);
    if (!target?.isFile() || (Number(target.mode) & 0o111) === 0) throw new Error("dependency CLI target is not executable");
  });
  const anchors: [string, BigIntStats | undefined][] = [[target, directory], ...reads.snapshot()];
  const anchorDigest = validationFingerprint(target, plan.key, receiptText, anchors);
  const stamp = (metadata: string, payload: string) =>
    createHash("sha256").update(anchorDigest + metadata + payload).digest("hex");
  if (!allowWalk && (!savedStamp || !savedPayload || !savedContent)) {
    assertAnchors(false);
    check();
    return null;
  }
  let inventory = await scan(modules, allowWalk && (!savedStamp || !savedPayload || !savedContent));
  const reusable = !inventory.reseal && !!savedPayload && !!savedContent && savedStamp === stamp(inventory.metadata, savedPayload);
  check();
  const recordedExecutables = new Set(executables as string[]);
  const recordedLinks = new Map((cliLinks as CliLink[]).map(link => [link.file, link.target]));
  if (recordedExecutables.size !== executables.length || recordedLinks.size !== cliLinks.length
    || recordedExecutables.size !== inventory.executables.length || inventory.executables.some(file => !recordedExecutables.has(file))
    || recordedLinks.size !== inventory.cliLinks.length || inventory.cliLinks.some(({ file, target }) => recordedLinks.get(file) !== target)) {
    assertAnchors(false);
    check();
    throw new Error("dependency receipt inventory does not match the installed graph");
  }
  if (!reusable && !allowWalk) {
    assertAnchors(false);
    check();
    return null;
  }
  if (!reusable && !inventory.payload) {
    const verified = await scan(modules, true);
    if (verified.metadata !== inventory.metadata) throw new Error("dependency graph changed during validation; retry setup");
    inventory = verified;
  }
  // Keep the local digest readable to earlier versions. Once a portable
  // digest has been verified, it also proves byte-identical restored files.
  const payloadChanged = savedContent ? savedContent !== inventory.portable : savedPayload && savedPayload !== inventory.payload;
  if (!reusable && payloadChanged) {
    throw new Error("dependency payload changed since the installation was validated");
  }

  function assertAnchors(reuse: boolean, expectedPayload = payloadEntry, expectedContent = contentEntry) {
    if (reuse && !sameVersion(validationEntry, entryNow(validation))) {
      throw new Error("dependency validation receipt changed during preparation; retry setup");
    }
    if (!sameVersion(expectedPayload, entryNow(payload)) || !sameVersion(expectedContent, entryNow(content))) {
      throw new Error("dependency payload receipt changed during validation; retry setup");
    }
    for (const [filename, expected] of anchors) {
      const current = entryNow(filename);
      const unchanged = filename === target
        ? sameEntry(expected, current) && expected?.mode === current?.mode
        : sameVersion(expected, current);
      if (!unchanged) throw new Error("dependency graph anchor changed during validation; retry setup");
    }
    // The manifest has only a handful of reads; keep this synchronous with
    // the final anchor check immediately before any return or link commit.
    installed.reads.assertCurrentNow("shared dependency manifest changed during preparation; retry setup");
  }
  const payloadDigest = inventory.payload || savedPayload;
  const contentDigest = inventory.portable || savedContent;
  if (!payloadDigest || !contentDigest) throw new Error("dependency payload scan did not certify its contents");
  const records: [string, string][] = [];
  if (contentDigest !== savedContent) records.push([content, contentDigest]);
  if (payloadDigest !== savedPayload) records.push([payload, payloadDigest]);
  return { reseal: inventory.reseal, reusable, metadata: inventory.metadata,
    records, fingerprint: stamp(inventory.metadata, payloadDigest), assertAnchors };
}

/** Match Git's registration backlink, so a copied .git pointer cannot give a
 * different checkout the eviction protection of the registered worktree. */
async function dependencyNamespace(cwd: string, common: string) {
  const dotGit = path.join(cwd, ".git");
  const checkout = entryNow(cwd), pointer = entryNow(dotGit), repository = entryNow(common);
  if (!checkout?.isDirectory() || !pointer?.isFile() || !repository?.isDirectory()) throw new Error("dependency worktree identity changed");
  const pointerText = await fs.readFile(dotGit, "utf8");
  const destination = pointerText.startsWith("gitdir: ") ? pointerText.slice(8).replace(/[\r\n]+$/, "") : undefined;
  if (!destination) throw new Error("invalid dependency worktree registration");
  const gitDir = await fs.realpath(path.resolve(cwd, destination.trimEnd()));
  const registration = entryNow(gitDir);
  if (path.dirname(gitDir) !== path.join(common, "worktrees") || !registration?.isDirectory()) {
    throw new Error("dependency worktree belongs to a different repository");
  }
  const backlink = path.join(gitDir, "gitdir"), commonFile = path.join(gitDir, "commondir");
  const linkEntry = entryNow(backlink), commonEntry = entryNow(commonFile);
  if (!linkEntry?.isFile() || !commonEntry?.isFile()
    || await fs.realpath(path.resolve(gitDir, (await fs.readFile(backlink, "utf8")).trimEnd())) !== dotGit
    || await fs.realpath(path.resolve(gitDir, (await fs.readFile(commonFile, "utf8")).trimEnd())) !== common) {
    throw new Error("dependency worktree is no longer registered");
  }
  const assertNamespace = () => {
    if (!sameEntry(checkout, entryNow(cwd)) || !sameEntry(repository, entryNow(common))
      || !sameEntry(registration, entryNow(gitDir)) || !sameVersion(pointer, entryNow(dotGit))
      || !sameVersion(linkEntry, entryNow(backlink)) || !sameVersion(commonEntry, entryNow(commonFile))) {
      throw new Error("dependency worktree identity changed during preparation");
    }
  };
  assertNamespace();
  return assertNamespace;
}

class DependencyDeadline extends Error {
  retry?: "validation" | "permission repair";
}

/** Retry one validation or repair deadline with fresh reads and attempt budget.
 * The prior attempt has already released its writer and temporary link. */
export async function prepareLockedDependencies(cwd: string, options: PreparationOptions = {}): Promise<boolean> {
  try {
    return await prepareLockedDependenciesOnce(cwd, options);
  } catch (error) {
    if (!(error instanceof DependencyDeadline) || !error.retry) throw error;
    console.warn(`${error.message}; retrying ${error.retry} in ${VALIDATION_RETRY_MS} ms`);
    await delay(VALIDATION_RETRY_MS, undefined, { signal: options.signal });
    return prepareLockedDependenciesOnce(cwd, options);
  }
}

/** One cache writer per repository. A sealed, registered checkout already
 * pointing at its graph can verify it independently of the writer. */
async function prepareLockedDependenciesOnce(cwd: string, options: PreparationOptions): Promise<boolean> {
  const exec = options.exec ?? worktreeDependencyExec;
  const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS);
  type Phase = "validation" | "wait" | "commit";
  const elapsed: Record<Phase, number> = { validation: 0, wait: 0, commit: 0 };
  let phase: Phase = "validation", operation = "worktree identity";
  let started = performance.now();
  const enter = (next: Phase, detail: string) => {
    const now = performance.now();
    elapsed[phase] += now - started;
    started = now;
    phase = next;
    operation = detail;
  };
  const remaining = () => {
    options.signal?.throwIfAborted();
    const ms = deadline - Date.now();
    if (ms <= 0) throw new DependencyDeadline("dependency preparation deadline exceeded");
    return ms;
  };
  const run = async (command: string, args: string[], directory = cwd, inheritFd?: number) => {
    const result = await exec(command, args, directory, { NODE_ENV: "development" }, { signal: options.signal, timeoutMs: remaining(), additionalInheritedFds: inheritFd === undefined ? [] : [inheritFd] });
    remaining();
    if (result.code !== 0) throw new Error(command === "bun" ? dependencyInstallFailure(result)
      : `dependency repository lookup failed (exit ${result.code ?? "interrupted"})`);
    return result.stdout.trim();
  };
  const scan: ScanPayload = async (modules, content) => {
    const result = await (options.payloadExec ?? worktreeDependencyExec)(process.execPath, ["--no-env-file", "-e", dependencyPayloadScan, modules, content ? "content" : "metadata"],
      path.dirname(process.execPath), {}, { signal: options.signal, timeoutMs: remaining() });
    remaining();
    if (result.code !== 0) throw new Error("dependency graph changed during validation or could not be scanned");
    const inventory: PayloadInventory = JSON.parse(result.stdout);
    if (!/^[a-f0-9]{64}$/.test(inventory.metadata) || (content &&
      [inventory.payload, inventory.portable].some(digest => !digest || !/^[a-f0-9]{64}$/.test(digest)))) {
      throw new Error("invalid dependency payload scan");
    }
    return inventory;
  };

  try {
    if (!await usesLockedDependencies(cwd)) return false;
    if (!(await stat(path.join(cwd, ".git")))?.isFile()) return false;
    await options.onStep?.("checkingDependencies");
    cwd = await fs.realpath(cwd);
    const common = await fs.realpath(await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    if (options.repository) {
      const ownerCommon = await fs.realpath(await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], options.repository));
      if (ownerCommon !== common) throw new Error("dependency worktree belongs to a different repository");
    }
    await run("git", ["check-ignore", "--quiet", "node_modules"]);
    const assertNamespace = await dependencyNamespace(cwd, common);
    const cacheParent = path.join(common, "delegatus-dependencies");
    const cache = path.join(cacheParent, CACHE_VERSION);
    const local = path.join(cwd, "node_modules");
    const activeBuild = path.join(cache, "building.json");
    const assertCurrent = () => {
      options.assertCurrent?.();
      remaining();
      assertNamespace();
    };
    const captureCache = () => {
      const parent = entryNow(cacheParent), root = entryNow(cache);
      if (!parent?.isDirectory() || !root?.isDirectory()) throw new Error("invalid shared dependency cache namespace");
      return () => {
        if (!sameEntry(parent, entryNow(cacheParent)) || !sameEntry(root, entryNow(cache))) {
          throw new Error("shared dependency cache namespace changed during preparation");
        }
      };
    };
    const capturePlan = async () => {
      const plan = await lockedDependencyInputs(cwd);
      if (plan.manifestName !== "delegatus-cli") throw new Error("dependency inputs changed during preparation; retry setup");
      return plan;
    };
    const assertInputs = (plan: DependencyPlan) =>
      plan.reads.assertCurrent("dependency inputs changed during preparation; retry setup", remaining);
    const assertInputsNow = (plan: DependencyPlan) =>
      plan.reads.assertCurrentNow("dependency inputs changed during preparation; retry setup");

    enter("validation", "existing link and seal");
    const before = entryNow(local);
    if (before?.isSymbolicLink() && entryNow(cache)) {
      await options.onStep?.("validatingSealedGraph");
      const assertCache = captureCache();
      const plan = await capturePlan();
      const graph = graphPaths(cache, plan.key);
      if (linksDirectlyTo(local, graph.modules) && await dependencyTarget(local) === graph.modules) {
        const checked = await inspectGraph(graph, plan, remaining, scan, false);
        if (checked) {
          assertCurrent();
          assertCache();
          assertInputsNow(plan);
          if (!sameVersion(before, entryNow(local)) || !linksDirectlyTo(local, graph.modules)) {
            throw new Error("dependency link changed during validation; retry setup");
          }
          checked.assertAnchors(true);
          assertCurrent();
          return true;
        }
      }
    }

    remaining();
    enter("wait", "repository writer fence");
    // Create the namespace one component at a time and refuse symlink aliases.
    await options.beforeEffect?.("open-cache");
    assertCurrent();
    await fs.mkdir(cacheParent, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (!entryNow(cacheParent)?.isDirectory()) throw new Error("invalid shared dependency cache namespace");
    await fs.mkdir(cache, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const assertCache = captureCache();
    const filename = path.join(cache, "owner.lock");
    const fd = await fs.open(filename, "ax+").catch(error => {
      if (error.code !== "EEXIST" || !entryNow(filename)?.isFile()) throw error;
      return fs.open(filename, "r+");
    });
    let held: ReturnType<typeof tryLockFenceExclusive> = null;
    let committed = false;
    try {
      const fenceEntry = await fd.stat({ bigint: true });
      const assertFence = () => {
        assertNamespace();
        assertCache();
        if (!fenceEntry.isFile() || !sameEntry(fenceEntry, entryNow(filename))) throw new Error("dependency writer fence changed");
      };
      const assertWriter = () => {
        options.assertCurrent?.();
        remaining();
        assertFence();
      };
      for (;;) {
        assertWriter();
        held = tryLockFenceExclusive({ fd: fd.fd, filename });
        if (held) break;
        await options.onWriterWait?.();
        await delay(Math.min(50, remaining()), undefined, { signal: options.signal });
      }

      await options.onStep?.("preparingToolchain");
      enter("commit", "interrupted install cleanup");
      const marker = entryNow(activeBuild);
      if (marker) {
        if (!marker.isFile()) throw new Error("invalid dependency build ownership record");
        const interrupted = JSON.parse(await fs.readFile(activeBuild, "utf8"));
        if (!sameVersion(marker, entryNow(activeBuild))) throw new Error("dependency build ownership changed");
        if (typeof interrupted?.key !== "string" || !/^[a-f0-9]{64}$/.test(interrupted.key)) throw new Error("invalid dependency build ownership record");
        // Windows' separate kernel handle cannot fence a surviving installer.
        if (process.platform === "win32") throw new Error("interrupted dependency build requires inspection before retry");
        const interruptedBuild = path.join(cache, `building-${interrupted.key}`);
        if (entryNow(interruptedBuild)?.isSymbolicLink()) throw new Error("invalid interrupted dependency build directory");
        await options.beforeEffect?.("prune-cache");
        assertWriter();
        await dependencyPermissions(path.join(interruptedBuild, "node_modules"), true, assertWriter);
        assertWriter();
        await fs.rm(interruptedBuild, { recursive: true, force: true });
        assertWriter();
        if (!sameVersion(marker, entryNow(activeBuild))) throw new Error("dependency build ownership changed");
        await fs.unlink(activeBuild);
      }

      enter("validation", "fenced graph");
      const plan = await capturePlan();
      const graph = graphPaths(cache, plan.key);
      const { target, modules } = graph;
      const existing = await stat(target);
      if (!existing) {
        enter("commit", "cold cache cleanup");
        // Eviction is needed only to reserve room for a new completed graph.
        // With three unused graphs reserved here, one more may become unused
        // if this build is interrupted or its worktree leaves a previous key.
        const listing = await run("git", ["worktree", "list", "--porcelain", "-z"]);
        const referenced = new Set<string>([modules]);
        const worktrees = listing.split("\0").filter(row => row.startsWith("worktree "));
        await inBatches(worktrees, async row => {
          remaining();
          const resolved = await dependencyTarget(path.join(row.slice(9), "node_modules"));
          if (resolved) referenced.add(resolved);
        });
        const unused: { directory: string; used: number }[] = [];
        for (const name of await fs.readdir(cache)) {
          remaining();
          if (!/^[a-f0-9]{64}$/.test(name)) continue;
          const oldGraph = graphPaths(cache, name);
          if (referenced.has(oldGraph.modules)) continue;
          if (!(await stat(oldGraph.target))?.isDirectory()) throw new Error("invalid shared dependency entry");
          const sealed = await stat(oldGraph.receipt);
          if (!sealed?.isFile() || JSON.parse(await fs.readFile(oldGraph.receipt, "utf8")).key !== name) continue;
          unused.push({ directory: oldGraph.target, used: sealed.mtimeMs });
        }
        unused.sort((a, b) => b.used - a.used || a.directory.localeCompare(b.directory));
        for (const old of unused.slice(3)) {
          await options.beforeEffect?.("prune-cache");
          assertWriter();
          await fs.unlink(path.join(old.directory, "installed.json"));
          // The receipt is invalidated first. Complete this owned cleanup
          // while retaining the fence, even if the caller has been cancelled.
          await dependencyPermissions(path.join(old.directory, "node_modules"), true, assertFence);
          assertFence();
          await fs.rm(old.directory, { recursive: true });
        }

        enter("commit", "cold install and seal");
        const build = path.join(cache, `building-${plan.key}`);
        if (await stat(build)) throw new Error("unowned dependency build directory; preserve it for inspection");
        assertWriter();
        await assertInputs(plan);
        await options.beforeEffect?.("prepare-cache");
        assertWriter();
        await fs.writeFile(activeBuild, JSON.stringify({ key: plan.key }), { flag: "wx" });
        try {
          assertWriter();
          await fs.mkdir(build);
          for (const [name, bytes] of plan.files) {
            assertWriter();
            await fs.mkdir(path.dirname(path.join(build, name)), { recursive: true });
            assertWriter();
            await fs.writeFile(path.join(build, name), bytes);
          }
          assertWriter();
          await fs.writeFile(path.join(build, "stage-install.toml"), stageInstallConfig(plan.files.get("bunfig.toml")));
          assertWriter();
          await options.beforeEffect?.("install-cache");
          assertWriter();
          await run("bun", ["install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile", "--config=stage-install.toml"], build, fd.fd);
          const buildingModules = path.join(build, "node_modules");
          if (!(await stat(buildingModules))?.isDirectory()) await fs.mkdir(buildingModules);
          if ((await lockedDependencyInputs(build)).key !== plan.key) throw new Error("frozen installation changed dependency inputs");
          await validateRequiredDependencies(buildingModules, plan.required, remaining);
          const executablePaths: string[] = [], links: CliLink[] = [];
          await dependencyPermissions(buildingModules, false, remaining, executablePaths, links);
          assertWriter();
          await fs.writeFile(path.join(build, "installed.json"), JSON.stringify({
            key: plan.key, executables: executablePaths.map(file => path.relative(buildingModules, file)),
            cliLinks: links.map(link => ({ ...link, file: path.relative(buildingModules, link.file) })),
          }));
          assertWriter();
          await options.beforeEffect?.("publish-cache");
          assertWriter();
          filesystem.renameSync(build, target);
        } finally {
          await dependencyPermissions(path.join(build, "node_modules"), true, assertFence);
          assertFence();
          await fs.rm(build, { recursive: true, force: true });
          assertFence();
          await fs.unlink(activeBuild);
        }
      }

      const validateForLink = async () => {
        enter("validation", existing ? "fenced graph" : "new graph seal");
        let checked = await inspectGraph(graph, plan, remaining, scan, true);
        if (!checked) throw new Error("incomplete shared dependency entry; preserve it for inspection");
        if (checked.reseal) {
          enter("commit", "permission repair");
          await options.beforeEffect?.("prepare-cache");
          assertWriter();
          checked.assertAnchors(false);
          // Invalidate before allowing any reader to see a repair in progress.
          if (!entryNow(graph.validation)?.isDirectory()) await fs.rm(graph.validation, { force: true });
          assertWriter();
          checked.assertAnchors(false);
          await repairDependencyPermissions(modules, remaining, assertWriter);
          enter("validation", "repaired graph seal");
          checked = await inspectGraph(graph, plan, remaining, scan, true);
          if (!checked || checked.reseal) throw new Error("shared dependency permissions could not be sealed");
        }
        const { assertAnchors } = checked;
        if (checked.reusable) return () => assertAnchors(true);

        enter("validation", "confirm graph inventory");
        await options.beforeEffect?.("prepare-cache");
        assertWriter();
        let saveStamp = true;
        if (entryNow(graph.validation)?.isDirectory()) {
          try { await fs.rmdir(graph.validation); }
          catch (error) {
            if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            saveStamp = false;
          }
        }
        // A directory occupying a payload record path can hold unrelated
        // contents. Revalidate without caching over that directory.
        const records = checked.records.filter(([file]) => !entryNow(file)?.isDirectory());
        if (saveStamp && records.length === checked.records.length) records.push([graph.validation, checked.fingerprint]);
        const temporary = (file: string) => file + ".next";
        let committedRecords = false;
        try {
          for (const [file, digest] of records) {
            assertWriter();
            await fs.rm(temporary(file), { force: true });
            assertWriter();
            const handle = await fs.open(temporary(file), "wx", 0o600);
            try {
              await handle.writeFile(digest);
              await handle.sync();
            } finally { await handle.close(); }
          }
          if ((await scan(modules, false)).metadata !== checked.metadata) {
            throw new Error("dependency graph changed during validation; retry setup");
          }
          assertWriter();
          assertAnchors(false);
          for (const [file] of records) filesystem.renameSync(temporary(file), file);
          const payloadEntry = entryNow(graph.payload);
          const contentEntry = entryNow(graph.content);
          committedRecords = true;
          return () => assertAnchors(false, payloadEntry, contentEntry);
        } finally {
          if (!committedRecords) for (const [file] of records) await fs.rm(temporary(file), { force: true });
        }
      };

      const previous = entryNow(local);
      if (previous?.isSymbolicLink() && linksDirectlyTo(local, modules) && await dependencyTarget(local) === modules) {
        const assertAnchors = await validateForLink();
        assertWriter();
        assertInputsNow(plan);
        if (!sameVersion(previous, entryNow(local)) || !linksDirectlyTo(local, modules)) {
          throw new Error("dependency link changed during validation; retry setup");
        }
        assertAnchors();
        assertWriter();
        return true;
      }

      enter("commit", "worktree link");
      assertWriter();
      await options.beforeEffect?.("link-cache");
      assertWriter();
      const linkRoot = await fs.mkdtemp(path.join(cwd, ".delegatus-dependencies-"));
      const link = path.join(linkRoot, "node_modules");
      let preserved: string | undefined;
      try {
        assertWriter();
        await fs.symlink(modules, link, process.platform === "win32" ? "junction" : "dir");
        const staged = entryNow(link);
        if (!staged?.isSymbolicLink() || Number(staged.nlink) !== 1 || !linksDirectlyTo(link, modules)
          || await dependencyTarget(link) !== modules) throw new Error("staged dependency link is invalid");
        const destination = readlinkSync(link);
        if (previous && !previous.isSymbolicLink()) {
          assertWriter();
          preserved = await fs.mkdtemp(path.join(cache, "preserved-"));
        }
        assertWriter();
        const assertAnchors = await validateForLink();
        enter("commit", "worktree link");
        await options.beforeEffect?.("link-cache");
        assertWriter();
        assertInputsNow(plan);
        if (!sameVersion(previous, entryNow(local)) || !sameVersion(staged, entryNow(link))) {
          throw new Error("dependency link changed before commit");
        }
        assertAnchors();
        assertWriter();
        const saved = preserved && path.join(preserved, "node_modules");
        try {
          if (saved) filesystem.renameSync(local, saved);
          filesystem.renameSync(link, local);
        } catch (error) {
          // A lost result is recoverable only from the exact link staged by
          // this call, under the original worktree and cache identities.
          assertFence();
          const observed = entryNow(local);
          if (!observed?.isSymbolicLink() || !sameEntry(staged, observed) || staged.mtimeNs !== observed.mtimeNs
            || staged.mode !== observed.mode || staged.nlink !== observed.nlink || readlinkSync(local) !== destination) {
            if (saved && !observed && sameEntry(previous, entryNow(saved))) filesystem.renameSync(saved, local);
            throw error;
          }
          assertAnchors();
          assertInputsNow(plan);
        }
        committed = true;
        return true;
      } finally {
        try {
          await fs.rm(linkRoot, { recursive: true, force: true });
          if (preserved && !entryNow(path.join(preserved, "node_modules"))) await fs.rmdir(preserved);
        } catch (error) {
          if (!committed) throw error;
          console.warn("dependency preparation: committed link; temporary directory cleanup failed");
        }
      }
    } finally {
      held?.release();
      try { await fd.close(); }
      catch (error) {
        if (!committed) throw error;
        console.warn("dependency preparation: committed link; writer descriptor close failed");
      }
    }
  } catch (error) {
    const failedPhase = phase;
    const failedOperation = operation;
    enter(phase, operation);
    const prefix = "stage environment: dependency preparation failed: ";
    const reason = error instanceof Error ? error.message : "unknown setup error";
    const evidence = (["wait", "validation", "commit"] as const).map(name => `${name} ${Math.round(elapsed[name])} ms`).join(", ");
    const message = `${prefix}${reason.startsWith(prefix) ? reason.slice(prefix.length) : reason} [${failedPhase}: ${failedOperation}, ${evidence}]`;
    if (!(error instanceof DependencyDeadline)) throw new Error(message, { cause: error });
    const failure = new DependencyDeadline(message, { cause: error });
    if (failedPhase === "validation") failure.retry = "validation";
    if (failedOperation === "permission repair") failure.retry = "permission repair";
    throw failure;
  }
}
