import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { normalizeRegistry, type RegistryFile } from "./registry";
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

function fixture(receiptCount = 257) {
  const root = directory();
  const initial = normalizeRegistry({ version: 2, entries: {}, receipts: {
    template: { launchId: "template", conversationId: "conversation_fixture", engine: "codex",
      cwd: "/registry-fixture", createdAt: "2026-10-01T00:00:00.000Z", state: "starting", error: null,
      launchProfile: emptyLaunchProfile({ cwd: "/registry-fixture", title: "Exercise keyed registry writes", mcpServers: ["viewer"] }) },
  } });
  const receipt = initial.receipts.template!;
  initial.receipts = Object.fromEntries(Array.from({ length: receiptCount }, (_, index) => {
    const launchId = `receipt-${String(index).padStart(4, "0")}`;
    return [launchId, { ...structuredClone(receipt), launchId }];
  }));
  let reads = 0;
  let loads = 0;
  const filename = path.join(root, "registry.sqlite");
  const open = () => {
    const store = new SqliteAgentRegistryStore(filename, {
      initialSnapshot: initial, normalize: normalizeRegistry,
      onSnapshotLoad: () => loads++, onRowPayloadRead: (_collection, count) => { reads += count; },
    });
    stores.push(store);
    return store;
  };
  return { filename, initial, open, reset: () => { reads = loads = 0; }, counts: () => ({ reads, loads }) };
}

test("a mutation returning a snapshot builds the bounded view from the current reader revision", () => {
  const f = fixture();
  const store = f.open();
  store.snapshot();
  f.reset();
  const mutation = store.mutate(file => { file.receipts["receipt-0001"]!.error = "changed"; });
  console.log(JSON.stringify({ operation: "one receipt with snapshot", fixtureRows: 257, payloadRowsRead: f.counts().reads }));
  expect(f.counts().loads).toBe(0);
  expect(mutation.file!.receipts["receipt-0001"]!.error).toBe("changed");
  expect((store as unknown as { writerSnapshotCache: { rowCount: number } | null }).writerSnapshotCache?.rowCount).toBe(257);
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

test("the first writer snapshot stays on the reader path; the second call builds a detached cache", () => {
  const f = fixture();
  const store = f.open();
  const first = store.snapshot();
  expect((store as unknown as { writerSnapshotCache: unknown }).writerSnapshotCache).toBeNull();
  f.reset();
  const second = store.snapshot();
  expect((store as unknown as { writerSnapshotCache: { rowCount: number } | null }).writerSnapshotCache?.rowCount).toBe(257);
  expect(f.counts().loads).toBe(0);
  expect(second.revision).toBe(first.revision);
  f.reset();
  const third = store.snapshot();
  expect(f.counts()).toEqual({ reads: 0, loads: 0 });
  expect(third.revision).toBe(first.revision);
  third.file.receipts["receipt-0001"]!.launchProfile.mcpServers.push("reader-only-change");
  delete third.file.receipts["receipt-0002"];
  third.file.receipts["receipt-appended"] = structuredClone(first.file.receipts["receipt-0001"]!);
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

test("issued snapshots retain unread archived owners after close in both reader modes", async () => {
  for (const prepared of [false, true]) {
    for (const cached of [false, true]) {
      const root = directory();
      const dataset = buildRegistryPerformanceDataset(root, scaledRegistryPerformanceShape(0.02));
      const store = new SqliteAgentRegistryStore(dataset.filename, {
        initialSnapshot: () => { throw new Error("fixture already imported"); }, normalize: normalizeRegistry,
      });
      stores.push(store);
      if (prepared) await store.prepareReadOnlySnapshot();
      if (cached) store.snapshot();
      const held = store.snapshot();
      const operationId = dataset.coldOperationIds[0]!;
      store.close();
      stores.splice(stores.indexOf(store), 1);
      expect(held.file.deliveryOperationOwners[operationId]).toMatchObject({
        command: { operationId }, deliveryId: "performance-delivery-0", terminalState: "delivered",
      });
    }
  }
});

test("the writer cache row bound holds in a fresh process", async () => {
  const f = fixture(8_193);
  f.open().mutate(file => { file.receipts["receipt-0001"]!.error = 'Перевірка 🌌 "quoted"\n'; }, false);
  const childRoot = path.join(path.dirname(f.filename), "child");
  const env = {
    ...process.env,
    HOME: path.join(childRoot, "home"),
    XDG_CONFIG_HOME: path.join(childRoot, "config"),
    LLV_STATE_DIR: path.join(childRoot, "state"),
    TMPDIR: path.join(childRoot, "tmp"),
  };
  for (const pathname of [env.HOME, env.XDG_CONFIG_HOME, env.LLV_STATE_DIR, env.TMPDIR]) {
    fs.mkdirSync(pathname!, { recursive: true });
  }
  const probe = async () => {
    const code = `
      import { normalizeRegistry } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "registry.ts")).href)};
      import { SqliteAgentRegistryStore } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "sqliteRegistryStore.ts")).href)};
      const store = new SqliteAgentRegistryStore(process.argv[1], {
        normalize: normalizeRegistry, initialSnapshot: () => { throw Error("already imported"); },
      });
      store.snapshot();
      const second = store.snapshot();
      console.log(JSON.stringify({ cached: store.writerSnapshotCache !== null,
        rowCount: store.writerSnapshotCache?.rowCount ?? null,
        count: Object.keys(second.file.receipts).length }));
      store.close();
    `;
    const child = Bun.spawn([process.execPath, "-e", code, f.filename], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    return JSON.parse(stdout) as { cached: boolean; rowCount: number | null; count: number };
  };
  expect(await probe()).toEqual({ cached: false, rowCount: null, count: 8_193 });
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

test("a malformed archived owner keeps the legacy synthesized owner in reader snapshots", () => {
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
  const eager = (store as unknown as { loadSnapshot(cache: boolean): { file: RegistryFile } }).loadSnapshot(false).file;
  expect(store.snapshot().file.deliveryOperationOwners[operationId])
    .toEqual(eager.deliveryOperationOwners[operationId]);
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
