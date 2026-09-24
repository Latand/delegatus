/**
 * retry-stage over MCP names the stage it retries (#1845, second slice).
 *
 * The engine reads a retry that carries stageId as an explicit launch-receipt
 * retry: it needs that attempt's launchId beside it and retries only a receipt
 * that settled failed or conflicted. A seat naming only the stage was refused
 * with "receipt retry requires both stageId and launchId", and a launchId
 * filled in for it would still be refused for every stage whose agent started
 * and then failed or parked. The tool sends such a stage as expectedStageId
 * and expectedAttempt instead, which retries the stage the lane waits on
 * whatever ended its attempt and refuses one that moved on.
 */
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { PipelineSpawnReceipt } from "@/lib/pipelines/engine";
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
const { defaultPipelinePorts, getPipeline, patchPipeline } = await import("@/lib/pipelines/engine");
expect(loadPipelines()).toEqual([]);

const LAUNCH = "launch_build_2";

/** A lane parked on its build stage. By default the agent started and its
    stage ended on a fail verdict; `launchFailed` makes it a launch that never
    produced an agent, and `launchId: null` one that never launched at all. */
function parkedPipeline(options: { launchFailed?: boolean; launchId?: string | null } = {}): Pipeline {
  const [, pipeline] = pipelineCorpus(2, 2);
  pipeline!.state = "needs_decision";
  pipeline!.cursor = { ...pipeline!.cursor!, stageId: "build", state: "pending" };
  const latest = pipeline!.runs.find((run) => run.stageId === "build")!.attempts.at(-1)!;
  const launchId = options.launchId === undefined ? LAUNCH : options.launchId;
  if (options.launchFailed) {
    pipeline!.stateDetail = "the build launch failed";
    Object.assign(latest, { state: "failed", verdict: null, launchId, paneId: null, completedAt: null, error: "structured spawn transport failed" });
  } else {
    pipeline!.stateDetail = "build: tests fail";
    Object.assign(latest, { state: "failed", verdict: { status: "fail", findings: ["tests fail"] }, launchId, conversationId: "conversation_build_2", paneId: null, error: null });
  }
  return pipeline!;
}

function receiptFor(state: PipelineSpawnReceipt["state"]) {
  return (launchId: string): PipelineSpawnReceipt | null => launchId === LAUNCH
    ? { state, launchId, conversationId: "conversation_build_2", sessionId: null, "transcript": null, paneId: null } as PipelineSpawnReceipt
    : null;
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

/** The MCP tools over the real engine, whose launch receipts are the ones given. */
function engineWithReceipts(spawnReceipt: (launchId: string) => PipelineSpawnReceipt | null, extra: Record<string, unknown> = {}) {
  /* A failed receipt is claimed for the retry in the agent registry, which this
     sandbox leaves empty; the claim is the engine's and succeeds here. */
  const ports = { ...defaultPipelinePorts(), spawnReceipt, claimSpawnRetry: () => "claimed" as const };
  return protocol({
    readPipelineRecord: getPipeline,
    patchPipeline: (id: string, request: never) => patchPipeline(id, request, ports),
    ...extra,
  });
}

test("retry-stage naming only the stage reaches the engine as the stage and attempt it waits on", async () => {
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
    expect(requests.at(-1)).toMatchObject({ action: "retry-stage", expectedStageId: "build", expectedAttempt: 2 });
    expect(requests.at(-1)).not.toHaveProperty("stageId");
    expect(requests.at(-1)).not.toHaveProperty("launchId");

    /* A launch the caller names is passed as given, for the engine to judge. */
    await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build", launchId: "launch_older" });
    expect(requests.at(-1)).toMatchObject({ stageId: "build", launchId: "launch_older" });
    expect(requests.at(-1)).not.toHaveProperty("expectedAttempt");

    /* With no stage named, nothing is added: the engine picks the attempt. */
    await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage" });
    expect(requests.at(-1)).not.toHaveProperty("expectedStageId");
    expect(requests.at(-1)).not.toHaveProperty("stageId");

    /* A stage and a guard naming another stage are refused before the engine. */
    const count = requests.length;
    const conflicting = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build", expectedStageId: "review" });
    expect(conflicting.isError).toBe(true);
    expect(conflicting.raw).toContain("STAGE_CHANGED");
    expect(requests.length).toBe(count);
  } finally {
    await p.close();
  }
});

test("retry-stage by stage retries a stage whose agent started and ended on a fail verdict", async () => {
  const pipeline = parkedPipeline();
  savePipelines([pipeline]);
  const p = await engineWithReceipts(receiptFor("completed"));
  try {
    const read = await p.call("get_pipeline", { pipelineId: pipeline.id, stageId: "build" });
    expect(read.answer).toMatchObject({ attempt: { launchId: LAUNCH } });

    const retried = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(retried.raw).not.toContain("retry was cancelled");
    expect(retried.isError).toBe(false);
    /* Accepted: the lane leaves its park and re-provisions for attempt 3. */
    expect(loadPipelines()[0]!.state).not.toBe("needs_decision");
  } finally {
    await p.close();
  }
});

test("retry-stage by stage still retries a launch that failed, with or without its launchId", async () => {
  for (const launchId of [undefined, LAUNCH]) {
    const pipeline = parkedPipeline({ launchFailed: true });
    savePipelines([pipeline]);
    const p = await engineWithReceipts(receiptFor("failed"));
    try {
      const retried = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build", ...(launchId ? { launchId } : {}) });
      expect(retried.isError).toBe(false);
      expect(loadPipelines()[0]!.state).not.toBe("needs_decision");
    } finally {
      await p.close();
    }
  }
});

test("retry-stage by stage is refused with STAGE_CHANGED when the lane waits on another stage or attempt", async () => {
  const pipeline = parkedPipeline();
  savePipelines([pipeline]);
  const p = await engineWithReceipts(receiptFor("completed"));
  try {
    const otherStage = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "review" });
    expect(otherStage.isError).toBe(true);
    expect(otherStage.raw).toContain("STAGE_CHANGED");
    expect(otherStage.raw).toContain("expectedStageId");
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
  } finally {
    await p.close();
  }

  /* The record the tool read still showed attempt 1; the engine sees attempt 2. */
  const stale = structuredClone(pipeline);
  stale.runs.find((run) => run.stageId === "build")!.attempts.pop();
  const q = await engineWithReceipts(receiptFor("completed"), { readPipelineRecord: (id: string) => (id === stale.id ? stale : null) });
  try {
    const olderAttempt = await q.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(olderAttempt.isError).toBe(true);
    expect(olderAttempt.raw).toContain("STAGE_CHANGED");
    expect(olderAttempt.raw).toContain("expectedAttempt");
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
  } finally {
    await q.close();
  }
});

test("retry-stage on a stage whose attempt never launched is fenced the same way", async () => {
  const pipeline = parkedPipeline({ launchFailed: true, launchId: null });
  const requests: Array<Record<string, unknown>> = [];
  const p = await protocol({
    readPipelineRecord: (id: string) => (id === pipeline.id ? pipeline : null),
    patchPipeline: async (_id: string, request: Record<string, unknown>) => { requests.push(request); return { pipeline }; },
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
  });
  try {
    const answer = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(answer.isError).toBe(false);
    expect(requests.at(-1)).toMatchObject({ action: "retry-stage", expectedStageId: "build", expectedAttempt: 2 });
    expect(requests.at(-1)).not.toHaveProperty("stageId");
    expect(requests.at(-1)).not.toHaveProperty("launchId");

    const tool = (await p.client.listTools()).tools.find((candidate) => candidate.name === "pipeline_action")!;
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.launchId?.description ?? "").toContain("only for an attempt whose launch failed");
  } finally {
    await p.close();
  }
});
