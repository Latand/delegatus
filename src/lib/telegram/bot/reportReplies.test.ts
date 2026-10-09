import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TgMessage, TgUpdate } from "./store";
import type { ReportReplyPorts } from "./reportReplies";
import type { OriginalSendEvidence } from "@/lib/runtime/sendSettlement";
import type { BridgeReportV1 } from "@/lib/bridge/types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-replies-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");
const { TelegramBotService, productionTelegramBotDependencies } = await import("./service");
const { TelegramBotStore } = await import("./store");
const { FakeBotTransport, fakeBotToken, ok, refused } = await import("./fakeTransport");
const { reportReplyOperatorId, deliverReportReply, productionReportReplyPorts } = await import("./reportReplies");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");

// Invented fixture identities, shared with the bot's existing fake-transport tests.
const botId = "4242424";
const chat = { id: -1000000000101, type: "supergroup", title: "Fixture Reports" };
const owner = { id: 700000505, is_bot: false, first_name: "Fixture owner" };
const now = new Date("2026-10-02T12:00:00Z");
const date = Math.floor(now.getTime() / 1000);
let directory: string;
let store: InstanceType<typeof TelegramBotStore>;
let service: InstanceType<typeof TelegramBotService>;
let transport: InstanceType<typeof FakeBotTransport>;
let ports: ReportReplyPorts;
let delivered: Array<Parameters<ReportReplyPorts["deliver"]>[0]>;
let receipts: Map<string, OriginalSendEvidence>;
let report: BridgeReportV1;
let token: string | null;
let recipient: string | null;
let ready: boolean;

function createService() {
  return new TelegramBotService({
    ...productionTelegramBotDependencies(), reportReplies: ports,
    transportFor: () => transport, openStore: () => store, removeStoreFiles: () => {},
    saveToken: value => { token = value; }, removeToken: () => { token = null; },
    withStoredToken: callback => token ? callback(token, botId) : null,
    now: () => now, sleep: async () => {}, conversationTitle: () => null,
  });
}

function reply(extra: Partial<TgMessage> = {}, updateId = 2): TgUpdate {
  return { update_id: updateId, message: { message_id: 20, date, chat, from: owner, text: "Please proceed.", reply_to_message: { message_id: 10 }, ...extra } };
}

async function poll(updates: TgUpdate[]) {
  transport.script("getUpdates", ok(updates));
  return service.pollOnce(new AbortController().signal);
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(root, "case-"));
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  store = new TelegramBotStore(path.join(directory, "bot.sqlite"));
  transport = new FakeBotTransport();
  delivered = [];
  receipts = new Map();
  token = null;
  recipient = "conversation_seat_first";
  ready = true;
  report = { id: "fixture-report", key: "fixture-report-key", seq: 7, at: now.toISOString(), class: "question", body: "Proceed?",
    project: "fixture-project", targetSeatConversationId: recipient, origin: { kind: "manager", conversationId: recipient, role: "orchestrator" },
    telegram: { chat: "fixture-reports", html: "Proceed?", state: "sent", messageIds: [10], attempts: 1, at: now.toISOString() } };
  ports = {
    operatorId: () => String(owner.id), reports: () => [report], destination: () => ({ chat: "fixture-reports" }),
    seat: () => recipient ? { conversationId: recipient, path: null } : null,
    ready: async () => ready,
    original: async binding => receipts.get(binding.clientMessageId) ?? { kind: "absent" },
    deliver: async binding => { delivered.push(binding); return { ok: true, delivered: true }; },
    withdraw: async () => "unknown",
  };
  service = createService();
  transport.script("getMe", ok({ id: Number(botId), is_bot: true, first_name: "Fixture Bot" }));
  await service.connect(fakeBotToken(botId));
  await service.stopPoller();
  await poll([{ update_id: 1, my_chat_member: { chat, date, new_chat_member: { status: "member" } } }]);
  service.setChat(String(chat.id), "fixture-reports", true);
  transport.script("sendMessage", ok({ message_id: 10, date }));
  await service.send({ conversationId: recipient, clientRequestId: `bridge-report:${report.id}`, chat: "fixture-reports", text: "Proceed?" });
});

afterEach(async () => { await service.stopPoller(); store.close(); resetTeamStoreForTests(); });
afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true });
});

test("the fake transport routes the owner's report reply with Telegram attribution and the original seq", async () => {
  await poll([reply()]);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ conversationId: recipient, text: "Operator reply from Telegram:\n\nPlease proceed.\n\n[bridge ref=7]", origin: { kind: "operator" } });
  expect(delivered[0].clientMessageId).toMatch(/^bridge_d_telegram_[a-f0-9]{64}_0$/);
  expect(store.pendingReportReplies()).toHaveLength(0);
});

test("captions route as text; unsupported media produces only a short notice", async () => {
  await poll([reply({ message_id: 21, text: undefined, caption: "Use this caption", photo: [{}] }),
    reply({ message_id: 22, text: undefined, voice: {} }, 3)]);
  expect(delivered).toHaveLength(2);
  expect(delivered[0].text).toContain("Use this caption\n\n[bridge ref=7]");
  expect(delivered[1].text).toContain("non-text reply");
  expect(delivered[1].text).toEndWith("[bridge ref=7]");
});

for (const [name, change] of Object.entries({
  stranger: { from: { ...owner, id: owner.id + 1 } },
  bot: { from: { ...owner, is_bot: true } },
  "missing bot flag": { from: { id: owner.id } },
  "no sender": { from: undefined },
  "anonymous sender": { sender_chat: chat },
  "forwarded message": { forward_origin: { type: "user" } },
  "legacy forwarded message": { forward_date: date },
  "automatic forward": { is_automatic_forward: true },
  "edited payload": { edit_date: date },
  "non-report reply": { reply_to_message: { message_id: 11 } },
  "wrong chat": { chat: { ...chat, id: chat.id - 1 } },
  "wrong topic": { message_thread_id: 4 },
  "ordinary message": { reply_to_message: undefined },
} satisfies Record<string, Partial<TgMessage>>)) {
  test(`rejects ${name}`, async () => { await poll([reply(change)]); expect(delivered).toHaveLength(0); });
}

test("edit and channel update envelopes never deliver", async () => {
  const message = reply().message!;
  await poll([{ update_id: 2, edited_message: message }, { update_id: 3, channel_post: message }]);
  expect(delivered).toHaveLength(0);
});

test("report ids must match an actual report send, rather than an ordinary outgoing message", async () => {
  transport.script("sendMessage", ok({ message_id: 11, date }));
  await service.send({ conversationId: recipient, clientRequestId: "ordinary-send", chat: "fixture-reports", text: "Ordinary message" });
  report.telegram!.messageIds = [11];
  await poll([reply({ reply_to_message: { message_id: 11 } })]);
  expect(delivered).toHaveLength(0);
});

test("a reply during the report mirror's receipt-write window uses the committed bot receipt", async () => {
  report.telegram!.state = "pending";
  delete report.telegram!.messageIds;
  await poll([reply()]);
  expect(delivered).toHaveLength(1);
});

test("unlinked owner and disabled project destination route nothing", async () => {
  ports.operatorId = () => null;
  await poll([reply()]);
  expect(service.status().reportReplies).toBe("operator_unlinked");
  ports.operatorId = () => String(owner.id);
  ports.destination = () => null;
  await poll([reply()]);
  expect(delivered).toHaveLength(0);
});

test("dedup survives reopening the store and replay with a different update id", async () => {
  await poll([reply(), reply({}, 3)]);
  store.close();
  store = new TelegramBotStore(path.join(directory, "bot.sqlite"));
  service = createService();
  await poll([reply({}, 999)]);
  expect(delivered).toHaveLength(1);
});

test("replays cannot replace a pending directive's admitted text", async () => {
  ready = false;
  await poll([reply()]);
  await poll([reply({ text: "Changed replay text" }, 3)]);
  ready = true;
  await poll([]);
  expect(delivered).toHaveLength(1);
  expect(delivered[0].text).toContain("Please proceed.");
  expect(delivered[0].text).not.toContain("Changed replay text");
});

test("a queued admission pauses if the owner unlinks their Telegram account", async () => {
  ready = false;
  await poll([reply()]);
  ready = true;
  ports.operatorId = () => null;
  await poll([]);
  expect(delivered).toHaveLength(0);
  ports.operatorId = () => String(owner.id);
  await poll([]);
  expect(delivered).toHaveLength(1);
});

test("a busy seat keeps the reply through restart and rotation; the new seat receives it", async () => {
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  const designate = (key: string, id: string) => {
    beginOrchestratorSeatIntent({ project: "fixture-project", mandate: "Fixture mandate", clientRequestId: key, mode: "spawn" });
    completeOrchestratorSeatIntent({ project: "fixture-project", clientRequestId: key, conversationId: id, path: null });
  };
  designate("fixture-initial-seat", recipient!);
  ports.seat = productionReportReplyPorts.seat;
  ready = false;
  await poll([reply()]);
  expect(delivered).toHaveLength(0);
  expect(store.pendingReportReplies()).toHaveLength(1);
  store.close();
  store = new TelegramBotStore(path.join(directory, "bot.sqlite"));
  service = createService();
  beginOrchestratorSeatIntent({ project: "fixture-project", mandate: "Fixture successor mandate", clientRequestId: "fixture-rotation", mode: "spawn" });
  ready = true;
  // The incumbent still exists, but the pending rotation fences fresh delivery.
  await poll([]);
  expect(delivered).toHaveLength(0);
  recipient = "conversation_seat_second";
  completeOrchestratorSeatIntent({ project: "fixture-project", clientRequestId: "fixture-rotation", conversationId: recipient, path: null });
  await poll([]);
  expect(delivered).toHaveLength(1);
  expect(delivered[0].conversationId).toBe(recipient!);
  expect(delivered[0].text).toEndWith("[bridge ref=7]");
});

test("designation changing during readiness is checked again before binding", async () => {
  ports.ready = async () => { recipient = "conversation_seat_second"; return true; };
  await poll([reply()]);
  expect(delivered).toHaveLength(0);
  ports.ready = async () => true;
  await poll([]);
  expect(delivered[0].conversationId).toBe(recipient!);
});

function queued(binding: Parameters<ReportReplyPorts["deliver"]>[0], state: "in-flight" | "delivered" = "in-flight"): OriginalSendEvidence {
  const receipt = { operationId: "fixture-operation", kind: "send" as const, conversationId: binding.conversationId,
    clientMessageId: binding.clientMessageId, state, reason: null, acceptedAt: now.toISOString(), settledAt: null,
    duplicateRisk: state === "delivered", resend: state === "delivered" ? "not-needed" as const : null, evidence: "delivery-record" as const };
  return { kind: "found", operationId: receipt.operationId, deliveryId: "fixture-delivery", reservationState: "assigned", receipt, current: { readable: true, value: receipt } };
}

test("a lost delivery acknowledgement is recovered by the original key after restart", async () => {
  ports.deliver = async binding => {
    delivered.push(binding);
    receipts.set(binding.clientMessageId, queued(binding, "delivered"));
    throw new Error("fixture receipt lost");
  };
  await expect(poll([reply()])).rejects.toThrow("fixture receipt lost");
  store.close();
  store = new TelegramBotStore(path.join(directory, "bot.sqlite"));
  service = createService();
  await poll([reply()]);
  expect(delivered).toHaveLength(1);
  expect(store.pendingReportReplies()).toHaveLength(0);
});

test("a queued send is withdrawn before moving to a successor; uncertain withdrawal keeps the binding", async () => {
  ports.deliver = async binding => { delivered.push(binding); receipts.set(binding.clientMessageId, queued(binding)); return { ok: true, operationId: "fixture-operation" }; };
  await poll([reply()]);
  recipient = "conversation_seat_second";
  await poll([]);
  expect(delivered).toHaveLength(1);
  expect(store.pendingReportReplies()[0].recipient).toBe("conversation_seat_first");
  ports.withdraw = async () => "withdrawn";
  ports.deliver = async binding => { delivered.push(binding); return { ok: true, delivered: true }; };
  await poll([]);
  expect(delivered).toHaveLength(2);
  expect(delivered[1].conversationId).toBe(recipient!);
  expect(delivered[1].clientMessageId).toEndWith("_1");
  expect(delivered[1].text).toBe(delivered[0].text);
});

test("a foreign webhook leaves pending replies inert and is never changed", async () => {
  ready = false;
  await poll([reply()]);
  ready = true;
  transport.script("getUpdates", refused(409, "Conflict"));
  transport.script("getWebhookInfo", ok({ url: "https://example.invalid/fixture-webhook" }));
  expect(await service.pollOnce(new AbortController().signal)).toEqual({ next: "stop" });
  expect(service.status()).toMatchObject({ receiving: "webhook_elsewhere", reportReplies: "receiving_unavailable" });
  expect(delivered).toHaveLength(0);
  expect(transport.callsOf("deleteWebhook")).toHaveLength(0);
  expect(transport.callsOf("setWebhook")).toHaveLength(0);
});

test("durable intake failure cannot advance the Telegram polling cursor", async () => {
  const { spyOn } = await import("bun:test");
  const admission = spyOn(store, "admitReportReply").mockImplementation(() => { throw new Error("fixture persistence failed"); });
  await expect(poll([reply()])).rejects.toThrow("fixture persistence failed");
  admission.mockRestore();
  await poll([reply()]);
  const calls = transport.callsOf("getUpdates");
  expect(calls.at(-1)?.params.offset).toBe(2);
  expect(delivered).toHaveLength(1);
});

test("operator means the existing active owner, never an ordinary linked member", () => {
  expect(reportReplyOperatorId()).toBeNull();
  const team = teamStore();
  const member = { id: "fixture-owner", name: "Fixture owner", role: "owner" as const, status: "active" as const, color: "sky" as const,
    telegram: null, createdAt: now.toISOString(), createdBy: "operator", revokedAt: null };
  team.insertMember(member);
  team.insertMember({ ...member, id: "fixture-member", role: "member", telegram: { userId: String(owner.id + 1), username: null, firstName: null, linkedAt: now.toISOString() } });
  expect(reportReplyOperatorId()).toBeNull();
  team.updateMember({ ...member, telegram: { userId: String(owner.id), username: null, firstName: null, linkedAt: now.toISOString() } });
  expect(reportReplyOperatorId()).toBe(String(owner.id));
  team.updateMember({ ...member, status: "revoked" });
  expect(reportReplyOperatorId()).toBeNull();
});

test("Telegram intake reaches the real durable seat reservation and runtime journal, and recovers after reopening both", async () => {
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { resolveOriginalSend } = await import("@/lib/runtime/sendSettlement");
  const registryFile = path.join(directory, "registry.json");
  const journalFile = path.join(directory, "runtime.sqlite");
  let registry = new AgentRegistry(registryFile);
  let journal = new RuntimeJournal(journalFile, { structuredHosts: true });
  try {
    const artifactPath = path.join(directory, "fixture-session.jsonl");
    const launchProfile = emptyLaunchProfile({ cwd: directory });
    registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: "fixture-account", launchProfile,
      turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: now.toISOString() }]);
    const conversation = registry.conversationForPath(artifactPath)!;
    const generation = conversation.generations.at(-1)!;
    recipient = conversation.id;
    report.origin!.conversationId = recipient;
    report.targetSeatConversationId = recipient;
    transport.script("sendMessage", ok({ message_id: 10, date }));
    await service.send({ conversationId: recipient, clientRequestId: `bridge-report:${report.id}`, chat: "fixture-reports", text: "Proceed?" });
    journal.append({ scope: { type: "session", id: recipient }, kind: "session-status", payload: {
      conversationId: recipient, sessionKey: { engine: "codex", sessionId: generation.id }, hostKind: "codex-app-server",
      host: "hosted", turn: "idle", provenance: "structured", artifactPath, capabilities: { steer: true, structuredAttention: true },
    } });
    const client = {
      readSession: async () => journal.snapshot().sessions.find(session => session.conversationId === recipient) ?? null,
      command: async (command: Parameters<InstanceType<typeof RuntimeJournal>["executeOperation"]>[0]) => journal.executeOperation(command),
      operationStatus: async (id: string) => journal.operationResult(id),
    } as unknown as import("@/lib/runtime/client").RuntimeHostClient;
    ports.deliver = binding => deliverReportReply(binding, { enabled: () => true, registry: () => registry, client: () => client, kick: () => {} });
    ports.original = binding => resolveOriginalSend(binding, { registry, client });
    await poll([reply()]);
    const pending = store.pendingReportReplies()[0];
    expect(pending.operationId).toBeTruthy();
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries)).toHaveLength(1);
    expect(journal.effectBatch(20, ["runtime.send"])[0].payload).toMatchObject({
      text: pending.text, policy: "queue", origin: { kind: "operator" }, conversationId: recipient,
    });
    registry.close();
    journal.close();
    store.close();
    registry = new AgentRegistry(registryFile);
    journal = new RuntimeJournal(journalFile, { structuredHosts: true });
    store = new TelegramBotStore(path.join(directory, "bot.sqlite"));
    service = createService();
    await poll([reply({}, 99)]);
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries)).toHaveLength(1);
    expect(journal.effectBatch(20, ["runtime.send"])).toHaveLength(1);
    journal.transitionOperation(pending.operationId!, "delivering");
    journal.transitionOperation(pending.operationId!, "delivered");
    await poll([]);
    expect(store.pendingReportReplies()).toHaveLength(0);
  } finally { registry.close(); journal.close(); }
});

/* docs/design/delivery-progress-and-drain.md, P23 (C2): the recipient-rotation
   withdrawal decides inside the write it waited for. Another process holds the
   SQLite writer; once it lets go, the switch is cancelled and an attempt claims
   the row in the same tick, before the withdrawal's next probe. `withdrawn`
   would let the reply go to the new recipient beside the original send. */
test("a recipient-rotation withdrawal that waited for the writer leaves a row an attempt claimed meanwhile, and never answers withdrawn", async () => {
  const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { Database } = await import("bun:sqlite");
  const sqlitePath = path.join(directory, "agent-registry.sqlite");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite", sqliteFilename: sqlitePath });
  const conversation = registry.ensureConversation("codex", path.join(directory, "seat.jsonl"), null);
  registry.setConversationMigration(conversation.id, {
    intentId: "rotation-race-intent", phase: "requested", targetId: "default", revision: 1, error: null, updatedAt: now.toISOString(),
  });
  const held = registry.holdDelivery(conversation.id, "Operator reply", "rotation-race-key");
  expect(held.state).toBe("held");
  setAgentRegistryForTests(registry);
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = "";
  const holder = new Database(sqlitePath);
  holder.exec("PRAGMA busy_timeout = 5000");
  holder.exec("BEGIN IMMEDIATE");
  try {
    const withdrawing = productionReportReplyPorts.withdraw(held.command.operationId, held.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    holder.exec("ROLLBACK");
    registry.setConversationMigration(conversation.id, null);
    const assigned = registry.requeueHeldDelivery(held.id);
    expect(registry.beginDeliveryAttempt(held.id, assigned.generationId!)?.state).toBe("delivery-uncertain");
    expect(await withdrawing).toBe("unknown");
    expect(registry.readOnlySnapshot().heldDeliveries[held.id]).toMatchObject({ state: "delivery-uncertain", text: "Operator reply" });
  } finally {
    holder.close();
    setAgentRegistryForTests(null);
    registry.close();
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  }
});
