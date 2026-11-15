import { expect, test, fs, path, spawn, stopFixtureProcess, providerRecoveryHarness, tickPipelines, loadPipelines, savePipelines, patchPipeline, AgentRegistry, setAgentRegistryForTests, defaultPipelinePorts, LIMITED_ACCOUNT, PASS_TEXT, recoveryReport } from "./engine.fixture";
import { stopPipelineStageAgent } from "./engine";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { observeHostExit, readHostExit } from "@/lib/runtime/hostExit";
import { seatTickDecision, DEFAULT_SEAT_TICK_POLICY, SEAT_TICK_WAKE_INTERVAL_MS } from "@/lib/monitor/seatTick";
import { defaultSeatTickSettings, effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { emptySeatTickState, type SeatTickCheckInput } from "@/lib/monitor/types";

async function cancelledHostDeath() {
  const f = await providerRecoveryHarness("codex", "host_death", "stage host died without output");
  const directory = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "host-exit-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const identity = captureProcessIdentity(child.pid!);
  observeHostExit(child, identity);
  setAgentRegistryForTests(registry);
  const close = async () => { await stopFixtureProcess(child); setAgentRegistryForTests(null); registry.close(); fs.rmSync(directory, { recursive: true, force: true }); };
  try {
    const launch = registry.beginSpawn("codex", "fixtures", { title: "Host exit fixture" });
    const key = { engine: "codex" as const, sessionId: "00000000-0000-0000-0000-000000000000" };
    const staged = registry.settleSpawn(launch.launchId, { key, artifactPath: `/codex/rollout-2026-01-01T00-00-00-${key.sessionId}.jsonl`, cwd: "fixtures", accountId: null,
      status: "dead", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null,
      structuredHost: { kind: "codex-app-server", process: identity, exitProcess: identity, endpoint: "stdio:fixture",
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: "open-turn", pendingAttention: [], activeFlags: [] } });
    expect(staged.kind).toBe("settled");
    expect(registry.conversation(launch.conversationId)?.generations).toHaveLength(1);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.agentPath = `/codex/rollout-2026-01-01T00-00-00-${key.sessionId}.jsonl`;
    attempt.launchId = launch.launchId;
    attempt.conversationId = launch.conversationId;
    savePipelines([lane]);
    const ports = () => defaultPipelinePorts();
    f.h.ports.spawnReceipt = id => ports().spawnReceipt(id);
    f.h.ports.conversationHostExited = (...args) => ports().conversationHostExited?.(...args) ?? Boolean(readHostExit(identity)?.exit);
    f.h.ports.conversationHostEnded = (...args) => ports().conversationHostEnded!(...args);
    f.h.ports.conversationHostProcess = id => ports().conversationHostProcess!(id);
    f.h.ports.conversationTurnInterrupted = async () => null;
    f.h.ports.stopStageAgent = target => stopPipelineStageAgent(target);
    f.h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: f.now(), prompts: [] });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toMatchObject({ condition: { kind: "host_death" }, tries: 0 });
    expect(f.h.ports.conversationHostExited(launch.conversationId, launch.launchId)).toBe(false);
    // The real stage-stop path ends only this test's recorded host while its
    // host-death wait is still pending. Its native exit observer writes proof.
    expect((await import("@/lib/agent/registry")).agentRegistry()).toBe(registry);
    expect(registry.conversation(launch.conversationId)?.generations).toHaveLength(1);
    expect(await f.h.ports.conversationHostProcess!(launch.conversationId)).toMatchObject({ state: "alive" });
    expect(child.exitCode).toBeNull();
    expect(registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]?.structuredHost?.process?.pid).toBe(child.pid);
    f.advance(11_000);
    const stopped = await stopPipelineStageAgent({ stageId: "plan", attempt: 1, launchId: launch.launchId,
      conversationId: launch.conversationId, agentPath: attempt.agentPath, paneId: null }, { termination: { terminateOwnedHost: async () => false } });
    expect(stopped.outcome).toBe("stopped");
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<never>((_, reject) => { exitTimer = setTimeout(() => reject(new Error("the stage-stop host did not exit")), 2_000); })]); }
    finally { clearTimeout(exitTimer); }
    expect(f.h.ports.conversationHostExited(launch.conversationId, launch.launchId)).toBe(true);
    expect(f.h.ports.conversationHostEnded(launch.conversationId, launch.launchId)).toContain("stopped by pipeline-stage-stop");
    f.h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: f.now(),
      prompts: [{ origin: "external", ts: f.now() }], promptHistoryComplete: true });
    await tickPipelines([], f.h.ports);
    const cancelled = loadPipelines()[0]!;
    expect(cancelled.state).toBe("running");
    expect(cancelled.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
    f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: LIMITED_ACCOUNT,
      kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
    return { ...f, close, lane: cancelled, conversationId: launch.conversationId };
  } catch (error) { await close(); throw error; }
}

function seatInput(f: Awaited<ReturnType<typeof cancelledHostDeath>>): SeatTickCheckInput {
  return { project: "fixture", now: f.now(), seat: { conversationId: "conversation_seat", seatEpoch: 1, path: "/codex/seat.jsonl", designatedAt: null, turn: "idle", activity: null },
    pipelines: [{ id: f.lane.id, title: "Host exit fixture", state: "active", updatedAt: f.h.ports.now(), stageId: "plan",
      stageActivity: { lifecycle: "gone", reason: "host_gone_turn_unverified", verified: false, turnState: "busy", conversationId: f.conversationId } }],
    tasks: [], events: [], pullRequests: [], pullRequestsUnavailable: null, ownLanes: [], signals: [], children: [], childrenUnavailable: null, changeFingerprint: "host-exit",
    state: { ...emptySeatTickState(), lastWakeAt: new Date(f.now() - 60_000).toISOString(), lastWakeFingerprint: "host-exit" },
    policy: DEFAULT_SEAT_TICK_POLICY, settings: effectiveSeatTickSettings(defaultSeatTickSettings("fixture"), f.now(), SEAT_TICK_WAKE_INTERVAL_MS) };
}

test("a stage stop during a host-death wait is visible as stalled and settles its cancelled attempt on the next tick", async () => {
  const f = await cancelledHostDeath();
  try {
    const input = seatInput(f);
    const first = seatTickDecision(input);
    expect(first.state.stalledSeen).toContain(f.lane.id);
    const second = seatTickDecision({ ...input, now: f.now() + SEAT_TICK_WAKE_INTERVAL_MS, state: first.state });
    expect(second.verdict.kind).toBe("wake");
    if (second.verdict.kind === "wake") expect(second.verdict.items.some(item => item.id === f.lane.id)).toBe(true);
    f.advance(1_000);
    await tickPipelines([], f.h.ports);
    const settled = loadPipelines()[0]!;
    expect(settled.state).toBe("needs_decision");
    expect(settled.runs[0]!.attempts[0]).toMatchObject({ state: "failed", completedAt: f.h.ports.now() });
    expect(settled.runs[0]!.attempts[0]!.error).toContain("stopped by pipeline-stage-stop");
    expect(f.h.spawnInputs).toHaveLength(1);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.completedAt).toBe(settled.runs[0]!.attempts[0]!.completedAt);
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(retry.error).toBeUndefined();
    expect(loadPipelines()[0]!.cursor).toMatchObject({ stageId: "plan", state: "pending" });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  } finally { await f.close(); }
});

for (const turn of ["busy", "unknown", "unreadable", "reader-error"] as const) test(`recorded host exit admits retry-stage with ${turn} turn evidence`, async () => {
  const f = await cancelledHostDeath();
  try {
    f.h.ports.durableTurnEvidence = async () => {
      if (turn === "reader-error") throw new Error("transcript unavailable");
      return turn === "unreadable" ? null : { turn, message: null };
    };
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(retry.error).toBeUndefined();
    expect(loadPipelines()[0]!.cursor).toMatchObject({ stageId: "plan", state: "pending" });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  } finally { await f.close(); }
});

for (const guard of ["missing-exit", "live-host", "pending-delivery"] as const) test(`recorded host exit preserves the ${guard} retry fence`, async () => {
  const f = await cancelledHostDeath();
  try {
    if (guard === "missing-exit") f.h.ports.conversationHostExited = () => false;
    if (guard === "live-host") f.h.ports.conversationHostProcess = async () => ({ state: "alive", pid: process.pid });
    if (guard === "pending-delivery") f.h.ports.conversationDeliveryOutstanding = () => true;
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(retry.status).toBe(409);
    expect(retry.error).toContain(guard === "pending-delivery" ? "pending delivery" : "not confirmed stalled");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    if (guard !== "pending-delivery") {
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).not.toBe("failed");
    }
  } finally { await f.close(); }
});

for (const action of ["tick", "retry"] as const) test(`a living successor discovered during ${action} keeps the attempt`, async () => {
  const f = await cancelledHostDeath();
  try {
    let reads = 0;
    f.h.ports.conversationHostProcess = async () => ({ state: ++reads === 1 ? "gone" : "alive", pid: process.pid });
    if (action === "tick") await tickPipelines([], f.h.ports);
    else {
      const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
      expect(retry.status).toBe(409);
    }
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  } finally { await f.close(); }
});

for (const evidence of ["terminal-verdict", "late-report"] as const) test(`cancelled host-death settlement preserves a ${evidence}`, async () => {
  const f = await cancelledHostDeath();
  try {
    if (evidence === "terminal-verdict") f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: { text: PASS_TEXT, ts: f.now() + 1 } });
    else {
      let recorded = false;
      f.h.ports.durableTurnEvidence = async () => {
        if (!recorded) {
          recorded = true;
          const lanes = loadPipelines();
          lanes[0]!.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
          savePipelines(lanes);
        }
        return { turn: "busy", message: null };
      };
    }
    await tickPipelines([], f.h.ports);
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    if (evidence === "terminal-verdict") expect(attempt.state).toBe("passed");
    else { expect(attempt.report?.verdict.status).toBe("pass"); expect(attempt.state).not.toBe("failed"); }
  } finally { await f.close(); }
});

test("a cancelled host-death wait cannot keep its exited attempt running", async () => {
  const f = await cancelledHostDeath();
  try {
    f.advance(1_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "failed", completedAt: f.h.ports.now(),
      error: expect.stringContaining("stage host exited after recovery was cancelled") });
  } finally { await f.close(); }
});

test("a delivery queued while retry rechecks host exit keeps its retry fence", async () => {
  const f = await cancelledHostDeath();
  try {
    f.h.ports.durableTurnEvidence = async () => {
      f.h.ports.conversationDeliveryOutstanding = () => true;
      return { turn: "busy", message: null };
    };
    f.h.ports.stopStageAgent = async () => { throw new Error("an exited host must not be stopped again"); };
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(retry).toMatchObject({ status: 409, error: expect.stringContaining("pending delivery") });
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { await f.close(); }
});

test("a successor appearing during retry evidence read is never stopped", async () => {
  const f = await cancelledHostDeath();
  try {
    let successor = false;
    let conditionalStops = 0;
    f.h.ports.conversationHostProcess = async () => ({ state: successor ? "alive" : "gone", pid: process.pid });
    f.h.ports.conversationHostExited = () => true;
    f.h.ports.durableTurnEvidence = async () => {
      successor = true;
      return { turn: "busy", message: null };
    };
    f.h.ports.stopInterruptedStageAgent = async () => {
      conditionalStops++;
      return successor ? null : { outcome: "not-running" };
    };
    f.h.ports.stopStageAgent = async () => { throw new Error("unconditional host stop must not run"); };
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(retry.status).toBe(409);
    expect(conditionalStops).toBe(0);
    expect(successor).toBe(true);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  } finally { await f.close(); }
});

test("retry of a newly failed stage rechecks its live writer immediately before reset", async () => {
  const f = await cancelledHostDeath();
  try {
    f.advance(1_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("failed");
    f.h.ports.conversationHostProcess = async () => ({ state: "alive", pid: process.pid });
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(retry.status).toBe(409);
    expect(retry.error).toContain("live stage host");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { await f.close(); }
});

test("cancelled host-exit settlement waits for an outstanding delivery", async () => {
  const f = await cancelledHostDeath();
  try {
    let outstanding = false;
    let firstEvidenceRead = true;
    f.h.ports.conversationDeliveryOutstanding = () => outstanding;
    f.h.ports.durableTurnEvidence = async () => {
      if (firstEvidenceRead) { firstEvidenceRead = false; outstanding = true; }
      return { turn: "busy", message: null };
    };
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    outstanding = false;
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("failed");
  } finally { await f.close(); }
});

test("cancelled host-exit settlement waits for a deploy continuation", async () => {
  const f = await cancelledHostDeath();
  try {
    let state: "owed" | "delivered" = "owed";
    const recordedAt = loadPipelines()[0]!.runs[0]!.attempts[0]!.startedAt!;
    f.h.ports.conversationInterruption = () => ({ state, recordedAt, resolvedAt: state === "delivered" ? new Date(f.now()).toISOString() : null });
    f.h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    state = "delivered";
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("failed");
  } finally { await f.close(); }
});
