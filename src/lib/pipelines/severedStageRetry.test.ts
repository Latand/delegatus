import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

/* Isolated state only: this suite seats registry rows, drives a runtime kill
   and ticks pipelines against them. The only pid it can ever signal is a child
   it started itself, and it must never read the operator's live state
   directory. Structured hosting is pinned off so nothing reaches a runtime
   host: the delivery controller here is bound to a journal of its own. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-severed-stage-retry-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
  LLV_STRUCTURED_HOSTS: "0",
};
const ambientEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
);
for (const [name, value] of Object.entries(isolatedEnvironment)) {
  if (name !== "LLV_STRUCTURED_HOSTS") fs.mkdirSync(value, { recursive: true });
  process.env[name] = value;
}

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { procBackend } = await import("@/lib/proc");
const { captureProcessIdentity, processIdentityStatus } = await import("@/lib/processIdentity");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
const { dispatchStructuredControl, RUNTIME_HOST_UNAVAILABLE_CODE } = await import("@/lib/runtime/structuredControls");
const { conversationTurnLiveness, LIVENESS_CPU_PROGRESS_WINDOW_MS } = await import("@/lib/runtime/liveness");
const { ClaudeStreamBrokerHost } = await import("@/lib/runtime/claudeStreamBrokerHost");
const { bindClaudeHostPersistence, claudeHostColumns } = await import("@/lib/runtime/registry");
const { orphanWriterTree } = await import("@/lib/runtime/fixtures/orphanWriterTree");
const { createPipelineFromRequest, defaultPipelinePorts, patchPipeline, reportStageCompletion, stopPipelineStageAgent, stopSettledPipelineStageWriter, tickPipelines } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
const { registerPipelineTick } = await import("./controllerSignal");
type PipelinePorts = import("./engine").PipelinePorts;
type RuntimeHostClient = import("@/lib/runtime/client").RuntimeHostClient;

/* A tick this suite did not ask for must never reach the real ports. */
registerPipelineTick(async () => {});

afterAll(() => {
  setAgentRegistryForTests(null);
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

const TOOL_CALL_AT = "2026-08-29T03:24:00.000Z";
const TOOL_RESULT_AT = "2026-08-29T03:24:05.000Z";
const STAGE_HEAD = "1111111111111111111111111111111111111111";
/* The incident's own interval: the host had been up 34 minutes when the kill
   was attempted. Both clocks move together, because a wall clock 34 minutes
   ahead is a machine that has been up 34 minutes longer. */
const LATER_MS = 34 * 60_000;

function runtimeJournalClient(journal: InstanceType<typeof RuntimeJournal>): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    retryOperation: async (operationId, nextIdempotencyKey, options) =>
      journal.retryOperation(operationId, nextIdempotencyKey, options),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) =>
      journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

async function settles(assertion: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error(`${what} did not settle`);
}

const OPEN_TURN_TRANSCRIPT = [
  JSON.stringify({ type: "assistant", timestamp: TOOL_CALL_AT, message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }),
  JSON.stringify({ type: "user", timestamp: TOOL_RESULT_AT, message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
  "",
].join("\n");

/** A tail no reader can parse: the record is cut off mid-object. */
const UNREADABLE_TRANSCRIPT = '{"type":"assistant","timestamp":"2026-08-29T03:24:0';

/**
 * A stage whose structured host is the incident's specimen: a live process that
 * has written nothing since its own launch, over a transcript whose last event
 * is an unanswered tool call from before that launch.
 *
 * `hostProcess` replaces that live child with a pid the row still names and the
 * machine no longer runs, and `body` replaces the transcript — together, the
 * shape a redeploy leaves behind when the artifact is also unreadable.
 */
function severedStage(
  options: { body?: string; recordedTurn?: "busy" | "terminal"; hostProcess?: { pid: number; startIdentity: string } } = {},
) {
  const directory = fs.mkdtempSync(path.join(isolated, "stage-"));
  const worktreeDir = path.join(directory, "worktree");
  fs.mkdirSync(worktreeDir, { recursive: true });
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const child = options.hostProcess ? null : Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const hostProcess = options.hostProcess ?? captureProcessIdentity(child!.pid);
  if (!hostProcess.startIdentity) throw new Error("the fixture host has no start identity to fence on");
  const sessionId = crypto.randomUUID();
  const transcript = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, options.body ?? OPEN_TURN_TRANSCRIPT);
  const anHourAgo = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(transcript, anHourAgo, anHourAgo);
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: worktreeDir, transport: "structured", accountId: null });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "claude", sessionId },
    artifactPath: transcript,
    cwd: worktreeDir,
    accountId: null,
    status: "live",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: `stdio:${hostProcess.pid}`,
      process: hostProcess,
      eventCursor: 0,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:severed-stage-fixture",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  if (options.recordedTurn) {
    /* The turn word the durable record carries, inherited from whoever wrote it
       last. No retry is ever decided on it (#1281), and a case that means to
       prove that has to put the word there. */
    registry.reconcileConversations([{
      engine: "claude",
      path: transcript,
      accountId: null,
      launchProfile: settled.conversation.generations.at(-1)!.launchProfile,
      turn: {
        state: options.recordedTurn,
        source: "lifecycle",
        terminalAt: options.recordedTurn === "terminal" ? TOOL_RESULT_AT : null,
      },
      observedAt: "2026-08-29T03:30:00.000Z",
    }]);
  }
  setAgentRegistryForTests(registry);
  return {
    registry,
    worktreeDir,
    transcript,
    launchId: begun.receipt.launchId,
    key: { engine: "claude" as const, sessionId },
    conversationId: settled.conversation.id,
    child: { pid: hostProcess.pid, exited: child?.exited ?? Promise.resolve(0),
      kill: () => { try { child?.kill("SIGKILL"); } catch { /* gone */ } } },
  };
}

/**
 * The pipeline ports, real everywhere the incident runs through them: host
 * liveness, durable turn evidence and the spawn receipt all read the registry
 * this test seated. Only the outside world is stubbed — git, and starting an
 * agent, which no test may do — plus the wall clock, so the dead-host grace can
 * be spent without waiting it out.
 */
function stagePorts(
  stage: ReturnType<typeof severedStage>,
  spawns: string[],
  options: {
    liveness?: NonNullable<Parameters<typeof defaultPipelinePorts>[0]>["liveness"];
    autonomousStopClient?: RuntimeHostClient;
  } = {},
): PipelinePorts {
  let wallClockOffsetMs = 0;
  const defaults = defaultPipelinePorts({ liveness: options.liveness });
  const ports: PipelinePorts = {
    ...defaults,
    engineReadiness: () => "connected",
    cpuPressureHold: () => null,
    cpuAdmissionReconcile: () => {},
    cpuAdmissionSuspend: () => {},
    now: () => new Date(Date.now() + wallClockOffsetMs).toISOString(),
    exec: (rawCommand, rawArgs) => {
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${STAGE_HEAD}\n`, stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: "pipeline/severed-stage\n", stderr: "" };
      if (args[0] === "remote") return { code: 2, stdout: "", stderr: "error: No such remote 'origin'\n" };
      if (args[0] === "ls-remote") return { code: 0, stdout: `${STAGE_HEAD}\trefs/heads/pipeline/severed-stage\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({
      ok: true,
      repoDir,
      gitCommonDir: path.join(repoDir, ".git"),
      worktreeParent: path.dirname(repoDir),
    }),
    roleLookup: (roleId) => roleId === "builder"
      ? { engine: "claude", model: "opus", effort: "xhigh", access: "read-write", promptScaffold: "Builder guidance" }
      : null,
    /* The first launch is the stage host this suite seated; a later one is the
       replacement a retry asks for. No agent is ever started. */
    spawnAgent: async ({ clientAttemptId }, onReserved) => {
      spawns.push(clientAttemptId);
      if (spawns.length === 1) {
        await onReserved({ launchId: stage.launchId, conversationId: stage.conversationId });
        return {
          launchId: stage.launchId,
          conversationId: stage.conversationId,
          sessionId: stage.key.sessionId,
          ["transcript"]: stage.transcript,
          paneId: null,
        };
      }
      const replacement = `replacement-${spawns.length - 1}`;
      await onReserved({ launchId: replacement, conversationId: `conversation_${replacement}` });
      return {
        launchId: replacement,
        conversationId: `conversation_${replacement}`,
        sessionId: `session-${replacement}`,
        ["transcript"]: path.join(path.dirname(stage.transcript), `${replacement}.jsonl`),
        paneId: null,
      };
    },
    stopStageAgent: options.autonomousStopClient
      ? (target) => stopPipelineStageAgent(target, {
          client: options.autonomousStopClient,
          action: async ({ conversationId, transcriptPath, action }) => await dispatchStructuredControl({
            path: transcriptPath,
            conversationId,
            action,
          }, {
            registry: stage.registry,
            client: options.autonomousStopClient,
            enabled: () => true,
          }) ?? { status: 409, body: { error: "structured control was unavailable" } },
        })
      : async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "not-running" }),
    stageHostResident: async () => false,
    paneAgentAlive: async () => false,
    worktreePresent: () => true,
    headCwd: () => stage.worktreeDir,
    sourcePathAllowed: (pathname) => pathname.endsWith(".jsonl"),
    projectForCwd: () => "fixture",
  };
  return Object.assign(ports, {
    advanceWallClock: (milliseconds: number) => { wallClockOffsetMs += milliseconds; },
  });
}

test("a CPU-flat stage autonomously retires its exact child before one replacement attempt (#1296)", async () => {
  const stage = severedStage();
  const journal = new RuntimeJournal(path.join(path.dirname(stage.transcript), "autonomous-runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const livenessStartedAt = Date.now() + LATER_MS;
  const livenessUptimeAtStart = os.uptime() + LATER_MS / 1_000;
  let livenessElapsedMs = 0;
  const liveness = {
    now: () => livenessStartedAt + livenessElapsedMs,
    uptimeSeconds: () => livenessUptimeAtStart + livenessElapsedMs / 1_000,
    /* A one-time resume cost makes lifetime CPU look active. Holding this
       value flat makes the recent observation window the deciding evidence. */
    processCpuMs: () => 20_000,
  };
  const spawns: string[] = [];
  const ports = stagePorts(stage, spawns, { liveness, autonomousStopClient: client }) as PipelinePorts & {
    advanceWallClock(ms: number): void;
  };

  try {
    savePipelines([]);
    const created = await createPipelineFromRequest({
      task: "Recover the CPU-flat stage",
      spec: "AC1",
      repoDir: stage.worktreeDir,
      src: stage.transcript,
      stages: [{
        id: "build",
        kind: "run",
        role: { roleId: "builder" },
        access: "read-write",
        ["prompt"]: "Build the scoped change",
        next: null,
      }],
    } as never, ports);
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running" });

    await bindStructuredDeliveryQueue([], { registry: stage.registry, client, liveness });
    ports.advanceWallClock(6 * 60_000);

    /* The first production liveness read records the baseline. Even with the
       pipeline grace already spent, no host may retire before the full recent
       CPU window exists. */
    await tickPipelines([], ports);
    livenessElapsedMs = LIVENESS_CPU_PROGRESS_WINDOW_MS - 1;
    await tickPipelines([], ports);
    expect(procBackend.pidAlive(stage.child.pid)).toBe(true);
    expect(stage.registry.readOnlySnapshot().entries[`claude:${stage.key.sessionId}`]).toMatchObject({
      status: "live",
      structuredHost: { process: { pid: stage.child.pid } },
    });
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running" });

    livenessElapsedMs = LIVENESS_CPU_PROGRESS_WINDOW_MS;
    const recent = await conversationTurnLiveness(stage.registry, stage.conversationId, liveness);
    expect(recent).toMatchObject({ state: "severed", hostEvidence: { cpuProgress: {
      consumedMs: 0,
      observedMs: LIVENESS_CPU_PROGRESS_WINDOW_MS,
    } } });
    expect(recent?.reason).toContain(`latest ${LIVENESS_CPU_PROGRESS_WINDOW_MS / 1_000}s`);
    await tickPipelines([], ports);

    expect(procBackend.pidAlive(stage.child.pid)).toBe(false);
    expect(stage.registry.readOnlySnapshot().entries[`claude:${stage.key.sessionId}`]).toMatchObject({
      status: "dead",
      structuredHost: null,
    });
    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "failed" });

    const retried = await patchPipeline(parked.id, { action: "retry-stage" }, ports);
    expect(retried.error).toBeUndefined();
    await tickPipelines([], ports);
    expect(spawns).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]).toMatchObject({
      n: 2,
      launchId: "replacement-1",
    });
  } finally {
    stage.child.kill();
    await stage.child.exited;
    await bindStructuredDeliveryQueue([], { registry: stage.registry, client: null });
    journal.close();
  }
});

test("a live severed stage host is killed, retired, and its stage retried once, through the seams the incident ran through (#1282)", async () => {
  const stage = severedStage();
  const journal = new RuntimeJournal(path.join(path.dirname(stage.transcript), "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const spawns: string[] = [];
  const ports = stagePorts(stage, spawns) as PipelinePorts & { advanceWallClock(ms: number): void };

  try {
    /* 0. A pipeline whose one stage is running on that host, provisioned and
       spawned through the engine's own path. */
    savePipelines([]);
    const created = await createPipelineFromRequest({
      task: "Ship the severed stage",
      spec: "AC1",
      repoDir: stage.worktreeDir,
      src: stage.transcript,
      stages: [{
        id: "build",
        kind: "run",
        role: { roleId: "builder" },
        access: "read-write",
        ["prompt"]: "Build the scoped change",
        next: null,
      }],
    } as never, ports);
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
      state: "running",
      conversationId: stage.conversationId,
      launchId: stage.launchId,
      paneId: null,
    });

    /* 1. The operator's kill, admitted as a runtime operation and executed by
       the delivery controller — the path that refused forever while the
       recorded process was alive and this Viewer was its claim owner. */
    journal.executeOperation({
      kind: "kill",
      operationId: "kill-severed-stage",
      idempotencyKey: "kill-severed-stage",
      conversationId: stage.conversationId,
      sessionKey: stage.key,
    });
    await bindStructuredDeliveryQueue([], {
      registry: stage.registry,
      client,
      /* Real process, real transcript, real registry; only the clock is moved,
         so the host reaches the age the incident's host had. */
      liveness: {
        now: () => Date.now() + LATER_MS,
        uptimeSeconds: () => os.uptime() + LATER_MS / 1_000,
        processCpuMs: () => 4_700,
      },
    });

    await settles(
      () => journal.operationResult("kill-severed-stage")?.receipt.status === "delivered",
      "the kill operation",
    );
    /* 2. The process is gone and the row retired, so the registry stops
       claiming a host for this conversation. */
    await settles(() => !procBackend.pidAlive(stage.child.pid), "the reaped host process");
    expect(stage.registry.readOnlySnapshot().entries[`claude:${stage.key.sessionId}`]).toMatchObject({
      status: "dead",
      structuredHost: null,
    });

    /* 3. The pipeline tick, reading host liveness through its own port. */
    ports.advanceWallClock(6 * 60_000);
    await tickPipelines([], ports);

    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "failed" });

    /* 4. `retry-stage`, which the stage's stuck `running` state used to refuse
       — the lane could only be freed by closing the pipeline. */
    const retried = await patchPipeline(parked.id, { action: "retry-stage" }, ports);
    expect(retried.error).toBeUndefined();
    expect(retried.pipeline?.state).not.toBe("closed");

    await tickPipelines([], ports);

    /* 5. Exactly one replacement attempt for the severed one. */
    expect(spawns).toHaveLength(2);
    const resumed = loadPipelines()[0]!;
    expect(resumed.state).not.toBe("closed");
    expect(resumed.runs[0]!.attempts).toHaveLength(2);
    expect(resumed.runs[0]!.attempts[1]).toMatchObject({ n: 2, launchId: "replacement-1" });
  } finally {
    stage.child.kill();
    await stage.child.exited;
    await bindStructuredDeliveryQueue([], { registry: stage.registry, client: null });
    journal.close();
  }
});

test.each(["busy", "terminal"] as const)(
  "a stage whose host is gone and whose transcript cannot be read is never retried on a stale %s turn word",
  async (recordedTurn) => {
    /* The same seams as the sequence above, with one fact removed: the
       transcript cannot be parsed. What remains is a row that still reads
       `live`, a pid the machine no longer runs, and a word claiming a turn is
       in flight or finished. Under the reading this replaced, the missing pid
       alone answered `severed`, the tick spent the dead-host grace and failed
       the attempt, and `retry-stage` re-ran a step that may have completed
       before the process ever went away. Nothing separates that from a turn cut
       off mid-work, so nothing happens: the attempt keeps running and no
       replacement is spawned (#1281). */
    const stage = severedStage({
      body: UNREADABLE_TRANSCRIPT,
      recordedTurn,
      hostProcess: { pid: 2_000_000_005, startIdentity: "pre-restart-host" },
    });
    const spawns: string[] = [];
    const ports = stagePorts(stage, spawns) as PipelinePorts & { advanceWallClock(ms: number): void };

    savePipelines([]);
    const created = await createPipelineFromRequest({
      task: "Ship the unreadable stage",
      spec: "AC1",
      repoDir: stage.worktreeDir,
      src: stage.transcript,
      stages: [{
        id: "build",
        kind: "run",
        role: { roleId: "builder" },
        access: "read-write",
        ["prompt"]: "Build the scoped change",
        next: null,
      }],
    } as never, ports);
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running" });

    /* Well past the grace a genuinely dead host is failed after. */
    ports.advanceWallClock(6 * 60_000);
    await tickPipelines([], ports);

    const held = loadPipelines()[0]!;
    expect(held.runs[0]!.attempts[0]).toMatchObject({ state: "running" });
    expect(held.runs[0]!.attempts).toHaveLength(1);
    expect(held.state).not.toBe("needs_decision");
    expect(spawns).toHaveLength(1);
  },
);

/**
 * #2790, end to end through the pipeline's own recovery. The stage's agent is
 * a real process. While its turn is open, one of its descendants moves into a
 * transient user scope of its own (`systemd-run --user --scope`, the wrapper
 * the incident's build steps ran under; `setsid` where no user manager runs)
 * and that scope ends. Nothing may treat that as the agent going away. Then
 * the stream is lost while the agent keeps running: the row turns `dead` with
 * the agent's identity still recorded, as a host publishes it before its reap.
 * The recovery must end that process by its recorded identity before it
 * starts the replacement, so two writers never share the worktree.
 */
test("a descendant's transient scope ending leaves the stage alone, and a lost stream stops the live agent before its replacement (#2790)", async () => {
  const directory = fs.mkdtempSync(path.join(isolated, "scope-descendant-"));
  const worktreeDir = path.join(directory, "worktree");
  fs.mkdirSync(worktreeDir, { recursive: true });
  const descendantFile = path.join(directory, "descendant.pid");
  const scoped = Bun.spawnSync(["systemd-run", "--user", "--scope", "--quiet", "--collect", "--", "true"],
    { stdout: "ignore", stderr: "ignore", timeout: 5_000 }).exitCode === 0;
  const wrapper = scoped ? "systemd-run --user --scope --quiet --collect --" : "setsid";
  const agent = Bun.spawn(["bash", "-c",
    `${wrapper} sleep 1 & d=$!; echo "$d" > "$1"; wait "$d"; echo ended > "$1.ended"; exec sleep 300`,
    "agent", descendantFile], { stdout: "ignore", stderr: "ignore" });
  const agentIdentity = captureProcessIdentity(agent.pid);
  const agentAlive = () => processIdentityStatus(agentIdentity) === "alive";
  const cgroupOf = (pid: number) => { try { return fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"); } catch { return null; } };
  try {
    if (!agentIdentity.startIdentity || !agentIdentity.bootEpoch) throw new Error("the agent stand-in has no complete identity");
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const sessionId = crypto.randomUUID();
    const transcript = path.join(directory, `${sessionId}.jsonl`);
    fs.writeFileSync(transcript, OPEN_TURN_TRANSCRIPT);
    const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: worktreeDir, transport: "structured", accountId: null });
    if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
    const key = { engine: "claude" as const, sessionId };
    /* The Viewer generation that hosted the stream; a pid no machine hands out. */
    const goneViewer = { pid: 2_000_000_119, startIdentity: "gone-viewer" };
    const columns = {
      kind: "claude-broker" as const,
      endpoint: `stdio:${agent.pid}`,
      process: agentIdentity,
      eventCursor: 0,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: "open-turn",
      pendingAttention: [],
      activeFlags: [],
    };
    const settled = registry.settleSpawn(begun.receipt.launchId, {
      key, artifactPath: transcript, cwd: worktreeDir, accountId: null, status: "live", host: null,
      structuredHost: columns, claimEpoch: 1, claimOwner: `structured-host:${JSON.stringify(goneViewer)}`, pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
    setAgentRegistryForTests(registry);
    const stage = {
      registry, worktreeDir, transcript, launchId: begun.receipt.launchId, key,
      conversationId: settled.conversation.id, child: { pid: agent.pid, kill: () => {} },
    };
    const spawns: string[] = [];
    const agentAliveAtReplacement: boolean[] = [];
    let interrupted: "dead" | null = null;
    const base = stagePorts(stage as ReturnType<typeof severedStage>, spawns) as PipelinePorts & { advanceWallClock(ms: number): void };
    const ports: PipelinePorts = {
      ...base,
      /* The runtime's reading of the host: running until the stream is lost. */
      conversationTurnInterrupted: async () => interrupted,
      restartRecoveryBootStartedAt: () => Date.now() - 60 * 60_000,
      stopInterruptedStageAgent: undefined,
      /* The production stop, with no structured control channel in this process. */
      stopStageAgent: (target, options) => stopPipelineStageAgent(target, { automatic: options?.automatic }),
      stageHostResident: defaultPipelinePorts().stageHostResident,
      /* The machine's own CPU pressure decides nothing in this case. */
      cpuPressureHold: () => null,
      /* No runtime host answers in this process; the operator asked for no stop. */
      conversationOperatorStopped: async () => false,
      spawnAgent: async (input, onReserved) => {
        if (spawns.length > 0) agentAliveAtReplacement.push(agentAlive());
        return base.spawnAgent(input, onReserved);
      },
    };

    savePipelines([]);
    const created = await createPipelineFromRequest({
      task: "Build behind a scope-wrapped step", spec: "AC1", repoDir: worktreeDir, src: transcript,
      stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", ["prompt"]: "Build it", next: null }],
    } as never, ports);
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", conversationId: stage.conversationId });

    /* 1. The descendant runs in a scope of its own, and that scope ends. */
    await settles(() => fs.existsSync(descendantFile), "the descendant's start");
    const descendant = Number(fs.readFileSync(descendantFile, "utf8").trim());
    if (scoped) {
      await settles(() => cgroupOf(descendant) !== cgroupOf(agent.pid) || !fs.existsSync(`/proc/${descendant}`), "the descendant's move");
    }
    for (let attempt = 0; attempt < 100 && !fs.existsSync(`${descendantFile}.ended`); attempt += 1) await Bun.sleep(30);
    expect(fs.existsSync(`${descendantFile}.ended`)).toBe(true);
    await Bun.sleep(1_100);
    await tickPipelines([], ports);
    expect(agentAlive()).toBe(true);
    expect(registry.readOnlySnapshot().entries[`claude:${sessionId}`]).toMatchObject({ status: "live", structuredHost: { process: agentIdentity } });
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running" });

    /* 2. The stream is lost; the agent is not. */
    registry.upsert({ ...registry.readOnlySnapshot().entries[`claude:${sessionId}`]!, status: "dead" });
    interrupted = "dead";
    expect(await ports.stageHostResident({ stageId: "build", attempt: 1, launchId: stage.launchId,
      conversationId: stage.conversationId, agentPath: transcript, paneId: null })).toBe(true);
    expect(await defaultPipelinePorts().conversationHostProcess!(stage.conversationId)).toMatchObject({ state: "alive", pid: agent.pid });
    await tickPipelines([], ports);
    await tickPipelines([], ports);

    expect(agentAlive()).toBe(false);
    expect(agentAliveAtReplacement).toEqual([false]);
    const replaced = loadPipelines()[0]!;
    expect(replaced.runs[0]!.attempts).toHaveLength(2);
    expect(replaced.runs[0]!.attempts[0]!.error).toBe(
      "stage host was lost while its turn was open; its agent process was still running and Delegatus stopped it by its recorded identity; replaced by a fresh stage attempt");
  } finally {
    try { agent.kill("SIGKILL"); } catch { /* gone */ }
    await Promise.race([agent.exited, Bun.sleep(2_000)]);
  }
}, 30_000);

/**
 * #2790, through a real stream host, its real persistence and the pipeline's
 * own recovery. The engine's stream fails with a tool it started still
 * writing outside its process group, a tool that ignores SIGTERM. The host
 * captures the tool onto the row before its first signal and the engine
 * exits, so the row names a dead engine and a live captured writer. Nothing
 * may start the replacement attempt in that worktree until the writer is
 * proven gone: not while the host's own ladder is still in its SIGTERM grace,
 * and not after a ladder that ended with the writer still running.
 */
async function streamFaultStage(persistence: { terminationStop?: { graceMs: number; deadlineMs: number } }) {
  const directory = fs.mkdtempSync(path.join(isolated, "stream-fault-"));
  const worktreeDir = path.join(directory, "worktree");
  fs.mkdirSync(worktreeDir, { recursive: true });
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const tree = await orphanWriterTree({ stream: true, toolIgnoresTerm: true });
  const viewer = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  let host: Awaited<ReturnType<typeof ClaudeStreamBrokerHost.adopt>> | null = null;
  const stop = async () => {
    await host?.release().catch(() => undefined);
    await tree.stop();
  };
  try {
    const sessionId = crypto.randomUUID();
    const memoryEvents = new Map<string, unknown[]>();
    const deliveries = new Map<string, Array<{ entry: { id: string }; delivered: boolean }>>();
    host = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: worktreeDir,
      deliveryLedger: {
        load: (id) => structuredClone(deliveries.get(id) ?? []) as never,
        recordQueued: (id, entry, disposition) => {
          deliveries.set(id, [...deliveries.get(id) ?? [], { entry: structuredClone(entry), disposition, delivered: false } as never]);
        },
        confirmDelivered: () => "accepted",
      },
      eventStore: {
        load: (id) => structuredClone(memoryEvents.get(id) ?? []) as never,
        append: (id, event) => { memoryEvents.set(id, [...memoryEvents.get(id) ?? [], structuredClone(event)]); },
      },
      readTranscript: () => [],
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      shutdownGraceMs: 50,
      spawnProcess: () => tree.child,
    });
    const transcript = path.join(directory, `${sessionId}.jsonl`);
    fs.writeFileSync(transcript, OPEN_TURN_TRANSCRIPT);
    const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: worktreeDir, transport: "structured", accountId: null });
    if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
    const key = { engine: "claude" as const, sessionId };
    const settled = registry.settleSpawn(begun.receipt.launchId, {
      key, artifactPath: transcript, cwd: worktreeDir, accountId: null, status: "live", host: null,
      structuredHost: { ...claudeHostColumns(await host.health(), 1), activeTurnRef: "open-turn" },
      claimEpoch: 1, claimOwner: viewer, pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
    expect(registry.readOnlySnapshot().entries[`claude:${sessionId}`]?.structuredHost?.process).toEqual(tree.engine);
    setAgentRegistryForTests(registry);
    await bindClaudeHostPersistence(registry, key, host, viewer, 1, "unhosted", persistence);
    return {
      registry, tree, host, key, worktreeDir, transcript, launchId: begun.receipt.launchId,
      conversationId: settled.conversation.id, row: () => registry.readOnlySnapshot().entries[`claude:${sessionId}`]!, stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function runStreamFaultRecovery(
  stage: Awaited<ReturnType<typeof streamFaultStage>>,
  termination: { graceMs?: number; deadlineMs?: number } = {},
) {
  const spawns: string[] = [];
  const toolAliveAtReplacement: boolean[] = [];
  let interrupted: "dead" | null = null;
  const base = stagePorts({ ...stage, child: { pid: stage.tree.engine.pid, kill: () => {} } } as unknown as ReturnType<typeof severedStage>,
    spawns) as PipelinePorts & { advanceWallClock(ms: number): void };
  const ports: PipelinePorts = {
    ...base,
    conversationTurnInterrupted: async () => interrupted,
    restartRecoveryBootStartedAt: () => Date.now() - 60 * 60_000,
    stopInterruptedStageAgent: undefined,
    /* The production stop, with no structured control channel in this process. */
    stopStageAgent: (target, options) => stopPipelineStageAgent(target, { automatic: options?.automatic, termination }),
    stageHostResident: defaultPipelinePorts().stageHostResident,
    stageHostTreeStillRunning: defaultPipelinePorts().stageHostTreeStillRunning,
    cpuPressureHold: () => null,
    conversationOperatorStopped: async () => false,
    spawnAgent: async (input, onReserved) => {
      if (spawns.length > 0) toolAliveAtReplacement.push(stage.tree.toolAlive());
      return base.spawnAgent(input, onReserved);
    },
  };
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Build with a detached tool", spec: "AC1", repoDir: stage.worktreeDir, src: stage.transcript,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", ["prompt"]: "Build it", next: null }],
  } as never, ports);
  if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", conversationId: stage.conversationId });

  /* The stream fails; the host captures the tool and its stop ends the engine. */
  void stage.host.send({ id: "stream-fault-turn", text: "run the build" }).catch(() => undefined);
  await settles(() => !stage.tree.engineAlive(), "the engine's exit");
  expect(stage.row().structuredTerminationSurvivors).toContainEqual(stage.tree.tool);
  expect(stage.tree.toolAlive()).toBe(true);
  interrupted = "dead";
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  return { spawns, toolAliveAtReplacement, ports };
}

test("a stream fault's captured writer is ended before the replacement attempt starts, inside the host's SIGTERM grace (#2790)", async () => {
  const stage = await streamFaultStage({});
  try {
    const { spawns, toolAliveAtReplacement } = await runStreamFaultRecovery(stage);
    expect(toolAliveAtReplacement).toEqual([false]);
    expect(spawns).toHaveLength(2);
    expect(stage.tree.toolAlive()).toBe(false);
    expect(await stage.tree.stillWriting()).toBe(false);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  } finally {
    await stage.stop();
  }
}, 30_000);

test("a captured writer that outlives every ladder holds the stage: no replacement starts while it writes (#2790)", async () => {
  const incomplete = { graceMs: 60_000, deadlineMs: 300 };
  const stage = await streamFaultStage({ terminationStop: incomplete });
  try {
    const { spawns, toolAliveAtReplacement, ports } = await runStreamFaultRecovery(stage, incomplete);
    expect(toolAliveAtReplacement).toEqual([]);
    expect(spawns).toHaveLength(1);
    expect(stage.tree.toolAlive()).toBe(true);
    expect(await stage.tree.stillWriting()).toBe(true);
    const held = loadPipelines()[0]!;
    expect(held.runs[0]!.attempts).toHaveLength(1);
    expect(held.runs[0]!.attempts[0]!.unresolvedTermination?.survivors).toContainEqual(
      expect.objectContaining({ pid: stage.tree.tool.pid, startIdentity: stage.tree.tool.startIdentity }));
    expect(stage.row().structuredTerminationSurvivors).toContainEqual(stage.tree.tool);
    await tickPipelines([], ports);
    expect(spawns).toHaveLength(1);
  } finally {
    await stage.stop();
  }
}, 30_000);

/* #2790: the launch itself is the last fence. A replacement reserved by a
   path that read the old host as gone (here a stop that answers
   `not-running`) still finds the process a stop captured from that host's
   tree on its registry row, and starts no agent in the same worktree until
   it is gone. The earlier attempt is settled, so the gate ends that process
   itself, by its recorded identity, instead of waiting on a manual kill. */
test("a new attempt does not launch while a process captured from the earlier attempt's host may still run (#2790)", async () => {
  const stage = severedStage();
  const captured = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const capturedIdentity = captureProcessIdentity(captured.pid);
  try {
    const spawns: string[] = [];
    const capturedAtReplacement: string[] = [];
    let interrupted: "dead" | null = null;
    const base = stagePorts(stage, spawns) as PipelinePorts & { advanceWallClock(ms: number): void };
    const ports: PipelinePorts = {
      ...base,
      conversationTurnInterrupted: async () => interrupted,
      restartRecoveryBootStartedAt: () => Date.now() - 60 * 60_000,
      stopInterruptedStageAgent: undefined,
      stageHostTreeStillRunning: defaultPipelinePorts().stageHostTreeStillRunning,
      stopSettledStageWriter: defaultPipelinePorts().stopSettledStageWriter,
      cpuPressureHold: () => null,
      conversationOperatorStopped: async () => false,
      spawnAgent: async (input, onReserved) => {
        if (spawns.length > 0) capturedAtReplacement.push(processIdentityStatus(capturedIdentity));
        return base.spawnAgent(input, onReserved);
      },
    };
    savePipelines([]);
    const created = await createPipelineFromRequest({
      task: "Build after a captured writer", spec: "AC1", repoDir: stage.worktreeDir, src: stage.transcript,
      stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", ["prompt"]: "Build it", next: null }],
    } as never, ports);
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", conversationId: stage.conversationId });

    /* The host's stop captured a tool, ended the engine and lost its stream. */
    const rowKey = `claude:${stage.key.sessionId}`;
    const root = stage.registry.readOnlySnapshot().entries[rowKey]!.structuredHost!.process!;
    expect(stage.registry.captureStructuredTerminationSurvivors(stage.key, root, [capturedIdentity])).not.toBeNull();
    stage.child.kill();
    await settles(() => processIdentityStatus(root) === "dead", "the engine's exit");
    stage.registry.upsert({ ...stage.registry.readOnlySnapshot().entries[rowKey]!, status: "dead" });
    interrupted = "dead";
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    const replaced = loadPipelines()[0]!;
    expect(replaced.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "failed" });
    expect(spawns).toHaveLength(2);
    expect(capturedAtReplacement).toEqual(["dead"]);
    expect(await Promise.race([captured.exited.then(() => "exited"), Bun.sleep(2_000).then(() => "running")])).toBe("exited");
    expect(replaced.runs[0]!.attempts.at(-1)).toMatchObject({ n: 2, state: "running", launchId: "replacement-1" });
    expect(replaced.stateDetail ?? "").not.toContain("waiting for an earlier stage agent");
  } finally {
    stage.child.kill();
    try { captured.kill("SIGKILL"); } catch { /* gone */ }
    await Promise.all([stage.child.exited, captured.exited]);
  }
}, 30_000);

/**
 * Lane 376bce9c, 2026-10-20: the fix stage passed and its host went idle. An
 * automatic retirement of that idle host captured its tree (the engine and
 * its two MCP children) onto the registry row, was then refused before its
 * first signal and left the capture behind. Nothing ever signalled the three
 * processes, so the review attempt that followed waited about an hour on
 * "processes … captured from its stopped host may still be running" until
 * the seat killed the conversation by hand.
 *
 * Here the row is real, the processes are real children of this test, and
 * the capture is written exactly as the refused retirement wrote it. The
 * earlier stage passed through the engine's own completion path.
 */
async function passedStageWithCapturedTree(spawns: string[], stop: (ports: PipelinePorts) => PipelinePorts["stopSettledStageWriter"]) {
  const stage = severedStage();
  const helper = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const helperIdentity = captureProcessIdentity(helper.pid);
  const rowKey = `claude:${stage.key.sessionId}`;
  /* The turn ends after the report it carries. */
  const turnEnd = { text: "Done.", ts: Date.now() + 60_000 };
  let ended = false;
  const base = stagePorts(stage, spawns) as PipelinePorts & { advanceWallClock(ms: number): void };
  const ports = {
    ...base,
    roleLookup: (roleId: string) => roleId === "builder" || roleId === "reviewer"
      ? { engine: "claude" as const, model: "opus", effort: "xhigh", access: "read-write" as const, promptScaffold: "Guidance" }
      : null,
    /* The stage commits on the lane's own branch. */
    exec: (command: string, args: string[], ...rest: unknown[]) => args[0] === "branch"
      ? { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" }
      : (base.exec as (...all: unknown[]) => ReturnType<PipelinePorts["exec"]>)(command, args, ...rest),
    stageHostTreeStillRunning: defaultPipelinePorts().stageHostTreeStillRunning,
    conversationTurnInterrupted: async () => null,
    conversationOperatorStopped: async () => false,
    durableTurnEvidence: async (engine: "claude" | "codex", transcriptPath: string, ...rest: unknown[]) => ended && transcriptPath === stage.transcript
      ? { turn: "terminal" as const, message: turnEnd, lastRecordAt: turnEnd.ts }
      : await (base.durableTurnEvidence as (...args: unknown[]) => Promise<unknown>)(engine, transcriptPath, ...rest) as never,
    lastMessage: (item: { path: string }) => ended && item.path === stage.transcript ? turnEnd : null,
  } as PipelinePorts & { advanceWallClock(ms: number): void };
  ports.stopSettledStageWriter = stop(ports);
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Fix, then review", spec: "AC1", repoDir: stage.worktreeDir, src: stage.transcript, publication: "internal",
    stages: [
      { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", ["prompt"]: "Fix it", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", ["prompt"]: "Review it", next: null },
    ],
  } as never, ports);
  if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", conversationId: stage.conversationId });

  /* The stage reports and its turn ends; the host stays up, idle. */
  expect((await reportStageCompletion({ verdict: "pass", summary: "Fixed." },
    { kind: "agent", role: "builder", conversationId: stage.conversationId }, ports)).error).toBeUndefined();
  stage.registry.upsert({ ...stage.registry.readOnlySnapshot().entries[rowKey]!, status: "idle" });
  ended = true;

  /* The refused retirement's leftover: the whole tree, root included, captured
     on the live row and never signalled. */
  const root = stage.registry.readOnlySnapshot().entries[rowKey]!.structuredHost!.process!;
  expect(stage.registry.recordStructuredTerminationSurvivors(stage.key, root, [root, helperIdentity])).toBe(true);
  /* The transcript entry a scan hands the tick once the turn has ended. */
  const endedTurn = {
    path: stage.transcript, root: "claude-projects", name: path.basename(stage.transcript), project: "fixture", title: "fix",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: turnEnd.ts, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  } as unknown as Parameters<typeof tickPipelines>[0][number];
  return {
    stage, helper, helperIdentity, root, ports, rowKey, endedTurn,
    alive: () => [processIdentityStatus(root), processIdentityStatus(helperIdentity)],
    cleanup: async () => {
      stage.child.kill();
      try { helper.kill("SIGKILL"); } catch { /* gone */ }
      await Promise.all([stage.child.exited, helper.exited]);
    },
  };
}

test("a passed stage's idle host whose captured tree keeps running is stopped by its recorded identities, and the next stage starts with no manual kill", async () => {
  const spawns: string[] = [];
  const journalDir = fs.mkdtempSync(path.join(isolated, "prior-writer-runtime-"));
  const journal = new RuntimeJournal(path.join(journalDir, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  let fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>> | null = null;
  const aliveAtReplacement: string[][] = [];
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => (target, operationId) => stopSettledPipelineStageWriter(target, {
      operationId,
      client,
      /* The production control channel: a runtime kill operation, executed by
         the delivery controller bound below. */
      action: async ({ conversationId, transcriptPath, action }) => await dispatchStructuredControl({
        path: transcriptPath, conversationId, action,
      }, { registry: fixture!.stage.registry, client, enabled: () => true })
        ?? { status: 409, body: { error: "structured control was unavailable" } },
    }));
    const { ports } = fixture;
    const spawn = ports.spawnAgent;
    ports.spawnAgent = async (input, onReserved) => {
      if (spawns.length > 0) aliveAtReplacement.push(fixture!.alive());
      return spawn(input, onReserved);
    };
    await bindStructuredDeliveryQueue([], { registry: fixture.stage.registry, client });

    /* Settle the fix stage; the review stage is next. */
    for (let tick = 0; tick < 4 && spawns.length < 2; tick += 1) {
      await tickPipelines([fixture.endedTurn], ports);
      ports.advanceWallClock(10_000);
    }
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "passed" });
    expect(loadPipelines()[0]!.stateDetail ?? "").not.toContain("waiting for an earlier stage agent");
    expect(spawns).toHaveLength(2);
    expect(aliveAtReplacement).toEqual([["dead", "dead"]]);
    expect(fixture.alive()).toEqual(["dead", "dead"]);
    const lane = loadPipelines()[0]!;
    expect(lane.runs[1]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "replacement-1" });
    expect(lane.runs[1]!.attempts[0]!.priorWriterStop).toBeUndefined();
  } finally {
    await fixture?.cleanup();
    await bindStructuredDeliveryQueue([], { registry: fixture?.stage.registry, client: null });
    journal.close();
  }
}, 30_000);

test("captured processes that outlive every bounded stop park the lane with a reason the seat can act on", async () => {
  const spawns: string[] = [];
  let fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>> | null = null;
  const sent: Array<[number, string]> = [];
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => (target, operationId) => stopSettledPipelineStageWriter(target, {
      operationId,
      client: null,
      /* No runtime host answers, so the stop falls to the recorded identities;
         every signal it sends is observed and none lands. */
      action: async () => ({ status: 503, body: { ok: false, code: RUNTIME_HOST_UNAVAILABLE_CODE, error: "structured runtime host is unavailable" } }),
      termination: { signal: (pid, signal) => { sent.push([pid, signal]); }, graceMs: 20, deadlineMs: 80 },
    }));
    const { ports } = fixture;
    /* The fix stage settles, then the first stop. */
    for (let tick = 0; tick < 4 && !loadPipelines()[0]!.runs[1]?.attempts[0]?.priorWriterStop; tick += 1) {
      await tickPipelines([fixture.endedTurn], ports);
    }
    const first = loadPipelines()[0]!;
    expect(first.state).toBe("running");
    expect(first.runs[1]!.attempts[0]).toMatchObject({ state: "pending", priorWriterStop: { conversationId: fixture.stage.conversationId, tries: 1 } });
    expect(first.stateDetail).toContain("; automatic stop 1 of 3 left them running (");
    /* The stored count spaces the next stop: an early tick sends nothing. */
    const afterFirst = sent.length;
    await tickPipelines([fixture.endedTurn], ports);
    expect(sent).toHaveLength(afterFirst);
    expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.priorWriterStop?.tries).toBe(1);
    for (let tick = 0; tick < 8 && loadPipelines()[0]!.state !== "needs_decision"; tick += 1) {
      ports.advanceWallClock(10_000);
      await tickPipelines([fixture.endedTurn], ports);
    }
    const parked = loadPipelines()[0]!;
    expect(spawns).toHaveLength(1);
    expect(fixture.alive()).toEqual(["alive", "alive"]);
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", priorWriterStop: { tries: 3 } });
    expect(parked.stateDetail).toStartWith(`an earlier stage agent could not be stopped before a new attempt starts in its worktree: ${fixture.stage.conversationId}: processes ${fixture.root.pid}, ${fixture.helperIdentity.pid} captured from its stopped host may still be running; 3 automatic stops by their recorded identities (SIGTERM, then SIGKILL) left them running`);
    expect(parked.stateDetail).toContain("stop those processes, then retry the stage");
    /* Each stop escalated, and only the recorded identities were signalled. */
    expect(new Set(sent.map(([, signal]) => signal))).toEqual(new Set(["SIGTERM", "SIGKILL"]));
    const recorded = new Set([fixture.root.pid, fixture.helperIdentity.pid, -fixture.root.pid]);
    expect(sent.every(([pid]) => recorded.has(pid))).toBe(true);

    /* Parked is final until someone acts: further ticks send nothing more. */
    const signalled = sent.length;
    await tickPipelines([], ports);
    expect(sent).toHaveLength(signalled);
  } finally {
    await fixture?.cleanup();
  }
}, 30_000);

test("a settled stage's host that is in a turn is never signalled: the next attempt waits and says why", async () => {
  const spawns: string[] = [];
  let fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>> | null = null;
  const actions: string[] = [];
  const sent: number[] = [];
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => (target, operationId) => stopSettledPipelineStageWriter(target, {
      operationId,
      client: null,
      action: async ({ action }) => { actions.push(action); return { status: 503, body: { ok: false, code: RUNTIME_HOST_UNAVAILABLE_CODE } }; },
      termination: { signal: (pid) => { sent.push(pid); }, graceMs: 20, deadlineMs: 80 },
    }));
    const { ports, stage, rowKey } = fixture;
    /* Someone wrote to the passed agent and its turn is open. */
    const entry = stage.registry.readOnlySnapshot().entries[rowKey]!;
    stage.registry.upsert({ ...entry, status: "live", structuredHost: { ...entry.structuredHost!, activeTurnRef: "operator-turn" } });
    for (let tick = 0; tick < 6; tick += 1) {
      await tickPipelines([fixture.endedTurn], ports);
      ports.advanceWallClock(10 * 60_000);
    }
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts[0]).toMatchObject({ state: "passed" });
    expect(spawns).toHaveLength(1);
    expect(actions).toEqual([]);
    expect(sent).toEqual([]);
    expect(fixture.alive()).toEqual(["alive", "alive"]);
    expect(lane.state).toBe("running");
    expect(lane.runs[1]!.attempts[0]).toMatchObject({ state: "pending" });
    expect(lane.runs[1]!.attempts[0]!.priorWriterStop).toBeUndefined();
    expect(lane.stateDetail).toBe(`waiting for an earlier stage agent to stop before a new attempt starts in its worktree: ${stage.conversationId}: processes ${fixture.root.pid}, ${fixture.helperIdentity.pid} captured from its stopped host may still be running; its agent is in a turn, so it is left to finish`);
  } finally {
    await fixture?.cleanup();
  }
}, 30_000);
