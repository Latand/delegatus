/* #2761: the runtime host the candidate gate's Viewers talk to.

   A Viewer release reaches the runtime host only through its production RPC
   client (`UnixRuntimeHostClient`) over a Unix socket, under deadlines, and
   that path is where a loaded release timed out in production. The gate
   therefore starts a real runtime host from the candidate's own
   `src/runtime-host/main.ts`, under the candidate's interpreter, in the gate's
   private state directory: its own journal, its own fence, a socket in the
   sandbox, no deployments and no stable listener. Every Viewer release, the
   browser half's production server and the board driver point
   `LLV_RUNTIME_HOST_SOCKET` at it.

   With `faults`, the Viewers reach the host through a pass-through socket the
   gate controls, so its own tests can stall the host's answers: a stalled
   connection is accepted and read and never answered, which is how a host
   whose event loop is held looks from the Viewer.

   Run directly with `--owner <pid>`, this file is that host: it runs
   `main.ts` unchanged in this process and leaves when its owner does, so a
   gate that is killed leaves no runtime host behind. */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const READY_TIMEOUT_MS = 60_000;
const LOG_LINES = 20;

export interface CandidateRuntimeHost {
  /** The socket the Viewers are given: the fault proxy when there is one. */
  socket: string;
  pid: number;
  /** Hold every new connection unanswered while on; only with `faults`. */
  stall(on: boolean): void;
  /** Connections the proxy held unanswered. */
  stalled(): number;
  exited(): boolean;
  log(): string[];
  stop(): Promise<void>;
}

export function candidateRuntimeHostEnvironment(env: Record<string, string>, directory: string): Record<string, string> {
  return {
    ...env,
    LLV_RUNTIME_HOST_SOCKET: path.join(directory, "rt.sock"),
    LLV_RUNTIME_JOURNAL: path.join(directory, "runtime-events.sqlite"),
    LLV_RUNTIME_HOST_FENCE: path.join(directory, "rt.lock"),
    LLV_RUNTIME_HOST_STARTUP_TARGET: path.join(directory, "runtime-host-startup.json"),
  };
}

/** Ask the host for its identity once; true when it answered in time. */
async function answers(socketPath: string): Promise<boolean> {
  const { UnixRuntimeHostClient } = await import("@/lib/runtime/client");
  try {
    await new UnixRuntimeHostClient(socketPath).runtimeHostHealth();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the candidate's runtime host and wait until it answers on its socket.
 * `env` is the gate's sandbox environment; `directory` holds the socket, the
 * journal and the fence, and must be short enough for a Unix socket path.
 */
export async function startCandidateRuntimeHost(options: {
  runtimeBin: string;
  cwd: string;
  env: Record<string, string>;
  directory: string;
  faults?: boolean;
}): Promise<CandidateRuntimeHost> {
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const env = candidateRuntimeHostEnvironment(options.env, options.directory);
  const hostSocket = env.LLV_RUNTIME_HOST_SOCKET!;
  const lines: string[] = [];
  const child: ChildProcess = spawn(options.runtimeBin, [path.join(options.cwd, "src", "runtime-host", "candidateRuntimeHost.ts"), "--owner", String(process.pid)], {
    cwd: options.cwd,
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      lines.push(line.slice(0, 300));
      if (lines.length > LOG_LINES) lines.shift();
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let gone = false;
  const exited = new Promise<void>((resolve) => child.once("exit", () => { gone = true; resolve(); }));

  let proxy: net.Server | null = null;
  let stalling = false;
  let stalledCount = 0;
  const open = new Set<net.Socket>();
  const proxySocket = path.join(options.directory, "rt-proxy.sock");
  const stop = async () => {
    for (const socket of open) socket.destroy();
    if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    if (!gone) {
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(forced);
    }
  };
  try {
    for (const until = performance.now() + READY_TIMEOUT_MS; ; await Bun.sleep(100)) {
      if (gone) throw new Error(`the runtime host exited before it answered: ${lines.slice(-3).join(" | ")}`);
      if (performance.now() > until) throw new Error(`the runtime host did not answer within ${READY_TIMEOUT_MS}ms`);
      if (fs.existsSync(hostSocket) && await answers(hostSocket)) break;
    }
    if (options.faults) {
      fs.rmSync(proxySocket, { force: true });
      proxy = net.createServer((client) => {
        open.add(client);
        client.on("error", () => {});
        client.once("close", () => open.delete(client));
        if (stalling) {
          /* Read and never answered: the Viewer's own deadline ends it. */
          stalledCount += 1;
          client.resume();
          return;
        }
        const upstream = net.createConnection(hostSocket);
        open.add(upstream);
        upstream.on("error", () => client.destroy());
        upstream.once("close", () => { open.delete(upstream); client.end(); });
        client.once("close", () => upstream.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
      });
      await new Promise<void>((resolve, reject) => { proxy!.once("error", reject); proxy!.listen(proxySocket, resolve); });
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    socket: options.faults ? proxySocket : hostSocket,
    pid: child.pid!,
    stall(on) {
      if (!options.faults) throw new Error("the runtime host was started without a fault proxy");
      stalling = on;
    },
    stalled: () => stalledCount,
    exited: () => gone,
    log: () => [...lines],
    stop,
  };
}

/**
 * Wait until a production server over this host has finished its
 * structured-host startup, which `/api/runtime/snapshot` reports. That startup
 * is a release's activation, bounded apart by the gate; the views measure a
 * started server, as an operator's do. Returns the last state it saw.
 */
export async function waitForServerStartup(baseUrl: string, timeoutMs = 120_000): Promise<string> {
  let state = "unanswered";
  for (const until = performance.now() + timeoutMs; performance.now() < until; await Bun.sleep(500)) {
    try {
      const response = await fetch(`${baseUrl}/api/runtime/snapshot?view=summary`);
      const body = await response.json() as { structuredStartup?: string | null; error?: string };
      state = response.ok ? String(body.structuredStartup ?? "disabled") : `HTTP ${response.status}`;
      if (response.ok && body.structuredStartup !== "pending") return state;
    } catch { /* booting */ }
  }
  return state;
}

if (import.meta.main) {
  const owner = Number(process.argv[process.argv.indexOf("--owner") + 1]);
  if (!Number.isSafeInteger(owner) || owner <= 1) throw new Error("the candidate runtime host needs --owner <pid>");
  setInterval(() => {
    try { process.kill(owner, 0); } catch { process.exit(86); }
  }, 500).unref();
  await import("./main");
}
