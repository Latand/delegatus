import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { formatGuide } from "@/lib/externalRelay/rich.fixture";
import { ownerIntentFixture, startTestRelay } from "@/lib/externalRelay/testRelay";

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
const { viewerMcpBindings, viewerMcpRecoverableTools, viewerMcpToolPolicy } = await import("@/lib/mcp/bindings");
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

function actor(project?: string, role = "builder", engine: "claude" | "codex" = "codex", handoffOnly = false) {
  const spawn = registry.beginSpawnRequest({ engine, cwd: root, explicitProject: project,
    launchProfile: { cwd: root, title: "Relay fixture conversation", role: role === "root" ? "root" : "worker",
      ...(handoffOnly ? { ownerRelayHandoffOnly: true } : {}) } });
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
function toolsFor(sender: ReturnType<typeof actor> | null, control?: ViewerControlDependencies, onAttribution?: () => void) {
  if (sender) process.env.LLV_SPAWN_CAPABILITY = sender.capability;
  else delete process.env.LLV_SPAWN_CAPABILITY;
  const domain: Partial<ViewerMcpDomainDependencies> = {
    registrySnapshot: () => registry.readOnlySnapshot(),
    loadTasks: () => [],
    completedFileScan: async () => ({ generation: 1, targetGeneration: 1, cacheStatus: "hit", requestCount: 1, cloneDurationMs: 0, snapshot: {
      files: [], complete: true, projectCatalog: [
        { project: "project-a", displayName: "Example sender", smt: 1, conversations: 1 },
        { project: "project-b", displayName: "Example recipient", smt: 1, conversations: 0 },
      ],
    } }),
    attentionAuthority: () => sender ? { kind: "worker", conversationId: sender.id, role: null } : { kind: "unidentified" },
    recoveryPredecessors: () => [],
    callerAttribution: () => {
      onAttribution?.();
      return sender ? { kind: "agent", conversationId: sender.id, role: "orchestrator" }
        : { kind: "unidentified", conversationId: null, role: null };
    },
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
  return { bindings, posts, service: createMcpToolService(bindings, new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as ViewerMcpDomainDependencies), { recovery: viewerMcpRecoverableTools(domain as ViewerMcpDomainDependencies) }) };
}

const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
const { procBackend } = await import("@/lib/proc");
const { reserveRun, changeRun, dropRun, readRunLedger, updateRelayStore } = await import("@/lib/externalRelay/store");
const { liveOwnerRelayConversation } = await import("@/lib/externalRelay/ownerAuthority");
const { ownerTierFor } = await import("@/lib/externalRelay/profile");
const { runOwnerAgent } = await import("@/lib/externalRelay/ownerRun");
const { structuredHostAccessPolicy } = await import("@/lib/runtime/structuredSpawn");
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

test("ordinary Viewer reads skip seat and deputy attribution", async () => {
  const sender = actor();
  let resolutions = 0;
  const service = toolsFor(sender, undefined, () => { resolutions++; }).service;
  expect(await service.callTool("list_tasks", { project: "project-b" })).toMatchObject({ ok: true });
  expect(resolutions).toBe(0);
});

test("guest owner Viewer permissions require durable intent and survive pause and settlement", async () => {
  const sender = actor(undefined, "builder", "codex", true);
  actor("project-b");
  ownerRun(sender);
  const service = toolsFor(sender).service;
  const handoff = (key: string) => service.callTool("send_message_to_orchestrator", {
    clientRequestId: key, project: "project-b", text: "Please send the quoted owner request to this seat.",
  });
  const assertOrdinaryDenied = async () => {
    expect(await service.callTool("list_tasks", { project: "project-b" })).toMatchObject({
      ok: false, code: "tool_not_permitted",
    });
  };
  changeRun("owner-request", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, rawRequest: { delivery: "guest" } } }));
  await assertOrdinaryDenied();
  expect(await handoff("guest-handoff-without-proof")).toMatchObject({ ok: false });
  expect(delivered).toEqual([]);
  changeRun("owner-request", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, seatHandoff: true } }));
  expect(await handoff("live-owner-handoff")).toMatchObject({ ok: true, project: "project-b" });
  await assertOrdinaryDenied();
  updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, paused: true })) }));
  await assertOrdinaryDenied();
  expect(await handoff("paused-owner-handoff")).toMatchObject({ ok: false });
  dropRun("owner-request");
  await assertOrdinaryDenied();
  expect(await handoff("settled-owner-handoff")).toMatchObject({ ok: false });
});

test("a native guest handoff reads its ready attachment and delivers its description to the seat", async () => {
  const { runClaimedRequest, externalRelayTempRoot } = await import("@/lib/externalRelay/runner");
  const { ownerRunRoot } = await import("@/lib/externalRelay/runDirectory");
  const { readRelayStore } = await import("@/lib/externalRelay/store");
  const { accountManager } = await import("@/lib/accounts/manager");
  const attachment = Buffer.from("Moderation issue details\n");
  const sender = actor(undefined, "builder", "codex", true);
  const seat = actor("project-b");
  ownerRun(sender);
  dropRun("owner-request");
  const source = contextRequest.input.conversation[0]!;
  const ref = "ready_project_attachment";
  const description = "The moderation panel still shows the matching post.";
  const words = "Could you have them look into this?";
  const request = requestSchema.parse({ ...contextRequest, target_id: "target", request_id: "ready_attachment_handoff", delivery: "guest",
    features: ["requester_context", "relay_media_in"], answer: { ...contextRequest.answer, progress: "none" },
    input: { ...contextRequest.input, respond_to: "owner-message", request_text: words,
      requester: { ...contextRequest.input.requester, is_owner: true },
      tools: contextRequest.input.tools.filter(tool => tool.mode === "handoff"),
      conversation: [
        { ...source, id: "linked-issue", text: "The example project has a moderation regression.", reply_to: null,
          media: [{ ref, kind: "document", availability: "ready", mime_type: "text/plain", filename: "report.txt",
            byte_size: attachment.length, expires_at: "2099-01-01T00:00:00Z" }] },
        { ...source, id: "owner-message", text: words, reply_to: "linked-issue" },
      ],
      documents: [{ title: "Report", text: description, message_id: "linked-issue", media_ref: ref, extraction: "complete" }],
    },
  });
  let downloads = 0;
  const server = await startTestRelay(req => {
    if (!req.url?.endsWith(`/media/${ref}`)) return { body: { status: "ok" } };
    downloads++;
    return { headers: { "content-type": "text/plain", "content-length": String(attachment.length) }, raw: attachment };
  });
  updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({
    ...relay, origin: server.origin, api_base: `${server.origin}/v1`,
    targets: relay.targets.map(target => ({ ...target, engine: "claude", model: "fixture", project: "project-b" })),
  })) }));
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "claude", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { ...process.env },
  } });
  const service = toolsFor(sender).service;
  let handoffPrompt = "";
  try {
    const result = await runClaimedRequest(readRelayStore().relays[0]!, request, undefined, {
      leaseWorker: false, ownerIntentCommand: ownerIntentFixture(root, true),
      ownerPorts: {
        launch: async input => {
          handoffPrompt = String(input.prompt);
          const cwd = String(input.cwd);
          const dir = fs.realpathSync(ownerRunRoot());
          expect(path.dirname(cwd)).toBe(dir);
          expect(dir).not.toBe(externalRelayTempRoot());
          const [media] = promptSection<Array<{ ref: string; local_path: string }>>(handoffPrompt, "inbound_media");
          expect(media?.ref).toBe(ref);
          const relative = path.relative(cwd, media!.local_path);
          expect(relative).toMatch(/^media-/);
          // A separate native process reads the path using the worker's launch cwd.
          const native = Bun.spawn([process.execPath, "-e", "process.stdout.write(require('fs').readFileSync(process.argv[1]))", relative],
            { cwd, stdout: "pipe", stderr: "pipe" });
          expect(Buffer.from(await new Response(native.stdout).arrayBuffer())).toEqual(attachment);
          expect(await native.exited).toBe(0);
          return { status: 202, body: { conversationId: sender.id } };
        },
        observe: async () => {
          const documents = promptSection<Array<{ title: string; text: string }>>(handoffPrompt, "documents");
          expect(documents).toContainEqual(expect.objectContaining({ title: "Report", text: description }));
          expect(await service.callTool("send_message_to_orchestrator", {
            clientRequestId: "ready-attachment-seat-handoff", project: "project-b",
            text: documents.map(document => `${document.title}: ${document.text}`).join("\n"),
          })).toMatchObject({ ok: true, project: "project-b", conversationId: seat.id });
          return { state: "ended", finalText: "Queued for the project-b orchestrator.\nExtra explanation." };
        },
        stop: async () => {}, pollMs: 1,
      },
    });
    expect(downloads).toBe(1);
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "Queued for the project-b orchestrator.", reply_to: null } });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain(JSON.stringify({ text: words, requestText: words }));
    expect(delivered[0]?.text).toContain(description);
  } finally { selection.mockRestore(); await server.close(); }
}, 30_000);

function promptSection<T>(prompt: string, name: string): T {
  const match = prompt.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`));
  if (!match) throw new Error(`owner prompt is missing ${name}`);
  return JSON.parse(match[1]!) as T;
}

for (const finalText of ["[ignore]", "", "   ", null])
  test(`a refused owner handoff followed by ${JSON.stringify(finalText)} reports an actionable outcome`, async () => {
    const sender = actor(); const source = actor("project-b"); actor("project-a"); ownerRun(sender);
    const report = { project: "project-b", sourceSeat: source.id, reportId: "report", reportText: "Proceed with the requested change?" };
    changeRun("owner-request", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, bridgeReport: report } }));
    const ownerRequest = requestSchema.parse({ ...contextRequest, request_id: "owner-request", answer: { ...contextRequest.answer, max_chars: 4000 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true },
        conversation: contextRequest.input.conversation.map(message => ({ ...message, text: ownerWords })),
      },
    });
    const owner = { ...ownerTierFor({ ownerTier: true }, ownerRequest)!, bridgeReport: report };
    const tools = toolsFor(sender);
    const result = await runOwnerAgent({ request: ownerRequest, owner, accountId: "fixture",
      target: { id: "target", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 3 },
      hardCapMs: 2000, onConversation: () => {}, ports: {
        launch: async () => ({ status: 202, body: { conversationId: sender.id } }),
        observe: async () => {
          const refusal = await tools.service.callTool("send_message_to_orchestrator", { ...relayArgs("refused-owner-outcome"), project: "project-a" });
          expect(refusal).toMatchObject({ ok: false, code: "owner_report_seat_unavailable" });
          return { state: "ended", finalText };
        },
        stop: async () => { throw new Error("a settled turn needs no cancellation"); },
      },
    }).done;
    expect(delivered).toEqual([]);
    expect(result).toMatchObject({ status: "done", answer: { action: "reply", reply_to: owner.messageId } });
    const answer = result.answer as { text: string };
    expect(answer.text).toContain("without reporting completion or a successful handoff");
    expect(answer.text).toContain("Open the project's orchestrator seat and resend your request there");
  });

test("verified owner turn reaches the designated seat through MCP and HTTP with quoted authority", async () => {
  const sender = actor(); const recipient = actor("project-b"); ownerRun(sender);
  const tools = toolsFor(sender);
  const result = await tools.service.callTool("send_message_to_orchestrator", relayArgs());
  expect(result).toMatchObject({ ok: true, conversationId: recipient.id, outcome: "queued", created: false });
  expect(readRunLedger().runs.find(run => run.requestId === "owner-request")?.ownerTurn?.handoffOutcome)
    .toMatchObject({ status: "accepted", project: "project-b", code: null });
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

for (const cloudTarget of [false, true]) for (const pairedProject of ["project-b", "project-a", "unknown-project", null] as const) for (const delivery of ["owner", "guest"] as const) {
  test(`${delivery} ${cloudTarget ? "Cloud " : ""}group request with paired project ${pairedProject ?? "unset"}`, async () => {
    const { runClaimedRequest } = await import("@/lib/externalRelay/runner");
    const { readRelayStore, readRunLedger, dropRun } = await import("@/lib/externalRelay/store");
    const { accountManager } = await import("@/lib/accounts/manager");
    const sender = actor(undefined, "builder", "codex", delivery === "guest");
    const recipient = actor("project-b");
    actor("project-a");
    ownerRun(sender);
    dropRun("owner-request");
    const server = await startTestRelay(() => ({ body: { status: "ok" } }));
    updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({
      ...relay, origin: server.origin, api_base: `${server.origin}/v1`,
      targets: relay.targets.map(target => ({ ...target, project: pairedProject,
        ...(cloudTarget ? { engine: "codex-cloud" as const, cloudEnvironmentId: "fixture-cloud-environment" } : {}) })),
    })) }));
    const paired = readRelayStore().relays[0]!;
    const words = "Could you have them look into this?";
    const linkedIssueText = "In Example recipient, the blacklist phrase still leaves matching messages visible.";
    const screenshotDescription = "Screenshot description: the moderation panel still shows the matching post.";
    const message = contextRequest.input.conversation[0]!;
    const projectKey = pairedProject ?? "unset";
    const wire = requestSchema.parse({ ...contextRequest, ...(delivery === "guest" ? { delivery: "guest" } : {}), target_id: "target", request_id: `owner-request-${delivery}-${projectKey}`,
      chat: { key: "fixture_group_chat" }, answer: { max_chars: delivery === "owner" ? 32000 : 1000, progress: "none" },
      ...(delivery === "owner" ? { features: ["relay_rich_messages"] } : {}),
      input: { ...contextRequest.input, ...(delivery === "owner" ? { format: formatGuide } : {}),
        ...(delivery === "guest" ? { tools: contextRequest.input.tools.filter(tool => tool.mode === "handoff") } : {}),
        requester: { ...contextRequest.input.requester, is_owner: true },
        respond_to: "owner-message", conversation: [
          { ...message, id: "linked-issue", text: linkedIssueText, reply_to: null },
          { ...message, id: "owner-message", text: words, reply_to: "linked-issue" },
        ],
        documents: [{ title: "Screenshot", text: screenshotDescription, message_id: "linked-issue", extraction: "complete" }],
      },
    });
    const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
      engine: "codex", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { ...process.env },
    } });
    fs.writeFileSync(path.join(root, "auth.json"), "{}");
    fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({ models: [{ slug: "auto" }] }));
    const tools = toolsFor(sender);
    let launchPrompt = "", cloudCalls = 0;
    const send = { clientRequestId: `group-owner-handoff-${delivery}-${projectKey}`, text: "",
      ...(["project-a", null].includes(pairedProject) ? { project: "project-b" } : {}) };
    const accepted = "Queued for the Example recipient orchestrator.";
    const question = "Which project should receive this?";
    try {
      const result = await runClaimedRequest(paired, wire, undefined, { timeoutMs: 10000, ownerIntentCommand: ownerIntentFixture(root, true), ownerPorts: {
        launch: async input => {
          launchPrompt = String(input.prompt);
          expect(input.mcpServers).toEqual(["viewer"]);
          if (delivery === "guest") {
            expect(input).toMatchObject({ ownerRelayHandoffOnly: true, plugins: [] });
            expect(structuredHostAccessPolicy({ readOnly: true, sandbox: "restricted", ownerRelayHandoffOnly: true }))
              .toEqual({ readOnly: true, sandbox: "restricted", ownerRelayHandoffOnly: true });
          }
          return { status: 202, body: { conversationId: sender.id } };
        },
        observe: async () => {
          const replyContext = promptSection<{ message_id: string }>(launchPrompt, "owner_reply_context");
          const conversation = promptSection<Array<{ id: string; text?: string }>>(launchPrompt, "conversation");
          const documents = promptSection<Array<{ title: string; text: string }>>(launchPrompt, "documents");
          const linkedIssue = conversation.find(row => row.id === replyContext.message_id);
          expect(linkedIssue?.text).toBe(linkedIssueText);
          expect(documents).toContainEqual(expect.objectContaining({ title: "Screenshot", text: screenshotDescription }));
          send.text = `${linkedIssue!.text}\n\n${documents.map(document => `${document.title}: ${document.text}`).join("\n")}`;
          if (delivery === "guest") {
            expect(await tools.service.callTool("list_tasks", { project: "project-b" })).toMatchObject({
              ok: false, code: "tool_not_permitted",
            });
          }
          const handoff = await tools.service.callTool("send_message_to_orchestrator", send);
          if (pairedProject === "project-b" || pairedProject === "project-a" || pairedProject === null) {
            expect(handoff).toMatchObject({ ok: true, project: "project-b", conversationId: recipient.id, outcome: "queued" });
            // The admitted operation keeps its project when the target setting changes.
            updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({
              ...relay, targets: relay.targets.map(target => ({ ...target, project: "project-a" })),
            })) }));
            expect(await tools.service.callTool("send_message_to_orchestrator", send))
              .toMatchObject({ ok: true, project: "project-b", replayed: true });
          } else {
            expect(handoff).toMatchObject({ ok: false, code: pairedProject ? "unknown_project" : "project_required" });
          }
          expect(readRunLedger().runs.find(run => run.requestId === wire.request_id)?.ownerTurn?.handoffOutcome)
            .toMatchObject({ status: handoff.ok ? "accepted" : "refused", project: handoff.ok ? "project-b" : pairedProject, code: handoff.ok ? null : expect.any(String) });
          const outcome = handoff.ok ? accepted : question;
          return { state: "ended", finalText: `${outcome}\n\nThis extra analysis must never be published.\nA third verbose line.` };
        }, stop: async () => {}, pollMs: 1,
      }, cloudTransport: async () => { cloudCalls++; return JSON.stringify({ action: "reply", text: "Cloud answer", reply_to: "owner-message" }); } });
      expect(cloudCalls).toBe(0);
      expect(result).toMatchObject({ outcome: "answered", answer: {
        action: "reply", reply_to: delivery === "guest" ? null : "owner-message", text: pairedProject === "unknown-project" ? question : accepted,
        ...(delivery === "owner" ? { format: "rich_markdown" } : {}),
      } });
      if (pairedProject === "unknown-project") {
        expect(delivered).toEqual([]);
        expect(tools.posts).toEqual([]);
      } else {
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({ conversationId: recipient.id, origin: { kind: "agent", role: "owner-relay", conversationId: sender.id } });
        expect(delivered[0].text).toContain(JSON.stringify({ text: words, requestText: null }));
        expect(delivered[0].text).toContain(linkedIssueText);
        expect(delivered[0].text).toContain(screenshotDescription);
      }
    } finally { select.mockRestore(); await server.close(); }
  }, 20000);
}

test("an owner report reply carries verbatim approval and stored report only to its source seat", async () => {
  const sender = actor(); const recipient = actor("project-b"); const otherSeat = actor("project-a"); ownerRun(sender);
  const reportText = "Create a clone with one button? Confirm the start.";
  changeRun("owner-request", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, request: { text: "/ai го", requestText: "го" },
    bridgeReport: { project: "project-b", sourceSeat: recipient.id, reportId: "report", reportText } } }));
  const tools = toolsFor(sender);
  expect(await tools.service.callTool("send_message_to_orchestrator", relayArgs("report-reply"))).toMatchObject({ ok: true, conversationId: recipient.id });
  expect(delivered[0].text).toContain(JSON.stringify({ text: "/ai го", requestText: "го" }));
  expect(delivered[0].text).toContain(reportText);
  expect(await tools.service.callTool("send_message_to_orchestrator", { ...relayArgs("wrong-report-seat"), project: "project-a" })).toMatchObject({ ok: false, code: "owner_report_seat_unavailable" });
  const response = await orchestratorPOST(request(sender.capability, { project: "project-a", conversationId: otherSeat.id, text: "go", clientMessageId: "wrong-report-http" }));
  expect(response.status).toBe(409);
  expect(delivered).toHaveLength(1);
});

for (const approval of [false, true])
  test(`runner routes ${approval ? "an explicit approval reply to its report seat" : "an independent instruction past an unrelated report"} through MCP and HTTP`, async () => {
    const { Database } = await import("bun:sqlite");
    const { appendBridgeReports, recordBridgeReportTelegram } = await import("@/lib/bridge/store");
    const { recordPublishedRelayReference } = await import("@/lib/externalRelay/publishedReferences");
    const { readRelayStore, readRunLedger, dropRun } = await import("@/lib/externalRelay/store");
    const { runClaimedRequest } = await import("@/lib/externalRelay/runner");
    const { accountManager } = await import("@/lib/accounts/manager");
    const sender = actor(); const recipient = actor("project-a"); const source = actor("project-b");
    ownerRun(sender);
    dropRun("owner-request");
    const server = await startTestRelay(() => ({ body: { status: "ok" } }));
    updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, origin: server.origin, api_base: `${server.origin}/v1` })) }));
    const paired = readRelayStore().relays[0]!;
    const chatId = String(2 ** 6), messageId = 2 ** 5;
    const directory = path.join(process.env.LLV_STATE_DIR!, "telegram");
    fs.mkdirSync(directory, { recursive: true });
    const db = new Database(path.join(directory, "bot.sqlite"));
    db.exec("CREATE TABLE chats (chat_id TEXT PRIMARY KEY, alias TEXT)");
    db.query("INSERT INTO chats VALUES (?, ?)").run(chatId, "report-room");
    db.close();
    const reportText = "Implement the previously reported feature in project-b?";
    const at = "2026-10-11T12:00:00Z";
    const report = appendBridgeReports([{ key: "preceding-report", project: "project-b", targetSeatConversationId: source.id,
      origin: { kind: "manager", conversationId: source.id, role: "orchestrator" }, class: "question", at, body: reportText,
      telegram: { chat: "report-room", html: reportText } }]).appended[0];
    recordBridgeReportTelegram(report.id, { state: "sent", messageIds: [messageId], at });
    recordPublishedRelayReference(paired.api_base, "/targets/target/messages", "POST", { chat_id: Number(chatId), message_id: messageId }, 200,
      { message_key: "preceding-report", replayed: false });
    const words = approval ? "go ahead" : "Implement the new feature in project-a.";
    const wire = requestSchema.parse({ ...contextRequest, target_id: "target", request_id: "owner-request",
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true }, request_text: words, respond_to: "owner-message",
        conversation: [
          { ...contextRequest.input.conversation[0], id: "preceding-report", text: reportText, author: { ...contextRequest.input.conversation[0]!.author, self: true } },
          { ...contextRequest.input.conversation[0], id: "owner-message", text: `/ai ${words}`, reply_to: approval ? "preceding-report" : null },
        ],
      },
    });
    const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
      engine: "codex", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { ...process.env },
    } });
    const tools = toolsFor(sender);
    let launchPrompt = "";
    let custody: ReturnType<typeof readRunLedger>["runs"][number]["ownerTurn"];
    let handoff: unknown;
    let wrongSeat: unknown;
    try {
      const result = await runClaimedRequest(paired, wire, undefined, { timeoutMs: 10000, ownerPorts: {
        launch: async input => {
          launchPrompt = String(input.prompt);
          return { status: 202, body: { conversationId: sender.id } };
        },
        observe: async () => {
          custody = readRunLedger().runs.find(run => run.requestId === wire.request_id)!.ownerTurn!;
          const project = approval ? "project-b" : "project-a";
          handoff = await tools.service.callTool("send_message_to_orchestrator", { ...relayArgs("runner-owner-send"), project });
          if (approval) wrongSeat = await tools.service.callTool("send_message_to_orchestrator", { ...relayArgs("runner-wrong-seat"), project: "project-a" });
          return { state: "ended", finalText: `Handed the request to ${project}.` };
        }, stop: async () => {}, pollMs: 1,
      } });
      expect(handoff).toMatchObject({ ok: true, conversationId: approval ? source.id : recipient.id });
      expect(custody?.request).toEqual({ text: `/ai ${words}`, requestText: words });
      expect(launchPrompt).toContain(words);
      if (approval) {
        expect(custody?.bridgeReport).toMatchObject({ project: "project-b", sourceSeat: source.id });
        expect(launchPrompt).toContain(reportText);
        expect(wrongSeat).toMatchObject({ ok: false, code: "owner_report_seat_unavailable" });
      } else {
        expect(custody?.bridgeReport).toBeUndefined();
        expect(launchPrompt).not.toContain('"sourceSeat"');
      }
      expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: "owner-message" } });
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toContain(JSON.stringify({ text: `/ai ${words}`, requestText: words }));
      expect(delivered[0].origin).toMatchObject({ kind: "agent", role: "owner-relay", conversationId: sender.id });
      if (approval) expect(delivered[0].text).toContain(reportText);
      else expect(delivered[0].text).not.toContain(reportText);
    } finally { select.mockRestore(); await server.close(); }
  }, 20000);

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
  expect(await toolsFor(sender).service.callTool("create_task", withTaskDue({ clientRequestId: "owner-board", project: "project-b", text: "Виконати зміну обережно" }))).toMatchObject({ ok: true });
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
  expect(decision.verdict).toMatchObject({ kind: "wake", reasons: [expect.objectContaining({ kind: "unstarted-task" })],
    taskPage: { rows: [expect.objectContaining({ item: expect.objectContaining({ id: task.id }) })] } });
});

test("ordinary worker board creation keeps its inbox default", async () => {
  actor("project-b");
  const sender = actor();
  expect(await toolsFor(sender).service.callTool("create_task", withTaskDue({ clientRequestId: "worker-board", project: "project-b", text: "Виконати зміну" }))).toMatchObject({ ok: true });
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
  expect(await tools.service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, recovered: true });
  const held = Object.values(registry.readOnlySnapshot().heldDeliveries)[0];
  registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
  expect(await tools.service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, operationId: held.command.operationId });
  expect(delivered).toHaveLength(1);
});

test("a report reply recovers its original seat after rotation and refuses fresh work", async () => {
  const sender = actor(); const source = actor("project-b"); ownerRun(sender); realAdmission();
  changeRun("owner-request", row => ({ ...row, ownerTurn: { ...row.ownerTurn!, request: { text: "/ai го", requestText: "го" },
    bridgeReport: { project: "project-b", sourceSeat: source.id, reportId: "report", reportText: "Proceed with clone creation?" } } }));
  const body = { project: "project-b", text: "go", clientMessageId: "report-original" };
  expect((await orchestratorPOST(request(sender.capability, body))).status).toBe(200);
  const held = Object.values(registry.readOnlySnapshot().heldDeliveries)[0];
  registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
  actor("project-b");
  const recovered = await orchestratorPOST(request(sender.capability, body));
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ target: source.id });
  const fresh = await orchestratorPOST(request(sender.capability, { ...body, clientMessageId: "report-fresh" }));
  expect(fresh.status).toBe(409);
  expect(await fresh.json()).toMatchObject({ code: "owner_report_seat_unavailable" });
  expect(delivered).toHaveLength(1);
});
