import { engineMemoryOff } from "@/lib/memory/source";
import { operatorDecisionFormsRequired } from "@/lib/orchestrator/operatorDecisionForms";
import { codexOperatorQuestionPolicy } from "./operatorQuestionPolicy";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAgentBinary } from "../../../bin/agent-binaries.mjs";

import { accountForSpawn, codexHomeOwningSessionPath, isManagedCodexHome } from "@/lib/accounts/codex";
import { claudeProviderForHome, claudeProviderLauncherPath, claudeSettingsPath, claudeTranscriptOwnership, isManagedClaudeHome, legacyClaudeHome } from "@/lib/accounts/claude";
import { homeDirectory } from "@/lib/platformHome";
import { agentCodexPublicationArgs, agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { readCodexShellPolicy } from "@/lib/git/codexShellPolicy";
import { codexMemoryHookArgs, installCodexMemoryHook } from "@/lib/memory/hook";
import { isUnderClaudeSubagentsDir } from "@/lib/scanner/claudeNative";
import { telegramSessionReaderPath } from "@/lib/telegram/packaging";
import { TELEGRAM_CONNECTOR_TOKEN_ENV, telegramSessionPath } from "@/lib/telegram/sessionStore";

import { claudeTranscriptPath, headCwd } from "./transcript";
import { normalizedClaudePermissionMode, readClaudePermissionModeSync } from "./claudePermissionMode";
import { grantedMcpServers } from "./mcpAllowlist";
import { grantedPlugins } from "./pluginAllowlist";
import { normalizeClaudeLaunchModel } from "./models";
import {
  applyClaudeSpawnPolicy, claudeSpawnPolicyPaths, viewerMcpHttpCodexEntry,
  viewerMcpServerEntry, viewerMcpTransportForLaunch, VIEWER_SPAWN_CAPABILITY_ENV,
} from "./spawnPolicy";
import { explicitLaunchProfileSandbox, launchProfileCodexSandbox, launchProfileEngineReadOnly, type LaunchProfile } from "@/lib/accounts/migration/contracts";
import { codexSubagentArgs } from "./codexSpawnPolicy";
import { codexProcessCleanupArgs, codexProcessCleanupConfig } from "./processCleanupPolicy";

export { ENGINE_EFFORTS, isEngineEffort } from "./efforts";

/**
 * The one home for "how do we start an agent CLI": binary resolution, shell
 * quoting, and the boot/resume command specs for both engines. Flag changes
 * (permissions mode, session ids, read-only sandboxes) land here and nowhere
 * else.
 */

export type AgentEngine = "claude" | "codex" | "copilot";

/**
 * Candidate absolute paths for an agent CLI on Windows, in probe order.
 *
 * The native Claude Code installer puts `claude.exe` under
 * `%USERPROFILE%\.local\bin`; a Bun global install puts it under
 * `%USERPROFILE%\.bun\bin`. Only `.exe` is probed. An npm install of Claude
 * Code exposes `claude.cmd`, and `spawn` without a shell cannot run a `.cmd`
 * (Node raises EINVAL), so finding one and returning it would produce a spawn
 * failure instead of a clean "not installed" — the README says to use the
 * native installer. `CreateProcess` searching PATH appends `.exe` and `.com`
 * and never `.cmd`, so the bare-name fallback has the same property.
 *
 * Pure over `home`, so the order is asserted without a Windows filesystem.
 */
export function windowsBinaryCandidates(home: string, name: string): string[] {
  return [
    path.join(home, ".local", "bin", `${name}.exe`),
    path.join(home, ".bun", "bin", `${name}.exe`),
    path.join(home, "AppData", "Local", "Programs", name, `${name}.exe`),
  ];
}

/** Absolute path of an agent CLI when we can find one; bare name otherwise. */
export function resolveBinary(name: string): string {
  if (process.platform === "win32") {
    /* `X_OK` is meaningless on Windows — `fs.access` there answers existence —
       so the probe says what it means. `homeDirectory()` rather than
       `os.homedir()` so an isolated `USERPROFILE` is honoured under Bun. */
    for (const candidate of windowsBinaryCandidates(homeDirectory(), name)) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return name;
  }
  const home = os.homedir();
  if (process.env.LLV_DOCKER_NSENTER_SHIMS === "1" && (name === "claude" || name === "codex" || name === "copilot")) {
    const shim = "/usr/local/bin/" + name;
    try {
      fs.accessSync(shim, fs.constants.X_OK);
      return shim;
    } catch {
      /* keep looking */
    }
  }
  return findAgentBinary(name, { home }) ?? name;
}

function resolveCodexBinary(hostTerminal = false): string {
  return process.env.LLV_CODEX_BINARY?.trim() || (hostTerminal ? resolveHostBinary : resolveBinary)("codex");
}

/** Binary path as the OPERATOR'S OWN terminal resolves it. Inside the runtime
    container the nsenter shim lives at /usr/local/bin and points at container
    plumbing that does not exist on the host, so a command composed for a host
    terminal must never embed it (issue: "Підключитися у своєму терміналі"
    emitted /usr/local/bin/claude → "No such file or directory"). Only the
    mounted $HOME install locations are probed there; system directories are
    container-owned and untrustworthy. Outside a container the system paths are
    probed too. When nothing matches, the bare name defers to the user's PATH. */
export function resolveHostBinary(name: string): string {
  const home = os.homedir();
  const containerized = process.env.LLV_DOCKER_NSENTER_SHIMS === "1";
  // A container PATH belongs to the container, even for the host terminal.
  const candidates = containerized ? [".bun", ".npm-global", ".local", "go"].map((dir) => path.join(home, dir, "bin", name)) : [];
  if (!containerized) return findAgentBinary(name, { home }) ?? name;
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return name;
}

/** The Copilot CLI a structured host launches: `LLV_COPILOT_BIN` when set
    (tests and pinned installs), otherwise the same probe as the other CLIs. */
export function resolveCopilotBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLV_COPILOT_BIN?.trim() || resolveBinary("copilot");
}

/** Why a Copilot launch cannot start on this machine, or null when the CLI
    resolves to an executable. A bare name that no probe found is missing. */
export function copilotBinaryGap(env: NodeJS.ProcessEnv = process.env): string | null {
  const binary = resolveCopilotBinary(env);
  if (!path.isAbsolute(binary)) {
    return "the GitHub Copilot CLI is not installed; install it with `bun add -g @github/copilot@1.0.87` or set LLV_COPILOT_BIN";
  }
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return null;
  } catch {
    return `the GitHub Copilot CLI at ${binary} is not executable`;
  }
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export interface ResumeSpec {
  command: string;
  cwd: string;
  windowName: string;
  engine: AgentEngine;
  /** Transcript path the session will write, when knowable at spawn time —
      a fresh claude session launched with a pre-chosen --session-id. */
  transcript?: string;
  /** Non-interactive `claude -p` command that can never present a permission
      acceptance gate; the only Claude shape a tmux window may still host
      under structured transport (the migration successor fork). */
  printMode?: true;
  launchProfile?: LaunchProfile;
  /** Only legacy launches probe native policy; structured hosts read it themselves. */
  codexPublication?: { home: string; command: string; mcpServers: string[]; operatorDecisionForms?: boolean; subcommand?: string; viewerMcpArgs?: string };
  claudeTerminalPolicy?: { home: string; options: Parameters<typeof applyClaudeSpawnPolicy>[1] };
}

export async function prepareAgentPublicationSpec(spec: ResumeSpec): Promise<ResumeSpec> {
  const input = spec.codexPublication;
  if (!input) return spec;
  const source = { ...process.env, CODEX_HOME: input.home };
  const policy = await readCodexShellPolicy(resolveCodexBinary(), spec.cwd, source);
  const args = agentCodexPublicationArgs(policy, source).map(shellQuote).join(" ");
  return { ...spec, command: telegramScopedCommand(`${codexEnvPrefix(input.home, input.mcpServers)} ${input.command} ${args}${input.subcommand ?? ""}`, input.mcpServers) };
}

export function withSpawnCapability(spec: ResumeSpec, capability: string, source: NodeJS.ProcessEnv = process.env): ResumeSpec {
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("Viewer spawn capability is invalid");
  const identity = Object.entries(agentPublicationIdentityEnv(source))
    .map(([key, value]) => `${key}=${shellQuote(value!)}; export ${key};`).join(" ");
  const publicationEnv = { ...source, LLV_SPAWN_CAPABILITY: capability };
  let command = spec.command;
  try {
    if (spec.claudeTerminalPolicy) {
      const policy = spec.claudeTerminalPolicy;
      applyClaudeSpawnPolicy(policy.home, { ...policy.options, publicationEnv });
    }
    if (spec.codexPublication && !spec.launchProfile?.cleanMemory) {
      const input = spec.codexPublication;
      const hook = installCodexMemoryHook(input.home, publicationEnv);
      if (hook) {
        const policy = input.operatorDecisionForms ? codexOperatorQuestionPolicy(input.home).config : codexProcessCleanupConfig(input.home);
        const args = codexMemoryHookArgs(hook, policy.hooks.state).map(shellQuote).join(" ");
        command = command.replace(input.command, `${input.command} ${args}`);
      }
    }
  } catch { /* optional memory setup cannot stop terminal launch */ }
  if (spec.codexPublication?.viewerMcpArgs) {
    // Terminal HTTP remains opt-in. Select only after the receipt capability
    // exists, using the same access-gate check as structured hosts. Existing
    // registrations retain their transport: Codex merges their fields.
    const requested = source.DELEGATUS_MCP_TRANSPORT ?? source.LLV_MCP_TRANSPORT;
    const flag = { ...source, LLV_MCP_TRANSPORT: requested?.trim() || "stdio" };
    const transport = viewerMcpTransportForLaunch(publicationEnv, flag);
    if (transport === "http") command = command.replace(spec.codexPublication.viewerMcpArgs, codexViewerMcpArgs(transport, flag));
  }
  return {
    ...spec,
    command: `( ${VIEWER_SPAWN_CAPABILITY_ENV}=${shellQuote(capability)}; export ${VIEWER_SPAWN_CAPABILITY_ENV}; ${identity} ${command} )`,
  };
}

export interface FreshSpecOptions {
  cleanMemory?: boolean;
  /** Durable human-readable identity for a viewer-controlled fresh launch. */
  title?: string | null;
  model?: string | null;
  effort?: string | null;
  /** Codex only: true → `service_tier=priority` ("Fast" in the TUI), false →
      `service_tier=standard`; unset leaves the user's config.toml default. */
  fast?: boolean | null;
  serviceTier?: string | null;
  readOnly?: boolean;
  /** Claude only: override the CLI permission mode for a fresh launch. */
  permissionMode?: string | null;
  /** Codex only: explicit account home scoped into the typed host command. */
  codexHome?: string | null;
  /** Claude only: an already-resolved managed config home. */
  claudeConfigDir?: string | null;
  claudeProjectsDir?: string | null;
  /** Allow native Claude sub-agents and the Codex multi-agent feature. */
  allowSubagents?: boolean;
  operatorDecisionForms?: boolean;
  mcpServers?: readonly string[];
  /** Route admission owns policy materialization after its durable reservation. */
  deferClaudeSpawnPolicy?: boolean;
}

const CLAUDE_SHADOWED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEXAI_PROJECT", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "LLV_TOKEN"];

function telegramTokenAssignment(mcpServers: readonly string[]): string {
  if (!mcpServers.includes("telegram")) return "";
  const command = [process.execPath, telegramSessionReaderPath(), path.dirname(telegramSessionPath())].map(shellQuote).join(" ");
  return `unset ${TELEGRAM_CONNECTOR_TOKEN_ENV}; `
    + `if ${TELEGRAM_CONNECTOR_TOKEN_ENV}="$(${command} 2>/dev/null)" `
    + `&& [ "\${#${TELEGRAM_CONNECTOR_TOKEN_ENV}}" -eq 43 ]; then export ${TELEGRAM_CONNECTOR_TOKEN_ENV}; `
    + `else unset ${TELEGRAM_CONNECTOR_TOKEN_ENV}; fi; `;
}

function telegramScopedCommand(command: string, mcpServers: readonly string[]): string {
  const tokenPrelude = mcpServers.includes("telegram")
    ? telegramTokenAssignment(mcpServers)
    : `unset ${TELEGRAM_CONNECTOR_TOKEN_ENV}; `;
  return `( ${tokenPrelude}${command} )`;
}

export function claudeEnvPrefix(home: string, mcpServers: readonly string[] = []): string {
  const provider = claudeProviderForHome(home);
  const unsets = [
    ...CLAUDE_SHADOWED_ENV,
    ...(mcpServers.includes("telegram") ? [] : [TELEGRAM_CONNECTOR_TOKEN_ENV]),
    ...(provider ? ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_HEADERS"] : []),
  ];
  const providerEnv = provider
    ? ` bun ${shellQuote(claudeProviderLauncherPath(home))} --home ${shellQuote(home)} --base-url ${shellQuote(provider.baseUrl)} --default-model ${shellQuote(provider.model)} --small-model ${shellQuote(provider.smallFastModel ?? "")} --header-names ${shellQuote(JSON.stringify(provider.customHeaderNames ?? []))} --`
    : "";
  return `env ${unsets.map((key) => `-u ${key}`).join(" ")} CLAUDE_CONFIG_DIR=${shellQuote(home)}${providerEnv}`;
}

function providerLaunchModel(home: string, requested: string | null | undefined): string | null {
  const provider = claudeProviderForHome(home);
  return provider ? requested === "haiku" && provider.smallFastModel ? provider.smallFastModel : provider.model : requested ?? null;
}

function codexEnvPrefix(home: string, mcpServers: readonly string[]): string {
  const tokenUnset = mcpServers.includes("telegram") ? "" : ` -u ${TELEGRAM_CONNECTOR_TOKEN_ENV}`;
  return `env -u LLV_TOKEN${tokenUnset} CODEX_HOME=${shellQuote(home)}`;
}

export interface ResumeSpecOptions {
  cleanMemory?: boolean;
  model?: string | null;
  effort?: string | null;
  /** Codex only: override the service tier when reopening a conversation. */
  fast?: boolean | null;
  serviceTier?: string | null;
  /** Execution policy inherited from the generation being replaced. */
  readOnly?: boolean | null;
  /** Explicit execution sandbox. When present, repository readOnly metadata
      must not be reinterpreted as an engine restriction. */
  sandbox?: LaunchProfile["sandbox"];
  permissionMode?: string | null;
  allowSubagents?: boolean;
  operatorDecisionForms?: boolean;
  mcpServers?: readonly string[];
  /** Codex plugin grant replayed from the conversation's durable profile
      (issue #687). A resume is the controlled path by which an existing
      session picks the grant up; absent ⇒ no plugin, the default. */
  plugins?: readonly string[];
  /** The conversation's authoritative working directory. When set it is the ONE
      effective cwd used for MCP policy enumeration, materialization, and the
      rendered command. The resume spec otherwise re-derives cwd by sniffing the
      transcript head and silently falls back to `$HOME`, which enumerates
      project-scoped MCP servers in the wrong directory (finding 1). Absent/empty
      ⇒ safe fallback to the sniffed cwd. */
  cwd?: string | null;
  /** The command is destined for the operator's own terminal: resolve the CLI
      binary as the HOST sees it, never the in-container nsenter shim. */
  hostTerminal?: boolean;
  /** Account recorded for this conversation (issue #935). Under the shared
      transcript store (#891) the path names no owner — every account resolves
      to the same root — so this durable provenance is what picks the home the
      resume runs under. Absent ⇒ path layout, then the routed account. */
  accountId?: string | null;
}

/* Re-validation on the way out of the durable launch profile (issue #739): a
   resume or attach replays a stored allowlist, and a stored allowlist can be
   edited by hand, so the command is rendered from the re-bounded list instead
   of the stored one. A resume can therefore never widen its own surface. */
function normalizedMcpServers(value: readonly string[] | undefined): string[] {
  return grantedMcpServers(value);
}

function configuredCodexMcpServers(home: string, cwd: string): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.LLV_TOKEN;
  // eslint-disable-next-line no-restricted-syntax -- Legacy terminal-launch MCP discovery invoked by serving launch controls.
  const listed = spawnSync(resolveCodexBinary(), ["-c", "features.plugins=false", "mcp", "list", "--json"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (listed.status === 0) {
    try {
      const parsed = JSON.parse(listed.stdout) as unknown;
      if (Array.isArray(parsed) && parsed.every((server) => server && typeof server === "object" && typeof (server as { name?: unknown }).name === "string")) {
        return parsed.map((server) => (server as { name: string }).name);
      }
    } catch { /* fail closed below */ }
  }
  throw new Error("Codex MCP configuration could not be enumerated safely");
}

function codexViewerMcpArgs(transport: "stdio" | "http", source: NodeJS.ProcessEnv = process.env): string {
  const entry = transport === "http" ? viewerMcpHttpCodexEntry(source)
    : { ...viewerMcpServerEntry(process.cwd(), source), env_vars: [VIEWER_SPAWN_CAPABILITY_ENV] };
  // Codex's -c parser accepts TOML leaves. Header and environment keys may
  // contain punctuation, so quote them rather than treating them as paths.
  const leaves = (prefix: string, values: Record<string, unknown>): string[] => Object.entries(values).flatMap(([key, value]) => {
    const name = `${prefix}.${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}`;
    return value && typeof value === "object" && !Array.isArray(value)
      ? leaves(name, value as Record<string, unknown>) : [`${name}=${JSON.stringify(value)}`];
  });
  return leaves("mcp_servers.viewer", { ...entry, enabled: true, default_tools_approval_mode: "approve" })
    .map(override => `-c ${shellQuote(override)}`).join(" ");
}

function codexMcpRuntimeOverrides(home: string, cwd: string, allowlist: readonly string[]): { overrides: string[]; viewerMcpArgs: string } {
  const enabled = new Set(allowlist);
  const configured = configuredCodexMcpServers(home, cwd);
  const overrides = [
    /* Plugin-contributed servers (computer-use, github, …) carry no
       `[mcp_servers.*]` block in config.toml, so a fabricated
       `mcp_servers.<name>.enabled` override for them leaves codex a server
       table with only `enabled` — its config loader fails the whole launch
       with "invalid transport". Plugins are off for Viewer-spawned sessions,
       and the enumeration runs under the same flag so the override list can
       never name a plugin server. */
    "features.plugins=false",
    ...configured.map((name) => {
      const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
      return `mcp_servers.${key}.enabled=${enabled.has(name)}`;
    }),
  ];
  return { overrides, viewerMcpArgs: configured.includes("viewer") ? "" : codexViewerMcpArgs("stdio") };
}

function pushClaudePolicyArgs(
  args: string[],
  policy: ReturnType<typeof applyClaudeSpawnPolicy> | ReturnType<typeof claudeSpawnPolicyPaths>,
): void {
  args.push(
    "--settings", policy.settingsPath,
    "--strict-mcp-config", "--mcp-config", policy.mcpConfigPath,
  );
}

export function effectiveClaudePermissionMode(
  options: Pick<ResumeSpecOptions, "readOnly" | "sandbox" | "permissionMode">,
): string {
  return normalizedClaudePermissionMode(options.permissionMode)
    ?? (launchProfileEngineReadOnly(options) ? "plan" : "default");
}

/** Boot spec for a brand-new agent (no prior conversation) in a chosen directory. */
export function freshSpecFor(engine: AgentEngine, cwd: string, options: FreshSpecOptions = {}): ResumeSpec {
  const mcpServers = normalizedMcpServers(options.mcpServers);
  if (engine === "claude") {
    /* A pre-chosen session id makes the transcript path knowable right at
       spawn time (handoff lineage links it before the file exists) and lets
       the scanner pid-match the session by argv, where the cwd fallback would
       stay ambiguous with several agents in one directory. */
    const sid = crypto.randomUUID();
    const args = [resolveBinary("claude")];
    /* Read-only rounds must not inherit the skip-permissions bypass: with it,
       denying Edit/Write still leaves Bash free to mutate the worktree. */
    const permissionMode = effectiveClaudePermissionMode({
      ...options, permissionMode: options.permissionMode ?? (options.readOnly ? "plan" : "bypassPermissions"),
    });
    if (options.readOnly) args.push("--permission-mode", permissionMode, "--disallowedTools", `Edit,Write,NotebookEdit${options.operatorDecisionForms ? ",AskUserQuestion,ExitPlanMode" : ""}`);
    else if (permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", permissionMode);
    if (options.operatorDecisionForms && !options.readOnly) args.push("--disallowedTools", "AskUserQuestion,ExitPlanMode");
    args.push("--session-id", sid);
    const launchModel = providerLaunchModel(options.claudeConfigDir ?? legacyClaudeHome(), options.model);
    if (launchModel) args.push("--model", launchModel);
    if (options.effort) args.push("--effort", options.effort);
    const managed = Boolean(options.claudeConfigDir && isManagedClaudeHome(options.claudeConfigDir));
    const installedPolicy = options.claudeConfigDir
      ? options.deferClaudeSpawnPolicy
        ? claudeSpawnPolicyPaths(options.claudeConfigDir, sid)
        : applyClaudeSpawnPolicy(options.claudeConfigDir, {
          providerAccount: Boolean(claudeProviderForHome(options.claudeConfigDir)),
          allowSubagents: options.allowSubagents,
          cleanMemory: options.cleanMemory,
          cwd,
          mcpServers,
          baseSettingsPath: managed ? claudeSettingsPath() : null,
          profileId: sid,
        })
      : null;
    if (installedPolicy) pushClaudePolicyArgs(args, installedPolicy);
    else args.push("--settings", JSON.stringify({
      ...(engineMemoryOff(options) ? { autoMemoryEnabled: false } : {}),
      env: { ...agentPublicationIdentityEnv(process.env), ...(engineMemoryOff(options) ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {}) },
    }), "--strict-mcp-config");
    const command = args.map(shellQuote).join(" ");
    return {
      command: telegramScopedCommand(`${claudeEnvPrefix(options.claudeConfigDir ?? legacyClaudeHome(), mcpServers)} ${command}`, mcpServers),
      cwd,
      windowName: "claude-new",
      engine: "claude",
      claudeTerminalPolicy: options.claudeConfigDir ? { home: options.claudeConfigDir, options: {
        providerAccount: Boolean(claudeProviderForHome(options.claudeConfigDir)), allowSubagents: options.allowSubagents, cleanMemory: options.cleanMemory,
        cwd, mcpServers, baseSettingsPath: managed ? claudeSettingsPath() : null, profileId: sid,
        mcpStatePath: managed ? path.join(options.claudeConfigDir, ".claude.json") : path.join(path.dirname(options.claudeConfigDir), ".claude.json"),
      } } : undefined,
      ["transcript"]: claudeTranscriptPath(cwd, sid, options.claudeProjectsDir ?? path.join(legacyClaudeHome(), "projects")),
      launchProfile: {
        ...(options.cleanMemory !== undefined ? { cleanMemory: options.cleanMemory } : {}),
        cwd,
        model: options.model ?? null,
        effort: options.effort ?? null,
        fast: null,
        permissionMode,
        readOnly: options.readOnly ?? false,
        allowSubagents: options.allowSubagents ?? false,
        mcpServers,
        /* Plugin grants are a Codex thread capability decided by the spawn
           route from the session's origin (issue #687), never by the command
           builder — a fresh spec carries none. */
        plugins: [],
        title: options.title?.trim() || null,
        project: null,
        parentConversationId: null,
        role: "worker",
        goal: null,
        plan: null,
      },
    };
  }
  if (engine === "copilot") {
    /* Copilot runs on the structured transport only (docs/design/copilot-engine.md
       3.3); this command is what the launch profile records for display, and
       the host builds its own argv from the profile. */
    const permissionMode = options.readOnly ? "default" : options.permissionMode ?? "bypassPermissions";
    const args = [resolveCopilotBinary(), "--acp", "--no-auto-update", "-C", cwd];
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--reasoning-effort", options.effort);
    args.push("--disable-builtin-mcps");
    if (!options.allowSubagents) args.push("--excluded-tools", "task", "read_agent", "write_agent", "list_agents");
    if (permissionMode === "bypassPermissions") args.push("--allow-all");
    return {
      command: args.map(shellQuote).join(" "),
      cwd,
      windowName: "copilot-new",
      engine: "copilot",
      launchProfile: {
        ...(options.cleanMemory !== undefined ? { cleanMemory: options.cleanMemory } : {}),
        cwd,
        model: options.model ?? null,
        effort: options.effort ?? null,
        fast: null,
        permissionMode,
        readOnly: options.readOnly ?? false,
        allowSubagents: options.allowSubagents ?? false,
        mcpServers,
        plugins: [],
        title: options.title?.trim() || null,
        project: null,
        parentConversationId: null,
        role: "worker",
        goal: null,
        plan: null,
      },
    };
  }
  const args = [resolveCodexBinary()];
  if (engineMemoryOff(options)) args.push("-c", "features.memories=false");
  const home = options.codexHome ?? accountForSpawn().home;
  args.push(...agentCodexPublicationArgs({}, process.env));
  if (isManagedCodexHome(home)) args.push("-c", "cli_auth_credentials_store=file");
  const mcp = codexMcpRuntimeOverrides(home, cwd, mcpServers);
  for (const override of mcp.overrides) args.push("-c", override);
  if (options.model) args.push("-m", options.model);
  if (options.effort) args.push("-c", `model_reasoning_effort=${options.effort}`);
  if (options.serviceTier) args.push("-c", `service_tier=${options.serviceTier === "standard" ? "default" : options.serviceTier}`);
  else if (options.fast != null) args.push("-c", `service_tier=${options.fast ? "priority" : "standard"}`);
  if (options.readOnly) args.push("--sandbox", "read-only");
  args.push(...codexSubagentArgs(args[0], options.allowSubagents, process.env, true));
  args.push(...codexProcessCleanupArgs(home));
  if (options.operatorDecisionForms) args.push(...codexOperatorQuestionPolicy(home).args);
  const command = args.map(shellQuote).join(" ") + (mcp.viewerMcpArgs ? ` ${mcp.viewerMcpArgs}` : "");
  return {
    command: telegramScopedCommand(`${codexEnvPrefix(home, mcpServers)} ${command}`, mcpServers),
    codexPublication: { home, command, mcpServers, operatorDecisionForms: options.operatorDecisionForms, viewerMcpArgs: mcp.viewerMcpArgs },
    cwd,
    windowName: "codex-new",
    engine: "codex",
    launchProfile: {
      ...(options.cleanMemory !== undefined ? { cleanMemory: options.cleanMemory } : {}),
      cwd,
      model: options.model ?? null,
      effort: options.effort ?? null,
      fast: options.serviceTier ? !["default", "standard"].includes(options.serviceTier) : options.fast ?? null,
      serviceTier: options.serviceTier ?? null,
      permissionMode: options.readOnly ? "never" : null,
      readOnly: options.readOnly ?? false,
      allowSubagents: options.allowSubagents ?? false,
      mcpServers,
      plugins: [],
      title: options.title?.trim() || null,
      project: null,
      parentConversationId: null,
      role: "worker",
      goal: null,
      plan: null,
    },
  };
}

/** Whether a transcript can be reopened, and — when it cannot — which single
    condition refused it. A caller that only needs the command uses
    {@link resumeSpecFor}; a caller that has to tell the operator why nothing
    happened reads {@link ResumeEligibility.reason}, so diagnosing a refusal
    never again means reading three files. */
export type ResumeEligibility =
  | { ok: true; engine: Extract<AgentEngine, "claude" | "codex">; sessionId: string; home: string; cwd: string }
  | { ok: false; reason: string };

/**
 * The gate {@link resumeSpecFor} applies, with its refusal named. Claude
 * account ownership resolves through {@link claudeTranscriptOwnership}, where
 * the recorded account (`options.accountId`) is what answers inside the shared
 * transcript store — every account resolves to the same root there, so the
 * path names no owner (issue #935).
 */
export function resumeEligibility(root: string, pathname: string, options: ResumeSpecOptions = {}): ResumeEligibility {
  const base = path.basename(pathname);
  /* One effective cwd, chosen before the spec (and its MCP policy enumeration)
     is generated: the caller's recorded cwd is authoritative; only when it is
     absent do we sniff the transcript head (finding 1). */
  const recordedCwd = options.cwd && options.cwd.trim() ? options.cwd : null;
  const cwd = () => recordedCwd ?? resumeCwd(pathname);
  if (root === "claude-projects" && base.endsWith(".jsonl")) {
    if (isUnderClaudeSubagentsDir(pathname)) {
      return { ok: false, reason: "a Claude subagent transcript has no session of its own to resume" };
    }
    const sid = base.slice(0, -".jsonl".length);
    if (!/^[0-9a-f-]{36}$/.test(sid)) return { ok: false, reason: "the transcript filename carries no Claude session id" };
    const ownership = claudeTranscriptOwnership(pathname, options.accountId);
    if (ownership.kind === "unreadable") return { ok: false, reason: "the conversation transcript cannot be read from disk" };
    if (ownership.kind === "foreign") return { ok: false, reason: "the transcript is outside every Claude account transcript root the viewer knows" };
    return { ok: true, engine: "claude", sessionId: sid, home: ownership.home, cwd: cwd() };
  }
  if (root === "codex-sessions" && base.endsWith(".jsonl")) {
    const id = base.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
    if (!id) return { ok: false, reason: "the transcript filename carries no Codex session id" };
    const home = codexHomeOwningSessionPath(pathname);
    if (!home) return { ok: false, reason: "the transcript is outside every Codex account session root the viewer knows" };
    return { ok: true, engine: "codex", sessionId: id, home, cwd: cwd() };
  }
  return { ok: false, reason: "this transcript belongs to no resumable agent session" };
}

/**
 * Shell command that reopens a finished conversation interactively so a new
 * prompt can be typed into it. Claude subagent transcripts have no resumable
 * session of their own, so only root session files qualify.
 */
export function resumeSpecFor(root: string, pathname: string, options: ResumeSpecOptions = {}): ResumeSpec | null {
  const eligibility = resumeEligibility(root, pathname, options);
  if (!eligibility.ok) return null;
  return resumeSpecForSession(eligibility.engine, eligibility.sessionId, eligibility.cwd, eligibility.home, {
    ...options, operatorDecisionForms: options.operatorDecisionForms || operatorDecisionFormsRequired(null, pathname),
    permissionMode: options.permissionMode ?? (eligibility.engine === "claude"
      ? launchProfileEngineReadOnly(options) ? "plan" : readClaudePermissionModeSync(pathname) : null),
  });
}

/**
 * Compose the resume/attach command from an explicit engine + session id + cwd +
 * account home, without waiting for the transcript scanner (round-1 P1#6).
 * The transcript-path form {@link resumeSpecFor} delegates here after sniffing
 * the session id and home off the path; a finalized launch receipt can pass its
 * recorded session id, cwd, and account home directly during scan lag.
 */
export function resumeSpecForSession(
  engine: AgentEngine,
  sessionId: string,
  cwd: string,
  home: string,
  options: ResumeSpecOptions = {},
): ResumeSpec | null {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  const mcpServers = normalizedMcpServers(options.mcpServers);
  if (engine === "claude") {
    const managed = isManagedClaudeHome(home);
    const policy = applyClaudeSpawnPolicy(home, {
      providerAccount: Boolean(claudeProviderForHome(home)),
      allowSubagents: options.allowSubagents,
      cleanMemory: options.cleanMemory,
      baseSettingsPath: managed ? claudeSettingsPath() : null,
      profileId: `resume-${sessionId}`,
      cwd,
      mcpServers,
      mcpStatePath: managed ? path.join(home, ".claude.json") : path.join(path.dirname(home), ".claude.json"),
    });
    const args = [(options.hostTerminal ? resolveHostBinary : resolveBinary)("claude")];
    const permissionMode = effectiveClaudePermissionMode(options);
    const engineReadOnly = launchProfileEngineReadOnly(options);
    if (engineReadOnly || permissionMode === "plan") {
      args.push("--permission-mode", "plan", "--disallowedTools", `Edit,Write,NotebookEdit${options.operatorDecisionForms ? ",AskUserQuestion,ExitPlanMode" : ""}`);
    } else if (permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", permissionMode);
    }
    if (options.operatorDecisionForms && !engineReadOnly && permissionMode !== "plan") args.push("--disallowedTools", "AskUserQuestion,ExitPlanMode");
    pushClaudePolicyArgs(args, policy);
    const launchModel = providerLaunchModel(home, normalizeClaudeLaunchModel(options.model));
    if (launchModel) args.push("--model", launchModel);
    if (options.effort) args.push("--effort", options.effort);
    args.push("--resume", sessionId);
    const command = args.map(shellQuote).join(" ");
    return {
      command: telegramScopedCommand(`${claudeEnvPrefix(home, mcpServers)} ${command}`, mcpServers),
      cwd,
      windowName: "claude-resume",
      engine: "claude",
      claudeTerminalPolicy: { home, options: {
        providerAccount: Boolean(claudeProviderForHome(home)), allowSubagents: options.allowSubagents, cleanMemory: options.cleanMemory,
        cwd, mcpServers, baseSettingsPath: managed ? claudeSettingsPath() : null, profileId: `resume-${sessionId}`,
        mcpStatePath: managed ? path.join(home, ".claude.json") : path.join(path.dirname(home), ".claude.json"),
      } },
      launchProfile: { ...emptyLaunchProfileForResume(cwd, launchModel, options.effort ?? null), ...(options.cleanMemory !== undefined ? { cleanMemory: options.cleanMemory } : {}), readOnly: options.readOnly ?? null, sandbox: explicitLaunchProfileSandbox(options), permissionMode, allowSubagents: options.allowSubagents ?? false, mcpServers, plugins: grantedPlugins(options.plugins) },
    };
  }
  const codexBinary = resolveCodexBinary(options.hostTerminal);
  let command = shellQuote(codexBinary);
  if (engineMemoryOff(options)) command += " -c features.memories=false";
  const publicationArgs = agentCodexPublicationArgs({}, process.env);
  command += ` ${publicationArgs.map(shellQuote).join(" ")}`;
  if (isManagedCodexHome(home)) command += " -c cli_auth_credentials_store=file";
  const mcp = codexMcpRuntimeOverrides(home, cwd, mcpServers);
  for (const override of mcp.overrides) command += ` -c ${shellQuote(override)}`;
  if (mcp.viewerMcpArgs) command += ` ${mcp.viewerMcpArgs}`;
  if (options.model) command += ` -m ${shellQuote(options.model)}`;
  if (options.effort) command += ` -c ${shellQuote(`model_reasoning_effort=${options.effort}`)}`;
  if (options.serviceTier) command += ` -c ${shellQuote(`service_tier=${options.serviceTier === "standard" ? "default" : options.serviceTier}`)}`;
  else if (options.fast != null) command += ` -c ${shellQuote(`service_tier=${options.fast ? "priority" : "standard"}`)}`;
  const codexSandbox = launchProfileCodexSandbox(options);
  if (codexSandbox) command += ` --sandbox ${codexSandbox}`;
  if (options.permissionMode && ["untrusted", "on-request", "never"].includes(options.permissionMode)) {
    command += ` --ask-for-approval ${shellQuote(options.permissionMode)}`;
  }
  command += ` ${codexSubagentArgs(codexBinary, options.allowSubagents, process.env, true).join(" ")}`;
  command += ` ${codexProcessCleanupArgs(home).map(shellQuote).join(" ")}`;
  if (options.operatorDecisionForms) command += ` ${codexOperatorQuestionPolicy(home).args.map(shellQuote).join(" ")}`;
  // Publication must stay with the other global options before resume.
  const subcommand = ` resume ${sessionId}`;
  return {
    command: telegramScopedCommand(`${codexEnvPrefix(home, mcpServers)} ${command}${subcommand}`, mcpServers),
    codexPublication: { home, command, mcpServers, subcommand, operatorDecisionForms: options.operatorDecisionForms, viewerMcpArgs: mcp.viewerMcpArgs },
    cwd,
    windowName: "codex-resume",
    engine: "codex",
    launchProfile: { ...emptyLaunchProfileForResume(cwd, options.model ?? null, options.effort ?? null),
      ...(options.cleanMemory !== undefined ? { cleanMemory: options.cleanMemory } : {}), fast: options.serviceTier ? !["default", "standard"].includes(options.serviceTier) : options.fast ?? null, serviceTier: options.serviceTier ?? null, readOnly: options.readOnly ?? null, sandbox: explicitLaunchProfileSandbox(options), permissionMode: options.permissionMode ?? null, allowSubagents: options.allowSubagents ?? false, mcpServers, plugins: grantedPlugins(options.plugins) },
  };
}

function emptyLaunchProfileForResume(cwd: string, model: string | null, effort: string | null): LaunchProfile {
  return {
    cwd,
    model,
    effort,
    fast: null,
    permissionMode: null,
    readOnly: null,
    allowSubagents: false,
    mcpServers: ["viewer"],
    plugins: [],
    title: null,
    project: null,
    parentConversationId: null,
    role: "worker",
    goal: null,
    plan: null,
  };
}

/** A resume window must land in a directory that still exists; the home
    directory is the safe fallback when the transcript's cwd is gone. */
export function resumeCwd(pathname: string): string {
  return headCwd(pathname, { maxLines: 30, requireDir: true }) ?? os.homedir();
}
