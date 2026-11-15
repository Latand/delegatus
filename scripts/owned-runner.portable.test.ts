import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";

// Exercise the runner as a separate process: a printed Bun summary does not
// prove that the supervisor can emit its verdict and exit on the native OS.
for (const code of [0, 7]) test(`portable runner returns command exit ${code} after native stdio closes`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-verdict-"));
  const env = withoutInheritedGate({ ...process.env });
  for (const [key, leaf] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", LLV_STATE_DIR: "state", TMPDIR: "tmp", TMP: "tmp", TEMP: "tmp" })) {
    env[key] = path.join(root, leaf);
    fs.mkdirSync(env[key]!, { recursive: true });
  }
  env.LLV_OWNED_RUN_TIMEOUT_MS = "10000";
  env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  const child = spawn(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), "--portable", process.execPath, "-e",
    `process.stdout.write("command finished\\n"); process.exit(${code});`], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const closed = once(child, "close");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      closed,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`portable verdict stalled after command completion: ${stdout} ${stderr}`)), 20000); }),
    ]);
    expect({ result, stderr }).toEqual({ result: [code, null], stderr: expect.any(String) });
    expect(stdout).toBe("command finished\n");
  } finally {
    clearTimeout(timeout);
    await stopFixtureProcess(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
