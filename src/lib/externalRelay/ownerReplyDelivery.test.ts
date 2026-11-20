import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import * as registries from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { EngineHost } from "@/lib/runtime/engineHost";
import { NativeCodexQueue, type NativeQueuedSubmission } from "@/lib/runtime/nativeCodexQueue";
import { NativeQueueExecutor, type NativeQueueHost } from "@/lib/runtime/nativeQueueExecutor";
import type { NativeQueueProof } from "@/lib/runtime/nativeQueueContracts";
import { settleNativeQueueEntry } from "@/lib/runtime/nativeQueueSettlement";
import { resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import * as delivery from "@/lib/runtime/structuredMessageDelivery";
import { RuntimeJournal } from "@/runtime-host/journal";
import { observeOwnerContinuation, sendOwnerContinuation } from "./ownerRun";
import { newTargetSettings } from "./store";

function codexQueue(threadId: string) {
  const submissions: NativeQueuedSubmission[] = [];
  let proof: NativeQueueProof | null = null;
  const host: NativeQueueHost = {
    queue: new NativeCodexQueue({ rpc: async (method, params) => {
      if (method !== "thread/queue/add" || params.threadId !== threadId) throw new Error("unexpected queue RPC");
      const queuedSubmission = { id: "native-submission", clientUserMessageId: String(params.clientUserMessageId),
        input: params.input as NativeQueuedSubmission["input"] };
      submissions.push(queuedSubmission);
      return { queuedSubmission };
    } }, threadId),
    prepare: async (_, version) => [{ type: "text", text: version.text }],
    evidence: async () => proof,
    sendWithdrawn: async () => { throw new Error("unexpected withdrawn send"); },
  };
  return { host, submissions, consume() {
    expect(submissions).toHaveLength(1);
    const { clientUserMessageId, input } = submissions[0]!;
    const item = input[0];
    if (item?.type !== "text") throw new Error("missing Codex text input");
    proof = { threadId, clientUserMessageId, input, revision: 1, turnId: "reply-turn", itemId: "reply-item" };
    return item.text;
  } };
}

const targets = [
  { engine: "claude", hostKind: "claude-broker", nativeQueue: false },
  { engine: "codex", hostKind: "codex-app-server", nativeQueue: true },
  { engine: "codex", hostKind: "codex-app-server", nativeQueue: false },
] as const;

const scenarios = ["immediate", "reconciliation before claim", "three minutes later", "running",
  "retired", "retirement claimed", "reply admitted first", "host exits before journal admission"] as const;

for (const { engine, hostKind, nativeQueue } of targets) test.each([...scenarios])(
  `${hostKind}, native queue ${nativeQueue}: owner reply reaches its conversation and answers once: %s`, async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reply-"));
    const registry = new registries.AgentRegistry(path.join(root, "registry.json"));
    const transcript = path.join(root, "session.jsonl");
    fs.writeFileSync(transcript, "");
    const accountId = "fixture-account";
    let now = Date.now();
    const previousAnswerAt = new Date(now - 1).toISOString();
    const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true, now: () => now });
    registry.reconcileConversations([{ engine, path: transcript, accountId,
      launchProfile: emptyLaunchProfile({ cwd: root }), turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: new Date(now).toISOString() }]);
    const conversation = registry.conversationForPath(transcript)!;
    const conversationId = conversation.id;
    const sessionKey = { engine, sessionId: conversation.generations[0]!.id };
    let running = false;
    const publish = (reconciliationRevision: number) => journal.append({ scope: { type: "session", id: conversationId },
      kind: "session-status", payload: { conversationId, sessionKey, hostKind, host: "hosted", capabilities: { nativeQueue },
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
    const codex = codexQueue(sessionKey.sessionId);
    const client: Partial<RuntimeHostClient> = {
      command: async cmd => {
        if (scenario === "host exits before journal admission") {
          journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status",
            payload: { conversationId, host: "dead", turn: "idle", activeTurnId: null } });
          expect(journal.readSession({ conversationId })).toMatchObject({ host: "dead", capabilities: { nativeQueue } });
        }
        return journal.executeOperation(cmd);
      },
      readSession: async () => journal.readSession({ conversationId }),
      operationStatus: async id => journal.operationResult(id),
      nativeQueueRead: async id => journal.nativeQueueRead(id),
      nativeQueueTransition: async (id, change) => {
        if (change.phase === "prepared" && scenario === "reconciliation before claim") publish(4);
        const result = journal.nativeQueueTransition(id, change);
        if (change.phase === "prepared" && scenario === "three minutes later") publish(4);
        return result;
      },
    };
    let recoveries = 0;
    const enqueue = delivery.enqueueStructuredMessage;
    const dispatch = spyOn(delivery, "enqueueStructuredMessage").mockImplementation((request, deps) => enqueue(request, {
      ...deps, enabled: () => true, registry: () => registry, client: () => client as RuntimeHostClient, kick: () => {}, republish: async () => false,
      recover: async () => { recoveries++; publish(3); return { conversationId, path: transcript, target: null, spawned: true }; },
    }));
    const prepare = spyOn(registries, "prepareAgentRegistry").mockResolvedValue(registry);
    const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId } as never });
    const writes: string[] = [];
    let lastRecordAt = previousAnswerAt;
    const appendTurn = (text: string, reply: string, timestamp: string) => {
      const records = engine === "codex" ? [
        { type: "event_msg", payload: { type: "user_message", message: text } },
        { type: "event_msg", payload: { type: "agent_message", message: reply } },
      ] : [
        { type: "user", message: { role: "user", content: text } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } },
      ];
      fs.appendFileSync(transcript, records.map(row => JSON.stringify({ timestamp, ...row })).join("\n") + "\n");
      lastRecordAt = timestamp;
    };
    appendTurn("Earlier request", "Earlier answer", previousAnswerAt);
    const answer = (text: string) => {
      writes.push(text);
      appendTurn(text, "Fixture answer", new Date(Math.max(now, Date.now()) + 1).toISOString());
    };
    const host: EngineHost = {
      ...(engine === "claude"
        ? { supportsQueuedSend: true, coalescesQueuedInput: true, acceptsInputDuringTurn: true, sendWaitsForRunningTurn: true }
        : { supportsSteer: true, nativeQueue: nativeQueue ? codex.host : undefined }),
      attach: () => ({ async *[Symbol.asyncIterator]() {} }), release: async () => {}, answer: async () => {},
      interrupt: async () => { throw Error("unexpected interrupt"); },
      health: async () => ({ status: running ? "active" : "idle", sessionKey: sessionKey.sessionId, endpoint: "fixture",
        pid: 1, processStartIdentity: "1", eventCursor: 0, protocolVersion: "test", activeTurnRef: running ? "other-turn" : null,
        pendingAttention: [], activeFlags: [], account: null }),
      send: async entry => {
        const text = entry.content?.text ?? entry.text;
        if (text === undefined) throw new Error("reply text missing");
        answer(text);
        return { outcome: "turn-started", turnId: "reply-turn" };
      },
    };
    const resolveHost = () => journal.readSession({ conversationId })?.host === "hosted" ? host : null;
    const executor = new NativeQueueExecutor({ client: client as RuntimeHostClient, resolveHost,
      binding: () => ({ threadId: sessionKey.sessionId, accountId }),
      settled: entry => settleNativeQueueEntry(registry, entry) });
    const observe = () => observeOwnerContinuation(turn, { registry: () => registry, now: () => now,
      liveness: async () => [{ reason: "host_alive_turn_idle", lastRecordAt }] as never },
      id => resolveSendReceipt(id, { registry, client: client as RuntimeHostClient, progress: null }));
    const queue = new StructuredDeliveryQueue({
      effects: async () => journal.effectBatch(100, ["runtime.send", "runtime.native-queue"]),
      status: async id => journal.operationResult(id)?.receipt ?? null,
      hostClaim: () => "fixture:1",
      nativeQueueExecute: (...args) => executor.execute(...args),
      nativeQueueReconcile: async () => { await executor.reconcile(conversationId); },
      transition: async (id, status, details, options) => {
        if (status === "delivering" && scenario === "reconciliation before claim") publish(4);
        journal.transitionOperation(id, status, details, options);
        if (status === "delivering" && scenario === "three minutes later") publish(4);
      },
      idleContinuationCurrent: async (_, fence) => journal.readSession({ conversationId })?.revision === fence.revision,
    }, resolveHost, undefined, undefined,
    async () => { recoveries++; publish(6); return true; });
    try {
      const target = { ...newTargetSettings({ target_id: "target", name: "Fixture", answered_by: "install", fallback: "none" }), engine };
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
      const hostUnavailableAtAdmission = scenario === "retirement claimed" || scenario === "host exits before journal admission";
      const native = nativeQueue && !hostUnavailableAtAdmission;
      expect(journal.effectBatch(100, ["runtime.send", "runtime.native-queue"]).map(effect => effect.kind))
        .toEqual([native ? "runtime.native-queue" : "runtime.send"]);
      if (running) {
        await queue.drain();
        expect(writes).toEqual([]);
        expect(await observe()).toMatchObject({ state: "running", firstMessagePending: true });
        expect(codex.submissions).toHaveLength(native ? 1 : 0);
        running = false;
        publish(5);
      }
      await queue.drain();
      if (native) {
        expect(codex.submissions).toMatchObject([{ clientUserMessageId: operationId }]);
        expect(journal.nativeQueueRead(conversationId)).toMatchObject([{ binding: { threadId: sessionKey.sessionId, accountId },
          entryId: operationId, state: "queued", proof: null }]);
        expect(await observe()).toMatchObject({ state: "running", firstMessagePending: true });
        answer(codex.consume());
      }
      await queue.drain();
      expect(codex.submissions).toHaveLength(native ? 1 : 0);
      if (native) expect(journal.nativeQueueRead(conversationId)).toMatchObject([{ state: "delivered",
        proof: { threadId: sessionKey.sessionId, clientUserMessageId: operationId, turnId: "reply-turn" } }]);
      const receipt = journal.operationResult(operationId)!.receipt;
      expect(receipt).toMatchObject({ status: "delivered" });
      expect(writes).toEqual(["Fixture reply"]);
      expect(recoveries).toBe(scenario === "retired" || hostUnavailableAtAdmission ? 1 : 0);
      expect(await observe()).toMatchObject({ state: "ended", conversationId, finalText: "Fixture answer" });
    } finally {
      dispatch.mockRestore(); prepare.mockRestore(); select.mockRestore(); journal.close(); registry.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
