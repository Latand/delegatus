import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { AgentRegistry } from "./registry";
import { beginLegacySpawnFixture } from "./registryTestFixtures";
import { executeSpawnRequest, type SpawnCommandDependencies } from "./spawnCommand";
import { clearTelegramConnection, saveTelegramSession, writeTelegramConnection, TELEGRAM_CONNECTOR_TOKEN_ENV } from "@/lib/telegram/sessionStore";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { defaultStartHost, spawnStructuredConversation, type StructuredSpawnInput } from "@/lib/runtime/structuredSpawn";
import { telegramMcpUrl } from "@/lib/telegram/packaging";
import { executeOrchestratorSeatRequest, type SeatCommandDependencies } from "@/lib/orchestrator/seatCommand";
import { defaultModelFor } from "@/lib/agent/models";
import { reboundAssembledMcpGrants } from "./mcpAllowlist";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-spawn-"));
const previous = { state: process.env.LLV_STATE_DIR, config: process.env.XDG_CONFIG_HOME,
  transport: process.env.LLV_SPAWN_TRANSPORT, socket: process.env.LLV_RUNTIME_HOST_SOCKET,
  hosts: process.env.LLV_STRUCTURED_HOSTS, events: process.env.LLV_RUNTIME_EVENTS,
  ui: process.env.NEXT_PUBLIC_RUNTIME_UI, codexBinary: process.env.LLV_CODEX_BINARY };
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_SPAWN_TRANSPORT = "structured";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "fixture.sock");
process.env.LLV_STRUCTURED_HOSTS = "1";
process.env.LLV_RUNTIME_EVENTS = "1";
process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
const codexBinary = path.join(sandbox, "codex-list-stub");
fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[{\"name\":\"viewer\"},{\"name\":\"telegram\"}]'\n");
fs.chmodSync(codexBinary, 0o755);
process.env.LLV_CODEX_BINARY = codexBinary;
afterAll(() => {
  if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
  if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.config;
  if (previous.transport === undefined) delete process.env.LLV_SPAWN_TRANSPORT; else process.env.LLV_SPAWN_TRANSPORT = previous.transport;
  if (previous.socket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = previous.socket;
  if (previous.hosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS; else process.env.LLV_STRUCTURED_HOSTS = previous.hosts;
  if (previous.events === undefined) delete process.env.LLV_RUNTIME_EVENTS; else process.env.LLV_RUNTIME_EVENTS = previous.events;
  if (previous.ui === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI; else process.env.NEXT_PUBLIC_RUNTIME_UI = previous.ui;
  if (previous.codexBinary === undefined) delete process.env.LLV_CODEX_BINARY; else process.env.LLV_CODEX_BINARY = previous.codexBinary;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const cwd = path.join(sandbox, "repo");
fs.mkdirSync(cwd, { recursive: true });
let registry = new AgentRegistry(path.join(sandbox, "registry.json"), undefined, undefined, { sqliteMode: "off" });

async function withRegistryMode(mode: "off" | "sqlite", run: (sqlitePath: string) => Promise<void>): Promise<void> {
  const previousRegistry = registry;
  const sqlitePath = path.join(sandbox, `registry-${mode}-${crypto.randomUUID()}.sqlite`);
  registry = new AgentRegistry(path.join(sandbox, `registry-${mode}-${crypto.randomUUID()}.json`),
    undefined, undefined, { sqliteMode: mode, sqliteFilename: sqlitePath });
  try { await run(sqlitePath); }
  finally { registry.close(); registry = previousRegistry; }
}

function connected(): string {
  const session = saveTelegramSession("placeholder-session-for-telegram-spawn-test");
  writeTelegramConnection({ version: 1, status: "connected", credentialRef: session.credentialRef,
    identity: null, lastHealthCheckAt: null, errorCode: null, identityIdUpgradedAt: null });
  return session.connectorToken;
}

function rewriteSqliteRow(sqlitePath: string, collection: "receipts" | "conversations", key: string,
  rewrite: (row: Record<string, unknown>) => void): void {
  const db = new Database(sqlitePath, { strict: true });
  try {
    const stored = db.query<{ value_json: string }, [string, string]>(
      "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
    ).get(collection, key);
    if (!stored) throw new Error(`missing ${collection} row`);
    const row = JSON.parse(stored.value_json) as Record<string, unknown>;
    rewrite(row);
    db.query<unknown, [string, string, string]>(
      "UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?",
    ).run(JSON.stringify(row), collection, key);
  } finally { db.close(); }
}

function seedSeat(granted = true): string {
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd,
    role: "orchestrator", origin: { kind: "operator" },
    launchProfile: { mcpServers: granted ? ["viewer", "telegram"] : ["viewer"] } });
  if (begun.kind !== "created") throw new Error("seat reservation failed");
  const sid = crypto.randomUUID();
  const artifactPath = path.join(sandbox, `${sid}.jsonl`);
  fs.writeFileSync(artifactPath, "{}\n");
  const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "claude", sessionId: sid },
    artifactPath, cwd, accountId: "seat-account", status: "idle", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind !== "settled") throw new Error("seat settlement failed");
  return settled.conversation.id;
}

function dependencies(engine: "claude" | "codex", overrides: Partial<SpawnCommandDependencies> = {}): SpawnCommandDependencies {
  const account = launchAccount(engine);
  return {
    registry: () => registry,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: () => {},
    storeImages: () => [],
    spawnStructuredConversation: async () => { throw new Error("deferred launch is outside admission test"); },
    ...overrides,
  };
}

function launchAccount(engine: "claude" | "codex") {
  return { engine, accountId: `${engine}-test`, kind: "managed" as const,
    home: path.join(sandbox, engine), transcriptRoot: path.join(sandbox, engine, "sessions"),
    env: { NODE_ENV: "test" as const, [TELEGRAM_CONNECTOR_TOKEN_ENV]: "untrusted-inherited-token" } };
}

async function launch(engine: "claude" | "codex", seatId: string | null, mcpServers?: string[], overrides: Partial<SpawnCommandDependencies> = {}) {
  const clientAttemptId = `telegram_${crypto.randomUUID()}`;
  const request = new NextRequest("http://127.0.0.1/api/spawn", { method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId, title: "Seat child Telegram grant", engine, cwd, prompt: "inspect",
      ...(seatId ? { parentConversationId: seatId } : {}), ...(mcpServers ? { mcpServers } : {}) }) });
  const response = await executeSpawnRequest(request, dependencies(engine, overrides));
  return { response, receipt: registry.spawnReceiptForClientAttempt(clientAttemptId) };
}

type LaunchEvidence = { tokenPresent: boolean; tokenMatches: boolean; telegramDefinition: unknown; reachedEngine: boolean };

/** Only the external engine protocol is synthetic; admission, deferral,
    structured startup, and both host configuration builders stay real. */
function deferredLaunch(engine: "claude" | "codex", token: string | null, codexServers?: Record<string, unknown>) {
  const work: Array<() => Promise<void>> = [];
  const evidence: LaunchEvidence = { tokenPresent: false, tokenMatches: false, telegramDefinition: null, reachedEngine: false };
  const client = {
    command: async () => ({}),
    transitionOperation: async () => ({}),
  } as unknown as RuntimeHostClient;
  const startHost = (hostInput: StructuredSpawnInput, capability: string) => defaultStartHost(hostInput, capability, {
        claude: {
          readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
          spawnProcess: (_binary, args, options) => {
            evidence.reachedEngine = true;
            evidence.tokenPresent = Boolean(options.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV]);
            evidence.tokenMatches = token !== null && options.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV] === token;
            const configPath = args[args.indexOf("--mcp-config") + 1];
            evidence.telegramDefinition = configPath
              ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.telegram
              : null;
            throw new Error("synthetic Claude protocol stopped after launch capture");
          },
        },
        codex: {
          spawnProcess: (_binary, _args, options) => {
            evidence.reachedEngine = true;
            evidence.tokenPresent = Boolean(options.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV]);
            evidence.tokenMatches = token !== null && options.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV] === token;
            return new CodexProtocolCapture((definition) => { evidence.telegramDefinition = definition; }, codexServers) as never;
          },
        },
      });
  const overrides: Partial<SpawnCommandDependencies> = {
    defer: (task) => { work.push(task); },
    runtimeHostClient: () => client,
    spawnStructuredConversation: (input) => spawnStructuredConversation(input, { startHost }),
  };
  return { work, evidence, overrides, startHost, client };
}

class CodexProtocolCapture extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42424242;
  private pending = "";

  constructor(
    private readonly capture: (definition: unknown) => void,
    private readonly configuredServers: Record<string, unknown> = { viewer: { command: "viewer-mcp" } },
  ) {
    super();
    this.stdin.on("data", (chunk) => {
      this.pending += String(chunk);
      for (let newline = this.pending.indexOf("\n"); newline >= 0; newline = this.pending.indexOf("\n")) {
        const message = JSON.parse(this.pending.slice(0, newline)) as { id?: number; method?: string; params?: Record<string, unknown> };
        this.pending = this.pending.slice(newline + 1);
        if (typeof message.id !== "number") continue;
        if (message.method === "thread/start" || message.method === "thread/resume") {
          this.capture((message.params?.config as { mcp_servers?: Record<string, unknown> })?.mcp_servers?.telegram);
          this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "synthetic Codex protocol stopped after launch capture" } }) + "\n");
          continue;
        }
        const result = message.method === "initialize" ? { userAgent: "test" }
          : message.method === "account/read" ? { account: { type: "chatgpt", planType: "pro" } }
          : message.method === "model/list" ? { data: [] }
          : message.method === "config/read" ? { config: { mcp_servers: this.configuredServers } }
          : {};
        this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      }
    });
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }
}

for (const mode of ["off", "sqlite"] as const) test(`the ${mode} production launch builder keeps seat-child Telegram grants`, async () => withRegistryMode(mode, async () => {
  connected();
  const seatId = seedSeat();
  for (const engine of ["claude", "codex"] as const) {
    const { response, receipt } = await launch(engine, seatId, ["telegram"]);
    expect(response.status).toBe(202);
    expect(receipt?.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    expect(receipt?.telegramSeatGrant).toBe(true);
    const sid = crypto.randomUUID();
    const artifactPath = path.join(sandbox, `${sid}.jsonl`);
    fs.writeFileSync(artifactPath, "{}\n");
    const settled = registry.settleSpawn(receipt!.launchId, { key: { engine, sessionId: sid },
      artifactPath, cwd, accountId: `${engine}-test`, status: "idle", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null });
    expect(settled.kind).toBe("settled");
    expect(registry.conversation(receipt!.conversationId)?.generations.at(-1)?.launchProfile.mcpServers)
      .toEqual(["viewer", "telegram"]);
    const storedProfile = registry.conversation(receipt!.conversationId)?.generations.at(-1)?.launchProfile;
    const resumed = beginLegacySpawnFixture(registry, { engine, cwd, transport: "structured",
      accountId: `${engine}-test`, conversationId: receipt!.conversationId,
      purpose: "resume-successor",
      origin: { kind: "successor" }, expectedArtifactPath: artifactPath, launchProfile: storedProfile });
    expect(resumed.kind).toBe("created");
    if (resumed.kind !== "created") throw new Error("resume reservation was unavailable");
    expect(resumed.receipt.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    expect(resumed.receipt.telegramSeatGrant).toBe(true);
    expect(resumed.receipt.parentConversationId).toBe(seatId as `conversation_${string}`);
    const probe = deferredLaunch(engine, connected());
    await expect(probe.startHost({ engine,
      receipt: resumed.receipt,
      spec: { command: engine, cwd, windowName: "resume", engine, transcript: artifactPath,
        launchProfile: resumed.receipt.launchProfile },
      account: launchAccount(engine), prompt: "", registry, client: probe.client,
    }, "test-capability")).rejects.toThrow();
    expect(probe.evidence.reachedEngine).toBe(true);
    expect(probe.evidence.tokenMatches).toBe(true);
    expect(probe.evidence.telegramDefinition, `resumed ${engine} missing Telegram definition`).toBeTruthy();
  }
}));

for (const mode of ["off", "sqlite"] as const) test(`the ${mode} production builder keeps an ungranted child on Viewer alone`, async () => withRegistryMode(mode, async () => {
  const seatId = seedSeat();
  const { response, receipt } = await launch("claude", seatId);
  expect(response.status).toBe(202);
  expect(receipt?.launchProfile.mcpServers).toEqual(["viewer"]);
}));

for (const mode of ["off", "sqlite"] as const) test(`the ${mode} disconnected operator root launches without Telegram`,
  async () => withRegistryMode(mode, async () => {
    clearTelegramConnection();
    for (const engine of ["claude", "codex"] as const) {
      const probe = deferredLaunch(engine, null);
      const { response, receipt } = await launch(engine, null, undefined, probe.overrides);
      expect(response.status).toBe(202);
      expect(receipt?.launchProfile.mcpServers).toEqual(["viewer"]);
      await Promise.all(probe.work.map(work => work()));
      expect(probe.evidence.reachedEngine).toBe(true);
      expect(probe.evidence.tokenPresent).toBe(false);
      expect(probe.evidence.telegramDefinition).toBeFalsy();
    }
  }));

test("SQLite refuses a child that forges both receipt and conversation Telegram claims", async () => withRegistryMode("sqlite", async (sqlitePath) => {
  connected();
  const seatId = seedSeat();
  const { response, receipt } = await launch("claude", seatId);
  expect(response.status).toBe(202);
  const sid = crypto.randomUUID();
  const artifactPath = path.join(sandbox, `${sid}.jsonl`);
  fs.writeFileSync(artifactPath, "{}\n");
  expect(registry.settleSpawn(receipt!.launchId, { key: { engine: "claude", sessionId: sid },
    artifactPath, cwd, accountId: "claude-test", status: "idle", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null }).kind).toBe("settled");
  rewriteSqliteRow(sqlitePath, "receipts", receipt!.launchId, row => {
    (row.launchProfile as { mcpServers: string[] }).mcpServers = ["viewer", "telegram"];
    row.telegramSeatGrant = true;
  });
  rewriteSqliteRow(sqlitePath, "conversations", receipt!.conversationId, row => {
    (row.generations as { launchProfile: { mcpServers: string[] } }[]).at(-1)!.launchProfile.mcpServers = ["viewer", "telegram"];
  });
  expect(registry.spawnReceiptForClientAttempt(receipt!.clientAttemptId!)?.launchProfile.mcpServers).toEqual(["viewer"]);
  expect(registry.conversation(receipt!.conversationId)?.generations.at(-1)?.launchProfile.mcpServers).toEqual(["viewer"]);
}));

for (const revoked of ["parent seat", "parent lineage", "admitting receipt"] as const) test(`SQLite invalidates a warm child grant when its ${revoked} changes`,
  async () => withRegistryMode("sqlite", async (sqlitePath) => {
    connected();
    const seatId = seedSeat();
    const { response, receipt } = await launch("claude", seatId, ["telegram"]);
    expect(response.status).toBe(202);
    const sid = crypto.randomUUID();
    const artifactPath = path.join(sandbox, `${sid}.jsonl`);
    fs.writeFileSync(artifactPath, "{}\n");
    expect(registry.settleSpawn(receipt!.launchId, { key: { engine: "claude", sessionId: sid },
      artifactPath, cwd, accountId: "claude-test", status: "idle", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null }).kind).toBe("settled");
    expect(registry.conversation(receipt!.conversationId)?.generations.at(-1)?.launchProfile.mcpServers)
      .toEqual(["viewer", "telegram"]);
    expect(registry.spawnReceiptForClientAttempt(receipt!.clientAttemptId!)?.launchProfile.mcpServers)
      .toEqual(["viewer", "telegram"]);
    if (revoked === "parent seat") {
      rewriteSqliteRow(sqlitePath, "conversations", seatId, row => {
        (row.generations as { launchProfile: { mcpServers: string[] } }[]).at(-1)!.launchProfile.mcpServers = ["viewer"];
      });
    } else if (revoked === "parent lineage") {
      const edge = { ...registry.readOnlySnapshot().lineageEdges[receipt!.conversationId]!,
        childConversationId: seatId as `conversation_${string}`, parentConversationId: receipt!.conversationId,
        evidence: { launchId: null, clientAttemptId: null } };
      const db = new Database(sqlitePath, { strict: true });
      try {
        db.query<unknown, [string, string, string, string]>(
          "INSERT INTO registry_rows(collection,row_key,value_json,row_order) SELECT ?,?,?,COALESCE(MAX(row_order)+1,0) FROM registry_rows WHERE collection=?",
        ).run("lineageEdges", seatId, JSON.stringify(edge), "lineageEdges");
      } finally { db.close(); }
    } else {
      rewriteSqliteRow(sqlitePath, "receipts", receipt!.launchId, row => { row.telegramSeatGrant = false; });
    }
    expect(registry.conversation(receipt!.conversationId)?.generations.at(-1)?.launchProfile.mcpServers)
      .toEqual(["viewer"]);
    expect(registry.spawnReceiptForClientAttempt(receipt!.clientAttemptId!)?.launchProfile.mcpServers)
      .toEqual(["viewer"]);
  }));

test("a child read before a contradictory seat cannot retain its Telegram grant", async () => withRegistryMode("sqlite", async () => {
  connected();
  const seatId = seedSeat();
  const { response, receipt } = await launch("claude", seatId, ["telegram"]);
  expect(response.status).toBe(202);
  const sid = crypto.randomUUID();
  const artifactPath = path.join(sandbox, `${sid}.jsonl`);
  fs.writeFileSync(artifactPath, "{}\n");
  expect(registry.settleSpawn(receipt!.launchId, { key: { engine: "claude", sessionId: sid },
    artifactPath, cwd, accountId: "claude-test", status: "idle", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null }).kind).toBe("settled");
  const file = structuredClone(registry.readOnlySnapshot());
  const childId = receipt!.conversationId;
  file.conversations = { [childId]: file.conversations[childId]!, [seatId]: file.conversations[seatId]! };
  file.lineageEdges[seatId] = { ...file.lineageEdges[childId]!,
    childConversationId: seatId as `conversation_${string}`, parentConversationId: childId };
  reboundAssembledMcpGrants(file);
  expect(file.conversations[seatId]?.generations.at(-1)?.launchProfile.mcpServers).toEqual(["viewer"]);
  expect(file.conversations[childId]?.generations.at(-1)?.launchProfile.mcpServers).toEqual(["viewer"]);
}));

test("an explicit seat-child Telegram request refuses a disconnected connector before reservation", async () => {
  const seatId = seedSeat();
  clearTelegramConnection();
  const { response, receipt } = await launch("claude", seatId, ["telegram"]);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "telegram MCP connector is not connected" });
  expect(receipt).toBeNull();
});

test("an ungranted seat cannot grant Telegram to a child", async () => {
  connected();
  const seatId = seedSeat(false);
  const { response, receipt } = await launch("claude", seatId, ["telegram"]);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "telegram MCP requires an operator-owned orchestrator seat parent" });
  expect(receipt).toBeNull();
});

for (const mode of ["off", "sqlite"] as const) test(`the ${mode} deferred seat children reach both production hosts with Telegram`, async () => withRegistryMode(mode, async () => {
  const token = connected();
  const seatId = seedSeat();
  for (const engine of ["claude", "codex"] as const) {
    const probe = deferredLaunch(engine, token);
    const { response, receipt } = await launch(engine, seatId, ["telegram"], probe.overrides);
    expect(response.status).toBe(202);
    expect(receipt?.launchProfile.mcpServers).toContain("telegram");
    await Promise.all(probe.work.map((work) => work()));
    expect(probe.evidence.reachedEngine).toBe(true);
    expect(probe.evidence.tokenMatches).toBe(true);
    expect(probe.evidence.telegramDefinition).toMatchObject(engine === "claude"
      ? { type: "http", url: telegramMcpUrl(), headers: { Authorization: `Bearer \${${TELEGRAM_CONNECTOR_TOKEN_ENV}}` } }
      : { url: telegramMcpUrl(), bearer_token_env_var: TELEGRAM_CONNECTOR_TOKEN_ENV, enabled: true });
  }
}));

for (const mode of ["off", "sqlite"] as const) test(`the ${mode} seat builder reaches both production hosts with Telegram`, async () => withRegistryMode(mode, async () => {
  const token = connected();
  for (const engine of ["claude", "codex"] as const) {
    const probe = deferredLaunch(engine, token);
    const attempt = `seat_${crypto.randomUUID()}`;
    const seatDependencies: SeatCommandDependencies = {
      spawn: async (body) => {
        const request = new NextRequest("http://127.0.0.1/api/spawn", { method: "POST",
          headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
          body: JSON.stringify(body) });
        const response = await executeSpawnRequest(request, dependencies(engine, probe.overrides));
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      },
      deliver: async () => ({ ok: true }),
      conversationTarget: () => null,
      projectTasks: () => [],
      summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
      launchSettlement: () => ({ kind: "unknown" }),
      stampRegistryIdentity: () => {},
      runtimeIdentity: () => ({ engine: null, model: null }),
      resolvedConversation: () => null,
      engineReadiness: () => "connected",
      now: () => new Date().toISOString(),
    };
    const result = await executeOrchestratorSeatRequest({
      project: `proj-${engine}-${crypto.randomUUID()}`, mandate: "own test board",
      clientRequestId: attempt, engine, model: defaultModelFor(engine), cwd,
    }, seatDependencies);
    if (result.status !== 202) throw new Error(JSON.stringify(result.body));
    expect(registry.spawnReceiptForClientAttempt(attempt)?.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    await Promise.all(probe.work.map((work) => work()));
    expect(probe.evidence.reachedEngine).toBe(true);
    expect(probe.evidence.tokenMatches).toBe(true);
    expect(probe.evidence.telegramDefinition).toMatchObject(engine === "claude"
      ? { url: telegramMcpUrl() }
      : { url: telegramMcpUrl(), bearer_token_env_var: TELEGRAM_CONNECTOR_TOKEN_ENV, enabled: true });
  }
}));

for (const mode of ["off", "sqlite"] as const) test(`the ${mode} ungranted children reach both hosts without a Telegram token`, async () => withRegistryMode(mode, async () => {
  const token = connected();
  const seatId = seedSeat();
  for (const engine of ["claude", "codex"] as const) {
    const probe = deferredLaunch(engine, token);
    const { response } = await launch(engine, seatId, undefined, probe.overrides);
    expect(response.status).toBe(202);
    await Promise.all(probe.work.map((work) => work()));
    expect(probe.evidence.reachedEngine).toBe(true);
    expect(probe.evidence.tokenPresent).toBe(false);
    expect(probe.evidence.telegramDefinition).toBeFalsy();
  }
}));

test("disconnect between admission and deferred host start terminalizes a granted child", async () => {
  const token = connected();
  const seatId = seedSeat();
  for (const engine of ["claude", "codex"] as const) {
    const probe = deferredLaunch(engine, token);
    const { response, receipt } = await launch(engine, seatId, ["telegram"], probe.overrides);
    expect(response.status).toBe(202);
    clearTelegramConnection();
    await Promise.all(probe.work.map((work) => work()));
    expect(probe.evidence.reachedEngine).toBe(false);
    expect(registry.spawnReceiptForClientAttempt(receipt!.clientAttemptId!)).toMatchObject({
      state: "failed",
      error: "telegram MCP connector is not connected at launch",
    });
    connected();
  }
});

test("a conflicting Codex account definition ends the granted launch with a named refusal", async () => {
  const token = connected();
  const seatId = seedSeat();
  const probe = deferredLaunch("codex", token, {
    viewer: { command: "viewer-mcp" }, telegram: { command: "unrelated-server" },
  });
  const { response, receipt } = await launch("codex", seatId, ["telegram"], probe.overrides);
  expect(response.status).toBe(202);
  await Promise.all(probe.work.map((work) => work()));
  expect(probe.evidence.telegramDefinition).toBeNull();
  expect(registry.spawnReceiptForClientAttempt(receipt!.clientAttemptId!)).toMatchObject({
    state: "failed", error: "telegram MCP account definition conflicts with operator connector",
  });
});
