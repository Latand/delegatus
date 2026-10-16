import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { normalizeRegistry } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { registryLockHolder } from "./registryLockHolderFixture";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-keyed-writes-"));
  directories.push(root);
  return root;
}

function fixture() {
  const root = directory();
  const initial = normalizeRegistry({ version: 2, entries: {}, receipts: {
    template: { launchId: "template", conversationId: "conversation_fixture", engine: "codex",
      cwd: "/registry-fixture", createdAt: "2026-10-01T00:00:00.000Z", state: "starting", error: null,
      launchProfile: emptyLaunchProfile({ cwd: "/registry-fixture", title: "Exercise keyed registry writes", mcpServers: ["viewer"] }) },
  } });
  const receipt = initial.receipts.template!;
  initial.receipts = Object.fromEntries(Array.from({ length: 257 }, (_, index) => {
    const launchId = `receipt-${String(index).padStart(4, "0")}`;
    return [launchId, { ...structuredClone(receipt), launchId }];
  }));
  let reads = 0;
  let loads = 0;
  const filename = path.join(root, "registry.sqlite");
  const open = (writerSnapshotCacheBytes?: number) => {
    const store = new SqliteAgentRegistryStore(filename, {
      initialSnapshot: initial, normalize: normalizeRegistry,
      writerSnapshotCacheBytes,
      onSnapshotLoad: () => loads++, onRowPayloadRead: (_collection, count) => { reads += count; },
    });
    stores.push(store);
    return store;
  };
  return { filename, initial, open, reset: () => { reads = loads = 0; }, counts: () => ({ reads, loads }) };
}

test("a single-row mutation returning a snapshot avoids reading every unchanged row", () => {
  const f = fixture();
  const store = f.open();
  store.snapshot();
  f.reset();
  const mutation = store.mutate(file => { file.receipts["receipt-0001"]!.error = "changed"; });
  console.log(JSON.stringify({ operation: "one receipt with snapshot", fixtureRows: 257, payloadRowsRead: f.counts().reads }));
  expect(f.counts().reads).toBeLessThanOrEqual(2);
  expect(mutation.file!.receipts["receipt-0001"]!.error).toBe("changed");
});

test("a single grant-bearing row mutation reads its attestors without materializing unrelated rows", () => {
  const root = directory();
  const dataset = buildRegistryPerformanceDataset(root, scaledRegistryPerformanceShape(0.02));
  // Both storage layouts must use the same scoped grant precondition.
  const db = new Database(dataset.filename);
  db.run("DELETE FROM registry_cold");
  db.close();
  let reads = 0;
  const store = new SqliteAgentRegistryStore(dataset.filename, {
    initialSnapshot: () => { throw new Error("fixture already imported"); }, normalize: normalizeRegistry,
    onRowPayloadRead: (_collection, count) => { reads += count; },
  });
  stores.push(store);
  const subject = dataset.grantSubjects.find(row => row.collection === "receipts" && row.servers.includes("telegram"))!;
  expect(subject).toBeDefined();
  reads = 0;
  const result = store.mutate(file => {
    expect(file.receipts[subject.key]!.launchProfile.mcpServers).toEqual(subject.servers);
    file.receipts[subject.key]!.error = "one changed row";
  }, false);
  console.log(JSON.stringify({ operation: "one receipt", fixtureRows: dataset.rows, payloadRowsRead: reads }));
  expect(reads).toBeLessThanOrEqual(32);
  expect(result.file).toBeNull();
  expect(store.snapshot().file.receipts[subject.key]!.error).toBe("one changed row");
});

test("writer snapshots reuse one stored revision and remain detached and mutable", () => {
  const f = fixture();
  const store = f.open();
  const first = store.snapshot();
  f.reset();
  const second = store.snapshot();
  expect(f.counts()).toEqual({ reads: 0, loads: 0 });
  expect(second.revision).toBe(first.revision);
  second.file.receipts["receipt-0001"]!.launchProfile.mcpServers.push("reader-only-change");
  delete second.file.receipts["receipt-0002"];
  second.file.receipts["receipt-appended"] = structuredClone(first.file.receipts["receipt-0001"]!);
  expect(first.file.receipts["receipt-0001"]!.launchProfile.mcpServers).toEqual(["viewer"]);
  expect(store.snapshot().file.receipts["receipt-0002"]).toBeDefined();
  expect(store.snapshot().file.receipts["receipt-appended"]).toBeUndefined();
  expect(structuredClone(first.file)).toEqual(f.initial);
});

test("a replacement writes changed keys, removes missing keys and keeps the requested order", () => {
  const f = fixture();
  const store = f.open();
  const db = new Database(f.filename);
  try {
    db.exec("CREATE TABLE payload_writes(row_key TEXT)");
    db.exec(`CREATE TRIGGER observe_payload_writes AFTER UPDATE OF value_json ON registry_rows
      WHEN NEW.collection='receipts' BEGIN INSERT INTO payload_writes VALUES (NEW.row_key); END`);
    const cursor = db.query<{ seq: number }, []>("SELECT MAX(seq) AS seq FROM registry_changes").get()!.seq;
    store.mutate(file => {
      const next = { ...file.receipts };
      delete next["receipt-0000"];
      next["receipt-0001"] = { ...next["receipt-0001"]!, error: "changed" };
      file.receipts = next;
    }, false);
    const changes = db.query<{ row_key: string }, [number]>(
      "SELECT DISTINCT row_key FROM registry_changes WHERE seq>? AND collection='receipts' ORDER BY row_key",
    ).all(cursor).map(row => row.row_key);
    // Positions may move, but unchanged payloads must never be upserted.
    expect(store.snapshot().file.receipts["receipt-0000"]).toBeUndefined();
    expect(changes).toContain("receipt-0000");
    expect(db.query("SELECT row_key FROM payload_writes").all()).toEqual([{ row_key: "receipt-0001" }]);
    expect(Object.keys(store.snapshot().file.receipts)).toEqual(Object.keys(f.initial.receipts).slice(1));
  } finally { db.close(); }
});

test("writer snapshots follow peer and unversioned writes while held snapshots survive close", () => {
  const f = fixture();
  const store = f.open();
  const peer = f.open();
  const held = store.snapshot();
  peer.mutate(file => { file.receipts["receipt-0001"]!.error = "peer write"; }, false);
  expect(store.snapshot().file.receipts["receipt-0001"]!.error).toBe("peer write");
  const db = new Database(f.filename);
  try {
    db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.error',?) WHERE collection='receipts' AND row_key=?")
      .run("unversioned write", "receipt-0001");
    expect(store.snapshot().file.receipts["receipt-0001"]!.error).toBe("unversioned write");
  } finally { db.close(); }
  store.close();
  stores.splice(stores.indexOf(store), 1);
  expect(held.file.receipts["receipt-0001"]!.error).toBeNull();
});

test("writer snapshot byte admission is enforced again in each fresh process", async () => {
  const f = fixture();
  f.open().mutate(file => { file.receipts["receipt-0001"]!.error = 'Перевірка 🌌 "quoted"\n'; }, false);
  const probe = async (limit: number) => {
    const code = `
      import { normalizeRegistry } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "registry.ts")).href)};
      import { SqliteAgentRegistryStore } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "sqliteRegistryStore.ts")).href)};
      const store = new SqliteAgentRegistryStore(process.argv[1], {
        normalize: normalizeRegistry, initialSnapshot: () => { throw Error("already imported"); },
        writerSnapshotCacheBytes: Number(process.argv[2]),
      });
      const first = store.snapshot();
      console.log(JSON.stringify({ bytes: store.writerSnapshotCache?.bytes ?? null,
        actualBytes: Buffer.byteLength(JSON.stringify(first.file)),
        count: Object.keys(first.file.receipts).length }));
      store.close();
    `;
    const child = Bun.spawn([process.execPath, "-e", code, f.filename, String(limit)], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    return JSON.parse(stdout) as { bytes: number | null; actualBytes: number; count: number };
  };
  const admitted = await probe(2 * 1024 * 1024);
  expect(admitted.bytes).toBeGreaterThan(0);
  expect(admitted.bytes).toBe(admitted.actualBytes);
  expect(await probe(0)).toEqual({ bytes: null, actualBytes: admitted.actualBytes, count: 257 });
  for (let restart = 0; restart < 2; restart++) {
    expect(await probe(admitted.bytes!)).toEqual(admitted);
    expect(await probe(admitted.bytes! - 1)).toEqual({ bytes: null, actualBytes: admitted.actualBytes, count: 257 });
  }
});

test("invalid snapshot byte limits refuse before opening the database", () => {
  const f = fixture();
  for (const limit of [-1, 0.5, NaN, Infinity]) expect(() => f.open(limit)).toThrow("invalid writer snapshot cache byte limit");
});

test("writer snapshot refreshes cold grants and owner defaults from their changed attestors", () => {
  const root = directory();
  const dataset = buildRegistryPerformanceDataset(root, scaledRegistryPerformanceShape(0.02));
  const open = () => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      initialSnapshot: () => { throw new Error("already imported"); }, normalize: normalizeRegistry,
    });
    stores.push(store);
    return store;
  };
  const store = open();
  const peer = open();
  // The original eager path remains the independent normalization oracle.
  const eager = () => (store as unknown as { loadSnapshot(cache: boolean): { file: unknown } }).loadSnapshot(false).file;
  const subject = dataset.grantSubjects.find(row => row.collection === "receipts" && row.servers.includes("telegram"))!;
  const held = store.snapshot().file;
  const receipt = held.receipts[subject.key]!;
  const parent = receipt.parentConversationId!;
  const original = structuredClone(held.conversations[parent]!);
  for (const restore of [false, true]) {
    peer.mutate(file => {
      if (restore) file.conversations[parent] = original;
      else delete file.conversations[parent];
    }, false);
    const current = store.snapshot().file;
    expect(current.receipts[subject.key]!.launchProfile.mcpServers).toEqual(restore ? subject.servers : ["viewer"]);
    expect(JSON.stringify(current)).toBe(JSON.stringify(eager()));
    expect(held.receipts[subject.key]!.launchProfile.mcpServers).toEqual(subject.servers);
  }
  const operationId = dataset.coldOperationIds[0]!;
  const owner = store.snapshot().file.deliveryOperationOwners[operationId]!;
  expect(owner).toBeDefined();
  for (const contentDigest of ["first-digest", "second-digest"]) {
    peer.mutate(file => {
      file.heldDeliveries[owner.deliveryId]!.contentDigest = contentDigest;
      file.deliveryOperationOwners[operationId]!.contentDigest = null;
    }, false);
    expect(store.snapshot().file.deliveryOperationOwners[operationId]!.contentDigest).toBe(contentDigest);
    expect(JSON.stringify(store.snapshot().file)).toBe(JSON.stringify(eager()));
  }
});

test("a malformed archived owner keeps the eager writer's legacy synthesis behavior", () => {
  const root = directory();
  const dataset = buildRegistryPerformanceDataset(root, scaledRegistryPerformanceShape(0.02));
  const operationId = dataset.coldOperationIds[0]!;
  const db = new Database(dataset.filename);
  try {
    const version = db.query(`INSERT INTO registry_archive(collection,row_key,value_json,row_order)
      SELECT collection,row_key,'{}',row_order FROM registry_rows
      WHERE collection='deliveryOperationOwners' AND row_key=?`).run(operationId).lastInsertRowid;
    db.query("UPDATE registry_cold SET archive_id=? WHERE collection='deliveryOperationOwners' AND row_key=?").run(version, operationId);
  } finally { db.close(); }
  const store = new SqliteAgentRegistryStore(dataset.filename, {
    initialSnapshot: () => { throw new Error("already imported"); }, normalize: normalizeRegistry,
  });
  stores.push(store);
  const eager = (store as unknown as { loadSnapshot(cache: boolean): { file: unknown } }).loadSnapshot(false).file;
  expect(JSON.stringify(store.snapshot().file)).toBe(JSON.stringify(eager));
});

test("a rejected mutation and a no-op leave the revision and the cached snapshot intact", () => {
  const f = fixture();
  const store = f.open();
  const first = store.snapshot();
  expect(() => store.mutate(file => {
    file.receipts["receipt-0001"]!.error = "rolled back";
    throw new Error("reject write");
  }, false)).toThrow("reject write");
  store.mutate(file => { file.receipts["receipt-0001"]!.error = null; }, false);
  expect(store.snapshot().revision).toBe(first.revision);
  expect(store.snapshot().file.receipts["receipt-0001"]!.error).toBeNull();
});

test("snapshot reads and the writer admission timer progress beside a peer-held lock", async () => {
  const f = fixture();
  const store = f.open();
  const first = store.snapshot();
  const holder = registryLockHolder(f.filename);
  try {
    await holder.hold();
    const writing = store.withWriter(() => store.mutate(file => { file.receipts["receipt-0001"]!.error = "admitted"; }));
    expect(store.snapshot().revision).toBe(first.revision);
    let timerAdvanced = false;
    await new Promise<void>(resolve => setTimeout(() => { timerAdvanced = true; resolve(); }, 0));
    expect(timerAdvanced).toBeTrue();
    await holder.release();
    const written = await writing;
    expect(written.acquired).toBeTrue();
    expect(store.snapshot().file.receipts["receipt-0001"]!.error).toBe("admitted");
  } finally { await holder.close(); }
});
