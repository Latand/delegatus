import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendBridgeReports, readBridgeChannel, bridgeReportComplete } from "@/lib/bridge/store";
import { stateDir } from "@/lib/configDir";
import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import { directoryProjectId, localRepositoryProjectId } from "@/lib/projects/identity";
import { projectSuccessionFor, recordProjectSuccessions } from "@/lib/projects/succession";
import { globalCache } from "@/lib/scanner/caches";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { waitForStateLock } from "@/lib/state/lockWait";
import { canonicalSensitiveText } from "@/lib/privacy/canonicalText";
import { knownProviderSecretOffset } from "@/lib/accounts/providerSecretRedaction";
import { AUTHORIZATION_HEADER, BEARER_TOKEN, COOKIE_HEADER, JWT_PATTERN, TOKEN_FAMILY_PATTERN } from "@/lib/view/compactText";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { realExec } from "@/lib/workflows/provision";

import { preflightPipelineRepo } from "./preflight";
import type { PipelineRepoPreflight, RepositoryInitialization } from "./types";

export const BASELINE_IGNORE_PATTERNS = [
  ".env*", "*.pem", "*.key", "*.p12", "*.pfx", "*.ppk", "*.jks", "*.keystore", "id_rsa*", "id_ed25519*",
  "*credential*", "*secret*", ".gitconfig*", ".npmrc*", ".yarnrc*", ".pypirc*", ".netrc*", ".git-credentials*", "auth.json", "token.json", "tokens.json",
  ".aws/", ".docker/", ".terraform/", "*.tfstate*", ".ssh/", ".gnupg/", ".azure/", ".kube/", ".config/",
  "node_modules/", ".next/", "dist/", "build/", "out/", "coverage/",
  ".delegatus-initialization*", ".cache/", ".venv/", "venv/", "__pycache__/", ".DS_Store",
] as const;
const OMIT_NAME = /^(?:\.env.*|.*\.(?:pem|key|p12|pfx|ppk|jks|keystore)|id_(?:rsa|ed25519).*|.*(?:credential|secret).*|\.(?:(?:gitconfig|npmrc|yarnrc|pypirc|netrc|git-credentials).*|aws|docker|terraform|ssh|gnupg|azure|kube|config)|(?:auth|tokens?)\.json|.*\.tfstate.*|\.delegatus-initialization.*|node_modules|\.next|dist|build|out|coverage|\.cache|\.?venv|__pycache__|\.DS_Store)$/i;
const SECRET_ASSIGNMENT = /(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|bearer|secret|token)\b\s*["']?\s*[:=]\s*["']?[^\s"'\x00]+/i;
const SECRET_PATTERNS = [AUTHORIZATION_HEADER, BEARER_TOKEN, COOKIE_HEADER, JWT_PATTERN, TOKEN_FAMILY_PATTERN]
  .map(pattern => new RegExp(pattern === AUTHORIZATION_HEADER || pattern === COOKIE_HEADER
    ? pattern.source.replaceAll("\\s", "[\\t ]") : pattern.source, pattern.flags.replace("g", "")));
const MARKER = "delegatus-initialization.json";
const INITIALIZED_MESSAGE = "Delegatus initialized a local Git repository on main and created its first baseline commit.";
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
// Refusal needs a boolean; avoid the display redactor's per-character decoded
// copies and unbounded assignment-prefix backtracking on source files.
const containsSecret = (value: string) => SECRET_ASSIGNMENT.test(value)
  || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
  || SECRET_PATTERNS.some(pattern => pattern.test(value)) || knownProviderSecretOffset(value) !== -1;
function secret(value: string): boolean {
  if (containsSecret(value)) return true;
  const decoded = canonicalSensitiveText(value, true);
  return decoded.error || decoded.text !== value && containsSecret(decoded.text);
}
const label = (value: string) => secret(value) ? "[private path]" : value;
const limit = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid repository initialization limit");
  return value;
};

async function canonical(value: string): Promise<string> {
  try { return await fs.realpath(value); } catch (error) { if (missing(error)) return path.resolve(value); throw error; }
}

/** This guard runs on real paths before any project mutation. */
async function safeRoot(candidate: string): Promise<void> {
  const homes = [os.homedir(), os.userInfo().homedir, process.env.HOME].filter((value): value is string => !!value);
  for (const home of homes) if (inside(await canonical(home), candidate)) throw new Error("initialization refused for the home directory or its ancestors");
  const configs = [process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")];
  for (const state of [stateDir(), ...configs.flatMap(config => ["delegatus", "agent-log-viewer"].map(name => path.join(config, name, "state")))]) {
    const real = await canonical(state);
    if (inside(candidate, real) || inside(real, candidate)) throw new Error("initialization refused for the Delegatus state directory");
  }
  const system = ["bin", "sbin", "etc", "usr", "lib", "lib64", "dev", "proc", "sys", "run", "boot", "opt", "System", "Library", "Applications", "Windows", "Program Files"];
  const root = path.parse(candidate).root;
  if (candidate === root || system.some(name => inside(candidate, path.join(root, name)))
    || ["tmp", "var", "home", "Users", "root", "mnt", "media", "srv"].some(name => candidate === path.join(root, name))
    || (inside(candidate, path.join(root, "var")) && !inside(candidate, path.join(root, "var", "tmp")))) {
    throw new Error("initialization refused for a system path");
  }
}

type Snapshot = { relative: string; data: Buffer; mode: number; dev: number; ino: number; mtimeMs: number; size: number };
async function readFile(root: string, relative: string, maxBytes = limit("LLV_PIPELINE_INIT_MAX_FILE_BYTES", 2 * 1024 * 1024)): Promise<Snapshot> {
  if (await fs.realpath(path.dirname(path.join(root, relative))) !== path.dirname(path.join(root, relative))) throw new Error("project directory identity changed during initialization; retry");
  const file = await fs.open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("initialization refused for a linked or special file");
    if (stat.size > maxBytes) throw new Error("project changed while preparing its initial commit; retry");
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("project changed while preparing its initial commit; retry");
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("project changed while preparing its initial commit; retry");
    return { relative, data: data.subarray(0, stat.size), mode: stat.mode, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } finally { await file.close(); }
}

async function snapshot(root: string) {
  const directories: { relative: string; ino: number; dev: number }[] = [];
  const maxFiles = limit("LLV_PIPELINE_INIT_MAX_FILES", 2000);
  const maxBytes = limit("LLV_PIPELINE_INIT_MAX_BYTES", 32 * 1024 * 1024);
  const maxFileBytes = limit("LLV_PIPELINE_INIT_MAX_FILE_BYTES", 2 * 1024 * 1024);
  const files: Snapshot[] = [], ignored: string[] = [];
  let count = 0, bytes = 0, pathBytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const stat = await fs.lstat(path.join(root, directory));
    if (!stat.isDirectory()) throw new Error("project directory identity changed during initialization; retry");
    directories.push({ relative: directory, ino: stat.ino, dev: stat.dev });
    const entries = await fs.opendir(path.join(root, directory));
    for await (const entry of entries) {
      if (++count > maxFiles) throw new Error("project exceeds the initial commit file-count bound");
      const relative = directory ? directory + "/" + entry.name : entry.name;
      if (/[\x00-\x1f\x7f]/.test(relative)) throw new Error("project contains a path with control characters");
      pathBytes += Buffer.byteLength(relative);
      if (pathBytes > 4_000) throw new Error("project exceeds the initial commit path-list bound");
      if (secret(relative)) throw new Error("project contains a path matching secret patterns; initialization refused");
      if (entry.name === ".gitignore" && !entry.isFile()) throw new Error("existing gitignore cannot be merged safely; initialization refused");
      if (OMIT_NAME.test(entry.name)) { ignored.push(relative); continue; }
      if (entry.isDirectory()) {
        try { await fs.lstat(path.join(root, relative, ".git")); ignored.push(relative); continue; }
        catch (error) { if (!missing(error)) throw error; }
        await walk(relative);
      } else if (entry.isFile()) {
        const stat = await fs.lstat(path.join(root, relative));
        if (entry.name === ".gitignore" && (stat.size > maxFileBytes || stat.nlink !== 1)) throw new Error("existing gitignore cannot be merged safely; initialization refused");
        if (stat.size > maxFileBytes || stat.nlink !== 1) { ignored.push(relative); continue; }
        if (bytes + stat.size > maxBytes) throw new Error("project exceeds the initial commit size bound");
        const file = await readFile(root, relative, Math.min(maxFileBytes, maxBytes - bytes));
        bytes += file.size;
        if (file.data.length > maxFileBytes) throw new Error("project changed while preparing its initial commit; retry");
        if (path.basename(relative) === ".gitignore" && (file.data.includes(0) || !Buffer.from(file.data.toString("utf8")).equals(file.data))) throw new Error("existing gitignore has an unsupported encoding; initialization refused");
        const bigEndian = file.data.length % 2 === 0 ? Buffer.from(file.data).swap16().toString("utf16le") : "";
        if (secret(file.data.toString("utf8")) || secret(file.data.toString("utf16le")) || secret(bigEndian)) {
          if (entry.name === ".gitignore") throw new Error("existing gitignore matches secret patterns; initialization refused");
          ignored.push(relative);
        } else files.push(file);
      } else ignored.push(relative);
    }
  };
  await walk("");
  return { directories, files: files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0), ignored: ignored.sort() };
}

function gitEnvironment(): Partial<NodeJS.ProcessEnv> {
  const env: Partial<NodeJS.ProcessEnv> = {};
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) env[key] = undefined;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", ...controllerCommitIdentityEnv() };
}
async function git(cwd: string, args: string[]) {
  const result = await realExec("git", args, cwd, gitEnvironment(), { timeoutMs: 15_000, maxOutputBytes: 256_000 });
  if (result.code !== 0) throw new Error("local repository preparation failed; no file contents were reported");
  return result.stdout.trim();
}
function ignoreLiteral(relative: string) {
  return "/" + relative.replace(/[\\*?\[\]#! ]/g, "\\$&");
}

function baselineIgnore(ignored: readonly string[], directory = "") {
  const prefix = directory ? directory + "/" : "";
  const paths = ignored.filter(relative => relative.startsWith(prefix)).map(relative => ignoreLiteral(relative.slice(prefix.length)));
  return "\n# Delegatus baseline exclusions\n" + BASELINE_IGNORE_PATTERNS.join("\n") + "\n" + paths.join("\n") + "\n";
}

function completeReport(initialization: RepositoryInitialization) {
  return { summary: "Delegatus створив перший локальний коміт.", sections: [
    { heading: "Файли в коміті", items: initialization.committedFiles.map(label) },
    { heading: "Виключені шляхи", items: initialization.ignoredPaths.map(label) },
    { heading: "Стандартні виключення", items: initialization.defaultIgnorePatterns },
  ] };
}

async function appendIgnore(root: string, original: Snapshot, text: string) {
  const file = await fs.open(path.join(root, original.relative), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== original.dev || stat.ino !== original.ino || stat.size !== original.size || stat.mtimeMs !== original.mtimeMs) throw new Error("project gitignore changed during initialization; retry");
    await file.writeFile(text);
  } finally { await file.close(); }
}

async function report(root: string, initialization: RepositoryInitialization) {
  return waitForStateLock("pipelines.repository-initialization", () => {
    globalCache("project-info-cwd-v2").delete(root);
    recordProjectSuccessions([projectSuccessionFor(directoryProjectId(root), root)]);
    // Channels must be initialized before the report's SQL transaction opens.
    readBridgeChannel();
    appendBridgeReports([{
      key: "repository-initialized:" + initialization.commit, project: initialization.project,
      class: "status", at: new Date().toISOString(),
      body: "Delegatus створив локальний Git-репозиторій, гілку main і перший коміт. Перелік файлів і виключень — у повному звіті. Віддалений репозиторій можна додати за вашим запитом.",
      complete: completeReport(initialization),
    }]);
  });
}

export async function readRepositoryInitialization(root: string): Promise<RepositoryInitialization | undefined> {
  try {
    if (!(await fs.lstat(path.join(root, ".git"))).isDirectory()) return;
    const marker = await readFile(root, ".git/" + MARKER, 16_000);
    if (marker.size > 16_000) return;
    const value = JSON.parse(marker.data.toString("utf8")) as RepositoryInitialization;
    if (!/^[a-f0-9]{40}$/.test(value.commit) || value.project !== localRepositoryProjectId(root)
      || ![value.committedFiles, value.ignoredPaths, value.defaultIgnorePatterns].every(items => Array.isArray(items) && items.every(item => typeof item === "string" && !secret(item)))) return;
    bridgeReportComplete(completeReport(value), true);
    return { message: INITIALIZED_MESSAGE, project: value.project, commit: value.commit, committedFiles: value.committedFiles, ignoredPaths: value.ignoredPaths, defaultIgnorePatterns: value.defaultIgnorePatterns };
  } catch (error) { if (missing(error)) return; throw new Error("project initialization receipt cannot be read safely"); }
}

/** Picker checks are read-only. Only pipeline creation installs a ready commit. */
export async function preparePipelineRepository(rawPath: string, initialize = true): Promise<PipelineRepoPreflight> {
  return withViewerOperation("pipelines.repository-initialization", async () => {
    const admission = await preflightPipelineRepo(rawPath);
    if (admission.ok) {
      const previous = initialize ? await readRepositoryInitialization(admission.repoDir) : undefined;
      if (previous) { await report(admission.repoDir, previous); return { ...admission, repositoryInitialization: previous }; }
      return admission;
    }
    if (admission.code !== "not_git") return admission;
    const candidate = await fs.realpath(admission.path);
    let temporary: string | undefined;
    let directory: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      await safeRoot(candidate);
      try {
        await fs.access(candidate, constants.W_OK | constants.X_OK);
        await fs.access(path.dirname(candidate), constants.W_OK | constants.X_OK);
      } catch { throw new Error("project directory or its worktree parent is not writable"); }
      directory = process.platform === "linux" ? await fs.open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : undefined;
      const initialRoot = await fs.lstat(candidate);
      const stableRoot = directory ? "/proc/self/fd/" + directory.fd : candidate;
      const assertRoot = async () => {
        const current = await fs.lstat(candidate);
        const held = directory ? await directory.stat() : initialRoot;
        if (!current.isDirectory() || current.dev !== initialRoot.dev || current.ino !== initialRoot.ino || held.dev !== initialRoot.dev || held.ino !== initialRoot.ino) throw new Error("project directory identity changed during initialization; retry");
      };
      await assertRoot();
      try { await fs.lstat(path.join(candidate, ".git")); throw new Error("Git metadata already exists; initialization refused"); }
      catch (error) { if (!missing(error)) throw error; }
      try {
        const ignore = await fs.lstat(path.join(candidate, ".gitignore"));
        if (!ignore.isFile() || ignore.nlink !== 1 || ignore.size > limit("LLV_PIPELINE_INIT_MAX_FILE_BYTES", 2 * 1024 * 1024)) throw new Error("existing gitignore cannot be merged safely; initialization refused");
      } catch (error) { if (!missing(error)) throw error; }
      const data = await snapshot(candidate);
      if (!initialize) return { ok: true, repoDir: candidate, gitCommonDir: path.join(candidate, ".git"), worktreeParent: path.dirname(candidate) };
      temporary = await fs.mkdtemp(path.join(path.dirname(candidate), ".delegatus-initial-repository-"));
      await git(temporary, ["init", "--initial-branch=main", "--template="]);
      const originalIgnore = data.files.find(file => file.relative === ".gitignore");
      const prefix = originalIgnore?.data.toString("utf8") ?? "";
      const appended = baselineIgnore(data.ignored);
      const ignore = prefix + appended;
      if (secret(ignore)) throw new Error("existing gitignore cannot be merged safely; initialization refused");
      // Respect the folder's existing ignore rules as well as the safety policy.
      for (const file of data.files.filter(file => path.basename(file.relative) === ".gitignore")) {
        const destination = path.join(temporary, file.relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.data, { mode: file.mode & 0o777 });
      }
      const ignored = data.files.length ? await realExec("git", ["-c", "core.quotePath=false", "check-ignore", "--no-index", "--", ...data.files.map(file => "./" + file.relative)], temporary, gitEnvironment()) : { code: 1, stdout: "" };
      if (ignored.code !== 0 && ignored.code !== 1) throw new Error("local repository ignore check failed");
      const userIgnored = new Set(ignored.stdout.split("\n").filter(Boolean).map(line => (line.startsWith('"') ? JSON.parse(line) as string : line).replace(/^\.\//, "")));
      if (data.files.some(file => file.relative !== ".gitignore" && path.basename(file.relative) === ".gitignore" && userIgnored.has(file.relative))) throw new Error("existing gitignore is excluded by parent rules and cannot be merged safely; initialization refused");
      data.ignored.push(...userIgnored);
      const selected = data.files.filter(file => !userIgnored.has(file.relative) || file.relative === ".gitignore");
      for (const file of selected) {
        if (file.relative === ".gitignore") continue;
        const destination = path.join(temporary, file.relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.data, { mode: file.mode & 0o777 });
        if (path.basename(file.relative) === ".gitignore") await fs.appendFile(destination, baselineIgnore(data.ignored, path.posix.dirname(file.relative)));
      }
      await fs.writeFile(path.join(temporary, ".gitignore"), ignore, { mode: originalIgnore ? originalIgnore.mode & 0o777 : 0o644 });
      const committedFiles = [".gitignore", ...selected.filter(file => file.relative !== ".gitignore").map(file => file.relative)].sort();
      const sizes = [Buffer.byteLength(ignore), ...selected.filter(file => file.relative !== ".gitignore").map(file =>
        file.size + (path.basename(file.relative) === ".gitignore" ? Buffer.byteLength(baselineIgnore(data.ignored, path.posix.dirname(file.relative))) : 0))];
      if (committedFiles.length > limit("LLV_PIPELINE_INIT_MAX_FILES", 2000)) throw new Error("project exceeds the initial commit file-count bound");
      if (sizes.some(size => size > limit("LLV_PIPELINE_INIT_MAX_FILE_BYTES", 2 * 1024 * 1024))) throw new Error("project baseline exceeds the initial commit per-file size bound");
      if (sizes.reduce((total, size) => total + size, 0) > limit("LLV_PIPELINE_INIT_MAX_BYTES", 32 * 1024 * 1024)) throw new Error("project exceeds the initial commit size bound");
      // Hash the inspected bytes directly. Repository attributes must not transform
      // them or run filters while preparing the first commit.
      const hashes = (await git(temporary, ["hash-object", "--no-filters", "-w", "--", ...committedFiles])).split("\n");
      if (hashes.length !== committedFiles.length || hashes.some(hash => !/^[a-f0-9]{40}$/.test(hash))) throw new Error("local repository snapshot hashing failed");
      const modes = new Map(selected.map(file => [file.relative, file.mode]));
      await git(temporary, ["update-index", "--add", ...committedFiles.flatMap((file, index) =>
        ["--cacheinfo", ((modes.get(file) ?? 0o644) & 0o111 ? "100755" : "100644") + "," + hashes[index] + "," + file])]);
      await git(temporary, ["-c", "commit.gpgsign=false", "commit", "-m", "Initialize project with a safe Delegatus baseline"]);
      const commit = await git(temporary, ["rev-parse", "HEAD"]);
      const project = localRepositoryProjectId(candidate);
      if (!project) throw new Error("local repository identity could not be resolved");
      const initialization: RepositoryInitialization = {
        message: INITIALIZED_MESSAGE, project, commit, committedFiles, ignoredPaths: [...new Set(data.ignored)].sort().map(label), defaultIgnorePatterns: [...BASELINE_IGNORE_PATTERNS],
      };
      try { bridgeReportComplete(completeReport(initialization), true); }
      catch { throw new Error("project exceeds the initial commit path-list bound"); }
      const prepared = temporary;
      return await withFileTransaction(path.join(stableRoot, ".delegatus-initialization"), "project initialization is already in progress; retry", async () => {
        await fs.writeFile(path.join(prepared, ".git", MARKER), JSON.stringify(initialization), { flag: "wx" });
        // A fresh repository probe and file identities fence changes during preparation.
        const current = await preflightPipelineRepo(candidate);
        if (current.ok) return preparePipelineRepository(candidate);
        if (current.code !== "not_git") throw new Error("repository identity changed during initialization; retry");
        await safeRoot(candidate);
        for (const directory of data.directories) {
          const current = await fs.lstat(path.join(candidate, directory.relative));
          if (!current.isDirectory() || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error("project directory identity changed during initialization; retry");
        }
        for (const file of data.files) {
          const current = await fs.lstat(path.join(candidate, file.relative));
          if (current.dev !== file.dev || current.ino !== file.ino || current.mtimeMs !== file.mtimeMs || current.size !== file.size) throw new Error("project changed during initialization; retry");
        }
        const finalProbe = await preflightPipelineRepo(candidate);
        if (finalProbe.ok || finalProbe.code !== "not_git") throw new Error("repository identity changed during initialization; retry");
        // An existing .git entry of any kind belongs to somebody else.
        try { await fs.lstat(path.join(candidate, ".git")); throw new Error("Git metadata appeared during initialization; retry"); }
        catch (error) { if (!missing(error)) throw error; }
        await assertRoot();
        for (const file of selected.filter(file => file.relative !== ".gitignore" && path.basename(file.relative) === ".gitignore")) {
          await appendIgnore(stableRoot, file, baselineIgnore(data.ignored, path.posix.dirname(file.relative)));
        }
        if (originalIgnore) await appendIgnore(stableRoot, originalIgnore, appended);
        else await fs.writeFile(path.join(stableRoot, ".gitignore"), ignore, { flag: "wx" });
        await assertRoot();
        await fs.rename(path.join(prepared, ".git"), path.join(stableRoot, ".git"));
        await assertRoot();
        await report(candidate, initialization);
        const ready = await preflightPipelineRepo(candidate);
        return ready.ok ? { ...ready, repositoryInitialization: initialization } : ready;
      });
    } catch (error) {
      return { ok: false, code: "initialization_refused", path: candidate,
        detail: error instanceof Error && /^(?:initialization refused|project |existing gitignore|invalid repository|local repository|repository identity|Git metadata)/.test(error.message)
          ? error.message : "repository initialization refused; the folder could not be prepared safely" };
    } finally {
      await directory?.close();
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
  });
}
