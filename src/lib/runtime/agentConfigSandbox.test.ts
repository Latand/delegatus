import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { QUIET_DIAGNOSTICS_ENV } from "@/lib/startupDiagnostics";
import { STATE_OWNER_ENV, underOperatorRoot } from "@/lib/stateOwnership";

import { agentConfigSandboxRoot, withAgentConfigSandbox } from "./agentConfigSandbox";

test("fresh attempts reuse package artifact caches while their config and state stay private", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-artifacts-"));
  try {
    const source: NodeJS.ProcessEnv = { NODE_ENV: "test", HOME: path.join(root, "home"), XDG_CACHE_HOME: path.join(root, "cache") };
    const first = withAgentConfigSandbox({ NODE_ENV: "test" }, { ...source, TMPDIR: path.join(root, "first") });
    const second = withAgentConfigSandbox({ NODE_ENV: "test" }, { ...source, TMPDIR: path.join(root, "second") });
    expect(first.UV_CACHE_DIR).toBe(path.join(root, "cache/uv"));
    expect(second.UV_CACHE_DIR).toBe(first.UV_CACHE_DIR);
    expect(second.BUN_INSTALL_CACHE_DIR).toBe(first.BUN_INSTALL_CACHE_DIR);
    expect(first.BUN_INSTALL_CACHE_DIR).toBe(path.join(root, "home/.bun/install/cache"));
    expect(first.LLV_STATE_DIR).not.toBe(second.LLV_STATE_DIR);
    expect(first.UV_PROJECT_ENVIRONMENT).toBeUndefined();
    expect(fs.existsSync(first.UV_CACHE_DIR!)).toBeFalse();
    const configured = withAgentConfigSandbox({ NODE_ENV: "test" }, { ...source, TMPDIR: root,
      UV_CACHE_DIR: path.join(root, "uv-custom"), BUN_INSTALL_CACHE_DIR: path.join(root, "bun-custom") });
    expect(configured.UV_CACHE_DIR).toBe(path.join(root, "uv-custom"));
    expect(configured.BUN_INSTALL_CACHE_DIR).toBe(path.join(root, "bun-custom"));
    const defaults = withAgentConfigSandbox({ NODE_ENV: "test" }, { NODE_ENV: "test", HOME: source.HOME, TMPDIR: root, BUN_INSTALL: path.join(root, "bun") });
    expect(defaults.UV_CACHE_DIR).toBe(path.join(root, "home/.cache/uv"));
    expect(defaults.BUN_INSTALL_CACHE_DIR).toBe(path.join(root, "bun/install/cache"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("attempt allocation identity and allowance cross the filtered host environment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-budget-env-"));
  try {
    const stat = fs.statSync(root);
    const source: NodeJS.ProcessEnv = { NODE_ENV: "test", HOME: root, TMPDIR: root, LLV_ATTEMPT_TIMING_ROOT: root,
      LLV_ATTEMPT_TIMING_ROOT_IDENTITY: `${stat.dev}:${stat.ino}`, LLV_ATTEMPT_TMP_MAX_BYTES: "8388608" };
    const child = withAgentConfigSandbox({ NODE_ENV: "test" }, source);
    expect(child.LLV_ATTEMPT_TIMING_ROOT).toBe(root);
    expect(child.LLV_ATTEMPT_TIMING_ROOT_IDENTITY).toBe(source.LLV_ATTEMPT_TIMING_ROOT_IDENTITY);
    expect(child.LLV_ATTEMPT_TMP_MAX_BYTES).toBe("8388608");
    withAgentConfigSandbox(child, { NODE_ENV: "test", TMPDIR: root });
    expect(child.LLV_ATTEMPT_TIMING_ROOT).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* The spawn boundary's half of #1905. The hosts' own suites assert the child
   command carries this; these cases pin what "isolated" means. */

test("a spawned agent's environment carries its own config and state root", () => {
  /* The launch writes its Git hooks under the home's cache, so the home is a
     real directory here. */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "operator-home-"));
  const pluginKey = ["EXAMPLE", "PLUGIN", "API", "KEY"].join("_");
  const source: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    LLV_STATE_DIR: path.join(home, ".config", "agent-log-viewer", "state"),
    TMPDIR: "/scratch/tmp",
    [STATE_OWNER_ENV]: "viewer",
    [QUIET_DIAGNOSTICS_ENV]: "1",
    [pluginKey]: "private-fixture",
  };
  const env = withAgentConfigSandbox({ ...source }, source, path.join(home, ".config", "agent-log-viewer", "accounts", "claude", "lane"));

  const sandbox = path.join("/scratch/tmp", "llv-spawn-sandbox", "lane", "config");
  expect(env.XDG_CONFIG_HOME).toBe(sandbox);
  expect(env.LLV_STATE_DIR).toBe(path.join(sandbox, "agent-log-viewer", "state"));
  /* The claim the Viewer made for itself stops at the boundary. */
  expect(env[STATE_OWNER_ENV]).toBeUndefined();
  /* So does the CLI launcher's quiet terminal. */
  expect(env[QUIET_DIAGNOSTICS_ENV]).toBeUndefined();
  expect(env[pluginKey]).toBeUndefined();
  /* `gh` read its configuration out of XDG_CONFIG_HOME, so it is pinned. */
  expect(env.GH_CONFIG_DIR).toBe(path.join(home, ".config", "gh"));
  fs.rmSync(home, { recursive: true, force: true });
});

test("the sandbox is derived from the temp root, never from the operator's installation", () => {
  const source: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    HOME: "/opt/operator-home",
    XDG_CONFIG_HOME: "/opt/operator-home/.config",
    LLV_STATE_DIR: "/opt/operator-home/.config/agent-log-viewer/state",
  };
  const root = agentConfigSandboxRoot(source, "/opt/operator-home/.config/agent-log-viewer/accounts/codex/lane");
  expect(root).toBe(path.join(os.tmpdir(), "llv-spawn-sandbox", "lane"));
  expect(root.startsWith("/opt/operator-home")).toBeFalse();
});

test("an account home with no usable name still gets a root of its own, and a forwarded gh config wins", () => {
  const source: NodeJS.ProcessEnv = { NODE_ENV: "production", TMPDIR: "/scratch/tmp", XDG_CONFIG_HOME: "/shared/config" };
  const env = withAgentConfigSandbox({ NODE_ENV: "production", GH_CONFIG_DIR: "/forwarded/gh" }, source, undefined);
  expect(env.XDG_CONFIG_HOME).toBe(path.join("/scratch/tmp", "llv-spawn-sandbox", "default", "config"));
  expect(env.GH_CONFIG_DIR).toBe("/forwarded/gh");
});

test("a TMPDIR inside the operator's state directory is not where the sandbox goes", () => {
  const source: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    HOME: "/opt/operator-home",
    XDG_CONFIG_HOME: "/opt/operator-home/.config",
    /* What a restricted stage is handed: the scratch directory the Viewer
       made for it under statePath("scratch"). Honouring it put the agent's
       "isolated" root inside the operator's own state directory, and every
       directory the agent then mktemped read as the operator's. */
    TMPDIR: "/opt/operator-home/.config/agent-log-viewer/state/scratch/llv-read-only-stage-a1b2c3/tmp",
  };

  const root = agentConfigSandboxRoot(source, "/opt/operator-home/.config/agent-log-viewer/accounts/claude/lane");

  expect(root).toBe(path.join(os.tmpdir(), "llv-spawn-sandbox", "lane"));
  expect(underOperatorRoot(root, source)).toBeFalse();
});
