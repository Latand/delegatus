import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPipeline, loadPipelinesForStartup, pipelineRegistryHealth, pipelineRegistryHealthAsync, savePipelines, withPipelineMutation, withPipelineStartupAdmission } from "./store";
import { createViewerLoopMonitor, withViewerOperation } from "@/lib/viewerLoopMonitor";

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

test("production-sized startup bursts keep timer and lease holds below 200 ms", async () => {
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
    let expected = performance.now() + 10, maxGapMs = 0, maxHoldMs = 0;
    const timer = setInterval(() => { const at = performance.now(); maxGapMs = Math.max(maxGapMs, at - expected); expected = at + 10; }, 10);
    try {
      const outcomes = await Promise.all(Array.from({ length: count }, () => withPipelineStartupAdmission(async available => {
        expect(available).toBeTrue();
        if (evidence) { expect(loadPipelinesForStartup()).toHaveLength(804); expect(pipelineRegistryHealth()).toEqual([]); }
        return true;
      }, "synthetic startup", held => { maxHoldMs = Math.max(maxHoldMs, held); })));
      await new Promise(resolve => setTimeout(resolve, 25));
      console.info(JSON.stringify({ case: `startup-${count}-${evidence}`, maxGapMs, maxHoldMs }));
      expect(outcomes.every(Boolean)).toBeTrue();
      expect(maxGapMs).toBeLessThan(200);
      expect(maxHoldMs).toBeLessThan(200);
    } finally { clearInterval(timer); }
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
  try {
    const pending = withViewerOperation("pipelines.startup-admission", () => withPipelineMutation(() => true, held => { heldMs = held; }));
    Bun.sleepSync(1100);
    expect(await pending).toBeTrue();
    expect(heldMs).toBeGreaterThan(1000);
    expect(lines).toContainEqual(["[state lease-hold]", expect.objectContaining({ collection: "pipelines", operation: "pipelines.mutation", heldMs: expect.any(Number) })]);
  } finally { console.warn = warn; }
});

test("a foreign commit and a new owner invalidate prepared evidence before admission", async () => {
  const { row } = fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const writer = withPipelineMutation(async (records, persist) => {
    entered(); await wait;
    const newOwner = { ...row, id: "new-owner", worktreeDir: "/repo-pipeline-new-owner", branch: "pipeline/synthetic-ownership-evidence-new-owner" };
    persist([...records, newOwner]);
  });
  await ready;
  const reader = withPipelineStartupAdmission(async available => available);
  try { await new Promise(resolve => setTimeout(resolve, 40)); }
  finally { release(); }
  await writer;
  expect(await reader).toBeFalse();
  expect(await withPipelineStartupAdmission(async available => {
    expect(available).toBeTrue();
    expect(loadPipelinesForStartup().map(record => record.id)).toContain("new-owner");
    return true;
  })).toBeTrue();
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
  let expected = performance.now() + 10, maxGapMs = 0;
  const timer = setInterval(() => { const at = performance.now(); maxGapMs = Math.max(maxGapMs, at - expected); expected = at + 10; }, 10);
  try {
    await Promise.all(Array.from({ length: 32 }, () => withPipelineStartupAdmission(async available => {
      expect(available).toBeTrue();
      Bun.sleepSync(15);
    })));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(maxGapMs).toBeLessThan(200);
  } finally { clearInterval(timer); }
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
