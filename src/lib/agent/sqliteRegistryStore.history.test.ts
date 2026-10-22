import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { fullGC } from "bun:jsc";

import { reboundAssembledMcpGrants } from "./mcpAllowlist";
import { normalizeRegistry, readOnlyConversationLookupFromSnapshot, type RegistryFile } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import {
  registryRowsMatching, archivedOwnersEndedSince, hotRegistryRows, registryConversationsForEntryKey, registryConversationsForPath, registryRowProjection,
  SqliteAgentRegistryStore, type RegistryRowProjector,
} from "./sqliteRegistryStore";

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

test("mixed foreign writes release superseded history views while keeping lazy archive reads", async () => {
  const { dataset, open } = history();
  const writer = open();
  const reader = open();
  const conversationKeys = writer.read((file) => Object.keys(file.conversations).slice(-24));
  const deliveryKeys = writer.read((file) => Object.keys(file.heldDeliveries));
  const views: WeakRef<RegistryFile>[] = [];
  const read = () => {
    const file = reader.readOnlySnapshot().file;
    expect(file).not.toBe(views.at(-1)?.deref());
    for (const collection of ["entries", "receipts", "conversations", "heldDeliveries"] as const) Object.keys(file[collection]);
    views.push(new WeakRef(file));
  };
  read();
  for (let index = 0; index < 36; index++) {
    writer.mutate((file) => {
      const subject = dataset.grantSubjects[index % dataset.grantSubjects.length]!;
      const stamp = new Date(Date.UTC(2026, 9, 13) + index * 1000).toISOString();
      if (index % 3 === 0) {
        if (subject.collection === "entries") file.entries[subject.key]!.updatedAt = stamp;
        else file.receipts[subject.key]!.createdAt = stamp;
      } else if (index % 3 === 1) file.conversations[conversationKeys[index % conversationKeys.length]!]!.updatedAt = stamp;
      else file.heldDeliveries[deliveryKeys[index % deliveryKeys.length]!]!.deliveredAt = stamp;
    }, false);
    read();
  }
  // WeakRef targets stay alive until this job ends. Collect in later jobs
  // so the read's stack and job no longer keep a prior view alive.
  await Bun.sleep(0);
  fullGC();
  await Bun.sleep(0);
  fullGC();
  expect(views.filter((view) => view.deref()).length).toBeLessThanOrEqual(2);
}, 30_000);

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

/* The reviewer's reproduction: a files projection holds one view while
   reconciliation on another connection moves a transcript. The path index is
   the database's current one, so the held view lost the conversation it still
   showed at the old path; on the base of this change, which enumerated the
   view, it kept it. */
test("a held view keeps its own path and generation ownership while another connection moves them", () => {
  const { dataset, open } = history();
  const reader = open();
  const writer = open();
  const held = reader.readOnlySnapshot().file;
  /* One conversation of the archived history and one of the newest. */
  const pathOf = (index: number) => dataset.conversationPaths.at(index)!;
  const [moved, taker] = [0, -1].map((index) => readOnlyConversationLookupFromSnapshot(held).conversationForPath(pathOf(index))!);
  const oldPath = pathOf(0);
  expect(moved!.generations[0]!.path).toBe(oldPath);
  expect(taker!.id).not.toBe(moved!.id);
  const oldEntryKey = `${moved!.engine}:${moved!.generations[0]!.id}`;
  expect(readOnlyConversationLookupFromSnapshot(held).conversationForPath(oldPath)?.id).toBe(moved!.id);

  writer.mutate((file) => {
    const generation = file.conversations[moved!.id]!.generations[0]!;
    generation.path = "/sessions/moved.jsonl";
    generation.id = "moved-generation";
  }, false);
  const owners = (file: RegistryFile, pathname: string) => registryConversationsForPath(file, pathname).map((conversation) => conversation.id);
  /* The held view: its own owner at the old path, nothing at the new one. */
  const lookup = readOnlyConversationLookupFromSnapshot(held);
  expect(lookup.conversationForPath(oldPath)?.id).toBe(moved!.id);
  expect(lookup.conversationForPath("/sessions/moved.jsonl")).toBeNull();
  expect(owners(held, oldPath)).toEqual([moved!.id]);
  expect(registryConversationsForEntryKey(held, oldEntryKey).map((conversation) => conversation.id)).toEqual([moved!.id]);
  expect(registryConversationsForEntryKey(held, `${moved!.engine}:moved-generation`)).toEqual([]);

  /* Reassigned to another owner: the held view still names its own. */
  writer.mutate((file) => { file.conversations[taker!.id]!.continuityPaths.push(oldPath); }, false);
  expect(readOnlyConversationLookupFromSnapshot(held).conversationForPath(oldPath)?.id).toBe(moved!.id);
  expect(owners(held, oldPath)).toEqual([moved!.id]);

  /* A fresh view sees what was committed. */
  const fresh = reader.readOnlySnapshot().file;
  const freshLookup = readOnlyConversationLookupFromSnapshot(fresh);
  expect(freshLookup.conversationForPath(oldPath)?.id).toBe(taker!.id);
  expect(freshLookup.conversationForPath("/sessions/moved.jsonl")?.id).toBe(moved!.id);
  expect(registryConversationsForEntryKey(fresh, oldEntryKey)).toEqual([]);
  /* An untouched path is answered from the index by both. */
  const untouched = owners(fresh, pathOf(2));
  expect(untouched).toHaveLength(1);
  expect(owners(held, pathOf(2))).toEqual(untouched);

  /* A journal that no longer reaches back to the held view: it answers from its own rows. */
  const db = new Database(dataset.filename);
  try { db.run("DELETE FROM registry_changes"); } finally { db.close(); }
  expect(owners(held, oldPath)).toEqual([moved!.id]);
  expect(owners(held, "/sessions/moved.jsonl")).toEqual([]);
}, 60_000);

/* #2761: a view refreshed after another connection's commit decided every
   grant-bearing hot row again whenever a conversation, a receipt or a lineage
   edge had changed, related or not. It now decides the rows the change can
   reach, and must still agree with a whole read after every kind of write:
   a revoked edge, a contradicting owner and an owner that is gone included. */
test("a view refreshed across mixed entry, receipt, conversation and lineage writes decides grants as a whole read does", () => {
  const { dataset, open } = history();
  const reader = open();
  const writer = open();
  const judge = open();
  let decisions = 0;
  const spied = reader as unknown as { decideStoredRow: (...args: unknown[]) => unknown };
  const decide = spied.decideStoredRow.bind(reader);
  spied.decideStoredRow = (...args) => { decisions += 1; return decide(...args); };
  const claims = claimingRows(dataset.filename);
  const initial = new Map(claims.map(({ collection, key }) => [`${collection} ${key}`, JSON.stringify(lists(judge.snapshot().file, collection, key))]));
  reader.readOnlySnapshot();
  let flipped = 0;
  const agree = (step: string) => {
    decisions = 0;
    const view = reader.readOnlySnapshot().file;
    const refreshed = decisions;
    const whole = judge.snapshot().file;
    /* The refreshed collections hold the rows of a whole read, in its order, and stay frozen. */
    for (const collection of ["entries", "receipts", "conversations", "lineageEdges"] as const) {
      expect({ step, collection, keys: Object.keys(view[collection]) }).toEqual({ step, collection, keys: Object.keys(whole[collection]) });
      expect(Object.isFrozen(view[collection])).toBe(true);
    }
    for (const { collection, key } of claims) {
      const decided = lists(whole, collection, key);
      expect({ step, collection, key, view: lists(view, collection, key) }).toEqual({ step, collection, key, view: decided });
      if (JSON.stringify(decided) !== initial.get(`${collection} ${key}`)) flipped += 1;
    }
    return refreshed;
  };
  const hot = dataset.grantSubjects;
  const entry = hot.find((subject) => subject.collection === "entries")!;
  const receipts = hot.filter((subject) => subject.collection === "receipts");
  expect(receipts.length).toBeGreaterThan(8);
  const conversationOf = (key: string) => judge.snapshot().file.receipts[key]!.conversationId;

  const before = reader.readOnlySnapshot().file;
  const stamped = before.entries[entry.key]!.updatedAt;
  writer.mutate((file) => { file.entries[entry.key]!.updatedAt = "2026-10-12T21:00:00.000Z"; }, false);
  expect(agree("an entry write")).toBeLessThanOrEqual(2);
  /* The view held from before the write keeps its own row; the refreshed one has the new. */
  expect(before.entries[entry.key]!.updatedAt).toBe(stamped);
  expect(reader.readOnlySnapshot().file.entries[entry.key]!.updatedAt).toBe("2026-10-12T21:00:00.000Z");
  expect(Object.keys(before.entries)).toEqual(Object.keys(reader.readOnlySnapshot().file.entries));
  /* An unrelated receipt or conversation write reaches the rows that read it, never every hot row. */
  writer.mutate((file) => { file.receipts[receipts[0]!.key]!.clientAttemptId = "restamped-attempt"; }, false);
  expect(agree("a receipt write")).toBeLessThanOrEqual(6);
  writer.mutate((file) => { file.conversations[conversationOf(receipts[1]!.key)]!.updatedAt = "2026-10-12T21:00:02.000Z"; }, false);
  expect(agree("a conversation write")).toBeLessThanOrEqual(6);

  for (const [index, subject] of receipts.slice(0, 8).entries()) {
    const owner = conversationOf(subject.key);
    /* Revoked: the child's own lineage edge is gone. */
    writer.mutate((file) => { delete file.lineageEdges[owner]; }, false);
    agree(`edge ${index} removed`);
    /* Contradicted: a second owner of the same generation appears, then leaves. */
    writer.mutate((file) => {
      const forged = JSON.parse(JSON.stringify(file.conversations[owner]!)) as RegistryFile["conversations"][string];
      forged.id = `conversation_forged-owner-${index}` as typeof forged.id;
      forged.delegationDepth = 0;
      forged.agentRole = "orchestrator";
      file.conversations[forged.id] = forged;
    }, false);
    agree(`owner ${index} forged`);
    writer.mutate((file) => { delete file.conversations[`conversation_forged-owner-${index}` as typeof owner]; }, false);
    agree(`forged owner ${index} removed`);
    /* Absent: the attesting conversation itself is gone. */
    writer.mutate((file) => { delete file.conversations[owner]; }, false);
    agree(`owner ${index} removed`);
  }
  /* The writes must actually move some decisions, or the agreement proves nothing. */
  expect(flipped).toBeGreaterThan(0);
}, 180_000);

/* #2761: the settlement sweep looks for owners that ended since its last
   checkpoint. Enumerating the collection read and normalized every archived
   owner on each sweep, 0.3 s of the serving release's thread over retained
   history; the archive names the candidates from the instant each stores. */
test("recent endings among archived operation owners are named without reading the archive", async () => {
  const { dataset, open } = history();
  const db = new Database(dataset.filename);
  const archived = db.query<{ id: number; row_key: string; settled: string }, []>(`SELECT a.id, c.row_key, json_extract(a.value_json, '$.settledAt') AS settled
    FROM registry_cold c JOIN registry_archive a ON a.id = c.archive_id WHERE c.collection = 'deliveryOperationOwners' ORDER BY settled`).all();
  expect(archived.length).toBeGreaterThan(100);
  /* One owner stored without its instant: it takes its delivery's, as normalization does. */
  const [legacy, silent] = archived;
  const deliveredAt = archived.at(-1)!.settled;
  /* A version is immutable: each row below is archived again as a new one. */
  const rearchive = (collection: string, key: string, edit: string, ...values: string[]) => {
    const version = db.query<{ id: number }, string[]>(`INSERT INTO registry_archive(collection, row_key, value_json, row_order)
      SELECT a.collection, a.row_key, ${edit}, a.row_order FROM registry_cold c JOIN registry_archive a ON a.id = c.archive_id
      WHERE c.collection = ? AND c.row_key = ? RETURNING id`).get(...values, collection, key)!;
    db.run("UPDATE registry_cold SET archive_id = ? WHERE collection = ? AND row_key = ?", [version.id, collection, key]);
  };
  try {
    for (const owner of [legacy!, silent!]) rearchive("deliveryOperationOwners", owner.row_key, "json_remove(a.value_json, '$.settledAt')");
    const delivery = db.query<{ id: string }, [number]>("SELECT json_extract(value_json, '$.deliveryId') AS id FROM registry_archive WHERE id = ?").get(legacy!.id)!;
    rearchive("heldDeliveries", delivery.id, "json_set(a.value_json, '$.deliveredAt', ?)", deliveredAt);
  } finally {
    db.close();
  }
  const metrics = { reads: 0 };
  const selectedStore = open(metrics);
  await selectedStore.prepareReadOnlySnapshot();
  const view = selectedStore.readOnlySnapshot().file;
  const whole = open().snapshot().file;
  const ended = (since: string) => Object.entries(whole.deliveryOperationOwners)
    .filter(([, owner]) => owner.terminalState !== null && (owner.settledAt ?? "") >= since).map(([key]) => key).sort();
  const hot = new Set(hotRegistryRows(view, "deliveryOperationOwners").map(([key]) => key));
  expect(whole.deliveryOperationOwners[legacy!.row_key]!.settledAt).toBe(deliveredAt);
  expect(whole.deliveryOperationOwners[silent!.row_key]!.settledAt).toBeNull();
  for (const since of [archived[Math.floor(archived.length / 2)]!.settled, archived.at(-3)!.settled, deliveredAt, "2099-01-01T00:00:00.000Z"]) {
    metrics.reads = 0;
    const named = archivedOwnersEndedSince(view, since)!;
    expect(metrics.reads).toBe(0);
    expect({ since, named: [...named].sort() }).toEqual({ since, named: ended(since).filter((key) => !hot.has(key)) });
  }
  expect(archivedOwnersEndedSince(view, deliveredAt)).toContain(legacy!.row_key);
  expect(archivedOwnersEndedSince(view, "1970-01-01T00:00:00.000Z")).not.toContain(silent!.row_key);
  /* A plain file has no archive to ask: its caller reads the rows. */
  expect(archivedOwnersEndedSince(whole, deliveredAt)).toBeUndefined();
});

/* #2761: Next standalone gives the instrumentation and each route bundle its
   own copy of the store's module, over one process-wide store. A file's
   indexed readers were kept by the copy that built it, so a route asking
   through another copy enumerated the collection, archived history included,
   on every lookup. A second copy of the module must find the same readers. */
test("another bundle's copy of the store module reads a view through its indexes", async () => {
  const { dataset, open } = history();
  const metrics = { reads: 0 };
  const view = open(metrics).readOnlySnapshot().file;
  const copy = await import(`./sqliteRegistryStore.ts?bundle=${"route"}`) as typeof import("./sqliteRegistryStore");
  expect(copy.registryConversationsForPath).not.toBe(registryConversationsForPath);
  const pathname = dataset.conversationPaths[0]!;
  const owner = registryConversationsForPath(view, pathname)[0]!;
  const entryKey = `${owner.engine}:${owner.generations[0]!.id}`;
  metrics.reads = 0;
  expect(copy.registryHasPathIndex(view)).toBe(true);
  expect(copy.registryHasEntryKeyIndex(view)).toBe(true);
  expect(copy.registryConversationsForPath(view, pathname).map((conversation) => conversation.id)).toEqual([owner.id]);
  expect(copy.registryConversationsForEntryKey(view, entryKey).map((conversation) => conversation.id)).toEqual([owner.id]);
  expect(copy.registryKeysMatching(view, "heldDeliveries", "conversationId", owner.id))
    .toEqual(Object.keys(view.heldDeliveries).filter((key) => view.heldDeliveries[key]!.conversationId === owner.id));
  expect(copy.hotRegistryRows(view, "entries").length).toBeLessThan(Object.keys(view.entries).length);
  expect(copy.archivedOwnersEndedSince(view, "2099-01-01T00:00:00.000Z")).toEqual([]);
  const projector: RegistryRowProjector<"receipts", string> = { id: "history-test.bundle-copy", collection: "receipts", project: (receipt) => receipt.state };
  expect(copy.registryRowProjection(view, projector)).toEqual(registryRowProjection(view, projector));
});


test("receipt replacement lookups agree across archive, peer replacement and transactional deletion", () => {
  const { open } = history();
  const writer = open();
  const reader = open();
  const digest = "9".repeat(64);
  const key = writer.read(file => Object.keys(file.receipts)[0]!);
  writer.mutate(file => { file.receipts[key]!.requestDigest = digest; }, false);
  writer.archiveInactive();
  const select = () => reader.read(file => registryRowsMatching(file, "receipts", "requestDigest", digest).map(row => row.launchId));
  expect(select()).toEqual([key]);
  writer.mutate(file => { file.receipts[key]!.requestDigest = "8".repeat(64); }, false);
  expect(select()).toEqual([]);
  writer.mutate(file => { file.receipts[key]!.requestDigest = digest; }, false);
  writer.archiveInactive();
  expect(select()).toEqual([key]);
  writer.mutate(file => {
    delete file.receipts[key];
    expect(registryRowsMatching(file, "receipts", "requestDigest", digest)).toEqual([]);
  }, false);
  expect(select()).toEqual([]);
});


test("archived endings page by normalized instant without fetching old owner payloads", async () => {
  const { dataset, open } = history();
  const store = open();
  await store.prepareReadOnlySnapshot();
  const view = store.readOnlySnapshot().file;
  const since = "1970-01-01T00:00:00.000Z";
  const all = archivedOwnersEndedSince(view, since)!;
  expect(all.length).toBeGreaterThan(32);
  const page = archivedOwnersEndedSince(view, since, { limit: 16 })!;
  expect(page.length).toBe(16);
  const next = archivedOwnersEndedSince(view, since, { limit: 16, after: page.at(-1)! })!;
  expect(next.length).toBe(16);
  expect(new Set([...page, ...next]).size).toBe(32);
  const db = new Database(dataset.filename, { readonly: true });
  try {
    const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT operation_id FROM registry_owner_endings
      WHERE ending_ms >= 0 ORDER BY ending_ms, operation_id LIMIT 16`).all().map(row => row.detail).join(" ");
    expect(plan).toContain("SEARCH");
    expect(plan).toContain("ending_ms>?");
    expect(plan).not.toContain("TEMP B-TREE");
  } finally { db.close(); }
});


test("ending projection preserves offset and legacy timestamps through archive replacement", async () => {
  const { dataset, open } = history();
  const store = open();
  await store.prepareReadOnlySnapshot();
  const db = new Database(dataset.filename);
  const keys = db.query<{ row_key: string }, []>("SELECT row_key FROM registry_cold WHERE collection='deliveryOperationOwners' ORDER BY row_key LIMIT 3").all();
  try {
    for (const [index, stamp] of ["2026-10-22T01:00:00+02:00", "Thu, 22 Oct 2026 00:00:00 GMT", "2026-10-22T00:00:00.000Z"].entries()) {
      const key = keys[index]!.row_key;
      const version = db.query<{ id: number }, [string, string]>(`INSERT INTO registry_archive(collection,row_key,value_json,row_order)
        SELECT a.collection,a.row_key,json_set(a.value_json,'$.settledAt',?),a.row_order
        FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id
        WHERE c.collection='deliveryOperationOwners' AND c.row_key=? RETURNING id`).get(stamp, key)!;
      db.query("UPDATE registry_cold SET archive_id=? WHERE collection='deliveryOperationOwners' AND row_key=?").run(version.id, key);
    }
    await store.prepareReadOnlySnapshot();
    const file = store.readOnlySnapshot().file;
    const named = archivedOwnersEndedSince(file, "2026-10-22T00:00:00.000Z")!;
    expect(named).not.toContain(keys[0]!.row_key);
    expect(named).toContain(keys[1]!.row_key);
    expect(named).toContain(keys[2]!.row_key);
    const page = archivedOwnersEndedSince(file, "2026-10-22T00:00:00.000Z", { limit: 1 })!;
    const next = archivedOwnersEndedSince(file, "2026-10-22T00:00:00.000Z", { limit: 1, after: page[0] })!;
    expect(new Set([...page, ...next]).size).toBe(2);
  } finally { db.close(); }
});


test("ending preparation resumes a committed partial cursor in a fresh process", async () => {
  const { dataset } = history();
  const db = new Database(dataset.filename);
  try {
    db.run("DELETE FROM registry_owner_endings");
    db.run("DELETE FROM registry_meta WHERE key='owner_endings_cursor'");
  } finally { db.close(); }
  const launch = async (finish: boolean) => {
    const code = `import { Database } from "bun:sqlite";
      import { prepareRegistryEndingsBatch } from "./src/lib/agent/registryEndings";
      import { SqliteAgentRegistryStore } from "./src/lib/agent/sqliteRegistryStore";
      import { normalizeRegistry } from "./src/lib/agent/registry";
      const filename=${JSON.stringify(dataset.filename)};
      if (${finish}) {
        const store=new SqliteAgentRegistryStore(filename,{normalize:normalizeRegistry,initialSnapshot:()=>{throw Error("unexpected import")}});
        await store.prepareReadOnlySnapshot(); store.close();
      } else {
        const db=new Database(filename); db.transaction(()=>prepareRegistryEndingsBatch(db,16))(); db.close();
      }`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_STATE_OWNER: undefined } });
    const watchdog = setTimeout(() => child.kill(), 30_000);
    try {
      const output = await new Response(child.stderr).text();
      expect({ exit: await child.exited, error: output }).toEqual({ exit: 0, error: "" });
    } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill(); await child.exited; } }
  };
  await launch(false);
  const partial = new Database(dataset.filename, { readonly: true });
  try {
    expect(partial.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM registry_owner_endings").get()!.n).toBe(16);
    expect(partial.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key='owner_endings_cursor'").get()!.value).not.toBe("complete");
  } finally { partial.close(); }
  await launch(true);
  const complete = new Database(dataset.filename, { readonly: true });
  try {
    expect(complete.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM registry_owner_endings").get()!.n)
      .toBe(complete.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM registry_rows WHERE collection='deliveryOperationOwners'").get()!.n);
    expect(complete.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key='owner_endings_cursor'").get()!.value).toBe("complete");
  } finally { complete.close(); }
});
