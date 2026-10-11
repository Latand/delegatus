import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { POST } from "@/app/api/spawn/route";
import { AgentRegistry } from "@/lib/agent/registry";
import { BINDINGS_SOURCE, resetAccountCollectionsForTests } from "@/lib/accounts/accountsStore";
import { clearAccountFixture, seedAccountSource } from "@/lib/accounts/accountsStoreFixture";
import { projectForCwd } from "@/lib/scanner/describe";
import { viewerMcpBindings, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, createViewerMcpServer, McpToolRefusal, MemoryMcpReceiptStore } from "./server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-account-"));
let testNumber = 0;
let previousState: string | undefined;
let previousCodexBinary: string | undefined;
let previousRuntimeSocket: string | undefined;
let registry: AgentRegistry;

{
  previousState = process.env.LLV_STATE_DIR;
  previousCodexBinary = process.env.LLV_CODEX_BINARY;
  previousRuntimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(sandbox, "account"));
  const binary = path.join(sandbox, "codex-fixture");
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$3 $4" = "mcp list" ]; then echo "[]"; else exit 1; fi\n', { mode: 0o700 });
  process.env.LLV_CODEX_BINARY = binary;
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "unused-runtime.sock");
}

beforeEach(() => {
  resetAccountCollectionsForTests();
  clearAccountFixture(BINDINGS_SOURCE);
  registry?.close();
  registry = new AgentRegistry(path.join(sandbox, `registry-${++testNumber}.json`), undefined, undefined, { sqliteMode: "off" });
});

afterAll(() => {
  registry.close();
  resetAccountCollectionsForTests();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
  else process.env.LLV_CODEX_BINARY = previousCodexBinary;
  if (previousRuntimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = previousRuntimeSocket;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function bind(accounts: string[]) {
  seedAccountSource(BINDINGS_SOURCE, {
    schemaVersion: 1,
    bindings: accounts.map(accountId => ({ engine: "codex", accountId, project: projectForCwd(sandbox), createdAt: "2026-10-01T00:00:00.000Z" })),
  });
}

function harness() {
  let resolvedAccount: string | undefined;
  const resolutions: { requested: string | null | undefined; project: string | null | undefined }[] = [];
  const accountContext = (accountId: string) => ({
    engine: "codex" as const, accountId, kind: "managed" as const,
    home: path.join(sandbox, "account"), transcriptRoot: path.join(sandbox, "sessions"), env: { NODE_ENV: "test" as const },
  });
  const routeDependencies: NonNullable<Parameters<typeof POST.withDependencies>[1]> = {
    ...POST.productionDependencies,
    registry: () => registry,
    assertStructuredRuntime: () => {},
    engineReadiness: () => "connected",
    autonomousStructured: true,
    runtimeHostClient: () => ({} as ReturnType<typeof POST.productionDependencies.runtimeHostClient>),
    resolveSpawnAccount: (_engine, accountId) => accountContext(accountId ?? "account-a"),
    resolveHealthySpawnAccount: async (_engine, requested, project) => {
      resolutions.push({ requested, project });
      return accountContext(resolvedAccount ?? requested ?? "account-a");
    },
    storeImages: () => [],
    defer: () => {},
    spawnTmuxAgent: async () => { throw new Error("a real agent must never launch"); },
    spawnStructuredConversation: async () => { throw new Error("a real agent must never launch"); },
  };
  const bindings = viewerMcpBindings(undefined, {
    post: async (pathname, body, headers) => {
      const response = await POST.withDependencies(new NextRequest(`http://127.0.0.1${pathname}`, {
        method: "POST", headers: { ...headers, host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify(body),
      }), routeDependencies);
      const payload = await response.json();
      if (!response.ok) throw new McpToolRefusal(payload.error, { status: response.status, code: payload.code });
      return payload;
    },
  }, {
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_seat", role: "orchestrator" }),
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {} }),
    authorizedSeats: () => [{ conversationId: "conversation_seat", path: "seat.jsonl", project: projectForCwd(sandbox) }],
    loadTasks: () => [],
  } as unknown as ViewerMcpDomainDependencies);
  return { bindings, routeDependencies, resolutions, resolveAs: (account: string) => { resolvedAccount = account; } };
}

async function withClient(run: (client: Client, fixture: ReturnType<typeof harness>) => Promise<void>) {
  const fixture = harness();
  const server = createViewerMcpServer(createMcpToolService(fixture.bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "spawn-account-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await run(client, fixture); }
  finally { await client.close(); await server.close(); }
}

function requestId() { return `spawn-account-fixture-${testNumber}`; }

function args(account?: string | null) {
  return { clientRequestId: requestId(), cwd: sandbox, title: "Inspect account routing", ["prompt"]: "Inspect routing", engine: "codex", model: "gpt-6.1-sol", ...(account === undefined ? {} : { account }) };
}

test("an MCP account pin reaches the spawn route and its durable launch receipt", async () => {
  bind(["account-a", "account-b"]);
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: args("account-b") });
    expect(resolutions).toEqual([{ requested: "account-b", project: projectForCwd(sandbox) }]);
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(registry.spawnReceiptForClientAttempt(requestId())).toMatchObject({ accountId: "account-b", accountPin: true });
  });
});

test("the MCP spawn route refuses an account outside the target project's binding before reservation", async () => {
  bind(["account-a"]);
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: args("account-b") });
    expect(response.structuredContent).toMatchObject({ ok: false, details: { status: 409, code: "project_account_refused" } });
    const payload = response.structuredContent as { error: string };
    expect(payload.error).toContain("account-a");
    expect(payload.error).toContain("account-b");
    expect(resolutions).toEqual([]);
    expect(registry.spawnReceiptForClientAttempt(requestId())).toBeNull();
  });
});

test("an advertised account pin cannot reserve a launch onto a resolver fallback", async () => {
  bind(["account-a", "account-b"]);
  await withClient(async (client, { resolveAs }) => {
    resolveAs("account-a");
    const response = await client.callTool({ name: "spawn_agent", arguments: args("account-b") });
    expect(response.structuredContent).toMatchObject({ ok: false });
    expect(registry.spawnReceiptForClientAttempt(requestId())?.state).toBe("failed");
  });
});

test.each([null, undefined])("account %j leaves selection to the target project and records the selected account", async account => {
  bind(["account-a"]);
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: args(account) });
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(resolutions).toEqual([{ requested: undefined, project: projectForCwd(sandbox) }]);
    expect(registry.spawnReceiptForClientAttempt(requestId())).toMatchObject({ accountId: "account-a", accountPin: false });
  });
});

test("an unbound target project accepts a named account", async () => {
  await withClient(async client => {
    const response = await client.callTool({ name: "spawn_agent", arguments: args("account-b") });
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(registry.spawnReceiptForClientAttempt(requestId())).toMatchObject({ accountId: "account-b" });
  });
});

test.each(["merger", "deployer", "reviewer"])("a %s preset honours the advertised account", async role => {
  bind(["account-a", "account-b"]);
  const reviewed = registry.ensureConversation("codex", path.join(sandbox, "reviewed.jsonl"), "account-a");
  const roleArgs = role === "merger" ? { roleParams: { prs: `1@${"a".repeat(40)}` } }
    : role === "deployer" ? { roleParams: { sha: "a".repeat(40) }, confirm: "deploy" }
    : { roleParams: { diffSource: "PR #1" }, reviews: reviewed.id };
  await withClient(async client => {
    const response = await client.callTool({ name: "spawn_agent", arguments: { ...args("account-b"), role, ...roleArgs } });
    expect(response.structuredContent).toMatchObject({ ok: true });
    expect(registry.spawnReceiptForClientAttempt(requestId())).toMatchObject({ accountId: "account-b", agentRole: role });
  });
});

test("a pin replays once and a changed account conflicts with the original MCP request", async () => {
  bind(["account-a", "account-b"]);
  await withClient(async (client, { resolutions }) => {
    const request = { name: "spawn_agent", arguments: args("account-b") };
    expect((await client.callTool(request)).structuredContent).toMatchObject({ ok: true, replayed: false });
    expect((await client.callTool(request)).structuredContent).toMatchObject({ ok: true, replayed: true });
    expect((await client.callTool({ ...request, arguments: args("account-a") })).structuredContent)
      .toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(resolutions).toHaveLength(1);
  });
});

test.each([42, {}, true])("invalid account %j is refused at the MCP schema before dispatch", async account => {
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: { ...args(), account } });
    expect(response.isError).toBe(true);
    expect(resolutions).toEqual([]);
    expect(registry.spawnReceiptForClientAttempt(requestId())).toBeNull();
  });
});

test("conflicting advertised and legacy accounts are refused by the spawn route", async () => {
  await withClient(async (client, { resolutions }) => {
    const response = await client.callTool({ name: "spawn_agent", arguments: { ...args("account-b"), accountId: "account-a" } });
    expect(response.structuredContent).toMatchObject({ ok: false, error: "account and accountId must agree", details: { status: 400 } });
    expect(resolutions).toEqual([]);
  });
});

test("the spawn HTTP route validates account without relying on the MCP schema", async () => {
  const { routeDependencies, resolutions } = harness();
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ ...args(), clientAttemptId: requestId(), account: 42 }),
  }), routeDependencies);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "account must be a string or null" });
  expect(resolutions).toEqual([]);
});
