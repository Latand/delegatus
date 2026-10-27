import { expect, test, fs, path, spawn, harness, idleStageHostFixture, defaultPipelinePorts,
  tickPipelines, loadPipelines, savePipelines, durableStageTurnEvidence, withRuntimeSnapshot, recoveryReport, engineModule, entry } from "./engine.fixture";
import { syntheticNoOpRecord, queueOperationRecords } from "@/lib/accounts/migration/fixtures/claudeRecoveryTail";
import type { PipelinePorts } from "./engine";

const WAIT = 3 * 60_000;

async function restoredStage() {
  const h = harness();
  const f = await idleStageHostFixture(h);
  let wall = Date.parse(f.attempt.startedAt!) + 60_000;
  h.ports.now = () => new Date(wall).toISOString();
  const cutAt = h.ports.now();
  const stamp = (offset: number) => new Date(Date.parse(cutAt) + offset).toISOString();
  const records: Record<string, unknown>[] = [
    { type: "user", timestamp: stamp(-2000), message: { role: "user", content: "Finish the stage" } },
    { type: "assistant", timestamp: stamp(-1500), message: { role: "assistant", model: "claude-test", content: [
      { type: "tool_use", id: "background-command", name: "Bash", input: { command: "check", run_in_background: true } },
    ] } },
    { type: "user", timestamp: stamp(-1000), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "background-command", content: "Exit code 137" },
    ] } },
    ...queueOperationRecords(stamp(100)),
    syntheticNoOpRecord(stamp(200)),
    { type: "user", uuid: "native-notification", timestamp: stamp(300), origin: "task-notification",
      promptSource: "system", queueTranscriptOnly: true, message: { role: "user", content:
        "<task-notification><task-id>background-command</task-id><status>failed</status><summary>Background shell command did not finish before the previous session ended</summary></task-notification>" } },
  ];
  const write = () => fs.writeFileSync(f.transcriptPath, records.map(row => JSON.stringify(row)).join("\n") + "\n");
  write();
  const sends: Parameters<NonNullable<PipelinePorts["resumeSeveredTurn"]>>[0][] = [];
  let outstanding = false;
  let completed = true;
  let active: boolean | null = null;
  let interrupted: "idle" | "dead" | null = "idle";
  let stopped = false;
  const ports: PipelinePorts = { ...h.ports,
    durableTurnEvidence: durableStageTurnEvidence,
    conversationRestartCut: () => ({ recordedAt: cutAt }),
    conversationAgentActive: async () => active,
    conversationTurnInterrupted: async () => interrupted,
    conversationOperatorStopped: async () => stopped,
    conversationDeliveryOutstanding: () => outstanding,
    conversationDeliveryCompleted: () => completed,
    resumeSeveredTurn: async input => {
      if (input.continuationAllowed && !await input.continuationAllowed()) return false;
      sends.push(input);
      return true;
    },
    pathForConversation: () => f.transcriptPath,
  };
  return { h, f, ports, records, write, sends, cutAt,
    advance: (ms: number) => { wall += ms; },
    setOutstanding: (value: boolean) => { outstanding = value; },
    setCompleted: (value: boolean) => { completed = value; },
    setStopped: () => { stopped = true; },
    setActive: () => { active = true; interrupted = null; },
  };
}

test("native restore bookkeeping keeps its cut and continues the same Claude stage before unavailable-host grace settlement", async () => {
  const r = await restoredStage();
  try {
    // Real host persistence and production host-unavailability read, after grace.
    const unbind = await r.f.bind(0);
    r.f.host.emit({ status: "idle" });
    await unbind();
    fs.utimesSync(r.f.transcriptPath, new Date(r.cutAt), new Date(r.cutAt));
    r.advance(5 * 60_000);
    const production = defaultPipelinePorts({ liveness: { pidAlive: () => false, processIdentity: () => null } });
    r.ports.conversationHostUnavailableSince = production.conversationHostUnavailableSince;
    r.ports.conversationAgentActive = production.conversationAgentActive;
    r.ports.conversationTurnInterrupted = production.conversationTurnInterrupted;
    expect(await production.conversationHostUnavailableSince!(r.f.attempt.conversationId!)).toBe(new Date(Date.parse(r.cutAt) + 300).toISOString());
    await withRuntimeSnapshot({ sessions: [{ conversationId: r.f.attempt.conversationId, host: "unhosted", turn: "idle", attentionIds: [] }] },
      async () => { await tickPipelines([], r.ports); });
    const lane = loadPipelines()[0]!;
    expect({ state: lane.state, error: lane.runs[0]!.attempts[0]!.error, sendCount: r.sends.length })
      .toEqual({ state: "running", error: null, sendCount: 1 });
    expect(r.sends[0]).toMatchObject({ conversationId: r.f.attempt.conversationId, transcriptPath: r.f.transcriptPath, policy: "queue" });
    expect(lane.runs[0]!.attempts).toHaveLength(1);
    expect(lane.runs[0]!.attempts[0]!.state).toBe("running");
    expect(r.f.signals).toEqual([]);
    expect(r.h.calls.filter(call => call.startsWith("stop-host:"))).toEqual([]);
    expect(r.h.spawnInputs).toHaveLength(1);
    const evidence = await durableStageTurnEvidence("claude", r.f.transcriptPath);
    expect(evidence).toMatchObject({ turn: "busy", lastAgentEventAt: Date.parse(r.cutAt) - 1000 });
  } finally { await r.f.end(); }
});

test.each(["deliver", "operator input", "operator stop", "lost ACK"] as const)
("restore continuation uses durable structured admission: %s", async scenario => {
  const r = await restoredStage();
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
  const { delegatusMessageOrigin } = await import("@/lib/runtime/agentMessageAuthor");
  type RuntimeHostClient = import("@/lib/runtime/client").RuntimeHostClient;
  const journal = new RuntimeJournal(path.join(path.dirname(r.f.transcriptPath), "delivery.sqlite"), { structuredHosts: true });
  let commands = 0, deliveries = 0, changed = false;
  const commandInputs: Parameters<RuntimeHostClient["command"]>[0][] = [];
  const publish = () => journal.append({ scope: { type: "session", id: r.f.attempt.conversationId! }, kind: "session-status", payload: {
    conversationId: r.f.attempt.conversationId, sessionKey: r.f.key, hostKind: "claude-broker", host: "hosted", turn: "idle",
    activeTurnId: null, attentionIds: [], provenance: "structured", artifactPath: r.f.transcriptPath,
    writerClaim: "fixture:1", capabilities: { steer: false, structuredAttention: true },
  } });
  publish();
  const client = {
    readSession: async () => {
      if (!changed) {
        changed = true;
        if (scenario === "operator input") {
          r.records.push({ type: "user", timestamp: r.ports.now(), origin: { kind: "human" },
            message: { role: "user", content: "Wait for review" } });
          r.write();
        }
        if (scenario === "operator stop") r.setStopped();
      }
      return journal.readSession({ conversationId: r.f.attempt.conversationId! });
    },
    operationStatus: async (id: string) => journal.operationResult(id),
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => {
      commands++;
      commandInputs.push(structuredClone(command));
      let result = journal.executeOperation(command);
      if (result.receipt.status === "queued") {
        result = journal.transitionOperation(result.operationId, "delivering");
        if (result.receipt.status === "delivering") {
          deliveries++;
          result = journal.transitionOperation(result.operationId, "delivered");
        }
      }
      if (scenario === "lost ACK" && commands === 1) throw new Error("acknowledgment lost");
      return result;
    },
  } as unknown as RuntimeHostClient;
  r.ports.resumeSeveredTurn = async input => {
    const result = await enqueueStructuredMessage({ path: input.transcriptPath, conversationId: input.conversationId,
      clientMessageId: input.clientMessageId, text: input.text, policy: input.policy,
      origin: delegatusMessageOrigin("pipeline", input.project, input.cwd), ...(input.cohortAt ? { cohortAt: input.cohortAt } : {}) }, {
      enabled: () => true, registry: () => r.f.registry, client: () => client, kick: () => {},
      idleContinuationAllowed: input.continuationAllowed,
    });
    if (result?.ok) r.sends.push(input);
    return result?.ok === true;
  };
  try {
    await tickPipelines([], r.ports);
    if (scenario === "lost ACK") await tickPipelines([], r.ports);
    const allowed = scenario === "deliver" || scenario === "lost ACK";
    expect(changed).toBe(true);
    expect({ commands, deliveries }).toEqual({ commands: scenario === "lost ACK" ? 2 : allowed ? 1 : 0, deliveries: allowed ? 1 : 0 });
    if (scenario === "lost ACK") expect(commandInputs[1]).toEqual(commandInputs[0]);
    expect(r.sends).toHaveLength(allowed ? 1 : 0);
    if (allowed) {
      const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
      expect(r.f.registry.deliveryAdmissionForKey(attempt.conversationId!, attempt.restoreContinuation!.clientMessageId))
        .toMatchObject({ outcome: "admitted", state: "delivered" });
    }
  } finally { journal.close(); await r.f.end(); }
});

test("restored stage sends at most three continuations then parks with its persisted count", async () => {
  const r = await restoredStage();
  try {
    for (let n = 1; n <= 3; n++) {
      await tickPipelines([], { ...r.ports, restartRecoveryBootId: () => `boot-${n}` });
      expect(r.sends).toHaveLength(n);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restoreContinuation?.count).toBe(n);
      r.advance(WAIT);
    }
    await tickPipelines([], r.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("3");
    expect(loadPipelines()[0]!.stateDetail).toContain("retry-stage");
    expect(new Set(r.sends.map(send => send.clientMessageId)).size).toBe(3);
  } finally { await r.f.end(); }
});

test("fresh controller processes retain the delivery budget and its exhaustion", async () => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    const probe = path.join(path.dirname(r.f.transcriptPath), "restore-probe.ts");
    const moduleUrl = (file: string) => new URL(file, import.meta.url).href;
    fs.writeFileSync(probe, `
      import { defaultPipelinePorts, tickPipelines } from ${JSON.stringify(moduleUrl("./engine.ts"))};
      import { loadPipelines } from ${JSON.stringify(moduleUrl("./store.ts"))};
      import { durableStageTurnEvidence } from ${JSON.stringify(moduleUrl("./durableEvidence.ts"))};
      import { registerPipelineTick } from ${JSON.stringify(moduleUrl("./controllerSignal.ts"))};
      registerPipelineTick(async () => {});
      const lane = loadPipelines()[0];
      const attempt = lane.runs[0].attempts[0];
      const keys = [];
      const ports = { ...defaultPipelinePorts(),
        now: () => process.argv[2], monotonicNow: () => 0,
        worktreePresent: () => true, headCwd: () => lane.worktreeDir,
        pathForConversation: () => attempt.agentPath,
        conversationIdForPath: () => attempt.conversationId,
        sourcePathAllowed: () => true,
        spawnReceipt: () => null, accountExhausted: () => false, allowedAccountIds: () => null,
        conversationOutOfMemory: async () => null,
        conversationAgentActive: async () => null, conversationTurnInterrupted: async () => "idle",
        conversationRestartCutHeld: () => false, conversationInterruption: () => null,
        conversationRestartCut: () => ({recordedAt: ${JSON.stringify(r.cutAt)}}),
        conversationOperatorStopped: async () => false, conversationDeliveryOutstanding: () => false,
        conversationDeliveryCompleted: () => true,
        durableTurnEvidence: durableStageTurnEvidence,
        resumeSeveredTurn: async input => {
          if (!await input.continuationAllowed()) return false;
          keys.push(input.clientMessageId); return true;
        },
        scheduleTick: () => {},
      };
      await tickPipelines([], ports);
      const current = loadPipelines()[0];
      console.log(JSON.stringify({keys, state: current.state, recovery: current.runs[0].attempts[0].restoreContinuation}));
      await (await import(${JSON.stringify(moduleUrl("../links/taskPageWorker.ts"))})).shutdownTaskPageWorker();
    `);
    const pids: number[] = [];
    for (const count of [2, 3, 3, 3]) {
      r.advance(WAIT);
      const child = spawn(process.execPath, [probe, r.ports.now()], { env: { ...process.env, LLV_STRUCTURED_HOSTS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      pids.push(child.pid!);
      let stdout = "", stderr = "";
      child.stdout!.on("data", chunk => { stdout += chunk; });
      child.stderr!.on("data", chunk => { stderr += chunk; });
      const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const result = JSON.parse(stdout.trim());
      expect(result.recovery.count).toBe(count);
      expect(result.keys).toHaveLength(count === 2 || pids.length === 2 ? 1 : 0);
      expect(result.state).toBe(pids.length < 3 ? "running" : "needs_decision");
    }
    expect(pids).toHaveLength(4);
  } finally { await r.f.end(); }
});

test("loaded restore records can be changed without mutating the persisted budget", async () => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    const detached = loadPipelines()[0]!;
    detached.runs[0]!.attempts[0]!.restoreContinuation!.count = 3;
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restoreContinuation?.count).toBe(1);
  } finally { await r.f.end(); }
});

test("a pending delivery holds the restore continuation and cannot spend a second send", async () => {
  const r = await restoredStage();
  try {
    r.setOutstanding(true);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(0);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    r.setOutstanding(false);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    r.setCompleted(false);
    r.advance(WAIT);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
  } finally { await r.f.end(); }
});

test.each(["missing", "failed"] as const)("%s delivery proof cannot admit a second continuation", async proof => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    if (proof === "missing") delete r.ports.conversationDeliveryCompleted;
    else r.ports.conversationDeliveryCompleted = () => { throw new Error("receipt read refused"); };
    r.advance(WAIT);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restoreContinuation?.count).toBe(1);
  } finally { await r.f.end(); }
});

test.each(["refused", "lost ACK", "exception"] as const)("a %s continuation reuses its reserved delivery identity", async outcome => {
  const r = await restoredStage();
  try {
    const keys: string[] = [];
    r.ports.resumeSeveredTurn = async input => {
      keys.push(input.clientMessageId);
      if (outcome === "exception") throw new Error("transport unavailable");
      if (outcome === "lost ACK") input.onUncertain?.();
      return false;
    };
    await tickPipelines([], r.ports);
    await tickPipelines([], r.ports);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restoreContinuation?.count).toBe(1);
    r.advance(WAIT);
    await tickPipelines([], r.ports);
    expect(keys).toHaveLength(2);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
  } finally { await r.f.end(); }
});

test("operator stop retains its authority over restored stage recovery", async () => {
  const r = await restoredStage();
  try {
    r.setStopped();
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(0);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { await r.f.end(); }
});

test("a genuine running turn is never prompted or expired by restore recovery", async () => {
  const r = await restoredStage();
  try {
    r.setActive();
    await tickPipelines([], r.ports);
    r.advance(4 * WAIT);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(0);
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { await r.f.end(); }
});

test("a scan and runtime that agree work is live retain the cheap controller path", async () => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    r.setActive();
    let reads = 0;
    r.ports.durableTurnEvidence = async () => { reads++; throw new Error("live turn read its history"); };
    await tickPipelines([{ ...entry(r.f.transcriptPath), activity: "live" }], r.ports);
    expect(reads).toBe(0);
    expect(r.sends).toHaveLength(1);
    expect(loadPipelines()[0]!.state).toBe("running");
  } finally { await r.f.end(); }
});

test("real Claude tool work keeps the idle-host quiet bound after restore", async () => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    r.advance(1000);
    r.records.push({ type: "assistant", timestamp: r.ports.now(), message: { role: "assistant", model: "claude-test",
      content: [{ type: "tool_use", id: "long-check", name: "Bash", input: { command: "check" } }] } });
    r.write();
    r.advance(WAIT);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restoreContinuation?.count).toBe(1);
    r.advance(12 * 60_000);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(2);
  } finally { await r.f.end(); }
});

test("work after continuation can report through the stage completion writer and settle normally", async () => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    r.advance(1000);
    const report = await engineModule.reportStageCompletion({ verdict: "pass", summary: "Work and checks completed" },
      { kind: "agent", role: "builder", conversationId: r.f.attempt.conversationId! }, r.ports);
    expect(report).not.toHaveProperty("error");
    r.advance(1000);
    r.records.push({ type: "assistant", timestamp: r.ports.now(), message: { role: "assistant", model: "claude-test",
      stop_reason: "end_turn", content: [{ type: "text", text: "Work and checks completed." }] } });
    r.write();
    await tickPipelines([], r.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    expect(r.sends).toHaveLength(1);
  } finally { await r.f.end(); }
});

test("a restored terminal turn without a report gets another continuation before missing-verdict settlement", async () => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    r.advance(1000);
    r.records.push({ type: "assistant", timestamp: r.ports.now(), message: { role: "assistant", model: "claude-test",
      stop_reason: "end_turn", content: [{ type: "text", text: "I will check the interrupted command." }] } });
    r.write();
    r.advance(WAIT);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(2);
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { await r.f.end(); }
});

test.each(["prompt", "stop", "pending", "active", "native tool work", "account", "restart hold", "deploy hold"] as const)
("restore delivery rechecks %s at the final admission callback", async change => {
  const r = await restoredStage();
  try {
    let changed = false;
    r.ports.allowedAccountIds = () => changed && change === "account" ? [] : null;
    r.ports.conversationRestartCutHeld = () => changed && change === "restart hold";
    r.ports.conversationInterruption = () => changed && change === "deploy hold" ? {
      state: "owed", recordedAt: r.ports.now(), resolvedAt: null,
    } : null;
    r.ports.resumeSeveredTurn = async input => {
      changed = true;
      if (change === "prompt") {
        r.records.push({ type: "user", timestamp: new Date(Date.parse(r.cutAt) + 500).toISOString(),
          origin: { kind: "human" }, message: { role: "user", content: "Wait for my review" } });
        r.write();
      } else if (change === "stop") r.setStopped();
      else if (change === "pending") r.setOutstanding(true);
      else if (change === "active") r.setActive();
      else if (change === "native tool work") {
        r.advance(1000);
        r.records.push({ type: "assistant", timestamp: r.ports.now(), message: { role: "assistant", model: "claude-test",
          content: [{ type: "tool_use", id: "native-check", name: "Bash", input: { command: "check" } }] } });
        r.write();
      }
      const allowed = await input.continuationAllowed!();
      if (allowed) r.sends.push(input);
      return allowed;
    };
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(0);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { await r.f.end(); }
});

test.each(["report", "control", "identity"] as const)("a retained queue callback rereads persisted %s authority", async change => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    if (change === "report") attempt.report = recoveryReport(r.ports.now());
    if (change === "control") lane.controlGeneration = "operator-control-generation";
    if (change === "identity") attempt.conversationId = "conversation_replacement";
    savePipelines([lane]);
    const before = loadPipelines()[0]!;
    expect(await r.sends[0]!.continuationAllowed!()).toBe(false);
    expect(loadPipelines()[0]).toEqual(before);
  } finally { await r.f.end(); }
});

test("a continuation reserved for an earlier conversation cannot be redirected by a later tick", async () => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.conversationId = "conversation_successor";
    savePipelines([lane]);
    r.advance(WAIT);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restoreContinuation?.conversationId).toBe(r.f.attempt.conversationId!);
  } finally { await r.f.end(); }
});

test.each(["transcript", "runtime", "operator lookup"] as const)("new input during the %s await withdraws restore admission", async step => {
  const r = await restoredStage();
  try {
    let injecting = false, changed = false;
    const change = () => {
      if (!injecting || changed) return;
      changed = true;
      r.records.push({ type: "user", timestamp: r.ports.now(), origin: { kind: "human" },
        message: { role: "user", content: "Hold for review" } });
      r.write();
    };
    if (step === "transcript") r.ports.durableTurnEvidence = async (...args) => {
      const evidence = await durableStageTurnEvidence(...args);
      change();
      return evidence;
    };
    if (step === "runtime") r.ports.conversationAgentActive = async () => { change(); return null; };
    if (step === "operator lookup") r.ports.conversationOperatorStopped = async () => { change(); return false; };
    r.ports.resumeSeveredTurn = async input => {
      injecting = true;
      const allowed = await input.continuationAllowed!();
      if (allowed) r.sends.push(input);
      expect(changed).toBe(true);
      return allowed;
    };
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(0);
  } finally { await r.f.end(); }
});

test("a transcript append during delivery reconciliation cannot expire a newly working turn", async () => {
  const r = await restoredStage();
  try {
    await tickPipelines([], r.ports);
    r.advance(3 * WAIT);
    r.ports.conversationDeliveryCompleted = () => {
      r.records.push({ type: "assistant", timestamp: r.ports.now(), message: { role: "assistant", model: "claude-test",
        content: [{ type: "tool_use", id: "recheck", name: "Bash", input: { command: "check" } }] } });
      r.write();
      return true;
    };
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(1);
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restoreContinuation?.count).toBe(1);
  } finally { await r.f.end(); }
});

test("operator stop arriving during the final runtime lookup withdraws dispatch", async () => {
  const r = await restoredStage();
  try {
    let injecting = false;
    r.ports.conversationAgentActive = async () => { if (injecting) r.setStopped(); return null; };
    r.ports.resumeSeveredTurn = async input => {
      injecting = true;
      const allowed = await input.continuationAllowed!();
      if (allowed) r.sends.push(input);
      return allowed;
    };
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(0);
  } finally { await r.f.end(); }
});

test.each(["unreadable", "partial history"] as const)("%s evidence refuses delivery and reaches a durable deadline", async cause => {
  const r = await restoredStage();
  try {
    r.ports.durableTurnEvidence = async () => cause === "unreadable" ? null
      : { turn: "busy", message: null, lastAgentEventAt: Date.parse(r.cutAt) - 1000, promptHistoryComplete: false };
    await tickPipelines([], r.ports);
    r.advance(WAIT);
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(0);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { await r.f.end(); }
});

test.each(["normal Claude", "Codex", "final verdict"] as const)("%s retains its existing settlement behaviour", async kind => {
  const r = await restoredStage();
  try {
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    if (kind === "normal Claude") r.ports.conversationRestartCut = () => null;
    if (kind === "Codex") {
      attempt.effectiveRole = { ...attempt.effectiveRole, engine: "codex", model: "gpt-5.6-sol" };
      savePipelines([lane]);
      r.ports.durableTurnEvidence = async () => ({ turn: "busy", message: null,
        lastAgentEventAt: Date.parse(r.cutAt) + 1000, lastRecordAt: Date.parse(r.cutAt) + 1000 });
    }
    if (kind === "final verdict") {
      r.records.push({ type: "assistant", timestamp: new Date(Date.parse(r.cutAt) + 1000).toISOString(),
        message: { role: "assistant", model: "claude-test", stop_reason: "end_turn", content: [
          { type: "text", text: 'Done\n\n```json\n{"status":"pass","findings":[]}\n```' },
        ] } });
      r.write();
    }
    await tickPipelines([], r.ports);
    expect(r.sends).toHaveLength(0);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restoreContinuation).toBeUndefined();
    if (kind === "final verdict") expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
  } finally { await r.f.end(); }
});
