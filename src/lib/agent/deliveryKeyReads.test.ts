import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { lookupOriginalSend } from "@/lib/runtime/sendSettlement";
import { DELIVERY_KEY_ROW_LIMIT, deliveryRegistryEntriesForKey, normalizeRegistry } from "./registry";
import { registryKeysMatching, registryKeysMatchingBounded, SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { memoryDeliveryEvidence } from "@/lib/memory/deliveryEvidence";

const roots: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const at = "2026-10-01T00:00:00.000Z";
function fixture(count = 1025) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-key-reads-")); roots.push(root);
  const file = normalizeRegistry({ version: 2, entries: {}, receipts: {}, conversations: {
    conversation_target: { id: "conversation_target", engine: "codex", createdAt: at, updatedAt: at,
      generations: [{ id: "generation_target", path: "/sessions/target.jsonl", createdAt: at,
        launchProfile: emptyLaunchProfile({ cwd: "/repo", mcpServers: ["viewer"] }) }] },
  }, conversationAliases: { conversation_old: "conversation_target" },
  deliveryOperationOwners: Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const operation = `operation-${String(index).padStart(5, "0")}`;
    return [operation, { conversationId: index === 0 ? "conversation_old" : "conversation_other",
      clientMessageId: index === 0 ? "selected-key" : `other-${index}`,
      deliveryId: `delivery-${index}`, requestDigest: `digest-${index}`, contentDigest: null,
      command: { operationId: operation, origin: { kind: "operator" } }, createdAt: at,
      terminalState: "delivered", terminalDisposition: "delivered", settledAt: at, settledReason: null }];
  })) });
  let decoded = 0;
  const filename = path.join(root, "registry.sqlite");
  const open = () => {
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: file, normalize: normalizeRegistry,
      onRowPayloadParse: (_collection, count) => { decoded += count; } });
    stores.push(store); return store;
  };
  return { file, filename, open, reset: () => { decoded = 0; }, decoded: () => decoded };
}

test("recovery filters message key and aliased recipient before decoding hot and archived bodies", async () => {
  const f = fixture(); const store = f.open();
  await store.prepareRecoveryIndexes();
  for (const archived of [false, true]) {
    if (archived) expect(store.archiveInactive(10_000)).toBeGreaterThan(1000);
    await store.prepareReadOnlySnapshot();
    for (let repeat = 0; repeat < 3; repeat++) {
      const view = store.readOnlySnapshot().file; f.reset();
      expect(deliveryRegistryEntriesForKey(view, "deliveryOperationOwners", "selected-key", ["conversation_target", "conversation_target"])
        .map(([key]) => key)).toEqual(["operation-00000"]);
      expect(lookupOriginalSend(view, { conversationId: "conversation_target", clientMessageId: "selected-key" }).kind).toBe("found");
      expect(deliveryRegistryEntriesForKey(view, "deliveryOperationOwners", "selected-key", ["conversation_unrelated"])).toEqual([]);
      expect(deliveryRegistryEntriesForKey(view, "deliveryOperationOwners", "absent", ["conversation_target"])).toEqual([]);
      expect(f.decoded()).toBeLessThan(8);
    }
  }
});

test("a changed key, recipient and disposition are visible on the next view and after reopen", async () => {
  const f = fixture(); const store = f.open(); const peer = f.open();
  await store.prepareReadOnlySnapshot();
  expect(store.archiveInactive(10_000)).toBeGreaterThan(0);
  await store.prepareReadOnlySnapshot();
  const held = store.readOnlySnapshot().file;
  peer.mutate(file => {
    const owner = file.deliveryOperationOwners["operation-00000"]!;
    owner.clientMessageId = "changed-key"; owner.conversationId = "conversation_changed";
    owner.terminalState = "failed"; owner.terminalDisposition = "unverified";
  }, false);
  for (const reader of [store, f.open()]) {
    const view = reader.readOnlySnapshot().file;
    expect(deliveryRegistryEntriesForKey(view, "deliveryOperationOwners", "selected-key", ["conversation_target"])).toEqual([]);
    const result = lookupOriginalSend(view, { conversationId: "conversation_changed", clientMessageId: "changed-key" });
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.receipt.state).toBe("failed");
  }
  expect(deliveryRegistryEntriesForKey(held, "deliveryOperationOwners", "selected-key", ["conversation_target"]).length).toBe(1);
  expect(deliveryRegistryEntriesForKey(held, "deliveryOperationOwners", "changed-key", ["conversation_changed"])).toEqual([]);
});

test("recovery refuses an over-budget key before decoding and still refuses after reopen", async () => {
  const f = fixture(DELIVERY_KEY_ROW_LIMIT + 1); const store = f.open();
  store.mutate(file => {
    for (const owner of Object.values(file.deliveryOperationOwners)) {
      owner.clientMessageId = "crowded-key"; owner.conversationId = "conversation_target";
    }
  }, false);
  for (const reader of [store, f.open()]) {
    await reader.prepareReadOnlySnapshot(); f.reset();
    expect(() => deliveryRegistryEntriesForKey(reader.readOnlySnapshot().file, "deliveryOperationOwners", "crowded-key", ["conversation_target"]))
      .toThrow("row budget");
    expect(f.decoded()).toBe(0);
  }
});

test("recipient intersection and relay refusal stop at bounded indexed headers", async () => {
  const f = fixture(20_000); const store = f.open();
  await store.prepareRecoveryIndexes();
  while (store.archiveInactive(10_000) > 0) { /* archive the complete retained fixture */ }
  await store.prepareReadOnlySnapshot();
  const view = store.readOnlySnapshot().file;
  f.reset();

  const db = new Database(f.filename, { readonly: true });
  try {
    const plan = db.query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN
      SELECT row_key FROM registry_rows INDEXED BY registry_lookup_clientMessageId_conversationId_deliveryOperationOwners
      WHERE collection='deliveryOperationOwners' AND json_extract(value_json,'$.clientMessageId') IN (?)
        AND json_extract(value_json,'$.conversationId') IN (?,?)
      ORDER BY row_order LIMIT ?`).all("selected-key", "conversation_target", "conversation_old", DELIVERY_KEY_ROW_LIMIT + 1);
    expect(plan.some(row => row.detail.includes("registry_lookup_clientMessageId_conversationId_deliveryOperationOwners")
      && row.detail.includes("clientMessageId") && row.detail.includes("conversationId"))).toBe(true);
    expect(plan.some(row => row.detail.startsWith("SCAN"))).toBe(false);
  } finally { db.close(); }

  expect(deliveryRegistryEntriesForKey(view, "deliveryOperationOwners", "absent", ["conversation_target"])).toEqual([]);
  expect(f.decoded()).toBe(0);
  expect(deliveryRegistryEntriesForKey(view, "deliveryOperationOwners", "selected-key", ["conversation_target"]).map(([key]) => key))
    .toEqual(["operation-00000"]);
  expect(f.decoded()).toBe(1);

  f.reset();
  expect(registryKeysMatchingBounded(view, "deliveryOperationOwners", [], 257)).toHaveLength(257);
  expect(memoryDeliveryEvidence(view, "conversation_target", true)).toBeNull();
  expect(f.decoded()).toBe(0);
});

test("a heavily reused message key seeks the requested recipients in hot and archived rows", async () => {
  const f = fixture(20_000); const store = f.open();
  store.mutate(file => {
    for (const [key, owner] of Object.entries(file.deliveryOperationOwners)) {
      owner.clientMessageId = "shared-key";
      owner.conversationId = `conversation_unrelated_${key}`;
    }
  }, false);
  await store.prepareRecoveryIndexes();
  const db = new Database(f.filename, { readonly: true });
  try {
    const plans = db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN
      SELECT row_key FROM registry_rows INDEXED BY registry_lookup_clientMessageId_conversationId_deliveryOperationOwners
      WHERE collection='deliveryOperationOwners' AND json_extract(value_json,'$.clientMessageId') IN (?)
        AND json_extract(value_json,'$.conversationId') IN (?,?) ORDER BY row_order LIMIT ?`)
      .all("shared-key", "conversation_target", "conversation_old", String(DELIVERY_KEY_ROW_LIMIT + 1));
    expect(plans.some(row => row.detail.includes("registry_lookup_clientMessageId_conversationId_deliveryOperationOwners")
      && row.detail.includes("clientMessageId") && row.detail.includes("conversationId"))).toBe(true);
    expect(plans.some(row => row.detail.startsWith("SEARCH"))).toBe(true);
    expect(plans.some(row => row.detail.startsWith("SCAN"))).toBe(false);
  } finally { db.close(); }

  for (const archived of [false, true]) {
    if (archived) {
      let archivedRows = 0;
      while (true) {
        const count = store.archiveInactive(10_000);
        archivedRows += count;
        if (count === 0) break;
      }
      expect(archivedRows).toBeGreaterThan(20_000);
    }
    await store.prepareReadOnlySnapshot(); f.reset();
    const view = store.readOnlySnapshot().file;
    expect(deliveryRegistryEntriesForKey(view, "deliveryOperationOwners", "shared-key", ["conversation_target", "conversation_old"]))
      .toEqual([]);
    expect(f.decoded()).toBe(0);
  }
}, 30_000);

test("message-key selectors seek scoped hot and archive indexes for duplicate and multiple bindings", async () => {
  const f = fixture(); const store = f.open(); await store.prepareRecoveryIndexes();
  const db = new Database(f.filename, { readonly: true });
  try {
    for (const collection of ["heldDeliveries", "deliveryOperationOwners"]) {
      for (const values of [["selected-key"], ["selected-key", "absent", "selected-key"]]) {
        // Production deliberately makes a singleton seek for each distinct value.
        for (const value of new Set(values)) {
          const plans = db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN
            SELECT row_key,row_order FROM registry_hot_rows WHERE collection='${collection}' AND json_extract(value_json,'$.clientMessageId') IN (?)
            UNION ALL SELECT a.row_key,a.row_order FROM registry_archive a CROSS JOIN registry_cold c
              WHERE a.collection='${collection}' AND json_extract(a.value_json,'$.clientMessageId') IN (?)
                AND c.collection=a.collection AND c.row_key=a.row_key AND c.archive_id=a.id ORDER BY row_order`).all(value, value);
          expect(plans.some(row => row.detail.includes(`registry_lookup_clientMessageId_${collection}`))).toBe(true);
          expect(plans.some(row => row.detail.includes(`registry_archive_clientMessageId_${collection}`))).toBe(true);
          expect(plans.some(row => row.detail.startsWith("SCAN"))).toBe(false);
        }
        expect(registryKeysMatching(store.readOnlySnapshot().file, "deliveryOperationOwners", "clientMessageId", values))
          .toEqual(["operation-00000"]);
      }
    }
  } finally { db.close(); }
});

test("authority facts are narrow and follow alias, generation, project and supersedence changes", () => {
  const f = fixture(); const store = f.open(); const peer = f.open(); f.reset();
  expect(store.conversationAuthorityFacts("conversation_old")).toEqual({ id: "conversation_target", superseded: false,
    hasGeneration: true, project: null, directories: ["/repo"] });
  expect(store.conversationAuthorityFacts("conversation_missing")).toBeNull();
  expect(f.decoded()).toBe(0);
  peer.mutate(file => {
    const conversation = file.conversations.conversation_target!;
    conversation.generations = [];
    conversation.supersededBy = { conversationId: "conversation_successor", at, reason: "recovery-spawn" };
    conversation.projectOwnership = { project: "project-b", source: "operator", setAt: at, operationId: "project-change" };
  }, false);
  for (const reader of [store, f.open()]) expect(reader.conversationAuthorityFacts("conversation_old"))
    .toEqual({ id: "conversation_target", superseded: true, hasGeneration: false, project: "project-b", directories: [] });
});
