import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { heapStats } from "bun:jsc";
import { afterEach, expect, spyOn, test } from "bun:test";

import { normalizeRegistry, type RegistryFile } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { readAttribution } from "@/lib/readAttribution";
import * as sqliteReads from "@/lib/sqliteReadAttribution";

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-generations-"));
  directories.push(directory);
  const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05));
  let completeLoads = 0;
  const open = (counted: boolean) => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("the dataset must already exist"); },
      ...(counted ? { onSnapshotLoad: () => { completeLoads += 1; } } : {}),
    });
    stores.push(store);
    return store;
  };
  const reader = open(true);
  const writer = open(false);
  const judge = open(false);
  const receipt = dataset.grantSubjects.find(subject => subject.collection === "receipts")!.key;
  return { dataset, reader, writer, judge, receipt, completeLoads: () => completeLoads };
}

function accessors(): number {
  Bun.gc(true);
  return (heapStats().objectTypeCounts as Record<string, number>).GetterSetter ?? 0;
}

test("loading a fully hot journal preserves row order without a point read per additional row", () => {
  const { reader, writer, dataset } = fixture();
  const before = reader.readOnlySnapshot().file;
  let lastRead = "", journalRows = 0, journalGets = 0;
  const fresh = new SqliteAgentRegistryStore(dataset.filename, {
    normalize: normalizeRegistry,
    initialSnapshot: () => { throw new Error("the dataset must already exist"); },
    onRowPayloadRead: (collection, count) => {
      if (collection !== "agentStateJournal") return;
      journalRows += count;
      if (lastRead === "registry.get") journalGets += count;
    },
  });
  stores.push(fresh);
  const original = readAttribution.sync;
  readAttribution.sync = (name, work, ...args) => {
    const result = original(name, work, ...args);
    lastRead = name;
    return result;
  };
  try {
    const keys = Array.from({ length: 80 }, (_, index) => `journal-fixture-${79 - index}`);
    writer.mutate(file => {
      for (const [index, id] of keys.entries()) {
        file.agentStateJournal[id] = { version: 1, id, subject: "fixture", at: index, from: null, to: null,
          reason: "fixture", divergence: null, writer: { pid: 42, startIdentity: "fixture", bootEpoch: "fixture" },
          release: "fixture", evidence: [] };
      }
    }, false);
    const after = fresh.readOnlySnapshot().file;
    expect(Object.keys(after.agentStateJournal)).toEqual([...Object.keys(before.agentStateJournal), ...keys]);
    expect(keys.map(key => after.agentStateJournal[key]!.at)).toEqual(keys.map((_, index) => index));
    expect(before.agentStateJournal[keys[0]!]).toBeUndefined();
    expect(journalRows).toBe(Object.keys(after.agentStateJournal).length);
    expect(journalGets).toBe(0);
  } finally { readAttribution.sync = original; }
});

test("a peer write and archival at a page boundary leave the in-flight journal at its starting revision", () => {
  const { dataset, writer, receipt } = fixture();
  const keys = Array.from({ length: 36 }, (_, index) => `page-journal-${index}`);
  writer.mutate(file => {
    for (const [index, id] of keys.entries()) {
      file.agentStateJournal[id] = { version: 1, id, subject: "fixture", at: index, from: null, to: null,
        reason: `before-${index}`, divergence: null, writer: { pid: 42, startIdentity: "fixture", bootEpoch: "fixture" },
        release: "fixture", evidence: [] };
    }
    file.receipts["page-settled"] = { ...file.receipts[receipt]!, launchId: "page-settled", state: "failed", key: null, queuedPinnedSpawn: null };
  }, false);
  const startingRevision = writer.revision();
  let scanned = 0;
  let archived = 0;
  const reader = new SqliteAgentRegistryStore(dataset.filename, {
    normalize: normalizeRegistry,
    initialSnapshot: () => { throw new Error("the dataset must already exist"); },
    onRowPayloadRead(collection, count) {
      if (collection !== "agentStateJournal") return;
      scanned += count;
      if (scanned !== 16) return;
      writer.mutate(file => { file.agentStateJournal[keys[30]!]!.reason = "after-30"; }, false);
      archived = writer.archiveInactive(1);
    },
  });
  stores.push(reader);
  const inFlight = reader.readOnlySnapshot();
  expect(archived).toBe(1);
  using peer = new Database(dataset.filename, { readonly: true });
  expect(peer.query("SELECT row_key FROM registry_cold WHERE collection='receipts' AND row_key='page-settled'").get())
    .toEqual({ row_key: "page-settled" });
  expect(inFlight.file.agentStateJournal[keys[30]!]!.reason).toBe("before-30");
  expect(inFlight.revision).toBe(startingRevision);
  const next = reader.readOnlySnapshot();
  expect(next.revision).toBe(writer.revision());
  expect(next.file.agentStateJournal[keys[30]!]!.reason).toBe("after-30");
});

test("archived receipts with identical claim JSON isolate mutations to their own projection", () => {
  const { reader, dataset } = fixture();
  const db = new Database(dataset.filename, { readonly: true });
  let keys: string[];
  try {
    keys = db.query<{ row_key: string }, []>(`SELECT a.row_key FROM registry_cold c
      JOIN registry_archive a ON a.id = c.archive_id WHERE c.collection = 'receipts'
      AND json_extract(a.value_json, '$.launchProfile.mcpServers') = '["viewer"]'
      ORDER BY a.row_order LIMIT 2`).all().map(row => row.row_key);
  } finally { db.close(); }
  expect(keys).toHaveLength(2);
  const [left, right] = keys as [string, string];
  const held = reader.readOnlySnapshot().file.receipts;
  const mutable = reader.snapshot().file.receipts;
  const expected = ["viewer"];
  expect(mutable[left]!.launchProfile.mcpServers).toEqual(expected);
  expect(mutable[right]!.launchProfile.mcpServers).toEqual(expected);
  mutable[left]!.launchProfile.mcpServers.length = 0;
  expect(mutable[left]!.launchProfile.mcpServers).toEqual([]);
  expect(mutable[right]!.launchProfile.mcpServers).toEqual(expected);
  expect(held[left]!.launchProfile.mcpServers).toEqual(expected);
  const changed = Reflect.set(held[left]!.launchProfile.mcpServers, "length", 0);
  expect(held[right]!.launchProfile.mcpServers).toEqual(expected);
  expect(changed).toBe(false);
});

test("a cold projection page decodes repeated claim text once and keeps each operation's delivery", () => {
  const { reader, dataset } = fixture();
  const parse = spyOn(sqliteReads, "parseSqliteJson");
  const projections = new Map<string, number>();
  let file: RegistryFile;
  try {
    file = reader.readOnlySnapshot().file;
    for (const [json] of parse.mock.calls) {
      if (json.startsWith('{"launchProfile":{"mcpServers":') && json.includes(',"generations":')) {
        projections.set(json, (projections.get(json) ?? 0) + 1);
      }
    }
  } finally { parse.mockRestore(); }
  expect(dataset.coldOperationIds.length).toBeGreaterThanOrEqual(4);
  expect(projections.size).toBeGreaterThan(1);
  for (const count of projections.values()) expect(count).toBeLessThanOrEqual(Math.ceil(dataset.coldRows / 64));
  for (const id of dataset.coldOperationIds.slice(0, 4)) {
    const owner = file.deliveryOperationOwners[id]!;
    expect(file.heldDeliveries[owner.deliveryId]?.command.operationId).toBe(id);
  }
});

test("a preparation after a few commits replays them and assembles no new view of the whole registry", async () => {
  const { dataset, reader, writer, judge, receipt, completeLoads } = fixture();
  const first = (await reader.prepareReadOnlySnapshot()).file;
  const loaded = completeLoads();
  expect(loaded).toBeGreaterThan(0);
  const held: RegistryFile[] = [];
  const before = accessors();
  const rounds = 10;
  for (let round = 1; round <= rounds; round++) {
    writer.mutate((file) => { file.receipts[receipt]!.clientAttemptId = `attempt-${round}`; }, false);
    const prepared = await reader.prepareReadOnlySnapshot();
    expect(prepared.revision).toBe(judge.snapshot().revision);
    held.push(prepared.file);
  }
  // Every held view is a view a caller may still be reading: before the
  // change each one kept its own reader and one accessor per archived row.
  expect(completeLoads()).toBe(loaded);
  expect((accessors() - before) / rounds).toBeLessThan(dataset.coldRows / 2);
  held.forEach((view, index) => {
    expect(view.receipts[receipt]!.clientAttemptId).toBe(`attempt-${index + 1}`);
    expect(Object.keys(view.receipts)).toEqual(Object.keys(first.receipts));
  });
  expect(first.receipts[receipt]!.clientAttemptId).not.toBe("attempt-1");
  expect(held.at(-1)!.receipts[receipt]).toEqual(judge.snapshot().file.receipts[receipt]!);
  expect(reader.readOnlySnapshot().file).toBe(held.at(-1)!);
});

test("preparing a snapshot after a peer write seeks the journal bounds without scanning retained changes", async () => {
  const { dataset, reader, writer, receipt } = fixture();
  const initial = await reader.prepareReadOnlySnapshot();
  writer.mutate(file => { file.receipts[receipt]!.clientAttemptId = "journal-bounds"; }, false);
  const queries = spyOn(Database.prototype, "query");
  let bounds: string[];
  try {
    const next = await reader.prepareReadOnlySnapshot();
    expect(next.file.receipts[receipt]!.clientAttemptId).toBe("journal-bounds");
    expect(initial.file.receipts[receipt]!.clientAttemptId).not.toBe("journal-bounds");
    bounds = queries.mock.calls.map(([sql]) => sql)
      .filter(sql => /FROM registry_changes/i.test(sql) && /(?:MIN|MAX)\(seq\)/i.test(sql));
  } finally { queries.mockRestore(); }
  const db = new Database(dataset.filename, { readonly: true });
  try {
    expect(bounds.length).toBeGreaterThan(0);
    for (const sql of new Set(bounds)) {
      const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all();
      expect(plan.map(row => row.detail).filter(detail => /SCAN registry_changes/i.test(detail))).toEqual([]);
    }
  } finally { db.close(); }
});

test("a preparation after more commits than one step replays takes the cooperative path", async () => {
  const { reader, writer, judge, receipt, completeLoads } = fixture();
  await reader.prepareReadOnlySnapshot();
  const loaded = completeLoads();
  for (let round = 1; round <= 300; round++) {
    writer.mutate((file) => { file.receipts[receipt]!.clientAttemptId = `attempt-${round}`; }, false);
  }
  const prepared = await reader.prepareReadOnlySnapshot();
  expect(completeLoads()).toBe(loaded + 1);
  expect(prepared.file.receipts[receipt]!.clientAttemptId).toBe("attempt-300");
  expect(prepared.revision).toBe(judge.snapshot().revision);
}, 60_000);
