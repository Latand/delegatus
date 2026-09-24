import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore, registryRowsMatching, registryConversationsForPath } from "./sqliteRegistryStore";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-read-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function seed(name: string) {
  const registry = new AgentRegistry(path.join(root, `${name}.json`), undefined, undefined, { sqliteMode: "off" });
  registry.reconcileConversations([{ engine: "codex", path: "/sessions/target.jsonl", accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }), turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date().toISOString() }]);
  const conversation = registry.conversationForPath("/sessions/target.jsonl")!;
  const delivery = registry.holdDelivery(conversation.id, "keep this message", "same-key", "text", [], null);
  return { registry, conversation, delivery };
}

test("keyed reads retain multi-hop alias and old reservation evidence after reopening", () => {
  const { registry: seedRegistry, conversation, delivery } = seed("aliases");
  const state = seedRegistry.snapshot();
  state.conversationAliases.conversation_alias = "conversation_middle";
  state.conversationAliases.conversation_middle = conversation.id;
  state.heldDeliveries[delivery.id]!.conversationId = "conversation_alias";
  delete state.deliveryOperationOwners[delivery.command.operationId];
  state.conversations[conversation.id]!.continuityPaths.push("/sessions/historical.jsonl");
  fs.writeFileSync(seedRegistry.filename, JSON.stringify(state));
  let registry = new AgentRegistry(seedRegistry.filename, undefined, undefined, { sqliteMode: "sqlite" });
  try {
    expect(registry.conversationForPath("/sessions/historical.jsonl")?.id).toBe(conversation.id);
    expect(registry.conversation("conversation_alias")?.id).toBe(conversation.id);
    expect(registry.deliveryAdmissionForKey(conversation.id, "same-key")).toMatchObject({ outcome: "admitted", operationId: delivery.command.operationId });
    expect(registry.deliverySnapshotForOperation(delivery.command.operationId).deliveryOperationOwners[delivery.command.operationId]).toBeTruthy();
    expect(() => registry.preflightDeliveryReservation(conversation.id, "changed", "same-key", "text", [], null)).toThrow();
  } finally { registry.close(); }
  registry = new AgentRegistry(seedRegistry.filename, undefined, undefined, { sqliteMode: "sqlite" });
  expect(registry.conversationForPath("/sessions/historical.jsonl")?.id).toBe(conversation.id);
  registry.close();
});

test("indexed selections observe in-transaction inserts, changes and deletions", () => {
  const { registry, conversation, delivery } = seed("transaction");
  const store = new SqliteAgentRegistryStore(path.join(root, "transaction.sqlite"), { initialSnapshot: registry.snapshot(), normalize: normalizeRegistry });
  try {
    store.mutate(file => {
      file.heldDeliveries[delivery.id]!.conversationId = "conversation_moved";
      expect(registryRowsMatching(file, "heldDeliveries", "conversationId", conversation.id)).toHaveLength(0);
      expect(registryRowsMatching(file, "heldDeliveries", "conversationId", "conversation_moved")).toHaveLength(1);
      delete file.heldDeliveries[delivery.id];
      expect(registryRowsMatching(file, "heldDeliveries", "conversationId", "conversation_moved")).toHaveLength(0);
      file.conversations[conversation.id]!.continuityPaths.push("/sessions/new-path.jsonl");
      expect(registryConversationsForPath(file, "/sessions/new-path.jsonl")[0]?.id).toBe(conversation.id);
    }, false);
    expect(store.read(file => registryConversationsForPath(file, "/sessions/new-path.jsonl")[0]?.id)).toBe(conversation.id);
  } finally { store.close(); }
});

test("conversation upserts retain overlapping generation and continuity paths", () => {
  const { registry, conversation, delivery } = seed("overlapping-paths");
  const state = registry.snapshot();
  const row = state.conversations[conversation.id]!;
  row.continuityPaths.push(row.generations[0]!.path);
  row.generations.push({ ...row.generations[0]!, id: "repeated-path-generation" });
  const filename = path.join(root, "overlapping-paths.sqlite");
  let store = new SqliteAgentRegistryStore(filename, { initialSnapshot: state, normalize: normalizeRegistry });
  try {
    store.mutate(file => {
      file.conversations[conversation.id]!.continuityPaths.push("/sessions/extra.jsonl");
    }, false);
    expect(store.read(file => registryConversationsForPath(file, "/sessions/target.jsonl").map(row => row.id))).toEqual([conversation.id]);
    expect(store.snapshot().file.heldDeliveries[delivery.id]).toEqual(state.heldDeliveries[delivery.id]);
    store.close();
    store = new SqliteAgentRegistryStore(filename, { initialSnapshot: state, normalize: normalizeRegistry });
    expect(store.read(file => registryConversationsForPath(file, "/sessions/extra.jsonl").map(row => row.id))).toEqual([conversation.id]);
  } finally { store.close(); registry.close(); }
});

test("a pre-index SQLite registry backfills historical paths and old ownerless reservations", () => {
  const { registry, conversation, delivery } = seed("upgrade");
  const filename = path.join(root, "upgrade.sqlite");
  let store = new SqliteAgentRegistryStore(filename, { initialSnapshot: registry.snapshot(), normalize: normalizeRegistry });
  store.close();
  const legacy = new Database(filename);
  legacy.exec("DROP TRIGGER registry_paths_insert; DROP TRIGGER registry_paths_update; DROP TRIGGER registry_paths_delete; DROP TABLE registry_conversation_paths; DELETE FROM registry_meta WHERE key IN ('conversation_paths_ready', 'conversation_paths_trigger_version'); DELETE FROM registry_rows WHERE collection='deliveryOperationOwners'");
  const before = legacy.query("SELECT value_json FROM registry_rows WHERE collection='conversations'").all();
  legacy.close();
  store = new SqliteAgentRegistryStore(filename, { initialSnapshot: registry.snapshot(), normalize: normalizeRegistry });
  try {
    expect(store.read(file => registryConversationsForPath(file, "/sessions/target.jsonl")[0]?.id)).toBe(conversation.id);
    const owner = store.read(file => JSON.parse(JSON.stringify(file.deliveryOperationOwners[delivery.command.operationId])));
    expect(owner).toMatchObject({ conversationId: conversation.id, deliveryId: delivery.id });
    const db = new Database(filename, { readonly: true });
    expect(db.query("SELECT value_json FROM registry_rows WHERE collection='conversations'").all()).toEqual(before);
    db.close();
    store.mutate(file => { file.conversations[conversation.id]!.continuityPaths.push("/sessions/after-backfill.jsonl"); }, false);
    expect(store.read(file => registryConversationsForPath(file, "/sessions/after-backfill.jsonl").map(row => row.id))).toEqual([conversation.id]);
  } finally { store.close(); }
});

test("opening an existing path index upgrades triggers for already connected upsert writers", () => {
  const { registry, conversation } = seed("trigger-upgrade");
  const state = registry.snapshot();
  state.conversations[conversation.id]!.continuityPaths.push("/sessions/target.jsonl");
  const filename = path.join(root, "trigger-upgrade.sqlite");
  let store = new SqliteAgentRegistryStore(filename, { initialSnapshot: state, normalize: normalizeRegistry });
  store.close();
  const writer = new Database(filename);
  writer.exec(`DROP TRIGGER registry_paths_update;
    CREATE TRIGGER registry_paths_update AFTER UPDATE ON registry_rows WHEN NEW.collection = 'conversations' BEGIN
      DELETE FROM registry_conversation_paths WHERE conversation_id = OLD.row_key;
      INSERT OR IGNORE INTO registry_conversation_paths SELECT json_extract(value, '$.path'), NEW.row_key FROM json_each(NEW.value_json, '$.generations') WHERE json_extract(value, '$.path') IS NOT NULL;
      INSERT OR IGNORE INTO registry_conversation_paths SELECT value, NEW.row_key FROM json_each(NEW.value_json, '$.continuityPaths');
    END;
    DELETE FROM registry_meta WHERE key = 'conversation_paths_trigger_version';`);
  const before = writer.query("SELECT * FROM registry_rows ORDER BY collection, row_key").all();
  store = new SqliteAgentRegistryStore(filename, { initialSnapshot: state, normalize: normalizeRegistry });
  try {
    expect(writer.query("SELECT * FROM registry_rows ORDER BY collection, row_key").all()).toEqual(before);
    const row = structuredClone(state.conversations[conversation.id]!);
    row.continuityPaths.push("/sessions/upgraded.jsonl");
    writer.query(`INSERT INTO registry_rows(collection, row_key, value_json, row_order) VALUES ('conversations', ?, ?, 0)
      ON CONFLICT(collection, row_key) DO UPDATE SET value_json = excluded.value_json`).run(conversation.id, JSON.stringify(row));
    expect(store.read(file => registryConversationsForPath(file, "/sessions/upgraded.jsonl").map(row => row.id))).toEqual([conversation.id]);
    expect(store.read(file => registryConversationsForPath(file, "/sessions/target.jsonl").map(row => row.id))).toEqual([conversation.id]);
  } finally { writer.close(); store.close(); registry.close(); }
});
