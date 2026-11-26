/**
 * The commands the Engines step offers for an engine whose command-line tool is
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
