import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { TelegramAdapter } from "../adapter";
import { connectorServerName, ensureTelegramConnector, stopTelegramConnector, type ConnectorProbe, type TelegramConnectorPorts } from "../connector";
import { stagedConnectorSourceDir } from "../packaging";
import { TelegramConnectionService } from "../service";

/**
 * A connector as a self-update leaves it: started by a Viewer process that
 * served from one release directory and has exited, while the connector it
 * detached runs on. The supervisor's own code starts and records it, in a
 * second process, so the record is the one a release writes; only the
 * connector program is a stand-in that waits to be stopped.
 *
 * The stored session must already be in the state directory. The caller stops
 * the process by the pid returned here.
 */
export function startConnectorFromRelease(releaseDir: string): { pid: number; entrypoint: string } {
  const entrypoint = path.join(releaseDir, "bin", "telegram-mcp-server.py");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "setInterval(() => undefined, 1000);\n");
  fs.mkdirSync(stagedConnectorSourceDir(), { recursive: true, mode: 0o700 });
  const supervisor = path.join(releaseDir, "start-connector.mjs");
  fs.writeFileSync(supervisor, [
    "import { spawn } from 'node:child_process';",
    `const { connectorServerName, ensureTelegramConnector } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "connector.ts"))});`,
    `const { readTelegramSession } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "sessionStore.ts"))});`,
    "const session = readTelegramSession();",
    "let pid = 0;",
    "const result = await ensureTelegramConnector(session, {",
    "  spawn: (spec) => {",
    "    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'ignore', detached: true });",
    "    child.unref();",
    "    pid = child.pid ?? 0;",
    "    return child;",
    "  },",
    "  probe: async () => ({ ok: true, serverName: connectorServerName(session.connectorToken), tools: [{ name: 'get_me', readOnly: true }] }),",
    "  sleep: async () => {},",
    "  now: () => Date.now(),",
    "});",
    "if (!result.ok || pid <= 1) process.exit(1);",
    "process.stdout.write(String(pid));",
    "",
  ].join("\n"));
  const started = spawnSync(process.execPath, [supervisor], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLV_STATE_DIR: statePath(),
      LLV_TELEGRAM_PYTHON: process.execPath,
      LLV_TELEGRAM_SERVER_BRIDGE: entrypoint,
      LLV_TELEGRAM_API_ID: "12345",
      LLV_TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
    },
  });
  const pid = Number(started.stdout);
  if (started.status !== 0 || !Number.isInteger(pid) || pid <= 1) {
    throw new Error(`the earlier release could not start its connector: ${started.stderr}`);
  }
  return { pid, entrypoint };
}

/**
 * The connection service of the release that takes over. Its health check is
 * the production one and so is the supervisor under it; the stand-ins are the
 * listener's answers (it verifies whatever listens), the account read and the
 * host registration. `calls.spawns` counts the connectors it had to start
 * itself, and a start it attempts fails, so a second connector cannot pass.
 */
export function releaseTakeover(connectorToken: string): { service: TelegramConnectionService; calls: { spawns: number } } {
  const calls = { spawns: 0 };
  const verified: ConnectorProbe = { ok: true, serverName: connectorServerName(connectorToken), tools: [{ name: "get_me", readOnly: true }] };
  const supervisor: TelegramConnectorPorts = {
    spawn: () => { calls.spawns += 1; return null; },
    probe: async () => verified,
    sleep: async () => {},
    now: () => Date.now(),
  };
  const adapter: TelegramAdapter = {
    unavailableReason: () => null,
    startEnrollment: () => { throw new Error("this fixture never signs in"); },
    checkSession: async () => ({ status: "error", code: "bridge_failed" }),
    logout: async () => ({ ok: true, code: null }),
  };
  const service = new TelegramConnectionService({
    adapter,
    ensureConnector: (session) => ensureTelegramConnector(session, supervisor),
    readConnectorIdentity: async () => ({ name: "Account A", username: "account_a", id: "770000001" }),
    stopConnector: () => stopTelegramConnector(),
    registerHosts: () => ({ ok: true, claude: { registered: 1, conflict: 0, unwritable: 0 }, codex: { registered: 1, failed: 0 } }),
    unregisterHosts: () => {},
    now: () => Date.now(),
    credentialsConfigured: () => true,
  });
  return { service, calls };
}

/** Runs the release that takes over with its connector paths under `releaseDir`. */
export async function asRelease<T>(releaseDir: string, run: () => Promise<T>): Promise<T> {
  const previous = { python: process.env.LLV_TELEGRAM_PYTHON, entry: process.env.LLV_TELEGRAM_SERVER_BRIDGE };
  process.env.LLV_TELEGRAM_PYTHON = process.execPath;
  process.env.LLV_TELEGRAM_SERVER_BRIDGE = path.join(releaseDir, "bin", "telegram-mcp-server.py");
  try {
    return await run();
  } finally {
    if (previous.python === undefined) delete process.env.LLV_TELEGRAM_PYTHON; else process.env.LLV_TELEGRAM_PYTHON = previous.python;
    if (previous.entry === undefined) delete process.env.LLV_TELEGRAM_SERVER_BRIDGE; else process.env.LLV_TELEGRAM_SERVER_BRIDGE = previous.entry;
  }
}

/** Ends the stand-in connector by the pid its start returned. */
export function endConnectorProcess(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
