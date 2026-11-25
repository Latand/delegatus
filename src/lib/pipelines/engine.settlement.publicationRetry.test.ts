import { expect, test, path, Database, tickPipelines, loadPipelines, savePipelines, patchPipeline, harness, REMOTE_BRANCH, create, publishHarness, PUBLISH_STAGES } from "./engine.fixture";

// Role-memory preparation refuses before the launcher can reserve a launch.
async function undispatchedRetryFixture(spawnCalled = false) {
  const { roleMemoryCollection } = await import("@/lib/memory/roleStore");
  const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "retry-publication-registry.json"));
  setAgentRegistryForTests(registry);
  const h = harness();
  const now = h.ports.now();
  h.ports.now = () => now;
  const box = publishHarness(h);
  const pipeline = await create(h.ports, [PUBLISH_STAGES[0], { ...PUBLISH_STAGES[1],
    onFail: { to: "build", maxRounds: 3, onExhausted: "park" } }] as never, REMOTE_BRANCH);
  const read = () => loadPipelines().find(lane => lane.id === pipeline.id)!;
  const restore = () => { setAgentRegistryForTests(null); registry.close(); };
  try {
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish(read().runs[0]!.attempts[0]!.agentPath!, "pass")], h.ports);
    expect(read().delivery!.operation).toMatchObject({ state: "settled", result: { ok: true, remote: "published", sha: box.passedSha } });
    expect(h.spawnInputs).toHaveLength(1);
    const collection = roleMemoryCollection(true)!;
    const rule = {
      kind: "rule" as const, id: "r_retry_publication", scope: "machine" as const,
      rule: "Preserve current publication evidence during a retry", why: "", state: "active" as const, hints: [],
      source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
      createdAt: h.ports.now(), changedAt: h.ports.now(),
    };
    collection.boundedPatch(1, tx => tx.put(rule));
    const launch = h.ports.spawnAgent;
    if (spawnCalled) h.ports.spawnAgent = async () => { throw new Error("fixture launcher refused after invocation"); };
    else {
      const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
      db.query("UPDATE state_rows SET value_json = ? WHERE collection = 'role_memory' AND row_key = 'r:r_retry_publication'")
        .run(JSON.stringify({ kind: "rule", id: 7, rule: rule.rule }));
      db.close();
    }
    try { await tickPipelines([], h.ports); }
    finally { collection.boundedPatch(1, tx => tx.put(rule)); h.ports.spawnAgent = launch; }
    const parked = read();
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain(spawnCalled ? "fixture launcher refused" : "role memory could not be read");
    expect(parked.runs.find(run => run.stageId === "review")!.attempts[0]!.launchId).toBeNull();
    expect(h.spawnInputs).toHaveLength(1);
    const key = `pipeline_${pipeline.id}_review_1`;
    expect(registry.pipelineSpawnHistory(key)).toEqual([]);
    const { rawPatchPipeline } = await import("./engine.fixture");
    const retry = () => rawPatchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "review", expectedAttempt: 1 }, h.ports);
    return { h, box, read, registry, key, retry, restore };
  } catch (error) { restore(); throw error; }
}

test("an undispatched same-head retry keeps its publication receipt without publishing again", async () => {
  const f = await undispatchedRetryFixture();
  try {
    const unknown = f.registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", transport: "structured",
      clientAttemptId: "pipeline_unrelated_review_1", launchProfile: { title: "Unsettled original evidence" } }).receipt!;
    const before = structuredClone(f.read());
    const reads = f.box.remoteReadAttempts();
    const pushes = f.box.order.filter(item => item.startsWith("push:"));
    expect(pushes).toHaveLength(1);
    expect((await f.retry()).error).toBeUndefined();
    const retried = f.read();
    expect(retried.delivery).toEqual(before.delivery);
    expect(retried.publishedCommit).toBe(f.box.passedSha);
    expect(retried.publicationRecovery).toEqual(before.publicationRecovery);
    expect(retried.stages).toEqual(before.stages);
    expect(retried.stages[1]!.onFail).toMatchObject({ maxRounds: 3 });
    expect(retried.runs).toEqual(before.runs);
    await f.retry();
    await tickPipelines([], f.h.ports);
    const running = f.read().runs.find(run => run.stageId === "review")!;
    expect(running.attempts).toHaveLength(2);
    expect(running.attempts[0]).toEqual(before.runs.find(run => run.stageId === "review")!.attempts[0]);
    expect(f.h.spawnInputs).toHaveLength(2);
    await tickPipelines([f.h.finish(running.attempts[1]!.agentPath!, "pass")], f.h.ports);
    const completed = f.read();
    expect(completed.state).toBe("completed");
    expect(completed.delivery!.operation).toEqual(before.delivery!.operation);
    expect(completed.publishedCommit).toBe(f.box.passedSha);
    expect(f.box.remoteReadAttempts()).toBe(reads);
    expect(f.box.order.filter(item => item.startsWith("push:"))).toEqual(pushes);
    expect(f.registry.spawnReceipt(unknown.launchId)).toEqual(unknown);
  } finally { f.restore(); }
});

test.each(["uncertain-success", "executor-unfinished"] as const)(
  "an undispatched retry replaces unresolved publication evidence before completion: %s", async variant => {
    const f = await undispatchedRetryFixture();
    try {
      const lane = f.read();
      const operation = lane.delivery!.operation!;
      expect(operation.result?.ok).toBe(true);
      if (variant === "uncertain-success" && operation.result?.ok) operation.result.uncertain = true;
      if (variant === "executor-unfinished") {
        expect(operation.executor).toBeDefined();
        operation.executor!.finished = false;
      }
      savePipelines([lane]);
      const { pipelinePublicationHoldsHost } = await import("./hostRetirement");
      expect(pipelinePublicationHoldsHost(f.read())).toBe(true);
      const reads = f.box.remoteReadAttempts();
      expect((await f.retry()).error).toBeUndefined();
      const retried = f.read();

      await tickPipelines([], f.h.ports);
      const attempt = f.read().runs.find(run => run.stageId === "review")!.attempts.at(-1)!;
      expect(attempt.n).toBe(2);
      await tickPipelines([f.h.finish(attempt.agentPath!, "pass")], f.h.ports);
      const completed = f.read();
      expect(completed.state).toBe("completed");
      expect(completed.delivery!.operation!.id).not.toBe(operation.id);
      expect(completed.delivery!.operation).toMatchObject({ state: "settled",
        result: { ok: true, remote: "published", sha: f.box.passedSha } });
      expect(f.box.remoteReadAttempts()).toBeGreaterThan(reads);
      expect(pipelinePublicationHoldsHost(completed)).toBe(false);
      expect(retried.delivery!.operation).toBeUndefined();
      expect(retried.publishedCommit).toBeNull();
      expect(retried.stages).toEqual(lane.stages);
      expect(retried.runs).toEqual(lane.runs);
    } finally { f.restore(); }
  });

test.each(["moved-head", "dirty-worktree", "spawn-called", "owner-replaced", "stale-epoch",
  "refused-receipt", "unreachable-receipt", "pending-receipt", "running-receipt", "result-sha", "operation-sha", "published-sha",
  "registry-after-await", "registry-unreadable", "wrong-branch", "head-read-failed", "head-read-threw"] as const)(
  "an undispatched retry retains existing publication invalidation: %s", async variant => {
    const f = await undispatchedRetryFixture(variant === "spawn-called");
    try {
      const lane = f.read();
      const before = structuredClone(lane);
      const operation = structuredClone(lane.delivery!.operation!);
      const otherSha = "9".repeat(40);
      if (variant === "moved-head") f.box.setLocalHead(otherSha);
      if (variant === "dirty-worktree") f.box.setDirty(true);
      if (variant === "spawn-called") expect(lane.runs.find(run => run.stageId === "review")!.attempts[0]!.spawnCalls).toBeGreaterThan(0);
      if (variant === "stale-epoch") lane.delivery!.operation!.epoch++;
      if (variant === "refused-receipt") lane.delivery!.operation!.result = { ok: false, error: "fixture publication refusal" };
      if (variant === "unreachable-receipt") lane.delivery!.operation!.result = { ok: true, sha: f.box.passedSha, remote: "unreachable", detail: "unknown remote outcome" };
      if (variant === "pending-receipt") lane.delivery!.operation!.state = "pending";
      if (variant === "running-receipt") lane.delivery!.operation!.state = "running";
      if (variant === "result-sha") lane.delivery!.operation!.result = { ok: true, sha: otherSha, remote: "published" };
      if (variant === "operation-sha") lane.delivery!.operation!.sha = otherSha;
      if (variant === "published-sha") lane.publishedCommit = otherSha;
      if (variant === "stale-epoch") {
        expect(() => savePipelines([lane])).toThrow("refusing to persist a malformed pipeline record");
        expect(f.read()).toEqual(before);
        return;
      }
      savePipelines([lane]);
      if (variant === "owner-replaced") {
        const { buildPipeline, createPipelineWithDelivery, takeoverPipelineDelivery } = await import("./store");
        const successor = await createPipelineWithDelivery(buildPipeline({ id: "retry-successor", task: "Continue delivery",
          project: lane.project, repoDir: lane.repoDir, stages: lane.stages, srcPath: null, srcConversationId: null,
          now: f.h.ports.now(), state: "draft" }), lane.delivery!.target);
        expect((await takeoverPipelineDelivery(successor.id, lane.id, lane.delivery!.epoch, "continue delivery", null)).error).toBeUndefined();
      }
      const execute = f.h.ports.exec;
      let inserted = false;
      f.h.ports.exec = async (command, rawArgs, ...rest) => {
        const args = command === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
        const result = await execute(command, rawArgs, ...rest);
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          if (variant === "head-read-threw") throw new Error("fixture HEAD read failed");
          if (variant === "head-read-failed") return { code: 1, stdout: "", stderr: "fixture HEAD unavailable" };
          if (variant === "registry-after-await" && !inserted) {
            inserted = true;
            expect(f.registry.beginSpawnRequest({ engine: "codex", cwd: lane.worktreeDir, transport: "structured",
              clientAttemptId: f.key, launchProfile: { title: "Original launch evidence" } }).kind).toBe("created");
          }
        }
        if (variant === "wrong-branch" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: "other-branch", stderr: "" };
        return result;
      };
      const { spyOn } = await import("bun:test");
      const unreadable = variant === "registry-unreadable" ? spyOn(f.registry, "pipelineSpawnHistory").mockImplementation(() => { throw new Error("fixture registry unavailable"); }) : null;
      let result;
      try { result = await f.retry(); } finally { unreadable?.mockRestore(); }
      expect(result.error).toBeUndefined();
      const after = f.read();
      if (variant === "pending-receipt" || variant === "running-receipt") {
        // Existing retry leaves unsettled evidence alone; it proves no success.
        expect(after.delivery!.operation).toEqual({ ...operation, state: variant === "pending-receipt" ? "pending" : "running" });
        expect(after.publishedCommit).toBe(lane.publishedCommit);
      } else {
        expect(after.delivery!.operation).toBeUndefined();
        expect(after.publishedCommit).toBeNull();
      }
      if (variant === "registry-after-await") {
        expect(inserted).toBe(true);
        expect(f.registry.pipelineSpawnHistory(f.key)).toHaveLength(1);
      }
      if (variant === "refused-receipt") expect(after.publicationRecovery![f.box.passedSha]!.history[0]!.operationId).toBe(operation.id);
      if (variant === "owner-replaced") {
        const reads = f.box.remoteReadAttempts();
        expect((await patchPipeline(lane.id, { action: "publish" }, f.h.ports)).error).toBeDefined();
        expect(f.box.remoteReadAttempts()).toBe(reads);
      }
    } finally { f.restore(); }
  });
