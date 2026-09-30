import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentBinaryCandidates, agentStartupMessage, findAgentBinary } from "./agent-binaries.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dlg-binaries-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const options = { home: root, platform: "darwin", envPath: "", includeSystem: false };
function executable(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

test("clean machine has actionable English and Ukrainian guidance without logging in", () => {
  for (const lang of ["en", "uk"]) {
    const message = agentStartupMessage(lang, options);
    expect(message).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(message).toContain("bun add -g @openai/codex");
    expect(message).toContain("Claude Desktop");
  }
});

test("PATH-only executable is detected, without treating presence as authentication", () => {
  const bin = path.join(root, "path-only");
  executable(path.join(bin, "claude"));
  expect(findAgentBinary("claude", { ...options, envPath: bin })).toBe(path.join(bin, "claude"));
  expect(agentStartupMessage("en", { ...options, envPath: bin })).toContain("Agent CLI: claude. Sign in");
});

test("macOS bundle follows PATH and is never guessed for Claude or Linux", () => {
  const mac = agentBinaryCandidates("codex", { home: root, platform: "darwin", envPath: "/custom/bin" });
  expect(mac).toContain("/Applications/Codex.app/Contents/Resources/codex");
  expect(mac).toContain(path.join(root, "Applications/Codex.app/Contents/Resources/codex"));
  expect(mac.indexOf("/custom/bin/codex")).toBeLessThan(mac.indexOf("/Applications/Codex.app/Contents/Resources/codex"));
  expect(agentBinaryCandidates("claude", { platform: "darwin" }).join("\n")).not.toContain(".app/");
  expect(agentBinaryCandidates("codex", { platform: "linux" }).join("\n")).not.toContain(".app/");
});

test("finds executable in a user app bundle, rejects directories and non-executable files", () => {
  const home = path.join(root, "bundle-home");
  const bundle = path.join(home, "Applications/Codex.app/Contents/Resources/codex");
  executable(bundle);
  expect(findAgentBinary("codex", { home, platform: "darwin", envPath: "", includeSystem: false })).toBe(bundle);
  fs.chmodSync(bundle, 0o644);
  // Limit this negative probe to our fixture, regardless of host-installed CLIs.
  expect(findAgentBinary("codex", { home, platform: "darwin", envPath: path.dirname(bundle), includeSystem: false })).toBeNull();
  fs.mkdirSync(path.join(home, ".bun/bin/claude"), { recursive: true });
  expect(findAgentBinary("claude", { ...options, home })).toBeNull();
});

test("Windows candidates keep native exe launchers and never return npm cmd wrappers", () => {
  const candidates = agentBinaryCandidates("claude", { home: root, platform: "win32", envPath: "" });
  expect(candidates.every((file) => file.endsWith(".exe"))).toBe(true);
});

test("installed launcher runs with Bun alone and no Node on PATH", () => {
  if (process.platform === "win32") return;
  const bin = path.join(root, "bun-only");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, "bun"));
  const child = spawnSync(new URL("./cli.mjs", import.meta.url).pathname, ["--version"], {
    env: { HOME: root, PATH: bin, LLV_STATE_DIR: path.join(root, "state"), LANG: "en_US.UTF-8", NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000,
  });
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(child.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

test("MCP entrypoint starts with Bun alone and closes on EOF", () => {
  if (process.platform === "win32") return;
  const bin = path.join(root, "mcp-bun-only");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "bun"));
  const fixture = path.join(root, "mcp-package");
  fs.mkdirSync(path.join(fixture, "bin"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "dist"));
  for (const name of ["mcp-server.mjs", "server-runtime.mjs", "appDir.mjs", "envAlias.mjs", "self-update-supervisor.mjs"]) {
    fs.copyFileSync(new URL(`./${name}`, import.meta.url), path.join(fixture, "bin", name));
  }
  const launcher = path.join(fixture, "bin/mcp-server.mjs");
  fs.chmodSync(launcher, 0o755);
  fs.writeFileSync(path.join(fixture, "dist/mcp-server.mjs"), 'process.stdout.write("Bun MCP fixture\\n"); process.stdin.resume();');
  const child = spawnSync(launcher, [], {
    env: { HOME: root, PATH: bin, LLV_STATE_DIR: path.join(root, "mcp-state"), LANG: "en_US.UTF-8", NODE_ENV: "test" },
    input: "", encoding: "utf8", timeout: 10_000,
  });
  expect(child.stderr).not.toContain("No such file or directory");
  expect(child.status).toBe(0);
  expect(child.stdout).toContain("Bun MCP fixture");
});
