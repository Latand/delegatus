import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { checkAttemptTmpBudget } from "./attempt-tmp-budget";
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
