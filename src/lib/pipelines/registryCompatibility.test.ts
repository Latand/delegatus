import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPipeline, findPipelineRecord, loadPipelines, pipelineRegistryHealth, PIPELINES_SCHEMA_VERSION, savePipelines, unclaimedPipelinePublications, withPipelineControllerMutation, withPipelineMutation } from "./store";
import { probeQuiet } from "@/lib/selfUpdate/quiet";
import type { Snapshot } from "@/lib/selfUpdate/types";

function fixture(id: string, merger = false) {
  return buildPipeline({ id, task: "Registry compatibility", project: "fixture", repoDir: "/repo",
    stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
      ...(merger ? { role: { roleId: "merger" as const } } : {}),
      effectiveRole: { roleId: merger ? "merger" : null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: merger ? "Merge reviewed changes" : null } }],
    srcPath: null, srcConversationId: null, now: "2026-10-02T00:00:00.000Z" });
}

async function isolated(run: (root: string) => Promise<void> | void) {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-compatibility-"));
  process.env.LLV_STATE_DIR = root;
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function insertRaw(root: string, id: string, json: string) {
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    db.transaction(() => {
      db.query("UPDATE state_collections SET revision = revision + 1 WHERE collection = 'pipelines'").run();
      db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) SELECT 'pipelines',?,?,99,revision,1 FROM state_collections WHERE collection='pipelines'").run(id, json);
    })();
  } finally { db.close(); }
}

async function olderStore(root: string): Promise<typeof import("./store")> {
  // Exercise the real store with the pre-merger role vocabulary, including its
  // separate SQLite cache. All other validation and persistence code is intact.
  const source = fs.readFileSync(path.join(import.meta.dir, "store.ts"), "utf8")
    .replace('"deployer", "merger"', '"deployer"')
    .replaceAll('from "@/lib/', `from "${path.resolve(import.meta.dir, '..')}/`)
    .replaceAll('from "./', `from "${import.meta.dir}/`);
  const modulePath = path.join(root, "older-store.ts");
  fs.writeFileSync(modulePath, source);
  return import(modulePath);
}

test("an older role validator reads and writes healthy lanes beside the newer merger record", async () => isolated(async (root) => {
  savePipelines([fixture("healthy")]);
  insertRaw(root, "future", JSON.stringify(fixture("future", true)));
  const older = await olderStore(root);
  expect(older.isEffectiveRole(fixture("future", true).stages[0]!.effectiveRole)).toBe(false);
  expect(older.loadPipelines().map((row) => row.id)).toEqual(["healthy"]);
  expect(older.loadPipelinesForList().map((row) => row.id)).toEqual(["healthy"]);
  expect(older.loadPipelinesForStartup().map((row) => row.id)).toEqual(["healthy"]);
  await older.withPipelineMutation((rows, persist) => { rows[0]!.stateDetail = "stage report persisted"; persist(); });
  expect(older.loadPipelines()[0]!.stateDetail).toBe("stage report persisted");
}));

function storedBytes(root: string, id: string): string {
  const db = new Database(path.join(root, "state.sqlite"));
  try { return (db.query("SELECT value_json FROM state_rows WHERE collection='pipelines' AND row_key=?").get(id) as { value_json: string }).value_json; }
  finally { db.close(); }
}

test("replacement, bounded writes and rollback mirrors preserve the newer record across downgrade and upgrade", async () => isolated(async (root) => {
  savePipelines([fixture("healthy")]);
  const bytes = JSON.stringify(fixture("future", true), null, 3);
  insertRaw(root, "future", bytes);
  const older = await olderStore(root);
  older.savePipelines(older.loadPipelines());
  await older.withPipelineMutation((rows, persist) => { rows[0]!.stateDetail = "changed"; persist(rows); });
  older.withDeliveryMutation((tx) => { const row = tx.get("healthy")!; row.stateDetail = "bounded"; tx.put(row); });
  expect(() => older.savePipelines([fixture("future")])).toThrow("preserved");
  expect(() => older.withDeliveryMutation((tx) => tx.delete("future"))).toThrow("preserved");
  expect(() => older.withDeliveryMutation((tx) => tx.put(fixture("future")))).toThrow("preserved");
  await older.archiveSettledPipelines();
  older.checkpointPipelineRollbackMirrorsForDemotion();
  const mirror = JSON.parse(fs.readFileSync(path.join(root, "pipelines.json"), "utf8"));
  expect(mirror.pipelines.find((row: { id: string }) => row.id === "future")).toEqual(JSON.parse(bytes));
  expect(storedBytes(root, "future")).toBe(bytes);
  expect(fs.readFileSync(path.join(root, "pipelines.json"), "utf8")).toContain(bytes);
  expect(loadPipelines().map((row) => row.id)).toEqual(["healthy", "future"]);
  expect(findPipelineRecord("future")!.stages[0]!.role!.roleId).toBe("merger");
}));

test("an older release imports a newer legacy record intact and the upgraded controller can read it", async () => isolated(async (root) => {
  const bytes = JSON.stringify(fixture("future", true), null, 3);
  fs.writeFileSync(path.join(root, "pipelines.json"), `{"schemaVersion":${PIPELINES_SCHEMA_VERSION},"pipelines":[${JSON.stringify(fixture("healthy"))},${bytes}]}`);
  const older = await olderStore(root);
  expect(older.loadPipelines().map((row) => row.id)).toEqual(["healthy"]);
  await older.withPipelineControllerMutation((rows, persist) => { expect(rows.map((row) => row.id)).toEqual(["healthy"]); persist(); });
  older.checkpointPipelineRollbackMirrorsForDemotion();
  expect(storedBytes(root, "future")).toBe(bytes);
  expect(fs.readFileSync(path.join(root, "pipelines.json"), "utf8")).toContain(bytes);
  await withPipelineControllerMutation((rows) => { expect(rows.map((row) => row.id)).toEqual(["healthy", "future"]); });
}));

test.each(["kind", "cursor-state", "attempt-state", "pipeline-state", "malformed"])("%s is identified and preserved while quiet-window reads healthy records", async (field) => isolated(async (root) => {
  savePipelines([fixture("healthy")]);
  const future = fixture("future") as unknown as Record<string, unknown>;
  if (field === "kind") (future.stages as Record<string, unknown>[])[0]!.kind = "future-stage";
  if (field === "cursor-state") (future.cursor as Record<string, unknown>).state = "future-cursor";
  if (field === "attempt-state") {
    future.state = "running";
    (future.cursor as Record<string, unknown>).state = "running";
    (future.runs as { attempts: unknown[] }[])[0]!.attempts.push({
      n: 1, state: "future-attempt", effectiveRole: fixture("role").stages[0]!.effectiveRole,
      launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
    });
  }
  if (field === "pipeline-state") future.state = "future-state";
  if (field === "malformed") future.runs = null;
  const bytes = JSON.stringify(future, null, 4);
  insertRaw(root, "future", bytes);
  expect(loadPipelines().map((row) => row.id)).toEqual(["healthy"]);
  expect(findPipelineRecord("healthy")?.id).toBe("healthy");
  expect(pipelineRegistryHealth()).toMatchObject([{ id: "future", reason: field === "malformed" ? "malformed" : "unknown-but-preserved" }]);
  const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;
  const quiet = await probeQuiet(snapshot, { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: loadPipelines, presence: () => [] }, Date.now());
  expect(quiet).toMatchObject({ quiet: true, blockers: { unreadable: null, registryIssues: [{ id: "future" }] } });
  savePipelines(loadPipelines());
  expect(storedBytes(root, "future")).toBe(bytes);
}));

test("unparseable SQLite rows and legacy JSON still abort reads and writes", async () => isolated(async (root) => {
  savePipelines([fixture("healthy")]);
  insertRaw(root, "broken", "{broken");
  expect(() => loadPipelines()).toThrow();
  expect(() => savePipelines([fixture("healthy")])).toThrow();
  expect(() => pipelineRegistryHealth()).toThrow("corrupt pipelines SQLite row");
  expect(storedBytes(root, "broken")).toBe("{broken");
  await isolated(async (legacy) => {
    fs.writeFileSync(path.join(legacy, "pipelines.json"), "{broken");
    expect(() => loadPipelines()).toThrow();
    await expect(withPipelineMutation((_, persist) => persist())).rejects.toThrow();
    expect(fs.readFileSync(path.join(legacy, "pipelines.json"), "utf8")).toBe("{broken");
  });
}));

test("publication admission skips a preserved future record without blocking healthy owners", async () => isolated((root) => {
  const healthy = fixture("healthy"); healthy.publication = "remote-branch";
  savePipelines([healthy]);
  const future = fixture("future"); future.publication = "remote-branch";
  (future.stages[0] as unknown as { kind: string }).kind = "future-kind";
  insertRaw(root, future.id, JSON.stringify(future));
  expect(unclaimedPipelinePublications().map((row) => row.id)).toEqual(["healthy"]);
}));
