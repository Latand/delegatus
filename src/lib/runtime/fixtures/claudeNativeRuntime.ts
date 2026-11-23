/** A separate Viewer delivery-controller process over the installed Claude
 * CLI. The caller owns the loopback Messages API and every response. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ClaudeDeliveryState, ClaudeStreamBrokerHost } from "../claudeStreamBrokerHost";
import type { HostState, RuntimeEvent } from "../engineHost";
import type { RuntimeJournal } from "@/runtime-host/journal";

export interface NativeRuntimeOptions {
  directory: string;
  api: string;
  binary: string;
  version: string;
  enabled: boolean;
  requestTimeoutMs?: number;
}

export interface NativeRuntimeSnapshot {
  pid: number;
  health: HostState;
  nativeQueued: boolean;
  memory: ReturnType<ClaudeStreamBrokerHost["agentStateMemory"]>;
  wire: Record<string, unknown>[];
  rows: ClaudeDeliveryState[];
  events: RuntimeEvent[];
  journal: ReturnType<RuntimeJournal["snapshot"]>;
}

export async function startNativeClaudeRuntime(options: NativeRuntimeOptions) {
  const directory = options.directory;
  for (const name of ["config", "tmp", "state"]) fs.mkdirSync(path.join(directory, name), { recursive: true });
  const child = spawn(process.execPath, [import.meta.path, "--serve", JSON.stringify(options)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: path.join(directory, "config"),
      TMPDIR: path.join(directory, "tmp"), LLV_STATE_DIR: path.join(directory, "state"),
      LLV_TEST_STARTUP_HOME: directory, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  let errors = "", output = "";
  child.stderr.on("data", chunk => { errors += String(chunk); });
  const ready = new Promise<{ url: string; conversationId: string }>((resolve, reject) => {
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const line = output.split("\n").find(line => line.startsWith('{"url":'));
      if (line) resolve(JSON.parse(line));
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`native runtime fixture exited before ready: ${errors}`)));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await Promise.race([ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("native runtime fixture startup timed out")), 30_000);
    })]);
    return { ...info, pid: child.pid!,
      async call<T = NativeRuntimeSnapshot>(action: string, body?: unknown): Promise<T> {
        const response = await fetch(info.url + action, { method: body === undefined ? "GET" : "POST",
          signal: AbortSignal.timeout(15_000),
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
        if (!response.ok) throw new Error(`native runtime fixture ${action}: ${response.status}`);
        return response.json() as Promise<T>;
      },
      async stop() {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          if (child.exitCode === null && child.signalCode === null) {
            // A closed response can race a clean process exit. Reconcile that
            // exit, while retaining a hard bound on an unacknowledged stop.
            await fetch(info.url + "/stop", { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => {});
          }
          const code = await Promise.race([exited, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("native runtime fixture cleanup timed out")), 10_000);
          })]);
          if (code !== 0) throw new Error(`native runtime fixture exit ${code}: ${errors}`);
        } finally {
          clearTimeout(deadline);
          if (child.exitCode === null && child.signalCode === null) {
            const { stopFixtureProcess } = await import("@/lib/testing/fixtureProcess");
            await stopFixtureProcess(child);
          }
        }
      },
    };
  } catch (error) {
    child.kill("SIGTERM"); await exited; throw error;
  } finally { clearTimeout(timer); }
}

async function serve(options: NativeRuntimeOptions) {
  const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } = await import("../claudeStreamBrokerHost");
  const { claudeTranscriptPath } = await import("@/lib/agent/transcript");
  const { FileRuntimeEventStore } = await import("../eventStore");
  const { claudeHostColumns } = await import("../registry");
  const { bindStructuredDeliveryQueue, releaseStructuredDeliveryHost, releaseClaudeHostForDemotion } = await import("../structuredDeliveryController");
  const { kickStructuredDeliveryQueue } = await import("../structuredDeliverySignal");
  const { handleRuntimeCommand } = await import("../http");
  const { enqueueStructuredMessage } = await import("../structuredMessageDelivery");
  const { runtimeImageStore } = await import("../runtimeImageStore");
  const { NextRequest } = await import("next/server");
  const directory = options.directory;
  const sessionId = ["00000000", "0000", "4000", "8000", "000000000080"].join("-");
  const key = { engine: "claude" as const, sessionId };
  const config = path.join(directory, ".claude");
  const resume = fs.existsSync(config);
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(directory, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  const journal = new RuntimeJournal(path.join(directory, "state", "runtime.sqlite"), { structuredHosts: true });
  const ledger = new FileClaudeDeliveryLedger();
  const store = new FileRuntimeEventStore();
  const wire: Record<string, unknown>[] = [];
  const hostOptions: import("../claudeStreamBrokerHost").ClaudeStreamBrokerHostOptions = { cwd: directory, sessionId, binary: options.binary, nativeQueuedSend: options.enabled,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: process.env.TMPDIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, LLV_STATE_DIR: process.env.LLV_STATE_DIR, NODE_ENV: "test" },
    tools: ["Bash"], model: "fixture-model", requestTimeoutMs: options.requestTimeoutMs ?? 20_000, permissionMode: "bypassPermissions",
    claudeProjectsDir: path.join(config, "projects"), deliveryLedger: ledger, eventStore: store,
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", version: options.version }),
    spawnProcess: (command: string, args: string[], launch: import("node:child_process").SpawnOptionsWithoutStdio) => {
      const child = spawn(command, [...args, "--setting-sources", ""], { ...launch, stdio: ["pipe", "pipe", "pipe"],
        env: { ...launch.env, NODE_ENV: "test", CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: options.api,
          CLAUDE_CODE_OAUTH_TOKEN: "isolated-fixture-credential", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: string, ...rest: unknown[]) => {
        wire.push(JSON.parse(String(chunk)));
        return Reflect.apply(write, child.stdin, [chunk, ...rest]);
      }) as typeof child.stdin.write;
      return child;
    },
  };
  const host = resume ? await ClaudeStreamBrokerHost.adopt(sessionId, hostOptions) : await ClaudeStreamBrokerHost.start(hostOptions);
  const registry = new AgentRegistry(path.join(directory, "state", "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  try {
    setAgentRegistryForTests(registry);
    const artifactPath = claudeTranscriptPath(directory, sessionId, path.join(config, "projects"));
    const profile = emptyLaunchProfile({ cwd: directory });
    registry.reconcileConversations([{ engine: "claude", path: artifactPath, accountId: "fixture-account", launchProfile: profile,
      turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: "2026-11-13T00:00:00.000Z" }]);
    const conversationId = registry.conversationForPath(artifactPath)!.id;
    registry.upsert({ key, artifactPath, cwd: directory, accountId: "fixture-account", launchProfile: profile,
      status: "idle", host: null, structuredHost: claudeHostColumns(await host.health(), 1),
      claimEpoch: 1, claimOwner: "fixture-writer", pendingAction: null });
    const client = {
      snapshot: async () => journal.snapshot(), events: async (after: number) => journal.replay(after),
      readSession: async identity => journal.readSession(identity),
      append: async event => journal.append(event), command: async command => journal.executeOperation(command),
      producerCursor: async (kind, prefix) => journal.producerCursor(kind, prefix),
      effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
      operationStatus: async id => journal.operationResult(id),
      transitionOperation: async (...args) => journal.transitionOperation(...args),
    } as import("../client").RuntimeHostClient;
    await bindStructuredDeliveryQueue([{ key, host }], { registry, client, watchdogIntervalMs: 0, settlementSweepMs: 0 });
    let stop!: () => void;
    let stopping = false;
    const stopped = new Promise<void>(resolve => { stop = () => { stopping = true; resolve(); }; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/stop") { stop(); return Response.json({ stopped: true }); }
      if (url.pathname === "/demote") {
        await releaseClaudeHostForDemotion(registry, key, host, { boundary: "fixture-demotion" }, async () => {
          if (!await releaseStructuredDeliveryHost(key, host)) throw new Error("fixture demotion registration changed");
        }, () => { if (stopping) throw new Error("fixture demotion cancelled"); });
        return Response.json({ released: true });
      }
      if (url.pathname === "/snapshot") return Response.json({ pid: process.pid, health: await host.health(), nativeQueued: host.supportsQueuedSend,
        memory: host.agentStateMemory(),
        wire, rows: ledger.load(sessionId), events: store.load(sessionId), journal: journal.snapshot() });
      if (url.pathname === "/image") {
        const body = await request.json() as { base64: string };
        return Response.json(runtimeImageStore().putMany([{ mime: "image/png", base64: body.base64 }]));
      }
      if (url.pathname === "/command") {
        const body = await request.json() as Record<string, unknown>;
        const result = journal.executeOperation({ ...body, conversationId } as Parameters<RuntimeJournal["executeOperation"]>[0]);
        kickStructuredDeliveryQueue(); return Response.json(result);
      }
      if (url.pathname === "/api/runtime/send") return handleRuntimeCommand(new NextRequest(request), "send", {
        enabled: () => true, structuredEnabled: () => true, client: () => client, registry: () => registry,
        enqueue: enqueueStructuredMessage, recordOperatorAdmission: () => false, kick: kickStructuredDeliveryQueue,
      });
      return new Response("", { status: 404 });
    } });
    console.log(JSON.stringify({ url: server.url.origin, conversationId }));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await stopped;
    await server.stop(false);
  } finally {
    try { await releaseStructuredDeliveryHost(key); } finally { await host.release(); }
    await bindStructuredDeliveryQueue([], { registry, client: null });
    registry.close(); journal.close();
  }

}

if (process.argv[2] === "--serve") await serve(JSON.parse(process.argv[3]!));
