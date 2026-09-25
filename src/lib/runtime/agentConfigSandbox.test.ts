import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { QUIET_DIAGNOSTICS_ENV } from "@/lib/startupDiagnostics";
import { STATE_OWNER_ENV, underOperatorRoot } from "@/lib/stateOwnership";

import { agentConfigSandboxRoot, withAgentConfigSandbox } from "./agentConfigSandbox";

/* The spawn boundary's half of #1905. The hosts' own suites assert the child
   command carries this; these cases pin what "isolated" means. */

test("a spawned agent's environment carries its own config and state root", () => {
  const source: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    HOME: "/opt/operator-home",
    XDG_CONFIG_HOME: "/opt/operator-home/.config",
    LLV_STATE_DIR: "/opt/operator-home/.config/agent-log-viewer/state",
    TMPDIR: "/scratch/tmp",
    [STATE_OWNER_ENV]: "viewer",
    [QUIET_DIAGNOSTICS_ENV]: "1",
  };
  const env = withAgentConfigSandbox({ ...source }, source, "/opt/operator-home/.config/agent-log-viewer/accounts/claude/lane");

  const sandbox = path.join("/scratch/tmp", "llv-spawn-sandbox", "lane", "config");
  expect(env.XDG_CONFIG_HOME).toBe(sandbox);
  expect(env.LLV_STATE_DIR).toBe(path.join(sandbox, "agent-log-viewer", "state"));
  /* The claim the Viewer made for itself stops at the boundary. */
  expect(env[STATE_OWNER_ENV]).toBeUndefined();
  /* So does the CLI launcher's quiet terminal. */
  expect(env[QUIET_DIAGNOSTICS_ENV]).toBeUndefined();
  /* `gh` read its configuration out of XDG_CONFIG_HOME, so it is pinned. */
  expect(env.GH_CONFIG_DIR).toBe("/opt/operator-home/.config/gh");
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
