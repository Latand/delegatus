import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPipeline, findPipelineRecord, loadPipelines, PIPELINES_SCHEMA_VERSION, savePipelines, unclaimedPipelinePublications, withPipelineControllerMutation, withPipelineMutation } from "./store";
import * as pipelineStore from "./store";
import { probeQuiet } from "@/lib/selfUpdate/quiet";
import type { Snapshot } from "@/lib/selfUpdate/types";

// Keep the incident tests runnable against releases predating this diagnostic.
const { pipelineRegistryHealth } = pipelineStore;

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

async function olderStore(root: string, vocabulary: [string, string] = ['"deployer", "merger"', '"deployer"']): Promise<typeof import("./store")> {
  // Exercise the real store with an older role vocabulary (pre-merger by
  // default), including its separate SQLite cache. All other validation and
  // persistence code is intact.
  const original = fs.readFileSync(path.join(import.meta.dir, "store.ts"), "utf8");
  expect(original).toContain(vocabulary[0]);
  const source = original
    .replace(vocabulary[0], vocabulary[1])
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

/* The visual critic joined the pipeline roles after the merger. A release that
   predates it keeps every stored lane of the older roles readable and writable,
   and preserves a visual-critic lane byte for byte until the newer release
   reads it again. */
test("a release before the visual critic keeps older-role lanes and preserves a visual-critic lane", async () => isolated(async (root) => {
  const critic = fixture("critic");
  critic.stages[0]!.role = { roleId: "visual-critic" };
  critic.stages[0]!.effectiveRole = { roleId: "visual-critic", engine: "claude", model: "opus", effort: "high", access: "read-only", promptScaffold: "You are a Visual-critic." };
  savePipelines([fixture("healthy"), fixture("merge", true)]);
  const bytes = JSON.stringify(critic, null, 2);
  insertRaw(root, "critic", bytes);
  expect(loadPipelines().map((row) => [row.id, row.stages[0]!.effectiveRole.roleId])).toEqual([["healthy", null], ["merge", "merger"], ["critic", "visual-critic"]]);
  const older = await olderStore(root, ['"merger", "visual-critic"]', '"merger"]']);
  expect(older.isEffectiveRole(critic.stages[0]!.effectiveRole)).toBe(false);
  expect(older.isEffectiveRole(fixture("merge", true).stages[0]!.effectiveRole)).toBe(true);
  expect(older.loadPipelines().map((row) => row.id)).toEqual(["healthy", "merge"]);
  await older.withPipelineMutation((rows, persist) => { rows[1]!.stateDetail = "older write"; persist(); });
  expect(storedBytes(root, "critic")).toBe(bytes);
  expect(loadPipelines().map((row) => [row.id, row.stateDetail ?? null])).toEqual([["healthy", null], ["merge", "older write"], ["critic", null]]);
  expect(findPipelineRecord("critic")!.stages[0]!.effectiveRole).toMatchObject({ roleId: "visual-critic", access: "read-only" });
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
  const healthy = fixture("zhealthy"); healthy.publication = "remote-branch";
  savePipelines([healthy]);
  for (let index = 0; index < 16; index++) {
    const future = fixture(`a${String(index).padStart(2, "0")}`); future.publication = "remote-branch";
    (future.stages[0] as unknown as { kind: string }).kind = "future-kind";
    insertRaw(root, future.id, JSON.stringify(future));
  }
  expect(loadPipelines().map((row) => row.id)).toEqual(["zhealthy"]);
  expect(unclaimedPipelinePublications().map((row) => row.id)).toEqual(["zhealthy"]);
}));

test.each(["sqlite", "legacy"])("%s parsed records with invalid nested types cannot throw through validation", async (storage) => isolated(async (root) => {
  const malformed = [
    { ...fixture("null-creation"), creationRequest: null },
    { ...fixture("object-state"), state: { toString: null } },
  ];
  if (storage === "sqlite") {
    savePipelines([fixture("healthy")]);
    for (const row of malformed) insertRaw(root, row.id, JSON.stringify(row));
  } else {
    fs.writeFileSync(path.join(root, "pipelines.json"), JSON.stringify({ schemaVersion: PIPELINES_SCHEMA_VERSION, pipelines: [fixture("healthy"), ...malformed] }));
  }
  expect(loadPipelines().map((row) => row.id)).toEqual(["healthy"]);
  expect(pipelineRegistryHealth().map((issue) => [issue.id, issue.reason])).toEqual(malformed.map((row) => [row.id, "malformed"]));
  const older = await olderStore(root);
  expect(older.loadPipelinesForStartup().map((row) => row.id)).toEqual(["healthy"]);
  savePipelines(loadPipelines());
  for (const row of malformed) expect(storedBytes(root, row.id)).toBe(JSON.stringify(row));
}));

test("an empty draft with only a future state is unknown-but-preserved", async () => isolated((root) => {
  savePipelines([fixture("healthy")]);
  const future = { ...fixture("empty-future"), stages: [], runs: [], cursor: null, state: "future-draft-state" };
  insertRaw(root, future.id, JSON.stringify(future));
  expect(pipelineRegistryHealth()).toMatchObject([{ id: future.id, reason: "unknown-but-preserved" }]);
}));
