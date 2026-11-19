import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { checkAttemptTmpBudget, recordAttemptTmpAllocation } from "./attempt-tmp-budget";
import { checkEnvironment } from "./gate-cache";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-budget-")); roots.push(root);
  fs.mkdirSync(path.join(root, "tmp"));
  const stat = fs.statSync(root);
  return { root, env: { ...process.env, LLV_ATTEMPT_TIMING_ROOT: root, LLV_ATTEMPT_TIMING_ROOT_IDENTITY: `${stat.dev}:${stat.ino}`, LLV_ATTEMPT_TMP_MAX_BYTES: String(1024 ** 2) } };
}

test("shared dependency links do not spend the attempt budget and near-limit allocation warns", () => {
  const f = fixture(), external = path.join(f.root, "dependencies"); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "package"), Buffer.alloc(2 * 1024 ** 2, 1));
  fs.symlinkSync(external, path.join(f.root, "tmp/node_modules"));
  const bytes = checkAttemptTmpBudget(f.env)!;
  expect(bytes).toBeLessThan(1024 ** 2);
  const warnings: string[] = [];
  checkAttemptTmpBudget({ ...f.env, LLV_ATTEMPT_TMP_MAX_BYTES: String(bytes) }, message => warnings.push(message));
  expect(warnings[0]).toContain("90%");
});

test("exceeding the cap refuses across real process restarts and survives gate environment isolation", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "tmp/payload"), Buffer.alloc(2 * 1024 ** 2, 1));
  const env = checkEnvironment(f.env);
  for (let round = 0; round < 2; round++) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "attempt-tmp-budget.ts")], { env, encoding: "utf8" });
    expect(result.status).toBe(73);
    expect(result.stderr).toContain("Refusing another check/export");
    expect(result.stderr).toContain("1048576 bytes");
  }
  const observed = path.join(f.root, "ran");
  const result = spawnSync(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(observed)}, 'ran')`], { env, encoding: "utf8" });
  expect(result.status).toBe(73); expect(fs.existsSync(observed)).toBeFalse();
});

test("a remote gate refuses before SSH, capture or local fallback when the attempt is full", () => {
  const f = fixture(), decision = path.join(f.root, "decision"), contacted = path.join(f.root, "contacted");
  fs.writeFileSync(path.join(f.root, "tmp/payload"), Buffer.alloc(2 * 1024 ** 2, 1));
  const bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ssh"), '#!/bin/sh\ntouch "$FIXTURE_SSH_CONTACTED"\nexit 99\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(import.meta.dir, "gate-runner/client.ts"), "bun", "test", "./unused.test.ts"], {
    cwd: path.join(f.root, "tmp"), encoding: "utf8",
    env: { ...f.env, NODE_ENV: "development", LLV_GATE_RUNNER: "fixture-runner", LLV_GATE_RUNNER_DECISION: decision,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, FIXTURE_SSH_CONTACTED: contacted },
  });
  expect(result.status).toBe(73);
  expect(result.stderr).toContain("Refusing another check/export");
  expect(fs.existsSync(decision)).toBeFalse();
  expect(fs.existsSync(contacted)).toBeFalse();
  expect(fs.readdirSync(path.join(f.root, "tmp"))).toEqual(["payload"]);
});

test.each(["0", "-1", "garbage"])("invalid cap %s is an explicit refusal", cap => {
  const f = fixture();
  expect(() => checkAttemptTmpBudget({ ...f.env, LLV_ATTEMPT_TMP_MAX_BYTES: cap })).toThrow("positive integer");
});

test("changed root identity and symlink tmp refuse rather than measure another owner", () => {
  const f = fixture();
  expect(() => checkAttemptTmpBudget({ ...f.env, LLV_ATTEMPT_TIMING_ROOT_IDENTITY: "0:0" })).toThrow("identity changed");
  fs.rmSync(path.join(f.root, "tmp"), { recursive: true }); fs.symlinkSync(f.root, path.join(f.root, "tmp"));
  expect(() => checkAttemptTmpBudget(f.env)).toThrow("owned directory");
});

test.each([false, true])("production gate allocations remain charged after nested isolation and restart (fallback=%s)", fallback => {
  const f = fixture(), script = path.join(f.root, "allocate.ts"), outside = path.join(f.root, "external-gate-");
  fs.writeFileSync(script, `
    import fs from "node:fs"; import path from "node:path";
    import { createGateSandbox, isolatedEnvironment } from ${JSON.stringify(path.join(import.meta.dir, "local-gate.ts"))};
    let calls = 0;
    const sandbox = createGateSandbox("linux", prefix => {
      const expected = ++calls === 1 ? "/var/tmp" : "/tmp";
      if (path.dirname(prefix) !== expected) throw new Error("incorrect production placement");
      if (${fallback} && calls === 1) throw Object.assign(new Error("read-only"), { code: "EROFS" });
      return fs.mkdtempSync(${JSON.stringify(outside)});
    });
    const first = isolatedEnvironment(sandbox, process.env);
    const nested = isolatedEnvironment(path.join(first.TMPDIR!, "nested"), first);
    fs.writeFileSync(path.join(nested.TMPDIR!, "payload"), Buffer.alloc(2 * 1024 ** 2, 1));
    fs.writeFileSync(path.join(nested.HOME!, "cache"), Buffer.alloc(1024 ** 2, 1));
    fs.writeFileSync(${JSON.stringify(path.join(f.root, "environment.json"))}, JSON.stringify(nested));
  `);
  const allocationEnv: NodeJS.ProcessEnv = { ...f.env, NODE_ENV: "production" };
  delete allocationEnv.LLV_GATE_SANDBOX_RECORD;
  const allocation = spawnSync(process.execPath, [script], { env: allocationEnv, encoding: "utf8" });
  expect({ code: allocation.status, error: allocation.stderr }).toMatchObject({ code: 0 });
  const nested = checkEnvironment(JSON.parse(fs.readFileSync(path.join(f.root, "environment.json"), "utf8")));
  const warnings: string[] = [];
  expect(checkAttemptTmpBudget({ ...nested, LLV_ATTEMPT_TMP_MAX_BYTES: String(3.3 * 1024 ** 2 | 0) }, message => warnings.push(message))).toBeGreaterThan(3 * 1024 ** 2);
  expect(warnings[0]).toContain("90%");
  const marker = path.join(f.root, "should-not-run");
  for (let round = 0; round < 2; round++) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { env: nested, encoding: "utf8" });
    expect(result.status).toBe(73);
    expect(result.stderr).toContain("Refusing another check/export");
    expect(fs.existsSync(marker)).toBeFalse();
  }
});

test("external allocations deduplicate parents and hardlinks, survive re-registration and retire after cleanup", () => {
  const f = fixture(), external = path.join(f.root, "external"); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "payload"), Buffer.alloc(2 * 1024 ** 2, 1));
  fs.linkSync(path.join(external, "payload"), path.join(f.root, "tmp/link"));
  const child = path.join(external, "nested"); fs.mkdirSync(child);
  recordAttemptTmpAllocation(child, f.env);
  recordAttemptTmpAllocation(external, f.env);
  recordAttemptTmpAllocation(external, f.env);
  const env = { ...f.env, LLV_ATTEMPT_TMP_MAX_BYTES: String(4 * 1024 ** 2) };
  const bytes = checkAttemptTmpBudget(env)!;
  expect(bytes).toBeGreaterThan(2 * 1024 ** 2);
  expect(bytes).toBeLessThan(3 * 1024 ** 2);
  fs.rmSync(external, { recursive: true });
  expect(checkAttemptTmpBudget(env)).toBeLessThanOrEqual(bytes);
});

test.each(["symlink", "directory", "invalid journal"])("external allocation %s is an explicit refusal", replacement => {
  const f = fixture(), external = path.join(f.root, "external"); fs.mkdirSync(external);
  recordAttemptTmpAllocation(external, f.env);
  if (replacement === "invalid journal") fs.writeFileSync(path.join(f.root, "attempt-tmp-sandboxes.ndjson"), '{"directory":4}\n');
  else {
    fs.renameSync(external, external + "-saved");
    if (replacement === "symlink") fs.symlinkSync(external + "-saved", external);
    else fs.mkdirSync(external);
  }
  expect(() => checkAttemptTmpBudget(f.env)).toThrow(replacement === "invalid journal" ? "invalid sandbox allocation journal" : "sandbox identity changed");
});

test("allocation registration validates the attempt and journal before writing", () => {
  const f = fixture(), external = path.join(f.root, "external"); fs.mkdirSync(external);
  expect(() => recordAttemptTmpAllocation(external, { ...f.env, LLV_ATTEMPT_TIMING_ROOT_IDENTITY: "0:0" })).toThrow("identity changed");
  fs.symlinkSync(path.join(f.root, "untouched"), path.join(f.root, "attempt-tmp-sandboxes.ndjson"));
  expect(() => recordAttemptTmpAllocation(external, f.env)).toThrow("invalid sandbox allocation journal");
  expect(fs.existsSync(path.join(f.root, "untouched"))).toBeFalse();
});
