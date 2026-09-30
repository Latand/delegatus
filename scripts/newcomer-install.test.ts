import { expect, test } from "bun:test";
import { promptCommand, readInstallPrompt } from "./newcomer-install.mjs";

test("rehearsal consumes the shipped commands for both prompt variants", () => {
  for (const agent of ["claude", "codex"]) {
    const prompt = readInstallPrompt(agent);
    expect(promptCommand(prompt, "bun add -g delegatus-cli")).toBe("bun add -g delegatus-cli");
    expect(promptCommand(prompt, "curl -fsSL https://bun.com/install")).toBe("curl -fsSL https://bun.com/install | bash");
    expect(promptCommand(prompt, `${agent} --version`)).toBe(`${agent} --version`);
    expect(promptCommand(prompt, `${agent} mcp add viewer`)).toContain('-- "$HOME/.bun/bin/bun" "$HOME/.bun/bin/delegatus-mcp"');
    expect(promptCommand(prompt, "mkdir -p ~/.cache/delegatus")).toContain("~/.bun/bin/delegatus --no-open");
  }
});

test("prompt drift fails explicitly instead of skipping a missing step", () => {
  expect(() => promptCommand("No commands", "bun add")).toThrow("Install prompt has no command");
});
