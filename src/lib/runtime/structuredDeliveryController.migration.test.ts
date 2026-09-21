import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { UnixRuntimeHostClient, type RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { NativeCodexQueue } from "./nativeCodexQueue";
import { FakeEngineHost } from "./fixtures/fakeEngineHost";
import type { EngineHost } from "./engineHost";

const roots: string[] = [];
afterEach(async () => {
  await bindStructuredDeliveryQueue([], { client: null });
  setSystemTime();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const f = migrationDeliveryFixture();
  roots.push(f.root);
  return f;
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

async function silentRuntime(root: string) {
  const sockets = new Set<net.Socket>();
  let requests = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => requests++);
  });
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\llv-silent-${crypto.randomUUID()}` : path.join(root, "host.sock");
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return { client: new UnixRuntimeHostClient(socketPath, 10, 10, 10), requests: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function addTarget(f: ReturnType<typeof fixture>, name: string) {
  const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  const pathname = path.join(f.root, `${name}.jsonl`);
  fs.writeFileSync(pathname, "");
  f.registry.reconcileConversations([{ engine: "codex", path: pathname, accountId: "account-a",
    launchProfile: entry.launchProfile!, turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date().toISOString() }]);
  const conversation = f.registry.conversationForPath(pathname)!;
  const key = { engine: "codex" as const, sessionId: conversation.generations.at(-1)!.id };
  f.registry.upsert({ ...entry, key, artifactPath: pathname });
  const host = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  return { key, host, conversation };
}

test.each(["native-read", "receipt-read"] as const)("production controller bounds total native execution and reconciliation reads with parked and successful targets (%s)", async fault => {
  const f = fixture();
  const silent = await silentRuntime(f.root);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const parked = addTarget(f, "parked");
  const healthy = addTarget(f, "healthy");
  const native = new NativeCodexQueue({ rpc: async () => { throw new Error("must not actuate an unreadable queue"); } }, f.key.sessionId);
  const nativeHost = Object.assign(f.host, { nativeQueue: { queue: native,
    prepare: async () => [], evidence: async () => null, sendWithdrawn: async () => { throw new Error("unexpected send"); },
  } });
  let interrupts = 0;
  nativeHost.interrupt = async () => { interrupts++; };
  const health = nativeHost.health.bind(nativeHost);
  nativeHost.health = async () => ({ ...await health(), status: "active", activeTurnRef: "native-turn", activeFlags: ["native-queue"] });
  f.client.nativeQueueRead = id => silent.client.nativeQueueRead!(id);
  f.client.nativeQueueTransition = async (id, change) => f.journal.nativeQueueTransition(id, change);
  if (fault === "receipt-read") {
    const operationStatus = f.client.operationStatus.bind(f.client);
    f.client.operationStatus = (id, options) => id === "native-send"
      ? silent.client.operationStatus(id, options) : operationStatus(id, options);
  }
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: nativeHost }, parked, healthy], { registry: f.registry, client: f.client });
    f.journal.executeOperation({ kind: "native-queue", operationId: "native-send", idempotencyKey: "native-send",
      conversationId: f.conversation.id, action: "add", text: "preserve original payload", binding: { threadId: f.key.sessionId, accountId: "account-a" } });
    f.journal.executeOperation({ kind: "reconfigure", operationId: "parked-pick", idempotencyKey: "parked-pick",
      conversationId: parked.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    const original = f.journal.nativeQueueRead(f.conversation.id)[0]!;
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      if (elapsed % 10_000 === 0) f.journal.executeOperation({ kind: "send", operationId: `healthy-${elapsed}`, idempotencyKey: `healthy-${elapsed}`,
        conversationId: healthy.conversation.id, text: "continue", policy: "queue" });
      if (elapsed === 50_000) f.journal.executeOperation({ kind: "interrupt", operationId: "native-interrupt", idempotencyKey: "native-interrupt",
        conversationId: f.conversation.id });
      await kickStructuredDeliveryQueue();
    }
    expect(interrupts).toBe(1);
    expect(f.journal.operationResult("native-interrupt")?.receipt.status).toBe("interrupted");
    expect(healthy.host.ledger.writes).toHaveLength(6);
    expect(f.journal.operationResult("parked-pick")?.receipt.status).toBe("queued");
    expect(f.journal.operationResult("native-send")?.receipt.status).toBe("queued");
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]).toEqual(original);
    expect(silent.requests()).toBeGreaterThan(1);
    expect(silent.requests()).toBeLessThanOrEqual(14);
  } finally { await f.cleanup(); await silent.close(); errors.mockRestore(); }
}, 20_000);

test("production controller bounds effect reads when the runtime socket never answers", async () => {
  const f = fixture();
  const silent = await silentRuntime(f.root);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client });
    f.client.effectBatch = (kinds, after) => silent.client.effectBatch(kinds, after);
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      await kickStructuredDeliveryQueue();
    }
    expect(silent.requests()).toBeGreaterThan(1);
    expect(silent.requests()).toBeLessThanOrEqual(7);
  } finally { await f.cleanup(); await silent.close(); errors.mockRestore(); }
}, 20_000);

test("production applying switch bounds unreadable host checks while other sends and a replacement pick progress", async () => {
  const f = fixture();
  const other = addTarget(f, "other");
  const silent = await silentRuntime(f.root);
  let unavailable = false;
  const health = f.host.health.bind(f.host);
  f.host.health = async () => { if (unavailable) await silent.client.snapshot(); return health(); };
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }, other], { registry: f.registry, client: f.client,
      reconfigure: { validateAccount: async () => { throw new Error("replacement account requires authentication"); } },
    });
    unavailable = true;
    f.journal.executeOperation({ kind: "reconfigure", operationId: "applying", idempotencyKey: "applying",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    f.journal.transitionOperation("applying", "applying");
    f.registry.claimConversationReconfigure(f.conversation.id, { operationId: "applying", revision: 1,
      profile: { model: "gpt-5.6-sol", effort: "high", fast: false }, accountId: "account-b" });
    f.journal.executeOperation({ kind: "send", operationId: "other-send", idempotencyKey: "other-send",
      conversationId: other.conversation.id, text: "continue", policy: "queue" });
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      await kickStructuredDeliveryQueue();
    }
    expect(other.host.ledger.writes).toHaveLength(1);
    expect(f.journal.operationResult("applying")?.receipt.status).toBe("applying");
    expect(silent.requests()).toBeGreaterThan(1);
    expect(silent.requests()).toBeLessThanOrEqual(6);
    unavailable = false;
    f.journal.executeOperation({ kind: "reconfigure", operationId: "replacement", idempotencyKey: "replacement",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-c" });
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("applying")?.receipt.reason).toBe("superseded");
    expect(f.journal.operationResult("replacement")?.receipt.status).toBe("failed");
  } finally { await f.cleanup(); await silent.close(); }
}, 20_000);
