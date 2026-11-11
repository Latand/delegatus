import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("wait owner passes only the caller's environment to the engine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-owner-env-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  fs.writeFileSync(path.join(root, ".env"), ["ANTHROPIC_API_KEY", "fixture-key"].join("=") + "\nUNDECLARED_PROJECT_VALUE=fixture-value\n");
  const { spawnNativeWaitOwner } = await import("./nativeWaitOwner");
  const flags = process.versions.bun ? ["--no-env-file"] : [];
  const child = spawnNativeWaitOwner(process.execPath, [...flags, "-e", `process.stdout.write(JSON.stringify({
    declared: process.env.DECLARED_VALUE,
    apiKeyPresent: "ANTHROPIC_API_KEY" in process.env,
    projectValuePresent: "UNDECLARED_PROJECT_VALUE" in process.env,
  }))`], {
    cwd: root,
    env: { NODE_ENV: "test", PATH: process.env.PATH, DECLARED_VALUE: "fixture-explicit" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`engine exited ${code}`)));
  });
  try {
    await child.spawnReady;
    child.retainExit(false);
    await closed;
    expect(JSON.parse(output)).toEqual({ declared: "fixture-explicit", apiKeyPresent: false, projectValuePresent: false });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
