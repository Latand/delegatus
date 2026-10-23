import { withoutWriterWait } from "@/lib/agent/registryLockHolderFixture";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { DELIVERY_PHASE_HISTORY_LIMIT, DELIVERY_PROGRESS_TERMINAL_RETENTION_MS, DeliveryProgressStore, readDeliveryProgress, type DeliveryProgressRecord } from "./deliveryProgress";

/* Private temporary files only. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-progress-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const noTimer = (() => 0 as unknown as ReturnType<typeof setTimeout>);

/* A busy week's retained completions, newer than the records under test. */
function addRecentCompletions(filename: string, now: number): void {
  const seed = new DeliveryProgressStore(null, () => now, noTimer);
  seed.note("completion-seed", "busy-conversation", { waitReason: "dispatching" });
  seed.settle("completion-seed", "delivered", null);
  const record = seed.get("completion-seed")!;
  const db = new Database(filename);
  try {
    const insert = db.query("INSERT INTO delivery_progress VALUES (?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 10_001; i++) {
        const operationId = `recent-completion-${i}`;
        insert.run(operationId, record.conversationId, null, 1, now,
          JSON.stringify({ ...record, operationId }));
      }
    })();
  } finally {
    db.close();
    seed.close();
  }
}

test("recent completions cannot hide an open send after prune and restart or replace its history", () => {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const filename = path.join(root, "busy-restart.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("open-send", "conversation", {
    waitReason: "queued", originalKey: "open-key", kind: "steer", admittedAt: new Date(now).toISOString(),
    executorId: "original-executor", nextWakeMs: 5_000,
  });
  store.timing("open-send", { ingressAt: new Date(now - 100).toISOString() });
  now += 100;
  store.note("open-send", "conversation", { waitReason: "checking", detail: "reading journal", attempted: true });
  store.deadline("open-send", new Date(now + 60_000).toISOString(), "settlement-window");
  store.stalled("open-send");
  const before = structuredClone(store.get("open-send"))!;
  expect(store.flush()).toBe(true);
  now += 1_000;
  addRecentCompletions(filename, now);
  now += 10 * 60_000;
  store.checkpoint(now);
  expect(store.flush()).toBe(true);
  store.close();

  const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
  try {
    expect(reopened.open().map((record) => record.operationId)).toContain("open-send");
    expect(reopened.get("open-send")).toEqual(before);
    const at = new Date(now).toISOString();
    reopened.note("open-send", "conversation", { waitReason: "dispatching", attempted: true });
    const expected: DeliveryProgressRecord = { ...before, waitReason: "dispatching", detail: null, attempt: before.attempt + 1,
      phaseSince: at, lastProgressAt: at, stalledSince: null, updatedAt: at,
      phaseHistory: [...before.phaseHistory!, { phase: "dispatching", reason: null, at }] };
    expect(reopened.get("open-send")).toEqual(expected);
    expect(reopened.get("open-send")!.phaseHistory!.length).toBeLessThanOrEqual(DELIVERY_PHASE_HISTORY_LIMIT);
    expect(reopened.flush()).toBe(true);
    expect(readDeliveryProgress(["open-send"], filename).get("open-send")).toEqual(expected);
  } finally {
    reopened.close();
  }
});

test("updates hydrate retained sends outside the startup cache and preserve their fields and phases", () => {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const filename = path.join(root, "cold-history.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  const operations = ["note", "rearm", "settle", "timing", "get"] as const;
  for (const operation of operations) {
    store.note(operation, "conversation", { waitReason: "queued", originalKey: `${operation}-key`,
      admittedAt: new Date(now).toISOString(), executorId: "original-executor" });
    store.note(operation, "conversation", { waitReason: "dispatching", attempted: true });
    store.settle(operation, "uncertain", "lost acknowledgement");
  }
  const before = new Map(operations.map((operation) => [operation, structuredClone(store.get(operation))!]));
  store.close();
  now += 1_000;
  addRecentCompletions(filename, now);
  const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
  try {
    expect(reopened.open()).toEqual([]); // Load the startup cache before each cold access.
    reopened.note("note", "conversation", { waitReason: "checking" });
    reopened.rearm("rearm", "conversation", { waitReason: "checking" });
    reopened.settle("settle", "delivered", null);
    reopened.timing("timing", { engineEchoAt: new Date(now).toISOString() });
    expect(reopened.get("get")).toEqual(before.get("get")!);
    expect(reopened.flush()).toBe(true);
    const records = readDeliveryProgress(operations, filename);
    expect(records.get("note")).toEqual(before.get("note")!);
    for (const operation of ["rearm", "settle", "timing"] as const) {
      const record = records.get(operation)!;
      expect(record).toMatchObject({ originalKey: `${operation}-key`, admittedAt: before.get(operation)!.admittedAt });
      expect(record.phaseHistory?.slice(0, 3)).toEqual(before.get(operation)!.phaseHistory!);
      expect(record.phaseHistory).toHaveLength(4);
    }
    expect(records.get("rearm")).toMatchObject({ terminal: null, attempt: 2, executorId: null });
    expect(records.get("settle")).toMatchObject({ terminal: { state: "delivered" }, attempt: 1 });
    expect(records.get("timing")).toMatchObject({ terminal: before.get("timing")!.terminal, attempt: 1,
      engineEchoAt: new Date(now).toISOString() });
  } finally {
    reopened.close();
  }
});

test("uncertain enumeration includes cold rows and respects unflushed transitions", () => {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const filename = path.join(root, "cold-uncertain.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  const ids = ["still-uncertain", "confirmed", "rearmed", "newly-uncertain"];
  for (const id of ids) {
    store.note(id, "conversation", { waitReason: "dispatching" });
    if (id !== "newly-uncertain") store.settle(id, "uncertain", "lost acknowledgement");
  }
  store.close();
  now += 1_000;
  addRecentCompletions(filename, now);
  // An unrelated malformed completion must not hide valid cold uncertain rows.
  const corrupt = new Database(filename);
  try {
    corrupt.query("INSERT INTO delivery_progress VALUES (?, ?, ?, ?, ?, ?)")
      .run("malformed-completion", "conversation", null, 1, now, "{");
  } finally { corrupt.close(); }
  const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
  try {
    expect(reopened.uncertain().map((record) => record.operationId).sort())
      .toEqual(["confirmed", "rearmed", "still-uncertain"]);
    reopened.settle("confirmed", "delivered", null);
    reopened.rearm("rearmed", "conversation", { waitReason: "checking" });
    reopened.settle("newly-uncertain", "uncertain", "lost acknowledgement");
    // The saved uncertain rows must not undo dirty delivery/rearm transitions.
    expect(reopened.uncertain().map((record) => record.operationId).sort())
      .toEqual(["newly-uncertain", "still-uncertain"]);
    expect(reopened.flush()).toBe(true);
    expect(reopened.uncertain().map((record) => record.operationId).sort())
      .toEqual(["newly-uncertain", "still-uncertain"]);
  } finally { reopened.close(); }
});

test("an unreadable cold row is left intact until an update can hydrate it", () => {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const filename = path.join(root, "unreadable-cold-history.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("cold-send", "conversation", { waitReason: "queued", originalKey: "cold-key" });
  store.settle("cold-send", "uncertain", "lost acknowledgement");
  const before = structuredClone(store.get("cold-send"))!;
  store.close();
  now += 1_000;
  addRecentCompletions(filename, now);
  const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
  const internals = reopened as unknown as { connection: () => unknown };
  const connection = internals.connection;
  try {
    expect(reopened.open()).toEqual([]);
    internals.connection = () => { throw new Error("unable to open database file"); };
    reopened.note("cold-send", "conversation", { waitReason: "checking" });
    reopened.rearm("cold-send", "conversation", { waitReason: "checking" });
    expect(reopened.flush()).toBe(true); // Neither update queued a replacement row.
    internals.connection = connection;
    expect(reopened.get("cold-send")).toEqual(before);
    reopened.rearm("cold-send", "conversation", { waitReason: "checking" });
    expect(reopened.flush()).toBe(true);
    const record = readDeliveryProgress(["cold-send"], filename).get("cold-send")!;
    expect(record).toMatchObject({ terminal: null, originalKey: "cold-key", attempt: 1 });
    expect(record.phaseHistory?.slice(0, 2)).toEqual(before.phaseHistory!);
    expect(record.phaseHistory).toHaveLength(3);
  } finally {
    internals.connection = connection;
    reopened.close();
  }
});

test("an inaccessible directory preserves saved history until the store can read it again", () => {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const directory = path.join(root, "inaccessible-history");
  const filename = path.join(directory, "progress.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("blocked-send", "conversation", { waitReason: "queued", originalKey: "saved-key" });
  store.note("blocked-send", "conversation", { waitReason: "checking", attempted: true });
  const before = structuredClone(store.get("blocked-send"))!;
  store.close();
  const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
  try {
    fs.chmodSync(directory, 0o000);
    reopened.note("blocked-send", "conversation", { waitReason: "dispatching", attempted: true });
    expect(reopened.presence("blocked-send")).toBe("unknown");
    expect(reopened.flush()).toBe(true); // No replacement is queued while the saved record is unreadable.
    fs.chmodSync(directory, 0o700);
    now += 1_000;
    reopened.note("blocked-send", "conversation", { waitReason: "dispatching", attempted: true });
    expect(reopened.flush()).toBe(true);
    const record = readDeliveryProgress(["blocked-send"], filename).get("blocked-send")!;
    expect(record.originalKey).toBe(before.originalKey);
    expect(record.phaseHistory?.slice(0, 2)).toEqual(before.phaseHistory!);
    expect(record.phaseHistory).toHaveLength(3);
    expect(record.attempt).toBe(2);
  } finally {
    fs.chmodSync(directory, 0o700);
    reopened.close();
  }
});

test("phase history survives a restart, including changes within checking and the ending", () => {
  let now = Date.parse("2026-10-11T00:00:00.000Z");
  const filename = path.join(root, "phase-history.sqlite");
  let store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("history-send", "history-conversation", { waitReason: "queued" });
  now += 100;
  store.note("history-send", "history-conversation", { waitReason: "checking", detail: "reading journal" });
  now += 200;
  store.note("history-send", "history-conversation", { waitReason: "checking", detail: "claiming writer" });
  now += 300;
  store.note("history-send", "history-conversation", { waitReason: "dispatching", attempted: true });
  now += 400;
  store.settle("history-send", "delivered", null);
  store.close();
  store = new DeliveryProgressStore(filename, () => now, noTimer);
  expect(store.get("history-send")).toMatchObject({
    waitReason: "dispatching", attempt: 1, terminal: { state: "delivered" },
    phaseHistory: [
      { phase: "queued", reason: null, at: "2026-10-11T00:00:00.000Z" },
      { phase: "checking", reason: "reading journal", at: "2026-10-11T00:00:00.100Z" },
      { phase: "checking", reason: "claiming writer", at: "2026-10-11T00:00:00.300Z" },
      { phase: "dispatching", reason: null, at: "2026-10-11T00:00:00.600Z" },
      { phase: "delivered", reason: null, at: "2026-10-11T00:00:01.000Z" },
    ],
  });
  store.close();
  expect(readDeliveryProgress(["history-send"], filename).get("history-send")).toMatchObject({ phaseHistory: expect.any(Array) });
});

test("a late checking detail keeps its supplied start time without advancing delivery clocks", () => {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const filename = path.join(root, "late-detail.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("late-detail-send", "conversation", { waitReason: "checking", detail: "reading journal" });
  const before = structuredClone(store.get("late-detail-send"))!;
  now += 1_000;
  store.note("late-detail-send", "conversation", {
    waitReason: "checking", detail: "claiming writer", sinceMs: Date.parse("2026-10-11T00:00:00.200Z"),
  });
  store.close();
  const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
  expect(reopened.get("late-detail-send")).toMatchObject({
    phaseSince: before.phaseSince, lastProgressAt: before.lastProgressAt, attempt: before.attempt,
    phaseHistory: [
      { phase: "checking", reason: "reading journal", at: "2026-10-11T00:00:00.000Z" },
      { phase: "checking", reason: "claiming writer", at: "2026-10-11T00:00:00.200Z" },
    ],
  });
  reopened.close();
});

test("history and writes stay bounded through polling, retries and late confirmation", () => {
  let now = Date.parse("2026-10-11T00:00:00.000Z");
  const filename = path.join(root, "bounded-history.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("bounded-send", "conversation", { waitReason: "queued" });
  store.flush();
  const before = fs.readFileSync(`${filename}-wal`);
  for (let i = 0; i < 1_000; i++) store.note("bounded-send", "conversation", { waitReason: "queued" });
  store.flush();
  expect(fs.readFileSync(`${filename}-wal`)).toEqual(before);
  expect(store.get("bounded-send")?.phaseHistory).toHaveLength(1);
  for (let i = 0; i < DELIVERY_PHASE_HISTORY_LIMIT + 10; i++) {
    now += 1;
    store.note("bounded-send", "conversation", { waitReason: i % 2 ? "checking" : "dispatching", detail: "x".repeat(1_000) });
  }
  expect(store.get("bounded-send")?.phaseHistory).toHaveLength(DELIVERY_PHASE_HISTORY_LIMIT);
  expect(store.get("bounded-send")?.phaseHistoryDropped).toBe(11);
  expect(store.get("bounded-send")?.phaseHistory?.every((phase) => (phase.reason?.length ?? 0) <= 240)).toBe(true);
  now += 1;
  store.settle("bounded-send", "uncertain", "lost acknowledgement");
  now += 1;
  store.rearm("bounded-send", "conversation", { waitReason: "checking" });
  now += 1;
  store.settle("bounded-send", "uncertain", "checking echo");
  now += 1;
  store.settle("bounded-send", "delivered", null);
  expect(store.get("bounded-send")?.phaseHistory?.slice(-4).map((phase) => phase.phase)).toEqual(["uncertain", "checking", "uncertain", "delivered"]);
  store.close();
});

test("a busy week retains every send's history for seven days despite the terminal row cap", () => {
  const startedAt = Date.parse("2026-10-01T00:00:00.000Z");
  let now = startedAt;
  const filename = path.join(root, "busy-week.sqlite");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  for (let i = 0; i < 5_001; i++) {
    now += 1;
    store.note(`week-send-${i}`, "conversation", { waitReason: "dispatching" });
    store.settle(`week-send-${i}`, "delivered", null);
  }
  store.flush();
  const day = 24 * 60 * 60_000;
  now = startedAt + 7 * day - 1;
  store.note("retention-tick", "conversation", { waitReason: "queued" });
  store.flush();
  expect(readDeliveryProgress(["week-send-0"], filename).get("week-send-0")?.phaseHistory).toHaveLength(2);
  now = startedAt + 8 * day;
  store.note("retention-tick", "conversation", { waitReason: "checking" });
  store.flush();
  expect(readDeliveryProgress(["week-send-0"], filename).size).toBe(0);
  store.close();
});

test("arrival observations survive restart and replay without advancing or reopening a settled send", () => {
  let now = Date.parse("2026-10-11T00:00:01Z");
  const filename = path.join(root, "arrival-times.sqlite");
  let store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("arrival-send", "conversation", { waitReason: "dispatching", attempted: true });
  now += 1_000;
  store.settle("arrival-send", "delivered", null);
  const settled = structuredClone(store.get("arrival-send"));
  store.timing("arrival-send", { ingressAt: "2026-10-11T00:00:00Z", engineEchoAt: "2026-10-11T00:00:01.500Z" });
  store.close();
  store = new DeliveryProgressStore(filename, () => now, noTimer);
  expect(store.get("arrival-send")).toMatchObject({
    ingressAt: "2026-10-11T00:00:00.000Z", engineEchoAt: "2026-10-11T00:00:01.500Z",
    phaseHistory: [
      { phase: "ingress", reason: null, at: "2026-10-11T00:00:00.000Z" },
      { phase: "dispatching", reason: null, at: "2026-10-11T00:00:01.000Z" },
      { phase: "engine-echo", reason: null, at: "2026-10-11T00:00:01.500Z" },
      { phase: "delivered", reason: null, at: "2026-10-11T00:00:02.000Z" },
    ],
    waitReason: settled!.waitReason, phaseSince: settled!.phaseSince, updatedAt: settled!.updatedAt,
    lastProgressAt: settled!.lastProgressAt, terminal: settled!.terminal, attempt: settled!.attempt,
  });
  const original = structuredClone(store.get("arrival-send"));
  store.timing("arrival-send", { ingressAt: "2026-10-11T00:01:00Z", engineEchoAt: "2026-10-11T00:01:01Z" });
  expect(store.get("arrival-send")).toEqual(original);
  store.timing("absent-send", { engineEchoAt: "invalid" });
  expect(store.get("absent-send")).toBeNull();
  store.close();
});

test("an older record keeps working and gains only phases actually observed after the upgrade", () => {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const filename = path.join(root, "legacy-history.sqlite");
  let store = new DeliveryProgressStore(filename, () => now, noTimer);
  store.note("legacy-send", "conversation", { waitReason: "awaiting-turn" });
  store.close();
  const db = new Database(filename);
  db.exec("UPDATE delivery_progress SET record_json = json_remove(record_json, '$.phaseHistory', '$.phaseHistoryDropped')");
  db.close();
  now += 1_000;
  store = new DeliveryProgressStore(filename, () => now, noTimer);
  expect(store.get("legacy-send")?.waitReason).toBe("awaiting-turn");
  store.note("legacy-send", "conversation", { waitReason: "dispatching", attempted: true });
  expect(store.get("legacy-send")?.phaseHistory).toEqual([{ phase: "dispatching", reason: null, at: "2026-10-11T00:00:01.000Z" }]);
  store.close();
});

test("a new rearm clears the ended executor, including after the progress store restarts", () => {
  const filename = path.join(root, "rearm-executor.sqlite");
  let store = new DeliveryProgressStore(filename, Date.now, noTimer);
  store.note("rearm-executor", "conversation-rearm", { waitReason: "dispatching", executorId: "ended-queue" });
  store.settle("rearm-executor", "uncertain", "lost acknowledgement");
  store.flush();
  store.close();
  store = new DeliveryProgressStore(filename, Date.now, noTimer);
  store.rearm("rearm-executor", "conversation-rearm", { waitReason: "checking" });
  expect(store.get("rearm-executor")).toMatchObject({ terminal: null, executorId: null });
  store.close();
});

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
    expect(withoutWriterWait(filename, () => store.flush())).toBe(false);
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

test("a progress file the sweep cannot read proves no ending: no checkpoint passes it, and once readable the ending is restored under its original key and survives a reopen", () => {
  for (const unreadable of ["at-load", "after-load"] as const) {
    const { registry, conversation, filename } = sweepFixture(`unreadable-${unreadable}`);
    let now = Date.now();
    const bootstrap = new DeliveryProgressStore(filename, () => now, noTimer);
    bootstrap.note("bootstrap", conversation.id, { waitReason: "queued" });
    expect(bootstrap.flush()).toBe(true);
    bootstrap.close();
    const held = registry.holdDelivery(conversation.id, "settled while unreadable", `unreadable-${unreadable}-key`);
    registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
    now += 1_000;

    const store = new DeliveryProgressStore(filename, () => now, noTimer);
    const internals = store as unknown as { connection: () => unknown };
    const connection = internals.connection;
    if (unreadable === "at-load") fs.chmodSync(filename, 0o000);
    else {
      expect(store.get("bootstrap")).not.toBeNull();
      internals.connection = () => { throw new Error("unable to open database file"); };
    }
    expect(store.presence(held.command.operationId)).toBe("unknown");
    expect(restoreMissingRecords(registry, store, now)).toBe(false);
    expect(store.get(held.command.operationId)).toBeNull();

    if (unreadable === "at-load") fs.chmodSync(filename, 0o600);
    else internals.connection = connection;
    now += 1_000;
    expect(restoreMissingRecords(registry, store, now)).toBe(true);
    store.checkpoint(now - 500);
    expect(store.flush()).toBe(true);
    store.close();

    const reopened = new DeliveryProgressStore(filename, () => now, noTimer);
    restoreMissingRecords(registry, reopened, now);
    expect(reopened.get(held.command.operationId)).toMatchObject({ originalKey: `unreadable-${unreadable}-key`, terminal: { state: "delivered" } });
    reopened.close();
  }
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


test("restoration covers every ending through bounded sweeps before advancing completeness", async () => {
  const { registry, conversation, filename } = sweepFixture("bounded-restoration");
  const held = registry.holdDelivery(conversation.id, "ending template", "template-key");
  registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
  const template = registry.readOnlySnapshot();
  const owner = template.deliveryOperationOwners[held.command.operationId]!;
  const delivery = template.heldDeliveries[held.id]!;
  const file = { ...template, deliveryOperationOwners: {}, heldDeliveries: {} } as typeof template;
  const settledAt = Date.parse("2026-10-22T00:00:00Z");
  for (let i = 0; i < 513; i++) {
    const op = `bounded-operation-${String(i).padStart(4, "0")}`;
    const id = `bounded-delivery-${i}`;
    file.deliveryOperationOwners[op] = { ...owner, deliveryId: id, clientMessageId: op,
      command: { ...owner.command, operationId: op }, settledAt: new Date(settledAt).toISOString() };
    file.heldDeliveries[id] = { ...delivery, id, clientMessageId: op, command: { ...delivery.command, operationId: op }, deliveredAt: new Date(settledAt).toISOString() };
  }
  const reader = { readOnlySnapshot: () => file } as typeof registry;
  const store = new DeliveryProgressStore(filename, () => settledAt, noTimer);
  try {
    expect(restoreMissingRecords(reader, store, settledAt)).toBe(false);
    const first = Object.keys(file.deliveryOperationOwners).filter(key => store.get(key));
    expect(first.length).toBeLessThanOrEqual(128);
    expect(store.flush()).toBe(true);
    store.close();
    const registryFile = path.join(path.dirname(filename), "restart-registry.json");
    fs.writeFileSync(registryFile, JSON.stringify(file));
    const code = `import {AgentRegistry} from "./src/lib/agent/registry";
      import {DeliveryProgressStore} from "./src/lib/runtime/deliveryProgress";
      import {restoreMissingRecordsAsync} from "./src/lib/runtime/recordWait";
      const registry=new AgentRegistry(${JSON.stringify(registryFile)},undefined,undefined,{sqliteMode:"off"});
      const store=new DeliveryProgressStore(${JSON.stringify(filename)},()=>${settledAt});
      if(!await restoreMissingRecordsAsync(registry,store,${settledAt}))throw Error("incomplete restarted restoration");
      if(!store.flush())throw Error("progress flush refused");store.close();registry.close();`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_STATE_OWNER: undefined } });
    const watchdog = setTimeout(() => child.kill(), 30_000);
    try {
      const error = await new Response(child.stderr).text();
      expect({ exit: await child.exited, error }).toEqual({ exit: 0, error: "" });
    } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill(); await child.exited; } }
    const restarted = new DeliveryProgressStore(filename, () => settledAt, noTimer);
    try {
      let covered = false;
      for (let i = 0; i < 100 && !covered; i++) covered = restoreMissingRecords(reader, restarted, settledAt);
      expect(covered).toBe(true);
      for (const key of Object.keys(file.deliveryOperationOwners)) expect(restarted.get(key)?.terminal?.state).toBe("delivered");
      expect(restarted.get("bounded-operation-0512")?.originalKey).toBe("bounded-operation-0512");
    } finally { restarted.close(); }
  } finally { store.close(); registry.close(); }
});


test("asynchronous restoration prepares both its selection and freshness check without a synchronous refresh", async () => {
  const { registry, filename } = sweepFixture("prepared-restoration");
  const snapshot = registry.readOnlySnapshot();
  const store = new DeliveryProgressStore(filename, () => 1000, noTimer);
  const { restoreMissingRecordsAsync } = await import("./recordWait");
  let preparations = 0;
  const reader = {
    readOnlySnapshot: () => { throw new Error("unprepared restoration refresh"); },
    prepareReadOnlySnapshot: async (signal?: AbortSignal) => {
      signal?.throwIfAborted(); preparations++; return snapshot;
    },
  } as unknown as typeof registry;
  try {
    expect(await restoreMissingRecordsAsync(reader, store, 1000)).toBe(true);
    expect(preparations).toBe(2);
    reader.prepareReadOnlySnapshot = async () => { throw new Error("preparation refused"); };
    await expect(restoreMissingRecordsAsync(reader, store, 1000)).rejects.toThrow("preparation refused");
    preparations = 0;
    reader.prepareReadOnlySnapshot = async () => { preparations++; return snapshot; };
    expect(await restoreMissingRecordsAsync(reader, store, 1000, () => {}, 0)).toBe(false);
    expect(preparations).toBe(0);
    let current = true;
    reader.prepareReadOnlySnapshot = async () => { current = false; return snapshot; };
    await expect(restoreMissingRecordsAsync(reader, store, 1000, () => {
      if (!current) throw new Error("restoration owner retired");
    })).rejects.toThrow("restoration owner retired");
    preparations = 0;
    reader.prepareReadOnlySnapshot = async () => ++preparations === 1 ? snapshot : { ...snapshot };
    expect(await restoreMissingRecordsAsync(reader, store, 1000)).toBe(false);
  } finally { store.close(); registry.close(); }
});


/* A send stored before its delivery carried command.operationId: owner and
   delivery share one id, and normalization derives the operation from it.
   Archived, the owner's ending is found through the indexed projection, which
   must apply the same default or restoration completes past the record. */
test("an archived legacy send whose delivery names no operation is restored before completeness advances", async () => {
  const { restoreMissingRecordsAsync } = await import("./recordWait");
  const directory = fs.mkdtempSync(path.join(root, "legacy-archived-ending-"));
  const options = { sqliteMode: "sqlite" as const, sqliteFilename: path.join(directory, "agent-registry.sqlite") };
  const open = () => new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, options);
  const writer = open();
  const conversation = writer.ensureConversation("codex", path.join(directory, "thread.jsonl"), "default");
  const held = writer.holdDelivery(conversation.id, "legacy ending", "legacy-key");
  writer.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
  writer.close();
  const legacy = "legacy-send";
  let deliveredAt = "";
  const db = new Database(options.sqliteFilename);
  try {
    const row = (collection: string, key: string) => db.query<{ value_json: string; row_order: number }, [string, string]>(
      "SELECT value_json,row_order FROM registry_rows WHERE collection=? AND row_key=?").get(collection, key)!;
    const ownerRow = row("deliveryOperationOwners", held.command.operationId);
    const deliveryRow = row("heldDeliveries", held.id);
    const owner = JSON.parse(ownerRow.value_json);
    const delivery = JSON.parse(deliveryRow.value_json);
    deliveredAt = delivery.deliveredAt;
    delete owner.settledAt;
    delete delivery.command.operationId;
    db.transaction(() => {
      db.run("DELETE FROM registry_rows WHERE (collection='deliveryOperationOwners' AND row_key=?) OR (collection='heldDeliveries' AND row_key=?)",
        [held.command.operationId, held.id]);
      db.run("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('heldDeliveries',?,?,?)",
        [legacy, JSON.stringify({ ...delivery, id: legacy }), deliveryRow.row_order]);
      db.run("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('deliveryOperationOwners',?,?,?)",
        [legacy, JSON.stringify({ ...owner, deliveryId: legacy, command: { ...owner.command, operationId: legacy } }), ownerRow.row_order]);
    })();
  } finally { db.close(); }
  const archiver = open();
  try {
    archiver.archiveInactiveRows();
    expect(archiver.readOnlySnapshot().deliveryOperationOwners[legacy]?.settledAt).toBe(deliveredAt);
  } finally { archiver.close(); }
  const cold = new Database(options.sqliteFilename);
  try {
    expect(cold.query("SELECT collection FROM registry_cold WHERE row_key=? ORDER BY collection").all(legacy))
      .toEqual([{ collection: "deliveryOperationOwners" }, { collection: "heldDeliveries" }]);
  } finally { cold.close(); }
  const settledAt = Date.parse(deliveredAt);
  expect(Number.isFinite(settledAt)).toBe(true);
  /* Once on the projection this boot prepares, and again from an empty
     progress store over the reopened, already prepared projection. */
  for (const pass of ["prepared", "reopened"]) {
    const registry = open();
    const store = new DeliveryProgressStore(path.join(directory, `delivery-progress-${pass}.sqlite`), () => settledAt, noTimer);
    try {
      expect(store.get(legacy)).toBeNull();
      expect(await restoreMissingRecordsAsync(registry, store, settledAt)).toBe(true);
      expect({ pass, record: store.get(legacy)?.terminal?.state ?? null }).toEqual({ pass, record: "delivered" });
      expect(store.flush()).toBe(true);
    } finally { store.close(); registry.close(); }
  }
});


/* An owner stored without its instant, whose delivery lost its digest: the
   projection cannot tell which candidate normalization takes, so it keeps
   the later. Compared as text, 'Thu, 01 Oct…' sorts after '2026-10-23…' and
   the recent send fell out of the window while completeness advanced. */
test("an archived legacy send with mixed-format candidate endings is restored before completeness advances", async () => {
  const { restoreMissingRecordsAsync } = await import("./recordWait");
  const { endingInstant } = await import("@/lib/agent/registryEndings");
  const recent = "2026-10-23T12:00:00.000Z";
  const now = Date.parse(recent) + 1000;
  for (const [variant, retained] of [["mixed", "Thu, 01 Oct 2026 00:00:00 GMT"], ["offset", "2026-10-23T13:00:00+14:00"]] as const) {
    const directory = fs.mkdtempSync(path.join(root, `legacy-${variant}-ending-`));
    const options = { sqliteMode: "sqlite" as const, sqliteFilename: path.join(directory, "agent-registry.sqlite") };
    const open = () => new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, options);
    const writer = open();
    const conversation = writer.ensureConversation("codex", path.join(directory, "thread.jsonl"), "default");
    const held = writer.holdDelivery(conversation.id, "legacy ending", "legacy-key");
    writer.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
    writer.close();
    const operation = held.command.operationId;
    const db = new Database(options.sqliteFilename);
    try {
      const row = (collection: string, key: string) => JSON.parse(db.query<{ value_json: string }, [string, string]>(
        "SELECT value_json FROM registry_rows WHERE collection=? AND row_key=?").get(collection, key)!.value_json);
      const owner = row("deliveryOperationOwners", operation);
      const delivery = row("heldDeliveries", held.id);
      expect(owner.requestDigest).toBe(delivery.requestDigest);
      delete owner.settledAt;
      owner.settledDelivery = { ...delivery, deliveredAt: retained };
      /* Its digest is derived again from the text it still carries. */
      delete delivery.requestDigest;
      delivery.text = "legacy ending";
      delivery.deliveredAt = recent;
      const update = db.query("UPDATE registry_rows SET value_json=? WHERE collection=? AND row_key=?");
      db.transaction(() => {
        update.run(JSON.stringify(delivery), "heldDeliveries", held.id);
        update.run(JSON.stringify(owner), "deliveryOperationOwners", operation);
      })();
    } finally { db.close(); }
    const archiver = open();
    try {
      archiver.archiveInactiveRows();
      expect(archiver.readOnlySnapshot().deliveryOperationOwners[operation]?.settledAt).toBe(recent);
    } finally { archiver.close(); }
    const cold = new Database(options.sqliteFilename);
    try {
      expect(cold.query("SELECT collection FROM registry_cold WHERE row_key IN (?, ?) ORDER BY collection").all(operation, held.id))
        .toEqual([{ collection: "deliveryOperationOwners" }, { collection: "heldDeliveries" }]);
    } finally { cold.close(); }
    /* On the projection this boot prepares, over the reopened prepared one,
       and rebuilt from nothing; each time from a progress store whose
       checkpoint an hour earlier leaves only the recent candidate in range. */
    for (const pass of ["prepared", "reopened", "rebuilt"]) {
      if (pass === "rebuilt") {
        const rebuild = new Database(options.sqliteFilename);
        try {
          rebuild.run("DELETE FROM registry_owner_endings");
          rebuild.run("DELETE FROM registry_meta WHERE key='owner_endings_cursor'");
        } finally { rebuild.close(); }
      }
      const progressFile = path.join(directory, `delivery-progress-${pass}.sqlite`);
      const seed = new DeliveryProgressStore(progressFile, () => now - 3_600_000, noTimer);
      seed.checkpoint(now - 3_600_000);
      expect(seed.flush()).toBe(true);
      seed.close();
      const registry = open();
      const store = new DeliveryProgressStore(progressFile, () => now, noTimer);
      try {
        expect(store.completenessMark()).toBe(now - 3_600_000);
        expect(store.get(operation)).toBeNull();
        expect(await restoreMissingRecordsAsync(registry, store, now)).toBe(true);
        expect({ variant, pass, record: store.get(operation)?.terminal?.state ?? null }).toEqual({ variant, pass, record: "delivered" });
      } finally { store.close(); registry.close(); }
      const projection = new Database(options.sqliteFilename, { readonly: true });
      try {
        const ending = projection.query<{ ending_ms: number | null; ending_text: string }, [string]>(
          "SELECT ending_ms,ending_text FROM registry_owner_endings WHERE operation_id=?").get(operation)!;
        expect({ variant, pass, instant: ending.ending_ms ?? endingInstant(ending.ending_text) }).toEqual({ variant, pass, instant: Date.parse(recent) });
      } finally { projection.close(); }
    }
  }
});
