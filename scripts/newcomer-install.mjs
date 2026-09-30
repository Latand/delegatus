import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readInstallPrompt(agent, lang = "en") {
  const context = { window: { DLG: {} } };
  vm.runInNewContext(readFileSync(path.join(root, "landing/site/copy.js"), "utf8"), context);
  return context.window.DLG.copy.prompt(agent, lang);
}

export function promptCommand(prompt, prefix) {
  const command = [...prompt.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]).find((value) => value.startsWith(prefix));
  if (!command) throw new Error(`Install prompt has no command starting with ${prefix}`);
  return command;
}

function shell(command, env) {
  const result = spawnSync("/bin/bash", ["-c", command], { env, encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`Prompt command failed: ${command}\n${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    throw new Error("Harness-owned launcher did not shut down within 15 seconds");
  }
}

async function startCase(label, env, expected, reportDirectory) {
  const port = await availablePort();
  // Run the prompt's installed launcher in the background through a tracked
  // child handle, with an ephemeral port instead of the visitor's stable port.
  const child = spawn(path.join(env.HOME, ".bun/bin/delegatus"), ["--no-open", "--port", String(port)], {
    env, stdio: ["ignore", "pipe", "pipe"], cwd: env.HOME,
  });
  let output = "";
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  const collect = (chunk) => { output = (output + chunk).slice(-200_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  try {
    const deadline = Date.now() + 60_000;
    let presence;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label}: launcher exited before readiness`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
        if (response.status === 200 && output.includes(expected.message)) {
          const probe = await fetch(`http://127.0.0.1:${port}/api/accounts/cli`, { signal: AbortSignal.timeout(5_000) });
          if (probe.status !== 200) throw new Error(`CLI presence returned ${probe.status}`);
          presence = await probe.json();
          break;
        }
      } catch { /* The Viewer is still becoming ready; the outer bound holds. */ }
      await delay(200);
    }
    if (JSON.stringify(presence) !== JSON.stringify(expected.presence)) throw new Error(`${label}: expected CLI presence ${JSON.stringify(expected.presence)}, got ${JSON.stringify(presence)}`);
    if (expected.installer && !output.includes(expected.installer)) throw new Error(`${label}: missing actionable installation command`);
    if (expected.available && output.includes("CLI were not found")) throw new Error(`${label}: available CLI still reported missing`);
    return { case: label, rootStatus: 200, cli: presence, message: expected.message, passed: true };
  } finally {
    try { await stop(child); } finally {
      // The fixture has no personal identities or credentials; keep diagnostic
      // logs bounded and replace its generated home before uploading.
      writeFileSync(path.join(reportDirectory, `${label}.log`), output.replaceAll(env.HOME, "$HOME"));
    }
  }
}

function stub(name, directory, audit) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${audit}'\nif [ "$*" = '--version' ]; then echo '${name} newcomer-stub'; exit 0; fi\nif [ "$1 $2 $3" = 'mcp add viewer' ]; then command -v delegatus-mcp >/dev/null; exit $?; fi\nexit 97\n`);
  chmodSync(file, 0o755);
  return file;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("The clean-machine rehearsal requires macOS");
  const target = process.argv[2];
  const reportDirectory = path.resolve(process.argv[3] ?? "newcomer-report");
  if (!target) throw new Error("Usage: bun scripts/newcomer-install.mjs <tarball-or-npm-package> <report-directory>");
  mkdirSync(reportDirectory, { recursive: true });
  const fixture = mkdtempSync(path.join(os.tmpdir(), "dlg-newcomer-"));
  const home = path.join(fixture, "home");
  mkdirSync(home);
  // Start with a new home, no credentials and only runner system tools on PATH.
  const env = {
    HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
    TMPDIR: fixture, XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_CACHE_HOME: path.join(fixture, "cache"),
    LLV_STATE_DIR: path.join(fixture, "state"), LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"), NEXT_TELEMETRY_DISABLED: "1",
  };
  const rows = [];
  const report = { platform: process.platform, source: target.endsWith(".tgz") ? "checkout tarball" : "npm release", rows, passed: false };
  try {
    const prompt = readInstallPrompt("claude");
    shell(promptCommand(prompt, "curl -fsSL https://bun.com/install"), env);
    env.PATH = `${home}/.bun/bin:${home}/.local/bin:${env.PATH}`;
    const bunVersion = shell(promptCommand(prompt, "bun --version"), env);
    report.bunVersion = bunVersion;
    const [major, minor] = bunVersion.split(".").map(Number);
    if (!(major > 1 || major === 1 && minor >= 4)) throw new Error("The prompt requires Bun 1.4+");
    // Same install command, substituting the exact subject this run verifies.
    // Target is passed via an env value rather than interpolated shell text.
    shell(promptCommand(prompt, "bun add -g delegatus-cli").replace("delegatus-cli", '"$NEWCOMER_PACKAGE"'), { ...env, NEWCOMER_PACKAGE: target });
    rows.push(await startCase("neither-cli", env, {
      message: "Claude Code CLI and Codex CLI were not found", presence: { claude: "missing", codex: "missing" },
      installer: "curl -fsSL https://claude.ai/install.sh | bash",
    }, reportDirectory));
    const audit = path.join(fixture, "stub-calls.txt");
    for (const agent of ["claude", "codex"]) {
      const stubDirectory = path.join(fixture, `path-${agent}`);
      stub(agent, stubDirectory, audit);
      const withStub = { ...env, PATH: `${stubDirectory}:${env.PATH}` };
      const variant = readInstallPrompt(agent);
      shell(promptCommand(variant, `${agent} --version`), withStub);
      shell(promptCommand(variant, `${agent} mcp add viewer`), withStub);
      rows.push(await startCase(`path-${agent}`, withStub, {
        message: `Agent CLI: ${agent}. Sign in`, available: true,
        presence: { claude: agent === "claude" ? "found" : "missing", codex: agent === "codex" ? "found" : "missing" },
      }, reportDirectory));
    }
    stub("codex", path.join(home, "Applications/Codex.app/Contents/Resources"), audit);
    rows.push(await startCase("desktop-bundle", env, {
      message: "Agent CLI: codex. Sign in", available: true, presence: { claude: "missing", codex: "found" },
    }, reportDirectory));
    const calls = readFileSync(audit, "utf8").trim().split("\n");
    if (calls.some((call) => call !== "--version" && !call.startsWith("mcp add viewer"))) throw new Error("A stub received a login or agent-run command");
    report.stubCommands = [...new Set(calls.map((call) => call.replaceAll(home, "$HOME")))];
    report.passed = true;
  } finally {
    writeFileSync(path.join(reportDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
