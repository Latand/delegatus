import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { finalizeCases, installedPackageIdentity, promptCommand, readInstallPrompt, runCases, safeStubCall, startCase, writeReport } from "./newcomer-install.mjs";

test("rehearsal consumes the shipped commands for both prompt variants", () => {
  for (const agent of ["claude", "codex"]) {
    const prompt = readInstallPrompt(agent);
    expect(promptCommand(prompt, "bun add -g delegatus-cli")).toBe("bun add -g delegatus-cli");
    expect(promptCommand(prompt, "curl -fsSL https://bun.com/install")).toBe("curl -fsSL https://bun.com/install | bash");
    expect(promptCommand(prompt, `${agent} --version`)).toBe(`${agent} --version`);
    expect(promptCommand(prompt, `${agent} mcp add viewer`)).toContain('-- "$(command -v bun)" "$HOME/.bun/bin/delegatus-mcp"');
    expect(promptCommand(prompt, "mkdir -p ~/.cache/delegatus")).toContain("~/.bun/bin/delegatus --no-open");
  }
});

test("prompt drift fails explicitly instead of skipping a missing step", () => {
  expect(() => promptCommand("No commands", "bun add")).toThrow("Install prompt has no command");
});

test("read-only startup probes are allowed; logins and agent execution are refused", () => {
  for (const call of ["--version", "auth status --json", "login status", "-c features.plugins=false mcp list --json", "-c cli_auth_credentials_store=file -c mcp_servers={} app-server"]) {
    expect(safeStubCall(call)).toBe(true);
  }
  for (const call of ["auth login --claudeai", "login --device-auth", "app-server", "exec hello", "--print hello", ""]) {
    expect(safeStubCall(call)).toBe(false);
  }
});

const expected = {
  message: "Claude Code CLI and Codex CLI were not found",
  installer: "curl -fsSL https://claude.ai/install.sh | bash",
  presence: { claude: "missing", codex: "missing" },
};
const at = "2026-11-14T11:45:29.000Z";
const cleanReceipt = { at, removed: [], kept: [], reclaimedCacheBytes: 0, errors: [] };

test.each([
  ["clean", { status: "completed", at, errorCount: 0 }, null],
  ["error", { status: "completed", at, errorCount: 1 }, "retention completed with 1 error(s)"],
  ["missing", { status: "unavailable", reason: "retention receipt timed out" }, "retention receipt timed out"],
  ["invalid", { status: "unavailable", reason: "invalid retention receipt" }, "invalid retention receipt"],
  ["malformed", { status: "unavailable", reason: "invalid retention receipt" }, "invalid retention receipt"],
  ["unreadable", { status: "unavailable", reason: "cannot read retention receipt" }, "cannot read retention receipt"],
  ["stale", { status: "unavailable", reason: "retention receipt predates launcher" }, "retention receipt predates launcher"],
  ["late-stale", { status: "unavailable", reason: "retention receipt timed out" }, "retention receipt timed out"],
  ["late-fresh", { status: "completed", at, errorCount: 0 }, null],
  ["pending-close", { status: "unavailable", reason: "retention receipt timed out" }, "retention receipt timed out"],
  ["post-rename-fsync", { status: "completed", at, errorCount: 1 }, "retention completed with 1 error(s)"],
  ["exited", { status: "unavailable", reason: "launcher exited before retention receipt" }, "launcher exited before retention receipt"],
  ["later-start", undefined, null],
] as const)("startup rehearsal records HTTP and handles retention for %s", async (scenario, retention, failure) => {
  const fixture = mkdtempSync(join(tmpdir(), "newcomer-case-"));
  try {
    const home = join(fixture, "home");
    const bunInstall = join(home, ".bun");
    const state = join(fixture, "state");
    const directory = join(fixture, "report");
    const receipt = join(state, "self-update/retention.json");
    const launcher = join(bunInstall, "bin/delegatus");
    for (const dir of [directory, dirname(receipt), dirname(launcher)]) mkdirSync(dir, { recursive: true });
    const unrelatedReceipt = join(fixture, "other-state/self-update/retention.json");
    mkdirSync(dirname(unrelatedReceipt), { recursive: true });
    writeFileSync(unrelatedReceipt, JSON.stringify(cleanReceipt));
    if (scenario === "stale") writeFileSync(receipt, JSON.stringify(cleanReceipt));
    const syntheticError = `Synthetic permission error at ${receipt}`;
    // The fixture answers the real HTTP probes before publishing an atomic
    // receipt. The missing scenario writes a clean receipt only on teardown.
    writeFileSync(launcher, `#!/usr/bin/env node
const { createServer } = require("node:http");
const { mkdirSync, renameSync, writeFileSync } = require("node:fs");
const file = ${JSON.stringify(receipt)};
const staleFile = file + ".stale";
const clean = ${JSON.stringify(cleanReceipt)};
const scenario = ${JSON.stringify(scenario)};
const runId = process.env.LLV_RETENTION_RUN_ID;
function publish(report) {
  writeFileSync(file + ".tmp", JSON.stringify(report));
  renameSync(file + ".tmp", file);
}
function complete(report, errors = report.errors.length) {
  publish({ ...report, runId });
  console.error("[self-update] retention pass " + runId + " complete; " + errors + " error(s)");
}
function stop() {
  if (scenario === "missing") publish(clean);
  writeFileSync(file + ".stopped", "yes");
  process.exit(0);
}
process.on("SIGTERM", stop);
const server = createServer((request, response) => {
  if (request.url === "/") return response.end("ready");
  if (request.url !== "/api/accounts/cli") return response.writeHead(404).end();
  response.end(${JSON.stringify(JSON.stringify(expected.presence))}, scenario === "exited" ? stop : undefined);
  if (scenario === "clean" || scenario === "error" || scenario === "invalid") {
    setTimeout(() => complete(scenario === "invalid" ? { at: clean.at, errors: [] } : {
      ...clean,
      kept: [{ dir: file, reason: "fixture hold", bytes: 0 }],
      errors: scenario === "error" ? [${JSON.stringify(syntheticError)}] : [],
    }, scenario === "error" ? 1 : 0), 75);
  }
  if (scenario === "post-rename-fsync") setTimeout(() => complete({ ...clean, errors: [] }, 1), 75);
  if (scenario === "pending-close") setTimeout(() => publish({ ...clean, runId }), 75);
  if (scenario === "late-stale" || scenario === "late-fresh") {
    setTimeout(() => {
      writeFileSync(staleFile, JSON.stringify(clean));
      renameSync(staleFile, file);
    }, 30);
    if (scenario === "late-fresh") setTimeout(() => complete(clean), 180);
  }
  if (scenario === "malformed") writeFileSync(file, "{");
  if (scenario === "unreadable") mkdirSync(file);
});

server.listen(Number(process.argv[4]), "127.0.0.1", () => {
  console.log(${JSON.stringify(`${expected.message}\n${expected.installer}`)});
  console.log(file);
});
`, { mode: 0o755 });

    const rows: unknown[] = [];
    const env = { HOME: home, BUN_INSTALL: bunInstall, LLV_STATE_DIR: state, PATH: process.env.PATH };
    const label = scenario === "later-start" ? "path-claude" : "neither-cli";
    const errorFile = join(directory, `${label}-error.txt`);
    const result = startCase(label, env, expected, {
      directory, rows, retentionTimeoutMs: ["missing", "pending-close", "late-stale"].includes(scenario) ? 300 : 3_000,
    }).catch((error: Error) => error.message);
    expect(await result).toBe(failure ? `neither-cli: ${failure}` : undefined);
    expect(rows).toEqual([{
      case: label, rootStatus: 200, cli: expected.presence, message: expected.message, passed: failure === null,
      ...(retention && { retention }),
    }]);
    expect(readFileSync(`${receipt}.stopped`, "utf8")).toBe("yes");
    const log = readFileSync(join(directory, `${label}.log`), "utf8");
    expect(log).toContain("<fixture>/state/self-update/retention.json");
    expect(log).not.toContain(fixture);
    if (failure) expect(readFileSync(errorFile, "utf8")).toBe(`neither-cli: ${failure}\n`);
    else expect(existsSync(errorFile)).toBe(false);
    if (scenario === "missing") expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(cleanReceipt);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a failed first retention case remains in the report while the other cases and audit run", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "newcomer-driver-"));
  try {
    const reportDir = join(fixture, "report"); const home = join(fixture, "home");
    mkdirSync(reportDir); mkdirSync(home);
    const rows: unknown[] = [];
    const cases = { directory: reportDir, rows, home };
    const entries = [];
    const audit = join(fixture, "stub-calls.txt");
    for (const [index, label] of ["neither-cli", "path-claude", "path-codex", "desktop-bundle"].entries()) {
      const caseHome = join(fixture, label); const state = join(fixture, `${label}-state`);
      const receipt = join(state, "self-update/retention.json"); const launcher = join(caseHome, ".bun/bin/delegatus");
      mkdirSync(dirname(launcher), { recursive: true }); mkdirSync(dirname(receipt), { recursive: true });
      const presence = label === "neither-cli" ? { claude: "missing", codex: "missing" }
        : label === "path-claude" ? { claude: "found", codex: "missing" } : { claude: "missing", codex: "found" };
      const message = label === "neither-cli" ? expected.message : `Agent CLI: ${label === "path-claude" ? "claude" : "codex"}. Sign in`;
      writeFileSync(launcher, `#!/usr/bin/env node
const { createServer } = require("node:http"); const { writeFileSync, renameSync } = require("node:fs");
const file = ${JSON.stringify(receipt)}; const runId = process.env.LLV_RETENTION_RUN_ID;
const server = createServer((req, res) => { if (req.url === "/") return res.end("ready"); res.end(${JSON.stringify(JSON.stringify(presence))});
if (runId) setTimeout(() => { const report = { at: ${JSON.stringify(at)}, removed: [], kept: [], reclaimedCacheBytes: 0, errors: ${index === 0 ? "[\"fsync failed after rename\"]" : "[]"}, runId };
writeFileSync(file + ".tmp", JSON.stringify(report)); renameSync(file + ".tmp", file); console.error("[self-update] retention pass " + runId + " complete; " + report.errors.length + " error(s)"); }, 50); });
server.listen(Number(process.argv[4]), "127.0.0.1", () => console.log(${JSON.stringify(message)}));
process.on("SIGTERM", () => process.exit(0));
`, { mode: 0o755 });
      entries.push([label, { HOME: caseHome, LLV_STATE_DIR: state, PATH: process.env.PATH }, { message, presence }]);
    }
    writeFileSync(audit, "--version\nmcp add viewer viewer\n");
    const failures = await runCases(cases, entries);
    const report: { rows: unknown[]; passed: boolean; error?: string } = { rows, passed: false };
    expect(() => finalizeCases(report, audit, home, failures)).toThrow("neither-cli: retention completed with 1 error(s)");
    report.error = "neither-cli: retention completed with 1 error(s)";
    writeReport(reportDir, report);
    const artifact = JSON.parse(readFileSync(join(reportDir, "report.json"), "utf8"));
    expect(failures).toEqual(["neither-cli: retention completed with 1 error(s)"]);
    expect(artifact.passed).toBe(false);
    expect(artifact.rows).toHaveLength(4);
    expect(artifact.rows[0]).toMatchObject({ case: "neither-cli", passed: false, retention: { status: "completed", errorCount: 1 } });
    expect(artifact.rows.slice(1).every((row: { passed: boolean }) => row.passed)).toBe(true);
    expect(artifact.stubCommands).toEqual(["--version", "mcp add viewer viewer"]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("package identity comes from the installed manifest and omits an unrecognized revision", () => {
  const fixture = mkdtempSync(join(tmpdir(), "newcomer-package-"));
  try {
    const file = join(fixture, "install/global/node_modules/delegatus-cli/package.json");
    mkdirSync(dirname(file), { recursive: true });
    const revision = "a".repeat(40);
    writeFileSync(file, JSON.stringify({ name: "delegatus-cli", version: "2.2.0", gitHead: revision }));
    expect(installedPackageIdentity(fixture)).toEqual({ version: "2.2.0", revision });
    writeFileSync(file, JSON.stringify({ name: "delegatus-cli", version: "2.2.0", gitHead: fixture }));
    expect(installedPackageIdentity(fixture)).toEqual({ version: "2.2.0" });
    writeFileSync(file, JSON.stringify({ name: "delegatus-cli", version: fixture }));
    expect(() => installedPackageIdentity(fixture)).toThrow("Installed package has no recognized Delegatus version");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
