import { expect, test, spyOn, crypto, harness, create, BUILD_ONLY, tickPipelines, patchPipeline,
  loadPipelines, savePipelines, Database, path, realExec } from "./engine.fixture";
import { tickPipelinesController } from "./controllerPass";
import { withPipelineMutation } from "./store";

async function pausedLane() {
  const h = harness();
  let now = Date.parse("2026-11-01T12:00:00.000Z");
  h.ports.now = () => new Date(now).toISOString();
  h.ports.monotonicNow = () => 0;
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `94000001-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`);
  try { await create(h.ports, BUILD_ONLY as never, { publication: "internal" }); }
  finally { ids.mockRestore(); }
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect((await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, h.ports)).error).toBeUndefined();
  h.setPaneAlive(false);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.suspension?.stoppedAt).toBeDefined();
  return { h, id: loadPipelines()[0]!.id, advance: () => { now += 31_000; } };
}

function observeRow(id: string) {
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  db.query("DELETE FROM history_pending WHERE collection='pipelines' AND row_key=?").run(id);
  // Count every enqueue, even if another projection reader drains it again.
  db.exec(`CREATE TABLE IF NOT EXISTS fixture_history_arrivals(row_key TEXT);
    DELETE FROM fixture_history_arrivals;
    CREATE TRIGGER IF NOT EXISTS fixture_history_arrival AFTER INSERT ON history_pending
    WHEN NEW.collection='pipelines' BEGIN
      INSERT INTO fixture_history_arrivals VALUES(NEW.row_key);
    END`);
  const row = () => db.query<{ row_revision: number; value_json: string }, [string]>(
    "SELECT row_revision,value_json FROM state_rows WHERE collection='pipelines' AND row_key=?").get(id)!;
  const arrivals = () => db.query<{ n: number }, [string]>(
    "SELECT count(*) AS n FROM fixture_history_arrivals WHERE row_key=?").get(id)!.n;
  return { db, row, arrivals };
}

test.each(["settled", "withdrawal-failed", "delivery-pending"])(
  "a paused lane keeps its row and history queue unchanged across controller ticks: %s", async mode => {
    const f = await pausedLane();
    let withdrawals = 0;
    f.h.ports.invalidateProviderContinuation = async () => {
      withdrawals++;
      if (mode === "withdrawal-failed") throw new Error("fixture continuation unavailable");
    };
    f.h.ports.conversationDeliveryOutstanding = () => mode === "delivery-pending";
    // Record the actual failure/pending reason once before measuring repeats.
    await tickPipelines([], f.h.ports);
    const observation = observeRow(f.id);
    try {
      const before = observation.row();
      const stops = f.h.calls.filter(call => call.startsWith("stop-host:")).length;
      for (let tick = 0; tick < 5; tick++) {
        f.advance();
        await tickPipelinesController([], f.h.ports);
        expect(observation.row()).toEqual(before);
        expect(observation.arrivals()).toBe(0);
      }
      expect(withdrawals).toBeGreaterThan(1);
      expect(f.h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(stops);
      if (mode === "settled") {
        const restarted = await realExec(process.execPath, ["-e", `
          import { defaultPipelinePorts, tickPipelines } from "@/lib/pipelines/engine";
          import { tickPipelinesController } from "@/lib/pipelines/controllerPass";
          import { registerPipelineTick } from "@/lib/pipelines/controllerSignal";
          registerPipelineTick(async () => {});
          let stops = 0, withdrawals = 0, now = Date.parse("2026-11-02T12:00:00Z");
          const ports = { ...defaultPipelinePorts(), now: () => new Date(now).toISOString(),
            monotonicNow: () => 0, stageHostResident: async () => false, paneAgentAlive: async () => false,
            conversationGeneration: () => null, pathForConversation: () => null, accountExhausted: () => false,
            allowedAccountIds: () => null, durableTurnEvidence: async () => null,
            invalidateProviderContinuation: async () => { withdrawals++; },
            conversationDeliveryOutstanding: () => false,
            stopStageAgent: async () => { stops++; return { outcome: "not-running" }; },
            exec: async () => { throw new Error("unexpected restart effect"); },
            spawnAgent: async () => { throw new Error("unexpected restart spawn"); } };
          for (let tick = 0; tick < 3; tick++) { now += 31_000; await tickPipelinesController([], ports); }
          console.log(JSON.stringify({ stops, withdrawals }));
        `], process.cwd(), { LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, { timeoutMs: 30_000 });
        expect(restarted.code, restarted.stderr).toBe(0);
        expect(JSON.parse(restarted.stdout.trim())).toEqual({ stops: 0, withdrawals: 3 });
        expect(observation.row()).toEqual(before);
        expect(observation.arrivals()).toBe(0);
      }
      await withPipelineMutation(async (rows, persist) => {
        const lane = rows.find(row => row.id === f.id)!;
        lane.stateDetail = "recorded operator note";
        await persist([lane]);
      });
      expect(observation.arrivals()).toBe(1);
      expect(observation.row().row_revision).toBe(before.row_revision + 1);
      expect(loadPipelines()[0]!.stateDetail).toBe("recorded operator note");
    } finally { observation.db.close(); }
  });

test("a completed lane has no repeated row write and still records a real change", async () => {
  const f = await pausedLane();
  const lane = loadPipelines()[0]!;
  lane.state = "completed";
  lane.cursor = null;
  lane.closedAt = f.h.ports.now();
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = "passed";
  attempt.verdict = { status: "pass", findings: [] };
  attempt.completedAt = lane.closedAt;
  lane.merge = { state: "blocked", by: null, repository: "example/project", prNumber: 1,
    policyChangedAt: lane.closedAt, reviewedHead: lane.lastPassedCommit, chain: [lane.lastPassedCommit],
    updates: [], seenChecks: [], head: null, headSeenAt: null, lastChecks: null, readAt: null, nextReadAt: null,
    readFailures: 0, requestedAt: lane.closedAt, mergedHead: null, mergeCommit: null, method: null, mergedAt: null,
    attempts: 0, reason: "waiting for review", blockedAt: lane.closedAt, updatedAt: lane.closedAt };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  const observation = observeRow(f.id);
  try {
    const before = observation.row();
    for (let tick = 0; tick < 5; tick++) {
      f.advance();
      await tickPipelinesController([], f.h.ports);
      expect(observation.row()).toEqual(before);
      expect(observation.arrivals()).toBe(0);
    }
    await withPipelineMutation(async (rows, persist) => {
      rows[0]!.merge!.state = "cancelled";
      await persist([rows[0]!]);
      await persist([rows[0]!]);
    });
    expect(observation.arrivals()).toBe(1);
    expect(observation.row().row_revision).toBe(before.row_revision + 1);
    expect(loadPipelines()[0]!.merge!.state).toBe("cancelled");
  } finally { observation.db.close(); }
});

test.each(["resume", "close"] as const)("retaining a stopped receipt still allows %s", async action => {
  const f = await pausedLane();
  const observation = observeRow(f.id);
  try {
    const before = observation.row();
    f.advance();
    expect((await patchPipeline(f.id, { action }, f.h.ports)).error).toBeUndefined();
    expect(observation.row().row_revision).toBeGreaterThan(before.row_revision);
    expect(observation.arrivals()).toBe(1);
    expect(loadPipelines()[0]!.state).toBe(action === "resume" ? "running" : "closed");
  } finally { observation.db.close(); }
});

test("a host resumed during continuation withdrawal receives a fresh stop", async () => {
  const f = await pausedLane();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.h.ports.invalidateProviderContinuation = async () => { entered(); await held; };
  let stops = 0;
  f.h.ports.stopStageAgent = async () => { stops++; return { outcome: "stopped" }; };
  const ticking = tickPipelines([], f.h.ports);
  try {
    await waiting;
    f.h.setHostsResident(true);
  } finally { release(); await ticking; }
  expect(stops).toBe(1);
});

test("a failed fresh stop keeps its operation key for recovery", async () => {
  const f = await pausedLane();
  f.h.setHostsResident(true);
  const operations: Array<string | undefined> = [];
  f.h.ports.stopStageAgent = async (_target, options) => {
    operations.push(options?.operationId);
    if (operations.length === 1) return { outcome: "failed", error: "fixture stop unavailable" };
    f.h.setHostsResident(false);
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.suspension!.stoppedAt).toBeUndefined();
  expect(loadPipelines()[0]!.stateDetail).toContain("fixture stop unavailable");
  await tickPipelines([], f.h.ports);
  expect(operations).toHaveLength(2);
  expect(operations[1]).toBe(operations[0]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.suspension!.stoppedAt).toBeDefined();
});

test.each(["host", "pane"])("a reappearing %s invalidates the retained stop before stopping it", async kind => {
  const f = await pausedLane();
  const before = loadPipelines()[0]!.runs[0]!.attempts[0]!.suspension!;
  if (kind === "host") f.h.ports.stageHostResident = async () => true;
  else f.h.setPaneAlive(true);
  let stops = 0;
  f.h.ports.stopStageAgent = async (_target, options) => {
    stops++;
    const durable = loadPipelines()[0]!.runs[0]!.attempts[0]!.suspension!;
    expect(durable.stoppedAt).toBeUndefined();
    expect(durable.stopRevision).toBe((before.stopRevision ?? 0) + 1);
    expect(options?.operationId).toEndWith(`-${durable.stopRevision}`);
    f.h.ports.stageHostResident = async () => false;
    f.h.setPaneAlive(false);
    return { outcome: "stopped" };
  };
  f.advance();
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.suspension!.stoppedAt).not.toBe(before.stoppedAt);
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(1);
});
