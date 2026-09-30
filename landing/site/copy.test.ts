import { expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

export function installPrompt(agent: string, lang = "en"): string {
  const context = { window: { DLG: {} as { copy?: { prompt: (agent: string, lang: string) => string } } } };
  vm.runInNewContext(fs.readFileSync(new URL("./copy.js", import.meta.url), "utf8"), context);
  return context.window.DLG.copy!.prompt(agent, lang);
}

for (const agent of ["claude", "codex"]) {
  test(`${agent} prompt verifies CLI before start, fixes PATH and registers MCP afterwards`, () => {
    const prompt = installPrompt(agent);
    expect(prompt.indexOf(`${agent} --version`)).toBeLessThan(prompt.indexOf("bun add -g delegatus-cli"));
    expect(prompt).toContain('export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"');
    expect(prompt).toContain(`${agent} mcp add viewer`);
    expect(prompt).toContain('-- "$HOME/.bun/bin/bun" "$HOME/.bun/bin/delegatus-mcp"');
    expect(prompt.indexOf(`${agent} mcp add viewer`)).toBeGreaterThan(prompt.indexOf("nohup"));
    expect(installPrompt(agent, "uk")).toBe(prompt + "\n\nВідповідай українською.");
  });
}
test("desktop-specific advice names only the verified Codex bundle and Claude separate installer", () => {
  expect(installPrompt("claude")).toContain("Claude Desktop requires a separate Claude Code CLI");
  expect(installPrompt("codex")).toContain("/Applications/Codex.app/Contents/Resources/codex");
  expect(installPrompt("codex")).toContain("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  expect(installPrompt("codex")).not.toContain("bun add -g @openai/codex");
});
