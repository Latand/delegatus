import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("fresh Claude and Codex registrations use the managed stable MCP executable", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-install-mcp-"));
  sandboxes.push(sandbox);
  const fakeBin = path.join(sandbox, "bin");
  const stableLauncher = path.join(sandbox, ".agents", "tools", "llv-mcp-runtime", "bin", "mcp-server.mjs");
  const claudeLog = path.join(sandbox, "claude.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.dirname(stableLauncher), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".codex"), { recursive: true });
  fs.writeFileSync(stableLauncher, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(path.join(sandbox, ".codex", "config.toml"), "", "utf8");
  const fakeClaude = path.join(fakeBin, "claude");
  fs.writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1 $2 $3" = "mcp get viewer" ]; then exit 1; fi
printf '%s\\n' "$*" >> "$LLV_TEST_CLAUDE_LOG"
`, { mode: 0o755 });

  const child = Bun.spawn({
    cmd: ["bash", path.join(process.cwd(), "scripts", "install-mcp.sh")],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: sandbox,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      LLV_TEST_CLAUDE_LOG: claudeLog,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("claude[user]: viewer added");
  expect(fs.readFileSync(claudeLog, "utf8")).toContain(`mcp add viewer -s user -- bun ${stableLauncher}`);
  expect(fs.readFileSync(path.join(sandbox, ".codex", "config.toml"), "utf8"))
    .toContain(`args = ["${stableLauncher}"]`);
});

test("a registration that runs the renamed agent-log-viewer package is repointed, and every other one is left alone", async () => {
  /* rename-delegatus.md §3.3: an install of the package before the rename
     registered a launcher inside that package, which stops existing once the
     package is gone. */
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-install-mcp-repoint-"));
  sandboxes.push(sandbox);
  const fakeBin = path.join(sandbox, "bin");
  const stableLauncher = path.join(sandbox, ".agents", "tools", "llv-mcp-runtime", "bin", "mcp-server.mjs");
  const oldLauncher = path.join(sandbox, ".npm-global", "lib", "node_modules", "agent-log-viewer", "bin", "mcp-server.mjs");
  const claudeLog = path.join(sandbox, "claude.log");
  const accounts = path.join(sandbox, ".config", "agent-log-viewer", "accounts");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.dirname(stableLauncher), { recursive: true });
  fs.writeFileSync(stableLauncher, "#!/usr/bin/env node\n", { mode: 0o755 });
  const userToml = path.join(sandbox, ".codex", "config.toml");
  const accountToml = path.join(accounts, "codex", "second", "config.toml");
  const userCodex = [
    "[mcp_servers.other]",
    'command = "bun"',
    `args = ["${oldLauncher}"]`,
    "",
    "[mcp_servers.viewer]",
    'command = "bun"',
    `args = ["${oldLauncher}"]`,
    "",
  ].join("\n");
  const customised = ["[mcp_servers.viewer]", 'command = "node"', 'args = ["/opt/custom/viewer.mjs"]', ""].join("\n");
  fs.mkdirSync(path.dirname(userToml), { recursive: true });
  fs.mkdirSync(path.dirname(accountToml), { recursive: true });
  fs.writeFileSync(userToml, userCodex, "utf8");
  fs.writeFileSync(accountToml, customised, "utf8");
  /* The operator's own Claude still runs the old package; nothing else is
     registered anywhere. */
  fs.writeFileSync(path.join(fakeBin, "claude"), `#!/bin/sh
if [ "$1 $2 $3" = "mcp get viewer" ]; then
  if [ -z "$CLAUDE_CONFIG_DIR" ]; then printf 'viewer:\\n  Command: bun\\n  Args: ${oldLauncher}\\n'; exit 0; fi
  exit 1
fi
printf '%s|%s\\n' "\${CLAUDE_CONFIG_DIR:-user}" "$*" >> "$LLV_TEST_CLAUDE_LOG"
`, { mode: 0o755 });

  const child = Bun.spawn({
    cmd: ["bash", path.join(process.cwd(), "scripts", "install-mcp.sh")],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: sandbox,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      LLV_TEST_CLAUDE_LOG: claudeLog,
      XDG_CONFIG_HOME: path.join(sandbox, ".config"),
      /* The user-default registration is the one without a config dir. */
      CLAUDE_CONFIG_DIR: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("claude[user]: viewer repointed from the agent-log-viewer package");
  expect(fs.readFileSync(claudeLog, "utf8").split("\n").filter(Boolean)).toEqual([
    "user|mcp remove viewer -s user",
    `user|mcp add viewer -s user -- bun ${stableLauncher}`,
  ]);
  expect(stdout).toContain("codex[user]: viewer repointed from the agent-log-viewer package");
  expect(fs.readFileSync(userToml, "utf8")).toBe(userCodex.replace(
    `[mcp_servers.viewer]\ncommand = "bun"\nargs = ["${oldLauncher}"]`,
    `[mcp_servers.viewer]\ncommand = "bun"\nargs = ["${stableLauncher}"]`,
  ));
  expect(stdout).toContain("codex[second]: viewer already registered");
  expect(fs.readFileSync(accountToml, "utf8")).toBe(customised);
});
