import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHookFixture } from "./local-gate.fixture";
import { passStore, stepPasses, type Step } from "./local-gate";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const hookFixture = () => createHookFixture(root, roots);

test("hook receipts invalidate base, tool and environment drift, and malformed records", () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, ".gitignore"), "commands.jsonl\nadmission.sqlite*\nllv-heavy-gate.*\nbudget-*/\n");
  f.git("add", ".gitignore"); f.git("commit", "-m", "intermediate base");
  const nextBase = f.git("rev-parse", "HEAD").toString().trim();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "change");
  const run = (extra: Partial<NodeJS.ProcessEnv> = {}) => {
    const before = f.calls().length;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: { ...f.env, LANG: "C", ...extra }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return f.calls().slice(before).some(call => call.args[0] === "tsc");
  };
  expect(run()).toBeTrue(); expect(run()).toBeFalse();
  f.git("update-ref", "refs/remotes/origin/main", nextBase);
  expect(run()).toBeTrue(); expect(run()).toBeFalse();
  expect(run({ NODE_OPTIONS: "--stack-trace-limit=25" })).toBeTrue();
  expect(run({ LANG: "uk_UA.UTF-8" })).toBeTrue();
  expect(run({ LANG: "uk_UA.UTF-8" })).toBeFalse();
  expect(run({ LANG: "C.UTF-8" })).toBeTrue();
  // An endpoint that never reaches a check cannot separate two runs.
  expect(run({ LANG: "C.UTF-8", LLV_VIEWER_PORT: "8001" })).toBeFalse();
  const directory = path.join(f.dir, ".git/delegatus-gate/passes");
  for (const file of readdirSync(directory)) writeFileSync(path.join(directory, file), "incomplete record");
  expect(run()).toBeTrue();
  // Installed compiler metadata is part of the toolchain even on one tree.
  mkdirSync(path.join(f.dir, "node_modules/typescript"), { recursive: true });
  writeFileSync(path.join(f.dir, "node_modules/typescript/package.json"), '{"version":"changed"}');
  // This fixture keeps generated dependencies ignored, as the real checkout does.
  mkdirSync(path.join(f.dir, ".git/info"), { recursive: true });
  writeFileSync(path.join(f.dir, ".git/info/exclude"), "node_modules/\n");
  expect(run()).toBeTrue();
}, 120_000);

test("a pass is reused across gate admissions in one signal boundary, never across host epochs", () => {
  const f = hookFixture();
  const base = f.git("rev-parse", "origin/main").toString().trim();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "change");
  const step: Step = { name: "types", command: ["bunx", "tsc", "--noEmit"] };
  const env = (service: number, hostEpoch = "linux:boot-a:pidns:pid:[1]") => ({ ...f.env, LLV_SIGNAL_SANDBOX: JSON.stringify({ policyVersion: 1, hostEpoch,
    scope: "/agent.scope", gate: { cgroup: `/gate.slice/delegatus-gate-${service}.service`, entry: `${service}:1` } }) });
  stepPasses(f.dir, base, [step], () => {}, env(1)).passed(step);
  expect(stepPasses(f.dir, base, [step], () => {}, env(2)).reused(step)).toBeTrue();
  expect(stepPasses(f.dir, base, [step], () => {}, env(2, "linux:boot-b:pidns:pid:[1]")).reused(step)).toBeFalse();
});

test("a pass outlasts the passes other lanes of the repository record before the next push", () => {
  const f = hookFixture();
  const base = f.git("rev-parse", "origin/main").toString().trim();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "change");
  const step: Step = { name: "types", command: ["bunx", "tsc", "--noEmit"] };
  stepPasses(f.dir, base, [step], () => {}, f.env).passed(step);
  // Two days of pushes by other lanes, each a different tree.
  const others = passStore(f.dir);
  for (let index = 0; index < 400; index++) others.write(`other lane step ${index}`, { at: new Date().toISOString() });
  expect(stepPasses(f.dir, base, [step], () => {}, f.env).reused(step)).toBeTrue();
});
