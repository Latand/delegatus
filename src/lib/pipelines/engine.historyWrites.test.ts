import { expect, test, spyOn, crypto, harness, create, BUILD_ONLY, tickPipelines, patchPipeline,
  loadPipelines, savePipelines, Database, path, realExec, recoveryReport, ORIGIN_MAIN_SHA, entry } from "./engine.fixture";
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


async function capacityLane() {
  const h = harness();
  let now = Date.parse("2026-11-01T12:00:00.000Z");
  h.ports.now = () => new Date(now).toISOString();
  h.ports.monotonicNow = () => 0;
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `95000001-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`);
  try { await create(h.ports, [{ ...BUILD_ONLY[0]!, id: "refresh" }] as never, { publication: "internal" }); }
  finally { ids.mockRestore(); }
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const child = loadPipelines()[0]!;
  const parent = structuredClone(child);
  parent.id = "capacity-origin";
  parent.worktreeDir = parent.worktreeDir.replace(child.id, parent.id);
  parent.branch = parent.branch.replace(child.id, parent.id);
  if (parent.delivery) { parent.delivery.active = false; parent.delivery.ownerId = parent.id; }
  parent.state = "completed";
  parent.cursor = null;
  parent.runs = parent.runs.map(run => ({ ...run, attempts: [] }));
  parent.closedAt = h.ports.now();
  const { refreshReservation } = await import("@/lib/forge/autoRefresh");
  parent.merge = { state: "refreshing", by: null, repository: "example/project", prNumber: 1,
    policyChangedAt: parent.closedAt, reviewedHead: child.lastPassedCommit, chain: [child.lastPassedCommit],
    updates: [], seenChecks: [], head: null, headSeenAt: null, lastChecks: null, readAt: null, nextReadAt: null,
    readFailures: 0, requestedAt: parent.closedAt, mergedHead: null, mergeCommit: null, method: null, mergedAt: null,
    attempts: 0, reason: null, blockedAt: null, updatedAt: parent.closedAt };
  parent.merge.refresh = refreshReservation(parent, "a".repeat(40), child.lastPassedCommit, now, "main");
  parent.merge.refresh.pipelineId = child.id;
  child.creationRequest = { key: parent.merge.refresh.key, digest: parent.merge.refresh.digest };
  child.refreshOf = { pipelineId: parent.id, base: parent.merge.refresh.base };
  const { isStoredPipeline } = await import("./store");
  expect(isStoredPipeline(child), JSON.stringify(child)).toBe(true);
  expect(isStoredPipeline(parent), JSON.stringify(parent)).toBe(true);
  savePipelines([child, parent]);
  h.setPaneAlive(false);
  h.ports.invalidateProviderContinuation = async () => {};
  h.ports.conversationDeliveryOutstanding = () => false;
  h.ports.stageHostTreeStillRunning = () => null;
  h.ports.stageHostPresence = async target => await h.ports.stageHostResident(target) ? "resident" : "absent";
  h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null, backgroundTasks: [] });
  return { h, id: child.id, advance: (ms: number) => { now += ms; },
    lane: () => loadPipelines().find(row => row.id === child.id)! };
}

test("an active refresh reaches a durable settled capacity yield at its original budget", async () => {
  const f = await capacityLane();
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.lane().state).toBe("paused");
  expect(f.lane().runs[0]!.attempts[0]!.suspension).toMatchObject({
    capacityYield: { reservationKey: f.lane().creationRequest!.key, settledAt: f.h.ports.now() },
  });
  expect(f.h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(1);
  expect(f.lane().runs[0]!.attempts[0]!.verdict).toBeNull();
});


const yieldedAttempt = (f: Awaited<ReturnType<typeof capacityLane>>) => f.lane().runs[0]!.attempts[0]!;

test.each(["failed", "deferred", "unconfirmed", "unresolved"] as const)("capacity retains UNKNOWN stop and never resends after %s", async outcome => {
  const f = await capacityLane();
  let stops = 0, withdrawals = 0;
  f.h.ports.invalidateProviderContinuation = async () => { withdrawals++; };
  f.h.ports.stopStageAgent = async () => {
    stops++;
    return { outcome, error: "fixture stop refused", operationId: "original-stop", detail: "fixture uncertain stop", survivors: [] } as never;
  };
  f.h.ports.suspensionStopReceipt = async () => null;
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeUndefined();
  const key = yieldedAttempt(f).suspension?.capacityYield?.reservationKey;
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(1);
  const repeatedPause = await patchPipeline(f.id, { action: "pause", reason: "repeat UNKNOWN pause" }, f.h.ports);
  expect(repeatedPause.error).toBeUndefined();
  expect(stops).toBe(1);
  expect(withdrawals).toBe(1);
  expect(yieldedAttempt(f).suspension?.capacityYield?.reservationKey).toBe(key);
  expect(f.lane().stateDetail).toContain("UNKNOWN");
  const { holdsRefreshCapacity } = await import("./refreshCapacity");
  for (const state of ["paused", "needs_decision", "closed"] as const) {
    expect(holdsRefreshCapacity({ ...f.lane(), state })).toBe(true);
  }
});

async function structuredCapacityLane() {
  const f = await capacityLane();
  const lane = f.lane();
  Object.assign(lane.runs[0]!.attempts[0]!, { sessionId: "capacity-session", conversationId: "conversation_capacity",
    agentPath: path.join(lane.worktreeDir, "transcript.jsonl"), launchId: "capacity-launch", paneId: null,
    historical: false, state: "running" });
  lane.state = "running";
  savePipelines([lane, ...loadPipelines().filter(row => row.id !== lane.id)]);
  f.h.setConversationActive(false);
  return f;
}

test.each(["transcript", "admission", "unexpired"] as const)("refresh verdict continuation respects its budget at %s", async boundary => {
  const f = await structuredCapacityLane();
  const sends: string[] = [];
  let admissions = 0, reads = 0;
  f.advance(60 * 60_000 - 1);
  f.h.ports.durableTurnEvidence = async () => {
    reads++;
    if (boundary === "transcript") f.advance(1);
    return { turn: "terminal", message: { text: "Stage work is complete.", ts: Date.parse("2026-11-01T12:00:01.000Z") }, backgroundTasks: [] };
  };
  f.h.ports.resumeSeveredTurn = async input => {
    admissions++;
    if (boundary === "admission") f.advance(1);
    if (input.continuationAllowed && !await input.continuationAllowed()) return false;
    sends.push(input.clientMessageId);
    return true;
  };
  await tickPipelines([], f.h.ports);
  expect(reads).toBeGreaterThan(0);
  if (boundary === "unexpired") {
    expect(admissions).toBe(1);
    expect(sends).toEqual([`stage-verdict-request-${f.id}-refresh-1-${Date.parse("2026-11-01T12:00:01.000Z")}`]);
    expect(yieldedAttempt(f).verdictRequest?.requestedAt).toBe(f.h.ports.now());
    return;
  }
  expect(sends).toEqual([]);
  expect(admissions).toBe(boundary === "transcript" ? 0 : 1);
  expect(yieldedAttempt(f).verdictRequest?.requestedAt).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(sends).toEqual([]);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeDefined();
  expect(yieldedAttempt(f).verdict).toBeNull();
});

const verdictAuthorityChanges = ["owner", "epoch", "control", "launch", "target", "input", "requirements", "policy", "merge-policy", "reservation"] as const;
test.each(["transcript", "admission"].flatMap(boundary => verdictAuthorityChanges.map(change => [boundary, change] as const)))(
  "refresh verdict continuation refuses changed authority at %s: %s", async (boundary, change) => {
    const f = await structuredCapacityLane();
    const settings = await import("@/lib/projects/settings");
    let mergePolicy = settings.mergeOnReviewSetting(f.lane().project);
    const setting = spyOn(settings, "mergeOnReviewSetting").mockImplementation(() => mergePolicy);
    let pool: string[] | null = null;
    f.h.ports.allowedAccountIds = () => pool;
    let changed = false, sends = 0, admissions = 0;
    const replaceAuthority = () => {
      if (changed) return;
      changed = true;
      if (change === "policy") { pool = ["replacement-account"]; return; }
      if (change === "merge-policy") { mergePolicy = { ...mergePolicy, enabled: !mergePolicy.enabled }; return; }
      const rows = loadPipelines(), lane = rows.find(row => row.id === f.id)!;
      const attempt = lane.runs[0]!.attempts[0]!;
      if (change === "owner") { lane.delivery!.active = false; lane.delivery!.ownerId = "replacement"; }
      if (change === "epoch") lane.delivery!.epoch++;
      if (change === "control") lane.controlGeneration = "replacement-control";
      if (change === "launch") attempt.launchId = "replacement-launch";
      if (change === "target") lane.delivery!.target.branch = "refs/heads/replacement";
      if (change === "input") attempt.input = "replacement input";
      if (change === "requirements") lane.spec = "replacement requirements";
      if (change === "reservation") lane.refreshOf!.capacity!.deadline = "2026-11-02T13:00:00.000Z";
      savePipelines(rows);
    };
    f.h.ports.durableTurnEvidence = async () => {
      await Promise.resolve();
      if (boundary === "transcript") replaceAuthority();
      return { turn: "terminal", message: { text: "Stage work is complete.", ts: Date.parse("2026-11-01T12:00:01.000Z") }, backgroundTasks: [] };
    };
    f.h.ports.resumeSeveredTurn = async input => {
      admissions++;
      await Promise.resolve();
      if (boundary === "admission") replaceAuthority();
      if (input.continuationAllowed && !await input.continuationAllowed()) return false;
      sends++;
      return true;
    };
    try {
      await tickPipelines([], f.h.ports);
      expect(changed).toBe(true);
      expect(sends).toBe(0);
      expect(admissions).toBe(boundary === "transcript" ? 0 : 1);
      expect(yieldedAttempt(f).verdictRequest?.requestedAt).toBeUndefined();
    } finally { setting.mockRestore(); }
  });

test.each(["expired", "unexpired", "replay"] as const)("runtime-switch refresh continuation uses a fresh admission: %s", async outcome => {
  const f = await structuredCapacityLane();
  const attempt = yieldedAttempt(f);
  let continuations = 0, receiptReads = 0;
  let reconfigured = false;
  f.h.ports.runtimeSwitchControl = async (_conversationId, _path, action) => {
    if (action === "reconfigure") { reconfigured = true; if (outcome === "expired") f.advance(60 * 60_000); }
  };
  f.h.ports.runtimeSwitchOutcome = async () => ({ state: "applied" });
  f.h.ports.runtimeSwitchDelivery = () => {
    receiptReads++;
    return outcome === "replay" || continuations > 0
      ? { state: "delivered", at: f.h.ports.now() } : { state: "pending", admitted: false };
  };
  f.h.ports.conversationGeneration = () => ({ engine: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: null,
    accountId: "default", sessionId: "session-new", agentPath: attempt.agentPath! });
  f.h.ports.resumeSeveredTurn = async () => { continuations++; return true; };
  const result = await patchPipeline(f.id, { action: "override-stage", stageId: "refresh", model: "gpt-6.1-sol", applyNow: true }, f.h.ports);
  expect(result.error).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(reconfigured).toBe(true);
  expect(receiptReads).toBeGreaterThan(0);
  expect(continuations).toBe(outcome === "unexpired" ? 1 : 0);
  if (outcome === "expired") expect(f.h.ports.now()).toBe("2026-11-01T13:00:00.000Z");
});

test.each(["background", "unreadable", "tree", "delivery", "withdrawal"] as const)("capacity waits for positive owned-work proof: %s", async kind => {
  const f = await capacityLane();
  let held = true, stops = 0;
  f.h.ports.stopStageAgent = async () => { stops++; return { outcome: "stopped" }; };
  f.h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null,
    ...(held && kind === "unreadable" ? {} : { backgroundTasks: held && kind === "background"
      ? [{ id: "own-command", kind: "command", startedAt: 1, expiresAt: null }] : [] }) });
  f.h.ports.stageHostTreeStillRunning = () => held && kind === "tree" ? "own surviving check" : null;
  f.h.ports.conversationDeliveryOutstanding = () => held && kind === "delivery";
  f.h.ports.invalidateProviderContinuation = async () => { if (held && kind === "withdrawal") throw new Error("withdrawal unavailable"); };
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension?.stoppedAt).toBeDefined();
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeUndefined();
  held = false;
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeDefined();
  expect(stops).toBe(1);
  expect(yieldedAttempt(f).verdict).toBeNull();
});

test.each(["control", "owner", "epoch", "launch", "target", "requirements", "policy"] as const)("capacity stop refuses a last-await authority change: %s", async change => {
  const f = await capacityLane();
  let stops = 0;
  f.h.ports.stopStageAgent = async () => { stops++; return { outcome: "stopped" }; };
  let pool: string[] | null = null;
  f.h.ports.allowedAccountIds = () => pool;
  f.h.ports.invalidateProviderContinuation = async () => {
    await Promise.resolve();
    if (change === "policy") { pool = ["replacement-account"]; return; }
    await withPipelineMutation(async (rows, persist) => {
      const lane = rows.find(row => row.id === f.id)!;
      const attempt = lane.runs[0]!.attempts[0]!;
      if (change === "control") lane.controlGeneration = "new-control";
      if (change === "owner") { lane.delivery!.active = false; lane.delivery!.ownerId = "replacement"; }
      if (change === "epoch") lane.delivery!.epoch++;
      if (change === "launch") attempt.launchId = "replacement-launch";
      if (change === "target") lane.delivery!.target.branch = "refs/heads/replacement";
      if (change === "requirements") lane.spec = "new requirements";
      await persist([lane]);
    });
  };
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(0);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeUndefined();
});

test.each(["before-stop", "during-stop", "final-head"] as const)("capacity settles an authoritative report once at %s", async boundary => {
  const f = await capacityLane();
  let terminal = false, filed = false;
  const report = async () => {
    if (filed) return;
    filed = true; terminal = true;
    await withPipelineMutation(async (rows, persist) => {
      const lane = rows.find(row => row.id === f.id)!;
      const attempt = lane.runs[0]!.attempts[0]!;
      attempt.report = { ...recoveryReport(f.h.ports.now()), provenance: { head: ORIGIN_MAIN_SHA, branch: lane.branch,
        uncommitted: [], pullRequest: null, outputs: [] } };
      await persist([lane]);
    });
  };
  f.h.ports.durableTurnEvidence = async () => {
    if (boundary === "before-stop") await report();
    return { turn: terminal ? "terminal" : "busy", message: null, lastRecordAt: Date.parse(f.h.ports.now()), backgroundTasks: [] };
  };
  f.h.ports.stopStageAgent = async () => { if (boundary === "during-stop") await report(); return { outcome: "stopped" }; };
  const exec = f.h.ports.exec;
  let reads = 0;
  f.h.ports.exec = async (...args) => {
    const result = await exec(...args);
    if (args[1][0] === "rev-parse" && args[1].includes("HEAD") && ++reads === 2 && boundary === "final-head") await report();
    return result;
  };
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(filed).toBe(true);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeDefined();
  expect(yieldedAttempt(f).verdict?.status).toBe("pass");
  expect(f.lane().runs[0]!.attempts).toHaveLength(1);
});

test("capacity deadline cannot be extended by a valid-looking capsule or resume", async () => {
  const f = await capacityLane();
  await tickPipelines([], f.h.ports);
  const capsule = { ...f.lane().refreshOf!.capacity! };
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  const before = f.lane();
  expect((await patchPipeline(f.id, { action: "resume" }, f.h.ports)).error).toContain("budget expired");
  expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toContain("budget expired");
  expect(f.lane()).toEqual(before);
  const rows = loadPipelines();
  rows.find(row => row.id === f.id)!.refreshOf!.capacity!.deadline = "2026-11-02T13:00:00.000Z";
  savePipelines(rows);
  await tickPipelines([], f.h.ports);
  expect(f.lane().refreshOf!.capacity).toMatchObject({ ...capsule, deadline: "2026-11-02T13:00:00.000Z" });
  expect(f.lane().refreshOf!.capacityRefusal).toContain("conflicts with the original");
});

test("settled capacity yield has stable history and reappearance alone renews stop proof", async () => {
  const f = await capacityLane();
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  const observation = observeRow(f.id);
  try {
    const before = observation.row();
    for (let tick = 0; tick < 3; tick++) { f.advance(60_000); await tickPipelinesController([], f.h.ports); }
    expect(observation.row()).toEqual(before);
    expect(observation.arrivals()).toBe(0);
    f.h.setHostsResident(true);
    f.h.ports.stopStageAgent = async () => { f.h.setHostsResident(false); return { outcome: "stopped" }; };
    await tickPipelines([], f.h.ports);
    expect(yieldedAttempt(f).suspension!.stopRevision).toBe(1);
    expect(yieldedAttempt(f).suspension!.capacityYield!.deadline).toBe("2026-11-01T13:00:00.000Z");
    expect(yieldedAttempt(f).suspension!.capacityYield!.settledAt).toBe(f.h.ports.now());
  } finally { observation.db.close(); }
});

test.each(["none", "requirements", "control", "policy", "unlink-task", "clear-finishes"] as const)(
  "a second conflicted PR is admitted after confirmed stop and its creator fences %s changes",
  async change => {
  const f = await capacityLane();
  const { sweepAutoMerge, resetAutoMergeForTests, MERGE_POLL_MS } = await import("@/lib/forge/autoMerge");
  const { createPipelineFromRequest } = await import("./engine");
  resetAutoMergeForTests();
  const rows = loadPipelines();
  const origin = rows.find(row => row.id === "capacity-origin")!;
  const second = structuredClone(origin);
  second.id = "second-pr";
  second.worktreeDir = origin.worktreeDir.replace(origin.id, second.id);
  second.branch = origin.branch.replace(origin.id, second.id);
  second.delivery!.target.branch = "refs/heads/second-pr";
  second.delivery!.target.pr = 2;
  second.delivery!.ownerId = second.id;
  second.merge!.prNumber = 2;
  second.merge!.state = "queued";
  delete second.merge!.refresh;
  if (change === "unlink-task" || change === "clear-finishes") {
    const { saveTasks } = await import("@/lib/tasks/store");
    const now = f.h.ports.now();
    saveTasks([{ id: "capacity-task", project: second.project, text: "Refresh task", status: "inbox", placement: "unplaced",
      assignments: [], createdAt: now, updatedAt: now }]);
    second.taskIds = ["capacity-task"];
    second.finishesTaskIds = ["capacity-task"];
  }
  const fix = { ...structuredClone(second.stages[0]!), id: "fix" };
  const review = second.stages[0]!;
  review.id = "review";
  review.onFail = { to: "fix", maxRounds: 1 };
  second.stages.push(fix);
  review.role = { roleId: "reviewer" };
  review.access = "read-only";
  review.effectiveRole = { ...review.effectiveRole, roleId: "reviewer", access: "read-only" };
  second.runs = [{ stageId: "review", attempts: [{ ...structuredClone(yieldedAttempt(f)), n: 1, state: "passed",
    effectiveRole: review.effectiveRole, launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null,
    completedAt: f.h.ports.now(), verdict: { status: "pass", findings: [] } }] }, { stageId: "fix", attempts: [] }];
  savePipelines([...rows, second]);
  let creates = 0;
  const lookup = f.h.ports.roleLookup;
  f.h.ports.roleLookup = role => role === "merger"
    ? { engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: "Fixture merger" } : lookup!(role);
  const { mergeOnReviewSetting, setMergeOnReview } = await import("@/lib/projects/settings");
  setMergeOnReview(second.project, true, "fixture", f.h.ports.now());
  let policy = mergeOnReviewSetting(second.project);
  const ports: import("@/lib/forge/autoMerge").AutoMergePorts = {
    now: () => Date.parse(f.h.ports.now()), loadPipelines,
    setting: () => policy,
    cachedState: () => null, pullRequestOf: row => row.merge?.prNumber ? { repository: "example/project", number: row.merge.prNumber } : null,
    mutate: (id, change) => withPipelineMutation(async (rows, persist) => {
      const row = rows.find(row => row.id === id); if (!row || !change(row)) return false;
      await persist([row]); return true;
    }),
    run: async args => {
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN", isDraft: false,
        headRefOid: ORIGIN_MAIN_SHA, headRefName: "second-pr", baseRefName: "main", isCrossRepository: false,
        mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "", statusCheckRollup: [] });
      if (args[0] === "api" && args[1]?.includes("/branches/")) return args.at(-1) === ".commit.sha" ? "a".repeat(40) : "[]";
      if (args[0] === "api" && args[1]?.includes("/rules/")) return "[]";
      if (args[0] === "api" && /comments|reviews/.test(args[1] ?? "")) return "";
      if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
      throw new Error(`unexpected forge observation ${args.join(" ")}`);
    },
    write: async () => { throw new Error("fixture must never merge a conflicting PR"); },
    startRefresh: async (request, options) => {
      creates++;
      return createPipelineFromRequest(request, f.h.ports, options);
    },
  };
  if (change !== "none") {
    const preflight = f.h.ports.preflightRepo;
    f.h.ports.preflightRepo = async repoDir => {
      const result = await preflight(repoDir);
      await withPipelineMutation(async (rows, persist) => {
        const live = rows.find(row => row.id === second.id)!;
        if (change === "requirements") live.spec = "replacement refresh requirements";
        if (change === "control") live.controlGeneration = "replacement-control";
        await persist([live]);
      });
      if (change === "unlink-task" || change === "clear-finishes") {
        const answer = await patchPipeline(second.id, change === "unlink-task"
          ? { action: "unlink-task", taskId: "capacity-task" }
          : { action: "link-task", taskId: "capacity-task", finishes: false }, f.h.ports);
        expect(answer.error).toBeUndefined();
      }
      if (change === "policy") {
        setMergeOnReview(second.project, false, "fixture", f.h.ports.now());
        policy = mergeOnReviewSetting(second.project);
      }
      return result;
    };
  }
  await sweepAutoMerge(ports);
  expect(loadPipelines().find(row => row.id === second.id)!.merge!.reason).toContain("repository capacity");
  f.advance(60 * 60_000);
  await sweepAutoMerge(ports);
  expect(creates).toBe(0);
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeDefined();
  const firstOwner = structuredClone(f.lane().delivery);
  f.advance(MERGE_POLL_MS);
  await sweepAutoMerge(ports);
  expect(creates).toBe(1);
  const reservation = loadPipelines().find(row => row.id === second.id)!.merge!.refresh!;
  if (change === "none") {
    expect(reservation.pipelineId).not.toBeNull();
    const admitted = loadPipelines().find(row => row.id === reservation.pipelineId)!;
    expect(admitted.state).toBe("provisioning");
    expect(admitted.refreshOf?.capacity?.requestedAt).toBe(f.h.ports.now());
  } else {
    expect(reservation.pipelineId).toBeNull();
    expect(loadPipelines().some(row => row.creationRequest?.key === reservation.key)).toBeFalse();
  }
  expect(f.lane().delivery).toEqual(firstOwner);
  expect(yieldedAttempt(f).verdict).toBeNull();
});


test.each([false, true])("two refresh resumes share atomic capacity admission (pending=%s)", async pending => {
  const f = await capacityLane();
  const rows = loadPipelines();
  const first = rows.find(row => row.id === f.id)!;
  first.state = "paused"; first.pausedState = "running";
  if (pending) {
    first.cursor!.state = "pending";
    Object.assign(first.runs[0]!.attempts[0]!, { state: "pending", startedAt: null,
      launchId: null, conversationId: null, agentPath: null, sessionId: null, paneId: null });
  }
  const peer = structuredClone(first);
  peer.id = "resume-peer";
  peer.worktreeDir = first.worktreeDir.replace(first.id, peer.id);
  peer.branch = first.branch.replace(first.id, peer.id);
  peer.delivery!.ownerId = peer.id;
  peer.delivery!.target.branch = "refs/heads/resume-peer";
  const parent = structuredClone(rows.find(row => row.id === "capacity-origin")!);
  parent.id = "resume-origin";
  parent.worktreeDir = parent.worktreeDir.replace("capacity-origin", parent.id);
  parent.branch = parent.branch.replace("capacity-origin", parent.id);
  parent.delivery!.ownerId = parent.id;
  parent.delivery!.target = structuredClone(peer.delivery!.target);
  parent.merge!.prNumber = 2;
  const { refreshReservation } = await import("@/lib/forge/autoRefresh");
  parent.merge!.refresh = refreshReservation(parent, "a".repeat(40), ORIGIN_MAIN_SHA, Date.parse(f.h.ports.now()), "main");
  parent.merge!.refresh!.pipelineId = peer.id;
  peer.creationRequest = { key: parent.merge!.refresh!.key, digest: parent.merge!.refresh!.digest };
  peer.refreshOf = { pipelineId: parent.id, base: parent.merge!.refresh!.base };
  savePipelines([...rows, peer, parent]);
  const answers = await Promise.all([first.id, peer.id].map(id => patchPipeline(id, { action: "resume" }, f.h.ports)));
  expect(answers.filter(answer => !answer.error)).toHaveLength(1);
  expect(answers.find(answer => answer.error)?.error).toContain("repository capacity");
  expect(loadPipelines().filter(row => row.refreshOf && row.state === "running")).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test.each(["before-stop", "lost-effect", "stopped", "settled"] as const)("a real controller restart retains refresh origin and original stop custody at %s", async boundary => {
  const f = await capacityLane();
  if (boundary === "before-stop") {
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...args) => { if (args[1][0] === "rev-parse") throw new Error("fixture boundary before stop"); return exec(...args); };
  }
  if (boundary === "lost-effect") f.h.ports.stopStageAgent = async () => ({ outcome: "unconfirmed", operationId: "original-stop", detail: "fixture lost answer" });
  if (boundary === "stopped") f.h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null });
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  const before = yieldedAttempt(f).suspension!.capacityYield!;
  const rowBefore = f.lane().refreshOf;
  const child = await realExec(process.execPath, ["-e", `
    import { defaultPipelinePorts, tickPipelines } from "@/lib/pipelines/engine";
    import { loadPipelines } from "@/lib/pipelines/store";
    import { registerPipelineTick } from "@/lib/pipelines/controllerSignal";
    registerPipelineTick(async () => {});
    let stops = 0, reads = 0;
    const ports = { ...defaultPipelinePorts(), now: () => "2026-11-01T13:05:00.000Z", monotonicNow: () => 0,
      stageHostResident: async () => false, stageHostPresence: async () => "absent", paneAgentAlive: async () => false,
      stageHostTreeStillRunning: () => null, conversationGeneration: () => null, pathForConversation: () => null,
      allowedAccountIds: () => null, accountExhausted: () => false, conversationAgentActive: async () => false,
      conversationDeliveryOutstanding: () => false, invalidateProviderContinuation: async () => {},
      durableTurnEvidence: async () => ({ turn: "busy", message: null, backgroundTasks: [] }),
      suspensionStopReceipt: async () => { reads++; return null; },
      stopStageAgent: async () => { stops++; return { outcome: "not-running" }; },
      spawnAgent: async () => { throw new Error("unexpected refresh dispatch"); },
      worktreePresent: () => true,
      exec: async (_command, args) => args[0] === "rev-parse"
        ? { code: 0, stdout: "${ORIGIN_MAIN_SHA}", stderr: "" }
        : { code: 0, stdout: "", stderr: "" } };
    await tickPipelines([], ports);
    const lane = loadPipelines().find(row => row.id === ${JSON.stringify(f.id)});
    console.log(JSON.stringify({ stops, reads, capacity: lane.refreshOf, marker: lane.runs[0].attempts[0].suspension.capacityYield }));
  `], process.cwd(), { LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, { timeoutMs: 30_000 });
  expect(child.code, child.stderr).toBe(0);
  const after = JSON.parse(child.stdout.trim());
  expect(after.capacity).toEqual(rowBefore);
  expect(after.marker.deadline).toBe(before.deadline);
  expect(after.marker.target).toEqual(before.target);
  expect(after.stops).toBe(boundary === "before-stop" ? 1 : 0);
  if (boundary === "lost-effect") {
    expect(after.reads).toBe(1);
    expect(after.marker.settledAt).toBeUndefined();
  } else expect(after.marker.settledAt).toBeDefined();
});


test("a report whose turn is still busy retains capacity after host stop", async () => {
  const f = await capacityLane();
  let terminal = false;
  f.h.ports.durableTurnEvidence = async () => ({ turn: terminal ? "terminal" : "busy", message: null,
    lastRecordAt: Date.parse(f.h.ports.now()), backgroundTasks: [] });
  const rows = loadPipelines();
  const lane = rows.find(row => row.id === f.id)!;
  lane.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
  savePipelines(rows);
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension?.stoppedAt).toBeDefined();
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeUndefined();
  expect(yieldedAttempt(f).verdict).toBeNull();
  terminal = true;
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeDefined();
  expect(yieldedAttempt(f).verdict?.status).toBe("pass");
});

test("a terminal report arriving after the settled yield is reconciled exactly once", async () => {
  const f = await capacityLane();
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  const settledAt = yieldedAttempt(f).suspension?.capacityYield?.settledAt;
  expect(settledAt).toBeDefined();

  await withPipelineMutation(async (rows, persist) => {
    const lane = rows.find(row => row.id === f.id)!;
    lane.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
    await persist([lane]);
  });
  f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: null,
    lastRecordAt: Date.parse(f.h.ports.now()), backgroundTasks: [] });
  await tickPipelines([], f.h.ports);

  expect(yieldedAttempt(f).verdict?.status).toBe("pass");
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBe(settledAt);
  expect(f.h.calls.filter(call => call.startsWith("stop-host:")).length).toBe(1);
  expect(f.h.spawnInputs).toHaveLength(1);
  const verdict = structuredClone(yieldedAttempt(f).verdict);
  const attemptState = yieldedAttempt(f).state;
  const suspension = structuredClone(yieldedAttempt(f).suspension);
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).verdict).toEqual(verdict);
  expect(yieldedAttempt(f).state).toBe(attemptState);
  expect(yieldedAttempt(f).suspension).toEqual(suspension);
  expect(f.h.calls.filter(call => call.startsWith("stop-host:")).length).toBe(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a late terminal transcript fallback settles after a completed capacity yield", async () => {
  const f = await capacityLane();
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  const settledAt = yieldedAttempt(f).suspension?.capacityYield?.settledAt;
  expect(settledAt).toBeDefined();
  const at = Date.parse(f.h.ports.now()) + 1;
  f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: { ts: at, text: '```json\n{"status":"pass","findings":[]}\n```' },
    lastRecordAt: at, backgroundTasks: [] });

  await tickPipelines([], f.h.ports);

  expect(yieldedAttempt(f).report).toBeUndefined();
  expect(yieldedAttempt(f).verdict?.status).toBe("pass");
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBe(settledAt);
  expect(f.h.calls.filter(call => call.startsWith("stop-host:")).length).toBe(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});


test("an unreadable host probe never renews the original capacity stop key", async () => {
  const f = await capacityLane();
  let held = true;
  f.h.ports.stageHostTreeStillRunning = () => held ? "own check" : null;
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  const before = structuredClone(yieldedAttempt(f).suspension!);
  const calls = f.h.calls.filter(call => call.startsWith("stop-host:")).length;
  f.h.ports.stageHostPresence = async () => "unknown";
  for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension).toEqual(before);
  expect(f.h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(calls);
  held = false;
  f.h.ports.stageHostPresence = async () => "absent";
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeDefined();
  expect(yieldedAttempt(f).suspension?.stopRevision).toBeUndefined();
});


test("capacity settlement preserves an operator pause after accepting a report", async () => {
  const f = await capacityLane();
  expect((await patchPipeline(f.id, { action: "pause", reason: "fixture operator hold" }, f.h.ports)).error).toBeUndefined();
  const rows = loadPipelines();
  rows.find(row => row.id === f.id)!.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
  savePipelines(rows);
  f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: null, lastRecordAt: Date.parse(f.h.ports.now()), backgroundTasks: [] });
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).verdict?.status).toBe("pass");
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeDefined();
  expect(f.lane().state).toBe("paused");
  expect(f.lane().pause?.reason).toBe("fixture operator hold");
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a disappeared active checkout cannot be represented as an uncreated checkout", async () => {
  const f = await capacityLane();
  f.h.setWorktreePresent(false);
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(yieldedAttempt(f).suspension?.capacityYield?.headBefore).toBeUndefined();
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeUndefined();
  expect(f.lane().stateDetail).toContain("HEAD remains UNKNOWN");
  expect(f.h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(0);
});

test("refresh expiry during a live read reaches stop settlement in the same controller pass", async () => {
  const f = await capacityLane();
  f.advance(60 * 60_000 - 1);
  const active = { ...entry(yieldedAttempt(f).agentPath!), activity: "live" as const };
  f.h.setPaneAlive(true);
  await tickPipelines([active], f.h.ports);
  expect(yieldedAttempt(f).suspension?.capacityYield).toBeUndefined();
  let reads = 0;
  const paneAlive = f.h.ports.paneAgentAlive;
  f.h.ports.paneAgentAlive = async pane => {
    const result = await paneAlive(pane);
    if (++reads === 1) f.advance(1);
    return result;
  };
  let stops = 0;
  f.h.ports.stopStageAgent = async () => { stops++; f.h.setPaneAlive(false); return { outcome: "stopped" }; };
  await tickPipelines([active], f.h.ports);
  expect(reads).toBeGreaterThan(0);
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBe(f.h.ports.now());
  expect(stops).toBe(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test.each(["stop", "origin"] as const)("a closed yield with incomplete %s proof remains in indexed capacity admission", async proof => {
  const f = await capacityLane();
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  const rows = loadPipelines();
  const lane = rows.find(row => row.id === f.id)!;
  lane.state = "closed"; lane.closedAt = f.h.ports.now(); lane.cursor = null;
  delete lane.runs[0]!.attempts[0]!.suspension!.stoppedAt;
  if (proof === "origin") {
    delete lane.runs[0]!.attempts[0]!.suspension!.capacityYield;
    lane.refreshOf!.capacityRefusal = "original origin is unreadable; UNKNOWN";
  }
  savePipelines(rows);
  const { pipelineRefreshCapacityCandidates } = await import("./store");
  const { refreshCapacityHolders } = await import("./refreshCapacity");
  const repository = lane.delivery!.target.repository;
  const holders = refreshCapacityHolders(pipelineRefreshCapacityCandidates(repository), repository,
    row => row.delivery?.target.repository);
  expect(holders.map(row => row.id)).toEqual([f.id]);
});

test("capacity admission explicitly refuses a truncated repository candidate set", async () => {
  const f = await capacityLane();
  const rows = loadPipelines();
  const lane = rows.find(row => row.id === f.id)!;
  lane.state = "paused"; lane.pausedState = "running";
  const peers = Array.from({ length: 257 }, (_, index) => {
    const peer = structuredClone(lane);
    peer.id = `retained-refresh-${index}`;
    peer.worktreeDir = lane.worktreeDir.replace(lane.id, peer.id);
    peer.branch = lane.branch.replace(lane.id, peer.id);
    delete peer.creationRequest;
    peer.delivery!.active = false;
    peer.delivery!.ownerId = peer.id;
    peer.delivery!.target.branch = `refs/heads/${peer.id}`;
    return peer;
  });
  savePipelines([...rows, ...peers]);
  const before = f.lane();
  const answer = await patchPipeline(f.id, { action: "resume" }, f.h.ports);
  expect(answer.error).toContain("admission remains UNKNOWN");
  expect(answer.error).toContain("bounded read");
  expect(f.lane()).toEqual(before);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("refresh expiry refuses delivery ownership already lost before its first observation", async () => {
  const f = await capacityLane();
  const rows = loadPipelines();
  const lane = rows.find(row => row.id === f.id)!;
  lane.delivery!.active = false; lane.delivery!.ownerId = "replacement-owner";
  savePipelines(rows);
  f.advance(60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.lane().refreshOf?.capacityRefusal).toContain("ownership changed");
  expect(f.lane().stateDetail).toContain("UNKNOWN");
  expect(yieldedAttempt(f).suspension?.capacityYield?.settledAt).toBeUndefined();
  expect(f.h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(0);
});
