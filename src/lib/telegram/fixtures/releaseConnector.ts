import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { TelegramAdapter } from "../adapter";
import { connectorServerName, ensureTelegramConnector, spawnTelegramConnectorProcess, stopTelegramConnector, type ConnectorProbe, type TelegramConnectorPorts } from "../connector";
import { stagedConnectorSourceDir } from "../packaging";
import { TelegramConnectionService, type TelegramServicePorts } from "../service";

/** The connector program's stand-in: it waits to be stopped, and ignores its
    stdin lease, as a runner started before leases did. */
function writeStandInEntrypoint(releaseDir: string): string {
  const entrypoint = path.join(releaseDir, "bin", "telegram-mcp-server.py");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "setInterval(() => undefined, 1000);\n");
  return entrypoint;
}

function connectorStarter(releaseDir: string, env: Record<string, string>): { supervisor: string; entrypoint: string; env: NodeJS.ProcessEnv } {
  const entrypoint = writeStandInEntrypoint(releaseDir);
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
  return {
    supervisor,
    entrypoint,
    env: {
      ...process.env,
      LLV_STATE_DIR: statePath(),
      LLV_TELEGRAM_PYTHON: process.execPath,
      LLV_TELEGRAM_SERVER_BRIDGE: entrypoint,
      LLV_TELEGRAM_API_ID: "12345",
      LLV_TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
      ...env,
    },
  };
}

function startedConnector(status: number | null, stdout: string, stderr: string, entrypoint: string): { pid: number; entrypoint: string } {
  const pid = Number(stdout);
  if (status !== 0 || !Number.isInteger(pid) || pid <= 1) {
    throw new Error(`the earlier release could not start its connector: ${stderr}`);
  }
  return { pid, entrypoint };
}

/**
 * A connector that outlived the Viewer that started it, as a self-update or a
 * service restart used to leave it: started by a Viewer process that served
 * from one release directory and has exited, while the connector it detached
 * runs on. The supervisor's own code starts and records it, in a second
 * process, so the record is the one a release writes; only the connector
 * program is a stand-in that waits to be stopped.
 *
 * The stored session must already be in the state directory. The caller stops
 * the process by the pid returned here.
 */
export function startConnectorFromRelease(releaseDir: string): { pid: number; entrypoint: string } {
  const starter = connectorStarter(releaseDir, {});
  const started = spawnSync(process.execPath, [starter.supervisor], { encoding: "utf8", env: starter.env });
  return startedConnector(started.status, started.stdout, started.stderr, starter.entrypoint);
}

/** The same start from a Viewer that runs beside this process, under `env`
    (another release's PORT): this process keeps reaping its own children
    while the other one stops them. */
export async function startConnectorFromReleaseBeside(releaseDir: string, env: Record<string, string>): Promise<{ pid: number; entrypoint: string }> {
  const starter = connectorStarter(releaseDir, env);
  const child = spawn(process.execPath, [starter.supervisor], { env: starter.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const status = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return startedConnector(status, stdout, stderr, starter.entrypoint);
}

/**
 * The connection service of the release that takes over. Its health check is
 * the production one and so is the supervisor under it, which starts the
 * release's stand-in runner under its stdin lease; the other stand-ins are the
 * listener's answers (it verifies whatever listens), the account read and the
 * host registration. `calls.pids` names the runners it started; the caller
 * stops them with `stopTelegramConnector`. `overrides` replaces service ports.
 */
export function releaseTakeover(connectorToken: string, overrides: Partial<TelegramServicePorts> = {}): { service: TelegramConnectionService; calls: { spawns: number; pids: number[] } } {
  const calls = { spawns: 0, pids: [] as number[] };
  const verified: ConnectorProbe = { ok: true, serverName: connectorServerName(connectorToken), tools: [{ name: "get_me", readOnly: true }] };
  const supervisor: TelegramConnectorPorts = {
    spawn: (spec) => {
      calls.spawns += 1;
      const child = spawnTelegramConnectorProcess(spec);
      if (child?.pid) calls.pids.push(child.pid);
      return child;
    },
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
    ...overrides,
  });
  return { service, calls };
}

/** Runs the release that takes over with its connector paths under `releaseDir`
    and the API credentials its own runner starts with. */
export async function asRelease<T>(releaseDir: string, run: () => Promise<T>): Promise<T> {
  const names = ["LLV_TELEGRAM_PYTHON", "LLV_TELEGRAM_SERVER_BRIDGE", "LLV_TELEGRAM_API_ID", "LLV_TELEGRAM_API_HASH"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.LLV_TELEGRAM_PYTHON = process.execPath;
  process.env.LLV_TELEGRAM_SERVER_BRIDGE = writeStandInEntrypoint(releaseDir);
  process.env.LLV_TELEGRAM_API_ID = "12345";
  process.env.LLV_TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";
  try {
    return await run();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
}

/** Ends the stand-in connector by the pid its start returned. */
export function endConnectorProcess(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
