import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { RuntimeJournal } from "@/runtime-host/journal";
import { UnixRuntimeHostClient, type RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { StructuredDeliveryQueue, type StructuredDeliveryEffect } from "./structuredDeliveryQueue";
import { FakeEngineHost } from "./fixtures/fakeEngineHost";
import type { EngineHost } from "./engineHost";

const roots: string[] = [];
afterEach(async () => {
  await bindStructuredDeliveryQueue([], { client: null });
  setSystemTime();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-switch-"));
  roots.push(root);
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
  return { root, registry, conversation, key, journal, host, client };
}

test("production controller applies a pick after usage_limit_exceeded without another message or turn end", async () => {
  const f = fixture();
  let creates = 0;
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client,
      reconfigure: {
        validateAccount: async () => {}, resolveAccount: () => ({}) as never, releaseHost: async () => true,
        migrate: (id, _target, registry, ownsOperation, reconfigureOperationId) => advanceConversationMigration(id, registry, {
          create: async input => { creates++; return { operationId: input.operationId, nativeId: "successor", path: path.join(f.root, "successor.jsonl"),
            continuityPaths: [], historyHash: "fixture", host: { kind: "codex-app-server", identity: "fixture-successor", epoch: 1, verifiedAt: new Date().toISOString() } }; },
          verify: async () => {},
        }, { ownsOperation, reconfigureOperationId }),
      },
    });
    f.journal.executeOperation({ kind: "reconfigure", operationId: "switch", idempotencyKey: "switch",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt.status).toBe("applied");
    expect(f.registry.conversation(f.conversation.id)?.migration?.phase).toBe("committed");
    expect(f.registry.conversation(f.conversation.id)?.generations.at(-1)?.accountId).toBe("account-b");
    expect(creates).toBe(1);
  } finally { await bindStructuredDeliveryQueue([], { client: null }); f.journal.close(); f.registry.close(); }
});

test("production native-queue reconciliation bounds retries despite sixty seconds of admission wakes", async () => {
  const f = fixture();
  const nativeHost = Object.assign(f.host, { nativeQueue: {} as NonNullable<EngineHost["nativeQueue"]> });
  let reads = 0;
  f.client.nativeQueueRead = async () => { reads++; throw new Error("runtime host request timed out"); };
  f.client.nativeQueueTransition = async () => { throw new Error("unexpected transition"); };
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: nativeHost }], { registry: f.registry, client: f.client });
    let snapshots = 0;
    const snapshot = f.registry.readOnlySnapshot.bind(f.registry);
    f.registry.readOnlySnapshot = () => { snapshots++; return snapshot(); };
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      await kickStructuredDeliveryQueue();
    }
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(7);
    expect(snapshots).toBeLessThanOrEqual(40);
  } finally { await bindStructuredDeliveryQueue([], { client: null }); f.journal.close(); f.registry.close(); }
});

test("a runtime socket that never answers receives at most six drain requests per minute", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-silent-"));
  roots.push(root);
  const sockets = new Set<net.Socket>();
  let requests = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => requests++);
  });
  const socketPath = path.join(root, "host.sock");
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const client = new UnixRuntimeHostClient(socketPath, 10);
  const queue = new StructuredDeliveryQueue({ effects: (kinds, after) => client.effectBatch(kinds, after), transition: async () => {} }, () => null);
  try {
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 15) {
      setSystemTime(start + elapsed);
      await queue.drain().catch(() => {});
    }
    expect(requests).toBe(6);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("an applying switch backs off without delaying other sends or a new account pick", async () => {
  let applies = 0;
  let healthReads = 0;
  let statusReads = 0;
  const host = new FakeEngineHost();
  const health = host.health.bind(host);
  host.health = async () => { healthReads++; return health(); };
  const other = new FakeEngineHost();
  let sent = false;
  let replacementApplied = false;
  const switches: StructuredDeliveryEffect[] = [{ id: "pending-switch", kind: "runtime.reconfigure", eventSeq: 1,
    payload: { operationId: "pending-switch", conversationId: "conversation_pending", model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" } }];
  const queue = new StructuredDeliveryQueue({
    terminalTurn: () => true,
    effects: async () => [...switches, ...sent ? [] : [{ id: "other-send", kind: "runtime.send", eventSeq: 2,
      payload: { operationId: "other-send", conversationId: "conversation_other", text: "continue", policy: "queue" } }]],
    status: async () => { statusReads++; return { status: "queued" }; },
    transition: async (id, status) => {
      if (id === "other-send" && status === "delivered") sent = true;
      if (id === "replacement" && status === "applied") replacementApplied = true;
    },
  }, id => id === "conversation_other" ? other : host, undefined, undefined, undefined,
  async effect => { applies++; return effect.operationId === "replacement" ? "applied" : "pending"; });
  const start = Date.now();
  for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
    setSystemTime(start + elapsed);
    await queue.drain();
  }
  expect(applies).toBe(6);
  expect(healthReads).toBe(6);
  expect(statusReads).toBeLessThanOrEqual(30);
  expect(other.ledger.writes).toHaveLength(1);
  switches.push({ id: "replacement", kind: "runtime.reconfigure", eventSeq: 3,
    payload: { ...switches[0]!.payload, operationId: "replacement", accountId: "account-c" } });
  await queue.drain();
  expect(replacementApplied).toBe(true);
});
