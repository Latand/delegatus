// Pre-S5 embedded-flow execution cases stay as history until S8 deletion.
// Supported run-reviewer cases and flows/retirement.test.ts remain active.
import { expect, test, spawn, spawnSync, fs, path, Database, reviewNote, tickPipelines, MAX_FLOW_NOTE_LENGTH, createPipelineFromRequest, loadPipelines, savePipelines, pipelineRevision, FAIL_EDGE_BUDGET_SPENT_DETAIL, failEdgeRoundsUsed, pipelineCompletedUnreviewed, asStoredLegacyReviewLane, patchPipeline, closeAndDrain, RUN_STAGES, ORIGIN_MAIN_SHA, entry, harness, finishReported, REMOTE_BRANCH, create, realWorktreeLane, PROVIDER_LIMIT_NOTICE, LIMITED_ACCOUNT, SPARE_ACCOUNT, limitInterruptedTranscript, codexUsageLimitTranscript, verdictTranscript, silentTranscript, readFixtures, usageLimitPorts, usageLimitStage, reviewPipeline, reviewStage, noteOf, CYCLE_STAGES, BUDGET_STAGES, failEveryCritique, STOP_AFTER_FIX, REVIEW_HEADS, movingHeadHarness, critiqueRound, buildRound, continueReview, movingHead, acceptHead, driveWithController, expectConvertedReview, REVIEW_LOOP_STAGE, BUILD_ONLY, publishHarness, PUBLISH_STAGES, deliveryRefusalPark, interruptedPublication } from "./engine.fixture";


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

test.skip("a lost advance on a fresh review flow is re-issued instead of waiting forever", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  /* The harness flow stays waiting_ready with zero rounds — exactly the
     crash-between-persist-and-advance shape. The next tick re-issues. */
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:advance").length).toBe(2);
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

test("comparison review notes preserve owner guidance within the flow-note budget", () => {
  const pipeline = { ...reviewPipeline, delivery: {
    target: { repository: "repo-fixture", remote: "", branch: "refs/heads/review" },
    disposition: "comparison" as const, publish: "disabled" as const, active: false, ownerId: "publishing-lane", epoch: 4, journal: [],
  } };
  const role = { roleId: "reviewer" as const, engine: "codex" as const, model: null, effort: null,
    access: "read-only" as const, promptScaffold: "review guidance ".repeat(400) };
  const note = noteOf(reviewNote(pipeline, reviewStage("Check acceptance criteria"), role));
  expect(note).toContain("owned by publishing-lane at epoch 4");
  expect(note).toContain("Do not push to that branch");
  expect(note.length).toBeLessThanOrEqual(MAX_FLOW_NOTE_LENGTH);
  expect(reviewNote(pipeline, reviewStage("x".repeat(MAX_FLOW_NOTE_LENGTH)), role)).toHaveProperty("error");
});

test("reviewNote fits the flow-note cap while preserving the directive and safety fences", () => {
  /* A long role scaffold + fences would blow past the flow note's 2,000-char cap.
     The directive and the fences must survive; only the scaffold body is trimmed. */
  const fences = "\n\nSafety fences:\n- never delete production data\n- keep read-only when reviewing";
  const role = {
    engine: "codex" as const, model: "gpt-5.6-sol", effort: "high",
    roleId: "reviewer" as const, access: "read-only" as const,
    promptScaffold: `${"scaffold body ".repeat(400)}${fences}`,
  };
  const result = reviewNote(reviewPipeline, reviewStage("Review the diff for {{task}} carefully."), role);
  const note = noteOf(result);
  expect("note" in result).toBe(true);
  expect(note.length).toBeLessThanOrEqual(2_000);
  /* The operator's directive (with {{task}} substituted) is kept whole. */
  expect(note).toContain("Review the diff for ship the widget carefully.");
  /* Both safety fences survive the trim. */
  expect(note).toContain("never delete production data");
  expect(note).toContain("keep read-only when reviewing");
  /* The scaffold body was trimmed (it did not all fit). */
  expect(note).toContain("scaffold body");
});

test("reviewNote parks a too-long directive for raw and role-backed review stages", () => {
  const longDirective = `${"X".repeat(3_000)} {{task}}`;
  /* Raw review stage (no role scaffold): a 3,000-char directive can't be
     delivered whole, so it parks with an actionable error and never a 1,967-char slice. */
  const raw = reviewNote(reviewPipeline, reviewStage(longDirective), {
    engine: "codex", model: "gpt-5.6-sol", effort: "high", roleId: null, access: "read-only", promptScaffold: null,
  } as unknown as Parameters<typeof reviewNote>[2]);
  expect("error" in raw).toBe(true);
  if ("error" in raw) expect(raw.error).toContain("too long");

  /* Role-backed review stage: same over-cap directive still parks (the scaffold
     body trims, but the directive itself cannot be dropped). */
  const backed = reviewNote(reviewPipeline, reviewStage(longDirective), {
    engine: "codex", model: "gpt-5.6-sol", effort: "high", roleId: "reviewer", access: "read-only",
    promptScaffold: "guidance\n\nSafety fences:\n- stay read-only",
  } as unknown as Parameters<typeof reviewNote>[2]);
  expect("error" in backed).toBe(true);

  /* A directive that fits is delivered whole. */
  const ok = reviewNote(reviewPipeline, reviewStage("Check {{task}} against the ACs."), {
    engine: "codex", model: "gpt-5.6-sol", effort: "high", roleId: null, access: "read-only", promptScaffold: null,
  } as unknown as Parameters<typeof reviewNote>[2]);
  expect(noteOf(ok)).toBe("Check ship the widget against the ACs.");
});

test("a review-loop note relays a reported pass's short summary, not the full brief", () => {
  const role = { engine: "codex", model: "gpt-5.6-sol", effort: "high", roleId: null, access: "read-only", promptScaffold: null } as unknown as Parameters<typeof reviewNote>[2];
  const brief = `Fence added.\n\nFinal assistant message:\n${"b".repeat(40_000)}`;
  const reported = (activatedBy: unknown) => ({
    n: 1, state: "passed", output: brief, activatedBy,
    report: { verdict: { status: "pass" }, summary: "Fence added." },
  });
  const lane = (buildActivation: unknown, cursorInput: string) => ({
    ...reviewPipeline,
    stages: [
      { id: "build", kind: "run", prompt: "Build", next: "review" },
      { id: "verify", kind: "run", prompt: "Verify", next: "review", onFail: { to: "build", maxRounds: 1 } },
      { id: "review", kind: "review-loop", prompt: "Review {{prev.output}}", next: null },
    ],
    runs: [
      { stageId: "build", attempts: [reported(buildActivation)] },
      { stageId: "verify", attempts: [{ n: 1, state: "failed", verdict: { status: "fail", findings: ["P1 — the fence is missing"] } }] },
    ],
    cursor: { stageId: "review", state: "pending", input: cursorInput, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } },
  }) as unknown as Parameters<typeof reviewNote>[0];

  expect(noteOf(reviewNote(lane(null, brief), reviewStage("Review {{prev.output}}"), role))).toBe("Review Fence added.");
  /* A fix on a spent fail edge carries the same budget note the cursor input does. */
  const spent = noteOf(reviewNote(
    lane({ stageId: "verify", attempt: 1, edge: "fail", budgetSpent: true }, brief),
    reviewStage("Review {{prev.output}}"),
    role,
  ));
  expect(spent).toStartWith("Review Fence added.\n\n");
  expect(spent).toEndWith("Unreviewed findings:\n- P1 — the fence is missing");
  expect(spent.length).toBeLessThanOrEqual(MAX_FLOW_NOTE_LENGTH);
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

test.skip("draft edits that would orphan a review-loop are rejected (#136)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Guard the chain",
    repoDir: "/repo",
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null },
    ] as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;
  /* A stored legacy draft: a new review-loop is converted at creation (#2187). */
  savePipelines([asStoredLegacyReviewLane(created.pipeline!, created.convertedStages)]);
  /* Moving the review loop ahead of its only run stage — the API must refuse. */
  const reordered = await patchPipeline(id, { action: "reorder-stage", stageIds: ["review", "build"] }, ports);
  expect(reordered.pipeline).toBeUndefined();
  expect(reordered.status).toBe(400);
  /* Removing the sole preceding run leaves a review loop with nothing to review. */
  const removed = await patchPipeline(id, { action: "remove-stage", stageId: "build" }, ports);
  expect(removed.pipeline).toBeUndefined();
  expect(removed.status).toBe(400);
  /* The draft survived both rejections unchanged. */
  expect(loadPipelines()[0]!.stages.map((stage) => stage.id)).toEqual(["build", "review"]);
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
    error: "invalid codex model id \"gpt-5.6-codex\"; valid codex model ids: gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna",
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

test("a rejected structured fail verdict parks before fail-edge traversal (#429)", async () => {
  const h = harness();
  await create(h.ports, CYCLE_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built")], h.ports);
  await tickPipelines([], h.ports);
  h.messages.set("/codex/stage-2.jsonl", {
    text: "VERDICT: APPROVE\n\n```json\n{\"status\":\"fail\",\"findings\":[\"broken test\"]}\n```",
    ts: Date.now() + 100_000_000,
  });

  await tickPipelines([entry("/codex/stage-2.jsonl")], h.ports);

  const reason = 'contradictory stage verdict: prose marker "APPROVE" disagrees with JSON status "fail"';
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toBe(reason);
  expect(current.cursor).toEqual({
    stageId: "verify",
    state: "pending",
    input: "built",
    activatedBy: { stageId: "build", attempt: 1, edge: "pass" },
  });
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    output: "VERDICT: APPROVE",
    verdict: null,
    error: reason,
  });
});

test("a completed stage's output is persisted once and relayed exactly once (#353)", async () => {
  const h = harness();
  const prompts: string[] = [];
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    prompts.push(input.prompt);
    return baseSpawn(input, onReserved);
  };
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "plan output")], h.ports);

  /* The relay record lands in the same mutation as the verdict. */
  let current = loadPipelines()[0]!;
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "plan output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });

  /* Sibling-record evolution after the advance must not change the delivered
     The persisted prompt input remains authoritative across cursor movement. */
  current.runs[0]!.attempts[0]!.output = "mutated later";
  savePipelines([current]);
  await tickPipelines([], h.ports);

  current = loadPipelines()[0]!;
  expect(current.runs[1]!.attempts[0]).toMatchObject({
    input: "plan output",
    activatedBy: { stageId: "plan", attempt: 1, edge: "pass" },
    state: "running",
  });
  expect(prompts.at(-1)).toContain("Build from plan output");
  /* Exactly once: re-ticking the same state neither respawns nor rewrites. */
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(2);
});

test("an accepted fail verdict traverses the fail edge, loops once, then parks on budget exhaustion under onExhausted: park (#353, #1868)", async () => {
  const h = harness();
  const prompts: string[] = [];
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    prompts.push(input.prompt);
    return baseSpawn(input, onReserved);
  };
  await create(h.ports, [CYCLE_STAGES[0], { ...CYCLE_STAGES[1], onFail: { to: "build", maxRounds: 1, onExhausted: "park" } }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built v1")], h.ports);
  await tickPipelines([], h.ports);

  /* verify fails with findings → the fail edge routes back to build with the
     failure narrative as {{prev.output}}; no park, no worktree reset. */
  h.messages.set("/codex/stage-2.jsonl", { text: "cannot pass\n\n```json\n{\"status\":\"fail\",\"findings\":[\"broken test\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-2.jsonl")], h.ports);

  let current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[1]!.attempts[0]).toMatchObject({ state: "failed", verdict: { status: "fail" } });
  expect(current.cursor).toEqual({
    stageId: "build",
    state: "pending",
    input: "cannot pass\n\nFail verdict findings:\n- broken test",
    activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
  });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);

  /* The loop round re-runs build with the failure input, passes, re-enters
     verify as a fresh attempt. */
  await tickPipelines([], h.ports);
  expect(prompts.at(-1)).toContain("Fail verdict findings:\n- broken test");
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(2);
  expect(current.runs[0]!.attempts[1]!.activatedBy).toEqual({ stageId: "verify", attempt: 1, edge: "fail" });
  h.messages.set("/codex/stage-3.jsonl", { text: "fixed\n\n```json\n{\"status\":\"pass\"}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-3.jsonl")], h.ports);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[1]!.attempts).toHaveLength(2);

  /* Second verify failure exhausts maxRounds: 1 → parks for the operator. */
  h.messages.set("/codex/stage-4.jsonl", { text: "still broken\n\n```json\n{\"status\":\"fail\",\"findings\":[\"regression\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-4.jsonl")], h.ports);
  current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toContain("fail-edge budget exhausted after 1 round(s)");
  expect(current.runs[1]!.attempts[1]!.state).toBe("failed");
});

test("a retry of the fail edge's target spends no round, and the budget still parks once the edge has really been traversed twice (#1754)", async () => {
  const h = harness();
  const CYCLE_STAGES_TWO_ROUNDS = [
    CYCLE_STAGES[0],
    { ...CYCLE_STAGES[1], onFail: { to: "build", maxRounds: 2, onExhausted: "park" } },
  ];
  await create(h.ports, CYCLE_STAGES_TWO_ROUNDS as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built v1")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "cannot pass")], h.ports);
  await tickPipelines([], h.ports);

  let current = loadPipelines()[0]!;
  const round = current.runs[0]!.attempts[1]!;
  expect(round.activatedBy).toEqual({ stageId: "verify", attempt: 1, edge: "fail" });

  /* The round's own attempt died on its spawn and `retry-stage` re-ran the
     stage: a fresh attempt carrying the same activation. The traversal already
     happened; this is the same round, not a second one (#1754). */
  round.state = "failed";
  round.completedAt = h.ports.now();
  round.error = "pipeline structured runtime host is unavailable";
  current.runs[0]!.attempts.push({
    ...structuredClone(round),
    n: 3,
    state: "running",
    completedAt: null,
    error: null,
    launchId: "launch-retry",
    conversationId: "conversation_stage_retry",
    sessionId: "session-retry",
    agentPath: "/codex/stage-retry.jsonl",
    paneId: null,
  });
  current.cursor = { stageId: "build", state: "running", input: round.input, activatedBy: round.activatedBy };
  savePipelines([current]);

  /* The retried attempt passes and verify fails a second time: that failure is
     the edge's second traversal, so it loops rather than parking. */
  await tickPipelines([h.finish("/codex/stage-retry.jsonl", "pass", "built v2")], h.ports);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[1]!.attempts).toHaveLength(2);
  const verifyRetryPath = current.runs[1]!.attempts[1]!.agentPath!;
  await tickPipelines([h.finish(verifyRetryPath, "fail", "still broken")], h.ports);

  current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.cursor).toMatchObject({ stageId: "build", activatedBy: { stageId: "verify", attempt: 2, edge: "fail" } });

  /* Two traversals are spent; the third failure parks for the operator. */
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  const buildRoundTwo = current.runs[0]!.attempts.at(-1)!;
  await tickPipelines([h.finish(buildRoundTwo.agentPath!, "pass", "built v3")], h.ports);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  const verifyThird = current.runs[1]!.attempts.at(-1)!;
  expect(current.runs[1]!.attempts).toHaveLength(3);
  await tickPipelines([h.finish(verifyThird.agentPath!, "fail", "regression")], h.ports);

  current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toContain("fail-edge budget exhausted after 2 round(s)");
});

test("a spent review budget hands the last findings to the fix stage once and moves on along the reviewer's pass edge (#1868)", async () => {
  const h = harness();
  const prompts: string[] = [];
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    prompts.push(input.prompt);
    return baseSpawn(input, onReserved);
  };
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 3 }) as never);
  await tickPipelines([], h.ports);
  await failEveryCritique(h, 3);

  let current = loadPipelines()[0]!;
  const builds = current.runs.find((run) => run.stageId === "build")!.attempts;
  const critiques = current.runs.find((run) => run.stageId === "critique")!.attempts;
  expect(builds).toHaveLength(4);
  expect(critiques).toHaveLength(3);
  expect(builds.every((attempt) => attempt.state === "passed")).toBe(true);
  expect(critiques.every((attempt) => attempt.state === "failed")).toBe(true);
  /* The fourth build carries the third critique's findings. */
  expect(builds[3]!.activatedBy).toEqual({ stageId: "critique", attempt: 3, edge: "fail", budgetSpent: true });
  expect(builds[3]!.input).toContain("P2 evidence gap 3");
  /* The record says the last review was handed on unreviewed and keeps it. */
  expect(critiques[2]).toMatchObject({
    state: "failed",
    budgetSpent: true,
    verdict: { status: "fail", findings: ["P2 evidence gap 3"] },
  });
  expect(current.state).toBe("running");
  expect(current.stateDetail).toBe(FAIL_EDGE_BUDGET_SPENT_DETAIL);
  expect(FAIL_EDGE_BUDGET_SPENT_DETAIL).toBe("budget spent: last findings handed to the fix stage, not re-reviewed");
  /* The cursor sits on the reviewer's pass successor, and the unreviewed
     findings travel with the fix's output. */
  expect(current.cursor).toMatchObject({
    stageId: "ship",
    state: "pending",
    activatedBy: { stageId: "build", attempt: 4, edge: "pass" },
  });
  expect(current.cursor!.input).toContain("built v4");
  expect(current.cursor!.input).toContain(FAIL_EDGE_BUDGET_SPENT_DETAIL);
  expect(current.cursor!.input).toContain("P2 evidence gap 3");
  /* The handoff is the edge's last traversal: 3 of 3. */
  expect(failEdgeRoundsUsed(current, current.stages.find((stage) => stage.id === "critique")!)).toBe(3);

  /* The next stage runs, and the reviewer never runs a fourth time. */
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs.find((run) => run.stageId === "ship")!.attempts).toHaveLength(1);
  expect(prompts.at(-1)).toContain("P2 evidence gap 3");
  expect(current.runs.find((run) => run.stageId === "critique")!.attempts).toHaveLength(3);
});

test("onExhausted: park keeps today's park once the review budget is spent (#1868)", async () => {
  const h = harness();
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 2, onExhausted: "park" }) as never);
  await tickPipelines([], h.ports);
  await failEveryCritique(h, 3);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toContain("fail-edge budget exhausted after 2 round(s)");
  expect(current.cursor?.stageId).toBe("critique");
  expect(current.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(3);
  expect(current.runs.find((run) => run.stageId === "critique")!.attempts).toHaveLength(3);
  expect(current.runs.find((run) => run.stageId === "critique")!.attempts.some((attempt) => attempt.budgetSpent)).toBe(false);
  expect(current.stages.find((stage) => stage.id === "critique")!.onFail).toEqual({ to: "build", maxRounds: 2, onExhausted: "park" });
});

test("a spent review budget on the last stage parks after its final re-check (#3037)", async () => {
  const h = harness();
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1 }, null) as never);
  await tickPipelines([], h.ports);
  await failEveryCritique(h, 1);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.cursor?.stageId).toBe("critique");
  expect(current.reviewPending?.terminalRecheck).toBe(true);
  expect(current.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(2);
  const critiques = current.runs.find((run) => run.stageId === "critique")!.attempts;
  expect(critiques).toHaveLength(2);
  expect(critiques[0]).toMatchObject({ state: "failed", budgetSpent: true, verdict: { findings: ["P2 evidence gap 1"] } });
});

test("onExhausted is validated and edited with the fail edge, and freezes with it (#1868)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const refused = await createPipelineFromRequest({
    task: "Bad option",
    repoDir: "/repo",
    stages: BUDGET_STAGES({ to: "build", maxRounds: 2, onExhausted: "stop" }) as never,
    autoStart: false,
  }, ports);
  expect(refused.error).toContain("onExhausted");
  const created = await createPipelineFromRequest({
    task: "Edge option",
    repoDir: "/repo",
    stages: BUDGET_STAGES({ to: "build", maxRounds: 2 }) as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;
  expect(created.pipeline!.stages[1]!.onFail).toEqual({ to: "build", maxRounds: 2 });
  expect((await patchPipeline(id, { action: "set-edge", stageId: "critique", edge: "fail", to: "build", onExhausted: "stop" as never }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "critique", edge: "pass", to: "ship", onExhausted: "park" }, ports)).status).toBe(400);
  const parked = await patchPipeline(id, { action: "set-edge", stageId: "critique", edge: "fail", to: "build", maxRounds: 3, onExhausted: "park" }, ports);
  expect(parked.pipeline?.stages[1]?.onFail).toEqual({ to: "build", maxRounds: 3, onExhausted: "park" });
  const advance = await patchPipeline(id, { action: "set-edge", stageId: "critique", edge: "fail", to: "build", maxRounds: 3, onExhausted: "advance" }, ports);
  expect(advance.pipeline?.stages[1]?.onFail).toEqual({ to: "build", maxRounds: 3, onExhausted: "advance" });

  /* The handoff is a traversal of the edge, so it freezes the edge's option
     with the rest of it. */
  await patchPipeline(id, { action: "set-edge", stageId: "critique", edge: "fail", to: "build", maxRounds: 1, onExhausted: "advance" }, ports);
  await patchPipeline(id, { action: "start" }, ports);
  await tickPipelines([], ports);
  await failEveryCritique(h, 1);
  const handedOff = loadPipelines()[0]!;
  expect(handedOff.runs.find((run) => run.stageId === "critique")!.attempts[0]!.budgetSpent).toBe(true);
  const frozen = await patchPipeline(id, { action: "set-edge", stageId: "critique", edge: "fail", to: "build", maxRounds: 1, onExhausted: "park" }, ports);
  expect(frozen.status).toBe(409);
  expect(frozen.error).toContain("frozen evidence");
  expect(loadPipelines()[0]!.stages[1]!.onFail).toEqual({ to: "build", maxRounds: 1, onExhausted: "advance" });
});

test("stop-after-fix, maxRounds 1: a final fix that writes a new head ends in needs_review with both heads and the last verdict, never completed (#1938)", async () => {
  const h = movingHeadHarness();
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1, ...STOP_AFTER_FIX }, null) as never);
  await tickPipelines([], h.ports);
  await failEveryCritique(h, 1, h.beforeBuildPass);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_review");
  expect(current.closedAt).toBeNull();
  expect(current.cursor).toBeNull();
  expect(current.lastPassedCommit).toBe(REVIEW_HEADS[1]);
  expect(current.reviewPending).toMatchObject({
    stageId: "critique",
    attempt: 1,
    fixStageId: "build",
    fixAttempt: 2,
    reviewedHead: REVIEW_HEADS[0],
    currentHead: REVIEW_HEADS[1],
    verdict: "fail",
    findings: 1,
  });
  expect(current.stateDetail).toContain("last review failed");
  expect(current.stateDetail).toContain("unreviewed");
  /* No pass was recorded for the reviewer, and nothing completed. */
  const critiques = current.runs.find((run) => run.stageId === "critique")!.attempts;
  expect(critiques.map((attempt) => attempt.state)).toEqual(["failed"]);
  expect(critiques[0]!.reviewedHead).toBe(REVIEW_HEADS[0]);
  /* It survives a reload through the store unchanged. */
  expect(loadPipelines()[0]!.state).toBe("needs_review");
  /* Nothing ticks it forward on its own. */
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_review");
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "critique")!.attempts).toHaveLength(1);
  /* A pause and a resume bring it back to needs_review, still naming the head. */
  expect((await patchPipeline(current.id, { action: "pause" }, h.ports)).pipeline?.pausedState).toBe("needs_review");
  const resumed = await patchPipeline(current.id, { action: "resume" }, h.ports);
  expect(resumed.pipeline?.state).toBe("needs_review");
  expect(resumed.pipeline?.stateDetail).toBe(current.stateDetail);
});

test("stop-after-fix with no new head completes (#1938, #2187)", async () => {
  for (const edge of [STOP_AFTER_FIX]) {
    /* Round 1 writes H1 and the handoff fix leaves the tree at H1. */
    const h = movingHeadHarness(() => REVIEW_HEADS[0]!);
    await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1, ...edge }, null) as never);
    await tickPipelines([], h.ports);
    await failEveryCritique(h, 1, h.beforeBuildPass);

    const current = loadPipelines()[0]!;
    expect({ edge, state: current.state }).toEqual({ edge, state: "completed" });
    expect(current.stateDetail).toBe(FAIL_EDGE_BUDGET_SPENT_DETAIL);
    expect(current.reviewPending).toBeUndefined();
  }
});

test("stop-after-fix: a budget handoff recorded before reviewed heads existed is judged against the head its fix started from (#1938)", async () => {
  for (const [label, heads, expected] of [
    ["unchanged", () => REVIEW_HEADS[0]!, "completed"],
    ["moved", (round: number) => REVIEW_HEADS[round - 1]!, "needs_review"],
  ] as const) {
    const h = movingHeadHarness(heads);
    await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1, ...STOP_AFTER_FIX }, null) as never);
    await tickPipelines([], h.ports);
    await buildRound(h, "built v1");
    await critiqueRound(h, "fail", "round 1");
    /* The handoff as a pre-#1938 engine wrote it: no reviewed head. */
    const legacy = loadPipelines()[0]!;
    expect(legacy.cursor).toMatchObject({ stageId: "build", activatedBy: { budgetSpent: true } });
    delete legacy.runs.find((run) => run.stageId === "critique")!.attempts[0]!.reviewedHead;
    savePipelines([legacy]);
    await buildRound(h, "built v2");
    const current = loadPipelines()[0]!;
    expect({ label, state: current.state }).toEqual({ label, state: expected });
    expect(current.runs.find((run) => run.stageId === "critique")!.attempts[0]!.reviewedHead).toBe(REVIEW_HEADS[0]);
    if (expected === "needs_review") expect(current.reviewPending).toMatchObject({ reviewedHead: REVIEW_HEADS[0], currentHead: REVIEW_HEADS[1] });
  }
});

test.each(["advance", "stop-after-fix", "park"] as const)("continue-review refuses new rounds for %s without changing the lane", async (policy) => {
  const h = movingHeadHarness();
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1, onExhausted: policy }, null) as never);
  await driveWithController(h);
  const lane = loadPipelines()[0]!;
  const revision = pipelineRevision(lane);
  const spawned = h.spawnInputs.length;
  for (const rounds of [1, 2, 9]) {
    const refused = await continueReview(lane, "refused-" + rounds, rounds);
    expect(refused.status).toBe(409);
    expect(refused.field).toBe("addRounds");
    expect(refused.error).toContain("Review budget is fixed");
    expect(pipelineRevision(loadPipelines()[0]!)).toBe(revision);
  }
  expect(loadPipelines()[0]!.reviewGrants).toBeUndefined();
  expect(h.spawnInputs).toHaveLength(spawned);
  expect((await continueReview(lane, "bad-shape", 0)).status).toBe(400);
  const stranger = await patchPipeline(lane.id, { action: "continue-review", clientRequestId: "stranger", addRounds: 1, expectedRevision: revision }, h.ports,
    { kind: "agent", role: "orchestrator", conversationId: "conversation_other" });
  expect(stranger.status).toBe(403);
});

test("an accepted historical continue-review receipt replays without extending or launching work", async () => {
  const h = movingHeadHarness();
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1, ...STOP_AFTER_FIX }, null) as never);
  await driveWithController(h);
  const lane = loadPipelines()[0]!;
  const acceptedRevision = pipelineRevision(lane);
  lane.reviewGrants = [{ clientRequestId: "historical-grant", expectedRevision: acceptedRevision, stageId: "critique", rounds: 1,
    reviewedHead: REVIEW_HEADS[0], currentHead: REVIEW_HEADS[1]!, actor: { kind: "operator" }, at: h.ports.now() }];
  savePipelines([lane]);
  const revision = pipelineRevision(loadPipelines()[0]!);
  const spawned = h.spawnInputs.length;
  expect((await continueReview(lane, "historical-grant", 1, acceptedRevision.slice(0, 8))).replayed).toBe(true);
  expect((await continueReview(lane, "historical-grant", 2, acceptedRevision)).status).toBe(409);
  expect((await continueReview(lane, "another-grant", 1)).status).toBe(409);
  expect(pipelineRevision(loadPipelines()[0]!)).toBe(revision);
  expect(h.spawnInputs).toHaveLength(spawned);
});

test("accept-head completes a stop-after-fix lane along the review stage's null pass edge, records who accepted, replays and is refused outside needs_review (#2187)", async () => {
  const h = movingHeadHarness();
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1, ...STOP_AFTER_FIX }, null) as never);
  await tickPipelines([], h.ports);
  /* Refused while the lane still runs. */
  const running = loadPipelines()[0]!;
  const early = await acceptHead(running, "accept-early");
  expect(early.status).toBe(409);
  expect(early.error).toContain("requires a pipeline in needs_review");
  await failEveryCritique(h, 1, h.beforeBuildPass);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_review");
  const revision = pipelineRevision(parked);

  expect((await patchPipeline(parked.id, { action: "accept-head", expectedRevision: revision }, h.ports)).status).toBe(400);
  expect((await acceptHead(parked, "accept-stale", "0".repeat(8))).code).toBe("STAGE_CHANGED");
  /* Another conversation is not the creator. */
  const stranger = await patchPipeline(parked.id, { action: "accept-head", clientRequestId: "accept-x", expectedRevision: revision }, h.ports, { kind: "agent", conversationId: "not-the-creator" } as never);
  expect(stranger.status).toBe(403);
  expect(loadPipelines()[0]!.state).toBe("needs_review");

  const accepted = await acceptHead(parked, "accept-1", revision.slice(0, 8));
  expect(accepted.reviewAcceptance?.expectedRevision).toBe(revision);
  expect(accepted.error).toBeUndefined();
  expect(accepted.replayed).toBe(false);
  expect(accepted.reviewAcceptance).toMatchObject({
    clientRequestId: "accept-1",
    stageId: "critique",
    attempt: 1,
    fixStageId: "build",
    fixAttempt: 2,
    reviewedHead: REVIEW_HEADS[0],
    currentHead: REVIEW_HEADS[1],
    actor: { kind: "operator" },
  });
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("completed");
  expect(current.cursor).toBeNull();
  expect(current.closedAt).not.toBeNull();
  expect(current.reviewPending).toBeUndefined();
  expect(current.stateDetail).toBe(FAIL_EDGE_BUDGET_SPENT_DETAIL);
  expect(current.lastPassedCommit).toBe(REVIEW_HEADS[1]);
  expect(current.reviewAcceptances).toHaveLength(1);
  /* No reviewer pass was invented for the accepted head. */
  expect(current.runs.find((run) => run.stageId === "critique")!.attempts.map((attempt) => attempt.state)).toEqual(["failed"]);

  const replay = await acceptHead(parked, "accept-1", revision);
  expect(replay.replayed).toBe(true);
  expect(replay.reviewAcceptance?.clientRequestId).toBe("accept-1");
  expect(pipelineRevision(loadPipelines()[0]!)).toBe(pipelineRevision(current));
  const late = await acceptHead(current, "accept-2");
  expect(late.status).toBe(409);
  expect(late.error).toContain("this one is completed");
  expect(loadPipelines()[0]!.reviewAcceptances).toHaveLength(1);
});

test("accept-head follows the review stage's pass edge to the next stage with the unreviewed findings in its input (#2187)", async () => {
  const h = movingHeadHarness();
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1, ...STOP_AFTER_FIX }) as never);
  await tickPipelines([], h.ports);
  await failEveryCritique(h, 1, h.beforeBuildPass);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_review");
  const accepted = await acceptHead(parked, "accept-ship");
  expect(accepted.error).toBeUndefined();
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.stateDetail).toBe(FAIL_EDGE_BUDGET_SPENT_DETAIL);
  expect(current.cursor).toMatchObject({ stageId: "ship", state: "pending", activatedBy: { stageId: "build", attempt: 2, edge: "pass" } });
  expect(current.cursor!.input).toContain("built v2");
  expect(current.cursor!.input).toContain("Unreviewed findings:");
  /* The controller runs the next stage like any other activation. */
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "ship")?.attempts).toHaveLength(1);
});

test("another gate's fail loop gives a spent gate a fresh bounded check cycle (#2247)", async () => {
  const h = movingHeadHarness();
  await create(h.ports, [
    { ...BUILD_ONLY[0], next: "review" },
    { ...BUDGET_STAGES({ to: "fix", maxRounds: 1 })[1], id: "review", next: "ui-check" },
    { ...BUILD_ONLY[0], id: "fix", next: "review" },
    { ...BUDGET_STAGES({ to: "fix", maxRounds: 2 })[1], id: "ui-check", next: null },
  ] as never);
  const { pipeline } = await driveWithController(h, (stageId, n) => stageId === "review" || (stageId === "ui-check" && n <= 2));
  expect(pipeline.state).toBe("completed");
  expect(pipeline.runs.find((run) => run.stageId === "review")!.attempts).toHaveLength(2);
  expect(pipeline.runs.find((run) => run.stageId === "fix")!.attempts).toHaveLength(4);
  expect(pipeline.runs.find((run) => run.stageId === "ui-check")!.attempts.map((attempt) => attempt.verdict!.status)).toEqual(["fail", "fail", "pass"]);
});

test.each([1, 3, 5])("terminal advance budget %s parks after its N reviews, final fix and terminal re-check", async (reviews) => {
  const h = movingHeadHarness();
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: reviews }, null) as never);
  const { pipeline } = await driveWithController(h);
  const builds = pipeline.runs.find(run => run.stageId === "build")!.attempts;
  const critiques = pipeline.runs.find(run => run.stageId === "critique")!.attempts;
  expect(pipeline.state).toBe("needs_decision");
  expect(pipeline.cursor?.stageId).toBe("critique");
  expect(pipeline.reviewPending?.terminalRecheck).toBe(true);
  expect(critiques).toHaveLength(reviews + 1);
  expect(builds).toHaveLength(reviews + 1);
  expect(builds.at(-1)!.input).toContain(`P2 evidence gap ${reviews}`);
  expect(builds.at(-1)!.state).toBe("passed");
  expect(critiques.at(-1)!.activatedBy?.budgetRecheck).toBe(true);
  expect(pipelineCompletedUnreviewed(pipeline)).toBeNull();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs.find(run => run.stageId === "critique")!.attempts).toHaveLength(reviews + 1);
});


test("under the default a last fix with a new head takes the reviewer's pass edge, and the next stage reads the unreviewed findings (#2187)", async () => {
  const h = movingHeadHarness();
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 2 }) as never);
  const { pipeline } = await driveWithController(h);

  expect(pipeline.state).toBe("completed");
  expect(pipeline.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(3);
  const ship = pipeline.runs.find((run) => run.stageId === "ship")!.attempts;
  expect(ship).toHaveLength(1);
  expect(ship[0]!.activatedBy).toEqual({ stageId: "build", attempt: 3, edge: "pass" });
  expect(ship[0]!.input).toContain(FAIL_EDGE_BUDGET_SPENT_DETAIL);
  expect(ship[0]!.input).toContain("P2 evidence gap 2");
  expect(pipelineCompletedUnreviewed(pipeline)).toEqual({ stageId: "critique", reviewedHead: REVIEW_HEADS[1], currentHead: REVIEW_HEADS[3], findings: 1 });
});

test("the controller stops stop-after-fix in needs_review after the last fix, and parks park before it (#2187)", async () => {
  const stop = movingHeadHarness();
  await create(stop.ports, BUDGET_STAGES({ to: "build", maxRounds: 2, onExhausted: "stop-after-fix" }, null) as never);
  const stopped = (await driveWithController(stop)).pipeline;
  expect(stopped.state).toBe("needs_review");
  expect(stopped.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(3);
  expect(stopped.runs.find((run) => run.stageId === "critique")!.attempts).toHaveLength(2);
  expect(stopped.reviewPending).toMatchObject({ stageId: "critique", attempt: 2, fixStageId: "build", fixAttempt: 3, reviewedHead: REVIEW_HEADS[1], currentHead: REVIEW_HEADS[2] });
  expect(pipelineCompletedUnreviewed(stopped)).toBeNull();

  const park = movingHeadHarness();
  await create(park.ports, BUDGET_STAGES({ to: "build", maxRounds: 2, onExhausted: "park" }, null) as never);
  const parked = (await driveWithController(park)).pipeline;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("fail-edge budget exhausted after 2 round(s)");
  expect(parked.cursor?.stageId).toBe("critique");
  expect(parked.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(3);
  expect(parked.runs.find((run) => run.stageId === "critique")!.attempts).toHaveLength(3);
});

test("stop-after-fix is accepted wherever a fail edge takes its option (#2187)", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Stop after the fix",
    repoDir: "/repo",
    stages: BUDGET_STAGES({ to: "build", maxRounds: 2, onExhausted: "stop-after-fix" }) as never,
    autoStart: false,
  }, h.ports);
  expect(created.pipeline?.stages[1]?.onFail).toEqual({ to: "build", maxRounds: 2, onExhausted: "stop-after-fix" });
  const id = created.pipeline!.id;
  const edited = await patchPipeline(id, { action: "set-edge", stageId: "critique", edge: "fail", to: "build", maxRounds: 3, onExhausted: "stop-after-fix" }, h.ports);
  expect(edited.pipeline?.stages[1]?.onFail).toEqual({ to: "build", maxRounds: 3, onExhausted: "stop-after-fix" });
  expect(edited.graphEdit?.summary).toContain("then stop after the last fix");
  /* The store reads it back. */
  expect(loadPipelines()[0]!.stages[1]!.onFail).toEqual({ to: "build", maxRounds: 3, onExhausted: "stop-after-fix" });
});

test.skip("create_pipeline stores a review-loop as a read-only reviewer, a fix stage and an advance fail edge (#2187)", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Reviewed build",
    repoDir: "/repo",
    stages: [{ ...BUILD_ONLY[0], next: "review" }, { ...REVIEW_LOOP_STAGE, next: null }] as never,
    autoStart: false,
  }, h.ports);
  expect(created.error).toBeUndefined();
  expect(created.convertedStages).toEqual([{ reviewer: "review", fixer: "review-fix" }]);
  expect(created.legacyReview).toBeUndefined();
  expectConvertedReview(loadPipelines()[0]!, "build", null);
  expect(loadPipelines()[0]!.stages.map((stage) => stage.id)).toEqual(["build", "review", "review-fix"]);
});

test.skip("add-stage on a draft converts a review-loop, and that draft completes after fixing its final review (#2187)", async () => {
  const h = movingHeadHarness();
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Draft with review", repoDir: "/repo", stages: BUILD_ONLY as never, autoStart: false, publication: "internal" }, h.ports);
  const id = created.pipeline!.id;
  const added = await patchPipeline(id, { action: "add-stage", after: "build", stage: REVIEW_LOOP_STAGE as never }, h.ports);
  expect(added.error).toBeUndefined();
  expect(added.convertedStages).toEqual([{ reviewer: "review", fixer: "review-fix" }]);
  expect(added.graphEdit?.summary).toContain("as a reviewer with fix stage review-fix");
  expectConvertedReview(loadPipelines()[0]!, "build", null);

  expect((await patchPipeline(id, { action: "start" }, h.ports)).error).toBeUndefined();
  const { pipeline, reviews } = await driveWithController(h, new Set(["review"]));
  expect(reviews).toBe(3);
  expect(pipeline.state).toBe("completed");
  const fixes = pipeline.runs.find((run) => run.stageId === "review-fix")!.attempts;
  expect(fixes).toHaveLength(3);
  expect(fixes.at(-1)!.activatedBy).toEqual({ stageId: "review", attempt: 3, edge: "fail", budgetSpent: true });
  expect(fixes.at(-1)!.input).toContain("P2 evidence gap 3");
  expect(pipelineCompletedUnreviewed(pipeline)?.stageId).toBe("review");
  expect(h.calls.some((call) => call.startsWith("flow:"))).toBe(false);
});

test.skip("add-stage on a started lane converts a review-loop and keeps every run's history (#2187)", async () => {
  const h = harness();
  await create(h.ports, [RUN_STAGES[0], { ...RUN_STAGES[1] }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const started = loadPipelines()[0]!;
  expect(started.state).toBe("running");
  expect(started.cursor?.stageId).toBe("plan");
  const planAttempts = structuredClone(started.runs.find((run) => run.stageId === "plan")!.attempts);
  expect(planAttempts).toHaveLength(1);

  const added = await patchPipeline(started.id, { action: "add-stage", index: 2, after: "build", stage: REVIEW_LOOP_STAGE as never }, h.ports);
  expect(added.error).toBeUndefined();
  expect(added.convertedStages).toEqual([{ reviewer: "review", fixer: "review-fix" }]);
  const lane = loadPipelines()[0]!;
  expectConvertedReview(lane, "build", null);
  expect(lane.stages.find((stage) => stage.id === "build")!.next).toBe("review");
  expect(lane.runs.find((run) => run.stageId === "plan")!.attempts).toEqual(planAttempts);
  expect(lane.cursor?.stageId).toBe("plan");
});

test.skip("a review-loop the conversion cannot build without a guess is stored as sent, and the answer carries the refusals (#2187)", async () => {
  const h = harness();
  savePipelines([]);
  /* Only a read-only stage passes into the review: no fix stage can copy it. */
  const readOnly = await createPipelineFromRequest({
    task: "Review a plan",
    repoDir: "/repo",
    stages: [{ ...RUN_STAGES[0], next: "review" }, { ...REVIEW_LOOP_STAGE, next: null }] as never,
    autoStart: false,
  }, h.ports);
  expect(readOnly.error).toBeUndefined();
  expect(readOnly.convertedStages).toBeUndefined();
  expect(readOnly.legacyReview).toEqual([{ stageId: "review", refusals: [expect.objectContaining({ code: "implementer-read-only" })] }]);
  expect(readOnly.pipeline!.stages.find((stage) => stage.id === "review")).toMatchObject({ kind: "review-loop", onFail: null });
  expect(readOnly.pipeline!.stages).toHaveLength(2);

  /* A full plan has no slot for the fix stage, on add-stage as at creation. */
  const seven = Array.from({ length: 7 }, (_, index) => ({ ...BUILD_ONLY[0], id: `build${index}`, next: index < 6 ? `build${index + 1}` : null }));
  const full = await createPipelineFromRequest({ task: "Seven builds", repoDir: "/repo", stages: seven as never, autoStart: false }, h.ports);
  const added = await patchPipeline(full.pipeline!.id, { action: "add-stage", after: "build6", stage: REVIEW_LOOP_STAGE as never }, h.ports);
  expect(added.error).toBeUndefined();
  expect(added.convertedStages).toBeUndefined();
  expect(added.legacyReview).toEqual([{ stageId: "review", refusals: [expect.objectContaining({ code: "stage-count" })] }]);
  const stored = loadPipelines().find((pipeline) => pipeline.id === full.pipeline!.id)!;
  expect(stored.stages).toHaveLength(8);
  expect(stored.stages.at(-1)).toMatchObject({ id: "review", kind: "review-loop" });
});

test.skip("graph edits on a stored legacy lane never convert its review-loop (#2187)", async () => {
  const h = harness();
  const lane = await create(h.ports, [
    { ...BUILD_ONLY[0], next: "review" },
    { ...REVIEW_LOOP_STAGE, next: null },
    { ...BUILD_ONLY[0], id: "docs", prompt: "Docs", next: null },
  ] as never);
  expect(lane.stages.map((stage) => [stage.id, stage.kind])).toEqual([["build", "run"], ["review", "review-loop"], ["docs", "run"]]);
  const reordered = await patchPipeline(lane.id, { action: "reorder-stage", stageIds: ["build", "docs", "review"] }, h.ports);
  expect(reordered.error).toBeUndefined();
  expect(reordered.convertedStages).toBeUndefined();
  const stored = loadPipelines()[0]!;
  expect(stored.stages.map((stage) => [stage.id, stage.kind])).toEqual([["build", "run"], ["docs", "run"], ["review", "review-loop"]]);
  expect(stored.stages.find((stage) => stage.id === "review")!.onFail).toBeNull();
});

/* A needs_decision that carries findings routes along the fail edge (#1785);
   one with nothing to fix still parks, whatever budget the edge has left. */
test("a needs_decision with no findings parks — a fail edge never auto-loops it (#353)", async () => {
  const h = harness();
  await create(h.ports, CYCLE_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built")], h.ports);
  await tickPipelines([], h.ports);
  h.messages.set("/codex/stage-2.jsonl", { text: "unsure\n\n```json\n{\"status\":\"needs_decision\"}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-2.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.cursor?.stageId).toBe("verify");
  expect(current.runs[0]!.attempts).toHaveLength(1);
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

test.skip("a review-loop binds its implementer through the activation graph across a merge (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  /* Execution runs seed → buildB → review, while the array order places review
     (index 1) ahead of its real implementer buildB (index 2). The activation
     lineage binds the review to buildB, the run that activated it, and the merge
     makes buildB sit later in the array than the review it feeds. */
  const created = await createPipelineFromRequest({
    task: "Merge lineage",
    spec: "AC",
    repoDir: "/repo",
    stages: [
      { id: "seed", kind: "run", role: { roleId: "builder" }, prompt: "Seed {{task}}", next: "buildB" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review {{task}}", next: null },
      { id: "buildB", kind: "run", role: { roleId: "builder" }, prompt: "Build {{prev.output}}", next: "review" },
    ] as never,
  }, ports);
  expect(created.pipeline).toBeDefined();
  /* A lane stored before #2187, whose review-loop runs as an embedded flow. */
  savePipelines([asStoredLegacyReviewLane(created.pipeline!, created.convertedStages)]);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn seed
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "seeded")], ports); // seed → buildB
  await tickPipelines([], ports); // spawn buildB
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass", "built")], ports); // buildB → review
  await tickPipelines([], ports); // review creates its flow

  const current = loadPipelines()[0]!;
  expect(current.cursor?.stageId).toBe("review");
  expect(current.runs.find((run) => run.stageId === "review")!.attempts[0]!.activatedBy).toEqual({ stageId: "buildB", attempt: 1, edge: "pass" });
  /* The review flow opens against buildB's transcript, the run that activated
     the review. */
  expect(h.calls.some((call) => call.startsWith("flow:/codex/stage-2.jsonl"))).toBe(true);
  expect(h.calls.some((call) => call.startsWith("flow:/codex/stage-1.jsonl"))).toBe(false);
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

test.skip("consecutive reviews cross a migration boundary and resume positional implementer selection (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Mixed consecutive reviews",
    spec: "AC",
    repoDir: "/repo",
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build {{task}}", next: "review1" },
      { id: "review1", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review {{task}}", next: "review2" },
      { id: "review2", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review again {{task}}", next: null },
    ] as never,
  }, ports);
  expect(created.pipeline).toBeDefined();
  /* A lane stored before #2187, whose review-loop runs as an embedded flow. */
  savePipelines([asStoredLegacyReviewLane(created.pipeline!, created.convertedStages)]);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn build
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built")], ports); // build → review1
  await tickPipelines([entry("/codex/stage-1.jsonl")], ports); // review1 opens flow-1
  h.flows.get("flow-1")!.rounds.push({ n: 1, reviewHeadSha: ORIGIN_MAIN_SHA } as never);
  h.flows.get("flow-1")!.state = "approved";
  await tickPipelines([entry("/codex/stage-1.jsonl")], ports); // review1 approves → review2

  /* Migrate review1's attempt: an ancestor with activatedBy null is the boundary
     the review2 lineage stops at, so implementer selection resumes positionally
     and binds to build (the passed run before the reviews). */
  const staged = loadPipelines()[0]!;
  expect(staged.cursor?.stageId).toBe("review2");
  staged.runs.find((run) => run.stageId === "review1")!.attempts[0]!.activatedBy = null;
  savePipelines([staged]);

  await tickPipelines([], ports); // review2 opens its flow
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(h.flows.size).toBe(2);
  expect(h.calls.filter((call) => call.startsWith("flow:/codex/stage-1.jsonl")).length).toBe(2);
});

test("a fail loop crosses a migration boundary and resumes positional parent selection (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Mixed fail loop",
    spec: "AC",
    repoDir: "/repo",
    stages: [
      { id: "seed", kind: "run", role: { roleId: "builder" }, prompt: "Seed {{task}}", next: "build" },
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build {{prev.output}}", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify {{prev.output}}", next: null, onFail: { to: "build", maxRounds: 2 } },
    ] as never,
  }, ports);
  expect(created.pipeline).toBeDefined();
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn seed
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "seeded")], ports); // seed → build
  await tickPipelines([], ports); // spawn build
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass", "built")], ports); // build → verify
  await tickPipelines([], ports); // spawn verify
  h.messages.set("/codex/stage-3.jsonl", { text: "cannot pass\n\n```json\n{\"status\":\"fail\",\"findings\":[\"broken\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-3.jsonl")], ports); // verify fails → routes to build

  /* Migrate verify's attempt: the fail-loop lineage stops at that boundary, so
     the build retry's parent selection resumes positionally and inherits seed
     (the passed run before build). */
  const staged = loadPipelines()[0]!;
  expect(staged.cursor).toMatchObject({ stageId: "build", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });
  staged.runs.find((run) => run.stageId === "verify")!.attempts[0]!.activatedBy = null;
  savePipelines([staged]);

  await tickPipelines([], ports); // build retry spawns
  const lastSpawn = h.calls.filter((call) => call.startsWith("spawn:")).at(-1) ?? "";
  expect(lastSpawn).toContain("_build_2");
  expect(lastSpawn).toContain("parent=/codex/stage-1.jsonl");
});

test("closing an initial pending stage records the resting stage as a durable pending attempt (#353)", async () => {
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
  const planRun = reloaded.runs.find((run) => run.stageId === "plan")!;
  expect(planRun.attempts).toHaveLength(1);
  expect(planRun.attempts[0]).toMatchObject({ state: "pending", startedAt: null, completedAt: null, input: null, activatedBy: null });
  expect(reloaded.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(0);
});

test("closing a post-advance pending stage records the resting stage with its relay record (#353)", async () => {
  const h = harness();
  const pipeline = await create(h.ports); // RUN_STAGES: plan → build
  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], h.ports); // plan passes → advance to build
  const before = loadPipelines()[0]!;
  expect(before.cursor).toMatchObject({ stageId: "build", state: "pending", input: "planned", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(before.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(0);

  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  const reloaded = loadPipelines()[0]!;
  expect(reloaded.state).toBe("closed");
  expect(reloaded.cursor).toBeNull();
  const buildRun = reloaded.runs.find((run) => run.stageId === "build")!;
  expect(buildRun.attempts).toHaveLength(1);
  /* The resting attempt inherits the durable relay record and carries no run
     timestamps (it never started). */
  expect(buildRun.attempts[0]).toMatchObject({ state: "pending", startedAt: null, completedAt: null, input: "planned", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(reloaded.runs.find((run) => run.stageId === "plan")!.attempts[0]!.state).toBe("passed");
});

test("closing a fail-edge target with an older terminal attempt records a fresh pending round (#353)", async () => {
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

  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  const reloaded = loadPipelines()[0]!;
  expect(reloaded.state).toBe("closed");
  expect(reloaded.cursor).toBeNull();
  const buildRun = reloaded.runs.find((run) => run.stageId === "build")!;
  expect(buildRun.attempts).toHaveLength(2);
  expect(buildRun.attempts[0]!.state).toBe("passed");
  /* The fresh round stays pending, carries the fail-edge provenance and input,
     and has no run timestamps (it never started). */
  expect(buildRun.attempts[1]).toMatchObject({ n: 2, state: "pending", startedAt: null, completedAt: null, activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });
  expect(buildRun.attempts[1]!.input).toContain("regression");
  expect(reloaded.runs.find((run) => run.stageId === "verify")!.attempts[0]!.state).toBe("failed");
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

test("a same-owner publication waits through another tick, then advances once settled (#1939)", async () => {
  const { h, box, pipeline } = await interruptedPublication();
  const operation = pipeline.delivery!.operation!;
  expect(operation.state).toBe("running");
  const descriptor = fs.openSync(operation.executor!.lock, "a");
  try {
    expect(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] }).status).toBe(0);
    await tickPipelines([], h.ports);
    const waiting = loadPipelines()[0]!;
    expect(waiting.state).toBe("running");
    expect(waiting.stateDetail).toContain("in progress since");
    expect(waiting.delivery!.operation!.id).toBe(operation.id);
    expect(waiting.cursor).toMatchObject({ stageId: "build", state: "committing" });
    expect(waiting.runs[0]!.attempts[0]!.state).toBe("passed");
  } finally { fs.closeSync(descriptor); }
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

test.skip("a passed run stage publishes its committed head before the review stage creates its flow (#729)", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  /* The builder's commit reaches origin before anything can gate on it: this is
     the exact ordering pipeline 2ae14391 lacked when its review stage parked on
     `review remote head is unavailable before launch`. */
  expect(box.remote()).toBe(box.passedSha);
  expect(loadPipelines()[0]).toMatchObject({ lastPassedCommit: box.passedSha, publishedCommit: box.passedSha });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  expect(box.order).toEqual(["commit", `push:${box.passedSha}`, "createFlow"]);
  expect(h.flows.get("flow-1")).toMatchObject({ headRef: loadPipelines()[0]!.branch, targetSha: box.passedSha });
  expect(loadPipelines()[0]!.state).toBe("running");
});

test("an unreachable remote leaves the stage passed and records it as unpublished (#999)", async () => {
  const h = harness();
  const box = publishHarness(h, { remoteReadFails: true });
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
  expect(box.remoteReadAttempts()).toBe(2);
  expect(h.flows.size).toBe(0);
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
  // The first line names the cause and the next step; the evidence follows it.
  expect(parked.stateDetail!.split("\n")[0]).toBe("publishing the passed stage: git push was refused (exit 1): ! [remote rejected] (shallow update not allowed). Fix it on this branch or on the base branch, then retry-stage.");
  expect(parked.stateDetail).toContain("\npublishing the pipeline branch: exit 1");
  /* The stage's work is committed and recorded — the park is recoverable, and a
     retry resets to this commit rather than discarding the builder's output. */
  expect(parked.lastPassedCommit).toBe(box.passedSha);
  expect(parked.publishedCommit ?? null).toBeNull();
  expect(box.order).toEqual(["commit", "push-rejected"]);
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
