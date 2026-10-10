import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { AgentRegistry } from "@/lib/agent/registry";
import { registryLockHolder } from "@/lib/agent/registryLockHolderFixture";
import { RuntimeJournal } from "@/runtime-host/journal";
import { withConversationActuation } from "@/lib/deliveryActuation";
import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { terminalRetryOperationId } from "./contracts";
import { DeliveryProgressStore } from "./deliveryProgress";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { handleRuntimeRetry } from "./http";
import { StructuredDeliveryQueue, type StructuredDeliveryEffect } from "./structuredDeliveryQueue";
import { deliverHeldStructuredMessage } from "./structuredMessageDelivery";
import { recordDirectWait } from "./recordWait";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retry-progress-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
    { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite"), sqliteWriterDeadlineMs: 80 });
  const conversation = registry.ensureConversation("codex", path.join(root, "recipient.jsonl"), "source");
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  const progress = new DeliveryProgressStore(path.join(root, "progress.sqlite"));
  const operationId = "retry-progress-original";
  const key = "retry-progress-original-key";
  const reservation = registry.holdDelivery(conversation.id, "one original input", key, "text", [], null,
    { operationId, kind: "send", policy: "queue" });
  const publish = (host: "hosted" | "unhosted" = "hosted") => journal.append({ scope: { type: "session", id: conversation.id },
    kind: "session-status", payload: { conversationId: conversation.id, sessionKey: { engine: "codex", sessionId: "retry-progress-session" },
      hostKind: "codex-app-server", host, turn: "idle", provenance: "structured", capabilities: { steer: true, structuredAttention: true } } });
  publish();
  journal.executeOperation({ kind: "send", operationId, idempotencyKey: key, conversationId: conversation.id, text: reservation.text, policy: "queue" });
  const client = {
    operationStatus: async (id, options) => options?.currentRetryLeaf ? journal.currentRetryResult(id) : journal.operationResult(id),
    claimDeliveryAction: async (...args) => journal.claimDeliveryAction(...args),
    retryOperation: async (...args) => journal.retryOperation(...args),
    transitionOperation: async (...args) => journal.transitionOperation(...args),
    readSession: async (identity) => journal.readSession(identity),
    command: async (command) => journal.executeOperation(command),
  } satisfies Partial<RuntimeHostClient> as RuntimeHostClient;
  let kicks = 0;
  const dependencies = { enabled: () => true, client: () => client, registry: () => registry, progress,
    kick: () => { kicks += 1; }, recover: async () => ({ conversationId: conversation.id }) as never };
  const retry = (uncertain = true) => handleRuntimeRetry(new NextRequest("http://127.0.0.1/api/runtime/retry", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(uncertain ? { action: "retry-uncertain" } : {}),
  }), operationId, dependencies);
  const uncertain = () => {
    registry.beginDeliveryAttempt(reservation.id, reservation.generationId!);
    journal.transitionOperation(operationId, "delivering");
    journal.transitionOperation(operationId, "uncertain", { reason: "acknowledgement lost" });
    progress.note(operationId, conversation.id, { waitReason: "dispatching", executorId: "ended-executor", originalKey: key });
    progress.settle(operationId, "uncertain", "acknowledgement lost");
  };
  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger);
  const queue = (sink = progress) => new StructuredDeliveryQueue({
    effects: async (kinds, after) => journal.effectBatch(100, kinds, after) as StructuredDeliveryEffect[],
    status: async (id) => journal.operationResult(id)?.receipt ?? null,
    transition: async (...args) => { journal.transitionOperation(...args); },
    settled: async () => false,
    progress: sink,
  }, () => host, undefined, undefined, undefined, undefined, undefined, undefined, { passBudgetMs: 20, stallMs: 25 });
  return { root, registry, journal, progress, operationId, key, reservation, conversation, publish, client, dependencies,
    retry, uncertain, ledger, host, queue, kicks: () => kicks,
    close() { progress.close(); journal.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const step of ["checking", "dispatching"] as const) {
  test(`retry-uncertain replay preserves the active queue's ${step} record and produces one input`, async () => {
    const f = fixture();
    const blocked = deferred<void>();
    const section = deferred<void>();
    let actor: Promise<unknown> | undefined;
    const queue = f.queue();
    try {
      f.uncertain();
      expect((await f.retry()).status).toBe(202);
      const original = step === "checking" ? f.host.health.bind(f.host) : f.host.send.bind(f.host);
      if (step === "checking") f.host.health = async () => { await blocked.promise; return (original as typeof f.host.health)(); };
      else f.host.send = async (entry) => { await blocked.promise; return (original as typeof f.host.send)(entry); };
      await queue.drain();
      await Bun.sleep(40);
      await queue.tick();
      const standing = f.progress.get(f.operationId)!;
      expect(standing.waitReason).toBe(step);
      expect(standing.stalledSince).not.toBeNull();
      expect(typeof standing.deadlineAt).toBe("string");
      if (step === "checking") {
        const entered = deferred<void>();
        actor = withConversationActuation(f.conversation.id, async (lease) => {
          lease.act(f.operationId); entered.resolve(); await section.promise;
        });
        await entered.promise;
      }
      expect((await f.retry()).status).toBe(step === "dispatching" ? 409 : 202);
      expect(f.progress.get(f.operationId)).toEqual(standing);
      blocked.resolve();
      await until(() => f.ledger.writes.length === 1);
      await queue.drain();
      expect(f.ledger.writes).toHaveLength(1);
      expect(f.journal.currentRetryResult(f.operationId)?.operationId).toBe(f.operationId);
    } finally { section.resolve(); await actor; blocked.resolve(); await Bun.sleep(30); queue.retire(); f.close(); }
  });
}

test("a fresh uncertain rearm releases its ended executor and a restarted reconcile records the session wait", async () => {
  const f = fixture();
  const session = deferred<null>();
  let restarted: DeliveryProgressStore | undefined;
  try {
    f.uncertain();
    expect((await f.retry()).status).toBe(202);
    expect(f.progress.get(f.operationId)?.executorId).toBeNull();
    f.progress.flush();
    f.progress.close();
    restarted = new DeliveryProgressStore(path.join(f.root, "progress.sqlite"));
    const reconciling = deliverHeldStructuredMessage({ conversationId: f.conversation.id, path: f.conversation.generations[0]!.path,
      deliveryId: f.reservation.id, clientMessageId: f.key, text: f.reservation.text, command: f.reservation.command, reconcileUncertain: true },
      { enabled: () => true, registry: () => f.registry, client: () => ({ ...f.client, readSession: () => session.promise }), progress: restarted, recover: async () => null });
    await Bun.sleep(4_100);
    expect(restarted.get(f.operationId)).toMatchObject({ waitReason: "checking", detail: "reading the recipient's runtime session", executorId: null });
    session.resolve(null);
    await reconciling;
  } finally { session.resolve(null); restarted?.close(); f.close(); }
});

for (const failure of ["lost-ack", "refused-claim", "queue-won"] as const) {
  test(`an uncertain retry with ${failure} records its reason and wake without replacing a queue record`, async () => {
    const f = fixture();
    const holder = registryLockHolder(path.join(f.root, "registry.sqlite"));
    const claim = f.registry.beginDeliveryAttemptOffLoop.bind(f.registry);
    try {
      f.uncertain();
      if (failure === "refused-claim") {
        f.registry.beginDeliveryAttemptOffLoop = async (...args) => { await holder.hold(600); return claim(...args); };
      } else {
        f.client.retryOperation = async (...args) => {
          f.journal.retryOperation(...args);
          if (failure === "queue-won") f.progress.note(f.operationId, f.conversation.id, { waitReason: "dispatching", executorId: "active-queue", nextWakeMs: 5_000 });
          throw new RuntimeHostUnavailableError("runtime host request timed out");
        };
      }
      expect((await f.retry()).status).toBe(503);
      const record = f.progress.get(f.operationId)!;
      expect(record.waitReason).toBe(failure === "queue-won" ? "dispatching" : failure === "refused-claim" ? "checking" : "evidence-unreadable");
      if (failure === "refused-claim") expect(record.detail).toContain("write lock stayed held");
      expect(record.nextWakeAt).not.toBeNull();
      expect(f.kicks()).toBe(1);
      await holder.release();
      f.registry.beginDeliveryAttemptOffLoop = claim;
      if (failure === "refused-claim") expect((await f.retry()).status).toBe(202);
      f.progress.flush();
      const restarted = new DeliveryProgressStore(path.join(f.root, "progress.sqlite"));
      const queue = f.queue(restarted);
      await queue.drain();
      await until(() => f.ledger.writes.length === 1);
      await queue.drain();
      expect(f.ledger.writes).toHaveLength(1);
      queue.retire(); restarted.close();
    } finally { await holder.close(); f.close(); }
  });
}

for (const led of [false, true]) {
  test(`a terminal retry replay restores missing progress immediately and preserves an existing queue record (${led})`, async () => {
    const f = fixture();
    try {
      f.journal.transitionOperation(f.operationId, "failed", { reason: "not delivered" });
      f.registry.recordDeliveryOutcome(f.reservation.id, "failed", "not delivered", "lost");
      const leaf = f.journal.retryOperation(f.operationId, "retry-progress-fresh-key");
      const owner = f.registry.recordDirectAdmission({ operationId: leaf.operationId, retryOf: f.operationId })!;
      if (led) {
        recordDirectWait(f.progress, f.registry, owner, { reason: "queued" });
        f.progress.note(leaf.operationId, f.conversation.id, { waitReason: "dispatching", executorId: "active-queue" });
      }
      const standing = f.progress.get(leaf.operationId);
      expect((await f.retry(false)).status).toBe(202);
      const record = f.progress.get(leaf.operationId);
      expect(record).toMatchObject({ originalKey: owner.clientMessageId, admittedAt: owner.createdAt, terminal: null });
      expect(record?.deadlineAt).not.toBeNull();
      if (led) expect(record).toEqual(standing);
      else expect(record?.waitReason).toBe("queued");
    } finally { f.close(); }
  });
}

for (const led of [false, true]) test(`terminal retry recovery after reservation names its steps and preserves parallel queue ownership (${led})`, async () => {
  const f = fixture();
  const recovered = deferred<void>();
  const republished = deferred<void>();
  let recoveries = 0;
  let republishes = 0;
  let retries = 0;
  let retrying: ReturnType<typeof f.retry> | undefined;
  const leaf = terminalRetryOperationId(f.operationId);
  try {
    f.journal.transitionOperation(f.operationId, "failed", { reason: "not delivered" });
    f.registry.recordDeliveryOutcome(f.reservation.id, "failed", "not delivered", "lost");
    f.dependencies.recover = async () => {
      recoveries += 1;
      if (recoveries === 2) await recovered.promise;
      f.publish();
      return { conversationId: f.conversation.id } as never;
    };
    Object.assign(f.dependencies, { republish: async () => { republishes += 1; if (republishes === 2) await republished.promise; } });
    f.client.retryOperation = async (...args) => { retries += 1; if (retries === 1) f.publish("unhosted"); return f.journal.retryOperation(...args); };
    retrying = f.retry(false);
    await until(() => recoveries === 2);
    expect(f.progress.get(leaf)).toMatchObject({ waitReason: "recovering-host", terminal: null });
    expect(f.progress.get(leaf)?.nextWakeAt).not.toBeNull();
    if (!led) {
      await Bun.sleep(4_100);
      expect(f.progress.get(leaf)).toMatchObject({ waitReason: "recovering-host", detail: "recovering the host before retry admission" });
      expect(f.progress.get(leaf)?.stalledSince).not.toBeNull();
    }
    if (led) {
      f.progress.note(leaf, f.conversation.id, { waitReason: "dispatching", executorId: "parallel-queue", nextWakeMs: 5_000 });
      f.progress.stalled(leaf);
    }
    const standing = f.progress.get(leaf);
    recovered.resolve();
    await until(() => republishes === 2);
    await Bun.sleep(4_100);
    if (led) expect(f.progress.get(leaf)).toEqual(standing);
    else {
      expect(f.progress.get(leaf)).toMatchObject({ waitReason: "checking", detail: "publishing the recovered host before retry admission" });
      expect(f.progress.get(leaf)?.stalledSince).not.toBeNull();
    }
    republished.resolve();
    expect((await retrying).status).toBe(202);
    if (led) expect(f.progress.get(leaf)).toEqual(standing);
    else expect(f.progress.get(leaf)?.waitReason).toBe("queued");
    const queue = f.queue();
    await queue.drain();
    await until(() => f.ledger.writes.length === 1);
    await queue.drain(); queue.retire();
    expect(f.ledger.writes).toHaveLength(1);
  } finally { recovered.resolve(); republished.resolve(); await retrying?.catch(() => {}); f.close(); }
}, 15_000);
