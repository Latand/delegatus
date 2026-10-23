import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { initializeStateCollections, SqliteStateCollection, StateSnapshotChangedError } from "./sqliteStateStore";
import { publishHotStateAuthority } from "./hotStateAuthority";
import { pipelineHostHasLiveWork } from "@/lib/pipelines/hostRetirement";
import type { Pipeline } from "@/lib/pipelines/types";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import { assertStateChildSuccess } from "./stateChildResult.fixture";

type Row = { key: string; value: number };

test("bounded task project evidence seeks only selected projects and shares the write budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-task-evidence-"));
  const filename = path.join(dir, "state.sqlite");
  type Task = Row & { project: string };
  let decoded = 0;
  const options = { collection: "tasks", schemaVersion: 1, busyMessage: "busy", key: (row: Task) => row.key,
    clone: structuredClone, decode: (raw: unknown) => { decoded++; return raw as Task; } };
  const rows = [
    { key: "one", project: "old", value: 1 }, { key: "two", project: "current", value: 2 },
    ...Array.from({ length: 2_000 }, (_, n) => ({ key: `foreign-${n}`, project: "other", value: n })),
  ];
  let store: SqliteStateCollection<Task> | undefined;
  try {
    initializeStateCollections(filename, [{ ...options, migrationId: "evidence", loadRecords: () => rows }]);
    store = new SqliteStateCollection<Task>(filename, options);
    decoded = 0;
    store.boundedPatch(5, tx => {
      expect(tx.taskProjectRows(["current", "old", "current"]).map(row => row.key)).toEqual(["two", "one"]);
      tx.put({ key: "admitted", project: "current", value: 3 });
    });
    expect(decoded).toBe(2);
    expect(() => store!.boundedPatch(5, tx => {
      tx.taskProjectRows(["current", "old"]);
      tx.put({ key: "refused", project: "current", value: 4 });
    })).toThrow("budget");
    expect(store.get("refused")).toBeNull();
    const db = new Database(filename);
    try {
      const plan = db.query<{ detail: string }, [string, number]>(`EXPLAIN QUERY PLAN
        SELECT value_json FROM state_rows INDEXED BY state_rows_task_project
        WHERE collection='tasks' AND json_valid(value_json) AND json_extract(value_json,'$.project')=?
        ORDER BY row_key LIMIT ?`).all("current", 16);
      expect(plan.some(row => row.detail.includes("SEARCH") && row.detail.includes("state_rows_task_project"))).toBe(true);
      expect(plan.some(row => /SCAN|TEMP B-TREE/.test(row.detail))).toBe(false);
    } finally { db.close(); }
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bounded companion writes commit together, rollback together and share a finite budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-companion-"));
  const filename = path.join(dir, "state.sqlite");
  const options = (collection: string) => ({ collection, schemaVersion: 1, busyMessage: "busy", key: (row: Row) => row.key,
    clone: structuredClone, decode: (raw: unknown) => raw as Row });
  initializeStateCollections(filename, ["first", "second"].map(name => ({ ...options(name), migrationId: name, loadRecords: () => [] })));
  const first = new SqliteStateCollection<Row>(filename, options("first"));
  const second = new SqliteStateCollection<Row>(filename, options("second"));
  try {
    const put = (budget: number, crash = false) => first.boundedPatch(budget, tx => {
      tx.put({ key: "task", value: 1 });
    }, undefined, { collection: second, prepare: () => {
      if (crash) throw new Error("crash after task write");
      return { records: [{ key: "allowance", value: 2 }] };
    } });
    expect(() => put(2, true)).toThrow("crash after task write");
    expect(first.get("task")).toBeNull();
    expect(second.get("allowance")).toBeNull();
    expect(() => put(1)).toThrow("budget");
    expect(first.get("task")).toBeNull();
    expect(second.get("allowance")).toBeNull();
    put(2);
    expect(first.get("task")?.value).toBe(1);
    expect(second.get("allowance")?.value).toBe(2);
    // Reverse collection order must take the same two leases in the same order.
    second.boundedPatch(2, tx => tx.put({ key: "allowance", value: 3 }), undefined,
      { collection: first, prepare: () => ({ records: [{ key: "task", value: 4 }] }) });
    expect(first.get("task")?.value).toBe(4);
    expect(second.get("allowance")?.value).toBe(3);
  } finally { first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

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
    onDecode = () => {};
    authority = 30;
    await store.reconcileSnapshot(async (records,persist,assertCurrent) => {
      await Promise.resolve();
      authority = 40;
      expect(() => assertCurrent(records[0]!)).toThrow(StateSnapshotChangedError);
      records[0]!.value = 999;
      await expect(persist(records)).rejects.toThrow(StateSnapshotChangedError);
    }, undefined, true, ["row-0"]);
    expect(store.get("row-0")?.value).toBe(540);
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

test("a fresh process upgrades the pre-compact reference schema before ordinary reads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "controller-reference-upgrade-"));
  const filename = path.join(dir, "state.sqlite");
  const row = { key: "legacy-lane", state: "paused", runs: [{ stageId: "build", attempts: [
    { n: 1, conversationId: "legacy-host", state: "failed", completedAt: "done", output: "retained" },
  ] }] };
  const options = { collection: "pipelines", schemaVersion: 1, busyMessage: "busy", key: (value: typeof row) => value.key,
    decode: (raw: unknown) => raw as typeof row, clone: (value: typeof row) => structuredClone(value) };
  try {
    initializeStateCollections(filename, [{ ...options, migrationId: "legacy", loadRecords: () => [row] }]);
    const db = new Database(filename);
    // The previous schema has reference tables and the delete sentinel, but
    // maintains references directly from state_rows, without compact inputs.
    for (const name of ["pipeline_refs_insert", "pipeline_refs_update", "pipeline_ref_inputs_insert", "pipeline_ref_inputs_update"]) db.exec(`DROP TRIGGER ${name}`);
    db.exec("DROP TRIGGER pipeline_refs_delete");
    db.exec("DROP TABLE pipeline_ref_inputs");
    db.exec("CREATE TRIGGER pipeline_refs_delete AFTER DELETE ON state_rows WHEN OLD.collection='pipelines' BEGIN DELETE FROM pipeline_attempt_refs WHERE row_key=OLD.row_key; DELETE FROM pipeline_owner_refs WHERE row_key=OLD.row_key; END");
    const before = db.query("SELECT * FROM state_rows").all();
    db.close();
    const result = spawnSync(process.execPath, ["--eval", `
      const { SqliteStateCollection } = await import(${JSON.stringify(path.resolve("src/lib/state/sqliteStateStore.ts"))});
      const store = new SqliteStateCollection(process.env.UPGRADE_DATABASE, {
        collection: 'pipelines', schemaVersion: 1, busyMessage: 'busy',
        key: row => row.key, decode: row => row, clone: row => structuredClone(row),
      });
      if (!store.pipelineOwnerExists([['conversationId','legacy-host']],false)) throw new Error('missing backfill');
    `], { env: { ...process.env, UPGRADE_DATABASE: filename }, encoding: "utf8", timeout: 10_000 });
    assertStateChildSuccess(result.status, result.stderr);
    const upgraded = new Database(filename);
    try {
      expect(upgraded.query("SELECT * FROM state_rows").all()).toEqual(before);
      expect(upgraded.query("SELECT row_key FROM pipeline_ref_inputs").all()).toEqual([{ row_key: row.key }]);
      expect(upgraded.query("SELECT stageId,n FROM pipeline_attempt_refs").all()).toEqual([{ stageId: "build", n: 1 }]);
      upgraded.exec("CREATE TABLE ref_upgrade_probe(n INTEGER)");
      for (const table of ["pipeline_attempt_refs", "pipeline_owner_refs"]) upgraded.exec(`CREATE TRIGGER probe_${table} AFTER INSERT ON ${table} BEGIN INSERT INTO ref_upgrade_probe VALUES(1); END`);
      upgraded.query("UPDATE state_rows SET value_json=json_set(value_json,'$.runs[0].attempts[0].output','new output') WHERE collection='pipelines'").run();
      expect(upgraded.query("SELECT count(*) AS n FROM ref_upgrade_probe").get()).toEqual({ n: 0 });
    } finally { upgraded.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("paged moves preserve an identical target row under its own key selector", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collection-move-keys-"));
  const filename = path.join(dir, "state.sqlite");
  const row: Row = { key: "one", value: 1 };
  const sourceOptions = { collection: "source", schemaVersion: 1, busyMessage: "busy",
    key: (value: Row) => value.key, decode: (value: unknown) => value as Row, clone: (value: Row) => structuredClone(value) };
  const targetOptions = { ...sourceOptions, collection: "target", key: (value: Row) => `target-${value.key}` };
  try {
    initializeStateCollections(filename, [sourceOptions, targetOptions].map(options => ({
      ...options, migrationId: "one", loadRecords: () => [row],
    })));
    const source = new SqliteStateCollection(filename, sourceOptions);
    const target = new SqliteStateCollection(filename, targetOptions);
    const revision = target.revision();
    expect(await source.moveMatchingTo(target, () => true)).toBe(1);
    expect(source.snapshot()).toEqual([]);
    expect(target.get("target-one")).toEqual(row);
    expect(target.revision()).toBe(revision);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
