import { expect, test, fs, path, spawn, stopFixtureProcess, pipelineIdentity, providerRecoveryHarness, tickPipelines, loadPipelines, savePipelines, patchPipeline, AgentRegistry, setAgentRegistryForTests, defaultPipelinePorts, LIMITED_ACCOUNT, PASS_TEXT, recoveryReport } from "./engine.fixture";
import { stopPipelineStageAgent } from "./engine";
import { tickPipelinesController } from "./controllerPass";
import { recordPipelineControllerSelection, selectPipelineControllerWork } from "./store";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { observeHostExit, readHostExit } from "@/lib/runtime/hostExit";
import { initializeRecipientInterruptionIndex, interruptionObligationDirectory, interruptionObligationStore, recipientInterruptionEvidence } from "@/lib/runtime/interruptionObligations";
import { journalTickets, startJournalPeer, until } from "@/lib/runtime/startup.interruptionAdmission.fixture";
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
    const ports = defaultPipelinePorts();
    f.h.ports.spawnReceipt = id => ports.spawnReceipt(id);
    f.h.ports.conversationHostExited = (...args) => ports.conversationHostExited?.(...args) ?? Boolean(readHostExit(identity)?.exit);
    f.h.ports.conversationHostEnded = (...args) => ports.conversationHostEnded!(...args);
    f.h.ports.conversationHostProcess = id => ports.conversationHostProcess!(id);
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
    return { ...f, close, lane: cancelled, conversationId: launch.conversationId, registry };
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

for (const action of ["tick", "retry"] as const) test(`${action} reads a successor generation from the same production ports instance`, async () => {
  const f = await cancelledHostDeath();
  const successor: { child: ReturnType<typeof spawn> | null } = { child: null };
  try {
    f.h.ports.durableTurnEvidence = async () => {
      successor.child = spawn("sleep", ["300"], { stdio: "ignore" });
      const identity = captureProcessIdentity(successor.child.pid!);
      const begun = f.registry.beginSpawnRequest({ engine: "codex", cwd: "fixtures", accountId: null,
        conversationId: f.conversationId, purpose: "resume-successor" });
      if (begun.kind !== "created") throw new Error("expected a resume successor launch");
      const sessionId = "00000000-0000-0000-0000-000000000001";
      const path = `/codex/rollout-2026-01-01T00-00-01-${sessionId}.jsonl`;
      expect(f.registry.settleSpawn(begun.receipt.launchId, {
        key: { engine: "codex", sessionId }, artifactPath: path, cwd: "fixtures", accountId: null,
        status: "live", host: null, claimEpoch: 2, claimOwner: null, pendingAction: null,
        structuredHost: { kind: "codex-app-server", process: identity, exitProcess: identity, endpoint: "stdio:successor",
          eventCursor: 0, protocolVersion: null, writerClaimEpoch: 2, activeTurnRef: "successor-turn", pendingAttention: [], activeFlags: [] },
      }).kind).toBe("settled");
      return { turn: "busy", message: null, lastRecordAt: f.now() };
    };
    if (action === "tick") await tickPipelines([], f.h.ports);
    else {
      const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
      expect(retry.status).toBe(409);
      expect(retry.error).toContain("resumed work");
    }
    expect(await f.h.ports.conversationHostProcess!(f.conversationId)).toMatchObject({ state: "alive" });
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(successor.child?.exitCode).toBeNull();
  } finally {
    if (successor.child) await stopFixtureProcess(successor.child);
    await f.close();
  }
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

test("a live successor appearing during late retry preparation prevents resetting a parked attempt", async () => {
  const f = await cancelledHostDeath();
  try {
    let hostChecks = 0;
    let successorAlive = false;
    f.h.ports.conversationHostProcess = async () => {
      hostChecks++;
      if (hostChecks > 3) successorAlive = true;
      return { state: successorAlive ? "alive" : "gone", pid: process.pid };
    };
    f.h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null, lastRecordAt: f.now() });
    const cursorBefore = structuredClone(loadPipelines()[0]!.cursor);
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    // The first retry checks the exited owner, then later receipt preparation
    // discovers the live successor immediately before the cursor reset.
    expect(hostChecks).toBeGreaterThan(3);
    expect(successorAlive).toBe(true);
    expect(retry.status).toBe(409);
    expect(retry.error).toContain("live stage host");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.cursor).toEqual(cursorBefore);
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


for (const pause of [false, true]) test(`controller settlement waits for the production journal (pause while waiting=${pause})`, async () => {
  const f = await cancelledHostDeath();
  const directory = interruptionObligationDirectory(f.registry.filename);
  let peer: ReturnType<typeof startJournalPeer> | undefined;
  let recovery: Promise<unknown> | undefined;
  try {
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    const seed = path.join(path.dirname(directory), "cut-seed");
    const cut = interruptionObligationStore(seed).record({
      conversationId: f.conversationId, engine: "codex", hostKey: "codex:stage-fixture",
      path: attempt.agentPath!, owner: null, claimEpoch: 1, turnRef: "stage-turn",
      boundary: "fixture-release", reason: "viewer-release", recordedAt: attempt.startedAt!,
      checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null,
    }).obligation;
    await initializeRecipientInterruptionIndex(directory);
    peer = startJournalPeer(directory, path.join(path.dirname(directory), "cut-owner"), {
      append: JSON.stringify(cut) + "\n", maxHoldMs: 2_000,
    });
    await peer.ready();
    f.h.ports.conversationInterruption = defaultPipelinePorts().conversationInterruption;
    f.h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null });
    let completed = false;
    recovery = tickPipelines([], f.h.ports).finally(() => { completed = true; });
    void recovery.catch(() => {});
    await until(() => journalTickets(directory) === 2 || completed);
    expect(peer.held()).toBe(true);
    expect(completed).toBe(false);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    if (pause) {
      const [concurrent] = loadPipelines();
      concurrent!.state = "paused";
      savePipelines([concurrent!]);
    }
    expect(await peer.stop()).toBe(0);
    await recovery;
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    expect(recipientInterruptionEvidence(directory, [f.conversationId]).records).toEqual([cut]);
    if (pause) {
      expect(loadPipelines()[0]!.state).toBe("paused");
      return;
    }

    interruptionObligationStore(directory).update(cut.id, { state: "delivered", resolvedAt: f.h.ports.now() });
    f.h.ports.conversationInterruption = defaultPipelinePorts().conversationInterruption;
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("failed");
  } finally {
    await Promise.allSettled([peer?.stop(), recovery]);
    await f.close();
  }
}, 20_000);

for (const recovered of [false, true]) test(`failed settlement preserves a live successor with restartRecovery=${recovered}`, async () => {
  const f = await cancelledHostDeath();
  let successor: ReturnType<typeof spawn> | null = null;
  try {
    const before = loadPipelines();
    if (recovered) {
      before[0]!.runs[0]!.attempts[0]!.restartRecovery = {
        bootId: "fixture-recovery", requestedAt: f.h.ports.now(), lastRecordAt: f.now(),
        stopped: { kind: "dead", restarted: false, lastRecordAt: f.now() },
      };
      savePipelines(before);
    }
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("failed");
    successor = spawn("sleep", ["300"], { stdio: "ignore" });
    const identity = captureProcessIdentity(successor.pid!);
    observeHostExit(successor, identity);
    const begun = f.registry.beginSpawnRequest({ engine: "codex", cwd: "fixtures", accountId: null,
      conversationId: f.conversationId, purpose: "resume-successor" });
    if (begun.kind !== "created") throw new Error("successor reservation refused");
    const sessionId = "00000000-0000-0000-0000-000000000002";
    expect(f.registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId }, artifactPath: `/codex/rollout-2026-01-01T00-00-02-${sessionId}.jsonl`,
      cwd: "fixtures", accountId: null, status: "dead", host: null, claimEpoch: 2, claimOwner: null, pendingAction: null,
      structuredHost: { kind: "codex-app-server", process: identity, exitProcess: identity, endpoint: "stdio:successor",
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 2, activeTurnRef: "busy-successor", pendingAttention: [], activeFlags: [] },
    }).kind).toBe("settled");
    expect(await f.h.ports.conversationHostProcess!(f.conversationId)).toMatchObject({ state: "alive" });
    let stops = 0;
    f.h.ports.stopStageAgent = async target => {
      stops++;
      return await stopPipelineStageAgent(target, { termination: { terminateOwnedHost: async () => false } });
    };
    const cursorBefore = structuredClone(loadPipelines()[0]!.cursor);
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(stops).toBe(0);
    expect(successor.exitCode).toBeNull();
    expect(successor.signalCode).toBeNull();
    expect(loadPipelines()[0]!.cursor).toEqual(cursorBefore);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(retry.status).toBe(409);
    expect(await f.h.ports.conversationHostProcess!(f.conversationId)).toMatchObject({ state: "alive" });
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally {
    if (successor) await stopFixtureProcess(successor);
    await f.close();
  }
});

for (const boundary of ["transcript", "final-host-check"] as const) test(`retry rereads production delivery after ${boundary}`, async () => {
  const f = await cancelledHostDeath();
  try {
    if (boundary === "final-host-check") await tickPipelines([], f.h.ports);
    const deliveryPorts = defaultPipelinePorts();
    f.h.ports.conversationDeliveryOutstanding = id => deliveryPorts.conversationDeliveryOutstanding!(id);
    expect(f.h.ports.conversationDeliveryOutstanding(f.conversationId)).toBe(false);
    let queued = false;
    let deliveryId = "";
    const enqueue = () => {
      if (queued) return;
      queued = true;
      deliveryId = f.registry.holdDelivery(f.conversationId, "Fixture message", "fixture-pending-message").id;
    };
    f.h.ports.durableTurnEvidence = async () => {
      if (boundary === "transcript") enqueue();
      return { turn: "busy", message: null };
    };
    if (boundary === "final-host-check") {
      const hostProcess = f.h.ports.conversationHostProcess!;
      f.h.ports.conversationHostProcess = async id => {
        const host = await hostProcess(id);
        enqueue();
        return host;
      };
    }
    const cursorBefore = structuredClone(loadPipelines()[0]!.cursor);
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(queued).toBe(true);
    expect(defaultPipelinePorts().conversationDeliveryOutstanding!(f.conversationId)).toBe(true);
    expect(retry).toMatchObject({ status: 409, error: expect.stringContaining("pending delivery") });
    expect(loadPipelines()[0]!.cursor).toEqual(cursorBefore);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(f.h.ports.conversationDeliveryOutstanding(f.conversationId)).toBe(true);
    expect(f.registry.recordDeliveryOutcome(deliveryId, "delivered").state).toBe("delivered");
    expect(f.h.ports.conversationDeliveryOutstanding(f.conversationId)).toBe(false);
    const settled = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(settled.error).toBeUndefined();
    expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(f.h.spawnInputs).toHaveLength(2);
  } finally { await f.close(); }
});

test("overlapping settlement and retries create one successor attempt", async () => {
  const f = await cancelledHostDeath();
  try {
    await Promise.all([tickPipelines([], f.h.ports), tickPipelines([], f.h.ports)]);
    const settledAt = loadPipelines()[0]!.runs[0]!.attempts[0]!.completedAt;
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("failed");
    expect(f.h.spawnInputs).toHaveLength(1);
    const request = { action: "retry-stage" as const, expectedStageId: "plan", expectedAttempt: 1 };
    await Promise.all([patchPipeline(f.lane.id, request, f.h.ports), patchPipeline(f.lane.id, request, f.h.ports)]);
    await Promise.all([tickPipelines([], f.h.ports), tickPipelines([], f.h.ports)]);
    await tickPipelines([], f.h.ports);
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts).toHaveLength(2);
    expect(lane.runs[0]!.attempts[0]!.completedAt).toBe(settledAt);
    expect(f.h.spawnInputs).toHaveLength(2);
  } finally { await f.close(); }
});

test("tick rereads production delivery queued during transcript I/O", async () => {
  const f = await cancelledHostDeath();
  try {
    const deliveryPorts = defaultPipelinePorts();
    f.h.ports.conversationDeliveryOutstanding = id => deliveryPorts.conversationDeliveryOutstanding!(id);
    expect(f.h.ports.conversationDeliveryOutstanding(f.conversationId)).toBe(false);
    let queued = false;
    let deliveryId = "";
    f.h.ports.durableTurnEvidence = async () => {
      if (!queued) {
        queued = true;
        deliveryId = f.registry.holdDelivery(f.conversationId, "Fixture message", "fixture-tick-message").id;
      }
      return { turn: "busy", message: null };
    };
    await tickPipelines([], f.h.ports);
    expect(queued).toBe(true);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    expect(f.h.ports.conversationDeliveryOutstanding(f.conversationId)).toBe(true);
    expect(f.registry.recordDeliveryOutcome(deliveryId, "delivered").state).toBe("delivered");
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("failed");
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { await f.close(); }
});

test("retry of an exited recovery launches once without stopping the conversation again", async () => {
  const f = await cancelledHostDeath();
  try {
    const before = loadPipelines();
    before[0]!.runs[0]!.attempts[0]!.restartRecovery = {
      bootId: "fixture-recovery", requestedAt: f.h.ports.now(), lastRecordAt: f.now(),
      stopped: { kind: "dead", restarted: false, lastRecordAt: f.now() },
    };
    savePipelines(before);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("failed");
    f.h.ports.stopStageAgent = async () => { throw new Error("the exited recovery must not stop the conversation again"); };
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, f.h.ports);
    expect(retry.error).toBeUndefined();
    expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(f.h.spawnInputs).toHaveLength(2);
  } finally { await f.close(); }
});

for (const readNumber of [1, 2]) test(`manual retry preserves a cut that arrives during transcript read ${readNumber}`, async () => {
  const f = await cancelledHostDeath();
  try {
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    const directory = interruptionObligationDirectory(f.registry.filename);
    await initializeRecipientInterruptionIndex(directory);
    const store = interruptionObligationStore(directory);
    const production = defaultPipelinePorts();
    const ports = { ...production, ...f.h.ports, conversationInterruption: production.conversationInterruption };
    let reads = 0;
    let cutId: string | undefined;
    ports.durableTurnEvidence = async () => {
      if (++reads === readNumber) {
        cutId = store.record({
          conversationId: f.conversationId, engine: "codex", hostKey: "codex:stage-fixture",
          path: attempt.agentPath!, owner: null, claimEpoch: 1, turnRef: "stage-turn",
          boundary: "fixture-release", reason: "viewer-release", recordedAt: attempt.startedAt!,
          checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null,
        }).obligation.id;
      }
      return { turn: "busy", message: null, lastRecordAt: f.now() };
    };
    const request = { action: "retry-stage" as const, expectedStageId: "plan", expectedAttempt: 1 };
    const refused = await patchPipeline(f.lane.id, request, ports);
    expect(cutId).toBeDefined();
    expect(refused.status).toBe(409);
    expect(loadPipelines()[0]!.cursor?.state).toBe("running");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toMatchObject([{ n: 1, state: "running" }]);
    expect(recipientInterruptionEvidence(directory, [f.conversationId]).records).toMatchObject([{ id: cutId, state: "owed" }]);

    store.update(cutId!, { state: "delivered", resolvedAt: ports.now() });
    const accepted = await patchPipeline(f.lane.id, request, ports);
    expect(accepted.error).toBeUndefined();
    expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
  } finally { await f.close(); }
});


test("manual retry refuses a cut recorded at its final host inspection", async () => {
  const f = await cancelledHostDeath();
  try {
    const original = loadPipelines()[0]!;
    const attempt = original.runs[0]!.attempts[0]!;
    const directory = interruptionObligationDirectory(f.registry.filename);
    await initializeRecipientInterruptionIndex(directory);
    const store = interruptionObligationStore(directory);
    const production = defaultPipelinePorts();
    const ports = { ...production, ...f.h.ports };
    let reads = 0;
    let cutId: string | undefined;
    ports.conversationInterruption = (...args) => { reads++; return production.conversationInterruption!(...args); };
    const inspect = f.h.ports.conversationHostProcess!;
    ports.conversationHostProcess = async id => {
      const host = await inspect(id);
      if (reads >= 2 && !cutId) {
        cutId = store.record({ conversationId: f.conversationId, engine: "codex", hostKey: "codex:stage-fixture",
          path: attempt.agentPath!, owner: null, claimEpoch: 1, turnRef: "stage-final-check",
          boundary: "fixture-release", reason: "viewer-release", recordedAt: attempt.startedAt!,
          checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null }).obligation.id;
      }
      return host;
    };
    const request = { action: "retry-stage" as const, expectedStageId: "plan", expectedAttempt: 1 };
    const refused = await patchPipeline(f.lane.id, request, ports);
    expect(cutId).toBeDefined();
    expect(refused.status).toBe(409);
    const retained = loadPipelines()[0]!;
    expect(retained.cursor).toEqual(original.cursor);
    expect(retained.runs[0]!.attempts).toEqual(original.runs[0]!.attempts);
    expect(recipientInterruptionEvidence(directory, [f.conversationId]).records).toMatchObject([{ id: cutId, state: "owed" }]);
    store.update(cutId!, { state: "delivered", resolvedAt: ports.now() });
    expect((await patchPipeline(f.lane.id, request, ports)).error).toBeUndefined();
    expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
  } finally { await f.close(); }
});

for (const decision of ["paused", "closed", "available"] as const) test(`journal timeout defers one scheduled lane and recovers when the journal is ${decision}`, async () => {
  const f = await cancelledHostDeath();
  const directory = interruptionObligationDirectory(f.registry.filename);
  let peer: ReturnType<typeof startJournalPeer> | undefined;
  let pass: ReturnType<typeof tickPipelinesController> | undefined;
  try {
    const affected = loadPipelines()[0]!;
    const attempt = affected.runs[0]!.attempts[0]!;
    affected.id = `journal-${decision}-a`;
    Object.assign(affected, pipelineIdentity(affected.id, affected.task, affected.repoDir));
    affected.delivery = undefined;
    affected.publication = "internal";
    const next = structuredClone(affected!);
    next.id = `journal-${decision}-b`;
    Object.assign(next, pipelineIdentity(next.id, next.task, next.repoDir));
    next.state = "paused";
    next.cursor = null;
    next.creationRequest = undefined;
    next.runs = next.runs.map(run => ({ ...run, attempts: [] }));
    const now = f.h.ports.now();
    f.h.ports.now = () => now;
    next.unconfirmedHosts = [{ stageId: "plan", attempt: 1, conversationId: null, agentPath: null, paneId: "peer-fixture",
      operationId: null, detail: "host disappearance is pending", at: now }];
    const visited: string[] = [];
    f.h.ports.stageHostResident = async ({ paneId }) => { if (paneId) visited.push(paneId); return false; };
    f.h.ports.paneAgentAlive = async () => false;
    f.h.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null });
    savePipelines([affected, next]);
    const time = Date.parse(now);
    // Start this scenario at the beginning of the persisted fair walk.
    await recordPipelineControllerSelection({ row_key: "", row_order: -1, generation: 0,
      attempt_cursor: 0, dirty: 1, due_at: 0 }, time);
    expect((await selectPipelineControllerWork(time, [])).map(row => row.row_key)).toEqual([affected.id, next.id]);

    const cut = interruptionObligationStore(path.join(path.dirname(directory), "cut-seed")).record({
      conversationId: f.conversationId, engine: "codex", hostKey: "codex:stage-fixture",
      path: attempt.agentPath!, owner: null, claimEpoch: 1, turnRef: "stage-turn",
      boundary: "fixture-release", reason: "viewer-release", recordedAt: attempt.startedAt!,
      checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null,
    }).obligation;
    await initializeRecipientInterruptionIndex(directory);
    peer = startJournalPeer(directory, path.join(path.dirname(directory), "timed-writer"), { append: JSON.stringify(cut) + "\n" });
    await peer.ready();
    const read = defaultPipelinePorts().conversationInterruption!;
    f.h.ports.conversationInterruption = async (...args) => {
      try { return await read(...args); }
      catch (error) {
        if (decision === "available") await peer!.stop();
        throw error;
      }
    };
    if (decision === "available") {
      f.h.ports.stageHostResident = async ({ paneId }) => {
        expect((await read(f.conversationId))?.state).toBe("owed");
        if (paneId) visited.push(paneId);
        return false;
      };
    }
    pass = tickPipelinesController([], f.h.ports);
    void pass.catch(() => {});
    await until(() => journalTickets(directory) === 2);
    await pass;
    if (decision !== "available") expect(peer.held()).toBe(true);
    expect(visited).toEqual(["peer-fixture"]);
    const afterTimeout = loadPipelines();
    expect(afterTimeout.find(row => row.id === affected.id)?.cursor?.state).toBe("running");
    expect(afterTimeout.find(row => row.id === next.id)?.unconfirmedHosts ?? []).toEqual([]);
    expect((await selectPipelineControllerWork(time, [])).some(row => row.row_key === affected.id)).toBe(true);
    expect(await peer.stop()).toBe(0);
    if (decision === "available") {
      expect(recipientInterruptionEvidence(directory, [f.conversationId]).records).toEqual([cut]);
      return;
    }

    const readCut = defaultPipelinePorts().conversationInterruption!;
    const states: string[] = [];
    f.h.ports.conversationInterruption = async (...args) => {
      const result = await readCut(...args);
      if (!states.length) {
        states.push(result?.state ?? "missing");
        const rows = loadPipelines();
        const concurrent = rows.find(row => row.id === affected.id)!;
        concurrent.state = decision;
        if (decision === "closed") {
          concurrent.closedAt = now;
          concurrent.cursor = null;
        }
        savePipelines(rows);
      }
      return result;
    };
    pass = tickPipelinesController([], f.h.ports);
    await pass;
    expect(states).toEqual(["owed"]);
    expect(loadPipelines().find(row => row.id === affected.id)?.state).toBe(decision);
    expect(recipientInterruptionEvidence(directory, [f.conversationId]).records).toEqual([cut]);
  } finally {
    await Promise.allSettled([peer?.stop(), pass]);
    await f.close();
  }
}, 20_000);
