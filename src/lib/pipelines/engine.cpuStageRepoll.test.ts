import { BUILD_ONLY, create, crypto, Database, expect, harness, loadPipelines, path,
  savePipelines, test, tickPipelines } from "./engine.fixture";
import { tickPipelinesController } from "./controllerPass";
import { setSystemTime } from "bun:test";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { CpuAdmissionQueue, CPU_STAGE_POLL_MS } from "@/lib/runtime/cpuAdmission";
import { DEFAULT_CPU_PRESSURE_POLICY } from "@/lib/runtime/cpuPressure";
import { stateDir } from "@/lib/configDir";
import type { UrgentStagePoll } from "@/lib/runtime/urgentStageCapacity";
import { acknowledgePipelineControllerWork, selectPipelineControllerWork } from "./store";

test("a CPU-held third attempt keeps a durable five-second repoll and starts exactly once", async () => {
  const h = harness();
  const start = Date.parse("2026-11-18T00:00:00.000Z");
  let now = start;
  let allows = false;
  let pendingStage: UrgentStagePoll | undefined;
  const lock = path.join(stateDir(), "stage-repoll.sqlite");
  const queue = new CpuAdmissionQueue(lock, () => now);
  const reads: Array<{ key: string; at: number }> = [];
  const wakes: number[] = [];
  h.ports.now = () => new Date(now).toISOString();
  h.ports.scheduleTick = delay => { wakes.push(delay); };
  h.ports.cpuPressureHold = (key, source, urgentStage) => {
    if (!key) throw new Error("missing stage CPU key");
    reads.push({ key, at: now });
    if (key.endsWith(":build:3")) pendingStage = urgentStage;
    const wait = queue.check(key, allows, undefined, true, source);
    return wait ? { since: wait.since, avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY, queue: wait } : null;
  };
  setSystemTime(new Date(start));
  try {
    const { id } = await create(h.ports, BUILD_ONLY as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const lane = loadPipelines().find(pipeline => pipeline.id === id)!;
    const attempt = lane.runs[0]!.attempts.at(-1)!;
    expect(attempt.state).toBe("pending");
    for (const { key } of reads) queue.cancel(key);
    reads.length = 0;
    wakes.length = 0;
    const retryAccounting = { ...attempt.accounting!, repeatReason: "restart" as const };
    lane.runs[0]!.attempts = [
      { ...attempt, n: 1, state: "failed", historical: true },
      { ...attempt, n: 2, state: "failed", historical: true, accounting: { ...retryAccounting } },
      { ...attempt, n: 3, accounting: { ...retryAccounting } },
    ];
    savePipelines([lane]);
    const stageKey = `stage:${crypto.createHash("sha256").update(stateDir()).digest("hex")}:${lane.id}:build:3`;
    const schedule = new Database(path.join(stateDir(), "state.sqlite"));
    const tickets = new Database(lock, { readonly: true });
    try {
      await tickPipelinesController([], h.ports);
      await tickPipelinesController([], h.ports);
      const row = schedule.query("SELECT dirty, due_at FROM pipeline_tick_work WHERE row_key = ?");
      const ticket = tickets.query("SELECT fifo_seq, since, polled FROM tickets WHERE key = ?");
      expect(h.spawnInputs).toHaveLength(0);
      expect(reads).toContainEqual({ key: stageKey, at: start });
      expect(wakes).toContain(CPU_STAGE_POLL_MS);
      expect(row.get(lane.id)).toEqual({ dirty: 0, due_at: start + CPU_STAGE_POLL_MS });
      const before = ticket.get(stageKey) as { fifo_seq: number; since: number; polled: number };
      expect(before).toMatchObject({ since: start, polled: start });
      now += CPU_STAGE_POLL_MS;
      await tickPipelinesController([], h.ports);
      expect(ticket.get(stageKey)).toEqual({ ...before, polled: now });
      expect(row.get(lane.id)).toEqual({ dirty: 0, due_at: now + CPU_STAGE_POLL_MS });
      expect(h.spawnInputs).toHaveLength(0);
      const current = pendingStage;
      const revision = current?.currentRevision();
      if (!current || !revision) throw new Error("the third pending attempt has no revision-bound CPU wake");
      const expires = Date.now() + CPU_STAGE_POLL_MS;
      expect(await current.makeDue(revision, Date.now() - 1)).toBeNull();
      schedule.query(`UPDATE state_rows SET value_json=json_set(value_json,'$.fixturePeerRevision',1)
        WHERE collection='pipelines' AND row_key=?`).run(lane.id);
      expect(await current.makeDue(revision, expires)).toBeNull();
      const changed = current.currentRevision();
      if (!changed) throw new Error("the edited pending attempt is missing");
      const previousSelection = (await selectPipelineControllerWork(now, [])).find(item => item.row_key === lane.id);
      if (!previousSelection) throw new Error("the pending attempt is missing from the durable selector");
      const readyRevision = await current.makeDue(changed, expires);
      expect(readyRevision).not.toBeNull();
      expect(current.currentRevision()).toBe(readyRevision);
      await acknowledgePipelineControllerWork(previousSelection, 0, now + 30_000);
      expect(row.get(lane.id)).toEqual({ dirty: 1, due_at: 0 });
      now += CPU_STAGE_POLL_MS;
      allows = true;
      await tickPipelinesController([], h.ports);
      await tickPipelinesController([], h.ports);
      expect(h.spawnInputs).toHaveLength(1);
      expect(loadPipelines().find(pipeline => pipeline.id === id)?.runs[0]?.attempts.at(-1)).toMatchObject({ n: 3, state: "running" });
    } finally { tickets.close(); schedule.close(); }
  } finally { setSystemTime(); await settlePipelineControllerJobs(); queue.close(); savePipelines([]); }
});
