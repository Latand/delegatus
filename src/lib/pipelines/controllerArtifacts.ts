import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

/** Keep controller handoffs out of ordinary Git discovery where possible.
 * Settlement also excludes this path explicitly, so repository negation rules
 * cannot make private controller inputs eligible for a stage commit. */
export function prepareControllerArtifactDirectory(worktreeDir: string): string {
  const root = path.resolve(worktreeDir);
  const artifactRoot = path.join(root, ".artifacts");
  const directory = path.join(artifactRoot, "pipeline-stage-inputs");

  /* These names are inside a repository controlled by the agent being
     launched. Never let mkdir or a later file write follow a repository
     symlink into another path. Check existing components before creating
     either directory, then create one level at a time and recheck races. */
  assertDirectoryOrMissing(artifactRoot);
  assertDirectoryOrMissing(directory);
  protectControllerArtifactIndex(root);
  ensureDirectory(artifactRoot);
  ensureDirectory(directory);

  ensureCatchAllIgnore(path.join(directory, ".gitignore"));
  return directory;
}

/** A small launch can inherit old handoffs. Repair their exclusion as well as
 * their staging, without creating a private namespace when none exists. */
export function protectExistingControllerArtifacts(worktreeDir: string): void {
  const root = path.resolve(worktreeDir);
  const artifactRoot = path.join(root, ".artifacts");
  const directory = path.join(artifactRoot, "pipeline-stage-inputs");
  assertDirectoryOrMissing(artifactRoot);
  assertDirectoryOrMissing(directory);
  if (fs.existsSync(directory)) prepareControllerArtifactDirectory(root);
  else protectControllerArtifactIndex(root);
}

/** Ignoring a file does not protect it once it is in the index. Remove only
 * uncommitted private entries before launching a worker that may commit before
 * controller settlement. A committed input path cannot safely receive secrets. */
function protectControllerArtifactIndex(worktreeDir: string): void {
  const root = path.resolve(worktreeDir);
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };
  const git = (args: string[], cwd = root) => spawnSync("git", args, {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    // Plain spawn directories and unit fixtures need no Git index protection.
    // An existing Git entry with broken metadata must not bypass the fence.
    if (fs.existsSync(path.join(root, ".git"))) throw new Error("cannot inspect the private controller artifact Git index");
    return;
  }
  const repo = fs.realpathSync(top.stdout.trim());
  const physicalDirectory = path.join(fs.realpathSync(root), CONTROLLER_ARTIFACT_DIRECTORY);
  const relative = path.relative(repo, physicalDirectory).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("controller artifacts must stay inside the Git worktree");
  const namespaceOf = (file: string): string | null => {
    const parts = file.split("/");
    const index = parts.findIndex((part, n) => part === ".artifacts" && parts[n + 1] === "pipeline-stage-inputs");
    return index < 0 ? null : parts.slice(0, index + 2).join("/");
  };
  const namespaces = new Set([relative]);
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD"], repo);
  if (head.status !== 0 && head.status !== 1) throw new Error("cannot inspect the private controller artifact Git head");
  if (head.status === 0) {
    const committed = git(["ls-tree", "-r", "--name-only", "-z", "HEAD"], repo);
    if (committed.status !== 0) throw new Error("cannot inspect committed controller artifacts");
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
  // including exposed untracked files whose local ignore was removed.
  const indexed = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], repo);
  if (indexed.status !== 0) throw new Error("cannot inspect staged controller artifacts");
  const exposed = new Set<string>();
  for (const file of indexed.stdout.split("\0")) {
    const namespace = namespaceOf(file);
    if (namespace) { namespaces.add(namespace); exposed.add(namespace); }
  }
  for (const namespace of namespaces) {
    const directory = path.join(repo, namespace);
    // A repository-controlled ancestor must not redirect ignore repair into
    // another directory. Check every component before any filesystem writes.
    let component = repo;
    for (const part of namespace.split("/")) {
      component = path.join(component, part);
      assertDirectoryOrMissing(component);
    }
    if (exposed.has(namespace)) {
      // Reset preserves a tracked controller .gitignore. An unborn repository
      // has no HEAD; cached removal keeps every private file on disk.
      const unstage = git(head.status === 0
        ? ["reset", "--quiet", "HEAD", "--", namespace]
        : ["rm", "--cached", "-r", "-f", "--ignore-unmatch", "--", namespace], repo);
      if (unstage.status !== 0) throw new Error("cannot unstage private controller artifacts before launch");
    }
    if (fs.existsSync(directory)) ensureCatchAllIgnore(path.join(directory, ".gitignore"));
  }
}

function ensureCatchAllIgnore(filename: string): void {
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
    const lastRule = contents.split(/\r?\n/).reverse()
      .find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    if (lastRule !== "*") {
      assertPrivateIgnoreFile(descriptor);
      fs.writeSync(descriptor, `${contents.length > 0 && !contents.endsWith("\n") ? "\n" : ""}*\n`);
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
