import fs from "node:fs";
import path from "node:path";

export const CONTROLLER_ARTIFACT_DIRECTORY = ".artifacts/pipeline-stage-inputs";
export const CONTROLLER_ARTIFACT_PATHSPEC = `:(exclude,top)${CONTROLLER_ARTIFACT_DIRECTORY}`;

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
  ensureDirectory(artifactRoot);
  ensureDirectory(directory);

  ensureCatchAllIgnore(path.join(directory, ".gitignore"));
  return directory;
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
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("pipeline controller artifact ignore file must be a regular file");
    }
    const contents = fs.readFileSync(descriptor, "utf8");
    const lastRule = contents.split(/\r?\n/).reverse()
      .find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    if (lastRule !== "*") {
      fs.writeSync(descriptor, `${contents.length > 0 && !contents.endsWith("\n") ? "\n" : ""}*\n`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function openExistingIgnore(filename: string, noFollow: number | undefined): number {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("pipeline controller artifact ignore file must be a regular file");
  }
  return fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_APPEND | (noFollow ?? 0));
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
