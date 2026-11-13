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
import { afterAll, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";

import type { PipelineSpawnReceipt } from "@/lib/pipelines/engine";
import type { Pipeline } from "@/lib/pipelines/types";

// Establish every state root before importing production bindings.
setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
afterAll(() => setSystemTime());
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

const { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
const { savePipelines, loadPipelines } = await import("@/lib/pipelines/store");
const { defaultPipelinePorts, getPipeline, patchPipeline } = await import("@/lib/pipelines/engine");
expect(loadPipelines()).toEqual([]);

const { POST } = await import("@/app/api/mcp/route");
const { setMcpHttpDependenciesForTests } = await import("./http");
let protocolSequence = 0;

const LAUNCH = "launch_build_2";

/** A lane parked on its build stage. By default the agent started and its
    stage ended on a fail verdict; `launchFailed` makes it a launch that never
    produced an agent, and `launchId: null` one that never launched at all. */
function parkedPipeline(options: { launchFailed?: boolean; launchId?: string | null } = {}): Pipeline {
  const [, pipeline] = pipelineCorpus(2, 2);
  // The corpus keeps a stored legacy review stage; these lanes are current ones.
  for (const stage of pipeline!.stages) if (stage.kind !== "run") Object.assign(stage, { kind: "run" });
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
  const dependencies = { ...productionDomainDependencies, ...overrides };
  const bindings = viewerMcpBindings(undefined, undefined, dependencies);
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  const capability = "c".repeat(43);
  setMcpHttpDependenciesForTests({
    service: async () => ({ callTool: (name, args, context) => service.callTool(name, args, context) }),
    conversationForCapability: value => value === capability ? "conversation_orchestrator" : null,
  });
  let requests = 0;
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method === "POST") {
      const body = await request.clone().json();
      if (body.method === "tools/call") requests++;
    }
    return POST(new NextRequest(request));
  } });
  const client = new Client({ name: "retry-stage-launch-test", version: "1" });
  const close = async () => { await client.close(); listener.stop(true); setMcpHttpDependenciesForTests(null); };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
      requestInit: { headers: { "x-llv-spawn-capability": capability } },
    }));
  } catch (error) { await close(); throw error; }
  const protocolId = ++protocolSequence;
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const before = requests;
    const result = await client.callTool({ name, arguments: { clientRequestId: `retry-${protocolId}-${++sequence}`, ...args } });
    expect(requests).toBe(before + 1);
    return { isError: result.isError === true, answer: result.structuredContent as Record<string, unknown>, raw: JSON.stringify(result) };
  };
  return { client, call, close };
}

/** The MCP tools over the real engine, whose launch receipts are the ones given. */
function engineWithReceipts(spawnReceipt: (launchId: string) => PipelineSpawnReceipt | null, extra: Record<string, unknown> = {}) {
  /* A failed receipt is claimed for the retry in the agent registry, which this
     sandbox leaves empty; the claim is the engine's and succeeds here. */
  const ports = {
    ...defaultPipelinePorts(),
    spawnReceipt,
    // Both receipt reads must consult the same synthetic launch ledger.
    spawnReceiptState: (launchId: string) => spawnReceipt(launchId)?.state ?? null,
    claimSpawnRetry: () => "claimed" as const,
  };
  return protocol({
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
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
    expect(retried.isError, retried.raw).toBe(false);
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
      expect(retried.isError, retried.raw).toBe(false);
      expect(loadPipelines()[0]!.state).not.toBe("needs_decision");
    } finally {
      await p.close();
    }
  }
});

test("retry-stage naming the completed launch of a stage whose host was lost retries it (#1871)", async () => {
  /* The card and get_pipeline both name the attempt's launch. Its launch
     completed; a restart then lost the host before the stage reported, so the
     stage ended on its own and the named launch says nothing more than that. */
  const pipeline = parkedPipeline();
  const latest = pipeline.runs.find((run) => run.stageId === "build")!.attempts.at(-1)!;
  Object.assign(latest, { verdict: null, error: "historical attempt completed without a valid final JSON verdict" });
  pipeline.stateDetail = latest.error;
  savePipelines([pipeline]);
  const p = await engineWithReceipts(receiptFor("completed"));
  try {
    const retried = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build", launchId: LAUNCH });
    expect(retried.raw).not.toContain("retry was cancelled");
    expect(retried.isError, retried.raw).toBe(false);
    expect(loadPipelines()[0]!.state).not.toBe("needs_decision");
  } finally {
    await p.close();
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

  } finally {
    await p.close();
  }
});

/** The build attempt ran for a long time and a provider error then parked it,
    while its launch receipt never closed (#3760). */
function providerCutPipeline(): Pipeline {
  const pipeline = parkedPipeline();
  const latest = pipeline.runs.find((run) => run.stageId === "build")!.attempts.at(-1)!;
  const detail = "stage cut by provider error after 0 tries; last: API Error: Connection lost";
  Object.assign(latest, { state: "needs_decision", verdict: null, error: detail, sessionId: "session_build_2",
    agentPath: path.join(sandbox, "build-2.jsonl"), completedAt: "2026-01-02T00:00:00.000Z" });
  pipeline.cursor = { ...pipeline.cursor!, state: "running" };
  pipeline.stateDetail = detail;
  return pipeline;
}

test("retry-stage retries a stage parked after it ran while its launch receipt is still open, stopping its host first (#3760)", async () => {
  const pipeline = providerCutPipeline();
  savePipelines([pipeline]);
  const stops: string[] = [];
  const spawnReceipt = receiptFor("path-pending");
  const ports = { ...defaultPipelinePorts(), spawnReceipt,
    spawnReceiptState: (launchId: string) => spawnReceipt(launchId)?.state ?? null,
    claimSpawnRetry: () => "claimed" as const,
    stopStageAgent: async (target: { conversationId?: string | null }) => { stops.push(String(target.conversationId)); return { outcome: "stopped" as const }; } };
  const p = await protocol({
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
    readPipelineRecord: getPipeline,
    patchPipeline: (id: string, request: never) => patchPipeline(id, request, ports as never),
  });
  try {
    const retried = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(retried.isError, retried.raw).toBe(false);
    expect(stops).toEqual(["conversation_build_2"]);
    expect(loadPipelines()[0]!.state).not.toBe("needs_decision");
  } finally {
    await p.close();
  }
});

test("that retry is refused, and the lane stays parked, while the old host has not confirmed its stop (#3760)", async () => {
  const pipeline = providerCutPipeline();
  savePipelines([pipeline]);
  const spawnReceipt = receiptFor("path-pending");
  const ports = { ...defaultPipelinePorts(), spawnReceipt,
    spawnReceiptState: (launchId: string) => spawnReceipt(launchId)?.state ?? null,
    claimSpawnRetry: () => "claimed" as const,
    stopStageAgent: async () => ({ outcome: "unconfirmed" as const, error: "the host is still running" }) };
  const p = await protocol({
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
    readPipelineRecord: getPipeline,
    patchPipeline: (id: string, request: never) => patchPipeline(id, request, ports as never),
  });
  try {
    const retried = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(retried.isError).toBe(true);
    const after = loadPipelines()[0]!;
    expect(after.state).toBe("needs_decision");
    expect(after.runs.find((run) => run.stageId === "build")!.attempts.length).toBe(pipeline.runs.find((run) => run.stageId === "build")!.attempts.length);
  } finally {
    await p.close();
  }
});

test("a launch that never produced a turn keeps its open receipt refusal (#3760)", async () => {
  const pipeline = parkedPipeline();
  const latest = pipeline.runs.find((run) => run.stageId === "build")!.attempts.at(-1)!;
  Object.assign(latest, { state: "needs_decision", verdict: null, error: "provider recovery parked", agentPath: null, sessionId: null });
  pipeline.stateDetail = latest.error;
  savePipelines([pipeline]);
  const p = await engineWithReceipts(receiptFor("path-pending"));
  try {
    const retried = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(retried.isError).toBe(true);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
  } finally {
    await p.close();
  }
});

// Retained records use the attempt's settlement, even when launch publication
// stopped before its acknowledgement. Reading them needs no migration.
test.each(["starting", "pane-bound", "path-pending", "prompt-delivered", "host-verified", "completed", "failed", "conflicted", null] as const)
("settled attempt retries through loopback MCP with a retained %s launch", async state => {
  for (const explicit of [false, true]) {
    const pipeline = parkedPipeline();
    const latest = pipeline.runs.find(run => run.stageId === "build")!.attempts.at(-1)!;
    Object.assign(latest, { startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-02T00:00:00.000Z" });
    savePipelines([pipeline]);
    const old = structuredClone(loadPipelines()[0]!.runs.find(run => run.stageId === "build")!.attempts.at(-1)!);
    let claims = 0;
    const receipt = state ? { ...receiptFor(state)(LAUNCH)!, error: 'structured launch recovery: {"phase":"uncertain","startedAt":1,"checks":0,"nextTryAt":1,"reason":"first-message acknowledgement pending"}' } : null;
    const p = await protocol({
      callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
      readPipelineRecord: getPipeline,
      patchPipeline: (id: string, request: never) => patchPipeline(id, request, {
        ...defaultPipelinePorts(), now: () => "2026-01-03T00:00:00.000Z",
        spawnReceipt: () => receipt, spawnReceiptState: () => state,
        claimSpawnRetry: () => { claims++; return "claimed"; },
      }),
    });
    try {
      const args = { pipelineId: pipeline.id, action: "retry-stage", stageId: "build", ...(explicit ? { launchId: LAUNCH } : {}), clientRequestId: "settled-retry" };
      const result = await p.call("pipeline_action", args);
      expect(result.isError, result.raw).toBe(false);
      expect((await p.call("pipeline_action", args)).answer.replayed).toBe(true);
      expect(claims).toBe(0);
      const after = loadPipelines()[0]!;
      expect(after.state).not.toBe("needs_decision");
      expect(after.runs.find(run => run.stageId === "build")!.attempts.at(-1)).toEqual(old);
      expect(receipt?.state ?? null).toBe(state);
    } finally { await p.close(); }
  }
});

test.each(["neither", "verdict only", "completion only"] as const)
("unsettled path-pending launch stays fenced with %s settlement through loopback MCP", async settlement => {
  const pipeline = parkedPipeline();
  const latest = pipeline.runs.find(run => run.stageId === "build")!.attempts.at(-1)!;
  Object.assign(latest, { state: "needs_decision", agentPath: null, sessionId: null,
    verdict: settlement === "verdict only" ? { status: "fail" } : null,
    completedAt: settlement === "completion only" ? "2026-01-02T00:00:00.000Z" : null });
  savePipelines([pipeline]);
  const before = structuredClone(loadPipelines()[0]);
  const p = await engineWithReceipts(receiptFor("path-pending"));
  try {
    const result = await p.call("pipeline_action", { pipelineId: pipeline.id, action: "retry-stage", stageId: "build" });
    expect(result.isError, result.raw).toBe(true);
    expect(result.raw).toContain("still path-pending");
    expect(loadPipelines()[0]).toEqual(before);
  } finally { await p.close(); }
});
