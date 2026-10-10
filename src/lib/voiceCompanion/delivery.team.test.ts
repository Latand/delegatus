import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-delivery-team-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.HOME = path.join(root, "home");
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_STRUCTURED_HOSTS = "1";
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
const { claimInstall, createInvite, redeemJoin } = await import("@/lib/team/members");
const { messageSenders } = await import("@/lib/team");
const { setConversationHostDependenciesForTests } = await import("@/app/api/conversation-host/dependencies");
const { conversationHostPOST } = await import("@/app/api/conversation-host/handlers");
const { POST: mountedPOST } = await import("@/app/api/conversation-host/route");
const { CompanionStorage } = await import("./storage");
const { CompanionAdmission } = await import("./admission");
const { companionDeliveryPaths, sendCompanionMessage } = await import("./deliveryPaths");
let registry: InstanceType<typeof AgentRegistry>;
let count = 0;
let delivered: Record<string, unknown>[];
let scan: () => void = () => {};
beforeEach(() => {
  resetTeamStoreForTests();
  registry?.close();
  process.env.LLV_STATE_DIR = path.join(root, `state-${++count}`);
  registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR, "registry.json"));
  setAgentRegistryForTests(registry);
  delivered = [];
  scan = () => {};
  setConversationHostDependenciesForTests({
    completedFileScan: async () => { scan(); return { snapshot: { files: [] } } as never; },
    recordOperatorRequest: () => null,
    collectImagePayloads: () => ({ images: [], error: null }),
    enqueueStructuredMessage: async message => {
      delivered.push({ ...message });
      const held = registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId ?? null, "text", [], null,
        { policy: message.policy, origin: message.origin });
      registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
      return { ok: true, structured: true, outcome: "delivered", target: null, operationId: held.command.operationId } as never;
    },
  });
});
afterAll(() => {
  resetTeamStoreForTests();
  registry?.close();
  setAgentRegistryForTests(null);
  setConversationHostDependenciesForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});
const desktop = { surface: "desktop" as const, browser: "chrome" as const };
function fixture() {
  const store = teamStore();
  const owner = claimInstall(store, "Owner", desktop);
  const human = redeemJoin(store, createInvite(store, owner.member, null).code, "Member", desktop);
  const project = "team-project";
  const spawn = registry.beginSpawnRequest({ engine: "codex", cwd: root, explicitProject: project, launchProfile: { cwd: root, title: "Manager fixture", role: "worker" } });
  if (spawn.kind !== "created") throw new Error("fixture spawn refused");
  const receipt = spawn.receipt;
  registry.completeSpawn(receipt.launchId, { key: { engine: "codex", sessionId: receipt.conversationId.slice("conversation_".length) },
    artifactPath: path.join(root, `${receipt.conversationId}.jsonl`), cwd: root, accountId: null, status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
  beginOrchestratorSeatIntent({ project, mandate: "Fixture mandate", clientRequestId: "fixture-seat", mode: "spawn" });
  completeOrchestratorSeatIntent({ project, clientRequestId: "fixture-seat", conversationId: receipt.conversationId, path: null });
  const admission = new CompanionAdmission(new CompanionStorage(), companionDeliveryPaths);
  const session = admission.create({ project, locale: "en", authority: "live-model", startedBy: { memberId: human.member.id } });
  return { store, owner, human, admission, session };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/conversation-host", { method: "POST", headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) });
}

test("the actual host handler stamps the stored starting member, sends once, and keeps voice origin and steer-or-queue", async () => {
  const f = fixture();
  expect(await f.admission.delegate(f.session.id, "voice-call", "live-turn", "Review the plan")).toEqual({ state: "sent", status: "delivered" });
  const held = Object.values(f.admission.session(f.session.id).proposals)[0];
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ origin: { kind: "operator", channel: "voice-delegatus" }, policy: "steer-or-queue" });
  expect(messageSenders([held.delivery!.clientMessageId])[held.delivery!.clientMessageId]).toMatchObject({ memberId: f.human.member.id, name: "Member" });
  expect(f.store.events({ actions: ["message.sent"], limit: 10 })).toMatchObject([{ actor: { kind: "member", memberId: f.human.member.id } }]);
  await f.admission.confirm(f.session.id, { proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
  expect(delivered).toHaveLength(1);
  const persisted = fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "voice-companion.json"), "utf8");
  expect(persisted).not.toContain(f.human.cookie);
  expect(persisted).not.toContain(f.owner.cookie);
});

test("an HTTP body or header cannot select the in-process actor, and cookie-less HTTP is refused", async () => {
  const f = fixture();
  const proposal = f.admission.propose(f.session.id, "call", "turn", "Review", { autosend: true })!;
  const row = f.admission.session(f.session.id).proposals[proposal.proposalId];
  const body = { orchestratorRelayProject: row.proposal.recipient.project, conversationId: row.proposal.recipient.conversationId,
    clientMessageId: row.delivery!.clientMessageId, text: row.text, voiceDelegatus: { sessionId: f.session.id, proposalId: proposal.proposalId },
    actor: { kind: "member", memberId: f.human.member.id } };
  const response = await mountedPOST(request(body, { "x-member-id": f.human.member.id }));
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "member_required" });
  expect(delivered).toEqual([]);
  const denied = await conversationHostPOST(request({ text: "Review", conversationId: row.proposal.recipient.conversationId }), { actor: { kind: "operator" } });
  expect(denied.status).toBe(401);
});

for (const duringScan of [false, true]) test(`starter revocation ${duringScan ? "during the handler await" : "before send"} prevents dispatch and author stamping`, async () => {
    const f = fixture();
    const revoke = () => f.store.updateMember({ ...f.human.member, status: "revoked", revokedAt: new Date().toISOString() });
    if (duringScan) scan = revoke; else revoke();
    const outcome = await f.admission.delegate(f.session.id, `call-${duringScan}`, `turn-${duringScan}`, "Review");
    expect(outcome).toEqual({ state: "sent", status: "failed", failureCode: "member_required" });
    const held = Object.values(f.admission.session(f.session.id).proposals)[0];
    expect(delivered).toEqual([]);
    expect(messageSenders([held.delivery!.clientMessageId])).toEqual({});
    f.admission.retire(f.session.id);
});

test("a solo starter cannot send after the installation enters team mode", async () => {
  const f = fixture();
  const proposal = f.admission.propose(f.session.id, "solo-call", "solo-turn", "Review", { autosend: true })!;
  const row = f.admission.session(f.session.id).proposals[proposal.proposalId];
  const result = await sendCompanionMessage({ sessionId: f.session.id, proposalId: proposal.proposalId, delivery: row.delivery!, text: row.text!, startedBy: { operator: true } });
  expect(result).toEqual({ status: "failed", operationId: null, code: "member_required" });
  expect(delivered).toEqual([]);
});

test("an error response that names an operation retains its unknown fate and original operation", async () => {
  const f = fixture();
  const proposal = f.admission.propose(f.session.id, "call-operation", "turn-operation", "Review", { autosend: true })!;
  const held = f.admission.session(f.session.id).proposals[proposal.proposalId];
  const result = await sendCompanionMessage({ sessionId: f.session.id, proposalId: proposal.proposalId, delivery: held.delivery!, text: held.text!, startedBy: f.session.startedBy },
    async () => new Response(JSON.stringify({ code: "voice_seat_changed", operationId: "op-already-admitted" }), { status: 409, headers: { "content-type": "application/json" } }));
  expect(result).toEqual({ status: "unknown", operationId: "op-already-admitted", code: "voice_seat_changed" });
});
