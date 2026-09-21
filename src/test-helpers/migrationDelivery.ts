import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { bindStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliverySignal";
import { FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";

export function migrationDeliveryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-switch-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const transcript = path.join(root, "source.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "event_msg", payload: {
    type: "task_complete", error: { codex_error_info: "usage_limit_exceeded" },
  } }) + "\n");
  const profile = emptyLaunchProfile({ cwd: root, model: "gpt-5.6-sol", effort: "high", fast: false });
  registry.reconcileConversations([{ engine: "codex", path: transcript, accountId: "account-a", launchProfile: profile,
    turn: { state: "terminal", source: "lifecycle", terminalAt: new Date().toISOString() }, observedAt: new Date().toISOString() }]);
  const conversation = registry.conversationForPath(transcript)!;
  const key = { engine: "codex" as const, sessionId: conversation.generations.at(-1)!.id };
  registry.upsert({ key, artifactPath: transcript, cwd: root, accountId: "account-a", launchProfile: profile,
    status: "idle", host: null, structuredHost: { kind: "codex-app-server", endpoint: "fake:host", process: null,
      eventCursor: 0, protocolVersion: "fake", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "fixture", pendingAction: null });
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"), { structuredHosts: true });
  const host = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  const client = {
    append: async (event: Parameters<RuntimeJournal["append"]>[0]) => journal.append(event),
    producerCursor: async () => 0,
    snapshot: async () => journal.snapshot(),
    effectBatch: async (kinds: string[], after: number) => journal.effectBatch(100, kinds, after),
    operationStatus: async (id: string) => journal.operationResult(id),
    transitionOperation: async (...args: Parameters<RuntimeJournal["transitionOperation"]>) => journal.transitionOperation(...args),
  } as unknown as RuntimeHostClient;
  return { root, registry, conversation, key, journal, host, client, cleanup: async () => {
    await bindStructuredDeliveryQueue([], { client: null });
    journal.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true });
  } };
}

/** Real held switch and failed preflight, with only account authentication isolated. */
export async function failHeldSwitch(f: ReturnType<typeof migrationDeliveryFixture>) {
  let active = true;
  const health = f.host.health.bind(f.host);
  f.host.health = async () => ({ ...await health(), status: active ? "active" : "idle", activeTurnRef: active ? "running" : null });
  await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client,
    reconfigure: { validateAccount: async () => { throw new Error("target account requires authentication"); } },
  });
  f.journal.executeOperation({ kind: "reconfigure", operationId: "switch", idempotencyKey: "switch",
    conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
  const delivery = f.registry.holdDelivery(f.conversation.id, "continue", "held-send", "text", [], null,
    { operationId: "held-send", kind: "send", policy: "queue", turnId: null });
  f.registry.beginDeliveryAttempt(delivery.id, delivery.generationId!);
  f.journal.executeOperation({ kind: "send", operationId: "held-send", idempotencyKey: "held-send",
    conversationId: f.conversation.id, text: "continue", policy: "queue" });
  await kickStructuredDeliveryQueue();
  const held = f.journal.operationResult("held-send")!.receipt;
  active = false;
  await kickStructuredDeliveryQueue();
  return { held, delivery, failed: f.journal.operationResult("held-send")!.receipt };
}
