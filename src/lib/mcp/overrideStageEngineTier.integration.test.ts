/**
 * Moving a stage to Claude over MCP drops the Codex tier it only preferred.
 *
 * A merge-queue refresh lane stores `preferredServiceTier: ultrafast` on its
 * stages, and a role row may carry a default tier of its own. Neither applies
 * to Claude, yet `pipeline_action override-stage` with engine claude was
 * refused with "preferredServiceTier is Codex only", even with serviceTier
 * null, so a seat could not move unstarted stages off nearly exhausted Codex
 * accounts. An explicit Codex tier, sent or stored, still needs serviceTier
 * null before the stage leaves Codex.
 *
 * The calls go through the SDK client, the HTTP route on a port-0 loopback
 * listener, the real tool service with its policy, receipts and schema, and
 * the real pipeline engine and store.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "override-stage-tier-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent.sock");
process.env.LLV_STRUCTURED_HOSTS = "0";

const { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { setMcpHttpDependenciesForTests } = await import("./http");
const { POST } = await import("@/app/api/mcp/route");
const { saveRoleMapping } = await import("@/lib/roles/store");
const { createPipelineFromRequest, defaultPipelinePorts, patchPipeline } = await import("@/lib/pipelines/engine");
const { loadPipelines, savePipelines } = await import("@/lib/pipelines/store");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
type PipelinePorts = import("@/lib/pipelines/engine").PipelinePorts;
type ViewerMcpDomainDependencies = import("./bindings").ViewerMcpDomainDependencies;

registerPipelineTick(async () => {});
const REPO = path.join(sandbox, "repo");
fs.mkdirSync(REPO, { recursive: true });
const SEAT = "conversation_seat";
const CAPABILITY = "c".repeat(43);

/* The reviewer row carries a Codex default tier, as an operator override
   does on the merger row. */
saveRoleMapping({ reviewer: { config: { engine: "codex", model: "gpt-6.1-sol", effort: "xhigh", serviceTier: "priority" } } });

/* The default Codex account's catalog offers both tiers, so an explicit
   tier is admitted and only the engine rule decides. */
for (const home of [process.env.CODEX_HOME!, process.env.LLV_CODEX_HOME!]) {
  fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", service_tiers: [{ id: "priority" }, { id: "ultrafast" }] }] }));
}

const ports: PipelinePorts = {
  ...defaultPipelinePorts(),
  exec: (command, args) => {
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") return { code: 2, stdout: "", stderr: "No such remote" };
    throw new Error(`unexpected fixture command: ${command} ${args.join(" ")}`);
  },
  preflightRepo: () => ({ ok: true, repoDir: REPO, gitCommonDir: path.join(REPO, ".git"), worktreeParent: sandbox }),
  projectForCwd: () => "project-tier",
  allowedAccountIds: () => null,
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  savePipelines([]);
});
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** A draft lane created through the engine's own create path. */
async function draftLane(stages: Record<string, unknown>[]) {
  const created = await createPipelineFromRequest({ task: "Move unstarted stages to Claude", repoDir: REPO, autoStart: false,
    stages: stages.map((stage, index) => ({ kind: "run", prompt: `Stage ${index}`, next: stages[index + 1]?.id ?? null, ...stage })) } as never,
  ports, { allowOperatorDraftWithoutLineage: true });
  if (!created.pipeline) throw new Error(`draft was not created: ${created.error}`);
  return created.pipeline;
}

async function connect() {
  const dependencies: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "manager", conversationId: SEAT, role: "orchestrator" }),
    patchPipeline: (id, request, _ports, actor) => patchPipeline(id, request, ports, actor),
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  setMcpHttpDependenciesForTests({
    service: async () => ({ callTool: (name, args, context) => service.callTool(name, args, context) }),
    conversationForCapability: capability => capability === CAPABILITY ? SEAT : null,
  });
  cleanups.push(() => setMcpHttpDependenciesForTests(null));
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
  cleanups.push(() => listener.stop(true));
  const client = new Client({ name: "override-stage-tier", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/api/mcp`), {
    requestInit: { headers: { "x-llv-spawn-capability": CAPABILITY } },
  }));
  cleanups.push(() => client.close());
  let sequence = 0;
  return async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "pipeline_action", arguments: { clientRequestId: `override-${++sequence}`, action: "override-stage", ...args } });
    return { isError: result.isError === true, answer: result.structuredContent as Record<string, unknown>, raw: JSON.stringify(result) };
  };
}

const stored = (pipelineId: string, stageId: string) => loadPipelines().find(row => row.id === pipelineId)!.stages.find(stage => stage.id === stageId)!;
const TO_CLAUDE = { engine: "claude", model: "opus", effort: "high" };

test("a refresh-lane preferred tier is dropped when the stage moves to Claude, with and without serviceTier null", async () => {
  const lane = await draftLane([
    { id: "review", role: { roleId: "reviewer" }, engine: "codex", model: "gpt-6.1-sol", effort: "high", preferredServiceTier: "ultrafast" },
    { id: "recheck", role: { roleId: "reviewer" }, engine: "codex", model: "gpt-6.1-sol", effort: "high", preferredServiceTier: "ultrafast" },
  ]);
  expect(stored(lane.id, "review").effectiveRole).toMatchObject({ serviceTier: "ultrafast", serviceTierSource: "role-default", preferredServiceTier: "ultrafast" });
  const override = await connect();

  for (const [stageId, extra] of [["review", {}], ["recheck", { serviceTier: null }]] as const) {
    const moved = await override({ pipelineId: lane.id, stageId, ...TO_CLAUDE, ...extra });
    expect(moved.isError, moved.raw).toBe(false);
    expect(String((moved.answer.graphEdit as { summary: string }).summary)).toContain("dropped Codex service tier ultrafast, which does not apply to Claude");
    const stage = stored(lane.id, stageId);
    expect(stage).toMatchObject({ engine: "claude", model: "opus", effort: "high" });
    expect(stage.preferredServiceTier).toBeUndefined();
    expect(stage.effectiveRole).toMatchObject({ engine: "claude", model: "opus", effort: "high" });
    for (const key of ["serviceTier", "serviceTierSource", "preferredServiceTier"] as const) expect(stage.effectiveRole[key]).toBeUndefined();
  }
});

test("a role-default tier is dropped on the move to Claude and comes back when the stage returns to Codex", async () => {
  const lane = await draftLane([{ id: "review", role: { roleId: "reviewer" } }]);
  expect(stored(lane.id, "review").effectiveRole).toMatchObject({ engine: "codex", serviceTier: "priority", serviceTierSource: "role-default" });
  const override = await connect();

  const moved = await override({ pipelineId: lane.id, stageId: "review", ...TO_CLAUDE });
  expect(moved.isError, moved.raw).toBe(false);
  expect(String((moved.answer.graphEdit as { summary: string }).summary)).toContain("dropped Codex service tier priority");
  expect(stored(lane.id, "review").effectiveRole.serviceTier).toBeUndefined();

  const back = await override({ pipelineId: lane.id, stageId: "review", engine: "codex", model: "gpt-6.1-sol", effort: "xhigh" });
  expect(back.isError, back.raw).toBe(false);
  expect(String((back.answer.graphEdit as { summary: string }).summary)).not.toContain("dropped");
  expect(stored(lane.id, "review").effectiveRole).toMatchObject({ engine: "codex", model: "gpt-6.1-sol", serviceTier: "priority", serviceTierSource: "role-default" });
});

test("an explicit Codex tier still needs serviceTier null before the stage moves to Claude", async () => {
  const lane = await draftLane([
    { id: "pinned", role: { roleId: "reviewer" }, engine: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "priority" },
    { id: "review", role: { roleId: "reviewer" } },
  ]);
  const override = await connect();

  const sent = await override({ pipelineId: lane.id, stageId: "review", ...TO_CLAUDE, serviceTier: "priority" });
  expect(sent.isError).toBe(true);
  expect(sent.raw).toContain("serviceTier is Codex only");
  expect(stored(lane.id, "review").effectiveRole.engine).toBe("codex");

  const kept = await override({ pipelineId: lane.id, stageId: "pinned", ...TO_CLAUDE });
  expect(kept.isError).toBe(true);
  expect(kept.raw).toContain("serviceTier is Codex only");
  expect(stored(lane.id, "pinned")).toMatchObject({ serviceTier: "priority", effectiveRole: { engine: "codex", serviceTier: "priority", serviceTierSource: "explicit" } });

  const cleared = await override({ pipelineId: lane.id, stageId: "pinned", ...TO_CLAUDE, serviceTier: null });
  expect(cleared.isError, cleared.raw).toBe(false);
  expect(String((cleared.answer.graphEdit as { summary: string }).summary)).not.toContain("dropped");
  expect(stored(lane.id, "pinned")).toMatchObject({ serviceTier: null, effectiveRole: { engine: "claude", model: "opus" } });
  expect(stored(lane.id, "pinned").effectiveRole.serviceTier).toBeUndefined();
});

test("create_pipeline's create path accepts engine claude on a role whose default tier is Codex only", async () => {
  const lane = await draftLane([{ id: "review", role: { roleId: "reviewer" }, ...TO_CLAUDE }]);
  expect(stored(lane.id, "review").effectiveRole).toMatchObject({ engine: "claude", model: "opus" });
  expect(stored(lane.id, "review").effectiveRole.serviceTier).toBeUndefined();
  /* A tier the caller names for a Claude stage is still its own error. */
  const named = await createPipelineFromRequest({ task: "Named tier", repoDir: REPO, autoStart: false,
    stages: [{ id: "review", kind: "run", prompt: "Review", next: null, role: { roleId: "reviewer" }, ...TO_CLAUDE, preferredServiceTier: "ultrafast" }] } as never,
  ports, { allowOperatorDraftWithoutLineage: true });
  expect(named.error).toContain("preferredServiceTier is Codex only");
});
