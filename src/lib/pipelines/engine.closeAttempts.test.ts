import { expect, test, Database, path, harness, rawPatchPipeline, closeAndDrain, AgentRegistry, setAgentRegistryForTests,
  loadPipelines, savePipelines, activationDrainFixture, reserveActivationOnly, tickPipelines, defaultPipelinePorts } from "./engine.fixture";
import type { AgentRegistry as Registry, SpawnRequest } from "@/lib/agent/registry";
import { stopPipelineStageAgent } from "./engine";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { buildPipeline, findPipelineRecord, loadPipelinesForProjection, loadPipelinesForList,
  loadPipelinesForStartup, isStoredPipeline, pipelineRevision, loadArchivedPipelinesForList } from "./store";
import { settleClosedPipelineAttempts } from "./closeAttempts";
import type { Pipeline, PipelineStageAttempt } from "./types";

const START = "2026-10-25T10:00:00.000Z";
const CLOSED = "2026-10-25T11:00:00.000Z";
const role = { roleId: null, engine: "codex", model: null, effort: null,
  access: "read-only", promptScaffold: null } as const;

function pending(n: number): PipelineStageAttempt {
  return { n, state: "pending", effectiveRole: { ...role }, launchId: null,
    conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    expectedReviewHeadSha: null, reviewHeadSha: null, startedAt: null, completedAt: null,
    input: null, activatedBy: null, output: null, verdict: null, error: null };
}

function lane(id = "close-attempts"): Pipeline {
  const pipeline = buildPipeline({ id, task: "Close untouched work", project: "fixture",
    repoDir: "/repo", now: START, srcPath: null, srcConversationId: null, publication: "internal",
    stages: [
      { id: "review", kind: "run", prompt: "Review", effectiveRole: { ...role }, next: "publish" },
      { id: "publish", kind: "run", prompt: "Publish", effectiveRole: { ...role }, next: null },
    ] });
  pipeline.state = "needs_decision";
  pipeline.baseBranch = "main";
  pipeline.baseRef = pipeline.lastPassedCommit = "a".repeat(40);
  pipeline.runs[0]!.attempts = [{ ...pending(1), state: "failed", startedAt: START, completedAt: START,
    verdict: { status: "fail", findings: [] }, error: "review rejected" }, pending(2), pending(3)];
  pipeline.runs[1]!.attempts = [pending(1)];
  return pipeline;
}

function stored(collection = "pipelines", id = "close-attempts"): { json: string; revision: number; pipeline: Pipeline } {
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  try {
    const row = db.query("SELECT value_json AS json, row_revision AS revision FROM state_rows WHERE collection=? AND row_key=?")
      .get(collection, id) as { json: string; revision: number };
    return { ...row, pipeline: JSON.parse(row.json) };
  } finally { db.close(); }
}

/** Capture the actual stage producer's reservation input before dispatch. */
async function closeLaunchFixture(label: string) {
  const h = harness();
  const pipeline = lane(`close-produced-${label}`);
  pipeline.state = "running";
  pipeline.cursor = { stageId: "review", state: "pending", input: null, activatedBy: null };
  pipeline.runs[0]!.attempts[1]!.spawnCalls = 0;
  savePipelines([pipeline]);
  let checks = 0;
  h.ports.structuredDeliveryPublication = () => ++checks <= 2 ? "ready" : "unbound";
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  try { await tickPipelines([], h.ports); }
  finally { delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
  const produced = loadPipelines()[0]!;
  const attempt = produced.runs[0]!.attempts.at(-1)!;
  const input = attempt.activation!.input;
  delete attempt.activation;
  Object.assign(attempt, { state: "pending", startedAt: START, spawnCalls: 1 });
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `close-produced-${label}.json`));
  const request = (retry = false) => ({ engine: input.role.engine, cwd: input.cwd, transport: "structured" as const,
    accountId: input.requestedAccountId, role: input.role.roleId,
    clientAttemptId: retry ? `handshake_retry_1_${input.clientAttemptId}`.slice(0, 128) : input.clientAttemptId,
    conversationId: retry ? "conversation_close_retry" as const : "conversation_close_original" as const,
    origin: { kind: "container" as const, container: "pipeline" as const, containerId: input.membership.containerId,
      creatorConversationId: input.creatorConversationId?.startsWith("conversation_")
        ? input.creatorConversationId as `conversation_${string}` : null },
    memberships: [{ ...input.membership }], launchProfile: { title: input.title, cwd: input.cwd,
      project: input.project, readOnly: input.role.access === "read-only" } } satisfies SpawnRequest);
  const stops: Array<{ launchId: string | null | undefined; outcome: string }> = [];
  h.ports.now = () => CLOSED;
  const productionStop = defaultPipelinePorts().stopStageAgent;
  h.ports.stopStageAgent = async (target, options) => {
    const result = await productionStop(target, options);
    stops.push({ launchId: target.launchId, outcome: result.outcome });
    return result;
  };
  setAgentRegistryForTests(registry);
  return { h, pipeline: produced, attempt, input, registry, request, stops,
    stored: (collection = "pipelines") => stored(collection, produced.id) };
}

async function reserveUnadmitted(registry: Registry, request: SpawnRequest) {
  await expect(registry.beginSpawnRequestAsync(request, () => {
    if (registry.spawnReceiptForClientAttempt(request.clientAttemptId!)) throw new Error("hold before membership admission");
  })).rejects.toThrow("hold before membership admission");
  return registry.spawnReceiptForClientAttempt(request.clientAttemptId!)!;
}

test("production stop of a failed original retains the starting retry across repeated drains", async () => {
  const f = await closeLaunchFixture("mixed");
  try {
    const first = f.registry.beginSpawnRequest(f.request());
    const retry = f.registry.beginSpawnRequest(f.request(true));
    expect(f.registry.failSpawn(first.receipt.launchId, "setup failed before host publication")).toBe(true);
    f.attempt.spawnCalls = 2;
    const firstReceipt = f.registry.spawnReceipt(first.receipt.launchId);
    savePipelines([f.pipeline]);
    for (let drain = 0; drain < 2; drain++) {
      const result = await closeAndDrain(f.pipeline.id, { action: "close" }, f.h.ports);
      expect(result.close).toMatchObject({ status: "pending", pending: [expect.objectContaining({ launchId: retry.receipt.launchId })] });
      expect(f.stored().pipeline.runs[0]!.attempts.at(-1)).toMatchObject({ state: "pending", completedAt: null, verdict: null });
      expect(f.registry.spawnReceipt(retry.receipt.launchId)!.state).toBe("starting");
    }
    expect(f.stops).toEqual([{ launchId: first.receipt.launchId, outcome: "not-running" }]);
    expect(f.registry.spawnReceipt(first.receipt.launchId)).toEqual(firstReceipt);
    expect(f.registry.failSpawn(retry.receipt.launchId, "retry setup failed before host publication")).toBe(true);
    const drained = await closeAndDrain(f.pipeline.id, { action: "close" }, f.h.ports);
    expect(drained.close).toMatchObject({ status: "settled", pending: [] });
    expect(f.stored().pipeline.runs[0]!.attempts.at(-1)).toMatchObject({ state: "failed", completedAt: CLOSED });
    expect(f.stops.map(stop => stop.launchId)).toEqual([first.receipt.launchId, retry.receipt.launchId]);
    expect(f.stored().pipeline.runs.map(run => run.attempts.length)).toEqual(f.pipeline.runs.map(run => run.attempts.length));
    expect(f.h.spawnInputs).toEqual([]);
  } finally { setAgentRegistryForTests(null); }
});

test.each([false, true])("a no-host receipt released after close persists terminal settlement (prior host=%s)", async (priorHost) => {
  const f = await closeLaunchFixture(`late-no-host-${priorHost}`);
  try {
    if (priorHost) {
      const first = f.registry.beginSpawnRequest(f.request());
      expect(f.registry.failSpawn(first.receipt.launchId, "original setup failed")).toBe(true);
      f.attempt.spawnCalls = 2;
    }
    const request = f.request(priorHost);
    const receipt = await reserveUnadmitted(f.registry, request);
    savePipelines([f.pipeline]);
    const waiting = await closeAndDrain(f.pipeline.id, { action: "close" }, f.h.ports);
    expect(waiting.close!.status).toBe("pending");
    expect(f.stored().pipeline.runs[0]!.attempts.at(-1)!.state).toBe("pending");
    expect(f.registry.retireUnconsumedSpawn(request.clientAttemptId, "unconsumed admission cancelled")).toBe(true);
    const settled = await closeAndDrain(f.pipeline.id, { action: "close" }, f.h.ports);
    expect(settled.close).toMatchObject({ status: "settled", pending: [] });
    expect(f.stored().pipeline.runs[0]!.attempts.at(-1)).toMatchObject({ state: priorHost ? "failed" : "skipped", completedAt: CLOSED });
    expect(f.stops).toHaveLength(priorHost ? 1 : 0);
    expect(f.registry.spawnReceipt(receipt.launchId)).toMatchObject({ state: "failed", membershipAdmitted: false });
  } finally { setAgentRegistryForTests(null); }
});

test.each(["missing", "foreign"] as const)("close retains %s original request evidence without stopping an unverified identity", async (variant) => {
  const f = await closeLaunchFixture(`unverified-${variant}`);
  try {
    if (variant === "foreign") {
      const begun = f.registry.beginSpawnRequest({ ...f.request(), clientAttemptId: "another-original-request" });
      Object.assign(f.attempt, { launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId });
    } else f.attempt.launchId = "missing-original-launch";
    savePipelines([f.pipeline]);
    for (let drain = 0; drain < 2; drain++) {
      const closed = await closeAndDrain(f.pipeline.id, { action: "close" }, f.h.ports);
      expect(closed.close!.status).toBe("pending");
      expect(closed.close!.pending).toHaveLength(1);
      expect(f.stored().pipeline.runs[0]!.attempts.at(-1)).toMatchObject({ state: "pending", completedAt: null });
    }
    expect(f.stops).toEqual([]);
  } finally { setAgentRegistryForTests(null); }
});

test("a bound starting receipt retains custody until its original host materializes", async () => {
  const f = await closeLaunchFixture("bound");
  try {
    const begun = f.registry.beginSpawnRequest(f.request());
    Object.assign(f.attempt, { launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId });
    const target = { stageId: "review", attempt: f.attempt.n, launchId: begun.receipt.launchId,
      conversationId: begun.receipt.conversationId, agentPath: null, paneId: null };
    expect(await stopPipelineStageAgent(target)).toEqual({ outcome: "not-running" });
    savePipelines([f.pipeline]);
    for (let drain = 0; drain < 2; drain++) {
      const closed = await closeAndDrain(f.pipeline.id, { action: "close" }, f.h.ports);
      expect(closed.close).toMatchObject({ status: "pending", pending: [expect.objectContaining({ launchId: begun.receipt.launchId })] });
      expect(closed.close!.notes).toContainEqual(expect.objectContaining({ launchId: begun.receipt.launchId,
        detail: expect.stringContaining("still starting") }));
      expect(f.stored().pipeline.runs[0]!.attempts.at(-1)).toMatchObject({ state: "pending", completedAt: null });
    }
    expect(f.stops).toEqual([]);
    expect(f.registry.stageStructuredSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "close-materialized" }, artifactPath: "/codex/close-materialized.jsonl",
      cwd: f.input.cwd, accountId: null, launchProfile: begun.receipt.launchProfile, status: "idle", host: null,
      structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    }).kind).toBe("settled");
    expect(f.registry.conversation(begun.receipt.conversationId)!.generations.at(-1)!.id)
      .not.toBe(f.registry.spawnReceipt(begun.receipt.launchId)!.key!.sessionId);
    const drained = await closeAndDrain(f.pipeline.id, { action: "close" }, f.h.ports);
    expect(drained.close).toMatchObject({ status: "settled", pending: [], alreadyStopped: [target] });
    expect(f.stops).toEqual([{ launchId: begun.receipt.launchId, outcome: "not-running" }]);
    expect(f.stored().pipeline.runs[0]!.attempts.at(-1)).toMatchObject({ state: "failed", launchId: begun.receipt.launchId });
    expect(f.h.spawnInputs).toEqual([]);
  } finally { setAgentRegistryForTests(null); }
});

test("retained receipt custody is independent of a prior terminal attempt checkpoint", async () => {
  const f = await closeLaunchFixture("terminal-checkpoint");
  try {
    const begun = f.registry.beginSpawnRequest(f.request());
    savePipelines([f.pipeline]);
    await rawPatchPipeline(f.pipeline.id, { action: "close" }, f.h.ports);
    const old = f.stored().pipeline;
    // A previous controller could have stopped one host and written this state
    // before checking another original receipt. Its custody still belongs here.
    Object.assign(old.runs[0]!.attempts.at(-1)!, { state: "failed", completedAt: CLOSED });
    savePipelines([old]);
    const closed = await closeAndDrain(old.id, { action: "close" }, f.h.ports);
    expect(closed.close).toMatchObject({ status: "pending", pending: [expect.objectContaining({ launchId: begun.receipt.launchId })] });
    expect(f.stops).toEqual([]);
    expect(f.registry.spawnReceipt(begun.receipt.launchId)!.state).toBe("starting");
  } finally { setAgentRegistryForTests(null); }
});

test("verified unadmitted launch-only evidence settles durably and through every reader", async () => {
  const f = await closeLaunchFixture("no-host");
  try {
    const request = f.request();
    const begun = await reserveUnadmitted(f.registry, request);
    expect(f.registry.retireUnconsumedSpawn(request.clientAttemptId, "unconsumed admission cancelled")).toBe(true);
    const receipt = f.registry.spawnReceipt(begun.launchId);
    Object.assign(f.attempt, { launchId: begun.launchId, conversationId: null });
    savePipelines([f.pipeline]);
    const earlier = structuredClone(f.pipeline.runs[0]!.attempts[0]);
    const closed = await closeAndDrain(f.pipeline.id, { action: "close" }, f.h.ports);
    expect(closed.close).toMatchObject({ status: "settled", pending: [] });
    expect(f.stored().pipeline.runs[0]!.attempts.at(-1)).toMatchObject({ state: "skipped", launchId: begun.launchId,
      conversationId: null, completedAt: CLOSED, startedAt: START, verdict: null });
    expect(f.stored().pipeline.runs[0]!.attempts[0]).toEqual(earlier);
    expect(f.stops).toEqual([]);
    // Old persisted rows can carry the id and either the old or reset counter.
    for (const spawnCalls of [0, 1]) {
      const old = f.stored().pipeline;
      Object.assign(old.runs[0]!.attempts.at(-1)!, { state: "pending", completedAt: null, error: null, spawnCalls });
      savePipelines([old]);
      const before = f.stored();
      for (const rows of [loadPipelines(), loadPipelinesForProjection(), loadPipelinesForList(), loadPipelinesForStartup(), [findPipelineRecord(old.id)!]]) {
        expect(rows[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ state: "skipped", launchId: begun.launchId, completedAt: CLOSED });
      }
      expect(f.stored()).toEqual(before);
    }
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
    try {
      db.query("UPDATE state_rows SET collection='pipelines_archive' WHERE collection='pipelines' AND row_key=?").run(f.pipeline.id);
      db.exec("UPDATE state_collections SET revision=revision+1 WHERE collection IN ('pipelines','pipelines_archive')");
      const archived = f.stored("pipelines_archive");
      for (const read of [loadArchivedPipelinesForList().find(row => row.id === f.pipeline.id)!, findPipelineRecord(f.pipeline.id)!]) {
        expect(read.runs[0]!.attempts.at(-1)).toMatchObject({ state: "skipped", launchId: begun.launchId, completedAt: CLOSED });
      }
      expect(f.stored("pipelines_archive")).toEqual(archived);
    } finally {
      db.query("UPDATE state_rows SET collection='pipelines' WHERE collection='pipelines_archive' AND row_key=?").run(f.pipeline.id);
      db.exec("UPDATE state_collections SET revision=revision+1 WHERE collection IN ('pipelines','pipelines_archive')");
      db.close();
    }
    expect(f.registry.spawnReceipt(begun.launchId)).toEqual(receipt);
    expect(f.h.spawnInputs).toEqual([]);
  } finally { setAgentRegistryForTests(null); }
});

test.each(["missing", "starting", "retry", "engine", "cwd", "transport", "foreign-key", "admitted"] as const)(
  "launch-only settlement refuses %s receipt proof even with a reset call count", async (variant) => {
    const f = await closeLaunchFixture(`no-host-${variant}`);
    try {
      const request = { ...f.request(), ...(variant === "engine" ? { engine: "claude" as const } : {}),
        ...(variant === "cwd" ? { cwd: "/different-worktree" } : {}),
        ...(variant === "transport" ? { transport: "tmux" as const } : {}),
        ...(variant === "foreign-key" ? { clientAttemptId: "unrelated-original-request" } : {}) };
      const begun = variant === "admitted" ? f.registry.beginSpawnRequest(request).receipt
        : await reserveUnadmitted(f.registry, request);
      if (variant === "admitted") expect(f.registry.failSpawn(begun.launchId, "admitted setup failed")).toBe(true);
      else if (variant !== "starting") expect(f.registry.retireUnconsumedSpawn(request.clientAttemptId, "unconsumed admission cancelled")).toBe(true);
      if (variant === "retry") f.registry.beginSpawnRequest(f.request(true));
      Object.assign(f.attempt, { launchId: variant === "missing" ? "missing-original-launch" : begun.launchId,
        spawnCalls: 0, conversationId: null });
      f.pipeline.state = "closed";
      f.pipeline.closedAt = CLOSED;
      f.pipeline.cursor = null;
      savePipelines([f.pipeline]);
      const before = f.stored();
      for (const rows of [loadPipelines(), loadPipelinesForProjection(), loadPipelinesForList(), loadPipelinesForStartup(), [findPipelineRecord(f.pipeline.id)!]]) {
        expect(rows[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ state: "pending", completedAt: null, launchId: f.attempt.launchId });
      }
      expect(f.stored()).toEqual(before);
      expect(f.stops).toEqual([]);
    } finally { setAgentRegistryForTests(null); }
  });

test("close persists every untouched attempt as skipped and preserves earlier verdicts", async () => {
  const h = harness();
  h.ports.now = () => CLOSED;
  const pipeline = lane();
  const earlier = structuredClone(pipeline.runs[0]!.attempts[0]!);
  savePipelines([pipeline]);
  const result = await rawPatchPipeline(pipeline.id, { action: "close" }, h.ports);
  expect(result.error).toBeUndefined();
  const closed = stored().pipeline;
  expect(closed.state).toBe("closed");
  expect(closed.cursor).toBeNull();
  expect(closed.runs.map(run => run.attempts.length)).toEqual([3, 1]);
  expect(closed.runs[0]!.attempts[0]).toEqual(earlier);
  for (const attempt of [...closed.runs[0]!.attempts.slice(1), ...closed.runs[1]!.attempts]) {
    expect(attempt).toMatchObject({ state: "skipped", completedAt: CLOSED, startedAt: null,
      launchId: null, conversationId: null, verdict: null, error: "pipeline closed before this attempt started" });
  }
  expect(isStoredPipeline(closed)).toBe(true);
  expect(loadPipelines()[0]!.runs).toEqual(result.pipeline!.runs);
  expect(result.close!.pending).toEqual([]);
  expect(h.spawnInputs).toHaveLength(0);
  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
  expect(stored().pipeline.runs).toEqual(closed.runs);
});

test("close settles a preparation timestamp after explicit zero-call admission", async () => {
  const h = harness();
  h.ports.now = () => CLOSED;
  const pipeline = lane();
  const preparedAt = "2026-10-25T10:30:00.000Z";
  Object.assign(pipeline.runs[0]!.attempts[1]!, { spawnCalls: 0, startedAt: preparedAt });
  savePipelines([pipeline]);

  const result = await rawPatchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(result.error).toBeUndefined();
  expect(stored().pipeline.runs[0]!.attempts[1]).toMatchObject({ state: "skipped",
    startedAt: preparedAt, completedAt: CLOSED, verdict: null });
  expect(h.spawnInputs).toHaveLength(0);
});

test("closed pending history with an unresolved original launch remains pending", () => {
  const pipeline = lane();
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = CLOSED;
  Object.assign(pipeline.runs[0]!.attempts[1]!, { spawnCalls: 1 });
  settleClosedPipelineAttempts(pipeline, () => "uncertain");

  expect(pipeline.runs[0]!.attempts[1]).toMatchObject({ state: "pending", completedAt: null, spawnCalls: 1 });
  expect(pipeline.runs[1]!.attempts[0]!.state).toBe("pending");
});

test.each([1, undefined] as const)("close retains a starting registry reservation with spawnCalls=%s", async (spawnCalls) => {
  const h = harness();
  const pipeline = lane();
  const attempt = pipeline.runs[0]!.attempts[1]!;
  if (spawnCalls !== undefined) attempt.spawnCalls = spawnCalls;
  const variant = spawnCalls ?? "legacy";
  const conversationId: `conversation_${string}` = `conversation_original_reserved_${variant}`;
  const clientAttemptId = `pipeline_${pipeline.id}_review_2`;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `close-launch-registry-${variant}.json`));
  setAgentRegistryForTests(registry);
  try {
    const membership = { kind: "pipeline" as const, containerId: pipeline.id, role: "agent", slot: "review:2",
      stageId: "review", stageOrder: 0, round: 2, parentConversationId: null };
    const reservation = registry.beginSpawnRequest({ engine: "codex", cwd: pipeline.worktreeDir,
      transport: "structured", clientAttemptId, conversationId, role: "agent", memberships: [membership],
      launchProfile: { title: "Reserved pipeline stage" } });
    if (reservation.kind !== "created") throw new Error(`fixture reservation returned ${reservation.kind}`);
    expect(registry.pipelineSpawnHistory(clientAttemptId)).toMatchObject([{
      launchId: reservation.receipt.launchId, engine: "codex", cwd: pipeline.worktreeDir,
      transport: "structured", clientAttemptId, state: "starting",
    }]);
    expect(registry.conversationMemberships(conversationId)).toMatchObject([membership]);
    savePipelines([pipeline]);
    expect(isStoredPipeline(loadPipelines().find(row => row.id === pipeline.id))).toBe(true);

    const result = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

    expect(result.error).toBeUndefined();
    const closed = stored("pipelines", pipeline.id).pipeline;
    expect({ ...closed.runs[0]!.attempts[1], spawnCalls: closed.runs[0]!.attempts[1]!.spawnCalls ?? null }).toMatchObject({
      state: "pending", spawnCalls: spawnCalls ?? null, launchId: null, conversationId: null });
    expect(result.close!.pending).toMatchObject([{ stageId: "review", attempt: 2,
      launchId: reservation.receipt.launchId, conversationId }]);
    expect(result.close!.status).toBe("pending");
    expect(result.close!.notes).toContainEqual(expect.objectContaining({ launchId: reservation.receipt.launchId,
      detail: expect.stringContaining("still starting") }));
    expect(h.calls.filter(call => call.startsWith("stop-host:") || call.startsWith("stop-pane:"))).toEqual([]);
    expect(registry.spawnReceipt(reservation.receipt.launchId)).toMatchObject({ state: "starting", admissionOwner: expect.objectContaining({ pid: process.pid }) });
    expect(loadPipelines().find(row => row.id === pipeline.id)!.runs[0]!.attempts[1]).toMatchObject({ state: "pending",
      launchId: null, conversationId: null });
  } finally { setAgentRegistryForTests(null); }
});

test("a launch that finishes after close remains the same pending receipt until teardown acts on it", async () => {
  const h = harness();
  h.ports.now = () => CLOSED;
  const pipeline = lane();
  const attempt = pipeline.runs[0]!.attempts[1]!;
  attempt.spawnCalls = 1;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "close-late-launch.json"));
  setAgentRegistryForTests(registry);
  try {
    const membership = { kind: "pipeline" as const, containerId: pipeline.id, role: "agent", slot: "review:2",
      stageId: "review", stageOrder: 0, round: 2, parentConversationId: null };
    const reservation = registry.beginSpawnRequest({ engine: "codex", cwd: pipeline.worktreeDir, transport: "structured",
      clientAttemptId: `pipeline_${pipeline.id}_review_2`, conversationId: "conversation_late_launch", role: "agent",
      memberships: [membership], launchProfile: { title: "Late pipeline launch" } });
    expect(reservation.kind).toBe("created");
    savePipelines([pipeline]);

    const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
    expect(closed.close!.status).toBe("pending");
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.state).toBe("pending");

    const owner = captureProcessIdentity(process.pid);
    const staged = registry.stageStructuredSpawn(reservation.receipt.launchId, {
      key: { engine: "codex", sessionId: "late-launch-session" },
      artifactPath: "/codex/late-launch.jsonl", cwd: pipeline.worktreeDir, accountId: null,
      launchProfile: reservation.receipt.launchProfile, status: "idle", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "stdio:close-test", process: owner,
        eventCursor: 1, protocolVersion: "v2", writerClaimEpoch: 1, activeTurnRef: null,
        pendingAttention: [], activeFlags: [] },
      claimEpoch: 1, claimOwner: `structured-host:${JSON.stringify(owner)}`, pendingAction: null,
      structuredHostOperationId: reservation.receipt.launchId,
    });
    expect(staged.kind).toBe("settled");
    expect(registry.spawnReceipt(reservation.receipt.launchId)).toMatchObject({ state: "path-pending" });

    const drained = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
    expect(drained.close!.status).toBe("settled");
    expect(drained.close!.alreadyStopped).toContainEqual(expect.objectContaining({ launchId: reservation.receipt.launchId }));
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.state).toBe("failed");
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.completedAt).toBe(CLOSED);
  } finally { setAgentRegistryForTests(null); }
});

test("close retains every unresolved original request, including handshake retries", async () => {
  const h = harness();
  const pipeline = lane();
  const attempt = pipeline.runs[0]!.attempts[1]!;
  attempt.spawnCalls = 2;
  const base = `pipeline_${pipeline.id}_review_2`;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "close-launch-retries.json"));
  setAgentRegistryForTests(registry);
  try {
    const make = (clientAttemptId: string, conversationId: `conversation_${string}`, slot: string) => {
      const membership = { kind: "pipeline" as const, containerId: pipeline.id, role: "agent", slot,
        stageId: "review", stageOrder: 0, round: 2, parentConversationId: null };
      return registry.beginSpawnRequest({ engine: "codex", cwd: pipeline.worktreeDir, transport: "structured",
        clientAttemptId, conversationId, role: "agent", memberships: [membership], launchProfile: { title: "Reserved pipeline stage" } });
    };
    const first = make(base, "conversation_original_initial", "review:2");
    const retry = make(`handshake_retry_1_${base}`, "conversation_original_retry", "review:2");
    expect(first.kind).toBe("created");
    expect(retry.kind).toBe("created");
    savePipelines([pipeline]);

    const result = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

    expect(result.close!.status).toBe("pending");
    expect(result.close!.pending).toMatchObject([
      { stageId: "review", attempt: 2, launchId: first.receipt.launchId, conversationId: first.receipt.conversationId },
      { stageId: "review", attempt: 2, launchId: retry.receipt.launchId, conversationId: retry.receipt.conversationId },
    ]);
    expect(registry.pipelineSpawnHistory(base).map(receipt => receipt.state)).toEqual(["starting", "starting"]);
    expect(h.calls.filter(call => call.startsWith("stop-host:") || call.startsWith("stop-pane:"))).toEqual([]);
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.state).toBe("pending");
  } finally { setAgentRegistryForTests(null); }
});

test("conflicting original receipt remains an explicit close obligation without host actuation", async () => {
  const h = harness();
  const pipeline = lane();
  const attempt = pipeline.runs[0]!.attempts[1]!;
  attempt.spawnCalls = 1;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "close-conflicting-receipt.json"));
  setAgentRegistryForTests(registry);
  try {
    const key = `pipeline_${pipeline.id}_review_2`;
    const reservation = registry.beginSpawnRequest({ engine: "codex", cwd: "/different-worktree", transport: "structured",
      clientAttemptId: key, conversationId: "conversation_conflicting_receipt", role: "agent",
      memberships: [{ kind: "pipeline", containerId: pipeline.id, role: "agent", slot: "review:2",
        stageId: "review", stageOrder: 0, round: 2, parentConversationId: null }],
      launchProfile: { title: "Conflicting pipeline stage" } });
    expect(reservation.kind).toBe("created");
    savePipelines([pipeline]);

    const result = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

    expect(result.close!.status).toBe("pending");
    expect(result.close!.pending).toContainEqual(expect.objectContaining({ launchId: reservation.receipt.launchId }));
    expect(result.close!.notes).toContainEqual(expect.objectContaining({ launchId: reservation.receipt.launchId,
      detail: expect.stringContaining("could not be verified") }));
    expect(result.close!.unconfirmed).toEqual([]);
    expect(result.close!.stillRunning).toEqual([]);
    expect(h.calls.filter(call => call.startsWith("stop-host:") || call.startsWith("stop-pane:"))).toEqual([]);
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]).toMatchObject({ state: "pending", launchId: null, conversationId: null });
  } finally { setAgentRegistryForTests(null); }
});

test.each(["empty", "terminal"] as const)("close allocates no attempt for a pending cursor with %s history", async (history) => {
  const h = harness();
  h.ports.now = () => CLOSED;
  const pipeline = lane();
  pipeline.runs[0]!.attempts = history === "empty" ? [] : [pipeline.runs[0]!.attempts[0]!];
  const before = structuredClone(pipeline.runs);
  savePipelines([pipeline]);
  const result = await rawPatchPipeline(pipeline.id, { action: "close" }, h.ports);
  expect(result.error).toBeUndefined();
  expect(stored().pipeline.runs[0]).toEqual(before[0]!);
  expect(h.spawnInputs).toHaveLength(0);
});

test.each(["stopped", "failed"] as const)("close preserves launched host teardown truth when termination is %s", async (outcome) => {
  const h = harness();
  h.ports.now = () => CLOSED;
  h.setHostsResident(true);
  h.setStageHost("conversation_launched", outcome === "stopped" ? { outcome } : { outcome, error: "fixture stop refused" });
  const pipeline = lane();
  const earlier = pipeline.runs[0]!.attempts[0]!;
  earlier.conversationId = "conversation_launched";
  earlier.launchId = "launch-earlier";
  const before = structuredClone(earlier);
  savePipelines([pipeline]);
  const result = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
  expect(result.error).toBeUndefined();
  expect(result.close![outcome === "stopped" ? "stopped" : "stillRunning"])
    .toMatchObject([{ stageId: "review", attempt: 1, conversationId: "conversation_launched" }]);
  const closed = stored().pipeline;
  expect(closed.runs[0]!.attempts[0]).toMatchObject(before);
  expect(closed.runs[0]!.attempts[1]!.state).toBe("skipped");
  expect(closed.hiddenAt === null).toBe(outcome === "failed");
});

test.each(["pipelines", "pipelines_archive"])("old closed %s read as skipped without rewriting durable history", (collection) => {
  const pipeline = lane();
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = CLOSED;
  savePipelines([pipeline]);
  if (collection === "pipelines_archive") {
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
    try {
      db.query("UPDATE state_rows SET collection='pipelines_archive' WHERE collection='pipelines' AND row_key=?").run(pipeline.id);
      db.exec("UPDATE state_collections SET revision=revision+1 WHERE collection IN ('pipelines','pipelines_archive')");
    }
    finally { db.close(); }
  }
  const before = stored(collection);
  expect(before.pipeline.runs[0]!.attempts[1]!.state).toBe("pending");
  const reads = collection === "pipelines" ? [loadPipelines(), loadPipelinesForProjection(),
    loadPipelinesForList(), loadPipelinesForStartup()] : [loadArchivedPipelinesForList()];
  reads.push([findPipelineRecord(pipeline.id)!]);
  for (const rows of reads) {
    const read = rows.find(row => row.id === pipeline.id)!;
    expect(read.runs[0]!.attempts[1]).toMatchObject({ state: "skipped", startedAt: null, completedAt: CLOSED, verdict: null });
    expect(read.runs[1]!.attempts[0]!.state).toBe("skipped");
    expect(read.runs[0]!.attempts[0]).toMatchObject(pipeline.runs[0]!.attempts[0]!);
    const revision = pipelineRevision(read);
    expect(pipelineRevision(findPipelineRecord(pipeline.id)!)).toBe(revision);
  }
  expect(stored(collection)).toEqual(before);
});

test.each(["running", "needs_decision", "paused", "completed"] as const)("%s lanes keep pending work untouched", (state) => {
  const pipeline = lane();
  pipeline.state = state;
  if (state === "completed") pipeline.cursor = null;
  savePipelines([pipeline]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.state).toBe("pending");
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.state).toBe("pending");
});

test.each(["passed", "failed", "needs_decision", "skipped"] as const)("closed history preserves earlier %s outcomes without inventing timestamps", (state) => {
  const pipeline = lane();
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = CLOSED;
  const earlier = pipeline.runs[0]!.attempts[0] = { ...pending(1), state, output: "earlier result", error: "earlier reason" };
  savePipelines([pipeline]);
  const read = loadPipelines()[0]!;
  expect(read.runs[0]!.attempts[0]).toMatchObject(earlier);
  expect(read.runs[1]!.attempts[0]!.state).toBe("skipped");
});

test.each(["launchId", "conversationId", "sessionId", "agentPath", "paneId", "flowId", "startedAt", "completedAt", "verdict"] as const)("close settlement preserves %s evidence", (evidence) => {
  const pipeline = lane();
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = CLOSED;
  const attempt = pipeline.runs[0]!.attempts[1]!;
  if (evidence === "verdict") attempt.verdict = { status: "fail", findings: [] };
  else attempt[evidence] = evidence.endsWith("At") ? START : "fixture-evidence";
  const before = structuredClone(attempt);
  savePipelines([pipeline]);
  const read = loadPipelines()[0]!;
  expect(read.runs[0]!.attempts[1]).toMatchObject(before);
  expect(read.runs[1]!.attempts[0]!.state).toBe("skipped");
});

test("reader preserves a pending activation before host evidence exists", async () => {
  await reserveActivationOnly();
  const activation = structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation!);
  const pipeline = lane();
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = CLOSED;
  pipeline.runs[0]!.attempts[1]!.activation = activation;
  savePipelines([pipeline]);
  const read = loadPipelines()[0]!;
  expect(read.runs[0]!.attempts[1]).toMatchObject({ state: "pending", activation });
  expect(read.runs[1]!.attempts[0]!.state).toBe("skipped");
});

test.each([false, true])("close keeps real activation custody across the dispatch permit (%s)", async (permitted) => {
  const f = await activationDrainFixture(permitted);
  try {
    const before = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    const changed = await rawPatchPipeline(f.id, { action: "close" }, f.h.ports);
    expect(changed.error).toBeUndefined();
    const waiting = loadPipelines()[0]!;
    expect(waiting.closeTeardown?.waitingForActivation).toBe(true);
    expect(waiting.runs[0]!.attempts[0]!.activation?.id).toBe(before.activation!.id);
    expect(waiting.runs[0]!.attempts[0]!.state).not.toBe("skipped");
    f.release();
    await f.ticking;
    const closed = loadPipelines()[0]!;
    expect(f.launches()).toBe(permitted ? 1 : 0);
    expect(closed.runs[0]!.attempts).toHaveLength(1);
    expect(closed.runs[0]!.attempts[0]!.activation).toBeUndefined();
    if (permitted) expect(closed.closeTeardown!.hosts).toMatchObject([{ target: { launchId: "activation-launch" } }]);
    expect(closed.runs[0]!.attempts[0]!.state).not.toBe("pending");
    expect(stored("pipelines", f.id).pipeline.runs[0]!.attempts[0]!.state).not.toBe("pending");
  } finally { f.release(); await f.ticking; delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});
