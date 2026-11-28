/**
 * The commands the Accounts step offers for an engine whose command-line tool is
 * missing. They are the ones `delegatus start` prints when it finds no agent
 * CLI (`bin/agent-binaries.mjs`, `agentStartupMessage`), so the page and the
 * terminal never disagree; `agentInstallCommands.test.ts` holds them together.
 *
 * `segments` are the places a narrow row may break: after the flags, after the
 * domain's slash and after each path slash. `https://` stays whole and the pipe
 * stays with the file it follows. The copied text is the joined command.
 */
export const AGENT_INSTALL_COMMANDS: Record<"claude" | "codex", { command: string; segments: readonly string[] }> = {
  claude: {
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    segments: ["curl -fsSL ", "https://claude.ai/", "install.sh | bash"],
  },
  codex: {
    command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    segments: ["curl -fsSL ", "https://chatgpt.com/", "codex/", "install.sh | sh"],
  },
};

/**
 * The Antigravity CLI's installer, from Google's install page. Kept out of
 * `AGENT_INSTALL_COMMANDS` because that table is held equal to `delegatus
 * start`'s message, and `agy` is an optional engine that message does not
 * install.
 */
export const ANTIGRAVITY_INSTALL_COMMAND: { command: string; segments: readonly string[] } = {
  command: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  segments: ["curl -fsSL ", "https://antigravity.google/", "cli/", "install.sh | bash"],
};

/** The host systems whose rows differ (docs/design/onboarding-v2.md §7); every other system reads as Linux. */
export type HostPlatform = "linux" | "darwin" | "win32";

export function hostPlatformOf(value: unknown): HostPlatform {
  return value === "win32" || value === "darwin" ? value : "linux";
}

type InstallLine = { command: string; segments: readonly string[] };

/**
 * The vendors' PowerShell installers, for a Delegatus that runs on Windows
 * itself. A row there shows the line to copy and no button. The break points
 * follow the same rule: after the verb and after each slash.
 */
export const AGENT_INSTALL_COMMANDS_POWERSHELL: Record<"claude" | "codex" | "antigravity", InstallLine> = {
  claude: {
    command: "irm https://claude.ai/install.ps1 | iex",
    segments: ["irm ", "https://claude.ai/", "install.ps1 | iex"],
  },
  codex: {
    command: "irm https://chatgpt.com/codex/install.ps1 | iex",
    segments: ["irm ", "https://chatgpt.com/", "codex/", "install.ps1 | iex"],
  },
  antigravity: {
    command: "irm https://antigravity.google/cli/install.ps1 | iex",
    segments: ["irm ", "https://antigravity.google/", "cli/", "install.ps1 | iex"],
  },
};

/** The line a not-installed row shows for the system Delegatus runs on. */
export function agentInstallCommand(engine: "claude" | "codex" | "antigravity", platform: HostPlatform): InstallLine {
  if (platform === "win32") return AGENT_INSTALL_COMMANDS_POWERSHELL[engine];
  return engine === "antigravity" ? ANTIGRAVITY_INSTALL_COMMAND : AGENT_INSTALL_COMMANDS[engine];
}
