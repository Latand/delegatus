import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentEnvironments, createHookFixture } from "./local-gate.fixture";
import { pipelinePublicationHookEnv } from "../src/lib/pipelines/git";
import { NoVerdict, runSteps, stepPasses, type Step } from "./local-gate";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const hookFixture = () => createHookFixture(root, roots);

test("prose-only skips name their reason and a subsequent code change runs the checks", () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, "notes.md"), "A documentation change.\n");
  f.git("add", "notes.md"); f.git("commit", "-m", "documentation");
  const run = () => {
    const before = f.calls().length;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: f.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return { output: result.stderr, calls: f.calls().slice(before) };
  };
  const prose = run();
  expect(prose.output).toContain("prose-only diff; types, lint and touched tests skipped");
  expect(prose.calls.some(call => call.args[0] === "tsc")).toBeFalse();
  expect(prose.calls.some(call => call.args[0] === "scripts/eslint-changes.ts")).toBeFalse();
  expect(prose.calls.some(call => call.args[0] === "scripts/local-gate-tests.ts")).toBeFalse();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "code change");
  const code = run();
  expect(code.output).not.toContain("prose-only diff");
  for (const command of ["tsc", "scripts/eslint-changes.ts", "scripts/local-gate-tests.ts"])
    expect(code.calls.some(call => call.args[0] === command), command).toBeTrue();
}, 60_000);

test("identical clean hook processes reuse passed checks, while privacy and supply chain stay fresh", () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, ".gitignore"), "commands.jsonl\nadmission.sqlite*\nllv-heavy-gate.*\nbudget-*/\n");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", ".gitignore", "example.ts"); f.git("commit", "-m", "change");
  const run = () => {
    const before = f.calls().length;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: f.env, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return { calls: f.calls().slice(before), output: result.stderr };
  };
  const first = run(); expect(first.calls.some(c => c.args[0] === "tsc")).toBeTrue();
  const again = run();
  expect(again.calls.some(c => c.args[0] === "tsc"), again.output).toBeFalse();
  expect(again.calls.some(c => c.args[0] === "scripts/eslint-changes.ts")).toBeFalse();
  expect(again.calls.some(c => c.args[0] === "scripts/local-gate-tests.ts")).toBeFalse();
  expect(again.calls.some(c => c.args[0] === "scripts/privacy-publication-gate.ts")).toBeTrue();
  expect(again.output).toContain("reused pass");
  // Dirty staged, unstaged and new files never read or create receipts.
  for (const kind of ["unstaged", "staged", "untracked"]) {
    const file = kind === "untracked" ? "another.ts" : "example.ts";
    writeFileSync(path.join(f.dir, file), "export const value = 3;\n");
    if (kind === "staged") f.git("add", file);
    expect(run().calls.some(c => c.args[0] === "tsc"), kind).toBeTrue();
    if (kind === "untracked") rmSync(path.join(f.dir, file));
    else f.git("restore", "--staged", "--worktree", file);
  }
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    f.git("update-index", `--${flag}`, "example.ts");
    expect(run().calls.some(c => c.args[0] === "tsc"), flag).toBeTrue();
    f.git("update-index", `--no-${flag}`, "example.ts");
  }
  // Ignored compiler inputs still affect a clean Git tree.
  const ignored = path.join(f.dir, ".git/info/exclude");
  mkdirSync(path.dirname(ignored), { recursive: true });
  writeFileSync(ignored, "next-env.d.ts\n");
  writeFileSync(path.join(f.dir, "next-env.d.ts"), "declare const generated: true;\n");
  expect(run().calls.some(c => c.args[0] === "tsc")).toBeTrue();
  writeFileSync(path.join(f.dir, "next-env.d.ts"), "declare const generated: false;\n");
  expect(run().calls.some(c => c.args[0] === "tsc")).toBeTrue();
  // A different tree with exactly the same selected paths runs all checks.
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 4;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "another change");
  expect(run().calls.some(c => c.args[0] === "tsc")).toBeTrue();
}, 120_000);


test("hook receipts invalidate base, tool and environment drift, and malformed records", () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, ".gitignore"), "commands.jsonl\nadmission.sqlite*\nllv-heavy-gate.*\nbudget-*/\n");
  f.git("add", ".gitignore"); f.git("commit", "-m", "intermediate base");
  const nextBase = f.git("rev-parse", "HEAD").toString().trim();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "change");
  const run = (extra: Partial<NodeJS.ProcessEnv> = {}) => {
    const before = f.calls().length;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: { ...f.env, ...extra }, encoding: "utf8" });
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

test("a failed hook step is run again on retry", () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, ".gitignore"), "commands.jsonl\nadmission.sqlite*\nllv-heavy-gate.*\nbudget-*/\n");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", ".gitignore", "example.ts"); f.git("commit", "-m", "change");
  const failed = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "tsc" }, encoding: "utf8" });
  expect(failed.status).not.toBe(0);
  const before = f.calls().length;
  const again = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(again.status, again.stderr).toBe(0);
  expect(f.calls().slice(before).some(call => call.args[0] === "tsc")).toBeTrue();
}, 120_000);


test("stopped, deferred, cancelled and failed steps never write a pass; the runtime chain reuses as a unit", async () => {
  const f = hookFixture();
  const base = f.git("rev-parse", "origin/main").toString().trim();
  const step: Step = { name: "types", command: ["bunx", "tsc", "--noEmit"] };
  const open = (steps = [step]) => stepPasses(f.dir, base, steps, () => {});
  const options = { root: f.dir, logDir: f.dir, say: () => {}, prepare: () => ({ env: f.env, command: [process.execPath, "-e", "process.exit(7)"] }) };
  await expect(runSteps("pre-push", [step], { ...options, deadline: null, passes: open() })).rejects.toThrow();
  expect(open().reused(step)).toBeFalse();
  const expired = { at: 1, startedAt: 0 };
  await expect(runSteps("pre-push", [step], { ...options, deadline: expired, passes: open() })).rejects.toBeInstanceOf(NoVerdict);
  expect(open().reused(step)).toBeFalse();
  const deferred = { ...step, deferrable: true };
  expect(await runSteps("pre-push", [deferred], { ...options, deadline: expired, passes: open([deferred]) })).toEqual(["types"]);
  expect(open([deferred]).reused(deferred)).toBeFalse();
  await runSteps("pre-push", [step], { ...options, deadline: null, cancel: AbortSignal.abort(), passes: open() });
  expect(open().reused(step)).toBeFalse();
  const runtime: Step[] = ["Viewer build", "Viewer runtime", "runtime host"].map(name => ({ name, command: ["bun", name], lane: "runtime" }));
  open(runtime).passed(runtime[0]!);
  expect(open(runtime).reused(runtime[0]!)).toBeFalse();
  for (const member of runtime) open(runtime).passed(member);
  for (const member of runtime) expect(open(runtime).reused(member)).toBeTrue();
  await expect(runSteps("pre-push", runtime, { ...options, deadline: expired, passes: open(runtime) })).rejects.toBeInstanceOf(NoVerdict);
  const held = open(runtime);
  expect(held.reused(runtime[0]!)).toBeTrue();
  // A peer may evict optional cache files after the build has been skipped.
  // The already-validated group must keep its complete verdict for this run.
  const directory = path.join(f.dir, ".git/delegatus-gate/passes");
  for (const file of readdirSync(directory)) rmSync(path.join(directory, file));
  expect(held.reused(runtime[1]!)).toBeTrue();
  expect(open(runtime).reused(runtime[0]!)).toBeFalse();
});


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

test("privacy, frozen install and advisory audit execute on both pushes of one dependency tree", () => {
  const f = hookFixture();
  for (const file of ["audit-with-retry.test.ts", "supply-chain-check.test.ts"]) writeFileSync(path.join(f.dir, "scripts", file), "// hook fixture\n");
  writeFileSync(path.join(f.dir, ".gitignore"), "commands.jsonl\nadmission.sqlite*\nllv-heavy-gate.*\nbudget-*/\n");
  writeFileSync(path.join(f.dir, "package.json"), '{"name":"dependency-change"}');
  f.git("add", ".gitignore", "package.json", "scripts/audit-with-retry.test.ts", "scripts/supply-chain-check.test.ts"); f.git("commit", "-m", "dependency change");
  for (let index = 0; index < 2; index++) {
    const before = f.calls().length;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: f.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const calls = f.calls().slice(before);
    for (const command of ["scripts/privacy-publication-gate.ts", "install", "scripts/supply-chain-check.ts"])
      expect(calls.some(call => call.args[0] === command), command).toBeTrue();
  }
}, 60_000);

test("a stage agent's pass is reused by publication of the same tree, which reruns privacy", () => {
  const f = hookFixture();
  writeFileSync(path.join(f.dir, ".gitignore"), "commands.jsonl\nadmission.sqlite*\nllv-heavy-gate.*\nbudget-*/\n");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", ".gitignore", "example.ts"); f.git("commit", "-m", "change");
  // The forge directory shadows git with a credentialed shim, as an agent's does.
  // Outside the checkout: ignored files there are verification inputs.
  const agent = mkdtempSync(path.join(tmpdir(), "hook-agent-")), forge = path.join(agent, "forge");
  roots.push(agent);
  mkdirSync(forge, { recursive: true });
  writeFileSync(path.join(forge, "git"), `#!/bin/bash\nPATH=\${PATH#*:} exec git "$@"\n`); chmodSync(path.join(forge, "git"), 0o755);
  const { producer, viewer } = agentEnvironments(f.env, forge);
  // Roots and the CPU priority binding point into the fixture, never at live state.
  for (const name of ["TMPDIR", "LLV_STATE_DIR", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "LLV_AGENT_GIT_GUARD_DIR"]) {
    producer[name] = path.join(agent, name.toLowerCase()); mkdirSync(producer[name]!, { recursive: true });
  }
  Object.assign(producer, { NODE_ENV: f.env.NODE_ENV, LLV_GATE_CPU_PRIORITY_SOURCE: process.env.LLV_GATE_CPU_PRIORITY_SOURCE, GIT_CONFIG_VALUE_0: "!true" });
  // A runner inside a signal boundary hands it to gate-slot; on the host the
  // Viewer has none, and the key binds the boundary's host epoch either way.
  const publication = { ...viewer, ...pipelinePublicationHookEnv(viewer), LLV_PRIVACY_KNOWN_VALUES_FILE: path.join(agent, "lessons.json"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "!true",
    LLV_SIGNAL_SANDBOX: process.env.LLV_SIGNAL_SANDBOX, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
  const run = (env: NodeJS.ProcessEnv) => {
    const before = f.calls().length;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0); return { calls: f.calls().slice(before), output: result.stderr };
  };
  const built = run(producer);
  for (const command of ["tsc", "scripts/eslint-changes.ts", "scripts/local-gate-tests.ts"]) {
    const call = built.calls.find(call => call.args[0] === command);
    expect(call, command).toBeDefined();
    for (const name of ["LLV_SPAWN_CAPABILITY", "LLV_STRUCTURED_HOST", "LLV_VIEWER_PORT", "LLV_AGENT_FORGE_DIR", "GH_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_TOKEN", "AI_AGENT", "CODEX_THREAD_ID", "GIT_CONFIG_COUNT", "GIT_AUTHOR_NAME", "LLV_PRIVACY_KNOWN_VALUES_FILE"]) expect(call!.names, `${command} ${name}`).not.toContain(name);
    expect(call!.path!.split(path.delimiter), command).not.toContain(forge);
  }
  const published = run(publication);
  for (const command of ["tsc", "scripts/eslint-changes.ts", "scripts/local-gate-tests.ts"]) expect(published.calls.some(call => call.args[0] === command), published.output).toBeFalse();
  for (const step of ["types", "eslint", "touched tests"]) expect(published.output).toContain(`pre-push: ${step}: reused pass`);
  expect(published.calls.some(call => call.args[0] === "scripts/privacy-publication-gate.ts")).toBeTrue();
}, 120_000);
