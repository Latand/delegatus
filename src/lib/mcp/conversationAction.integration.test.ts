import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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

const { captureProcessIdentity } = await import("@/lib/processIdentity");
const { AgentRegistry, agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { applyConversationAction } = await import("@/lib/conversation/actions");
const { callerConversationId } = await import("@/lib/agent/operatorAuthority");
const { dispatchStructuredControl } = await import("@/lib/runtime/structuredControls");
const { ClaudeStreamBrokerHost } = await import("@/lib/runtime/claudeStreamBrokerHost");
const { bindClaudeHostPersistence, flushStructuredHostPersistence } = await import("@/lib/runtime/registry");
const { pendingQuestionFor } = await import("@/lib/scanner/questions");
const { FileRuntimeEventStore } = await import("@/lib/runtime/eventStore");
const { bindStructuredDeliveryQueue, releaseStructuredDeliveryHost } = await import("@/lib/runtime/structuredDeliveryController");
const { kickStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliverySignal");
const { RuntimeHost } = await import("@/runtime-host/host");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { CONTROL_SETTLEMENT_WINDOW_MS } = await import("@/lib/runtime/structuredDeliveryQueue");
const { advanceConversationMigration } = await import("@/lib/accounts/migration/coordinator");
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

test.each(["kill", "interrupt", "answer", "kill-after-migration", "kill-after-writer-contention", "migration-retires-writer"])("MCP %s reaches a live structured host through the Viewer without an agent runtime socket", async (firstAction) => {
  const retireWriter = firstAction === "migration-retires-writer";
  const migrated = retireWriter || firstAction.startsWith("kill-after-");
  const contended = firstAction === "kill-after-writer-contention";
  const fixtureSessionId = ["11111111", "1111", "4111", "8111",
    retireWriter ? "000000000003" : contended ? "000000000002" : "000000000001"].join("-");
  const registryPath = path.join(sandbox, `${firstAction}-registry.sqlite`);
  const registry = migrated ? new AgentRegistry(path.join(sandbox, `${firstAction}-registry.json`), undefined, undefined,
    { sqliteMode: "sqlite", sqliteFilename: registryPath, sqliteWriterDeadlineMs: 150 }) : agentRegistry();
  if (migrated) setAgentRegistryForTests(registry);
  const caller = registry.beginSpawn("claude", sandbox, { cwd: sandbox, title: "Conversation control caller" });
  process.env.LLV_SPAWN_CAPABILITY = registry.rotateSpawnCapabilityForReceipt(caller.launchId);
  const target = registry.beginSpawnRequest({ engine: "claude", cwd: sandbox, transport: "structured",
    ...(migrated ? { accountId: "account-a" } : {}), launchProfile: { title: "Conversation control target" } });
  if (target.kind !== "created") throw new Error("fixture target was not created");
  const journal = new RuntimeJournal(path.join(sandbox, `${firstAction}-runtime.sqlite`), { structuredHosts: true });
  const socketPath = testEndpoint(sandbox, "runtime");
  const socket = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  if (!socket.listening) await once(socket, "listening");
  const runtimeClient = new UnixRuntimeHostClient(socketPath);
  let child: ChildProcessWithoutNullStreams | undefined;
  let childExited = false;
  const protocolLog = path.join(sandbox, `${firstAction}-provider-input.ndjson`);
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
        else {
          output({ ...frame, isReplay: true, uuid: "fixture-user" });
          if (process.argv[2] === "answer") output({ type: "control_request", request_id: "host-question", request: {
            subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "toolu_question",
            input: { questions: [{ question: "Which scope?", multiSelect: false, options: [{ label: "All" }, { label: "Small (Recommended)" }] }] }
          } });
        }
      }
      if (frame.type === "control_response" && frame.response.request_id === "host-question") {
        output({ type: "control_response", response: { subtype: "success", request_id: "host-question" } });
        output({ type: "result", subtype: "success", result: "Answered" });
      }
      if (frame.type === "control_request" && frame.request.subtype === "interrupt") {
        output({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
        output({ type: "result", subtype: "error_during_execution" });
      }
    });
  `;
  const host = await ClaudeStreamBrokerHost.start({
    cwd: sandbox,
    ...(migrated ? { sessionId: fixtureSessionId } : {}),
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    readTranscript: () => [],
    eventStore: new FileRuntimeEventStore(path.join(sandbox, "events")),
    spawnProcess: () => {
      child = spawn(process.execPath, ["-e", provider, protocolLog, firstAction], { cwd: sandbox, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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
  const transcriptPath = path.join(process.env.LLV_CLAUDE_HOME!, "projects", "-repo", `${key.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, "{}\n");
  const health = await host.health();
  registry.settleSpawn(target.receipt.launchId, {
    key, artifactPath: transcriptPath, cwd: sandbox, accountId: migrated ? "account-a" : null, status: "live", host: null,
    structuredHost: {
      kind: "claude-broker", endpoint: health.endpoint!,
      process: captureProcessIdentity(child!.pid!),
      eventCursor: health.eventCursor, protocolVersion: health.protocolVersion,
      writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [],
    },
    claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null,
  });
  const stopPersistence = firstAction === "answer"
    ? await bindClaudeHostPersistence(registry, key, host, "structured-host:fixture", 1)
    : async () => {};
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client: runtimeClient });
  // This closure is the Viewer's runtime connection. MCP still sees no socket.
  setConversationHostDependenciesForTests({
    applyConversationAction: request => applyConversationAction(request, {
      registry: () => registry,
      structuredEnabled: () => true,
      dispatchStructuredControl: request => dispatchStructuredControl(request, { registry, client: runtimeClient }),
      resumeConversation: async () => { throw new Error("unexpected legacy resume"); },
      // The simulated provider is not a native CLI in process discovery. Read
      // its real transcript with the process identity this fixture owns.
      pendingQuestion: async pathname => {
        const stat = fs.statSync(pathname);
        return pendingQuestionFor({ root: "claude-projects", path: pathname, size: stat.size,
          mtime: stat.mtimeMs / 1000, proc: "running", pid: child!.pid! } as import("@/lib/types").FileEntry);
      },
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
  let answerRequestId = "toolu_stale";
  const call = async (action: string, clientRequestId = `control-${action}`) => (await client.callTool({ name: "conversation_action", arguments: {
    clientRequestId, conversationId: target.receipt.conversationId, action,
    // Caller claims must not replace the capability's server-attributed identity.
    callerConversationId: target.receipt.conversationId, actor: { kind: "operator" },
    ...(action === "answer" ? { requestId: answerRequestId, answers: [1] } : {}),
  } })).structuredContent as { ok: boolean; error?: string; operationId: string; receipt?: { status: string } };
  let writer: Database | undefined;
  let writerHeld = false;
  let successorKey: typeof key | undefined;
  try {
    expect(runtimeHostClient()).toBeNull();
    expect(childExited).toBe(false);
    await host.send({ id: "running-turn", text: "Hold this turn open" });
    expect((await host.health()).activeTurnRef).toBe("running-turn");
    if (migrated) {
      const id = target.receipt.conversationId;
      const successorId = "fixture-successor";
      successorKey = { engine: "claude", sessionId: successorId };
      const successorPath = path.join(sandbox, `${firstAction}-successor.jsonl`);
      fs.writeFileSync(successorPath, "{}\n");
      const successor = spawn(process.execPath, ["-e", "process.stdin.resume()"], { cwd: sandbox, stdio: "pipe" });
      const exited = once(successor, "exit");
      const successorProcess = captureProcessIdentity(successor.pid!);
      successor.stdin.end();
      expect(await exited).toEqual([0, null]);
      registry.upsert({ key: successorKey, artifactPath: successorPath, cwd: sandbox, accountId: "account-b",
        status: "dead", host: null, structuredHost: {
          ...registry.hostEntry(key)!.structuredHost!, process: successorProcess,
        }, claimEpoch: 1, claimOwner: null, pendingAction: null });
      const requested = registry.requestConversationReseat(id, "account-b").migration!;
      registry.transitionConversationMigration(id, requested.revision, [requested.phase], { phase: "successor-starting" });
      const providerReceipt = { operationId: requested.operationId, nativeId: successorId, path: successorPath,
        continuityPaths: [], historyHash: "fixture-history",
        host: { kind: "claude-fork" as const, identity: successorId, epoch: 1, verifiedAt: "2026-11-26T22:15:00.000Z" } };
      registry.persistMigrationProviderReceipt(id, requested.revision, requested.operationId, providerReceipt);
      const committed = registry.commitSuccessor(id, { id: successorId, path: successorPath, accountId: "account-b" },
        requested.revision, requested.operationId, providerReceipt);
      expect(committed.generations.map(generation => generation.id)).toEqual([key.sessionId, successorId]);
      expect(childExited).toBe(false);
      if (retireWriter) {
        const predecessor = registry.hostEntry(key)!;
        expect(predecessor.structuredHost?.process).toMatchObject({ pid: child!.pid });
        expect(registry.ownsStructuredHostClaim(key, "structured-host:fixture", 1)).toBe(false);
        expect(registry.setStructuredHostClaimed(key, predecessor.structuredHost!, "live", "structured-host:fixture", 1)).toBeNull();
        await advanceConversationMigration(id, registry, undefined, { deferBoardRepair: true });
        await eventually(() => childExited);
        expect(registry.hostEntry(key)).toMatchObject({ status: "dead", claimOwner: null, structuredHost: null });
        expect(registry.hostEntry(successorKey)?.structuredHost?.process).toEqual(successorProcess);
        return;
      }
      if (contended) {
        writer = new Database(registryPath, { strict: true });
        writer.exec("BEGIN IMMEDIATE");
        writerHeld = true;
      }
    }
    if (firstAction === "answer") {
      await eventually(async () => (await host.health()).pendingQuestions?.length === 1);
      fs.writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", timestamp: "2026-09-30T05:15:00.000Z",
        sessionId: key.sessionId, cwd: sandbox, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_question",
          name: "AskUserQuestion", input: { questions: [{ question: "Which scope?", header: "Scope", multiSelect: false,
            options: [{ label: "All", description: "" }, { label: "Small (Recommended)", description: "" }] }] } }] } }) + "\n");
      await flushStructuredHostPersistence(host);
      expect(registry.readOnlySnapshot().entries[`claude:${key.sessionId}`]?.structuredHost?.pendingQuestions)
        .toMatchObject([{ toolUseId: "toolu_question", questions: [{ prompt: "Which scope?", options: ["Small (Recommended)", "All"] }] }]);
      const activity = (await client.callTool({ name: "agent_activity", arguments: {
        clientRequestId: "waiting-question", conversationId: target.receipt.conversationId,
      } })).structuredContent as { conversations: Array<{ reason: string; lifecycle: string; question: { toolUseId: string; since: string } }> };
      expect(activity.conversations).toMatchObject([{ lifecycle: "waiting", reason: "question",
        question: { toolUseId: "toolu_question", questions: [{ prompt: "Which scope?", options: ["Small (Recommended)", "All"] }] } }]);
      expect(Number.isFinite(Date.parse(activity.conversations[0]!.question.since))).toBe(true);
      expect(await call("answer", "control-stale-answer")).toMatchObject({ ok: false });
      expect((await host.health()).pendingQuestions).toHaveLength(1);
      expect((await host.health()).activeTurnRef).toBe("running-turn");
      answerRequestId = activity.conversations[0]!.question.toolUseId;
      const answered = await call("answer");
      expect(answered).toMatchObject({ ok: true });
      await eventually(() => journal.operationResult(answered.operationId)?.receipt.status === "answered");
      await eventually(async () => (await host.health()).activeTurnRef === null);
      expect((await host.health()).pendingQuestions).toEqual([]);
      const frames = fs.readFileSync(protocolLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(frames.filter(frame => frame.type === "control_response")).toMatchObject([{
        response: { request_id: "host-question", response: { behavior: "allow", updatedInput: { answers: { "Which scope?": "Small" } } } },
      }]);
      expect(childExited).toBe(false);
      await stopPersistence();
    }
    if (firstAction === "interrupt") {
      expect(await call("resume")).toMatchObject({ ok: true, outcome: "resumed", spawned: false });
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
    if (contended) {
      expect(killed.receipt?.status).toBe("queued");
      await eventually(async () => {
        const receipt = (await runtimeClient.operationStatus(killed.operationId))?.receipt;
        return receipt?.status === "queued" && receipt.reason?.includes("write lock is held") === true;
      });
      expect(childExited).toBe(false);
      writer!.exec("ROLLBACK");
      writerHeld = false;
    }
    await eventually(async () => (await runtimeClient.operationStatus(killed.operationId))?.receipt.status === "delivered");
    expect(childExited).toBe(true);
    if (migrated) {
      const receipt = (await runtimeClient.operationStatus(killed.operationId))!.receipt;
      expect(receipt.operationId).toBe(killed.operationId);
      expect(Date.parse(receipt.at) - Date.parse(receipt.admittedAt!)).toBeLessThan(CONTROL_SETTLEMENT_WINDOW_MS);
      expect(registry.hostEntry(successorKey!)?.status).toBe("dead");
    }
    expect(registry.readOnlySnapshot().entries[`claude:${key.sessionId}`]?.status).toBe("dead");
    expect(requests.map(request => request.body.action)).toEqual(firstAction === "interrupt" ? ["resume", "interrupt", "compact", "kill"] : firstAction === "answer" ? ["answer", "answer", "kill"] : ["kill"]);
    expect(requests.every(request => request.caller === caller.conversationId)).toBe(true);
    expect(requests.every(request => request.body.actor === undefined && request.body.callerConversationId === undefined)).toBe(true);
    expect(runtimeHostClient()).toBeNull();
  } finally {
    if (writerHeld) writer?.exec("ROLLBACK");
    writer?.close();
    await client.close();
    await server.close();
    receipts.close();
    viewer.stop(true);
    setConversationHostDependenciesForTests(null);
    await stopPersistence();
    await releaseStructuredDeliveryHost(key);
    await kickStructuredDeliveryQueue();
    await bindStructuredDeliveryQueue([], { registry, client: null });
    await host.release();
    await new Promise<void>(resolve => socket.close(() => resolve()));
    journal.close();
    if (migrated) {
      setAgentRegistryForTests(null);
      registry.close();
    }
  }
}, 20_000);

test.each(["kill", "interrupt", "resume", "compact"])("MCP %s preserves an unknown timeout outcome without repeating the control", async (action) => {
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
