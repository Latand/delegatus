import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { legacyClaudeHome } from "../accounts/claude";
import { accountForSpawn } from "../accounts/codex";
import { legacyCopilotHome } from "../accounts/copilot";
import { readCodexAuth } from "../codexAuth";
import { claudeTranscriptPath } from "../agent/transcript";
import { openclawStateDir, ROOTS } from "../scanner/roots";
import { processIdentityStatus, type ProcessIdentity } from "../processIdentity";
import { fixtureReport, stopFixtureIdentity, stopFixtureProcess } from "./fixtureProcess";

function expectInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  expect(path.isAbsolute(relative)).toBe(false);
  expect(relative === ".." || relative.startsWith(`..${path.sep}`)).toBe(false);
}

test("preload confines default account resolvers and CLI homes to its sandbox", () => {
  for (const home of [legacyClaudeHome(), accountForSpawn("default").home, legacyCopilotHome(), openclawStateDir()]) {
    expectInside(os.tmpdir(), home);
  }
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "CLAUDE_CODE_TMPDIR", "USERPROFILE", "DELEGATUS_CLAUDE_HOME", "DELEGATUS_CODEX_HOME"]) {
    expectInside(os.tmpdir(), process.env[key]!);
  }
});

test.skipIf(process.platform !== "linux").each(["SIGTERM", "SIGKILL"] as const)("startup-home runner ends when its supervisor receives %s", async (signal) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "home-runner-lifetime-"));
  const repository = path.resolve(import.meta.dir, "../../..");
  const home = path.join(root, "launch-home");
  fs.mkdirSync(home);
  const temporary = path.join(root, "tmp");
  fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(root, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(path.join(repository, "test-preload.ts"))}]\n`);
  fs.writeFileSync(path.join(root, "held.test.ts"), `
    import { test } from "bun:test";
    import { captureProcessIdentity } from ${JSON.stringify(path.join(repository, "src/lib/processIdentity.ts"))};
    test("held runner", async () => {
      setInterval(() => {}, 1000);
      console.log(JSON.stringify(captureProcessIdentity(process.pid)));
      await new Promise(() => {});
    });
  `);
  const child = spawn(process.execPath, ["test", "--timeout=60000", "./held.test.ts"], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: temporary }, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let identity: ProcessIdentity | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    identity = await fixtureReport<ProcessIdentity>(child, "startup-home runner", []);
    expect(identity.pid).not.toBe(child.pid);
    expect(processIdentityStatus(identity)).toBe("alive");
    expect(child.kill(signal)).toBe(true);
    await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("isolated runner outlived its supervisor")), 10_000);
    })]);
    expect(processIdentityStatus(identity)).toBe("dead");
  } finally {
    clearTimeout(timer);
    await stopFixtureProcess(child);
    if (identity) await stopFixtureIdentity(identity);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preload also isolates native-home fallbacks without environment overrides", () => {
  expectInside(path.dirname(os.tmpdir()), os.homedir());
  expectInside(path.dirname(os.homedir()), claudeTranscriptPath("/workspace", "session"));
  for (const key of ["codex-sessions", "claude-projects", "openclaw-sessions"] as const) {
    expectInside(path.dirname(os.homedir()), ROOTS[key]);
  }
  expect(readCodexAuth()).toBeNull();
});

test.each([undefined, ""])("native account fallbacks stay isolated with overrides set to %j", value => {
  const keys = ["LLV_CLAUDE_HOME", "LLV_CODEX_HOME", "COPILOT_HOME"] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const home of [legacyClaudeHome(), accountForSpawn("default").home, legacyCopilotHome()]) {
      expectInside(os.homedir(), home);
    }
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test.each([
  { inherited: false, fails: false },
  { inherited: true, fails: false },
  { inherited: false, fails: true },
  { inherited: true, fails: true },
])("preload confines fresh runners and preserves their outcome: %j", ({ inherited, fails }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-home-isolation-"));
  try {
    const repository = path.resolve(import.meta.dir, "../../..");
    fs.writeFileSync(path.join(root, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(path.join(repository, "test-preload.ts"))}]\n`);
    fs.writeFileSync(path.join(root, "fixture.test.ts"), `
      import { expect, test } from "bun:test";
      import os from "node:os";
      import path from "node:path";
      import fs from "node:fs";
      import { legacyClaudeHome } from ${JSON.stringify(path.join(repository, "src/lib/accounts/claude.ts"))};
      import { accountForSpawn } from ${JSON.stringify(path.join(repository, "src/lib/accounts/codex.ts"))};
      import { legacyCopilotHome } from ${JSON.stringify(path.join(repository, "src/lib/accounts/copilot.ts"))};
      import { readCodexAuth } from ${JSON.stringify(path.join(repository, "src/lib/codexAuth.ts"))};
      import { foldDelegatusEnvironment } from ${JSON.stringify(path.join(repository, "bin/envAlias.mjs"))};
      test("account homes stay in the preload sandbox", () => {
        foldDelegatusEnvironment();
        for (const candidate of [legacyClaudeHome(), accountForSpawn("default").home, legacyCopilotHome()]) {
          const relative = path.relative(os.tmpdir(), candidate);
          expect(path.isAbsolute(relative)).toBe(false);
          expect(relative === ".." || relative.startsWith(".." + path.sep)).toBe(false);
        }
        expect(readCodexAuth()).toBeNull();
        const nativeRelative = path.relative(path.dirname(os.tmpdir()), os.homedir());
        expect(path.isAbsolute(nativeRelative)).toBe(false);
        expect(nativeRelative === ".." || nativeRelative.startsWith(".." + path.sep)).toBe(false);
        fs.appendFileSync(process.env.LLV_TEST_HOME_RECEIPT, os.homedir() + "\\n");
        if (${fails}) throw new Error("fixture refusal after home checks");
      });
      test("excluded fixture", () => { throw new Error("the test-name filter was lost"); });
    `);
    const env = { ...process.env };
    const home = path.join(root, "launch-home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: "fixture", account_id: "fixture" } }));
    env.HOME = home;
    env.USERPROFILE = home;
    env.TMPDIR = path.join(root, "tmp");
    fs.mkdirSync(env.TMPDIR);
    const receipt = path.join(root, "home-receipt");
    env.LLV_TEST_HOME_RECEIPT = receipt;
    for (const key of ["LLV_CLAUDE_HOME", "LLV_CODEX_HOME", "COPILOT_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DELEGATUS_CLAUDE_HOME", "DELEGATUS_CODEX_HOME"]) {
      if (inherited) env[key] = path.join(root, "foreign-home", key.toLowerCase());
      else delete env[key];
    }
    const result = spawnSync(process.execPath, ["test", "--timeout=60000", "--rerun-each=2", "--test-name-pattern", "account homes stay", "./fixture.test.ts"], {
      cwd: root, env, encoding: "utf8", timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(fails ? 1 : 0);
    expect(fs.existsSync(receipt), result.stdout + result.stderr).toBe(true);
    const startupHomes = fs.readFileSync(receipt, "utf8").trim().split("\n");
    expect(startupHomes).toHaveLength(2);
    for (const startupHome of startupHomes) {
      expectInside(env.TMPDIR, startupHome);
      expect(fs.existsSync(path.dirname(startupHome))).toBe(false);
    }
    if (fails) expect(result.stderr).toContain("fixture refusal after home checks");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
