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

  const localIgnore = path.join(directory, ".gitignore");
  try {
    fs.writeFileSync(localIgnore, "*\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const ignore = fs.lstatSync(localIgnore);
    if (!ignore.isFile() || ignore.isSymbolicLink()) {
      throw new Error("pipeline controller artifact ignore file must be a regular file");
    }
  }
  return directory;
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
