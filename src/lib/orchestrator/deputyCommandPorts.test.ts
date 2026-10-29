import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { RuntimeJournal } from "@/runtime-host/journal";
import { deputyMessageKey, type OrchestratorDeputy } from "./deputies";
import { productionDeputyCommandPorts } from "./deputyCommandPorts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test.each(["unattempted", "queued", "delivering", "unreachable", "raced-claim"] as const)("parallel C: retry settles the prior %s journal operation before another message", async state => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-retry-journal-")); roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"));
  const conversation = registry.ensureConversation("claude", path.join(root, "fork.jsonl"), null);
  const deputy = { askId: "deputy-retry", deputyConversationId: conversation.id, artifactPath: path.join(root, "fork.jsonl"), attempt: 0 } as OrchestratorDeputy;
  const delivery = registry.holdDelivery(conversation.id, "saved question", deputyMessageKey(deputy.askId), "text", [], null,
    { operationId: "prior-question" }, { recoveryIntent: "reclaimed-host" });
  // A claimed send has crossed the registry boundary; only the journal can
  // prove whether its host actuation began.
  if (state !== "unattempted" && state !== "raced-claim") registry.beginDeliveryAttempt(delivery.id, conversation.generations.at(-1)!.id);
  journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: {
    conversationId: conversation.id, sessionKey: { engine: "claude", sessionId: conversation.generations.at(-1)!.id },
    hostKind: "claude-broker", host: "hosted", turn: "idle", provenance: "structured", artifactPath: deputy.artifactPath,
    capabilities: { steer: false, structuredAttention: true },
  } });
  const command = { kind: "send" as const, conversationId: conversation.id, operationId: "prior-question", idempotencyKey: deputyMessageKey(deputy.askId), text: "saved question", policy: "queue" as const };
  if (state !== "unattempted" && state !== "raced-claim") journal.executeOperation(command);
  if (state === "delivering" || state === "unreachable") journal.transitionOperation("prior-question", "delivering");
  let raced = false;
  const client = { readSession: async () => null,
    operationStatus: async (id: string) => {
      if (state === "unreachable") throw new Error("runtime unavailable");
      if (state === "raced-claim" && !raced) {
        raced = true; registry.beginDeliveryAttempt(delivery.id, conversation.generations.at(-1)!.id);
        journal.executeOperation(command); journal.transitionOperation("prior-question", "delivering");
        return null;
      }
      return journal.operationResult(id);
    },
    transitionOperation: async (id: string, status: Parameters<RuntimeJournal["transitionOperation"]>[1], options: Parameters<RuntimeJournal["transitionOperation"]>[2]) => journal.transitionOperation(id, status, options),
  } as unknown as RuntimeHostClient;
  try {
    const port = productionDeputyCommandPorts({ registry, client: () => client });
    const result = await port.prepareRetry!(deputy, () => {});
    expect(result.ok).toBe(state === "queued" || state === "unattempted");
    expect(journal.operationResult("prior-question")?.receipt.status).toBe(state === "unattempted" ? undefined : state === "queued" ? "failed" : (state === "delivering" || state === "raced-claim") ? "uncertain" : "delivering");
    const reopened = new AgentRegistry(registry.filename);
    expect(reopened.deliveryAdmissionForKey(conversation.id, deputyMessageKey(deputy.askId))).toMatchObject({ state: "failed" });
    reopened.close();
  } finally { registry.close(); journal.close(); }
});


test("parallel C: retry's cancellation yields to a peer writer and rechecks the seat fence", async () => {
  const { Database } = await import("bun:sqlite");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-retry-writer-")); roots.push(root);
  const registry = new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const conversation = registry.ensureConversation("claude", path.join(root, "fork.jsonl"), null);
  const deputy = { askId: "deputy-peer", deputyConversationId: conversation.id, artifactPath: path.join(root, "fork.jsonl"), attempt: 0 } as OrchestratorDeputy;
  registry.holdDelivery(conversation.id, "saved question", deputyMessageKey(deputy.askId), "text", [], null,
    { operationId: "unclaimed-question" }, { recoveryIntent: "reclaimed-host" });
  const peer = new Database(path.join(root, "agent-registry.sqlite"));
  let locked = false, advanced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const client = { readSession: async () => null, operationStatus: async () => {
    peer.exec("BEGIN IMMEDIATE"); locked = true;
    timer = setTimeout(() => { advanced = true; peer.exec("ROLLBACK"); locked = false; }, 25);
    return null;
  } } as unknown as RuntimeHostClient;
  try {
    const port = productionDeputyCommandPorts({ registry, client: () => client });
    await expect(port.prepareRetry!(deputy, () => { if (advanced) throw new Error("authority changed"); })).rejects.toThrow("authority changed");
    expect(advanced).toBe(true);
    expect(registry.pendingDeliveries(conversation.id)[0]).toMatchObject({ state: "assigned", attempts: 0 });
  } finally { clearTimeout(timer); if (locked) peer.exec("ROLLBACK"); peer.close(); registry.close(); }
});

for (const change of ["unchanged", "member-revoked", "owner-revoked", "project-rebound"] as const) test(`parallel queue rechecks saved human authority after the runtime read: ${change}`, async () => {
  const { agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { createWorkspace, placeProject } = await import("@/lib/team/workspaces");
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } = await import("./seats");
  const { beginDeputy, recordDeputyFork } = await import("./deputies");
  const clientModule = await import("@/lib/runtime/client");
  const previousRegistry = agentRegistry(), previousState = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-member-queue-")); roots.push(root);
  process.env.LLV_STATE_DIR = root; resetTeamStoreForTests();
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  setAgentRegistryForTests(registry);
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"));
  const at = "2026-10-20T09:00:00.000Z", project = "project-alpha", w1 = `w_${"a".repeat(32)}`, w2 = `w_${"b".repeat(32)}`;
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const read = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let clientSpy: ReturnType<typeof spyOn> | undefined, delivery: Promise<unknown> | undefined;
  let commands = 0;
  try {
    const store = teamStore();
    const owner = { id: "m_owner", name: "Owner", role: "owner" as const, status: "active" as const, color: "teal" as const,
      telegram: null, createdAt: at, createdBy: "claim", revokedAt: null };
    const member = { ...owner, id: "m_member", name: "Member", role: "member" as const };
    store.insertMember(owner); store.insertMember(member);
    createWorkspace(store, owner, { id: w1, name: "Alpha", projects: [project] });
    createWorkspace(store, owner, { id: w2, name: "Beta", projects: [] });
    store.putWorkspaceMember(w1, member.id, "member", owner.id, at);
    const actor = change === "owner-revoked" ? owner : member;
    const workspace = actor.role === "owner" ? undefined : { memberId: actor.id, workspaceId: w1 };
    const seat = registry.ensureForkedConversation("claude", path.join(root, "seat.jsonl"), null, emptyLaunchProfile({ cwd: root, project }));
    beginOrchestratorSeatIntent({ project, mandate: "Run work", mode: "existing", conversationId: seat.id, clientRequestId: "queue-seat", now: at });
    completeOrchestratorSeatIntent({ project, conversationId: seat.id, path: seat.generations.at(-1)!.path, clientRequestId: "queue-seat", now: at });
    const fork = registry.ensureForkedConversation("claude", path.join(root, "fork.jsonl"), null,
      emptyLaunchProfile({ cwd: root, project, parentConversationId: seat.id, ...(workspace ? { workspace } : {}) }));
    const begun = beginDeputy({ project, seatConversationId: seat.id, seatEpoch: orchestratorSeatFor(project).active!.seatEpoch,
      seatPath: seat.generations.at(-1)!.path, clientRequestId: "queue-member", askId: "deputy-member-queue", workspace,
      ask: { text: "Workspace question", images: 0, sender: null, origin: { kind: "operator" }, memberId: actor.id }, now: new Date(at) });
    recordDeputyFork(begun.deputy.askId, { deputyConversationId: fork.id, artifactPath: fork.generations.at(-1)!.path, forkRecordCount: 1 });
    store.admitConversationMember(fork.id, actor.id);
    journal.append({ scope: { type: "session", id: fork.id }, kind: "session-status", payload: {
      conversationId: fork.id, sessionKey: { engine: "claude", sessionId: fork.generations.at(-1)!.id },
      hostKind: "claude-broker", host: "hosted", turn: "idle", provenance: "structured", artifactPath: fork.generations.at(-1)!.path,
      capabilities: { steer: false, structuredAttention: true },
    } });
    const client = { readSession: async () => { read.resolve(); await release.promise; return journal.readSession({ conversationId: fork.id }); },
      command: async (command: Parameters<RuntimeJournal["executeOperation"]>[0]) => { commands++; return journal.executeOperation(command); },
    } as unknown as RuntimeHostClient;
    clientSpy = spyOn(clientModule, "runtimeHostClient").mockReturnValue(client);
    const pending = productionDeputyCommandPorts({ registry }).deliver({ conversationId: fork.id, path: fork.generations.at(-1)!.path,
      clientMessageId: deputyMessageKey(begun.deputy.askId), text: "Workspace question", images: [], origin: { kind: "operator" } });
    delivery = pending;
    await Promise.race([read.promise, pending.then(result => { throw new Error(`queue ended before its runtime read: ${JSON.stringify(result)}`); })]);
    if (change === "member-revoked") store.removeWorkspaceMember(w1, member.id);
    if (change === "owner-revoked") store.updateMember({ ...owner, status: "revoked", revokedAt: at });
    if (change === "project-rebound") {
      placeProject(store, owner, project, w2);
      store.putWorkspaceMember(w2, member.id, "member", owner.id, at);
    }
    release.resolve();
    const result = await pending.then(value => ({ value }), error => ({ error }));
    expect(commands).toBe(change === "unchanged" ? 1 : 0);
    if (change === "unchanged") expect(result).toMatchObject({ value: { ok: true } });
    else {
      expect("error" in result ? String(result.error) : JSON.stringify(result.value))
        .toContain(change === "owner-revoked" ? "member authority is unavailable" : "workspace access denied");
      expect(registry.pendingDeliveries(fork.id)).toEqual([]);
    }
  } finally {
    release.resolve(); await Promise.allSettled(delivery ? [delivery] : []);
    clientSpy?.mockRestore(); clock.mockRestore(); journal.close(); registry.close();
    setAgentRegistryForTests(previousRegistry); resetTeamStoreForTests();
    process.env.LLV_STATE_DIR = previousState;
  }
});
