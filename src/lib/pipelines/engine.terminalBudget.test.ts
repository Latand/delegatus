import { spyOn } from "bun:test";
import { pipelineRoleLookup } from "./roles";
import { expect, test, create, BUDGET_STAGES, movingHeadHarness, driveWithController,
  loadPipelines, realExec, pipelineCompletedUnreviewed } from "./engine.fixture";
import { mergeEligible } from "@/lib/forge/autoMerge";
import { prototypeCriticGate } from "@/lib/prototypeReview/criticGate";

async function createFixedLane(h: ReturnType<typeof movingHeadHarness>, stages: unknown, caseId: string) {
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `${caseId}-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`);
  try { await create(h.ports, stages as never); }
  finally { ids.mockRestore(); }
}

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

test.each([null, "ship"] as const)("an unconfigured visual critic parks at its budget before %s", async next => {
  const h = movingHeadHarness();
  h.ports.roleLookup = pipelineRoleLookup;
  const stages = BUDGET_STAGES({ to: "build", maxRounds: 2 }, next);
  Object.assign(stages[1]!, { role: { roleId: "visual-critic" }, engine: "claude", access: "read-only" });
  await createFixedLane(h, stages, next ? "30370011" : "30370010");
  const { pipeline } = await driveWithController(h, id => id === "critique");
  expect(pipeline.stages[1]!.onFail?.onExhausted).toBe("park");
  expect(pipeline.state).toBe("needs_decision");
  expect(pipeline.runs.find(run => run.stageId === "critique")!.attempts).toHaveLength(3);
  expect(pipeline.runs.find(run => run.stageId === "build")!.attempts).toHaveLength(3);
  expect(pipeline.runs.find(run => run.stageId === "ship")?.attempts ?? []).toHaveLength(0);
  expect(mergeEligible(pipeline)).toBe(false);
  expect(prototypeCriticGate(pipeline, next ?? "build").ok).toBe(false);
  const snapshot = (lane: typeof pipeline) => ({ state: lane.state, stateDetail: lane.stateDetail, cursor: lane.cursor,
    attempts: lane.runs.map(run => [run.stageId, run.attempts.length]), merge: mergeEligible(lane),
    publication: prototypeCriticGate(lane, next ?? "build").ok });
  const expected = snapshot(pipeline);
  // This process has no controller caches or in-memory fail-edge counters.
  const result = await realExec(process.execPath, ["-e", `
    const { defaultPipelinePorts, tickPipelines } = await import("@/lib/pipelines/engine");
    const { FlowPipelineController } = await import("@/lib/pipelines/controller");
    const { loadPipelines } = await import("@/lib/pipelines/store");
    const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
    const { mergeEligible } = await import("@/lib/forge/autoMerge");
    const { prototypeCriticGate } = await import("@/lib/prototypeReview/criticGate");
    registerPipelineTick(async () => {});
    const read = () => {
      const lane = loadPipelines().find(lane => lane.id === ${JSON.stringify(pipeline.id)});
      return { state: lane.state, stateDetail: lane.stateDetail, cursor: lane.cursor,
        attempts: lane.runs.map(run => [run.stageId, run.attempts.length]), merge: mergeEligible(lane),
        publication: prototypeCriticGate(lane, ${JSON.stringify(next ?? "build")}).ok };
    };
    const before = read();
    let spawns = 0, effects = 0, ticks = 0;
    const errors = [];
    const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(h.ports.now())},
      conversationAgentActive: async () => false, stageHostResident: async () => false,
      paneAgentAlive: async () => false, durableTurnEvidence: async () => null,
      stopStageAgent: async () => ({ outcome: "not-running" }),
      spawnAgent: async () => { spawns++; throw new Error("unexpected budget worker"); },
      exec: async () => { effects++; return { code: 1, stdout: "", stderr: "no external effects" }; } };
    const controller = new FlowPipelineController({
      scan: async () => ({ files: [], complete: true }),
      tickPipelines: async entries => { ticks++; return tickPipelines(entries, ports); },
      tickFlows: async () => ({ changed: false }), now: () => 0,
      publishHeartbeat: () => {}, sweepForgeLinks: () => {}, log: (_message, error) => { if (error) errors.push(String(error)); },
    });
    await controller.tick("test");
    console.log(JSON.stringify({ before, after: read(), spawns, effects, ticked: ticks > 0, errors }));
  `], process.cwd(), { LLV_STATE_DIR: process.env.LLV_STATE_DIR!,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_CONTROL_URL: "http://127.0.0.1:1" }, { timeoutMs: 30_000 });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({ before: expected, after: expected, spawns: 0, effects: 0, ticked: true, errors: [] });
  expect(snapshot(loadPipelines().find(lane => lane.id === pipeline.id)!)).toEqual(expected);
});

test.each([
  { caseId: "30370001", role: "reviewer", rounds: 3, pass: true, changed: true },
  { caseId: "30370002", role: "reviewer", rounds: 3, pass: false, changed: true },
  { caseId: "30370003", role: "visual-critic", rounds: 2, pass: true, changed: true },
  { caseId: "30370004", role: "visual-critic", rounds: 2, pass: false, changed: true },
  { caseId: "30370005", role: "reviewer", rounds: 1, pass: false, changed: false },
] as const)("terminal $role re-checks the final fix once (rounds=$rounds, pass=$pass, changed=$changed)", async ({ caseId, role, rounds, pass, changed }) => {
  const h = changed ? movingHeadHarness() : movingHeadHarness(() => "1".repeat(40));
  const launched = recordReviewLaunches(h);
  const roleLookup = h.ports.roleLookup!;
  h.ports.roleLookup = id => roleLookup(id === "visual-critic" ? "architect" : id);
  const stages = BUDGET_STAGES({ to: "build", maxRounds: rounds, onExhausted: "advance" }, null);
  Object.assign(stages[1]!, { role: { roleId: role }, engine: role === "visual-critic" ? "claude" : "codex", access: "read-only" });
  await createFixedLane(h, stages, caseId);
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
  { caseId: "30370006", kind: "repair", pass: true }, { caseId: "30370007", kind: "repair", pass: false },
  { caseId: "30370008", kind: "validation", pass: true }, { caseId: "30370009", kind: "validation", pass: false },
] as const)("the terminal re-check retains the spent handoff through $kind (pass=$pass)", async ({ caseId, kind, pass }) => {
  const h = movingHeadHarness();
  const launched = recordReviewLaunches(h);
  const stages = BUDGET_STAGES({ to: "build", maxRounds: 1 }, null);
  Object.assign(stages[1]!, { role: { roleId: "reviewer" }, access: "read-only" });
  if (kind === "repair") Object.assign(stages[0]!, { onFail: { to: "repair", maxRounds: 1 } });
  else stages[0]!.next = "validation";
  stages.push({ ...stages[0]!, id: kind, next: kind === "repair" ? null : "critique", onFail: undefined } as never);
  await createFixedLane(h, stages, caseId);
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
