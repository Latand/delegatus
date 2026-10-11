import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { reboundAssembledMcpGrants } from "./mcpAllowlist";
import { normalizeRegistry, type RegistryFile } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { registryRowProjection, SqliteAgentRegistryStore, type RegistryRowProjector } from "./sqliteRegistryStore";

/* A registry whose history is mostly archived (#2761): grant decisions,
   identity lookups and projections must stay keyed, and must agree with the
   whole-file decision they replace. */

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function history() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-registry-history-"));
  directories.push(directory);
  const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05));
  const open = (observed?: { reads: number }) => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("the history registry is imported by its dataset"); },
      onRowPayloadRead: (_collection, count) => { if (observed) observed.reads += count; },
    });
    stores.push(store);
    return store;
  };
  return { dataset, open };
}

type Grantable = "entries" | "receipts" | "conversations";
const lists = (file: RegistryFile, collection: Grantable, key: string) => {
  const row = file[collection][key] as { launchProfile?: { mcpServers?: string[] }; generations?: { launchProfile: { mcpServers: string[] } }[] } | undefined;
  if (!row) return null;
  return collection === "conversations"
    ? row.generations!.map((generation) => [...generation.launchProfile.mcpServers])
    : [[...(row.launchProfile?.mcpServers ?? [])]];
};

/** Every row claiming more than the baseline, by stored JSON. */
function claimingRows(filename: string): Array<{ collection: Grantable; key: string }> {
  const db = new Database(filename, { readonly: true });
  try {
    return db.query<{ collection: Grantable; row_key: string }, []>(`SELECT DISTINCT r.collection, r.row_key FROM registry_records r
      LEFT JOIN json_each(r.value_json, '$.generations') g ON r.collection = 'conversations'
      WHERE (r.collection IN ('entries','receipts') AND json_array_length(r.value_json, '$.launchProfile.mcpServers') > 1)
        OR (r.collection = 'conversations' AND json_array_length(g.value, '$.launchProfile.mcpServers') > 1)
      ORDER BY r.collection, r.row_key`).all().map((row) => ({ collection: row.collection, key: row.row_key }));
  } finally {
    db.close();
  }
}

class Rollback extends Error {}

/** Run an edit inside a mutation and roll it back, keeping what it read. */
function insideRolledBack<T>(store: SqliteAgentRegistryStore, edit: (file: RegistryFile) => T): T {
  let result: T | undefined;
  try {
    store.mutate((file) => { result = edit(file); throw new Rollback(); }, false);
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

/** The whole-file decision over a writable copy, after the same edit. */
function assembled(whole: RegistryFile, edit: (file: RegistryFile) => void): RegistryFile {
  const file = structuredClone(whole);
  edit(file);
  reboundAssembledMcpGrants(file);
  return file;
}

test("a mutation decides a grant over cold history from its attestors alone, as the whole file decides it", () => {
  const { dataset, open } = history();
  const claims = claimingRows(dataset.filename);
  expect(dataset.coldRows / dataset.rows).toBeGreaterThan(0.8);
  expect(claims.length).toBeGreaterThan(50);
  const metrics = { reads: 0 };
  const store = open(metrics);
  const whole = store.snapshot().file;
  for (const { collection, key } of claims) {
    metrics.reads = 0;
    const decided = store.mutate((file) => lists(file, collection, key), false).result;
    expect({ collection, key, decided }).toEqual({ collection, key, decided: lists(whole, collection, key) });
    /* The subject and its attestors, never the history: a whole-file decision
       read every row of the registry here. */
    expect(metrics.reads).toBeLessThan(25);
  }
}, 60_000);

test("a grant-bearing write is decided once and serialized without assembling the registry again", () => {
  const { dataset, open } = history();
  const subject = dataset.grantSubjects.find((candidate) => candidate.collection === "entries")!;
  const metrics = { reads: 0 };
  const store = open(metrics);
  const expected = lists(store.snapshot().file, "entries", subject.key);
  metrics.reads = 0;
  const written = store.mutate((file) => {
    const entry = file.entries[subject.key]!;
    entry.updatedAt = "2026-10-11T21:00:00.000Z";
    entry.launchProfile!.cwd = "/repo/rewritten";
    return lists(file, "entries", subject.key);
  }, false).result;
  expect(written).toEqual(expected);
  expect(metrics.reads).toBeLessThan(25);
  const stored = store.read((file) => file.entries[subject.key]!);
  expect(stored.updatedAt).toBe("2026-10-11T21:00:00.000Z");
  expect(stored.launchProfile?.cwd).toBe("/repo/rewritten");
  expect([stored.launchProfile?.mcpServers]).toEqual(expected!);
});

test("a decision inside a mutation reads the attestors that mutation rewrote", () => {
  const { dataset, open } = history();
  const store = open();
  const whole = store.snapshot().file;
  /* Contradicted, absent and ordinary attestors all occur among the first receipts. */
  const claims = claimingRows(dataset.filename).filter((row) => row.collection === "receipts").slice(0, 16);
  let flipped = 0;
  for (const { key } of claims) {
    const receipt = store.read((file) => file.receipts[key]!);
    const edge = receipt.conversationId;
    /* Removing the child's own lineage edge, or forging a second owner of its
       generation, changes what attests to the receipt. */
    const edits: Array<(file: RegistryFile) => void> = [
      (file) => { delete file.lineageEdges[edge]; },
      (file) => {
        const owner = file.conversations[receipt.conversationId];
        if (!owner) return;
        const forged = JSON.parse(JSON.stringify(owner)) as typeof owner;
        forged.id = "conversation_forged-owner" as typeof forged.id;
        forged.delegationDepth = 0;
        forged.agentRole = "orchestrator";
        file.conversations[forged.id] = forged;
      },
    ];
    for (const edit of edits) {
      const scoped = insideRolledBack(store, (file) => { edit(file); return lists(file, "receipts", key); });
      const decided = lists(assembled(whole, edit), "receipts", key);
      expect({ key, scoped }).toEqual({ key, scoped: decided });
      if (JSON.stringify(decided) !== JSON.stringify(lists(whole, "receipts", key))) flipped += 1;
    }
  }
  /* The edits must actually move some decisions, or the comparison proves nothing. */
  expect(flipped).toBeGreaterThan(0);
}, 60_000);

test("the generation identity index follows every writer and is rebuilt for an older registry", () => {
  const { dataset, open } = history();
  const indexed = (db: Database) => db.query<{ conversation_id: string; entry_key: string | null; path: string | null }, []>(
    "SELECT conversation_id, entry_key, path FROM registry_generation_identities ORDER BY conversation_id, entry_key, path").all();
  const derived = (db: Database) => db.query<{ conversation_id: string; entry_key: string | null; path: string | null }, []>(
    `SELECT r.row_key AS conversation_id, json_extract(r.value_json, '$.engine') || ':' || json_extract(g.value, '$.id') AS entry_key,
      json_extract(g.value, '$.path') AS path FROM registry_rows r, json_each(r.value_json, '$.generations') g
      WHERE r.collection = 'conversations' ORDER BY conversation_id, entry_key, path`).all();
  const store = open();
  const [first, second] = Object.keys(store.snapshot().file.conversations);
  store.mutate((file) => {
    file.conversations[first!]!.generations[0]!.path = "/sessions/rewritten.jsonl";
    delete file.conversations[second!];
  }, false);
  const db = new Database(dataset.filename);
  try {
    expect(indexed(db)).toEqual(derived(db));
    expect(indexed(db).some((row) => row.path === "/sessions/rewritten.jsonl")).toBe(true);
    /* A predecessor release writes registry_rows directly; the triggers are its too. */
    db.run("UPDATE registry_rows SET value_json = json_set(value_json, '$.generations[0].id', 'older-writer') WHERE collection = 'conversations' AND row_key = ?", [first!]);
    expect(indexed(db)).toEqual(derived(db));
    db.exec(`DROP TRIGGER registry_generation_identities_insert; DROP TRIGGER registry_generation_identities_update;
      DROP TRIGGER registry_generation_identities_delete; DROP TABLE registry_generation_identities;
      DELETE FROM registry_meta WHERE key = 'generation_identities_version';`);
  } finally {
    db.close();
  }
  open();
  const reopened = new Database(dataset.filename, { readonly: true });
  try {
    expect(indexed(reopened)).toEqual(derived(reopened));
  } finally {
    reopened.close();
  }
});

test("another connection's archive pass and promotions reach the cold key set without a full reread", () => {
  const { dataset, open } = history();
  const reader = open();
  const writer = open();
  reader.readOnlySnapshot();
  const coldKeys = (store: SqliteAgentRegistryStore) => [...(store as unknown as { coldKeys: Set<string> }).coldKeys].sort();
  const fresh = () => {
    const db = new Database(dataset.filename, { readonly: true });
    try {
      return db.query<{ collection: string; row_key: string }, []>("SELECT collection, row_key FROM registry_cold").all()
        .map((row) => `${row.collection}\u0000${row.row_key}`).sort();
    } finally {
      db.close();
    }
  };
  const cold = fresh()[0]!.split("\u0000");
  writer.mutate((file) => {
    const rows = file[cold[0] as "entries"] as Record<string, { updatedAt?: string }>;
    rows[cold[1]!] = { ...rows[cold[1]!]!, updatedAt: "2026-10-11T21:00:00.000Z" };
  }, false);
  expect(writer.archiveInactive(10_000)).toBeGreaterThan(0);
  const writes = { full: 0 };
  const db = (reader as unknown as { db: { query: (sql: string) => unknown } }).db;
  const query = db.query.bind(db);
  (reader as unknown as { db: unknown }).db = new Proxy(db, {
    get: (target, property) => property === "query"
      ? (sql: string) => { if (sql === "SELECT collection,row_key FROM registry_cold") writes.full += 1; return query(sql); }
      : Reflect.get(target, property),
  });
  reader.readOnlySnapshot();
  expect(coldKeys(reader)).toEqual(fresh());
  expect(writes.full).toBe(0);
});

test("projections over archived history match the rows and are computed once per archived version", () => {
  const { dataset, open } = history();
  const metrics = { reads: 0 };
  const store = open(metrics);
  const projector: RegistryRowProjector<"receipts", { conversationId: string; state: string }> = {
    id: "history-test.receipt-state",
    collection: "receipts",
    project: (receipt) => ({ conversationId: receipt.conversationId, state: receipt.state }),
  };
  const view = store.readOnlySnapshot().file;
  const whole = store.snapshot().file;
  const expected = Object.entries(whole.receipts).map(([key, receipt]) => [key, projector.project(receipt)] as [string, { conversationId: string; state: string }]);
  metrics.reads = 0;
  expect(registryRowProjection(view, projector)).toEqual(expected);
  expect(metrics.reads).toBeGreaterThan(0);
  metrics.reads = 0;
  expect(registryRowProjection(view, projector)).toEqual(expected);
  expect(metrics.reads).toBe(0);
  /* A promoted row is read from its new hot version. */
  const [key] = Object.keys(whole.receipts);
  const writer = open();
  writer.mutate((file) => { file.receipts[key!]!.state = "failed"; }, false);
  const next = registryRowProjection(store.readOnlySnapshot().file, projector);
  expect(Object.fromEntries(next)[key!]).toEqual({ conversationId: whole.receipts[key!]!.conversationId, state: "failed" });
  expect(next).toHaveLength(expected.length);
  expect(() => registryRowProjection(view, {
    id: "history-test.owner", collection: "deliveryOperationOwners", project: (owner) => owner.deliveryId,
  })).toThrow("operation owners");
  void dataset;
});
