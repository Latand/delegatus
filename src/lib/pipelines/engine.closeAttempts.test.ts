import { expect, test, Database, path, harness, rawPatchPipeline, closeAndDrain, AgentRegistry, setAgentRegistryForTests,
  loadPipelines, savePipelines, activationDrainFixture, reserveActivationOnly } from "./engine.fixture";
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

function lane(): Pipeline {
  const pipeline = buildPipeline({ id: "close-attempts", task: "Close untouched work", project: "fixture",
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

test.each([1, undefined] as const)("close binds an unresolved registry reservation with spawnCalls=%s", async (spawnCalls) => {
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

    const result = await rawPatchPipeline(pipeline.id, { action: "close" }, h.ports);

    expect(result.error).toBeUndefined();
    const closed = stored("pipelines", pipeline.id).pipeline;
    expect({ ...closed.runs[0]!.attempts[1], spawnCalls: closed.runs[0]!.attempts[1]!.spawnCalls ?? null }).toMatchObject({
      state: "pending", spawnCalls: spawnCalls ?? null,
      launchId: reservation.receipt.launchId, conversationId });
    expect(result.close!.pending).toMatchObject([{ stageId: "review", attempt: 2,
      launchId: reservation.receipt.launchId, conversationId }]);
    expect(loadPipelines().find(row => row.id === pipeline.id)!.runs[0]!.attempts[1]).toMatchObject({ state: "pending",
      launchId: reservation.receipt.launchId, conversationId });
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
    try { db.query("UPDATE state_rows SET collection='pipelines_archive' WHERE collection='pipelines' AND row_key=?").run(pipeline.id); }
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
