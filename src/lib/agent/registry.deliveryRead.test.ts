import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, setSystemTime, test } from "bun:test";
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

test("an operation snapshot resolves its delivery by the owner index without unrelated history", () => {
  const { registry: seedRegistry, delivery } = seed("operation-scope");
  const state = seedRegistry.snapshot();
  for (let i = 0; i < 500; i++) {
    const id = `unrelated-operation-${i}`;
    state.heldDeliveries[id] = { ...structuredClone(delivery), id, conversationId: `conversation_unrelated_${i}`,
      command: { ...delivery.command, operationId: `unrelated-operation-key-${i}` } };
  }
  fs.writeFileSync(seedRegistry.filename, JSON.stringify(state));
  const registry = new AgentRegistry(seedRegistry.filename, undefined, undefined, { sqliteMode: "sqlite" });
  try {
    const snapshot = registry.deliverySnapshotForOperation(delivery.command.operationId);
    const owner = snapshot.deliveryOperationOwners[delivery.command.operationId]!;
    expect(snapshot.heldDeliveries[owner.deliveryId]?.command.operationId).toBe(delivery.command.operationId);
    expect(Object.keys(snapshot.heldDeliveries)).toEqual([owner.deliveryId]);
  } finally { registry.close(); seedRegistry.close(); }
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

test("admission ordering reads its conversation's aliases without loading unrelated deliveries", () => {
  const { registry: seedRegistry, conversation, delivery } = seed("admission-order");
  const state = seedRegistry.snapshot();
  state.conversationAliases.conversation_old = conversation.id;
  state.heldDeliveries[delivery.id]!.conversationId = "conversation_old";
  state.heldDeliveries[delivery.id]!.admissionSeq = 7;
  for (let i = 0; i < 200; i++) {
    const id = `unrelated-${i}`;
    state.heldDeliveries[id] = { ...structuredClone(delivery), id,
      conversationId: `conversation_background-${i}`, admissionSeq: 999,
      command: { ...delivery.command, operationId: `background-operation-${i}` } };
  }
  fs.writeFileSync(seedRegistry.filename, JSON.stringify(state));
  let reads = 0;
  const registry = new AgentRegistry(seedRegistry.filename, undefined, undefined, { sqliteMode: "sqlite",
    onSqliteRowPayloadRead: (_collection, count) => { reads += count; } });
  try {
    reads = 0;
    const next = registry.holdDelivery(conversation.id, "next message", "next-key");
    expect(next.admissionSeq).toBe(8);
    const generationId = conversation.generations.at(-1)!.id;
    expect(registry.beginDeliveryAttempt(next.id, generationId)).toBeNull();
    expect(registry.beginDeliveryAttempt(delivery.id, generationId)?.state).toBe("delivery-uncertain");
    expect(reads).toBeLessThan(100);
  } finally {
    registry.close();
    seedRegistry.close();
  }
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

test("opening an existing termination projection upgrades connected conversation and entry writers", () => {
  const { registry, conversation } = seed("termination-upgrade");
  const state = registry.snapshot();
  state.conversations[conversation.id]!.continuityPaths.push("/sessions/target.jsonl");
  const filename = path.join(root, "termination-upgrade.sqlite");
  let store = new SqliteAgentRegistryStore(filename, { initialSnapshot: state, normalize: normalizeRegistry });
  store.close();
  const writer = new Database(filename);
  writer.exec(`DROP TRIGGER registry_rows_termination_update;
    CREATE TRIGGER registry_rows_termination_update AFTER UPDATE ON registry_rows WHEN NEW.collection='conversations' BEGIN
      DELETE FROM registry_termination_paths WHERE conversation_id=OLD.row_key;
      INSERT OR IGNORE INTO registry_termination_paths SELECT NEW.row_key,json_extract(value,'$.path')
        FROM json_each(NEW.value_json,'$.generations');
      INSERT OR IGNORE INTO registry_termination_paths SELECT NEW.row_key,value FROM json_each(NEW.value_json,'$.continuityPaths');
    END;
    UPDATE registry_meta SET value='1' WHERE key='termination_projection_version';`);
  const before = writer.query("SELECT * FROM registry_rows ORDER BY collection,row_key").all();
  store = new SqliteAgentRegistryStore(filename, { initialSnapshot: state, normalize: normalizeRegistry });
  try {
    expect(writer.query("SELECT * FROM registry_rows ORDER BY collection,row_key").all()).toEqual(before);
    const row = structuredClone(state.conversations[conversation.id]!);
    row.generations.push({ ...row.generations[0]!, id: "upgraded-generation" });
    row.continuityPaths.push("/sessions/upgraded-termination.jsonl");
    writer.query(`INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('conversations',?,?,0)
      ON CONFLICT(collection,row_key) DO UPDATE SET value_json=excluded.value_json`).run(conversation.id, JSON.stringify(row));
    expect(store.terminationPage(conversation.id, 0, 8).totalGenerations).toBe(2);
    expect(store.terminationIdentity({ path: "/sessions/upgraded-termination.jsonl" })?.id).toBe(conversation.id);
    expect(store.terminationIdentity({ path: "/sessions/target.jsonl" })?.id).toBe(conversation.id);
    const key = { engine: "codex" as const, sessionId: "termination-upgrade-owner" };
    const entryKey = `${key.engine}:${key.sessionId}`;
    const child = { pid: 2147483647, startIdentity: "retained-child" };
    const entry = { key, artifactPath: "/sessions/target.jsonl", cwd: "/repo", accountId: null,
      status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
      updatedAt: "2026-11-12T12:00:00.000Z", structuredTerminationSurvivors: [child] };
    const version = () => store.terminationIdentity({ conversationId: conversation.id })!.version;
    const owner = () => store.terminationPage(conversation.id, 0, 8).snapshot.entries[entryKey];
    let beforeVersion = version();
    writer.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('entries',?,?,0)")
      .run(entryKey, JSON.stringify(entry));
    expect(version()).not.toBe(beforeVersion);
    expect(owner()?.structuredTerminationSurvivors?.[0]).toEqual(child);
    beforeVersion = version();
    writer.query("UPDATE registry_rows SET value_json=? WHERE collection='conversations' AND row_key=?")
      .run(JSON.stringify({ ...row, title: "Updated conversation" }), conversation.id);
    expect(version()).not.toBe(beforeVersion);
    expect(owner()?.structuredTerminationSurvivors?.[0]).toEqual(child);
    beforeVersion = version();
    writer.query("UPDATE registry_rows SET value_json=? WHERE collection='entries' AND row_key=?")
      .run(JSON.stringify({ ...entry, artifactPath: "/sessions/detached-owner.jsonl" }), entryKey);
    expect(version()).not.toBe(beforeVersion);
    expect(owner()).toBeUndefined();
    beforeVersion = version();
    writer.query("UPDATE registry_rows SET value_json=? WHERE collection='entries' AND row_key=?")
      .run(JSON.stringify(entry), entryKey);
    expect(version()).not.toBe(beforeVersion);
    expect(owner()?.structuredTerminationSurvivors?.[0]).toEqual(child);
    beforeVersion = version();
    writer.query("DELETE FROM registry_rows WHERE collection='entries' AND row_key=?").run(entryKey);
    expect(version()).not.toBe(beforeVersion);
    expect(owner()).toBeUndefined();
  } finally { writer.close(); store.close(); registry.close(); }
});

test.each(["off", "sqlite"] as const)("recipient failure health survives restart and observes terminal corrections (%s)", sqliteMode => {
  const at = "2026-11-01T12:00:00.000Z";
  setSystemTime(new Date(at));
  const filename = path.join(root, `incoming-${sqliteMode}.json`);
  let reads = 0;
  let registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode, onSqliteRowPayloadRead: (_collection, count) => { reads += count; } });
  try {
    const conversation = registry.ensureConversation("claude", "/sessions/incoming.jsonl", null);
    expect(registry.incomingDeliveryHealth(conversation.id)).toBeNull();
    const fail = (key: string, disposition: "lost" | "unverified" = "lost") => {
      const delivery = registry.holdDelivery(conversation.id, "fixture request", key);
      registry.recordDeliveryOutcome(delivery.id, "failed", "claude-native-broker/admission: native-evidence-uncertain", disposition);
      return delivery;
    };
    const first = fail("incoming-first");
    registry.recordDeliveryOutcome(first.id, "failed", "same terminal replay", "lost");
    expect(registry.incomingDeliveryHealth(conversation.id)).toMatchObject({ failures: 1, firstFailedAt: at });
    fail("incoming-second");
    registry.close();
    registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode, onSqliteRowPayloadRead: (_collection, count) => { reads += count; } });
    const summary = registry.incomingDeliveryHealth(conversation.id);
    expect(summary).toMatchObject({ failures: 2, firstFailedAt: at, lastDeliveredAt: null });
    expect(normalizeRegistry(registry.snapshot()).conversations[conversation.id]!.incomingDeliveryHealth).toEqual(summary!);
    const uncertain = fail("incoming-unverified", "unverified");
    expect(registry.incomingDeliveryHealth(conversation.id)).toMatchObject({ failures: 0, firstFailedAt: null });
    fail("incoming-after-unknown");
    expect(registry.incomingDeliveryHealth(conversation.id)?.failures).toBe(1);
    registry.recordDeliveryOutcomeForOperation(conversation.id, uncertain.command.operationId, "delivered", null, "delivered");
    expect(registry.incomingDeliveryHealth(conversation.id)).toMatchObject({ failures: 0, firstFailedAt: null, lastDeliveredAt: at });
    // Populate retained unrelated admissions, then measure only the hot read.
    const other = registry.ensureConversation("claude", "/sessions/unrelated.jsonl", null);
    for (let i = 0; i < 120; i++) {
      const held = registry.holdDelivery(other.id, "fixture unrelated", `unrelated-${i}`);
      registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
    }
    reads = 0;
    expect(registry.incomingDeliveryHealth(conversation.id)?.failures).toBe(0);
    if (sqliteMode === "sqlite") expect(reads).toBeLessThanOrEqual(4);
    const legacy = registry.snapshot(); delete legacy.conversations[conversation.id]!.incomingDeliveryHealth;
    expect(normalizeRegistry(legacy).conversations[conversation.id]!.incomingDeliveryHealth).toBeUndefined();
    const nextEpisode = fail("new-episode");
    expect(registry.incomingDeliveryHealth(conversation.id)?.episodeId).toBe(nextEpisode.command.operationId);
    expect(registry.incomingDeliveryHealth(conversation.id)?.episodeId).not.toBe(summary!.episodeId);
  } finally { registry.close(); setSystemTime(); }
});
