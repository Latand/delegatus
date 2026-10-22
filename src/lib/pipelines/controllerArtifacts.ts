import fs from "node:fs";
import path from "node:path";
import { realExec, type ExecPort, type ExecResult } from "@/lib/workflows/provision";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

const INSPECTION_DEADLINE_MS = 30_000;
const PROBE_ATTEMPTS = 3;
const transientSpawnErrors = new Set(["EAGAIN", "EINTR", "EBUSY", "ENOMEM", "EMFILE", "ENFILE", "ETIMEDOUT"]);
interface ProbeTiming { now(): number; sleep(ms: number): Promise<void> }
const probeTiming: ProbeTiming = {
  now: () => performance.now(),
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
};

function gitRefusal(message: string, result: ExecResult): Error {
  const cause = [result.signal ? `signal ${result.signal}` : result.code === null ? "no exit status" : `exit code ${result.code}`,
    result.stderr.trim()].filter(Boolean).join(": ");
  return new Error(`${message}: ${cause}`);
}

export const CONTROLLER_ARTIFACT_DIRECTORY = ".artifacts/pipeline-stage-inputs";
export const CONTROLLER_ARTIFACT_PATHSPEC = `:(exclude,top)${CONTROLLER_ARTIFACT_DIRECTORY}`;
export const CONTROLLER_ARTIFACT_GIT_PATHS = [
  `:(top)${CONTROLLER_ARTIFACT_DIRECTORY}`,
  `:(top,glob)**/${CONTROLLER_ARTIFACT_DIRECTORY}`,
  `:(top,glob)**/${CONTROLLER_ARTIFACT_DIRECTORY}/**`,
] as const;
export const CONTROLLER_ARTIFACT_PATHSPECS = [
  CONTROLLER_ARTIFACT_PATHSPEC,
  `:(exclude,top,glob)**/${CONTROLLER_ARTIFACT_DIRECTORY}`,
  `:(exclude,top,glob)**/${CONTROLLER_ARTIFACT_DIRECTORY}/**`,
] as const;

/** Store new handoffs beneath an untracked, self-ignored child directory.
 * Its ignore file cannot be restored from HEAD: index protection refuses any
 * committed namespace entries except the legacy root ignore file. Restoring
 * that tracked file therefore cannot expose a handoff to ordinary Git add. */
export async function prepareControllerArtifactDirectory(worktreeDir: string, exec: ExecPort = realExec, timing: ProbeTiming = probeTiming): Promise<string> {
  const root = path.resolve(worktreeDir);
  const artifactRoot = path.join(root, ".artifacts");
  const directory = path.join(artifactRoot, "pipeline-stage-inputs");
  const privateDirectory = path.join(directory, "private");

  /* These names are inside a repository controlled by the agent being
     launched. Never let mkdir or a later file write follow a repository
     symlink into another path. Check existing components before creating
     each directory, then create one level at a time and recheck races. */
  assertDirectoryOrMissing(artifactRoot);
  assertDirectoryOrMissing(directory);
  assertDirectoryOrMissing(privateDirectory);
  await protectControllerArtifactIndex(root, exec, timing);
  ensureDirectory(artifactRoot);
  ensureDirectory(directory);

  ensureCatchAllIgnore(path.join(directory, ".gitignore"));
  ensureDirectory(privateDirectory);
  ensureCatchAllIgnore(path.join(privateDirectory, ".gitignore"));
  return privateDirectory;
}

/** A small launch can inherit old handoffs. Repair their exclusion as well as
 * their staging, without creating a private namespace when none exists. */
export async function protectExistingControllerArtifacts(worktreeDir: string, exec: ExecPort = realExec, timing: ProbeTiming = probeTiming): Promise<void> {
  const root = path.resolve(worktreeDir);
  const artifactRoot = path.join(root, ".artifacts");
  const directory = path.join(artifactRoot, "pipeline-stage-inputs");
  assertDirectoryOrMissing(artifactRoot);
  assertDirectoryOrMissing(directory);
  if (fs.existsSync(directory)) await prepareControllerArtifactDirectory(root, exec, timing);
  else await protectControllerArtifactIndex(root, exec, timing);
}

/** Ignoring a file does not protect it once it is in the index. Remove only
 * uncommitted private entries before launching a worker that may commit before
 * controller settlement. A committed input path cannot safely receive secrets. */
async function protectControllerArtifactIndex(worktreeDir: string, exec: ExecPort, timing: ProbeTiming): Promise<void> {
  const root = path.resolve(worktreeDir);
  // Plain launch directories and injected worktree fixtures can be absent.
  // There is no index to protect until the directory exists.
  if (!fs.existsSync(root)) return;
  // One monotonic deadline covers every probe and backoff in this inspection.
  // A restart starts a new inspection; no pending retry escapes this call.
  const deadline = timing.now() + INSPECTION_DEADLINE_MS;
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };
  const git = async (args: string[], cwd = root, literalPaths = true, controllerPathsOnly = false) => withViewerOperation("pipelines.controller-artifacts", async () => {
    let result: ExecResult = { code: null, stdout: "", stderr: "inspection has not started" };
    for (let attempt = 1; ; attempt++) {
      const remaining = Math.ceil(deadline - timing.now());
      const context = `cannot inspect controller artifact Git paths (git ${args[0]}, attempt ${attempt})`;
      if (remaining <= 0) throw gitRefusal(`${context}; ${INSPECTION_DEADLINE_MS}ms inspection deadline exceeded`, result);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), remaining);
      try {
        result = await exec("git", args, cwd,
          literalPaths ? env : { ...env, GIT_LITERAL_PATHSPECS: "0", GIT_GLOB_PATHSPECS: "0", GIT_NOGLOB_PATHSPECS: "0" },
          { timeoutMs: Math.min(10_000, remaining), signal: abort.signal,
            maxOutputBytes: 8 * 1024 * 1024, stdoutEncoding: "latin1" });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (!code || !transientSpawnErrors.has(code)) throw error;
        result = { code: null, stdout: "", stderr: `${code}: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        clearTimeout(timer);
      }
      if (timing.now() >= deadline) throw gitRefusal(`${context}; ${INSPECTION_DEADLINE_MS}ms inspection deadline exceeded`, result);
      if (result.code !== null) break;
      // Only observations retry. Never replay an index write after losing its
      // acknowledgement, or retry deterministic cancellation/output refusals.
      if (attempt >= PROBE_ATTEMPTS || args[0] === "reset" || args[0] === "rm" ||
        /command cancelled|output exceeded|\b(?:ENOENT|EACCES|EPERM|ENOTDIR)\b/.test(result.stderr)) {
        throw gitRefusal(context, result);
      }
      await timing.sleep(Math.min(250 * attempt, Math.max(0, deadline - timing.now())));
    }
    let bytes = Buffer.from(result.stdout, "latin1");
    if (controllerPathsOnly) {
      // Latin-1 preserves every byte while filtering ASCII namespace segments.
      // Ordinary source filenames need no UTF-8 decoding or controller repair.
      bytes = Buffer.from(bytes.toString("latin1").split("\0")
        .filter((file) => /(?:^|\/)\.artifacts\/pipeline-stage-inputs(?:\/|$)/.test(file)).join("\0"), "latin1");
    }
    const stdout = bytes.toString("utf8");
    // Git names are byte strings. A lossy decode would let an index reset
    // target a different path while leaving the actual private entry staged.
    if (!Buffer.from(stdout, "utf8").equals(bytes)) throw new Error("cannot safely decode controller artifact Git paths");
    return { ...result, status: result.code, stdout };
  });
  const top = (await git(["rev-parse", "--show-toplevel"]));
  if (top.status !== 0) {
    // Plain spawn directories and unit fixtures need no Git index protection.
    // An existing Git entry with broken metadata must not bypass the fence.
    if (fs.existsSync(path.join(root, ".git"))) throw gitRefusal("cannot inspect the private controller artifact Git index", top);
    return;
  }
  const repo = fs.realpathSync(top.stdout.trim());
  const physicalDirectory = path.join(fs.realpathSync(root), CONTROLLER_ARTIFACT_DIRECTORY);
  const relative = path.relative(repo, physicalDirectory).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    // A stray core.worktree in the shared config moves the answer of
    // --show-toplevel away from the checkout. Name the redirect, not just the fence.
    let message = `controller artifacts must stay inside the Git worktree: ${fs.realpathSync(root)} resolves to Git work tree ${repo}`;
    const configured = await git(["config", "--get", "core.worktree"]).catch(() => null);
    const configuredValue = configured?.status === 0 ? configured.stdout.trim() : "";
    const environmentValue = process.env.GIT_WORK_TREE?.trim() ?? "";
    if (configuredValue) message += `; core.worktree is set to ${configuredValue} in this repository's config`;
    if (environmentValue) message += `; GIT_WORK_TREE is set to ${environmentValue}`;
    throw new Error(message);
  }
  const namespaceOf = (file: string): string | null => {
    const parts = file.split("/");
    const index = parts.findIndex((part, n) => part === ".artifacts" && parts[n + 1] === "pipeline-stage-inputs");
    return index < 0 ? null : parts.slice(0, index + 2).join("/");
  };
  const namespaces = new Set([relative]);
  const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], repo));
  if (head.status !== 0 && head.status !== 1) throw gitRefusal("cannot inspect the private controller artifact Git head", head);
  if (head.status === 0) {
    const committed = (await git(["ls-tree", "-r", "--name-only", "-z", "HEAD"], repo, true, true));
    if (committed.status !== 0) throw gitRefusal("cannot inspect committed controller artifacts", committed);
    for (const file of committed.stdout.split("\0")) {
      const namespace = namespaceOf(file);
      if (!namespace) continue;
      if (file !== `${namespace}/.gitignore`) {
        throw new Error("committed files in the private controller artifact directory prevent safe handoff composition");
      }
      namespaces.add(namespace);
    }
  }
  // A worker's `git add -A` and commit consume the whole repository, even when
  // it launches in a package. Discover inherited parent/sibling namespaces,
  // Include ignored handoffs too: restoring a tracked ancestor ignore can
  // expose them later. Bound that discovery to controller paths so ordinary
  // ignored build/dependency trees do not fill the result buffer.
  const indexed = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], repo, true, true));
  if (indexed.status !== 0) throw gitRefusal("cannot inspect staged controller artifacts", indexed);
  const ignored = (await git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--",
    `:(top,glob)**/${CONTROLLER_ARTIFACT_DIRECTORY}/**`], repo, false, true));
  if (ignored.status !== 0) throw gitRefusal("cannot inspect ignored controller artifacts", ignored);
  const exposed = new Set<string>();
  for (const file of indexed.stdout.split("\0")) {
    const namespace = namespaceOf(file);
    if (namespace) { namespaces.add(namespace); exposed.add(namespace); }
  }
  for (const file of ignored.stdout.split("\0")) {
    const namespace = namespaceOf(file);
    if (namespace) namespaces.add(namespace);
  }
  for (const namespace of namespaces) {
    const directory = path.join(repo, namespace);
    // A repository-controlled ancestor must not redirect ignore repair into
    // another directory. Check every component before any filesystem writes.
    const assertAncestors = () => {
      let component = repo;
      for (const part of namespace.split("/")) {
        component = path.join(component, part);
        assertDirectoryOrMissing(component);
      }
    };
    assertAncestors();
    if (fs.existsSync(directory) && fs.readdirSync(directory)
      .some((entry) => entry !== ".gitignore" && entry !== "private")) {
      // Older releases wrote handoffs directly beneath the tracked ignore.
      // An independent ancestor guard keeps those paths readable and private
      // even when a worker restores every tracked ignore file before commit.
      const ancestorIgnore = path.join(path.dirname(directory), ".gitignore");
      const relativeIgnore = path.relative(repo, ancestorIgnore).split(path.sep).join("/");
      const trackedIgnore = (await git(["ls-files", "--cached", "-z", "--", relativeIgnore], repo));
      if (trackedIgnore.status !== 0) throw gitRefusal("cannot inspect the legacy controller artifact ignore", trackedIgnore);
      if (trackedIgnore.stdout) {
        const committedIgnore = (await git(["show", `HEAD:${relativeIgnore}`], repo));
        const indexedIgnore = (await git(["show", `:${relativeIgnore}`], repo));
        if (committedIgnore.status !== 0) throw gitRefusal("cannot inspect committed controller artifact ignore", committedIgnore);
        if (indexedIgnore.status !== 0) throw gitRefusal("cannot inspect staged controller artifact ignore", indexedIgnore);
        if (!excludesControllerDirectory(committedIgnore.stdout) || !excludesControllerDirectory(indexedIgnore.stdout)) {
          throw new Error("tracked ancestor ignore prevents safe legacy controller handoff protection");
        }
      }
      // Git awaits let repository-controlled parents change. O_NOFOLLOW on
      // the ignore file protects its final component, so recheck parents too.
      assertAncestors();
      ensureIgnoreRules(ancestorIgnore, ["/.gitignore", "/pipeline-stage-inputs/"]);
    }
    const privateDirectory = path.join(directory, "private");
    assertDirectoryOrMissing(privateDirectory);
    if (fs.existsSync(privateDirectory)) ensureCatchAllIgnore(path.join(privateDirectory, ".gitignore"));
    if (exposed.has(namespace)) {
      // Reset preserves a tracked controller .gitignore. An unborn repository
      // has no HEAD; cached removal keeps every private file on disk.
      const unstage = (await git(head.status === 0
        ? ["reset", "--quiet", "HEAD", "--", namespace]
        : ["rm", "--cached", "-r", "-f", "--ignore-unmatch", "--", namespace], repo));
      if (unstage.status !== 0) throw gitRefusal("cannot unstage private controller artifacts before launch", unstage);
    }
    assertAncestors();
    if (fs.existsSync(directory)) ensureCatchAllIgnore(path.join(directory, ".gitignore"));
  }
}

function ignoreRules(contents: string): string[] {
  return contents.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

function excludesControllerDirectory(contents: string): boolean {
  const lastRule = ignoreRules(contents).at(-1);
  return lastRule === "*" || lastRule === "/pipeline-stage-inputs/";
}

function ensureCatchAllIgnore(filename: string): void {
  ensureIgnoreRules(filename, ["*"]);
}

function ensureIgnoreRules(filename: string, rules: readonly string[]): void {
  const noFollow = fs.constants.O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = openExistingIgnore(filename, noFollow);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    try {
      descriptor = fs.openSync(filename,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_APPEND | noFollow,
        0o600);
    } catch (createError) {
      if (!(createError && typeof createError === "object" && "code" in createError && createError.code === "EEXIST")) throw createError;
      descriptor = openExistingIgnore(filename, noFollow);
    }
  }

  try {
    assertPrivateIgnoreFile(descriptor);
    const contents = fs.readFileSync(descriptor, "utf8");
    const existingRules = ignoreRules(contents);
    if (existingRules.at(-1) !== "*" && existingRules.slice(-rules.length).join("\n") !== rules.join("\n")) {
      assertPrivateIgnoreFile(descriptor);
      fs.writeSync(descriptor, `${contents.length > 0 && !contents.endsWith("\n") ? "\n" : ""}${rules.join("\n")}\n`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function openExistingIgnore(filename: string, noFollow: number | undefined): number {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("pipeline controller artifact ignore file must be a regular file with one link");
  }
  return fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_APPEND | (noFollow ?? 0));
}

function assertPrivateIgnoreFile(descriptor: number): void {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error("pipeline controller artifact ignore file must be a regular file with one link");
  }
}

function assertDirectoryOrMissing(directory: string): void {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`pipeline controller artifact path must be a real directory: ${path.basename(directory)}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function ensureDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  assertDirectoryOrMissing(directory);
}
