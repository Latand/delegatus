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

test.each(["queued", "delivering", "unreachable"] as const)("parallel C: retry settles the prior %s journal operation before another message", async state => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-retry-journal-")); roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"));
  const conversation = registry.ensureConversation("claude", path.join(root, "fork.jsonl"), null);
  const deputy = { askId: "deputy-retry", deputyConversationId: conversation.id, artifactPath: path.join(root, "fork.jsonl"), attempt: 0 } as OrchestratorDeputy;
  const delivery = registry.holdDelivery(conversation.id, "saved question", deputyMessageKey(deputy.askId), "text", [], null,
    { operationId: "prior-question" }, { recoveryIntent: "reclaimed-host" });
  // A claimed send has crossed the registry boundary; only the journal can
  // prove whether its host actuation began.
  registry.beginDeliveryAttempt(delivery.id, conversation.generations.at(-1)!.id);
  journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: {
    conversationId: conversation.id, sessionKey: { engine: "claude", sessionId: conversation.generations.at(-1)!.id },
    hostKind: "claude-broker", host: "hosted", turn: "idle", provenance: "structured", artifactPath: deputy.artifactPath,
    capabilities: { steer: false, structuredAttention: true },
  } });
  journal.executeOperation({ kind: "send", conversationId: conversation.id, operationId: "prior-question", idempotencyKey: deputyMessageKey(deputy.askId), text: "saved question", policy: "queue" });
  if (state !== "queued") journal.transitionOperation("prior-question", "delivering");
  const client = { readSession: async () => null,
    operationStatus: async (id: string) => { if (state === "unreachable") throw new Error("runtime unavailable"); return journal.operationResult(id); },
    transitionOperation: async (id: string, status: Parameters<RuntimeJournal["transitionOperation"]>[1], options: Parameters<RuntimeJournal["transitionOperation"]>[2]) => journal.transitionOperation(id, status, options),
  } as unknown as RuntimeHostClient;
  try {
    const port = productionDeputyCommandPorts({ registry, client: () => client });
    const result = await port.prepareRetry!(deputy, () => {});
    expect(result.ok).toBe(state === "queued");
    expect(journal.operationResult("prior-question")?.receipt.status).toBe(state === "queued" ? "failed" : state === "delivering" ? "uncertain" : "delivering");
    const reopened = new AgentRegistry(registry.filename);
    expect(reopened.deliveryAdmissionForKey(conversation.id, deputyMessageKey(deputy.askId))).toMatchObject({ state: "failed" });
    reopened.close();
  } finally { registry.close(); journal.close(); }
});
