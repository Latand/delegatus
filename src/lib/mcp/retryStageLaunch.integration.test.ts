/**
 * retry-stage over MCP names the launch it retries (#1845, second slice).
 *
 * The engine takes a retry that names its stage as a receipt retry and then
 * needs the failed attempt's launchId beside it. An agent had no way to read
 * that id short of the whole record, so a seat naming the stage was refused
 * with "receipt retry requires both stageId and launchId". The tool now fills
 * the launch from the record it reads, and the stage read answers it too.
 */
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { Pipeline } from "@/lib/pipelines/types";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "retry-stage-launch-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent.sock");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } = await import("./server");
const { pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
const { savePipelines, loadPipelines } = await import("@/lib/pipelines/store");
expect(loadPipelines()).toEqual([]);

const LAUNCH = "launch_failed_build";

/** A lane parked on its build stage, whose current attempt is a failed launch. */
function parkedPipeline(launchId: string | null = LAUNCH): Pipeline {
  const [, pipeline] = pipelineCorpus(2, 2);
  pipeline!.state = "needs_decision";
  pipeline!.stateDetail = "the build launch failed";
  pipeline!.cursor = { ...pipeline!.cursor!, stageId: "build", state: "pending" };
  const latest = pipeline!.runs.find((run) => run.stageId === "build")!.attempts.at(-1)!;
  Object.assign(latest, { state: "failed", verdict: null, launchId, paneId: null, error: "structured spawn transport failed" });
  return pipeline!;
}

async function protocol(overrides?: Record<string, unknown>) {
  const bindings = overrides ? viewerMcpBindings(undefined, undefined, overrides as never) : viewerMcpBindings();
  const server = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "retry-stage-launch-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { clientRequestId: `retry-${Math.random().toString(36).slice(2)}-${++sequence}`, ...args } });
    return { isError: result.isError === true, answer: result.structuredContent as Record<string, unknown>, raw: JSON.stringify(result) };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

test("retry-stage naming only the stage reaches the engine with that stage's failed launch", async () => {
  const pipeline = parkedPipeline();
  const requests: Array<Record<string, unknown>> = [];
  const p = await protocol({
    readPipelineRecord: (id: string) => (id === pipeline.id ? pipeline : null),
    patchPipeline: async (_id: string, request: Record<string, unknown>) => { requests.push(request); return { pipeline }; },
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
  });
  try {
    const named = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(named.isError).toBe(false);
    expect(requests.at(-1)).toMatchObject({ action: "retry-stage", stageId: "build", launchId: LAUNCH });

    /* A launch the caller names is passed as given, for the engine to judge. */
    await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build", launchId: "launch_older" });
    expect(requests.at(-1)).toMatchObject({ stageId: "build", launchId: "launch_older" });

    /* With no stage named, nothing is added: the engine picks the attempt. */
    await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage" });
    expect(requests.at(-1)).not.toHaveProperty("launchId");
    expect(requests.at(-1)).not.toHaveProperty("stageId");
  } finally {
    await p.close();
  }
});

test("retry-stage on a stage whose attempt never launched is fenced by expectedStageId instead", async () => {
  const pipeline = parkedPipeline(null);
  const requests: Array<Record<string, unknown>> = [];
  const p = await protocol({
    readPipelineRecord: (id: string) => (id === pipeline.id ? pipeline : null),
    patchPipeline: async (_id: string, request: Record<string, unknown>) => { requests.push(request); return { pipeline }; },
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
  });
  try {
    const answer = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(answer.isError).toBe(false);
    expect(requests.at(-1)).toMatchObject({ action: "retry-stage", expectedStageId: "build" });
    expect(requests.at(-1)).not.toHaveProperty("stageId");
    expect(requests.at(-1)).not.toHaveProperty("launchId");
  } finally {
    await p.close();
  }
});

test("the engine no longer refuses a stage-named retry for a missing launchId, and the stage read answers the launch", async () => {
  const pipeline = parkedPipeline();
  savePipelines([pipeline]);
  const p = await protocol();
  try {
    const read = await p.call("get_pipeline", { pipelineId: pipeline.id, stageId: "build" });
    expect(read.isError).toBe(false);
    expect(read.answer).toMatchObject({ attempt: { launchId: LAUNCH, state: "failed" } });

    /* The launch has no receipt in this sandbox, so the engine still refuses —
       now on the receipt it looked up, which it only does once it has the
       launch, rather than on the request's shape. */
    const retried = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(retried.raw).not.toContain("receipt retry requires both stageId and launchId");
    expect(retried.raw).toContain("the clicked launch receipt is no longer available");

    const tool = (await p.client.listTools()).tools.find((candidate) => candidate.name === "pipeline_action")!;
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.launchId?.description ?? "").toContain("retry-stage");
  } finally {
    await p.close();
  }
});
