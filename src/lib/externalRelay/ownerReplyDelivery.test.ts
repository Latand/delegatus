import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import * as registries from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { EngineHost } from "@/lib/runtime/engineHost";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import * as delivery from "@/lib/runtime/structuredMessageDelivery";
import { RuntimeJournal } from "@/runtime-host/journal";
import { observeOwnerContinuation, sendOwnerContinuation } from "./ownerRun";
import { newTargetSettings } from "./store";

test.each(["immediate", "three minutes later", "running", "retired", "retirement claimed", "reply admitted first"] as const)(
  "owner reply reaches its conversation and answers once: %s", async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reply-"));
    const registry = new registries.AgentRegistry(path.join(root, "registry.json"));
    const transcript = path.join(root, "session.jsonl");
    fs.writeFileSync(transcript, "");
    const accountId = "fixture-account";
    let now = Date.now();
    const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true, now: () => now });
    registry.reconcileConversations([{ engine: "claude", path: transcript, accountId,
      launchProfile: emptyLaunchProfile({ cwd: root }), turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: new Date(now).toISOString() }]);
    const conversation = registry.conversationForPath(transcript)!;
    const conversationId = conversation.id;
    const sessionKey = { engine: "claude" as const, sessionId: conversation.generations[0]!.id };
    let running = false;
    const publish = (reconciliationRevision: number) => journal.append({ scope: { type: "session", id: conversationId },
      kind: "session-status", payload: { conversationId, sessionKey, hostKind: "claude-broker", host: "hosted",
        turn: running ? "running" : "idle", activeTurnId: running ? "other-turn" : null, writerClaim: "fixture:1",
        artifactPath: transcript, accountId, reconciliationRevision } });
    publish(1);
    if (scenario === "three minutes later") now += 180_000;
    if (scenario === "running") { running = true; publish(2); }
    if (scenario === "retired" || scenario === "retirement claimed" || scenario === "reply admitted first") {
      const kill = journal.executeOperation({ kind: "kill", operationId: "retire", idempotencyKey: "retire",
        conversationId, sessionKey, onlyIfIdle: { revision: journal.readSession({ conversationId })!.revision, writerClaim: "fixture:1" } });
      if (scenario !== "reply admitted first") journal.transitionOperation(kill.operationId, "delivering");
      if (scenario === "retired") journal.transitionOperation(kill.operationId, "delivered");
    }
    const operationId = "fixture-reply";
    const turn = { conversationId, clientAttemptId: operationId, continuation: { operationId }, claimedAt: new Date(now).toISOString() };
    const client = { command: async cmd => journal.executeOperation(cmd), readSession: async () => journal.readSession({ conversationId }),
      operationStatus: async id => journal.operationResult(id) } as RuntimeHostClient;
    let recoveries = 0;
    const enqueue = delivery.enqueueStructuredMessage;
    const dispatch = spyOn(delivery, "enqueueStructuredMessage").mockImplementation((request, deps) => enqueue(request, {
      ...deps, enabled: () => true, registry: () => registry, client: () => client, kick: () => {}, republish: async () => false,
      recover: async () => { recoveries++; publish(3); return { conversationId, path: transcript, target: null, spawned: true }; },
    }));
    const prepare = spyOn(registries, "prepareAgentRegistry").mockResolvedValue(registry);
    const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId } as never });
    const writes: string[] = [];
    const host: EngineHost = {
      supportsQueuedSend: true, coalescesQueuedInput: true, acceptsInputDuringTurn: true, sendWaitsForRunningTurn: true,
      attach: () => ({ async *[Symbol.asyncIterator]() {} }), release: async () => {}, answer: async () => {},
      interrupt: async () => { throw Error("unexpected interrupt"); },
      health: async () => ({ status: running ? "active" : "idle", sessionKey: sessionKey.sessionId, endpoint: "fixture",
        pid: 1, processStartIdentity: "1", eventCursor: 0, protocolVersion: "test", activeTurnRef: running ? "other-turn" : null,
        pendingAttention: [], activeFlags: [], account: null }),
      send: async entry => {
        writes.push(entry.text);
        const timestamp = new Date(now + 1).toISOString();
        fs.appendFileSync(transcript, [{ type: "user", message: { role: "user", content: entry.text }, timestamp },
          { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixture answer" }] }, timestamp }]
          .map(row => JSON.stringify(row)).join("\n") + "\n");
        return { outcome: "turn-started", turnId: "reply-turn" };
      },
    };
    const queue = new StructuredDeliveryQueue({
      effects: async () => journal.effectBatch(100, ["runtime.send"]),
      status: async id => journal.operationResult(id)?.receipt ?? null,
      hostClaim: () => "fixture:1",
      transition: async (id, status, details, options) => {
        journal.transitionOperation(id, status, details, options);
        if (status === "delivering" && scenario === "three minutes later") publish(4);
      },
      idleContinuationCurrent: async (_, fence) => journal.readSession({ conversationId })?.revision === fence.revision,
    }, () => journal.readSession({ conversationId })?.host === "hosted" ? host : null, undefined, undefined,
    async () => { recoveries++; publish(6); return true; });
    try {
      const target = { ...newTargetSettings({ target_id: "target", name: "Fixture", answered_by: "install", fallback: "none" }), engine: "claude" as const };
      expect(await sendOwnerContinuation(turn, "Fixture reply", target, () => {})).toMatchObject({ ok: true, operationId });
      if (scenario === "retirement claimed") {
        await queue.drain();
        expect(writes).toEqual([]);
        expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
        journal.transitionOperation("retire", "delivered");
      }
      if (scenario === "reply admitted first") {
        expect(journal.transitionOperation("retire", "delivering").receipt.reason).toBe("idle-retirement-deferred");
      }
      if (running) {
        await queue.drain();
        expect(writes).toEqual([]);
        running = false;
        publish(5);
      }
      await queue.drain();
      const receipt = journal.operationResult(operationId)!.receipt;
      expect(receipt).toMatchObject({ status: "delivered" });
      expect(writes).toEqual(["Fixture reply"]);
      expect(recoveries).toBe(scenario === "retired" || scenario === "retirement claimed" ? 1 : 0);
      const observed = await observeOwnerContinuation(turn, { registry: () => registry, now: () => now + 2,
        liveness: async () => [{ reason: "host_alive_turn_idle", lastRecordAt: new Date(now + 2).toISOString() }] as never },
        async () => ({ state: "delivered", acceptedAt: turn.claimedAt, settledAt: receipt.at, conversationId }));
      expect(observed).toMatchObject({ state: "ended", finalText: "Fixture answer" });
    } finally {
      dispatch.mockRestore(); prepare.mockRestore(); select.mockRestore(); journal.close(); registry.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
