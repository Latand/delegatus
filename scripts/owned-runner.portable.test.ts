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


for (const launch of ["direct", "shell", "package"] as const) for (const cache of ["explicit", "default"] as const) test.skipIf(launch === "shell" && process.platform === "win32")(`legacy ${launch} test preloads receive private startup homes and retain ${cache} selected caches before admission`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-legacy-home-"));
  const env = withoutInheritedGate({ ...process.env });
  for (const [key, leaf] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", LLV_STATE_DIR: "state", TMPDIR: "tmp" })) {
    env[key] = path.join(root, leaf); fs.mkdirSync(env[key]!, { recursive: true });
  }
  env.LLV_CHECK_ADMISSION_FILE = path.join(root, "checks.sqlite");
  env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  delete env.LLV_TEST_STARTUP_HOME;
  const selectedCache = cache === "explicit" ? path.join(root, "cache") : path.join(env.HOME!, ".cache");
  if (cache === "explicit") env.XDG_CACHE_HOME = selectedCache;
  else delete env.XDG_CACHE_HOME;
  fs.mkdirSync(selectedCache, { recursive: true });
  fs.writeFileSync(path.join(selectedCache, "selected-tool"), "pinned");
  fs.writeFileSync(path.join(root, "bunfig.toml"), '[test]\npreload = ["./legacy-preload.ts"]\n');
  fs.writeFileSync(path.join(root, "legacy-preload.ts"), `import os from "node:os"; import fs from "node:fs";
    if (process.env.LLV_TEST_STARTUP_HOME !== os.homedir()) {
      fs.writeFileSync(${JSON.stringify(path.join(root, "old-runner-requested"))}, "reentry"); process.exit(79);
    }`);
  fs.writeFileSync(path.join(root, "worker.test.ts"), `import { test, expect } from "bun:test"; import os from "node:os"; import fs from "node:fs";
    test("private startup", () => {
      expect(process.env.LLV_TEST_STARTUP_HOME).toBe(os.homedir());
      expect(os.homedir()).not.toBe(${JSON.stringify(env.HOME)});
      expect(process.env.DELEGATUS_CLAUDE_HOME).toBe(process.env.LLV_CLAUDE_HOME);
      expect(process.env.DELEGATUS_CODEX_HOME).toBe(process.env.LLV_CODEX_HOME);
      expect(process.env.XDG_CACHE_HOME).toBe(${JSON.stringify(selectedCache)});
      expect(fs.readFileSync(${JSON.stringify(path.join(selectedCache, "selected-tool"))}, "utf8")).toBe("pinned");
    });`);
  const report = path.join(root, "junit.xml");
  const command = [process.execPath, "test", "./worker.test.ts", "--reporter=junit", `--reporter-outfile=${report}`];
  fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({scripts:{check:command.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ")}}));
  const invoked = launch === "direct" ? command : launch === "package" ? [process.execPath,"run","check"]
    : ["bash","-c", "exec " + command.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ")];
  const child = spawn(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), "--portable", ...invoked], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr!.on("data", data => { stderr += String(data); }); child.stdout!.resume();
  const closed = once(child, "close");
  try {
    expect(await closed, stderr).toEqual([0, null]);
    expect(fs.existsSync(path.join(root, "old-runner-requested"))).toBe(false);
    expect(fs.readFileSync(report, "utf8")).toContain('name="private startup"');
  } finally {
    await stopFixtureProcess(child); fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
