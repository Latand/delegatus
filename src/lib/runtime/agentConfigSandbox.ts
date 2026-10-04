import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { QUIET_DIAGNOSTICS_ENV } from "@/lib/startupDiagnostics";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { discardUnsupportedApiCredentials } from "@/lib/environmentIsolation";
import { STATE_OWNER_ENV, underOperatorRoot } from "@/lib/stateOwnership";

import { LEGACY_APP_DIR } from "../../../bin/appDir.mjs";
import { FORGE_DIR_ENV, FORGE_READ_CONFIG_ENV } from "../../../bin/forge-app-token.mjs";
import { DELEGATUS_ENV_PREFIX } from "../../../bin/envAlias.mjs";

/**
 * The spawn boundary's half of #1905.
 *
 * A stage agent runs the repository's own commands — `bun run build`, `bun
 * test`, a capture driver — inside a checkout of this very project. Until now
 * it inherited the Viewer's `XDG_CONFIG_HOME` and `LLV_STATE_DIR`, so every one
 * of those commands resolved the operator's live directories by default; one
 * build did, and took every spawn on the machine down with it for seventy
 * minutes. Each agent now gets its own config and state root instead.
 *
 * What deliberately keeps pointing at the real installation:
 *
 * - the account home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and the transcript
 *   root, which the Viewer resolves and passes as absolute paths, so the
 *   agent's credentials and its transcripts are untouched by this;
 * - the Viewer MCP server, which gets the real state directory through its own
 *   server entry (`viewerMcpServerEntry`) rather than through the agent's
 *   environment, so the agent's link to the Viewer keeps working;
 * - the operator's `gh` configuration, for reads only. `gh` reads its
 *   configuration out of `XDG_CONFIG_HOME` and a lane without one cannot reach
 *   GitHub at all, so `agentForgeWriteEnv` records where it is and the `gh`
 *   shim hands it to a read. The agent's own `GH_CONFIG_DIR` names an empty
 *   directory and a write goes out as the Delegatus GitHub App or not at all.
 */
export const AGENT_SANDBOX_DIRNAME = "llv-spawn-sandbox";

function configRootFor(source: NodeJS.ProcessEnv): string {
  return source.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
}

function sandboxKey(value: string | undefined): string {
  const base = value ? path.basename(value) : "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return safe.length > 0 ? safe : "default";
}

/**
 * Where one agent's throw-away config root lives: under the temp root, keyed by
 * the account home it runs under so the number of them stays bounded and a
 * resumed agent finds the same one.
 *
 * Deliberately not a sibling of the real `state` directory: the point is that
 * nothing about this path is derived from the operator's installation, so a
 * process building it can never create a directory inside it — the mistake
 * this whole change exists to make impossible.
 */
export function agentConfigSandboxRoot(source: NodeJS.ProcessEnv, home?: string): string {
  return path.join(sandboxTemporaryRoot(source), AGENT_SANDBOX_DIRNAME, sandboxKey(home));
}

/**
 * The temp root the sandbox is built under.
 *
 * A restricted stage runs with `TMPDIR` pointed at a scratch directory the
 * Viewer made under `statePath("scratch")`, and that env is the `source` here
 * — so honouring it put the agent's "isolated" config root inside the
 * operator's own state directory, which is the one place this module promises
 * never to build in. Such a `TMPDIR` is ignored in favour of the process temp
 * root.
 */
function sandboxTemporaryRoot(source: NodeJS.ProcessEnv): string {
  const declared = source.TMPDIR?.trim();
  if (declared && !underOperatorRoot(declared, source)) return declared;
  return os.tmpdir();
}

/**
 * Point a spawned agent's environment at its own config and state root.
 * Mutates and returns `env`, which the callers have already filtered down to
 * their allowlist.
 */
export function withAgentConfigSandbox(
  env: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  home?: string,
): NodeJS.ProcessEnv {
  Object.assign(env, agentPublicationIdentityEnv(source));
  discardUnsupportedApiCredentials(env);
  const realConfigRoot = configRootFor(source);
  const root = agentConfigSandboxRoot(source, home);
  const configHome = path.join(root, "config");
  try {
    fs.mkdirSync(configHome, { recursive: true, mode: 0o700 });
  } catch {
    /* The agent's own tools create what they need; a sandbox this process
       could not pre-create is still a sandbox, and refusing to spawn over it
       would be worse than the directory arriving late. */
  }
  env.XDG_CONFIG_HOME = configHome;
  /* A fixed name, never probed on disk (see GH_CONFIG_DIR below): the agent is
     handed this path and resolves no app dir of its own, so the spelling is
     the one every release before the Delegatus rename used. */
  env.LLV_STATE_DIR = path.join(configHome, LEGACY_APP_DIR, "state");
  /* The new prefix never reaches an agent: an inherited DELEGATUS_STATE_DIR
     would win over the sandbox value above at the agent's own entry point
     (rename-delegatus.md §5). Entry points fold and delete it at the root;
     this holds for an environment built from anywhere else too. */
  for (const name of Object.keys(env)) {
    if (name.startsWith(DELEGATUS_ENV_PREFIX)) delete env[name];
  }
  /* An agent is no owner: whatever the Viewer claimed for itself stops here,
     so a command the agent runs cannot resolve the real directories even if it
     points itself back at them. */
  delete env[STATE_OWNER_ENV];
  /* The CLI launcher's quiet terminal is its own (#2168): a Viewer or a test
     the agent starts prints its startup diagnostics as it would anywhere. */
  delete env[QUIET_DIAGNOSTICS_ENV];
  /* Unconditional, and never probed on disk: what `gh` finds at the end of it
     is `gh`'s business, and a path that depends on what this machine happens
     to hold would make the spawned environment unreproducible. Windows has no
     shim (see agentForgeWriteEnv) and keeps the configuration itself. */
  const forge = env[FORGE_DIR_ENV];
  if (!forge) {
    if (!env.GH_CONFIG_DIR) env.GH_CONFIG_DIR = path.join(realConfigRoot, "gh");
    return env;
  }
  /* Reads keep that configuration: a forwarded value still wins, then the one
     an agent that is itself launching this already reads with, then the
     operator's own. The agent's `GH_CONFIG_DIR` names a directory with no
     account in it, so a `gh` started past the shim cannot write as a person. */
  const launcher = source[FORGE_DIR_ENV];
  const forwarded = env.GH_CONFIG_DIR && !(launcher && env.GH_CONFIG_DIR.startsWith(launcher)) ? env.GH_CONFIG_DIR : undefined;
  env[FORGE_READ_CONFIG_ENV] = forwarded ?? source[FORGE_READ_CONFIG_ENV] ?? path.join(realConfigRoot, "gh");
  env.GH_CONFIG_DIR = path.join(forge, "gh-config");
  return env;
}
