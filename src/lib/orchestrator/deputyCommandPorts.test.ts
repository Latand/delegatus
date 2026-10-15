import { afterEach, expect, test } from "bun:test";
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
