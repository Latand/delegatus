import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { registryConversationsForPath, registryLivenessRows, registryRowsMatching, SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { archiveCandidates, archiveInactiveRegistryRows, installRegistryArchive } from "./registryArchive";
import { normalizeHostMemory } from "@/lib/runtime/agentMemoryState";
import { codexHostColumns } from "@/lib/runtime/registry";

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

function scopedFixture(legacy: boolean) {
  const f = fixture();
  const unit = "delegatus-agent-projection-fixture.scope";
  const columns = codexHostColumns({ status: "dead", sessionKey: id(0), endpoint: "stdio:released", pid: null,
    processStartIdentity: null, eventCursor: 0, protocolVersion: null, activeTurnRef: null,
    pendingAttention: [], activeFlags: [], account: null, ...(legacy
      ? { memory: normalizeHostMemory({ mechanism: "scope", limitBytes: 2 ** 30, unit, kills: 0, lastKill: null })! }
      : { scope: { unit, bootEpoch: "fixture-boot" } }) }, 1);
  const key = `codex:${id(0)}`;
  f.initial.entries[key]!.structuredHost = columns;
  return { ...f, key, columns };
}

test.each([false, true])("liveness retains a process-free scope through writes and pinned snapshots (legacy=%s)", legacy => {
  const { open, initial, key, columns } = scopedFixture(legacy);
  const store = open();
  const entry = structuredClone(initial.entries[key]!);
  const keys = (file: ReturnType<typeof normalizeRegistry>) => registryLivenessRows(file).entries.map(row => `codex:${row.key.sessionId}`);
  const held = store.readOnlySnapshot().file;
  expect(keys(held)).toContain(key);
  store.mutate(file => { file.entries[key]!.structuredHost = null; });
  expect(keys(store.readOnlySnapshot().file)).not.toContain(key);
  expect(keys(held)).toContain(key);
  store.mutate(file => { file.entries[key]!.structuredHost = columns; });
  expect(keys(store.readOnlySnapshot().file)).toContain(key);
  store.mutate(file => { delete file.entries[key]; });
  store.mutate(file => { file.entries[key] = entry; });
  expect(keys(store.readOnlySnapshot().file)).toContain(key);
});

test.each([false, true])("a read-only registry without a projection table still selects process-free scopes (legacy=%s)", legacy => {
  const { open, filename, initial } = scopedFixture(legacy);
  open().close();
  const db = new Database(filename);
  try {
    for (const kind of ["insert", "update", "delete"]) db.run(`DROP TRIGGER registry_liveness_${kind}`);
    db.run("DROP TABLE registry_liveness_entries");
    db.run("DROP TABLE registry_liveness_receipts");
    // The entry selector falls back when no table exists. Keep its later
    // receipt join resolvable without supplying a materialized projection.
    db.run("CREATE VIEW registry_liveness_entries AS SELECT row_key,row_order FROM registry_rows WHERE collection='entries'");
    // Select through SQL alone, without pinned-row recovery adding the row.
    db.run("DROP TABLE registry_changes");
    const reader = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry, readOnly: true });
    stores.push(reader);
    expect(registryLivenessRows(reader.readOnlySnapshot().file).entries.map(row => row.key.sessionId)).toContain(id(0));
  } finally { db.close(); }
});

test.each([false, true])("scope projection upgrade rolls back a failed backfill and retries in a fresh process (legacy=%s)", legacy => {
  const { open, filename, key, columns } = scopedFixture(legacy);
  open().close();
  const db = new Database(filename);
  try {
    // Recreate the previous projection: neither trigger selected scope-only rows.
    for (const name of ["registry_liveness_insert", "registry_liveness_update"]) {
      const sql = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?").get(name)!.sql;
      db.run(`DROP TRIGGER ${name}`);
      db.run(sql.split("\n").filter(line => !line.includes("$.structuredHost.scope.unit") && !line.includes("$.structuredHost.memory.unit")).join("\n"));
    }
    db.run("UPDATE registry_meta SET value='1' WHERE key='liveness_projection_version'");
    db.run("DELETE FROM registry_liveness_entries WHERE row_key=?", [key]);
    const oldTriggers = db.query("SELECT name,sql FROM sqlite_master WHERE name IN ('registry_liveness_insert','registry_liveness_update') ORDER BY name").all();
    db.run(`CREATE TRIGGER refuse_scope_backfill BEFORE INSERT ON registry_liveness_entries
      WHEN NEW.row_key='${key}' BEGIN SELECT RAISE(ABORT,'scope backfill refused'); END`);
    const restart = () => Bun.spawnSync([process.execPath, "-e", `
      const { SqliteAgentRegistryStore, registryLivenessRows } = await import(${JSON.stringify(path.resolve("src/lib/agent/sqliteRegistryStore.ts"))});
      const { normalizeRegistry } = await import(${JSON.stringify(path.resolve("src/lib/agent/registry.ts"))});
      const store = new SqliteAgentRegistryStore(process.argv[1], { initialSnapshot: () => { throw new Error("unexpected import"); }, normalize: normalizeRegistry });
      console.log(JSON.stringify(registryLivenessRows(store.readOnlySnapshot().file).entries.map(row => row.key.sessionId)));
      store.close();
    `, filename], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const refused = restart();
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain("scope backfill refused");
    expect(db.query("SELECT value FROM registry_meta WHERE key='liveness_projection_version'").get()).toEqual({ value: "1" });
    expect(db.query("SELECT name,sql FROM sqlite_master WHERE name IN ('registry_liveness_insert','registry_liveness_update') ORDER BY name").all()).toEqual(oldTriggers);
    expect(db.query("SELECT row_key FROM registry_liveness_entries WHERE row_key=?").get(key)).toBeNull();
    db.run("DROP TRIGGER refuse_scope_backfill");
    const recovered = restart();
    expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
    expect(JSON.parse(recovered.stdout.toString())).toContain(id(0));
    expect(db.query("SELECT value FROM registry_meta WHERE key='liveness_projection_version'").get()).toEqual({ value: "2" });
    const store = open();
    store.mutate(file => { file.entries[key]!.structuredHost = null; });
    store.mutate(file => { file.entries[key]!.structuredHost = columns; });
    expect(registryLivenessRows(store.readOnlySnapshot().file).entries.map(row => row.key.sessionId)).toContain(id(0));
  } finally { db.close(); }
});

test("keyed archive reads use the cold identity index after upgrading an existing view", () => {
  const { open, filename } = fixture();
  archiveAll(open());
  const db = new Database(filename);
  try {
    // Reproduce the first archive schema, including its retained cold payloads.
    db.exec(`DROP VIEW registry_records;
      CREATE VIEW registry_records AS
      SELECT collection,row_key,value_json,row_order FROM registry_hot_rows
      UNION ALL SELECT a.collection,a.row_key,a.value_json,a.row_order
      FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id`);
    const before = db.query("SELECT * FROM registry_records ORDER BY collection,row_key").all();
    installRegistryArchive(db);
    expect(db.query("SELECT * FROM registry_records ORDER BY collection,row_key").all()).toEqual(before);
    const query = "SELECT value_json FROM registry_records WHERE collection=? AND row_key=?";
    for (const key of [`codex:${id(0)}`, "missing-entry"]) {
      const plan = db.query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${query}`)
        .all("entries", key).map(row => row.detail);
      expect(plan.some(detail => /SCAN c\b/.test(detail))).toBe(false);
      expect(plan.some(detail => /SEARCH c .*\(collection=\? AND row_key=\?\)/.test(detail))).toBe(true);
    }
    expect(db.query(query).get("entries", `codex:${id(0)}`)).not.toBeNull();
    expect(db.query(query).get("entries", "missing-entry")).toBeNull();
    // Reopening a store must retain the indexed definition and the same rows.
    open();
    expect(db.query("SELECT * FROM registry_records ORDER BY collection,row_key").all()).toEqual(before);
  } finally { db.close(); }
});

test("field lookups over cold history start from the archive's expression indexes and keep every row", () => {
  const { open, filename } = fixture();
  archiveAll(open());
  const db = new Database(filename);
  try {
    // The view as #2762 first shipped it: identity from the mapping alone.
    db.exec(`DROP VIEW registry_records;
      CREATE VIEW registry_records AS
      SELECT collection,row_key,value_json,row_order FROM registry_hot_rows
      UNION ALL SELECT c.collection,c.row_key,a.value_json,a.row_order
      FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id`);
    const all = "SELECT * FROM registry_records ORDER BY collection,row_key";
    const before = db.query(all).all();
    installRegistryArchive(db);
    expect(db.query(all).all()).toEqual(before);
    const lookup = "SELECT row_key FROM registry_records WHERE collection=? AND json_extract(value_json,'$.command.operationId')=?";
    const plan = db.query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${lookup}`)
      .all("heldDeliveries", "archive-operation-0").map(row => row.detail);
    expect(plan.some(detail => /SEARCH a USING INDEX registry_archive_operation/.test(detail))).toBe(true);
    expect(plan.some(detail => /SCAN c\b|SEARCH c USING INDEX \S+ \(collection=\?\)$/.test(detail))).toBe(false);
    expect(db.query(lookup).all("heldDeliveries", "archive-operation-0")).toEqual([{ row_key: "archive-delivery-0" }]);
    expect(db.query(lookup).all("heldDeliveries", "missing-operation")).toEqual([]);
  } finally { db.close(); }
});

test("a cold mapping naming another row's archive version keeps the conserving view until it is repaired", () => {
  const { open, filename } = fixture();
  archiveAll(open());
  const db = new Database(filename);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...values: unknown[]) => { warnings.push(values.join(" ")); };
  try {
    const target = db.query<{ archive_id: number }, []>(
      "SELECT archive_id FROM registry_cold WHERE collection='receipts' AND row_key='archive-launch-0'").get()!;
    const other = db.query<{ archive_id: number }, []>(
      "SELECT archive_id FROM registry_cold WHERE NOT (collection='receipts' AND row_key='archive-launch-0') ORDER BY archive_id LIMIT 1").get()!;
    const otherPayload = db.query<{ value_json: string }, [number]>("SELECT value_json FROM registry_archive WHERE id=?").get(other.archive_id)!.value_json;
    db.run("UPDATE registry_cold SET archive_id=? WHERE collection='receipts' AND row_key='archive-launch-0'", [other.archive_id]);
    db.run("DROP VIEW registry_records");
    db.run("CREATE VIEW registry_records AS SELECT collection,row_key,value_json,row_order FROM registry_hot_rows");
    open();
    // The damaged mapping still reads under the identity its mapping gives it.
    const keyed = "SELECT value_json FROM registry_records WHERE collection='receipts' AND row_key=?";
    const ownPayload = db.query<{ value_json: string }, [number]>("SELECT value_json FROM registry_archive WHERE id=?").get(target.archive_id)!.value_json;
    expect(db.query(keyed).get("archive-launch-0")).toEqual({ value_json: otherPayload });
    expect(warnings.some(line => line.includes("1 cold mapping(s) name an archive version of another row"))).toBe(true);
    expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='registry_records'").get()!.sql)
      .not.toContain("a.collection=c.collection");
    db.run("UPDATE registry_cold SET archive_id=? WHERE collection='receipts' AND row_key='archive-launch-0'", [target.archive_id]);
    open();
    expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='registry_records'").get()!.sql)
      .toContain("a.collection=c.collection AND a.row_key=c.row_key");
    expect(db.query(keyed).get("archive-launch-0")).toEqual({ value_json: ownPayload });
  } finally {
    console.warn = warn;
    db.close();
  }
});

test("fleet liveness census skips archived dead entries and completed dead-host receipts", () => {
  const { open,initial } = fixture();
  for (const index of [0,1]) initial.entries[`codex:${id(index)}`]!.status = "live";
  const entryTemplate = initial.entries[`codex:${id(2)}`]!;
  for (let index = 0; index < 200; index++) {
    const key = { engine: "codex" as const,sessionId: id(index + 20_000) };
    initial.entries[`codex:${key.sessionId}`] = { ...structuredClone(entryTemplate),key,artifactPath: `/sessions/${key.sessionId}.jsonl`,status: "dead",
      host: null,structuredHost: null,claimOwner: null,pendingAction: null,structuredTerminationSurvivors: [] };
  }
  const template = initial.receipts["archive-launch-0"]!;
  for (let index = 0; index < 200; index++) {
    const key = { engine: "codex" as const,sessionId: id(index + 10_000) };
    const launchId = `completed-dead-host-${index}`;
    initial.receipts[launchId] = { ...structuredClone(template),launchId,key,artifactPath: `/sessions/${key.sessionId}.jsonl`,state: "completed",
      verifiedHost: { kind: "tmux",endpoint: "fixture",server: { pid: 900_000 + index,startIdentity: "old" },paneId: "dead-pane",
        panePid: { pid: 900_000 + index,startIdentity: "old" },windowName: "dead",agent: { pid: 900_000 + index,startIdentity: "old" },argv: [] } };
  }
  const liveKey = { engine: "codex" as const,sessionId: id(0) };
  initial.receipts["completed-live-host"] = { ...structuredClone(template),launchId: "completed-live-host",key: liveKey,state: "completed",
    verifiedHost: { kind: "tmux",endpoint: "fixture",server: { pid: 42,startIdentity: "current" },paneId: "live-pane",
      panePid: { pid: 42,startIdentity: "current" },windowName: "live",agent: { pid: 42,startIdentity: "current" },argv: [] } };
  const metrics = { reads: 0,loads: 0 };
  const store = open(metrics);
  archiveAll(store);
  const db = new Database(path.join(store.filename));
  try {
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM registry_cold WHERE collection='entries' AND row_key LIKE 'codex:%'").get()!.count).toBe(200);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM registry_cold WHERE collection='receipts' AND row_key LIKE 'completed-dead-host-%'").get()!.count).toBe(200);
  } finally { db.close(); }
  const snapshot = store.readOnlySnapshot().file;
  metrics.reads = metrics.loads = 0;

  const rows = registryLivenessRows(snapshot);

  expect(rows.entries.map(row => row.key.sessionId)).toContain(id(0));
  expect(rows.entries.map(row => row.key.sessionId)).toContain(id(1));
  expect(rows.receipts.map(row => row.launchId)).not.toContain("completed-dead-host-0");
  expect(rows.receipts.map(row => row.launchId)).toContain("completed-live-host");
  expect(metrics.loads).toBe(0);
  expect(metrics.reads).toBeLessThanOrEqual(8);
});

test("liveness receipt session probes seek selected keys with the old membership and order", () => {
  const { open, initial, filename } = fixture();
  const template = initial.receipts["archive-launch-0"]!;
  const pane = { panePid: { pid: 42, startIdentity: "fixture" } } as NonNullable<typeof template.pane>;
  const add = (launchId: string, session: number, hosted = true) => {
    initial.receipts[launchId] = { ...structuredClone(template), launchId,
      key: { engine: "codex", sessionId: id(session) }, state: "completed", verifiedHost: null,
      pane: hosted ? pane : null };
  };
  initial.entries[`codex:${id(2)}`] = { ...structuredClone(initial.entries[`codex:${id(1)}`]!),
    key: { engine: "codex", sessionId: id(2) } };
  // Deliberately reverse insertion order and give one session several receipts.
  add("session-two", 2);
  add("session-one-first", 1);
  add("session-one-second", 1);
  add("without-host", 1, false);
  add("dead-session", 0);
  add("missing-entry", 99);
  const store = open();
  archiveAll(store);
  const snapshot = store.readOnlySnapshot().file;
  const querySpy = spyOn(Database.prototype, "query");
  let sql: string;
  try {
    const rows = registryLivenessRows(snapshot);
    expect(rows.receipts.map(row => row.launchId).filter(key => key.startsWith("session-")))
      .toEqual(["session-one-first", "session-one-second", "session-two"]);
    sql = querySpy.mock.calls.find(([query]) => query.includes("INDEXED BY registry_liveness_receipt_session"))![0];
  } finally { querySpy.mockRestore(); }
  const db = new Database(filename);
  try {
    // Keep these rows hot so entry membership and host presence each decide
    // their exclusion independently of the cold-row filter.
    db.run("DELETE FROM registry_cold WHERE collection='receipts' AND row_key IN ('missing-entry','dead-session','without-host')");
    // Add a cold mapping to a hosted receipt, which the probe must exclude.
    db.run("INSERT INTO registry_cold(collection,row_key,archive_id) SELECT 'receipts','session-one-second',archive_id FROM registry_cold WHERE collection='receipts' AND row_key='archive-launch-0'");
    const old = (binds: string) => `SELECT r.row_key FROM registry_rows r INDEXED BY registry_liveness_receipt_session
      JOIN registry_liveness_entries e ON e.row_key IN (${binds})
      WHERE r.collection='receipts'
        AND (json_extract(r.value_json,'$.key.engine')||':'||json_extract(r.value_json,'$.key.sessionId'))=e.row_key
        AND (json_extract(r.value_json,'$.verifiedHost.agent') IS NOT NULL OR json_extract(r.value_json,'$.pane.panePid') IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM registry_cold c WHERE c.collection='receipts' AND c.row_key=r.row_key)`;
    for (const [values, expected] of [
      [[`codex:${id(1)}`], ["session-one-first"]],
      [[`codex:${id(2)}`, `codex:${id(1)}`], ["session-one-first", "session-two"]],
      [[`codex:${id(1)}`, `codex:${id(1)}`], ["session-one-first"]],
      [[`codex:${id(99)}`], []],
      [[`codex:${id(0)}`], []],
      [[`codex:${id(99)}`, `codex:${id(2)}`], ["session-two"]],
    ] as [string[], string[]][]) {
      const binds = values.map(() => "?").join(",");
      const query = sql.replace(/IN \(\?(?:,\?)*\)/, `IN (${binds})`);
      const actual = db.query<{ row_key: string }, string[]>(query).all(...values);
      expect(actual).toEqual(db.query<{ row_key: string }, string[]>(old(binds)).all(...values));
      expect(actual.map(row => row.row_key)).toEqual(expected);
      const plan = db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${query}`).all(...values).map(row => row.detail);
      expect(plan.some(detail => /SEARCH r USING INDEX registry_liveness_receipt_session \(.*<expr>=\?/.test(detail))).toBe(true);
      expect(plan.some(detail => /SCAN (?:r|e|c)\b/.test(detail))).toBe(false);
      expect(plan.some(detail => /SEARCH c .*collection=\? AND row_key=\?/.test(detail))).toBe(true);
    }
  } finally { db.close(); }
});

for (const transition of ["settled", "deleted", "rebound"] as const) {
  test(`a held liveness snapshot keeps its receipt after a peer ${transition} it`, () => {
    const { open, conversationId } = fixture();
    const reader = open();
    reader.mutate(file => {
      const receipt = file.receipts["archive-launch-0"]!;
      receipt.state = "starting";
      receipt.createdAt = "2026-10-17T00:00:00.000Z";
      receipt.verifiedHost = null;
    });
    const held = reader.readOnlySnapshot().file;
    expect(registryLivenessRows(held).receipts.map(row => row.launchId)).toContain("archive-launch-0");

    const writer = open();
    writer.mutate(file => {
      if (transition === "settled") file.receipts["archive-launch-0"]!.state = "completed";
      else if (transition === "deleted") delete file.receipts["archive-launch-0"];
      else file.receipts["archive-launch-0"]!.conversationId = conversationId(1);
    });

    const heldReceipt = registryLivenessRows(held).receipts.find(row => row.launchId === "archive-launch-0");
    expect(heldReceipt?.conversationId).toBe(conversationId(0));
    const fresh = reader.readOnlySnapshot().file;
    const current = registryLivenessRows(fresh).receipts.find(row => row.launchId === "archive-launch-0");
    if (transition === "settled" || transition === "deleted") expect(current).toBeUndefined();
    else expect(current?.conversationId).toBe(conversationId(1));
  });
}

for (const archived of [false,true]) {
  for (const external of [false,true]) {
    test(`detached reads preserve shared deltas after ${external ? "external" : "local"} ${archived ? "cold promotion" : "hot update"}`, () => {
      const { open } = fixture();
      const metrics = { reads: 0,loads: 0 };
      const reader = open(metrics);
      if (archived) archiveAll(reader);
      const held = reader.readOnlySnapshot().file;
      expect(held.receipts["archive-launch-0"]!.error).toBeNull();
      const writer = external ? open() : reader;
      writer.mutate(file => { file.receipts["archive-launch-0"]!.error = "updated receipt"; });
      expect(reader.snapshot().file.receipts["archive-launch-0"]!.error).toBe("updated receipt");
      metrics.reads = metrics.loads = 0;
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(reader.readOnlySnapshot().file.receipts["archive-launch-0"]!.error).toBe("updated receipt");
      }
      expect(held.receipts["archive-launch-0"]!.error).toBeNull();
      expect(metrics.loads).toBe(0);
      expect(metrics.reads).toBeLessThanOrEqual(1);
    });
  }
}

for (const archived of [false,true]) {
  test(`incremental delivery refresh normalizes its ${archived ? "cold" : "hot"} owner`, () => {
    const { open,filename,initial } = fixture();
    if (!archived) {
      initial.heldDeliveries["archive-delivery-0"]!.state = "held";
      initial.deliveryOperationOwners["archive-operation-0"]!.terminalState = null;
    }
    const metrics = { reads: 0,loads: 0 };
    const reader = open(metrics);
    if (archived) archiveAll(reader);
    const held = reader.readOnlySnapshot().file;
    const before = held.deliveryOperationOwners["archive-operation-0"];
    const db = new Database(filename);
    try {
      db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.state','failed','$.error','delivery failed') WHERE collection='heldDeliveries' AND row_key='archive-delivery-0'");
    } finally { db.close(); }
    metrics.reads = metrics.loads = 0;
    const shared = reader.readOnlySnapshot().file;
    expect(shared.deliveryOperationOwners["archive-operation-0"]!.terminalState).toBe("failed");
    expect(metrics.loads).toBe(0);
    expect(metrics.reads).toBeLessThanOrEqual(3);
    expect(shared.deliveryOperationOwners["archive-operation-0"]).toEqual(reader.snapshot().file.deliveryOperationOwners["archive-operation-0"]);
    expect(held.deliveryOperationOwners["archive-operation-0"]).toEqual(before);
  });

  test(`incremental legacy owner refresh uses its ${archived ? "cold" : "hot"} reservation`, () => {
    const { open,filename } = fixture();
    const reader = open();
    if (archived) archiveAll(reader);
    reader.readOnlySnapshot();
    const db = new Database(filename);
    try {
      db.run(`UPDATE registry_rows SET value_json=json_remove(value_json,'$.terminalState','$.contentDigest','$.targetGenerationId','$.evidenceText','$.runtimeConversationId','$.createdAt') WHERE collection='deliveryOperationOwners' AND row_key='archive-operation-0'`);
    } finally { db.close(); }
    const shared = reader.readOnlySnapshot().file;
    expect(shared.deliveryOperationOwners["archive-operation-0"]!.terminalState).toBe("delivered");
    expect(shared.deliveryOperationOwners["archive-operation-0"]).toEqual(reader.snapshot().file.deliveryOperationOwners["archive-operation-0"]);
  });

  test(`incremental owner deletion preserves ${archived ? "cold" : "hot"} reservation ownership`, () => {
    const { open,filename } = fixture();
    const reader = open();
    if (archived) archiveAll(reader);
    reader.readOnlySnapshot();
    const db = new Database(filename);
    try { db.run("DELETE FROM registry_rows WHERE collection='deliveryOperationOwners' AND row_key='archive-operation-0'"); }
    finally { db.close(); }
    const shared = reader.readOnlySnapshot().file;
    expect(shared.deliveryOperationOwners["archive-operation-0"]).toEqual(reader.snapshot().file.deliveryOperationOwners["archive-operation-0"]);
    expect(shared.deliveryOperationOwners["archive-operation-0"]!.terminalState).toBe("delivered");
  });
}

test("cold reservation ownership is synthesized on a fresh shared load", () => {
  const { open,filename } = fixture();
  const writer = open();
  archiveAll(writer);
  const db = new Database(filename);
  try { db.run("DELETE FROM registry_rows WHERE collection='deliveryOperationOwners' AND row_key='archive-operation-0'"); }
  finally { db.close(); }
  const reader = open();
  expect(reader.readOnlySnapshot().file.deliveryOperationOwners["archive-operation-0"])
    .toEqual(reader.snapshot().file.deliveryOperationOwners["archive-operation-0"]);
});

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

test("a cold launch replay without a title keeps its admitted name with bounded receipt reads", () => {
  const { open,filename,initial,directory } = fixture();
  for (let index = 0; index < 40; index++) {
    const launchId = `unrelated-launch-${index}`;
    initial.receipts[launchId] = { ...structuredClone(initial.receipts["archive-launch-1"]!),
      launchId,clientAttemptId: `unrelated-attempt-${index}` };
  }
  const store = open();
  archiveAll(store);
  let receiptReads = 0;
  const registry = new AgentRegistry(path.join(directory,"agent-registry.json"),undefined,undefined,{
    sqliteMode: "sqlite",sqliteFilename: filename,
    onSqliteRowPayloadRead: (collection,count) => { if (collection === "receipts") receiptReads += count; },
  });
  try {
    receiptReads = 0;
    const request = { engine: "codex" as const,cwd: "/repo",clientAttemptId: "archive-attempt-0",requestDigest: "d".repeat(64),
      launchDisplay: { prompt: "A different prompt-derived title",images: 0,echo: "Replay fixture" } };
    const replay = registry.beginSpawnRequest(request);
    expect(replay.kind).toBe("replay");
    expect(replay.receipt.launchId).toBe("archive-launch-0");
    expect(replay.receipt.launchProfile.title).toBe("Archive regression");
    expect(receiptReads).toBeLessThan(20);
    expect(registry.beginSpawnRequest({ ...request,launchProfile: { title: "Explicit replacement title" } }).kind).toBe("conflict");
  } finally { registry.close(); }
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

/* #2761: the pass finds its candidates before it takes the write lock, since
   the search is most of the pass and every writer waits behind the lock. What
   another writer revives between the search and the lock must stay hot. */
test("an archive pass confirms under the lock what it selected before it, and a pass with nothing to move takes no lock", () => {
  const { open,filename } = fixture();
  const store = open();
  const db = new Database(filename);
  try {
    const selected = archiveCandidates(db,1_000);
    const entry = { collection: "entries",row_key: `codex:${id(0)}` };
    const delivery = { collection: "heldDeliveries",row_key: "archive-delivery-0" };
    expect(selected).toContainEqual(entry);
    expect(selected).toContainEqual(delivery);
    /* Revived after the search: a claim on the entry, a delivery held again. */
    store.mutate(file => {
      file.entries[entry.row_key]!.claimOwner = "fixture-owner";
      file.heldDeliveries[delivery.row_key]!.state = "held";
    },false);
    db.exec("BEGIN IMMEDIATE");
    const moved = archiveInactiveRegistryRows(db,1_000,selected);
    db.exec("COMMIT");
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(selected.length - 2);
    for (const row of [entry,delivery]) {
      expect(db.query("SELECT 1 AS found FROM registry_hot_rows WHERE collection=? AND row_key=?").get(row.collection,row.row_key)).toEqual({ found: 1 });
    }
    const cold = db.query<{ collection: string; row_key: string }, []>("SELECT collection,row_key FROM registry_cold").all();
    expect(cold).toHaveLength(moved);
    for (const row of cold) expect(selected).toContainEqual(row);
    /* The same rows the single statement under the lock selects. */
    archiveAll(store);
    expect(archiveCandidates(db,1_000)).toEqual([]);
    /* Nothing left: another connection holding the write lock is not waited for. */
    db.exec("BEGIN IMMEDIATE");
    try { expect(store.archiveInactive()).toBe(0); } finally { db.exec("ROLLBACK"); }
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

test("held cold grants pin their decision before first access and after payload eviction", () => {
  const { open,initial,conversationId } = fixture();
  const root = initial.conversations[conversationId(1)]!;
  root.delegationDepth = 0;
  const receipt = initial.receipts["archive-launch-0"]!;
  receipt.conversationId = root.id;
  receipt.key = null;
  receipt.delegationDepth = 0;
  receipt.launchProfile.mcpServers = ["viewer","telegram"];
  const forged = structuredClone(receipt);
  // Baseline cold payloads fill and then evict the bounded reader cache.
  for (let index = 0; index < 140; index++) {
    const launchId = `eviction-launch-${index}`;
    initial.receipts[launchId] = { ...structuredClone(initial.receipts["archive-launch-1"]!),launchId,key: null };
  }
  const reader = open();
  archiveAll(reader);
  // An older writer can persist a claim without the assembled grant decision.
  const db = new Database(reader.filename);
  try {
    db.run("UPDATE registry_rows SET value_json=? WHERE collection='conversations' AND row_key=?",[JSON.stringify(root),root.id]);
    db.run("UPDATE registry_rows SET value_json=? WHERE collection='receipts' AND row_key=?",[JSON.stringify(forged),forged.launchId]);
  } finally { db.close(); }
  archiveAll(reader);
  const held = reader.readOnlySnapshot().file;
  const writer = open();
  const edge = structuredClone(initial.lineageEdges[conversationId(0)]!);
  writer.mutate(file => {
    delete file.lineageEdges[conversationId(0)];
    file.heldDeliveries["archive-delivery-0"]!.state = "failed";
  },false);
  const restored = reader.readOnlySnapshot().file;
  expect(restored.receipts[receipt.launchId]!.launchProfile.mcpServers).toEqual(["viewer","telegram"]);
  expect(held.receipts[receipt.launchId]!.launchProfile.mcpServers).toEqual(["viewer"]);
  expect(restored.deliveryOperationOwners["archive-operation-0"]!.terminalState).toBe("failed");
  expect(held.deliveryOperationOwners["archive-operation-0"]!.terminalState).toBe("delivered");
  for (let index = 0; index < 140; index++) expect(held.receipts[`eviction-launch-${index}`]).toBeDefined();
  expect(held.receipts[receipt.launchId]!.launchProfile.mcpServers).toEqual(["viewer"]);
  expect(held.deliveryOperationOwners["archive-operation-0"]!.terminalState).toBe("delivered");
  writer.mutate(file => { file.lineageEdges[conversationId(0)] = edge; },false);
  expect(reader.readOnlySnapshot().file.receipts[receipt.launchId]!.launchProfile.mcpServers).toEqual(["viewer"]);
  for (let index = 0; index < 140; index++) expect(restored.receipts[`eviction-launch-${index}`]).toBeDefined();
  expect(restored.receipts[receipt.launchId]!.launchProfile.mcpServers).toEqual(["viewer","telegram"]);
  const cache = reader as unknown as { coldReaderRows: Map<unknown,unknown> };
  expect(cache.coldReaderRows.size).toBeLessThanOrEqual(128);
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

test("external refresh leaves unrelated cold root grants warm", () => {
  const { open, initial, conversationId, filename } = fixture();
  initial.lineageEdges = {};
  const parent = initial.conversations[conversationId(0)]!;
  parent.delegationDepth = 0;
  parent.generations[0]!.launchProfile.mcpServers = ["viewer", "telegram"];
  for (let index = 0; index < 160; index++) {
    const launchId = `root-history-${index}`;
    initial.receipts[launchId] = { ...structuredClone(initial.receipts["archive-launch-0"]!), launchId, key: null,
      conversationId: parent.id, delegationDepth: 0,
      launchProfile: { ...structuredClone(initial.receipts["archive-launch-0"]!.launchProfile), mcpServers: ["viewer", "telegram"] } };
  }
  const metrics = { reads: 0, loads: 0 };
  const reader = open(metrics);
  archiveAll(reader);
  const held = reader.readOnlySnapshot().file;
  expect(held.receipts["root-history-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
  const writer = new Database(filename);
  try {
    writer.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.error','one hot update') WHERE collection='receipts' AND row_key='archive-launch-2'");
  } finally { writer.close(); }
  metrics.reads = metrics.loads = 0;
  const refreshStart = performance.now();
  const fresh = reader.readOnlySnapshot().file;
  expect(fresh.receipts["archive-launch-2"]!.error).toBe("one hot update");
  expect(metrics.reads).toBe(1);
  expect(fresh.receipts["root-history-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
  console.info({ reads: metrics.reads, loads: metrics.loads, refreshMs: performance.now() - refreshStart });
  expect(metrics.loads).toBe(0);
  /* The unrelated archived root was normalized before the commit and its
     version and pinned decision are unchanged, so it is not read again. */
  expect(metrics.reads).toBe(1);
});


function independentColdGrants(count: number) {
  const result = fixture();
  const { initial, conversationId } = result;
  initial.lineageEdges = {};
  for (let index = 0; index < count; index++) {
    const key = conversationId(index + 10);
    const root = structuredClone(initial.conversations[conversationId(0)]!);
    root.id = key;
    root.delegationDepth = 0;
    root.generations[0]!.id = id(index + 10);
    root.generations[0]!.path = `/sessions/${id(index + 10)}.jsonl`;
    root.generations[0]!.launchProfile.mcpServers = ["viewer", "telegram"];
    initial.conversations[key] = root;
    const launchId = `independent-root-${index}`;
    initial.receipts[launchId] = { ...structuredClone(initial.receipts["archive-launch-0"]!), launchId,
      conversationId: key, key: null, artifactPath: root.generations[0]!.path, delegationDepth: 0,
      launchProfile: structuredClone(root.generations[0]!.launchProfile) };
  }
  return result;
}

test("cold grant refresh reads only the changed root's authority dependencies", () => {
  const { open, filename, conversationId } = independentColdGrants(160);
  const metrics = { reads: 0, loads: 0 };
  const reader = open(metrics);
  archiveAll(reader);
  const held = reader.readOnlySnapshot().file;
  const db = new Database(filename);
  try {
    db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.delegationDepth',1) WHERE collection='conversations' AND row_key=?", [conversationId(10)]);
    metrics.reads = metrics.loads = 0;
    const fresh = reader.readOnlySnapshot().file;
    expect(metrics.loads).toBe(0);
    expect(metrics.reads).toBeLessThanOrEqual(6);
    expect(fresh.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(fresh.receipts["independent-root-1"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    expect(held.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.delegationDepth',0) WHERE collection='conversations' AND row_key=?", [conversationId(10)]);
    metrics.reads = 0;
    const restored = reader.readOnlySnapshot().file;
    expect(metrics.reads).toBeLessThanOrEqual(6);
    expect(restored.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    expect(fresh.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer"]);
    for (let index = 0; index < 160; index++) expect(restored.receipts[`independent-root-${index}`]).toBeDefined();
    expect(held.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    expect(fresh.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer"]);
    const cache = reader as unknown as { coldReaderRows: Map<unknown, unknown> };
    expect(cache.coldReaderRows.size).toBeLessThanOrEqual(128);
  } finally { db.close(); }
});

for (const source of ["conversation identity", "independent lineage", "missing named edge"] as const) {
  test(`new ${source} revokes a warmed cold grant and deletion restores it`, () => {
    const { open, filename, initial, conversationId } = independentColdGrants(1);
    if (source === "conversation identity") initial.receipts["independent-root-0"]!.key = { engine: "codex", sessionId: id(10) };
    const reader = open();
    archiveAll(reader);
    const held = reader.readOnlySnapshot().file;
    const db = new Database(filename);
    const collection = source === "conversation identity" ? "conversations" : "lineageEdges";
    const key = source === "missing named edge" ? conversationId(10) : conversationId(1000);
    const value = source === "conversation identity"
      ? { ...structuredClone(initial.conversations[conversationId(10)]!), id: key, delegationDepth: 1 }
      : { ...structuredClone(fixtureEdge(initial)), childConversationId: key, parentConversationId: conversationId(2),
          evidence: { launchId: "independent-root-0" } };
    try {
      db.run("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES (?,?,?,?)", [collection,key,JSON.stringify(value),1000]);
      const revoked = reader.readOnlySnapshot().file;
      expect(revoked.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer"]);
      expect(held.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
      db.run("DELETE FROM registry_rows WHERE collection=? AND row_key=?", [collection,key]);
      expect(reader.readOnlySnapshot().file.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
      expect(revoked.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer"]);
    } finally { db.close(); }
  });
}

function fixtureEdge(initial: ReturnType<typeof fixture>["initial"]) {
  return { childConversationId: Object.keys(initial.conversations)[0]!, parentConversationId: null,
    childSessionKey: null, parentSessionKey: null, childArtifactPath: null, parentArtifactPath: null,
    kind: "spawn" as const, role: null, reviewsConversationId: null, source: "viewer-spawn" as const,
    evidence: {}, createdAt: Object.values(initial.conversations)[0]!.createdAt };
}

test("trimmed journals revoke and restore warmed cold grants on consecutive fallbacks", () => {
  const { open, filename, conversationId } = independentColdGrants(1);
  const reader = open();
  archiveAll(reader);
  const held = reader.readOnlySnapshot().file;
  const db = new Database(filename);
  try {
    for (const depth of [1, 0]) {
      db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.delegationDepth',?) WHERE collection='conversations' AND row_key=?", [depth,conversationId(10)]);
      db.run("DELETE FROM registry_changes");
      db.run("DELETE FROM registry_grant_changes");
      expect(reader.readOnlySnapshot().file.receipts["independent-root-0"]!.launchProfile.mcpServers)
        .toEqual(depth ? ["viewer"] : ["viewer", "telegram"]);
    }
    expect(held.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
  } finally { db.close(); }
});


for (const source of ["parent seat", "admitting receipt"] as const) {
  test(`cold delegated grants track changes to their ${source}`, () => {
    const { open, filename, initial, conversationId } = fixture();
    const parent = initial.conversations[conversationId(2)]!;
    parent.agentRole = "orchestrator";
    parent.delegationDepth = 0;
    parent.generations[0]!.launchProfile.mcpServers = ["viewer", "telegram"];
    const child = initial.conversations[conversationId(0)]!;
    child.agentRole = "builder";
    child.delegationDepth = 1;
    child.generations[0]!.launchProfile.parentConversationId = parent.id;
    child.generations[0]!.launchProfile.mcpServers = ["viewer", "telegram"];
    const receipt = initial.receipts["archive-launch-0"]!;
    receipt.agentRole = "builder";
    receipt.delegationDepth = 1;
    receipt.parentConversationId = parent.id;
    receipt.telegramSeatGrant = true;
    receipt.launchProfile = structuredClone(child.generations[0]!.launchProfile);
    initial.lineageEdges[child.id]!.evidence.telegramSeatGrant = true;
    const reader = open();
    archiveAll(reader);
    const held = reader.readOnlySnapshot().file;
    expect(held.conversations[child.id]!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    const db = new Database(filename);
    try {
      for (const allowed of [false, true]) {
        if (source === "parent seat") {
          db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.agentRole',?) WHERE collection='conversations' AND row_key=?", [allowed ? "orchestrator" : "builder",parent.id]);
        } else {
          db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.telegramSeatGrant',json(?)) WHERE collection='receipts' AND row_key=?", [JSON.stringify(allowed),receipt.launchId]);
        }
        const fresh = reader.readOnlySnapshot().file;
        expect(fresh.conversations[child.id]!.generations[0]!.launchProfile.mcpServers).toEqual(allowed ? ["viewer", "telegram"] : ["viewer"]);
        expect(held.conversations[child.id]!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
      }
    } finally { db.close(); }
  });
}

test("promoted and deleted cold versions release their grant dependency metadata", () => {
  const { open, filename } = independentColdGrants(3);
  const reader = open();
  archiveAll(reader);
  const held = reader.readOnlySnapshot().file;
  const caches = reader as unknown as { coldGrantDecisions: Map<number, unknown>; coldGrantTargets: Map<string, Set<number>> };
  const db = new Database(filename);
  try {
    const oldVersion = db.query<{ archive_id: number }, []>("SELECT archive_id FROM registry_cold WHERE collection='receipts' AND row_key='independent-root-0'").get()!.archive_id;
    expect(caches.coldGrantDecisions.has(oldVersion)).toBe(true);
    db.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.error','promoted') WHERE collection='receipts' AND row_key='independent-root-0'");
    expect(reader.readOnlySnapshot().file.receipts["independent-root-0"]!.error).toBe("promoted");
    expect(caches.coldGrantDecisions.has(oldVersion)).toBe(false);
    expect([...caches.coldGrantTargets.values()].some(targets => targets.has(oldVersion))).toBe(false);
    archiveAll(reader);
    reader.readOnlySnapshot();
    const nextVersion = db.query<{ archive_id: number }, []>("SELECT archive_id FROM registry_cold WHERE collection='receipts' AND row_key='independent-root-0'").get()!.archive_id;
    expect(caches.coldGrantDecisions.has(nextVersion)).toBe(true);
    db.run("DELETE FROM registry_rows WHERE collection='receipts' AND row_key='independent-root-0'");
    expect(reader.readOnlySnapshot().file.receipts["independent-root-0"]).toBeUndefined();
    expect(caches.coldGrantDecisions.has(nextVersion)).toBe(false);
    expect([...caches.coldGrantTargets.values()].some(targets => targets.has(nextVersion))).toBe(false);
    expect(held.receipts["independent-root-0"]!.error).toBeNull();
    expect(held.receipts["independent-root-0"]!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
  } finally { db.close(); }
});


test("first cold snapshot defers collection assembly and keeps an unread generation across external changes", () => {
  const { open, conversationId } = fixture();
  const writer = open();
  archiveAll(writer);
  const reader = open();
  const defineProperty = Object.defineProperty;
  const archivedKeys = new Set([conversationId(0), "archive-launch-0", "archive-delivery-0"]);
  let installed = 0;
  const spy = spyOn(Object, "defineProperty").mockImplementation((target, key, descriptor) => {
    if (archivedKeys.has(String(key))) installed++;
    return defineProperty(target, key, descriptor);
  });
  let held: ReturnType<typeof reader.readOnlySnapshot>["file"];
  try {
    held = reader.readOnlySnapshot().file;
    expect(installed).toBe(0);
  } finally { spy.mockRestore(); }
  const expected = reader.snapshot().file;
  writer.mutate(file => {
    file.receipts["archive-launch-0"]!.state = "path-pending";
    file.heldDeliveries["archive-delivery-0"]!.state = "failed";
    delete file.conversations[conversationId(0)];
  }, false);
  const current = reader.readOnlySnapshot().file;
  expect(current.receipts["archive-launch-0"]!.state).toBe("path-pending");
  expect(current.deliveryOperationOwners["archive-operation-0"]!.terminalState).toBe("failed");
  expect(current.conversations[conversationId(0)]).toBeUndefined();
  // No archived collection of held was read before the writer changed it.
  expect(held!).toEqual(expected);
  expect(Object.keys(held!.receipts)).toEqual(Object.keys(expected.receipts));
  expect(Object.isFrozen(held!)).toBe(true);
  expect(Object.isFrozen(held!.receipts)).toBe(true);
  expect(Object.isFrozen(held!.receipts["archive-launch-0"])).toBe(true);
  expect(Reflect.deleteProperty(held!.receipts, "archive-launch-0")).toBe(false);
});

test("cold collection descriptors retain numeric and prototype-named own keys", () => {
  const { open, initial, filename } = fixture();
  const template = initial.receipts["archive-launch-0"]!;
  for (const launchId of ["42", "7", "constructor", "toString"]) {
    initial.receipts[launchId] = { ...structuredClone(template), launchId, key: null };
  }
  archiveAll(open());
  // A stored legacy key must remain an own accessor even when its name is
  // Object.prototype's setter. Preserve the reader's existing row semantics.
  const db = new Database(filename);
  try {
    const row = db.query<{ value_json: string; row_order: number }, []>(
      "SELECT value_json,row_order FROM registry_rows WHERE collection='receipts' AND row_key='archive-launch-0'").get()!;
    db.run("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('receipts','__proto__',?,?)",
      [JSON.stringify({ ...JSON.parse(row.value_json), launchId: "__proto__" }), row.row_order + 100]);
  } finally { db.close(); }
  archiveAll(open());
  const reader = open();
  const view = reader.readOnlySnapshot().file;
  expect(Object.keys(view.receipts).slice(0, 2)).toEqual(["7", "42"]);
  for (const key of ["42", "7", "constructor", "toString", "__proto__"]) {
    expect(Object.hasOwn(view.receipts, key)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(view.receipts, key)?.get).toBeFunction();
  }
  expect(Object.getPrototypeOf(view.receipts)).toBe(Object.prototype);
});

test("delivery outcome selection reads requested operations under the writer lock without expanding history", async () => {
  const { initial, open, directory, filename, conversationId } = fixture();
  const target = initial.heldDeliveries["archive-delivery-0"]!;
  target.state = "delivery-uncertain";
  target.conversationId = "conversation_old";
  initial.conversationAliases.conversation_old = "conversation_middle";
  initial.conversationAliases.conversation_middle = conversationId(0);
  // A duplicate operation for the same canonical owner retains collection
  // order; another conversation using that key cannot take its outcome.
  initial.heldDeliveries["duplicate"] = { ...structuredClone(target), id: "duplicate" };
  initial.heldDeliveries["different-conversation"] = { ...structuredClone(target), id: "different-conversation", conversationId: conversationId(1) };
  delete initial.deliveryOperationOwners[target.command.operationId];
  for (let index = 0; index < 240; index++) {
    const key = `unrelated-delivery-${index}`;
    initial.heldDeliveries[key] = { ...structuredClone(target), id: key,
      conversationId: conversationId(2), state: "delivered", command: { ...target.command, operationId: `unrelated-operation-${index}` } };
  }
  archiveAll(open());
  let reads = 0;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename: filename,
    onSqliteRowPayloadRead: (_collection, count) => { reads += count; },
  });
  try {
    reads = 0;
    const written = await registry.deliveryWrite({ label: "test-outcome" }, () => registry.recordDeliveryOutcomesForOperations([
      { conversationId: conversationId(0), operationId: target.command.operationId, state: "delivered" },
      { conversationId: "conversation_old", operationId: target.command.operationId, state: "delivered" },
      ...Array.from({ length: 501 }, (_, index) => ({
        conversationId: conversationId(0), operationId: `missing-operation-${index}`, state: "failed" as const,
      })),
    ]));
    expect(reads).toBeLessThan(80);
    expect(written.acquired).toBe(true);
    if (!written.acquired) throw new Error("writer was not acquired");
    expect(written.value.slice(0, 2).map(row => row?.id)).toEqual([target.id, target.id]);
    expect(written.value.slice(2)).toEqual(Array(501).fill(null));
    expect(written.value[0]).toMatchObject({ state: "delivered", text: "" });
    const state = registry.snapshot();
    expect(state.heldDeliveries.duplicate!.state).toBe("delivery-uncertain");
    expect(state.heldDeliveries["different-conversation"]!.state).toBe("delivery-uncertain");
    reads = 0;
    expect(registry.recordDeliveryOutcomesForOperations([])).toEqual([]);
    expect(reads).toBeLessThan(10);
  } finally { registry.close(); }
});

test("fresh mixed cold and synthesized hot operation owners retain every owner", () => {
  const { open,initial,filename } = fixture();
  const hotId = "hot-ownerless-delivery", hotOp = "hot-ownerless-operation";
  initial.heldDeliveries[hotId] = { ...structuredClone(initial.heldDeliveries["archive-delivery-0"]!),
    id: hotId,state: "held",command: { ...initial.heldDeliveries["archive-delivery-0"]!.command,operationId: hotOp } };
  initial.deliveryOperationOwners[hotOp] = { ...structuredClone(initial.deliveryOperationOwners["archive-operation-0"]!),
    deliveryId: hotId,terminalState: null,terminalDisposition: null,
    command: { ...initial.deliveryOperationOwners["archive-operation-0"]!.command,operationId: hotOp } };
  archiveAll(open());
  const db = new Database(filename);
  try {
    db.run("DELETE FROM registry_rows WHERE collection='deliveryOperationOwners' AND row_key=?", [hotOp]);
    expect(db.query("SELECT 1 FROM registry_cold WHERE collection='deliveryOperationOwners'").get()).toBeTruthy();
    expect(db.query("SELECT 1 FROM registry_hot_rows WHERE collection='heldDeliveries' AND row_key=?").get(hotId)).toBeTruthy();
  } finally { db.close(); }
  const reader=open();
  const held=reader.readOnlySnapshot().file;
  const expected=open().snapshot().file;
  expect(expected.deliveryOperationOwners[hotOp]?.deliveryId).toBe(hotId);
  expect(held.deliveryOperationOwners[hotOp]).toEqual(expected.deliveryOperationOwners[hotOp]);
  expect(Object.keys(held.deliveryOperationOwners)).toEqual(Object.keys(expected.deliveryOperationOwners));
});
test("mixed cold legacy commands can still acknowledge their normalized operation", async () => {
  const { open,initial,filename,directory,conversationId } = fixture();
  const legacyId="legacy-command-delivery";
  const template=initial.heldDeliveries["archive-delivery-0"]!;
  initial.heldDeliveries[legacyId] = { ...structuredClone(template),id: legacyId,state:"delivery-uncertain",
    command: { ...template.command,operationId:legacyId } };
  archiveAll(open());
  const db=new Database(filename);
  try { db.run("UPDATE registry_rows SET value_json=json_remove(value_json,'$.command') WHERE collection='heldDeliveries' AND row_key=?", [legacyId]); }
  finally { db.close(); }
  const registry = new AgentRegistry(path.join(directory,"agent-registry.json"),undefined,undefined,{
    sqliteMode:"sqlite",sqliteFilename:filename });
  try {
    const write=await registry.deliveryWrite({label:"review.legacy"},()=>registry.recordDeliveryOutcomesForOperations([
      {conversationId:conversationId(0),operationId:legacyId,state:"delivered"}
    ]));
    expect(write.acquired).toBe(true);
    if(!write.acquired) throw new Error("not acquired");
    expect(write.value[0]?.id).toBe(legacyId);
    expect(write.value[0]?.state).toBe("delivered");
  } finally {registry.close();}
});
