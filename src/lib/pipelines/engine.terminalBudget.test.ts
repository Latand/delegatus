import { expect, test, create, BUDGET_STAGES, movingHeadHarness, driveWithController,
  loadPipelines, realExec, pipelineCompletedUnreviewed } from "./engine.fixture";
import { mergeEligible } from "@/lib/forge/autoMerge";

function recordReviewLaunches(h: ReturnType<typeof movingHeadHarness>) {
  const observed: Array<{ head: string; state: string }> = [];
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (...args) => {
    const lane = loadPipelines()[0]!;
    if (lane.cursor?.stageId === "critique") {
      const head = await h.ports.exec("git", ["rev-parse", "HEAD"], args[0].cwd);
      expect(head.code).toBe(0);
      observed.push({ head: head.stdout.trim(), state: lane.state });
    }
    return spawn(...args);
  };
  return observed;
}

test.each([
  { role: "reviewer", rounds: 3, pass: true, changed: true },
  { role: "reviewer", rounds: 3, pass: false, changed: true },
  { role: "visual-critic", rounds: 2, pass: true, changed: true },
  { role: "visual-critic", rounds: 2, pass: false, changed: true },
  { role: "reviewer", rounds: 1, pass: false, changed: false },
] as const)("terminal $role re-checks the final fix once (rounds=$rounds, pass=$pass, changed=$changed)", async ({ role, rounds, pass, changed }) => {
  const h = changed ? movingHeadHarness() : movingHeadHarness(() => "1".repeat(40));
  const launched = recordReviewLaunches(h);
  const roleLookup = h.ports.roleLookup;
  h.ports.roleLookup = id => roleLookup(id === "visual-critic" ? "architect" : id);
  const stages = BUDGET_STAGES({ to: "build", maxRounds: rounds }, null);
  Object.assign(stages[1]!, { role: { roleId: role }, engine: role === "visual-critic" ? "claude" : "codex", access: "read-only" });
  await create(h.ports, stages as never);
  const { pipeline } = await driveWithController(h, (id, n) => id === "critique" && (n <= rounds || !pass));
  const reviews = pipeline.runs.find(run => run.stageId === "critique")!.attempts;
  const builds = pipeline.runs.find(run => run.stageId === "build")!.attempts;
  expect(reviews).toHaveLength(rounds + 1);
  expect(builds).toHaveLength(rounds + 1);
  const recheck = reviews.at(-1)!;
  expect(recheck.activatedBy).toEqual({ stageId: "build", attempt: rounds + 1, edge: "pass", budgetRecheck: true });
  expect(launched).toHaveLength(rounds + 1);
  expect(launched.at(-1)).toEqual({ head: pipeline.lastPassedCommit, state: "running" });
  expect(recheck.verdict?.status).toBe(pass ? "pass" : "fail");
  expect(pipeline.state).toBe(pass ? "completed" : "needs_decision");
  expect(mergeEligible(pipeline)).toBe(pass);
  expect(pipelineCompletedUnreviewed(pipeline)).toBeNull();
  if (pass) {
    expect(pipeline.cursor).toBeNull();
    expect(pipeline.reviewPending).toBeUndefined();
  } else {
    expect(pipeline.stateDetail).toContain("budget spent: 1 findings left");
    expect(pipeline.reviewPending).toMatchObject({ terminalRecheck: true, attempt: rounds + 1,
      currentHead: pipeline.lastPassedCommit, findings: 1 });
    // A real new controller process must retain the exhausted gate's refusal.
    // No spawned worker, forge command or live runtime is available to it.
    const result = await realExec(process.execPath, ["-e", `
      const { defaultPipelinePorts, tickPipelines } = await import("@/lib/pipelines/engine");
      const { loadPipelines } = await import("@/lib/pipelines/store");
      const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
      registerPipelineTick(async () => {});
      const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(h.ports.now())},
        conversationAgentActive: async () => false, stageHostResident: async () => false,
        paneAgentAlive: async () => false, durableTurnEvidence: async () => null,
        stopStageAgent: async () => ({ outcome: "not-running" }),
        spawnAgent: async () => { throw new Error("unexpected extra budget worker"); },
        exec: async () => ({ code: 1, stdout: "", stderr: "no external effects" }) };
      await tickPipelines([], ports);
      await tickPipelines([], ports);
      const lane = loadPipelines().find(lane => lane.id === ${JSON.stringify(pipeline.id)});
      console.log(JSON.stringify({ state: lane.state, pending: lane.reviewPending,
        reviews: lane.runs.find(run => run.stageId === "critique").attempts.length,
        builds: lane.runs.find(run => run.stageId === "build").attempts.length }));
    `], process.cwd(), { LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_CONTROL_URL: "http://127.0.0.1:1" }, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ state: "needs_decision", pending: pipeline.reviewPending,
      reviews: rounds + 1, builds: rounds + 1 });
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
  }
});

test.each([
  { kind: "repair", pass: true }, { kind: "repair", pass: false },
  { kind: "validation", pass: true }, { kind: "validation", pass: false },
] as const)("the terminal re-check retains the spent handoff through $kind (pass=$pass)", async ({ kind, pass }) => {
  const h = movingHeadHarness();
  const launched = recordReviewLaunches(h);
  const stages = BUDGET_STAGES({ to: "build", maxRounds: 1 }, null);
  Object.assign(stages[1]!, { role: { roleId: "reviewer" }, access: "read-only" });
  if (kind === "repair") Object.assign(stages[0]!, { onFail: { to: "repair", maxRounds: 1 } });
  else stages[0]!.next = "validation";
  stages.push({ ...stages[0]!, id: kind, next: kind === "repair" ? null : "critique", onFail: undefined } as never);
  await create(h.ports, stages as never);
  const { pipeline } = await driveWithController(h, (id, n) => (id === "critique" && (n === 1 || !pass))
    || (kind === "repair" && id === "build" && n === 2));
  const reviews = pipeline.runs.find(run => run.stageId === "critique")!.attempts;
  expect(pipeline.state).toBe(pass ? "completed" : "needs_decision");
  expect(mergeEligible(pipeline)).toBe(pass);
  expect(reviews).toHaveLength(2);
  expect(reviews.at(-1)!.activatedBy).toMatchObject({ stageId: kind === "repair" ? "repair" : "build", edge: "pass", budgetRecheck: true });
  expect(launched).toHaveLength(2);
  expect(launched.at(-1)).toEqual({ head: pipeline.lastPassedCommit, state: "running" });
  expect(pipeline.runs.find(run => run.stageId === kind)!.attempts).toHaveLength(1);
});
