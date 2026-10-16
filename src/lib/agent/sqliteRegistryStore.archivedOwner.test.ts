import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { normalizeRegistry, type RegistryFile } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

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

test("writer snapshots refresh archived owner defaults after delivery re-archive", async () => {
  await checkRearchivedDeliveryOwner(false);
});

test("prepared reader snapshots refresh archived owner defaults after delivery re-archive", async () => {
  await checkRearchivedDeliveryOwner(true);
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
