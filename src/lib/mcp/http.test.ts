import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";

/**
 * The shared Streamable HTTP endpoint, driven at its public boundary.
 *
 * An SDK client speaks the protocol over real HTTP to a loopback listener that
 * rebuilds each request as a `NextRequest` and hands it to the EXPORTED route
 * (`src/app/api/mcp/route.ts`). Behind the route is the production tool
 * service — real bindings, the real per-call policy, the SQLite receipt store —
 * and the production identity resolution: the capability each client presents
 * is looked up in a real registry. The only stand-in is the Viewer's
 * `/api/tmux` delivery route, served on the same listener, which records what
 * the bindings forwarded and delivers nothing.
 *
 * Everything runs in a private sandbox: state, config, home and temp all point
 * inside it before a single Viewer module loads.
 */

const originalEnv = { ...process.env };
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-http-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LLV_") || key.startsWith("NEXT_PUBLIC_")) delete process.env[key];
}
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}

const { agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const route = await import("@/app/api/mcp/route");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore, SqliteMcpReceiptStore } = await import("./server");
const { productionViewerControlDependencies, sendDownstreamKey, viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");

interface Delivery {
  capability: string | null;
  clientMessageId: string;
}

let listener: ReturnType<typeof Bun.serve> | null = null;
let port = 0;
let origin = "";
let deliveries: Delivery[] = [];
/** When set, the next MCP request is served by the route and its answer is
    then lost on the way back, as when the stable listener loses its upstream
    mid-answer during a deploy. */
let loseNextAnswer = false;
/** When set, the delivery route holds its answer until the bindings' request
    to it is abandoned, and resolves this with how long it waited. */
let holdDelivery: ((waitedMs: number) => void) | null = null;

function serveViewer(listenPort: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: listenPort,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/tmux" && request.method === "POST" && holdDelivery) {
        const settle = holdDelivery;
        holdDelivery = null;
        const started = Date.now();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        settle(Date.now() - started);
        return new Response(null, { status: 499 });
      }
      if (url.pathname === "/api/tmux" && request.method === "POST") {
        const body = await request.json() as { clientMessageId: string };
        deliveries.push({ capability: request.headers.get("x-llv-spawn-capability"), clientMessageId: body.clientMessageId });
        const operationId = `op_${body.clientMessageId.slice(-12)}`;
        return Response.json({ ok: true, operationId, outcome: "queued", receipt: { operationId, status: "queued" } });
      }
      if (url.pathname === "/api/mcp") {
        const next = new NextRequest(url, {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          ...(request.method === "POST" ? { body: await request.text() } : {}),
        });
        const answer = request.method === "POST"
          ? await route.POST(next)
          : request.method === "DELETE" ? route.DELETE() : route.GET();
        if (loseNextAnswer) {
          loseNextAnswer = false;
          await answer.arrayBuffer();
          return new Response(null, { status: 502 });
        }
        return answer;
      }
      return Response.json({ error: `no route for ${request.method} ${url.pathname}` }, { status: 404 });
    },
  });
}

interface Agent {
  conversationId: string;
  launchId: string;
  capability: string;
}

let alice: Agent;
let bob: Agent;

function launchAgent(title: string): Agent {
  const registry = agentRegistry();
  const receipt = registry.beginSpawn("claude", sandbox, { cwd: sandbox, title });
  return { conversationId: receipt.conversationId, launchId: receipt.launchId, capability: registry.rotateSpawnCapabilityForReceipt(receipt.launchId) };
}

beforeAll(() => {
  listener = serveViewer(0);
  port = listener.port!;
  origin = `http://127.0.0.1:${port}`;
  /* Where the bindings send the delivery the send tool makes. */
  process.env.LLV_VIEWER_CONTROL_URL = origin;
  alice = launchAgent("HTTP MCP caller A");
  bob = launchAgent("HTTP MCP caller B");
});

afterAll(() => {
  listener?.stop(true);
  setAgentRegistryForTests(null);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  deliveries = [];
  loseNextAnswer = false;
});

async function httpClient(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "llv-http-mcp-regression", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", origin), { requestInit: { headers } }));
  /* As an agent does at startup; it also primes the client's tool cache, so a
     later call is exactly one request. */
  await client.listTools();
  return client;
}

function agentClient(agent: Agent): Promise<Client> {
  return httpClient({ "x-llv-spawn-capability": agent.capability });
}

function payloadOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

function send(client: Client, clientRequestId: string, to: Agent = bob) {
  return client.callTool({ name: "send_message", arguments: { clientRequestId, conversationId: to.conversationId, text: "hello over http" } });
}

async function rawPost(headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL("/api/mcp", origin), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("the HTTP endpoint publishes exactly the stdio server's tools, schemas and instructions", async () => {
  const http = await agentClient(alice);
  const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies()), new MemoryMcpReceiptStore(), viewerMcpToolPolicy());
  const server = createViewerMcpServer(service);
  const stdio = new Client({ name: "llv-stdio-shape", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), stdio.connect(clientSide)]);
  try {
    const [overHttp, overStdio] = await Promise.all([http.listTools(), stdio.listTools()]);
    expect(overHttp.tools.length).toBeGreaterThan(30);
    expect(overHttp.tools).toEqual(overStdio.tools);
    expect(http.getInstructions()).toBe(stdio.getInstructions());
    expect(http.getServerVersion()).toEqual(stdio.getServerVersion());
  } finally {
    await Promise.all([http.close(), stdio.close(), server.close()]);
  }
});

test("a missing, malformed, unknown or rotated capability is refused before any tool runs", async () => {
  const missing = await rawPost({});
  expect(missing.status).toBe(403);
  expect(missing.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32001 } });
  expect((await rawPost({ "x-llv-spawn-capability": "not-a-capability" })).status).toBe(403);
  expect((await rawPost({ "x-llv-spawn-capability": crypto.randomBytes(32).toString("base64url") })).status).toBe(403);

  /* A relaunch rotates the capability; the one it replaced names nobody. */
  const carol = launchAgent("HTTP MCP rotated caller");
  const rotated = agentRegistry().rotateSpawnCapabilityForReceipt(carol.launchId);
  const stale = await rawPost({ "x-llv-spawn-capability": carol.capability });
  expect(stale.status).toBe(403);
  expect(JSON.stringify(stale.body)).not.toContain(carol.capability);
  expect((await rawPost({ "x-llv-spawn-capability": rotated })).status).toBe(200);

  /* Never a browser's cross-site request. */
  expect((await rawPost({ "x-llv-spawn-capability": alice.capability, origin: "http://evil.example" })).status).toBe(403);

  /* A client with no capability cannot even initialize. */
  await expect(httpClient({})).rejects.toThrow();
  expect(deliveries).toEqual([]);

  /* Stateless: nothing to stream, nothing to end. */
  for (const method of ["GET", "DELETE"]) {
    const response = await fetch(new URL("/api/mcp", origin), { method, headers: { "x-llv-spawn-capability": alice.capability } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  }
});

test("each call runs as the agent whose capability it presented, and one agent's key cannot replay another's call", async () => {
  const [a, b] = await Promise.all([agentClient(alice), agentClient(bob)]);
  try {
    /* Interleaved calls from both agents: every forwarded delivery carries the
       capability of the agent that made that call and of no other. */
    const calls = Array.from({ length: 6 }, (_, index) => index % 2 === 0
      ? send(a, `http-identity-a-${index}`, bob)
      : send(b, `http-identity-b-${index}`, alice));
    const results = await Promise.all(calls);
    for (const result of results) expect(payloadOf(result)).toMatchObject({ ok: true });
    expect(deliveries).toHaveLength(6);
    for (const delivery of deliveries) {
      const index = Array.from({ length: 6 }, (_, i) => i).find((i) => delivery.clientMessageId === sendDownstreamKey(`http-identity-${i % 2 === 0 ? "a" : "b"}-${i}`));
      expect(index).toBeDefined();
      expect(delivery.capability).toBe(index! % 2 === 0 ? alice.capability : bob.capability);
    }

    /* The durable claim names the caller the server derived from the key. */
    const store = new SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "mcp-receipts.sqlite"));
    const claimA = await store.lookup("send_message:http-identity-a-0");
    const claimB = await store.lookup("send_message:http-identity-b-1");
    expect(claimA?.binding?.caller).toMatchObject({ kind: "worker", conversationId: alice.conversationId });
    expect(claimB?.binding?.caller).toMatchObject({ kind: "worker", conversationId: bob.conversationId });

    /* Replaying one's own call answers from the receipt and delivers nothing new. */
    const replay = await send(a, "http-identity-a-0", bob);
    expect(payloadOf(replay)).toMatchObject({ ok: true, replayed: true });
    /* The other agent presenting the same clientRequestId learns nothing and
       causes nothing. */
    const borrowed = await send(b, "http-identity-a-0", bob);
    expect(borrowed.isError).toBe(true);
    expect(payloadOf(borrowed)).toMatchObject({ ok: false, code: "recovery_not_permitted" });
    expect(deliveries).toHaveLength(6);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test("a restart fails the call in flight cleanly and the next call succeeds on the same client, with no duplicate side effect", async () => {
  const client = await agentClient(alice);
  try {
    /* 1. The route ran and delivered, but the answer never came back (the
          stable listener lost its upstream mid-answer). The call fails. */
    loseNextAnswer = true;
    await expect(send(client, "http-restart-lost-answer")).rejects.toThrow();
    expect(deliveries).toHaveLength(1);
    /* Retrying under the SAME clientRequestId answers from the receipt: the
       message is not delivered twice. */
    const retried = await send(client, "http-restart-lost-answer");
    expect(payloadOf(retried)).toMatchObject({ ok: true, replayed: true });
    expect(deliveries).toHaveLength(1);

    /* 2. The Viewer is gone altogether: the call fails as a transport error. */
    listener!.stop(true);
    await expect(send(client, "http-restart-down")).rejects.toThrow();
    expect(deliveries).toHaveLength(1);

    /* 3. The Viewer is back on the same port. The same client, with no new
          session and no reconnect, simply makes its next call. */
    listener = serveViewer(port);
    const after = await send(client, "http-restart-down");
    expect(after.isError).not.toBe(true);
    expect(payloadOf(after)).toMatchObject({ ok: true });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual({ capability: alice.capability, clientMessageId: sendDownstreamKey("http-restart-down") });
  } finally {
    await client.close();
  }
});

test("a client's cancel ends the call it names, over the stateless endpoint", async () => {
  const client = await agentClient(alice);
  try {
    const abandoned = new Promise<number>((resolve) => { holdDelivery = resolve; });
    const controller = new AbortController();
    const call = client.callTool(
      { name: "send_message", arguments: { clientRequestId: "http-walk-away", conversationId: bob.conversationId, text: "held" } },
      undefined,
      { signal: controller.signal },
    );
    await Bun.sleep(300);
    /* The SDK client sends `notifications/cancelled` on a new POST and keeps
       the original request open, as Claude's client does. */
    controller.abort();
    await expect(call).rejects.toThrow();
    /* The Viewer-side work — here the delivery the tool was waiting on — is
       abandoned promptly, well inside the 30-second tool deadline that alone
       bounded it before. */
    const waited = await Promise.race([abandoned, Bun.sleep(4_000).then(() => Number.POSITIVE_INFINITY)]);
    expect(waited).toBeLessThan(4_000);
  } finally {
    holdDelivery = null;
    await client.close();
  }
}, 15_000);
