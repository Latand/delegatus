import { expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";
import { telemetryNotice } from "../../bin/telemetry-notice.mjs";

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
    expect(prompt).toContain('export BUN_INSTALL="$HOME/.bun"');
    expect(prompt).toContain(`${agent} mcp add viewer`);
    expect(prompt).toContain('-- "$(command -v bun)" "$HOME/.bun/bin/delegatus-mcp"');
    expect(prompt.indexOf(`${agent} mcp add viewer`)).toBeGreaterThan(prompt.indexOf("nohup"));
    const ukrainian = installPrompt(agent, "uk");
    expect(prompt).toContain(`At the end of the install, show the user: ${telemetryNotice.en}`);
    expect(ukrainian).toContain(`Наприкінці встановлення покажи користувачеві: ${telemetryNotice.uk}`);
    expect(ukrainian.endsWith("\n\nВідповідай українською.")).toBe(true);
    expect(ukrainian.slice(0, ukrainian.indexOf("Наприкінці встановлення"))).toBe(prompt.slice(0, prompt.indexOf("At the end of the install")));
  });
}
test("desktop-specific advice names only the verified Codex bundle and Claude separate installer", () => {
  expect(installPrompt("claude")).toContain("Claude Desktop requires a separate Claude Code CLI");
  expect(installPrompt("codex")).toContain("/Applications/Codex.app/Contents/Resources/codex");
  expect(installPrompt("codex")).toContain("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  expect(installPrompt("codex")).not.toContain("bun add -g @openai/codex");
});

function strings(): Record<string, Record<string, string>> {
  const context = { window: { DLG: {} as { copy?: { strings: Record<string, Record<string, string>> } } } };
  vm.runInNewContext(fs.readFileSync(new URL("./copy.js", import.meta.url), "utf8"), context);
  return context.window.DLG.copy!.strings;
}

test("footer offers either CLI and narrates the install in the prompt's order", () => {
  const { en, uk } = strings();
  expect(en["foot.line"]).toContain("Claude Code or Codex");
  expect(uk["foot.line"]).toContain("Claude Code або Codex");
  expect(en["foot.does"]).toContain("installs and starts Delegatus on this machine, connects itself to it");
  expect(uk["foot.does"]).toContain("встановить і запустить Delegatus на цій машині, підключиться до нього");
  const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  for (const key of ["foot.line", "foot.does"]) expect(html).toContain(`data-i18n="${key}">${en[key]}</p>`);
});

test("hero runs the official CLIs, the description fits a search snippet, and the page's fallbacks match", () => {
  const { en, uk } = strings();
  expect(en["hero.promise"]).toContain("Runs the official CLIs");
  expect(uk["hero.promise"]).toContain("Запускає офіційні CLI");
  for (const lang of [en, uk]) {
    expect(lang["meta.description"].length).toBeLessThanOrEqual(155);
    expect(lang["meta.description"]).toMatch(/Free and open source|Безкоштовно, з відкритим кодом/);
  }
  const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  for (const key of ["hero.sub", "hero.promise"]) expect(html).toContain(`data-i18n="${key}">${en[key]}</p>`);
  expect(html).toContain(`<meta name="description" content="${en["meta.description"]}">`);
});
