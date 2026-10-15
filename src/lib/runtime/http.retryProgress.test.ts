import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
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
import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";
import type { StructuredRecoveryRequest } from "./structuredRecovery";
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
    kick: () => { kicks += 1; }, recover: async (_request?: StructuredRecoveryRequest) => ({ conversationId: conversation.id }) as never };
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
  for (const unreadable of [false, true]) test(`live same-key resend preserves the queue's ${step} record, attempt and deadline and sends once (journal unreadable: ${unreadable})`, async () => {
    const f = fixture();
    const blocked = deferred<void>();
    const queue = f.queue();
    let inputs = 0;
    const send = f.host.send.bind(f.host);
    f.host.send = async entry => { inputs += 1; if (step === "dispatching") await blocked.promise; return send(entry); };
    if (step === "checking") {
      const health = f.host.health.bind(f.host);
      f.host.health = async () => { await blocked.promise; return health(); };
    }
    try {
      f.uncertain();
      expect((await f.retry()).status).toBe(202);
      await queue.drain();
      await Bun.sleep(40);
      await queue.tick();
      const before = structuredClone(f.progress.get(f.operationId)!);
      const reservation = structuredClone(f.registry.snapshot().heldDeliveries[f.reservation.id]);
      expect(before.waitReason).toBe(step);
      expect(before.stalledSince).not.toBeNull();
      if (unreadable) f.client.operationStatus = async () => { throw new RuntimeHostUnavailableError("journal read failed"); };
      const result = await enqueueStructuredMessage({ path: f.conversation.generations[0]!.path,
        conversationId: f.conversation.id, clientMessageId: f.key, text: f.reservation.text, policy: "queue" }, f.dependencies);
      expect(result).toMatchObject({ ok: true, operationId: f.operationId });
      expect(f.progress.get(f.operationId)).toEqual(before);
      expect(f.registry.snapshot().heldDeliveries[f.reservation.id]).toEqual(reservation);
      blocked.resolve();
      await until(() => f.ledger.writes.length === 1);
      await queue.drain();
      expect(inputs).toBe(1);
    } finally {
      blocked.resolve();
      await Bun.sleep(40);
      await queue.drain();
      queue.retire();
      f.close();
    }
  });
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


test("D4 rotation after retry reservation settles the refused attempt", async () => {
  const f = fixture();
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "seat-state");
  let retries = 0;
  const successor = f.registry.ensureConversation("codex", path.join(f.root, "successor.jsonl"), null);
  const designate = (id: string, pathname: string, clientRequestId: string) => {
    beginOrchestratorSeatIntent({ project: "retry-seat-after-reservation", mandate: "coordinate work", clientRequestId, mode: "existing" });
    completeOrchestratorSeatIntent({ project: "retry-seat-after-reservation", clientRequestId, conversationId: id, path: pathname });
  };
  designate(f.conversation.id, f.conversation.generations.at(-1)!.path, "retry-seat-before-reservation");
  const rotate = () => designate(successor.id, successor.generations.at(-1)!.path, "retry-seat-after-reservation");
  f.registry.recordDeliveryOutcome(f.reservation.id, "failed", "not delivered", "lost");
  f.journal.transitionOperation(f.operationId, "failed", { reason: "not delivered" });
  const write = f.registry.deliveryWrite.bind(f.registry);
  let rotated = false;
  f.registry.deliveryWrite = async (label, mutation, ...rest) => {
    const result = await write(label, mutation, ...rest);
    if (!rotated && label.label === "delivery.direct-admission") {
      rotated = true;
      rotate();
    }
    return result;
  };
  const retryOperation = f.client.retryOperation.bind(f.client);
  f.client.retryOperation = async (...args) => { retries += 1; return retryOperation(...args); };
  const attemptOperationId = terminalRetryOperationId(f.operationId);
  try {
    const response = await f.retry(false);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ successorConversationId: successor.id });
    expect(rotated).toBe(true);
    expect(retries).toBe(0);
    expect(f.registry.readOnlySnapshot().deliveryOperationOwners[attemptOperationId]).toMatchObject({
      terminalState: "failed", terminalDisposition: "lost", settledAt: expect.any(String),
    });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    f.close();
  }
});

test.each(["failed", "uncertain", "rotate-during-status", "recovery-wait", "reservation-wait"])("D4 explicit %s retry refuses a rotated seat before recovery or a new attempt", async mode => {
  const f = fixture();
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "seat-state");
  let recoveries = 0;
  let retries = 0;
  const successor = f.registry.ensureConversation("codex", path.join(f.root, "successor.jsonl"), null);
  const designate = (id: string, pathname: string, key: string) => {
    beginOrchestratorSeatIntent({ project: "retry-seat", mandate: "coordinate work", clientRequestId: key, mode: "existing" });
    completeOrchestratorSeatIntent({ project: "retry-seat", clientRequestId: key, conversationId: id, path: pathname });
  };
  designate(f.conversation.id, f.conversation.generations.at(-1)!.path, "retry-seat-old");
  const rotate = () => designate(successor.id, successor.generations.at(-1)!.path, "retry-seat-next");
  if (mode === "uncertain") f.uncertain();
  else {
    f.registry.recordDeliveryOutcome(f.reservation.id, "failed", "not delivered", "lost");
    f.journal.transitionOperation(f.operationId, "failed", { reason: "not delivered" });
  }
  if (!["rotate-during-status", "recovery-wait", "reservation-wait"].includes(mode)) rotate();
  f.dependencies.recover = async request => {
    recoveries += 1;
    if (mode === "recovery-wait") { rotate(); request?.admissionGuard?.(); }
    return { conversationId: f.conversation.id } as never;
  };
  const holder = mode === "reservation-wait" ? registryLockHolder(path.join(f.root, "registry.sqlite")) : null;
  let timerAdvanced = false;
  const write = f.registry.deliveryWrite.bind(f.registry);
  f.registry.deliveryWrite = async (label, mutation, ...rest) => {
    if (holder && label.label === "delivery.direct-admission") {
      await holder.hold();
      const pending = write(label, mutation, ...rest);
      await new Promise<void>(resolve => setTimeout(() => { timerAdvanced = true; resolve(); }, 0));
      rotate();
      await holder.release();
      return pending;
    }
    return write(label, mutation, ...rest);
  };
  const read = f.client.operationStatus.bind(f.client);
  f.client.operationStatus = async (...args) => {
    const result = await read(...args);
    if (mode === "rotate-during-status") rotate();
    return result;
  };
  const retry = f.client.retryOperation.bind(f.client);
  f.client.retryOperation = async (...args) => { retries += 1; return retry(...args); };
  const before = Object.keys(f.registry.readOnlySnapshot().deliveryOperationOwners);
  try {
    const response = await f.retry(mode === "uncertain");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ successorConversationId: successor.id });
    expect(recoveries).toBe(mode === "recovery-wait" || mode === "reservation-wait" ? 1 : 0);
    expect(retries).toBe(0);
    if (mode === "reservation-wait") expect(timerAdvanced).toBe(true);
    expect(Object.keys(f.registry.readOnlySnapshot().deliveryOperationOwners)).toEqual(before);
    expect(f.registry.conversation(f.conversation.id)?.supersededBy).toBeNull();
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    await holder?.close();
    f.close();
  }
});

test("REVIEW refusal during uncertain rearm keeps the original unknown outcome terminal", async () => {
  const f = fixture();
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "seat-state");
  const successor = f.registry.ensureConversation("codex", path.join(f.root, "successor.jsonl"), null);
  const designate = (id: string, pathname: string, key: string) => {
    beginOrchestratorSeatIntent({ project: "retry-seat", mandate: "coordinate work", clientRequestId: key, mode: "existing" });
    completeOrchestratorSeatIntent({ project: "retry-seat", clientRequestId: key, conversationId: id, path: pathname });
  };
  designate(f.conversation.id, f.conversation.generations.at(-1)!.path, "retry-seat-old");
  const rotate = () => designate(successor.id, successor.generations.at(-1)!.path, "retry-seat-next");
  f.uncertain();
  const original = structuredClone(f.progress.get(f.operationId)!);
  const deliveryBefore = f.registry.deliverySnapshotForOperation(f.operationId);
  const retryOperation = f.client.retryOperation.bind(f.client);
  let retries = 0;
  f.client.retryOperation = async (...args) => { retries += 1; return retryOperation(...args); };
  const beginAttempt = f.registry.beginDeliveryAttemptOffLoop.bind(f.registry);
  f.registry.beginDeliveryAttemptOffLoop = async (...args) => {
    const claim = await beginAttempt(...args);
    rotate();
    return claim;
  };
  try {
    const response = await f.retry();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ successorConversationId: successor.id });
    expect(retries).toBe(0);
    expect(f.progress.get(f.operationId)).toMatchObject({
      operationId: original.operationId,
      conversationId: original.conversationId,
      originalKey: original.originalKey,
      terminal: { state: "uncertain", reason: "acknowledgement lost" },
    });
    expect(f.progress.open().some(record => record.operationId === f.operationId)).toBe(false);
    expect(f.journal.operationResult(f.operationId)?.receipt).toMatchObject({ status: "uncertain", reason: "acknowledgement lost" });
    const deliveryAfter = f.registry.deliverySnapshotForOperation(f.operationId);
    expect(deliveryAfter.deliveryOperationOwners[f.operationId]?.deliveryId)
      .toBe(deliveryBefore.deliveryOperationOwners[f.operationId]?.deliveryId);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    f.close();
  }
});
