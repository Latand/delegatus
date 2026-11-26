import { expect, test, fs, path, tickPipelines, createPipelineFromRequest, loadPipelines, savePipelines, pipelineRevision, patchPipeline, closeAndDrain, RUN_STAGES, ORIGIN_MAIN_SHA, entry, harness, create, realWorktreeLane, PROVIDER_LIMIT_NOTICE, LIMITED_ACCOUNT, SPARE_ACCOUNT, limitInterruptedTranscript, codexUsageLimitTranscript, verdictTranscript, silentTranscript, readFixtures, usageLimitPorts, usageLimitStage, CYCLE_STAGES, BUDGET_STAGES, movingHeadHarness, critiqueRound, buildRound, driveWithController, BUILD_ONLY } from "./engine.fixture";
import { AccountMutationBusyError } from "@/lib/accounts/accountMutation";

test("a failover whose remaining capacity disappears waits with the limit detail (#1371)", async () => {
  const h = harness();
  const resetsAt = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const pipeline = await create(h.ports, usageLimitStage() as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  readFixtures(h, { "/codex/stage-1.jsonl": codexUsageLimitTranscript("failover-capacity-race", resetsAt) });
  usageLimitPorts(h, {
    kind: "available",
    account: {
      engine: "codex",
      accountId: SPARE_ACCOUNT,
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  });
  await tickPipelines([], h.ports);
  usageLimitPorts(h, {
    kind: "exhausted",
    resetsAt,
    allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT],
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines().find((candidate) => candidate.id === pipeline.id)!;
  expect(h.spawnInputs).toHaveLength(1);
  expect(parked).toMatchObject({
    state: "running",
    stateDetail: expect.stringContaining("waiting for codex usage limit"),
  });
});

test("successive usage limits wait on the current source reset across failed-over accounts (#1371)", async () => {
  const h = harness();
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_stage_2", { outcome: "stopped" });
  const firstReset = Math.floor(Date.parse("2026-09-02T10:05:00.000Z") / 1_000);
  const secondReset = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const pipeline = await create(h.ports, usageLimitStage() as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  readFixtures(h, { "/codex/stage-1.jsonl": codexUsageLimitTranscript("first-account-usage-limit", firstReset) });
  usageLimitPorts(h, {
    kind: "available",
    account: {
      engine: "codex",
      accountId: SPARE_ACCOUNT,
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  readFixtures(h, { "/codex/stage-2.jsonl": codexUsageLimitTranscript("second-account-usage-limit", secondReset) });
  usageLimitPorts(h, {
    kind: "unavailable",
    allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT],
  });
  await tickPipelines([], h.ports);

  const parked = loadPipelines().find((candidate) => candidate.id === pipeline.id)!;
  expect(parked).toMatchObject({
    state: "running",
    stateDetail: expect.stringContaining(new Date(secondReset * 1_000).toISOString()),
  });
  expect(parked.runs[0]!.attempts[1]?.usageLimitedAccounts).toMatchObject([
    { accountId: LIMITED_ACCOUNT, engine: "codex", resetsAt: firstReset },
    { accountId: SPARE_ACCOUNT, engine: "codex", resetsAt: secondReset },
  ]);
});

test("a pinned usage-limited stage waits on its account and names the reset (#1371)", async () => {
  const h = harness();
  const resetsAt = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const pipeline = await create(h.ports, usageLimitStage(LIMITED_ACCOUNT) as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  readFixtures(h, { "/codex/stage-1.jsonl": codexUsageLimitTranscript("pinned-usage-limit", resetsAt) });
  let selectionCalls = 0;
  usageLimitPorts(h, {
    kind: "available",
    account: {
      engine: "codex",
      accountId: SPARE_ACCOUNT,
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  });
  Object.assign(h.ports, { resolveProjectSpawn: () => { selectionCalls += 1; throw new Error("pinned failover must not select"); } });

  await tickPipelines([], h.ports);

  const parked = loadPipelines().find((candidate) => candidate.id === pipeline.id)!;
  const detail = expect.stringContaining(new Date(resetsAt * 1_000).toISOString());
  expect(parked).toMatchObject({ state: "running", stateDetail: detail });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "running", error: null });
  expect(selectionCalls).toBe(0);
});

test("retry-stage settles a passed read-only stage after output discovery fails without relaunching it", async () => {
  const fixture = await realWorktreeLane("read-only settlement listing retry", [
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, access: "read-only", outputs: ["report.md"], prompt: "Audit", next: null },
  ]);
  const { h, id: pipelineId, worktree } = fixture;
  const pipeline = loadPipelines().find((item) => item.id === pipelineId)!;
  fs.writeFileSync(path.join(worktree, "report.md"), "Audited report\n");
  let failListing = true;
  const baseExec = h.ports.exec;
  h.ports.exec = async (command, args, cwd, env, options) => {
    if (command === "git" && args[0] === "ls-files" && args.includes("--others")) {
      if (failListing) {
        failListing = false;
        return { code: 1, stdout: "", stderr: "injected output listing failure" };
      }
    }
    return await baseExec(command, args, cwd, env, options);
  };

  try {
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "Audited report")], h.ports);
    const parked = loadPipelines().find((item) => item.id === pipeline.id)!;
    expect(parked).toMatchObject({ state: "needs_decision", cursor: { stageId: "audit", state: "committing" } });
    expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "needs_decision", verdict: { status: "pass" }, error: expect.stringContaining("staging the passed stage:") });
    expect(parked.stateDetail).toContain("retry-stage to commit the existing outputs without rerunning the agent");
    expect(h.spawnInputs).toHaveLength(1);

    expect((await patchPipeline(pipelineId, { action: "retry-stage", expectedStageId: "audit", expectedAttempt: 1 }, h.ports)).error).toBeUndefined();
    await tickPipelines([], h.ports);

    const settled = loadPipelines().find((item) => item.id === pipeline.id)!;
    expect(settled.runs[0]!.attempts).toHaveLength(1);
    expect(settled.runs[0]!.attempts[0]).toMatchObject({ state: "passed", verdict: { status: "pass" }, error: null });
    expect(h.spawnInputs).toHaveLength(1);
    expect((await fixture.git(worktree, "show", "--pretty=format:", "--name-only", "HEAD"))).toContain("report.md");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("close retires an attempt whose turn a provider limit cut off, naming the notice (#1141)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured runtime host is unavailable" });
  readFixtures(h, { "/codex/stage-1.jsonl": limitInterruptedTranscript("close-limit-interrupted") });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stillRunning).toEqual([]);
  expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  const stored = loadPipelines()[0]!;
  expect(stored.state).toBe("closed");
  /* Retired as failed, with the provider's own words as the reason — on the
     attempt and on the lane, so nothing reads as a stage that produced one. */
  const attempt = stored.runs[0]!.attempts[0]!;
  expect(attempt.state).toBe("failed");
  expect(attempt.completedAt).toBeTruthy();
  expect(attempt.error).toContain("terminal provider message");
  expect(attempt.error).toContain(PROVIDER_LIMIT_NOTICE);
  expect(stored.stateDetail).toContain(PROVIDER_LIMIT_NOTICE);
});

test("a transcript that ends on a valid fenced verdict still closes on the verdict path (#1141)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured runtime host is unavailable" });
  readFixtures(h, { "/codex/stage-1.jsonl": verdictTranscript("close-verdict") });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  const detail = closed.close?.notes[0]?.detail ?? "";
  expect(detail).toContain("valid fenced verdict");
  /* A lane closed on a real verdict stays distinguishable from one closed on a
     provider notice — the two reasons never collapse into one. */
  expect(detail).not.toContain("terminal provider message");
  expect(loadPipelines()[0]!.state).toBe("closed");
});

test("a transcript silent under a live host is not terminalized by the provider-message rule (#1141)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured runtime host is unavailable" });
  readFixtures(h, { "/codex/stage-1.jsonl": silentTranscript("close-silent") });

  const refused = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  /* Silence is not evidence that the turn ended: the stall path keeps it. */
  expect(refused.error).toBeUndefined();
  expect(refused.close?.stillRunning).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  const stored = loadPipelines()[0]!;
  expect(stored.state).toBe("closed");
  expect(stored.hiddenAt).toBeNull();
  expect(stored.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a pipeline blocked only by a limit-interrupted attempt closes end to end (#1141)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* The board shape from the issue: earlier attempts of the same stage ended on
     verdicts and terminalize from their transcripts; the parked one was cut off
     by the limit and is the whole reason the close was refused. */
  const stored = loadPipelines()[0]!;
  const run = stored.runs[0]!;
  const parked = run.attempts[0]!;
  const settled = structuredClone(parked);
  settled.n = 1;
  settled.state = "failed";
  settled.conversationId = "conversation_stage_2";
  settled.agentPath = "/codex/stage-2.jsonl";
  settled.paneId = "%2";
  parked.n = 2;
  parked.accounting!.repeatReason = "unknown";
  parked.state = "needs_decision";
  parked.error = "stage verdict recovery exhausted after 3 checks";
  run.attempts = [settled, parked];
  stored.state = "needs_decision";
  stored.stateDetail = parked.error;
  savePipelines([stored]);
  h.setHostsResident(true);
  for (const conversationId of ["conversation_stage_1", "conversation_stage_2"]) {
    h.setStageHost(conversationId, { outcome: "failed", error: "structured runtime host is unavailable" });
  }
  readFixtures(h, {
    "/codex/stage-1.jsonl": limitInterruptedTranscript("close-blocker-limit"),
    "/codex/stage-2.jsonl": verdictTranscript("close-blocker-verdict", "needs_decision"),
  });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stillRunning).toEqual([]);
  expect(closed.close?.alreadyStopped).toHaveLength(2);
  const terminal = loadPipelines()[0]!;
  expect(terminal.state).toBe("closed");
  expect(terminal.closedAt).toBeTruthy();
  /* Nothing unconfirmed is left, so the lane leaves the board. */
  expect(terminal.hiddenAt).toBe(terminal.closedAt);
  expect(terminal.runs[0]!.attempts.map((item) => item.completedAt).every(Boolean)).toBeTrue();
  /* The parking attempt keeps the reason it parked with; the close reason it
     was retired on rides the lane's own detail. */
  expect(terminal.runs[0]!.attempts[1]!.error).toBe("stage verdict recovery exhausted after 3 checks");
  expect(terminal.stateDetail).toContain(PROVIDER_LIMIT_NOTICE);
});

test("closing preserves uncommitted stage work and names what it left behind (#670)", async () => {
  const h = harness();
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") {
      return { code: 0, stdout: " M src/lib/app.ts\n?? notes.md\n", stderr: "" };
    }
    return baseExec(command, args, cwd);
  };
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });

  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.close?.worktree).toEqual({
    dir: loadPipelines()[0]!.worktreeDir,
    uncommitted: ["src/lib/app.ts", "notes.md"],
    truncated: false,
  });
  /* The whole point of the report: the work stays on disk. */
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBeFalse();
  expect(h.calls.some((call) => call.startsWith("git clean"))).toBeFalse();
  expect(h.calls.some((call) => call.startsWith("git checkout"))).toBeFalse();
  expect(loadPipelines()[0]!.stateDetail).toBe("closed; stopped 1 stage host; kept 2 uncommitted paths in the worktree");
});

test("creation caps task, spec, and stage prompt sizes", async () => {
  const { ports } = harness();
  expect((await createPipelineFromRequest({ task: "x".repeat(4_001), repoDir: "/repo", stages: [] }, ports)).error).toContain("task exceeds");
  expect((await createPipelineFromRequest({ task: "x", spec: "y".repeat(16_001), repoDir: "/repo", stages: [] }, ports)).error).toContain("spec exceeds");
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", prompt: "p".repeat(8_001), next: "b" },
    { id: "b", kind: "run", prompt: "b", next: null },
  ] }, ports)).error).toContain("prompt exceeds");
});

test("override-stage re-configures an unstarted stage and holds one whose live attempt predates definition binding (issue #118)", async () => {
  const { ports } = harness();
  const created = await create(ports);
  /* The trailing "build" stage has not run yet, so its config is still editable. */
  const res = await patchPipeline(
    created.id,
    { action: "override-stage", stageId: "build", engine: "claude", model: "opus", effort: "high", prompt: "New build prompt" },
    ports,
  );
  expect(res.error).toBeUndefined();
  const build = loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;
  expect(build.effectiveRole).toMatchObject({ engine: "claude", model: "opus", effort: "high" });
  expect(build.prompt).toBe("New build prompt");

  /* A blank model resolves to the engine default (null), not the literal "". */
  const cleared = await patchPipeline(created.id, { action: "override-stage", stageId: "build", model: "  " }, ports);
  expect(cleared.error).toBeUndefined();
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!.effectiveRole.model).toBeNull();

  /* A running attempt recorded without a bound definition would read the live
     stage on a re-issued launch, so its stage refuses the override until it settles. */
  const started = loadPipelines()[0]!;
  const buildStage = started.stages.find((stage) => stage.id === "build")!;
  started.runs.find((run) => run.stageId === "build")!.attempts.push({
    n: 1, state: "running", effectiveRole: structuredClone(buildStage.effectiveRole), launchId: null,
    conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
  });
  savePipelines([started]);
  expect((await patchPipeline(started.id, { action: "override-stage", stageId: "build", prompt: "x" }, ports)).status).toBe(409);
});

test("a stage spawn uses the model and effort saved by override-stage", async () => {
  const h = harness();
  const created = await create(h.ports);
  const updated = await patchPipeline(created.id, {
    action: "override-stage",
    stageId: "build",
    model: "gpt-5.6-terra",
    effort: "xhigh",
  }, h.ports);
  expect(updated.error).toBeUndefined();

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], h.ports);
  await tickPipelines([], h.ports);

  expect(h.spawnRoles.at(-1)).toMatchObject({
    roleId: "builder",
    engine: "codex",
    model: "gpt-5.6-terra",
    effort: "xhigh",
  });
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "build")?.attempts[0]?.effectiveRole).toMatchObject({
    model: "gpt-5.6-terra",
    effort: "xhigh",
  });
});

test("override-stage edits every stage while a pipeline is a draft", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Tune the plan",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  for (const stage of created.pipeline!.stages) {
    const updated = await patchPipeline(created.pipeline!.id, {
      action: "override-stage",
      stageId: stage.id,
      "prompt": `Edited ${stage.id}`,
    }, ports);
    expect(updated.error).toBeUndefined();
  }

  expect(loadPipelines()[0]!.stages.map((stage) => stage.prompt)).toEqual(["Edited plan", "Edited build"]);
});

test("draft metadata can be revised before the pipeline starts", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Initial task",
    spec: "Initial AC",
    repoDir: "/repo",
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  const updated = await patchPipeline(created.pipeline!.id, {
    action: "update-draft",
    task: "Revised task",
    spec: "Revised AC",
    repoDir: "/other-repo",
  }, ports);

  expect(updated.pipeline).toMatchObject({
    task: "Revised task",
    spec: "Revised AC",
    repoDir: "/other-repo",
    project: "viewer",
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
  });
  expect(updated.pipeline?.worktreeDir).toContain("other-repo-pipeline-");
  expect(updated.pipeline?.branch).toContain("revised-task");
});

test("add-stage preserves the supplied graph and every existing edge (#2247)", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Preserve graph", repoDir: "/repo", autoStart: false,
    stages: [
      { ...RUN_STAGES[1], id: "build", next: "review" },
      { ...RUN_STAGES[1], id: "review", next: null, onFail: { to: "fix", maxRounds: 2 } },
      { ...RUN_STAGES[1], id: "fix", next: "review" },
    ] as never,
  }, h.ports);
  const original = structuredClone(created.pipeline!.stages);
  const added = await patchPipeline(created.pipeline!.id, {
    action: "add-stage", index: 1,
    stage: { ...RUN_STAGES[1], id: "ui-check", next: null, onFail: { to: "fix", maxRounds: 2 } } as never,
  }, h.ports);
  expect(added.error).toBeUndefined();
  expect(added.pipeline!.stages.filter((stage) => stage.id !== "ui-check")).toEqual(original);
  expect(added.pipeline!.stages.find((stage) => stage.id === "ui-check")).toMatchObject({ next: null, onFail: { to: "fix", maxRounds: 2 } });
  const loop = await patchPipeline(created.pipeline!.id, {
    action: "add-stage", stage: { ...RUN_STAGES[1], id: "polish-fix", next: "ui-check" } as never,
  }, h.ports);
  expect(loop.error).toBeUndefined();
  expect(loop.pipeline!.stages.find((stage) => stage.id === "polish-fix")!.next).toBe("ui-check");
  expect(loop.pipeline!.stages.find((stage) => stage.id === "fix")!.next).toBe("review");
});

test.each([
  { next: "missing" },
  { next: "extra" },
  { next: null, onFail: { to: "missing", maxRounds: 1 } },
])("add-stage refuses invalid edges without clearing them in draft or started graphs (#2247): %j", async (edges) => {
  for (const started of [false, true]) {
    const h = harness();
    savePipelines([]);
    const created = await createPipelineFromRequest({ task: "Invalid insertion", repoDir: "/repo", autoStart: false, stages: RUN_STAGES as never }, h.ports);
    if (started) await patchPipeline(created.pipeline!.id, { action: "start" }, h.ports);
    const before = loadPipelines()[0]!;
    const added = await patchPipeline(before.id, { action: "add-stage", stage: { ...RUN_STAGES[1], id: "extra", ...edges } } as never, h.ports);
    expect(added.status).toBe(400);
    expect(loadPipelines()[0]).toEqual(before);
  }
});

test("add-stage refuses replacing the draft entry by display insertion (#2247)", async () => {
  const h = movingHeadHarness();
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Display order", repoDir: "/repo", autoStart: false, publication: "internal", stages: BUILD_ONLY as never }, h.ports);
  const added = await patchPipeline(created.pipeline!.id, { action: "add-stage", index: 0, stage: { ...BUILD_ONLY[0], id: "disconnected", next: null } } as never, h.ports);
  expect(added.status).toBe(409);
  expect(added.error).toContain("draft entry build");
  expect(loadPipelines()[0]).toEqual(created.pipeline!);
  const appended = await patchPipeline(created.pipeline!.id, { action: "add-stage", stage: { ...BUILD_ONLY[0], id: "disconnected", next: null } } as never, h.ports);
  expect(appended.error).toBeUndefined();
  expect(appended.pipeline!.cursor?.stageId).toBe("build");
  await patchPipeline(created.pipeline!.id, { action: "start" }, h.ports);
  const { pipeline } = await driveWithController(h, new Set());
  expect(pipeline.state).toBe("completed");
  expect(pipeline.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(1);
  expect(pipeline.runs.find((run) => run.stageId === "disconnected")!.attempts).toHaveLength(0);
});

test("add-stage after selects a pass edge independently of displayed neighbours (#2247)", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Explicit insertion", repoDir: "/repo", autoStart: false,
    stages: [
      { ...RUN_STAGES[1], id: "build", next: "review" },
      { ...RUN_STAGES[1], id: "review", next: "ship", onFail: { to: "fix", maxRounds: 2 } },
      { ...RUN_STAGES[1], id: "fix", next: "review" },
      { ...RUN_STAGES[1], id: "ship", next: null },
    ] as never,
  }, h.ports);
  const added = await patchPipeline(created.pipeline!.id, {
    action: "add-stage", after: "review",
    stage: { ...RUN_STAGES[1], id: "ui-check", next: null, onFail: { to: "fix", maxRounds: 1 } } as never,
  } as Parameters<typeof patchPipeline>[1], h.ports);
  expect(added.error).toBeUndefined();
  expect(added.pipeline!.stages.map(({ id, next }) => [id, next])).toEqual([
    ["build", "review"], ["review", "ui-check"], ["fix", "review"], ["ship", null], ["ui-check", "ship"],
  ]);
  expect(added.pipeline!.stages.find((stage) => stage.id === "ui-check")!.onFail).toEqual({ to: "fix", maxRounds: 1 });
  expect(added.pipeline!.graphEdits).toHaveLength(1);
  const before = loadPipelines()[0]!;
  const unknown = await patchPipeline(before.id, { action: "add-stage", after: "absent", stage: { ...RUN_STAGES[1], id: "extra", next: null } } as Parameters<typeof patchPipeline>[1], h.ports);
  expect(unknown.status).toBe(400);
  expect(loadPipelines()[0]).toEqual(before);
  await patchPipeline(before.id, { action: "start" }, h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const build = loadPipelines()[0]!.runs.find((run) => run.stageId === "build")!.attempts.at(-1)!;
  await tickPipelines([h.finish(build.agentPath!, "pass", "built")], h.ports);
  const appended = await patchPipeline(before.id, { action: "add-stage", stage: { ...RUN_STAGES[1], id: "extra", next: null } } as never, h.ports);
  expect(appended.error).toBeUndefined();
  const frozen = loadPipelines()[0]!;
  const refused = await patchPipeline(before.id, { action: "add-stage", after: "build", stage: { ...RUN_STAGES[1], id: "insert", next: null } } as never, h.ports);
  expect(refused.status).toBe(409);
  expect(refused.error).toContain("frozen evidence");
  expect(loadPipelines()[0]).toEqual(frozen);

});

test("draft stages can be added, reordered, and removed while keeping a linear plan", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Edit the plan",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;
  h.setBuilderEffort("high");

  const added = await patchPipeline(id, {
    action: "add-stage",
    index: 1, after: "plan",
    stage: { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify the plan", next: null },
  }, ports);
  expect(added.pipeline?.stages.map((stage) => [stage.id, stage.next])).toEqual([
    ["plan", "verify"], ["verify", "build"], ["build", null],
  ]);
  expect(added.pipeline?.stages.map((stage) => stage.effectiveRole.effort)).toEqual(["high", "high", "medium"]);

  const reordered = await patchPipeline(id, {
    action: "reorder-stage",
    stageIds: ["plan", "build", "verify"],
  }, ports);
  expect(reordered.pipeline?.stages.map((stage) => stage.id)).toEqual(["plan", "build", "verify"]);

  const removed = await patchPipeline(id, { action: "remove-stage", stageId: "verify" }, ports);
  expect(removed.pipeline?.stages.map((stage) => [stage.id, stage.next])).toEqual([
    ["plan", "build"], ["build", null],
  ]);
  expect(removed.pipeline?.runs.map((run) => run.stageId)).toEqual(["plan", "build"]);
});

test("an empty draft is created, assembled from zero, and starts with one stage (#136, #353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  /* The legacy stageless draft POST still loads; the current client seeds a
     default implement stage (#353), but the API keeps accepting zero. */
  const created = await createPipelineFromRequest({ task: "Build on canvas", repoDir: "/repo", stages: [], autoStart: false }, ports);
  expect(created.pipeline?.state).toBe("draft");
  expect(created.pipeline?.stages).toEqual([]);
  expect(created.pipeline?.cursor).toBeNull();
  const id = created.pipeline!.id;

  /* Start is refused while the draft is empty, without side effects. */
  const tooFew = await patchPipeline(id, { action: "start" }, ports);
  expect(tooFew.status).toBe(409);
  expect(loadPipelines()[0]!.state).toBe("draft");

  /* One implement conversation is the minimum graph (#353): Start succeeds. */
  const one = await patchPipeline(id, { action: "add-stage", stage: { id: "plan", kind: "run", role: { roleId: "builder" }, prompt: "Plan it", next: null } }, ports);
  expect(one.pipeline?.stages.map((stage) => stage.id)).toEqual(["plan"]);
  expect(one.pipeline?.cursor).toEqual({ stageId: "plan", state: "pending", input: null, activatedBy: null });
  const started = await patchPipeline(id, { action: "start" }, ports);
  expect(started.pipeline?.state).toBe("provisioning");
});

test("a draft keeps at least one stage on the canvas (#136, #353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Empty me", repoDir: "/repo", stages: RUN_STAGES as never, autoStart: false }, ports);
  const id = created.pipeline!.id;
  await patchPipeline(id, { action: "remove-stage", stageId: "build" }, ports);
  /* The final stage is not removable (#353: every pipeline keeps at least one
     default action) — reconfigure it instead. */
  const lastRemove = await patchPipeline(id, { action: "remove-stage", stageId: "plan" }, ports);
  expect(lastRemove.status).toBe(409);
  expect(loadPipelines()[0]!.stages.map((stage) => stage.id)).toEqual(["plan"]);
});

test("discarding a draft terminates its persisted record (#1274)", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Disposable draft",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  const discarded = await patchPipeline(created.pipeline!.id, { action: "delete" }, ports);
  expect(discarded.pipeline?.id).toBe(created.pipeline!.id);
  expect(loadPipelines()).toHaveLength(1);
  const record = loadPipelines()[0]!;
  /* A hide alone left `state: "draft"` with `closedAt: null`, which every
     liveness reader answered "open" to — the hourly seat wake in #1274. */
  expect(record.state).toBe("closed");
  expect(record.closedAt).toBeTruthy();
  expect(record.hiddenAt).toBe(record.closedAt);
  expect(record.cursor).toBeNull();
  expect(record.runs.flatMap((run) => run.attempts)).toHaveLength(0);
});

test("closing a draft settles it the same way discarding does (#1274)", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Draft closed rather than discarded",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  const closed = await closeAndDrain(created.pipeline!.id, { action: "close" }, ports);
  expect(closed.pipeline?.id).toBe(created.pipeline!.id);
  const record = loadPipelines()[0]!;
  expect(record.state).toBe("closed");
  expect(record.closedAt).toBeTruthy();
  expect(record.hiddenAt).toBe(record.closedAt);
});

test("a draft that is real work still starts after the discard change (#1274)", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Draft nobody discarded",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  const started = await patchPipeline(created.pipeline!.id, { action: "start" }, ports);
  expect(started.status).toBeUndefined();
  const record = loadPipelines()[0]!;
  expect(record.state).not.toBe("draft");
  expect(record.closedAt).toBeNull();
  expect(record.hiddenAt ?? null).toBeNull();
});

test("draft-only mutations cannot rewrite or delete an active pipeline", async () => {
  const { ports } = harness();
  const active = await create(ports);
  const before = structuredClone(loadPipelines()[0]!);
  /* add-stage, reorder-stage, set-edge and override-stage edit a started graph
     (graph slice 1, graphEdits.test.ts); the cursor stage keeps its place. */
  const attempts = [
    { action: "start" },
    { action: "update-draft", task: "rewritten" },
    { action: "remove-stage", stageId: "plan" },
    { action: "reorder-stage", stageId: "plan", toIndex: 1 },
    { action: "delete" },
  ] as const;

  for (const request of attempts) {
    expect((await patchPipeline(active.id, request, ports)).status).toBe(409);
  }
  expect(loadPipelines()[0]).toEqual(before);
});

test("override-stage validates the target and requires a change", async () => {
  const { ports } = harness();
  const created = await create(ports);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "ghost", prompt: "x" }, ports)).status).toBe(404);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build" }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", engine: "gemini" as never }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", prompt: "  " }, ports)).status).toBe(400);
});

test("override-stage swaps the stage role through the registry and resets unpinned runtime (issue #118 review F3)", async () => {
  const { ports } = harness();
  const created = await create(ports);
  /* build was builder/codex; switch it to architect with no runtime pins → the
     new role's registry defaults (claude/fable/high + scaffold) apply. */
  const res = await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "architect" } }, ports);
  expect(res.error).toBeUndefined();
  const build = loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;
  expect(build.role).toEqual({ roleId: "architect" });
  expect(build.effectiveRole).toMatchObject({ roleId: "architect", engine: "claude", model: "fable", effort: "high", promptScaffold: "Architect guidance" });
  /* Input fields stay consistent with the effectiveRole so the record persists. */
  expect(build.engine).toBe("claude");
  expect(build.model).toBe("fable");

  /* An explicit runtime pin still wins over the role default. */
  const pinned = await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "reviewer" }, effort: "low" }, ports);
  expect(pinned.error).toBeUndefined();
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!.effectiveRole).toMatchObject({ roleId: "reviewer", effort: "low" });

  /* Clearing the role falls back to the Builder default. */
  const cleared = await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: null }, ports);
  expect(cleared.error).toBeUndefined();
  const roleless = loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;
  expect(roleless.role).toBeUndefined();
  expect(roleless.effectiveRole).toMatchObject({ roleId: null, engine: "codex" });
});

test("override-stage rejects an unknown/disallowed role and an incompatible role+model (issue #118 review F3)", async () => {
  const { ports } = harness();
  const created = await create(ports);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "wizard" as never } }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "deployer" } }, ports)).error).toContain("not allowed in a pipeline");
  /* architect resolves to claude; a codex-only model must fail canonical bounds. */
  const bad = await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "architect" }, model: "gpt-5.6-sol" }, ports);
  expect(bad.status).toBe(400);
  const unknown = await patchPipeline(created.id, { action: "override-stage", stageId: "build", engine: "codex", model: "gpt-5.6-codex" }, ports);
  expect(unknown).toMatchObject({
    status: 400,
    error: "invalid codex model id \"gpt-5.6-codex\"; valid codex model ids: gpt-6.2-sol, gpt-6.2-astra, gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-6.1-terra",
  });
});

test("override-stage rejects non-string model/effort instead of silently ignoring them (issue #118 review F3)", async () => {
  const { ports } = harness();
  const created = await create(ports);
  /* resolvePipelineRole would treat these as absent and 200 with the old config;
     the type guards must 400 instead, and never mutate the stage. */
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", model: 123 as never }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", effort: false as never }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", engine: 7 as never }, ports)).status).toBe(400);
  const build = loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;
  expect(build.prompt).toBe("Build from {{prev.output}}");
});

test("override-stage enforces the same prompt-size ceiling as creation (issue #118 review F5)", async () => {
  const { ports } = harness();
  const { MAX_STAGE_PROMPT_LENGTH } = await import("./limits");
  const created = await create(ports);
  /* Over the ceiling is rejected with a 400, not persisted as an oversized record. */
  const over = await patchPipeline(created.id, { action: "override-stage", stageId: "build", prompt: "x".repeat(MAX_STAGE_PROMPT_LENGTH + 1) }, ports);
  expect(over.status).toBe(400);
  expect(over.error).toContain(String(MAX_STAGE_PROMPT_LENGTH));
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!.prompt).toBe("Build from {{prev.output}}");
  /* Exactly at the ceiling is accepted. */
  const atLimit = await patchPipeline(created.id, { action: "override-stage", stageId: "build", prompt: "y".repeat(MAX_STAGE_PROMPT_LENGTH) }, ports);
  expect(atLimit.error).toBeUndefined();
});

test("set-edge rewires future edges and freezes traversed evidence (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Graph edit",
    repoDir: "/repo",
    stages: [
      { id: "plan", kind: "run", role: { roleId: "builder" }, prompt: "Plan", next: "build" },
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify", next: null },
    ] as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;

  /* Validation matrix. */
  expect((await patchPipeline(id, { action: "set-edge", stageId: "missing", edge: "pass", to: null }, ports)).status).toBe(404);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "up" as never, to: null }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass" }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "missing" }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "pass", to: "plan" }, ports)).error).toContain("cycle");
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "plan" }, ports)).error).toContain("itself");
  expect((await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: "build", maxRounds: 10 }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: null, maxRounds: 3 }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "build", maxRounds: 2 }, ports)).status).toBe(400);

  /* A direct pass link (skipping build) and a fail-edge cycle are accepted. */
  const direct = await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "verify" }, ports);
  expect(direct.pipeline?.stages[0]?.next).toBe("verify");
  const cycle = await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: "build", maxRounds: 2 }, ports);
  expect(cycle.pipeline?.stages[2]?.onFail).toEqual({ to: "build", maxRounds: 2 });
  /* Defaulted budget mirrors the review flow's round limit. */
  const defaulted = await patchPipeline(id, { action: "set-edge", stageId: "build", edge: "fail", to: "plan" }, ports);
  expect(defaulted.pipeline?.stages[1]?.onFail).toEqual({ to: "plan", maxRounds: 3 });
  /* Clearing works. */
  const cleared = await patchPipeline(id, { action: "set-edge", stageId: "build", edge: "fail", to: null }, ports);
  expect(cleared.pipeline?.stages[1]?.onFail).toBeNull();

  /* Restore the chain, start, run plan to completion: its pass edge freezes. */
  await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "build" }, ports);
  await patchPipeline(id, { action: "start" }, ports);
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], ports);
  const frozen = await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "verify" }, ports);
  expect(frozen.status).toBe(409);
  expect(frozen.error).toContain("frozen evidence");
  /* An untraversed fail edge on a started-but-not-run stage stays editable. */
  const stillEditable = await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: "build", maxRounds: 1 }, ports);
  expect(stillEditable.pipeline?.stages[2]?.onFail).toEqual({ to: "build", maxRounds: 1 });
});

test("review budgets can be set and lowered before the first review, then cannot grow after traversal", async () => {
  const h = movingHeadHarness();
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 2 }, null) as never);
  const id = loadPipelines()[0]!.id;
  const edit = (maxRounds: number) => patchPipeline(id, { action: "set-edge", stageId: "critique", edge: "fail", to: "build", maxRounds }, h.ports);
  expect((await edit(4)).pipeline?.stages[1]?.onFail?.maxRounds).toBe(4);
  expect((await edit(2)).pipeline?.stages[1]?.onFail?.maxRounds).toBe(2);
  await tickPipelines([], h.ports);
  await buildRound(h, "first build");
  await critiqueRound(h, "fail", "first findings");
  const revision = pipelineRevision(loadPipelines()[0]!);
  const refused = await edit(3);
  expect(refused.status).toBe(409);
  expect(refused.error).toContain("Review budget cannot increase");
  expect(pipelineRevision(loadPipelines()[0]!)).toBe(revision);
  expect(loadPipelines()[0]!.stages[1]!.onFail?.maxRounds).toBe(2);
});

test("a fail edge freezes the instant it routes, before the target attempt materializes, and the freeze survives restart (#353)", async () => {
  const h = harness();
  const { ports } = h;
  await create(ports, CYCLE_STAGES as never);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn build
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built v1")], ports); // build passes → verify
  await tickPipelines([], ports); // spawn verify
  /* verify fails → the cursor routes back to build along the fail edge. The
     follow-up tick that would materialize build's second attempt is a no-op in
     this suite, so we sit in the in-flight window on purpose. */
  h.messages.set("/codex/stage-2.jsonl", { text: "cannot pass\n\n```json\n{\"status\":\"fail\",\"findings\":[\"broken\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-2.jsonl")], ports);

  const inflight = loadPipelines()[0]!;
  expect(inflight.cursor).toMatchObject({ stageId: "build", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });
  /* The traversal lives on the durable cursor while build still holds one
     attempt, so the freeze reads the cursor activation to catch this window. */
  expect(inflight.runs[0]!.attempts).toHaveLength(1);

  const frozen = await patchPipeline(inflight.id, { action: "set-edge", stageId: "verify", edge: "fail", to: null }, ports);
  expect(frozen.status).toBe(409);
  expect(frozen.error).toContain("frozen evidence");

  /* patchPipeline re-reads the persisted registry from disk, so this second edit
     proves the freeze survives a process restart. */
  const afterRestart = await patchPipeline(inflight.id, { action: "set-edge", stageId: "verify", edge: "fail", to: "build", maxRounds: 4 }, ports);
  expect(afterRestart.status).toBe(409);
  expect(afterRestart.error).toContain("Review budget cannot increase");
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "verify")?.onFail).toEqual({ to: "build", maxRounds: 1 });
});

test("structural draft edits preserve intentional pass and fail edges (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Graph preservation",
    repoDir: "/repo",
    stages: [
      { id: "plan", kind: "run", role: { roleId: "builder" }, prompt: "Plan", next: "build" },
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify", next: null },
    ] as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;

  /* A custom jump (plan → verify, skipping build) and a fail loop (verify → plan). */
  await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "verify" }, ports);
  await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: "plan", maxRounds: 3 }, ports);

  const edgesOf = (stages: { id: string; next: string | null; onFail?: unknown }[]) =>
    new Map(stages.map((stage) => [stage.id, { next: stage.next, onFail: stage.onFail ?? null }]));
  const jumpAndLoopSurvive = (stages: { id: string; next: string | null; onFail?: unknown }[]) => {
    const edges = edgesOf(stages);
    expect(edges.get("plan")!.next).toBe("verify");
    expect(edges.get("verify")!.onFail).toEqual({ to: "plan", maxRounds: 3 });
  };

  /* add-stage: every existing edge survives; the new stage keeps its edges. */
  const added = await patchPipeline(id, {
    action: "add-stage",
    stage: { id: "audit", kind: "run", role: { roleId: "builder" }, prompt: "Audit", next: null },
  }, ports);
  jumpAndLoopSurvive(added.pipeline!.stages);
  expect(added.pipeline!.stages.some((stage) => stage.id === "audit")).toBe(true);

  /* reorder-stage: edges follow ids, so a reorder leaves them in place. */
  const reordered = await patchPipeline(id, { action: "reorder-stage", stageId: "build", toIndex: 3 }, ports);
  expect(reordered.pipeline!.stages.map((stage) => stage.id)).toEqual(["plan", "verify", "audit", "build"]);
  jumpAndLoopSurvive(reordered.pipeline!.stages);

  /* override-stage: editing a stage's prompt leaves its edges intact. */
  const overridden = await patchPipeline(id, { action: "override-stage", stageId: "build", prompt: "Rebuild" }, ports);
  jumpAndLoopSurvive(overridden.pipeline!.stages);

  /* remove-stage: removing an unrelated stage leaves the jump and loop intact. */
  const removed = await patchPipeline(id, { action: "remove-stage", stageId: "audit" }, ports);
  expect(removed.pipeline!.stages.some((stage) => stage.id === "audit")).toBe(false);
  jumpAndLoopSurvive(removed.pipeline!.stages);
});

test("closing an initial pending stage does not allocate a future attempt (#353)", async () => {
  const h = harness();
  const pipeline = await create(h.ports); // RUN_STAGES: plan → build
  await tickPipelines([], h.ports); // provision → running, cursor plan pending, no attempts
  const before = loadPipelines()[0]!;
  expect(before.cursor).toMatchObject({ stageId: "plan", state: "pending" });
  expect(before.runs.every((run) => run.attempts.length === 0)).toBe(true);

  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  const reloaded = loadPipelines()[0]!;
  expect(reloaded.state).toBe("closed");
  expect(reloaded.cursor).toBeNull();
  expect(reloaded.runs.find((run) => run.stageId === "plan")!.attempts).toHaveLength(0);
  expect(reloaded.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(0);
  expect(h.spawnInputs).toHaveLength(0);
});

test("closing after pre-reservation account admission settles the pending attempt", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports); // provision
  h.ports.spawnAgent = async () => { throw new AccountMutationBusyError(); };
  await tickPipelines([], h.ports); // admission refuses before onReserved
  const admissionDeferred = loadPipelines().find(item => item.id === pipeline.id)!;
  const deferred = admissionDeferred.runs.find(run => run.stageId === "plan")!.attempts[0]!;
  expect(admissionDeferred.state).toBe("running");
  expect(deferred).toMatchObject({ state: "pending", startedAt: expect.any(String), spawnCalls: 1,
    launchId: null, conversationId: null });

  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  const closed = loadPipelines().find(item => item.id === pipeline.id)!;
  expect(closed.runs.find(run => run.stageId === "plan")!.attempts[0]).toMatchObject({
    state: "skipped", startedAt: deferred.startedAt, completedAt: closed.closedAt,
    launchId: null, conversationId: null,
  });
  expect(h.spawnInputs).toHaveLength(0);
});

test("closing a post-advance pending stage leaves prior results without a future attempt (#353)", async () => {
  const h = harness();
  const pipeline = await create(h.ports); // RUN_STAGES: plan → build
  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], h.ports); // plan passes → advance to build
  const before = loadPipelines()[0]!;
  expect(before.cursor).toMatchObject({ stageId: "build", state: "pending", input: "planned", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(before.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(0);
  const priorSpawnCount = h.spawnInputs.length;
  const passedPlan = structuredClone(before.runs.find((run) => run.stageId === "plan")!.attempts[0]!);

  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  const reloaded = loadPipelines()[0]!;
  expect(reloaded.state).toBe("closed");
  expect(reloaded.cursor).toBeNull();
  expect(reloaded.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(0);
  expect(reloaded.runs.find((run) => run.stageId === "plan")!.attempts[0]).toEqual(passedPlan);
  expect(h.spawnInputs).toHaveLength(priorSpawnCount);
});

test("closing a fail-edge target preserves earlier outcomes without allocating a fresh round (#353)", async () => {
  const h = harness();
  const pipeline = await create(h.ports, [
    { id: "plan", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "Plan {{task}}", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "Build {{prev.output}}", next: "verify" },
    { id: "verify", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "Verify {{prev.output}}", next: null, onFail: { to: "build", maxRounds: 2 } },
  ] as never);
  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], h.ports); // plan → build
  await tickPipelines([], h.ports); // spawn build
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass", "built v1")], h.ports); // build → verify
  await tickPipelines([], h.ports); // spawn verify
  h.messages.set("/codex/stage-3.jsonl", { text: "cannot pass\n\n```json\n{\"status\":\"fail\",\"findings\":[\"regression\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-3.jsonl")], h.ports); // verify fails → routes to build

  const before = loadPipelines()[0]!;
  expect(before.cursor).toMatchObject({ stageId: "build", state: "pending", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });
  expect(before.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(1); // build attempt 2 not yet materialized
  const priorSpawnCount = h.spawnInputs.length;
  const passedBuild = structuredClone(before.runs.find((run) => run.stageId === "build")!.attempts[0]!);
  const failedVerify = structuredClone(before.runs.find((run) => run.stageId === "verify")!.attempts[0]!);

  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  const reloaded = loadPipelines()[0]!;
  expect(reloaded.state).toBe("closed");
  expect(reloaded.cursor).toBeNull();
  expect(reloaded.runs.find((run) => run.stageId === "build")!.attempts).toEqual([passedBuild]);
  expect(reloaded.runs.find((run) => run.stageId === "verify")!.attempts[0]).toEqual(failedVerify);
  expect(h.spawnInputs).toHaveLength(priorSpawnCount);
});
