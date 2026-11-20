import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { homeKeys, accountAliasKeys } from "./check-test-home";

const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
for (const entry of ["gate", "portable"] as const) for (const launch of ["direct", "shell", "package"] as const) {
  test.skipIf(process.platform === "win32")(`${entry} ${launch} non-test command retains caller homes, configuration and capture temp root`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caller-command-home-"));
    const env = withoutInheritedGate({ ...process.env });
    for (const key of [...homeKeys, ...accountAliasKeys, "TMPDIR", "LLV_STATE_DIR"]) {
      env[key] = path.join(root, key.toLowerCase()); fs.mkdirSync(env[key]!, { recursive: true });
    }
    Object.assign(env, { LLV_CHECK_ADMISSION_FILE: path.join(root, "checks.sqlite"),
      LLV_GATE_LOCK_DIR: path.join(root, "locks"), LLV_GATE_RUNNER: "off",
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_OWNED_RUN_TIMEOUT_MS: "20000" });
    delete env.LLV_TEST_STARTUP_HOME;
    for (const name of [".gitconfig", ".npmrc"]) fs.writeFileSync(path.join(env.HOME!, name), "caller configuration");
    fs.writeFileSync(path.join(env.XDG_CACHE_HOME!, "selected-tool"), "pinned");
    const selected = Object.fromEntries([...homeKeys, ...accountAliasKeys, "TMPDIR", "LLV_STATE_DIR"].map(key => [key, env[key]]));
    const source = `import fs from "node:fs"; import os from "node:os"; import path from "node:path";
      import { createCaptureDirectory } from ${JSON.stringify(path.join(import.meta.dir, "capture-directory.ts"))};
      for (const [key, value] of Object.entries(${JSON.stringify(selected)})) {
        if (process.env[key] !== value) throw new Error("caller home changed: " + key);
      }
      if (os.homedir() !== process.env.HOME) throw new Error("native home changed");
      for (const name of [".gitconfig", ".npmrc"]) {
        if (fs.readFileSync(path.join(os.homedir(), name), "utf8") !== "caller configuration") throw new Error("configuration hidden");
      }
      if (fs.readFileSync(path.join(process.env.XDG_CACHE_HOME, "selected-tool"), "utf8") !== "pinned") throw new Error("selected tool changed");
      const capture = createCaptureDirectory({ envName: "LLV_README_CAPTURE_ROOT", prefix: "llv-readme", repoRoot: ${JSON.stringify(path.resolve(import.meta.dir, ".."))} });
      if (path.dirname(capture) !== fs.realpathSync(os.tmpdir())) throw new Error("capture temp root changed");
      console.log("caller environment verified");`;
    // A script argument naming the preload is still a non-test command.
    const command = [process.execPath, "probe.ts", path.join(import.meta.dir, "check-test-preload.ts")];
    fs.writeFileSync(path.join(root, "probe.ts"), source);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { check: command.map(quote).join(" ") } }));
    const invoked = launch === "direct" ? command : launch === "package" ? [process.execPath, "run", "check"]
      : ["bash", "-c", "exec " + command.map(quote).join(" ")];
    const args = entry === "portable" ? [process.execPath, path.join(import.meta.dir, "owned-runner.ts"), "--portable", ...invoked]
      : ["bash", path.join(import.meta.dir, "gate-slot.sh"), ...invoked];
    const child = spawn(args[0]!, args.slice(1), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => stdout += chunk); child.stderr!.on("data", chunk => stderr += chunk);
    const closed = once(child, "close");
    try {
      expect(await closed, stderr).toEqual([0, null]);
      expect(stdout).toBe("caller environment verified\n");
    } finally { await stopFixtureProcess(child); fs.rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
}
