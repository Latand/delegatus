import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* This suite exercises the terminal-settlement host reap (#574), which
   terminates agent processes. Every pipeline is constructed directly inside
   this sandboxed state directory. The integration cases use a private runtime
   socket and processes started here; no case reads or signals operator state. */
const suiteState = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminal-reap-"));
const ambientState = process.env.LLV_STATE_DIR;
const ambientStructured = process.env.LLV_STRUCTURED_HOSTS;
process.env.LLV_STATE_DIR = suiteState;
process.env.LLV_STRUCTURED_HOSTS = "0";

const { tickPipelines } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, pipelineIdentity, savePipelines } = await import("./store");
type Pipeline = import("./types").Pipeline;
type PipelineStageAttempt = import("./types").PipelineStageAttempt;
type PipelinePorts = import("./engine").PipelinePorts;
type PipelineStageStopResult = import("./engine").PipelineStageStopResult;

/* tickPipelines self-schedules a follow-up tick when a pass leaves a pending
   cursor; keep that wake-up away from the real default ports in this suite. */
registerPipelineTick(async () => {});

afterAll(() => {
  if (ambientState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ambientState;
  if (ambientStructured === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
  else process.env.LLV_STRUCTURED_HOSTS = ambientStructured;
  fs.rmSync(suiteState, { recursive: true, force: true });
});

const ROLE = { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: null, access: "read-write", promptScaffold: null } as const;

function attempt(n: number, conversation: string, settled: boolean): PipelineStageAttempt {
  return {
    n,
    state: settled ? "passed" : "running",
    effectiveRole: { ...ROLE },
    launchId: `launch-${conversation}`,
    conversationId: conversation,
    sessionId: null,
    agentPath: `/codex/${conversation}.jsonl`,
    paneId: null,
    flowId: null,
    startedAt: "2026-07-31T00:00:00.000Z",
    completedAt: settled ? "2026-07-31T00:10:00.000Z" : null,
    input: null,
    activatedBy: null,
    output: settled ? "done" : null,
    verdict: settled ? { status: "pass" } : null,
    error: null,
  };
}

function pipelineRecord(input: {
  id: string;
  state: Pipeline["state"];
  attempts: PipelineStageAttempt[];
}): Pipeline {
  const task = "Terminal reap";
  const repoDir = "/repo";
  return {
    id: input.id,
    task,
    taskIds: [],
    project: "viewer",
    repoDir,
    ...pipelineIdentity(input.id, task, repoDir),
    baseBranch: "main",
    baseRef: "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f",
    lastPassedCommit: "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f",
    publishedCommit: null,
    stages: [{ id: "implement", kind: "run", prompt: "{{task}}", next: null, onFail: null, effectiveRole: { ...ROLE } }],
    runs: [{ stageId: "implement", attempts: input.attempts }],
    cursor: null,
    state: input.state,
    pausedState: null,
    stateDetail: null,
    srcPath: "/codex/creator.jsonl",
    srcConversationId: "conversation_creator",
    createdAt: "2026-07-31T00:00:00.000Z",
    closedAt: input.state === "completed" || input.state === "closed" ? "2026-07-31T00:20:00.000Z" : null,
    hiddenAt: null,
  };
}

function harness() {
  const stops: string[] = [];
  const resident = new Map<string, boolean>();
  const stopResults = new Map<string, PipelineStageStopResult>();
  const active = new Map<string, boolean | null>();
  let clock = 1_000_000;
  let monotonic = 0;
  let stopCostMs = 0;
  const ports: PipelinePorts = {
    exec: () => ({ code: 0, stdout: "", stderr: "" }),
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: () => null,
    spawnAgent: async () => { throw new Error("the terminal reap must never spawn an agent"); },
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    paneAgentAlive: async () => false,
    stopStageAgent: async (target, options) => {
      if (options?.onlyIfIdle && active.has(target.conversationId ?? "")
        && active.get(target.conversationId ?? "") !== false) return { outcome: "deferred" };
      stops.push(`${target.stageId}:${target.attempt}:${target.conversationId ?? "none"}`);
      monotonic += stopCostMs;
      const result = stopResults.get(target.conversationId ?? "") ?? { outcome: "stopped" as const };
      if (result.outcome === "stopped") resident.set(target.conversationId ?? "", false);
      return result;
    },
    stopStagePane: async () => ({ outcome: "not-running" as const }),
    stageHostResident: async (target) => resident.get(target.conversationId ?? "") ?? false,
    monotonicNow: () => monotonic,
    worktreePresent: () => false,
    conversationAgentActive: async (conversationId) => active.get(conversationId) ?? null,
    durableTurnEvidence: async () => null,
    headCwd: () => null,
    lastMessage: () => null,
    pathForConversation: () => null,
    sourcePathAllowed: () => true,
    conversationIdForPath: () => null,
    pipelineAdoptionCandidates: () => [],
    createFlow: async () => ({ error: "no flows in this suite" }),
    patchFlow: () => ({}),
    closeFlow: async () => {},
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  return {
    ports,
    stops,
    resident,
    stopResults,
    active,
    setStopCost: (ms: number) => { stopCostMs = ms; },
  };
}

test("completion reaps its finished resident builder hosts exactly once", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-clean",
    state: "completed",
    attempts: [attempt(1, "conversation_builder_1", true), attempt(2, "conversation_builder_2", true)],
  })]);
  h.resident.set("conversation_builder_1", true);
  h.resident.set("conversation_builder_2", true);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_builder_1", "implement:2:conversation_builder_2"]);
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 1, stopped: 2 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
  expect(settled.unconfirmedHosts).toBeUndefined();

  /* A settled reap is durable: the next tick re-reads it from the store and
     sends nothing, resident or not. */
  h.resident.set("conversation_builder_1", true);
  await tickPipelines([], h.ports);
  expect(h.stops).toHaveLength(2);
});

test("a completed pipeline with no launched host settles its empty reap", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-empty",
    state: "completed",
    attempts: [],
  })]);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual([]);
  expect(loadPipelines()[0]!.terminalReap).toMatchObject({
    rounds: 0,
    stopped: 0,
    settledAttempts: [],
    settledAt: expect.any(String),
  });
});

test("the creator, a mid-turn attempt, and a runtime-active session are preserved", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-preserve",
    state: "completed",
    attempts: [
      attempt(1, "conversation_creator", true),
      attempt(2, "conversation_midturn", false),
      attempt(3, "conversation_helper", true),
    ],
  })]);
  h.resident.set("conversation_creator", true);
  h.resident.set("conversation_midturn", true);
  h.resident.set("conversation_helper", true);
  h.active.set("conversation_helper", true);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual([]);
  expect(h.resident.get("conversation_creator")).toBe(true);
  expect(h.resident.get("conversation_midturn")).toBe(true);
  expect(h.resident.get("conversation_helper")).toBe(true);
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 0, stopped: 0 });
  expect(settled.terminalReap!.settledAt).toBeNull();
});

test("a finished attempt that is still active is rechecked and reaped after its live work settles", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-active-then-idle",
    state: "completed",
    attempts: [attempt(1, "conversation_finishing", true)],
  })]);
  h.resident.set("conversation_finishing", true);
  h.active.set("conversation_finishing", true);
  // A live turn can span many sweeps without exhausting the teardown budget.
  for (let tick = 0; tick < 7; tick++) await tickPipelines([], h.ports);
  expect(h.stops).toEqual([]);
  h.active.set("conversation_finishing", false);
  await tickPipelines([], h.ports);
  expect(h.stops).toEqual(["implement:1:conversation_finishing"]);
  expect(loadPipelines()[0]!.terminalReap!.settledAt).not.toBeNull();
  expect(loadPipelines()[0]!.unconfirmedHosts).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(h.stops).toHaveLength(1);
});

test("an unconfirmed sibling cannot settle the reap while another attempt still owns live work", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-active-and-unconfirmed",
    state: "completed",
    attempts: [attempt(1, "conversation_busy", true), attempt(2, "conversation_stubborn", true)],
  })]);
  h.resident.set("conversation_busy", true);
  h.resident.set("conversation_stubborn", true);
  h.active.set("conversation_busy", true);
  h.stopResults.set("conversation_stubborn", { outcome: "unconfirmed", operationId: "stop-stubborn", detail: "still resident" });
  for (let tick = 0; tick < 7; tick++) await tickPipelines([], h.ports);
  expect(h.stops.every((stop) => stop.includes("conversation_stubborn"))).toBe(true);
  expect(loadPipelines()[0]!.terminalReap!.settledAt).toBeNull();
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);
  h.active.set("conversation_busy", false);
  await tickPipelines([], h.ports);
  expect(h.stops).toContain("implement:1:conversation_busy");
});

test("a parked terminal attempt is swept while closed teardown stays the close action's job", async () => {
  const h = harness();
  savePipelines([
    pipelineRecord({ id: "reap-closed", state: "closed", attempts: [attempt(1, "conversation_closed", true)] }),
    pipelineRecord({ id: "reap-parked", state: "needs_decision", attempts: [attempt(1, "conversation_parked", true)] }),
  ]);
  h.resident.set("conversation_closed", true);
  h.resident.set("conversation_parked", true);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_parked"]);
  expect(h.resident.get("conversation_closed")).toBe(true);
  expect(loadPipelines().find((pipeline) => pipeline.id === "reap-closed")?.terminalReap).toBeUndefined();
  expect(loadPipelines().find((pipeline) => pipeline.id === "reap-parked")?.terminalReap)
    .toMatchObject({ rounds: 1, stopped: 1, settledAttempts: ["implement:1"] });
});

test("finished attempts are swept as the pipeline advances and later rounds reopen the reap", async () => {
  const h = harness();
  const record = pipelineRecord({
    id: "reap-progressive",
    state: "running",
    attempts: [attempt(1, "conversation_finished", true), attempt(2, "conversation_running", false)],
  });
  record.cursor = { stageId: "implement", state: "running", input: null, activatedBy: null };
  savePipelines([record]);
  h.resident.set("conversation_finished", true);
  h.resident.set("conversation_running", true);
  h.active.set("conversation_running", true);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_finished"]);
  expect(loadPipelines()[0]!.terminalReap).toMatchObject({
    rounds: 1,
    stopped: 1,
    settledAttempts: ["implement:1"],
  });

  const parked = loadPipelines()[0]!;
  const second = parked.runs[0]!.attempts[1]!;
  second.state = "needs_decision";
  second.completedAt = "2026-07-31T00:30:00.000Z";
  second.verdict = { status: "needs_decision" };
  parked.state = "needs_decision";
  h.active.set("conversation_running", false);
  savePipelines([parked]);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual([
    "implement:1:conversation_finished",
    "implement:2:conversation_running",
  ]);
  expect(loadPipelines()[0]!.terminalReap).toMatchObject({
    rounds: 1,
    stopped: 2,
    settledAttempts: ["implement:1", "implement:2"],
  });
});

test("a host that will not die is bounded and surfaces as an unconfirmed host", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-stuck",
    state: "completed",
    attempts: [attempt(1, "conversation_stuck", true)],
  })]);
  h.resident.set("conversation_stuck", true);
  h.stopResults.set("conversation_stuck", {
    outcome: "unconfirmed",
    operationId: "op_stuck",
    detail: "kill accepted as queued but termination was not confirmed",
  });

  for (let round = 0; round < 5; round += 1) await tickPipelines([], h.ports);

  expect(h.stops).toHaveLength(5);
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 5, stopped: 0 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
  expect(settled.unconfirmedHosts).toMatchObject([{ stageId: "implement", attempt: 1, operationId: "op_stuck" }]);

  /* Settled: no further kills are dispatched, ever. */
  await tickPipelines([], h.ports);
  expect(h.stops).toHaveLength(5);

  /* Once the survivor is demonstrably gone, the existing unconfirmed-host
     reconcile retires it without sending another kill. */
  h.resident.set("conversation_stuck", false);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.unconfirmedHosts).toBeUndefined();
  expect(h.stops).toHaveLength(5);
});

test("a reap whose every round expires still surfaces the hosts it never probed", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-exhaust",
    state: "completed",
    attempts: [attempt(1, "conversation_refusing", true), attempt(2, "conversation_unprobed", true)],
  })]);
  h.resident.set("conversation_refusing", true);
  h.resident.set("conversation_unprobed", true);
  h.stopResults.set("conversation_refusing", { outcome: "failed", error: "kill was refused" });
  h.setStopCost(6_000);

  for (let round = 0; round < 5; round += 1) await tickPipelines([], h.ports);

  /* Every round burned its budget on the refusing host, so the second host was
     never reached — settlement names both instead of dropping the unprobed one. */
  expect(h.stops).toEqual(Array.from({ length: 5 }, () => "implement:1:conversation_refusing"));
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 5, stopped: 0 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
  expect(settled.unconfirmedHosts).toMatchObject([
    { stageId: "implement", attempt: 1, detail: "kill was refused" },
    { stageId: "implement", attempt: 2, detail: "terminal reap budget expired before this host was probed" },
  ]);
});

test("the sweep budget defers remaining hosts to the next tick instead of stalling it", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-budget",
    state: "completed",
    attempts: [attempt(1, "conversation_slow", true), attempt(2, "conversation_next", true)],
  })]);
  h.resident.set("conversation_slow", true);
  h.resident.set("conversation_next", true);
  h.setStopCost(6_000);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_slow"]);
  const partial = loadPipelines()[0]!;
  expect(partial.terminalReap).toMatchObject({ rounds: 1, stopped: 1, settledAt: null });

  h.setStopCost(0);
  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_slow", "implement:2:conversation_next"]);
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 2, stopped: 2 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
});


const socketScenarios = ["unavailable", "resumed-after-snapshot", "resumed-before-actuation", "registry-busy-before-signal", "generation-before-actuation", "queued-before-actuation", "queued-after-actuation-read", "retry-after-actuation-read", "root-exits-before-helper", "legacy-session-read", "idle", "live-seat", "legacy-seat", "store-only-seat", "pending-seat", "rotated-seat", "rotated-seat-open-turn", "redesignated-seat", "seat-before-signal", "unreadable-seat-store", "running-stage", "seat-in-another-project", "malformed-active-seat", "malformed-pending-seat", "malformed-seat-collection", "malformed-revocation"];
const socketChild = process.env.LLV_TERMINAL_REAP_SOCKET_CHILD === "1";

// Task admission caches its store on module load. A fresh process gives each
// socket case a store whose sandbox outlives the case, even when another suite
// has already deleted the sandbox in which the parent loaded that module.
async function isolatedSocketCase(name: string): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reap-worker-"));
  let worker: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const environment = { ...process.env, LLV_TERMINAL_REAP_SOCKET_CHILD: "1",
      HOME: path.join(directory, "home"), XDG_CONFIG_HOME: path.join(directory, "config"),
      LLV_STATE_DIR: path.join(directory, "state"), TMPDIR: path.join(directory, "tmp") };
    for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR"] as const) {
      fs.mkdirSync(environment[key], { recursive: true });
    }
    const spawned = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", `^${name}$`], {
      env: environment, stdout: "pipe", stderr: "pipe",
    });
    worker = spawned;
    const [stdout, stderr, code] = await Promise.all([
      new Response(spawned.stdout).text(), new Response(spawned.stderr).text(), spawned.exited,
    ]);
    if (code !== 0 || !stdout.includes(`socket case completed: ${name}\n`)) {
      throw new Error(`isolated socket case failed (${code}):\n${stdout}\n${stderr}`);
    }
  } finally {
    if (worker && worker.exitCode === null) worker.kill();
    if (worker) await worker.exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

type SetupFailure = "readiness" | "admission" | "socket";
type FixtureOwnership = { pids: number[]; signals: number[] };

async function socketScenario(scenario: string, failure?: SetupFailure, ownership: FixtureOwnership = { pids: [], signals: [] }): Promise<void> {
  const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { procBackend } = await import("@/lib/proc");
  const { systemBootEpoch } = await import("@/lib/processIdentity");
  const { defaultPipelinePorts } = await import("./engine");
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const { runtimeHostClient } = await import("@/lib/runtime/client");
  const { RuntimeJournal } = await import("../../runtime-host/journal");
  const { RuntimeHost } = await import("../../runtime-host/host");
  const { serveRuntimeHost } = await import("../../runtime-host/socket");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-live-host-"));
  const helperFile = path.join(root, "helper.pid");
  const helperReady = path.join(root, "helper.ready");
  const helperCode = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(helperReady)}, "ready"); setInterval(() => {}, 1000);`;
  // Record the helper in the root immediately after spawn. A TERM handler runs
  // only after this synchronous acquisition block, so cleanup can recover its
  // PID even when readiness fails before the parent has read it.
  const rootCode = scenario === "root-exits-before-helper"
    ? `process.on("SIGTERM", () => process.exit(0)); const helper = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(helperCode)}], { detached: true, stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(helperFile)}, String(helper.pid)); helper.unref(); setInterval(() => {}, 1000);`
    : "setInterval(() => {}, 1000)";
  const originalKill = process.kill;
  const oldSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const oldStructured = process.env.LLV_STRUCTURED_HOSTS;
  const registryState = process as typeof process & { __llvAgentRegistry?: InstanceType<typeof AgentRegistry> | null };
  const oldRegistry = registryState.__llvAgentRegistry ?? null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let helperPid: number | null = null;
  let helperIdentity: string | null = null;
  let journalResource: InstanceType<typeof RuntimeJournal> | null = null;
  let server: ReturnType<typeof serveRuntimeHost> | null = null;
  let registryResource: InstanceType<typeof AgentRegistry> | null = null;
  let unbindPersistence: (() => void) | null = null;
  const signals = ownership.signals;
  const recordHelper = () => {
    if (helperPid === null && fs.existsSync(helperFile)) {
      const pid = Number(fs.readFileSync(helperFile, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("fixture helper PID is invalid");
      helperPid = pid;
      helperIdentity = procBackend.processIdentity(pid);
      ownership.pids.push(pid);
    }
  };
  try {
    child = Bun.spawn([process.execPath, "-e", rootCode], {
      env: { NODE_ENV: "test", LLV_STATE_DIR: root }, stdout: "ignore", stderr: "ignore",
    });
    const recordedPid = child.pid;
    ownership.pids.push(recordedPid);
    if (scenario === "root-exits-before-helper") {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(helperReady) && Date.now() < deadline) {
        recordHelper();
        await Bun.sleep(10);
      }
      recordHelper();
      if (!fs.existsSync(helperReady)) throw new Error("fixture helper readiness timed out");
    }
    if (failure === "readiness") throw new Error("injected readiness failure");
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      signals.push(pid);
      if (pid !== recordedPid && pid !== helperPid) throw new Error("fixture refused a signal to an unrecorded process");
      return originalKill.call(process, pid, signal);
    }) as typeof process.kill;
    const key = { engine: "codex" as const, sessionId: (await import("node:crypto")).randomUUID() };
    const transcript = path.join(root, `${key.sessionId}.jsonl`);
    fs.writeFileSync(transcript, "");
    const registry = registryResource = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    setAgentRegistryForTests(registry);
    if (failure === "admission") registry.beginSpawnRequest = () => { throw new Error("injected admission failure"); };
    const begun = beginLegacySpawnFixture(registry, {
      engine: "codex", cwd: root, transport: "structured", accountId: "account-a",
    });
    if (begun.kind !== "created") throw new Error("fixture launch refused");
    const settled = registry.settleSpawn(begun.receipt.launchId, {
      key, artifactPath: transcript, cwd: root, accountId: "account-a", status: "live", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "stdio", process: {
        pid: recordedPid, startIdentity: procBackend.processIdentity(recordedPid), bootEpoch: systemBootEpoch(),
      }, eventCursor: 1, protocolVersion: "v2", writerClaimEpoch: 1,
        activeTurnRef: "new-live-turn", pendingAttention: [], activeFlags: ["native-inject", "native-queue", "structured-image-v1"] },
      claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("fixture settlement refused");
    setAgentRegistryForTests(registry);
    const conversationId = begun.receipt.conversationId;
    const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, readOrchestratorSeatFile } = await import("@/lib/orchestrator/seats");
    const { statePath } = await import("@/lib/configDir");
    const seatProject = "fixture-seat-project";
    let designation = 0;
    const designate = (id: string, pending = false, project = seatProject) => {
      const clientRequestId = `fixture-seat-${++designation}`;
      expect(beginOrchestratorSeatIntent({ project, mandate: "run the board",
        clientRequestId, mode: "existing", conversationId: id }).kind).toBe("begun");
      if (!pending) expect(completeOrchestratorSeatIntent({ project, clientRequestId,
        conversationId: id, path: transcript }).kind).toBe("activated");
    };
    const rememberSeat = (project = seatProject) => registry.rememberMembership(conversationId, {
      kind: "orchestrator", containerId: project, role: "seat", slot: "orchestrator",
      parentConversationId: null, stageId: null, stageOrder: null, round: null,
    });
    if (["live-seat", "store-only-seat", "pending-seat", "rotated-seat", "rotated-seat-open-turn", "redesignated-seat", "malformed-active-seat", "malformed-pending-seat", "malformed-seat-collection", "malformed-revocation"].includes(scenario)) {
      designate(conversationId, scenario === "pending-seat" || scenario === "malformed-pending-seat");
      if (scenario !== "store-only-seat" && scenario !== "pending-seat" && !scenario.startsWith("malformed-")) rememberSeat();
    }
    if (["rotated-seat", "rotated-seat-open-turn", "redesignated-seat"].includes(scenario)) {
      designate("conversation_seat_successor");
      expect(readOrchestratorSeatFile().revocations.some(row => row.conversationId === conversationId)).toBe(true);
    }
    if (scenario === "redesignated-seat") {
      designate(conversationId);
      const file = readOrchestratorSeatFile();
      expect(file.seats[seatProject]!.seatEpoch).toBeGreaterThan(file.revocations.find(row => row.conversationId === conversationId)!.seatEpoch);
    }
    if (scenario === "seat-in-another-project") {
      designate(conversationId);
      rememberSeat();
      designate(conversationId, false, "fixture-other-project");
      rememberSeat("fixture-other-project");
      designate("conversation_other_successor", false, "fixture-other-project");
      expect(readOrchestratorSeatFile().seats[seatProject]!.conversationId).toBe(conversationId);
    }
    if (scenario === "legacy-seat") rememberSeat();
    const seatFile = statePath("orchestrator-seats.json");
    if (scenario === "unreadable-seat-store") fs.writeFileSync(seatFile, "{");
    let readableSeatFile: string | null = null;
    if (scenario.startsWith("malformed-")) {
      readableSeatFile = fs.readFileSync(seatFile, "utf8");
      const damaged = JSON.parse(readableSeatFile);
      if (scenario === "malformed-seat-collection") damaged.seats = null;
      else if (scenario === "malformed-revocation") damaged.revocations.push({ project: seatProject, conversationId,
        seatEpoch: damaged.seats[seatProject].seatEpoch, revokedAt: "2026-07-31T00:15:00.000Z",
        successorConversationId: { invalid: true } });
      else (scenario === "malformed-pending-seat" ? damaged.pending : damaged.seats)[seatProject].mandate = null;
      fs.writeFileSync(seatFile, JSON.stringify(damaged));
    }
    const journal = journalResource = new RuntimeJournal(path.join(root, "journal.sqlite"), { structuredHosts: true });
    journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
      conversationId, sessionKey: key, hostKind: "codex-app-server", host: "hosted", turn: "running",
      activeTurnId: "new-live-turn", attentionIds: [], provenance: "structured", artifactPath: transcript,
      writerClaim: "structured-host:fixture:1", capabilities: { steer: true, structuredAttention: true },
    } });
    if (scenario === "retry-after-actuation-read") {
      journal.executeOperation({ kind: "send", operationId: "failed-racing-turn", idempotencyKey: "failed-racing-turn",
        conversationId, policy: "queue", text: "work awaiting retry" });
      journal.transitionOperation("failed-racing-turn", "failed", { reason: "fixture-failure" });
    }
    const host = new RuntimeHost(journal, undefined, undefined, true);
    let unavailable = false;
    const commands: unknown[] = [];
    const payload = { conversationId, sessionKey: key, hostKind: "codex-app-server", host: "hosted",
      attentionIds: [], provenance: "structured", artifactPath: transcript,
      writerClaim: "structured-host:fixture:1", capabilities: { steer: true, structuredAttention: true } };
    const publish = (running: boolean) => journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status",
      payload: { ...payload, turn: running ? "running" : "idle", activeTurnId: running ? "resumed-live-turn" : null } });
    const setRegistryBusy = (busy: boolean) => {
      const entry = registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
      registry.upsert({ ...entry, status: busy ? "live" : "idle",
        structuredHost: { ...entry.structuredHost!, activeTurnRef: busy ? "resumed-live-turn" : null } });
    };
    let observedIdle = false;
    let actuationChecked = false;
    let recovered = false;
    let seatAcquired = false;
    const socket = path.join(root, "runtime.sock");
    process.env.LLV_RUNTIME_HOST_SOCKET = socket;
    process.env.LLV_STRUCTURED_HOSTS = "1";
    server = serveRuntimeHost(socket, { handle: async (request, options) => {
      if (unavailable && !recovered && request.method === "snapshot") {
        if (scenario === "unavailable") return { id: request.id, ok: false, error: "snapshot temporarily unavailable" };
        if (!observedIdle) {
          observedIdle = true;
          publish(false);
          setRegistryBusy(false);
        }
        const response = await host.handle(request, options);
        if (scenario === "resumed-after-snapshot") publish(true);
        return response;
      }
      if (request.method === "session-read" && unavailable && !recovered) {
        actuationChecked = true;
        if (scenario === "resumed-before-actuation" || scenario === "rotated-seat-open-turn") publish(true);
        const retirementClaimed = journal.effectBatch(100, ["runtime.kill"]).some(effect =>
          journal.operationResult(effect.payload.operationId as string)?.receipt.status === "delivering");
        if (scenario === "queued-before-actuation") journal.executeOperation({ kind: "send", operationId: "new-queued-turn",
          idempotencyKey: "new-queued-turn", conversationId, policy: "queue", text: "new live work" });
        if (scenario === "generation-before-actuation") journal.append({ scope: { type: "session", id: conversationId },
          kind: "session-status", payload: { ...payload, sessionKey: { ...key, sessionId: "replacement-generation" }, turn: "idle", activeTurnId: null } });
        const response = await host.handle(request, options);
        if (scenario === "queued-after-actuation-read" && retirementClaimed) {
          const newWork = journal.executeOperation({ kind: "send", operationId: "new-racing-turn", idempotencyKey: "new-racing-turn",
            conversationId, policy: "queue", text: "work after the idle response" });
          expect(newWork.receipt).toMatchObject({ status: "rejected", reason: "idle-retirement-in-progress" });
        }
        if (scenario === "retry-after-actuation-read" && retirementClaimed) {
          const retry = await host.handle({ id: "racing-retry", method: "operation-retry", params: { operationId: "failed-racing-turn" } });
          expect(retry).toMatchObject({ ok: false, error: "idle-retirement-in-progress" });
          expect(journal.operationResult("failed-racing-turn")?.receipt.status).toBe("failed");
        }
        if (scenario === "registry-busy-before-signal") setRegistryBusy(true);
        if (scenario === "legacy-session-read" && response.ok && response.result && typeof response.result === "object") {
          delete (response.result as { retirementBlocked?: boolean }).retirementBlocked;
        }
        return response;
      }
      if (request.method === "operation-status" && scenario === "seat-before-signal" && !recovered && !seatAcquired) {
        // First authority read admits the idle host. Acquire a seat at the
        // ladder's next async boundary, after its process tree was captured.
        const entry = registry.readOnlySnapshot().entries[`codex:${key.sessionId}`];
        if ((entry?.structuredTerminationSurvivors?.length ?? 0) > 0) {
          seatAcquired = true;
          designate(conversationId);
          rememberSeat();
        }
      }
      if (request.method === "command") commands.push(request.params?.command);
      return host.handle(request, options);
    } }, failure === "socket" ? { maxConnections: 1 } : {});
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const finished = attempt(1, conversationId, scenario !== "running-stage");
    finished.agentPath = transcript;
    finished.launchId = begun.receipt.launchId;
    savePipelines([pipelineRecord({ id: "review-live-busy", state: scenario === "running-stage" ? "needs_decision" : "completed", attempts: [finished] })]);
    const tick = async () => {
      const h = harness();
      const production = defaultPipelinePorts();
      h.ports.stageHostResident = production.stageHostResident;
      h.ports.conversationAgentActive = production.conversationAgentActive;
      h.ports.stopStageAgent = production.stopStageAgent;
      await tickPipelines([], h.ports);
    };
    await tick();
    expect(commands).toEqual([]);
    await bindStructuredDeliveryQueue([], { registry, client: runtimeHostClient(), recover: async () => null });
    if (helperPid !== null) {
      const { bindCodexHostPersistence } = await import("@/lib/runtime/registry");
      type HostState = import("@/lib/runtime/engineHost").HostState;
      const state: HostState = { sessionKey: key.sessionId, status: "idle", endpoint: "stdio", pid: recordedPid,
        processStartIdentity: procBackend.processIdentity(recordedPid), protocolVersion: "v2", eventCursor: 1,
        activeTurnRef: null, pendingAttention: [], activeFlags: ["native-inject", "native-queue", "structured-image-v1"], account: null };
      const listeners = new Set<(state: HostState) => void>();
      const observableHost = { health: async () => state, setWriterFence: () => {}, release: async () => {},
        onStateChange: (listener: (state: HostState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
      unbindPersistence = await bindCodexHostPersistence(registry, key,
        observableHost as unknown as Parameters<typeof bindCodexHostPersistence>[2], "structured-host:fixture", 1);
      void child!.exited.then(() => { for (const listener of [...listeners]) listener({ ...state, status: "dead", pid: null }); });
    }
    if (scenario === "running-stage") {
      publish(false);
      setRegistryBusy(false);
    }
    unavailable = true;
    const started = Date.now();
    await tick();
    if (helperPid !== null) {
      // The root can exit before the executor escalates its captured helper.
      while (journal.effectBatch(100, ["runtime.kill"]).length > 0 && Date.now() - started < 5_000) await Bun.sleep(10);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(journal.effectBatch(100, ["runtime.kill"])).toEqual([]);
    expect(commands.every(command => !!(command as { onlyIfIdle?: unknown }).onlyIfIdle)).toBe(true);
    if (["idle", "queued-after-actuation-read", "retry-after-actuation-read", "root-exits-before-helper", "rotated-seat"].includes(scenario)) {
      await child.exited;
      expect(procBackend.pidAlive(recordedPid)).toBe(false);
      expect(signals.length).toBeGreaterThan(0);
      if (helperPid !== null) {
        expect(procBackend.pidAlive(helperPid)).toBe(false);
        expect(signals).toContain(helperPid);
      }
      if (scenario === "queued-after-actuation-read") expect(journal.operationResult("new-racing-turn")?.receipt.status).toBe("rejected");
      expect(loadPipelines()[0]!.terminalReap).toMatchObject({ rounds: 1, stopped: 1 });
    } else {
      expect(procBackend.pidAlive(recordedPid)).toBe(true);
      expect(signals).toEqual([]);
      if (scenario === "running-stage") expect(loadPipelines()[0]!.terminalReap).toBeUndefined();
      else expect(loadPipelines()[0]!.terminalReap).toMatchObject({ rounds: 0, stopped: 0, settledAt: null });
      if (scenario === "unavailable" || scenario === "resumed-after-snapshot" || scenario === "resumed-before-actuation" || scenario === "rotated-seat-open-turn") {
        expect(journal.snapshot().sessions[0]?.turn).toBe("running");
      }
      if (["resumed-before-actuation", "registry-busy-before-signal", "generation-before-actuation", "queued-before-actuation"].includes(scenario)) expect(actuationChecked).toBe(true);
      if (scenario === "seat-before-signal") expect(seatAcquired).toBe(true);
      if (["live-seat", "legacy-seat", "store-only-seat", "pending-seat", "redesignated-seat", "seat-before-signal", "seat-in-another-project", "malformed-active-seat", "malformed-pending-seat", "malformed-seat-collection", "malformed-revocation"].includes(scenario)) {
        // Idle live seats survive repeated sweeps without spending the budget.
        await tick();
        expect(procBackend.pidAlive(recordedPid)).toBe(true);
        expect(signals).toEqual([]);
        expect(loadPipelines()[0]!.terminalReap).toMatchObject({ rounds: 0, stopped: 0, settledAt: null });
        if (readableSeatFile !== null) fs.writeFileSync(seatFile, readableSeatFile);
        if (scenario === "pending-seat" || scenario === "malformed-pending-seat") expect(completeOrchestratorSeatIntent({ project: seatProject,
          clientRequestId: "fixture-seat-1", conversationId, path: transcript }).kind).toBe("activated");
        if (scenario === "legacy-seat") designate(conversationId);
        designate("conversation_seat_successor");
      }
      if (scenario === "unreadable-seat-store") fs.unlinkSync(seatFile);
      if (scenario === "running-stage") {
        const record = loadPipelines()[0]!;
        record.runs[0]!.attempts[0] = { ...finished, state: "passed", completedAt: "2026-07-31T00:10:00.000Z", verdict: { status: "pass" } };
        record.state = "completed";
        savePipelines([record]);
      }
      // Deferred attempts remain eligible once the same recorded host is idle.
      recovered = true;
      if (scenario === "queued-before-actuation") {
        const pending = journal.operationResult("new-queued-turn")!;
        expect(pending.receipt.status).toBe("queued");
        journal.transitionOperation("new-queued-turn", "failed", { reason: "delivery-discarded" });
      }
      publish(false);
      setRegistryBusy(false);
      const cleanupStarted = Date.now();
      await tick();
      await child.exited;
      expect(Date.now() - cleanupStarted).toBeLessThan(5_000);
      expect(signals.length).toBeGreaterThan(0);
      expect(loadPipelines()[0]!.terminalReap).toMatchObject({ rounds: 1, stopped: 1 });
    }
  } finally {
    // Restore process-global overrides before any fallible resource cleanup.
    process.kill = originalKill;
    if (oldSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = oldSocket;
    if (oldStructured === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = oldStructured;
    setAgentRegistryForTests(oldRegistry);
    try {
      unbindPersistence?.();
      if (registryResource) await bindStructuredDeliveryQueue([], { registry: registryResource, client: null });
    } finally {
      try {
        if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
        try { journalResource?.close(); } finally { registryResource?.close(); }
      } finally {
        if (child && child.exitCode === null) {
          signals.push(child.pid);
          child.kill();
        }
        if (child) await child.exited;
        recordHelper();
        if (helperPid !== null && procBackend.pidAlive(helperPid)) {
          if (!helperIdentity || procBackend.processIdentity(helperPid) !== helperIdentity) {
            throw new Error("fixture helper identity changed before cleanup");
          }
          signals.push(helperPid);
          originalKill.call(process, helperPid, "SIGKILL");
          const deadline = Date.now() + 5_000;
          while (procBackend.pidAlive(helperPid) && Date.now() < deadline) await Bun.sleep(10);
          expect(procBackend.pidAlive(helperPid)).toBe(false);
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
}

test.each(socketScenarios)("automatic retirement over the production socket: %s", async (scenario) => {
  if (!socketChild) return isolatedSocketCase(`automatic retirement over the production socket: ${scenario}`);
  await socketScenario(scenario);
  process.stdout.write(`socket case completed: automatic retirement over the production socket: ${scenario}\n`);
}, 15_000);

test.each(["readiness", "admission", "socket"] as const)("production socket fixture cleans up setup failure: %s", async (failure) => {
  if (!socketChild) return isolatedSocketCase(`production socket fixture cleans up setup failure: ${failure}`);
  const { procBackend } = await import("@/lib/proc");
  const originalKill = process.kill;
  const originalSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const originalStructured = process.env.LLV_STRUCTURED_HOSTS;
  const registryState = process as typeof process & { __llvAgentRegistry?: unknown };
  const originalRegistry = registryState.__llvAgentRegistry ?? null;
  const ownership: FixtureOwnership = { pids: [], signals: [] };
  await expect(socketScenario("root-exits-before-helper", failure, ownership)).rejects.toThrow(
    failure === "socket" ? "runtime socket maxConnections" : `injected ${failure} failure`,
  );
  expect(ownership.pids).toHaveLength(2);
  for (const pid of ownership.pids) expect(procBackend.pidAlive(pid)).toBe(false);
  expect(ownership.signals.length).toBeGreaterThan(0);
  expect(ownership.signals.every(pid => ownership.pids.includes(pid))).toBe(true);
  expect(process.kill).toBe(originalKill);
  expect(process.env.LLV_RUNTIME_HOST_SOCKET).toBe(originalSocket);
  expect(process.env.LLV_STRUCTURED_HOSTS).toBe(originalStructured);
  expect(registryState.__llvAgentRegistry ?? null).toBe(originalRegistry);
  process.stdout.write(`socket case completed: production socket fixture cleans up setup failure: ${failure}\n`);
}, 15_000);
