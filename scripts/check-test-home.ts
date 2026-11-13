import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimProcessTempRoot, TEST_RUN_TEMP_PREFIX } from "../src/lib/tempDirs";

export const homeKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "LLV_CLAUDE_HOME", "LLV_CODEX_HOME", "COPILOT_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "OPENCLAW_STATE_DIR", "CLAUDE_CODE_TMPDIR"] as const;
export const accountAliasKeys = ["DELEGATUS_CLAUDE_HOME", "DELEGATUS_CODEX_HOME"] as const;
export function isolateHomes(root: string, env: NodeJS.ProcessEnv): void {
  for (const key of homeKeys) {
    env[key] = path.join(root, key.toLowerCase());
    fs.mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  }
  // Entry points fold public aliases after inheriting the test environment.
  for (const key of accountAliasKeys) env[key] = env[key.replace("DELEGATUS_", "LLV_")];
}

/** Prepare before Bun starts: older baseline preloads otherwise fork their
 * old runner after admission, across a service boundary the new broker does
 * not own. Keep the caller's temp parent for browser socket path lengths. */
export function prepareTestHome(env: NodeJS.ProcessEnv = process.env) {
  if (env.LLV_TEST_STARTUP_HOME === os.homedir()) return;
  const prepared = { ...env };
  // A caller can select and validate a native tool before entering the runner.
  // Moving its cache would select different bytes during the same check.
  const selectedCache = env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  const startup = claimProcessTempRoot(TEST_RUN_TEMP_PREFIX, prepared);
  if (env.TMPDIR === undefined) delete prepared.TMPDIR;
  else prepared.TMPDIR = env.TMPDIR;
  isolateHomes(startup.root, prepared);
  prepared.XDG_CACHE_HOME = selectedCache;
  prepared.LLV_TEST_STARTUP_HOME = prepared[process.platform === "win32" ? "USERPROFILE" : "HOME"];
  return { env: prepared, release: startup.release };
}
