import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { DELIVERY_PROGRESS_TERMINAL_RETENTION_MS, DeliveryProgressStore, readDeliveryProgress } from "./deliveryProgress";

/* Private temporary files only. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-progress-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const noTimer = (() => 0 as unknown as ReturnType<typeof setTimeout>);

test("a record keeps its reason, attempt, progress, deadline and next wake across a restart, and a reader in another process sees it", () => {
  let now = Date.parse("2026-10-06T12:06:26.209Z");
  const filename = path.join(root, "restart.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("operation-image", "conversation-b", { waitReason: "awaiting-turn", nextWakeMs: 5_000, originalKey: "original-key-image", admittedAt: "2026-10-06T12:06:26.209Z" });
  now += 3_000;
  store.note("operation-image", "conversation-b", { waitReason: "dispatching", attempted: true, nextWakeMs: 5_000 });
  store.deadline("operation-image", "2026-10-06T12:16:26.209Z", "settlement-window");
  now += 6_000;
  store.stalled("operation-image");
  expect(store.flush()).toBe(true);
  store.close();

  const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
  const record = reopened.get("operation-image")!;
  expect(record).toMatchObject({
    operationId: "operation-image",
    conversationId: "conversation-b",
    originalKey: "original-key-image",
    waitReason: "dispatching",
    attempt: 1,
    deadlineAt: "2026-10-06T12:16:26.209Z",
    deadlinePolicy: "settlement-window",
    terminal: null,
  });
  expect(record.phaseSince).toBe("2026-10-06T12:06:29.209Z");
  expect(record.stalledSince).toBe("2026-10-06T12:06:35.209Z");
  expect(reopened.open().map((candidate) => candidate.operationId)).toEqual(["operation-image"]);
  reopened.close();

  expect(readDeliveryProgress(["operation-image", "operation-absent"], filename).get("operation-image")?.waitReason).toBe("dispatching");
  expect(readDeliveryProgress(["operation-image"], path.join(root, "missing.sqlite")).size).toBe(0);
});

test("a terminal record survives for investigation and is pruned after the retention", () => {
  let now = Date.parse("2026-10-06T12:00:00.000Z");
  const filename = path.join(root, "retention.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("operation-done", "conversation-a", { waitReason: "dispatching", attempted: true });
  store.settle("operation-done", "delivered", null);
  store.note("operation-done", "conversation-a", { waitReason: "awaiting-turn" });
  expect(store.get("operation-done")?.terminal?.state).toBe("delivered");
  expect(store.get("operation-done")?.waitReason).toBe("dispatching");
  store.flush();
  now += DELIVERY_PROGRESS_TERMINAL_RETENTION_MS - 60_000;
  store.note("operation-other", "conversation-a", { waitReason: "awaiting-turn" });
  store.flush();
  expect(readDeliveryProgress(["operation-done"], filename).size).toBe(1);
  now += 11 * 60_000;
  store.note("operation-other", "conversation-a", { waitReason: "dispatching" });
  store.flush();
  expect(readDeliveryProgress(["operation-done"], filename).size).toBe(0);
  expect(readDeliveryProgress(["operation-other"], filename).size).toBe(1);
  store.close();
});

test("a busy file keeps the records owed and returns at once", () => {
  const filename = path.join(root, "busy.sqlite");
  const store = new DeliveryProgressStore(filename, Date.now, noTimer);
  store.note("operation-first", "conversation-a", { waitReason: "awaiting-turn" });
  expect(store.flush()).toBe(true);
  const holder = new Database(filename);
  holder.exec("BEGIN IMMEDIATE");
  try {
    store.note("operation-busy", "conversation-a", { waitReason: "awaiting-host" });
    const startedAt = performance.now();
    expect(store.flush()).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(store.get("operation-busy")?.waitReason).toBe("awaiting-host");
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  expect(store.flush()).toBe(true);
  expect(readDeliveryProgress(["operation-busy"], filename).get("operation-busy")?.waitReason).toBe("awaiting-host");
  store.close();
});

/* docs/design/delivery-progress-and-drain.md, A3: the sweep restores an open
   record a crash or another process left missing, and an ending owed at a
   crash, from the durable rows; a checkpoint persisted with the records it
   vouches for says how far back it must look. */
const { AgentRegistry } = await import("@/lib/agent/registry");
const { restoreMissingRecords } = await import("./recordWait");

function sweepFixture(name: string) {
  const directory = fs.mkdtempSync(path.join(root, `${name}-`));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const conversation = registry.ensureConversation("codex", path.join(directory, "thread.jsonl"), "default");
  const filename = path.join(directory, "delivery-progress.sqlite");
  return { registry, conversation, filename };
}

test("an ending owed at a crash is restored by the next sweep with its original key and terminal state, and nothing is sent", () => {
  for (const ending of ["delivered", "rejected", "discarded", "retry-leaf"] as const) {
    const { registry, conversation, filename } = sweepFixture(`ending-${ending}`);
    const store = new DeliveryProgressStore(filename, Date.now, noTimer);
    const held = registry.holdDelivery(conversation.id, `${ending} fixture`, `${ending}-key`);
    let operationId = held.command.operationId;
    store.note(operationId, conversation.id, { waitReason: "checking", originalKey: `${ending}-key` });
    registry.beginDeliveryAttempt(held.id, held.generationId!);
    if (ending === "delivered") registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
    if (ending === "rejected") registry.recordDeliveryOutcome(held.id, "failed", "no-claim", "lost");
    if (ending === "discarded") registry.discardDeliveryForOperation(conversation.id, operationId, "delivery-discarded", "lost");
    if (ending === "retry-leaf") {
      registry.recordDeliveryOutcome(held.id, "failed", "dead-host", "unverified");
      const leaf = registry.recordDirectAdmission({ operationId: `${operationId}-retry`, retryOf: operationId })!;
      operationId = leaf.command.operationId;
      registry.settleDirectAdmission(operationId, "delivered", null, "delivered");
    }
    /* The Viewer dies before its record of the ending is written. */
    const restarted = new DeliveryProgressStore(filename, Date.now, noTimer);
    restoreMissingRecords(registry, restarted, Date.now());
    const record = restarted.get(operationId)!;
    expect(record.originalKey).toBe(`${ending}-key`);
    expect(record.terminal?.state).toBe(ending === "delivered" || ending === "retry-leaf" ? "delivered" : "failed");
    expect(restarted.open()).toEqual([]);
    store.close();
    restarted.close();
  }
});

test("an ending the inventory sidecar wrote while the Viewer's record was owed is restored after a restart", () => {
  const { registry, conversation, filename } = sweepFixture("sidecar-ending");
  const held = registry.holdDelivery(conversation.id, "sidecar fixture", "sidecar-key");
  /* The sidecar's own registry ends it; the Viewer never wrote a record. */
  new AgentRegistry(registry.filename).recordDeliveryOutcome(held.id, "failed", "not delivered in 10 min: runtime owner is unavailable", "lost");
  const restarted = new DeliveryProgressStore(filename, Date.now, noTimer);
  restoreMissingRecords(registry, restarted, Date.now());
  expect(restarted.get(held.command.operationId)).toMatchObject({ originalKey: "sidecar-key", terminal: { state: "failed" } });
  restarted.close();
});

test("an empty progress file proves nothing: a send settled before its record was written is restored, as it is after a checkpoint older than the send", () => {
  for (const start of ["empty-file", "older-checkpoint"] as const) {
    const { registry, conversation, filename } = sweepFixture(`counterexample-${start}`);
    let now = Date.now();
    const first = new DeliveryProgressStore(filename, () => now, noTimer);
    if (start === "older-checkpoint") {
      restoreMissingRecords(registry, first, now);
      first.checkpoint(now - 60_000);
    }
    first.note("bootstrap", conversation.id, { waitReason: "queued" });
    first.settle("bootstrap", "delivered", null);
    expect(first.flush()).toBe(true);
    now += 5_000;
    const loaded = new DeliveryProgressStore(filename, () => now, noTimer);
    expect(loaded.get("bootstrap")).not.toBeNull();
    const held = registry.holdDelivery(conversation.id, "counterexample fixture", `${start}-key`);
    loaded.note(held.command.operationId, conversation.id, { waitReason: "checking", originalKey: `${start}-key` });
    registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
    /* Crash: the owed record never reaches the file. */
    now += 5_000;
    const restarted = new DeliveryProgressStore(filename, () => now, noTimer);
    restoreMissingRecords(registry, restarted, now);
    expect(restarted.get(held.command.operationId)).toMatchObject({ originalKey: `${start}-key`, terminal: { state: "delivered" } });
    first.close();
    loaded.close();
    restarted.close();
  }
});

test("a checkpoint reaches the file only with the records owed when it was taken, and a store without one looks back over the whole retention", () => {
  const { registry, conversation, filename } = sweepFixture("checkpoint-flush");
  let now = Date.now();
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  expect(store.completenessMark()).toBe(now - DELIVERY_PROGRESS_TERMINAL_RETENTION_MS);
  store.note("owed", conversation.id, { waitReason: "queued" });
  store.checkpoint(now - 1_000);
  /* Another writer holds the file: the flush is refused and both stay owed. */
  const holder = new Database(filename);
  holder.exec("PRAGMA busy_timeout = 0");
  holder.exec("BEGIN IMMEDIATE");
  expect(store.flush()).toBe(false);
  holder.exec("ROLLBACK");
  holder.close();
  const crashed = new DeliveryProgressStore(filename, () => now, noTimer);
  expect(crashed.get("owed")).toBeNull();
  expect(crashed.completenessMark()).toBe(now - DELIVERY_PROGRESS_TERMINAL_RETENTION_MS);
  crashed.close();
  expect(store.flush()).toBe(true);
  const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
  expect(reopened.get("owed")).not.toBeNull();
  expect(reopened.completenessMark()).toBe(now - 1_000);
  reopened.close();
  store.close();

  /* With no checkpoint, an ending thirteen days old is restored and one past
     the retention is not. */
  const old = sweepFixture("checkpoint-retention");
  const recent = old.registry.holdDelivery(old.conversation.id, "recent", "recent-key");
  old.registry.recordDeliveryOutcome(recent.id, "delivered", null, "delivered");
  const stale = old.registry.holdDelivery(old.conversation.id, "stale", "stale-key");
  old.registry.recordDeliveryOutcome(stale.id, "delivered", null, "delivered");
  const later = Date.now() + 13 * 24 * 60 * 60_000;
  const fresh = new DeliveryProgressStore(old.filename, () => later, noTimer);
  restoreMissingRecords(old.registry, fresh, later);
  expect(fresh.get(recent.command.operationId)?.terminal?.state).toBe("delivered");
  const beyond = Date.now() + 15 * 24 * 60 * 60_000;
  const beyondStore = new DeliveryProgressStore(path.join(path.dirname(old.filename), "beyond.sqlite"), () => beyond, noTimer);
  restoreMissingRecords(old.registry, beyondStore, beyond);
  expect(beyondStore.get(stale.command.operationId)).toBeNull();
  fresh.close();
  beyondStore.close();
  now += 1;
});

test("an open reservation whose record was owed at a crash gets it back, dated from its admission", () => {
  const { registry, conversation, filename } = sweepFixture("open-owed");
  const uncertain = registry.holdDelivery(conversation.id, "owed uncertain fixture", "uncertain-owed-key");
  registry.beginDeliveryAttempt(uncertain.id, uncertain.generationId!);
  const assigned = registry.holdDelivery(conversation.id, "owed open fixture", "open-owed-key");
  const handOff = registry.recordDirectAdmission({ handOff: { conversationId: conversation.id, clientMessageId: "handoff-owed-key",
    command: { operationId: "", kind: "send", policy: "queue" }, text: "hand-off", contentDigest: null, evidenceText: "hand-off", evidenceImageCount: 0 } })!;
  const store = new DeliveryProgressStore(filename, Date.now, noTimer);
  restoreMissingRecords(registry, store, Date.now());
  expect(store.get(assigned.command.operationId)).toMatchObject({ originalKey: "open-owed-key", terminal: null, phaseSince: assigned.createdAt, detail: "recorded from the delivery record" });
  expect(store.get(uncertain.command.operationId)).toMatchObject({ waitReason: "evidence-unreadable", terminal: null });
  expect(store.get(handOff.command.operationId)).toMatchObject({ originalKey: "handoff-owed-key", waitReason: "checking", terminal: null });
  store.close();
});
