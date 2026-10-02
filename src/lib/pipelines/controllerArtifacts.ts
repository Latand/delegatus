import fs from "node:fs";
import path from "node:path";

export const CONTROLLER_ARTIFACT_DIRECTORY = ".artifacts/pipeline-stage-inputs";
export const CONTROLLER_ARTIFACT_PATHSPEC = `:(exclude,top)${CONTROLLER_ARTIFACT_DIRECTORY}`;

/** Keep controller handoffs out of ordinary Git discovery where possible.
 * Settlement also excludes this path explicitly, so repository negation rules
 * cannot make private controller inputs eligible for a stage commit. */
export function prepareControllerArtifactDirectory(worktreeDir: string): string {
  const directory = path.resolve(worktreeDir, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const localIgnore = path.join(directory, ".gitignore");
  try {
    fs.writeFileSync(localIgnore, "*\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  return directory;
}
