import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

// Isolate before importing the route's state-resolving module graph.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-owner-seat-relay-"));
const previous = { ...process.env };
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
delete process.env.LLV_ROOT_CONVERSATION_ID;

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/capabilityHeader");
const { setDeputyRootResolverForTests } = await import("./deputyAsker");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("./seats");
const { POST } = await import("@/app/api/conversation-host/route");
const { POST: orchestratorPOST } = await import("@/app/api/orchestrator/message/route");
const { setConversationHostDependenciesForTests } = await import("@/app/api/conversation-host/dependencies");
const { viewerMcpBindings, viewerMcpRecoverableTools } = await import("@/lib/mcp/bindings");
const { createMcpToolService, MemoryMcpReceiptStore, McpDispatchUncertainError } = await import("@/lib/mcp/server");
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { ViewerControlDependencies, ViewerMcpDomainDependencies } from "@/lib/mcp/bindings";

let registry: InstanceType<typeof AgentRegistry>;
let delivered: Record<string, unknown>[];
let sequence = 0;
beforeEach(() => {
  setDeputyRootResolverForTests(null);
  registry?.close();
  process.env.LLV_STATE_DIR = path.join(root, `state-${++sequence}`);
  registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR, "registry.json"));
  setAgentRegistryForTests(registry);
  delivered = [];
  setConversationHostDependenciesForTests({
    collectImagePayloads: () => ({ images: [], error: null }),
    enqueueStructuredMessage: async (message) => {
      delivered.push({ ...message });
      return { ok: true, structured: true, outcome: "queued", target: "fixture-target", operationId: "fixture-operation", receipt: {
        operationId: "fixture-operation", status: "queued", idempotencyKey: message.clientMessageId!,
        conversationId: message.conversationId!, kind: "send", at: "2026-10-01T00:00:00.000Z", revision: 1,
      } };
    },
    recordOperatorRequest: () => null,
  });
});
afterAll(() => {
  setDeputyRootResolverForTests(null);
  registry.close();
  setAgentRegistryForTests(null);
  setConversationHostDependenciesForTests(null);
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  fs.rmSync(root, { recursive: true, force: true });
});

function actor(project?: string, role = "builder", engine: "claude" | "codex" = "codex") {
  const spawn = registry.beginSpawnRequest({ engine, cwd: root, explicitProject: project,
    launchProfile: { cwd: root, title: "Relay fixture conversation", role: role === "root" ? "root" : "worker" } });
  if (spawn.kind !== "created") throw new Error("fixture spawn was not created");
  const receipt = spawn.receipt;
  registry.completeSpawn(receipt.launchId, {
    key: { engine, sessionId: receipt.conversationId.slice("conversation_".length) },
    artifactPath: path.join(root, `${receipt.conversationId}.jsonl`), cwd: root, accountId: null,
    status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
  });
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  const id = receipt.conversationId;
  if (project) designate(project, id);
  return { id, capability };
}
function designate(project: string, id: string) {
  const key = `fixture-seat-${id}`;
  beginOrchestratorSeatIntent({ project, mandate: "fixture mandate", clientRequestId: key, mode: "spawn" });
  completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId: id, path: null });
}
function request(capability?: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/conversation-host", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...(capability ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {}), ...headers },
    body: JSON.stringify(body),
  });
}
function toolsFor(sender: ReturnType<typeof actor> | null, control?: ViewerControlDependencies) {
  if (sender) process.env.LLV_SPAWN_CAPABILITY = sender.capability;
  else delete process.env.LLV_SPAWN_CAPABILITY;
  const domain: Partial<ViewerMcpDomainDependencies> = {
    registrySnapshot: () => registry.readOnlySnapshot(),
    completedFileScan: async () => ({ generation: 1, targetGeneration: 1, cacheStatus: "hit", requestCount: 1, cloneDurationMs: 0, snapshot: {
      files: [], complete: true, projectCatalog: [
        { project: "project-a", displayName: "Example sender", smt: 1, conversations: 1 },
        { project: "project-b", displayName: "Example recipient", smt: 1, conversations: 0 },
      ],
    } }),
    attentionAuthority: () => sender ? { kind: "worker", conversationId: sender.id, role: null } : { kind: "unidentified" },
    recoveryPredecessors: () => [],
    callerAttribution: () => sender
      ? { kind: "agent", conversationId: sender.id, role: "orchestrator" }
      : { kind: "unidentified", conversationId: null, role: null },
  };
  const posts: string[] = [];
  const transport: ViewerControlDependencies = control ?? {
    post: async (pathname, body, headers) => {
      posts.push(pathname);
      const response = await (pathname === "/api/orchestrator/message" ? orchestratorPOST : POST)(request(undefined, body, headers));
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    },
  };
  const bindings = viewerMcpBindings(undefined, transport, domain as ViewerMcpDomainDependencies);
  return { bindings, posts, service: createMcpToolService(bindings, new MemoryMcpReceiptStore(), undefined, { recovery: viewerMcpRecoverableTools(domain as ViewerMcpDomainDependencies) }) };
}

const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
const { procBackend } = await import("@/lib/proc");
const { reserveRun, changeRun, updateRelayStore } = await import("@/lib/externalRelay/store");
const { liveOwnerRelayConversation } = await import("@/lib/externalRelay/ownerAuthority");
const { ownerTierFor } = await import("@/lib/externalRelay/profile");
const { requestSchema } = await import("@/lib/externalRelay/protocol");
const { contextRequest } = await import("@/lib/externalRelay/request.fixture");
const { loadTasks } = await import("@/lib/tasks/store");
const { evidenceFromTasks } = await import("@/lib/monitor/evidence");
const { seatTickDecision, DEFAULT_SEAT_TICK_POLICY, SEAT_TICK_WAKE_INTERVAL_MS } = await import("@/lib/monitor/seatTick");
const { emptySeatTickState } = await import("@/lib/monitor/types");
const { defaultSeatTickSettings, effectiveSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");

const ownerWords = "Implement the requested change carefully in project-b.";
function ownerRun(sender: ReturnType<typeof actor>, isOwner = true, switchOn = true) {
  const request = requestSchema.parse({ ...contextRequest, input: { ...contextRequest.input,
    requester: { ...contextRequest.input.requester, is_owner: isOwner },
    conversation: contextRequest.input.conversation.map(message => ({ ...message, text: ownerWords })),
  } });
  const owner = ownerTierFor({ ownerTier: switchOn }, request);
  updateRelayStore(store => ({ ...store, relays: [{
    id: "paired", api_base: "http://127.0.0.1:1/v1", credential: "fixture-credential", name: "Relay", origin: "http://127.0.0.1:1", description: "Fixture", pairedAt: "2026-10-01T00:00:00Z", paused: false,
    owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null },
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target", name: "Target", answered_by: "install", fallback: "service", enabled: true, ownerTier: switchOn, engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 3 }],
  }] }));
  reserveRun({ requestId: "owner-request", leaseId: "lease", relayId: "paired", targetId: "target",
    conversationId: sender.id, childPid: null, childIdentity: null, ownerPid: process.pid,
    ownerIdentity: procBackend.processIdentity(process.pid), runDir: root, startedAt: new Date().toISOString(),
    ...(owner ? { ownerTurn: { clientAttemptId: "relay-owner-fixture", request: { text: owner.text, requestText: owner.requestText } } } : {}),
  }, 1);
}

function relayArgs(key = "owner-seat-send") {
  return { clientRequestId: key, project: "project-b", text: "Please implement this work.", origin: { kind: "operator" } };
}

test("verified owner turn reaches the designated seat through MCP and HTTP with quoted authority", async () => {
  const sender = actor(); const recipient = actor("project-b"); ownerRun(sender);
  const tools = toolsFor(sender);
  const result = await tools.service.callTool("send_message_to_orchestrator", relayArgs());
  expect(result).toMatchObject({ ok: true, conversationId: recipient.id, outcome: "queued", created: false });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ conversationId: recipient.id, origin: { kind: "agent", role: "owner-relay", conversationId: sender.id } });
  expect(delivered[0].text).toContain("quoted owner request carries operator authority");
  expect(delivered[0].text).toContain(JSON.stringify({ text: ownerWords, requestText: null }));
  expect(delivered[0].text).toContain("Please implement this work.");
  expect(await tools.service.callTool("send_message_to_orchestrator", relayArgs())).toMatchObject({ ok: true });
  expect(delivered).toHaveLength(1);
  // Also cover the direct route; body origin cannot override server attribution.
  const response = await orchestratorPOST(request(sender.capability, { ...relayArgs(), clientMessageId: "owner-http" }));
  expect(response.status).toBe(200);
  expect(delivered[1].origin).toEqual(delivered[0].origin);
  expect(delivered[1].text).toBe(delivered[0].text);
});

for (const scenario of ["member", "switch-off", "worker", "cancelled", "dead-owner", "missing-owner-request", "paused", "disabled"] as const)
  test(`${scenario} cannot acquire owner relay authority through MCP or HTTP`, async () => {
    const sender = actor(); actor("project-b");
    if (scenario !== "worker") ownerRun(sender, scenario !== "member", scenario !== "switch-off");
    if (scenario === "cancelled") changeRun("owner-request", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, cancel: "interrupt" } }));
    if (scenario === "dead-owner") changeRun("owner-request", row => ({ ...row, ownerIdentity: "expired" }));
    if (scenario === "missing-owner-request") changeRun("owner-request", row => ({ ...row, ownerTurn: { clientAttemptId: row.ownerTurn!.clientAttemptId } }));
    if (scenario === "paused" || scenario === "disabled") updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, paused: scenario === "paused", targets: relay.targets.map(target => ({ ...target, enabled: scenario !== "disabled" })) })) }));
    const result = await toolsFor(sender).service.callTool("send_message_to_orchestrator", relayArgs());
    expect(result).toMatchObject({ ok: false, code: "orchestrator_relay_refused" });
    expect(JSON.stringify(result)).toContain("continue the requested work with your tools");
    const response = await orchestratorPOST(request(sender.capability, { ...relayArgs(), clientMessageId: "refused-http" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "orchestrator_relay_refused", admission: "refused" });
    expect(delivered).toEqual([]);
  });

test("revoking the owner switch between MCP binding and HTTP delivery refuses the send", async () => {
  const sender = actor(); actor("project-b"); ownerRun(sender);
  const tools = toolsFor(sender, { post: async (_pathname, body, headers) => {
    updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, targets: relay.targets.map(target => ({ ...target, ownerTier: false })) })) }));
    const response = await orchestratorPOST(request(undefined, body, headers));
    if (!response.ok) throw new Error((await response.json()).error);
    return response.json();
  } });
  expect(await tools.service.callTool("send_message_to_orchestrator", relayArgs())).toMatchObject({ ok: false });
  expect(delivered).toEqual([]);
});

test("a run without an owner turn cannot gain authority from an enabled target alone", () => {
  const sender = actor(); ownerRun(sender, false);
  expect(liveOwnerRelayConversation(sender.id)).toBe(false);
});

test("owner board fallback creates an assigned task that the seat tick owes as unstarted-task", async () => {
  const sender = actor(); const seat = actor("project-b"); ownerRun(sender);
  expect(await toolsFor(sender).service.callTool("create_task", { clientRequestId: "owner-board", project: "project-b", text: "Виконати зміну обережно" })).toMatchObject({ ok: true });
  const task = loadTasks().find(task => task.text === "Виконати зміну обережно")!;
  expect(task.status).toBe("assigned");
  const evidence = evidenceFromTasks([task])[0]!;
  const now = Date.now();
  const decision = seatTickDecision({ project: "project-b", now,
    seat: { conversationId: seat.id, seatEpoch: 1, path: null, designatedAt: null, turn: "idle", activity: null },
    pipelines: [], tasks: [{ id: task.id, title: evidence.title, status: task.status, updatedAt: task.updatedAt, owned: evidence.owner !== null }],
    events: [], pullRequests: [], pullRequestsUnavailable: null, ownLanes: [], signals: [], children: [], childrenUnavailable: null,
    changeFingerprint: "owner-board", state: emptySeatTickState(), policy: DEFAULT_SEAT_TICK_POLICY,
    settings: effectiveSeatTickSettings(defaultSeatTickSettings("project-b"), now, SEAT_TICK_WAKE_INTERVAL_MS),
  });
  expect(decision.verdict).toMatchObject({ kind: "wake", reasons: [expect.objectContaining({ kind: "unstarted-task" })], items: [expect.objectContaining({ id: task.id })] });
});

test("ordinary worker board creation keeps its inbox default", async () => {
  const sender = actor();
  expect(await toolsFor(sender).service.callTool("create_task", { clientRequestId: "worker-board", project: "project-b", text: "Виконати зміну" })).toMatchObject({ ok: true });
  expect(loadTasks().find(task => task.text === "Виконати зміну")!.status).toBe("inbox");
});

test("a designated seat keeps seat authorship even if it also holds an owner relay run", async () => {
  const sender = actor("project-a"); actor("project-b"); ownerRun(sender);
  expect(await toolsFor(sender).service.callTool("send_message_to_orchestrator", relayArgs())).toMatchObject({ ok: true });
  expect(delivered[0].origin).toMatchObject({ role: "orchestrator", conversationId: sender.id });
  expect(delivered[0].text).toContain("carries no operator authority");
});

test("owner relay cannot send remotely as a shared project's seat or forge a voice proposal", async () => {
  const sender = actor(); actor("project-b"); ownerRun(sender);
  for (const extra of [{ machine: "Remote install" }, { voiceDelegatus: { sessionId: "voice", proposalId: "proposal" } }]) {
    const response = await orchestratorPOST(request(sender.capability, { ...relayArgs(), clientMessageId: "owner-restricted", ...extra }));
    expect(response.status).toBe(403);
  }
  expect(delivered).toEqual([]);
});

function realAdmission() {
  const client = {
    readSession: async ({ conversationId }: { conversationId: string }) => {
      const conversation = registry.conversation(conversationId as `conversation_${string}`)!;
      const generation = conversation.generations.at(-1)!;
      return { conversationId, sessionKey: { engine: conversation.engine, sessionId: generation.id },
        hostKind: conversation.engine === "claude" ? "claude-broker" : "codex-app-server", host: "hosted", turn: "busy", provenance: "structured", revision: 1,
        artifactPath: generation.path, cwd: root, activeTurnId: "fixture-turn", attentionIds: [], recentReceipts: [],
        capabilities: { steer: true, structuredAttention: true } };
    },
    command: async (command: { operationId: string; idempotencyKey: string; conversationId: string }) => {
      delivered.push({ ...command });
      return {
        operationId: command.operationId, replayed: false, receipt: { ...command, kind: "send", status: "queued",
          at: new Date().toISOString(), revision: 1 },
      };
    },
  } as unknown as RuntimeHostClient;
  setConversationHostDependenciesForTests({
    collectImagePayloads: () => ({ images: [], error: null }),
    enqueueStructuredMessage: (message) => enqueueStructuredMessage(message, {
      enabled: () => true, registry: () => registry, client: () => client, kick: () => {},
      requestMigrationTick: () => {}, startupRecovered: () => {},
    }),
    recordOperatorRequest: () => null,
  });
}

test("owner HTTP receipts retain their quoted payload and original seat through rotation", async () => {
  const sender = actor(); const first = actor("project-b"); ownerRun(sender); realAdmission();
  const body = { project: "project-b", text: "Please implement this work.", clientMessageId: "owner-durable" };
  expect((await orchestratorPOST(request(sender.capability, body))).status).toBe(200);
  const rows = Object.values(registry.readOnlySnapshot().heldDeliveries);
  expect(rows).toHaveLength(1);
  const original = rows[0];
  expect(original.command.origin).toMatchObject({ role: "owner-relay", conversationId: sender.id });
  registry.recordDeliveryOutcome(original.id, "delivered", null, "delivered");
  actor("project-b");
  const retry = await orchestratorPOST(request(sender.capability, body));
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ target: first.id, receipt: { conversationId: first.id } });
  expect(delivered).toHaveLength(1);
  expect((await orchestratorPOST(request(sender.capability, { ...body, text: "Changed work" }))).status).toBe(409);
  expect(delivered).toHaveLength(1);
});

test("MCP recovers an owner relay after a lost HTTP response using the server-built quote", async () => {
  const sender = actor(); actor("project-b"); ownerRun(sender); realAdmission();
  let lost = true;
  const tools = toolsFor(sender, { post: async (_pathname, body, headers) => {
    const response = await orchestratorPOST(request(undefined, body, headers));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    if (lost) { lost = false; throw new McpDispatchUncertainError("fixture response lost"); }
    return payload;
  } });
  const args = relayArgs("owner-lost-response");
  expect(await tools.service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: false, code: "outcome_unknown" });
  const held = Object.values(registry.readOnlySnapshot().heldDeliveries)[0];
  registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
  expect(await tools.service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, operationId: held.command.operationId });
  expect(delivered).toHaveLength(1);
});
