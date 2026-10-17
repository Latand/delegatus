import { receiptHotCallers, replayReceiptCaller } from "./receiptHotCallers.fixture";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { deliveryHasDurableClaimOwner, type RegistryFile } from "./registry";
import { registryRowsMatching, SqliteAgentRegistryStore } from "./sqliteRegistryStore";

import { receiptReadFixture as fixture, closeReceiptReadFixtures, observeReceiptSelections } from "./receiptRead.fixture";

afterEach(closeReceiptReadFixtures);

test("each ownership check reads only the recipient receipts, including a fresh view per call", () => {
  const f = fixture();
  f.store.readOnlySnapshot();
  const db = (f.store as unknown as { db: Database }).db;
  const query = db.query.bind(db);
  const observed = new WeakSet<object>();
  let maxReceiptRows = 0;
  db.query = ((sql: string, ...args: Parameters<Database["query"]> extends [string, ...infer A] ? A : never) => {
    const statement = query(sql, ...args);
    if (!observed.has(statement)) {
      observed.add(statement);
      const all = statement.all.bind(statement);
      statement.all = (...bindings) => {
        const rows = all(...bindings);
        if (sql.includes("'receipts'") || /collection\s*=\s*\?/.test(sql) && bindings[0] === "receipts") maxReceiptRows = Math.max(maxReceiptRows, rows.length);
        return rows;
      };
    }
    return statement;
  }) as typeof db.query;
  for (let tick = 0; tick < 3; tick++) {
    f.reset(); maxReceiptRows = 0;
    for (let n = 0; n < 20; n++) {
      const view = f.store.readOnlySnapshot().file;
      const conversation = view.conversations[f.id]!;
      const generation = conversation.generations.at(-1)!;
      expect(deliveryHasDurableClaimOwner(view, conversation,
        { generationId: generation.id } as RegistryFile["heldDeliveries"][string])).toBe(true);
    }
    expect(f.reads()).toBeLessThanOrEqual(20);
    expect(maxReceiptRows).toBeLessThanOrEqual(1);
  }
});

test("indexed receipt selections see pending edits, deletes and inserts in collection order", () => {
  const f = fixture();
  f.store.mutate(file => {
    const selected = file.receipts["receipt-00512"]!;
    file.receipts["receipt-00000"]!.conversationId = f.id;
    delete file.receipts["receipt-00512"];
    file.receipts.inserted = { ...selected, launchId: "inserted" };
    expect(registryRowsMatching(file, "receipts", "conversationId", [f.id, "conversation_missing", f.id]).map(r => r.launchId))
      .toEqual(["receipt-00000", "inserted"]);
  }, false);
  expect(registryRowsMatching(f.store.readOnlySnapshot().file, "receipts", "conversationId", [f.id, "conversation_missing", f.id]).map(r => r.launchId))
    .toEqual(["receipt-00000", "inserted"]);
});

test("receipt ownership observes a peer settlement and a reopened reader", () => {
  const f = fixture();
  const check = (store: SqliteAgentRegistryStore) => {
    const view = store.readOnlySnapshot().file;
    return deliveryHasDurableClaimOwner(view, view.conversations[f.id]!,
      { generationId: "current" } as RegistryFile["heldDeliveries"][string]);
  };
  expect(check(f.store)).toBe(true);
  f.open().mutate(file => { file.receipts["receipt-00512"]!.state = "completed"; }, false);
  expect(check(f.store)).toBe(false);
  expect(check(f.open())).toBe(false);
});

test("receipt selectors use scoped indexes with large ineligible history", async () => {
  const f = fixture(2049);
  await f.store.prepareRecoveryIndexes();
  const db = new Database(f.filename, { readonly: true });
  try {
    for (const field of ["launchId", "conversationId", "artifactPath", "parentConversationId", "launchProfile.parentConversationId", "pendingSpawnCapability.operationId", "pendingSpawnCapability.digest", "spawnCapabilityDigest", "clientAttemptId", "state"]) {
      const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT row_key,row_order FROM registry_hot_rows
        WHERE collection='receipts' AND json_extract(value_json,'$.${field}') IN ('fixture')
        UNION ALL SELECT a.row_key,a.row_order FROM registry_archive a CROSS JOIN registry_cold c
        WHERE a.collection='receipts' AND json_extract(a.value_json,'$.${field}') IN ('fixture')
          AND c.collection=a.collection AND c.row_key=a.row_key AND c.archive_id=a.id ORDER BY row_order`).all();
      expect(plan.some(row => row.detail.includes("SEARCH") && row.detail.includes("registry_lookup_"))).toBe(true);
      expect(plan.some(row => row.detail.startsWith("SCAN"))).toBe(false);
      expect(plan.some(row => row.detail.includes("SEARCH a USING INDEX registry_archive_"))).toBe(true);
    }
  } finally { db.close(); }
});


test("held receipt selections keep their cut across a peer rebind", async () => {
  const f = fixture();
  await f.store.prepareRecoveryIndexes();
  f.store.mutate(file => {
    const row = file.receipts["receipt-00512"]!;
    row.clientAttemptId = "previous-attempt";
    row.pendingSpawnCapability = { operationId: "previous-operation", digest: "0".repeat(64) };
  }, false);
  const held = f.store.readOnlySnapshot().file;
  f.open().mutate(file => {
    const row = file.receipts["receipt-00512"]!;
    row.conversationId = "conversation_rebound";
    row.state = "completed";
    row.clientAttemptId = "next-attempt";
    row.pendingSpawnCapability = { operationId: "next-operation", digest: "1".repeat(64) };
  }, false);
  for (const [field, previous, next] of [
    ["conversationId", f.id, "conversation_rebound"],
    ["state", "starting", "completed"],
    ["clientAttemptId", "previous-attempt", "next-attempt"],
    ["pendingSpawnCapability.operationId", "previous-operation", "next-operation"],
  ] as const) {
    expect(registryRowsMatching(held, "receipts", field, ["missing", previous, previous]).some(row => row.launchId === "receipt-00512")).toBe(true);
    expect(registryRowsMatching(held, "receipts", field, ["missing", next]).some(row => row.launchId === "receipt-00512")).toBe(false);
    const fresh = f.store.readOnlySnapshot().file;
    expect(registryRowsMatching(fresh, "receipts", field, ["missing", next]).some(row => row.launchId === "receipt-00512")).toBe(true);
  }
});


test("conflicting launch diagnostics select in collection order without reading unrelated receipts", async () => {
  const f = fixture();
  await f.store.prepareRecoveryIndexes();
  f.reset();
  const selected = registryRowsMatching(f.store.readOnlySnapshot().file, "receipts", "launchId", ["receipt-00512", "receipt-00000"]);
  expect(selected.map(row => row.launchId)).toEqual(["receipt-00000", "receipt-00512"]);
  expect(f.reads()).toBeLessThanOrEqual(2);
});

test.each([
  ["duplicate canonical ids", ["conversation_selected", "conversation_selected"]],
  ["distinct canonical ids", ["conversation_missing", "conversation_selected"]],
] as const)("receipt multi-value selectors seek indexes: %s", async (_name, ids) => {
  const f = fixture(2049);
  await f.store.prepareRecoveryIndexes();
  const { plans } = observeReceiptSelections(f.store);
  f.reset();
  expect(registryRowsMatching(f.store.readOnlySnapshot().file, "receipts", "conversationId", ids).map(row => row.launchId))
    .toEqual(["receipt-02048"]);
  expect(f.reads()).toBeLessThanOrEqual(1);
  expect(plans.length).toBeGreaterThan(0);
  expect(plans.filter(detail => /(?:SCAN|SEARCH) (registry_rows|registry_hot_rows|a)( |$)/.test(detail) && !detail.includes("<expr>=?"))).toEqual([]);
});

// Each HTTP consumer's receipt-bearing liveness request, plus the fleet join.
test.each([...receiptHotCallers])("%s keeps receipt work narrow with retained history", async caller => {
  const f = fixture(2049);
  await f.store.prepareRecoveryIndexes();
  const { plans } = observeReceiptSelections(f.store);
  f.reset();
  const { snapshot } = await replayReceiptCaller(caller, f.store);
  expect(snapshot.conversations.map(row => row.conversationId)).toEqual([f.id]);
  expect(f.reads()).toBeLessThanOrEqual(2);
  expect(plans.length).toBeGreaterThan(0);
  expect(plans.filter(detail => /(?:SCAN|SEARCH) (registry_rows|registry_hot_rows|a)( |$)/.test(detail) && !detail.includes("<expr>=?"))).toEqual([]);
});

test("empty and absent receipt selections do no payload work", async () => {
  const f = fixture();
  await f.store.prepareRecoveryIndexes();
  const { plans } = observeReceiptSelections(f.store);
  f.reset();
  const view = f.store.readOnlySnapshot().file;
  f.reset();
  expect(registryRowsMatching(view, "receipts", "conversationId", [])).toEqual([]);
  expect(plans).toEqual([]);
  expect(registryRowsMatching(view, "receipts", "conversationId", ["missing", "also-missing", "missing"])).toEqual([]);
  expect(f.reads()).toBe(0);
  expect(plans.filter(detail => /(?:SCAN|SEARCH) (registry_rows|registry_hot_rows|a)( |$)/.test(detail) && !detail.includes("<expr>=?"))).toEqual([]);
});

test("multiple lookup values merge hot and archived matches in collection order", async () => {
  const f = fixture();
  await f.store.prepareRecoveryIndexes();
  f.store.mutate(file => {
    file.receipts["receipt-00512"]!.conversationId = "conversation_second";
    file.receipts["receipt-00000"]!.conversationId = f.id;
    file.receipts["receipt-00001"]!.conversationId = f.id;
  }, false);
  const select = (store: SqliteAgentRegistryStore) => registryRowsMatching(store.readOnlySnapshot().file,
    "receipts", "conversationId", ["conversation_second", f.id, f.id]).map(row => row.launchId);
  const before = f.store.readOnlySnapshot().file;
  expect(select(f.store)).toEqual(["receipt-00000", "receipt-00001", "receipt-00512"]);
  f.open().mutate(file => { delete file.receipts["receipt-00000"]; file.receipts["receipt-00001"]!.conversationId = "conversation_other"; }, false);
  expect(registryRowsMatching(before, "receipts", "conversationId", [f.id, "conversation_second"]).map(row => row.launchId))
    .toEqual(["receipt-00000", "receipt-00001", "receipt-00512"]);
  expect(select(f.store)).toEqual(["receipt-00512"]);
  expect(select(f.open())).toEqual(["receipt-00512"]);
});
