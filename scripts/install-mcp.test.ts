import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

/**
 * `scripts/install-mcp.sh`, run for real against a sandboxed home and accounts
 * root. PATH holds only the tools the script uses, so no `claude` CLI is found
 * and nothing outside the sandbox is read or written.
 */

const SCRIPT = path.join(process.cwd(), "scripts", "install-mcp.sh");
const LAUNCHER = path.join(process.cwd(), "bin", "mcp-server.mjs");
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-install-mcp-"));
  sandboxes.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const tool of ["dirname", "basename", "awk", "grep", "mktemp", "chmod", "mv", "cat"]) {
    const found = ["/usr/bin", "/bin"].map((directory) => path.join(directory, tool)).find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error(`${tool} is not installed`);
    fs.symlinkSync(found, path.join(bin, tool));
  }
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const account = (id: string, config: string) => {
    const directory = path.join(root, "config", "accounts", "codex", id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "config.toml"), config, { mode: 0o600 });
    return path.join(directory, "config.toml");
  };
  const run = (transport?: string) => {
    const result = spawnSync("/bin/bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: bin,
        HOME: home,
        LLV_CONFIG_ROOT: path.join(root, "config"),
        LLV_MCP_BIN: LAUNCHER,
        ...(transport ? { LLV_MCP_TRANSPORT: transport } : {}),
      },
    });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  return { home, account, run };
}

const STDIO_REGISTRATION = 'model = "x"\n\n[mcp_servers.viewer]\ncommand = "bun"\nargs = ["/old/bin/mcp-server.mjs"]\n\n[mcp_servers.viewer.env]\nFOO = "1"\n\n[notice]\nhide = true\n';

test("the HTTP switch removes the Codex account registration, so each launch decides its own transport", () => {
  const { home, account, run } = sandbox();
  const registered = account("a", STDIO_REGISTRATION);
  const unregistered = account("b", 'model = "y"\n');
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), STDIO_REGISTRATION);

  const first = run("http");
  expect(first).toContain("codex[a]: viewer registration removed");
  expect(first).toContain("codex[b]: viewer not registered");
  /* The table and its sub-table go; everything else stays, and so does the mode. */
  expect(fs.readFileSync(registered, "utf8")).toBe('model = "x"\n\n[notice]\nhide = true\n');
  expect(fs.statSync(registered).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(unregistered, "utf8")).toBe('model = "y"\n');
  /* The operator's own Codex config is never touched. */
  expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toBe(STDIO_REGISTRATION);
  expect(run("http")).toContain("codex[a]: viewer not registered");

  /* Back to stdio: the launcher is registered again. */
  expect(run("stdio")).toContain("codex[a]: viewer added");
  expect(fs.readFileSync(registered, "utf8")).toContain(`[mcp_servers.viewer]\ncommand = "bun"\nargs = ["${LAUNCHER}"]`);
});

test("a leftover url registration is rewritten to the stdio launcher, never kept", () => {
  const { account, run } = sandbox();
  const leftover = account("a", 'model = "x"\n\n[mcp_servers.viewer]\nurl = "http://127.0.0.1:8898/api/mcp"\nenv_http_headers = { "x-llv-spawn-capability" = "LLV_SPAWN_CAPABILITY" }\n');
  expect(run()).toContain("codex[a]: viewer switched to stdio");
  const config = fs.readFileSync(leftover, "utf8");
  expect(config).not.toContain("url =");
  expect(config).toContain('command = "bun"');
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
  /* The viewer table is replaced whole, the way a url registration is: the
     other server keeps its entry, even one that names the old package. */
  const repointed = fs.readFileSync(userToml, "utf8");
  expect(repointed).toContain(`[mcp_servers.other]\ncommand = "bun"\nargs = ["${oldLauncher}"]`);
  expect(repointed).toContain(`[mcp_servers.viewer]\ncommand = "bun"\nargs = ["${stableLauncher}"]`);
  expect(repointed.match(/^\[mcp_servers\.viewer\]$/gm)).toHaveLength(1);
  expect(stdout).toContain("codex[second]: viewer already registered");
  expect(fs.readFileSync(accountToml, "utf8")).toBe(customised);
});
