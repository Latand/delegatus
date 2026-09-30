import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { NextRequest } from "next/server";

/* Type-only, so the module graph still loads in the order the state root needs. */
import type { McpRequestBinding } from "./server";

/*
 * Issue #1609: a delivered send stayed unrecoverable because the two halves of
 * one request disagreed about its text. The send route TRIMS before it reserves,
 * and original-key recovery compared the caller's untrimmed argument against the
 * trimmed record — so a report ending in a newline came back
 * "the delivery payload contradicts the bound request", with no ids, forever.
 *
 * Both halves here are the production ones: the real `conversationHostPOST`
 * performs the admission normalization, a real `AgentRegistry` holds the
 * reservation and settles it, and the real MCP `send_message.recover` reads it
 * back. Only the structured host boundary is a fixture — that is the seam the
 * route's own suite uses, and it is downstream of every transform under test.
 *
 * The suite owns a throwaway HOME/state root: importing these modules drags in
 * everything that resolves state from the environment, and no test may read or
 * migrate the operator's live state (AGENTS.md).
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-original-key-send-recovery-"));
const previous = {
  home: process.env.HOME,
  xdg: process.env.XDG_CONFIG_HOME,
  state: process.env.LLV_STATE_DIR,
  codex: process.env.LLV_CODEX_HOME,
};
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.LLV_CODEX_HOME = path.join(root, "codex");

const { setConversationHostDependenciesForTests } = await import("@/app/api/conversation-host/dependencies");

afterAll(() => {
  setConversationHostDependenciesForTests(null);
  for (const [key, value] of [
    ["HOME", previous.home],
    ["XDG_CONFIG_HOME", previous.xdg],
    ["LLV_STATE_DIR", previous.state],
    ["LLV_CODEX_HOME", previous.codex],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const { conversationHostPOST } = await import("@/app/api/conversation-host/handlers");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeHostUnavailableError } = await import("@/lib/runtime/client");
const { sendDownstreamKey, viewerMcpRecoverableTools, viewerMcpBindings, productionViewerControlDependencies } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");

const transcriptPath = path.join(root, "recipient.jsonl");
fs.writeFileSync(transcriptPath, "{}\n");
let registry = new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
registry.reconcileConversations([{
  engine: "codex",
  path: transcriptPath,
  accountId: "recovery-fixture-account",
  launchProfile: emptyLaunchProfile({ cwd: root }),
  turn: { state: "idle", source: "assistant", terminalAt: null },
  observedAt: "2026-09-09T08:00:00.000Z",
}]);
let recipient = Object.values(registry.snapshot().conversations)[0]!;
let generationId = recipient.generations.at(-1)!.id;

/** Every text the structured host was handed, in order — the count is what
    says no recovery ever admitted a second copy of a message. */
const admitted: { clientMessageId: string; text: string }[] = [];
/** A test that needs the production `enqueueStructuredMessage` itself sets this. */
let structuredSend: ((request: Parameters<typeof enqueueStructuredMessage>[0]) => ReturnType<typeof enqueueStructuredMessage>) | null = null;

setConversationHostDependenciesForTests({
  collectImagePayloads: () => ({ images: [], error: null }),
  completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
  /* Stands in for the structured host, and reserves exactly what the real
     `enqueueStructuredMessage` reserves for a text-only send: the text the
     route handed it, under the caller's own key, with no digest of its own
     (the registry stamps one from the stored text). */
  enqueueStructuredMessage: async (request) => {
    if (structuredSend) return structuredSend(request);
    const clientMessageId = request.clientMessageId ?? "";
    admitted.push({ clientMessageId, text: request.text });
    const operationId = `op_${admitted.length}`;
    registry.holdDelivery(recipient.id, request.text, clientMessageId, "text", [], null, {
      operationId,
      kind: "send",
      policy: "queue",
    });
    return {
      ok: true,
      structured: true,
      target: recipient.id,
      outcome: "queued",
      operationId,
      receipt: { operationId, status: "queued" },
    } as never;
  },
});

const tools = viewerMcpRecoverableTools({
  registrySnapshot: () => registry.readOnlySnapshot(),
  sendSettlementPorts: () => ({ registry, client: null }),
} as never);
const recover = tools.send_message!.recover;

function bindingFor(downstreamKey: string): McpRequestBinding {
  return {
    version: 1,
    toolName: "send_message",
    clientRequestId: downstreamKey,
    caller: { kind: "worker", conversationId: "conversation_caller", project: null },
    target: { project: null, identity: recipient.id },
    downstreamKey,
    owner: { pid: process.pid, startIdentity: null },
    claimedAt: "2026-09-09T08:00:01.000Z",
  };
}

/** One send through the real route, exactly as `sendMessage` posts it. */
async function send(downstreamKey: string, text: string) {
  return conversationHostPOST(new NextRequest("http://127.0.0.1/api/conversation-host", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({
      pid: null,
      path: transcriptPath,
      conversationId: recipient.id,
      clientMessageId: downstreamKey,
      text,
      images: [],
    }),
  }));
}

/** Admit one send and drive it to the delivered state the defect was found in:
    settled, its reservation text blanked, its digest the only content evidence. */
async function deliver(requestId: string, text: string): Promise<{ key: string; operationId: string }> {
  const key = sendDownstreamKey(requestId);
  const response = await send(key, text);
  expect(response.status).toBe(200);
  const body = await response.json() as { operationId: string };
  const delivery = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((held) => held.clientMessageId === key)!;
  registry.beginDeliveryAttempt(delivery.id, generationId);
  registry.recordDeliveryOutcome(delivery.id, "delivered", null, "delivered");
  return { key, operationId: body.operationId };
}

test("the send route trims what it reserves, so the record never holds the caller's trailing newline", async () => {
  const before = admitted.length;
  const { key } = await deliver("route-normalization", "fixture report\n");

  expect(admitted.slice(before)).toEqual([{ clientMessageId: key, text: "fixture report" }]);
  const settled = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((held) => held.clientMessageId === key)!;
  /* Delivered records blank their text, so the digest of the TRIMMED text is
     what any later reader has to match. */
  expect(settled.text).toBe("");
  expect(settled.contentDigest).toBe(Object.values(registry.readOnlySnapshot().deliveryOperationOwners)
    .find((owner) => owner.clientMessageId === key)!.contentDigest);
});

test("original-key recovery of a delivered send whose text ended in a newline reports the actual operation", async () => {
  const originalText = "terminal report for the manager\n";
  const admissions = admitted.length;
  const { key, operationId } = await deliver("trailing-newline-report", originalText);

  /* The exact arguments the caller still holds — untrimmed, as it sent them. */
  const recovered = await recover(bindingFor(key), { legacy: false, args: { text: originalText } });

  const owner = Object.values(registry.readOnlySnapshot().deliveryOperationOwners)
    .find((entry) => entry.clientMessageId === key)!;
  expect(recovered.outcome).toBe("settled");
  expect(recovered.reason).toBeNull();
  expect(recovered.ids).toEqual({ operationId, conversationId: recipient.id, deliveryId: owner.deliveryId! });
  /* Recovery READ the record. It admitted nothing, and invented no delivery
     time of its own: the settlement it reports is the one the registry made. */
  expect(recovered.facts).toMatchObject({
    state: "delivered",
    resend: "not-needed",
    duplicateRisk: false,
    settledAt: owner.settledAt!,
  });
  expect(admitted.length).toBe(admissions + 1);
});

test("recovery of an accepted send whose reservation is still live answers with the original ids", async () => {
  /* The incident's own moment: the MCP dispatch timed out at 5 s, the send is
     durably admitted, and nothing has settled it yet. A LIVE reservation still
     carries the text admission stored — the trimmed form — where a delivered
     one has blanked it, so this is the only path on which the stored-text
     comparison decides the answer at all. */
  const originalText = "terminal report while the reservation is live\n";
  const admissions = admitted.length;
  const key = sendDownstreamKey("accepted-live-reservation");
  const response = await send(key, originalText);
  expect(response.status).toBe(200);
  const { operationId } = await response.json() as { operationId: string };

  const reservation = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((held) => held.clientMessageId === key)!;
  /* Unsettled, and holding the trimmed text against which the caller's
     untrimmed argument is measured. */
  expect(reservation.state).toBe("assigned");
  expect(reservation.deliveredAt).toBeNull();
  expect(reservation.text).toBe(originalText.trim());

  const before = JSON.stringify(registry.readOnlySnapshot());
  const recovered = await recover(bindingFor(key), { legacy: false, args: { text: originalText } });

  expect(recovered.outcome).toBe("accepted");
  expect(recovered.ids).toEqual({ operationId, conversationId: recipient.id, deliveryId: reservation.id });
  expect(recovered.facts).toMatchObject({
    state: "in-flight",
    acceptedAt: reservation.assignedAt!,
    resend: null,
    duplicateRisk: false,
  });
  /* Recovery READ the record: no second copy of the message was admitted, and
     the durable state is byte-identical to what it found. */
  expect(admitted.length).toBe(admissions + 1);
  expect(JSON.stringify(registry.readOnlySnapshot())).toBe(before);
});

test("leading and trailing whitespace recovers the same way, and an untouched text still does", async () => {
  const spaced = "\n  spaced report  \n";
  const spacedSend = await deliver("surrounded-report", spaced);
  const recoveredSpaced = await recover(bindingFor(spacedSend.key), { legacy: false, args: { text: spaced } });
  expect(recoveredSpaced).toMatchObject({ outcome: "settled", ids: { operationId: spacedSend.operationId } });

  const exact = "report with nothing to trim";
  const exactSend = await deliver("exact-report", exact);
  const recoveredExact = await recover(bindingFor(exactSend.key), { legacy: false, args: { text: exact } });
  expect(recoveredExact).toMatchObject({ outcome: "settled", ids: { operationId: exactSend.operationId } });
});

test("a changed payload under the same key still contradicts, and discloses nothing", async () => {
  const { key, operationId } = await deliver("changed-payload-control", "the original instruction\n");

  for (const changed of [
    "the amended instruction\n",
    "the original instruction and one more sentence\n",
    "theoriginalinstruction\n",
    "The original instruction\n",
  ]) {
    const answer = await recover(bindingFor(key), { legacy: false, args: { text: changed } });
    expect(answer.outcome).toBe("unknown");
    expect(answer.reason).toBe("the delivery payload contradicts the bound request");
    expect(answer.ids).toEqual({});
    expect(JSON.stringify(answer)).not.toContain(operationId);
  }
});

test("a record reserved verbatim by the legacy path recovers under the same original arguments", async () => {
  /* `deliverConversationMessage` reserves the text it was given, untrimmed
     (`src/lib/delivery.ts`), so both admitted forms are reachable in durable
     records and recovery has to accept whichever one is stored. */
  const originalText = "legacy relay\n";
  const key = sendDownstreamKey("legacy-verbatim-record");
  const held = registry.holdDelivery(recipient.id, originalText, key, "text", [], null, {
    operationId: "op_legacy_verbatim",
    kind: "send",
    policy: "queue",
  });
  registry.beginDeliveryAttempt(held.id, generationId);
  registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");

  expect(await recover(bindingFor(key), { legacy: false, args: { text: originalText } }))
    .toMatchObject({ outcome: "settled", ids: { operationId: "op_legacy_verbatim" } });
  expect(await recover(bindingFor(key), { legacy: false, args: { text: "a different relay\n" } }))
    .toMatchObject({ outcome: "unknown", reason: "the delivery payload contradicts the bound request", ids: {} });
});

test("recovery leaves the durable records exactly as it found them", async () => {
  const originalText = "read-only report\n";
  const { key } = await deliver("read-only-recovery", originalText);
  const before = JSON.stringify(registry.readOnlySnapshot());
  const admissions = admitted.length;

  await recover(bindingFor(key), { legacy: false, args: { text: originalText } });
  await recover(bindingFor(key), { legacy: false, args: { text: "something else" } });

  expect(JSON.stringify(registry.readOnlySnapshot())).toBe(before);
  expect(admitted.length).toBe(admissions);
});

/* #2020: a finished headless reviewer's row keeps the launch's publication
   marker (`starting`, `pendingAction: "spawn"`, no host, no process). The
   Viewer refuses a send to it before reserving anything, and the MCP call
   used to record that refusal as a dispatch that may have run: the first
   answer and every later lookup under the key said `outcome_unknown`. The
   route and `enqueueStructuredMessage` here are the production ones; the
   runtime host is a client that knows no session. */
test("a send the Viewer refuses before reserving anything settles as not executed, then and on every lookup", async () => {
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, launchProfile: { title: "headless reviewer" } });
  const sessionId = crypto.randomUUID();
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: path.join(root, `rollout-${sessionId}.jsonl`),
    cwd: root,
    accountId: "recovery-fixture-account",
    launchProfile: begun.receipt.launchProfile,
    status: "starting",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  if (settled.kind === "conflict") throw new Error(settled.code);
  const reviewer = registry.conversation(settled.receipt.conversationId)!;

  const domain = {
    registrySnapshot: () => registry.readOnlySnapshot(),
    attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_caller" }),
    callerAttribution: () => ({ kind: "worker", conversationId: "conversation_caller" }),
    recoveryPredecessors: () => [],
    sendSettlementPorts: () => ({ registry, client: null }),
  } as never;
  const receipts = new MemoryMcpReceiptStore();
  const service = () => createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(), domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const posts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    posts.push(new URL(request.url).pathname);
    return conversationHostPOST(new NextRequest("http://127.0.0.1/api/conversation-host", {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: await request.text(),
    }));
  } });
  const saved = { url: process.env.LLV_VIEWER_CONTROL_URL, target: process.env.LLV_VIEWER_DEPLOY_TARGET, port: process.env.LLV_VIEWER_PORT };
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  delete process.env.LLV_VIEWER_DEPLOY_TARGET;
  delete process.env.LLV_VIEWER_PORT;
  structuredSend = (request) => enqueueStructuredMessage(request, {
    enabled: () => true,
    registry: () => registry,
    client: () => ({ readSession: async () => null }) as never,
    requestMigrationTick: () => {},
  });
  const args = { clientRequestId: "refused-before-reservation", conversationId: reviewer.id, text: "round finished, one more question" };
  try {
    const first = await service().callTool("send_message", args);
    expect(first).toMatchObject({ ok: false, details: { outcome: "not-executed", nextAction: "new-request-permitted", status: 503 } });
    expect(JSON.stringify(first)).toContain("synchroniz");
    const lookup = await service().callTool("send_message", { ...args, recoveryOnly: true });
    expect(lookup).toMatchObject({ ok: false, details: { outcome: "not-executed", nextAction: "new-request-permitted" } });
    expect(JSON.stringify(lookup)).toContain("synchroniz");
    /* Nothing was reserved: the answer is the handler's own, and it said so. */
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries)
      .filter((held) => held.conversationId === reviewer.id)).toEqual([]);
    expect(posts).toHaveLength(1);
  } finally {
    structuredSend = null;
    await server.stop(true);
    for (const [key, value] of [["LLV_VIEWER_CONTROL_URL", saved.url], ["LLV_VIEWER_DEPLOY_TARGET", saved.target], ["LLV_VIEWER_PORT", saved.port]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("an oversized send to a reclaimed host keeps its refusal reason through MCP recovery", async () => {
  const previousRegistry = { registry, recipient, generationId };
  const isolatedRegistry = new AgentRegistry(path.join(root, "reclaimed-oversized-registry.json"), undefined, undefined, { sqliteMode: "off" });
  isolatedRegistry.reconcileConversations([{
    engine: "codex",
    path: transcriptPath,
    accountId: "recovery-fixture-account",
    launchProfile: emptyLaunchProfile({ cwd: root }),
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-09-09T08:00:00.000Z",
  }]);
  registry = isolatedRegistry;
  recipient = Object.values(registry.snapshot().conversations)[0]!;
  generationId = recipient.generations.at(-1)!.id;
  const generation = recipient.generations.at(-1)!;
  const before = registry.readOnlySnapshot();
  const saved = { url: process.env.LLV_VIEWER_CONTROL_URL, target: process.env.LLV_VIEWER_DEPLOY_TARGET, port: process.env.LLV_VIEWER_PORT };
  let stopServer: (() => Promise<void>) | null = null;
  try {
    registry.upsert({
      key: { engine: recipient.engine, sessionId: generation.id },
      artifactPath: generation.path,
      cwd: root,
      accountId: generation.accountId,
      launchProfile: generation.launchProfile,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:reclaimed-recovery-fixture",
        process: null,
        eventCursor: 0,
        protocolVersion: "v2",
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: null,
      pendingAction: null,
    });

    const domain = {
      registrySnapshot: () => registry.readOnlySnapshot(),
      attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_caller" }),
      callerAttribution: () => ({ kind: "worker", conversationId: "conversation_caller" }),
      recoveryPredecessors: () => [],
      sendSettlementPorts: () => ({ registry, client: null }),
    } as never;
    const receipts = new MemoryMcpReceiptStore();
    const service = () => createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(), domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
    const posts: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      posts.push(new URL(request.url).pathname);
      return conversationHostPOST(new NextRequest("http://127.0.0.1/api/conversation-host", {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: await request.text(),
      }));
    } });
    stopServer = () => server.stop(true);
    process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
    delete process.env.LLV_VIEWER_DEPLOY_TARGET;
    delete process.env.LLV_VIEWER_PORT;
    structuredSend = (request) => enqueueStructuredMessage(request, {
      enabled: () => true,
      registry: () => registry,
      client: () => ({ readSession: async () => null }) as never,
      requestMigrationTick: () => {},
    });
    const text = "x".repeat(32_001);
    const args = { clientRequestId: "reclaimed-oversized-refusal", conversationId: recipient.id, text };
    const first = await service().callTool("send_message", args);
    expect(first).toMatchObject({ ok: false, details: { outcome: "not-executed", nextAction: "new-request-permitted", status: 413 } });
    expect(JSON.stringify(first)).toContain("structured message text exceeds the 32000-byte envelope bound");

    const lookup = await service().callTool("send_message", { ...args, recoveryOnly: true });
    expect(lookup).toMatchObject({ ok: false, details: { outcome: "not-executed", nextAction: "new-request-permitted", status: 413 } });
    expect(JSON.stringify(lookup)).toContain("structured message text exceeds the 32000-byte envelope bound");
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries)).toEqual(Object.values(before.heldDeliveries));
    expect(posts).toHaveLength(1);
  } finally {
    structuredSend = null;
    await stopServer?.();
    for (const [key, value] of [["LLV_VIEWER_CONTROL_URL", saved.url], ["LLV_VIEWER_DEPLOY_TARGET", saved.target], ["LLV_VIEWER_PORT", saved.port]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    isolatedRegistry.close();
    registry = previousRegistry.registry;
    recipient = previousRegistry.recipient;
    generationId = previousRegistry.generationId;
  }
});

test("a transient readiness read after republish settles the original MCP key through durable admission", async () => {
  const previousRegistry = { registry, recipient, generationId };
  const isolatedRegistry = new AgentRegistry(path.join(root, "readiness-recovery-registry.json"), undefined, undefined, { sqliteMode: "off" });
  isolatedRegistry.reconcileConversations([{
    engine: "codex",
    path: transcriptPath,
    accountId: "recovery-fixture-account",
    launchProfile: emptyLaunchProfile({ cwd: root }),
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-09-09T08:00:00.000Z",
  }]);
  registry = isolatedRegistry;
  recipient = Object.values(registry.snapshot().conversations)[0]!;
  generationId = recipient.generations.at(-1)!.id;
  const generation = recipient.generations.at(-1)!;
  registry.upsert({
    key: { engine: recipient.engine, sessionId: generation.id },
    artifactPath: generation.path,
    cwd: root,
    accountId: generation.accountId,
    launchProfile: generation.launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:recovery-fixture",
      process: null,
      eventCursor: 0,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  const runtimeSession = (host: "dead" | "hosted") => ({
    conversationId: recipient.id,
    sessionKey: { engine: recipient.engine, sessionId: generation.id },
    hostKind: "codex-app-server",
    host,
    turn: "idle",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: generation.accountId,
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: root,
    artifactPath: generation.path,
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null,
  }) as never;
  let reads = 0;
  let commandCount = 0;
  const client = {
    readSession: async () => {
      reads += 1;
      if (reads === 1) return runtimeSession("dead");
      if (reads === 2) throw new RuntimeHostUnavailableError("runtime host request timed out");
      return runtimeSession("hosted");
    },
    command: async ({ operationId }: { operationId: string }) => {
      commandCount += 1;
      return { operationId, receipt: { status: "delivered" } };
    },
    operationStatus: async (operationId: string) => ({ operationId, receipt: { status: "delivered" } }),
  } as never;
  const domain = {
    registrySnapshot: () => registry.readOnlySnapshot(),
    attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_caller" }),
    callerAttribution: () => ({ kind: "worker", conversationId: "conversation_caller" }),
    recoveryPredecessors: () => [],
    sendSettlementPorts: () => ({ registry, client }),
  } as never;
  const receipts = new MemoryMcpReceiptStore();
  const service = () => createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(), domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  const posts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    posts.push(new URL(request.url).pathname);
    return conversationHostPOST(new NextRequest("http://127.0.0.1/api/conversation-host", {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: await request.text(),
    }));
  } });
  const saved = { url: process.env.LLV_VIEWER_CONTROL_URL, target: process.env.LLV_VIEWER_DEPLOY_TARGET, port: process.env.LLV_VIEWER_PORT };
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  delete process.env.LLV_VIEWER_DEPLOY_TARGET;
  delete process.env.LLV_VIEWER_PORT;
  structuredSend = (request) => enqueueStructuredMessage(request, {
    enabled: () => true,
    registry: () => registry,
    client: () => client,
    republish: async () => true,
    recover: async () => {
      registry.upsert({
        key: { engine: recipient.engine, sessionId: generation.id },
        artifactPath: generation.path,
        cwd: root,
        accountId: generation.accountId,
        launchProfile: generation.launchProfile,
        status: "idle",
        host: null,
        structuredHost: {
          kind: "codex-app-server",
          endpoint: "stdio:recovery-fixture",
          process: { pid: process.pid, startIdentity: null },
          eventCursor: 0,
          protocolVersion: "v2",
          writerClaimEpoch: 2,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 2,
        claimOwner: "structured-host:recovery-fixture",
        pendingAction: null,
      });
      return { target: null, path: generation.path, conversationId: recipient.id, spawned: true } as never;
    },
    requestMigrationTick: () => {},
    kick: () => {},
  });
  const args = { clientRequestId: "republish-read-timeout", conversationId: recipient.id, text: "deliver after readiness retry" };
  try {
    const first = await service().callTool("send_message", args);
    expect(first).toMatchObject({ ok: true });
    expect(JSON.stringify(first)).not.toContain("outcome_unknown");

    const recovered = await service().callTool("send_message", { ...args, recoveryOnly: true });
    expect(recovered).toMatchObject({ ok: true });
    expect(JSON.stringify(recovered)).not.toContain("outcome_unknown");
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(commandCount).toBe(1);
    expect(posts).toHaveLength(1);
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries)
      .filter((held) => held.clientMessageId === sendDownstreamKey(args.clientRequestId))).toHaveLength(1);
  } finally {
    structuredSend = null;
    await server.stop(true);
    for (const [key, value] of [["LLV_VIEWER_CONTROL_URL", saved.url], ["LLV_VIEWER_DEPLOY_TARGET", saved.target], ["LLV_VIEWER_PORT", saved.port]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    isolatedRegistry.close();
    registry = previousRegistry.registry;
    recipient = previousRegistry.recipient;
    generationId = previousRegistry.generationId;
  }
});

/* #1866: a dispatched send nothing ever answered read `in-flight` under its
   original key for an hour, because the lookup never applied the settlement
   deadline; only `message_receipt` did. Past the deadline the lookup now ends
   it the same way. Before it, the lookup still only observes. */
test("an original-key lookup past the settlement deadline ends an accepted send instead of answering in flight", async () => {
  const text = "relay accepted and never answered";
  const key = sendDownstreamKey("overdue-accepted-send");
  const response = await send(key, text);
  expect(response.status).toBe(200);
  const { operationId } = await response.json() as { operationId: string };
  const reservation = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((held) => held.clientMessageId === key)!;
  /* Accepted while the recipient's host was reclaimed, and never dispatched. */
  expect(reservation.state).toBe("assigned");

  const lookupAt = (now: number) => viewerMcpRecoverableTools({
    registrySnapshot: () => registry.readOnlySnapshot(),
    sendSettlementPorts: () => ({ registry, client: null, now: () => now }),
  } as never).send_message!.recover(bindingFor(key), { legacy: false, args: { text } });

  const early = await lookupAt(Date.now());
  expect(early).toMatchObject({ outcome: "accepted", facts: { state: "in-flight" }, ids: { operationId } });
  expect(registry.readOnlySnapshot().heldDeliveries[reservation.id]?.state).toBe("assigned");

  const overdue = await lookupAt(Date.now() + 11 * 60_000);
  expect(overdue).toMatchObject({
    outcome: "settled",
    ids: { operationId },
    facts: { state: "failed", duplicateRisk: true },
  });
  expect(overdue.reason).toEqual(expect.any(String));
  /* The same answer `message_receipt` now gives, because the lookup wrote it. */
  expect(registry.readOnlySnapshot().heldDeliveries[reservation.id]?.state).toBe("failed");
});
