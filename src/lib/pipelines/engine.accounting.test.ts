import { expect, test, harness, create, tickPipelines, loadPipelines, savePipelines, finishReported, BUILD_ONLY, createPipelineFromRequest, patchPipeline } from "./engine.fixture";
import { isStoredPipeline } from "./store";
import { REPEAT_REASONS } from "./accounting";

test("controller persists admission before launch and keeps an exact unknown remainder on completion", async () => {
  const h = harness();
  let now = 1_000_000;
  h.ports.now = () => new Date(now).toISOString();
  const lane = await create(h.ports, BUILD_ONLY as never);
  now += 1000;
  await tickPipelines([], h.ports);
  now += 2000;
  await tickPipelines([], h.ports);
  let stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  expect(attempt.accounting).toMatchObject({ admittedAt: lane.createdAt, startedAt: new Date(now).toISOString(), repeatReason: null });
  now += 5000;
  await tickPipelines([finishReported(h, attempt.agentPath!, "pass", "Change delivered")], h.ports);
  stored = loadPipelines()[0]!;
  const ended = stored.runs[0]!.attempts[0]!;
  expect(ended.completedAt).not.toBeNull();
  expect(ended.accounting!.time).toMatchObject({ intervalMs: 5000, unknownMs: 5000, modelMs: null, toolsMs: null, toleranceMs: 0 });
  expect(isStoredPipeline(JSON.parse(JSON.stringify(stored)))).toBe(true);
  savePipelines([stored]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting).toEqual(ended.accounting);
});
test("lane class is captured before effects and malformed declarations refuse without spawning", async () => {
  const h = harness();
  savePipelines([]);
  const request = { task: "Deliver change", spec: "Example succeeds", repoDir: "/repo", stages: BUILD_ONLY, src: "/codex/creator.jsonl", autoStart: false };
  const result = await createPipelineFromRequest({ ...request, taskClass: { size: "small", money: false, access: true, dataMigration: null } } as never, h.ports);
  expect(result.pipeline?.taskClass).toEqual({ project: "viewer", size: "small", money: false, access: true, dataMigration: null });
  const before = h.calls.length;
  expect((await createPipelineFromRequest({ ...request, taskClass: { access: "yes" } } as never, h.ports)).status).toBe(400);
  expect(h.calls).toHaveLength(before);
});
test("unknown and declared operator repeat causes persist through the real retry action", async () => {
  for (const repeatReason of [undefined, ...REPEAT_REASONS]) {
    const h = harness();
    await create(h.ports, BUILD_ONLY as never);
    await tickPipelines([], h.ports); await tickPipelines([], h.ports);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.state = "failed"; attempt.completedAt = h.ports.now();
    lane.state = "needs_decision"; lane.cursor!.state = "running";
    h.ports.paneAgentAlive = async () => false;
    savePipelines([lane]);
    const result = await patchPipeline(lane.id, { action: "retry-stage", repeatReason }, h.ports);
    expect(result.error).toBeUndefined();
    await tickPipelines([], h.ports);
    const next = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(next.n).toBe(2);
    expect(next.accounting!.repeatReason).toBe(repeatReason ?? "unknown");
    expect(isStoredPipeline(loadPipelines()[0])).toBe(true);
  }
});


test("reopening an attempt clears its old split and a later completion records its new interval", async () => {
  const h = harness();
  h.ports.now = () => new Date(1_000_000).toISOString();
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  let lane = loadPipelines()[0]!;
  let attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = "failed"; attempt.completedAt = new Date(1_001_000).toISOString();
  lane.state = "needs_decision";
  savePipelines([lane]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.time!.intervalMs).toBe(1000);
  lane = loadPipelines()[0]!; attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = "running"; attempt.completedAt = null; lane.state = "running";
  savePipelines([lane]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.time).toBeNull();
  lane = loadPipelines()[0]!; attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = "failed"; attempt.completedAt = new Date(1_003_000).toISOString(); lane.state = "needs_decision";
  savePipelines([lane]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.time).toMatchObject({ intervalMs: 3000, unknownMs: 3000 });
  lane = loadPipelines()[0]!; attempt = lane.runs[0]!.attempts[0]!;
  attempt.completedAt = new Date(1_004_000).toISOString(); savePipelines([lane]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.time!.intervalMs).toBe(4000);
});
