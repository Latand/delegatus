import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { descriptorPlace, homeRoot, isPrivateLocalPath, underRoot } from "@/lib/artifact/localFile";
import { knownProjectFileRootsForProject } from "@/lib/scanner/projectDirectories";
import { realExec } from "@/lib/workflows/provision";
import { ENV_KEY, scanEnvFile } from "./envFile";
import { SecretRequestError, secretError, type FileIdentity, type ResolvedSecretDestination, type SecretDestination } from "./types";

export const UNSAFE_TEXT = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
const FILE_LIMIT = 64 * 1024;
const ENV_NAME = /^(?:\.env(?:\..+)?|.+\.env)$/u;
type FileStats = Awaited<ReturnType<typeof stat>>;
type AllowedRoot = { lexical: string; real: string; identity: FileIdentity };
const stat = (filename: string) => fs.lstat(filename, { bigint: true });

export function fileIdentity(stats: { dev: bigint; ino: bigint }): FileIdentity {
  return { device: String(stats.dev), inode: String(stats.ino) };
}

export function sameInode(stats: { dev: bigint; ino: bigint }, identity: FileIdentity): boolean {
  return String(stats.dev) === identity.device && String(stats.ino) === identity.inode;
}

export function sameEntry(left: FileStats | null, right: FileStats | null): boolean {
  return left === null || right === null ? left === right
    : left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.ctimeNs === right.ctimeNs;
}

export function fsCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export async function lstatIfPresent(filename: string): Promise<FileStats | null> {
  try { return await stat(filename); }
  catch (error) {
    if (fsCode(error) === "ENOENT") return null;
    throw error;
  }
}

function checkName(filename: string) {
  if (UNSAFE_TEXT.test(filename) || filename.split(path.sep).some(part => part.toLowerCase() === ".git")) {
    throw new SecretRequestError("secret_destination_name");
  }
}

function checkPrivate(filename: string) {
  if (isPrivateLocalPath(filename)) throw new SecretRequestError("secret_destination_private");
}

function safeRoot(root: string, homes: string[]): boolean {
  return !homes.some(home => underRoot(home, root)) && root !== path.parse(root).root && !isPrivateLocalPath(root);
}

// Extra roots are resolved at configuration read. Cache the one current
// setting and home across requests, and recheck private areas at admission.
let configuredRoots: { key: string; roots: Promise<AllowedRoot[]> } | undefined;
async function rootsAt(paths: string[], homes: string[]): Promise<AllowedRoot[]> {
  const roots = await Promise.all([...new Set(paths)].filter(root => path.isAbsolute(root)).map(async raw => {
    const lexical = path.resolve(raw);
    if (!safeRoot(lexical, homes)) return null;
    const named = await lstatIfPresent(lexical).catch(() => null);
    if (!named?.isDirectory() || named.isSymbolicLink()) return null;
    const real = await fs.realpath(lexical).catch(() => null);
    if (!real || !safeRoot(real, homes)) return null;
    const stats = await stat(real).catch(() => null);
    if (!stats?.isDirectory()) return null;
    return { lexical, real, identity: fileIdentity(stats) };
  }));
  return roots.filter((root): root is AllowedRoot => root !== null);
}

async function allowedRoots(project: string) {
  const home = path.resolve(homeRoot());
  const realHome = await fs.realpath(home).catch(() => home);
  const homes = [home, realHome];
  const setting = process.env.LLV_SECRET_ROOTS ?? "";
  const key = JSON.stringify([setting, homes]);
  if (configuredRoots?.key !== key) configuredRoots = { key, roots: rootsAt(setting.split(":").filter(Boolean), homes) };
  const extras = await configuredRoots.roots;
  const projects = await rootsAt(knownProjectFileRootsForProject(project), homes);
  return [...projects, ...extras].filter(root => safeRoot(root.lexical, homes) && safeRoot(root.real, homes));
}

export async function confirmPlace(handle: FileHandle, expected: string): Promise<void> {
  const place = await descriptorPlace(handle, expected);
  if (place === null) throw new SecretRequestError("secret_platform_unsupported");
  if (!place) throw new SecretRequestError("secret_destination_link");
}

export async function gitStatus(parent: string, name: string): Promise<ResolvedSecretDestination["git"]> {
  const env: Partial<NodeJS.ProcessEnv> = {
    LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
  };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  }
  const deadline = performance.now() + 15_000;
  const git = (args: string[]) => {
    const timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) throw new SecretRequestError("secret_destination_unavailable");
    return realExec("git", ["-c", "core.fsmonitor=false", "-c", "core.excludesFile=/dev/null", ...args],
      parent, env, { timeoutMs, maxOutputBytes: 4096 });
  };

  const probe = await git(["rev-parse", "--is-inside-work-tree"]);
  if (probe.code === 128 && probe.stderr.startsWith("fatal: not a git repository (or any of the parent directories): .git")) {
    return "outside-repository";
  }
  if (probe.code !== 0 || probe.stdout.trim() !== "true") throw new SecretRequestError("secret_destination_unavailable");

  // A nested repository can hide an outer index entry. Walk the lexical
  // ancestors and check each distinct worktree root for the destination.
  const destination = path.resolve(parent, name);
  const roots = new Set<string>();
  for (let ancestor = path.resolve(parent); ; ancestor = path.dirname(ancestor)) {
    const resolved = await git(["-C", ancestor, "rev-parse", "--show-toplevel"]);
    if (resolved.code === 0) roots.add(path.resolve(resolved.stdout.trim()));
    else if (resolved.code !== 128) throw new SecretRequestError("secret_destination_unavailable");
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
  }
  if (!roots.size) throw new SecretRequestError("secret_destination_unavailable");
  for (const root of roots) {
    const relative = path.relative(root, destination).split(path.sep).join("/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
    // A repository setting cannot rule out case aliases on a Darwin volume.
    let caseInsensitive = process.platform === "darwin";
    if (!caseInsensitive) {
      const configured = await git(["-C", root, "config", "--type=bool", "--get", "core.ignorecase"]);
      if (configured.code !== 0 && configured.code !== 1) throw new SecretRequestError("secret_destination_unavailable");
      caseInsensitive = configured.stdout.trim() === "true";
    }
    const tracked = await git(["-C", root, "ls-files", "--error-unmatch", "--", `:(literal${caseInsensitive ? ",icase" : ""})${relative}`]);
    if (tracked.code === 0) throw new SecretRequestError("secret_destination_tracked");
    if (tracked.code !== 1) throw new SecretRequestError("secret_destination_unavailable");
  }

  // Replacing the file that supplies the ignore rule could drop that rule.
  if (name.toLowerCase() === ".gitignore") throw new SecretRequestError("secret_destination_not_ignored");
  const ignored = await git(["check-ignore", "-q", "--", "./" + name]);
  if (ignored.code === 1) throw new SecretRequestError("secret_destination_not_ignored");
  if (ignored.code !== 0) throw new SecretRequestError("secret_destination_unavailable");
  return "ignored";
}

export async function secretStagingDirectory(destination: ResolvedSecretDestination, parent: string): Promise<string> {
  if (destination.git === "outside-repository") {
    return path.join(destination.authorizedRoot.path, ".delegatus-secret-staging");
  }
  const env: Partial<NodeJS.ProcessEnv> = {
    LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
  };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  }
  const result = await realExec("git", ["-c", "core.fsmonitor=false", "rev-parse", "--absolute-git-dir"], parent,
    env, { timeoutMs: 15_000, maxOutputBytes: 4096 });
  const directory = result.stdout.trim();
  if (result.code !== 0 || !path.isAbsolute(directory)) throw new SecretRequestError("secret_destination_unavailable");
  return path.join(await fs.realpath(directory), "delegatus-secret-staging");
}

export function destinationRevision(destination: ResolvedSecretDestination): string {
  return createHash("sha256").update(JSON.stringify([
    destination.path, destination.kind, destination.kind === "env" ? destination.key : null,
    destination.effect, destination.git, destination.authorizedRoot,
  ])).digest("hex");
}

export async function readExistingEnv(filename: string, expected: FileStats): Promise<Buffer> {
  let content: Buffer | undefined;
  const handle = await fs.open(filename, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  try {
    await confirmPlace(handle, filename);
    const before = await handle.stat({ bigint: true });
    if (!sameEntry(before, expected)) throw new SecretRequestError("secret_destination_changed");
    content = Buffer.alloc(Number(before.size));
    let ptr = 0;
    while (ptr < content.length) {
      const { bytesRead } = await handle.read(content, ptr, content.length - ptr, ptr);
      if (bytesRead === 0) throw new SecretRequestError("secret_destination_changed");
      ptr += bytesRead;
    }
    if (!sameEntry(await handle.stat({ bigint: true }), before)) throw new SecretRequestError("secret_destination_changed");
    await handle.close();
    return content;
  } catch (error) {
    content?.fill(0);
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function inspectDestination(project: string, target: SecretDestination,
  authorizedRoot?: ResolvedSecretDestination["authorizedRoot"]) {
  try {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new SecretRequestError("secret_platform_unsupported");
    checkName(target.path);
    const written = target.path.startsWith("~/") ? homeRoot() + target.path.slice(1) : target.path;
    if (!path.isAbsolute(written)) throw new SecretRequestError("secret_destination_outside_roots");
    const filename = path.resolve(written);
    const roots = await allowedRoots(project);
    const lexicalRoots = roots.filter(root => filename !== root.lexical && underRoot(filename, root.lexical));
    if (!lexicalRoots.length) {
      throw new SecretRequestError("secret_destination_outside_roots");
    }
    if (authorizedRoot && !roots.some(root => root.real === authorizedRoot.path
      && root.identity.device === authorizedRoot.identity.device && root.identity.inode === authorizedRoot.identity.inode)) {
      throw new SecretRequestError("secret_destination_changed");
    }
    checkPrivate(filename);
    const name = path.basename(filename);
    if (target.kind === "env") {
      if (!ENV_NAME.test(name)) throw new SecretRequestError("secret_env_file_name");
      if (!ENV_KEY.test(target.key)) throw new SecretRequestError("secret_env_key_invalid");
    }
    const parentPath = path.dirname(filename);
    let realParent: string;
    try { realParent = await fs.realpath(parentPath); }
    catch (error) {
      if (fsCode(error) === "ENOENT" || fsCode(error) === "ENOTDIR") {
        throw new SecretRequestError(process.env.LLV_DOCKER_NSENTER_SHIMS === "1" && !underRoot(filename, homeRoot())
          ? "secret_destination_unavailable" : "secret_parent_missing");
      }
      if (fsCode(error) === "ELOOP") throw new SecretRequestError("secret_destination_link");
      throw error;
    }
    const real = path.join(realParent, name);
    checkName(real);
    // A lexical path admitted by one root can resolve through a parent link
    // into another independently authorized root. Keep the lexical admission
    // above, then bind the resolved destination to the root that contains it.
    const matchingRoot = roots.find(root => real !== root.real && underRoot(real, root.real)
      && (!authorizedRoot || (root.real === authorizedRoot.path
        && root.identity.device === authorizedRoot.identity.device && root.identity.inode === authorizedRoot.identity.inode)));
    if (!matchingRoot) throw new SecretRequestError("secret_destination_link");
    checkPrivate(real);
    const parent = await stat(realParent);
    if (!parent.isDirectory()) throw new SecretRequestError("secret_parent_missing");
    const existing = await lstatIfPresent(real);
    if (existing?.isSymbolicLink()) throw new SecretRequestError("secret_destination_link");
    if (existing && (!existing.isFile() || Number(existing.uid) !== process.geteuid?.()
      || existing.nlink !== BigInt(1) || (existing.mode & BigInt(0o111)) !== BigInt(0) || existing.size > FILE_LIMIT)) {
      throw new SecretRequestError("secret_destination_not_replaceable");
    }
    if (existing && target.kind === "file" && !target.replace) throw new SecretRequestError("secret_destination_exists");

    const git = await gitStatus(realParent, name);
    const previous = existing ? { size: Number(existing.size), modifiedAt: Number(existing.mtimeMs) } : undefined;
    const base = { path: real, git, authorizedRoot: { path: matchingRoot.real, identity: matchingRoot.identity }, ...(previous && { previous }) };
    let destination: ResolvedSecretDestination;
    if (target.kind === "env") {
      const bytes = existing ? await readExistingEnv(real, existing) : Buffer.alloc(0);
      try {
        destination = { ...base, kind: "env", key: target.key, effect: scanEnvFile(bytes, target.key).definition ? "env-replace" : "env-add" };
      } finally { bytes.fill(0); }
    } else {
      destination = { ...base, kind: "file", effect: existing ? "file-replace" : "file-create" };
    }
    if (!(await fs.realpath(parentPath) === realParent) || !sameInode(await stat(realParent), fileIdentity(parent))
      || !sameEntry(await lstatIfPresent(real), existing)) {
      throw new SecretRequestError("secret_destination_changed");
    }
    const currentRoot = await lstatIfPresent(matchingRoot.lexical);
    if (!currentRoot?.isDirectory() || currentRoot.isSymbolicLink()
      || !sameInode(currentRoot, matchingRoot.identity)
      || await fs.realpath(matchingRoot.lexical) !== matchingRoot.real) {
      throw new SecretRequestError("secret_destination_changed");
    }
    return { destination, parent: fileIdentity(parent), existing };
  } catch (error) {
    throw secretError(error, fsCode(error) === "ELOOP" ? "secret_destination_link" : "secret_destination_unavailable");
  }
}

export async function resolveSecretDestination(project: string, target: SecretDestination) {
  const { destination } = await inspectDestination(project, target);
  return { destination, revision: destinationRevision(destination) };
}
