import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discover, gateTemporaryRoot, isolatedEnvironment, pinnedBunVersion, plan, requiresMediaTools, type PlanEnvironment } from "./local-gate";
import { changedSinceBase } from "./ci-platform-scope";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context(overrides: Partial<PlanEnvironment> = {}): PlanEnvironment {
  return { base: "base", existing: new Set(["src/example.ts", "src/example.test.ts", "src/example.integration.test.ts", "src/example.browser.test.tsx", "image.png", "package.json"]), tests: ["src/example.test.ts", "src/example.integration.test.ts", "src/example.browser.test.tsx"], skippedMedia: [], linux: false, runtime: false, native: false, linuxTests: ["src/platform.test.ts"], runtimeTests: ["scripts/runtime.test.ts"], codexVersions: ["0.154.0", "0.159.0"], ...overrides };
}
test("commit plan checks staged whitespace/privacy/lint and leaves types and tests to push", () => {
  const steps = plan("pre-commit", ["src/example.ts"], context());
  expect(steps.map(step => step.name)).toEqual(["staged whitespace", "privacy", "eslint"]);
  expect(steps[1]!.command).toContain("--require-known-values");
  expect(steps[1]!.command.slice(-2)).toEqual(["--paths", "src/example.ts"]);
});
test("push checks commits, types and all sibling test variants, excluding browsers and deleted files", () => {
  const steps = plan("pre-push", ["src/example.ts", "src/deleted.test.ts"], context());
  expect(steps.find(step => step.name === "privacy")!.command).toContain("--check-commits");
  const tests = steps.find(step => step.name === "touched tests")!;
  expect(tests.command).toEqual(["bun", "test", "./src/example.test.ts", "./src/example.integration.test.ts"]);
  expect(tests.isolated).toBeTrue();
  for (const step of steps.filter(step => step.command[1] === "test")) for (const file of step.command.slice(2)) expect(file).toMatch(/\.test\.[jt]sx?$/);
});
test("scoped heavy steps retain pin, host interpreter and both native fixture versions", () => {
  const steps = plan("pre-push", ["package.json"], context({ linux: true, runtime: true, native: true }));
  expect(steps.some(step => step.name === "Linux backend")).toBeTrue();
  expect(steps.find(step => step.name === "Viewer build")!.pinned).toBeTrue();
  expect(steps.find(step => step.name === "runtime host")!.pinned).toBeTrue();
  expect(steps.filter(step => step.codex).map(step => step.codex)).toEqual(["0.154.0", "0.159.0"]);
  expect(steps.some(step => step.name === "supply chain")).toBeTrue();
  expect(plan("pre-push", ["src/example.ts"], context()).some(step => step.pinned)).toBeFalse();
});
test("media skipping is explicit and still checks commits when the whole diff is media", () => {
  const steps = plan("pre-push", ["image.png"], context({ skippedMedia: ["image.png"] }));
  const privacy = steps.find(step => step.name === "privacy")!.command;
  expect(privacy).not.toContain("image.png"); expect(privacy).toContain("--check-commits");
  expect(privacy.slice(-2)).toEqual(["--paths", "package.json"]);
});
test("state isolation replaces inherited roots and removes the live owner claim", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "gate-env-")); roots.push(sandbox);
  const env = isolatedEnvironment(sandbox, { GIT_DIR: "operator", GIT_INDEX_FILE: "operator", GIT_WORK_TREE: "operator", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", XDG_RUNTIME_DIR: sandbox, NODE_ENV: "test", HOME: "operator", LLV_STATE_DIR: "operator", LLV_STATE_OWNER: "viewer", LLV_INBOX_DIR: "operator" });
  for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR", "CODEX_HOME", "LLV_CLAUDE_HOME"]) {
    expect(env[key]).toStartWith(sandbox + path.sep); expect(existsSync(env[key]!)).toBeTrue();
  }
  expect(env.LLV_STATE_OWNER).toBeUndefined(); expect(env.LLV_INBOX_DIR).toBeUndefined();
  for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) expect(env[key]).toBeUndefined();
  expect(env.LLV_GATE_LOCK_DIR).toBe(path.join(sandbox, "delegatus-gate"));
});
test("scope uses executed import closure and the workflow test lists", () => {
  const doc = discover(root, "HEAD", ["CONTRIBUTING.md"]);
  expect([doc.linux, doc.runtime, doc.native]).toEqual([false, false, false]);
  const host = discover(root, "HEAD", ["src/runtime-host/main.ts"]);
  expect(host.runtime).toBeTrue();
  const native = discover(root, "HEAD", ["src/lib/runtime/nativeCodexQueue.ts"]);
  expect(native.native).toBeTrue();
  const linux = discover(root, "HEAD", ["src/lib/proc/index.ts"]);
  expect(linux.linux).toBe(process.platform === "linux");
  expect(linux.linuxTests).toContain("src/runtime-host/runtimeHostFence.test.ts");
  expect(host.runtimeTests).toContain("src/runtime-host/hostRehearsalRun.test.ts");
  expect(pinnedBunVersion("RUN npm install -g bun@1.4.0\nRUN npm install -g bun@1.4.0")).toBe("1.4.0");
  expect(() => pinnedBunVersion("bun@1.4.0")).toThrow();
  expect(() => pinnedBunVersion("npm install -g bun@1.4.0\nnpm install -g bun@1.3.3")).toThrow();
});

function hookFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "hooks-e2e-")); roots.push(dir);
  for (const leaf of [".githooks", "scripts", "shims", ".github/workflows"]) mkdirSync(path.join(dir, leaf), { recursive: true });
  for (const hook of ["pre-commit", "pre-push"]) copyFileSync(path.join(root, ".githooks", hook), path.join(dir, ".githooks", hook));
  symlinkSync(path.join(root, "scripts/local-gate.ts"), path.join(dir, "scripts/local-gate.ts"));
  for (const file of ["gate-slot.sh", "verify-native-codex-runtime.ts"]) copyFileSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  for (const file of ["platform-tests.yml", "bun-runtime.yml"]) copyFileSync(path.join(root, ".github/workflows", file), path.join(dir, ".github/workflows", file));
  const log = path.join(dir, "commands.jsonl");
  writeFileSync(path.join(dir, "record.ts"), `import { appendFileSync } from "node:fs"; appendFileSync(process.env.HOOK_LOG!, JSON.stringify({ args: process.argv.slice(2), state: process.env.LLV_STATE_DIR, home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, tmp: process.env.TMPDIR, known: process.env.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE, gitDir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE }) + "\\n"); if (process.env.HOOK_FAIL && process.argv.includes(process.env.HOOK_FAIL)) process.exit(19);`);
  for (const name of ["bun", "bunx"]) {
    const shim = path.join(dir, "shims", name);
    writeFileSync(shim, '#!/bin/bash\nif [[ "$1" == scripts/local-gate.ts ]]; then exec "$HOOK_BUN" "$@"; fi\nexec "$HOOK_BUN" "$HOOK_RECORD" "$@"\n'); chmodSync(shim, 0o755);
  }
  const env = { ...process.env, PATH: `${path.join(dir, "shims")}:${process.env.PATH}`, HOOK_LOG: log, HOOK_RECORD: path.join(dir, "record.ts"), HOOK_BUN: process.execPath, LLV_GATE_LOCK_DIR: dir, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "noreply@example.invalid", LLV_SKIP_HOOKS: "0" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null");
  writeFileSync(path.join(dir, "package.json"), "{}"); writeFileSync(path.join(dir, "example.ts"), "export const value = 1;\n");
  writeFileSync(path.join(dir, "example.test.ts"), "// hook fixture\n"); git("add", "."); git("commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD"); git("config", "core.hooksPath", ".githooks");
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; state?: string; home?: string; config?: string; tmp?: string; known?: string; gitDir?: string; index?: string });
  return { dir, env, git, calls };
}
test("real pre-commit hook checks staged source, stops failures, and supports the escape hatch", () => {
  const f = hookFixture(); writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n"); f.git("add", "example.ts");
  const failed = spawnSync("git", ["commit", "-m", "blocked"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "eslint" }, encoding: "utf8" });
  expect(failed.status).not.toBe(0);
  expect(f.calls().some(call => call.args.includes("--paths") && call.args.includes("example.ts") && call.known?.endsWith("privacy-known-value-fingerprints.json"))).toBeTrue();
  expect(f.calls().some(call => call.args.includes("--check-commits"))).toBeFalse();
  f.git("commit", "-m", "accepted");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 3;\n"); f.git("add", "example.ts");
  const skip = spawnSync("git", ["commit", "-m", "escape"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "eslint", LLV_SKIP_HOOKS: "1" } });
  expect(skip.status).toBe(0);
});
test("pre-push hook resolves an explicit base and runs named touched tests in a sandbox", () => {
  const f = hookFixture(); writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n"); f.git("add", "example.ts"); f.git("commit", "-m", "change");
  expect(changedSinceBase(f.dir, "origin/main")).toEqual(["example.ts"]);
  const remote = mkdtempSync(path.join(tmpdir(), "hook-remote-")); roots.push(remote);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  execFileSync("git", ["--git-dir", remote, "fetch", f.dir, "origin/main:main"], { stdio: "pipe" });
  f.git("remote", "add", "origin", remote);
  const result = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(result.status).toBe(0);
  const tests = f.calls().find(call => call.args[0] === "test")!;
  expect(tests.args).toEqual(["test", "./example.test.ts"]);
  expect(tests.gitDir).toBeUndefined(); expect(tests.index).toBeUndefined();
  for (const key of ["state", "home", "config", "tmp"] as const) expect(tests[key]).toContain("delegatus-local-gate-");
  expect(existsSync(tests.state!)).toBeFalse();
  expect(f.calls().some(call => call.args.includes("--check-commits"))).toBeTrue();
  const rejected = spawnSync("git", ["push", "origin", "HEAD:blocked"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "tsc" }, encoding: "utf8" });
  expect(rejected.status).not.toBe(0);
});

test("media deferral recognizes disguised raster magic without loading the privacy gate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-media-")); roots.push(dir);
  const disguised = path.join(dir, "capture.dat");
  writeFileSync(disguised, Buffer.from("89504e470d0a1a0a", "hex"));
  expect(requiresMediaTools(disguised)).toBeTrue();
  const text = path.join(dir, "note.md"); writeFileSync(text, "plain text");
  expect(requiresMediaTools(text)).toBeFalse();
});

test("the gate temp root cannot inherit a pipeline's operator scratch TMPDIR", () => {
  const original = process.env.TMPDIR;
  try {
    process.env.TMPDIR = path.join(tmpdir(), "operator-state", "scratch");
    expect(gateTemporaryRoot("linux")).toBe("/var/tmp");
    expect(gateTemporaryRoot("darwin")).toBe("/var/tmp");
  } finally {
    if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
  }
});
