import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import type { Flow } from "./types";
import type { PipelineMerge, PipelineStage, PipelineStageAttempt, PatchPipelineRequest } from "@/lib/pipelines/types";
import type { RuntimeEvent } from "@/lib/runtime/contracts";
import { FLOW_RETIREMENT, STAGE_RETIREMENT } from "./retirement";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-retirement-"));
const priorState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");
const { loadFlows, saveFlows } = await import("./store");
const { savePipelines, loadPipelines, buildPipeline, pipelineIdentity, pipelineRevision } = await import("@/lib/pipelines/store");
const { createPipelineFromRequest, patchPipeline, normalizeStages, tickPipelines, defaultPipelinePorts, reportStageCompletion, pipelineAttemptTargetForSource, adoptAttempt } = await import("@/lib/pipelines/engine");
const { queuePipelineCreation, queuedPipelineCreationStatus, queuedPipelineCreationMessage } = await import("@/lib/pipelines/creationQueue");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { viewerMcpBindings, productionDomainDependencies } = await import("@/lib/mcp/bindings");
const { consumeRuntimeEvent } = await import("@/lib/runtime/consumers");
const { createServerRuntimeConsumers } = await import("@/lib/runtime/serverConsumers");
const { LegacyRuntimeScheduler } = await import("@/lib/runtime/legacyScheduler");
const { FlowPipelineController } = await import("@/lib/pipelines/controller");
const { buildWorkflow, loadWorkflows, saveWorkflows } = await import("@/lib/workflows/store");
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

test("every flow and workflow HTTP method answers 410 with the replacement before reading its body; origin checks survive", async () => {
  for (const kind of ["flows", "workflows"]) {
    const collection = kind === "flows" ? await import("@/app/api/flows/route") : await import("@/app/api/workflows/route");
    const item = kind === "flows" ? await import("@/app/api/flows/[id]/route") : await import("@/app/api/workflows/[id]/route");
    const before = rows();
    const listed = collection.GET();
    expect(listed.status).toBe(410);
    expect(await listed.json()).toMatchObject({ code: "FLOW_RETIRED", replacement: "/api/pipelines", archive: "/api/review-history" });
    const request = new NextRequest(`http://localhost/api/${kind}`, { method: "POST", headers: { host: "localhost" }, body: "invalid JSON" });
    const created = await collection.POST(request);
    expect(created.status).toBe(410);
    expect(await created.json()).toMatchObject(FLOW_RETIREMENT);
    for (const action of actions) {
      const response = await item.PATCH(new NextRequest(`http://localhost/api/${kind}/missing`, { method: "PATCH", headers: { host: "localhost" }, body: JSON.stringify({ action }) }));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject(FLOW_RETIREMENT);
    }
    const foreign = await collection.POST(new NextRequest(`http://localhost/api/${kind}`, { method: "POST", headers: { host: "localhost", origin: "https://other.invalid" } }));
    expect(foreign.status).toBe(403);
    expect(rows()).toBe(before);
  }
});

test("the stored flow and workflow rows stay readable after the engines are gone", async () => {
  const before = rows();
  expect(loadFlows().map(item => item.id)).toEqual([flow().id]);
  expect(loadWorkflows().map(item => item.id)).toEqual(["legacy"]);
  const { listReviewHistory } = await import("@/lib/reviewHistory/boardSelection");
  const page = listReviewHistory({ project: "fixture", ids: [], query: "", updatedSince: "", includeClosed: true }, null, 25);
  expect(JSON.stringify(page)).toContain(flow().id);
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

test("controller refuses queued legacy creations before storing or provisioning them", async () => {
  savePipelines([]);
  const queued = legacyLane(); queued.id = "queued-retired-lane"; queued.publication = "remote-branch";
  queuePipelineCreation(queued, { repository: "fixture", remote: "https://example.invalid/repo.git", branch: "refs/heads/retired" }, false,
    "fixture handover", date);
  let gitCalls = 0;
  const ports = { ...defaultPipelinePorts(), exec: (async () => { gitCalls++; return { code: 0, stdout: "", stderr: "" }; }) as never };

  await tickPipelines([], ports);

  expect(loadPipelines()).toEqual([]);
  expect(gitCalls).toBe(0);
  const status = queuedPipelineCreationStatus(queued.id);
  if (status?.state !== "refused") throw new Error("retired queued creation was not refused");
  expect(status.error).toContain("STAGE_KIND_RETIRED");
  expect(queuedPipelineCreationMessage(queued.id, queuedPipelineCreationStatus(queued.id)!)).toContain("review-loop stages are retired");
});

test("controller leaves retained legacy publication lanes untouched and does not read Git", async () => {
  const lane = legacyLane(); lane.state = "paused"; lane.publication = "remote-branch";
  lane.runs[1]!.attempts.push({ n: 1, state: "reviewing", effectiveRole: lane.stages[1]!.effectiveRole, launchId: null,
    conversationId: owner, sessionId: null, agentPath: flow().implementerPath, paneId: null, flowId: flow().id,
    startedAt: date, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null } as PipelineStageAttempt);
  savePipelines([lane]); const before = rows(); let gitCalls = 0;
  const ports = { ...defaultPipelinePorts(), exec: (async () => { gitCalls++; throw new Error("legacy delivery read reached Git"); }) as never };

  await tickPipelines([], ports);

  expect(rows()).toBe(before);
  expect(gitCalls).toBe(0);
  const retained = loadPipelines()[0]!;
  expect(retained.delivery).toBeUndefined();
  expect(retained.publication).toBe("remote-branch");
  expect(retained.state).toBe("paused");
});

test("set-delivery-remote refuses a legacy graph restored while its Git read is pending", async () => {
  const lane = legacyLane();
  lane.delivery = {
    target: { repository: "fixture", remote: "", branch: "refs/heads/retired" },
    disposition: "owner", publish: "enabled", ownerId: lane.id, epoch: 1, active: true, journal: [],
  };
  savePipelines([lane]);
  let startGit!: () => void;
  let releaseGit!: () => void;
  const gitStarted = new Promise<void>(resolve => { startGit = resolve; });
  const heldGit = new Promise<void>(resolve => { releaseGit = resolve; });
  const ports = { ...defaultPipelinePorts(), exec: (async (_command: string, args: string[]) => {
    startGit(); await heldGit;
    if (args.length === 1 && args[0] === "remote") return { code: 0, stdout: "origin\n", stderr: "" };
    if (args[0] === "-c" && args[2] === "remote" && args[3] === "-v") {
      const probe = /^remote\.([^=]+)\.url=(.*)$/.exec(args[1]!);
      if (probe) return { code: 0, stdout: `${probe[1]}\t${probe[2]} (fetch)\n${probe[1]}\t${probe[2]} (push)\n`, stderr: "" };
    }
    return { code: 0, stdout: "https://example.invalid/repo.git", stderr: "" };
  }) as never };

  try {
    const converted = await patchPipeline(lane.id, {
      action: "convert-legacy-review", clientRequestId: "race-convert", expectedRevision: pipelineRevision(lane),
    } as never, ports);
    if (!converted.pipeline) throw new Error(converted.error);
    const conversionRevision = pipelineRevision(converted.pipeline);
    const adopting = patchPipeline(lane.id, { action: "set-delivery-remote" } as never, ports);
    await gitStarted;
    const reverted = await patchPipeline(lane.id, {
      action: "revert-legacy-review", clientRequestId: "race-revert", stageId: "review", expectedRevision: conversionRevision,
    } as never, ports);
    expect(reverted.error).toBeUndefined();
    expect(reverted.pipeline?.stages.some(stage => stage.kind === "review-loop")).toBe(true);
    const retainedRows = rows();

    releaseGit();
    expect(await adopting).toMatchObject(STAGE_RETIREMENT);
    expect(rows()).toBe(retainedRows);
    expect(loadPipelines()[0]?.delivery).toMatchObject({ target: { remote: "" }, epoch: 1 });
  } finally {
    releaseGit();
  }
});

test("delivery admission rechecks the graph after its Git read before claiming ownership", async () => {
  const live = legacyLane(); live.stages[1]!.kind = "run"; live.state = "paused"; live.publication = "remote-branch";
  savePipelines([live]);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let gitCalls = 0;
  const ports = { ...defaultPipelinePorts(), exec: (async () => {
    gitCalls++; started(); await held;
    return { code: 0, stdout: "https://example.invalid/repo.git", stderr: "" };
  }) as never };
  const pending = tickPipelines([], ports);
  try {
    await entered;
    const retained = legacyLane(); retained.state = "paused"; retained.publication = "remote-branch";
    savePipelines([retained]); const before = rows();
    release(); await pending;
    expect(rows()).toBe(before);
    const retainedRow = loadPipelines()[0]!;
    expect(retainedRow.delivery).toBeUndefined();
    expect(retainedRow.publication).toBe("remote-branch");
    expect(retainedRow.state).toBe("paused");
    expect(retainedRow.stages.map(stage => stage.kind)).toEqual(["run", "review-loop"]);
    expect(gitCalls).toBe(1);
  } finally { release(); await pending; }
});

test("pipeline controller cannot launch or reconcile a stored legacy lane (#2015 and #1739 are closed by the freeze)", async () => {
  const lane = legacyLane(); lane.state = "running"; lane.cursor!.stageId = "review";
  lane.runs[1]!.attempts.push({ n: 1, state: "reviewing", effectiveRole: lane.stages[1]!.effectiveRole, launchId: null,
    conversationId: owner, sessionId: null, agentPath: flow().implementerPath, paneId: null, flowId: flow().id,
    startedAt: date, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null } as PipelineStageAttempt);
  savePipelines([lane]); const before = rows();
  const ports = { ...defaultPipelinePorts(), exec: unreachable, patchFlow: unreachable, closeFlow: unreachable, spawnAgent: unreachable };
  await tickPipelines([], ports);
  expect(await reportStageCompletion({ verdict: "pass", findings: [], summary: "historical" }, { kind: "agent", conversationId: owner, role: "reviewer" }, ports)).toMatchObject(STAGE_RETIREMENT);
  expect(pipelineAttemptTargetForSource(owner)).toBeNull();
  expect(adoptAttempt(lane, "review", {} as never)).toBeNull();
  expect(rows()).toBe(before);
});

test("a controller pass reads, closes and cleans up no stored flow for a run lane that still names one", async () => {
  const lane = legacyLane(); lane.id = "converted-lane"; lane.stages[1]!.kind = "run";
  Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir));
  lane.state = "needs_decision"; lane.stateDetail = "parked for the operator"; lane.cursor!.stageId = "review";
  lane.runs[1]!.attempts.push({ n: 1, state: "needs_decision", effectiveRole: lane.stages[1]!.effectiveRole, launchId: null,
    conversationId: owner, sessionId: null, agentPath: flow().implementerPath, paneId: null, flowId: flow().id,
    startedAt: date, completedAt: date, input: null, activatedBy: null, output: null, verdict: null, error: "parked for the operator" } as PipelineStageAttempt);
  lane.pendingReviewFlowCleanup = ["stale-flow"];
  savePipelines([lane]);
  const flowsBefore = JSON.stringify(loadFlows());
  const flowCalls: string[] = [];
  const ports = { ...defaultPipelinePorts(), exec: unreachable, spawnAgent: unreachable,
    getFlow: (id: string) => { flowCalls.push(`get:${id}`); return null; },
    patchFlow: (id: string) => { flowCalls.push(`patch:${id}`); return {}; },
    closeFlow: async (id: string) => { flowCalls.push(`close:${id}`); return {}; } };
  for (let pass = 0; pass < 2; pass++) await tickPipelines([], ports);
  expect(flowCalls).toEqual([]);
  expect(loadPipelines().find(item => item.id === lane.id)?.pendingReviewFlowCleanup).toEqual(["stale-flow"]);
  expect(JSON.stringify(loadFlows())).toBe(flowsBefore);
});

test.each(["blocked", "queued"] as const)("a native parent's merge retry refuses its %s retired successor without changing either row", async state => {
  const { setMergeOnReview, resetProjectSettingsForTests } = await import("@/lib/projects/settings");
  const settings = path.join(process.env.LLV_STATE_DIR!, "project-settings.json");
  const prior = fs.existsSync(settings) ? fs.readFileSync(settings) : null;
  const parent = legacyLane(); parent.id = "native-parent"; parent.stages[1]!.kind = "run";
  Object.assign(parent, pipelineIdentity(parent.id, parent.task, parent.repoDir));
  const child = legacyLane();
  for (const lane of [parent, child]) { lane.state = "completed"; lane.cursor = null; lane.closedAt = date; }
  const base = "a".repeat(40);
  const merge = (state: "blocked" | "queued"): PipelineMerge => ({
    state, by: null, repository: "example/project", prNumber: 1, policyChangedAt: date, reviewedHead: base,
    chain: [base], updates: [], seenChecks: [], head: null, headSeenAt: null, lastChecks: null,
    readAt: null, nextReadAt: null, requestedAt: date, mergedHead: null, mergeCommit: null, method: null,
    mergedAt: null, attempts: 0, reason: "Historical merge", blockedAt: date, updatedAt: date,
  });
  parent.merge = { ...merge("blocked"), refresh: { attempt: 0, base, head: base, key: "retired-successor", digest: "c".repeat(64), requestedAt: date, pipelineId: child.id } };
  child.merge = merge(state); child.refreshOf = { pipelineId: parent.id, base };
  child.runs[1]!.attempts.push({ n: 1, state: "passed", effectiveRole: child.stages[1]!.effectiveRole,
    launchId: null, conversationId: owner, sessionId: null, agentPath: flow().implementerPath, paneId: null,
    flowId: flow().id, startedAt: date, completedAt: date, input: null, activatedBy: null, output: null,
    verdict: { status: "pass", findings: [] }, error: null } as PipelineStageAttempt);
  try {
    expect(setMergeOnReview("fixture", true, "fixture", date)?.enabled).toBe(true);
    savePipelines([parent, child]);
    expect(loadPipelines()).toHaveLength(2);
    const before = rows();
    expect(await patchPipeline(parent.id, { action: "retry-merge" }, { ...defaultPipelinePorts(), exec: unreachable })).toMatchObject(STAGE_RETIREMENT);
    expect(rows()).toBe(before);
  } finally {
    if (prior) fs.writeFileSync(settings, prior); else fs.rmSync(settings, { force: true });
    resetProjectSettingsForTests();
  }
});

test("stored flow and workflow runtime events, the scheduler, the controller and the file reconciler leave history untouched", async () => {
  const before = rows();
  const consumers = createServerRuntimeConsumers();
  expect(Object.keys(consumers).sort()).toEqual(["spawnTurnEnded", "taskDeliveryAcknowledged"]);
  for (const kind of ["flow.ready", "turn-ended", "workflow.stage.completed"]) {
    const event = { kind, eventId: "event-fixed", occurredAt: date, payload: { flowId: flow().id, readyNote: "REVIEW_READY: done", workflowId: "legacy", stage: 0 } } as unknown as RuntimeEvent;
    expect(await consumeRuntimeEvent(event, { taskDeliveryAcknowledged: unreachable, spawnTurnEnded: unreachable })).toEqual([]);
  }
  let scans = 0; let published = 0;
  const scheduler = new LegacyRuntimeScheduler({ scan: async () => { scans++; return []; }, publishFiles: () => { published++; } }, 10, () => 100);
  expect(await scheduler.runDue()).toBe(true); expect(scans).toBe(1); expect(published).toBe(1);
  const controller = new FlowPipelineController({ tickPipelines: async () => ({ changed: false }), scan: async () => ({ files: [], complete: true }) }, { maxPasses: 1 });
  await controller.recover(); await controller.poll();
  const { reconcileFileControllers } = await import("@/lib/scanner");
  await reconcileFileControllers([], { inventoryChanged: false });
  expect(rows()).toBe(before);
});
