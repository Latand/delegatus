import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { findAgentBinary } from "../../../bin/agent-binaries.mjs";

const execFileAsync = promisify(execFile);

/** Keep the caller's PATH precedence and credential environment, including GH_CONFIG_DIR. */
export async function runGithubCliRead(
  args: string[],
  options: { cwd?: string; timeout: number; env?: NodeJS.ProcessEnv; maxBuffer?: number },
  { platform = process.platform } = {},
): Promise<string> {
  try {
    return (await execFileAsync("gh", args, options)).stdout;
  } catch (error) {
    if (platform !== "darwin" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A launch agent may have only system directories on PATH. Use the same
    // install locations as the agent CLIs, including both Homebrew prefixes.
    const binary = findAgentBinary("gh", { platform, home: options.env?.HOME, envPath: "" });
    if (!binary) throw error;
    return (await execFileAsync(binary, args, options)).stdout;
  }
}
