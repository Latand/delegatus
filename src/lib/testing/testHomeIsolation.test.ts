import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { legacyClaudeHome } from "../accounts/claude";
import { legacyCodexHome } from "../accounts/codex";
import { legacyCopilotHome } from "../accounts/copilot";
import { readCodexAuth } from "../codexAuth";
import { claudeTranscriptPath } from "../agent/transcript";
import { openclawStateDir, ROOTS } from "../scanner/roots";

function expectInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  expect(path.isAbsolute(relative)).toBe(false);
  expect(relative === ".." || relative.startsWith(`..${path.sep}`)).toBe(false);
}

test("preload confines default account resolvers and CLI homes to its sandbox", () => {
  for (const home of [legacyClaudeHome(), legacyCodexHome(), legacyCopilotHome(), openclawStateDir()]) {
    expectInside(os.tmpdir(), home);
  }
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "CLAUDE_CODE_TMPDIR", "USERPROFILE"]) {
    expectInside(os.tmpdir(), process.env[key]!);
  }
});

test("preload also isolates native-home fallbacks without environment overrides", () => {
  expect(os.homedir()).toBe(process.env.LLV_TEST_STARTUP_HOME);
  expectInside(path.dirname(os.homedir()), claudeTranscriptPath("/workspace", "session"));
  for (const key of ["codex-sessions", "claude-projects", "openclaw-sessions"] as const) {
    expectInside(path.dirname(os.homedir()), ROOTS[key]);
  }
  expectInside(path.dirname(os.homedir()), legacyCopilotHome({}));
  expect(readCodexAuth()).toBeNull();
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
      import { legacyCodexHome } from ${JSON.stringify(path.join(repository, "src/lib/accounts/codex.ts"))};
      import { legacyCopilotHome } from ${JSON.stringify(path.join(repository, "src/lib/accounts/copilot.ts"))};
      import { readCodexAuth } from ${JSON.stringify(path.join(repository, "src/lib/codexAuth.ts"))};
      test("account homes stay in the preload sandbox", () => {
        for (const candidate of [legacyClaudeHome(), legacyCodexHome(), legacyCopilotHome()]) {
          const relative = path.relative(os.tmpdir(), candidate);
          expect(path.isAbsolute(relative)).toBe(false);
          expect(relative === ".." || relative.startsWith(".." + path.sep)).toBe(false);
        }
        expect(os.homedir()).toBe(process.env.LLV_TEST_STARTUP_HOME);
        expect(readCodexAuth()).toBeNull();
        fs.writeFileSync(process.env.LLV_TEST_HOME_RECEIPT, os.homedir());
        if (${fails}) throw new Error("fixture refusal after home checks");
      });
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
    for (const key of ["LLV_CLAUDE_HOME", "LLV_CODEX_HOME", "COPILOT_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
      if (inherited) env[key] = path.join(root, "foreign-home", key.toLowerCase());
      else delete env[key];
    }
    const result = spawnSync(process.execPath, ["test", "--timeout=60000", "./fixture.test.ts"], {
      cwd: root, env, encoding: "utf8", timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(fails ? 1 : 0);
    const startupHome = fs.readFileSync(receipt, "utf8");
    expectInside(env.TMPDIR, startupHome);
    expect(fs.existsSync(path.dirname(startupHome))).toBe(false);
    if (fails) expect(result.stderr).toContain("fixture refusal after home checks");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
