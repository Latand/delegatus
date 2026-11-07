import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initializeStateCollections } from "@/lib/state/sqliteStateStore";
import { buildPipeline, loadPipelines, loadArchivedPipelines, pipelineStateCollectionSeeds,
  pipelineDeliveryLookup, savePipelines, withPipelineMutation,
  checkpointPipelineRollbackMirrorsForDemotion } from "./store";

function fixture(id: string) {
  return buildPipeline({ id, task: "Format compatibility", project: "fixture", repoDir: "/repo",
    stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-11-05T00:00:00.000Z" });
}

async function isolated(run: (root: string) => void | Promise<void>) {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-format-bridge-"));
  process.env.LLV_STATE_DIR = root;
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seed(root: string, version: number, active: unknown[], archive: unknown[] = []) {
  initializeStateCollections(path.join(root, "state.sqlite"), pipelineStateCollectionSeeds().map((s, i) => ({
    ...s, schemaVersion: version, loadRecords: () => i === 0 ? active : archive,
  })));
}
function inspect(root: string) {
  const db = new Database(path.join(root, "state.sqlite"), { readonly: true });
  try { return {
    markers: db.query("SELECT collection,schema_version,revision,change_floor,migration_id FROM state_collections ORDER BY collection").all(),
    rows: db.query("SELECT collection,row_key,value_json,row_order,row_revision,controller_active FROM state_rows ORDER BY collection,row_key").all(),
  }; } finally { db.close(); }
}

test("the rollback bridge opens format six beside stale JSON and preserves its version on writes", async () => isolated(async root => {
  seed(root, 6, [fixture("healthy")], [fixture("archived")]);
  for (const name of ["pipelines.json", "pipelines-archive.json"]) fs.writeFileSync(path.join(root, name), "invalid stale mirror");
  const before = inspect(root);
  expect(loadPipelines().map(p => p.id)).toEqual(["healthy"]);
  expect(loadArchivedPipelines().map(p => p.id)).toEqual(["archived"]);
  expect(inspect(root)).toEqual(before);
  await withPipelineMutation(async (rows, persist) => { rows[0]!.stateDetail = "bridge write"; await persist(); });
  expect(loadPipelines()[0]!.stateDetail).toBe("bridge write");
  expect(inspect(root).markers).toMatchObject([
    { collection: "pipelines", schema_version: 6, revision: 2 },
    { collection: "pipelines_archive", schema_version: 6, revision: 1 },
  ]);
  checkpointPipelineRollbackMirrorsForDemotion();
  expect(JSON.parse(fs.readFileSync(path.join(root, "pipelines.json"), "utf8")).schemaVersion).toBe(6);
  expect(JSON.parse(fs.readFileSync(path.join(root, "pipelines-archive.json"), "utf8")).schemaVersion).toBe(6);
}));

test("the rollback bridge preserves future receipt-bearing rows without admitting them", async () => isolated(root => {
  const future = { ...fixture("future"), adoptedCreationRequests: [{ key: "adopted-key", digest: "digest" }] };
  seed(root, 5, [fixture("healthy"), future]);
  const before = inspect(root).rows.find(row => (row as { row_key: string }).row_key === "future");
  expect(loadPipelines().map(p => p.id)).toEqual(["healthy"]);
  savePipelines(loadPipelines());
  expect(inspect(root).rows.find(row => (row as { row_key: string }).row_key === "future")).toEqual(before);
  checkpointPipelineRollbackMirrorsForDemotion();
  const mirror = JSON.parse(fs.readFileSync(path.join(root, "pipelines.json"), "utf8"));
  expect(mirror.pipelines.find((p: { id: string }) => p.id === "future")).toEqual(future);
}));

test.each([false, true])("the rollback bridge refuses an adopted replay before another outcome is admitted, archive=%s", async archived => isolated(root => {
  const future = { ...fixture("future"), creationRequest: { key: "original-key", digest: "original" },
    adoptedCreationRequest: { key: "prior-key", digest: "prior" },
    adoptedCreationRequests: [{ key: "adopted-key", digest: "adopted" }] };
  seed(root, 5, archived ? [fixture("healthy")] : [fixture("healthy"), future], archived ? [future] : []);
  const before = inspect(root);
  for (const requestKey of ["original-key", "prior-key", "adopted-key"]) {
    expect(() => pipelineDeliveryLookup({ requestKey })).toThrow("invalid indexed pipeline row");
  }
  expect(inspect(root)).toEqual(before);
}));

test("the rollback bridge refuses an unsupported version without changing retained rows", async () => isolated(root => {
  seed(root, 7, [fixture("kept")], [fixture("archived")]);
  const before = inspect(root);
  expect(loadPipelines).toThrow("unsupported pipelines SQLite schema: 7");
  expect(inspect(root)).toEqual(before);
}));


test("receipt projections preserve opaque future fields and index only object keys", async () => isolated(root => {
  const future = { ...fixture("future"), adoptedCreationRequests: [3, "future-token", { key: "retained-key", digest: "digest" }] };
  seed(root, 5, [fixture("healthy"), future]);
  const before = inspect(root);
  expect(loadPipelines().map(p => p.id)).toEqual(["healthy"]);
  expect(() => pipelineDeliveryLookup({ requestKey: "retained-key" })).toThrow("invalid indexed pipeline row");
  expect(inspect(root)).toEqual(before);
}));

test("installing the receipt projection backfills retained rows without rewriting them", async () => isolated(root => {
  const future = { ...fixture("future"), adoptedCreationRequests: [{ key: "retained-key", digest: "digest" }] };
  seed(root, 5, [fixture("healthy"), future]);
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.exec("DROP TABLE pipeline_request_receipts"); } finally { db.close(); }
  const before = inspect(root);
  expect(loadPipelines().map(p => p.id)).toEqual(["healthy"]);
  expect(() => pipelineDeliveryLookup({ requestKey: "retained-key" })).toThrow("invalid indexed pipeline row");
  expect(inspect(root)).toEqual(before);
}));

test("a format-six database with a missing receipt index refuses repair that would lose replay ownership", async () => isolated(root => {
  seed(root, 6, [fixture("healthy")]);
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.exec("DROP TABLE pipeline_request_receipts"); } finally { db.close(); }
  const before = inspect(root);
  expect(loadPipelines).toThrow("pipeline format six receipt index is missing");
  expect(inspect(root)).toEqual(before);
}));


test("receipt backfill refuses conflicting retained owners without changing data", async () => isolated(root => {
  const first = { ...fixture("first"), adoptedCreationRequests: [{ key: "shared-key", digest: "first" }] };
  const second = { ...fixture("second"), adoptedCreationRequests: [{ key: "shared-key", digest: "second" }] };
  seed(root, 5, [first], [second]);
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.exec("DROP TABLE pipeline_request_receipts"); } finally { db.close(); }
  const before = inspect(root);
  expect(loadPipelines).toThrow("pipeline receipt key has conflicting retained owners");
  expect(inspect(root)).toEqual(before);
  const check = new Database(path.join(root, "state.sqlite"), { readonly: true });
  try { expect(check.query("SELECT name FROM sqlite_master WHERE name='pipeline_request_receipts'").get()).toBeNull(); }
  finally { check.close(); }
}));

test("compatible format acceptance still refuses a different migration identity", async () => isolated(root => {
  seed(root, 6, [fixture("healthy")]);
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.exec("UPDATE state_collections SET migration_id='unknown-import' WHERE collection='pipelines'"); }
  finally { db.close(); }
  const before = inspect(root);
  expect(loadPipelines).toThrow("unsupported pipelines SQLite migration");
  expect(inspect(root)).toEqual(before);
}));


test("lost startup authority rolls back receipt installation without changing retained rows", async () => isolated(root => {
  const future = { ...fixture("future"), adoptedCreationRequests: [{ key: "retained-key", digest: "digest" }] };
  seed(root, 5, [fixture("healthy"), future]);
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.exec("DROP TABLE pipeline_request_receipts"); } finally { db.close(); }
  const before = inspect(root);
  const result = spawnSync(process.execPath, ["-e", `
    import { mock } from "bun:test";
    const ownership = await import("./src/lib/stateOwnership.ts");
    const check = ownership.assertStateStartupMutation;
    mock.module("./src/lib/stateOwnership.ts", () => ({ ...ownership,
      assertStateStartupMutation: (directory, step) => {
        if (step === "state database schema publication") throw new ownership.StateStartupMutationRefused(step, directory, {});
        return check(directory, step);
      },
    }));
    const store = await import("./src/lib/pipelines/store.ts");
    try { store.loadPipelines(); process.exit(2); }
    catch (error) { if (!String(error).includes("state database schema publication")) throw error; }
  `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(inspect(root)).toEqual(before);
  const check = new Database(path.join(root, "state.sqlite"), { readonly: true });
  try { expect(check.query("SELECT name FROM sqlite_master WHERE name='pipeline_request_receipts'").get()).toBeNull(); }
  finally { check.close(); }
}));


test("the bridge refuses a format-six JSON import instead of relabeling it five", async () => isolated(root => {
  const source = JSON.stringify({ schemaVersion: 6, pipelines: [fixture("future")] });
  fs.writeFileSync(path.join(root, "pipelines.json"), source);
  fs.writeFileSync(path.join(root, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 6, pipelines: [] }));
  expect(loadPipelines).toThrow("unsupported pipeline registry schema: 6");
  expect(fs.readFileSync(path.join(root, "pipelines.json"), "utf8")).toBe(source);
  expect(inspect(root).markers).toEqual([]);
  expect(inspect(root).rows).toEqual([]);
}));


test("an expired final archive payload rolls back receipt backfill", async () => isolated(root => {
  const future = { ...fixture("archive-budget"), adoptedCreationRequests: [{ key: "budget-key", digest: "budget-digest" }] };
  seed(root, 5, [fixture("healthy")], [future]);
  const filename = path.join(root, "state.sqlite");
  const db = new Database(filename);
  let payload: string;
  try {
    payload = (db.query("SELECT value_json FROM state_rows WHERE collection='pipelines_archive'").get() as { value_json: string }).value_json;
    db.exec("DROP TABLE pipeline_request_receipts");
  } finally { db.close(); }
  const before = inspect(root);
  const parseDescriptor = Object.getOwnPropertyDescriptor(JSON, "parse")!;
  const clockDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
  const parse = JSON.parse;
  let time = 0, triggered = false, error: unknown;
  try {
    Object.defineProperty(performance, "now", { configurable: true, value: () => time });
    Object.defineProperty(JSON, "parse", { ...parseDescriptor, value: (text: string, ...args: unknown[]) => {
      const value = Reflect.apply(parse, JSON, [text, ...args]);
      if (text === payload) { triggered = true; time = 30_001; }
      return value;
    } });
    try { loadPipelines(); } catch (caught) { error = caught; }
  } finally {
    Object.defineProperty(JSON, "parse", parseDescriptor);
    if (clockDescriptor) Object.defineProperty(performance, "now", clockDescriptor);
    else delete (performance as { now?: unknown }).now;
  }
  expect(triggered).toBe(true);
  expect(String(error)).toContain("pipeline receipt backfill exceeded its startup budget");
  expect(inspect(root)).toEqual(before);
  const check = new Database(filename, { readonly: true });
  try { expect(check.query("SELECT name FROM sqlite_master WHERE name='pipeline_request_receipts'").get()).toBeNull(); }
  finally { check.close(); }
}));
