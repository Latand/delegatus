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
const { startUnreapedChild } = await import("@/lib/testing/unreapedChild");
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
    transitionOperation: async (operationId, status, details, options) =>
      journal.transitionOperation(operationId, status, details, options),
    readSession: async (identity) => journal.readSession(identity),
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
  const registryPath = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
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
    registryPath,
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
    /** A wall clock that stands still at this instant and moves only when the
        test advances it, so no real delay between ticks can cross a spacing. */
    frozenAt?: number;
  } = {},
): PipelinePorts {
  let wallClockOffsetMs = 0;
  const wallClock = () => (options.frozenAt ?? Date.now()) + wallClockOffsetMs;
  const defaults = defaultPipelinePorts({ liveness: options.liveness });
  const ports: PipelinePorts = {
    ...defaults,
    engineReadiness: () => "connected",
    cpuPressureHold: () => null,
    cpuAdmissionReconcile: () => {},
    cpuAdmissionSuspend: () => {},
    now: () => new Date(wallClock()).toISOString(),
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
async function passedStageWithCapturedTree(spawns: string[], stop: (ports: PipelinePorts) => PipelinePorts["stopSettledStageWriter"],
  options: { earlierStage?: true; engineAfterPass?: import("@/lib/processIdentity").ProcessIdentity; stageIsSource?: true } = {}) {
  const stage = severedStage();
  const helper = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const helperIdentity = captureProcessIdentity(helper.pid);
  const rowKey = `claude:${stage.key.sessionId}`;
  /* With `earlierStage`, a plan stage runs first, hosted by a second agent of
     its own in the same worktree, and passes the same way. */
  const plan = options.earlierStage ? seatStructuredHost(stage.registry, stage.worktreeDir) : null;
  /* The turn ends after the report it carries. */
  const turnEnd = { text: "Done.", ts: Date.now() + 60_000 };
  const ended = new Set<string>();
  /* The lane belongs to the conversation that asked for it, never to its own
     stage agent: a source conversation is held for as long as its lane runs. */
  const source = path.join(path.dirname(stage.transcript), "lane-source.jsonl");
  fs.writeFileSync(source, "");
  const base = stagePorts(stage, spawns, { frozenAt: Date.now() }) as PipelinePorts & { advanceWallClock(ms: number): void };
  const ports = {
    ...base,
    conversationIdForPath: (pathname: string) => pathname === source ? "conversation_lane-source" : base.conversationIdForPath(pathname),
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
    durableTurnEvidence: async (engine: "claude" | "codex", transcriptPath: string, ...rest: unknown[]) => ended.has(transcriptPath)
      ? { turn: "terminal" as const, message: turnEnd, lastRecordAt: turnEnd.ts }
      : await (base.durableTurnEvidence as (...args: unknown[]) => Promise<unknown>)(engine, transcriptPath, ...rest) as never,
    lastMessage: (item: { path: string }) => ended.has(item.path) ? turnEnd : null,
    /* The plan stage's agent launches first; the fix stage's is the stage
       this suite seated; anything later is a replacement no test starts. */
    spawnAgent: plan
      ? async (input: Parameters<PipelinePorts["spawnAgent"]>[0], onReserved: Parameters<PipelinePorts["spawnAgent"]>[1]) => {
        const host = spawns.length === 0 ? plan : spawns.length === 1 ? stage : null;
        if (!host) return await base.spawnAgent(input, onReserved);
        spawns.push(input.clientAttemptId);
        await onReserved({ launchId: host.launchId, conversationId: host.conversationId });
        return { launchId: host.launchId, conversationId: host.conversationId, sessionId: host.key.sessionId,
          ["transcript"]: host.transcript, paneId: null };
      }
      : base.spawnAgent,
  } as PipelinePorts & { advanceWallClock(ms: number): void };
  ports.stopSettledStageWriter = stop(ports);
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Fix, then review", spec: "AC1", repoDir: stage.worktreeDir, src: options.stageIsSource ? stage.transcript : source, publication: "internal",
    stages: [
      ...(plan ? [{ id: "plan", kind: "run", role: { roleId: "builder" }, access: "read-write", ["prompt"]: "Plan it", next: "fix" }] : []),
      { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", ["prompt"]: "Fix it", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", ["prompt"]: "Review it", next: null },
    ],
  } as never, ports);
  if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
  /* Each stage reports and its turn ends; its host stays up, idle. */
  const pass = async (host: { conversationId: string; key: { sessionId: string }; transcript: string }) => {
    expect((await reportStageCompletion({ verdict: "pass", summary: "Done." },
      { kind: "agent", role: "builder", conversationId: host.conversationId }, ports)).error).toBeUndefined();
    const key = `claude:${host.key.sessionId}`;
    stage.registry.upsert({ ...stage.registry.readOnlySnapshot().entries[key]!, status: "idle" });
    ended.add(host.transcript);
  };
  const fixRun = plan ? 1 : 0;
  if (plan) {
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", conversationId: plan.conversationId });
    await pass(plan);
    for (let tick = 0; tick < 6 && loadPipelines()[0]!.runs[1]?.attempts[0]?.state !== "running"; tick += 1) {
      await tickPipelines([endedTurnFor(plan.transcript, turnEnd.ts)], ports);
      ports.advanceWallClock(10_000);
    }
  } else {
    await tickPipelines([], ports);
    await tickPipelines([], ports);
  }
  expect(loadPipelines()[0]!.runs[fixRun]!.attempts[0]).toMatchObject({ state: "running", conversationId: stage.conversationId });
  await pass(stage);
  if (options.engineAfterPass) {
    /* The row now names another engine process, as a host that re-execs does. */
    const entry = stage.registry.readOnlySnapshot().entries[rowKey]!;
    stage.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, process: options.engineAfterPass } });
  }

  /* The refused retirement's leftover: the whole tree, root included, captured
     on the live row and never signalled. */
  const root = stage.registry.readOnlySnapshot().entries[rowKey]!.structuredHost!.process!;
  expect(stage.registry.recordStructuredTerminationSurvivors(stage.key, root, [root, helperIdentity])).toBe(true);
  if (plan) expect(stage.registry.recordStructuredTerminationSurvivors(plan.key, plan.identity, [plan.identity, plan.helperIdentity])).toBe(true);
  /* The transcript entries a scan hands the tick once the turns have ended. */
  const endedTurn = endedTurnFor(stage.transcript, turnEnd.ts);
  return {
    stage, helper, helperIdentity, root, ports, rowKey, endedTurn, plan, source, turnEnd,
    endedTurns: plan ? [endedTurnFor(plan.transcript, turnEnd.ts), endedTurn] : [endedTurn],
    alive: () => [processIdentityStatus(root), processIdentityStatus(helperIdentity)],
    cleanup: async () => {
      stage.child.kill();
      try { helper.kill("SIGKILL"); } catch { /* gone */ }
      await Promise.all([stage.child.exited, helper.exited, plan?.stop()]);
    },
  };
}

function endedTurnFor(transcript: string, mtime: number) {
  return {
    path: transcript, root: "claude-projects", name: path.basename(transcript), project: "fixture", title: "stage",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  } as unknown as Parameters<typeof tickPipelines>[0][number];
}

/** A second structured stage host in the same registry and worktree: a live
    engine process and a helper of its own, both children of this test. */
function seatStructuredHost(registry: InstanceType<typeof AgentRegistry>, worktreeDir: string) {
  const engine = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const helper = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const identity = captureProcessIdentity(engine.pid);
  const helperIdentity = captureProcessIdentity(helper.pid);
  const sessionId = crypto.randomUUID();
  const transcript = path.join(path.dirname(worktreeDir), `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, OPEN_TURN_TRANSCRIPT);
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: worktreeDir, transport: "structured", accountId: null });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "claude", sessionId }, artifactPath: transcript, cwd: worktreeDir, accountId: null, status: "live", host: null,
    structuredHost: { kind: "claude-broker", endpoint: `stdio:${engine.pid}`, process: identity, eventCursor: 0, protocolVersion: "test",
      writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "structured-host:severed-stage-fixture", pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  return {
    launchId: begun.receipt.launchId, conversationId: settled.conversation.id, key: { engine: "claude" as const, sessionId },
    transcript, identity, helperIdentity,
    alive: () => [processIdentityStatus(identity), processIdentityStatus(helperIdentity)],
    stop: async () => {
      for (const child of [engine, helper]) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      await Promise.all([engine.exited, helper.exited]);
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
  const requests: Array<{ operationId?: string; actor?: unknown; onlyIfIdle?: unknown; status: number }> = [];
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => (target, operationId) => stopSettledPipelineStageWriter(target, {
      operationId,
      client,
      /* The production control channel, every field the engine sends: a
         conditional runtime kill operation, admitted by the journal and
         executed by the delivery controller bound below. */
      action: async ({ transcriptPath, ...request }) => {
        const answer = await dispatchStructuredControl({ path: transcriptPath, ...request },
          { registry: fixture!.stage.registry, client, enabled: () => true })
          ?? { status: 409, body: { error: "structured control was unavailable" } };
        requests.push({ operationId: request.operationId, actor: request.actor, onlyIfIdle: request.onlyIfIdle, status: answer.status });
        return answer;
      },
    }));
    const { ports, stage } = fixture;
    const spawn = ports.spawnAgent;
    ports.spawnAgent = async (input, onReserved) => {
      if (spawns.length > 0) aliveAtReplacement.push(fixture!.alive());
      return spawn(input, onReserved);
    };
    await bindStructuredDeliveryQueue([], { registry: fixture.stage.registry, client });
    /* The runtime host's own record of the idle host, as its writer publishes it. */
    journal.append({ scope: { type: "session", id: stage.conversationId }, kind: "session-status", payload: {
      conversationId: stage.conversationId, sessionKey: stage.key, hostKind: "claude-broker", host: "hosted", turn: "idle",
      activeTurnId: null, attentionIds: [], provenance: "structured", artifactPath: stage.transcript,
      writerClaim: "structured-host:severed-stage-fixture:1", capabilities: { steer: true, structuredAttention: true },
    } });

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
    /* One conditional kill, accepted under the engine's own key and settled
       by the runtime. */
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.status).toBeLessThan(300);
    expect(request!.operationId).toMatch(/^prior-writer-stop-[0-9a-f]{32}-1$/);
    expect(request!.actor).toEqual({ kind: "agent", conversationId: stage.conversationId });
    expect(request!.onlyIfIdle).toMatchObject({ writerClaim: "structured-host:severed-stage-fixture:1" });
    expect(journal.operationResult(request!.operationId!)?.receipt).toMatchObject({ kind: "kill", status: "delivered" });
  } finally {
    await fixture?.cleanup();
    await bindStructuredDeliveryQueue([], { registry: fixture?.stage.registry, client: null });
    journal.close();
  }
}, 30_000);

/* What the runtime host says of the idle host once it lost or doubts it. A
   disconnected host reads recovering, a degraded one unhosted, both with an
   unknown turn and no turn id: neither affirms work and neither runtime holds
   the host, so the stop falls to the recorded identities and the next stage
   starts. A runtime that still holds the host and reads its turn unknown can
   fence no kill: nothing is signalled, its tries are spent and the lane parks.
   A turn the runtime reads running is left to finish. */
test.each([
  ["disconnected", "stopped"],
  ["degraded", "stopped"],
  ["hosted with an unknown turn", "parked"],
  ["running a turn", "waiting"],
] as const)("a settled stage's idle host the runtime reads %s never holds the next stage forever", async (reading, expected) => {
  const spawns: string[] = [];
  const journalDir = fs.mkdtempSync(path.join(isolated, "prior-writer-unknown-"));
  const journal = new RuntimeJournal(path.join(journalDir, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  let fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>> | null = null;
  const actions: string[] = [];
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => (target, operationId) => stopSettledPipelineStageWriter(target, {
      operationId,
      client,
      action: async ({ transcriptPath, ...request }) => {
        actions.push(request.action);
        return await dispatchStructuredControl({ path: transcriptPath, ...request },
          { registry: fixture!.stage.registry, client, enabled: () => true })
          ?? { status: 409, body: { error: "structured control was unavailable" } };
      },
      /* Real signals, to this test's own recorded children only. */
      termination: { graceMs: 50, deadlineMs: 2_000 },
    }));
    const { ports, stage } = fixture;
    await bindStructuredDeliveryQueue([], { registry: stage.registry, client });
    const scope = { type: "session" as const, id: stage.conversationId };
    const published = {
      conversationId: stage.conversationId, sessionKey: stage.key, hostKind: "claude-broker", host: "hosted", turn: "idle",
      activeTurnId: null, attentionIds: [], provenance: "structured", artifactPath: stage.transcript,
      writerClaim: "structured-host:severed-stage-fixture:1", capabilities: { steer: true, structuredAttention: true },
    };
    journal.append({ scope, kind: "session-status", payload: published });
    if (reading === "disconnected") journal.append({ scope, kind: "host.disconnected", payload: { conversationId: stage.conversationId } });
    if (reading === "degraded") journal.append({ scope, kind: "host.degraded", payload: { conversationId: stage.conversationId } });
    if (reading === "hosted with an unknown turn") journal.append({ scope, kind: "session-status", payload: { ...published, turn: "unknown" } });
    if (reading === "running a turn") journal.append({ scope, kind: "session-status", payload: { ...published, turn: "running", activeTurnId: "turn-1" } });
    const session = journal.readSession({ conversationId: stage.conversationId })!;
    expect({ host: session.host as string, turn: session.turn as string, activeTurnId: session.activeTurnId }).toEqual({
      disconnected: { host: "recovering", turn: "unknown", activeTurnId: null },
      degraded: { host: "unhosted", turn: "unknown", activeTurnId: null },
      "hosted with an unknown turn": { host: "hosted", turn: "unknown", activeTurnId: null },
      "running a turn": { host: "hosted", turn: "running", activeTurnId: "turn-1" },
    }[reading]);

    for (let tick = 0; tick < 12 && spawns.length < 2 && loadPipelines()[0]!.state !== "needs_decision"; tick += 1) {
      await tickPipelines([fixture.endedTurn], ports);
      ports.advanceWallClock(10 * 60_000);
    }
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts[0]).toMatchObject({ state: "passed" });
    /* No kill was fenced on a reading that is not idle. */
    expect(actions).toEqual([]);
    if (expected === "stopped") {
      expect(fixture.alive()).toEqual(["dead", "dead"]);
      expect(spawns).toHaveLength(2);
      expect(lane.runs[1]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "replacement-1" });
      expect(lane.runs[1]!.attempts[0]!.priorWriterStop).toBeUndefined();
      expect(lane.stateDetail ?? "").not.toContain("waiting for an earlier stage agent");
      return;
    }
    expect(fixture.alive()).toEqual(["alive", "alive"]);
    expect(spawns).toHaveLength(1);
    if (expected === "parked") {
      const error = "the runtime host holds the stage host but reads its turn as unknown, so no stop could be fenced on it";
      expect(lane.state).toBe("needs_decision");
      expect(lane.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", priorWriterStop: { tries: 3, error } });
      expect(lane.stateDetail).toStartWith(`an earlier stage agent could not be stopped before a new attempt starts in its worktree: ${stage.conversationId}: `);
      expect(lane.stateDetail).toContain(`3 automatic stops left them running (last: ${error}); stop those processes, then retry the stage`);
      return;
    }
    expect(lane.state).toBe("running");
    expect(lane.runs[1]!.attempts[0]).toMatchObject({ state: "pending" });
    expect(lane.runs[1]!.attempts[0]!.priorWriterStop).toBeUndefined();
    expect(lane.stateDetail).toEndWith("; its agent is in a turn or has work queued, so it is left to finish");
  } finally {
    await fixture?.cleanup();
    await bindStructuredDeliveryQueue([], { registry: fixture?.stage.registry, client: null });
    journal.close();
  }
}, 30_000);

/* The same runtime path, refused: the lane's own source conversation is never
   the runtime's to retire while its lane runs, so every conditional kill of
   that still-idle host fails before a signal. A refusal no turn explains
   spends a try, and the lane parks instead of waiting on it. */
test("a still-idle host whose conditional kill the runtime refuses spends its tries and parks the lane", async () => {
  const spawns: string[] = [];
  const journalDir = fs.mkdtempSync(path.join(isolated, "prior-writer-refused-"));
  const journal = new RuntimeJournal(path.join(journalDir, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  let fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>> | null = null;
  const keys: string[] = [];
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => (target, operationId) => stopSettledPipelineStageWriter(target, {
      operationId,
      client,
      action: async ({ transcriptPath, ...request }) => {
        keys.push(request.operationId!);
        return await dispatchStructuredControl({ path: transcriptPath, ...request },
          { registry: fixture!.stage.registry, client, enabled: () => true })
          ?? { status: 409, body: { error: "structured control was unavailable" } };
      },
    }), { stageIsSource: true });
    const { ports, stage } = fixture;
    await bindStructuredDeliveryQueue([], { registry: stage.registry, client });
    journal.append({ scope: { type: "session", id: stage.conversationId }, kind: "session-status", payload: {
      conversationId: stage.conversationId, sessionKey: stage.key, hostKind: "claude-broker", host: "hosted", turn: "idle",
      activeTurnId: null, attentionIds: [], provenance: "structured", artifactPath: stage.transcript,
      writerClaim: "structured-host:severed-stage-fixture:1", capabilities: { steer: true, structuredAttention: true },
    } });
    for (let tick = 0; tick < 10 && loadPipelines()[0]!.state !== "needs_decision"; tick += 1) {
      await tickPipelines([fixture.endedTurn], ports);
      ports.advanceWallClock(10_000);
    }
    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(spawns).toHaveLength(1);
    expect(fixture.alive()).toEqual(["alive", "alive"]);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(journal.operationResult(key)?.receipt).toMatchObject({ kind: "kill", status: "failed", reason: "idle-retirement-deferred" });
    }
    expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", priorWriterStop: { tries: 3, error: "the runtime host did not stop the idle stage host" } });
    expect(parked.stateDetail).toContain("3 automatic stops left them running (last: the runtime host did not stop the idle stage host); stop those processes, then retry the stage");
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
    /* The stored count spaces the next stop on the lane's clock alone: real
       time between ticks moves nothing, an early tick sends nothing, and the
       tick that reaches the spacing sends exactly the next stop. */
    const afterFirst = sent.length;
    const recordedAt = ports.now();
    await Bun.sleep(25);
    expect(ports.now()).toBe(recordedAt);
    expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.priorWriterStop?.lastAt).toBe(recordedAt);
    await tickPipelines([fixture.endedTurn], ports);
    expect(sent).toHaveLength(afterFirst);
    ports.advanceWallClock(4_999);
    await tickPipelines([fixture.endedTurn], ports);
    expect(sent).toHaveLength(afterFirst);
    expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.priorWriterStop?.tries).toBe(1);
    ports.advanceWallClock(1);
    await tickPipelines([fixture.endedTurn], ports);
    expect(sent.length).toBeGreaterThan(afterFirst);
    expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.priorWriterStop?.tries).toBe(2);
    for (let tick = 0; tick < 8 && loadPipelines()[0]!.state !== "needs_decision"; tick += 1) {
      ports.advanceWallClock(10_000);
      await tickPipelines([fixture.endedTurn], ports);
    }
    const parked = loadPipelines()[0]!;
    expect(spawns).toHaveLength(1);
    expect(fixture.alive()).toEqual(["alive", "alive"]);
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", priorWriterStop: { tries: 3 } });
    expect(parked.stateDetail).toStartWith(`an earlier stage agent could not be stopped before a new attempt starts in its worktree: ${fixture.stage.conversationId}: processes ${fixture.root.pid}, ${fixture.helperIdentity.pid} captured from its stopped host may still be running; 3 automatic stops left them running`);
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
    expect(lane.stateDetail).toBe(`waiting for an earlier stage agent to stop before a new attempt starts in its worktree: ${stage.conversationId}: processes ${fixture.root.pid}, ${fixture.helperIdentity.pid} captured from its stopped host may still be running; its agent is in a turn or has work queued, so it is left to finish`);
  } finally {
    await fixture?.cleanup();
  }
}, 30_000);

/* A settled stage's host can be given a turn at any moment: by the operator,
   by a seat, by a delivery that was queued for it. The idle reading the stop
   began with stops being authority the moment that turn begins, so the turn
   evidence is read again after every await and one step before each signal,
   and a turn seen at any of those points ends the stop with nothing further
   sent and no try spent. */
test.each([
  ["after the stop observed the host idle", "observed"],
  ["after the stop captured the host's tree", "captured"],
  ["between SIGTERM and SIGKILL", "grace"],
] as const)("a turn that begins %s withdraws every further signal, and the next attempt waits", async (_moment, moment) => {
  const spawns: string[] = [];
  let fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>> | null = null;
  const sent: Array<[number, string]> = [];
  const actions: string[] = [];
  const beginTurn = () => {
    const entry = fixture!.stage.registry.readOnlySnapshot().entries[fixture!.rowKey]!;
    fixture!.stage.registry.upsert({ ...entry, status: "live", structuredHost: { ...entry.structuredHost!, activeTurnRef: "operator-turn" } });
  };
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => (target, operationId) => stopSettledPipelineStageWriter(target, {
      operationId,
      /* The runtime reads the host idle, then cannot be reached for the kill. */
      client: moment === "observed" ? {
        readSession: async () => ({
          conversationId: fixture!.stage.conversationId, sessionKey: fixture!.stage.key, host: "hosted", turn: "idle",
          activeTurnId: null, attentionIds: [], retirementBlocked: false, writerClaim: "structured-host:severed-stage-fixture:1",
          artifactPath: fixture!.stage.transcript, revision: 1,
        }),
      } as unknown as RuntimeHostClient : null,
      action: async ({ action }) => {
        actions.push(action);
        beginTurn();
        return { status: 503, body: { ok: false, code: RUNTIME_HOST_UNAVAILABLE_CODE, error: "structured runtime host is unavailable" } };
      },
      termination: {
        /* Signals are observed and never delivered. */
        signal: (pid, signal) => {
          sent.push([pid, signal]);
          if (moment === "grace" && signal === "SIGTERM") beginTurn();
        },
        ...(moment === "captured" ? { persistCapturedTree: () => { beginTurn(); return true; } } : {}),
        graceMs: 20, deadlineMs: 80,
      },
    }));
    const { ports, stage } = fixture;
    for (let tick = 0; tick < 6; tick += 1) {
      await tickPipelines([fixture.endedTurn], ports);
      ports.advanceWallClock(10 * 60_000);
    }
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts[0]).toMatchObject({ state: "passed" });
    expect(actions).toEqual(moment === "observed" ? ["kill"] : []);
    expect(sent.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
    if (moment === "grace") expect(sent.length).toBeGreaterThan(0);
    else expect(sent).toEqual([]);
    expect(fixture.alive()).toEqual(["alive", "alive"]);
    expect(spawns).toHaveLength(1);
    expect(lane.state).toBe("running");
    expect(lane.runs[1]!.attempts[0]).toMatchObject({ state: "pending" });
    expect(lane.runs[1]!.attempts[0]!.priorWriterStop).toBeUndefined();
    expect(lane.stateDetail).toStartWith(`waiting for an earlier stage agent to stop before a new attempt starts in its worktree: ${stage.conversationId}: `);
    expect(lane.stateDetail).toEndWith("; its agent is in a turn or has work queued, so it is left to finish");
  } finally {
    await fixture?.cleanup();
  }
}, 30_000);

/** What a fresh process reads back from the lane's durable record: the
    waiting attempt's stop sequence, through the store's own decoder. */
async function persistedPriorWriterStop(): Promise<unknown> {
  const child = Bun.spawn([process.execPath, "-e", `
    const { loadPipelines } = await import(${JSON.stringify(path.join(import.meta.dir, "store.ts"))});
    console.log(JSON.stringify(loadPipelines()[0]?.runs.at(-1)?.attempts.at(-1)?.priorWriterStop ?? null));
  `], { cwd: path.resolve(import.meta.dir, "../../.."), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`the store read failed (${code}): ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

type RestartedStops = {
  stopsAt: number[]; stops: string[]; keys: string[]; sent: Array<[number, string]>; sentAfterPark: number; spawned: string[];
  state: string; stateDetail: string | null; attemptState: string; priorWriterStop: unknown;
};

/** The rest of a stop sequence, ticked by a fresh process
    (fixtures/priorWriterStopRestart.ts) over the same registry and store. */
async function restartedPriorWriterStops(fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>>,
  signalsLandFor: string | null): Promise<RestartedStops> {
  const config = {
    registryPath: fixture.stage.registryPath, clockAt: fixture.ports.now(), worktreeDir: fixture.stage.worktreeDir,
    source: fixture.source, sourceConversationId: "conversation_lane-source",
    endedTranscripts: fixture.endedTurns.map(entry => entry.path), turnEndTs: fixture.turnEnd.ts, signalsLandFor, stageHead: STAGE_HEAD,
  };
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "fixtures/priorWriterStopRestart.ts"), JSON.stringify(config)], {
    cwd: path.resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, LLV_FIXTURE_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)) },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`the restarted process failed (${code}): ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!) as RestartedStops;
}

/* Two earlier stage agents still run in the worktree. Each has a stop budget
   of its own: the sequence for one runs to its end before the other is
   touched, so neither can reset the other's count, and the lane cannot go on
   stopping both forever. The first process records try 1 and goes no
   further; a fresh process, with nothing of the first in memory, takes the
   sequence on from the durable record. */
test.each([
  ["both refuse every signal", "both"],
  ["the newer one stops and the older refuses", "older"],
] as const)("two surviving earlier agents each spend a whole persisted budget across a restart, then the lane parks: %s", async (_case, refusing) => {
  const spawns: string[] = [];
  let fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>> | null = null;
  const stops: string[] = [];
  const keys: string[] = [];
  const sent: Array<[number, string]> = [];
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => (target, operationId) => {
      stops.push(target.conversationId!);
      keys.push(operationId);
      return stopSettledPipelineStageWriter(target, {
        operationId, client: null,
        termination: {
          /* The fix stage's agent ends when told to unless both refuse; the
             plan stage's never does. Nothing but these recorded children is
             ever reached. */
          signal: (pid, signal) => {
            sent.push([pid, signal]);
            if (refusing === "older" && target.conversationId === fixture!.stage.conversationId) process.kill(pid, signal);
          },
          graceMs: 20, deadlineMs: 80,
        },
      });
    }, { earlierStage: true });
    const { ports, stage, plan } = fixture;
    const blocking = refusing === "both" ? stage.conversationId : plan!.conversationId;
    /* The fix stage settles, then the first stop: try 1 of the blocking
       conversation's sequence, durable before this process goes quiet. */
    for (let round = 0; round < 4 && stops.length === 0; round += 1) await tickPipelines(fixture.endedTurns, ports);
    expect(stops).toEqual(refusing === "both" ? [stage.conversationId] : [stage.conversationId, plan!.conversationId]);
    expect(await persistedPriorWriterStop()).toMatchObject({ conversationId: blocking, tries: 1, lastAt: ports.now() });
    expect(spawns).toHaveLength(2);

    const restarted = await restartedPriorWriterStops(fixture, refusing === "older" ? stage.conversationId : null);
    /* The same conversation goes on at try 2, at the stored spacing: nothing
       on the first tick or just short of it, exactly one stop on reaching it. */
    expect(restarted.stopsAt).toEqual([0, 0, 1]);
    expect(restarted.stops).toEqual([blocking, blocking]);
    expect(restarted.keys.map(key => key.at(-1))).toEqual(["2", "3"]);
    const allKeys = [...keys, ...restarted.keys];
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(allKeys.every(key => /^prior-writer-stop-[0-9a-f]{32}-[123]$/.test(key))).toBe(true);
    const blockingKeys = allKeys.filter((_, index) => [...stops, ...restarted.stops][index] === blocking);
    expect(new Set(blockingKeys.map(key => key.slice(0, -2))).size).toBe(1);
    /* Three failed stops in all, then the park, and parked is final. */
    expect(restarted.spawned).toEqual([]);
    expect(restarted.state).toBe("needs_decision");
    expect(restarted.attemptState).toBe("needs_decision");
    expect(restarted.priorWriterStop).toMatchObject({ conversationId: blocking, tries: 3 });
    expect(restarted.stateDetail).toStartWith(`an earlier stage agent could not be stopped before a new attempt starts in its worktree: ${blocking}: `);
    expect(restarted.stateDetail).toContain("3 automatic stops left them running");
    expect(restarted.sentAfterPark).toBe(0);
    expect(await persistedPriorWriterStop()).toMatchObject({ conversationId: blocking, tries: 3 });
    expect(spawns).toHaveLength(2);
    expect(fixture.alive()).toEqual(refusing === "both" ? ["alive", "alive"] : ["dead", "dead"]);
    expect(plan!.alive()).toEqual(["alive", "alive"]);
    /* Each restarted stop escalated, and only recorded identities were reached. */
    expect(new Set(restarted.sent.map(([, signal]) => signal))).toEqual(new Set(["SIGTERM", "SIGKILL"]));
    const recorded = new Set([fixture.root.pid, fixture.helperIdentity.pid, plan!.identity.pid, plan!.helperIdentity.pid]);
    expect([...sent, ...restarted.sent].every(([pid]) => recorded.has(Math.abs(pid)))).toBe(true);
  } finally {
    await fixture?.cleanup();
  }
}, 30_000);

/* #2967 meets the settled-writer stop: the engine has exited and sits unreaped
   as a zombie, while its row still carries the turn words it last wrote. A
   zombie runs no turn, so those words authorize nothing; the live helper the
   stop captured is ended by its recorded identity and the next stage starts. */
test.skipIf(process.platform !== "linux")("a zombie engine with stale turn words never holds the next stage: its live survivor is stopped", async () => {
  const spawns: string[] = [];
  let fixture: Awaited<ReturnType<typeof passedStageWithCapturedTree>> | null = null;
  const unreaped = await startUnreapedChild();
  const outcomes: string[] = [];
  try {
    fixture = await passedStageWithCapturedTree(spawns, () => async (target, operationId) => {
      const stopped = await stopSettledPipelineStageWriter(target, { operationId, client: null, termination: { graceMs: 50, deadlineMs: 500 } });
      outcomes.push(stopped.outcome);
      return stopped;
    }, { engineAfterPass: unreaped.zombie });
    const { ports, stage, rowKey } = fixture;
    const entry = stage.registry.readOnlySnapshot().entries[rowKey]!;
    stage.registry.upsert({ ...entry, status: "live", structuredHost: { ...entry.structuredHost!, activeTurnRef: "stale-turn" } });
    expect(stage.registry.readOnlySnapshot().entries[rowKey]).toMatchObject({ status: "live",
      structuredHost: { process: { pid: unreaped.zombie.pid }, activeTurnRef: "stale-turn" },
      structuredTerminationSurvivors: [{ pid: unreaped.zombie.pid }, { pid: fixture.helperIdentity.pid }] });
    expect(procBackend.processExited(unreaped.zombie.pid)).toBeTrue();
    for (let tick = 0; tick < 6 && spawns.length < 2; tick += 1) {
      await tickPipelines([fixture.endedTurn], ports);
      ports.advanceWallClock(10_000);
    }
    expect(outcomes).not.toContain("deferred");
    expect(outcomes.length).toBeGreaterThan(0);
    expect(await Promise.race([fixture.helper.exited.then(() => "exited"), Bun.sleep(2_000).then(() => "running")])).toBe("exited");
    expect(spawns).toHaveLength(2);
    const lane = loadPipelines()[0]!;
    expect(lane.runs[1]!.attempts[0]).toMatchObject({ state: "running", launchId: "replacement-1" });
    expect(lane.stateDetail ?? "").not.toContain("waiting for an earlier stage agent");
    /* Only the recorded helper was ended: the zombie's parent still runs. */
    expect(processIdentityStatus(unreaped.parentIdentity)).toBe("alive");
  } finally {
    await fixture?.cleanup();
    await unreaped.stop();
  }
}, 30_000);

/* #2967: a host stop captures its whole tree, and a member that has already
   exited stays in the process table as a zombie until its parent reaps it,
   with its pid and start token intact. It cannot write to the worktree, so it
   no longer holds the next attempt; a live member captured beside it still
   does, and the launch waits for that one alone. */
test.skipIf(process.platform !== "linux")("a zombie captured from the earlier attempt's host does not hold the next attempt, while a live sibling does (#2967)", async () => {
  const stage = severedStage();
  const unreaped = await startUnreapedChild();
  const sibling = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const siblingIdentity = captureProcessIdentity(sibling.pid);
  try {
    const spawns: string[] = [];
    let interrupted: "dead" | null = null;
    const base = stagePorts(stage, spawns) as PipelinePorts & { advanceWallClock(ms: number): void };
    const ports: PipelinePorts = {
      ...base,
      conversationTurnInterrupted: async () => interrupted,
      restartRecoveryBootStartedAt: () => Date.now() - 60 * 60_000,
      stopInterruptedStageAgent: undefined,
      /* Without the settled-writer stop, the live sibling holds the launch for
         as long as it runs; the stop itself is covered by the passed-stage
         cases above. */
      stopSettledStageWriter: undefined,
      stageHostTreeStillRunning: defaultPipelinePorts().stageHostTreeStillRunning,
      cpuPressureHold: () => null,
      conversationOperatorStopped: async () => false,
    };
    savePipelines([]);
    const created = await createPipelineFromRequest({
      task: "Build after a zombie writer", spec: "AC1", repoDir: stage.worktreeDir, src: stage.transcript,
      stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", ["prompt"]: "Build it", next: null }],
    } as never, ports);
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", conversationId: stage.conversationId });

    const rowKey = `claude:${stage.key.sessionId}`;
    const root = stage.registry.readOnlySnapshot().entries[rowKey]!.structuredHost!.process!;
    expect(stage.registry.captureStructuredTerminationSurvivors(stage.key, root, [unreaped.zombie, siblingIdentity])).not.toBeNull();
    stage.child.kill();
    await settles(() => processIdentityStatus(root) === "dead", "the engine's exit");
    stage.registry.upsert({ ...stage.registry.readOnlySnapshot().entries[rowKey]!, status: "dead" });
    interrupted = "dead";
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    const held = loadPipelines()[0]!;
    expect(spawns).toHaveLength(1);
    expect(held.runs[0]!.attempts.at(-1)).toMatchObject({ n: 2, state: "pending" });
    expect(held.stateDetail).toBe(`waiting for an earlier stage agent to stop before a new attempt starts in its worktree: ${stage.conversationId}: process ${sibling.pid} captured from its stopped host may still be running`);

    sibling.kill("SIGKILL");
    await sibling.exited;
    /* The zombie is still in the process table, unreaped, when the launch goes. */
    expect(procBackend.processExited(unreaped.zombie.pid)).toBeTrue();
    expect(processIdentityStatus(unreaped.zombie)).toBe("alive");
    await tickPipelines([], ports);
    expect(spawns).toHaveLength(2);
    expect(loadPipelines()[0]!.stateDetail ?? "").not.toContain("waiting for an earlier stage agent");
  } finally {
    stage.child.kill();
    try { sibling.kill("SIGKILL"); } catch { /* gone */ }
    await Promise.all([stage.child.exited, sibling.exited, unreaped.stop()]);
  }
}, 30_000);
