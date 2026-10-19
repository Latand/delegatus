import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { slice5bCases } from "./slice5b.fixture";
import { presetStore } from "@/lib/flows/store";
import { initializeStateCollections, readStateImport } from "./sqliteStateStore";
import { resetLegacyDocumentStoresForTests, setLegacyDocumentWriteHookForTests } from "./legacyDocumentStore";
import { changeRoleMapping, clearRoleOverrides, hasRoleOverrides, loadRoleOverrides, saveRoleOverrides } from "@/lib/roles/store";
import { clearTelegramReports, readTelegramReports, saveReportText, reportTextPath, updateTelegramReports } from "@/lib/telegram/reportStore";
import { StateLockDeferredError, waitForStateLock } from "./lockWait";
import { FileTransactionAdmissionError, withFileTransactionAttempt } from "./fileTransaction";

const roots: string[] = [];
const oldState = process.env.LLV_STATE_DIR;
function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slice5b-"));
  roots.push(root);
  return root;
}
function seed(root: string, name: string, body: unknown): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  return file;
}
afterEach(() => {
  setLegacyDocumentWriteHookForTests(null);
  resetLegacyDocumentStoresForTests();
  if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

for (const [name, store, body] of slice5bCases) {
  test(`${name}: verified import, unchanged reimport and rollback mirror`, () => {
    const root = sandbox();
    const file = seed(root, name, body);
    const expected = store.legacyCollection(file).parse(body);
    const imported = store.importLegacy(file);
    expect(imported.state).toBe("imported");
    expect(imported.record.gap).toBeNull();
    expect(imported.record.rowCount).toBeGreaterThan(0);
    expect(store.read(file)).toEqual(expected);
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(file, "README"), "utf8")).toContain(path.relative(file, path.join(root, "state.sqlite")));
    expect(store.importLegacy(file).state).toBe("already-imported");
    store.checkpointRollbackMirror(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(store.legacyCollection(file).mirrorBody().body);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(store.importLegacy(file).state).toBe("already-imported");
    expect(store.read(file)).toEqual(expected);
    if (name.startsWith("telegram/")) expect(fs.existsSync(path.join(root, "telegram", "state.sqlite"))).toBe(false);
  });

  test(`${name}: changed rollback rows reconcile without dropping held rows`, () => {
    const root = sandbox(), file = seed(root, name, body);
    store.importLegacy(file);
    store.checkpointRollbackMirror(file);
    const changed = JSON.parse(JSON.stringify(body).replaceAll("Fixture", "Updated").replaceAll("fixture", "updated"));
    fs.writeFileSync(file, JSON.stringify(changed));
    store.importLegacy(file);
    const spec = store.legacyCollection(file);
    const rows = new Map(spec.toRows(store.read(file)).map(row => [row.key, row.value]));
    for (const row of spec.toRows(spec.parse(changed))) expect(rows.get(row.key)).toEqual(row.value);
  });

  test(`${name}: builds read legacy bytes without importing or writing`, () => {
    const root = sandbox(), file = seed(root, name, body);
    process.env.LLV_STATE_DIR = root;
    const phase = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-build";
    try {
      expect(store.read(file)).toEqual(store.legacyCollection(file).parse(body));
      expect(() => store.mutate(file, document => ({ next: document, result: undefined }))).toThrow("waiting for release promotion");
      expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(body));
      expect(fs.existsSync(path.join(root, "state.sqlite"))).toBe(false);
    } finally { if (phase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = phase; }
  });

  test(`${name}: a torn source is preserved once with a durable gap`, () => {
    const root = sandbox();
    const file = seed(root, name, body);
    const torn = Buffer.from('{"partial":\u0000');
    fs.writeFileSync(file, torn);
    const imported = store.importLegacy(file);
    expect(imported.state).toBe("imported");
    expect(imported.record.gap).toBe("legacy-unreadable");
    expect(imported.incident?.kind).toBe("legacy-unreadable");
    expect(fs.readFileSync(imported.incident!.preservedAs!)).toEqual(torn);
    expect(store.importLegacy(file).state).toBe("already-imported");
    const db = path.join(root, "state.sqlite");
    expect(readStateImport(db, store.legacyCollection(file).collection)?.gap).toBe("legacy-unreadable");
  });
}

test("every store reopens in a fresh process using the root database", async () => {
  const root = sandbox();
  const expected = slice5bCases.map(([name, store, body]) => {
    const file = seed(root, name, body);
    store.importLegacy(file);
    return { name, state: "already-imported", value: store.read(file) };
  });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slice5b.fixture.ts"), root], {
    env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual(expected);
});

test("a restart finishes all nine imports interrupted after COMMIT", async () => {
  const root = sandbox();
  const expected = slice5bCases.map(([name, store, body]) => {
    const file = seed(root, name, body);
    expect(() => store.importLegacy(file, { reconcile: true, hooks: { afterCommit: () => { throw new Error("interrupted fixture"); } } })).toThrow("interrupted fixture");
    expect(fs.statSync(file).isFile()).toBe(true);
    return { name, state: "already-imported", value: store.read(file) };
  });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slice5b.fixture.ts"), root], {
    env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(code).toBe(0); expect(JSON.parse(stdout)).toEqual(expected);
  for (const [name] of slice5bCases) expect(fs.statSync(path.join(root, name)).isDirectory()).toBe(true);
});

for (const [name, store, body] of slice5bCases.filter(([name]) => name.startsWith("telegram/"))) {
  test(`${name}: unsafe sources refuse before any import write`, () => {
    const root = sandbox(), file = seed(root, name, body);
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, JSON.stringify(body), { mode: 0o600 });
    fs.unlinkSync(file); fs.symlinkSync(outside, file);
    expect(() => store.importLegacy(file)).toThrow("owner-only regular file");
    expect(fs.readFileSync(outside, "utf8")).toBe(JSON.stringify(body));
    expect(fs.existsSync(`${file}.write-locks`)).toBe(false);
    expect(fs.existsSync(path.join(root, "state.sqlite"))).toBe(false);
    fs.unlinkSync(file); fs.writeFileSync(file, JSON.stringify(body), { mode: 0o644 });
    expect(() => store.importLegacy(file)).toThrow("owner-only regular file");
    fs.chmodSync(file, 0o600); fs.chmodSync(path.dirname(file), 0o755);
    expect(() => store.importLegacy(file)).toThrow("directory must be owner-only");
  });
}

test("role defaults stay readable inside another collection transaction before and after import", () => {
  const root = sandbox(); process.env.LLV_STATE_DIR = root;
  const [name, store, body] = slice5bCases.find(([name]) => name === "role-presets.json")!;
  const file = seed(root, name, body), filename = path.join(root, "state.sqlite");
  initializeStateCollections(filename, [{ collection: "fixture", schemaVersion: 1, migrationId: "fixture", loadRecords: () => [], key: () => "fixture" }]);
  const db = new Database(filename);
  try {
    for (const imported of [false, true]) {
      if (imported) store.importLegacy(file);
      db.exec("BEGIN IMMEDIATE");
      try { expect(loadRoleOverrides()).toEqual(store.legacyCollection(file).parse(body) as ReturnType<typeof loadRoleOverrides>); }
      finally { db.exec("ROLLBACK"); }
      expect(fs.statSync(file).isDirectory()).toBe(imported);
    }
  } finally { db.close(); }
});

test("role presence comes from SQLite after import even if its tombstone disappears", () => {
  const root = sandbox(); process.env.LLV_STATE_DIR = root;
  const [, store] = slice5bCases.find(([name]) => name === "role-presets.json")!;
  const file = path.join(root, "role-presets.json");
  store.importLegacy(file);
  expect(hasRoleOverrides()).toBe(false);
  saveRoleOverrides({ builder: { config: { model: "gpt-fixture" } } });
  fs.rmSync(file, { recursive: true });
  expect(hasRoleOverrides()).toBe(true);
  expect(loadRoleOverrides().overrides.builder?.config?.model).toBe("gpt-fixture");
});

test("clearing the role fixture removes SQLite rows and restores absent-registry semantics", () => {
  process.env.LLV_STATE_DIR = sandbox();
  saveRoleOverrides({ builder: { config: { model: "gpt-fixture" } } });
  expect(hasRoleOverrides()).toBe(true);
  clearRoleOverrides();
  expect(hasRoleOverrides()).toBe(false);
  expect(loadRoleOverrides().overrides).toEqual({});
});

test("a prior atomic preset writer that lands after COMMIT is reconciled before retirement", async () => {
  const root = sandbox();
  process.env.LLV_STATE_DIR = root;
  const [, store, original] = slice5bCases.find(([name]) => name === "review-loop-presets.json")!;
  const file = seed(root, "review-loop-presets.json", original) as string;
  const updated = structuredClone(original) as { presets: unknown[] };
  updated.presets.push({ name: "Writer B", implementer: { engine: "codex", model: "writer-b", effort: "high" }, reviewer: { engine: "codex", model: "writer-b", effort: "high" } });

  expect(() => store.importLegacy(file, { reconcile: true, hooks: {
    afterCommit: () => {
      const temp = `${file}.old-writer.tmp`;
      fs.writeFileSync(temp, JSON.stringify(updated), { mode: 0o600 });
      fs.renameSync(temp, file);
    },
    afterRename: () => { throw new Error("interrupted after retirement"); },
  } })).toThrow("interrupted after retirement");
  const outcome = store.importLegacy(file, { reconcile: true });
  expect(outcome.state).toBe("already-imported");
  expect(outcome.incident?.kind).toBe("legacy-reconciled");
  expect((store.read(file) as { name: string }[]).map(preset => preset.name)).toContain("Writer B");
  const expected = slice5bCases.map(([name, otherStore]) => ({ name, state: "already-imported", value: otherStore.read(path.join(root, name)) }));
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slice5b.fixture.ts"), root], {
    env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual(expected);
});

test("a prior direct push writer that lands after COMMIT is reconciled before retirement", () => {
  const root = sandbox();
  const [name, store, original] = slice5bCases.find(([name]) => name === "push-subscriptions.json")!;
  const file = seed(root, name, original);
  const written = [{ endpoint: "https://push.example.invalid/late-writer", expirationTime: null }];

  const outcome = store.importLegacy(file, { reconcile: true, hooks: { afterCommit: () => {
    fs.writeFileSync(file, JSON.stringify(written), { mode: 0o600 });
  } } });

  expect(outcome.incident?.kind).toBe("legacy-reconciled");
  expect((store.read(file) as { endpoint: string }[]).map(subscription => subscription.endpoint)).toContain(written[0]!.endpoint);
});

test("consumed retired preset snapshots do not restore later SQLite deletions after restart", async () => {
  for (const mode of ["late-writer", "rollback-mirror"] as const) {
    const root = sandbox(), file = seed(root, "review-loop-presets.json", { presets: [] });
    const presets = ["A", "B"].map(name => ({ name, implementer: { engine: "codex" as const, model: `model-${name}`, effort: "high" as const }, reviewer: { engine: "codex" as const, model: `model-${name}`, effort: "high" as const } }));
    if (mode === "late-writer") {
      presetStore.importLegacy(file, { reconcile: true, hooks: { afterCommit: () => {
        const temp = `${file}.predecessor.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ presets }), { mode: 0o600 });
        fs.renameSync(temp, file);
      } } });
    } else {
      presetStore.importLegacy(file);
      presetStore.checkpointRollbackMirror(file);
      fs.writeFileSync(file, JSON.stringify({ presets }), { mode: 0o600 });
      presetStore.importLegacy(file);
    }
    expect((presetStore.read(file) as typeof presets).map(item => item.name)).toEqual(["A", "B"]);
    presetStore.mutate(file, () => ({ next: [presets[0]!], result: undefined }));

    for (let restart = 0; restart < 2; restart++) {
      resetLegacyDocumentStoresForTests();
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slice5b.fixture.ts"), root], {
        env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe(""); expect(code).toBe(0);
      const reopened = JSON.parse(stdout) as { name: string; value: { name: string }[] }[];
      expect(reopened.find(item => item.name === "review-loop-presets.json")?.value.map(item => item.name)).toEqual(["A"]);
    }
  }
});

test("a valid predecessor write replacing torn preset JSON is reconciled and survives restart", async () => {
  const root = sandbox(), file = path.join(root, "review-loop-presets.json");
  const torn = Buffer.from('{"presets":[');
  fs.writeFileSync(file, torn, { mode: 0o600 });
  const presets = ["A", "B"].map(name => ({ name, implementer: { engine: "codex" as const, model: `model-${name}`, effort: "high" as const }, reviewer: { engine: "codex" as const, model: `model-${name}`, effort: "high" as const } }));
  const imported = presetStore.importLegacy(file, { reconcile: true, hooks: { afterCommit: () => {
    const temp = `${file}.predecessor.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ presets }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } } });
  expect(imported.record.gap).toBe("legacy-unreadable");
  const unreadable = fs.readdirSync(root).find(name => name.startsWith("review-loop-presets.json.unreadable-"));
  expect(unreadable).toBeTruthy();
  expect(fs.readFileSync(path.join(root, unreadable!))).toEqual(torn);
  expect((presetStore.read(file) as typeof presets).map(item => item.name)).toEqual(["A", "B"]);

  resetLegacyDocumentStoresForTests();
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slice5b.fixture.ts"), root], {
    env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  const reopened = JSON.parse(stdout) as { name: string; value: { name: string }[] }[];
  expect(reopened.find(item => item.name === "review-loop-presets.json")?.value.map(item => item.name)).toEqual(["A", "B"]);
});

test("an audit refusal rolls back every role row and preserves retirements", () => {
  process.env.LLV_STATE_DIR = sandbox();
  saveRoleOverrides({ builder: { config: { model: "gpt-before" } } }, { fixture: { at: "2026-10-01T00:00:00.000Z" } });
  const before = loadRoleOverrides();
  expect(() => changeRoleMapping({ builder: { config: { engine: "codex", model: "gpt-after", effort: "high" } } }, {
    record: () => { expect(loadRoleOverrides().overrides.builder?.config?.model).toBe("gpt-after"); throw new Error("audit fixture refused"); },
  })).toThrow("audit fixture refused");
  expect(loadRoleOverrides()).toEqual(before);
});

test("report logout clears SQLite and artifacts; a refused update retains artifacts", () => {
  process.env.LLV_STATE_DIR = sandbox();
  updateTelegramReports(file => { file.settings.enabled = true; file.history = [{ id: "fixture-report", trigger: "manual", startedAt: "2026-10-01T00:00:00.000Z", finishedAt: null, windowStart: "2026-10-01T00:00:00.000Z", windowEnd: "2026-10-01T00:00:00.000Z", status: "ok", errorCode: null, conversationId: null, hasReport: true, promptVersion: "fixture" }]; });
  saveReportText("fixture-report", "Fixture report");
  setLegacyDocumentWriteHookForTests(collection => { if (collection === "telegram_reports") throw new Error("disk fixture refused"); });
  expect(() => updateTelegramReports(file => { file.history = []; })).toThrow("disk fixture refused");
  expect(fs.existsSync(reportTextPath("fixture-report"))).toBe(true);
  setLegacyDocumentWriteHookForTests(null);
  clearTelegramReports();
  expect(readTelegramReports().history).toEqual([]);
  expect(readTelegramReports().settings.enabled).toBe(false);
  expect(fs.existsSync(reportTextPath("fixture-report"))).toBe(false);
});

test("startup retries a contended role retirement before launching controllers", async () => {
  const { startCurrentReleaseControllers } = await import("@/lib/viewerInstrumentation");
  const events: string[] = [];
  let attempts = 0;
  await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
    loadRoleMappingRetirements: async () => ({ applyRoleMappingRetirements: () => {
      events.push(`retire:${++attempts}`);
      if (attempts === 1) throw new StateLockDeferredError("fixture.retirement");
      return { state: "unchanged" };
    } }),
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { events.push("controller"); } }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
  });
  expect(events).toEqual(["retire:1", "retire:2", "controller"]);
});

test("legacy file contention defers before callbacks and asynchronous admission yields", async () => {
  const root = sandbox(), file = path.join(root, "fixture.json");
  const lock = `${file}.write-lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "fixture" }));
  let called = 0;
  const operation = () => withFileTransactionAttempt(file, "fixture.import", () => ++called);
  expect(operation).toThrow(FileTransactionAdmissionError);
  expect(called).toBe(0);
  const pending = waitForStateLock("slice5b.fixture", operation);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(called).toBe(0);
  fs.unlinkSync(lock);
  expect(await pending).toBe(1);
});

test("subscription key pages seek the primary index and ignore unrelated history", () => {
  const root = sandbox(), [name, store, body] = slice5bCases[0]!;
  const file = seed(root, name, body);
  store.importLegacy(file);
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    const plan = db.query("EXPLAIN QUERY PLAN SELECT value_json FROM state_rows WHERE collection = ? AND row_key > ? ORDER BY row_key LIMIT ?").all("push_subscriptions", "", 32);
    expect(JSON.stringify(plan)).toContain("SEARCH");
    expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
  } finally { db.close(); }
  expect(store.readPage(file, "", 1)).toHaveLength(1);
  expect(store.readPage(file, "zzzz", 1)).toEqual([]);
});
