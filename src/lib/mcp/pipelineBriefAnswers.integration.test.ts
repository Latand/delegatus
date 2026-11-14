import { afterAll, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-brief-answers-"));
const keys = ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "DELEGATUS_CODEX_HOME", "CODEX_HOME", "TMPDIR"] as const;
const previousCapability = process.env.LLV_SPAWN_CAPABILITY;
delete process.env.LLV_SPAWN_CAPABILITY;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
for (const key of keys) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
for (const key of ["DELEGATUS_CODEX_HOME", "LLV_CODEX_HOME", "CODEX_HOME"]) process.env[key] = path.join(sandbox, "CODEX_HOME");
afterAll(() => {
  setSystemTime();
  if (previousCapability === undefined) delete process.env.LLV_SPAWN_CAPABILITY;
  else process.env.LLV_SPAWN_CAPABILITY = previousCapability;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { buildPipeline, loadPipelines, pipelineRevision, savePipelines } = await import("@/lib/pipelines/store");
const { briefWarnings } = await import("@/lib/pipelines/briefWarnings");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const restoreTick = registerPipelineTick(async () => {});
afterAll(restoreTick);
const { PATCH, GET } = await import("@/app/api/pipelines/[id]/route");
const { POST } = await import("@/app/api/pipelines/route");
const { soloBrowserSession } = await import("@/lib/agent/operatorSession");
const { viewerMcpBindings, productionDomainDependencies, viewerMcpToolPolicy } = await import("./bindings");
const { agentRegistry } = await import("@/lib/agent/registry");
const creatorPath = path.join(process.env.CODEX_HOME!, "sessions", "creator.jsonl");
fs.mkdirSync(path.dirname(creatorPath), { recursive: true });
fs.writeFileSync(creatorPath, "{}\n");
const creator = agentRegistry().ensureConversation("codex", creatorPath, null);
const dependencies = { ...productionDomainDependencies,
  attentionAuthority: () => ({ kind: "worker" as const, conversationId: creator.id, role: "builder" as const }),
  callerAttribution: () => ({ kind: "manager" as const, conversationId: creator.id, role: "orchestrator" as const }),
};
const bindings = viewerMcpBindings(undefined, undefined, dependencies);

function fixture() {
  const pipeline = buildPipeline({ id: "brief-answer-lane", task: "Parser checks", project: "fixture", repoDir: sandbox,
    now: "2026-01-03T00:00:00.000Z", srcPath: null, srcConversationId: null,
    stages: [{ id: "build", kind: "run", next: null,
      "prompt": Array.from({ length: 12 }, (_, index) => `No changes in area ${index}.`).join("\n"),
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
  });
  pipeline.spec = "No production writes.";
  pipeline.state = "needs_decision";
  savePipelines([pipeline]);
  expect(briefWarnings(pipeline)).toHaveLength(13);
  return pipeline;
}

test("route retry on unchanged text answers zero of the thirteen stored warnings", async () => {
  const pipeline = fixture();
  const response = await PATCH(new NextRequest(`http://127.0.0.1/api/pipelines/${pipeline.id}`, {
    method: "PATCH", headers: { host: "127.0.0.1" }, body: JSON.stringify({ action: "retry-stage" }),
  }), { params: Promise.resolve({ id: pipeline.id }) });
  expect(response.status).toBe(200);
  const answer = await response.json();
  expect(answer.briefWarnings ?? []).toHaveLength(0);
  expect(answer.briefWarningCount).toBe(13);
});

test("MCP compact retry on unchanged text answers zero of the thirteen stored warnings", async () => {
  const pipeline = fixture();
  const answer = await bindings.pipeline_action({ pipelineId: pipeline.id, action: "retry-stage" });
  expect(answer).not.toHaveProperty("pipeline");
  expect(answer.briefWarnings ?? []).toHaveLength(0);
  expect(answer.briefWarningCount).toBe(13);
});

type Answer = { briefWarnings?: Array<{ stageId: string | null; source: string; messageIndex: number }>; briefWarningCount?: number; briefWarningMessages?: string[] };
const headers = () => ({ host: "127.0.0.1", cookie: `llv_operator=${soloBrowserSession()}` });

for (const surface of ["route", "MCP compact binding"] as const) {
  async function action(id: string, request: Record<string, unknown>): Promise<Answer> {
    if (surface === "MCP compact binding") return bindings.pipeline_action({ pipelineId: id, ...request });
    const response = await PATCH(new NextRequest(`http://127.0.0.1/api/pipelines/${id}`, {
      method: "PATCH", headers: headers(), body: JSON.stringify(request),
    }), { params: Promise.resolve({ id }) });
    const answer = await response.json();
    expect({ status: response.status, error: answer.error }).toEqual({ status: 200, error: undefined });
    return answer;
  }

  test(`${surface}: prompt edits return two changed warnings, identical edits return zero, full reads retain all three`, async () => {
    const pipeline = fixture();
    pipeline.state = "draft";
    savePipelines([pipeline]);
    const request = { action: "override-stage", stageId: "build", prompt: "No network access.\nNever publish." };
    const answer = await action(pipeline.id, request);
    expect(answer.briefWarningCount).toBe(3);
    expect(answer.briefWarnings).toHaveLength(2);
    expect(answer.briefWarnings!.every(row => row.stageId === "build" && row.source === "prompt")).toBe(true);
    expect(answer.briefWarningMessages).toHaveLength(1);
    const repeated = await action(pipeline.id, request);
    expect(repeated.briefWarnings ?? []).toHaveLength(0);
    expect(repeated.briefWarningCount).toBe(3);
    const full = surface === "MCP compact binding"
      ? await bindings.get_pipeline({ pipelineId: pipeline.id, full: true })
      : await (await GET(new NextRequest(`http://127.0.0.1/api/pipelines/${pipeline.id}`), { params: Promise.resolve({ id: pipeline.id }) })).json();
    expect(full.briefWarnings).toHaveLength(3);
    expect(full.briefWarnings).toEqual(briefWarnings(full.pipeline));
  });

  test(`${surface}: adding a stage returns one new warning out of fourteen`, async () => {
    const pipeline = fixture();
    pipeline.state = "draft";
    savePipelines([pipeline]);
    const answer = await action(pipeline.id, { action: "add-stage", after: "build", stage: {
      id: "verify", kind: "run", prompt: "Never deploy.", next: null, engine: "codex",
    } });
    expect(answer.briefWarningCount).toBe(14);
    expect(answer.briefWarnings).toHaveLength(1);
    expect(answer.briefWarnings![0]).toMatchObject({ stageId: "verify", source: "prompt" });
  });

  test(`${surface}: draft specification changes return its two warnings; a title change returns zero`, async () => {
    const pipeline = fixture();
    pipeline.state = "draft";
    savePipelines([pipeline]);
    const answer = await action(pipeline.id, { action: "update-draft", spec: "No production writes.\nNo package changes." });
    expect(answer.briefWarningCount).toBe(14);
    expect(answer.briefWarnings).toHaveLength(2);
    expect(answer.briefWarnings!.every(row => row.source === "spec")).toBe(true);
    const title = await action(pipeline.id, { action: "update-draft", task: "Parser verification" });
    expect(title.briefWarnings ?? []).toHaveLength(0);
    expect(title.briefWarningCount).toBe(14);
  });

  test(`${surface}: answering a settled decision and linking a task return zero warnings`, async () => {
    const pipeline = fixture();
    pipeline.srcConversationId = creator.id;
    pipeline.runs[0]!.attempts = [{ n: 1, state: "needs_decision", effectiveRole: pipeline.stages[0]!.effectiveRole,
      launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
      expectedReviewHeadSha: null, reviewHeadSha: null, startedAt: "2026-01-02T00:00:00.000Z",
      completedAt: "2026-01-02T01:00:00.000Z", input: "Implement the parser.", output: "Which format?",
      activatedBy: null, verdict: { status: "needs_decision", findings: [] }, error: null }];
    savePipelines([pipeline]);
    const decision = await action(pipeline.id, { action: "resolve-decision", clientRequestId: `brief-decision-${surface}`,
      answer: "Use Markdown.", expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(loadPipelines()[0]!) });
    expect(decision.briefWarnings ?? []).toHaveLength(0);
    expect(decision.briefWarningCount).toBe(13);
    const { saveTasks } = await import("@/lib/tasks/store");
    saveTasks([{ id: "brief-task", project: pipeline.project, status: "inbox", text: "Verify the parser",
      placement: "unplaced", assignments: [], createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }]);
    const linked = await action(pipeline.id, { action: "link-task", taskId: "brief-task" });
    expect(linked.briefWarnings ?? []).toHaveLength(0);
    expect(linked.briefWarningCount).toBe(13);
  });

  test(`${surface}: clearing a prompt returns zero warnings and keeps refusals free of diagnostics`, async () => {
    const pipeline = fixture();
    pipeline.state = "draft";
    savePipelines([pipeline]);
    const answer = await action(pipeline.id, { action: "override-stage", stageId: "build", prompt: "Implement the parser." });
    expect(answer.briefWarnings ?? []).toHaveLength(0);
    expect(answer.briefWarningCount).toBe(1);
    const before = loadPipelines();
    if (surface === "MCP compact binding") {
      await expect(bindings.pipeline_action({ pipelineId: pipeline.id, action: "override-stage", stageId: "missing", prompt: "Never deploy." })).rejects.toThrow();
    } else {
      const refused = await PATCH(new NextRequest(`http://127.0.0.1/api/pipelines/${pipeline.id}`, {
        method: "PATCH", headers: headers(), body: JSON.stringify({ action: "override-stage", stageId: "missing", prompt: "Never deploy." }),
      }), { params: Promise.resolve({ id: pipeline.id }) });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await refused.json()).not.toHaveProperty("briefWarnings");
    }
    expect(loadPipelines()).toEqual(before);
  });

  test(`${surface}: runtime override, edge edit, pause, resume and close return zero warnings`, async () => {
    for (const request of [
      { action: "override-stage", stageId: "build", model: "gpt-6.1-sol" },
      { action: "set-edge", stageId: "build", edge: "pass", to: null },
      { action: "pause" }, { action: "resume" }, { action: "close" },
    ]) {
      const pipeline = fixture();
      if (request.action === "resume") { pipeline.state = "paused"; pipeline.pausedState = "needs_decision"; }
      savePipelines([pipeline]);
      const answer = await action(pipeline.id, request);
      expect(answer.briefWarnings ?? []).toHaveLength(0);
      if (answer.briefWarningCount !== undefined) expect(answer.briefWarningCount).toBe(13);
    }
  });

  test(`${surface}: creation returns all thirteen warnings with one shared explanation`, async () => {
    const pipeline = fixture();
    const request = { task: "Parser warning acknowledgement", spec: pipeline.spec, src: creatorPath,
      repoDir: process.cwd(), autoStart: false, stages: [{ id: "build", kind: "run", engine: "codex", prompt: pipeline.stages[0]!.prompt, next: null }] };
    const answer = surface === "MCP compact binding"
      ? await bindings.create_pipeline({ ...request, clientRequestId: "brief-create" }) as Answer
      : await (await POST(new NextRequest("http://127.0.0.1/api/pipelines", { method: "POST", headers: headers(), body: JSON.stringify(request) }))).json() as Answer;
    expect(answer).not.toHaveProperty("error");
    expect(answer.briefWarnings).toHaveLength(13);
    expect(answer.briefWarningCount).toBe(13);
    expect(answer.briefWarningMessages).toHaveLength(1);
    expect(answer.briefWarnings!.every(row => row.messageIndex === 0)).toBe(true);
  });
}

test("SDK transport and tool service preserve compact retry and full warning reads", async () => {
  const pipeline = fixture();
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
  const { POST: mcpPOST } = await import("@/app/api/mcp/route");
  const { setMcpHttpDependenciesForTests } = await import("./http");
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  const capability = "c".repeat(43);
  let calls = 0;
  setMcpHttpDependenciesForTests({ service: async () => ({ callTool: (name, args, context) => service.callTool(name, args, context) }),
    conversationForCapability: value => value === capability ? creator.id : null });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method === "POST" && (await request.clone().json()).method === "tools/call") calls++;
    return mcpPOST(new NextRequest(request));
  } });
  const client = new Client({ name: "pipeline-brief-answers", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), { requestInit: { headers: { "x-llv-spawn-capability": capability } } }));
    const retry = await client.callTool({ name: "pipeline_action", arguments: { pipelineId: pipeline.id, action: "retry-stage", clientRequestId: "sdk-brief-retry" } });
    expect(retry.isError).not.toBe(true);
    expect(retry.structuredContent).toMatchObject({ briefWarningCount: 13 });
    expect(retry.structuredContent).not.toHaveProperty("briefWarnings");
    const full = await client.callTool({ name: "get_pipeline", arguments: { pipelineId: pipeline.id, full: true } });
    expect(full.isError).not.toBe(true);
    expect((full.structuredContent as { briefWarnings: unknown[] }).briefWarnings).toHaveLength(13);
    const refused = await client.callTool({ name: "pipeline_action", arguments: { pipelineId: "missing-lane", action: "retry-stage", clientRequestId: "sdk-brief-refused" } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).not.toHaveProperty("briefWarnings");
    expect(calls).toBe(3);
  } finally { await client.close(); listener.stop(true); setMcpHttpDependenciesForTests(null); }
});
