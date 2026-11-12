import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGateSandbox, discover, gateTemporaryRoot, isolatedEnvironment, plan, pushDeadline, requiresMediaTools, SUPERVISOR_MARGIN_MS } from "./local-gate";
import { createHookFixture } from "./local-gate.fixture";
import { cpuWaitBudget } from "../src/lib/runtime/cpuAdmissionBudget";
import { type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import { createGateTestFixtures } from "./gateTest.fixture";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
const { context, stepRunner, grouped } = createGateTestFixtures(roots, owned);
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
  const tests = ["scripts/local-gate.test.ts", "scripts/local-gate.hooks.test.ts", "scripts/local-gate.hooks.lint.test.ts", "scripts/local-gate.hooks.transport.test.ts", "scripts/local-gate.hooks.lifecycle.test.ts", "scripts/local-gate.publication.test.ts", "scripts/local-gate.publication.native.test.ts", "scripts/local-gate.publication.privacy.test.ts", "scripts/local-gate.publication.drift.test.ts", "scripts/local-gate.transport.test.ts", "scripts/local-gate.receipts.test.ts", "scripts/local-gate-tests.test.ts", "scripts/eslint-changes.test.ts", "scripts/gate-cache.test.ts"];
  for (const file of ["scripts/gate-cache.ts", "scripts/local-gate.fixture.ts", "scripts/gateTest.fixture.ts", "scripts/publicationHook.fixture.ts"]) {
    const steps = plan("pre-push", [file], context({ existing: new Set([file]), tests }));
    expect(steps.find(step => step.name === "touched tests")?.command.slice(4)).toEqual(tests.map(test => `./${test}`));
  }
});
