import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";

import { AgentRegistry, normalizeRegistry, type RegistryFile } from "./registry";
import { registryRowsMatching, SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import { performanceSites, performanceSpans } from "@/lib/performanceSpans";

/* The shared read-only registry view (viewer-hot-path-clones): every reader of
   `readOnlySnapshot` holds the same objects, so none may change them, and every
   write must reach the next read. Each case owns a mkdtemp directory. */

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-readonly-view-"));
  directories.push(directory);
  const seed = new AgentRegistry(path.join(directory, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = seed.ensureConversation("codex", "/sessions/readonly-view.jsonl", "default");
  const delivery = seed.holdDelivery(conversation.id, "held for the view", "readonly-view");
  const kept = seed.beginSpawn("codex", "/repo/kept", { title: "Kept receipt" });
  const removed = seed.beginSpawn("codex", "/repo/removed", { title: "Removed receipt" });
  const initial = seed.snapshot();
  seed.close();
  const filename = path.join(directory, "agent-registry.sqlite");
  const open = () => {
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry });
    stores.push(store);
    return store;
  };
  return { filename, open, conversation, delivery, kept: kept.launchId, removed: removed.launchId };
}

function attempt(write: () => void): boolean {
  try {
    write();
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return false;
  }
}

test("cooperative preparation publishes one complete frozen view and follows peer writes", async () => {
  const { open, filename, kept, delivery } = fixture();
  const store = open();
  const peer = open();
  const preparation = store.prepareReadOnlySnapshot();
  const concurrent = store.prepareReadOnlySnapshot();
  const prepared = await preparation;
  expect((await concurrent).file).toBe(prepared.file);
  expect(prepared.file).toEqual(peer.readOnlySnapshot().file);
  expect(store.readOnlySnapshot().file).toBe(prepared.file);
  expect(Object.isFrozen(prepared.file.receipts[kept])).toBe(true);
  expect(Object.isFrozen(prepared.file.heldDeliveries[delivery.id]?.command)).toBe(true);
  peer.mutate(file => { file.receipts[kept]!.error = "peer changed after preparation"; }, false);
  expect(store.readOnlySnapshot().file.receipts[kept]?.error).toBe("peer changed after preparation");
  expect(prepared.file.receipts[kept]?.error).toBeNull();
  const db = new Database(filename, { readonly: true });
  try {
    expect(db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN
      ('registry_lookup_requestDigest','registry_lookup_supersedes_conversationId','registry_archive_request_digest','registry_archive_supersedes',
       'registry_lookup_structuredHost_kind','registry_archive_structured_host_kind')`).get()?.count).toBe(6);
  } finally { db.close(); }
});

test("a prepared reader cooperatively rebuilds its view after a peer archives a row", async () => {
  const { open, kept } = fixture();
  const reader = open();
  const writer = open();
  const initial = await reader.prepareReadOnlySnapshot();
  const template = initial.file.receipts[kept]!;
  // Four header batches exercise the same cancellation, ordering and yield
  // contract without making synchronous fixture seeding dominate the test.
  writer.mutate(file => {
    for (let index = 0; index < 512; index++) {
      const id = `archived-receipt-${index}`;
      file.receipts[id] = { ...template, launchId: id, state: "failed", error: "archived history", createdAt: "2020-01-01T00:00:00Z" };
    }
  }, false);
  expect(writer.archiveInactive(1)).toBe(1);
  const controller = new AbortController();
  const canceled = reader.prepareReadOnlySnapshot(controller.signal);
  setImmediate(() => controller.abort(new Error("retired warm refresh")));
  await expect(canceled).rejects.toThrow("retired warm refresh");
  for (let pass = 0; pass < 3; pass++) {
    expect(writer.archiveInactive(1)).toBe(1);
    const syncSnapshot = spyOn(SqliteAgentRegistryStore.prototype, "readOnlySnapshot");
    let yielded = false;
    const turn = new Promise<boolean>(resolve => setImmediate(() => { yielded = true; resolve(true); }));
    const started = performance.now();
    const refreshed = reader.prepareReadOnlySnapshot();
    let snapshot!: Awaited<typeof refreshed>;
    try {
      expect(await Promise.race([refreshed.then(() => false), turn])).toBe(true);
      expect(yielded).toBe(true);
      snapshot = await refreshed;
      expect(syncSnapshot).not.toHaveBeenCalled();
    } finally { syncSnapshot.mockRestore(); }
    const preparationSlices = performanceSpans.snapshot(started).records.filter(record =>
      record.kind === "sync" && ["registry.prepare.slice", "registry.headers"].includes(performanceSites[record.site]!));
    expect(preparationSlices.length).toBeGreaterThan(1);
    expect(Object.keys(snapshot.file.receipts).filter(id => id.startsWith("archived-receipt-"))).toHaveLength(512);
    expect(Object.keys(snapshot.file.receipts).filter(id => id.startsWith("archived-receipt-")))
      .toEqual(Array.from({ length: 512 }, (_, index) => `archived-receipt-${index}`));
  }
  const snapshot = await reader.prepareReadOnlySnapshot();
  expect(Object.keys(snapshot.file.receipts)).toContain("archived-receipt-0");
  expect(snapshot.file.receipts["archived-receipt-0"]?.state).toBe("failed");
}, 30_000);

test("held prepared views keep lazy archived payloads and indexes alive across repeated refreshes", async () => {
  const { open, kept } = fixture();
  const reader = open();
  const writer = open();
  const seeded = reader.readOnlySnapshot().file.receipts[kept]!;
  writer.mutate(file => {
    for (let index = 0; index < 4; index++) {
      const id = `held-archive-${index}`;
      file.receipts[id] = { ...seeded, launchId: id, state: "failed", error: `original-${index}`, createdAt: "2020-01-01T00:00:00Z" };
    }
  }, false);
  expect(writer.archiveInactive(2)).toBe(2);
  const held = await reader.prepareReadOnlySnapshot();

  for (let index = 0; index < 3; index++) {
    writer.mutate(file => { file.receipts[kept]!.error = `peer-${index}`; }, false);
    await reader.prepareReadOnlySnapshot();
  }

  expect(held.file.receipts["held-archive-0"]?.error).toBe("original-0");
  expect(registryRowsMatching(held.file, "receipts", "launchId", "held-archive-0").map(row => row.error))
    .toEqual(["original-0"]);
  expect((await reader.prepareReadOnlySnapshot()).file.receipts[kept]?.error).toBe("peer-2");
});

test("a retained archived collection keeps its retired reader alive after its root is collected", async () => {
  const { open, kept } = fixture();
  const reader = open();
  const writer = open();
  const seed = reader.readOnlySnapshot().file.receipts[kept]!;
  writer.mutate(file => {
    for (let index = 0; index < 8; index++) {
      const id = `retained-collection-${index}`;
      file.receipts[id] = { ...seed, launchId: id, state: "failed", error: `receipt-${index}`, createdAt: "2020-01-01T00:00:00Z" };
    }
  }, false);
  expect(writer.archiveInactive(8)).toBeGreaterThan(0);
  const retained = await (async () => {
    const view = await reader.prepareReadOnlySnapshot();
    return { collection: view.file.receipts, root: new WeakRef(view.file) };
  })();
  writer.mutate(file => { file.receipts[kept]!.error = "new generation"; }, false);
  await reader.prepareReadOnlySnapshot();
  for (let attempt = 0; attempt < 20; attempt++) {
    // A successful WeakRef.deref keeps its target alive until this job ends.
    // Release that check before collecting in the next job.
    await new Promise<void>(resolve => setImmediate(resolve));
    Bun.gc(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!retained.root.deref()) break;
  }
  expect(retained.root.deref()).toBeUndefined();
  expect(retained.collection["retained-collection-0"]?.error).toBe("receipt-0");
});

test("the first keyed archived read visits only its requested payload", async () => {
  const { open, kept, filename } = fixture();
  const reads: Array<[string, number]> = [];
  const writer = open();
  const seed = writer.readOnlySnapshot().file.receipts[kept]!;
  writer.mutate(file => {
    for (let index = 0; index < 128; index++) {
      const id = `keyed-archive-${index}`;
      file.receipts[id] = { ...seed, launchId: id, state: "failed", error: `payload-${index}`, createdAt: "2020-01-01T00:00:00Z" };
    }
  }, false);
  expect(writer.archiveInactive(128)).toBeGreaterThan(0);
  const coldReader = new SqliteAgentRegistryStore(filename,
    { readOnly: true, normalize: normalizeRegistry,
      initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
      onRowPayloadRead: (collection,count) => reads.push([collection,count]) });
  stores.push(coldReader);
  const view = await coldReader.prepareReadOnlySnapshot();
  reads.length = 0;
  expect(view.file.receipts["keyed-archive-73"]?.error).toBe("payload-73");
  expect(reads).toEqual([["receipts",1]]);
});

test("deferred cold-key initialization moves the first session view onto cooperative preparation", async () => {
  const { open, filename, kept } = fixture();
  const seed = open();
  const template = seed.readOnlySnapshot().file.receipts[kept]!;
  seed.mutate(file => {
    for (let index = 0; index < 640; index++) {
      const id = `cold-session-receipt-${index}`;
      file.receipts[id] = { ...template, launchId: id, state: "failed", error: "cold session history", createdAt: "2020-01-01T00:00:00Z" };
    }
  }, false);
  expect(seed.archiveInactive(1)).toBe(1);
  seed.close();
  stores.splice(stores.indexOf(seed), 1);
  const deferred = new SqliteAgentRegistryStore(filename, {
    deferColdKeyInitialization: true, normalize: normalizeRegistry,
    initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
  });
  stores.push(deferred);
  expect((deferred as unknown as { db: Database }).db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(0);
  let yielded = false;
  const turn = new Promise<boolean>(resolve => setImmediate(() => { yielded = true; resolve(true); }));
  const preparation = deferred.prepareReadOnlySnapshot();
  expect(await Promise.race([preparation.then(() => false), turn])).toBe(true);
  const snapshot = await preparation;
  expect(snapshot.file.receipts["cold-session-receipt-0"]?.state).toBe("failed");
  expect(yielded).toBe(true);
});

test("hot operation owners normalize in bounded batches and retain hydrated values", async () => {
  const { open } = fixture();
  const reader = open();
  const template = Object.values(reader.readOnlySnapshot().file.deliveryOperationOwners)[0]!;
  reader.mutate(file => {
    for (let index = 0; index < 128; index++) {
      const operationId = `batch-owner-${index}`;
      file.deliveryOperationOwners[operationId] = {
        ...template,
        deliveryId: `batch-missing-delivery-${index}`,
        requestDigest: `batch-digest-${index}`,
        command: { ...template.command, operationId },
      };
    }
  }, false);
  const started = performance.now();
  const prepared = await reader.prepareReadOnlySnapshot();
  const normalized = performanceSpans.snapshot(started).records.filter(record =>
    record.kind === "sync" && performanceSites[record.site] === "registry.prepare.normalize");
  expect(normalized.reduce((count, record) => count + record.count, 0)).toBeGreaterThanOrEqual(3);
  expect(normalized.reduce((rows, record) => rows + record.rows, 0)).toBe(129);
  expect(Object.keys(prepared.file.deliveryOperationOwners).filter(id => id.startsWith("batch-owner-")).length).toBe(128);
  expect(prepared.file.deliveryOperationOwners["batch-owner-127"]?.command.operationId).toBe("batch-owner-127");
});

test("cooperative cold headers use an iterator and retain ordered rows after restart", async () => {
  const { open, filename, kept } = fixture();
  const store = open();
  const template = store.readOnlySnapshot().file.receipts[kept]!;
  store.mutate(file => {
    for (let index = 0; index < 750; index++) {
      const id = `ordered-receipt-${index}`;
      file.receipts[id] = { ...template, launchId: id, state: "failed", error: "synthetic terminal history", createdAt: "2020-01-01T00:00:00Z" };
    }
  }, false);
  expect(store.archiveInactive(1024)).toBeGreaterThan(128);
  const expected = new Database(filename, { readonly: true });
  let keys: string[];
  try {
    keys = expected.query<{ row_key: string }, []>("SELECT row_key FROM registry_records WHERE collection='receipts' ORDER BY row_order").all().map(row => row.row_key);
    const plan = expected.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT c.collection,c.row_key,c.archive_id,a.row_order FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id").all();
    expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
    expect(plan.some(row => row.detail.includes("SEARCH a USING INTEGER PRIMARY KEY"))).toBe(true);
  }
  finally { expected.close(); }
  const query = Database.prototype.query;
  let iterations = 0;
  const probe = spyOn(Database.prototype, "query").mockImplementation(function(this: Database, sql: string) {
    const statement = query.call(this, sql);
    if (sql.startsWith("SELECT c.collection,c.row_key,c.archive_id")) {
      expect(sql).not.toContain("ORDER BY");
      const iterate = statement.iterate.bind(statement);
      statement.all = () => { throw Error("unbounded cold header materialization"); };
      statement.iterate = (...args: never[]) => { iterations++; return iterate(...args); };
    }
    return statement;
  } as typeof query);
  try {
    const view = await store.prepareReadOnlySnapshot();
    expect(Object.keys(view.file.receipts)).toEqual(keys);
    expect(iterations).toBe(1);
    const reopened = new SqliteAgentRegistryStore(filename, { readOnly: true, normalize: normalizeRegistry, initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }) });
    stores.push(reopened);
    expect((await reopened.prepareReadOnlySnapshot()).file).toEqual(view.file);
    expect(iterations).toBe(2);
  } finally { probe.mockRestore(); }
});

test("registry reads label cold loads and resumed preparation, including a failed preparation and retry", async () => {
  const { open, filename } = fixture();
  open();
  const labels: Array<string | undefined> = [];
  let refuse = false;
  const reader = new SqliteAgentRegistryStore(filename, { readOnly: true, normalize: normalizeRegistry, initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
    onSnapshotLoad: () => { labels.push(viewerLoopMonitor.current()); if (refuse) throw Error("refused read"); } });
  stores.push(reader);
  reader.readOnlySnapshot();
  refuse = true;
  await expect(reader.prepareReadOnlySnapshot()).rejects.toThrow("refused read");
  refuse = false;
  await reader.prepareReadOnlySnapshot();
  expect(labels).toEqual(["registry.read", "registry.prepare", "registry.prepare"]);
});

test("recovery index preparation yields while a peer owns the writer", async () => {
  const { open, filename } = fixture();
  const store = open();
  const peer = new Database(filename);
  peer.exec("BEGIN IMMEDIATE");
  let settled = false;
  const preparing = store.prepareRecoveryIndexes().finally(() => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(settled).toBe(false);
  } finally {
    peer.exec("ROLLBACK");
    peer.close();
    await preparing;
  }
  expect(settled).toBe(true);
});

test("an aborted preparation leaves keyed reads and the next preparation usable", async () => {
  const { open, kept } = fixture();
  const store = open();
  const controller = new AbortController();
  controller.abort(new Error("retired preparation"));
  await expect(store.prepareReadOnlySnapshot(controller.signal)).rejects.toThrow("retired preparation");
  expect(store.read(file => file.receipts[kept]?.launchId)).toBe(kept);
  expect((await store.prepareReadOnlySnapshot()).file.receipts[kept]?.launchId).toBe(kept);
});

test("closing the owner during asynchronous preparation refuses publication", async () => {
  const { open } = fixture();
  const store = open();
  const preparing = store.prepareReadOnlySnapshot();
  store.close();
  await expect(preparing).rejects.toThrow();
  const replacement = open();
  expect((await replacement.prepareReadOnlySnapshot()).file.version).toBe(2);
});

test("structured host lookup keeps a held view through peer deletion and replacement", async () => {
  const { open } = fixture();
  const store = open();
  const peer = open();
  await store.prepareRecoveryIndexes();
  const entry: RegistryFile["entries"][string] = {
    key: { engine: "codex", sessionId: "indexed-host" }, artifactPath: "/sessions/indexed-host.jsonl",
    cwd: "/repo", accountId: null, status: "dead", host: null, claimOwner: null, claimEpoch: 0, pendingAction: null,
    updatedAt: "2020-01-01T00:00:00Z",
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:released", process: null, eventCursor: 0,
      protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
  };
  store.mutate(file => { file.entries["codex:indexed-host"] = entry; }, false);
  const held = store.readOnlySnapshot().file;
  const hosts = (file: RegistryFile) => registryRowsMatching(file, "entries", "structuredHost.kind", "codex-app-server")
    .map(row => row.key.sessionId);
  peer.mutate(file => {
    delete file.entries["codex:indexed-host"];
    file.entries["codex:replacement-host"] = { ...entry, key: { engine: "codex", sessionId: "replacement-host" } };
  }, false);
  expect(hosts(held)).toEqual(["indexed-host"]);
  expect(hosts(store.readOnlySnapshot().file)).toEqual(["replacement-host"]);
  peer.mutate(file => { file.entries["codex:replacement-host"]!.structuredHost = undefined; }, false);
  expect(hosts(store.readOnlySnapshot().file)).toEqual([]);
  expect(hosts(held)).toEqual(["indexed-host"]);
});

test("preparation applies a peer commit and never publishes the stale transaction", async () => {
  const { open, filename, kept } = fixture();
  const writer = open();
  let changed = false;
  const reader = new SqliteAgentRegistryStore(filename, {
    normalize: normalizeRegistry, readOnly: true,
    initialSnapshot: () => { throw new Error("existing fixture required"); },
    onRowPayloadRead: () => {
      if (changed) return;
      changed = true;
      writer.mutate(file => { file.receipts[kept]!.error = "peer committed during preparation"; }, false);
    },
  });
  stores.push(reader);
  const prepared = await reader.prepareReadOnlySnapshot();
  expect(changed).toBe(true);
  expect(prepared.file.receipts[kept]?.error).toBe("peer committed during preparation");
  const abort = new AbortController(); abort.abort(new Error("retired cached reader"));
  await expect(reader.prepareReadOnlySnapshot(abort.signal)).rejects.toThrow("retired cached reader");
});

test("preparation completes under sustained peer commits and refreshes from their journal", async () => {
  const { open, filename, kept } = fixture();
  const writer = open();
  let writing = true, writes = 0, loads = 0;
  const reader = new SqliteAgentRegistryStore(filename, {
    normalize: normalizeRegistry, readOnly: true,
    initialSnapshot: () => { throw new Error("existing fixture required"); },
    onSnapshotLoad: () => { loads++; },
    onRowPayloadRead: (_collection, count) => {
      if (!writing || !count) return;
      writes++;
      writer.mutate(file => { file.receipts[kept]!.error = `peer revision ${writes}`; }, false);
    },
  });
  stores.push(reader);
  try { await reader.prepareReadOnlySnapshot(); }
  finally { writing = false; }
  expect(writes).toBeGreaterThan(1);
  expect(loads).toBe(1);
  expect(reader.readOnlySnapshot().file.receipts[kept]?.error).toBe(`peer revision ${writes}`);
});

test("a reader cannot replace a collection of the shared view, even through the loader's accessor", () => {
  const { open, kept } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  /* The regression: a frozen loaded file still ran its accessor's setter. */
  expect(attempt(() => { (view as { receipts: RegistryFile["receipts"] }).receipts = {}; })).toBe(false);
  expect(attempt(() => { (view as { conversationRevision: unknown }).conversationRevision = {}; })).toBe(false);
  expect(Object.getOwnPropertyDescriptor(view, "receipts")).toMatchObject({ writable: false, configurable: false });
  expect(store.readOnlySnapshot().file.receipts[kept]).toBeDefined();
});

test("a reader cannot add, replace or delete a row, or change a meta value, of the shared view", () => {
  const { open, kept, conversation } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  const receipt = view.receipts[kept]!;
  expect(attempt(() => { view.receipts["receipt-added-by-a-reader"] = receipt; })).toBe(false);
  expect(attempt(() => { view.receipts[kept] = { ...receipt, error: "replaced by a reader" }; })).toBe(false);
  expect(attempt(() => { delete view.receipts[kept]; })).toBe(false);
  expect(attempt(() => { delete view.conversations[conversation.id]; })).toBe(false);
  expect(attempt(() => { view.engineRouting.codex.revision += 1; })).toBe(false);
  expect(attempt(() => { view.conversationRevision.codex += 1; })).toBe(false);

  const next = store.readOnlySnapshot().file;
  expect(next).toBe(view);
  expect(Object.keys(next.receipts)).not.toContain("receipt-added-by-a-reader");
  expect(next.receipts[kept]).toBe(receipt);
  expect(next.conversations[conversation.id]).toBeDefined();
  expect(next.engineRouting.codex.revision).toBe(store.snapshot().file.engineRouting.codex.revision);
});

test("a reader cannot change a row's own fields or anything nested in it, and the next reader keeps the originals", () => {
  const { open, kept, conversation, delivery } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  const receipt = view.receipts[kept]!;
  const row = view.conversations[conversation.id]!;
  const held = view.heldDeliveries[delivery.id]!;
  const originalPath = row.generations[0]!.path;
  const originalOperation = held.command.operationId;

  /* The review's reproduction: each of these used to land in the next read. */
  expect(attempt(() => { receipt.error = "reader-corruption"; })).toBe(false);
  expect(attempt(() => { row.generations[0]!.path = "/sessions/reader-corruption.jsonl"; })).toBe(false);
  expect(attempt(() => { held.command.operationId = "reader-corruption"; })).toBe(false);
  expect(attempt(() => { (held.command as { text?: string }).text = "reader-corruption"; })).toBe(false);
  expect(attempt(() => { held.text = "reader-corruption"; })).toBe(false);
  expect(attempt(() => { row.generations.push(row.generations[0]!); })).toBe(false);
  expect(attempt(() => { row.continuityPaths.push("/sessions/reader-corruption.jsonl"); })).toBe(false);
  expect(attempt(() => { row.generations.splice(0, 1); })).toBe(false);
  expect(attempt(() => { delete (held.command as { kind?: string }).kind; })).toBe(false);
  for (const value of [receipt, row, row.generations, row.generations[0], held, held.command]) {
    expect(Object.isFrozen(value)).toBe(true);
  }

  const next = store.readOnlySnapshot().file;
  expect(next.receipts[kept]?.error).toBeNull();
  expect(next.conversations[conversation.id]?.generations).toHaveLength(1);
  expect(next.conversations[conversation.id]?.generations[0]?.path).toBe(originalPath);
  expect(next.heldDeliveries[delivery.id]?.command).toEqual(store.snapshot().file.heldDeliveries[delivery.id]!.command);
  expect(next.heldDeliveries[delivery.id]?.command.operationId).toBe(originalOperation);
  expect(next.heldDeliveries[delivery.id]?.text).toBe("held for the view");
});

test("the store's parse cache stays its own: the view shares no object with it, and a write still edits the row", () => {
  const { open, kept, conversation } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  const viewObjects = new Set<unknown>();
  const walk = (value: unknown) => {
    if (value === null || typeof value !== "object" || viewObjects.has(value)) return;
    viewObjects.add(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(view);
  const parsed = (store as unknown as { rowCache: Map<string, Map<string, { parsed: unknown }>> }).rowCache;
  for (const rows of parsed.values()) {
    for (const { parsed: row } of rows.values()) {
      const shared: unknown[] = [];
      const visit = (value: unknown) => {
        if (value === null || typeof value !== "object") return;
        if (viewObjects.has(value)) shared.push(value);
        expect(Object.isFrozen(value)).toBe(false);
        for (const child of Object.values(value)) visit(child);
      };
      visit(row);
      expect(shared).toEqual([]);
    }
  }

  store.mutate((file) => {
    file.receipts[kept]!.error = "written after a read";
    file.conversations[conversation.id]!.continuityPaths.push("/sessions/written-after-a-read.jsonl");
  }, false);
  const next = store.readOnlySnapshot().file;
  expect(next.receipts[kept]?.error).toBe("written after a read");
  expect(next.conversations[conversation.id]?.continuityPaths).toContain("/sessions/written-after-a-read.jsonl");
  expect(Object.isFrozen(next.conversations[conversation.id]?.continuityPaths)).toBe(true);
  expect(view.receipts[kept]?.error).toBeNull();
  expect(view.conversations[conversation.id]?.continuityPaths).not.toContain("/sessions/written-after-a-read.jsonl");
});

test("a write built from a view row can still be edited inside its mutation, and the view stays as it was", () => {
  const { open, kept, conversation } = fixture();
  const store = open();
  const view = store.readOnlySnapshot().file;
  const row = view.conversations[conversation.id]!;
  const path = row.generations[0]!.path;
  const revision = view.engineRouting.codex.revision;

  /* `upsert({ ...view.entries[id], … })` is how a writer reaches this: the
     spread is new, everything nested in it is the view's own frozen object. */
  store.mutate((file) => {
    file.conversations[conversation.id] = { ...row, pinnedAccountId: "spread-from-the-view" };
    file.conversations[conversation.id]!.generations[0]!.path = "/sessions/edited-in-the-mutation.jsonl";
    file.conversations[conversation.id]!.continuityPaths.push("/sessions/pushed-in-the-mutation.jsonl");
    file.receipts[kept]!.launchProfile = view.receipts[kept]!.launchProfile;
    file.receipts[kept]!.launchProfile!.title = "edited in the mutation";
    file.engineRouting = view.engineRouting;
    file.engineRouting.codex.revision += 1;
  }, false);

  const next = store.readOnlySnapshot().file;
  expect(next.conversations[conversation.id]?.pinnedAccountId).toBe("spread-from-the-view");
  expect(next.conversations[conversation.id]?.generations[0]?.path).toBe("/sessions/edited-in-the-mutation.jsonl");
  expect(next.conversations[conversation.id]?.continuityPaths).toContain("/sessions/pushed-in-the-mutation.jsonl");
  expect(next.receipts[kept]?.launchProfile?.title).toBe("edited in the mutation");
  expect(next.engineRouting.codex.revision).toBe(revision + 1);
  expect(row.generations[0]!.path).toBe(path);
  expect(row.continuityPaths).not.toContain("/sessions/pushed-in-the-mutation.jsonl");
  expect(view.receipts[kept]?.launchProfile?.title).toBe("Kept receipt");
  expect(view.engineRouting.codex.revision).toBe(revision);
});

test("a reload copies only the rows whose decided value changed", () => {
  const { open, kept, removed, conversation, delivery } = fixture();
  const reader = open();
  const writer = open();
  const before = reader.readOnlySnapshot().file;

  writer.mutate((file) => { file.receipts[kept]!.error = "written elsewhere"; }, false);
  const after = reader.readOnlySnapshot().file;
  expect(after).not.toBe(before);
  expect(after.receipts[kept]).not.toBe(before.receipts[kept]);
  expect(after.receipts[kept]?.error).toBe("written elsewhere");
  expect(after.receipts[removed]).toBe(before.receipts[removed]);
  expect(after.conversations[conversation.id]).toBe(before.conversations[conversation.id]);
  expect(after.heldDeliveries[delivery.id]).toBe(before.heldDeliveries[delivery.id]);
  expect(before.receipts[kept]?.error).toBeNull();
});

test("interleaved external revisions read only changed payloads, including unversioned writes", () => {
  const { open, filename, kept, removed } = fixture();
  const reader = open();
  const writer = open();
  reader.readOnlySnapshot();
  let reads = 0;
  let loads = 0;
  const observed = reader as unknown as { onRowPayloadRead: (_collection: string, count: number) => void; onSnapshotLoad: () => void };
  observed.onRowPayloadRead = (_collection, count) => { reads += count; };
  observed.onSnapshotLoad = () => { loads += 1; };
  writer.mutate(file => { file.receipts[kept]!.error = "first external revision"; }, false);
  writer.mutate(file => { file.receipts[removed]!.error = "second external revision"; }, false);
  const db = new Database(filename);
  try {
    db.query("UPDATE registry_rows SET value_json = json_set(value_json, '$.error', ?) WHERE collection='receipts' AND row_key=?")
      .run("external write without a revision", kept);
  } finally { db.close(); }
  const next = reader.readOnlySnapshot();
  expect(next.file.receipts[kept]?.error).toBe("external write without a revision");
  expect(next.file.receipts[removed]?.error).toBe("second external revision");
  expect(loads).toBe(0);
  expect(reads).toBeLessThanOrEqual(2);
});

test("two readers share one view and neither can corrupt the other; a detached snapshot stays mutable", () => {
  const { open, kept } = fixture();
  const store = open();
  const first = store.readOnlySnapshot().file;
  const second = store.readOnlySnapshot().file;
  expect(second).toBe(first);
  expect(attempt(() => { delete first.receipts[kept]; })).toBe(false);
  expect(second.receipts[kept]).toBeDefined();

  const detached = store.snapshot().file;
  expect(Object.isFrozen(detached)).toBe(false);
  detached.receipts = {};
  expect(Object.keys(detached.receipts)).toHaveLength(0);
  expect(store.readOnlySnapshot().file.receipts[kept]).toBeDefined();
});

test("every local write reaches the next read, and the view a reader already holds stays as it was", () => {
  const { open, kept, removed } = fixture();
  const store = open();
  const before = store.readOnlySnapshot().file;
  const template = before.receipts[kept]!;

  store.mutate((file) => { file.receipts[kept]!.error = "updated locally"; }, false);
  const updated = store.readOnlySnapshot().file;
  expect(updated.receipts[kept]?.error).toBe("updated locally");
  expect(before.receipts[kept]?.error).toBeNull();
  /* The view a local commit patches in place of a reload is frozen too. */
  expect(Object.isFrozen(updated)).toBe(true);
  expect(Object.isFrozen(updated.receipts)).toBe(true);

  store.mutate((file) => { file.receipts["receipt-added-locally"] = { ...structuredClone(template), launchId: "receipt-added-locally" }; }, false);
  expect(store.readOnlySnapshot().file.receipts["receipt-added-locally"]?.launchId).toBe("receipt-added-locally");

  store.mutate((file) => { delete file.receipts[removed]; }, false);
  expect(store.readOnlySnapshot().file.receipts[removed]).toBeUndefined();
  expect(before.receipts[removed]).toBeDefined();

  store.mutate((file) => { file.engineRouting.codex.revision += 7; }, false);
  const meta = store.readOnlySnapshot().file;
  expect(meta.engineRouting.codex.revision).toBe(before.engineRouting.codex.revision + 7);
  expect(Object.isFrozen(meta.engineRouting.codex)).toBe(true);
});

test("a write by another connection reaches the next read, with or without a revision", () => {
  const { open, filename, kept } = fixture();
  const reader = open();
  const writer = open();
  const before = reader.readOnlySnapshot().file;

  writer.mutate((file) => { file.receipts[kept]!.error = "written elsewhere"; }, false);
  expect(reader.readOnlySnapshot().file.receipts[kept]?.error).toBe("written elsewhere");

  /* A commit that rewrites a row without advancing the revision. */
  const db = new Database(filename);
  try {
    db.query("UPDATE registry_rows SET value_json = json_set(value_json, '$.error', ?) WHERE collection = 'receipts' AND row_key = ?")
      .run("written without a revision", kept);
  } finally {
    db.close();
  }
  const after = reader.readOnlySnapshot().file;
  expect(after.receipts[kept]?.error).toBe("written without a revision");
  expect(Object.isFrozen(after.receipts)).toBe(true);
  expect(before.receipts[kept]?.error).toBeNull();
});

test("the view keeps the keyed readers of the loaded file, and a complete read forgets deleted rows", () => {
  const { open, conversation, delivery, removed } = fixture();
  const reader = open();
  const writer = open();
  const view = reader.readOnlySnapshot().file;
  expect(registryRowsMatching(view, "heldDeliveries", "conversationId", conversation.id).map((row) => row.id)).toEqual([delivery.id]);

  const parsed = (store: SqliteAgentRegistryStore) =>
    (store as unknown as { rowCache: Map<string, Map<string, unknown>> }).rowCache.get("receipts")!;
  expect(parsed(reader).has(removed)).toBe(true);
  writer.mutate((file) => { delete file.receipts[removed]; }, false);
  expect(reader.readOnlySnapshot().file.receipts[removed]).toBeUndefined();
  expect(parsed(reader).has(removed)).toBe(false);
});

test("a reader cannot replace, delete or restamp the envelope the shared view comes in", () => {
  const { open, kept } = fixture();
  const store = open();
  const envelope = store.readOnlySnapshot() as { file?: RegistryFile; revision: number; stamp?: string };
  const { file, revision, stamp } = envelope;
  expect(Object.isFrozen(envelope)).toBe(true);
  /* The regression: the file was frozen and the envelope every reader gets was not. */
  expect(attempt(() => { envelope.file = { ...file!, receipts: {} }; })).toBe(false);
  expect(attempt(() => { delete envelope.file; })).toBe(false);
  expect(attempt(() => { envelope.revision = revision + 100; })).toBe(false);
  expect(attempt(() => { envelope.stamp = "restamped by a reader"; })).toBe(false);

  const next = store.readOnlySnapshot() as typeof envelope;
  expect(next.file).toBe(file);
  expect(next.revision).toBe(revision);
  expect(next.stamp).toBe(stamp);
  expect(next.file!.receipts[kept]).toBeDefined();

  /* The envelope a local commit patches in is frozen too, and the write is in it. */
  store.mutate((written) => { written.receipts[kept]!.error = "updated locally"; }, false);
  const patched = store.readOnlySnapshot();
  expect(Object.isFrozen(patched)).toBe(true);
  expect(patched.revision).toBe(revision + 1);
  expect(patched.file.receipts[kept]?.error).toBe("updated locally");

  const detached = store.snapshot() as { file: RegistryFile; revision: number };
  expect(Object.isFrozen(detached)).toBe(false);
  detached.file = { ...detached.file, receipts: {} };
  detached.revision += 100;
  expect(store.readOnlySnapshot().file.receipts[kept]).toBeDefined();
  expect(store.readOnlySnapshot().revision).toBe(revision + 1);
});

for (const mode of ["off", "dual-write"] as const) {
  const jsonFixture = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-readonly-json-"));
    directories.push(directory);
    const filename = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
    const conversation = registry.ensureConversation("codex", "/sessions/readonly-json.jsonl", "default");
    const kept = registry.beginSpawn("codex", "/repo/kept", { title: "Kept receipt" }).launchId;
    return { registry, conversation, kept };
  };

  test(`${mode}: a reader cannot change the shared JSON view, directly or in anything nested`, () => {
    const { registry, conversation, kept } = jsonFixture();
    try {
      const view = registry.readOnlySnapshot();
      expect(registry.readOnlySnapshot()).toBe(view);
      /* The regression: the parsed file was cached as it was and every row stayed writable. */
      expect(attempt(() => { view.receipts[kept]!.error = "reader-corruption"; })).toBe(false);
      expect(attempt(() => { view.receipts[kept]!.launchProfile!.cwd = "/reader/corruption"; })).toBe(false);
      expect(attempt(() => { view.conversations[conversation.id]!.generations.push(view.conversations[conversation.id]!.generations[0]!); })).toBe(false);
      expect(attempt(() => { delete view.receipts[kept]; })).toBe(false);
      expect(attempt(() => { view.receipts["receipt-added-by-a-reader"] = view.receipts[kept]!; })).toBe(false);
      expect(attempt(() => { (view as { receipts: RegistryFile["receipts"] }).receipts = {}; })).toBe(false);
      expect(attempt(() => { view.engineRouting.codex.revision += 1; })).toBe(false);

      const next = registry.readOnlySnapshot();
      expect(next).toBe(view);
      expect(next.receipts[kept]?.error).toBeNull();
      expect(next.receipts[kept]?.launchProfile?.cwd).toBe("/repo/kept");
      expect(next.conversations[conversation.id]?.generations).toHaveLength(1);
      expect(registry.snapshot().receipts[kept]?.error).toBeNull();
    } finally {
      registry.close();
    }
  });

  test(`${mode}: a write reaches the next read of the JSON view, and a detached snapshot stays mutable`, () => {
    const { registry, kept } = jsonFixture();
    try {
      const failed = registry.beginSpawn("codex", "/repo/failed", { title: "Failed receipt" }).launchId;
      const before = registry.readOnlySnapshot();

      expect(registry.failSpawn(failed, "written locally")).toBe(true);
      const local = registry.readOnlySnapshot();
      expect(local).not.toBe(before);
      expect(local.receipts[failed]?.error).toBe("written locally");
      expect(Object.isFrozen(local.receipts[failed])).toBe(true);
      expect(before.receipts[failed]?.error).toBeNull();

      /* A write by another registry over the same files. */
      const other = new AgentRegistry(registry.filename, undefined, undefined, { sqliteMode: mode });
      try {
        expect(other.failSpawn(kept, "written elsewhere")).toBe(true);
      } finally {
        other.close();
      }
      const foreign = registry.readOnlySnapshot();
      expect(foreign.receipts[kept]?.error).toBe("written elsewhere");
      expect(Object.isFrozen(foreign.receipts[kept])).toBe(true);
      expect(local.receipts[kept]?.error).toBeNull();

      const detached = registry.snapshot();
      expect(Object.isFrozen(detached)).toBe(false);
      detached.receipts[kept]!.error = "edited on a private copy";
      detached.receipts = {};
      expect(registry.readOnlySnapshot().receipts[kept]?.error).toBe("written elsewhere");
    } finally {
      registry.close();
    }
  });
}

test("warm recovery index proof is invalidated by an external schema edit", async () => {
  const { open, filename, kept } = fixture();
  const reader = open();
  const first = await reader.prepareReadOnlySnapshot();
  const db = new Database(filename);
  try {
    db.run("DROP INDEX registry_lookup_launchId");
    expect(db.query("SELECT name FROM sqlite_master WHERE name='registry_lookup_launchId'").get()).toBeNull();
    const next = await reader.prepareReadOnlySnapshot();
    expect(next.file.receipts[kept]?.launchId).toBe(first.file.receipts[kept]?.launchId);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='registry_lookup_launchId'").get()).not.toBeNull();
  } finally { db.close(); }
});

test("a schema edit during yielded recovery verification cannot publish an index proof", async () => {
  const { open, filename } = fixture();
  const reader = open();
  await reader.prepareReadOnlySnapshot();
  const db = new Database(filename);
  let edit: ReturnType<typeof setImmediate> | undefined;
  try {
    // A missing final index guarantees a second yield after the first index
    // was checked, so the peer edit lands behind that verified boundary.
    db.run("DROP INDEX registry_archive_structured_host_kind");
    const preparing = reader.prepareRecoveryIndexes();
    edit = setImmediate(() => { edit = setImmediate(() => db.run("DROP INDEX registry_lookup_clientMessageId_heldDeliveries")); });
    await expect(preparing).rejects.toThrow("indexes changed during preparation");
    await reader.prepareRecoveryIndexes();
    expect(db.query("SELECT name FROM sqlite_master WHERE name='registry_lookup_clientMessageId_heldDeliveries'").get()).not.toBeNull();
  } finally { if (edit) clearImmediate(edit); db.close(); }
});

test("cooperative preparation normalizes hot rows in bounded batches and keeps the receipt backfill", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-readonly-batches-"));
  directories.push(directory);
  const seed = new AgentRegistry(path.join(directory, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const template = seed.ensureConversation("codex", "/sessions/batch-template.jsonl", "default");
  const spawn = seed.beginSpawn("codex", "/repo/batch-template", { title: "Batch template" });
  const initial = seed.snapshot();
  seed.close();
  type ConversationId = RegistryFile["receipts"][string]["conversationId"] & string;
  const conversationTemplate = initial.conversations[template.id]!;
  const receiptTemplate = initial.receipts[spawn.launchId]!;
  const rows = 200;
  for (let index = 0; index < rows; index++) {
    const id = `conversation_batch-${index}` as ConversationId;
    const artifactPath = `/sessions/batch-${index}.jsonl`;
    initial.conversations[id] = {
      ...conversationTemplate, id, engine: index === 1 ? "claude" : "codex",
      generations: conversationTemplate.generations.map(generation => ({ ...generation, path: artifactPath })),
    };
    // Every third receipt reaches its conversation through a two-link alias chain.
    let conversationId = id;
    if (index % 3 === 0) {
      const near = `conversation_batch-alias-${index}` as ConversationId;
      const far = `conversation_batch-alias-far-${index}` as ConversationId;
      initial.conversationAliases[far] = near;
      initial.conversationAliases[near] = id;
      conversationId = far;
    }
    const launchId = `batch-receipt-${index}`;
    initial.receipts[launchId] = {
      ...receiptTemplate, launchId, conversationId, engine: "codex", transport: "structured", state: "completed",
      artifactPath, artifactLifecycle: "pending", completionMode: "observed-completed",
    };
  }
  let largest = 0;
  let counting = false;
  const normalize = ((value: unknown, mode?: Parameters<typeof normalizeRegistry>[1]) => {
    if (counting) {
      for (const collection of ["entries", "receipts", "conversations", "conversationAliases", "lineageEdges", "heldDeliveries"]) {
        largest = Math.max(largest, Object.keys(((value as Record<string, unknown>)[collection] ?? {}) as object).length);
      }
    }
    return normalizeRegistry(value, mode);
  }) as typeof normalizeRegistry;
  const store = new SqliteAgentRegistryStore(path.join(directory, "agent-registry.sqlite"), { initialSnapshot: initial, normalize });
  stores.push(store);
  counting = true;
  const prepared = await store.prepareReadOnlySnapshot();
  counting = false;
  // One normalization call over every hot row was a 372 ms slice on the
  // retained-history copy; each call now sees at most one batch.
  expect(largest).toBeGreaterThan(0);
  expect(largest).toBeLessThanOrEqual(64);
  const batch = Object.keys(prepared.file.receipts).filter(id => id.startsWith("batch-receipt-"));
  expect(batch).toEqual(Array.from({ length: rows }, (_, index) => `batch-receipt-${index}`));
  expect(batch.filter(id => prepared.file.receipts[id]!.artifactLifecycle === "materialized"))
    .toEqual(batch.filter(id => id !== "batch-receipt-1"));
  // An engine mismatch keeps the receipt pending, as the complete normalization does.
  expect(prepared.file.receipts["batch-receipt-1"]!.artifactLifecycle).toBe("pending");
  expect(prepared.file.receipts["batch-receipt-0"]!.conversationId).toBe("conversation_batch-alias-far-0");
  expect(Object.keys(prepared.file.conversations).filter(id => id.startsWith("conversation_batch-")))
    .toEqual(Array.from({ length: rows }, (_, index) => `conversation_batch-${index}`));
  expect(prepared.file.conversationAliases["conversation_batch-alias-far-0"]).toBe("conversation_batch-alias-0");
  const complete = normalizeRegistry(structuredClone(initial));
  for (const id of batch) expect(prepared.file.receipts[id]!.artifactLifecycle).toBe(complete.receipts[id]!.artifactLifecycle);
}, 30_000);
