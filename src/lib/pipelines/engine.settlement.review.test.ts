import { expect, test, tickPipelines, createPipelineFromRequest, loadPipelines, savePipelines, pipelineRevision, FAIL_EDGE_BUDGET_SPENT_DETAIL, failEdgeRoundsUsed, pipelineCompletedUnreviewed, patchPipeline, entry, harness, create, CYCLE_STAGES, BUDGET_STAGES, failEveryCritique, STOP_AFTER_FIX, REVIEW_HEADS, movingHeadHarness, critiqueRound, buildRound, continueReview, movingHead, acceptHead, driveWithController, BUILD_ONLY } from "./engine.fixture";

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
  expect(current.cursor).toMatchObject({
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
  expect(current.cursor).toMatchObject({ stageId: "build", state: "pending", input: "plan output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });

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
  expect(current.cursor).toMatchObject({
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
