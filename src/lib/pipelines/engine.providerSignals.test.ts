import { expect, test, tickPipelines, loadPipelines, savePipelines, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, stampPipelinePrompt, providerRecoveryHarness, cutChainKit, CHAIN_RESET, otherKindCut, largeToolResult, engineModule, patchPipeline, ProjectAccountRefusedError, AgentRegistry, fs, path, setAgentRegistryForTests, spyOn } from "./engine.fixture";
import { pipelineStageRead } from "@/lib/mcp/compactAnswers";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { providerRecoveryAttempt, providerRecoveryTurnMatches } from "./hostRetirement";

type RefusalHarness = Awaited<ReturnType<typeof providerRecoveryHarness>>;
type StageAttempt = ReturnType<typeof loadPipelines>[number]["runs"][number]["attempts"][number];
const REFUSAL_NOTICE = "This content was flagged for possible cybersecurity risk.";

test("an idle stop proves authority for the exact running Codex refusal", async () => {
  const f = await providerRecoveryHarness("codex", "other", REFUSAL_NOTICE);
  const hosts = refusalHosts(f);
  const id = loadPipelines()[0]!.id;
  hosts.refuse(latest(), "other", REFUSAL_NOTICE);
  await hosts.busyPass(id);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  const cut = attempt.providerWait!;
  expect(cut.condition.label).toBe("Codex cybersecurity refusal");
  const ref = { pipelineId: id, stageId: lane.cursor!.stageId, attempt: attempt.n, turnTs: cut.turnTs,
    controlGeneration: lane.controlGeneration ?? null };
  const target = { engine: "codex" as const, sessionId: attempt.sessionId!, agentPath: attempt.agentPath,
    conversationId: attempt.conversationId! };
  expect(providerRecoveryAttempt([lane], ref, target)?.n).toBe(attempt.n);
  expect(providerRecoveryAttempt([lane], { ...ref, controlGeneration: "superseded" }, target)).toBeNull();
  expect(providerRecoveryAttempt([lane], ref, { ...target, sessionId: "replacement" })).toBeNull();
  const evidence = await f.h.ports.durableTurnEvidence("codex", attempt.agentPath!, undefined, attempt.startedAt, undefined, cut.turnTs);
  expect(providerRecoveryTurnMatches(attempt, evidence, f.now())).toBe(true);
  expect(providerRecoveryTurnMatches(attempt, { ...evidence!, terminalProviderMessage: {
    ...evidence!.terminalProviderMessage!, text: "Unrelated provider error",
  } }, f.now())).toBe(false);
  expect(providerRecoveryTurnMatches(attempt, { ...evidence!, externalPromptAfterCut: true }, f.now())).toBe(false);
});

/** Hosts the refused attempts keep until the controller stops them idle-only. */
function refusalHosts(f: RefusalHarness) {
  const fixtures: Record<string, string> = {};
  const transcripts = new Map<string, Record<string, unknown>[]>();
  const resident = new Set<string>();
  const stops: number[] = [];
  let busy = false;
  f.h.ports.resolveProjectSpawn = engine => ({ kind: "available", account: {
    engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" },
  } });
  f.h.ports.stageHostResident = async target => resident.has(target.conversationId ?? "");
  f.h.ports.conversationHostProcess = async id => resident.has(id) ? { state: "alive", pid: 1234 } : { state: "gone", pid: null };
  f.h.ports.stopStageAgent = async (target, options) => {
    // Recovery may stop the refused host only while it is idle.
    expect(options?.onlyIfIdle).toBe(true);
    if (busy) return { outcome: "deferred" };
    stops.push(target.attempt);
    resident.delete(target.conversationId ?? "");
    return { outcome: "stopped" };
  };
  /** The attempt's open turn ends on a terminal Codex refusal: its first
      turn, or the turn the agent continued in after an earlier refusal. */
  const refuse = (attempt: StageAttempt, errorClass: string, message: string, later: (at: () => string) => Record<string, unknown>[] = () => []) => {
    resident.add(attempt.conversationId!);
    f.advance(1_000);
    const rows = transcripts.get(attempt.agentPath!) ?? [{ type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } }];
    f.advance(1_000);
    const refusal = { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", error: {
      ...(message ? { message } : {}), codex_error_info: errorClass,
    } } };
    const at = () => { f.advance(1_000); return f.h.ports.now(); };
    rows.push(refusal, ...later(at));
    write(attempt, rows);
  };
  const write = (attempt: StageAttempt, rows: Record<string, unknown>[]) => {
    transcripts.set(attempt.agentPath!, rows);
    fixtures[attempt.agentPath!] = stageTranscript(`codex-refusal-${attempt.n}`, rows);
    readFixtures(f.h, fixtures);
  };
  /** The attempt's agent keeps writing after its last refusal. */
  const work = (attempt: StageAttempt, later: (at: () => string) => Record<string, unknown>[]) => {
    const at = () => { f.advance(1_000); return f.h.ports.now(); };
    write(attempt, [...transcripts.get(attempt.agentPath!)!, ...later(at)]);
  };
  /** While the refused host is still busy nothing is stopped or relaunched. */
  const busyPass = async (id: string) => {
    const before = { spawns: f.h.spawnInputs.length, stops: stops.length };
    busy = true;
    f.h.setConversationActive(true);
    await engineModule.recoverPipelineProviderTurn(id, f.h.ports);
    await tickPipelines([], f.h.ports);
    expect({ spawns: f.h.spawnInputs.length, stops: stops.length }).toEqual(before);
  };
  const settle = async (id: string) => {
    await busyPass(id);
    busy = false;
    f.h.setConversationActive(false);
    f.advance(30_000);
    await engineModule.recoverPipelineProviderTurn(id, f.h.ports);
    for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  };
  return { refuse, work, busyPass, settle, stops, resident };
}

const latest = () => loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;

test.each(["current", "changed during capture"] as const)(
  "the real orphan stop checks the refused turn before relaunching on Opus (%s)", async proof => {
    const f = await providerRecoveryHarness("codex", "other", REFUSAL_NOTICE);
    const hosts = refusalHosts(f);
    const id = loadPipelines()[0]!.id;
    hosts.refuse(latest(), "other", REFUSAL_NOTICE);
    await hosts.settle(id);

    const root = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "refusal-orphan-"));
    const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const launch = beginLegacySpawnFixture(registry, { engine: "codex", cwd: root, transport: "structured", accountId: LIMITED_ACCOUNT });
    if (launch.kind !== "created") throw new Error("orphan fixture launch was unavailable");
    const pid = 2_000_000_124;
    let alive = true;
    const originalIdentity = procBackend.processIdentity.bind(procBackend), originalAlive = procBackend.pidAlive.bind(procBackend);
    const identity = (candidate: number) => candidate === pid ? alive ? "fixture-refusal-orphan" : null : originalIdentity(candidate);
    const living = (candidate: number) => candidate === pid ? alive : originalAlive(candidate);
    const identitySpy = spyOn(procBackend, "processIdentity").mockImplementation(identity);
    const aliveSpy = spyOn(procBackend, "pidAlive").mockImplementation(living);
    const signals: number[] = [];
    let captured = false;
    try {
      const ref = captureProcessIdentity(pid);
      const [lane] = loadPipelines();
      const refused = lane!.runs[0]!.attempts[1]!;
      const key = { engine: "codex" as const, sessionId: ["00000000", "0000", "4000", "8000", "000000000002"].join("-") };
      const agentPath = path.join(root, `${key.sessionId}.jsonl`);
      expect(registry.settleSpawn(launch.receipt.launchId, {
        key, artifactPath: agentPath, cwd: root, accountId: LIMITED_ACCOUNT, status: "dead", host: null,
        structuredHost: { kind: "codex-app-server", endpoint: "fixture:stdio", process: ref, eventCursor: 1,
          protocolVersion: "fixture-v1", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
        claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null,
      }).kind).toBe("settled");
      setAgentRegistryForTests(registry);
      Object.assign(refused, { agentPath, sessionId: key.sessionId,
        launchId: launch.receipt.launchId, conversationId: launch.receipt.conversationId });
      savePipelines([lane!]);
      const allowPath = f.h.ports.sourcePathAllowed;
      f.h.ports.sourcePathAllowed = file => file === agentPath || allowPath(file);
      const real = engineModule.defaultPipelinePorts();
      f.h.ports.stageHostResident = real.stageHostResident;
      f.h.ports.stopStageAgent = async (target, { onlyIfIdle, operationId, providerRecovery, requireIdleEvidence } = {}) => {
        expect(onlyIfIdle).toBe(true);
        expect(await real.stageHostResident(target)).toBe(true);
        const result = await engineModule.retirePipelineStageAgent(target, {
          operationId, providerRecovery, requireIdleEvidence,
          client: null, action: async () => { throw new Error("orphan must use recorded identity"); },
          termination: { processIdentity: identity, bootEpoch: () => ref.bootEpoch ?? null, pidAlive: living,
            ppidMap: () => new Map(), processGroupId: () => null,
            signal: candidate => { signals.push(candidate); alive = false; },
            ...(proof === "changed during capture" ? { persistCapturedTree: async () => {
              captured = true;
              fs.appendFileSync(agentPath, "\n");
              return true;
            } } : {}),
          },
        });
        expect(result.outcome).toBe(proof === "current" ? "stopped" : "failed");
        if (proof === "changed during capture") {
          expect("error" in result ? result.error : "").toContain("recorded refusal orphan authority changed");
        }
        return result;
      };
      hosts.refuse(refused, "other", REFUSAL_NOTICE);
      fs.copyFileSync(path.join(process.env.LLV_STATE_DIR!, "codex-refusal-2.jsonl"), agentPath);
      readFixtures(f.h, { [agentPath]: agentPath });
      await engineModule.recoverPipelineProviderTurn(id, f.h.ports);
      if (proof === "changed during capture") {
        expect(captured).toBe(true);
        expect(signals).toEqual([]);
        expect(latest()).toMatchObject({ n: 2, state: "running" });
        expect(f.h.spawnInputs).toHaveLength(2);
      } else {
        for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
        expect(signals).toEqual([pid]);
        expect(loadPipelines()[0]!.state).toBe("running");
        expect(latest()).toMatchObject({ n: 3, state: "running", effectiveRole: { engine: "claude", model: "opus" } });
        expect(f.h.spawnInputs).toHaveLength(3);
      }
    } finally {
      setAgentRegistryForTests(null);
      identitySpy.mockRestore();
      aliveSpy.mockRestore();
    }
  });

test.each(["authority returns on retry", "host exits while held", "retry-stage while held"] as const)(
  "a deferred refusal stop reaches its deadline without admitting repeated stops (%s)", async recovery => {
    const f = await providerRecoveryHarness("codex", "other", REFUSAL_NOTICE);
    const hosts = refusalHosts(f);
    const id = loadPipelines()[0]!.id;
    hosts.refuse(latest(), "other", REFUSAL_NOTICE);
    await hosts.settle(id);
    const refused = latest();
    const stop = f.h.ports.stopStageAgent;
    let admitted = false;
    let calls = 0;
    f.h.ports.stopStageAgent = async (target, options) => {
      calls += 1;
      if (!hosts.resident.has(refused.conversationId!)) return { outcome: "not-running" };
      return admitted ? stop(target, options) : { outcome: "deferred" };
    };
    hosts.refuse(refused, "other", REFUSAL_NOTICE);
    await engineModule.recoverPipelineProviderTurn(id, f.h.ports);
    const wait = latest().controllerWait!;
    expect(wait.rounds).toBe(1);
    f.advance(Date.parse(wait.startedAt) + wait.budgetMs! - f.now());
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.stateDetail).toContain("termination deadline elapsed");
    expect(loadPipelines()[0]!.stateDetail).toContain("idle stop authority was deferred");
    expect(latest().controllerWait).toMatchObject({ startedAt: wait.startedAt, providerStopRetry: "scheduled" });
    expect(calls).toBe(2);
    expect(f.h.spawnInputs).toHaveLength(2);

    admitted = recovery === "authority returns on retry";
    f.advance(Date.parse(latest().controllerWait!.retryAfter) - f.now());
    await tickPipelines([], f.h.ports);
    expect(calls).toBe(3);
    if (!admitted) {
      const held = loadPipelines()[0]!;
      expect(held.stateDetail).toContain("Waiting for recorded host exit or retry-stage");
      expect(latest().controllerWait).toMatchObject({ startedAt: wait.startedAt, providerStopRetry: "held" });
      for (let pass = 0; pass < 4; pass++) {
        f.advance(30 * 60_000);
        await tickPipelines([], f.h.ports);
        expect(loadPipelines()[0]!.stateDetail).toBe(held.stateDetail);
      }
      expect(calls).toBe(3);
      expect(f.h.spawnInputs).toHaveLength(2);
      if (recovery === "host exits while held") hosts.resident.delete(refused.conversationId!);
      else {
        admitted = true;
        const retry = await patchPipeline(id, { action: "retry-stage", expectedStageId: held.cursor!.stageId,
          expectedAttempt: refused.n }, f.h.ports);
        expect(retry).toMatchObject({ pipeline: { state: "running" } });
        expect(latest().controllerWait?.providerStopRetry).toBe("scheduled");
      }
    }
    for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
    expect(calls).toBe(recovery === "authority returns on retry" ? 3 : 4);
    expect(hosts.resident.has(refused.conversationId!)).toBe(false);
    expect(latest()).toMatchObject({ n: 3, state: "running", effectiveRole: { engine: "claude", model: "opus" } });
    expect(f.h.spawnInputs).toHaveLength(3);
  });

test.each(["slow exit", "confirmation deadline", "retry-stage during confirmation"] as const)(
  "the second Codex refusal keeps automatic custody until the host is gone (%s)", async timing => {
    const f = await providerRecoveryHarness("codex", "other", REFUSAL_NOTICE);
    const hosts = refusalHosts(f);
    const id = loadPipelines()[0]!.id;
    hosts.refuse(latest(), "other", REFUSAL_NOTICE);
    await hosts.settle(id);
    const refused = latest();
    expect(refused).toMatchObject({ n: 2, state: "running", effectiveRole: { engine: "codex" } });
    const stops: Array<string | undefined> = [];
    const schedule: number[] = [];
    f.h.ports.scheduleTick = delay => schedule.push(delay);
    const stop = f.h.ports.stopStageAgent;
    f.h.ports.stopStageAgent = async (target, options) => {
      expect(options?.onlyIfIdle).toBe(true);
      const lane = loadPipelines()[0]!;
      expect(providerRecoveryAttempt([lane], options!.providerRecovery!, { engine: "codex", sessionId: refused.sessionId!,
        agentPath: target.agentPath, conversationId: target.conversationId! })?.n).toBe(refused.n);
      stops.push(options?.operationId);
      if (stops.length < 3 && hosts.resident.has(refused.conversationId!)) return {
        outcome: "unconfirmed", operationId: "fixture-stop", detail: "kill accepted as delivering but termination was not confirmed",
      };
      if (!hosts.resident.has(refused.conversationId!)) return { outcome: "not-running" };
      return stop(target, options);
    };
    hosts.refuse(refused, "other", REFUSAL_NOTICE);
    await engineModule.recoverPipelineProviderTurn(id, f.h.ports);
    const waiting = loadPipelines()[0]!;
    expect(stops).toHaveLength(1);
    expect(waiting.state).toBe("running");
    expect(waiting.stateDetail).toContain("kill accepted as delivering but termination was not confirmed");
    expect(hosts.resident.has(refused.conversationId!)).toBe(true);
    expect(f.h.spawnInputs).toHaveLength(2);
    const wait = latest().controllerWait!;
    expect(wait.rounds).toBe(1);
    await tickPipelines([], f.h.ports);
    expect(stops).toHaveLength(1);

    if (timing !== "slow exit") {
      f.advance(Date.parse(wait.startedAt) + wait.budgetMs! - f.now());
      await tickPipelines([], f.h.ports);
      const retained = loadPipelines()[0]!;
      expect(retained.state).toBe("running");
      expect(retained.stateDetail).toContain("termination deadline elapsed");
      expect(retained.stateDetail).toContain("kill accepted as delivering but termination was not confirmed");
      expect(latest()).toMatchObject({ n: 2, state: "running", completedAt: null });
      expect(f.h.spawnInputs).toHaveLength(2);
      expect(hosts.resident.has(refused.conversationId!)).toBe(true);
      expect(stops).toHaveLength(2);
      expect(schedule.at(-1)).toBeGreaterThan(0);
      expect(schedule.at(-1)).toBeLessThanOrEqual(60_000);
      if (timing === "retry-stage during confirmation") {
        const retry = await patchPipeline(id, { action: "retry-stage", expectedStageId: retained.cursor!.stageId,
          expectedAttempt: refused.n }, f.h.ports);
        expect(retry).toMatchObject({ pipeline: { state: "running", cursor: { state: "running" } } });
        expect(stops).toHaveLength(2);
        expect(f.h.spawnInputs).toHaveLength(2);
      }
    } else {
      // The in-flight stop has finished between controller passes.
      hosts.resident.delete(refused.conversationId!);
    }

    f.advance(Date.parse(latest().controllerWait!.retryAfter) - f.now());
    for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
    expect(stops).toHaveLength(timing === "slow exit" ? 2 : 3);
    expect(stops[0]).toMatch(/^pipeline-idle-stop-/);
    expect(new Set(stops).size).toBe(1);
    expect(hosts.resident.has(refused.conversationId!)).toBe(false);
    const continued = loadPipelines()[0]!;
    expect(continued.state).toBe("running");
    expect(continued.runs[0]!.attempts[1]).toMatchObject({ state: "failed", error: "stage cut by Codex cybersecurity refusal" });
    expect(continued.runs[0]!.attempts[1]!.providerRecoveries!.map(item => item.action)).toEqual(["wait", "switch", "relaunch"]);
    expect(latest()).toMatchObject({ n: 3, state: "running", effectiveRole: { engine: "claude", model: "opus" } });
    expect(f.h.spawnInputs).toHaveLength(3);
  });

test.each([
  ["a fresh first attempt", "other", REFUSAL_NOTICE, false],
  ["an attempt launched after resume", "cyber_policy", "", true],
] as const)("a Codex cybersecurity refusal on %s retries on Codex once, then moves the stage to Claude Opus", async (_source, errorClass, message, resumed) => {
  const f = await providerRecoveryHarness("codex", errorClass, message);
  const initial = loadPipelines()[0]!;
  if (resumed) {
    f.h.ports.resolveProjectSpawn = engine => ({ kind: "available", account: {
      engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" },
    } });
    f.h.durableTurns.clear();
    f.h.setConversationActive(true);
    f.advance(1_000);
    expect((await patchPipeline(initial.id, { action: "pause", reason: "Maintenance" }, f.h.ports)).pipeline?.state).toBe("paused");
    f.h.setConversationActive(false);
    f.advance(1_000);
    expect((await patchPipeline(initial.id, { action: "resume" }, f.h.ports)).pipeline?.state).toBe("running");
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: "pipeline paused" });
  }
  const hosts = refusalHosts(f);
  const stageId = initial.cursor!.stageId;
  const first = latest();
  const launches = resumed ? 2 : 1;
  expect(first).toMatchObject({ n: launches, state: "running", effectiveRole: { engine: "codex" } });

  // 1-2: the first refusal stops the idle host and starts a fresh Codex attempt.
  hosts.refuse(first, errorClass, message);
  await hosts.settle(initial.id);
  const firstRead = pipelineStageRead(loadPipelines()[0]!, stageId, first.n).attempt!;
  expect(firstRead).toMatchObject({ state: "failed", error: "stage cut by Codex cybersecurity refusal" });
  expect(firstRead.providerRecoveries!.map(item => [item.action, item.condition])).toEqual([
    ["wait", "Codex cybersecurity refusal"], ["relaunch", "Codex cybersecurity refusal"],
  ]);
  expect(hosts.stops).toEqual([first.n]);
  const second = latest();
  expect(second).toMatchObject({ n: first.n + 1, state: "running", effectiveRole: { engine: "codex", model: "gpt-5.6-sol" } });
  expect(second.providerWait).toBeUndefined();
  expect(second.providerRecoveryBudget).toBeUndefined();
  expect(f.h.spawnInputs).toHaveLength(launches + 1);
  expect(loadPipelines()[0]!.stages[0]!.effectiveRole.engine).toBe("codex");

  // 3: the second refusal moves the stage to Claude Opus and relaunches there.
  hosts.refuse(second, errorClass, message);
  await hosts.settle(initial.id);
  expect(hosts.stops).toEqual([first.n, second.n]);
  const moved = loadPipelines()[0]!;
  const secondRead = pipelineStageRead(moved, stageId, second.n);
  expect(secondRead.attempt!.providerRecoveries!.map(item => [item.action, item.condition])).toEqual([
    ["wait", "Codex cybersecurity refusal"], ["switch", "Codex cybersecurity refusal"], ["relaunch", "Codex cybersecurity refusal"],
  ]);
  expect(secondRead.attempt!.providerRecoveries![1]!.summary).toBe("moving the stage to Claude opus after a second Codex cybersecurity refusal");
  expect(secondRead.stage).toMatchObject({ engine: "claude", model: "opus", effort: "high" });
  expect(moved.graphEdits?.at(-1)).toMatchObject({
    action: "override-stage", stageId, effect: "pending-next-attempt", appliesFromAttempt: second.n + 1,
    actor: { kind: "agent", role: "pipeline-controller", conversationId: null }, cause: "codex-cybersecurity-refusal",
    summary: `moved stage ${stageId} to Claude opus high after Codex refused it twice as a cybersecurity risk; applies from attempt ${second.n + 1}`,
  });
  const opus = latest();
  expect(opus).toMatchObject({ n: second.n + 1, state: "running", effectiveRole: { engine: "claude", model: "opus", effort: "high" } });
  expect(f.h.spawnInputs).toHaveLength(launches + 2);
  expect(f.h.spawnInputs.at(-1)!.role).toMatchObject({ engine: "claude", model: "opus" });
  expect({ wait: opus.providerWait, budget: opus.providerRecoveryBudget }).toEqual({ wait: undefined, budget: undefined });
  expect(f.sends).toEqual([]);
  expect(moved.state).toBe("running");
});

test.each(["launch", "provider"] as const)("an Opus attempt that cannot run after two Codex refusals parks with the reason (%s failure)", async failure => {
  const f = await providerRecoveryHarness("codex", "other", REFUSAL_NOTICE);
  const hosts = refusalHosts(f);
  const id = loadPipelines()[0]!.id;
  const stageId = loadPipelines()[0]!.cursor!.stageId;
  hosts.refuse(latest(), "other", REFUSAL_NOTICE);
  await hosts.settle(id);
  if (failure === "launch") {
    f.h.ports.spawnAgent = async () => { throw new ProjectAccountRefusedError({ kind: "unavailable", allowedAccountIds: [] }, "claude", "project-fixture"); };
  }
  hosts.refuse(latest(), "other", REFUSAL_NOTICE);
  await hosts.settle(id);
  const opus = latest();
  expect(opus).toMatchObject({ n: 3, effectiveRole: { engine: "claude", model: "opus" } });
  if (failure === "provider") {
    // Claude ends the Opus turn on its own refusal; nothing moves it further.
    expect(opus.state).toBe("running");
    f.h.durableTurns.set(opus.agentPath!, { turn: "terminal", message: { text: "API Error: refused", ts: Date.parse(f.h.ports.now()) + 2_000 },
      terminalProviderMessage: { text: "API Error: refused", ts: Date.parse(f.h.ports.now()) + 2_000, errorClass: "invalid_request" } });
    f.advance(3_000);
    f.h.ports.durableTurnEvidence = async (_engine, transcriptPath) => f.h.durableTurns.get(transcriptPath) ?? null;
    await engineModule.recoverPipelineProviderTurn(id, f.h.ports);
    for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  }
  const parked = loadPipelines()[0]!;
  // 4: only now the lane parks; the seat sees the reason on the decision.
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe(failure === "launch"
    ? "no allowed claude account is available for project project-fixture (project project-fixture allows no claude account)"
    : "stage cut by provider error after 0 tries; last: API Error: refused");
  expect(parked.stages[0]!.effectiveRole).toMatchObject({ engine: "claude", model: "opus" });
  expect(pipelineStageRead(parked, stageId, opus.n).attempt).toMatchObject({ state: "needs_decision" });
  expect(latest().n).toBe(3);
  // Later attempts of the stage in this lane stay on Opus.
  f.h.ports.spawnAgent = async (input, reserved) => {
    await reserved({ launchId: "launch-opus-retry", conversationId: "conversation_opus_retry", accountId: LIMITED_ACCOUNT });
    f.h.spawnInputs.push(structuredClone(input));
    return { launchId: "launch-opus-retry", conversationId: "conversation_opus_retry", sessionId: "session-opus-retry", transcript: "/claude/opus-retry.jsonl", paneId: null, accountId: LIMITED_ACCOUNT };
  };
  f.h.ports.spawnReceipt = launchId => opus.launchId && launchId === opus.launchId ? {
    state: "completed", launchId, conversationId: opus.conversationId!,
    sessionId: opus.sessionId, transcript: opus.agentPath, paneId: null,
  } : null;
  const retry = await patchPipeline(id, { action: "retry-stage", expectedStageId: stageId, expectedAttempt: opus.n }, f.h.ports);
  expect(retry.error).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(latest()).toMatchObject({ n: 4, effectiveRole: { engine: "claude", model: "opus" } });
});

test("the move to Claude Opus clears a Codex account pin so the project's Claude selection applies", async () => {
  const f = await providerRecoveryHarness("codex", "other", REFUSAL_NOTICE, null, true);
  const hosts = refusalHosts(f);
  const id = loadPipelines()[0]!.id;
  const stageId = loadPipelines()[0]!.cursor!.stageId;
  expect(loadPipelines()[0]!.stages[0]!.account).toBe(LIMITED_ACCOUNT);
  hosts.refuse(latest(), "other", REFUSAL_NOTICE);
  await hosts.settle(id);
  // The fresh Codex attempt still binds the pin.
  expect(loadPipelines()[0]!.stages[0]!.account).toBe(LIMITED_ACCOUNT);
  expect(latest().definition?.account).toBe(LIMITED_ACCOUNT);
  hosts.refuse(latest(), "other", REFUSAL_NOTICE);
  await hosts.settle(id);
  const moved = loadPipelines()[0]!;
  expect(moved.stages[0]!.account).toBeUndefined();
  expect(moved.graphEdits?.at(-1)).toMatchObject({
    action: "override-stage", stageId, accountOverride: null, cause: "codex-cybersecurity-refusal",
    summary: `moved stage ${stageId} to Claude opus high after Codex refused it twice as a cybersecurity risk; the Codex account pin was cleared; applies from attempt 3`,
  });
  expect(latest()).toMatchObject({ n: 3, state: "running", effectiveRole: { engine: "claude", model: "opus" }, definition: { account: null } });
});

test("a second refusal whose move to Claude cannot be made parks the Codex attempt and releases its idle host", async () => {
  const f = await providerRecoveryHarness("codex", "other", REFUSAL_NOTICE);
  const hosts = refusalHosts(f);
  const id = loadPipelines()[0]!.id;
  const stageId = loadPipelines()[0]!.cursor!.stageId;
  hosts.refuse(latest(), "other", REFUSAL_NOTICE);
  await hosts.settle(id);
  const second = latest();
  expect(second).toMatchObject({ n: 2, effectiveRole: { engine: "codex" } });
  // The role registry cannot resolve the Claude configuration.
  f.h.ports.roleLookup = () => null;
  hosts.refuse(second, "other", REFUSAL_NOTICE);
  await hosts.settle(id);
  const parked = loadPipelines()[0]!;
  const detail = `stage cut by Codex cybersecurity refusal twice; moving it to Claude Opus failed: Builder role is unavailable in the role registry; last: ${REFUSAL_NOTICE}`;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: detail });
  expect(parked.stages[0]!.effectiveRole.engine).toBe("codex");
  expect(parked.graphEdits ?? []).toEqual([]);
  expect(pipelineStageRead(parked, stageId, second.n).attempt).toMatchObject({
    state: "needs_decision", error: detail,
    providerRecoveries: [
      { action: "wait", condition: "Codex cybersecurity refusal" },
      { action: "park", condition: "Codex cybersecurity refusal", summary: detail },
    ],
  });
  // The parked refusal's idle host is retired; nothing else launched.
  expect(hosts.stops).toEqual([1, 2]);
  expect(parked.terminalReap?.settledAttempts).toContain(`${stageId}:${second.n}`);
  expect(f.h.spawnInputs).toHaveLength(2);
  f.h.ports.spawnReceipt = launchId => launchId === second.launchId ? {
    state: "completed", launchId, conversationId: second.conversationId!,
    sessionId: second.sessionId, transcript: second.agentPath, paneId: null,
  } : null;
  const retry = await patchPipeline(id, { action: "retry-stage", expectedStageId: stageId, expectedAttempt: second.n }, f.h.ports);
  expect(retry).toMatchObject({ pipeline: { state: "running", cursor: { stageId, state: "pending" } } });
});

test("operator work after a Codex refusal keeps the attempt and its host; a second refusal of that attempt moves the stage to Claude Opus", async () => {
  const f = await providerRecoveryHarness("codex", "other", REFUSAL_NOTICE);
  const hosts = refusalHosts(f);
  const id = loadPipelines()[0]!.id;
  const source = latest();
  // The refusal is recorded while the host is still busy.
  hosts.refuse(source, "other", REFUSAL_NOTICE);
  await hosts.busyPass(id);
  expect(latest().providerRecoveries!.map(item => [item.action, item.condition.label])).toEqual([["wait", "Codex cybersecurity refusal"]]);
  // The operator answers the refused turn and the agent works on it.
  hosts.work(source, at => [
    { type: "event_msg", timestamp: at(), payload: { type: "user_message", message: "Continue without the flagged step" } },
    { type: "event_msg", timestamp: at(), payload: { type: "task_started" } },
    { type: "event_msg", timestamp: at(), payload: { type: "agent_message", message: "Continuing the stage" } },
  ]);
  await hosts.busyPass(id);
  for (let tick = 0; tick < 3; tick++) { f.advance(30_000); await hosts.busyPass(id); }
  expect(hosts.stops).toEqual([]);
  expect(hosts.resident.has(source.conversationId!)).toBe(true);
  expect(f.h.spawnInputs).toHaveLength(1);
  const lane = loadPipelines()[0]!;
  expect(lane.state).toBe("running");
  expect(lane.stages[0]!.effectiveRole.engine).toBe("codex");
  expect(latest()).toMatchObject({ n: source.n, state: "running", effectiveRole: { engine: "codex" } });
  expect(latest().providerRecoveries?.some(item => item.action === "relaunch" || item.action === "switch") ?? false).toBe(false);

  // Codex refuses the continued turn of the same attempt: that is the
  // stage's second refusal, so it leaves Codex now.
  hosts.refuse(source, "other", REFUSAL_NOTICE);
  await hosts.settle(id);
  expect(hosts.stops).toEqual([source.n]);
  const moved = loadPipelines()[0]!;
  expect(moved.stages[0]!.effectiveRole).toMatchObject({ engine: "claude", model: "opus" });
  const refused = moved.runs[0]!.attempts.find(item => item.n === source.n)!;
  expect(refused.providerRecoveries!.map(item => item.action)).toEqual(["wait", "wait", "switch", "relaunch"]);
  expect(moved.graphEdits?.at(-1)).toMatchObject({ action: "override-stage", cause: "codex-cybersecurity-refusal", appliesFromAttempt: source.n + 1 });
  expect(latest()).toMatchObject({ n: source.n + 1, state: "running", effectiveRole: { engine: "claude", model: "opus" } });
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs.at(-1)!.role).toMatchObject({ engine: "claude", model: "opus" });
});

// A parked retry's confirmation wait goes with its chain when the next chain,
// read with no tick between, runs past the read bound.
for (const engine of ["claude", "codex"] as const) {
  test.each([false, true])(`${engine} an unticked closed parked chain's confirmation wait never binds a new chain over the read bound (pool=%p)`, async pool => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
    f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
    let reset = CHAIN_RESET["10pm"];
    const allowed = pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
    f.h.ports.allowedAccountIds = () => allowed;
    f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
      ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: reset, allowedAccountIds: allowed };
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(), ...(pool ? { triedAccounts: allowed } : {}) };
    savePipelines([lane]);
    const records: Record<string, unknown>[] = [];
    const file = stageTranscript(`chain-unticked-parked-${engine}-${pool}`, []);
    const k = cutChainKit(f, engine, () => file, records);
    k.notice("10pm", reset);
    k.write();
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
    const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
    await tick();
    expect(attempt().providerWait?.stageRetry).toBeDefined();
    // A harness wake is written just before the retry time; its answer is not yet.
    f.h.setConversationActive(true);
    f.advance(Date.parse("2026-10-05T19:00:58Z") - f.now());
    await k.harnessWake();
    k.write();
    f.advance(2_000);
    await tick();
    expect(attempt().controllerWait?.startedAt).toBe("2026-10-05T19:01:00.000Z");
    // The answer and a new chain over the read bound land before the next tick.
    f.advance(30_000);
    k.output();
    f.advance(20_000);
    reset = CHAIN_RESET["2am"];
    k.notice("2am", reset);
    const work = { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(1100) };
    for (let row = 0; row < 8500; row++) records.push(work);
    f.advance(1_000);
    k.notice("2am", reset);
    k.write();
    f.h.setConversationActive(false);
    await tick();
    expect({ state: loadPipelines()[0]!.state, resumeAt: attempt().providerWait?.resumeAt, retry: !!attempt().providerWait?.stageRetry, confirmation: attempt().controllerWait })
      .toEqual({ state: "needs_decision", resumeAt: new Date(reset * 1000 + 60_000).toISOString(), retry: true, confirmation: undefined });
    // Past the old chain's ten minutes the moved retry still holds.
    f.advance(Date.parse("2026-10-05T19:11:10Z") - f.now());
    await tick();
    expect(attempt().providerWait?.stageRetry).toBeDefined();
    // Output closes chain 2; chain 3 retries the stage at its reset.
    f.advance(10_000);
    k.output();
    f.advance(10_000);
    k.notice("2am", reset);
    k.write();
    await tick();
    expect(attempt().providerWait).toMatchObject({ turnTs: f.now(), stageRetry: {} });
    while (f.now() < reset * 1000 + 30_000) { f.advance(reset * 1000 - f.now() > 10 * 60_000 ? 10 * 60_000 : 30_000); await tick(); }
    expect(f.h.spawnInputs).toHaveLength(1);
    while (f.now() < reset * 1000 + 5 * 60_000 && f.h.spawnInputs.length < 2) { f.advance(30_000); await tick(); }
    expect({ spawns: f.h.spawnInputs.length, sends: f.sends.length }).toEqual({ spawns: 2, sends: 0 });
  }, 60_000);
}

// Tool or reasoning output closes a chain as text does; its budget goes with it.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["tool-closed", "reasoning-closed", "tool-same-tick", "open"] as const)(`${engine} agent output without a text message frees the closed chain's budget (pool=${pool}, %s)`, async shape => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      const reset = CHAIN_RESET["10pm"];
      if (pool) {
        f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
        f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
          ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
          : { kind: "exhausted", resetsAt: reset, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
      }
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 2, startedAt: f.h.ports.now() };
      savePipelines([lane]);
      const records: Record<string, unknown>[] = [];
      const file = stageTranscript(`chain-budget-${engine}-${pool}-${shape}`, []);
      const k = cutChainKit(f, engine, () => file, records);
      k.notice("10pm", reset);
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      await tick();
      f.advance(Date.parse("2026-10-05T19:01:30Z") - f.now());
      await tick();
      expect(f.sends).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(3);
      // The engine's continuation, then work that writes no text message.
      f.advance(1_000);
      const text = "Continue the same stage";
      const at = f.h.ports.now();
      if (engine === "claude") records.push({ type: "user", uuid: `continued-${shape}`, timestamp: at, message: { content: text } });
      else records.push({ type: "event_msg", timestamp: at, payload: { type: "user_message", message: await (await import("@/lib/runtime/codexStructuredUserText.server")).encodeCodexStructuredUserText(text, undefined, null, { kind: "agent", role: "pipeline" }) } },
        { type: "event_msg", timestamp: at, payload: { type: "task_started" } });
      if (shape !== "open") {
        f.advance(1_000);
        if (shape === "reasoning-closed") {
          records.push(engine === "claude"
            ? { type: "assistant", timestamp: f.h.ports.now(), message: { model: "claude-opus", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "Nothing left to change" }] } }
            : { type: "response_item", timestamp: f.h.ports.now(), payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Nothing left to change" }] } });
        } else {
          k.output(true);
          f.advance(1_000);
          largeToolResult(f, engine, records, 100);
        }
        f.advance(1_000);
        records.push(engine === "claude" ? { type: "result", subtype: "success", timestamp: f.h.ports.now() }
          : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete" } });
      }
      k.write();
      if (engine === "claude") await stampPipelinePrompt(file, `continued-${shape}`, text);
      if (shape !== "tool-same-tick") {
        f.advance(5_000);
        await tick();
        expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(shape === "open" ? 3 : undefined);
      }
      f.advance(Date.parse("2026-10-05T21:30:00Z") - f.now());
      otherKindCut(f, engine, records, "capacity");
      k.write();
      f.h.setConversationActive(false);
      await tick();
      const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait;
      if (shape === "open") {
        // The chain the continuation entered is still open: its spent budget parks.
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.stateDetail).toContain("after 3 tries");
        return;
      }
      expect(wait).toMatchObject({ condition: { kind: "transient" }, tries: 0, resumeAt: new Date(f.now() + 60_000).toISOString() });
      f.advance(60_000);
      await tick();
      expect({ sends: f.sends.length, state: loadPipelines()[0]!.state, spawns: f.h.spawnInputs.length })
        .toEqual({ sends: 2, state: "running", spawns: 1 });
    });
  }
}

// A closing Claude API error opens its own recovery read on the first tick.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["cut", "reply-after"] as const)(`${engine} a closing capacity cut after large work owes its first backoff (pool=${pool}, %s)`, async activity => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      if (pool) {
        f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
        f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
      }
      const records: Record<string, unknown>[] = [];
      const file = stageTranscript(`closing-capacity-${engine}-${pool}-${activity}`, []);
      const k = cutChainKit(f, engine, () => file, records);
      k.operator("run the stage");
      f.advance(1_000);
      k.output(true);
      f.advance(1_000);
      largeToolResult(f, engine, records, 150_000);
      f.advance(1_000);
      otherKindCut(f, engine, records, "capacity");
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      await tick();
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toMatchObject({ condition: { kind: "transient" }, tries: 0 });
      if (activity === "reply-after") {
        f.advance(1_000);
        k.operator("Wait for my review");
        k.write();
      }
      for (let n = 0; n < 4; n++) { f.advance(30_000); await tick(); }
      if (activity === "cut") {
        expect({ sends: f.sends.length, state: loadPipelines()[0]!.state }).toEqual({ sends: 1, state: "running" });
      } else expect(f.sends).toHaveLength(0);
      expect(f.h.spawnInputs).toHaveLength(1);
    });
  }
}
