import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll } from "bun:test";

import { claimProcessTempRoot, TEST_RUN_TEMP_PREFIX } from "./src/lib/tempDirs";
import { beginTestChildOwnership } from "./src/lib/testing/testChildren";
import { captureProcessIdentity } from "./src/lib/processIdentity";
import { spawn } from "node:child_process";
import { setHeadlessSpawnForTests } from "./src/lib/runtime/agentSignalSandbox";

// Each Linux test runner enters its own service when a manager is available.
// A nested runner cannot reuse its parent's admission. Without a manager the
// owned runner binds portable admission to the command PID and warns about
// polling limits. Re-enter before modules load, preserving Bun's command line.
const admitted = process.platform !== "linux"
  || Number(process.env.LLV_PORTABLE_TEST_RUNNER_PID) === process.pid
  || (Number(process.env.LLV_OWNED_TEST_RUNNER_PID) === process.pid
    && fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").some(line => line === `0::${process.env.LLV_OWNED_TEST_RUN_CGROUP}`));
if (!admitted) {
  const argv = fs.readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);
  const runner = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "scripts/owned-runner.ts"), ...argv], {
    env: { ...process.env, LLV_OWNED_RUN_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)) }, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.on("SIGTERM", () => runner.kill("SIGTERM"));
  process.on("SIGINT", () => runner.kill("SIGINT"));
  process.exit(await runner.exited);
}

// Bun preserves an ambient NODE_ENV. Pin the test runtime before JSX modules load.
Object.assign(process.env, { NODE_ENV: "test" });

// DOM nodes print as one line, so a failed element comparison stays a failure (#2182).
await import("./src/test-helpers/domInspect");

/*
 * One temp root per file repetition, removed after its children finish (#1957).
 *
 * Every temp directory a test makes afterwards goes inside it, whatever its
 * prefix and however it imported `mkdtemp` (see `src/lib/tempDirs.ts`), so a
 * suite that forgets its own cleanup no longer leaves anything behind. Before
 * this, 1050 `llv-test-state-*` roots and some 5000 other test directories
 * filled the workstation's disk.
 *
 * The removal is a global `afterAll`, because Bun's test runner exits without
 * emitting `exit` or `beforeExit`. A run that is killed leaves its root, named
 * with an owned prefix, and the Viewer's sweeper removes it once it is stale.
 */
// A launch's environment-level hooksPath outranks every fixture repository's
// config and even affects `rev-parse --git-path hooks`. Drop launch bindings
// before test modules load, including the task database a gate waited on.
// The gate has already claimed its CPU slot; fixtures get their own bindings.
// Keep newly generated guards in this run too.
for (const key of Object.keys(process.env)) {
  if (/^GIT_(?:CONFIG(?:_|$)|DIR$|WORK_TREE$|COMMON_DIR$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|IMPLICIT_WORK_TREE$|GRAFT_FILE$|NO_REPLACE_OBJECTS$|REPLACE_REF_BASE$|PREFIX$|SHALLOW_FILE$)/.test(key)
    || /^LLV_(?:AGENT_GIT_GUARD_DIR|STAGE_GIT_RECEIPT|STAGE_GIT_WORKTREE|GATE_CPU_PRIORITY_SOURCE|GATE_PUSH_HEAD|GATE_LANE_ID|GATE_STAGE_ID|GATE_CLOUD_CONFIG|GATE_STATE_DIR)$/.test(key)) delete process.env[key];
}
// Fixture repositories own their heads and settings. An enclosing publication's
// Cloud endpoint and selectors must not reach them; Cloud tests opt in explicitly.
process.env.LLV_GATE_EXECUTION = "local";
process.env.GIT_CONFIG_NOSYSTEM = "1";

/*
 * Test-suite guard: force an isolated LLV_STATE_DIR before ANY module loads.
 *
 * Several state modules bake their file path at import time
 * (`const FLOWS_FILE = statePath("flows.json")`), so a test that isolates the
 * state dir at its own top only wins if it is the first to import that module.
 * In a full `bun test` run the import order is not guaranteed — another test
 * file can load the store first with LLV_STATE_DIR unset, baking the path to
 * the user's REAL `~/.config/agent-log-viewer/state`, and a later
 * `saveFlows(...)` then clobbers real flows. Running this preload first pins the
 * state dir to a throwaway temp dir before imports, so no test can ever
 * write the user's real viewer state. A test that wants its own isolated dir
 * still overrides this value itself.
 */
const isolatedKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "GIT_CONFIG_GLOBAL", "GIT_TEMPLATE_DIR", "LLV_STATE_DIR", "LLV_FIXTURE_PARENT_IDENTITY"] as const;
const inherited = Object.fromEntries(isolatedKeys.map(key => [key, process.env[key]]));
let run: ReturnType<typeof claimProcessTempRoot> | undefined;
let releaseChildren: (() => Promise<void>) | undefined;
function beginRepetition(): void {
  run = claimProcessTempRoot(TEST_RUN_TEMP_PREFIX);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    process.env[key] = path.join(run.root, key.toLowerCase());
    fs.mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
  }
  process.env.GIT_CONFIG_GLOBAL = path.join(process.env.HOME!, ".gitconfig");
  // `git init` must never copy a template hook pointing outside this root.
  process.env.GIT_TEMPLATE_DIR = path.join(run.root, "git-template");
  fs.mkdirSync(process.env.GIT_TEMPLATE_DIR, { recursive: true, mode: 0o700 });
  if (!process.env.LLV_STATE_DIR) {
    process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(run.root, "llv-test-state-"));
  }
  releaseChildren = beginTestChildOwnership(run.root);
}
// Install before module evaluation too: fixtures may spawn at top level.
beginRepetition();
// This fixture reaches memory state while importing. Load it only after the
// private state and temp roots exist, so that import belongs to cleanup too.
const { beginCodexFeatureFixture } = await import("./src/lib/agent/codexSpawnPolicyTestFixtures");
// Fake launchers share an inventory; native policy tests restore this default.
beginCodexFeatureFixture();
setHeadlessSpawnForTests(spawn);
beforeAll(() => { if (!run) beginRepetition(); });
afterAll(async () => {
  try { await releaseChildren?.(); }
  finally {
    run?.release();
    run = undefined;
    releaseChildren = undefined;
    for (const key of isolatedKeys) {
      if (inherited[key] === undefined) delete process.env[key];
      else process.env[key] = inherited[key];
    }
  }
});

/*
 * CPU placement and CPU-pressure admission act on the live user manager and
 * read the machine's pressure. A test that exercises them passes its own env
 * and slices; no test process configures a live slice or waits on load. The
 * folded `LLV_` names are the ones every entry point leaves behind
 * (bin/envAlias.mjs), so a fold later in the run cannot turn this back on.
 */
for (const name of ["AGENT_CPU", "CPU_PRESSURE"]) {
  delete process.env[`DELEGATUS_${name}`];
  process.env[`LLV_${name}`] = "off";
}
