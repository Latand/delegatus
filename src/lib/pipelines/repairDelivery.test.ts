import { expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { stageRepairDelivery } from "./repairDelivery";

const START = Date.parse("2026-10-16T10:00:00.000Z");
const DEADLINE = START + 20 * 60_000;

test.each(["held", "queued", "delivering", "delivered"] as const)("repair delivery settles the real journal and preserves dispatch evidence: %s", async status => {
  setSystemTime(new Date(START));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-delivery-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { now: () => START });
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true, now: () => START });
  try {
    const profile = emptyLaunchProfile({ cwd: root });
    registry.reconcileConversations([{ engine: "codex", path: path.join(root, "stage.jsonl"), accountId: "fixture-account",
      launchProfile: profile, turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(START).toISOString() }]);
    const conversation = Object.values(registry.snapshot().conversations)[0]!;
    const generation = conversation.generations.at(-1)!;
    registry.upsert({ key: { engine: "codex", sessionId: generation.id }, artifactPath: generation.path, cwd: root,
      accountId: "fixture-account", launchProfile: profile, status: "idle", host: null, structuredHost: {
        kind: "codex-app-server", endpoint: "fixture:repair", process: null, eventCursor: 0, protocolVersion: "fixture",
        writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [],
      }, claimEpoch: 0, claimOwner: null, pendingAction: null });
    journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: {
      conversationId: conversation.id, sessionKey: { engine: "codex", sessionId: generation.id }, hostKind: "codex-app-server",
      host: "hosted", turn: "idle", provenance: "structured", artifactPath: generation.path, capabilities: { steer: true, structuredAttention: true },
    } });
    const key = "repair-key", operationId = "repair-operation";
    if (status === "held") registry.requestConversationReseat(conversation.id, "successor-account");
    const reserved = registry.holdDelivery(conversation.id, "repair", key, "text", [], null, { operationId, kind: "send", policy: "queue" });
    if (status === "held") expect(reserved).toMatchObject({ state: "held", attempts: 0 });
    else {
      expect(registry.beginDeliveryAttempt(reserved.id, generation.id)).not.toBeNull();
      expect(journal.executeOperation({ kind: "send", operationId, conversationId: conversation.id, idempotencyKey: key,
        text: "repair", policy: "queue" }).receipt.status).toBe("queued");
    }
    if (status === "delivering" || status === "delivered") journal.transitionOperation(operationId, "delivering");
    if (status === "delivered") journal.transitionOperation(operationId, "delivered");
    const client = { operationStatus: async (id: string) => journal.currentRetryResult(id),
      transitionOperation: async (...args: Parameters<RuntimeJournal["transitionOperation"]>) => journal.transitionOperation(...args),
    } as RuntimeHostClient;
    setSystemTime(new Date(DEADLINE + 1));
    const result = await stageRepairDelivery(registry, conversation.id, key, DEADLINE,
      { client, now: () => DEADLINE + 1, progress: null });
    expect(result).toEqual({ operationId, state: status === "delivered" ? "delivered" : "failed", safeToReplace: status === "held" || status === "queued" });
    if (status === "queued" || status === "held") {
      expect(journal.effectBatch(100, ["runtime.send"])).toEqual([]);
      expect(() => journal.transitionOperation(operationId, "delivering")).toThrow();
    }
    expect(await stageRepairDelivery(registry, conversation.id, key, DEADLINE,
      { client: null, now: () => DEADLINE + 1, progress: null })).toEqual(result);
  } finally { journal.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); setSystemTime(); }
});

test("a queued repair admitted near its deadline is fenced at the original cutoff", async () => {
  let clock = START;
  setSystemTime(new Date(START));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-delivery-late-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { now: () => clock });
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true, now: () => clock });
  try {
    const profile = emptyLaunchProfile({ cwd: root });
    registry.reconcileConversations([{ engine: "codex", path: path.join(root, "stage.jsonl"), accountId: "fixture-account",
      launchProfile: profile, turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(START).toISOString() }]);
    const conversation = Object.values(registry.snapshot().conversations)[0]!;
    const generation = conversation.generations.at(-1)!;
    registry.upsert({ key: { engine: "codex", sessionId: generation.id }, artifactPath: generation.path, cwd: root,
      accountId: "fixture-account", launchProfile: profile, status: "idle", host: null, structuredHost: {
        kind: "codex-app-server", endpoint: "fixture:repair-late", process: null, eventCursor: 0, protocolVersion: "fixture",
        writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [],
      }, claimEpoch: 0, claimOwner: null, pendingAction: null });
    journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: {
      conversationId: conversation.id, sessionKey: { engine: "codex", sessionId: generation.id }, hostKind: "codex-app-server",
      host: "hosted", turn: "idle", provenance: "structured", artifactPath: generation.path, capabilities: { steer: true, structuredAttention: true },
    } });
    clock = DEADLINE - 60_000;
    const key = "late-repair-key", operationId = "late-repair-operation";
    const reserved = registry.holdDelivery(conversation.id, "repair", key, "text", [], null, { operationId, kind: "send", policy: "queue" });
    expect(registry.beginDeliveryAttempt(reserved.id, generation.id)).not.toBeNull();
    expect(journal.executeOperation({ kind: "send", operationId, conversationId: conversation.id, idempotencyKey: key,
      text: "repair", policy: "queue" }).receipt.status).toBe("queued");
    const client = { operationStatus: async (id: string) => journal.currentRetryResult(id),
      transitionOperation: async (...args: Parameters<RuntimeJournal["transitionOperation"]>) => journal.transitionOperation(...args),
    } as RuntimeHostClient;
    clock = DEADLINE + 1;
    const result = await stageRepairDelivery(registry, conversation.id, key, DEADLINE,
      { client, now: () => clock, progress: null });
    expect(result).toEqual({ operationId, state: "failed", safeToReplace: true });
    expect(journal.effectBatch(100, ["runtime.send"])).toEqual([]);
    expect(() => journal.transitionOperation(operationId, "delivering")).toThrow();
  } finally { journal.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); setSystemTime(); }
});

test("an unreserved repair expires at its original cutoff across a process restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-unreserved-"));
  const filename = path.join(root, "registry.json");
  const registry = new AgentRegistry(filename);
  const conversation = registry.ensureForkedConversation("codex", path.join(root, "stage.jsonl"), null, emptyLaunchProfile({ cwd: root }));
  registry.close();
  try {
    for (const now of [DEADLINE - 1, DEADLINE, DEADLINE + 1]) {
      const child = spawnSync(process.execPath, ["-e", `
        const { AgentRegistry } = await import("./src/lib/agent/registry");
        const { stageRepairDelivery } = await import("./src/lib/pipelines/repairDelivery");
        const registry = new AgentRegistry(${JSON.stringify(filename)});
        const delivery = await stageRepairDelivery(registry, ${JSON.stringify(conversation.id)}, "unreserved-repair", ${DEADLINE},
          { now: () => ${now}, client: null, progress: null });
        const { pipelineCorpus } = await import("./src/lib/pipelines/fixtures/corpus");
        const { savePipelines, findPipelineRecord } = await import("./src/lib/pipelines/store");
        const lane = pipelineCorpus(2, 1)[1];
        lane.runs[0].attempts[0].publicationRepair = { sha: "a".repeat(40), baseSha: "b".repeat(40),
          operationId: "repair-publication", stageId: "build", attempt: 1,
          refusedAt: new Date(${START}).toISOString(), detail: "fixture refusal", paths: [], messageTs: null, delivery };
        savePipelines([lane]);
        console.log(JSON.stringify(findPipelineRecord(lane.id).runs[0].attempts[0].publicationRepair.delivery));
        registry.close();
      `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 20_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ operationId: null,
        state: now < DEADLINE ? "unreserved" : "failed", safeToReplace: true });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unknown legacy delivery history becomes bounded failure at the original deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-unknown-history-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const conversation = registry.ensureForkedConversation("codex", path.join(root, "legacy.jsonl"), null, emptyLaunchProfile({ cwd: root }));
  registry.deliveryAdmissionForKey = (() => ({ outcome: "unknown", reason: "legacy delivery history is unavailable" })) as typeof registry.deliveryAdmissionForKey;
  try {
    const result = await stageRepairDelivery(registry, conversation.id, "legacy-repair", DEADLINE,
      { now: () => DEADLINE, client: null, progress: null });
    expect(result).toEqual({ operationId: null, state: "failed", safeToReplace: false });
    registry.deliveryAdmissionForKey = (() => ({ outcome: "admitted", operationId: "unreadable-operation",
      deliveryId: "unreadable-delivery", state: "delivery-uncertain" })) as typeof registry.deliveryAdmissionForKey;
    expect(await stageRepairDelivery(registry, conversation.id, "legacy-repair", DEADLINE,
      { now: () => DEADLINE, client: null, progress: null })).toEqual({
      operationId: "unreadable-operation", state: "failed", safeToReplace: false,
    });
  } finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
