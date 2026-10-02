import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkpointFlowRollbackMirrorForDemotion, loadFlow, loadFlows, loadFlowsForTick, saveFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { buildWorkflow, checkpointWorkflowRollbackMirrorForDemotion, loadWorkflows, normalizeTemplate, saveWorkflows } from "@/lib/workflows/store";
import { buildPipeline, checkpointPipelineRollbackMirrorsForDemotion, loadPipelines, PIPELINES_SCHEMA_VERSION, savePipelines } from "@/lib/pipelines/store";
import { jsonArrayRecordBytes } from "./registryRecords";

async function isolated(run: (root: string) => Promise<void> | void) {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-records-"));
  process.env.LLV_STATE_DIR = root;
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const flow = (): Flow => ({
  id: "healthy-flow", template: "implement-review-loop", project: "fixture", cwd: "/repo", implementerPath: "/implementer.jsonl",
  roles: { implementer: { engine: "codex", model: null, effort: "high" }, reviewer: { engine: "codex", model: null, effort: "high" } },
  baseRef: "base", baseMode: "head", mode: "auto", reviewerMode: "headless", roundLimit: 5,
  state: "waiting_ready", stateDetail: null, rounds: [], createdAt: "now", closedAt: null,
});

test.each(["flows", "workflows", "pipelines"])("%s legacy import and replacement preserve rejected bytes and keep healthy rows writable", async (collection) => isolated(async (root) => {
  const healthy = collection === "flows" ? flow() : collection === "workflows"
    ? buildWorkflow({ id: "healthy-workflow", name: "Fixture", task: "Task", project: "fixture", repoDir: "/repo", mode: "manual", now: "now",
      template: normalizeTemplate({ name: "Fixture", stages: [{ kind: "implement", agent: { engine: "codex", model: null, effort: "high" }, scope: "Code" },
        { kind: "review-loop", reviewer: { engine: "codex", model: null, effort: "high" }, fixer: { engine: "codex", model: null, effort: "high" }, roundLimit: 5, reviewerMode: "headless" }], finish: "comment" })! })
    : buildPipeline({ id: "healthy-pipeline", task: "Task", project: "fixture", repoDir: "/repo", now: "now", srcPath: null, srcConversationId: null,
      stages: [{ id: "build", kind: "run", prompt: "Build", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: null } }] });
  const rejected = '{ "id" : "rejected-row", "rounds" : [], "unrecognized" : [1e2, {"text": "brackets ] }"}] }';
  const header = collection === "pipelines" ? `"schemaVersion":${PIPELINES_SCHEMA_VERSION},` : "";
  const file = path.join(root, `${collection}.json`);
  fs.writeFileSync(file, `{${header}"${collection}":[${JSON.stringify(healthy)},${rejected}]}`);
  const read = () => collection === "flows" ? loadFlows() : collection === "workflows" ? loadWorkflows() : loadPipelines();
  expect(read().map((row) => row.id)).toEqual([healthy.id]);
  if (collection === "flows") {
    expect(loadFlow(healthy.id)?.id).toBe(healthy.id);
    expect(loadFlow("rejected-row")).toBeNull();
    expect(loadFlowsForTick().map((row) => row.id)).toEqual([healthy.id]);
    saveFlows([{ ...flow(), stateDetail: "updated" }]);
    checkpointFlowRollbackMirrorForDemotion();
  } else if (collection === "workflows") {
    const rows = loadWorkflows(); rows[0]!.stateDetail = "updated"; saveWorkflows(rows);
    checkpointWorkflowRollbackMirrorForDemotion();
  } else {
    const rows = loadPipelines(); rows[0]!.stateDetail = "updated"; savePipelines(rows);
    checkpointPipelineRollbackMirrorsForDemotion();
  }
  expect(read()[0]!.stateDetail).toBe("updated");
  const db = new Database(path.join(root, "state.sqlite"));
  try { expect(db.query("SELECT value_json FROM state_rows WHERE collection=? AND row_key='rejected-row'").get(collection)).toEqual({ value_json: rejected }); }
  finally { db.close(); }
  expect(fs.readFileSync(file, "utf8")).toContain(rejected);
}));

test("a flow whose shallow history shape passes but lacks decoder fields does not poison its neighbors", async () => isolated((root) => {
  const incomplete = { ...flow(), id: "missing-roles", roles: undefined };
  fs.writeFileSync(path.join(root, "flows.json"), JSON.stringify({ flows: [flow(), incomplete] }));
  expect(loadFlows().map((row) => row.id)).toEqual(["healthy-flow"]);
  saveFlows(loadFlows());
  expect(loadFlow("missing-roles")).toBeNull();
}));

test.each(["flows", "workflows"])("%s unparseable SQLite rows still fail loudly", async (collection) => isolated((root) => {
  if (collection === "flows") saveFlows([]); else saveWorkflows([]);
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES (?,'broken','{broken',0,1,1)").run(collection);
    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection=?").run(collection);
    expect(() => collection === "flows" ? loadFlows() : loadWorkflows()).toThrow("malformed row");
    expect(() => collection === "flows" ? saveFlows([]) : saveWorkflows([])).toThrow();
  } finally { db.close(); }
}));

test("raw JSON element extraction follows the last top-level array key and preserves numeric spelling", () => {
  const raw = '{"nested":{"rows":[0]},"rows":[false],"rows":[ 1e2, { "escaped":"\\\" ] }", "array":[true,null] }, "end" ]}';
  expect(jsonArrayRecordBytes(raw, "rows")).toEqual(['1e2', '{ "escaped":"\\\" ] }", "array":[true,null] }', '"end"']);
});
