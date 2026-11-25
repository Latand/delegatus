import { expect, test, spawnSync, fs, path, Database, tickPipelines, loadPipelines, savePipelines, patchPipeline, rawPatchPipeline, entry, harness, finishReported, REMOTE_BRANCH, create, publishHarness, PUBLISH_STAGES, deliveryRefusalPark, interruptedPublication } from "./engine.fixture";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { publishPipelineBranch } from "./git";
import { recordPublicationFailure, PUBLICATION_RETRY_DELAYS_MS } from "./publicationHistory";

test.each(["automatic", "publish", "retry-stage", "dirty-tick", "dirty-publish", "dirty-retry-stage", "moved", "rollback-pending"] as const)(
  "a settled publication reaches the pass edge after interrupted pushes and a retired admission (%s)", async action => {
    const h = harness();
    const box = publishHarness(h, { remoteReadFails: true });
    const exec = h.ports.exec;
    const remote = "https://github.com/fixture/project.git";
    let prCreates = 0;
    const checkoutWrites: string[] = [];
    h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "git" && args[0] === "remote" && args[1] === "get-url")
        return { code: 0, stdout: remote + "\n", stderr: "" };
      if (command === "gh" && args[1] === "create") {
        prCreates++;
        return { code: 0, stdout: "created", stderr: "" };
      }
      if (command === "gh" && args[1] === "list") {
        const lane = loadPipelines()[0]!;
        return { code: 0, stdout: JSON.stringify(prCreates ? [{ number: 42, headRefName: lane.branch,
          baseRefName: lane.baseBranch, state: "OPEN", headRefOid: box.passedSha, isCrossRepository: false }] : []), stderr: "" };
      }
      if (command === "git" && ["add", "clean", "reset", "restore"].includes(args[0]!)) checkoutWrites.push(args[0]!);
      return exec(command, args, cwd, env, options);
    };
    await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "Accepted output")], h.ports);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    expect(lane.cursor).toMatchObject({ stageId: "build", state: "committing" });
    expect(attempt.state).toBe("passed");
    const oldSha = lane.baseRef;
    const refusal = "publishing the passed stage: the repository's pre-push hook failed in its touched tests phase";
    const now = h.ports.now();
    attempt.publicationRepair = { sha: oldSha, baseSha: oldSha, operationId: "old-head-refusal", stageId: "build", attempt: attempt.n,
      refusedAt: now, settledAt: now, requestedAt: now, cleanHead: { sha: oldSha, branch: lane.branch },
      detail: "pre-push: touched tests: failed (1)", parkDetail: refusal, paths: [], messageTs: null,
      outcome: { status: "rejected", reason: "The producer did not finish in time." },
      ...(action === "rollback-pending" ? { rollback: { index: oldSha, tree: oldSha,
        afterTree: oldSha, tracked: [], untracked: [], phase: "restore" as const } } : {}) };
    delete lane.publicationRecovery;
    delete attempt.publicationRetry;
    const delivery = lane.delivery!;
    const reservation = delivery.operation!;
    for (let index = 0; index < 7; index++) {
      const superseded = index === 4;
      const detail = superseded ? "publication admission superseded by the passed-stage settlement decision"
        : "interrupted publication did not leave its accepted head on the remote";
      const id = `prior-publication-${index}`;
      delivery.operation = { ...reservation, id, state: "settled", result: { ok: false, error: detail,
        ...(superseded ? {} : { outcome: "not-landed" as const }) } };
      recordPublicationFailure(lane, attempt, { operationId: id, epoch: delivery.epoch, at: h.ports.now(),
        cause: superseded ? "check-failure" : "interrupted", detail, recoverable: !superseded }, PUBLICATION_RETRY_DELAYS_MS);
    }
    delete delivery.operation;
    lane.stateDetail = refusal;
    attempt.error = refusal;
    savePipelines([lane]);
    box.setRemoteReadFails(false);
    box.setRemote(box.passedSha);
    expect(await publishPipelineBranch(lane, h.ports.exec, { acceptedSha: box.passedSha, now: h.ports.now }))
      .toMatchObject({ ok: true, remote: "published", sha: box.passedSha });
    const published = loadPipelines()[0]!;
    expect(published).toMatchObject({ state: "running", stateDetail: refusal,
      cursor: { stageId: "build", state: "committing" }, publishedCommit: box.passedSha });
    const receipt = published.delivery!.operation!;
    const history = published.publicationRecovery;
    expect(history?.[box.passedSha]).toMatchObject({ failures: 6, totalAttempts: 7 });
    checkoutWrites.length = 0;
    const reads = box.remoteReadAttempts();
    const seat = { kind: "agent", role: "orchestrator", conversationId: "conversation_creator" } as const;
    if (action.startsWith("dirty")) box.setDirty(true);
    if (action === "moved") box.setLocalHead("9".repeat(40));
    if (action === "publish") expect((await rawPatchPipeline(lane.id, { action }, h.ports, seat)).error).toBeUndefined();
    if (action === "retry-stage") {
      expect(await rawPatchPipeline(lane.id, { action, expectedStageId: "build", expectedAttempt: attempt.n + 1 }, h.ports, seat))
        .toMatchObject({ code: "STAGE_CHANGED", field: "expectedAttempt" });
      expect((await rawPatchPipeline(lane.id, { action, expectedStageId: "build", expectedAttempt: attempt.n }, h.ports, seat)).error)
        .toBeUndefined();
    }
    await tickPipelinesController([], h.ports);
    await settlePipelineControllerJobs();
    const after = loadPipelines()[0]!;
    const checkoutRefused = action.startsWith("dirty") || action === "moved";
    expect(after.publicationRecovery).toEqual(history);
    expect(after.delivery!.operation).toEqual(checkoutRefused ? { ...receipt, passedStage: false } : receipt);
    expect(after.runs[0]!.attempts).toHaveLength(1);
    expect(after.runs[0]!.attempts[0]!.publicationRepair).toEqual(attempt.publicationRepair);
    expect(checkoutWrites).toEqual([]);
    expect(box.order).toEqual(["commit"]);
    expect(box.remoteReadAttempts()).toBe(reads);
    if (checkoutRefused || action === "rollback-pending") {
      expect(after.cursor).toMatchObject({ stageId: "build", state: "committing" });
      expect(prCreates).toBe(0);
      if (checkoutRefused) expect(after.state).toBe("needs_decision");
      if (action.startsWith("dirty")) expect(after.stateDetail).toContain("uncommitted changes");
      if (action === "moved") expect(after.stateDetail).toContain("the worktree moved");
      if (action.startsWith("dirty")) {
        expect(after.delivery!.operation).toEqual({ ...receipt, passedStage: false });
        expect(after.runs[0]!.attempts[0]!.state).toBe("passed");
        box.setDirty(false);
        box.setLocalHead(box.passedSha);
        if (action === "dirty-publish") {
          expect((await rawPatchPipeline(lane.id, { action: "publish" }, h.ports, seat)).error).toBeUndefined();
        } else if (action === "dirty-retry-stage") {
          expect((await rawPatchPipeline(lane.id, { action: "retry-stage", expectedStageId: "build",
            expectedAttempt: attempt.n }, h.ports, seat)).error).toBeUndefined();
        }
        await tickPipelinesController([], h.ports);
        await settlePipelineControllerJobs();
        const recovered = loadPipelines()[0]!;
        expect(recovered).toMatchObject({ state: "running", stateDetail: null,
          delivery: { target: { pr: 42 }, operation: receipt },
          cursor: { stageId: "review", state: "pending", activatedBy: { stageId: "build", attempt: attempt.n, edge: "pass" } } });
        expect(recovered.runs[0]!.attempts).toHaveLength(1);
        expect(recovered.runs[0]!.attempts[0]!.publicationRepair).toEqual(attempt.publicationRepair);
        expect(box.order).toEqual(["commit"]);
        expect(prCreates).toBe(1);
      }
      return;
    }
    expect(after).toMatchObject({ state: "running", stateDetail: null, delivery: { target: { pr: 42 } },
      cursor: { stageId: "review", state: "pending", input: "Accepted output", activatedBy: { stageId: "build", attempt: attempt.n, edge: "pass" } } });
    expect(after.runs[0]!.attempts[0]).toMatchObject({ state: "passed", verdict: { status: "pass" }, error: null, completedAt: attempt.completedAt });
    expect(prCreates).toBe(1);
  });

test.each([false, true])("own-id takeover resumes a delivery-refusal park without rerunning the pass (publish first: %s)", async (publishFirst) => {
  const { h, box, pipeline, id } = await deliveryRefusalPark();
  const cursor = structuredClone(pipeline.cursor);
  expect((await patchPipeline(id, { action: "takeover", expectedOwner: id, expectedEpoch: 1,
    reason: "recover the lane's delivery" }, h.ports)).error).toBeUndefined();
  if (publishFirst) expect((await patchPipeline(id, { action: "publish" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  const resumed = loadPipelines()[0]!;
  expect(resumed).toMatchObject({ state: "running", cursor: { stageId: "review", state: "pending" },
    publishedCommit: box.passedSha, delivery: { active: true, ownerId: id, epoch: 2 } });
  expect(resumed.runs[0]!.attempts).toHaveLength(1);
  expect(resumed.runs[0]!.attempts[0]).toMatchObject({ state: "passed", output: "accepted output", input: cursor!.input,
    activatedBy: cursor!.activatedBy, verdict: { status: "pass" }, error: null });
  expect(h.spawnInputs).toHaveLength(1);
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`]);
});

test.each(["paused", "closed"] as const)("a quiescent accepted publication settles while its lane is %s without reopening or republishing", async (state) => {
  const { h, box, pipeline } = await interruptedPublication();
  const operationId = pipeline.delivery!.operation!.id;
  box.setRemote(box.passedSha);
  pipeline.state = state;
  pipeline.pausedState = state === "paused" ? "running" : null;
  if (state === "closed") { pipeline.closedAt = "2026-10-02T00:00:00.000Z"; pipeline.cursor = null; }
  savePipelines([pipeline]);
  const pushesBefore = box.order.filter((item) => item.startsWith("push:")).length;

  const descriptor = fs.openSync(pipeline.delivery!.operation!.executor!.lock, "a");
  try {
    expect(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] }).status).toBe(0);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state, delivery: { operation: { id: operationId, state: "running" } } });
  } finally { fs.closeSync(descriptor); }

  await tickPipelines([], h.ports);

  const settled = loadPipelines()[0]!;
  expect(settled).toMatchObject({ state, delivery: { operation: { id: operationId, state: "settled", result: { ok: true, sha: box.passedSha } } }, publishedCommit: box.passedSha });
  expect(box.order.filter((item) => item.startsWith("push:"))).toHaveLength(pushesBefore);
  if (state === "paused") expect(settled.cursor).toMatchObject({ stageId: "build", state: "committing" });
  else expect(settled.cursor).toBeNull();
});

test("Git proof hands off to review and retains a first-PR obligation after a transient forge lookup failure", async () => {
  const h = harness();
  const box = publishHarness(h);
  const exec = h.ports.exec;
  const remote = "https://github.com/fixture/project.git";
  let forgeReady = false;
  let createCalls = 0;
  const forgeCalls: string[] = [];
  h.ports.exec = async (command, args, cwd, env, options) => {
    if (command === "git" && args[0] === "remote" && args[1] === "get-url")
      return { code: 0, stdout: `${remote}\n`, stderr: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      forgeCalls.push(`${forgeReady}: ${args.join(" ")}`);
      if (!forgeReady) return { code: 1, stdout: "", stderr: "temporary forge outage" };
      return { code: 0, stdout: JSON.stringify([{ number: 42,
        headRefName: loadPipelines()[0]!.branch, baseRefName: "main", state: "OPEN",
        headRefOid: box.passedSha, isCrossRepository: false }]), stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      createCalls++;
      return { code: 0, stdout: "created", stderr: "" };
    }
    return exec(command, args, cwd, env, options);
  };
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  const lane = loadPipelines()[0]!;
  lane.delivery!.target.remote = remote;
  savePipelines([lane]);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "Accepted output")], h.ports);
  const handedOff = loadPipelines()[0]!;
  expect(handedOff).toMatchObject({ state: "running", cursor: { stageId: "review", state: "pending" },
    delivery: { pendingFirstPullRequest: { sha: box.passedSha, stageId: "build", attempt: 1 } } });
  expect(createCalls).toBe(0);

  forgeReady = true;
  for (let tick = 0; tick < 3; tick++) {
    await tickPipelines([], h.ports);
    await settlePipelineControllerJobs();
  }
  expect(forgeCalls.length).toBeGreaterThan(1);
  const final = loadPipelines()[0]!;
  expect(createCalls).toBe(0);
  expect(final).toMatchObject({ cursor: { stageId: "review" }, delivery: { target: { pr: 42 } } });
  expect(final.delivery!.pendingFirstPullRequest).toBeUndefined();
  expect(h.spawnInputs).toHaveLength(2);
});

test("a same-owner publication waits through another tick, then advances once settled (#1939)", async () => {
  let waiting: ReturnType<typeof loadPipelines>[number] | undefined;
  const { h, box, pipeline } = await interruptedPublication(async ports => {
    // Inspect the tick while the real publisher still holds both fences.
    await tickPipelines([], ports);
    waiting = loadPipelines()[0];
  });
  const operation = pipeline.delivery!.operation!;
  expect(operation.state).toBe("running");
  expect(waiting).toMatchObject({
    state: "running",
    stateDetail: expect.stringContaining("in progress since"),
    delivery: { operation: { id: operation.id, state: "running" } },
    cursor: { stageId: "build", state: "committing" },
    runs: expect.arrayContaining([expect.objectContaining({
      stageId: "build", attempts: [expect.objectContaining({ state: "passed" })],
    })]),
  });
  box.setRemote(box.passedSha);
  await tickPipelines([], h.ports);
  const advanced = loadPipelines()[0]!;
  expect(advanced.cursor?.stageId).toBe("review");
  expect(advanced.publishedCommit).toBe(box.passedSha);
  expect(advanced.runs[0]!.attempts).toHaveLength(1);
  expect(box.order.filter((item) => item === "commit")).toHaveLength(1);
  expect(box.order.some((item) => item.startsWith("push:"))).toBe(false);
});

test("a legacy HEAD-verification park waits for its in-flight publisher to settle", async () => {
  const { h, box, pipeline } = await interruptedPublication();
  const operation = pipeline.delivery!.operation!;
  const detail = "the accepted head cannot be verified before completion: HEAD temporarily unavailable";
  pipeline.state = "needs_decision";
  pipeline.stateDetail = detail;
  pipeline.runs[0]!.attempts[0]!.state = "needs_decision";
  pipeline.runs[0]!.attempts[0]!.error = detail;
  savePipelines([pipeline]);
  box.setRemote(box.passedSha);
  const descriptor = fs.openSync(operation.executor!.lock, "a");
  try {
    expect(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] }).status).toBe(0);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: detail,
      cursor: { stageId: "build", state: "committing" }, delivery: { operation: { id: operation.id, state: "running" } } });
    expect(h.spawnInputs).toHaveLength(1);
    expect(box.order).toEqual(["commit"]);
  } finally { fs.closeSync(descriptor); }
  await tickPipelines([], h.ports);
  const recovered = loadPipelines()[0]!;
  expect(recovered).toMatchObject({ state: "running", publishedCommit: box.passedSha,
    cursor: { stageId: "review", state: "pending" } });
  expect(recovered.runs[0]!.attempts).toHaveLength(1);
  expect(recovered.runs[0]!.attempts[0]!.state).toBe("passed");
  expect(h.spawnInputs).toHaveLength(1);
  expect(box.order).toEqual(["commit"]);
});

test("a restarted engine reconciles an interrupted reservation from the remote without repeating stage work (#1939)", async () => {
  const { h, box, pipeline } = await interruptedPublication();
  pipeline.delivery!.operation!.state = "pending";
  savePipelines([pipeline]);
  const child = Bun.spawn([process.execPath, "-e", `
    const { publishPipelineBranch } = await import("./src/lib/pipelines/git.ts");
    const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
    const pipeline = loadPipelines()[0];
    await publishPipelineBranch(pipeline, () => process.exit(0), { acceptedSha: pipeline.lastPassedCommit });
    process.exit(1);
  `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const crashed = loadPipelines()[0]!.delivery!.operation!;
  expect(crashed).toMatchObject({ state: "running", executor: { pid: child.pid } });
  expect(crashed.executor!.finished).toBeUndefined();
  box.setRemote(box.passedSha);
  const reservation = crashed.id;
  const exec = h.ports.exec;
  h.ports.exec = async (command, args, cwd) => {
    if (args.includes("ls-remote")) {
      const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
      try { expect(db.query("SELECT count(*) AS n FROM state_leases WHERE collection='pipelines'").get()).toEqual({ n: 0 }); }
      finally { db.close(); }
    }
    return (await exec(command, args, cwd));
  };
  await tickPipelines([], { ...h.ports });
  const recovered = loadPipelines()[0]!;
  expect(recovered.state).toBe("running");
  expect(recovered.cursor?.stageId).toBe("review");
  expect(recovered.delivery!.operation).toMatchObject({ id: reservation, state: "settled" });
  expect(recovered.publishedCommit).toBe(box.passedSha);
  expect(recovered.runs[0]!.attempts).toHaveLength(1);
  expect(box.order).toEqual(["commit"]);
});

test("a quiescent reservation that never pushed retries publication without repeating the passed stage (#1939)", async () => {
  const { h, box } = await interruptedPublication();
  await tickPipelines([], h.ports);
  const recovered = loadPipelines()[0]!;
  expect(recovered.cursor?.stageId).toBe("review");
  expect(recovered.publishedCommit).toBe(box.passedSha);
  expect(recovered.runs[0]!.attempts).toHaveLength(1);
  expect(box.order.filter((item) => item === "commit")).toHaveLength(1);
  expect(box.order.filter((item) => item.startsWith("push:"))).toEqual([`push:${box.passedSha}`]);
});

test("a stale running publication parks with its reservation, age and recovery action (#1939)", async () => {
  const { h, box, pipeline } = await interruptedPublication();
  const operation = pipeline.delivery!.operation!;
  const descriptor = fs.openSync(operation.executor!.lock, "a");
  try {
    expect(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] }).status).toBe(0);
    const stale = new Date(Date.now() - 120_000);
    fs.futimesSync(descriptor, stale, stale);
    await tickPipelines([], h.ports);
    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain(`publication ${operation.id} has no progress for 120s`);
    expect(parked.stateDetail).toContain(`takeover with expectedOwner ${pipeline.id} and expectedEpoch 1`);
    expect(parked.delivery!.operation!.id).toBe(operation.id);
    expect(parked.runs[0]!.attempts[0]!.state).toBe("passed");
  } finally { fs.closeSync(descriptor); }
  box.setRemote(box.passedSha);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("review");
});

test.each(["reject", "edit"] as const)("revocation during stage settlement preserves the active publication fence (%s)", async decision => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority, NOW } = await import("@/lib/tasks/proactive.fixture");
  const { mutateTasks } = await import("@/lib/tasks/store");
  const { patchTask } = await import("@/lib/tasks/commands");
  const { settlePendingStageGit } = await import("./engine");
  const { pipelinePublicationFence } = await import("./git");
  const { h, box, pipeline } = await interruptedPublication();
  const project = pipeline.project;
  const { task } = await admitProactiveTask({ ...candidate(`settlement-${decision}`), project }, { ...context(), project }, undefined, authority());
  const now = () => new Date(NOW).toISOString();
  await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task), undefined, now);
  pipeline.taskIds = [task.id];
  savePipelines([pipeline]);
  const fence = pipelinePublicationFence(pipeline);
  const operation = pipeline.delivery!.operation!;
  const descriptor = fs.openSync(operation.executor!.lock, "a");
  const artifact = path.join(path.dirname(operation.executor!.lock), "retained-settlement.txt");
  const exec = h.ports.exec;
  let revoked = false;
  try {
    expect(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] }).status).toBe(0);
    fs.writeFileSync(artifact, "Retain the accepted work\n", { flag: "wx" });
    h.ports.exec = async (...args) => {
      if (!revoked) {
        revoked = true;
        if (decision === "reject") await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(task), undefined, now);
        else mutateTasks(tasks => {
          const result = patchTask(tasks, task.id, { details: "Scope changed during the accepted-head read" });
          if (!result.ok) throw new Error(result.error);
          return { tasks: result.tasks, result: null };
        });
        const stale = new Date(Date.now() - 120_000);
        fs.futimesSync(descriptor, stale, stale);
      }
      return await exec(...args);
    };
    await settlePendingStageGit(h.ports);
    expect(revoked).toBe(true);
    const retained = loadPipelines()[0]!;
    expect(retained.state).toBe("running");
    expect(pipelinePublicationFence(retained)).toBe(fence);
    expect(retained.delivery!.operation).toMatchObject({ id: operation.id, state: "running" });
    expect(box.order).toEqual(["commit"]);
    expect(h.spawnInputs).toHaveLength(1);
    expect(fs.readFileSync(artifact, "utf8")).toBe("Retain the accepted work\n");
  } finally { h.ports.exec = exec; fs.closeSync(descriptor); }
});

for (const settled of [false, true]) {
  test(`a lane already parked on its own publisher recovers with a ${settled ? "settled" : "running"} reservation (#1939)`, async () => {
    const { h, box, pipeline } = await interruptedPublication();
    box.setRemote(box.passedSha);
    pipeline.state = "needs_decision";
    pipeline.stateDetail = `publishing the passed stage: publisher ${pipeline.id} at epoch 1 is in flight or uncertain`;
    // The old park helper overwrote even the passed attempt's state.
    pipeline.runs[0]!.attempts[0]!.state = "needs_decision";
    pipeline.runs[0]!.attempts[0]!.error = pipeline.stateDetail;
    if (settled) {
      pipeline.delivery!.operation!.state = "settled";
      pipeline.delivery!.operation!.result = { ok: true, sha: box.passedSha, remote: "published" };
    }
    savePipelines([pipeline]);
    await tickPipelines([], h.ports);
    const recovered = loadPipelines()[0]!;
    expect(recovered.state).toBe("running");
    expect(recovered.cursor?.stageId).toBe("review");
    expect(recovered.runs[0]!.attempts).toHaveLength(1);
    expect(recovered.runs[0]!.attempts[0]!.state).toBe("passed");
    expect(box.order).toEqual(["commit"]);
  });
}

for (const variant of ["published", "moved-head", "unknown-remote", "different-result-sha", "different-operation-sha", "pending", "failed"] as const) {
  test(`a read-only pass reuses only exact settled publication evidence: ${variant}`, async () => {
    const h = harness();
    const box = publishHarness(h);
    await create(h.ports, [PUBLISH_STAGES[0], { ...PUBLISH_STAGES[1], ...(variant === "moved-head" ? { role: { roleId: "builder" } } : {}) }] as never, REMOTE_BRANCH);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish(loadPipelines()[0]!.runs[0]!.attempts[0]!.agentPath!, "pass")], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const lane = loadPipelines()[0]!;
    const operation = lane.delivery!.operation!;
    expect(operation.state).toBe("settled");
    expect(operation.result).toMatchObject({ ok: true, remote: "published", sha: box.passedSha });
    const otherSha = "9".repeat(40);
    if (variant === "moved-head") box.setLocalHead(otherSha);
    if (variant === "unknown-remote") operation.result = { ok: true, sha: box.passedSha, remote: "unreachable", detail: "unknown" };
    if (variant === "different-result-sha") operation.result = { ok: true, sha: otherSha, remote: "published" };
    if (variant === "different-operation-sha") operation.sha = otherSha;
    if (variant === "pending") operation.state = "pending";
    if (variant === "failed") operation.result = { ok: false, error: "publication refused" };
    savePipelines([lane]);
    const reads = box.remoteReadAttempts();
    await tickPipelines([h.finish(lane.runs.find(run => run.stageId === "review")!.attempts[0]!.agentPath!, "pass")], h.ports);
    const settled = loadPipelines()[0]!;
    if (variant === "published") {
      expect(settled.state).toBe("completed");
      expect(settled.delivery!.operation!.id).toBe(operation.id);
      expect(box.remoteReadAttempts()).toBe(reads);
    } else {
      expect(settled.delivery!.operation!.id).not.toBe(operation.id);
      expect(box.remoteReadAttempts()).toBeGreaterThan(reads);
    }
  });
}

test("a builder that already pushed the accepted commit settles without another push (#1939)", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  box.setDirty(false);
  box.setLocalHead(box.passedSha);
  box.setRemote(box.passedSha);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  const advanced = loadPipelines()[0]!;
  expect(advanced.state).toBe("running");
  expect(advanced.cursor?.stageId).toBe("review");
  expect(advanced.publishedCommit).toBe(box.passedSha);
  expect(box.order).toEqual([]);
});

test("an unreachable remote backs off across restarts, parks, and recovers the accepted pass (#3375)", async () => {
  const h = harness();
  const box = publishHarness(h, { remoteReadFails: true });
  let clock = Date.parse(h.ports.now());
  const scheduled: number[] = [];
  h.ports.now = () => new Date(clock).toISOString();
  h.ports.scheduleTick = delay => { scheduled.push(delay); };
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  const current = loadPipelines()[0]!;
  const attempt = current.runs.find((run) => run.stageId === "build")!.attempts[0]!;
  expect(current).toMatchObject({
    state: "running",
    lastPassedCommit: box.passedSha,
    publishedCommit: null,
    stateDetail: expect.stringContaining("passed but unpublished"),
  });
  expect(attempt).toMatchObject({
    state: "passed",
    verdict: { status: "pass" },
    error: expect.stringContaining("passed but unpublished"),
  });
  expect(box.remoteReadAttempts()).toBe(1);
  expect(box.order).toEqual(["commit"]);
  expect(h.flows.size).toBe(0);

  /* A successor cannot run while the accepted head remains unpublished. */
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("running");
  expect(waiting.cursor).toMatchObject({ stageId: "build", state: "committing" });
  expect(waiting.stateDetail).toContain("passed but unpublished");
  expect(waiting.runs.find((run) => run.stageId === "build")!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass" },
  });
  expect(box.remoteReadAttempts()).toBe(1);
  expect(waiting.delivery!.operation!.id).toBe(current.delivery!.operation!.id);
  expect(h.flows.size).toBe(0);
  expect(attempt.publicationRetry).toMatchObject({ failures: 1, retryAt: new Date(clock + 60_000).toISOString() });
  expect(scheduled).toContain(60_000);

  const { realExec } = await import("@/lib/workflows/provision");
  const restart = async (remoteFails = true) => {
    const script = `
      const { defaultPipelinePorts, tickPipelines } = await import(${JSON.stringify(path.join(import.meta.dir, "engine.ts"))});
      const { registerPipelineTick } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerSignal.ts"))});
      registerPipelineTick(async () => {});
      const scheduled = [];
      let reads = 0;
      const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(new Date(clock).toISOString())},
        scheduleTick: delay => scheduled.push(delay), worktreePresent: () => true,
        conversationAgentActive: async () => false, stageHostResident: async () => false,
        paneAgentAlive: async () => false, getFlow: () => null,
        spawnAgent: async () => { throw new Error("passed stage must not respawn"); },
        exec: async (command, rawArgs) => {
          const args = command === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
          if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: ${JSON.stringify(box.passedSha)}, stderr: "" };
          if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: ${JSON.stringify(current.branch)}, stderr: "" };
          if (args[0] === "ls-remote") {
            reads++;
            return ${remoteFails ? '{ code: 128, stdout: "", stderr: "fatal: remote authentication unavailable" }'
              : JSON.stringify({ code: 0, stdout: `${box.passedSha}\trefs/heads/${current.branch}\n`, stderr: "" })};
          }
          throw new Error("unexpected publication command: " + command + " " + args.join(" "));
        } };
      await tickPipelines([], ports);
      console.log(JSON.stringify({ reads, scheduled }));
    `;
    const result = await realExec(process.execPath, ["-e", script], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim()) as { reads: number; scheduled: number[] };
  };

  for (const [index, delay] of [60_000, 5 * 60_000, 15 * 60_000].entries()) {
    const before = loadPipelines()[0]!;
    const history = structuredClone(before.publicationRecovery![box.passedSha]!);
    expect(history.failures).toBe(index + 1);
    expect(history.totalAttempts).toBe(index + 1);
    expect(history.history).toHaveLength(index + 1);
    clock += delay - 1;
    const early = await restart();
    expect(early.reads).toBe(0);
    expect(loadPipelines()[0]!.publicationRecovery![box.passedSha]).toEqual(history);
    expect(loadPipelines()[0]!.delivery!.operation!.id).toBe(before.delivery!.operation!.id);
    clock++;
    const due = await restart();
    expect(due.reads).toBe(1);
    const retried = loadPipelines()[0]!;
    expect(retried.delivery!.operation!.id).not.toBe(before.delivery!.operation!.id);
    expect(retried.publicationRecovery![box.passedSha]!.failures).toBe(index + 2);
    if (index < 2) expect(due.scheduled).toContain([5 * 60_000, 15 * 60_000][index]!);
  }

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", lastPassedCommit: box.passedSha, publishedCommit: null,
    cursor: { stageId: "build", state: "committing" } });
  expect(parked.stateDetail!.split("\n")[0]).toContain("checking the remote pipeline branch failed; retried 3 times");
  expect(parked.stateDetail).toContain("use publish to try again");
  expect(parked.stateDetail).toContain("fatal: remote authentication unavailable");
  expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "passed", verdict: { status: "pass" },
    publicationRetry: { failures: 3, exhausted: true } });
  expect(parked.publicationRecovery![box.passedSha]).toMatchObject({ failures: 4, totalAttempts: 4 });
  clock += 60 * 60_000;
  expect((await restart(false)).reads).toBe(0);
  expect(loadPipelines()[0]!.publicationRecovery).toEqual(parked.publicationRecovery);
  expect(loadPipelines()[0]!.stateDetail).toBe(parked.stateDetail);

  box.setRemoteReadFails(false);
  expect((await patchPipeline(current.id, { action: "publish" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  const recovered = loadPipelines()[0]!;
  expect(recovered).toMatchObject({ state: "running", publishedCommit: box.passedSha, cursor: { stageId: "review", state: "pending" } });
  expect(recovered.runs[0]!.attempts).toHaveLength(1);
  expect(recovered.runs[0]!.attempts[0]).toMatchObject({ state: "passed", verdict: attempt.verdict, output: attempt.output, error: null });
  expect(recovered.publicationRecovery).toEqual(parked.publicationRecovery);
  expect(h.spawnInputs).toHaveLength(1);
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`]);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(2);
  expect(loadPipelines()[0]!.runs.find(run => run.stageId === "review")!.attempts).toHaveLength(1);
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`]);
});

test.each(["publish", "retry-stage"] as const)("manual %s retains an uncounted settled remote-read failure (#3375)", async action => {
  const h = harness();
  const box = publishHarness(h, { remoteReadFails: true });
  const clock = Date.parse(h.ports.now());
  h.ports.now = () => new Date(clock).toISOString();
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", "done")], h.ports);
  const settled = loadPipelines()[0]!;
  const operationId = settled.delivery!.operation!.id;
  // Recreate a stop after the publisher settles, before the scheduler accounts
  // for that result. Explicit recovery must record it before replacing it.
  delete settled.publicationRecovery;
  delete settled.runs[0]!.attempts[0]!.publicationRetry;
  settled.state = "needs_decision";
  settled.stateDetail = "publishing the passed stage: checking the remote pipeline branch failed";
  savePipelines([settled]);
  const recovered = await patchPipeline(settled.id, { action }, h.ports);
  if (action === "publish") expect(recovered.error).toContain("remote authentication unavailable");
  else expect(recovered.error).toBeUndefined();
  const replaced = loadPipelines()[0]!;
  expect(replaced.publicationRecovery![box.passedSha]).toMatchObject({ failures: 1, totalAttempts: 1,
    history: [{ operationId, retryAt: new Date(clock + 60_000).toISOString() }] });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(box.remoteReadAttempts()).toBe(2);
  expect(loadPipelines()[0]!.delivery!.operation!.id).not.toBe(operationId);
  expect(loadPipelines()[0]!.publicationRecovery![box.passedSha]).toMatchObject({ failures: 2, totalAttempts: 2,
    history: [{ operationId }, { retryAt: new Date(clock + 5 * 60_000).toISOString() }] });
});

test("a final passing stage stays open until its accepted head is published (#999)", async () => {
  const h = harness();
  const box = publishHarness(h, { remoteReadFails: true });
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: null },
  ] as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  const waiting = loadPipelines()[0]!;
  expect(waiting).toMatchObject({
    state: "running",
    closedAt: null,
    lastPassedCommit: box.passedSha,
    publishedCommit: null,
    stateDetail: expect.stringContaining("passed but unpublished"),
  });
  expect(waiting.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass" },
    error: expect.stringContaining("passed but unpublished"),
  });
  expect(box.remoteReadAttempts()).toBe(1);

  box.setRemoteReadFails(false);
  h.advanceWallClock(60_000);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const completed = loadPipelines()[0]!;
  expect(completed).toMatchObject({
    state: "completed",
    cursor: null,
    lastPassedCommit: box.passedSha,
    publishedCommit: box.passedSha,
    stateDetail: null,
  });
  expect(completed.closedAt).not.toBeNull();
  expect(completed.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass" },
    error: null,
  });
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`]);
  expect(box.remoteReadAttempts()).toBe(3);
});

test("a publication that cannot land parks the pass without losing the commit", async () => {
  const h = harness();
  const box = publishHarness(h, { pushFails: true });
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  // Keep the remote diagnostic and accepted pass without attributing the
  // refusal to a local check or spending the producer's repair allowance.
  expect(parked.stateDetail!.split("\n")[0]).toContain("git push was refused (exit 1): ! [remote rejected] (shallow update not allowed)");
  expect(parked.stateDetail).toContain("\npublishing the pipeline branch: exit 1");
  expect(parked.publicationRecovery?.[box.passedSha]).toMatchObject({ failures: 0, totalAttempts: 1,
    history: [{ cause: "remote-refusal", retryAt: null }] });
  const attempt = parked.runs[0]!.attempts[0]!;
  expect(attempt.verdict?.status).toBe("pass");
  expect(attempt.publicationRepair).toBeUndefined();
  expect(attempt.publicationRetry).toBeUndefined();
  expect(parked.lastPassedCommit).toBe(box.passedSha);
  expect(parked.publishedCommit ?? null).toBeNull();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.publicationRecovery).toEqual(parked.publicationRecovery);
  expect(box.order).toEqual(["commit", "push-rejected"]);
  expect(h.flows.size).toBe(0);
});

test("a read-write privacy gate checks the accepted committed head and leaves a rejected head unpublished (#2424)", async () => {
  const h = harness();
  const box = publishHarness(h, { privacyRejects: true });
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  const rejected = loadPipelines()[0]!;
  expect(box.order).toEqual(["commit", `privacy:${box.passedSha}:${box.passedSha}`]);
  expect(rejected).toMatchObject({
    state: "needs_decision",
    lastPassedCommit: box.passedSha,
    publishedCommit: null,
    stateDetail: expect.stringContaining("privacy"),
  });
  expect(rejected.runs[0]!.attempts[0]).toMatchObject({ verdict: { status: "pass" } });
  expect(box.remote()).toBeNull();
  expect(h.flows.size).toBe(0);
});

test("retry-stage republishes a committing passed stage without rerunning its work", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  box.setPushFails(true);
  await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", "accepted output")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.cursor).toMatchObject({ stageId: "build", state: "committing" });
  expect(parked.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
  const before = structuredClone(parked.runs[0]!.attempts[0]!);
  box.setPushFails(false);
  expect((await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  const resumed = loadPipelines()[0]!;
  expect(resumed.cursor).toMatchObject({ stageId: "review", state: "pending" });
  expect(resumed.publishedCommit).toBe(box.passedSha);
  expect(resumed.runs[0]!.attempts).toHaveLength(1);
  expect(resumed.runs[0]!.attempts[0]).toMatchObject({ state: "passed", verdict: before.verdict, output: before.output,
    agentPath: before.agentPath, input: before.input, activatedBy: before.activatedBy, error: null });
  expect(h.spawnInputs).toHaveLength(1);
  expect(box.order).toEqual(["commit", "push-rejected", `push:${box.passedSha}`]);
  expect(h.killedPanes).toHaveLength(0);
});

test.each(["retry-stage", "publish"] as const)("publication recovery keeps the accepted pass through a temporary worktree-head mismatch (%s)", async (action) => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  box.setPushFails(true);
  await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", "done")], h.ports);
  const moved = "8".repeat(40);
  box.setLocalHead(moved);
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("needs_decision");
  expect(waiting.stateDetail).toContain(`the worktree moved to ${moved.slice(0, 8)}`);
  expect(waiting.lastPassedCommit).toBe(box.passedSha);
  box.setLocalHead(box.passedSha);
  box.setPushFails(false);
  expect((await patchPipeline(pipeline.id, { action }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  const resumed = loadPipelines()[0]!;
  expect(resumed.cursor).toMatchObject({ stageId: "review", state: "pending" });
  expect(resumed.publishedCommit).toBe(box.passedSha);
  expect(resumed.runs[0]!.attempts).toHaveLength(1);
  expect(h.spawnInputs).toHaveLength(1);
  expect(box.order).toEqual(["commit", "push-rejected", `push:${box.passedSha}`]);
});

test("a successful publish resumes a pass parked on a rejected publication", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  box.setPushFails(true);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  box.setPushFails(false);
  expect((await patchPipeline(pipeline.id, { action: "publish" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", publishedCommit: box.passedSha,
    cursor: { stageId: "review", state: "pending" } });
  expect(h.spawnInputs).toHaveLength(1);
  expect(box.order).toEqual(["commit", "push-rejected", `push:${box.passedSha}`]);
});

test.each([
  ["retry-stage", "moved"],
  ["publish", "moved"],
  ["retry-stage", "unverifiable"],
  ["publish", "unverifiable"],
] as const)("legacy HEAD-verification parks resume the accepted attempt (%s, %s)", async (action, cause) => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  box.setPushFails(true);
  await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", "accepted output")], h.ports);

  const exec = h.ports.exec;
  if (cause === "moved") box.setLocalHead("8".repeat(40));
  else h.ports.exec = async (command, args, cwd) => args[0] === "rev-parse" && args[1] === "HEAD"
    ? { code: 128, stdout: "", stderr: "HEAD temporarily unavailable" }
    : (await exec(command, args, cwd));
  expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  const legacy = loadPipelines()[0]!;
  expect(legacy.stateDetail).toStartWith(cause === "moved"
    ? "the worktree moved to " : "the accepted head cannot be verified before completion:");
  // The pinned base passed the accepted attempt to park(), overwriting its state.
  legacy.runs[0]!.attempts[0]!.state = "needs_decision";
  savePipelines([legacy]);
  const before = structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!);

  h.ports.exec = exec;
  box.setLocalHead(box.passedSha);
  box.setPushFails(false);
  expect((await patchPipeline(pipeline.id, { action, expectedStageId: "build", expectedAttempt: 1 }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  const resumed = loadPipelines()[0]!;
  expect(resumed).toMatchObject({ state: "running", lastPassedCommit: box.passedSha,
    publishedCommit: box.passedSha, cursor: { stageId: "review", state: "pending" } });
  expect(resumed.runs[0]!.attempts).toHaveLength(1);
  expect(resumed.runs[0]!.attempts[0]).toEqual({ ...before, state: "passed", error: null });
  expect(h.spawnInputs).toHaveLength(1);
  expect(h.killedPanes).toHaveLength(0);
  expect(box.order).toEqual(["commit", "push-rejected", `push:${box.passedSha}`]);
});
