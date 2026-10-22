import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetBlockingWaitsForTests } from "@/lib/blockingWaits";
import { initializeStateCollections, initializeStateCollectionsAsync, injectStateWriteFaultForTests, SqliteStateCollection } from "./sqliteStateStore";
import { StateLockDeferredError, stateLockAttempt, stateLockWaitDiagnostics, stateLockWaitsInFlight, waitForStateLock } from "./lockWait";
import { lockRowOptions, type LockRow } from "./lockWait.fixture";
import { readRevision, stateDatabases } from "./durability";
import { boardFor } from "@/lib/board/store";
import { LegacyDocumentStore } from "./legacyDocumentStore";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill(); await child.exited; }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  injectStateWriteFaultForTests(null);
  resetBlockingWaitsForTests();
});

function fixture(validate?: (row: LockRow) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-lock-")); roots.push(root);
  const filename = path.join(root, "state.sqlite");
  const seed = { ...lockRowOptions, migrationId: "one", loadRecords: () => [{ key: "counter", value: 0, trace: [] } as LockRow] };
  initializeStateCollections(filename, [seed]);
  const store = new SqliteStateCollection(filename, { ...lockRowOptions, validate });
  return { root, filename, store, seed };
}

test("five zero-wait admissions produce one journal summary with exact totals", () => {
  const logs: string[] = [];
  resetBlockingWaitsForTests(line => logs.push(line));
  const clock = spyOn(performance, "now").mockReturnValue(1_000);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => stateLockAttempt("test.zero", () => { throw new StateLockDeferredError("test.zero"); }))
        .toThrow(StateLockDeferredError);
    }
    // A short-lived process must flush its unexpired window before exiting.
    process.emit("beforeExit", 0);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.slice("[blocking-wait] ".length)))
      .toMatchObject({ deferred: true, count: 5, suppressedCount: 4, stateWait: { outcome: "deferred", attempts: 1 } });
  } finally {
    clock.mockRestore();
  }
});

test("a zero-budget async admission remains a deferral, with no timeout or lost-write count", async () => {
  const logs: string[] = [];
  resetBlockingWaitsForTests(line => logs.push(line));
  const before = stateLockWaitDiagnostics();
  const clock = spyOn(performance, "now").mockReturnValue(1_000);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(waitForStateLock("test.zeroAsync", () => stateLockAttempt("test.zeroAsync", () => {
        throw new StateLockDeferredError("test.zeroAsync", "lease");
      }), { waitMs: 0 })).rejects.toBeInstanceOf(StateLockDeferredError);
    }
    process.emit("beforeExit", 0);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.slice("[blocking-wait] ".length)))
      .toMatchObject({ deferred: true, count: 5, suppressedCount: 4, stateWait: { outcome: "deferred", reason: "lease", attempts: 1 } });
    expect(stateLockWaitDiagnostics().refused).toBe(before.refused);
    expect(stateLockWaitDiagnostics().deferred - before.deferred).toBe(5);
    expect(await waitForStateLock("test.zeroAsync", () => 42, { waitMs: 0 })).toBe(42);
  } finally {
    clock.mockRestore();
  }
});

async function peer(root: string, filename: string, mode: string, argument: number, suffix = "holder") {
  const ready = path.join(root, `${suffix}.ready`), go = path.join(root, "go");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "lockWait.fixture.ts"), mode, filename, ready, go, String(argument)],
    { env: { ...process.env, NODE_ENV: "test", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const deadline = performance.now() + 10_000;
  while (!fs.existsSync(ready)) {
    if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
    if (performance.now() > deadline) throw new Error("peer readiness deadline");
    await Bun.sleep(1);
  }
  return child;
}

async function probe(operation: () => Promise<unknown>) {
  let last = performance.now(), maxGap = 0, ticks = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 5);
  try {
    await Bun.sleep(20);
    const start = performance.now();
    await operation();
    const elapsed = performance.now() - start;
    await Bun.sleep(20);
    return { elapsed, maxGap, ticks };
  } finally { clearInterval(timer); }
}

test("handled cleanup contention preserves the admission wait's call site", async () => {
  const logs: string[] = []; resetBlockingWaitsForTests(line => logs.push(line));
  const owner = process.env.LLV_STATE_OWNER, revision = process.env.LLV_HOT_STATE_RELEASE_REVISION;
  process.env.LLV_STATE_OWNER = "mcp";
  process.env.LLV_HOT_STATE_RELEASE_REVISION = "a".repeat(40);
  let ready = false;
  const release = setTimeout(() => { ready = true; }, 80);
  try {
    await waitForStateLock("test.admission", () => {
      if (!ready) stateLockAttempt("state.transaction.test", () => { throw new StateLockDeferredError("state.transaction.test"); });
      try { stateLockAttempt("state.lease.release", () => { throw new StateLockDeferredError("state.lease.release"); }); }
      catch { /* The lease owner schedules its own deferred cleanup. */ }
    });
    const completed = logs.map(line => JSON.parse(line.slice("[blocking-wait] ".length)))
      .find(entry => entry.stateWait?.outcome === "success");
    expect(completed.stateWait.callSite).toBe("state.transaction.test");
    expect(completed.stateWait.processKind).toBe("embedded");
    expect(completed.stateWait.synchronousSleepMs).toBe(0);
    expect(completed.stateWait.release).toBe("a".repeat(40));
  } finally {
    clearTimeout(release);
    if (owner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = owner;
    if (revision === undefined) delete process.env.LLV_HOT_STATE_RELEASE_REVISION; else process.env.LLV_HOT_STATE_RELEASE_REVISION = revision;
  }
});

test.each([750, 750, 750, 2000])("real writer contention yields through acquisition and commit (%i ms)", async holdMs => {
  const { root, filename, store } = fixture();
  const logs: string[] = []; resetBlockingWaitsForTests(line => logs.push(line));
  let entered = 0, acknowledged = 0;
  // Acquire the logical lease first: the competing global writer then blocks
  // persist(), which an acquisition-only fix misses.
  await store.mutate(async (rows, persist) => {
    const child = await peer(root, filename, "hold", holdMs);
    rows[0]!.value++;
    const measurement = await probe(async () => { entered++; await persist(); acknowledged++; });
    expect(await child.exited).toBe(0);
    expect(measurement.elapsed).toBeGreaterThan(holdMs - 150);
    expect(measurement.maxGap).toBeLessThanOrEqual(50);
    expect(measurement.ticks).toBeGreaterThan(10);
    console.log(JSON.stringify({ case: "persist", holdMs, ...measurement }));
  });
  expect(entered).toBe(1); expect(acknowledged).toBe(1); expect(store.get("counter")!.value).toBe(1);
  const samples = logs.map(line => JSON.parse(line.slice("[blocking-wait] ".length)));
  expect(samples.some(sample => sample.stateWait?.outcome === "waiting")).toBe(true);
  const complete = samples.filter(sample => sample.stateWait?.outcome === "success");
  expect(complete).toHaveLength(1);
  expect(complete[0].stateWait.callSite).toBe("state.transaction.lock_probe");
  expect(complete[0].stateWait.synchronousSleepMs).toBe(0);
  expect(complete[0].stateWait.maxSliceMs).toBeLessThanOrEqual(50);
  expect(complete[0].label).toBeTruthy();
  expect(stateLockWaitsInFlight()).toEqual([]);
}, 10_000);

test("same-loop lease release progresses and refused synchronous admission never enters the callback", async () => {
  const { store } = fixture();
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const held = store.mutate(async () => { acquired(); await new Promise<void>(resolve => { release = resolve; }); });
  await ready;
  let entered = 0;
  expect(() => store.boundedPatch(1, () => { entered++; })).toThrow(StateLockDeferredError);
  const timer = setTimeout(release, 100);
  try {
    const measurement = await probe(() => store.boundedPatchAsync(1, tx => { entered++; tx.put({ key: "next", value: 2, trace: [] }); }));
    expect(measurement.maxGap).toBeLessThanOrEqual(50);
    expect(entered).toBe(1);
  } finally { clearTimeout(timer); release(); await held; }
});

test("a deferred lease reports its safe holder kind and age without entering a write", async () => {
  const { store } = fixture();
  const logs: string[] = [];
  resetBlockingWaitsForTests(line => logs.push(line));
  let now = 10_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const held = store.mutate(async () => { acquired(); await new Promise<void>(resolve => { release = resolve; }); });
  let entered = 0;
  try {
    await ready;
    now += 250;
    expect(() => store.boundedPatch(1, () => { entered++; })).toThrow(StateLockDeferredError);
    process.emit("beforeExit", 0);
    const summary = logs.map(line => JSON.parse(line.slice("[blocking-wait] ".length)))
      .find(sample => sample.deferred);
    expect(summary?.stateWait.holder).toEqual({ kind: "embedded", ageMs: 250 });
    expect(entered).toBe(0);
  } finally { release(); await held; clock.mockRestore(); }
  await store.boundedPatchAsync(1, () => { entered++; });
  expect(entered).toBe(1);
});

test("first-open migration yields before seeds run and an existing schema opens during a writer hold", async () => {
  const { root, filename, seed } = fixture();
  const child = await peer(root, filename, "hold", 750);
  expect(new SqliteStateCollection(filename, lockRowOptions).get("counter")!.value).toBe(0);
  let loads = 0;
  const measurement = await probe(() => initializeStateCollectionsAsync(filename, [{ ...seed, collection: "new_collection", loadRecords: () => { loads++; return []; } }]));
  expect(await child.exited).toBe(0);
  expect(loads).toBe(1); expect(measurement.maxGap).toBeLessThanOrEqual(50);
});

test("exclusive recovery contention bounds connection, schema, marker and durability probes", async () => {
  const { root, filename } = fixture();
  const db = new Database(filename); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const copyRoot = path.join(root, "exclusive"); fs.mkdirSync(copyRoot);
  const copy = path.join(copyRoot, "state.sqlite"); fs.copyFileSync(filename, copy);
  const child = await peer(root, copy, "exclusive", 750);
  const logs: string[] = []; resetBlockingWaitsForTests(line => logs.push(line));
  const document = new LegacyDocumentStore<null>({ collection: "document", migrationId: "one", busyMessage: "busy",
    parse: () => null, toRows: () => [], fromRows: () => null, toFile: () => null, readLegacy: () => null,
    error: message => new Error(message) });
  const measurement = await probe(async () => {
    expect(() => boardFor("project", path.join(copyRoot, "board.json"))).toThrow();
    expect(() => document.read(path.join(copyRoot, "document.json"))).toThrow(StateLockDeferredError);
    expect(readRevision(stateDatabases(copyRoot)[0]!)).toStartWith("sig:");
    // Construction itself must not spin; its async owner retries before use.
    await waitForStateLock("test.firstOpen", () => new SqliteStateCollection(copy, lockRowOptions));
  });
  expect(await child.exited).toBe(0);
  expect(measurement.maxGap).toBeLessThanOrEqual(50);
  process.emit("beforeExit", 0);
  for (const site of ["state.marker", "state.durability.revision", "state.connection"]) expect(logs.some(line => line.includes(`"callSite":"${site}"`))).toBe(true);
});

test("timeouts and cancellation never invoke a pending write; callback and commit errors are never replayed", async () => {
  const { root, filename, store } = fixture();
  const child = await peer(root, filename, "hold", 500);
  const logs: string[] = []; resetBlockingWaitsForTests(line => logs.push(line));
  let entered = 0;
  await expect(store.boundedPatchAsync(1, () => { entered++; }, 80)).rejects.toThrow("timed out");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 80);
  try {
    await expect(waitForStateLock("test.cancel", () => store.boundedPatch(1, () => { entered++; }), { signal: abort.signal })).rejects.toThrow();
  } finally { clearTimeout(timer); }
  expect(entered).toBe(0);
  expect(await child.exited).toBe(0);
  for (const outcome of ["timeout", "cancelled"]) expect(logs.some(line => line.includes(`"outcome":"${outcome}"`))).toBe(true);
  await expect(store.boundedPatchAsync(1, tx => { entered++; tx.put({ key: "lost", value: 1, trace: [] }); throw new StateLockDeferredError("callback"); })).rejects.toThrow();
  expect(entered).toBe(1); expect(store.get("lost")).toBeNull();
  injectStateWriteFaultForTests({ site: "commit", collection: "lock_probe", error: new Error("database is locked"), times: 1 });
  await expect(store.mutate(async (rows, persist) => { entered++; rows[0]!.value++; await persist(); })).rejects.toThrow();
  expect(entered).toBe(2); expect(store.get("counter")!.value).toBe(0);
  await store.boundedPatchAsync(1, tx => tx.put({ key: "after", value: 2, trace: [] }));
  expect(store.get("after")!.value).toBe(2);
});

test.each(["implicit", "explicit", "structural"] as const)("%s checkpoints retain edits queued after COMMIT", async mode => {
  const { store } = fixture();
  let entered = 0, acknowledged = 0;
  await store.mutate(async (rows, persist) => {
    entered++;
    rows[0]!.value = 1;
    if (mode === "structural") rows.push({ key: "first", value: 1, trace: [] });
    queueMicrotask(() => {
      rows[0]!.value = 2;
      if (mode === "structural") rows.push({ key: "queued", value: 2, trace: [] });
    });
    await persist(mode === "explicit" ? [rows[0]!] : undefined);
    acknowledged++;
    // The first checkpoint committed before the queued edit ran.
    expect(store.get("counter")!.value).toBe(1);
    expect(rows[0]!.value).toBe(2);
    await persist();
    acknowledged++;
  });
  expect(entered).toBe(1);
  expect(acknowledged).toBe(2);
  expect(store.get("counter")!.value).toBe(2);
  if (mode === "structural") expect(store.snapshot().map(row => row.key)).toEqual(["counter", "first", "queued"]);
});

test.each(["implicit", "explicit"] as const)("%s controller checkpoints retain edits queued after COMMIT", async mode => {
  let duringWrite = () => {};
  const { store } = fixture(() => duringWrite());
  await store.reconcileSnapshot(async (rows, persist) => {
    rows[0]!.value = 1;
    // Controller checkpoints await lease admission first. Queue from inside
    // the synchronous write to reach the same post-COMMIT microtask boundary.
    duringWrite = () => {
      duringWrite = () => {};
      queueMicrotask(() => { rows[0]!.value = 2; });
    };
    await persist(mode === "explicit" ? [rows[0]!] : undefined);
    expect(store.get("counter")!.value).toBe(1);
    expect(rows[0]!.value).toBe(2);
    await persist();
  });
  expect(store.get("counter")!.value).toBe(2);
});

test.each(["implicit", "explicit", "structural"] as const)("%s checkpoint rollback preserves dirty changes for retry", async mode => {
  const { store } = fixture();
  let entered = 0, prepared = 0;
  await store.mutate(async (rows, persist) => {
    entered++;
    rows[0]!.value = 1;
    if (mode === "structural") rows.push({ key: "added", value: 1, trace: [] });
    injectStateWriteFaultForTests({ site: "commit", collection: "lock_probe", times: 1, error: new Error("database is locked") });
    await expect(persist(mode === "explicit" ? [rows[0]!] : undefined)).rejects.toThrow("database is locked");
    expect(store.get("counter")!.value).toBe(0);
    expect(store.get("added")).toBeNull();
    expect(prepared).toBe(1);
    await persist();
  }, () => { prepared++; });
  expect(entered).toBe(1);
  expect(prepared).toBe(2);
  expect(store.get("counter")!.value).toBe(1);
  if (mode === "structural") expect(store.get("added")!.value).toBe(1);
});

test("four independent writers retain all 400 ordered writes, revisions and change-log entries", async () => {
  const { root, filename, store } = fixture();
  const peers = [];
  for (let writer = 0; writer < 4; writer++) peers.push(await peer(root, filename, "writer", writer, `writer-${writer}`));
  const revision = store.revision();
  fs.writeFileSync(path.join(root, "go"), "go");
  for (const child of peers) {
    expect(await child.exited).toBe(0);
    const result = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").at(-1)!);
    expect(result.maxGap).toBeLessThanOrEqual(50);
    console.log(JSON.stringify(result));
  }
  const row = store.get("counter")!;
  expect(row.value).toBe(400); expect(new Set(row.trace.map(entry => entry.join(":"))).size).toBe(400);
  for (let writer = 0; writer < 4; writer++) expect(row.trace.filter(entry => entry[0] === writer).map(entry => entry[1])).toEqual(Array.from({ length: 100 }, (_, i) => i));
  expect(store.revision()).toBe(revision + 400);
  expect(store.changesAfter(revision, "", 512).entries).toHaveLength(400);
  const db = new Database(filename, { readonly: true });
  try { expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM state_leases").get()!.n).toBe(0); }
  finally { db.close(); }
}, 30_000);
