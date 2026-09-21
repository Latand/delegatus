import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeOperationCommand } from "@/lib/runtime/contracts";

const originalEnv = { ...process.env };
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mcm-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LLV_") || key.startsWith("NEXT_PUBLIC_")) delete process.env[key];
}
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}

const { viewerMcpBindings, productionViewerControlDependencies } = await import("./bindings");
const { createMcpToolService, SqliteMcpReceiptStore } = await import("./server");
const { runtimeHostClient } = await import("@/lib/runtime/client");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { createConversationMigrationGET, createConversationMigrationPOST } = await import("@/app/api/conversations/[conversationId]/migration/handlers");
const { dispatchStructuredControl } = await import("@/lib/runtime/structuredControls");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { StructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryQueue");
const { FakeEngineHost } = await import("@/lib/runtime/fixtures/fakeEngineHost");

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function migrationFixture(name: string, options: { missingHost?: boolean; delay?: Promise<void>; loseRuntimeAnswer?: boolean; defaultSpeed?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, accountId: "account-a", transport: "structured",
    launchProfile: { title: "Account migration fixture", model: "gpt-5.6-luna", effort: "low", fast: options.defaultSpeed ? null : false, project: "repo-fixture", role: "worker" } });
  if (begun.kind !== "created") throw new Error("fixture was not created");
  const id = begun.receipt.conversationId;
  const nativeId = crypto.randomUUID();
  const transcript = path.join(root, `${nativeId}.jsonl`);
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: nativeId }, artifactPath: transcript, cwd: root,
    accountId: "account-a", status: "live", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "fake:fixture", process: { pid: process.pid, startIdentity: "fixture" },
      eventCursor: 0, protocolVersion: "fixture", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null,
  });
  expect(registry.conversationForPath(transcript)?.id).toBe(id);
  expect(registry.readOnlySnapshot().entries[`codex:${nativeId}`]?.structuredHost).toBeTruthy();
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"), { structuredHosts: true });
  journal.append({ scope: { type: "session", id }, kind: "session-status", payload: {
    conversationId: id, sessionKey: { engine: "codex", sessionId: nativeId },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured", artifactPath: transcript,
    capabilities: { steer: true, structuredAttention: true }, activeTurnId: null,
  } });
  const commands: RuntimeOperationCommand[] = [];
  const actors: unknown[] = [];
  const runtime = {
    command: async (command: RuntimeOperationCommand) => {
      commands.push(command);
      const result = journal.executeOperation(command);
      await options.delay;
      if (options.loseRuntimeAnswer) throw new Error("runtime reply lost after admission");
      return result;
    },
    effectBatch: async (kinds: readonly string[], after?: number) => journal.effectBatch(100, kinds, after),
    operationStatus: async (operationId: string) => options.loseRuntimeAnswer ? null : journal.operationResult(operationId),
  } as RuntimeHostClient;
  const handler = createConversationMigrationPOST({ registry: () => registry, operationStatus: id => runtime.operationStatus(id), kick: () => {},
    dispatchControl: request => {
      actors.push(request.actor);
      return dispatchStructuredControl(request, { registry, client: options.missingHost ? null : runtime,
        enabled: () => true, kick: () => {}, accountExists: (engine, account) => engine === "codex" && ["account-a", "account-b", "default"].includes(account),
      });
    },
  });
  let requests = 0;
  const viewer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    expect(request.headers.get("authorization")).toBe("Bearer fixture-viewer-control");
    requests++;
    return handler(new NextRequest(request), { params: Promise.resolve({ conversationId: decodeURIComponent(new URL(request.url).pathname.split("/")[3]!) }) });
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${viewer.port}`;
  process.env.LLV_VIEWER_CONTROL_TOKEN = "fixture-viewer-control";
  const receiptPath = path.join(root, "mcp.sqlite");
  const receipts = new SqliteMcpReceiptStore(receiptPath);
  const bindings = viewerMcpBindings(undefined, productionViewerControlDependencies(true));
  const service = createMcpToolService(bindings, receipts);
  return { registry, id, transcript, journal, commands, actors, runtime, service, bindings, receipts, receiptPath,
    requests: () => requests, close() { viewer.stop(true); receipts.close(); journal.close(); } };
}

test.each([false, true])("MCP explicit pick preserves busy=%s until engagement, then applies the chosen account before one send", async busy => {
  const f = migrationFixture(`engage-${busy}`);
  let selected = "account-a";
  let active = busy;
  const order: string[] = [];
  const host = new FakeEngineHost();
  const originalHealth = host.health.bind(host);
  host.health = async () => ({ ...await originalHealth(), status: active ? "active" : "idle", activeTurnRef: active ? "running" : null });
  const originalSend = host.send.bind(host);
  host.send = async entry => { order.push(`send:${selected}`); return originalSend(entry); };
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, after) => f.journal.effectBatch(100, kinds, after),
    status: async operationId => f.journal.operationResult(operationId)?.receipt ?? null,
    transition: async (operationId, status, details) => { f.journal.transitionOperation(operationId, status, details); },
  }, () => host, undefined, undefined, undefined, async effect => {
    selected = effect.accountId!;
    order.push(`select:${selected}`);
    return "applied";
  });
  try {
    const args = { clientRequestId: "explicit-pick", conversationId: f.id, action: "select-account", accountId: "account-b" };
    const picked = await f.service.callTool("conversation_migration", args);
    expect(picked).toMatchObject({ ok: true, receipt: { status: "queued" } });
    if (!picked.ok) throw new Error(picked.error);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({ kind: "reconfigure", accountId: "account-b", operationId: picked.operationId, idempotencyKey: picked.operationId });
    await queue.drain();
    expect(order).toEqual([]);
    f.journal.executeOperation({ kind: "send", operationId: "next-send", idempotencyKey: "next-send", conversationId: f.id, text: "Continue", policy: "queue" });
    await queue.drain();
    if (busy) {
      expect(order).toEqual([]);
      active = false;
      await queue.drain();
    }
    expect(order).toEqual(["select:account-b", "send:account-b"]);
    await queue.drain();
    expect(host.ledger.writes).toHaveLength(1);
    expect(await f.service.callTool("conversation_migration", args)).toEqual({ ...picked, replayed: true });
    expect(f.commands).toHaveLength(1);
  } finally { f.close(); }
});

test("MCP select-account defaults an unspecified Codex speed to false", async () => {
  const f = migrationFixture("default-speed", { defaultSpeed: true });
  try {
    expect(f.registry.conversation(f.id)?.generations.at(-1)?.launchProfile.fast).toBeNull();
    expect(await f.service.callTool("conversation_migration", {
      clientRequestId: "default-speed", conversationId: f.id, action: "select-account", accountId: "account-b",
    })).toMatchObject({ ok: true, receipt: { status: "queued" } });
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({ kind: "reconfigure", fast: false, accountId: "account-b" });
  } finally { f.close(); }
});

test("account-less reseat retains quota selection through HTTP and passes its receipt identity to the journal", async () => {
  const f = migrationFixture("automatic");
  const now = new Date().toISOString();
  f.registry.recordQuotaEvaluation({ engine: "codex", observations: [{ engine: "codex", accountId: "default",
    authenticated: true, authCheckedAt: now, limits: { session: { usedPercent: 5, resetsAt: null }, weekly: null, plan: null, capturedAt: Date.now() },
    provenance: { source: "live", reason: null, staleSince: null }, observedAt: now, bootId: "fixture" }], signature: null, bootId: "fixture", now, minimumGapMs: 0 });
  try {
    const result = await f.service.callTool("conversation_migration", { clientRequestId: "automatic", conversationId: f.id, action: "reseat" });
    expect(result).toMatchObject({ ok: true, reseat: "intended", targetId: "default", receipt: { status: "queued" } });
    if (!result.ok) throw new Error(result.error);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({ operationId: result.operationId, idempotencyKey: result.operationId, accountId: "default" });
  } finally { f.close(); }
});

test("selecting the current account keeps browser hold semantics", async () => {
  const f = migrationFixture("holds");
  try {
    f.registry.holdForFailedSwitch(f.id, { operationId: "failed-switch", accountId: "account-b", reason: "selected account unavailable" });
    const failed = await f.service.callTool("conversation_migration", { clientRequestId: "bad-switch", conversationId: f.id, action: "select-account", accountId: "missing" });
    expect(failed.ok).toBe(false);
    expect(f.registry.switchHold(f.id)).not.toBeNull();
    const current = await f.service.callTool("conversation_migration", { clientRequestId: "current-account", conversationId: f.id, action: "select-account", accountId: "account-a" });
    expect(current).toMatchObject({ ok: true, outcome: "withdrawn" });
    expect(f.registry.switchHold(f.id)).toBeNull();
    expect(f.commands).toEqual([]);
  } finally { f.close(); }
});

test("withdraw preserves the claimed switch identity and revision refusal over HTTP", async () => {
  const f = migrationFixture("withdraw");
  try {
    const picked = await f.service.callTool("conversation_migration", { clientRequestId: "claimed-pick", conversationId: f.id, action: "select-account", accountId: "account-b" });
    if (!picked.ok) throw new Error(picked.error);
    const operationId = picked.operationId as string;
    f.registry.claimConversationReconfigure(f.id, { operationId, revision: 1, profile: { model: "gpt-5.6-luna", effort: "low", fast: false }, accountId: "account-b" });
    const refused = await f.service.callTool("conversation_migration", { clientRequestId: "withdraw-claimed", conversationId: f.id, action: "withdraw", operationId });
    expect(refused).toMatchObject({ ok: false, details: { status: 409, code: "SWITCH_CLAIMED", expectedRevision: null } });
    expect(f.commands).toHaveLength(1);
  } finally { f.close(); }
});

test("a runtime error after admission stays unknown and never invites another dispatch", async () => {
  const f = migrationFixture("lost-runtime-answer", { loseRuntimeAnswer: true });
  const args = { clientRequestId: "lost-runtime-answer", conversationId: f.id, action: "select-account", accountId: "account-b" };
  try {
    const result = await f.service.callTool("conversation_migration", args);
    expect(result).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    expect(f.commands).toHaveLength(1);
    expect(f.journal.operationResult(f.commands[0]!.operationId!)?.receipt.status).toBe("queued");
    expect(await f.service.callTool("conversation_migration", args)).toEqual({ ...result, replayed: true });
    expect(f.commands).toHaveLength(1);
  } finally { f.close(); }
});

test("account selection derives the actor from the capability and ignores body role/project claims", async () => {
  const f = migrationFixture("actor");
  const capability = "a".repeat(43);
  process.env.LLV_SPAWN_CAPABILITY = capability;
  setCallerConversationResolverForTests(() => "conversation_caller");
  try {
    const result = await f.service.callTool("conversation_migration", { clientRequestId: "actor", conversationId: f.id,
      action: "select-account", accountId: "account-b", actor: { kind: "operator" }, role: "operator", project: "wrong-project", engine: "claude" });
    expect(result.ok).toBe(true);
    expect(f.actors).toEqual([{ kind: "agent", conversationId: "conversation_caller" }]);
    expect(f.commands[0]).toMatchObject({ conversationId: f.id, sessionKey: { engine: "codex" } });
  } finally { delete process.env.LLV_SPAWN_CAPABILITY; setCallerConversationResolverForTests(null); f.close(); }
});

test("bounded read exposes late receipts and actual host activity without queue or provider contents", async () => {
  const f = migrationFixture("read");
  const host = new FakeEngineHost();
  const health = await host.health();
  host.health = async () => ({ ...health, status: "active", activeTurnRef: "running-turn", diagnostics: { executable: "withheld-provider-detail" } } as never);
  const reads: string[] = [];
  const get = createConversationMigrationGET({ registry: () => f.registry, host: () => host, client: () => ({ ...f.runtime,
    operationStatus: async (id: string) => { reads.push(id); return f.journal.operationResult(id); },
  }) });
  const request = (operationId: string) => get(new NextRequest(`http://127.0.0.1/api/conversations/${f.id}/migration?operationId=${operationId}`, { headers: { host: "127.0.0.1" } }), { params: Promise.resolve({ conversationId: f.id }) });
  try {
    const result = await f.service.callTool("conversation_migration", { clientRequestId: "read-pick", conversationId: f.id, action: "select-account", accountId: "account-b" });
    if (!result.ok) throw new Error(result.error);
    const operationId = result.operationId as string;
    f.journal.transitionOperation(operationId, "applied", { reason: "withheld-provider-detail" });
    const before = f.registry.readOnlySnapshot();
    const response = await request(operationId);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ controlChannel: "configured", host: { read: "observed", status: "active", activeTurnRef: "running-turn" },
      receipts: [{ operationId, read: "observed", status: "applied", admittedAt: expect.any(String), updatedAt: expect.any(String) }] });
    expect(reads).toEqual([operationId]);
    expect(JSON.stringify(body)).not.toContain("withheld-provider-detail");
    expect(JSON.stringify(body)).not.toContain(sandbox);
    expect(f.registry.readOnlySnapshot()).toEqual(before);
    f.journal.executeOperation({ kind: "send", operationId: "unrelated", idempotencyKey: "unrelated", conversationId: "conversation_other", text: "private message", policy: "queue" });
    expect(await (await request("unrelated")).json()).toMatchObject({ receipts: [{ operationId: "unrelated", read: "wrong-conversation" }] });
    expect(await (await request("missing")).json()).toMatchObject({ receipts: [{ operationId: "missing", read: "missing" }] });
    expect(f.commands).toHaveLength(1);
  } finally { f.close(); }
});

test("a claimed timeout and MCP restart retain the key while the late journal receipt settles once", async () => {
  let release!: () => void;
  const f = migrationFixture("timeout", { delay: new Promise<void>(resolve => { release = resolve; }) });
  const args = { clientRequestId: "timed-pick", conversationId: f.id, action: "select-account", accountId: "account-b" };
  const abort = new AbortController();
  try {
    const pending = f.service.callTool("conversation_migration", args, { signal: abort.signal });
    for (let n = 0; n < 100 && !f.commands.length; n++) await Bun.sleep(10);
    expect(f.commands).toHaveLength(1);
    abort.abort();
    const first = await pending;
    expect(first).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false, details: { operationId: f.commands[0]!.operationId, nextAction: "original-key-lookup" } });
    expect(await f.service.callTool("conversation_migration", args)).toEqual({ ...first, replayed: true });
    release();
    f.journal.transitionOperation(f.commands[0]!.operationId!, "applied");
    expect((await f.runtime.operationStatus(f.commands[0]!.operationId!))?.receipt.status).toBe("applied");
    f.receipts.close();
    const reopened = new SqliteMcpReceiptStore(f.receiptPath);
    try {
      const restarted = createMcpToolService(f.bindings, reopened);
      expect(await restarted.callTool("conversation_migration", args)).toEqual({ ...first, replayed: true });
      expect(await restarted.callTool("conversation_migration", { ...args, accountId: "account-a" })).toMatchObject({ code: "idempotency_conflict" });
    } finally { reopened.close(); }
    expect(f.requests()).toBe(1);
    expect(f.commands).toHaveLength(1);
  } finally { release(); f.close(); }
});

test("explicit selection refuses unknown accounts, wrong engine, mismatched path, ambiguous reseat inputs and missing host", async () => {
  const f = migrationFixture("refusals");
  try {
    for (const [name, extra] of Object.entries({
      unknown: { accountId: "missing" }, engine: { accountId: "claude-only" },
      path: { transcriptPath: path.join(sandbox, "other-project.jsonl") },
      targetAlias: { targetAccountId: "account-b" }, automatic: { action: "reseat" }, empty: { accountId: "" },
    })) {
      const result = await f.service.callTool("conversation_migration", { clientRequestId: name, conversationId: f.id, action: "select-account", accountId: "account-b", ...extra });
      expect(result.ok).toBe(false);
    }
    expect(f.commands).toEqual([]);
  } finally { f.close(); }
  const missing = migrationFixture("missing-host", { missingHost: true });
  try {
    expect(await missing.service.callTool("conversation_migration", { clientRequestId: "missing-host", conversationId: missing.id, action: "select-account", accountId: "account-b" }))
      .toMatchObject({ ok: false, details: { status: 503, code: "runtime-host-unavailable" } });
    expect(missing.commands).toEqual([]);
  } finally { missing.close(); }
});

test("migration uses the Viewer HTTP owner while the MCP process has no runtime socket", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const viewer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    requests.push({ path: new URL(request.url).pathname, body });
    return Response.json({ conversation: { id: "conversation_target", migration: { phase: "rolled-back", revision: 4 } } });
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${viewer.port}`;
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "routing.sqlite"));
  const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true)), receipts);
  try {
    expect(runtimeHostClient()).toBeNull();
    const args = { clientRequestId: "migration-routing", conversationId: "conversation_target", action: "rollback", expectedRevision: 4 };
    const result = await service.callTool("conversation_migration", args);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/api/conversations/conversation_target/migration",
      body: { action: "rollback", expectedRevision: 4, requestOperationId: expect.stringMatching(/^mcp_conversation_migration_[0-9a-f]{24}$/) },
    });
    expect(result).toMatchObject({ ok: true, conversation: { migration: { phase: "rolled-back" } } });
    expect(await service.callTool("conversation_migration", args)).toEqual({ ...result, replayed: true });
    expect(requests).toHaveLength(1);
  } finally {
    viewer.stop(true);
    receipts.close();
  }
});
