import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

// Isolate before importing any state-resolving module.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orchestrator-recovery-"));
const previous = { ...process.env };
for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", LLV_STATE_DIR: "state", CODEX_HOME: "codex", LLV_CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", TMPDIR: "tmp" })) {
  process.env[key] = path.join(root, dir);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
delete process.env.LLV_VIEWER_DEPLOY_TARGET;
const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const { viewerMcpBindings, viewerMcpRecoverableTools, productionViewerControlDependencies } = await import("./bindings");
const { createMcpToolService, SqliteMcpReceiptStore, FileMcpReceiptStore, MemoryMcpReceiptStore, McpDispatchUncertainError, McpDispatchNotExecutedError } = await import("./server");
import type { McpRequestBinding } from "./server";
import type { ViewerControlDependencies, ViewerMcpDomainDependencies } from "./bindings";

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  fs.rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(label: string) {
  const dir = path.join(root, label);
  fs.mkdirSync(dir);
  const registry = new AgentRegistry(path.join(dir, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  for (const name of ["first", "successor", "caller", "other"]) {
    const transcript = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(transcript, "{}\n");
    registry.reconcileConversations([{
      engine: "codex", path: transcript, accountId: "fixture-account",
      launchProfile: emptyLaunchProfile({ cwd: dir }),
      turn: { state: "busy", source: "assistant", terminalAt: null },
      observedAt: "2026-09-20T00:00:00.000Z",
    }]);
  }
  const conversations = Object.values(registry.readOnlySnapshot().conversations);
  const [first, successor, caller, other] = conversations;
  const project = `fixture-${label}`;
  let epoch = 0;
  function seat(conversation = first!) {
    const key = `seat-${label}-${++epoch}`;
    beginOrchestratorSeatIntent({ project, mandate: "fixture mandate", clientRequestId: key, mode: "spawn" });
    completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId: conversation.id, path: conversation.generations.at(-1)!.path });
  }
  let callerId = caller!.id;
  const domain = {
    registrySnapshot: () => registry.readOnlySnapshot(),
    attentionAuthority: () => ({ kind: "worker", conversationId: callerId }),
    callerAttribution: () => ({ kind: "worker", conversationId: callerId }),
    recoveryPredecessors: () => [],
    sendSettlementPorts: () => ({ registry, client: null }),
  } as unknown as ViewerMcpDomainDependencies;
  const file = path.join(dir, "receipts.sqlite");
  let receipts = new SqliteMcpReceiptStore(file);
  const service = (control: ViewerControlDependencies = productionViewerControlDependencies()) => createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  return { registry, first: first!, successor: successor!, other: other!, project, seat, service,
    setCaller: (id: typeof callerId) => { callerId = id; },
    reopen: () => { receipts.close(); receipts = new SqliteMcpReceiptStore(file); },
    receipt: (key: string) => receipts.lookup(`send_message_to_orchestrator:${key}`),
    close: () => receipts.close(),
  };
}

test("uncertain orchestrator send recovers one busy-target operation after late admission, rotation and MCP restart", async () => {
  const f = fixture("late");
  f.seat();
  const arrived = deferred<void>();
  const admit = deferred<void>();
  const finish = deferred<void>();
  const admitted = deferred<void>();
  const requests: Record<string, unknown>[] = [];
  let deliveryId = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    requests.push(body);
    arrived.resolve();
    await admit.promise;
    const held = f.registry.holdDelivery(body.conversationId as typeof f.first.id, String(body.text).trim(), String(body.clientMessageId), "text", [], null, {
      operationId: `operation-${requests.length}`, kind: "send", policy: "queue",
    });
    deliveryId = held.id;
    admitted.resolve();
    await finish.promise;
    return Response.json({ ok: true, operationId: `operation-${requests.length}`, outcome: "queued" });
  } });
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  const args = { clientRequestId: "late-report", project: f.project, text: "status report\n" };
  try {
    const initial = f.service().callTool("send_message_to_orchestrator", args, { deadlineAt: Date.now() + 2000 });
    await arrived.promise;
    expect(await initial).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false, details: { nextAction: "original-key-lookup" } });
    expect(requests).toHaveLength(1);
    f.seat(f.successor);
    f.reopen();
    expect(await f.service().callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    admit.resolve();
    await admitted.promise;
    const recovered = await f.service().callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true });
    expect(recovered).toMatchObject({ ok: true, outcome: "accepted", state: "in-flight", operationId: "operation-1", conversationId: f.first.id });
    expect(f.receipt(args.clientRequestId)?.binding?.target.identity).toBe(f.first.id);
    expect(requests).toHaveLength(1);
    f.registry.beginDeliveryAttempt(deliveryId, f.first.generations.at(-1)!.id);
    f.registry.recordDeliveryOutcome(deliveryId, "delivered", null, "delivered");
    expect(await f.service().callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, outcome: "settled", operationId: "operation-1", state: "delivered" });
    f.reopen();
    expect(await f.service().callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, operationId: "operation-1" });
    expect(await f.service().callTool("send_message_to_orchestrator", { ...args, text: "changed" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
    f.setCaller(f.other.id);
    expect(await f.service().callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: false, code: "recovery_not_permitted" });
    expect(requests).toHaveLength(1);
  } finally {
    admit.resolve(); finish.resolve();
    await server.stop(true);
    f.close();
  }
}, 15000);


test("missing-seat creation pins its recipient before the message and recovers after rotation", async () => {
  const f = fixture("created");
  const posts: string[] = [];
  const args = { clientRequestId: "created-report", project: f.project, text: "report" };
  const control: ViewerControlDependencies = {
    post: async () => { throw new Error("reconnecting post must not run"); },
    dispatch: async (pathname, body, _headers, context) => {
      posts.push(pathname);
      context!.dispatch!.attempted = true;
      if (pathname === "/api/orchestrator/seat") {
        f.seat();
        return { ok: true, seat: { conversationId: f.first.id, path: f.first.generations.at(-1)!.path } };
      }
      expect(f.receipt(args.clientRequestId)?.binding?.target.identity).toBe(f.first.id);
      expect(body.conversationId).toBe(f.first.id);
      f.registry.holdDelivery(f.first.id, String(body.text), String(body.clientMessageId), "text", [], null, {
        operationId: "created-operation", kind: "send", policy: "queue",
      });
      throw new McpDispatchUncertainError("response lost after admission");
    },
  };
  try {
    expect(await f.service(control).callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, operationId: "created-operation", outcome: "accepted" });
    f.seat(f.successor);
    f.reopen();
    expect(await f.service(control).callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, operationId: "created-operation", conversationId: f.first.id });
    expect(posts).toEqual(["/api/orchestrator/seat", "/api/tmux"]);
  } finally { f.close(); }
});

test("uncertain creation and a refused second dispatch never authorize a new-key resend", async () => {
  for (const phase of ["creation", "message"]) {
    const f = fixture(`uncertain-${phase}`);
    let calls = 0;
    const control: ViewerControlDependencies = {
      post: async () => { throw new Error("reconnecting post must not run"); },
      dispatch: async (pathname, _body, _headers, context) => {
        calls++;
        context!.dispatch!.attempted = true;
        if (phase === "creation") throw new McpDispatchUncertainError("creation response lost");
        if (pathname === "/api/orchestrator/seat") return { ok: true, seat: { conversationId: f.first.id } };
        throw new McpDispatchNotExecutedError("second connection refused");
      },
    };
    const args = { clientRequestId: `unknown-${phase}`, project: f.project, text: "report" };
    try {
      expect(await f.service(control).callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true }))
        .toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
      expect(calls).toBe(0);
      expect(f.receipt(args.clientRequestId)).toBeNull();
      expect(await f.service(control).callTool("send_message_to_orchestrator", args))
        .toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
      const originalCalls = calls;
      f.seat(f.successor);
      f.reopen();
      for (const recoveryOnly of [false, true]) expect(await f.service(control).callTool("send_message_to_orchestrator", { ...args, recoveryOnly }))
        .toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
      expect(calls).toBe(originalCalls);
    } finally { f.close(); }
  }
});

test("equal text under new keys and direct-send keys remains intentional separate work", async () => {
  const f = fixture("equal");
  f.seat();
  const sent: Record<string, unknown>[] = [];
  const control: ViewerControlDependencies = {
    post: async () => { throw new Error("reconnecting post must not run"); },
    dispatch: async (_pathname, body) => {
      sent.push(body);
      return { ok: true, operationId: `equal-${sent.length}`, outcome: "queued" };
    },
  };
  const args = { clientRequestId: "equal-key", project: f.project, text: "same message" };
  try {
    const s = f.service(control);
    expect(await s.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, operationId: "equal-1", settled: false });
    expect(await s.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, operationId: "equal-1" });
    expect(await s.callTool("send_message_to_orchestrator", { ...args, clientRequestId: "another-key" })).toMatchObject({ ok: true, operationId: "equal-2" });
    expect(await s.callTool("send_message", { ...args, conversationId: f.first.id })).toMatchObject({ ok: true, operationId: "equal-3" });
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((body) => body.clientMessageId)).size).toBe(3);
    expect(sent.map((body) => body.text)).toEqual([args.text, args.text, args.text]);
  } finally { f.close(); }
});

test("every shared receipt backend binds a created recipient once under the original owner", async () => {
  const binding: McpRequestBinding = {
    version: 1, toolName: "send_message_to_orchestrator", clientRequestId: "created-binding",
    caller: { kind: "worker", conversationId: "conversation_caller", project: "fixture" },
    target: { identity: null, project: "fixture" }, downstreamKey: "downstream-created",
    owner: { pid: process.pid, startIdentity: "fixture-owner" }, claimedAt: new Date().toISOString(),
  };
  const key = "send_message_to_orchestrator:created-binding";
  for (const kind of ["memory", "file", "sqlite"] as const) {
    const file = path.join(root, `binding-${kind}`);
    let store = kind === "memory" ? new MemoryMcpReceiptStore() : kind === "file" ? new FileMcpReceiptStore(file) : new SqliteMcpReceiptStore(file);
    try {
      expect(await store.claim(key, "a".repeat(64), "durable", binding)).toMatchObject({ kind: "fresh" });
      expect(await store.bindCreatedTarget(key, "a".repeat(64), binding, "conversation_created")).toBe(false);
      expect(await store.markDispatching(key, "a".repeat(64))).toBe(true);
      expect(await store.bindCreatedTarget(key, "b".repeat(64), binding, "conversation_created")).toBe(false);
      expect(await store.bindCreatedTarget(key, "a".repeat(64), { ...binding, owner: { ...binding.owner, pid: process.pid + 1 } }, "conversation_created")).toBe(false);
      expect(await store.bindCreatedTarget(key, "a".repeat(64), binding, "conversation_created")).toBe(true);
      expect(await store.bindCreatedTarget(key, "a".repeat(64), binding, "conversation_rotated")).toBe(false);
      if (store instanceof SqliteMcpReceiptStore) { store.close(); store = new SqliteMcpReceiptStore(file); }
      if (store instanceof FileMcpReceiptStore) store = new FileMcpReceiptStore(file);
      expect((await store.lookup(key))?.binding).toEqual({ ...binding, target: { ...binding.target, identity: "conversation_created" } });
    } finally { if (store instanceof SqliteMcpReceiptStore) store.close(); }
  }
});


test("a delivered control verdict stays delivered when recovery finds no downstream record", async () => {
  const f = fixture("terminal");
  f.seat();
  let sends = 0;
  const control: ViewerControlDependencies = { post: async () => {
    sends++;
    return { ok: true, operationId: "terminal-operation", outcome: "delivered" };
  } };
  const args = { clientRequestId: "terminal-report", project: f.project, text: "report" };
  try {
    expect(await f.service(control).callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, settled: true });
    f.reopen();
    expect(await f.service(control).callTool("send_message_to_orchestrator", { ...args, recoveryOnly: true })).toMatchObject({
      ok: true, outcome: "settled", state: "delivered", operationId: "terminal-operation", resend: "not-needed", duplicateRisk: false,
    });
    expect(sends).toBe(1);
  } finally { f.close(); }
});
