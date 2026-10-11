import { afterAll, beforeAll, expect, test } from "bun:test";
import crypto from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/mcp/route";
import { mcpHttpMethodNotAllowed, setMcpHttpDependenciesForTests } from "./http";
import type { McpToolCallContext, McpToolService } from "./server";

const capability = crypto.randomBytes(32).toString("base64url");
const active = new Map<string, { signal: AbortSignal; finish: () => void }>();
const messages: Array<{ session: string | null; body: Record<string, unknown> }> = [];
let listener: ReturnType<typeof Bun.serve>;
let origin: string;
let finishing = false;

const service: McpToolService = {
  async callTool(toolName, args, context?: McpToolCallContext) {
    if (toolName !== "list_tasks") throw new Error("unexpected fixture tool");
    const key = String(args.clientRequestId);
    await new Promise<void>((resolve) => {
      active.set(key, { signal: context!.signal!, finish: resolve });
      if (finishing) { resolve(); return; }
      context!.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    return { ok: true, toolName, clientRequestId: key, replayed: false, data: {} };
  },
};

beforeAll(() => {
  setMcpHttpDependenciesForTests({ service: async () => service, conversationForCapability: () => "conversation_fixture" });
  listener = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST") return mcpHttpMethodNotAllowed();
      const body = await request.text();
      messages.push({ session: request.headers.get("mcp-session-id"), body: JSON.parse(body) as Record<string, unknown> });
      return POST(new NextRequest(request.url, { method: "POST", headers: request.headers, body, signal: request.signal }));
    },
  });
  origin = `http://127.0.0.1:${listener.port}/api/mcp`;
});

afterAll(() => {
  setMcpHttpDependenciesForTests(null);
  listener.stop(true);
});

async function connect() {
  const client = new Client({ name: "codex-thread-fixture", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(origin), {
    requestInit: { headers: { "x-llv-spawn-capability": capability } },
  });
  await client.connect(transport);
  return { client, transport };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("Codex sibling connections with colliding ids cancel only their own call without cancel metadata", async () => {
  const [first, second] = await Promise.all([connect(), connect()]);
  const cancel = new AbortController();
  const calls: Promise<unknown>[] = [];
  try {
    const call = (client: Client, key: string, threadId: string, signal?: AbortSignal) => client.callTool({
      name: "list_tasks", arguments: { clientRequestId: key }, _meta: { threadId },
    }, undefined, { signal }).catch(error => error);
    calls.push(call(first.client, "thread-first", "thread-first", cancel.signal));
    await waitFor(() => active.has("thread-first"));
    calls.push(call(second.client, "thread-second", "thread-second"));
    await waitFor(() => active.has("thread-second"));
    const wireCalls = messages.filter(row => row.body.method === "tools/call");
    expect(wireCalls[0]!.body.id).toBe(wireCalls[1]!.body.id);
    cancel.abort();
    await waitFor(() => active.get("thread-first")!.signal.aborted || active.get("thread-second")!.signal.aborted);
    expect(active.get("thread-first")!.signal.aborted).toBe(true);
    expect(active.get("thread-second")!.signal.aborted).toBe(false);
    const notification = messages.find(row => row.body.method === "notifications/cancelled")!;
    expect(notification.body.params).not.toHaveProperty("_meta");
    expect(notification.session).toBe(first.transport.sessionId ?? null);
    expect(first.transport.sessionId).toBeTruthy();
    expect(second.transport.sessionId).not.toBe(first.transport.sessionId);
  } finally {
    finishing = true;
    for (const held of active.values()) held.finish();
    await Promise.all(calls);
    await Promise.all([first.client.close(), second.client.close()]);
    active.clear();
    messages.length = 0;
    finishing = false;
  }
});

test.each([true, false])("a duplicate active id is refused and cancellation preserves id types (connection header: %s)", async (withHeader) => {
  const { client, transport } = await connect();
  const calls: Promise<Response>[] = [];
  const post = (body: unknown) => fetch(origin, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "x-llv-spawn-capability": capability, ...(withHeader ? { "mcp-session-id": transport.sessionId! } : {}) },
    body: JSON.stringify(body),
  });
  try {
    calls.push(post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_tasks", arguments: { clientRequestId: "original" } } }));
    await waitFor(() => active.has("original"));
    calls.push(post({ jsonrpc: "2.0", id: "7", method: "tools/call", params: { name: "list_tasks", arguments: { clientRequestId: "string-id" } } }));
    await waitFor(() => active.has("string-id"));
    const duplicate = post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_tasks", arguments: { clientRequestId: "duplicate" } } });
    calls.push(duplicate);
    const status = await Promise.race([duplicate.then(response => response.status), Bun.sleep(2_000).then(() => 0)]);
    expect(status).toBe(409);
    expect(active.has("duplicate")).toBe(false);
    await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    await waitFor(() => active.get("original")!.signal.aborted);
    expect(active.get("string-id")!.signal.aborted).toBe(false);
    await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "7" } });
    await waitFor(() => active.get("string-id")!.signal.aborted);
  } finally {
    finishing = true;
    for (const held of active.values()) held.finish();
    await Promise.all(calls);
    await client.close();
    active.clear();
    messages.length = 0;
    finishing = false;
  }
});
