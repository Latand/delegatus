import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHookFixture } from "./local-gate.fixture";
import { changedSinceBase } from "./ci-platform-scope";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function hookFixture(realLint = false, controlledClock = false) {
  return createHookFixture(root, roots, realLint, controlledClock);
}
test("real pre-commit hook checks staged source, stops failures, and supports the escape hatch", () => {
  const f = hookFixture(); writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n"); f.git("add", "example.ts");
  const failed = spawnSync("git", ["commit", "-m", "blocked"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "scripts/eslint-changes.ts" }, encoding: "utf8" });
  expect(failed.status).not.toBe(0);
  expect(f.calls().some(call => call.args[0] === "scripts/privacy-publication-gate.ts")).toBeFalse();
  expect(f.calls().some(call => call.args.includes("--check-commits"))).toBeFalse();
  f.git("commit", "-m", "accepted");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 3;\n"); f.git("add", "example.ts");
  const skip = spawnSync("git", ["commit", "-m", "escape"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "scripts/eslint-changes.ts", LLV_SKIP_HOOKS: "1" } });
  expect(skip.status).toBe(0);
});
test("linked-worktree pre-commit clears Git selectors and preserves the complete shared config", () => {
  const f = hookFixture();
  const linkedRoot = mkdtempSync(path.join(tmpdir(), "linked-commit-")); roots.push(linkedRoot);
  const worktree = path.join(linkedRoot, "checkout");
  f.git("config", "core.bare", "false"); f.git("config", "core.worktree", f.dir); f.git("config", "core.hooksPath", ".githooks");
  f.git("worktree", "add", "-b", "linked-commit", worktree);
  const configPath = path.join(f.dir, ".git", "config");
  const before = readFileSync(configPath);
  writeFileSync(path.join(worktree, "example.ts"), "export const value = 2;\n");
  execFileSync("git", ["add", "example.ts"], { cwd: worktree, env: f.env });
  const linkedGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, env: f.env, encoding: "utf8" }).trim();
  const linkedCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, env: f.env, encoding: "utf8" }).trim();
  const adversarial = { ...f.env, GIT_DIR: linkedGitDir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: path.join(linkedGitDir, "index"), GIT_COMMON_DIR: linkedCommon, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "false" };
  const result = spawnSync("git", ["commit", "-m", "linked change"], { cwd: worktree, env: adversarial, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(configPath)).toEqual(before);
  const calls = f.calls();
  expect(calls.some(call => call.gitDir === undefined && call.index === undefined && call.workTree === undefined && call.commonDir === undefined && call.configCount === undefined && call.configKey === undefined)).toBeTrue();
});
test("pre-push hook resolves an explicit base and runs named touched tests in a sandbox", () => {
  const f = hookFixture(); writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n"); f.git("add", "example.ts"); f.git("commit", "-m", "change");
  expect(changedSinceBase(f.dir, "origin/main")).toEqual(["example.ts"]);
  const remote = mkdtempSync(path.join(tmpdir(), "hook-remote-")); roots.push(remote);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe", env: f.env });
  execFileSync("git", ["--git-dir", remote, "fetch", f.dir, "origin/main:main"], { stdio: "pipe", env: f.env });
  f.git("remote", "add", "origin", remote);
  // Keep main at the base: both pushes must still contain a guarded change.
  const result = spawnSync("git", ["push", "origin", "HEAD:feature"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain("pre-push: CPU admission for publication checks");
  expect(result.stderr).toMatch(/pre-push: publication checks CPU wait: \d+ ms \(excluded from execution budget\)/);
  const tests = f.calls().find(call => call.args[0] === "scripts/local-gate-tests.ts")!;
  expect(tests.args).toEqual(["scripts/local-gate-tests.ts", "--base", f.git("rev-parse", "HEAD^").toString().trim(), "./example.test.ts"]);
  expect(tests.gitDir).toBeUndefined(); expect(tests.index).toBeUndefined(); expect(tests.workTree).toBeUndefined(); expect(tests.commonDir).toBeUndefined();
  for (const key of ["state", "home", "config", "tmp"] as const) expect(tests[key]).toContain("delegatus-local-gate-");
  expect(existsSync(tests.state!)).toBeFalse();
  expect(f.calls().some(call => call.args.includes("--check-commits"))).toBeTrue();
  const rejected = spawnSync("git", ["push", "origin", "HEAD:blocked"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "tsc" }, encoding: "utf8" });
  expect(rejected.status).not.toBe(0);
}, 20_000);
test("linked-worktree pre-push clears Git selectors and preserves the complete shared config", () => {
  const f = hookFixture();
  const linkedRoot = mkdtempSync(path.join(tmpdir(), "linked-push-")); roots.push(linkedRoot);
  const worktree = path.join(linkedRoot, "checkout");
  f.git("config", "core.bare", "false"); f.git("config", "core.worktree", f.dir); f.git("config", "core.hooksPath", ".githooks");
  f.git("worktree", "add", "-b", "linked-push", worktree);
  const remote = mkdtempSync(path.join(tmpdir(), "linked-hook-remote-")); roots.push(remote);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe", env: f.env });
  execFileSync("git", ["--git-dir", remote, "fetch", f.dir, "refs/heads/main:refs/heads/main"], { stdio: "pipe", env: f.env });
  f.git("remote", "add", "origin", remote);
  const configPath = path.join(f.dir, ".git", "config");
  const before = readFileSync(configPath);
  writeFileSync(path.join(worktree, "example.ts"), "export const value = 2;\n");
  execFileSync("git", ["add", "example.ts"], { cwd: worktree, env: f.env });
  execFileSync("git", ["commit", "-m", "linked push base"], { cwd: worktree, env: f.env, stdio: "pipe" });
  const linkedGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, env: f.env, encoding: "utf8" }).trim();
  const linkedCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, env: f.env, encoding: "utf8" }).trim();
  const adversarial = { ...f.env, GIT_DIR: linkedGitDir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: path.join(linkedGitDir, "index"), GIT_COMMON_DIR: linkedCommon, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "false" };
  const result = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: worktree, env: adversarial, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(configPath)).toEqual(before);
  expect(f.calls().some(call => call.gitDir === undefined && call.index === undefined && call.workTree === undefined && call.commonDir === undefined && call.configCount === undefined && call.configKey === undefined)).toBeTrue();
}, 20_000);

test("private fixture pushes reach Git and its hook under an agent tool environment", () => {
  const agent = mkdtempSync(path.join(tmpdir(), "fixture-agent-tools-")); roots.push(agent);
  const forge = path.join(agent, "forge");
  const guard = path.join(agent, "delegatus", "agent-git-hooks", "guard-fixture", "scope");
  const intercepted = path.join(agent, "intercepted");
  for (const directory of [forge, guard]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "git"), `#!/bin/sh\nprintf intercepted > '${intercepted}'\nexit 73\n`, { mode: 0o755 });
  }
  const previousPath = process.env.PATH, previousForge = process.env.LLV_AGENT_FORGE_DIR;
  let f: ReturnType<typeof hookFixture>;
  try {
    process.env.PATH = [guard, forge, previousPath].join(path.delimiter);
    process.env.LLV_AGENT_FORGE_DIR = forge;
    f = hookFixture();
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousForge === undefined) delete process.env.LLV_AGENT_FORGE_DIR; else process.env.LLV_AGENT_FORGE_DIR = previousForge;
  }
  const remote = path.join(agent, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { env: f.env, stdio: "pipe" });
  f.git("remote", "add", "origin", remote);
  const result = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain("pre-push: nothing changed since");
  expect(f.calls().map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
  expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { env: f.env, encoding: "utf8" }).trim())
    .toBe(f.git("rev-parse", "HEAD").toString().trim());
  expect(existsSync(intercepted)).toBeFalse();
}, 20_000);

test("a staged credential commits without privacy and is refused before push", () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, "example.ts"), `// ${["api_token", "=", "synthetic".repeat(3)].join("")}\n`);
  f.git("add", "example.ts");
  const commit = spawnSync("git", ["commit", "-m", "Synthetic credential"], { cwd: f.dir,
    env: { ...f.env, HOOK_FAIL: "scripts/privacy-publication-gate.ts" }, encoding: "utf8" });
  expect(commit.status, commit.stdout + commit.stderr).toBe(0);
  const result = spawnSync(process.execPath, [path.join(root, "scripts/privacy-publication-gate.ts"),
    "--repository", f.dir, "--base", "origin/main", "--added-lines", "--check-commits", "--require-known-values"], {
    cwd: root, env: { ...f.env, LLV_PRIVACY_KNOWN_VALUES_FILE: undefined,
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(root, "scripts/privacy-known-value-fingerprints.json") }, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("credential:");
});
