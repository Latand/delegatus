import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import type { Flow, FlowDecisionRequest, PatchFlowRequest } from "./types";
import type { PipelineStage, PipelineStageAttempt, PatchPipelineRequest } from "@/lib/pipelines/types";
import type { RuntimeEvent } from "@/lib/runtime/contracts";
import { FLOW_RETIREMENT, STAGE_RETIREMENT } from "./retirement";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-retirement-"));
const priorState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");
const { loadFlows, saveFlows, reconcileFlowConversationOwnership, reconcileFlowConversationOwnershipCooperatively } = await import("./store");
const { createFlowFromRequest, patchFlow, cancelRound, closeFlow } = await import("./commands");
const { tickFlows, enforceHeadlessAccountCreditGuard } = await import("./engine");
const { submitFlowDecision } = await import("./decisions");
const { savePipelines, loadPipelines, buildPipeline } = await import("@/lib/pipelines/store");
const { createPipelineFromRequest, patchPipeline, normalizeStages, tickPipelines, defaultPipelinePorts, reconcileEmbeddedReviewFlows, preparePipelineReviewRepair, reportStageCompletion, pipelineAttemptTargetForSource, adoptAttempt } = await import("@/lib/pipelines/engine");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { viewerMcpBindings, productionDomainDependencies } = await import("@/lib/mcp/bindings");
const { createMcpToolService, MemoryMcpReceiptStore, SqliteMcpReceiptStore } = await import("@/lib/mcp/server");
const { consumeRuntimeEvent } = await import("@/lib/runtime/consumers");
const { advanceFlowFromRuntime, createServerRuntimeConsumers } = await import("@/lib/runtime/serverConsumers");
const { LegacyRuntimeScheduler } = await import("@/lib/runtime/legacyScheduler");
const { FlowPipelineController } = await import("@/lib/pipelines/controller");
const { tickWorkflows, createWorkflowFromRequest, patchWorkflow } = await import("@/lib/workflows/engine");
const { refreshMergedFlowIds } = await import("@/lib/reaperRuntime");
const { buildWorkflow, saveWorkflows, reconcileWorkflowConversationOwnershipCooperatively } = await import("@/lib/workflows/store");
const unregister = registerPipelineTick(async () => {});
const date = "2026-09-01T00:00:00.000Z";
const owner = "conversation_fixture_owner";
const actions = ["pause", "resume", "advance", "retry-round", "set-mode", "set-round-limit", "extend", "another-round", "set-roles", "cancel-round", "close", "agent-decision"] as const;
function flow(id = "retired-flow-fixture", state: Flow["state"] = "fixing"): Flow {
  return {
    id, template: "implement-review-loop", project: "fixture", cwd: root,
    implementerPath: path.join(root, "missing.jsonl"), implementerConversationId: owner,
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    baseRef: "a".repeat(40), targetSha: "a".repeat(40), baseMode: "head", mode: "auto", reviewerMode: "headless",
    roundLimit: 3, state, stateDetail: null, rounds: [], createdAt: date, closedAt: state === "closed" ? date : null,
  };
}
function rows() {
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  try { return JSON.stringify({
    rows: db.query("SELECT * FROM state_rows WHERE collection IN (?,?,?) ORDER BY collection,row_key").all("flows", "pipelines", "workflows"),
    collections: db.query("SELECT * FROM state_collections WHERE collection IN (?,?,?) ORDER BY collection").all("flows", "pipelines", "workflows"),
  }); }
  finally { db.close(); }
}
function unreachable(): never { throw new Error("retired ingress reached an effect port"); }
function decision(flowId: string): FlowDecisionRequest {
  return { clientRequestId: "old-decision", flowId, decision: "submit-review", reason: "ready", expectedRevision: 1, expectedHead: "a".repeat(40), round: 0, turnId: "turn-fixed" };
}
beforeEach(() => {
  saveFlows([flow()]); savePipelines([]);
  const workflow = buildWorkflow({ id: "legacy", name: "Legacy workflow", task: "Historical work", project: "fixture", repoDir: root, mode: "auto", now: date,
    template: { name: "legacy", finish: "pr", stages: [{ kind: "implement", agent: { engine: "codex", model: null, effort: null }, scope: "Historical work" }, { kind: "review-loop", reviewer: { engine: "codex", model: null, effort: null }, fixer: { engine: "codex", model: null, effort: "low" }, reviewerMode: "headless", roundLimit: 3 }] } });
  workflow.state = "implementing"; workflow.stageRuns[0]!.startedAt = date;
  saveWorkflows([workflow]);
});
afterAll(() => {
  unregister();
  if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
  fs.rmSync(root, { recursive: true, force: true });
});

test("FlowDialog HTTP ingress and every cached action refuse before JSON, params, scan or effects; origin checks survive", async () => {
  for (const kind of ["flows", "workflows"]) {
    const collection = kind === "flows" ? await import("@/app/api/flows/route") : await import("@/app/api/workflows/route");
    const item = kind === "flows" ? await import("@/app/api/flows/[id]/route") : await import("@/app/api/workflows/[id]/route");
    const before = rows();
    const request = new NextRequest(`http://localhost/api/${kind}`, { method: "POST", headers: { host: "localhost" }, body: "invalid JSON" });
    expect(await (await collection.POST(request)).json()).toMatchObject(FLOW_RETIREMENT);
    for (const action of actions) {
      const response = await item.PATCH(new NextRequest(`http://localhost/api/${kind}/missing`, { method: "PATCH", headers: { host: "localhost" }, body: JSON.stringify({ action }) }));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject(FLOW_RETIREMENT);
    }
    const foreign = await collection.POST(new NextRequest(`http://localhost/api/${kind}`, { method: "POST", headers: { host: "localhost", origin: "https://other.invalid" } }));
    expect(foreign.status).toBe(403);
    expect((await (await collection.GET()).json()).retired).toBe(true);
    expect(rows()).toBe(before);
  }
});

test("direct command/workflow ingress refuses all actions and empty/hostile payloads without changing archived rows", async () => {
  const before = rows();
  await expect(createFlowFromRequest({} as never, [])).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  for (const action of actions) expect(() => patchFlow(flow().id, { action } as PatchFlowRequest)).toThrow("FLOW_RETIRED");
  await expect(cancelRound(flow().id)).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  await expect(closeFlow(flow().id)).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  const ports = new Proxy({}, { get: unreachable }) as never;
  await expect(createWorkflowFromRequest({} as never, ports)).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  await expect(patchWorkflow("missing", { action: "resume" }, ports)).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  await expect(tickWorkflows([], ports)).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  expect(rows()).toBe(before);
});

test("legacy engine admission refuses direct start, relay, recovery and persistence before effects", async () => {
  const engine = await import("./engine"); const before = rows();
  for (const method of ["tickFlow", "reserveReviewerSpawn", "sendToImplementer", "adoptSyntheticLaunchTakeover", "abandonLaunch", "relayFixOrPark", "persistTickFlows"] as const) {
    await expect(Promise.resolve().then(() => Reflect.apply(engine[method], null, []))).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  }
  expect(rows()).toBe(before);
});

test("MCP actions and the agent-decision bypass return retirement; an original decision remains owner/payload fenced after process restart", async () => {
  const stored = loadFlows()[0]!;
  const request = decision(stored.id);
  stored.agentDecisions = [{ ...request, owner, transcriptPath: stored.implementerPath, acceptedAt: date, disposition: "accepted" }];
  saveFlows([stored]);
  const before = rows();
  const bindings = viewerMcpBindings(undefined, undefined, { ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "agent", conversationId: owner, role: "builder" }),
    attentionAuthority: () => ({ kind: "worker", conversationId: owner, role: "builder" }),
    patchFlow: unreachable, closeFlow: unreachable, cancelRound: unreachable,
  } as never);
  const receipts = new MemoryMcpReceiptStore();
  const service = createMcpToolService(bindings, receipts);
  for (const action of actions.filter(value => value !== "agent-decision")) {
    const args = { clientRequestId: `retire-${action}`, flowId: stored.id, action };
    expect(await service.callTool("flow_action", args)).toMatchObject({ ok: false, code: "FLOW_RETIRED", retryable: false });
    expect(await service.callTool("flow_action", args)).toMatchObject({ ok: false, code: "FLOW_RETIRED", replayed: true });
  }
  for (const kind of ["submit-review", "continue-fixing", "stop", "completed"]) {
    expect(await service.callTool("flow_action", { ...request, action: "agent-decision", decision: kind, clientRequestId: `new-${kind}` })).toMatchObject({ ok: false, code: "FLOW_RETIRED" });
  }
  expect(await service.callTool("flow_action", { ...request, action: "agent-decision" })).toMatchObject({ ok: true, replayed: true, retired: true, decision: { disposition: "accepted" } });
  const foreign = viewerMcpBindings(undefined, undefined, { ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "agent", conversationId: "conversation_foreign", role: "builder" }),
    attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_foreign", role: "builder" }),
  } as never);
  const denied = await createMcpToolService(foreign, receipts).callTool("flow_action", { ...request, action: "agent-decision" });
  expect(denied.ok).toBe(false); expect(denied).not.toHaveProperty("decision");
  const conflict = await service.callTool("flow_action", { ...request, action: "agent-decision", reason: "changed" });
  expect(conflict.ok).toBe(false); expect(conflict).not.toHaveProperty("decision");
  await expect(submitFlowDecision(request, "conversation_foreign")).rejects.toThrow("owner");
  await expect(submitFlowDecision({ ...request, reason: "changed" }, owner)).rejects.toThrow("conflict");
  const restarted = await promisify(execFile)(process.execPath, ["--eval", `const {submitFlowDecision}=await import("./src/lib/flows/decisions.ts"); console.log(JSON.stringify(await submitFlowDecision(JSON.parse(process.env.FIXTURE_DECISION),${JSON.stringify(owner)})));`], {
    cwd: process.cwd(), env: { ...process.env, FIXTURE_DECISION: JSON.stringify(request) }, timeout: 10_000,
  });
  expect(JSON.parse(restarted.stdout)).toMatchObject({ replayed: true, decision: { disposition: "accepted" } });
  expect(rows()).toBe(before);
}, 15_000);

test("ordinary accepted MCP receipts and new retirement failures survive a real process restart without action effects", async () => {
  const stored = loadFlows()[0]!; const before = rows();
  const file = path.join(root, "receipt-replay.sqlite");
  const receipts = new SqliteMcpReceiptStore(file);
  const args = { clientRequestId: "accepted-before-freeze", flowId: stored.id, action: "pause" };
  let effects = 0;
  try {
    const old = createMcpToolService({ flow_action: async () => { effects++; return { flowId: stored.id, outcome: "accepted" }; } } as never, receipts);
    expect(await old.callTool("flow_action", args)).toMatchObject({ ok: true, replayed: false });
    const current = createMcpToolService(viewerMcpBindings(), receipts);
    expect(await current.callTool("flow_action", { ...args, clientRequestId: "retired-after-freeze" })).toMatchObject({ ok: false, code: "FLOW_RETIRED" });
  } finally { receipts.close(); }
  const child = await promisify(execFile)(process.execPath, ["--eval", `
    const {viewerMcpBindings}=await import("./src/lib/mcp/bindings.ts");
    const {createMcpToolService,SqliteMcpReceiptStore}=await import("./src/lib/mcp/server.ts");
    const receipts=new SqliteMcpReceiptStore(process.env.FIXTURE_RECEIPTS);
    try {
      const service=createMcpToolService(viewerMcpBindings(),receipts);
      const args=JSON.parse(process.env.FIXTURE_ARGS);
      console.log(JSON.stringify([await service.callTool("flow_action",args),await service.callTool("flow_action",{...args,clientRequestId:"retired-after-freeze"})]));
    } finally {receipts.close();}
  `], { cwd: process.cwd(), env: { ...process.env, FIXTURE_RECEIPTS: file, FIXTURE_ARGS: JSON.stringify(args) }, timeout: 10_000 });
  expect(JSON.parse(child.stdout)).toMatchObject([{ ok: true, replayed: true, outcome: "accepted" }, { ok: false, replayed: true, code: "FLOW_RETIRED" }]);
  expect(effects).toBe(1); expect(rows()).toBe(before);
}, 15_000);

test("archive paging exceeds row and byte budgets: each id remains reachable once; full reads omit decisionContext", async () => {
  const corpus = Array.from({ length: 260 }, (_, i) => ({ ...flow(`retired-flow-${String(i).padStart(3, "0")}`, i < 29 ? "approved" : "closed"), spec: "historical context ".repeat(400), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
  corpus[0]!.rounds = [{ n: 1, reviewerPath: null, findingsPath: null, triggeredBy: "button", readyNote: null,
    verdict: "APPROVE", findingsCount: 0, startedAt: date, reviewedAt: date, relayedAt: null, error: null, reviewHeadSha: "a".repeat(40) }];
  saveFlows(corpus);
  const bindings = viewerMcpBindings(undefined, undefined, { ...productionDomainDependencies, callerAttribution: () => ({ kind: "agent", conversationId: owner, role: "builder" }), attentionAuthority: () => ({ kind: "worker", conversationId: owner, role: "builder" }) } as never);
  const before = rows();
  for (const full of [false, true]) {
    const ids: string[] = []; let cursor: unknown;
    do {
      const page = await bindings.list_flows({ includeClosed: true, full, limit: 200, cursor });
      expect(page.retired).toBe(true);
      const records = page.flows as Flow[];
      ids.push(...records.map(item => item.id));
      expect(records.length).toBeLessThanOrEqual(200);
      if (full) expect(records.length).toBeLessThan(200);
      if (!full) expect(records[0]).not.toHaveProperty("spec");
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
    expect(ids).toEqual([...corpus].reverse().map(item => item.id));
    expect(new Set(ids).size).toBe(corpus.length);
  }
  const detail = await bindings.get_flow({ flowId: corpus[0]!.id });
  expect(detail).toMatchObject({ retired: true, flow: { state: "approved", rounds: [{ verdict: "APPROVE", reviewHeadSha: "a".repeat(40), reviewedAt: date }] } });
  expect(detail).not.toHaveProperty("decisionContext");
  expect(rows()).toBe(before);
});

function legacyLane() {
  const role = { roleId: "builder", engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: "Fixture instructions" };
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review", onFail: null, effectiveRole: role },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null, onFail: null, effectiveRole: { ...role, roleId: "reviewer", access: "read-only" } },
  ] as PipelineStage[];
  return buildPipeline({ id: "legacy-lane", task: "Historical review", project: "fixture", repoDir: root, stages, srcPath: null, srcConversationId: null, now: date, state: "draft", publication: "internal" });
}

test("pipeline create, draft/add-stage/copy paths and legacy start/resume refuse STAGE_KIND_RETIRED before effects; decoder and preview survive", async () => {
  const lane = legacyLane(); savePipelines([lane]);
  const before = rows(); const ports = new Proxy({}, { get: unreachable }) as never;
  expect(await createPipelineFromRequest({ stages: lane.stages } as never, ports)).toMatchObject(STAGE_RETIREMENT);
  for (const req of [
    { action: "update-draft", stages: lane.stages }, { action: "add-stage", stage: lane.stages[1] },
    ...["start", "resume", "advance", "retry-stage", "continue-review", "resolve-decision"].map(action => ({ action })),
  ]) expect(await patchPipeline(lane.id, req as PatchPipelineRequest, ports)).toMatchObject(STAGE_RETIREMENT);
  const bindings = viewerMcpBindings(undefined, undefined, { ...productionDomainDependencies, callerAttribution: () => ({ kind: "agent", conversationId: owner, role: "builder" }), attentionAuthority: () => ({ kind: "worker", conversationId: owner, role: "builder" }) } as never);
  await expect(bindings.create_pipeline({ clientRequestId: "legacy-create", task: "Historical work", repoDir: root, src: flow().implementerPath, stages: lane.stages }))
    .rejects.toMatchObject({ details: { code: "STAGE_KIND_RETIRED", status: 410 } });
  await expect(bindings.pipeline_action({ clientRequestId: "legacy-add", pipelineId: lane.id, action: "add-stage", stage: lane.stages[1] }))
    .rejects.toMatchObject({ details: { code: "STAGE_KIND_RETIRED", status: 410 } });
  expect(normalizeStages(lane.stages).error).toContain("STAGE_KIND_RETIRED");
  expect(loadPipelines()[0]?.stages[1]?.kind).toBe("review-loop");
  expect(await preparePipelineReviewRepair("missing", ports)).toMatchObject({ ok: false, retryable: false, detail: expect.stringContaining("STAGE_KIND_RETIRED") });
  expect(reconcileEmbeddedReviewFlows(loadPipelines(), loadFlows())).toBe(false);
  expect(rows()).toBe(before);
});

test("a graph replaced with a retired definition during preparation is rechecked under admission", async () => {
  const live = legacyLane(); live.stages[1]!.kind = "run"; savePipelines([live]);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const ports = { ...defaultPipelinePorts(), preflightRepo: () => ({ ok: true as const, repoDir: root, gitCommonDir: path.join(root, ".git"), worktreeParent: path.dirname(root) }),
    exec: async () => { started(); await held; return { code: 1, stdout: "", stderr: "no remote" }; } };
  const pending = patchPipeline(live.id, { action: "update-draft", repoDir: root }, ports);
  try {
    await entered;
    savePipelines([legacyLane()]); const before = rows();
    release();
    expect(await pending).toMatchObject(STAGE_RETIREMENT);
    expect(rows()).toBe(before);
  } finally { release(); await pending; }
});

test("pipeline controller cannot launch or reconcile a stored legacy lane (#2015 and #1739 are closed by the freeze)", async () => {
  const lane = legacyLane(); lane.state = "running"; lane.cursor!.stageId = "review";
  lane.runs[1]!.attempts.push({ n: 1, state: "reviewing", effectiveRole: lane.stages[1]!.effectiveRole, launchId: null,
    conversationId: owner, sessionId: null, agentPath: flow().implementerPath, paneId: null, flowId: flow().id,
    startedAt: date, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null } as PipelineStageAttempt);
  savePipelines([lane]); const before = rows();
  const ports = { ...defaultPipelinePorts(), exec: unreachable, createFlow: unreachable, patchFlow: unreachable, closeFlow: unreachable, spawnAgent: unreachable };
  await tickPipelines([], ports);
  expect(await reportStageCompletion({ verdict: "pass", findings: [], summary: "historical" }, { kind: "agent", conversationId: owner, role: "reviewer" }, ports)).toMatchObject(STAGE_RETIREMENT);
  expect(pipelineAttemptTargetForSource(owner)).toBeNull();
  expect(adoptAttempt(lane, "review", {} as never)).toBeNull();
  expect(rows()).toBe(before);
});

test("scanner/controller/host scheduling, runtime readiness, workflow callbacks and provider wakes leave history untouched", async () => {
  const before = rows();
  expect(await tickFlows([])).toMatchObject({ code: "FLOW_RETIRED", changed: false });
  await enforceHeadlessAccountCreditGuard(new Proxy({}, { get: unreachable }) as never, new Set(["fixture-account"]));
  expect(() => advanceFlowFromRuntime(flow(), "REVIEW_READY: done")).toThrow("FLOW_RETIRED");
  const consumers = createServerRuntimeConsumers();
  await expect(consumers.flowReady(flow().id, "REVIEW_READY: done")).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  await expect(consumers.workflowStageCompleted("legacy", 0)).rejects.toMatchObject({ code: "FLOW_RETIRED" });
  for (const kind of ["flow.ready", "turn-ended", "workflow.stage.completed"]) {
    const event = { kind, eventId: "event-fixed", occurredAt: date, payload: { flowId: flow().id, readyNote: "REVIEW_READY: done", workflowId: "legacy", stage: 0 } } as unknown as RuntimeEvent;
    expect(await consumeRuntimeEvent(event, { flowReady: unreachable, workflowStageCompleted: unreachable, taskDeliveryAcknowledged: unreachable })).toEqual([]);
  }
  let scans = 0; let published = 0;
  const scheduler = new LegacyRuntimeScheduler({ scan: async () => { scans++; return []; }, publishFiles: () => { published++; }, tickFlows: unreachable, tickWorkflows: unreachable }, 10, () => 100);
  expect(await scheduler.runDue()).toBe(true); expect(scans).toBe(1); expect(published).toBe(1);
  const controller = new FlowPipelineController({ tickPipelines: async () => ({ changed: false }), scan: async () => ({ files: [], complete: true }), tickFlows: unreachable }, { maxPasses: 1 });
  await controller.recover(); await controller.poll();
  expect(await refreshMergedFlowIds(loadFlows(), { checkoutClean: unreachable, saveFlows: unreachable })).toEqual(new Set());
  const registry = new Proxy({}, { get: unreachable }) as never;
  reconcileFlowConversationOwnership(registry); await reconcileFlowConversationOwnershipCooperatively(registry);
  await reconcileWorkflowConversationOwnershipCooperatively(registry);
  // The scan reconciler itself has no retired scheduling edge. Its unrelated
  // registry/question consumers are exercised by the existing scanner tests.
  const scanner = fs.readFileSync(path.join(process.cwd(), "src/lib/scanner/index.ts"), "utf8");
  expect(scanner).not.toMatch(/tickFlows|tickWorkflows|reconcileEmbeddedReviewFlows/);
  const host = fs.readFileSync(path.join(process.cwd(), "src/runtime-host/legacyScheduler.ts"), "utf8");
  expect(host).not.toMatch(/tickFlows|tickWorkflows/);
  const { reconcileFileControllers } = await import("@/lib/scanner");
  await reconcileFileControllers([], { inventoryChanged: false });
  expect(rows()).toBe(before);
});
