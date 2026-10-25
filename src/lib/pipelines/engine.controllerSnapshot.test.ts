import { expect, test, harness, create, loadPipelines, savePipelines, tickPipelines } from "./engine.fixture";
import { pipelineIdentity, withPipelineMutation } from "./store";
import { spyOn } from "bun:test";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";

test("a tick with retained attempt history materializes settled lanes only for its returned snapshot", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const active = loadPipelines()[0]!;
  const retained = Array.from({ length: 1_000 }, (_, n) => {
    const lane = structuredClone(active);
    lane.id = `retained-${n}`;
    Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir));
    lane.state = "closed";
    lane.closedAt = "2026-10-14T00:00:00.000Z";
    lane.cursor = null;
    lane.delivery = undefined;
    lane.publication = "internal";
    lane.runs.forEach(run => { if (run.attempts.length) run.attempts = Array.from({ length: 16 }, (_, i) => ({ ...run.attempts[0]!, n: i + 1,
      launchId: null, state: "failed", verdict: { status: "fail", findings: [] }, completedAt: lane.closedAt })); });
    lane.terminalReap = { rounds: 1, stopped: 0, lastAt: lane.closedAt, settledAt: lane.closedAt,
      settledAttempts: lane.runs.flatMap(run => run.attempts.map(attempt => `${run.stageId}:${attempt.n}`)) };
    return lane;
  });
  savePipelines([active, ...retained]);
  const before = loadPipelines();
  const snapshots = spyOn(SqliteStateCollection.prototype, "snapshot");
  const calls = [...h.calls];
  let result: Awaited<ReturnType<typeof tickPipelines>>;
  try {
    result = await tickPipelines([], h.ports);
    expect(snapshots.mock.calls.length).toBeLessThanOrEqual(2);
  } finally { snapshots.mockRestore(); }
  expect(result!.pipelines.filter(lane => lane.id.startsWith("retained-"))).toEqual(before.slice(1));
  expect(h.calls).toEqual(calls);
}, 30_000);

test("a controller evidence reply cannot overwrite a concurrent lane edit or trigger recovery", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.historical = true;
  lane.state = "paused";
  savePipelines([lane]);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const evidence = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  h.ports.durableTurnEvidence = async () => {
    reads++;
    entered();
    await evidence;
    return { turn: "terminal", message: { text: '```json\n{"status":"pass"}\n```', ts: Date.now() } };
  };
  const callsBefore = [...h.calls];
  const tick = tickPipelines([], h.ports);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([reading, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("evidence read did not start")), 1000); })]);
    await withPipelineMutation(async (rows, persist) => {
      rows[0]!.stateDetail = "operator edit during evidence";
      await persist([rows[0]!]);
    });
  } finally { if (timer) clearTimeout(timer); release(); await tick; }
  expect(reads).toBe(1);
  expect(loadPipelines()[0]).toMatchObject({ state: "paused", stateDetail: "operator edit during evidence" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  expect(h.calls).toEqual(callsBefore);
});
