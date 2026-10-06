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
