import fs from "node:fs";
import path from "node:path";

import { afterAll } from "bun:test";

import { claimProcessTempRoot, TEST_RUN_TEMP_PREFIX } from "./src/lib/tempDirs";
import { beginCodexFeatureFixture } from "./src/lib/agent/codexSpawnPolicyTestFixtures";
import { beginTestChildOwnership } from "./src/lib/testing/testChildren";
import { captureProcessIdentity } from "./src/lib/processIdentity";
import { spawn } from "node:child_process";
import { setHeadlessSpawnForTests } from "./src/lib/runtime/agentSignalSandbox";

// Each Linux test runner needs its own kernel-owned tree. A nested runner must
// not share its parent's lifetime: a short-lived intermediate can detach a
// descendant before any polling observer sees it. Re-enter the existing gate
// supervisor before test modules load, preserving Bun's exact command line.
const admitted = process.platform !== "linux" || (Number(process.env.LLV_OWNED_TEST_RUNNER_PID) === process.pid
  && fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").some(line => line === `0::${process.env.LLV_OWNED_TEST_RUN_CGROUP}`));
if (!admitted) {
  const argv = fs.readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);
  const runner = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "scripts/owned-runner.ts"), ...argv], {
    env: { ...process.env, LLV_OWNED_RUN_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)) }, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.on("SIGTERM", () => runner.kill("SIGTERM"));
  process.on("SIGINT", () => runner.kill("SIGTERM"));
  process.exit(await runner.exited);
}

// Bun preserves an ambient NODE_ENV. Pin the test runtime before JSX modules load.
Object.assign(process.env, { NODE_ENV: "test" });

// Fake launchers share an explicit inventory, even when their binary only
// implements MCP enumeration or Codex is absent from PATH. Native policy tests
// opt into the real reader for each test and restore this default afterwards.
beginCodexFeatureFixture();
setHeadlessSpawnForTests(spawn);

/*
 * One temp root for the whole test process, removed when the run ends (#1957).
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
const run = claimProcessTempRoot(TEST_RUN_TEMP_PREFIX);
// A launch's environment-level hooksPath outranks every fixture repository's
// config and even affects `rev-parse --git-path hooks`. Drop launch bindings
// before test modules load, including the task database a gate waited on.
// The gate has already claimed its CPU slot; fixtures get their own bindings.
// Keep newly generated guards in this run too.
for (const key of Object.keys(process.env)) {
  if (/^GIT_(?:CONFIG(?:_|$)|DIR$|WORK_TREE$|COMMON_DIR$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|IMPLICIT_WORK_TREE$|GRAFT_FILE$|NO_REPLACE_OBJECTS$|REPLACE_REF_BASE$|PREFIX$|SHALLOW_FILE$)/.test(key)
    || /^LLV_(?:AGENT_GIT_GUARD_DIR|STAGE_GIT_RECEIPT|STAGE_GIT_WORKTREE|GATE_CPU_PRIORITY_SOURCE)$/.test(key)) delete process.env[key];
}
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  process.env[key] = path.join(run.root, key.toLowerCase());
  fs.mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
}

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(process.env.HOME!, ".gitconfig");
// `git init` copies hooks from GIT_TEMPLATE_DIR, including symlinks. A fixture
// that then writes through its repository hook path could otherwise overwrite
// a hook outside its root even though core.hooksPath is isolated.
process.env.GIT_TEMPLATE_DIR = path.join(run.root, "git-template");
fs.mkdirSync(process.env.GIT_TEMPLATE_DIR, { recursive: true, mode: 0o700 });

beginTestChildOwnership(run.root);
afterAll(() => run.release());

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
 * state dir to a throwaway temp dir for the whole process, so no test can ever
 * write the user's real viewer state. A test that wants its own isolated dir
 * still overrides this value itself.
 */
if (!process.env.LLV_STATE_DIR) {
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(run.root, "llv-test-state-"));
}

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
