import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runtimeScope } from "@/lib/runtime/contracts";
import { RuntimeJournal, RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS } from "./journal";
import { SessionHostMetadata, SESSION_HOST_ACTIVE_FROM, SESSION_HOST_INACTIVE_FROM, SESSION_HOST_TERMINAL, SESSION_HOST_EXPIRY } from "./journalSessionMetadata";

const count = 24_000;
const now = 2_000_000_000;
const legacy = [
  `SELECT state_json FROM entities WHERE kind = 'session' AND
    (json_extract(state_json, '$.host') IS NULL OR json_extract(state_json, '$.host') NOT IN ('dead', 'unhosted')) ORDER BY id`,
  `SELECT state_json FROM entities WHERE kind = 'session' AND json_extract(state_json, '$.host') IN ('dead', 'unhosted')
    ORDER BY checkpoint_seq DESC, id DESC LIMIT 128`,
  `SELECT id, updated_at AS last_changed_at FROM entities WHERE kind = 'session' AND json_extract(state_json, '$.host') IN ('dead', 'unhosted')`,
];

function medianQuery(db: Database, sql: string) {
  const statement = db.query(sql);
  statement.all();
  const times = Array.from({ length: 5 }, () => {
    const start = performance.now();
    statement.all();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return times[2];
}

test("large legacy journal: indexed selection costs less and preserves every snapshot byte", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-session-metadata-"));
  const filename = path.join(directory, "journal.sqlite");
  const seed = new Database(filename);
  seed.exec(`CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    state_json TEXT NOT NULL, checkpoint_seq INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY(kind, id))`);
  const insert = seed.query("INSERT INTO entities VALUES (?, ?, 1, ?, ?, ?)");
  const padding = "Invented projection text. ".repeat(512);
  seed.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `session-${String(i).padStart(6, "0")}`;
      const host = i % 100 === 0 ? "hosted" : i % 101 === 0 ? null : i % 103 === 0 ? "future-status" : i % 2 ? "dead" : "unhosted";
      insert.run("session", id, JSON.stringify({ conversationId: id, revision: 1, host,
        turn: "idle", liveTurn: { text: padding }, recentReceipts: [],
        voiceDeliveries: [{ deliveryId: `voice-${i}`, responses: [{ responseId: `response-${i}`, text: "Invented voice body" }] }],
      }), Math.floor(i / 2), i % 11 === 0 ? null : i % 3 ? now : 1);
      if (i % 100 === 0) insert.run("edge", `edge-${i}`, JSON.stringify({ childConversationId: id }), i, now);
    }
  })();
  seed.close();
  const journal = new RuntimeJournal(filename, { now: () => now });
  const db = (journal as unknown as { db: Database }).db;
  try {
    const before = [journal.snapshotJson(), journal.snapshotJson([]), journal.snapshotJson(["session-000100"])];
    const beforeMs = legacy.map(sql => medianQuery(db, sql));
    console.log(JSON.stringify({ profile: "session-selection-before", sessions: count, bytes: fs.statSync(filename).size, beforeMs }));
    const migration = (journal as unknown as { sessionHostMetadata?: SessionHostMetadata }).sessionHostMetadata;
    const batchMs: number[] = [];
    if (migration) {
      const step = migration.step.bind(migration);
      migration.step = () => {
        const start = performance.now();
        try { step(); } finally { batchMs.push(performance.now() - start); }
      };
    }
    const migrationStart = performance.now();
    await Bun.sleep(1);
    // Before the fix this is the real inactive query's temporary sort. Keep
    // the regression red on the plan, even when the new schema is absent.
    const hasMetadata = db.query("SELECT name FROM sqlite_master WHERE name = 'session_host_metadata'").get();
    if (!hasMetadata) {
      const plan = db.query(`EXPLAIN QUERY PLAN ${legacy[1]}`).all() as { detail: string }[];
      expect(plan.some(row => row.detail.includes("session_host_inactive_recency"))).toBe(true);
    }
    // The migration yields between bounded transactions; requests remain valid meanwhile.
    for (let attempt = 0; attempt < 20_000; attempt++) {
      if (db.query<{ value: string }, []>("SELECT value FROM journal_meta WHERE key = 'session_host_metadata_ready'").get()?.value === "1") break;
      if (attempt % 100 === 0) expect(journal.snapshotJson()).toBe(before[0]);
      await Bun.sleep(2);
    }
    expect(db.query<{ value: string }, []>("SELECT value FROM journal_meta WHERE key = 'session_host_metadata_ready'").get()?.value).toBe("1");
    console.log(JSON.stringify({ profile: "session-metadata-migration", batches: batchMs.length,
      elapsedMs: performance.now() - migrationStart, maxBatchMs: Math.max(...batchMs) }));
    expect(batchMs.length).toBeGreaterThanOrEqual(Math.ceil(count / 32));
    const captured: string[] = [];
    const query = db.query.bind(db);
    db.query = ((sql: string) => { captured.push(sql); return query(sql); }) as typeof db.query;
    const after = [journal.snapshotJson(), journal.snapshotJson([]), journal.snapshotJson(["session-000100"])];
    db.query = query;
    expect(after).toEqual(before);
    expect(captured.some(sql => sql.includes(SESSION_HOST_ACTIVE_FROM))).toBe(true);
    expect(captured.some(sql => sql.includes(SESSION_HOST_INACTIVE_FROM))).toBe(true);
    expect(captured).toContain(SESSION_HOST_TERMINAL);
    expect(captured).toContain(SESSION_HOST_EXPIRY);
    const expiryPlan = db.query(`EXPLAIN QUERY PLAN ${SESSION_HOST_EXPIRY}`).all(
      RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS, RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS, now,
    ) as { detail: string }[];
    expect(expiryPlan.some(row => /SEARCH session USING COVERING INDEX session_host_activity/.test(row.detail))).toBe(true);
    expect(expiryPlan.some(row => row.detail.includes("SCAN session"))).toBe(false);
    const indexed = [
      `SELECT state_json ${SESSION_HOST_ACTIVE_FROM}`,
      `SELECT state_json ${SESSION_HOST_INACTIVE_FROM.replace("?", "128")}`,
      SESSION_HOST_TERMINAL,
    ];
    const afterMs = indexed.map(sql => medianQuery(db, sql));
    for (let i = 0; i < indexed.length; i++) {
      const plan = db.query(`EXPLAIN QUERY PLAN ${indexed[i]}`).all() as { detail: string }[];
      expect(plan.some(row => row.detail.includes(i === 1 ? "session_host_inactive_recency" : "session_host_activity"))).toBe(true);
      expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
      const oldRows = db.query(legacy[i]).all().map(row => JSON.stringify(row)).sort();
      const newRows = db.query(indexed[i]).all().map(row => JSON.stringify(row)).sort();
      expect(newRows).toEqual(oldRows);
    }
    const oldPlan = db.query(`EXPLAIN QUERY PLAN ${legacy[1]}`).all() as { detail: string }[];
    expect(oldPlan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(true);
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    console.log(JSON.stringify({ profile: "session-selection-comparison", sessions: count, beforeMs, afterMs, ratio: sum(afterMs) / sum(beforeMs) }));
    expect(sum(afterMs)).toBeLessThan(sum(beforeMs) * 0.6);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

function smallLegacy(filename = ":memory:") {
  const db = new Database(filename);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE journal_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO journal_meta VALUES ('schema_version', '1');
    CREATE TABLE entities(kind TEXT, id TEXT, revision INTEGER, state_json TEXT, checkpoint_seq INTEGER, updated_at INTEGER,
      PRIMARY KEY(kind, id));`);
  const put = db.query("INSERT INTO entities VALUES ('session', ?, 1, ?, ?, ?)");
  db.transaction(() => {
    const hosts = [null, "dead", "unhosted", "hosted", "registering", "future-status", 1, {}, undefined];
    for (let i = 0; i < 100; i++) put.run(String(i).padStart(4, "0"), JSON.stringify({ host: hosts[i % hosts.length] }), i, i % 2 ? null : i);
  })();
  return db;
}

function invariant(db: Database) {
  expect(db.query(`SELECT entities.id FROM entities LEFT JOIN session_host_metadata AS metadata ON metadata.id = entities.id
    WHERE kind = 'session' AND (metadata.id IS NULL OR metadata.host IS NOT json_extract(state_json, '$.host')
      OR metadata.inactive != CASE WHEN json_extract(state_json, '$.host') IN ('dead', 'unhosted') THEN 1 ELSE 0 END
      OR metadata.checkpoint_seq IS NOT entities.checkpoint_seq OR metadata.updated_at IS NOT entities.updated_at)`).all()).toEqual([]);
  expect(db.query(`SELECT metadata.id FROM session_host_metadata AS metadata LEFT JOIN entities
    ON entities.kind = 'session' AND entities.id = metadata.id WHERE entities.id IS NULL`).all()).toEqual([]);
}

function finish(migration: SessionHostMetadata) {
  for (let steps = 0; !migration.ready && steps < 100; steps++) migration.step();
  expect(migration.ready).toBe(true);
}

test("migration commits bounded batches, resumes after reopen and rolls back a failed batch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-session-migrate-"));
  const filename = path.join(directory, "journal.sqlite");
  let db = smallLegacy(filename);
  try {
    let migration = new SessionHostMetadata(db);
    migration.step();
    const firstCount = (db.query("SELECT count(*) AS n FROM session_host_metadata").get() as { n: number }).n;
    expect(firstCount).toBeGreaterThan(0);
    expect(firstCount).toBeLessThanOrEqual(32);
    expect(migration.ready).toBe(false);
    const cursor = db.query("SELECT value FROM journal_meta WHERE key = 'session_host_metadata_cursor'").get();
    db.exec(`CREATE TRIGGER interrupt_backfill BEFORE INSERT ON session_host_metadata BEGIN SELECT RAISE(ABORT, 'invented interruption'); END`);
    expect(() => migration.step()).toThrow("invented interruption");
    expect(db.query("SELECT value FROM journal_meta WHERE key = 'session_host_metadata_cursor'").get()).toEqual(cursor);
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    db.exec("DROP TRIGGER interrupt_backfill");
    db.close();
    db = new Database(filename);
    migration = new SessionHostMetadata(db);
    finish(migration);
    invariant(db);
    expect(db.query("SELECT value FROM journal_meta WHERE key = 'session_host_metadata_schema_version'").get()).toEqual({ value: "1" });
    expect(db.query("SELECT value FROM journal_meta WHERE key = 'schema_version'").get()).toEqual({ value: "1" });
    const changes = db.query("SELECT total_changes() AS n").get();
    new SessionHostMetadata(db).step();
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("legacy and current writers maintain scalars atomically, including null, unknown, rename and delete", () => {
  const db = smallLegacy();
  try {
    const migration = new SessionHostMetadata(db);
    migration.step();
    // Writes behind and ahead of the committed cursor while migration is incomplete.
    db.exec(`INSERT INTO entities VALUES ('session', '', 1, '{}', 100, NULL);
      UPDATE entities SET state_json = '{"host":"hosted"}', checkpoint_seq = 101, updated_at = 102 WHERE id IN ('0000', '0099');`);
    finish(migration);
    invariant(db);
    const before = db.query("SELECT * FROM session_host_metadata ORDER BY id").all();
    db.exec("BEGIN");
    db.exec(`UPDATE entities SET state_json = '{"host":"dead"}', checkpoint_seq = 999, updated_at = 998 WHERE id = '0000'`);
    invariant(db);
    db.exec("ROLLBACK");
    expect(db.query("SELECT * FROM session_host_metadata ORDER BY id").all()).toEqual(before);
    // The legacy INSERT column list never mentions the new scalars.
    db.exec(`INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq,updated_at) VALUES ('session','legacy',1,'{"host":"dead"}',1,2)
      ON CONFLICT(kind,id) DO UPDATE SET state_json=excluded.state_json, checkpoint_seq=excluded.checkpoint_seq, updated_at=excluded.updated_at;
      UPDATE entities SET id = 'renamed', state_json = '{"host":null}' WHERE id = 'legacy';
      UPDATE entities SET kind = 'edge' WHERE id = 'renamed';
      DELETE FROM entities WHERE id = '0001';
      INSERT OR REPLACE INTO entities VALUES ('session','0000',2,'{"host":"future"}',5,NULL);`);
    invariant(db);
    expect(db.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  } finally { db.close(); }
});

test("migration never waits for another writer and an existing WAL reader remains usable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-session-lock-"));
  const filename = path.join(directory, "journal.sqlite");
  const db = smallLegacy(filename);
  const peer = new Database(filename);
  try {
    const migration = new SessionHostMetadata(db);
    peer.exec("BEGIN IMMEDIATE");
    expect(() => migration.step()).toThrow();
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'session_host_metadata'").get()).toBeNull();
    peer.exec("ROLLBACK; BEGIN");
    const old = peer.query(legacy[0]).all();
    finish(migration);
    expect(peer.query(legacy[0]).all()).toEqual(old);
    peer.exec("COMMIT");
    peer.exec(`UPDATE entities SET state_json = '{"host":"dead"}' WHERE id = '0000'`);
    invariant(db);
  } finally { peer.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("journal append keeps metadata in its event transaction and expiry preserves the exact boundary", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-session-writer-"));
  let clock = RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS + 100;
  const journal = new RuntimeJournal(path.join(directory, "journal.sqlite"), { now: () => clock });
  const db = (journal as unknown as { db: Database }).db;
  try {
    await Bun.sleep(10);
    for (const host of ["hosted", "dead", "unhosted", "registering"] as const) {
      journal.append({ scope: runtimeScope("session", "child"), kind: "session-status",
        payload: { conversationId: "child", host, turn: "idle" } });
      invariant(db);
    }
    db.exec(`INSERT INTO entities VALUES ('session','expired',1,'{"conversationId":"expired","host":"dead","recentReceipts":[]}',1,100);
      INSERT INTO entities VALUES ('edge','edge',1,'{"childConversationId":"expired"}',1,100)`);
    expect(JSON.parse(journal.snapshotJson()).edges).toHaveLength(1);
    clock++;
    expect(JSON.parse(journal.snapshotJson()).edges).toHaveLength(0);
    invariant(db);
  } finally { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});


test("incomplete metadata batches preserve warm snapshot caches while entity writes invalidate them", () => {
  const journal = new RuntimeJournal(":memory:", { now: () => now });
  const internal = journal as unknown as { db: Database; sessionHostMetadata: SessionHostMetadata; snapshotAt: (...args: unknown[]) => unknown };
  const migration = internal.sessionHostMetadata;
  migration.close();
  try {
    const insert = internal.db.query("INSERT INTO entities VALUES ('session', ?, 1, ?, 1, 1)");
    for (let i = 0; i < 200; i++) insert.run(String(i), JSON.stringify({ conversationId: String(i), host: "dead", recentReceipts: [] }));
    const original = internal.snapshotAt.bind(journal);
    let builds = 0;
    internal.snapshotAt = (...args) => { builds++; return original(...args); };
    journal.snapshotJson();
    journal.snapshotJson([]);
    expect(builds).toBe(2);
    for (let i = 0; i < 3; i++) {
      migration.step();
      expect(migration.ready).toBe(false);
      journal.snapshotJson();
      journal.snapshotJson([]);
      expect(builds).toBe(2);
    }
    internal.db.exec(`UPDATE entities SET state_json = '{"conversationId":"0","host":"hosted","recentReceipts":[]}' WHERE id = '0'`);
    journal.snapshotJson();
    expect(builds).toBe(3);
    finish(migration);
    journal.snapshotJson();
    expect(builds).toBe(4);
  } finally { journal.close(); }
});
