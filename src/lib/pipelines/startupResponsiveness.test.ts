import { stateLeaseHoldsInFlight } from "@/lib/state/sqliteStateStore";
import * as stateStore from "@/lib/state/sqliteStateStore";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPipeline, loadPipelinesForStartup, loadPipelinesForStartupAsync, loadPipelineOwnershipForStartupAsync, pipelineRegistryHealth, pipelineRegistryHealthAsync, savePipelines, withPipelineMutation, withPipelineStartupAdmission } from "./store";
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
  try {
    const pending = withViewerOperation("pipelines.startup-admission", () => withPipelineMutation(() => true, held => { heldMs = held; }));
    // Store opening may itself yield. Observe durable acquisition independently
    // before blocking the continuation that will release it.
    for (let turn = 0; turn < 20 && !stateLeaseHoldsInFlight().some(held => held.collection === "pipelines"); turn++) await Promise.resolve();
    expect(stateLeaseHoldsInFlight().some(held => held.collection === "pipelines")).toBe(true);
    Bun.sleepSync(1100);
    expect(await pending).toBeTrue();
    expect(heldMs).toBeGreaterThan(1000);
    expect(lines).toContainEqual(["[state lease-hold]", expect.objectContaining({ collection: "pipelines", operation: "pipelines.mutation", heldMs: expect.any(Number) })]);
  } finally { console.warn = warn; }
});

test.each([false, true])("a foreign commit and a new owner invalidate prepared evidence before admission (compact=%s)", async compact => {
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
  const reader = withPipelineStartupAdmission(async available => available, undefined, undefined, compact);
  try { await new Promise(resolve => setTimeout(resolve, 40)); }
  finally { release(); }
  await writer;
  expect(await reader).toBeFalse();
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

test("a changed pipeline keeps validated history for the next evidence read", async () => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  const count = 48;
  try {
    const insert = db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive',?,?,?,1,0)");
    for (let i = 0; i < count; i++) {
      const id = `retained-evidence-${i}`;
      insert.run(id, JSON.stringify({ ...row, id, worktreeDir: `/repo-pipeline-${id}`, branch: `pipeline/synthetic-ownership-evidence-${id}` }), i);
    }
    const originalParse = JSON.parse;
    let changed = false;
    let reads = 0;
    const parse = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes('"stages":') && text.includes('"runs":')) {
        reads++;
        if (!changed) {
          changed = true;
          db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
            .run(JSON.stringify({ ...row, state: "future-owner" }), row.id);
        }
      }
      return originalParse(text, reviver);
    });
    try {
      await expect(pipelineRegistryHealthAsync()).rejects.toThrow("pipeline evidence changed during preparation");
      expect(reads).toBe(count + 1);
      reads = 0;
      expect(await pipelineRegistryHealthAsync()).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
      expect(reads, "only the changed row needs decoding after a rejected read").toBe(1);
      db.query("UPDATE state_rows SET value_json='{broken' WHERE collection='pipelines' AND row_key=?").run(row.id);
      await expect(pipelineRegistryHealthAsync()).rejects.toThrow("corrupt pipelines SQLite row");
    } finally { parse.mockRestore(); }
  } finally { db.close(); }
});

test("health callers across revisions share the cold history read and refuse its stale result", async () => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  const count = 48;
  let second: Promise<unknown> | undefined;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let writer: ReturnType<typeof setTimeout> | undefined;
  try {
    const insert = db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive',?,?,?,1,0)");
    for (let i = 0; i < count; i++) {
      const id = `shared-evidence-${i}`;
      insert.run(id, JSON.stringify({ ...row, id, worktreeDir: `/repo-pipeline-${id}`, branch: `pipeline/synthetic-ownership-evidence-${id}` }), i);
    }
    const originalParse = JSON.parse;
    let reads = 0;
    let scheduled = false;
    const parse = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes('"stages":') && text.includes('"runs":')) {
        reads++;
        if (!scheduled) {
          scheduled = true;
          writer = setTimeout(() => {
            db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
              .run(JSON.stringify({ ...row, state: "future-owner" }), row.id);
            second = pipelineRegistryHealthAsync().then(() => "accepted", () => "refused");
            entered();
          }, 0);
          // Force the cold reader to reach its cooperative yield before the
          // next row; the writer and second caller then run during that read.
          Bun.sleepSync(6);
        }
      }
      return originalParse(text, reviver);
    });
    try {
      const first = pipelineRegistryHealthAsync();
      // Observe rejection immediately while waiting for the second caller.
      const firstResult = first.then(() => "accepted", () => "refused");
      await ready;
      expect(await Promise.all([firstResult, second!])).toEqual(["refused", "refused"]);
      expect(reads, "overlapping callers must hydrate retained history once").toBe(count + 1);
      reads = 0;
      expect(await pipelineRegistryHealthAsync()).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
      expect(reads).toBe(1);
    } finally { parse.mockRestore(); }
  } finally { clearTimeout(writer); db.close(); }
});

test("a caller after a write cannot reuse a completed older evidence result", async () => {
  const { root, row } = fixture();
  const db = new Database(path.join(root, "state.sqlite"));
  const originalRead = stateStore.readCompactPipelineEvidence;
  let injected = false;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let afterWrite!: Promise<{ issues: unknown[] } | { error: string }>;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation((async (...args: Parameters<typeof originalRead>) => {
    const result = await originalRead(...args);
    if (!injected) {
      injected = true;
      // Run after the producer checks its signature, before its pending entry
      // is retired. The next caller starts strictly after the committed write.
      queueMicrotask(() => queueMicrotask(() => {
        db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
          .run(JSON.stringify({ ...row, state: "future-owner" }), row.id);
        afterWrite = pipelineRegistryHealthAsync().then(issues => ({ issues }), error => ({ error: String(error.message) }));
        entered();
      }));
    }
    return result;
  }) as typeof originalRead);
  try {
    const first = pipelineRegistryHealthAsync().catch(() => []);
    await ready;
    const result = await afterWrite;
    if ("issues" in result) expect(result.issues).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
    else expect(result.error).toBe("pipeline evidence changed during preparation");
    await first;
    expect(await pipelineRegistryHealthAsync()).toMatchObject([{ id: row.id, reason: "unknown-but-preserved" }]);
  } finally { read.mockRestore(); db.close(); }
});
