import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { initializeStateCollections, SqliteStateCollection, StateSnapshotChangedError } from "./sqliteStateStore";
import { publishHotStateAuthority } from "./hotStateAuthority";
import { pipelineHostHasLiveWork } from "@/lib/pipelines/hostRetirement";
import type { Pipeline } from "@/lib/pipelines/types";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";

type Row = { key: string; value: number };

test("controller caches follow decoding authority and refuse writes that race snapshot preparation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "controller-authority-"));
  const rows = Array.from({ length: 32 }, (_, n) => ({ key: `row-${n}`, value: n }));
  let authority = 0, onDecode = () => {};
  const options = { collection: "authority", schemaVersion: 1, busyMessage: "busy", key: (row: Row) => row.key,
    decodeAuthority: () => authority, clone: (row: Row) => structuredClone(row),
    decode: (raw: unknown) => { onDecode(); const row = raw as Row; return { ...row, value: row.value + authority }; } };
  try {
    const filename = path.join(dir, "state.sqlite");
    initializeStateCollections(filename, [{ ...options, migrationId: "one", loadRecords: () => rows }]);
    const store = new SqliteStateCollection(filename, options);
    await store.reconcileSnapshot(records => { records[0]!.value = 999; });
    await store.reconcileSnapshot(records => { expect(records[0]!.value).toBe(0); });
    authority = 10;
    await store.reconcileSnapshot(records => { expect(records[0]!.value).toBe(10); });
    const peer = new SqliteStateCollection(filename, options);
    let queued = false, entered = false;
    authority = 20;
    onDecode = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => peer.boundedPatch(1, tx => tx.put({ key: "row-0", value: 500 })));
    };
    await expect(store.reconcileSnapshot(() => { entered = true; })).rejects.toThrow(StateSnapshotChangedError);
    expect(entered).toBe(false);
    expect(store.get("row-0")?.value).toBe(520);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("controller candidate indexes backfill retained rows and follow peer writes, deletion and rollback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "controller-index-"));
  type WorkRow = Row & { state: string; runs: unknown[]; remoteAction?: { state: string }; pendingReviewFlowCleanup?: string[];
    closeTeardown?: { phase: string }; closeReport?: { unconfirmed: string[]; stillRunning: string[] } };
  const selected: WorkRow = { key: "closed-launch", value: 1, state: "closed",
    runs: [{ attempts: [{ launchId: "pending", state: "spawning", verdict: null }] }] };
  const other: WorkRow = { key: "parked", value: 2, state: "needs_decision", runs: [], remoteAction: { state: "pending" } };
  const rows: WorkRow[] = [selected, other, ...Array.from({ length: 2_000 }, (_, n) => ({ key: `retained-${n}`, value: n,
    state: "closed", runs: [{ attempts: [{ launchId: `settled-${n}`, state: "failed", verdict: null }] }] })),
    { key: "future", value: 3, state: "future", runs: ["opaque", { attempts: ["opaque"] }] }];
  let decodes = 0, duringRead = () => {};
  const options = { collection: "pipelines", schemaVersion: 1, busyMessage: "busy", key: (row: WorkRow) => row.key,
    decode: (raw: unknown) => { decodes++; duringRead(); return raw as WorkRow; }, clone: (row: WorkRow) => structuredClone(row) };
  try {
    const filename = path.join(dir, "state.sqlite");
    initializeStateCollections(filename, [{ ...options, migrationId: "one", loadRecords: () => rows }]);
    const db = new Database(filename);
    // Recreate the shape of a database written before this index existed.
    for (const name of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER pipeline_controller_work_${name}`);
    db.exec("DROP TABLE pipeline_controller_work");
    const store = new SqliteStateCollection(filename, options);
    expect(await store.pipelineControllerSelection("closed-launch")).toEqual([selected]);
    expect(decodes).toBe(1);
    expect(await store.pipelineControllerSelection("remote")).toEqual([other]);
    const closing = { ...selected, key: "close-custody", runs: [], closeTeardown: { phase: "settled" },
      closeReport: { unconfirmed: [], stillRunning: [] } };
    store.boundedPatch(1, tx => tx.put(closing));
    expect(await store.pipelineControllerSelection("close")).toEqual([]);
    store.boundedPatch(1, tx => tx.put({ ...closing, closeReport: { unconfirmed: ["unknown-host"], stillRunning: [] } }));
    expect((await store.pipelineControllerSelection("close")).map(row => row.key)).toEqual([closing.key]);
    // The pre-index writer's ordinary row SQL still maintains the projection.
    const updated = { ...selected, runs: [], pendingReviewFlowCleanup: ["flow"] };
    db.exec("BEGIN IMMEDIATE");
    db.query("UPDATE state_rows SET value_json = ?, row_revision = row_revision + 1 WHERE collection = 'pipelines' AND row_key = ?")
      .run(JSON.stringify(updated), selected.key);
    db.query("UPDATE state_collections SET revision = revision + 1 WHERE collection = 'pipelines'").run();
    db.exec("COMMIT");
    expect(await store.pipelineControllerSelection("closed-launch")).toEqual([]);
    expect(await store.pipelineControllerSelection("cleanup")).toEqual([updated]);
    const peer = new SqliteStateCollection(filename, options);
    expect(() => peer.boundedPatch(2, tx => { tx.delete(other.key); throw new Error("refused"); })).toThrow("refused");
    expect(await store.pipelineControllerSelection("remote")).toEqual([other]);
    peer.boundedPatch(1, tx => tx.delete(other.key));
    expect(await store.pipelineControllerSelection("remote")).toEqual([]);
    peer.boundedPatch(1, tx => tx.put(other));
    duringRead = () => {
      duringRead = () => {};
      peer.boundedPatch(1, tx => tx.put({ ...other, remoteAction: { state: "settled" } }));
    };
    expect(await store.pipelineControllerSelection("remote")).toEqual([other]);
    expect(await store.pipelineControllerSelection("remote")).toEqual([]);
    const throughOrder = store.pipelineControllerRowOrder();
    const fresh = { ...other, key: "fresh-provisioning", state: "provisioning" };
    peer.boundedPatch(2, tx => {
      tx.put(fresh);
      tx.put({ ...other, state: "provisioning" });
    });
    expect((await store.pipelineControllerSelection("provisioning", throughOrder)).map(row => row.key)).toEqual([other.key]);
    expect((await store.pipelineControllerSelection("provisioning")).map(row => row.key)).toEqual([other.key, fresh.key]);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reconciliation avoids inactive revisions and warm decoding while yielding between history batches", async () => {
  type HistoryRow = Row & { attempts: number[] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-batches-"));
  const rows = Array.from({ length: 2_128 }, (_, n): HistoryRow => ({ key: `row-${n}`, value: n < 128 ? n + 1 : -1,
    attempts: Array.from({ length: 200 }, (_, i) => i) }));
  let decoded = 0;
  const options = { collection: "reconcile-test", schemaVersion: 1, busyMessage: "busy",
    key: (row: HistoryRow) => row.key, controllerActive: (row: HistoryRow) => row.value > 0,
    decode: (raw: unknown) => { decoded++; return raw as HistoryRow; }, clone: (row: HistoryRow) => structuredClone(row) };
  try {
    const filename = path.join(dir, "state.sqlite");
    initializeStateCollections(filename, [{ ...options, migrationId: "one", loadRecords: () => rows }]);
    const store = new SqliteStateCollection(filename, options);
    const census = spyOn(store, "rowRevisions");
    let pulses = 0;
    const timer = setInterval(() => { pulses++; }, 0);
    try {
      await store.reconcileSnapshot(records => { expect(records.length).toBe(128); });
      expect(census).not.toHaveBeenCalled();
      expect(decoded).toBe(128);
      expect(pulses).toBeGreaterThan(0);
      decoded = 0;
      const stringify = JSON.stringify;
      let baselines = 0;
      const serialization = spyOn(JSON, "stringify").mockImplementation(((...args: Parameters<typeof stringify>) => {
        if (args[0]?.attempts) baselines++;
        return stringify(...args);
      }) as typeof JSON.stringify);
      try {
        await store.reconcileSnapshot(records => {
          expect(records.map(row => row.value)).toEqual(rows.slice(0, 128).map(row => row.value));
        }, undefined, true);
        expect(decoded).toBe(0);
        expect(baselines).toBe(0);
      } finally { serialization.mockRestore(); }
    } finally { clearInterval(timer); census.mockRestore(); }
    // Detached writes and ordinary implicit checkpoints retain their contract.
    await store.reconcileSnapshot(async (records, persist, assertCurrent) => {
      records[0]!.value = 500;
      await persist();
      assertCurrent(records[0]!);
      records[1]!.value = 600;
      await persist([records[1]!]);
    });
    expect(store.get("row-0")?.value).toBe(500);
    expect(store.get("row-1")?.value).toBe(600);
    const peer = new SqliteStateCollection(filename, options);
    await expect(store.reconcileSnapshot(async (records, persist, assertCurrent) => {
      const stale = records[0]!;
      peer.boundedPatch(2, tx => { const row = tx.get(stale.key)!; tx.put({ ...row, value: 700 }); });
      expect(() => assertCurrent(stale)).toThrow(StateSnapshotChangedError);
      stale.value = 800;
      await persist([stale]);
    })).rejects.toThrow(StateSnapshotChangedError);
    expect(store.get("row-0")?.value).toBe(700);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a controller decoding stall names its synchronous inner step", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-label-"));
  const lines: string[] = [];
  const restore = viewerLoopMonitor.setLogSink(line => lines.push(line));
  try {
    const filename = path.join(dir, "state.sqlite");
    initializeStateCollections(filename, [{ collection: "labels", schemaVersion: 1, migrationId: "one",
      key: (row: Row) => row.key, loadRecords: () => [{ key: "one", value: 1 }] }]);
    const store = new SqliteStateCollection(filename, { collection: "labels", schemaVersion: 1, busyMessage: "busy",
      key: (row: Row) => row.key, clone: structuredClone, decode: raw => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 550);
        viewerLoopMonitor.tick();
        return raw as Row;
      } });
    viewerLoopMonitor.tick();
    await store.reconcileSnapshot(() => undefined);
    const gaps = lines.filter(line => line.startsWith("[viewer loop-gap] "))
      .flatMap(line => JSON.parse(line.slice("[viewer loop-gap] ".length)).operations);
    expect(gaps).toContainEqual(expect.objectContaining({ name: "pipelines.controller-decode" }));
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test.each(["snapshot", "snapshotForController"] as const)("%s passes only the record to structuredClone and keeps returned rows independent", (method) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-snapshot-clone-"));
  try {
    const filename = path.join(dir, "state.sqlite");
    const rows: Row[] = [{ key: "one", value: 1 }, { key: "two", value: 2 }, { key: "inactive", value: -1 }];
    const options = {
      collection: "clone-test", schemaVersion: 1, busyMessage: "busy", key: (row: Row) => row.key,
      decode: (raw: unknown) => raw as Row, clone: structuredClone,
      controllerActive: (row: Row) => row.value > 0,
    };
    initializeStateCollections(filename, [{ ...options, migrationId: "clone-one", loadRecords: () => rows }]);
    const collection = new SqliteStateCollection<Row>(filename, options);
    const expected = method === "snapshot" ? rows : rows.slice(0, 2);
    const snapshot = collection[method]();
    expect(snapshot).toEqual(expected);
    snapshot[0]!.value = 99;
    expect(collection[method]()).toEqual(expected);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bounded collection pages and conditional patches stay atomic across independent connections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-store-"));
  try {
    const filename = path.join(dir, "state.sqlite");
    const options = { collection: "bounded-test", schemaVersion: 1, busyMessage: "busy", key: (row: Row) => row.key,
      decode: (raw: unknown) => raw as Row, clone: (row: Row) => ({ ...row }) };
    initializeStateCollections(filename, [{ ...options, migrationId: "one", loadRecords: () => [] }]);
    const first = new SqliteStateCollection(filename, options);
    const second = new SqliteStateCollection(filename, options);
    for (let batch = 0; batch < 10; batch++) first.boundedPatch(500, (tx) => {
      for (let n = batch * 500; n < (batch + 1) * 500; n++) tx.put({ key: `outcome/${String(n).padStart(6, "0")}`, value: n });
    });
    expect(first.keyRange("outcome/", "outcome/~", 3).map((row) => row.value)).toEqual([0, 1, 2]);
    expect(first.keyRange("outcome/000002", "outcome/~", 2).map((row) => row.value)).toEqual([3, 4]);
    const update = (store: typeof first) => store.boundedPatch(2, (tx) => {
      const held = tx.get("outcome/000000")!;
      if (held.value !== 0) return false;
      tx.put({ ...held, value: 100 });
      return true;
    });
    expect(update(first)).toBe(true);
    expect(update(second)).toBe(false);
    expect(() => first.boundedPatch(1, (tx) => {
      tx.put({ key: "rolled-back", value: 1 });
      tx.put({ key: "never", value: 2 });
    })).toThrow("budget exceeded");
    expect(second.get("rolled-back")).toBeNull();
    expect(() => first.boundedPatch(2, (tx) => { tx.delete("outcome/000000"); throw new Error("crash"); })).toThrow("crash");
    expect(second.get("outcome/000000")?.value).toBe(100);
    expect(() => first.boundedPatch(1, (tx) => {
      tx.put({ key: "authority-race", value: 1 });
      fs.writeFileSync(path.join(dir, "viewer-release.json"), JSON.stringify({ revision: "b".repeat(40), endpoint: "http://127.0.0.1:19004", hotStateBackend: "sqlite-v1" }));
      publishHotStateAuthority(dir, "fencing", "b".repeat(40));
    })).toThrow("fenced");
    expect(second.get("authority-race")).toBeNull();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("indexed host and flow owners match custody predicates and follow old-writer SQL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "controller-refs-"));
  type OwnerRow = { key: string; state: string; srcConversationId: string; srcPath: string; runs: unknown[]; [field: string]: unknown };
  const options = { collection: "pipelines", schemaVersion: 1, busyMessage: "busy", key: (row: OwnerRow) => row.key,
    decode: (raw: unknown) => raw as OwnerRow, clone: (row: OwnerRow) => structuredClone(row) };
  try {
    const filename = path.join(dir,"state.sqlite");
    initializeStateCollections(filename, [{ ...options, migrationId: "refs", loadRecords: () => [] }]);
    const store = new SqliteStateCollection(filename, options), peer = new Database(filename);
    const target = { conversationId: "shared-conversation", agentPath: "shared-transcript", paneId: "shared-pane", launchId: "shared-launch", sessionId: "shared-session" };
    const operations = [undefined, { state: "running" }, { state: "settled", result: { ok: true, sha: "head", remote: "published" } },
      { state: "settled", result: { ok: false, error: "refused" } }, { state: "settled", result: { ok: true, sha: "head", remote: "unreachable" } },
      { state: "settled", result: { ok: true, sha: "head", remote: "published", uncertain: true } },
      { state: "settled", result: { ok: true, sha: "head", remote: "published" }, executor: { finished: false } }];
    for (const state of ["passed","failed","running","pending","reviewing","committing","needs_decision"]) for (const operation of operations) {
      const row: OwnerRow = { key: "owner", state: "completed", srcConversationId: "source", srcPath: "source-path",
        ...(operation ? { delivery: { operation } } : {}),
        runs: [{ stageId: "build", attempts: [{ n: 1, ...target, state, verdict: { status: "pass" }, completedAt: "done", flowId: "flow" }] }] };
      store.boundedPatch(1, tx => tx.put(row));
      expect(store.pipelineOwnerExists([["flow","flow"]],false)).toBe(true);
      for (const [kind,identity] of Object.entries(target)) {
        expect(store.pipelineOwnerExists([[kind,identity]],true)).toBe(pipelineHostHasLiveWork([row as unknown as Pipeline], { [kind]: identity } as typeof target));
      }
      expect(store.pipelineAttemptWindow(row.key,-1,16).map(ref => ref.n)).toEqual([1]);
    }
    const encoded = peer.query<{ value_json: string }, []>("SELECT value_json FROM state_rows WHERE collection='pipelines' AND row_key='owner'").get()!.value_json;
    peer.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='owner'").run(encoded.replace('"n":1','"n":1.0'));
    expect(store.pipelineAttemptWindow("owner",0,16).map(ref => ref.n)).toEqual([1]);
    const quotedKey = "peer-a.value-r.value-h.value-'quote";
    store.boundedPatch(1, tx => tx.put({ ...store.get("owner")!, key: quotedKey }));
    for (const name of ["pipeline_refs_insert","pipeline_refs_update","pipeline_refs_delete"]) peer.exec(`DROP TRIGGER ${name}`);
    peer.exec("DROP TABLE pipeline_attempt_refs"); peer.exec("DROP TABLE pipeline_owner_refs");
    const reopened = new SqliteStateCollection(filename, options);
    expect(reopened.pipelineOwnerExists([["flow","flow"]],false)).toBe(true);
    expect(reopened.pipelineAttemptWindow("owner",-1,16)).toHaveLength(1);
    expect(reopened.pipelineAttemptWindow(quotedKey,-1,16)).toHaveLength(1);
    peer.query("DELETE FROM state_rows WHERE collection='pipelines' AND row_key=?").run(quotedKey);
    peer.exec("CREATE TABLE ref_write_probe(n INTEGER)");
    peer.exec("CREATE TRIGGER ref_write_probe AFTER INSERT ON pipeline_owner_refs BEGIN INSERT INTO ref_write_probe VALUES(1); END");
    peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.stateDetail','ordinary metadata') WHERE collection='pipelines' AND row_key='owner'").run();
    expect(peer.query("SELECT count(*) AS n FROM ref_write_probe").get()).toEqual({ n: 0 });
    peer.exec("BEGIN IMMEDIATE");
    peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.runs',json('[]')) WHERE collection='pipelines' AND row_key='owner'").run();
    expect(store.pipelineOwnerExists([["flow","flow"]],false)).toBe(true);
    peer.exec("ROLLBACK");
    expect(store.pipelineOwnerExists([["flow","flow"]],false)).toBe(true);
    peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.runs',json('[]')) WHERE collection='pipelines' AND row_key='owner'").run();
    expect(store.pipelineOwnerExists([["flow","flow"]],false)).toBe(false);
    expect(store.pipelineAttemptWindow("owner",-1,16)).toEqual([]);
    peer.query("DELETE FROM state_rows WHERE collection='pipelines' AND row_key='owner'").run();
    expect(peer.query("SELECT count(*) AS n FROM pipeline_owner_refs").get()).toEqual({ n: 0 });
    peer.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("output-only old-writer edits leave compact references intact as retained history grows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "controller-reference-writes-"));
  type Lane = { key: string; state: string; runs: { stageId: string; attempts: { n: number; conversationId: string; output: string; state: string; completedAt: string }[] }[] };
  const options = { collection: "pipelines", schemaVersion: 1, busyMessage: "busy", key: (row: Lane) => row.key,
    decode: (raw: unknown) => raw as Lane, clone: (row: Lane) => structuredClone(row) };
  try {
    const filename = path.join(dir,"state.sqlite");
    initializeStateCollections(filename,[{ ...options,migrationId: "writes",loadRecords: () => [] }]);
    const store = new SqliteStateCollection(filename,options), peer = new Database(filename);
    try {
      peer.exec("CREATE TABLE ref_write_probe(n INTEGER)");
      for (const table of ["pipeline_attempt_refs","pipeline_owner_refs"]) peer.exec(`CREATE TRIGGER probe_${table} AFTER INSERT ON ${table} BEGIN INSERT INTO ref_write_probe VALUES(1); END`);
      const samples = [];
      for (const history of [32,1024,4096]) {
        const row: Lane = { key: "large-lane",state: "paused",runs: [{ stageId: "build",attempts: Array.from({ length: history },(_,index) => ({ n: index+1,
          conversationId: `host-${index}`,state: "failed",completedAt: "done",output: "retained output ".repeat(32) })) }] };
        store.boundedPatch(1,tx => tx.put(row));
        peer.exec("DELETE FROM ref_write_probe");
        const outputMs = [];
        for (let sample = 0; sample < 3; sample++) {
          const start = performance.now();
          peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.runs[0].attempts[0].output',?) WHERE collection='pipelines' AND row_key='large-lane'").run(`new output ${sample}`);
          outputMs.push(performance.now()-start);
        }
        expect(peer.query("SELECT count(*) AS n FROM ref_write_probe").get()).toEqual({ n: 0 });
        expect(store.pipelineOwnerExists([["conversationId",`host-${history-1}`]],false)).toBe(true);
        // A real ownership change remains atomic, including rollback and an
        // older writer that updates only the JSON payload.
        const start = performance.now();
        peer.exec("BEGIN IMMEDIATE");
        peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.runs[0].attempts[0].conversationId','replacement') WHERE collection='pipelines' AND row_key='large-lane'").run();
        expect(peer.query("SELECT 1 FROM pipeline_owner_refs WHERE identity='replacement'").get()).not.toBeNull();
        expect(store.pipelineOwnerExists([["conversationId","replacement"]],false)).toBe(false);
        peer.exec("ROLLBACK");
        const ownershipMs = performance.now()-start;
        expect(store.pipelineOwnerExists([["conversationId","host-0"]],false)).toBe(true);
        samples.push({ history,outputMs,ownershipMs });
      }
      if (process.env.LLV_CONTROLLER_WRITE_EVIDENCE) fs.appendFileSync(process.env.LLV_CONTROLLER_WRITE_EVIDENCE,JSON.stringify(samples)+"\n");
    } finally { peer.close(); }
  } finally { fs.rmSync(dir,{ recursive: true,force: true }); }
},30_000);
