import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { registryConversationsForPath, registryRowsMatching, SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory,{ recursive: true,force: true });
});
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12,"0")}`;

function fixture(large = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"delegatus-registry-archive-"));
  directories.push(directory);
  const seed = new AgentRegistry(path.join(directory,"seed.json"),undefined,undefined,{ sqliteMode: "off" });
  const conversation = seed.ensureConversation("codex",`/sessions/${id(0)}.jsonl`,null);
  const receipt = seed.beginSpawn("codex","/repo",{ title: "Archive regression" });
  const delivery = seed.holdDelivery(conversation.id,"archive regression","archive-regression");
  const source = seed.snapshot();
  seed.close();
  const initial = normalizeRegistry({ version: 2,entries: {},receipts: {} });
  const count = large ? 4_245 : 3;
  const conversationId = (index: number) => `conversation_${id(index)}` as typeof conversation.id;
  for (let index = 0; index < count; index++) {
    const key = conversationId(index);
    initial.conversations[key] = { ...structuredClone(conversation),id: key,
      generations: [{ ...structuredClone(conversation.generations[0]!),id: id(index),path: `/sessions/${id(index)}.jsonl` }] };
  }
  for (let index = 0; index < (large ? 3_331 : 2); index++) {
    const key = { engine: "codex" as const,sessionId: id(index) };
    initial.entries[`codex:${key.sessionId}`] = { key,artifactPath: `/sessions/${key.sessionId}.jsonl`,cwd: "/repo",accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),status: index < (large ? 3_256 : 1) ? "dead" : "idle",
      host: null,claimEpoch: 0,claimOwner: null,pendingAction: null,updatedAt: conversation.updatedAt };
    if (large && index >= 3_279) initial.entries[`codex:${key.sessionId}`]!.status = index < 3_304 ? "live" : "unhosted";
  }
  for (let index = 0; index < (large ? 3_379 : 3); index++) {
    const launchId = `archive-launch-${index}`;
    initial.receipts[launchId] = { ...structuredClone(receipt),launchId,conversationId: conversationId(index),clientAttemptId: `archive-attempt-${index}`,
      requestDigest: "d".repeat(64),spawnCapabilityDigest: index === 0 ? "a".repeat(64) : null,
      key: { engine: "codex",sessionId: id(index) },artifactPath: `/sessions/${id(index)}.jsonl`,
      state: index >= (large ? 3_377 : 2) ? "path-pending" : index >= (large ? 3_355 : 1) ? "failed" : "completed",
      launchDisplay: { prompt: "archive fixture ".repeat(large ? 205 : 1),echo: "archive fixture",images: 0 } };
  }
  const heldTemplate = source.heldDeliveries[delivery.id]!;
  const ownerTemplate = source.deliveryOperationOwners[heldTemplate.command.operationId]!;
  for (let index = 0; index < (large ? 3_860 : 1); index++) {
    const key = `archive-delivery-${index}`;
    const command = { ...structuredClone(heldTemplate.command),operationId: `archive-operation-${index}` };
    initial.heldDeliveries[key] = { ...structuredClone(heldTemplate),id: key,conversationId: conversationId(index),command,state: "delivered" };
  }
  for (let index = 0; index < (large ? 5_521 : 1); index++) {
    const key = `archive-operation-${index}`;
    initial.deliveryOperationOwners[key] = { ...structuredClone(ownerTemplate),command: { ...structuredClone(ownerTemplate.command),operationId: key },conversationId: conversationId(index%count),
      deliveryId: `archive-delivery-${index}`,
      terminalState: "delivered",terminalDisposition: "delivered",terminalReason: "retained archive evidence ".repeat(large ? 300 : 1) };
  }
  for (let index = 0; index < (large ? 3_824 : 1); index++) {
    const child = conversationId(index);
    initial.lineageEdges[child] = { childConversationId: child,parentConversationId: conversationId(count-1),childSessionKey: null,parentSessionKey: null,
      childArtifactPath: `/sessions/${id(index)}.jsonl`,parentArtifactPath: null,kind: "spawn",role: null,reviewsConversationId: null,
      source: "viewer-spawn",evidence: { launchId: `archive-launch-${index}`,clientAttemptId: `archive-attempt-${index}` },createdAt: conversation.createdAt };
  }
  for (let index = 0; index < (large ? 2_752 : 1); index++) {
    const key = conversationId(index);
    initial.memberships[key] = [{ conversationId: key,kind: "pipeline",containerId: "archive-fixture",role: "builder",slot: "build",
      stageId: null,stageOrder: null,round: null,parentConversationId: null,createdAt: conversation.createdAt }];
  }
  for (let index = 0; index < (large ? 40 : 0); index++) {
    const key = `archive-migration-${index}`;
    initial.migrationIntents[key] = { id: key,engine: "codex",targetId: "fixture-account",origin: "manual",revision: 1,
      state: "complete",createdAt: conversation.createdAt,updatedAt: conversation.updatedAt,requestIds: [],evidence: null,stoppedAt: null };
  }
  const filename = path.join(directory,"agent-registry.sqlite");
  const open = (observed?: { reads: number; loads: number }) => {
    const store = new SqliteAgentRegistryStore(filename,{ initialSnapshot: initial,normalize: normalizeRegistry,
      onRowPayloadRead: (_collection,n) => { if (observed) observed.reads += n; },
      onSnapshotLoad: () => { if (observed) observed.loads++; } });
    stores.push(store); return store;
  };
  return { directory,filename,open,initial,conversationId };
}

function archiveAll(store: SqliteAgentRegistryStore) {
  let moved = 0;
  for (let pass = 0; pass < 100; pass++) {
    const batch = store.archiveInactive(1_000);
    moved += batch;
    if (!batch) return moved;
  }
  throw new Error("archive pass did not converge");
}

test("cold resume, path ownership, capability and exact launch replay survive reopen, promotion and deletion", () => {
  const { open,filename,initial,conversationId,directory } = fixture();
  const store = open();
  const before = store.snapshot().file;
  expect(archiveAll(store)).toBeGreaterThan(0);
  const old = store.readOnlySnapshot().file;
  expect(store.snapshot().file).toEqual(before);
  expect(Object.keys(old.entries)).toEqual(Object.keys(before.entries));
  expect(old.conversations[conversationId(0)]).toEqual(before.conversations[conversationId(0)]);
  const reopened = open();
  expect(reopened.read(file => registryConversationsForPath(file,`/sessions/${id(0)}.jsonl`).map(row => row.id))).toEqual([conversationId(0)]);
  expect(reopened.read(file => registryRowsMatching(file,"receipts","clientAttemptId","archive-attempt-0")[0]?.launchId)).toBe("archive-launch-0");
  expect(reopened.seatMcpReceipt(conversationId(0))?.spawnCapabilityDigest).toBe("a".repeat(64));
  expect(reopened.snapshotSpawns(["archive-launch-0"])["archive-launch-0"]?.state).toBe("completed");
  const registry = new AgentRegistry(path.join(directory,"agent-registry.json"),undefined,undefined,{ sqliteMode: "sqlite",sqliteFilename: filename });
  try {
    expect(registry.conversationIdForSpawnCapabilityDigest("a".repeat(64))).toBe(conversationId(0));
    expect(registry.spawnReceiptForClientAttempt("archive-attempt-0")?.launchId).toBe("archive-launch-0");
    expect(registry.conversationForPath(`/sessions/${id(0)}.jsonl`)?.id).toBe(conversationId(0));
    expect(registry.beginSpawnRequest({ engine: "codex",cwd: "/repo",clientAttemptId: "archive-attempt-0",requestDigest: "d".repeat(64),
      launchProfile: initial.receipts["archive-launch-0"]!.launchProfile }).kind).toBe("replay");
  } finally { registry.close(); }
  reopened.mutate(file => { file.conversations[conversationId(0)]!.pinnedAccountId = "fixture-account"; },false);
  expect(reopened.readOnlySnapshot().file.conversations[conversationId(0)]?.pinnedAccountId).toBe("fixture-account");
  expect(old.conversations[conversationId(0)]?.pinnedAccountId).toBe(initial.conversations[conversationId(0)]?.pinnedAccountId);
  reopened.mutate(file => { delete file.receipts["archive-launch-0"]; },false);
  expect(reopened.readOnlySnapshot().file.receipts["archive-launch-0"]).toBeUndefined();
  expect(old.receipts["archive-launch-0"]?.state).toBe("completed");
  const db = new Database(filename,{ readonly: true });
  try { expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); } finally { db.close(); }
});

test("an old reader sees cold history and an old writer promotes it during release handover", () => {
  const { open,filename,initial } = fixture();
  const store = open();
  archiveAll(store);
  const db = new Database(filename);
  try {
    const receipt = db.query<{ value_json: string }, []>(
      "SELECT value_json FROM registry_rows WHERE collection='receipts' AND row_key='archive-launch-0'").get()!;
    expect(JSON.parse(receipt.value_json).clientAttemptId).toBe("archive-attempt-0");
    db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.error','legacy writer') WHERE collection='receipts' AND row_key='archive-launch-0'");
    expect(store.readOnlySnapshot().file.receipts["archive-launch-0"]?.error).toBe("legacy writer");
    expect(db.query("SELECT 1 FROM registry_cold WHERE collection='receipts' AND row_key='archive-launch-0'").get()).toBeNull();
  } finally { db.close(); }
  const preUpgrade = path.join(path.dirname(filename),"pre-upgrade.sqlite");
  const legacy = new SqliteAgentRegistryStore(preUpgrade,{ initialSnapshot: initial,normalize: normalizeRegistry,allowArchiveMigration: false });
  stores.push(legacy);
  expect(legacy.archiveInactive()).toBe(0);
  const schema = new Database(preUpgrade,{ readonly: true });
  try {
    expect(schema.query("SELECT name FROM sqlite_master WHERE name IN ('registry_lookup_state','registry_lookup_clientAttemptId','registry_lookup_spawnCapabilityDigest')").all()).toEqual([]);
  } finally { schema.close(); }
  legacy.mutate(file => { file.receipts["archive-launch-0"]!.error = "pre-upgrade writer"; },false);
  expect(legacy.readOnlySnapshot().file.receipts["archive-launch-0"]?.error).toBe("pre-upgrade writer");
});

test("an interrupted archive move rolls back and outstanding work stays hot", () => {
  const { open,filename,conversationId,initial } = fixture();
  const store = open();
  store.mutate(file => {
    file.heldDeliveries["archive-delivery-0"]!.state = "held";
    file.deliveryOperationOwners["archive-operation-0"]!.terminalState = null;
    file.entries[`codex:${id(0)}`]!.claimOwner = "fixture-owner";
    file.receipts["archive-detached"] = { ...structuredClone(initial.receipts["archive-launch-0"]!),launchId: "archive-detached",key: null };
  },false);
  const before = store.snapshot().file;
  const db = new Database(filename);
  try {
    db.run("CREATE TRIGGER archive_fault BEFORE INSERT ON registry_cold BEGIN SELECT RAISE(ABORT,'injected archive interruption'); END");
    expect(() => store.archiveInactive()).toThrow("injected archive interruption");
    expect(store.snapshot().file).toEqual(before);
    db.run("DROP TRIGGER archive_fault");
    archiveAll(store);
    for (const [collection,key] of [["entries",`codex:${id(0)}`],["heldDeliveries","archive-delivery-0"],
      ["deliveryOperationOwners","archive-operation-0"],["conversations",conversationId(0)],["receipts","archive-launch-2"]]) {
      expect(db.query("SELECT 1 AS found FROM registry_hot_rows WHERE collection=? AND row_key=?").get(collection!,key!)).toEqual({ found: 1 });
    }
    expect(() => db.run("DELETE FROM registry_archive")).toThrow("no expiry");
  } finally { db.close(); }
});

test("cold independent lineage still denies a forged root grant, and external evidence changes redecide it", () => {
  const { open,filename,initial,conversationId } = fixture();
  const reader = open();
  archiveAll(reader);
  reader.readOnlySnapshot();
  const db = new Database(filename);
  try {
    const root = structuredClone(initial.conversations[conversationId(1)]!);
    root.delegationDepth = 0;
    const forged = { ...structuredClone(initial.receipts["archive-launch-0"]!),conversationId: root.id,key: null,
      delegationDepth: 0,launchProfile: { ...initial.receipts["archive-launch-0"]!.launchProfile,mcpServers: ["viewer","telegram"] } };
    db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES (?,?,?,?) ON CONFLICT(collection,row_key) DO UPDATE SET value_json=excluded.value_json")
      .run("conversations",root.id,JSON.stringify(root),1);
    db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES (?,?,?,?) ON CONFLICT(collection,row_key) DO UPDATE SET value_json=excluded.value_json")
      .run("receipts",forged.launchId,JSON.stringify(forged),0);
    expect(db.query("SELECT 1 AS found FROM registry_cold WHERE collection='lineageEdges' AND row_key=?").get(conversationId(0))).toEqual({ found: 1 });
    const denied = reader.readOnlySnapshot().file;
    expect(denied.receipts[forged.launchId]?.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(reader.read(file => file.receipts[forged.launchId]?.launchProfile.mcpServers)).toEqual(["viewer"]);
    const writer = open();
    writer.mutate(file => { delete file.lineageEdges[conversationId(0)]; },false);
    expect(reader.readOnlySnapshot().file.receipts[forged.launchId]?.launchProfile.mcpServers).toEqual(["viewer","telegram"]);
    expect(denied.receipts[forged.launchId]?.launchProfile.mcpServers).toEqual(["viewer"]);
  } finally { db.close(); }
});

test("a trimmed external journal falls back to the bounded hot loader and preserves cold history", () => {
  const { open,filename } = fixture();
  const reader = open();
  archiveAll(reader);
  const previous = reader.readOnlySnapshot().file;
  const db = new Database(filename);
  try {
    db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.error','after gap') WHERE collection='receipts' AND row_key='archive-launch-2'").run();
    db.run("DELETE FROM registry_changes");
  } finally { db.close(); }
  const next = reader.readOnlySnapshot().file;
  expect(next.receipts["archive-launch-2"]?.error).toBe("after gap");
  expect(next.receipts["archive-launch-0"]).toEqual(previous.receipts["archive-launch-0"]);
  // The fallback's cursor is now zero. Another write followed by a trim must
  // still invalidate it even though MIN/MAX(seq) are both zero again.
  const trimmed = new Database(filename);
  try {
    trimmed.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.error','second empty gap') WHERE collection='receipts' AND row_key='archive-launch-2'");
    trimmed.run("DELETE FROM registry_changes");
  } finally { trimmed.close(); }
  expect(reader.readOnlySnapshot().file.receipts["archive-launch-2"]?.error).toBe("second empty gap");
});

test("external receipt proof changes revoke and restore a hot child's grant beside cold history", () => {
  const { open,filename,initial,conversationId } = fixture();
  const parent = initial.conversations[conversationId(2)]!;
  parent.agentRole = "orchestrator";
  parent.delegationDepth = 0;
  parent.generations[0]!.launchProfile.mcpServers = ["viewer","telegram"];
  const child = initial.conversations[conversationId(0)]!;
  child.agentRole = "builder";
  child.delegationDepth = 1;
  child.generations[0]!.launchProfile.parentConversationId = parent.id;
  child.generations[0]!.launchProfile.mcpServers = ["viewer","telegram"];
  const receipt = initial.receipts["archive-launch-0"]!;
  receipt.agentRole = "builder";
  receipt.delegationDepth = 1;
  receipt.parentConversationId = parent.id;
  receipt.telegramSeatGrant = true;
  receipt.launchProfile = structuredClone(child.generations[0]!.launchProfile);
  initial.lineageEdges[child.id]!.evidence.telegramSeatGrant = true;
  const entry = initial.entries[`codex:${id(0)}`]!;
  entry.claimOwner = "fixture-owner";
  entry.launchProfile = structuredClone(receipt.launchProfile);
  const store = open();
  archiveAll(store);
  expect(store.readOnlySnapshot().file.entries[`codex:${id(0)}`]?.launchProfile?.mcpServers).toEqual(["viewer","telegram"]);
  const db = new Database(filename);
  try {
    for (const allowed of [false,true]) {
      db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.telegramSeatGrant',json(?)) WHERE collection='receipts' AND row_key='archive-launch-0'").run(JSON.stringify(allowed));
      expect(store.readOnlySnapshot().file.entries[`codex:${id(0)}`]?.launchProfile?.mcpServers)
        .toEqual(allowed ? ["viewer","telegram"] : ["viewer"]);
    }
  } finally { db.close(); }
});

test("a 26,952-row registry retains all history while bounding payload caches and external refresh reads", () => {
  const { open,filename } = fixture(true);
  const metrics = { reads: 0,loads: 0 };
  const store = open(metrics);
  const db = new Database(filename,{ readonly: true });
  let payloadBytes: number;
  try {
    const shape = db.query<{ count: number; bytes: number }, []>(
      "SELECT COUNT(*) AS count,SUM(LENGTH(value_json)) AS bytes FROM registry_records").get()!;
    expect(shape.count).toBe(26_952);
    payloadBytes = shape.bytes;
    expect(payloadBytes).toBeGreaterThan(70_000_000);
  } finally { db.close(); }
  const start = performance.now();
  const moved = archiveAll(store);
  expect(moved).toBeGreaterThan(25_000);
  const conserved = new Database(filename,{ readonly: true });
  try {
    expect(conserved.query("SELECT COUNT(*) AS count FROM registry_records").get()).toEqual({ count: 26_952 });
    expect(conserved.query(`SELECT COUNT(*) AS mismatches FROM registry_rows r
      LEFT JOIN registry_records p ON p.collection=r.collection AND p.row_key=r.row_key
      WHERE p.row_key IS NULL OR p.value_json!=r.value_json`).get()).toEqual({ mismatches: 0 });
  } finally { conserved.close(); }
  const view = store.readOnlySnapshot().file;
  expect(Object.keys(view.conversations)).toHaveLength(4_245);
  expect(Object.keys(view.receipts)).toHaveLength(3_379);
  // Historical enumeration remains supported; it must not retain its payloads.
  expect(Object.values(view.receipts)).toHaveLength(3_379);
  const caches = store as unknown as { rowCache: Map<string,Map<string,unknown>>; coldReaderRows: Map<number,unknown> };
  expect([...caches.rowCache.values()].reduce((n,rows) => n+rows.size,0)).toBeLessThan(1_000);
  expect(caches.coldReaderRows.size).toBeLessThanOrEqual(128);
  metrics.reads = metrics.loads = 0;
  const writer = open();
  writer.mutate(file => { file.receipts["archive-launch-0"]!.error = "external archived replay update"; },false);
  writer.mutate(file => { file.receipts["archive-launch-1"]!.error = "second external archived update"; },false);
  const refresh = performance.now();
  expect(store.readOnlySnapshot().file.receipts["archive-launch-0"]?.error).toBe("external archived replay update");
  expect(metrics.loads).toBe(0);
  expect(metrics.reads).toBeLessThanOrEqual(2);
  console.info(JSON.stringify({ registryRows: 26_952,payloadBytes,archivedRows: moved,archiveMs: refresh-start,refreshMs: performance.now()-refresh,payloadReads: metrics.reads }));
},120_000);


test("terminal migration history goes cold while draining and referenced intents stay hot", () => {
  const { open,filename,initial,conversationId } = fixture();
  const time = initial.conversations[conversationId(0)]!.createdAt;
  for (const [key,state] of [["migration-complete","complete"],["migration-stopped","stopped"],
    ["migration-draining","draining"],["migration-referenced","complete"]] as const) {
    initial.migrationIntents[key] = { id: key,engine: "codex",targetId: "fixture-account",origin: "manual",revision: 1,
      state,createdAt: time,updatedAt: time,requestIds: [key],evidence: null,stoppedAt: state === "stopped" ? time : null };
  }
  initial.conversations[conversationId(0)]!.migration = { intentId: "migration-referenced",phase: "committed",
    targetId: "fixture-account",revision: 1,error: null,errorCode: null,operationId: "migration-operation",
    sourceGenerationId: id(0),providerReceipt: null,pendingContinuityPaths: [],boardProject: null,
    boardOperationId: null,boardPlacementProject: null,updatedAt: time };
  const store = open();
  archiveAll(store);
  const db = new Database(filename,{ readonly: true });
  try {
    expect(db.query("SELECT row_key FROM registry_hot_rows WHERE collection='migrationIntents' ORDER BY row_key").all())
      .toEqual([{ row_key: "migration-draining" },{ row_key: "migration-referenced" }]);
    expect(db.query("SELECT row_key FROM registry_cold WHERE collection='migrationIntents' ORDER BY row_key").all())
      .toEqual([{ row_key: "migration-complete" },{ row_key: "migration-stopped" }]);
  } finally { db.close(); }
  expect(open().read(file => file.migrationIntents["migration-stopped"])).toEqual(initial.migrationIntents["migration-stopped"]);
});
