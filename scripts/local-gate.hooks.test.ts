import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGateSandbox, discover, endingOf, gateTemporaryRoot, isolatedEnvironment, NoVerdict, plan, pushDeadline, requiresMediaTools, runPushPair, runSteps, SUPERVISOR_MARGIN_MS } from "./local-gate";
import { createHookFixture } from "./local-gate.fixture";
import { cpuWaitBudget } from "../src/lib/runtime/cpuAdmissionBudget";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import { changedSinceBase } from "./ci-platform-scope";
import { createGateTestFixtures } from "./gateTest.fixture";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
const { recordFixtureIdentities, context, stepRunner, grouped, soon } = createGateTestFixtures(roots, owned);
afterEach(async () => {
  for (const identity of owned.splice(0)) await stopFixtureIdentity(identity);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hookFixture(realLint = false, controlledClock = false) {
  return createHookFixture(root, roots, realLint, controlledClock);
}
test("repository default budgets follow current changes across fresh hook processes and retain an explicit caller cap", () => {
  const now = 1_900_000_000_000;
  const f = hookFixture(false, true);
  const directory = path.join(f.dir, "src/lib/pipelines"); mkdirSync(directory, { recursive: true });
  const modulePath = path.join(directory, "engine.ts");
  writeFileSync(modulePath, "export const value = 1;\n");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", "src/lib/pipelines/engine.ts", "example.ts"); f.git("commit", "-m", "engine change");
  const run = (caller?: string) => {
    const before = f.calls().length;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir,
      env: { ...f.env, LLV_GATE_PUSH_DEADLINE: caller }, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const calls = f.calls().slice(before);
    const types = calls.find(call => call.args[0] === "tsc")!;
    expect(types).toBeDefined();
    expect(types.now).toBe(now);
    const wait = Number(/publication checks CPU wait: (\d+) ms/.exec(result.stderr)![1]);
    // The fixed child clock has not advanced through real admission; remove
    // the measured queue interval when comparing the execution allowance.
    return { deadline: Number(types.deadline), ownedBudget: Number(types.ownedBudget) - wait };
  };
  // Each call starts a new real hook and admitted process.
  expect(run()).toEqual({ deadline: now + 1_440_000, ownedBudget: 1_440_000 + SUPERVISOR_MARGIN_MS });
  f.git("rm", "src/lib/pipelines/engine.ts"); f.git("commit", "-m", "retain ordinary change");
  expect(run()).toEqual({ deadline: now + 840_000, ownedBudget: 840_000 + SUPERVISOR_MARGIN_MS });
  mkdirSync(directory, { recursive: true });
  writeFileSync(modulePath, "export const value = 1;\n"); f.git("add", "src/lib/pipelines/engine.ts"); f.git("commit", "-m", "restore engine change");
  expect(run(String(now + 30_000))).toEqual({ deadline: now + 30_000, ownedBudget: 30_000 + SUPERVISOR_MARGIN_MS });
}, 120_000);

for (const mode of ["pre-commit", "pre-push"] as const) test(`${mode} allows KanbanBoard baseline errors and rejects one added error by file/line`, () => {
  const f = hookFixture(true);
  const file = "src/components/kanban/KanbanBoard.tsx";
  mkdirSync(path.dirname(path.join(f.dir, file)), { recursive: true });
  const source = readFileSync(path.join(root, file), "utf8");
  writeFileSync(path.join(f.dir, file), source);
  f.git("add", file);
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "Kanban baseline"], { cwd: f.dir, env: f.env });
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}`);
  f.git("add", file);
  const run = () => spawnSync("bash", [`.githooks/${mode}`], { cwd: f.dir, env: f.env, encoding: "utf8" });
  const accepted = run();
  expect(accepted.status).toBe(0);
  expect((accepted.stdout + accepted.stderr)).toContain("0 errors introduced by this change");
  expect((accepted.stdout + accepted.stderr)).toMatch(/[1-9]\d* errors already on the base in files with head errors \(not blocking\)/);
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}\nexport const addedLintError: any = 1;\n`);
  f.git("add", file);
  const refused = run();
  expect(refused.status).not.toBe(0);
  expect((refused.stdout + refused.stderr)).toContain("1 errors introduced by this change");
  expect(refused.stderr).toMatch(/src\/components\/kanban\/KanbanBoard\.tsx:\d+:\d+ @typescript-eslint\/no-explicit-any/);
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}`);
  f.git("add", file);
}, 120000);
test.each([false, true])("a pending merge admits published main lint errors and still blocks a new error (main advanced=%s)", advanced => {
  const f = hookFixture(true);
  const base = f.git("rev-parse", "HEAD").toString().trim();
  f.git("checkout", "-q", "-b", "lane");
  writeFileSync(path.join(f.dir, "lane.ts"), "export const lane = 1;\n");
  f.git("add", "lane.ts"); f.git("commit", "-m", "lane work");
  f.git("checkout", "-q", "main");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value: any = 1;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "published baseline");
  const incoming = f.git("rev-parse", "HEAD").toString().trim();
  if (advanced) {
    writeFileSync(path.join(f.dir, "example.ts"), "export const value = 1;\n");
    f.git("add", "example.ts"); f.git("commit", "-m", "later main cleanup");
  }
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("checkout", "-q", "lane");
  f.git("merge", "--no-ff", "--no-commit", incoming);
  const merged = spawnSync("git", ["commit", "-m", "merge published main"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(merged.status, merged.stdout + merged.stderr).toBe(0);
  expect(merged.stdout + merged.stderr).toContain("0 errors introduced by this change");
  expect(f.git("rev-parse", "HEAD^2").toString().trim()).toBe(incoming);
  expect(f.git("merge-base", "HEAD^1", incoming).toString().trim()).toBe(base);
  const accepted = f.git("rev-parse", "HEAD").toString().trim();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value: any = 1;\nexport const added: any = 2;\n");
  f.git("add", "example.ts");
  const refused = spawnSync("git", ["commit", "-m", "new lint error"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(refused.status).not.toBe(0);
  expect(refused.stdout + refused.stderr).toContain("errors introduced by this change");
  expect(f.git("rev-parse", "HEAD").toString().trim()).toBe(accepted);
}, 120_000);

test("a pending merge never treats an unpublished incoming lint error as a baseline", () => {
  const f = hookFixture(true);
  f.git("checkout", "-q", "-b", "incoming");
  writeFileSync(path.join(f.dir, "example.ts"), "export const added: any = 1;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "unpublished error");
  f.git("checkout", "-q", "main");
  writeFileSync(path.join(f.dir, "lane.ts"), "export const lane = 1;\n");
  f.git("add", "lane.ts"); f.git("commit", "-m", "local work");
  const before = f.git("rev-parse", "HEAD").toString().trim();
  f.git("merge", "--no-ff", "--no-commit", "incoming");
  const refused = spawnSync("git", ["commit", "-m", "merge unpublished error"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(refused.status).not.toBe(0);
  expect(refused.stdout + refused.stderr).toContain("1 errors introduced by this change");
  expect(f.git("rev-parse", "HEAD").toString().trim()).toBe(before);
}, 120_000);

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
  expect(result.status).toBe(0);
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
  expect(result.status).toBe(0);
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
  expect(result.status).toBe(0);
  expect(readFileSync(configPath)).toEqual(before);
  expect(f.calls().some(call => call.gitDir === undefined && call.index === undefined && call.workTree === undefined && call.commonDir === undefined && call.configCount === undefined && call.configKey === undefined)).toBeTrue();
}, 20_000);

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
test("a push that changes nothing checks every pushed commit for privacy and runs no types or tests", () => {
  // Lane branch N commits behind main, stage changed nothing: the diff against
  // the merge base is empty whatever main has become since.
  const steps = plan("pre-push", [], context({ linux: true, runtime: true, native: true }));
  expect(steps.map(step => step.name)).toEqual(["privacy"]);
  expect(steps[0]!.command).toEqual(["bun", "scripts/privacy-publication-gate.ts", "--base", "base", "--require-known-values", "--check-commits", "--added-lines", "--defer-unavailable-media"]);
  expect(discover(root, "HEAD", []).linux).toBeFalse();
});
test("a push that changes one document keeps privacy and leaves main's types and tests alone", () => {
  const existing = new Set(["docs/design/note.md"]);
  const steps = plan("pre-push", ["docs/design/note.md"], context({ existing }));
  expect(steps.map(step => step.name)).toEqual(["privacy"]);
  expect(steps[0]!.command).toContain("--check-commits");
  expect(discover(root, "HEAD", ["docs/design/note.md"]).linux).toBeFalse();
});
test("no changed code file skips types or its tests, alone or beside a document", () => {
  for (const files of [["src/example.ts"], ["docs/design/note.md", "src/example.ts"], ["src/example.test.ts"], ["package.json"], ["src/deleted.ts"]]) {
    const names = plan("pre-push", files, context({ existing: new Set([...context().existing, "docs/design/note.md"]) })).map(step => step.name);
    expect(names.slice(0, 2)).toEqual(files.includes("package.json") ? ["privacy", "frozen install"] : ["privacy", "types"]);
    expect(names).toContain("types");
    if (files.some(file => file.startsWith("src/example"))) expect(names).toContain("touched tests");
  }
});
test("platform tests are judged against the merge base, so a test main already fails never blocks", () => {
  const linux = plan("pre-push", ["src/example.ts"], context({ linux: true })).find(step => step.name === "Linux tests")!;
  expect(linux.command).toEqual(["bun", "scripts/local-gate-tests.ts", "--base", "base", "./src/platform.test.ts"]);
  expect(linux.isolated).toBeTrue();
});
test("gate checks never inherit the pushing Viewer's language, launcher handoff or token", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "gate-viewer-env-")); roots.push(sandbox);
  const env = isolatedEnvironment(sandbox, { NODE_ENV: "production", PATH: "/usr/bin", LLV_LANG: "uk", LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: "/checkout", LLV_TOKEN: "t", LLV_GATE_SLOTS: "2" });
  for (const key of ["LLV_LANG", "LLV_LAUNCHER_REEXEC", "LLV_LAUNCHER_CHECKOUT", "LLV_TOKEN"]) expect(env[key]).toBeUndefined();
  expect(env.LLV_GATE_SLOTS).toBe("2");
});
test("pre-push hook on a branch behind main that changed nothing runs privacy on the pushed commits and nothing else", () => {
  const f = hookFixture();
  const remote = mkdtempSync(path.join(tmpdir(), "hook-remote-")); roots.push(remote);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe", env: f.env });
  f.git("remote", "add", "origin", remote);
  f.git("checkout", "-q", "-b", "lane");
  f.git("checkout", "-q", "main");
  for (const value of [2, 3]) { writeFileSync(path.join(f.dir, "example.ts"), `export const value = ${value};\n`); f.git("add", "example.ts"); f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", `main ${value}`); }
  f.git("-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "main"); f.git("fetch", "-q", "origin", "main");
  f.git("checkout", "-q", "lane");
  expect(f.git("rev-list", "--count", "HEAD..origin/main").toString().trim()).toBe("2");
  // A types or test step would fail here: the recorder refuses tsc.
  const result = spawnSync("git", ["push", "origin", "HEAD:refs/heads/lane"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "tsc" }, encoding: "utf8" });
  expect(result.stderr).toContain("pre-push: branch is 2 commit(s) behind origin/main");
  expect(result.stderr).toContain("pre-push: nothing changed since");
  expect(result.status).toBe(0);
  const calls = f.calls();
  expect(calls.map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
  expect(calls[0]!.args).toContain("--check-commits");
  expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/lane"], { encoding: "utf8", env: f.env }).trim()).toBe(f.git("rev-parse", "HEAD").toString().trim());
});

test("pre-commit lint admits only selections larger than forty files", () => {
  for (const count of [40, 41]) {
    const files = Array.from({ length: count }, (_, i) => `src/fixture-${i}.ts`);
    const steps = plan("pre-commit", files, context({ existing: new Set(files) }));
    expect(steps.find(step => step.name === "eslint")!.capped).toBe(count > 40);
  }
});

test("local runtime scope is Dockerfile, runtime host and bin, including deleted inputs", () => {
  for (const file of ["Dockerfile", "src/runtime-host/example.ts", "bin/example.mjs"]) {
    const env = discover(root, "HEAD", [file]);
    expect(env.runtime).toBeTrue(); expect(env.native).toBeTrue();
  }
  for (const file of ["src/lib/pipelines/engine.ts", "package.json", "next.config.ts"]) {
    const env = discover(root, "HEAD", [file]);
    expect(env.runtime).toBeFalse(); expect(env.native).toBeFalse();
  }
});

test("push lanes overlap while preserving order within each lane", async () => {
  const runner = stepRunner(null, dir => ({
    a: `touch '${dir}/a'; while [ ! -f '${dir}/b' ]; do sleep 0.02; done`,
    b: `touch '${dir}/b'; while [ ! -f '${dir}/a' ]; do sleep 0.02; done`,
    next: `test -f '${dir}/a' && test -f '${dir}/b'`,
  }));
  expect(await runner.run([
    { ...grouped("a"), lane: "types" },
    { ...grouped("next"), lane: "types" },
    { ...grouped("b"), lane: "tests" },
  ])).toBeNull();
}, 15_000);

test("a red lane cancels its peer and never starts its next step", async () => {
  const runner = stepRunner(null, dir => ({ bad: "exit 1", peer: "sleep 60", next: `touch '${dir}/next'` }));
  const started = Date.now();
  const error = await runner.run([
    { ...grouped("bad"), lane: "tests" },
    { ...grouped("peer"), lane: "types" },
    { ...grouped("next"), lane: "types" },
  ]);
  expect((error as Error).message).toContain('"bad" failed');
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(existsSync(path.join(runner.dir, "next"))).toBeFalse();
});

test.skipIf(process.platform !== "linux")("a real push takes one queue ticket and nested capped steps reuse its slot", () => {
  const f = hookFixture();
  const slot = path.join(f.dir, "scripts/gate-slot.sh");
  writeFileSync(slot, readFileSync(slot, "utf8").replace('queue_key="command:$$:$RANDOM:$RANDOM"', 'queue_key="command:$$:$RANDOM:$RANDOM"\nprintf "%s\\n" "$queue_key" >> "$QUEUE_PROBE"'));
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  const env: NodeJS.ProcessEnv = { ...f.env, DELEGATUS_CPU_PRESSURE: "off", QUEUE_PROBE: path.join(f.dir, "queue-probe") };
  delete env.LLV_GATE_SLOT_LEASE;
  const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(env.QUEUE_PROBE!, "utf8").trim().split("\n")).toHaveLength(1);
  const calls = f.calls();
  expect(calls.some(call => call.args.includes("tsc"))).toBeTrue();
  expect(calls.some(call => call.args.includes("scripts/eslint-changes.ts"))).toBeTrue();
  expect(calls.some(call => call.args.includes("scripts/local-gate-tests.ts"))).toBeTrue();
}, 20_000);

for (const failed of ["privacy", "checks"] as const) test(`publication refuses ${failed} after its peer passes`, async () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  const record = path.join(f.dir, "record.ts");
  const source = readFileSync(record, "utf8");
  writeFileSync(record, source + `
const privacy = process.argv.includes("scripts/privacy-publication-gate.ts");
const selected = ${JSON.stringify(failed)} === "privacy" ? privacy : process.argv.includes("tsc");
if (selected) {
  const until = Date.now() + 10000;
  while (!require("node:fs").existsSync(process.env.PEER_PASSED!)) {
    if (Date.now() > until) throw new Error("peer did not pass");
    await Bun.sleep(10);
  }
  process.exit(19);
}
if (${JSON.stringify(failed)} === "privacy" ? process.argv.includes("scripts/local-gate-tests.ts") : privacy)
  require("node:fs").writeFileSync(process.env.PEER_PASSED!, "passed");
`);
  const passed = path.join(f.dir, "peer-passed");
  const child = Bun.spawn({ cmd: ["bash", ".githooks/pre-push"], cwd: f.dir, env: { ...f.env, PEER_PASSED: passed }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(existsSync(passed)).toBeTrue();
  expect(stdout + stderr).toContain(failed === "privacy" ? "pre-push: bun failed (19); gate failed" : 'pre-push: "types" failed: 19; gate failed');
}, 20000);

test("privacy refusal stops running admitted checks and their detached helper", async () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  const record = path.join(f.dir, "record.ts");
  const observed = path.join(f.dir, "identities-observed");
  writeFileSync(record, readFileSync(record, "utf8") + `
const fs = require("node:fs");
if (process.argv.includes("tsc")) {
  const helper = require("node:child_process").spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  helper.unref();
  fs.writeFileSync(process.env.CHECK_PID!, String(process.pid));
  fs.writeFileSync(process.env.HELPER_PID!, String(helper.pid));
  await Bun.sleep(60000);
}
if (process.argv.includes("scripts/privacy-publication-gate.ts")) {
  while (!fs.existsSync(${JSON.stringify(observed)})) await Bun.sleep(10);
  process.exit(19);
}
`);
  const check = path.join(f.dir, "check.pid"), helper = path.join(f.dir, "helper.pid");
  const child = Bun.spawn({ cmd: ["bash", ".githooks/pre-push"], cwd: f.dir, env: { ...f.env, CHECK_PID: check, HELPER_PID: helper }, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let identities: ProcessIdentity[] = [];
  try {
    identities = await recordFixtureIdentities([check, helper]);
  } finally {
    writeFileSync(observed, "observed\n");
    await child.exited;
    await output;
  }
  expect(await child.exited).toBe(1);
  expect((await output).join("")).toContain("pre-push: bun failed (19); gate failed");
  for (const identity of identities) expect(processIdentityStatus(identity)).toBe("dead");
}, 20000);

for (const slow of ["privacy", "checks"] as const) test(`a ${slow} deadline preserves its missing-verdict refusal after its peer passes`, async () => {
  const runner = stepRunner(soon(500), () => ({ slow: "sleep 60", pass: "exit 0" }));
  const missing = slow === "privacy" ? { name: "privacy", command: [] } : { name: "types", command: [] };
  let passed = false;
  const passing = async () => { passed = true; };
  const timed = (cancel: AbortSignal) => runSteps("pre-push", [missing], {
    root, deadline: soon(500), logDir: runner.dir, say: () => {}, cancel,
    prepare: () => ({ command: ["bash", "-c", "sleep 60"], env: process.env }),
  });
  const error = await runPushPair(slow === "privacy" ? timed : passing, slow === "checks" ? timed : passing).then(() => null, (error: unknown) => error);
  expect(passed).toBeTrue();
  expect(error).toBeInstanceOf(NoVerdict);
  expect(endingOf("pre-push", error)).toMatchObject({ code: 75 });
  expect(endingOf("pre-push", error).line).toContain(`"${missing.name}" was still running`);
}, 15000);


for (const code of ["EROFS", "EACCES", "ENOENT"]) {
  test(`controller gate creation falls back from an unavailable /var/tmp (${code}) without using inherited scratch`, () => {
    const original = process.env.TMPDIR;
    const sandboxRecord = process.env.LLV_GATE_SANDBOX_RECORD;
    delete process.env.LLV_GATE_SANDBOX_RECORD;
    const calls: string[] = [];
    try {
      process.env.TMPDIR = "/operator-installation/state/scratch";
      const created = createGateSandbox("linux", prefix => {
        calls.push(prefix);
        if (calls.length === 1) throw Object.assign(new Error("unavailable preferred root"), { code });
        return `${prefix}fixture`;
      });
      expect(calls).toEqual([path.join("/var/tmp", "delegatus-local-gate-"), path.join("/tmp", "delegatus-local-gate-")]);
      expect(created).toBe(`${calls[1]}fixture`);
    } finally {
      if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
      if (sandboxRecord !== undefined) process.env.LLV_GATE_SANDBOX_RECORD = sandboxRecord;
    }
  });
}

test("gate creation preserves unrelated filesystem failures and a refused fallback", () => {
  for (const code of ["EIO", "ENOSPC"]) {
    const error = Object.assign(new Error("storage failure"), { code });
    let calls = 0;
    expect(() => createGateSandbox("linux", () => { calls++; throw error; })).toThrow(error);
    expect(calls).toBe(1);
  }
  const fallback = Object.assign(new Error("fallback denied"), { code: "EACCES" });
  let calls = 0;
  expect(() => createGateSandbox("linux", () => {
    if (++calls === 1) throw Object.assign(new Error("read-only preferred root"), { code: "EROFS" });
    throw fallback;
  })).toThrow(fallback);
  expect(calls).toBe(2);
  calls = 0;
  expect(() => createGateSandbox("win32", () => { calls++; throw fallback; })).toThrow(fallback);
  expect(calls).toBe(1);
});

test("the admitted hook credits its caller's completed admission instead of the supervisor's new ledger", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  const directory = JSON.parse(budget.env.LLV_CPU_WAIT_ROOTS!).at(-1);
  try {
    writeFileSync(path.join(directory, "wait.json"), JSON.stringify({ start: 100, end: 500 }));
    const env = { LLV_GATE_PUSH_DEADLINE: "1000", LLV_GATE_ADMISSION_WAIT_ROOTS: budget.env.LLV_CPU_WAIT_ROOTS };
    expect(pushDeadline(env, 1100, true)).toEqual({ at: 1400, startedAt: 1100 });
    expect(pushDeadline(env, 1100)).toEqual({ at: 1000, startedAt: 1100 });
  } finally { budget.close(); }
});

test("shared gate cache and hook fixture changes select every verification consumer", () => {
  const tests = ["scripts/local-gate.test.ts", "scripts/local-gate.hooks.test.ts", "scripts/local-gate.publication.test.ts", "scripts/local-gate.transport.test.ts", "scripts/local-gate.receipts.test.ts", "scripts/local-gate-tests.test.ts", "scripts/eslint-changes.test.ts", "scripts/gate-cache.test.ts"];
  for (const file of ["scripts/gate-cache.ts", "scripts/local-gate.fixture.ts", "scripts/gateTest.fixture.ts", "scripts/publicationHook.fixture.ts"]) {
    const steps = plan("pre-push", [file], context({ existing: new Set([file]), tests }));
    expect(steps.find(step => step.name === "touched tests")?.command.slice(4)).toEqual(tests.map(test => `./${test}`));
  }
});


test("a deadline-killed gate removes the exact sandbox recorded by its creator", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gate-record-fixture-")); roots.push(directory);
  const env = isolatedEnvironment(directory, process.env);
  delete env.LLV_GATE_SANDBOX_RECORD;
  env.LLV_OWNED_RUN_TIMEOUT_MS = "3000";
  const marker = path.join(directory, "created.json");
  const script = path.join(directory, "allocate.ts");
  writeFileSync(script, `import { createGateSandbox } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
    import fs from "node:fs"; import path from "node:path";
    const directory = createGateSandbox(process.platform, prefix => fs.mkdtempSync(path.join(process.env.TMPDIR!, path.basename(prefix))));
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({directory}));
    setInterval(() => {}, 1000); await new Promise(() => {});`);
  const child = Bun.spawn([process.execPath, path.join(root, "scripts/owned-runner.ts"), "--portable", process.execPath, script],
    { env, stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, error, code }).toMatchObject({ code: 124 });
  const created = JSON.parse(readFileSync(marker, "utf8")).directory;
  expect(existsSync(created)).toBeFalse();
}, 20_000);


test.skipIf(process.platform !== "linux")("the real unadmitted hook owns its sandbox before a deadline", async () => {
  const f = createHookFixture(root, roots);
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n"); f.git("add", "example.ts");
  const env = isolatedEnvironment(path.join(f.dir, "isolated"), f.env);
  delete env.LLV_GATE_SANDBOX_RECORD;
  env.LLV_OWNED_RUN_TIMEOUT_MS = "10000";
  const marker = path.join(f.dir, "phase.pid"), allocation = path.join(f.dir, "allocation.json"), recorder = path.join(f.dir, "record.ts");
  const preload = path.join(f.dir, "observe-allocation.ts");
  writeFileSync(preload, `import fs from "node:fs"; import path from "node:path"; import {mock} from "bun:test";
    const allocate=fs.mkdtempSync;
    mock.module("node:fs",()=>({...fs,default:fs,mkdtempSync:(prefix,options)=>{const directory=allocate(prefix,options);
      if(path.basename(String(prefix))==="delegatus-local-gate-") fs.writeFileSync(${JSON.stringify(allocation)},JSON.stringify(directory));
      return directory;}}));`);
  writeFileSync(recorder, readFileSync(recorder, "utf8") + `\n(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {});`);
  const child = Bun.spawn([process.execPath, "--preload", preload, path.join(root, "scripts/local-gate.ts"), "pre-commit"],
    { cwd: f.dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  owned.push(captureProcessIdentity(child.pid));
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [phase] = await recordFixtureIdentities([marker], 8000);
    const created = JSON.parse(readFileSync(allocation, "utf8"));
    expect(path.basename(created)).toStartWith("delegatus-local-gate-"); roots.push(created);
    const code = await Promise.race([child.exited, new Promise<number>(resolve => {
      timer = setTimeout(() => { child.kill("SIGTERM"); resolve(143); }, 18000);
    })]);
    await stopFixtureIdentity(phase!);
    const [out, error] = await output;
    expect(code, out + error).not.toBe(0);
    expect(existsSync(created)).toBeFalse();
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}, 35_000);

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
