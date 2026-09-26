import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { AgentRegistry } from "./registry";
import { beginLegacySpawnFixture } from "./registryTestFixtures";
import { executeSpawnRequest, type SpawnCommandDependencies } from "./spawnCommand";
import { clearTelegramConnection, saveTelegramSession, writeTelegramConnection } from "@/lib/telegram/sessionStore";
import type { RuntimeHostClient } from "@/lib/runtime/client";

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
const registry = new AgentRegistry(path.join(sandbox, "registry.json"), undefined, undefined, { sqliteMode: "off" });

function connected(): void {
  const session = saveTelegramSession("placeholder-session-for-telegram-spawn-test");
  writeTelegramConnection({ version: 1, status: "connected", credentialRef: session.credentialRef,
    identity: null, lastHealthCheckAt: null, errorCode: null, identityIdUpgradedAt: null });
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

function dependencies(engine: "claude" | "codex"): SpawnCommandDependencies {
  const account = { engine, accountId: `${engine}-test`, kind: "managed" as const,
    home: path.join(sandbox, engine), transcriptRoot: path.join(sandbox, engine, "sessions"),
    env: { NODE_ENV: "test" as const } };
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
  };
}

async function launch(engine: "claude" | "codex", seatId: string, mcpServers?: string[]) {
  const clientAttemptId = `telegram_${crypto.randomUUID()}`;
  const request = new NextRequest("http://127.0.0.1/api/spawn", { method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId, title: "Seat child Telegram grant", engine, cwd, prompt: "inspect",
      parentConversationId: seatId, ...(mcpServers ? { mcpServers } : {}) }) });
  const response = await executeSpawnRequest(request, dependencies(engine));
  return { response, receipt: registry.spawnReceiptForClientAttempt(clientAttemptId) };
}

test("the production structured launch builder keeps explicit seat-child Telegram grants for Claude and Codex", async () => {
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
  }
});

test("the production builder keeps an ungranted seat child on Viewer alone", async () => {
  const seatId = seedSeat();
  const { response, receipt } = await launch("claude", seatId);
  expect(response.status).toBe(202);
  expect(receipt?.launchProfile.mcpServers).toEqual(["viewer"]);
});

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
