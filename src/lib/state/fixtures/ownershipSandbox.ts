import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setStateOwnershipPathsForTests } from "../../stateOwnership";

export const OWNERSHIP_PRELOAD = path.join(import.meta.dir, "ownershipSandbox.ts");
const ROOT_ENV = "LLV_TEST_OWNERSHIP_ROOT";

function install(root: string): () => void {
  return setStateOwnershipPathsForTests({ home: path.join(root, "home"), tempRoots: [path.join(root, "tmp")] });
}

/** The same injection runs before a real entry point, including its bundle. */
if (process.env[ROOT_ENV]) install(process.env[ROOT_ENV]!);

export function ownershipSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ownership-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp);
  const restore = install(root);
  return {
    home,
    temporaryRoot: () => fs.mkdtempSync(path.join(tmp, "probe-")),
    environment(): Record<string, string> {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined || /^(?:LLV|DELEGATUS)_/.test(key) && !key.startsWith("LLV_OWNED_")) continue;
        if (/^(?:NEXT_|PROBE_)/.test(key) || ["NODE_OPTIONS", "BUN_OPTIONS"].includes(key)) continue;
        env[key] = value;
      }
      return { ...env, [ROOT_ENV]: root, HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(root, "cache"),
        TMPDIR: tmp, NODE_ENV: "production", LLV_CPU_PRESSURE: "off", LLV_AGENT_CPU: "off",
        LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
    },
    release() { restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
