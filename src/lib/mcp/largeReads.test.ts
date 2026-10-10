import { afterEach, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NextRequest } from "next/server";
import { createMcpToolService, createProductionViewerMcpService, SqliteMcpReceiptStore, type McpToolBindings, type McpToolCallContext } from "./server";
import { handleMcpHttpRequest, setMcpHttpDependenciesForTests } from "./http";
import { currentMcpHttpCaller } from "./callerContext";

const original = { ...process.env };
const listeners: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  setMcpHttpDependenciesForTests(null);
  for (const listener of listeners.splice(0)) listener.stop(true);
  for (const key of ["LLV_SPAWN_CAPABILITY", "LLV_VIEWER_CONTROL_URL", "LLV_VIEWER_CONTROL_TOKEN"]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

test("the production HTTP boundary owns read replay and checks capability revocation on every call", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-large-read-receipts-"));
  const receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
  let calls = 0, admitted = true;
  const upstream = createMcpToolService({ resources: async () => {
    expect(currentMcpHttpCaller()?.capability).toBe("a".repeat(43));
    return { sequence: ++calls, payload: "fixture ".repeat(100_000) };
  } } as unknown as McpToolBindings, receipts);
  setMcpHttpDependenciesForTests({ service: async () => upstream, conversationForCapability: () => admitted ? "conversation_fixture" : null });
  fixture(async request => handleMcpHttpRequest(new NextRequest(request)));
  try {
    const service = await createProductionViewerMcpService(false, true);
    const args = { clientRequestId: "large-replay", full: true };
    const first = await service.callTool("resources", args);
    expect(first).toMatchObject({ ok: true, sequence: 1, replayed: false });
    expect(await service.callTool("resources", args)).toEqual({ ...first, replayed: true });
    expect(calls).toBe(1);
    admitted = false;
    expect(await service.callTool("resources", args)).toMatchObject({ ok: false, error: expect.stringContaining("403") });
  } finally { receipts.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

function fixture(handler: (request: Request) => Promise<Response>) {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  listeners.push(listener);
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${listener.port}`;
  process.env.LLV_SPAWN_CAPABILITY = "a".repeat(43);
  process.env.LLV_VIEWER_CONTROL_TOKEN = "fixture-control-key";
}

test("stdio large reads run in the Viewer and preserve its receipt and native work envelope", async () => {
  const calls: Array<Record<string, unknown>> = [];
  fixture(async request => {
    expect(new URL(request.url).pathname).toBe("/api/mcp");
    expect(request.headers.get("x-llv-spawn-capability")).toBe("a".repeat(43));
    expect(request.headers.get("authorization")).toBe("Bearer fixture-control-key");
    const body = await request.json() as { id: string; params: Record<string, unknown> };
    calls.push(body.params);
    const name = body.params.name;
    return Response.json({ jsonrpc: "2.0", id: body.id, result: {
      content: [], structuredContent: { ok: true, toolName: name, clientRequestId: "read-key", replayed: true, marker: "Viewer answer" },
    } });
  });
  const service = await createProductionViewerMcpService(false, true);
  const nativeWork = { threadId: "fixture-thread", turnId: "fixture-turn", turnTrigger: "realtime", callId: "fixture-call", itemId: "fixture-item" };
  for (const name of ["conversation_messages", "resources", "operator_snapshot", "board_snapshot"] as const) {
    expect(await service.callTool(name, { clientRequestId: "read-key", full: true }, { nativeWork }))
      .toEqual({ ok: true, toolName: name, clientRequestId: "read-key", replayed: true, marker: "Viewer answer" });
  }
  expect(calls).toHaveLength(4);
  expect(calls[0]).toMatchObject({ name: "conversation_messages", arguments: { clientRequestId: "read-key", full: true }, _meta: {
    threadId: "fixture-thread", callId: "fixture-call", itemId: "fixture-item",
    "x-codex-turn-metadata": { thread_id: "fixture-thread", turn_id: "fixture-turn", turn_trigger: "realtime" },
  } });
});

test("a refused or malformed remote read never falls back to a local domain read", async () => {
  let status = 403;
  fixture(async () => status === 403
    ? Response.json({ error: { message: "capability revoked" } }, { status })
    : Response.json({ jsonrpc: "2.0", result: null }));
  const service = await createProductionViewerMcpService(false, true);
  expect(await service.callTool("conversation_messages", { conversationId: "local-only" })).toMatchObject({ ok: false, error: expect.stringContaining("403") });
  status = 200;
  expect(await service.callTool("conversation_messages", { conversationId: "local-only" })).toMatchObject({ ok: false, error: expect.stringContaining("malformed") });
});

test("cancelling a delegated read releases the request and the next read works", async () => {
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  fixture(async request => {
    const body = await request.json() as { id: string };
    if (++calls === 1) { reached(); await held; }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: {
      ok: true, toolName: "resources", clientRequestId: null, replayed: false,
    }, content: [] } });
  });
  const service = await createProductionViewerMcpService(false, true);
  const controller = new AbortController();
  const context: McpToolCallContext = { signal: controller.signal, deadlineAt: Date.now() + 5_000 };
  const call = service.callTool("resources", {}, context);
  try {
    expect(await Promise.race([started.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true);
    controller.abort(new Error("fixture cancelled"));
    const result = await Promise.race([call, Bun.sleep(1_000).then(() => null)]);
    expect(result).toMatchObject({ ok: false });
    expect(await service.callTool("resources", {})).toMatchObject({ ok: true });
  } finally { release(); await call; }
});
