import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, deliveryHasDurableClaimOwner, normalizeRegistry, type RegistryFile } from "./registry";
import { registryRowsMatching, SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const roots: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(count = 513) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-read-")); roots.push(root);
  const seed = new AgentRegistry(path.join(root, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const original = seed.ensureConversation("codex", "/fixture/current.jsonl", null);
  seed.close();
  const id = "conversation_selected" as const;
  const at = "2026-10-01T00:00:00.000Z";
  const conversation = { ...original, id, createdAt: at, updatedAt: at,
    generations: original.generations.map(g => ({ ...g, id: "current", host: null, createdAt: at })) };
  const initial = normalizeRegistry({ version: 2, entries: {}, conversations: { [id]: conversation },
    receipts: Object.fromEntries(Array.from({ length: count }, (_, n) => {
      const selected = n === count - 1;
      const key = `receipt-${n.toString().padStart(5, "0")}`;
      return [key, { launchId: key, conversationId: selected ? id : `conversation_history_${n}`, engine: "codex",
        cwd: "/fixture", createdAt: at, state: selected ? "starting" : "completed", transport: "structured", error: null,
        artifactPath: selected ? "/fixture/current.jsonl" : `/fixture/history-${n}.jsonl`,
        launchProfile: emptyLaunchProfile({ cwd: "/fixture", title: "Receipt read fixture", mcpServers: ["viewer"] }) }];
    })) });
  let reads = 0;
  const filename = path.join(root, "registry.sqlite");
  const open = () => {
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry,
      onRowPayloadRead: (collection, n) => { if (collection === "receipts") reads += n; } });
    stores.push(store); return store;
  };
  const store = open();
  while (store.archiveInactive(250)) { /* seed retained production history */ }
  return { store, open, initial, id, filename, reset: () => { reads = 0; }, reads: () => reads };
}

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
    expect(registryRowsMatching(file, "receipts", "conversationId", f.id).map(r => r.launchId))
      .toEqual(["receipt-00000", "inserted"]);
  }, false);
  expect(registryRowsMatching(f.store.readOnlySnapshot().file, "receipts", "conversationId", f.id).map(r => r.launchId))
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
    for (const field of ["conversationId", "artifactPath", "parentConversationId", "launchProfile.parentConversationId", "pendingSpawnCapability.operationId", "pendingSpawnCapability.digest", "spawnCapabilityDigest", "clientAttemptId", "state"]) {
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
    expect(registryRowsMatching(held, "receipts", field, previous).some(row => row.launchId === "receipt-00512")).toBe(true);
    expect(registryRowsMatching(held, "receipts", field, next).some(row => row.launchId === "receipt-00512")).toBe(false);
    const fresh = f.store.readOnlySnapshot().file;
    expect(registryRowsMatching(fresh, "receipts", field, next).some(row => row.launchId === "receipt-00512")).toBe(true);
  }
});
