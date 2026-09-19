import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";
import type { McpToolResult } from "./server";

// No inherited release, capability, provider home or runtime socket is usable.
const originalEnv = { ...process.env };
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mca-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LLV_") || key.startsWith("NEXT_PUBLIC_")) delete process.env[key];
}
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";

const { agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { applyConversationAction } = await import("@/lib/conversation/actions");
const { callerConversationId } = await import("@/lib/agent/operatorAuthority");
const { dispatchStructuredControl } = await import("@/lib/runtime/structuredControls");
const { ClaudeStreamBrokerHost } = await import("@/lib/runtime/claudeStreamBrokerHost");
const { FileRuntimeEventStore } = await import("@/lib/runtime/eventStore");
const { bindStructuredDeliveryQueue, releaseStructuredDeliveryHost } = await import("@/lib/runtime/structuredDeliveryController");
const { kickStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliverySignal");
const { RuntimeHost } = await import("@/runtime-host/host");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { serveRuntimeHost } = await import("@/runtime-host/socket");
const { testEndpoint } = await import("@/runtime-host/fixtures/testEndpoint");
const { UnixRuntimeHostClient, runtimeHostClient } = await import("@/lib/runtime/client");
const { POST } = await import("@/app/api/conversation-host/route");
const { setConversationHostDependenciesForTests } = await import("@/app/api/conversation-host/dependencies");
const { viewerMcpBindings, productionViewerControlDependencies } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } = await import("./server");

afterAll(() => {
  setAgentRegistryForTests(null);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("conversation control did not settle");
}

test.each(["kill", "interrupt"])("MCP %s reaches a live structured host through the Viewer without an agent runtime socket", async (firstAction) => {
  const registry = agentRegistry();
  const caller = registry.beginSpawn("claude", sandbox, { cwd: sandbox, title: "Conversation control caller" });
  process.env.LLV_SPAWN_CAPABILITY = registry.rotateSpawnCapabilityForReceipt(caller.launchId);
  const target = registry.beginSpawnRequest({ engine: "claude", cwd: sandbox, transport: "structured", launchProfile: { title: "Conversation control target" } });
  if (target.kind !== "created") throw new Error("fixture target was not created");
  const journal = new RuntimeJournal(path.join(sandbox, `${firstAction}-runtime.sqlite`), { structuredHosts: true });
  const socketPath = testEndpoint(sandbox, "runtime");
  const socket = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  if (!socket.listening) await once(socket, "listening");
  const runtimeClient = new UnixRuntimeHostClient(socketPath);
  let child: ChildProcessWithoutNullStreams | undefined;
  let childExited = false;
  const protocolLog = path.join(sandbox, "provider-input.ndjson");
  // Only the provider CLI is simulated. The broker, controller, runtime journal,
  // socket transport, HTTP route, MCP bindings, service and protocol are real.
  const provider = `
    const { createInterface } = require("node:readline");
    const fs = require("node:fs");
    const output = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
    createInterface({ input: process.stdin }).on("line", line => {
      const frame = JSON.parse(line);
      fs.appendFileSync(process.argv[1], line + "\\n");
      if (frame.type === "user") {
        if (frame.message.content[0].text === "/compact") output({ type: "system", subtype: "compact_boundary", session_id: frame.session_id });
        else output({ ...frame, isReplay: true, uuid: "fixture-user" });
      }
      if (frame.type === "control_request" && frame.request.subtype === "interrupt") {
        output({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
        output({ type: "result", subtype: "error_during_execution" });
      }
    });
  `;
  const host = await ClaudeStreamBrokerHost.start({
    cwd: sandbox,
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    readTranscript: () => [],
    eventStore: new FileRuntimeEventStore(path.join(sandbox, "events")),
    spawnProcess: () => {
      child = spawn(process.execPath, ["-e", provider, protocolLog], { cwd: sandbox, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      child.once("exit", () => { childExited = true; });
      return child;
    },
    // Signal only the child this test started, never a process group or a lookup.
    signalProcess: (pid, signal) => {
      if (!child || pid !== child.pid) throw new Error("refusing to signal an unowned process");
      child.kill(signal);
    },
  });
  const key = { engine: "claude" as const, sessionId: host.identity.sessionId };
  const transcriptPath = path.join(sandbox, `${key.sessionId}.jsonl`);
  const health = await host.health();
  registry.settleSpawn(target.receipt.launchId, {
    key, artifactPath: transcriptPath, cwd: sandbox, accountId: null, status: "live", host: null,
    structuredHost: {
      kind: "claude-broker", endpoint: health.endpoint!,
      process: { pid: child!.pid!, startIdentity: health.processStartIdentity },
      eventCursor: health.eventCursor, protocolVersion: health.protocolVersion,
      writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [],
    },
    claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null,
  });
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client: runtimeClient });
  // This closure is the Viewer's runtime connection. MCP still sees no socket.
  setConversationHostDependenciesForTests({
    applyConversationAction: request => applyConversationAction(request, {
      registry: () => registry,
      structuredEnabled: () => true,
      dispatchStructuredControl: request => dispatchStructuredControl(request, { registry, client: runtimeClient }),
      interruptConversation: async () => { throw new Error("unexpected legacy interrupt"); },
      killConversation: async () => { throw new Error("unexpected legacy kill"); },
      resumeConversation: async () => { throw new Error("unexpected legacy resume"); },
      compactConversation: async () => { throw new Error("unexpected legacy compact"); },
      answerDialogKey: async () => { throw new Error("unexpected legacy dialog"); },
    }),
  });
  const requests: Array<{ body: Record<string, unknown>; caller: string | null }> = [];
  const viewer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/conversation-host");
    const req = new NextRequest(request);
    requests.push({ body: await request.clone().json() as Record<string, unknown>, caller: callerConversationId(req) });
    return POST(req);
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${viewer.port}`;
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, `${firstAction}-mcp.sqlite`));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true)), receipts));
  const client = new Client({ name: "conversation-control-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const call = async (action: string) => (await client.callTool({ name: "conversation_action", arguments: {
    clientRequestId: `control-${action}`, conversationId: target.receipt.conversationId, action,
    // Caller claims must not replace the capability's server-attributed identity.
    callerConversationId: target.receipt.conversationId, actor: { kind: "operator" },
  } })).structuredContent as { ok: boolean; error?: string; operationId: string };
  try {
    expect(runtimeHostClient()).toBeNull();
    expect(childExited).toBe(false);
    await host.send({ id: "running-turn", text: "Hold this turn open" });
    expect((await host.health()).activeTurnRef).toBe("running-turn");
    if (firstAction === "interrupt") {
      expect(await call("resume")).toMatchObject({ ok: true, outcome: "resumed", spawned: false });
      expect(await call("dialog-key")).toMatchObject({ ok: false, error: "structured host does not support the dialog-key control" });
      const interrupted = await call("interrupt");
      expect(interrupted).toMatchObject({ ok: true });
      expect(interrupted.error).not.toBe("structured runtime host is unavailable");
      await eventually(() => journal.operationResult(interrupted.operationId)?.receipt.status === "interrupted");
      await eventually(async () => (await host.health()).activeTurnRef === null);
      expect(fs.readFileSync(protocolLog, "utf8")).toContain('"subtype":"interrupt"');
      expect(childExited).toBe(false);
      const compacted = await call("compact");
      expect(compacted).toMatchObject({ ok: true });
      await eventually(() => journal.operationResult(compacted.operationId)?.receipt.status === "delivered");
      expect(fs.readFileSync(protocolLog, "utf8")).toContain('"text":"/compact"');
    }
    const killed = await call("kill");
    expect(killed).toMatchObject({ ok: true });
    expect(killed.error).not.toBe("structured runtime host is unavailable");
    await eventually(() => childExited);
    await eventually(() => journal.operationResult(killed.operationId)?.receipt.status === "delivered");
    expect(registry.readOnlySnapshot().entries[`claude:${key.sessionId}`]?.status).toBe("dead");
    expect(requests.map(request => request.body.action)).toEqual(firstAction === "interrupt" ? ["resume", "dialog-key", "interrupt", "compact", "kill"] : ["kill"]);
    expect(requests.every(request => request.caller === caller.conversationId)).toBe(true);
    expect(requests.every(request => request.body.actor === undefined && request.body.callerConversationId === undefined)).toBe(true);
    expect(runtimeHostClient()).toBeNull();
  } finally {
    await client.close();
    await server.close();
    receipts.close();
    viewer.stop(true);
    setConversationHostDependenciesForTests(null);
    await releaseStructuredDeliveryHost(key);
    await kickStructuredDeliveryQueue();
    await bindStructuredDeliveryQueue([], { registry, client: null });
    await host.release();
    await new Promise<void>(resolve => socket.close(() => resolve()));
    journal.close();
  }
}, 20_000);

test.each(["kill", "interrupt", "resume", "compact", "dialog-key"])("MCP %s preserves an unknown timeout outcome without repeating the control", async (action) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const received = new Promise<void>(resolve => { entered = resolve; });
  let effects = 0;
  const operations: string[] = [];
  setConversationHostDependenciesForTests({
    applyConversationAction: async request => {
      operations.push(request.operationId!);
      entered();
      await delayed;
      effects++;
      return { status: 200, body: { ok: true, structured: true, target: "conversation_timeout_target", outcome: "delivered" } };
    },
  });
  const viewer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${viewer.port}`;
  const receiptPath = path.join(sandbox, `timeout-${action}.sqlite`);
  let receipts = new SqliteMcpReceiptStore(receiptPath);
  const bindings = viewerMcpBindings(undefined, productionViewerControlDependencies(true));
  let service = createMcpToolService(bindings, receipts);
  const deadline = new AbortController();
  let callSignal: AbortSignal | undefined = deadline.signal;
  const server = createViewerMcpServer({
    callTool: (name, args, context) => service.callTool(name, args, { ...context, signal: callSignal ?? context?.signal }),
  });
  const client = new Client({ name: "conversation-timeout-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const args = { clientRequestId: `timeout-${action}`, conversationId: "conversation_timeout_target", action };
  const call = async () => (await client.callTool({ name: "conversation_action", arguments: args })).structuredContent as McpToolResult;
  try {
    const pending = call();
    await received;
    // End the hop only once the actual HTTP handler has received the request.
    deadline.abort(new Error("test dispatch deadline"));
    const first = await pending;
    callSignal = undefined;
    expect(effects).toBe(0);
    expect(first).toMatchObject({
      ok: false, code: "outcome_unknown", retryable: false, clientRequestId: args.clientRequestId,
      details: { outcome: "unknown", nextAction: "original-key-lookup", operationId: operations[0] },
    });
    expect(JSON.stringify(first)).toContain("same clientRequestId");
    expect(operations[0]).toMatch(/^mcp_conversation_action_[0-9a-f]{24}$/);
    expect(await call()).toEqual({ ...first, replayed: true });
    release();
    await eventually(() => effects === 1);
    // Reopen the durable store to prove replay survives an MCP restart.
    receipts.close();
    receipts = new SqliteMcpReceiptStore(receiptPath);
    service = createMcpToolService(bindings, receipts);
    expect(await call()).toEqual({ ...first, replayed: true });
    expect(operations).toHaveLength(1);
    expect(effects).toBe(1);
  } finally {
    release();
    await client.close();
    await server.close();
    viewer.stop(true);
    receipts.close();
    setConversationHostDependenciesForTests(null);
  }
});
