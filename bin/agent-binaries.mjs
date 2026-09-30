import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Shared by the launcher and agent launch seams; no login or agent execution. */
export function agentBinaryCandidates(name, {
  home = os.homedir(), platform = process.platform, envPath = process.env.PATH ?? "",
  includeSystem = true,
} = {}) {
  if (platform === "win32") {
    return [
      path.join(home, ".local", "bin", `${name}.exe`),
      path.join(home, ".bun", "bin", `${name}.exe`),
      path.join(home, "AppData", "Local", "Programs", name, `${name}.exe`),
      ...envPath.split(";").filter(Boolean).map((dir) => path.join(dir, `${name}.exe`)),
    ];
  }
  return [
    ...[".bun", ".npm-global", ".local", "go"].map((dir) => path.join(home, dir, "bin", name)),
    ...(includeSystem ? ["/usr/local/bin/" + name, "/usr/bin/" + name] : []),
    ...(platform === "darwin" && includeSystem ? ["/opt/homebrew/bin/" + name] : []),
    ...envPath.split(":").filter(Boolean).map((dir) => path.join(dir, name)),
    // OpenAI documents this executable; Claude Desktop requires a separate CLI.
    ...(platform === "darwin" && name === "codex" ? [
      path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      ...(includeSystem ? ["/Applications/Codex.app/Contents/Resources/codex"] : []),
    ] : []),
  ];
}

export function findAgentBinary(name, options = {}) {
  const platform = options.platform ?? process.platform;
  for (const candidate of agentBinaryCandidates(name, options)) {
    try {
      fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Try the next install location. */ }
  }
  return null;
}

export function agentStartupMessage(lang = "en", options = {}) {
  const available = ["claude", "codex"].filter((name) => findAgentBinary(name, options));
  if (available.length) return lang === "uk"
    ? `  Agent CLI: ${available.join(", ")}. Увійдіть в обліковий запис у майстрі налаштування.`
    : `  Agent CLI: ${available.join(", ")}. Sign in through the setup guide to run agents.`;
  return lang === "uk"
    ? "  Claude Code CLI і Codex CLI не знайдено. Для оркестратора встановіть один із них:\n  Claude Code: curl -fsSL https://claude.ai/install.sh | bash\n  Codex: bun add -g @openai/codex\n  Claude Desktop потребує окремого CLI. Codex.app може містити CLI; перевірте встановлення.\n  Після встановлення перезапустіть Delegatus і відкрийте майстер налаштування."
    : "  Claude Code CLI and Codex CLI were not found. Install either to run an orchestrator:\n  Claude Code: curl -fsSL https://claude.ai/install.sh | bash\n  Codex: bun add -g @openai/codex\n  Claude Desktop requires a separate CLI. Codex.app may include a CLI; check its installation.\n  After installing, restart Delegatus and open the setup guide.";
}
