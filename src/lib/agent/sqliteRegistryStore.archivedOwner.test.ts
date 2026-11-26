import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { normalizeRegistry, type RegistryFile } from "./registry";
import { registryHotKeysMatching, registryStartupSelectionUnchanged, SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-archived-owner-refresh-"));
  directories.push(root);
  return root;
}

function archivedVersion(filename: string, collection: string, key: string): number | null {
  const db = new Database(filename, { readonly: true });
  try {
    return db.query<{ archive_id: number }, [string, string]>(
      "SELECT archive_id FROM registry_cold WHERE collection=? AND row_key=?",
    ).get(collection, key)?.archive_id ?? null;
  } finally { db.close(); }
}

async function checkRearchivedDeliveryOwner(prepared: boolean) {
  const dataset = buildRegistryPerformanceDataset(directory(), scaledRegistryPerformanceShape(0.02));
  const open = () => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      initialSnapshot: () => { throw new Error("fixture already imported"); }, normalize: normalizeRegistry,
    });
    stores.push(store);
    return store;
  };
  const reader = open();
  const peer = open();
  const operationId = dataset.coldOperationIds[0]!;
  const initialOwner = peer.snapshot().file.deliveryOperationOwners[operationId]!;
  const deliveryId = initialOwner.deliveryId;
  const previousDigest = initialOwner.contentDigest;
  const initialDeliveryVersion = archivedVersion(dataset.filename, "heldDeliveries", deliveryId);
  expect(previousDigest).toBeString();
  expect(typeof initialDeliveryVersion).toBe("number");

  peer.mutate(file => { file.deliveryOperationOwners[operationId]!.contentDigest = null; }, false);
  expect(archivedVersion(dataset.filename, "deliveryOperationOwners", operationId)).toBeNull();
  expect(peer.archiveInactive(10_000)).toBeGreaterThan(0);
  expect(typeof archivedVersion(dataset.filename, "deliveryOperationOwners", operationId)).toBe("number");
  if (prepared) await reader.prepareReadOnlySnapshot();

  const held = reader.snapshot();
  expect(held.file.deliveryOperationOwners[operationId]!.contentDigest).toBe(previousDigest);
  const heldCached = reader.snapshot();
  expect(heldCached.file.deliveryOperationOwners[operationId]!.contentDigest).toBe(previousDigest);

  peer.mutate(file => { file.heldDeliveries[deliveryId]!.contentDigest = "rearchived-delivery-digest"; }, false);
  expect(archivedVersion(dataset.filename, "heldDeliveries", deliveryId)).toBeNull();
  expect(peer.archiveInactive(10_000)).toBeGreaterThan(0);
  const currentDeliveryVersion = archivedVersion(dataset.filename, "heldDeliveries", deliveryId);
  expect(typeof currentDeliveryVersion).toBe("number");
  expect(currentDeliveryVersion).not.toBe(initialDeliveryVersion);

  const current = reader.snapshot();
  const eager = (reader as unknown as { loadSnapshot(cache: boolean): { file: unknown } }).loadSnapshot(false).file;
  expect((eager as RegistryFile).deliveryOperationOwners[operationId]!.contentDigest).toBe("rearchived-delivery-digest");
  expect(current.file.deliveryOperationOwners[operationId]!.contentDigest).toBe("rearchived-delivery-digest");
  expect(JSON.stringify(current.file)).toBe(JSON.stringify(eager));
  expect(held.file.deliveryOperationOwners[operationId]!.contentDigest).toBe(previousDigest);
  expect(heldCached.file.deliveryOperationOwners[operationId]!.contentDigest).toBe(previousDigest);
  expect(held.file.heldDeliveries[deliveryId]!.contentDigest).toBe(previousDigest);
}

async function checkHeldColdSnapshotAfterDatabaseReplacement(prepared: boolean) {
  const dataset = buildRegistryPerformanceDataset(directory(), scaledRegistryPerformanceShape(0.02));
  const store = new SqliteAgentRegistryStore(dataset.filename, {
    initialSnapshot: () => { throw new Error("fixture already imported"); }, normalize: normalizeRegistry,
  });
  stores.push(store);
  if (prepared) await store.prepareReadOnlySnapshot();

  const operationId = dataset.coldOperationIds[0]!;
  const heldFirst = store.snapshot();
  const heldCached = store.snapshot();
  const replacement = `${dataset.filename}.replacement`;
  fs.copyFileSync(dataset.filename, replacement);
  fs.renameSync(replacement, dataset.filename);

  // The snapshot has not read its archived owner yet. Reopening the current
  // store must leave this already-issued mutable view readable and closeable.
  expect(store.snapshot().file.deliveryOperationOwners[operationId]).toBeDefined();
  expect(() => store.close()).not.toThrow();
  expect(heldFirst.file.deliveryOperationOwners[operationId]).toBeDefined();
  expect(heldCached.file.deliveryOperationOwners[operationId]).toBeDefined();
}

test("writer snapshots refresh archived owner defaults after delivery re-archive", async () => {
  await checkRearchivedDeliveryOwner(false);
});

test("prepared reader snapshots refresh archived owner defaults after delivery re-archive", async () => {
  await checkRearchivedDeliveryOwner(true);
});

test("writer snapshots preserve unread archived rows across database replacement", async () => {
  await checkHeldColdSnapshotAfterDatabaseReplacement(false);
});

test("prepared reader snapshots preserve unread archived rows across database replacement", async () => {
  await checkHeldColdSnapshotAfterDatabaseReplacement(true);
});

test("the writer cache retains hot rows and reads archived owners through the merged reader", () => {
  const dataset = buildRegistryPerformanceDataset(directory(), scaledRegistryPerformanceShape(0.02));
  const reads = new Map<string, number>();
  const store = new SqliteAgentRegistryStore(dataset.filename, {
    initialSnapshot: () => { throw new Error("fixture already imported"); },
    normalize: normalizeRegistry,
    onRowPayloadRead: (collection, count) => reads.set(collection, (reads.get(collection) ?? 0) + count),
  });
  stores.push(store);
  const operationId = dataset.coldOperationIds[0]!;
  store.snapshot();
  store.snapshot();
  const cache = (store as unknown as { writerSnapshotCache: { rowCount: number } | null }).writerSnapshotCache;
  expect(cache?.rowCount).toBeGreaterThan(0);
  expect(cache?.rowCount).toBeLessThan(dataset.rows);
  const ownerReads = reads.get("deliveryOperationOwners") ?? 0;
  const deliveryReads = reads.get("heldDeliveries") ?? 0;
  const owner = store.snapshot().file.deliveryOperationOwners[operationId];
  expect(owner).toBeDefined();
  expect(reads.get("deliveryOperationOwners")! - ownerReads).toBe(1);
  expect(reads.get("heldDeliveries")! - deliveryReads).toBeLessThanOrEqual(1);
});

test("a pinned hot selection keeps its archive cut while promotions invalidate startup", async () => {
  const root = directory();
  const filename = path.join(root, "registry.sqlite");
  const host = { kind: "codex-app-server", endpoint: "stdio:released", process: null, eventCursor: 0, activeFlags: [] };
  const entry = (sessionId: string, status: string) => ({
    key: { engine: "codex", sessionId }, artifactPath: `/sessions/${sessionId}.jsonl`, cwd: "/repo",
    accountId: null, status, host: null, structuredHost: host, claimEpoch: 0, claimOwner: null, pendingAction: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  const plain = normalizeRegistry({ version: 2, receipts: {}, entries: {
    "codex:cold": entry("cold", "dead"), "codex:hot": entry("hot", "dead"), "codex:idle": entry("idle", "idle"),
  } });
  const select = (file: RegistryFile) => registryHotKeysMatching(file, "entries", "structuredHost.kind", ["codex-app-server"]);
  expect(select(plain)).toEqual(["codex:cold", "codex:hot", "codex:idle"]);
  const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: plain, normalize: normalizeRegistry });
  stores.push(store);
  expect(store.archiveInactive(1)).toBe(1);
  const held = (await store.prepareReadOnlySnapshot()).file;
  expect(select(held)).toEqual(["codex:hot", "codex:idle"]);
  expect(store.archiveInactive(1)).toBe(1);
  expect(registryStartupSelectionUnchanged(held)).toBe(true);
  expect(select(held)).toEqual(["codex:hot", "codex:idle"]);
  store.mutate(file => { file.entries["codex:cold"]!.updatedAt = "2026-10-02T00:00:00.000Z"; }, false);
  expect(registryStartupSelectionUnchanged(held)).toBe(false);
  expect(select(held)).toEqual(["codex:hot", "codex:idle"]);
  const current = (await store.prepareReadOnlySnapshot()).file;
  expect(select(current)).toEqual(["codex:cold", "codex:idle"]);
  expect(current.entries["codex:hot"]?.artifactPath).toBe("/sessions/hot.jsonl");
});

test("the archive sweep advances after confirmation and opens a new range after journal replacement", async () => {
  const data = buildRegistryPerformanceDataset(directory(), {
    ...scaledRegistryPerformanceShape(0.01),
    conversations: 12, entries: 12, receipts: 0, heldDeliveries: 0, deliveryOperationOwners: 0,
    lineageEdges: 0, memberships: 0, migrationIntents: 0, activeEntries: 0, workers: 0,
    startupCensus: { archived: 10, failedDead: 0, failedUnhosted: 0, closedStaged: 0, live: 0, idle: 2, unhosted: 0 },
  });
  const store = new SqliteAgentRegistryStore(data.filename, {
    initialSnapshot: () => { throw new Error("fixture already imported"); }, normalize: normalizeRegistry,
  });
  stores.push(store);
  const first = store.startupFallbackSweep("journal-a")!;
  expect(first.keys).toHaveLength(10);
  const newer = first.keys[0]!;
  store.mutate(file => { file.entries[newer]!.updatedAt = "2026-10-02T00:00:00.000Z"; }, false);
  expect(store.archiveInactive(1)).toBe(1);
  expect(await store.withWriter(() => store.finishStartupFallbackSweep(first))).toEqual({ acquired: true, value: true });
  const second = store.startupFallbackSweep("journal-a")!;
  expect(second.keys).toEqual([newer]);
  expect(await store.withWriter(() => store.finishStartupFallbackSweep(first))).toEqual({ acquired: true, value: false });
  expect(await store.withWriter(() => store.finishStartupFallbackSweep(second))).toEqual({ acquired: true, value: true });
  expect(store.startupFallbackSweep("journal-a")!.keys).toEqual([]);
  expect(store.startupFallbackSweep("journal-b")!.keys).toHaveLength(10);
});
