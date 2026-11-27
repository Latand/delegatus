import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const retentionRunIdEnv = "LLV_RETENTION_RUN_ID";

export function readInstallPrompt(agent, lang = "en", promptRoot = root) {
  const context = { window: { DLG: {} } };
  vm.runInNewContext(readFileSync(path.join(promptRoot, "landing/site/copy.js"), "utf8"), context);
  return context.window.DLG.copy.prompt(agent, lang);
}

export function promptCommand(prompt, prefix) {
  const command = [...prompt.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]).find((value) => value.startsWith(prefix));
  if (!command) throw new Error(`Install prompt has no command starting with ${prefix}`);
  return command;
}

/** Startup can read account status and registered MCPs without signing in. */
export function safeStubCall(call) {
  return ["--version", "auth status --json", "login status", "-c features.plugins=false mcp list --json",
    // The account-status client disables MCP and uses file credentials. The
    // stub exits 97 before any RPC, so this cannot sign in or execute a turn.
    "-c cli_auth_credentials_store=file -c mcp_servers={} app-server",
  ].includes(call)
    || call.startsWith("mcp add viewer ");
}

function publicFixtureText(value, home) {
  const realHome = realpathSync(home);
  return value.replaceAll(realHome, "$HOME").replaceAll(home, "$HOME")
    .replaceAll(path.dirname(realHome), "<fixture>").replaceAll(path.dirname(home), "<fixture>");
}

function installedPackageRoot(bunInstall) {
  return path.join(bunInstall, "install/global/node_modules/delegatus-cli");
}

export function installedPackageIdentity(bunInstall) {
  const { name, version, gitHead } = JSON.parse(readFileSync(path.join(installedPackageRoot(bunInstall), "package.json"), "utf8"));
  if (name !== "delegatus-cli" || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Installed package has no recognized Delegatus version");
  }
  return { version, ...(typeof gitHead === "string" && /^[a-f0-9]{40}$/.test(gitHead) && { revision: gitHead }) };
}

function requiresRetentionCompletion(bunInstall) {
  // A checkout tarball can share the npm release's version. Inspect the
  // installed server, where the run-ID transport can live in a shared chunk.
  const server = path.join(installedPackageRoot(bunInstall), "dist/standalone/.next/server");
  // An unknown package layout still requires the terminal marker.
  if (!lstatSync(server, { throwIfNoEntry: false })) return true;
  const files = readdirSync(server, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile() && entry.name.endsWith(".js"));
  return files.length === 0 || files.some((entry) =>
    readFileSync(path.join(entry.parentPath, entry.name), "utf8").includes(retentionRunIdEnv));
}

function shell(command, env) {
  const result = spawnSync("/bin/bash", ["-c", command], { env, cwd: env.HOME, encoding: "utf8", timeout: 120_000 });
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

async function waitForRetention(file, { runId, launchedAt, terminal, diagnostic, launcherExited, timeoutMs }) {
  const deadline = performance.now() + timeoutMs;
  const legacyDiagnosticSettleMs = 250;
  let legacyReceiptFirstSeenAt;
  let report;
  while (performance.now() < deadline) {
    if (launcherExited()) return { status: "unavailable", reason: "launcher exited before retention receipt" };
    try {
      const candidate = JSON.parse(readFileSync(file, "utf8"));
      const at = typeof candidate?.at === "string" ? Date.parse(candidate.at) : NaN;
      if (!Number.isFinite(at) || !Array.isArray(candidate.errors) || !candidate.errors.every((error) => typeof error === "string")
        || !Array.isArray(candidate.removed) || !Array.isArray(candidate.kept)
        || !Number.isFinite(candidate.reclaimedCacheBytes) || candidate.reclaimedCacheBytes < 0) {
        return { status: "unavailable", reason: "invalid retention receipt" };
      }
      if (!runId && Object.hasOwn(candidate, "runId")) {
        return { status: "unavailable", reason: "legacy retention receipt contains a run ID" };
      }
      if (!runId && (at < launchedAt || lstatSync(file).mtimeMs < launchedAt)) {
        return { status: "unavailable", reason: "retention receipt predates launcher" };
      }
      report = candidate;
    } catch (error) {
      if (error instanceof SyntaxError) return { status: "unavailable", reason: "invalid retention receipt" };
      if (error.code !== "ENOENT") return { status: "unavailable", reason: "cannot read retention receipt" };
    }
    const completion = runId ? terminal() : report && { errorCount: report.errors.length };
    if (completion) {
      const reportedErrors = diagnostic();
      if (!runId && !completion.errorCount && reportedErrors === null) {
        legacyReceiptFirstSeenAt ??= performance.now();
        if (performance.now() - legacyReceiptFirstSeenAt < legacyDiagnosticSettleMs) {
          await delay(Math.min(25, Math.max(0, deadline - performance.now())));
          continue;
        }
      }
      if (runId && completion.runId !== runId) return { status: "unavailable", reason: "retention completion belongs to another launch" };
      if (runId && report?.runId !== runId) return { status: "unavailable", reason: "retention receipt belongs to another launch" };
      const at = Date.parse(report.at);
      // Older releases log the retention summary after recording a failed
      // durable write. The receipt may already have been renamed into place
      // with an empty errors array before the directory sync fails.
      const errorCount = Math.max(completion.errorCount, reportedErrors ?? 0);
      // The receipt may contain absolute paths and raw errors. Publish only
      // the error count and normalized pass timestamp.
      return { status: "completed", at: new Date(at).toISOString(), errorCount };
    }
    await delay(Math.min(200, Math.max(0, deadline - performance.now())));
  }
  return { status: "unavailable", reason: "retention receipt timed out" };
}

export async function startCase(label, env, expected, { directory, rows, retentionTimeoutMs = 130_000 }) {
  const receipt = label === "neither-cli" ? path.join(env.LLV_STATE_DIR, "self-update", "retention.json") : null;
  const bunInstall = env.BUN_INSTALL ?? path.join(env.HOME, ".bun");
  const runId = receipt && requiresRetentionCompletion(bunInstall) ? randomUUID() : undefined;
  const port = await availablePort();
  // The first case owns a fresh profile. Refuse any receipt that predates
  // its launcher, including during a replay with a previously used profile.
  const preexistingReceipt = receipt && lstatSync(receipt, { throwIfNoEntry: false });
  // Run the prompt's installed launcher in the background through a tracked
  // child handle, with an ephemeral port instead of the visitor's stable port.
  const launchedAt = Date.now();
  const child = spawn(path.join(env.HOME, ".bun/bin/delegatus"), ["--no-open", "--port", String(port)], {
    env: runId ? { ...env, [retentionRunIdEnv]: runId } : env, stdio: ["ignore", "pipe", "pipe"], cwd: env.HOME,
  });
  let output = "";
  let spawnError;
  let failure;
  const launcherExited = () => child.exitCode !== null || child.signalCode !== null;
  child.once("error", (error) => { spawnError = error; });
  const collect = (chunk) => { output = (output + chunk).slice(-200_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  try {
    const deadline = Date.now() + 60_000;
    let presence;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (launcherExited()) throw new Error(`${label}: launcher exited before readiness`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
        await response.arrayBuffer();
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
    const row = { case: label, rootStatus: 200, cli: presence, message: expected.message, passed: false };
    rows.push(row);
    if (receipt) {
      row.retention = preexistingReceipt
        ? { status: "unavailable", reason: "retention receipt predates launcher" }
        : await waitForRetention(receipt, {
          runId, launchedAt, launcherExited, timeoutMs: retentionTimeoutMs,
          terminal: () => {
            const matches = [...output.matchAll(/\[self-update\] retention pass ([^ ]+) complete; (\d+) error\(s\)/g)];
            const match = matches.at(-1);
            return match ? { runId: match[1], errorCount: Number(match[2]) } : null;
          },
          diagnostic: () => {
            const matches = [...output.matchAll(/\[self-update\] retention removed \d+; reclaimed \d+ cache bytes; (\d+) error\(s\)/g)];
            const match = matches.at(-1);
            return match ? Number(match[1]) : null;
          },
        });
      if (!runId) row.retention.completionProtocol = "unavailable";
      row.passed = row.retention.status === "completed" && row.retention.errorCount === 0;
      if (!row.passed) {
        const reason = row.retention.reason ?? `retention completed with ${row.retention.errorCount} error(s)`;
        throw new Error(`${label}: ${reason}`);
      }
    }
    row.passed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await stop(child); } finally {
      // The fixture has no personal identities or credentials; keep diagnostic
      // logs bounded and replace its generated home before uploading.
      writeFileSync(path.join(directory, `${label}.log`), publicFixtureText(output, env.HOME));
      if (failure) writeFileSync(path.join(directory, `${label}-error.txt`), publicFixtureText(String(failure.message), env.HOME) + "\n");
    }
  }
}

export async function runCases(cases, entries) {
  const failures = [];
  for (const [label, env, expected] of entries) {
    try { await startCase(label, env, expected, cases); }
    catch (error) { failures.push(publicFixtureText(error.message, cases.home)); }
  }
  return failures;
}

export function writeReport(directory, report) {
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

export function finalizeCases(report, auditFile, home, caseFailures) {
  const calls = readFileSync(auditFile, "utf8").trim().split("\n");
  report.stubCommands = [...new Set(calls.map((call) => publicFixtureText(call, home)))];
  const forbidden = calls.filter((call) => !safeStubCall(call));
  if (forbidden.length) throw new Error(`Stub received unexpected commands: ${publicFixtureText(forbidden.join("; "), home)}`);
  if (caseFailures.length) throw new Error(caseFailures.join("; "));
  report.passed = true;
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
  const promptRoot = process.argv[4] ?? root;
  if (!target) throw new Error("Usage: node scripts/newcomer-install.mjs <tarball-or-npm-package> <report-directory> [prompt-checkout]");
  mkdirSync(reportDirectory, { recursive: true });
  // macOS's per-user temp path can exhaust its Unix socket pathname limit
  // before the runtime host's filename is appended. Keep this fixture short.
  const fixture = mkdtempSync("/tmp/dlg-newcomer-");
  const home = path.join(fixture, "home");
  mkdirSync(home);
  // Start with a new home, no credentials and only runner system tools on PATH.
  const env = {
    HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
    BUN_INSTALL: path.join(home, ".bun"),
    TMPDIR: fixture, XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_CACHE_HOME: path.join(fixture, "cache"),
    LLV_STATE_DIR: path.join(fixture, "state"), LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"), NEXT_TELEMETRY_DISABLED: "1",
    // This clean environment drops CI itself; fence the production launcher explicitly.
    DELEGATUS_TELEMETRY: "0",
  };
  const rows = [];
  const cases = { directory: reportDirectory, rows, home };
  const report = { platform: process.platform, arch: process.arch, source: target.endsWith(".tgz") ? "checkout tarball" : "npm release", rows, passed: false };
  try {
    const prompt = readInstallPrompt("claude", "en", promptRoot);
    shell(promptCommand(prompt, "curl -fsSL https://bun.com/install"), env);
    env.PATH = `${home}/.bun/bin:${home}/.local/bin:${env.PATH}`;
    const bunVersion = shell(promptCommand(prompt, "bun --version"), env);
    report.bunVersion = bunVersion;
    const [major, minor] = bunVersion.split(".").map(Number);
    if (!(major > 1 || major === 1 && minor >= 4)) throw new Error("The prompt requires Bun 1.4+");
    // Same install command, substituting the exact subject this run verifies.
    // Target is passed via an env value rather than interpolated shell text.
    report.packageInstall = publicFixtureText(shell(promptCommand(prompt, "bun add -g delegatus-cli").replace("delegatus-cli", '"$NEWCOMER_PACKAGE"'), { ...env, NEWCOMER_PACKAGE: target }).replaceAll(target, "<package subject>"), home);
    report.package = installedPackageIdentity(env.BUN_INSTALL);
    report.globalBin = publicFixtureText(shell("bun pm bin -g", env), home);
    report.binEntries = readdirSync(path.join(home, ".bun/bin"));
    const entries = [["neither-cli", env, {
      message: "Claude Code CLI and Codex CLI were not found", presence: { claude: "missing", codex: "missing", antigravity: "missing" },
      installer: "curl -fsSL https://claude.ai/install.sh | bash",
    }]];
    const audit = path.join(fixture, "stub-calls.txt");
    for (const agent of ["claude", "codex"]) {
      const stubDirectory = path.join(fixture, `path-${agent}`);
      stub(agent, stubDirectory, audit);
      const withStub = { ...env, PATH: `${stubDirectory}:${env.PATH}` };
      const variant = readInstallPrompt(agent, "en", promptRoot);
      shell(promptCommand(variant, `${agent} --version`), withStub);
      shell(promptCommand(variant, `${agent} mcp add viewer`), withStub);
      entries.push([`path-${agent}`, withStub, {
        message: `Agent CLI: ${agent}. Sign in`, available: true,
        presence: { claude: agent === "claude" ? "found" : "missing", codex: agent === "codex" ? "found" : "missing", antigravity: "missing" },
      }]);
    }
    const caseFailures = await runCases(cases, entries);
    stub("codex", path.join(home, "Applications/Codex.app/Contents/Resources"), audit);
    const desktopFailures = await runCases(cases, [["desktop-bundle", env, {
      message: "Agent CLI: codex. Sign in", available: true, presence: { claude: "missing", codex: "found", antigravity: "missing" },
    }]]);
    finalizeCases(report, audit, home, [...caseFailures, ...desktopFailures]);
  } catch (error) {
    report.error = publicFixtureText(error.message.replaceAll(target, "<package subject>"), home);
    throw new Error(report.error);
  } finally {
    writeReport(reportDirectory, report);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
