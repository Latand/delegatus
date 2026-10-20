import { expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
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
