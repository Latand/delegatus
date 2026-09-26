import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { statePath } from "@/lib/configDir";
import { readViewerGatewayConfig, VIEWER_GATEWAY_FILE } from "@/runtime-host/deploymentProxy";
import { stableMcpRuntimeRoot } from "@/runtime-host/mcpRuntimeRelease";

import { appDirIn } from "../../../bin/appDir.mjs";

import type { AgentEngine } from "./cli";
import { grantedMcpServers } from "./mcpAllowlist";
import { operatorTelegramClaudeEntry } from "@/lib/runtime/telegramConnectorEnv";

type JsonObject = Record<string, unknown>;

const MANAGED_HOOK_PREFIX = "LLV_MANAGED_NATIVE_SUBAGENT_DENY=1 ";
const MANAGED_DIR = ".llv";
const MANAGED_HOOK = "deny-native-subagents.sh";
const MCP_APPROVAL_SETTINGS = [
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
] as const;

/** Every native multi-agent entry point in the installed Claude CLI (#381 audit,
    CLI 2.1.214): subagent spawns (Task, Agent), Workflow orchestration scripts,
    and the agent-team surface (TeamCreate, TeamDelete, SendMessage). Swarm
    views are UI wrappers that launch through these same tools. Background
    shells and task-list tools (TaskOutput, TaskStop, TaskCreate…) never create
    child agents and stay allowed alongside full Bash/filesystem access. */
export const NATIVE_MULTI_AGENT_TOOLS: readonly string[] = Object.freeze([
  "Task", "Agent", "Workflow", "TeamCreate", "TeamDelete", "SendMessage",
]);
export const NATIVE_MULTI_AGENT_HOOK_MATCHER = NATIVE_MULTI_AGENT_TOOLS.join("|");

export const VIEWER_SPAWN_ENDPOINT = "http://127.0.0.1:8898/api/spawn";
export const VIEWER_SPAWN_CAPABILITY_ENV = "LLV_SPAWN_CAPABILITY";
/* Defined in an import-free module so client bundles can use it too; re-exported
   here so every existing importer is unaffected. */
export { VIEWER_SPAWN_CAPABILITY_HEADER } from "./capabilityHeader";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "./capabilityHeader";
const SPAWN_AUTH_GUIDANCE = `Send header ${VIEWER_SPAWN_CAPABILITY_HEADER}: $${VIEWER_SPAWN_CAPABILITY_ENV}.`;
export const NATIVE_SUBAGENT_DENY_MESSAGE = `Sub-agents are disabled on this surface. Spawn через POST ${VIEWER_SPAWN_ENDPOINT} with {engine, model, cwd, prompt, src: <your transcript path>, role, reviews?} and ${SPAWN_AUTH_GUIDANCE} The worker then appears on the board with correct lineage.`;
export const VIEWER_SPAWN_PROMPT_FENCE = `Viewer spawn policy: avoid native sub-agent, collaboration, and background-agent features. Spawn every helper through POST ${VIEWER_SPAWN_ENDPOINT} with {engine, model, cwd, prompt, src: <your transcript path>, role, reviews?}. ${SPAWN_AUTH_GUIDANCE} The worker appears on the board with correct lineage.`;

export const CODEX_VIEWER_SPAWN_FEATURES = {
  plugins: false,
  apps: false,
  multi_agent: false,
} as const;

export interface ViewerMcpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * What the Viewer MCP launcher needs to find this machine's Viewer, written
 * into the server definition rather than left to the agent's environment.
 *
 * A spawned agent now runs under its own throw-away config and state root
 * (#1905), and the launcher resolves the current release and the stable
 * listener from exactly these values. Pinning them here is what keeps the MCP
 * link pointed at the real Viewer while everything else the agent runs stays
 * in its sandbox.
 */
export function viewerMcpServerEnv(source: McpEnvironment = process.env): Record<string, string> {
  const configRoot = source.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const env: Record<string, string> = {
    XDG_CONFIG_HOME: configRoot,
    LLV_STATE_DIR: source.LLV_STATE_DIR?.trim() || path.join(appDirIn(configRoot), "state"),
  };
  /* PATH and HOME are restated rather than assumed: a CLI that treats a
     server's `env` table as the whole environment instead of as additions to
     it would otherwise launch the server without an interpreter to find. Where
     the table is additive — Claude's `.mcp.json` is — these are the values the
     server would have inherited anyway. */
  for (const name of ["PATH", "HOME", "LLV_VIEWER_DEPLOY_TARGET", "LLV_VIEWER_PORT"] as const) {
    const value = source[name]?.trim();
    if (value) env[name] = value;
  }
  return env;
}

/**
 * The Viewer server an agent launches when its account registers none. The
 * stable runtime comes first, as in `install-mcp.sh`: it lives under the home
 * directory the Docker image mounts at the same path, so the agent CLI, which
 * runs on the host through the nsenter shim, can start it. The package's own
 * launcher (a checkout root, or the standalone server directory of the
 * published CLI) is the fallback; inside the image that is `/app`, which does
 * not exist on the host (#2052).
 */
export function viewerMcpServerEntry(
  packageCwd = process.cwd(),
  source: McpEnvironment = process.env,
): ViewerMcpServerEntry {
  const stable = path.join(stableMcpRuntimeRoot(source), "bin", "mcp-server.mjs");
  const direct = path.resolve(packageCwd, "bin", "mcp-server.mjs");
  const fromStandalone = path.resolve(packageCwd, "..", "..", "bin", "mcp-server.mjs");
  const launcher = [stable, direct, fromStandalone].find((candidate) => fs.existsSync(candidate));
  if (!launcher) throw new Error(`Viewer MCP launcher could not be resolved from package cwd: ${packageCwd}`);
  return {
    command: "bun",
    args: [launcher],
    env: viewerMcpServerEnv(source),
  };
}

/**
 * How a newly spawned agent reaches the Viewer MCP tools (`LLV_MCP_TRANSPORT`).
 *
 * `stdio` (the default) starts `bin/mcp-server.mjs` beside every agent, one Bun
 * process each. `http` points the agent at the Viewer's own shared endpoint,
 * `/api/mcp`, so no per-agent server process exists at all. The flag is read
 * when a spawn's configuration is written, so it moves NEW spawns only: an
 * agent already running keeps the transport it was launched with, and stdio
 * keeps working for it whatever the flag says now.
 */
export const VIEWER_MCP_TRANSPORT_ENV = "LLV_MCP_TRANSPORT";
type McpEnvironment = Readonly<Record<string, string | undefined>>;
export type ViewerMcpTransport = "stdio" | "http";

export function viewerMcpTransport(source: McpEnvironment = process.env): ViewerMcpTransport {
  return source[VIEWER_MCP_TRANSPORT_ENV]?.trim().toLowerCase() === "http" ? "http" : "stdio";
}

/**
 * The transport for ONE launch, decided from the environment its agent will
 * actually run with. The shared endpoint identifies a caller only by the spawn
 * capability that environment carries, so a launch without one — a successor
 * host started with none, a command pasted into a terminal — keeps the stdio
 * launcher, which identifies it by process ancestry as it always has. A launch
 * whose environment is not known here passes nothing and gets stdio.
 */
export function viewerMcpTransportForLaunch(
  launchEnv: McpEnvironment,
  flag: McpEnvironment = process.env,
): ViewerMcpTransport {
  const capability = launchEnv[VIEWER_SPAWN_CAPABILITY_ENV]?.trim() ?? "";
  return viewerMcpTransport(flag) === "http"
    && /^[A-Za-z0-9_-]{43}$/.test(capability)
    && viewerMcpHttpAdmitted(flag)
    ? "http"
    : "stdio";
}

function stableViewerPort(source: McpEnvironment): string {
  const port = source.LLV_VIEWER_PORT?.trim();
  return port && /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65_535 ? port : "8898";
}

/**
 * Whether an agent can reach the endpoint through the Viewer's access gate.
 * With LLV_TOKEN configured every request needs it, and agents are launched
 * without it on purpose; the one thing that supplies it on their behalf is the
 * stable local entry, and only when the gateway file trusts that entry. Any
 * other shape keeps the launch on stdio rather than handing an agent a
 * connection every call of which would be refused.
 */
function viewerMcpHttpAdmitted(source: McpEnvironment): boolean {
  if (!source.LLV_TOKEN?.trim()) return true;
  const port = stableViewerPort(source);
  if (new URL(viewerMcpHttpUrl(source)).port !== port) return false;
  const gateway = readViewerGatewayConfig(statePath(VIEWER_GATEWAY_FILE), Number(port));
  return gateway.problem === null && gateway.config.localEntry === "trusted";
}

const LOOPBACK_MCP_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The shared endpoint's URL: `LLV_MCP_HTTP_URL` when it names a loopback
    http URL, else the stable listener (`LLV_VIEWER_PORT`, default 8898) that
    stays put across deploys while the release behind it changes. */
export function viewerMcpHttpUrl(source: McpEnvironment = process.env): string {
  const configured = source.LLV_MCP_HTTP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" && LOOPBACK_MCP_HOSTS.has(url.hostname) && url.port) return url.href;
    } catch { /* an unusable override falls back to the stable listener */ }
  }
  return `http://127.0.0.1:${stableViewerPort(source)}/api/mcp`;
}

/**
 * The Claude `--mcp-config` entry for the shared endpoint. The capability is
 * written as a reference Claude expands from the agent's own environment, so
 * the file holds no secret and stays correct when a relaunch rotates the
 * capability. It rides in its own header: Authorization is what the stable
 * listener rewrites when it vouches for a loopback caller.
 */
export function viewerMcpHttpClaudeEntry(source: McpEnvironment = process.env): JsonObject {
  return {
    type: "http",
    url: viewerMcpHttpUrl(source),
    headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: `\${${VIEWER_SPAWN_CAPABILITY_ENV}}` },
  };
}

/** The Codex `mcp_servers.viewer` table for the shared endpoint.
    `env_http_headers` maps a header to the environment variable Codex reads
    its value from (codex-cli 0.155.1). */
export function viewerMcpHttpCodexEntry(source: McpEnvironment = process.env): JsonObject {
  return {
    url: viewerMcpHttpUrl(source),
    env_http_headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: VIEWER_SPAWN_CAPABILITY_ENV },
  };
}

export interface ClaudeSpawnPolicyResult {
  settingsPath: string;
  mcpConfigPath: string;
  hookPath: string;
  command: string;
}

export function claudeSpawnPolicyPaths(home: string, profileId: string): ClaudeSpawnPolicyResult {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(profileId)) throw new Error("Claude spawn policy profile id is invalid");
  const hookPath = path.join(home, MANAGED_DIR, "hooks", MANAGED_HOOK);
  return {
    settingsPath: path.join(home, MANAGED_DIR, "spawn-settings", `${profileId}.json`),
    mcpConfigPath: path.join(home, MANAGED_DIR, "spawn-mcp", `${profileId}.json`),
    hookPath,
    command: `${MANAGED_HOOK_PREFIX}${shellQuote(hookPath)}`,
  };
}

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function atomicWrite(pathname: string, contents: string, mode: number): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, pathname);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readSettings(pathname: string): JsonObject {
  if (!fs.existsSync(pathname)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    throw new Error(`Claude settings are invalid JSON: ${pathname}`);
  }
  const settings = record(parsed);
  if (!settings) throw new Error(`Claude settings must contain a JSON object: ${pathname}`);
  return settings;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function claudeProjectMcpServers(cwd: string | undefined): JsonObject {
  if (!cwd) return {};
  const launchDirectory = path.resolve(cwd);
  let projectRoot = launchDirectory;
  for (let directory = launchDirectory; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, ".git"))) {
      projectRoot = directory;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  const configPath = path.join(projectRoot, ".mcp.json");
  if (!fs.existsSync(configPath)) return {};
  return record(readSettings(configPath).mcpServers) ?? {};
}

/** Resolves Claude's registered MCP definitions with the same scope precedence
    used when a structured spawn builds its strict per-spawn config. */
export function resolveClaudeMcpServers(
  home: string,
  cwd: string | undefined,
  mcpStatePath = path.join(home, ".claude.json"),
): JsonObject {
  const state = fs.existsSync(mcpStatePath) ? readSettings(mcpStatePath) : {};
  const rootServers = record(state.mcpServers) ?? {};
  const projects = record(state.projects);
  const project = cwd && projects ? record(projects[cwd]) : null;
  const sharedProjectServers = claudeProjectMcpServers(cwd);
  const localProjectServers = record(project?.mcpServers) ?? {};
  return { ...rootServers, ...sharedProjectServers, ...localProjectServers };
}

export function viewerMcpRegistered(
  home: string,
  cwd: string | undefined,
  mcpStatePath?: string,
): boolean {
  return record(resolveClaudeMcpServers(home, cwd, mcpStatePath).viewer) !== null;
}

function claudeMcpServers(
  home: string,
  cwd: string | undefined,
  allowlist: readonly string[] | undefined,
  mcpStatePath: string | undefined,
  viewerTransport: ViewerMcpTransport,
): JsonObject {
  const registered = resolveClaudeMcpServers(home, cwd, mcpStatePath);
  /* The grant bound is enforced again here (issue #739): the per-spawn
     `--strict-mcp-config` file is copied from the re-validated list, so a
     server the Viewer cannot grant is never written into it. */
  const names = grantedMcpServers(allowlist);
  const http = viewerTransport === "http";
  return Object.fromEntries(names.flatMap((name) => {
    if (name === "telegram") return [[name, operatorTelegramClaudeEntry()]];
    /* Over HTTP the Viewer owns the whole definition: a registered stdio
       launcher is replaced, never merged into. */
    if (name === "viewer" && http) return [[name, viewerMcpHttpClaudeEntry()]];
    const definition = record(registered[name])
      ?? (name === "viewer" ? { type: "stdio", ...viewerMcpServerEntry() } : null);
    if (!definition) return [];
    /* The agent runs under its own config and state root (#1905), so the
       Viewer server — however it was registered — carries the real ones
       itself. A value already written into the definition wins: an operator
       who pinned a state dir there meant it. */
    const pinned = name === "viewer"
      ? { ...definition, env: { ...viewerMcpServerEnv(), ...record(definition.env) } }
      : definition;
    return [[name, pinned]];
  }));
}

/** Seeds the mutable Claude home state before a managed bypass launch. */
export function prepareManagedClaudeSpawnHome(home: string, cwd: string): void {
  const pathname = path.join(home, ".claude.json");
  try {
    const stat = fs.lstatSync(pathname);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Claude state path is unsafe: ${pathname}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let state: JsonObject = {};
  if (fs.existsSync(pathname)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(pathname, "utf8"));
    } catch {
      throw new Error(`Claude state is invalid JSON: ${pathname}`);
    }
    const value = record(parsed);
    if (!value) throw new Error(`Claude state must contain a JSON object: ${pathname}`);
    state = value;
  }
  const projects = state.projects === undefined ? {} : record(state.projects);
  if (!projects) throw new Error(`Claude state projects must contain a JSON object: ${pathname}`);
  const existingProject = projects[cwd] === undefined ? {} : record(projects[cwd]);
  if (!existingProject) throw new Error(`Claude project state must contain a JSON object: ${cwd}`);
  atomicWrite(pathname, JSON.stringify({
    ...state,
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      ...projects,
      [cwd]: {
        ...existingProject,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  }, null, 2) + "\n", 0o600);
}

function managedCommand(command: unknown): boolean {
  return typeof command === "string" && command.startsWith(MANAGED_HOOK_PREFIX);
}

function withoutManagedHandlers(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Claude settings hooks.PreToolUse must be an array");
  return value.flatMap((candidate) => {
    const group = record(candidate);
    if (!group || !Array.isArray(group.hooks)) return [candidate];
    const handlers = group.hooks.filter((handler) => !managedCommand(record(handler)?.command));
    return handlers.length ? [{ ...group, hooks: handlers }] : [];
  });
}

/** Reconciles the Viewer-owned Claude hook while preserving every user key and handler. */
export function applyClaudeSpawnPolicy(
  home: string,
  options: {
    allowSubagents?: boolean;
    baseSettingsPath?: string | null;
    providerAccount?: boolean;
    profileId?: string;
    cwd?: string;
    mcpServers?: readonly string[];
    mcpStatePath?: string;
    /** How this launch reaches the Viewer tools; see
        {@link viewerMcpTransportForLaunch}. Absent means stdio. */
    viewerTransport?: ViewerMcpTransport;
  } = {},
): ClaudeSpawnPolicyResult {
  const sourceSettingsPath = path.join(home, "settings.json");
  const profileId = options.profileId ?? crypto.randomUUID();
  const result = claudeSpawnPolicyPaths(home, profileId);
  const sourceExists = fs.existsSync(sourceSettingsPath);
  const sourceSettings = sourceExists
    ? readSettings(sourceSettingsPath)
    : options.baseSettingsPath ? readSettings(options.baseSettingsPath) : {};
  const settings = sourceExists ? {} : { ...sourceSettings };
  if (options.providerAccount) {
    // --settings outranks process env. Keep the owner's hooks and UI settings,
    // while refusing endpoint, credential and model overrides from shared JSON.
    const sourceEnv = record(settings.env);
    if (sourceEnv) {
      settings.env = Object.fromEntries(Object.entries(sourceEnv).filter(([name]) =>
        !name.startsWith("ANTHROPIC_") && name !== "CLAUDE_CODE_OAUTH_TOKEN"));
    }
    delete settings.apiKeyHelper;
    delete settings.model;
  }
  if (!options.allowSubagents && sourceSettings.disableAllHooks === true) {
    throw new Error("Claude settings disableAllHooks prevents the Viewer spawn policy from enforcing native sub-agent denial");
  }
  if (!options.allowSubagents && sourceSettings.allowManagedHooksOnly === true) {
    throw new Error("Claude settings allowManagedHooksOnly prevents the Viewer spawn policy from enforcing native sub-agent denial");
  }
  const hooks = sourceSettings.hooks === undefined ? {} : record(sourceSettings.hooks);
  if (!hooks) throw new Error("Claude settings hooks must contain a JSON object");

  const preToolUse = withoutManagedHandlers(hooks.PreToolUse);
  if (!options.allowSubagents) {
    const script = `#!/bin/sh\nprintf '%s\\n' ${shellQuote(NATIVE_SUBAGENT_DENY_MESSAGE)} >&2\nexit 2\n`;
    atomicWrite(result.hookPath, script, 0o700);
    preToolUse.push({
      matcher: NATIVE_MULTI_AGENT_HOOK_MATCHER,
      hooks: [{ type: "command", command: result.command }],
    });
  }

  const enforcedSettings = options.allowSubagents
    ? settings
    : { ...settings, disableAllHooks: false, allowManagedHooksOnly: false };
  const mcpServers = claudeMcpServers(
    home,
    options.cwd,
    options.mcpServers,
    options.mcpStatePath,
    options.viewerTransport ?? "stdio",
  );
  const includedMcpServers = new Set(Object.keys(mcpServers));
  const excludedProjectMcpServers = Object.keys(claudeProjectMcpServers(options.cwd))
    .filter((name) => !includedMcpServers.has(name));
  const settingsWithoutMcp = Object.fromEntries(
    Object.entries(enforcedSettings).filter(([key]) => key !== "mcpServers"),
  );
  const approvalSettings: JsonObject = Object.fromEntries(MCP_APPROVAL_SETTINGS.flatMap((key) => (
    sourceSettings[key] === undefined ? [] : [[key, sourceSettings[key]]]
  )));
  if (sourceSettings.enabledMcpjsonServers !== undefined) {
    approvalSettings.enabledMcpjsonServers = stringArray(sourceSettings.enabledMcpjsonServers)
      .filter((name) => includedMcpServers.has(name));
  }
  const disabledMcpjsonServers = [...new Set([
    ...stringArray(sourceSettings.disabledMcpjsonServers),
    ...excludedProjectMcpServers,
  ])];
  if (disabledMcpjsonServers.length > 0) approvalSettings.disabledMcpjsonServers = disabledMcpjsonServers;
  atomicWrite(result.settingsPath, JSON.stringify({
    ...settingsWithoutMcp,
    ...approvalSettings,
    hooks: { ...hooks, PreToolUse: preToolUse },
  }, null, 2) + "\n", 0o600);
  atomicWrite(result.mcpConfigPath, JSON.stringify({ mcpServers }, null, 2) + "\n", 0o600);
  return result;
}

export function fenceViewerSpawnPrompt(engine: AgentEngine, prompt: string): string {
  if (engine !== "codex") return prompt;
  return [prompt.trim(), VIEWER_SPAWN_PROMPT_FENCE].filter(Boolean).join("\n\n");
}
