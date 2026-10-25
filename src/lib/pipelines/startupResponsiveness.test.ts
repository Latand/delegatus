import { stateLeaseHoldsInFlight } from "@/lib/state/sqliteStateStore";
import * as stateStore from "@/lib/state/sqliteStateStore";
import { afterEach, expect, spyOn, test } from "bun:test";
import { performanceSites, performanceSpans } from "@/lib/performanceSpans";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { spawn } from "node:child_process";

import { buildPipeline, loadPipelinesForStartup, loadPipelinesForStartupAsync, loadPipelineOwnershipForStartupAsync, pipelineRegistryHealth, pipelineRegistryHealthAsync, savePipelines, withPipelineMutation, withPipelineStartupAdmission } from "./store";
import { StateLockDeferredError, stateLockProcessKind, stateLockWaitsInFlight, waitForStateLock } from "@/lib/state/lockWait";
import { createViewerLoopMonitor } from "@/lib/viewerLoopMonitor";

const original = process.env.LLV_STATE_DIR;

const roots: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-responsiveness-"));
  roots.push(root); process.env.LLV_STATE_DIR = root;
  const row = buildPipeline({ id: "seed0001", task: "synthetic ownership evidence", project: "synthetic", repoDir: "/repo",
    stages: [{ id: "build", kind: "run", prompt: "build", next: null, effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
  savePipelines([row]);
  return { root, row };
}

test("production-sized startup bursts yield between leases", async () => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    db.exec("BEGIN IMMEDIATE");
    db.query("DELETE FROM state_rows WHERE collection IN ('pipelines','pipelines_archive')").run();
    const insert = db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES(?,?,?,?,1,0)");
    for (const [collection, count, bytes] of [["pipelines", 305, 34125185], ["pipelines_archive", 499, 61216839]] as const) {
      for (let i = 0; i < count; i++) {
        const id = `${collection}-${i}`;
        const record = { ...row, id, worktreeDir: `/repo-pipeline-${id}`, branch: `pipeline/synthetic-ownership-evidence-${id}`, padding: "" };
        const target = Math.floor(bytes / count) + (i < bytes % count ? 1 : 0);
        record.padding = "x".repeat(target - JSON.stringify(record).length);
        insert.run(collection, id, JSON.stringify(record), i);
      }
      db.query("UPDATE state_collections SET revision=revision+1 WHERE collection=?").run(collection);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  for (const [count, evidence] of [[64, false], [96, false], [32, true]] as const) {
    let completed = 0, observed = 0, maxHoldMs = 0;
    const ticks: Array<ReturnType<typeof setImmediate>> = [];
    try {
      const outcomes = await Promise.all(Array.from({ length: count }, () => withPipelineStartupAdmission(async available => {
        expect(available).toBeTrue();
        expect(observed, "the preceding lease must yield before this callback").toBe(completed);
        const ordinal = ++completed;
        ticks.push(setImmediate(() => { observed = ordinal; }));
        if (evidence) { expect(loadPipelinesForStartup()).toHaveLength(804); expect(pipelineRegistryHealth()).toEqual([]); }
        return true;
      }, "synthetic startup", held => { maxHoldMs = Math.max(maxHoldMs, held); })));
      console.info(JSON.stringify({ case: `startup-${count}-${evidence}`, completed, maxHoldMs }));
      expect(outcomes.every(Boolean)).toBeTrue();
      expect(completed).toBe(count);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(observed).toBe(count);
    } finally { for (const tick of ticks) clearImmediate(tick); }
  }
}, 120_000);

test("a completed blocking operation remains named at the delayed tick", async () => {
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line));
  monitor.start();
  try {
    monitor.run("files.health", () => Bun.sleepSync(600));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length));
    expect(event.gapMs).toBeGreaterThan(500);
    expect(event.operations).toContainEqual(expect.objectContaining({ name: "files.health", completed: true }));
  } finally { monitor.stop(); }
});

test("durable hold measurement includes time before the first await continuation", async () => {
  fixture();
  let heldMs = 0;
  const lines: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args) => { lines.push(args); };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const pending = withPipelineStartupAdmission(async () => { entered.resolve(); await release.promise; return true; }, "reconciling structured hosts", held => { heldMs = held; });
  try {
    await entered.promise;
    expect(stateLeaseHoldsInFlight().some(held => held.collection === "pipelines")).toBe(true);
    Bun.sleepSync(1100);
    release.resolve();
    expect(await pending).toBeTrue();
    expect(heldMs).toBeGreaterThan(1000);
    expect(lines).toContainEqual(["[state lease-hold]", expect.objectContaining({ collection: "pipelines", operation: "pipelines.startup-admission", heldMs: expect.any(Number) })]);
    const warning = lines.map(([message]) => String(message))
      .find(message => message.startsWith("[structured hosts] state lease exceeded budget "))!;
    expect(warning).toBeDefined();
    expect(warning).not.toMatch(/[\r\n]/);
    expect(JSON.parse(warning.slice("[structured hosts] state lease exceeded budget ".length)))
      .toMatchObject({ pid: process.pid, role: process.env.LLV_STATE_OWNER ?? stateLockProcessKind(), phase: "reconciling structured hosts" });
  } finally { release.resolve(); await pending; console.warn = warn; }
});

test.each([false, true])("a foreign commit refreshes prepared evidence within the original admission (compact=%s)", async compact => {
  const { row } = fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const writer = withPipelineMutation(async (records, persist) => {
    entered(); await wait;
    const newOwner = { ...row, id: "new-owner", worktreeDir: "/repo-pipeline-new-owner", branch: "pipeline/synthetic-ownership-evidence-new-owner" };
    await persist([...records, newOwner]);
  });
  await ready;
  let calls = 0;
  const reader = withPipelineStartupAdmission(async available => {
    calls++;
    expect(available).toBeTrue();
    expect((compact ? await loadPipelineOwnershipForStartupAsync() : loadPipelinesForStartup()).map(record => record.id)).toContain("new-owner");
    return available;
  }, undefined, undefined, compact);
  try { await waitingAdmission(); }
  finally { release(); }
  await writer;
  expect(await reader).toBeTrue();
  expect(calls).toBe(1);
  expect(await withPipelineStartupAdmission(async available => {
    expect(available).toBeTrue();
    expect((compact ? await loadPipelineOwnershipForStartupAsync() : loadPipelinesForStartup()).map(record => record.id)).toContain("new-owner");
    return true;
  }, undefined, undefined, compact)).toBeTrue();
});

test.each(["pipelines", "pipelines_archive"])("fresh asynchronous evidence refuses corrupt %s and preserves unknown owners", async collection => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  const value = JSON.stringify({ ...row, state: "future-owner" });
  try {
    db.query("DELETE FROM state_rows WHERE collection='pipelines'").run();
    db.query("INSERT OR REPLACE INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES(?,?,?,0,2,0)")
      .run(collection, row.id, value);
    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection=?").run(collection);
    expect(await pipelineRegistryHealthAsync()).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
    expect(await withPipelineStartupAdmission(async available => {
      expect(available).toBeTrue();
      expect(loadPipelinesForStartup()).toEqual([]);
      expect(pipelineRegistryHealth()).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
      return true;
    })).toBeTrue();
    // Direct corruption need not bump a revision. The next read is fresh.
    db.query("UPDATE state_rows SET value_json='{broken' WHERE collection=?").run(collection);
    expect(await withPipelineStartupAdmission(async available => available)).toBeFalse();
    await expect(pipelineRegistryHealthAsync()).rejects.toThrow(`corrupt ${collection} SQLite row`);
    expect(db.query("SELECT value_json FROM state_rows WHERE collection=?").get(collection)).toEqual({ value_json: "{broken" });
  } finally { db.close(); }
});

test("admitted copies stay independent and a callback failure is never replayed", async () => {
  fixture();
  let callbacks = 0;
  await expect(withPipelineStartupAdmission(async available => {
    callbacks++;
    expect(available).toBeTrue();
    const first = loadPipelinesForStartup();
    first[0]!.stages[0]!.prompt = "local change";
    expect(loadPipelinesForStartup()[0]!.stages[0]!.prompt).toBe("build");
    throw new Error("admitted callback refused");
  })).rejects.toThrow("admitted callback refused");
  expect(callbacks).toBe(1);
});

test("ready evidence callbacks yield between leases instead of draining one timer batch", async () => {
  fixture();
  let completed = 0, observed = 0;
  const ticks: Array<ReturnType<typeof setImmediate>> = [];
  try {
    await Promise.all(Array.from({ length: 32 }, () => withPipelineStartupAdmission(async available => {
      expect(available).toBeTrue();
      expect(observed, "the preceding lease must yield before this callback").toBe(completed);
      const ordinal = ++completed;
      ticks.push(setImmediate(() => { observed = ordinal; }));
      Bun.sleepSync(15);
    })));
    expect(completed).toBe(32);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(observed).toBe(32);
  } finally { for (const tick of ticks) clearImmediate(tick); }
});

test("a descendant async context cannot reuse evidence after its admission ends", async () => {
  const { root } = fixture();
  let readLater!: () => Promise<unknown>;
  await withPipelineStartupAdmission(async available => {
    expect(available).toBeTrue();
    const { AsyncResource } = await import("node:async_hooks");
    const descendant = new AsyncResource("synthetic-admission-descendant");
    readLater = () => descendant.runInAsyncScope(pipelineRegistryHealthAsync);
  });
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.query("UPDATE state_rows SET value_json='{broken' WHERE collection='pipelines'").run(); }
  finally { db.close(); }
  await expect(readLater()).rejects.toThrow("corrupt pipelines SQLite row");
});

test("zero-wait admission permits a free lease and refuses a queued callback", async () => {
  fixture();
  const waitMs = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "0";
  try {
    expect(await withPipelineStartupAdmission(async available => available)).toBeTrue();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const owner = withPipelineStartupAdmission(async available => { entered(); await wait; return available; });
    await ready;
    try { expect(await withPipelineStartupAdmission(async available => available)).toBeFalse(); }
    finally { release(); }
    expect(await owner).toBeTrue();
  } finally {
    if (waitMs === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS; else process.env.LLV_PIPELINE_LOCK_WAIT_MS = waitMs;
  }
});

test("a warm health witness observes direct writes with unchanged revisions and database replacement", async () => {
  const { root, row } = fixture();
  expect(await pipelineRegistryHealthAsync()).toEqual([]);
  expect(await pipelineRegistryHealthAsync()).toEqual([]);
  const filename = path.join(root, "state.sqlite");
  const db = new Database(filename);
  try {
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines'").run(JSON.stringify({ ...row, state: "future-owner" }));
    expect(await pipelineRegistryHealthAsync()).toMatchObject([{ reason: "unknown-but-preserved" }]);
    const result = await pipelineRegistryHealthAsync();
    result.length = 0;
    expect(await pipelineRegistryHealthAsync()).toHaveLength(1);
    db.query("UPDATE state_rows SET value_json='{broken' WHERE collection='pipelines'").run();
    await expect(pipelineRegistryHealthAsync()).rejects.toThrow("corrupt pipelines SQLite row");
  } finally { db.close(); }
  // The new file can have the same collection revision and data_version.
  const replacement = path.join(root, "replacement.sqlite");
  const copy = new Database(replacement);
  try {
    copy.exec("CREATE TABLE state_collections(collection TEXT PRIMARY KEY, revision INTEGER)");
    copy.exec("CREATE TABLE state_rows(collection TEXT, row_key TEXT, row_order INTEGER, value_json TEXT)");
    copy.exec("INSERT INTO state_collections VALUES ('pipelines',1),('pipelines_archive',1)");
  } finally { copy.close(); }
  fs.renameSync(filename, path.join(root, "retired.sqlite"));
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, path.join(root, "retired.sqlite" + suffix));
  }
  fs.renameSync(replacement, filename);
  expect(await pipelineRegistryHealthAsync()).toEqual([]);
});

test("asynchronous evidence copies preserve nested isolation and batch project aliases", async () => {
  const { root, row } = fixture();
  fs.writeFileSync(path.join(root, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: { synthetic: "canonical" }, displayNames: {} }));
  const [first, second] = await Promise.all([loadPipelinesForStartupAsync(), loadPipelinesForStartupAsync()]);
  expect(first).toEqual(second);
  expect(first[0]!.project).toBe("canonical");
  first[0]!.stages[0]!.prompt = "independent";
  first[0]!.taskIds.push("local");
  expect(second[0]!.stages[0]!.prompt).toBe(row.stages[0]!.prompt);
  expect(second[0]!.taskIds).toEqual([]);
});

test("compact ownership preserves unknown owners, duplicate detection and independent copies", async () => {
  const { root, row } = fixture();
  const first = await loadPipelineOwnershipForStartupAsync();
  first[0]!.attempts.push({ conversationId: "conversation_synthetic", state: "passed" });
  expect((await loadPipelineOwnershipForStartupAsync())[0]!.attempts).toEqual([]);
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines'").run(JSON.stringify({ ...row, state: "future-owner" }));
    expect(await withPipelineStartupAdmission(async available => {
      expect(available).toBe(true);
      expect(await loadPipelineOwnershipForStartupAsync()).toEqual([]);
      expect(await pipelineRegistryHealthAsync()).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
      return true;
    }, undefined, undefined, true)).toBe(true);
    db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive','duplicate',?,0,1,0)").run(JSON.stringify(row));
    expect(await withPipelineStartupAdmission(async available => available, undefined, undefined, true)).toBe(false);
    await expect(pipelineRegistryHealthAsync()).rejects.toThrow("contradictory identities");
  } finally { db.close(); }
});

async function waitingAdmission() {
  const deadline = performance.now() + 5000;
  while (!stateLockWaitsInFlight().some(wait => ["pipelines.startup-admission", "state.lease"].includes(wait.callSite) && wait.attempts > 1)) {
    if (performance.now() >= deadline) throw new Error("reader never reached contended admission");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test("an admitted typed refusal is not replayed or converted to unavailable", async () => {
  fixture();
  let calls = 0;
  const refusal = new StateLockDeferredError("synthetic.callback");
  await expect(withPipelineStartupAdmission(async () => { calls++; throw refusal; })).rejects.toBe(refusal);
  expect(calls).toBe(1);
});

test("a typed lease observer failure cannot replay an admitted callback", async () => {
  fixture();
  let effects = 0;
  const refusal = new StateLockDeferredError("synthetic.observer");
  await expect(withPipelineStartupAdmission(async () => { effects++; }, "startup evidence", () => { throw refusal; })).rejects.toBe(refusal);
  expect(effects).toBe(1);
});

test("an admitted callback's other resource wait gets its own admission", async () => {
  fixture();
  let effects = 0, attempts = 0;
  await withPipelineStartupAdmission(async available => {
    expect(available).toBeTrue(); effects++;
    expect(stateLockWaitsInFlight().some(wait => wait.callSite === "pipelines.startup-admission")).toBeFalse();
    await waitForStateLock("synthetic.registry", () => {
      if (++attempts === 1) throw new StateLockDeferredError("synthetic.registry");
    });
  });
  expect(effects).toBe(1);
  expect(attempts).toBe(2);
});

test.each([["deadline", "mutation"], ["cancel", "mutation"], ["deadline", "admission"], ["cancel", "admission"]] as const)("startup admission stops at its %s behind a held %s without invoking a writer", async (mode, holder) => {
  fixture();
  const saved = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = mode === "deadline" ? "200" : "5000";
  const held = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const hold = async () => { ready.resolve(); await held.promise; };
  const owner = holder === "mutation" ? withPipelineMutation(hold) : withPipelineStartupAdmission(hold);
  await ready.promise;
  const abort = new AbortController();
  let admitted = 0, refused = 0;
  const reader = withPipelineStartupAdmission(async available => {
    if (available) admitted++; else refused++;
    return available;
  }, "reconciling structured hosts", undefined, true, { signal: abort.signal });
  // Observe rejections immediately while the handshake is pending.
  const result = reader.then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    await waitingAdmission();
    if (mode === "cancel") abort.abort(new Error("retired during admission"));
    const outcome = await result;
    expect(admitted).toBe(0);
    expect(refused).toBe(mode === "deadline" ? 1 : 0);
    if (mode === "cancel") expect(outcome.error?.message).toBe("retired during admission");
    else expect(outcome.value).toBeFalse();
  } finally {
    held.resolve(); await owner; await result;
    if (saved === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS; else process.env.LLV_PIPELINE_LOCK_WAIT_MS = saved;
  }
  expect(await withPipelineStartupAdmission(async available => available)).toBeTrue();
});


const DEADLINE_FIXTURE = path.join(import.meta.dir, "fixtures/startupAdmissionDeadline.ts");

function assertAdmissionBudget(elapsedMs: number, budgetMs: number): void {
  const toleranceMs = 300;
  if (elapsedMs > budgetMs + toleranceMs) {
    throw new Error(`startup admission exceeded ${budgetMs} ms budget plus ${toleranceMs} ms tolerance: ${Math.round(elapsedMs)} ms`);
  }
}

async function runDeadlineFixture(mode: "deadline" | "sync-block" | "cold-legacy" | "cold-sqlite" | "cold-cancel", actualWaitMs: number, parentDeadlineMs: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-admission-child-"));
  const childHome = path.join(root, "home"), childConfig = path.join(root, "config"), childTmp = path.join(root, "tmp");
  for (const directory of [childHome, childConfig, childTmp]) fs.mkdirSync(directory, { recursive: true });
  const child = spawn(process.execPath, [DEADLINE_FIXTURE, mode, root, String(actualWaitMs)], {
    env: { ...process.env, HOME: childHome, XDG_CONFIG_HOME: childConfig, TMPDIR: childTmp,
      LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = Promise.withResolvers<void>();
  const report = Promise.withResolvers<Record<string, number | boolean>>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    if (line === "READY") ready.resolve();
    else {
      output += `${line}\n`;
      try { report.resolve(JSON.parse(line) as Record<string, number | boolean>); }
      catch { /* Preserve diagnostics for the parent assertion below. */ }
    }
  });
  const errors: string[] = [];
  child.stderr.setEncoding("utf8").on("data", chunk => { errors.push(String(chunk)); });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready.promise, once(child, "exit").then(([code]) => { throw new Error(`fixture exited ${code} before readiness: ${errors.join("")}`); }),
      new Promise<never>((_, reject) => { readyTimer = setTimeout(() => reject(new Error("fixture readiness handshake timed out")), 30_000); })]);
    if (readyTimer) clearTimeout(readyTimer);
    const start = performance.now();
    const result = await Promise.race([
      report.promise.then(value => ({ kind: "report" as const, value })),
      new Promise<{ kind: "watchdog" }>(resolve => { watchdog = setTimeout(() => resolve({ kind: "watchdog" }), parentDeadlineMs); }),
    ]);
    return { result, elapsedMs: performance.now() - start, output, errors, child };
  } finally {
    if (readyTimer) clearTimeout(readyTimer);
    if (watchdog) clearTimeout(watchdog);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 500);
      await once(child, "exit");
      clearTimeout(force);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("repeated evidence invalidation spends the configured deadline across a process boundary", async () => {
  const result = await runDeadlineFixture("deadline", 500, 3_000);
  expect(result.result.kind).toBe("report");
  if (result.result.kind !== "report") throw new Error(`parent watchdog expired: ${result.errors.join("")}`);
  const elapsedMs = Number(result.result.value.elapsedMs);
  expect(() => assertAdmissionBudget(elapsedMs, 500)).not.toThrow();
  expect(result.result.value.invalidations).toBeGreaterThan(1);
  expect(result.result.value.admitted).toBe(false);
  expect(result.result.value.refused).toBe(true);
  expect(result.result.value.recovered).toBe(true);
}, 10_000);

test.each(["cold-legacy", "cold-sqlite"] as const)("cold %s evidence refuses within its admission budget and recovers", async mode => {
  const result = await runDeadlineFixture(mode, 50, 15_000);
  expect(result.result.kind).toBe("report");
  if (result.result.kind !== "report") throw new Error(`cold preparation exceeded parent watchdog: ${result.errors.join("")}`);
  expect(result.result.value.admitted).toBe(false);
  expect(result.result.value.recovered).toMatchObject({ available: true });
  expect(Number(result.result.value.elapsedMs)).toBeLessThanOrEqual(350);
  if (mode === "cold-legacy") expect(result.result.value.storeInitialized).toBe(false);
}, 30_000);

test("cancellation interrupts cold evidence preparation and a later admission recovers", async () => {
  const result = await runDeadlineFixture("cold-cancel", 5_000, 15_000);
  expect(result.result.kind).toBe("report");
  if (result.result.kind !== "report") throw new Error(`cancelled preparation exceeded parent watchdog: ${result.errors.join("")}`);
  expect(result.result.value.cancelled).toBe(true);
  expect(result.result.value.admitted).toBe(false);
  expect(result.result.value.recovered).toMatchObject({ available: true });
  expect(Number(result.result.value.elapsedMs)).toBeLessThan(1_000);
}, 30_000);

test("the parent rejects a fourfold admission overrun and remains responsive to a blocked child", async () => {
  const overrun = await runDeadlineFixture("deadline", 2_000, 3_000);
  expect(overrun.result.kind).toBe("report");
  if (overrun.result.kind !== "report") throw new Error(`overrun fixture exceeded parent watchdog: ${overrun.errors.join("")}`);
  const overrunMs = Number(overrun.result.value.elapsedMs);
  expect(() => assertAdmissionBudget(overrunMs, 500)).toThrow("startup admission exceeded 500 ms budget");

  const blocked = await runDeadlineFixture("sync-block", 500, 800);
  expect(blocked.result.kind).toBe("watchdog");
  expect(blocked.elapsedMs).toBeLessThan(1_200);
}, 10_000);

function retainedHistory(db: Database, row: ReturnType<typeof fixture>["row"]) {
  const insert = db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive',?,?,?,1,0)");
  for (let i = 0; i < 48; i++) {
    const id = "retained-evidence-" + i;
    insert.run(id, JSON.stringify({ ...row, id, worktreeDir: "/repo-pipeline-" + id, branch: "pipeline/synthetic-ownership-evidence-" + id }), i);
  }
}

function observeEvidenceDecodes() {
  let rows = 0;
  performanceSpans.observeSite(site => { if (site === performanceSites.indexOf("state.json")) rows++; });
  return { rows: () => rows, reset: () => { rows = 0; }, stop: () => performanceSpans.observeSite() };
}

test.each(["before-write", "after-write"] as const)("history evidence joining a completed read rechecks freshness (%s)", async order => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  const originalRead = stateStore.readCompactPipelineEvidence;
  const entered = Promise.withResolvers<void>();
  let injected = false;
  let afterWrite!: Promise<{ issues: unknown[] } | { error: string }>;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation((async (...args: Parameters<typeof originalRead>) => {
    const result = await originalRead(...args);
    if (!injected) {
      injected = true;
      // The producer checks its signature between these microtasks. Exercise
      // both write/join orders while the completed read is still shared.
      queueMicrotask(() => queueMicrotask(() => {
        const join = () => pipelineRegistryHealthAsync().then(issues => ({ issues }), error => ({ error: error.message }));
        if (order === "before-write") afterWrite = join();
        db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
          .run(JSON.stringify({ ...row, state: "future-owner" }), row.id);
        if (order === "after-write") afterWrite = join();
        entered.resolve();
      }));
    }
    return result;
  }) as typeof originalRead);
  const first = pipelineRegistryHealthAsync().then(() => undefined, () => undefined);
  try {
    await entered.promise;
    const result = await afterWrite;
    // A fresh independent read is also valid if pending-entry cleanup moves.
    if ("issues" in result) expect(result.issues).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
    else expect(result.error).toBe("pipeline evidence changed during preparation");
    await first;
    expect(await pipelineRegistryHealthAsync()).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
  } finally { await first; read.mockRestore(); db.close(); }
});

test.each([
  ["health", "ownership", 1], ["ownership", "health", 1],
  ["startup", "health", 1], ["startup", "ownership", 1],
  ["health", "startup", 2], ["ownership", "startup", 2],
] as const)("history evidence shares compatible modes only (%s then %s)", async (firstMode, secondMode, reads) => {
  const { row } = fixture();
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const readers = {
    health: pipelineRegistryHealthAsync,
    ownership: loadPipelineOwnershipForStartupAsync,
    startup: loadPipelinesForStartupAsync,
  };
  let snapshots = 0;
  const originalCompact = stateStore.readCompactPipelineEvidence;
  const originalFull = stateStore.visitStateCollectionsRows;
  const compact = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation((async (...args: Parameters<typeof originalCompact>) => {
    snapshots++;
    const result = await originalCompact(...args);
    ready.resolve(); await release.promise;
    return result;
  }) as typeof originalCompact);
  const full = spyOn(stateStore, "visitStateCollectionsRows").mockImplementation(async (...args: Parameters<typeof originalFull>) => {
    snapshots++;
    const result = await originalFull(...args);
    ready.resolve(); await release.promise;
    return result;
  });
  const first = readers[firstMode]();
  let second: ReturnType<typeof readers[typeof secondMode]> | undefined;
  try {
    await ready.promise;
    second = readers[secondMode]();
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(snapshots).toBe(reads);
    for (const [index, mode] of [firstMode, secondMode].entries()) {
      if (mode === "health") expect(results[index]).toEqual([]);
      else if (mode === "ownership") expect(results[index]).toMatchObject([{ id: row.id, attempts: [], survivors: [] }]);
      else expect(results[index]).toMatchObject([{ id: row.id, task: row.task, stages: row.stages }]);
    }
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    compact.mockRestore(); full.mockRestore();
  }
});

test.each(["pipelines", "pipelines_archive"] as const)("history evidence still refuses corrupt changed rows in %s", async collection => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    retainedHistory(db, row);
    expect(await pipelineRegistryHealthAsync()).toEqual([]);
    const id = collection === "pipelines" ? row.id : "retained-evidence-0";
    const saved = db.query<{ value_json: string }, [string, string]>("SELECT value_json FROM state_rows WHERE collection=? AND row_key=?").get(collection, id)!;
    db.query("UPDATE state_rows SET value_json='{broken' WHERE collection=? AND row_key=?").run(collection, id);
    const results = await Promise.allSettled([pipelineRegistryHealthAsync(), loadPipelineOwnershipForStartupAsync()]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe("corrupt " + collection + " SQLite row: " + id);
    }
    db.query("UPDATE state_rows SET value_json=? WHERE collection=? AND row_key=?").run(saved.value_json, collection, id);
    expect(await pipelineRegistryHealthAsync()).toEqual([]);
  } finally { db.close(); }
});

test("history evidence never joins a pending read of a replaced database", async () => {
  const { root, row } = fixture();
  const filename = path.join(root, "state.sqlite");
  const replacement = path.join(root, "replacement.sqlite");
  const db = new Database(filename);
  try { fs.writeFileSync(replacement, db.serialize()); }
  finally { db.close(); }
  const copy = new Database(replacement);
  try {
    copy.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
      .run(JSON.stringify({ ...row, state: "future-owner" }), row.id);
  } finally { copy.close(); }
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const originalRead = stateStore.readCompactPipelineEvidence;
  let snapshots = 0;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation((async (...args: Parameters<typeof originalRead>) => {
    snapshots++;
    const result = await originalRead(...args);
    ready.resolve(); await release.promise;
    return result;
  }) as typeof originalRead);
  const first = pipelineRegistryHealthAsync().then(() => "accepted", error => error.message);
  let second: Promise<unknown> | undefined;
  try {
    await ready.promise;
    fs.renameSync(filename, path.join(root, "retired.sqlite"));
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, path.join(root, "retired.sqlite" + suffix));
    }
    fs.renameSync(replacement, filename);
    second = pipelineRegistryHealthAsync();
    release.resolve();
    const [oldResult, newResult] = await Promise.all([first, second]);
    expect(snapshots).toBe(2);
    expect(oldResult).toBe("pipeline evidence changed during preparation");
    expect(newResult).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
  } finally {
    release.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]);
    read.mockRestore();
  }
});

test("history evidence never retains validation across an inode swap during identity sampling", async () => {
  const { root, row } = fixture();
  const filename = path.join(root, "state.sqlite");
  const replacement = path.join(root, "replacement.sqlite");
  const db = new Database(filename);
  db.query("UPDATE state_rows SET value_json=json_set(value_json, '$.stateDetail', 'same-clock-change') WHERE collection='pipelines' AND row_key=?").run(row.id);
  try { fs.writeFileSync(replacement, db.serialize()); }
  finally { db.close(); }
  const corrupt = new Database(replacement);
  corrupt.query("UPDATE state_rows SET value_json='{broken' WHERE collection='pipelines' AND row_key=?").run(row.id);
  corrupt.close();

  const originalStat = fs.statSync;
  let readerIdentityChecks = 0;
  let swapped = false;
  const stat = spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof originalStat>) => {
    const target = args[0];
    const stack = new Error().stack ?? "";
    if (!swapped && target === filename && stack.includes("readCompactPipelineEvidence") && !stack.includes("openCurrentDatabase")) {
      readerIdentityChecks++;
      if (readerIdentityChecks === 2) {
        swapped = true;
        fs.renameSync(filename, path.join(root, "retired.sqlite"));
        for (const suffix of ["-wal", "-shm"]) {
          if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, path.join(root, "retired.sqlite" + suffix));
        }
        fs.renameSync(replacement, filename);
      }
    }
    return originalStat.apply(fs, args);
  }) as typeof originalStat);
  try {
    await expect(pipelineRegistryHealthAsync()).rejects.toThrow("controller snapshot changed");
    expect(swapped).toBeTrue();
  } finally { stat.mockRestore(); }

  await expect(pipelineRegistryHealthAsync()).rejects.toThrow(`corrupt pipelines SQLite row: ${row.id}`);
});

test("history evidence keeps 48 validated rows when one row changes before freshness rejection", async () => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  retainedHistory(db, row);
  const decodes = observeEvidenceDecodes();
  const originalRead = stateStore.readCompactPipelineEvidence;
  let changed = false;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation((async (...args: Parameters<typeof originalRead>) => {
    const result = await originalRead(...args);
    if (!changed) {
      changed = true;
      db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
        .run(JSON.stringify({ ...row, state: "future-owner" }), row.id);
    }
    return result;
  }) as typeof originalRead);
  try {
    await expect(pipelineRegistryHealthAsync()).rejects.toThrow("pipeline evidence changed during preparation");
    expect(decodes.rows()).toBe(49);
    decodes.reset();
    const start = performance.now();
    const result = await pipelineRegistryHealthAsync();
    console.info(JSON.stringify({ case: "history-evidence-retry", retained: 48, changed: 1, callers: 1,
      decodes: decodes.rows(), elapsedMs: performance.now() - start, load: os.loadavg() }));
    expect(result).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
    expect(decodes.rows(), "only the changed row needs decoding after a rejected read").toBe(1);
    db.query("UPDATE state_rows SET value_json='{broken' WHERE collection='pipelines' AND row_key=?").run(row.id);
    await expect(pipelineRegistryHealthAsync()).rejects.toThrow("corrupt pipelines SQLite row");
  } finally { read.mockRestore(); decodes.stop(); db.close(); }
});

test("history evidence keeps warming through consecutive freshness rejections", async () => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  retainedHistory(db, row);
  const decodes = observeEvidenceDecodes();
  const originalRead = stateStore.readCompactPipelineEvidence;
  let writes = 0;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation((async (...args: Parameters<typeof originalRead>) => {
    const result = await originalRead(...args);
    if (writes < 2) {
      writes++;
      db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
        .run(JSON.stringify({ ...row, stateDetail: `concurrent revision ${writes}` }), row.id);
    }
    return result;
  }) as typeof originalRead);
  try {
    await expect(pipelineRegistryHealthAsync()).rejects.toThrow("pipeline evidence changed during preparation");
    expect(decodes.rows()).toBe(49);
    decodes.reset();
    await expect(pipelineRegistryHealthAsync()).rejects.toThrow("pipeline evidence changed during preparation");
    expect(decodes.rows(), "the first refused snapshot remains valid read progress").toBe(1);
    decodes.reset();
    expect(await pipelineRegistryHealthAsync()).toEqual([]);
    expect(decodes.rows(), "the second refused snapshot remains valid read progress").toBe(1);
  } finally { read.mockRestore(); decodes.stop(); db.close(); }
});

test("history evidence callers across revisions hydrate once and both refuse stale data", async () => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  retainedHistory(db, row);
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const decodes = observeEvidenceDecodes();
  const originalRead = stateStore.readCompactPipelineEvidence;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation((async (...args: Parameters<typeof originalRead>) => {
    const result = await originalRead(...args);
    ready.resolve();
    await release.promise;
    return result;
  }) as typeof originalRead);
  const start = performance.now();
  const settledFirst = pipelineRegistryHealthAsync().then(() => "accepted", error => error.message);
  let second: Promise<string> | undefined;
  try {
    await ready.promise;
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
      .run(JSON.stringify({ ...row, state: "future-owner" }), row.id);
    second = loadPipelineOwnershipForStartupAsync().then(() => "accepted", error => error.message);
    release.resolve();
    const results = await Promise.all([settledFirst, second]);
    console.info(JSON.stringify({ case: "history-evidence-overlap", retained: 48, changed: 1, callers: 2,
      decodes: decodes.rows(), elapsedMs: performance.now() - start, load: os.loadavg() }));
    expect(decodes.rows(), "overlapping health and ownership reads must hydrate history once").toBe(49);
    expect(results).toEqual(["pipeline evidence changed during preparation", "pipeline evidence changed during preparation"]);
    decodes.reset();
    expect(await pipelineRegistryHealthAsync()).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
    expect(decodes.rows()).toBe(1);
  } finally {
    release.resolve();
    await Promise.allSettled([settledFirst, ...(second ? [second] : [])]);
    read.mockRestore(); decodes.stop(); db.close();
  }
});
