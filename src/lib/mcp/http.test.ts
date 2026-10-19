import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { awaitFixtureFile } from "./fixtureBarrier";

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
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.TMPDIR = sandbox;
fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), JSON.stringify({
  schemaVersion: 1, aliases: {}, displayNames: { viewer: "Fixture Viewer" },
}));

const { agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const route = await import("@/app/api/mcp/route");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore, SqliteMcpReceiptStore, withMcpDispatchTurns } = await import("./server");
const { productionViewerControlDependencies, sendDownstreamKey, viewerMcpBindings, viewerMcpRecoverableTools, viewerMcpToolPolicy } = await import("./bindings");

test("a tool server still validates elicited content when its JSON Schema validator starts lazily", async () => {
  const server = createViewerMcpServer({ async callTool() { throw new Error("no tool expected"); } });
  const client = new Client({ name: "elicitation-fixture", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  let content: Record<string, string | number> = { value: "accepted" };
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const params = { message: "Fixture value", requestedSchema: {
    type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"],
  } };
  try {
    expect(await server.server.elicitInput(params)).toMatchObject({ action: "accept", content: { value: "accepted" } });
    content = { value: 42 };
    await expect(server.server.elicitInput(params)).rejects.toThrow("does not match requested schema");
    content = { value: "accepted again" };
    expect(await server.server.elicitInput(params)).toMatchObject({ action: "accept", content });
  } finally { await Promise.all([client.close(), server.close()]); }
});

test("MCP dispatch yields to timers, preserves each caller and keeps awaited operations concurrent", async () => {
  const { runAsMcpHttpCaller, currentMcpHttpCaller } = await import("./callerContext");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  const observed: Array<string | undefined> = [];
  const service = withMcpDispatchTurns({ async callTool(toolName, args) {
    observed.push(currentMcpHttpCaller()?.capability);
    if (args.clientRequestId === "held") await held;
    return { ok: true, toolName: toolName as import("./server").McpToolName, clientRequestId: String(args.clientRequestId), replayed: false };
  } });
  const first = runAsMcpHttpCaller({ capability: "fixture-first" }, () => service.callTool("list_tasks", { clientRequestId: "held" }));
  try {
    const second = await runAsMcpHttpCaller({ capability: "fixture-second" }, () => service.callTool("list_tasks", { clientRequestId: "free" }));
    expect(second.ok).toBe(true);
    expect(timerRan).toBe(true);
    expect(observed).toEqual(["fixture-first", "fixture-second"]);
  } finally { clearTimeout(timer); release(); await first; }
  const cancelled = new AbortController(); cancelled.abort();
  const refused = await service.callTool("create_task", { clientRequestId: "original-key" }, { signal: cancelled.signal });
  expect(refused).toMatchObject({ ok: false, code: "outcome_unknown", details: { nextAction: "original-key-lookup" } });
  expect(observed).toHaveLength(2);
  expect((await service.callTool("create_task", { clientRequestId: "original-key" })).ok).toBe(true);
  expect(observed).toHaveLength(3);
});

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
let loseNextDeliveryAnswer = false;
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
        if (loseNextDeliveryAnswer) {
          loseNextDeliveryAnswer = false;
          return new Response('{"ok":', { headers: { "content-type": "application/json" } });
        }
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

beforeAll(async () => {
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  const at = "2026-10-01T00:00:00.000Z";
  beginOrchestratorSeatIntent({ project: "viewer", mandate: "Fixture board", clientRequestId: "http-fixture-seat", mode: "existing", now: at });
  completeOrchestratorSeatIntent({ project: "viewer", clientRequestId: "http-fixture-seat", conversationId: "conversation_http_fixture_seat", path: null, preparedAuthCredentialBaseline: null, now: at });
  listener = serveViewer(0);
  port = listener.port!;
  origin = `http://127.0.0.1:${port}`;
  /* Where the bindings send the delivery the send tool makes. */
  process.env.LLV_VIEWER_CONTROL_URL = origin;
  alice = launchAgent("HTTP MCP caller A");
  bob = launchAgent("HTTP MCP caller B");
});

afterAll(async () => {
  listener?.stop(true);
  await (await import("./taskExecutor")).viewerTaskExecutor().close();
  await reapFixtureChildren();
  setAgentRegistryForTests(null);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  deliveries = [];
  loseNextAnswer = false;
  loseNextDeliveryAnswer = false;
});

async function httpClient(headers: Record<string, string>, name = "llv-http-mcp-regression"): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", origin), { requestInit: { headers } }));
  /* As an agent does at startup; it also primes the client's tool cache, so a
     later call is exactly one request. */
  await client.listTools();
  return client;
}

for (const engine of ["codex-mcp-client", "claude-code"]) test(`${engine} receives one JSON result across HTTP executor calls`, async () => {
  const client = await httpClient({ "x-llv-spawn-capability": alice.capability, "user-agent": `${engine}/fixture` }, engine);
  try {
    const success = await client.callTool({ name: "list_tasks", arguments: { ids: ["task-fixture-absent"] } });
    expect(success.structuredContent).toBeUndefined();
    expect(success.content).toHaveLength(1);
    expect(JSON.parse((success.content as Array<{ text: string }>)[0].text)).toMatchObject({ ok: true, toolName: "list_tasks" });
    const invalid = await client.callTool({ name: "create_task", arguments: {
      clientRequestId: `format-invalid-${engine}`, project: "fixture-project", text: "Inspect the transport", details: 42,
    } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toBeUndefined();
    expect(invalid.content).toHaveLength(1);
    expect(JSON.parse((invalid.content as Array<{ text: string }>)[0].text)).toMatchObject({ ok: false, code: "TASK_INVALID_FIELD" });
  } finally { await client.close(); }
});

function agentClient(agent: Agent): Promise<Client> {
  return httpClient({ "x-llv-spawn-capability": agent.capability });
}

function payloadOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

async function holdReceiptLock(holdMs: number) {
  const filename = path.join(process.env.LLV_STATE_DIR!, "mcp-receipts.sqlite");
  new SqliteMcpReceiptStore(filename).close();
  const ready = path.join(sandbox, `lock-${crypto.randomUUID()}`);
  const release = `${ready}-release`;
  const child = ownFixtureChild(Bun.spawn([process.execPath, path.join(import.meta.dir, "receiptStoreProbeChild.ts"),
    "hold-sqlite", filename, ready, release, String(holdMs)], { env: process.env, stdout: "pipe", stderr: "pipe" }));
  await awaitFixtureFile(ready);
  return { child, async close() {
    fs.writeFileSync(release, "released");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  } };
}

test("HTTP retries a failed first inline initialization and original keys without repeating a write", async () => {
  const client = await agentClient(alice);
  // The task executor warms the HTTP wrapper without opening its inline store.
  await client.callTool({ name: "get_task", arguments: { taskId: "missing-task" } });
  const lock = await holdReceiptLock(6200);
  const args = { limit: 1, clientRequestId: "first-inline-read" };
  try {
    const [read, write] = await Promise.all([
      client.callTool({ name: "list_flows", arguments: args }),
      send(client, "first-inline-send"),
    ]);
    expect(read.isError).toBe(true);
    expect(write.isError).toBe(true);
    expect(JSON.stringify(read.content)).toMatch(/state admission timed out|database is locked/);
    expect(deliveries).toHaveLength(0);
    expect(await lock.child.exited).toBe(0);
    expect(payloadOf(await client.callTool({ name: "list_flows", arguments: args }))).toMatchObject({ ok: true });
    expect(payloadOf(await client.callTool({ name: "list_flows", arguments: { limit: 1, clientRequestId: "after-inline-failure" } })))
      .toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "first-inline-send"))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "first-inline-send"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries).toHaveLength(1);
  } finally { await lock.close(); await client.close(); }
}, 20_000);

test("forwarded stdio receipt contention yields on the Viewer and preserves replay", async () => {
  const client = new Client({ name: "receipt-contention", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(import.meta.dir, "entry.ts")],
    env: Object.fromEntries(Object.entries({ ...process.env, LLV_SPAWN_CAPABILITY: alice.capability })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: "pipe" });
  await client.connect(transport);
  await client.callTool({ name: "list_flows", arguments: { limit: 1 } });
  const lock = await holdReceiptLock(1200);
  const { performanceSpans, performanceSites } = await import("@/lib/performanceSpans");
  const start = performance.now();
  let previous = start, maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now;
  }, 5);
  const args = { limit: 1, clientRequestId: "stdio-held-receipt" };
  try {
    expect(payloadOf(await client.callTool({ name: "list_flows", arguments: args }))).toMatchObject({ ok: true });
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    const slices = performanceSpans.snapshot(start).records.filter(row => row.kind === "sync"
      && performanceSites[row.site] === "state.write-wait");
    const maxSliceMs = Math.max(0, ...slices.map(row => row.maxMs));
    console.info(`[receipt contention] ${JSON.stringify({ maxGapMs, maxSliceMs })}`);
    expect(maxGapMs).toBeLessThan(50);
    expect(slices.length).toBeGreaterThan(0);
    expect(maxSliceMs).toBeLessThan(50);
    expect(payloadOf(await client.callTool({ name: "list_flows", arguments: args }))).toMatchObject({ ok: true, replayed: true });
    expect(payloadOf(await send(client, "stdio-held-send"))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "stdio-held-send"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries).toHaveLength(1);
  } finally { clearInterval(timer); await lock.close(); await client.close(); }
}, 20_000);

test("task HTTP execution preserves protocol validation, exact text, caller receipts and replay", async () => {
  const client = await agentClient(alice);
  const details = "First line\nA tab\tand a backslash \\ with Unicode λ";
  const args = { project: "Fixture Viewer", text: "Task HTTP executor fixture", details, board: "hidden", clientRequestId: "http-task-protocol" };
  try {
    const invalid = payloadOf(await client.callTool({ name: "create_task", arguments: { ...args, steps: "invalid" } }));
    expect(invalid).toMatchObject({ ok: false, code: "TASK_INVALID_FIELD" });
    const created = payloadOf(await client.callTool({ name: "create_task", arguments: { ...args, full: true } }));
    expect(created).toMatchObject({ ok: true, task: { text: args.text, details } });
    expect(payloadOf(await client.callTool({ name: "create_task", arguments: { ...args, full: true } })))
      .toMatchObject({ ok: true, replayed: true, taskId: created.taskId, revision: created.revision });
    const other = await agentClient(bob);
    try {
      expect(payloadOf(await other.callTool({ name: "create_task", arguments: { ...args, full: true } })))
        .toMatchObject({ ok: true, replayed: true, taskId: created.taskId, revision: created.revision,
          task: { statusBy: (created.task as { statusBy: unknown }).statusBy } });
      expect(payloadOf(await other.callTool({ name: "update_task", arguments: {
        taskId: created.taskId, note: "Second caller note", clientRequestId: "http-task-note", full: true,
      } }))).toMatchObject({ ok: true, task: { note: { author: { conversationId: bob.conversationId } } } });
    } finally { await other.close(); }
    expect(payloadOf(await client.callTool({ name: "get_task", arguments: { taskId: created.taskId, full: true } })))
      .toMatchObject({ ok: true, task: { text: args.text, details } });
  } finally { await client.close(); }
});

function send(client: Client, clientRequestId: string, to: Agent = bob) {
  return client.callTool({ name: "send_message", arguments: { clientRequestId, conversationId: to.conversationId, text: "hello over http" } });
}

test("an authenticated compatibility adapter keeps unidentified authority and cannot borrow a launch identity", async () => {
  const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
  const headers = { ...internalServiceHeaders("mcp"), "x-delegatus-mcp-unattributed": "1" };
  await expect(httpClient({ "x-delegatus-mcp-unattributed": "1" })).rejects.toThrow();
  await expect(httpClient({ ...headers, "x-llv-spawn-capability": "unknown" })).rejects.toThrow();
  const client = await httpClient(headers);
  const previous = process.env.LLV_SPAWN_CAPABILITY;
  process.env.LLV_SPAWN_CAPABILITY = alice.capability;
  try {
    expect(payloadOf(await client.callTool({ name: "list_tasks", arguments: { ids: ["absent"] } }))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "compatibility-unidentified"))).toMatchObject({ ok: false, code: "caller_unidentified" });
    expect(deliveries).toHaveLength(0);
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.LLV_SPAWN_CAPABILITY;
    else process.env.LLV_SPAWN_CAPABILITY = previous;
  }
});

async function inMemoryAgentClient() {
  process.env.LLV_SPAWN_CAPABILITY = alice.capability;
  const store = new SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "reconnect-receipts.sqlite"));
  const service = createMcpToolService(viewerMcpBindings(), store, viewerMcpToolPolicy(), {
    recovery: viewerMcpRecoverableTools(),
  });
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "control-reconnect-regression", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server, store, service };
}

test("the first MCP send after an idle connection closes reaches either target exactly once", async () => {
  const { client, server } = await inMemoryAgentClient();
  try {
    expect(payloadOf(await send(client, "idle-warm"))).toMatchObject({ ok: true });
    // Close every pooled HTTP connection while the MCP session stays alive.
    await listener!.stop(true);
    listener = serveViewer(port);
    expect(payloadOf(await send(client, "idle-target"))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "idle-sibling", alice))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "idle-target"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries.map(delivery => delivery.clientMessageId)).toEqual([
      sendDownstreamKey("idle-warm"), sendDownstreamKey("idle-target"), sendDownstreamKey("idle-sibling"),
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
});

test("an MCP send survives a refused connection during a brief Viewer restart", async () => {
  const { client, server } = await inMemoryAgentClient();
  let restarted: Promise<void> = Promise.resolve();
  try {
    expect(payloadOf(await send(client, "restart-warm"))).toMatchObject({ ok: true });
    await listener!.stop(true);
    restarted = Bun.sleep(250).then(() => { listener = serveViewer(port); });
    const result = payloadOf(await send(client, "restart-first-send"));
    expect(result).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "restart-first-send"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries.map(delivery => delivery.clientMessageId)).toEqual([
      sendDownstreamKey("restart-warm"), sendDownstreamKey("restart-first-send"),
    ]);
  } finally {
    await restarted;
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
});

test("an exhausted reconnect leaves the original MCP send key available for retry", async () => {
  const { client, server, store } = await inMemoryAgentClient();
  try {
    expect(payloadOf(await send(client, "outage-warm"))).toMatchObject({ ok: true });
    await listener!.stop(true);
    listener = null;
    const result = payloadOf(await send(client, "outage-send"));
    expect(result).toMatchObject({
      ok: false, retryable: true,
      error: expect.stringContaining(origin),
      details: { outcome: "not-executed", nextAction: "retry-same-key", endpoint: origin, lastResponseAgeMs: expect.any(Number) },
    });
    expect(await store.lookup("send_message:outage-send")).toBeNull();
    expect(deliveries).toHaveLength(1);
    listener = serveViewer(port);
    expect(payloadOf(await send(client, "outage-send"))).toMatchObject({ ok: true, replayed: false });
    expect(payloadOf(await send(client, "outage-send"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries.map(delivery => delivery.clientMessageId)).toEqual([
      sendDownstreamKey("outage-warm"), sendDownstreamKey("outage-send"),
    ]);
  } finally {
    if (!listener) listener = serveViewer(port);
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
}, 15_000);

test("a send with a lost acceptance answer keeps its original claim and never reconnects by resending", async () => {
  const { client, server, store } = await inMemoryAgentClient();
  try {
    loseNextDeliveryAnswer = true;
    expect(payloadOf(await send(client, "lost-delivery-answer"))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(await store.lookup("send_message:lost-delivery-answer")).toMatchObject({ stage: "dispatching" });
    expect(payloadOf(await send(client, "lost-delivery-answer"))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(payloadOf(await client.callTool({ name: "send_message", arguments: {
      clientRequestId: "lost-delivery-answer", conversationId: bob.conversationId, text: "hello over http", recoveryOnly: true,
    } }))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(payloadOf(await client.callTool({ name: "send_message", arguments: {
      clientRequestId: "lost-delivery-answer", conversationId: bob.conversationId, text: "changed",
    } }))).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(deliveries).toEqual([{ capability: alice.capability, clientMessageId: sendDownstreamKey("lost-delivery-answer") }]);
  } finally {
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
});

test("cancellation during a refused-connection backoff releases the unadmitted send", async () => {
  const { client, server, store, service } = await inMemoryAgentClient();
  const args = { clientRequestId: "cancel-refused-send", conversationId: bob.conversationId, text: "cancel before sending" };
  try {
    await listener!.stop(true);
    listener = null;
    const controller = new AbortController();
    const cancelled = service.callTool("send_message", args, { signal: controller.signal, deadlineAt: Date.now() + 2_000 });
    const timer = setTimeout(() => controller.abort(new Error("fixture cancellation")), 25);
    const result = await cancelled.finally(() => clearTimeout(timer));
    expect(result).toMatchObject({ ok: false, details: { outcome: "not-executed", nextAction: "retry-same-key" } });
    expect(await store.lookup("send_message:cancel-refused-send")).toBeNull();
    expect(deliveries).toHaveLength(0);
    listener = serveViewer(port);
    expect(await service.callTool("send_message", args)).toMatchObject({ ok: true, replayed: false });
    expect(deliveries).toEqual([{ capability: alice.capability, clientMessageId: sendDownstreamKey("cancel-refused-send") }]);
  } finally {
    if (!listener) listener = serveViewer(port);
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
});

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
    expect(overHttp.tools.map(tool => tool.name)).not.toContain("suggest_replies");
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

  for (const name of ["codex-mcp-client", "claude-code"]) {
    expect((await rawPost({ "user-agent": `${name}/fixture` })).status).toBe(403);
    expect((await rawPost({ "user-agent": `${name}/fixture`, "x-llv-spawn-capability": "not-a-capability" })).status).toBe(403);
  }

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

test("both HTTP migration hosts can call tools before commit and a discard withdraws only the successor", async () => {
  agentRegistry().settleSpawn(alice.launchId, {
    key: { engine: "claude", sessionId: crypto.randomUUID() }, artifactPath: path.join(sandbox, "handover.jsonl"),
    cwd: sandbox, accountId: "source", status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  const predecessor = await agentClient(alice);
  const pending = agentRegistry().stageSpawnCapabilityForConversation(alice.conversationId, "http-handover")!;
  const successor = await agentClient({ ...alice, capability: pending.capability });
  try {
    expect(payloadOf(await send(predecessor, "http-handover-predecessor"))).toMatchObject({ ok: true });
    expect(payloadOf(await send(successor, "http-handover-successor"))).toMatchObject({ ok: true });
    agentRegistry().discardSpawnCapabilityForOperation("http-handover");
    await expect(send(successor, "http-handover-discarded")).rejects.toThrow();
    expect(payloadOf(await send(predecessor, "http-handover-after-discard"))).toMatchObject({ ok: true });
    expect(deliveries.map(row => row.capability)).toEqual([alice.capability, pending.capability, alice.capability]);
  } finally {
    agentRegistry().discardSpawnCapabilityForOperation("http-handover");
    await Promise.all([predecessor.close(), successor.close()]);
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
