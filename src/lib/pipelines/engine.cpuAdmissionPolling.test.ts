import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStateCollection, StateSnapshotChangedError } from "../state/sqliteStateStore";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cpuAdmissionFile, machineCpuAdmissionQueue, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS } from "../runtime/cpuAdmission";
import { DEFAULT_CPU_PRESSURE_POLICY, setMachineCpuPressureForTests } from "../runtime/cpuPressure";
import { registerPipelineTick } from "./controllerSignal";
import * as engine from "./engine";
import { loadPipelines, savePipelines } from "./store";
import { writeDrain, drainFile, releaseDrain } from "../selfUpdate/drain";
import { realExec } from "../workflows/provision";
import * as workflowEngine from "../workflows/engine";
import { buildWorkflow, loadWorkflows, saveWorkflows } from "../workflows/store";
import { closeAgentRegistryForTests } from "../agent/registry";

registerPipelineTick(async () => {});
const queueSymbol = Symbol.for("delegatus.cpuAdmission");
const globals = globalThis as typeof globalThis & { [queueSymbol]?: { queue: ReturnType<typeof machineCpuAdmissionQueue> } };
let directory: string, environment: NodeJS.ProcessEnv;

beforeEach(() => {
  environment = { ...process.env };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-cpu-poll-"));
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  process.env.LLV_GATE_LOCK_DIR = path.join(directory, "locks");
  closeAgentRegistryForTests();
  setMachineCpuPressureForTests({ check: key => {
    const wait = machineCpuAdmissionQueue().check(key!, false);
    return wait ? { since: wait.since, avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY, queue: wait } : null;
  } }, 20);
  savePipelines([]);
  saveWorkflows([]);
});

afterEach(() => {
  closeAgentRegistryForTests();
  globals[queueSymbol]?.queue.close();
  delete globals[queueSymbol];
  setMachineCpuPressureForTests(undefined);
  process.env = environment;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function until(check: () => boolean) {
  const deadline = performance.now() + 15_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("CPU polling fixture did not reach its barrier");
    await Bun.sleep(10);
  }
}

async function harness(words = ["one", "two"]) {
  const launches: { title: string; at: number }[] = [];
  machineCpuAdmissionQueue();
  const db = new Database(cpuAdmissionFile());
  db.exec("PRAGMA busy_timeout=5000");
  const abort = new AbortController();
  let release!: () => void, hookCode: number | null | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pressureFile = path.join(directory, "pressure");
  fs.writeFileSync(pressureFile, ""); // A permissive sample still respects FIFO.
  const adapter = engine.defaultPipelinePorts();
  const ports = {
    cpuPressureHold: adapter.cpuPressureHold, cpuAdmissionReconcile: adapter.cpuAdmissionReconcile,
    cpuAdmissionSuspend: adapter.cpuAdmissionSuspend, drainHold: adapter.drainHold,
    exec: async (_command: string, args: string[], cwd: string) => {
      const pipeline = loadPipelines().find(p => p.worktreeDir === cwd);
      if (args[0] === "remote" && args[1] === "get-url") return { code: 2, stdout: "", stderr: "no such remote" };
      if (args[0] === "commit") {
        const result = await realExec("bash", ["scripts/gate-slot.sh", "true"], process.cwd(), {
          ...process.env, DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "on",
          LLV_GATE_PSI_FILE: pressureFile, LLV_GATE_POLL_SECONDS: "0.02", LLV_GATE_SLOT_LEASE: "",
        }, { signal: abort.signal, timeoutMs: 1000 });
        hookCode = result.code;
        await held; // Keep the main tick held after the real hook settles.
        return { code: 1, stdout: "", stderr: "fixture stops after the hook" };
      }
      const stdout = args[0] === "branch" ? `${pipeline?.branch ?? "main"}\n`
        : args[0] === "symbolic-ref" ? `refs/heads/${pipeline?.branch}\n`
        : args.includes("--git-path") ? `${path.join(directory, "index")}\n`
        : args[0] === "status" ? " M output.txt\n"
        : args[0] === "rev-parse" || args[0] === "write-tree" ? `${"a".repeat(40)}\n` : "";
      return { code: 0, stdout, stderr: "" };
    },
    provisionExec: () => ({ code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }),
    preflightRepo: (repoDir: string) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: directory }),
    roleLookup: () => ({ engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: "Build" }),
    projectForCwd: () => "fixture", sourcePathAllowed: () => true,
    conversationIdForPath: () => "creator", pipelineAdoptionCandidates: () => [],
    pathForConversation: () => null, headCwd: () => null,
    worktreePresent: () => true, structuredDeliveryPublication: () => "ready",
    spawnReceipt: () => null, claimSpawnRetry: () => "claimed",
    spawnAgent: async (input: { clientAttemptId: string; title: string }, onReserved: (value: { launchId: string; conversationId: string }) => Promise<void>) => {
      launches.push({ title: input.title, at: performance.now() });
      const conversationId = `launched-${launches.length}`;
      await onReserved({ launchId: input.clientAttemptId, conversationId });
      return { launchId: input.clientAttemptId, conversationId, sessionId: "session", transcript: `/fixture/stage-${launches.length}.jsonl`, paneId: null };
    },
    stageHostResident: async () => false, conversationAgentActive: async () => false,
    durableTurnEvidence: async () => null, lastMessage: () => null,
    scheduleTick: () => {}, monotonicNow: Date.now, now: () => new Date().toISOString(),
  } as unknown as engine.PipelinePorts;
  for (const word of words) {
    const result = await engine.createPipelineFromRequest({ task: word, spec: "CPU queue", repoDir: path.join(directory, word),
      src: "/fixture/creator.jsonl", publication: "internal", baseRef: "a".repeat(40),
      stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: null }] }, ports);
    expect(result.error).toBeUndefined();
  }
  await engine.tickPipelines([], ports);
  await engine.tickPipelines([], ports);
  const age = () => db.query("UPDATE tickets SET since = ? WHERE owner IS NULL").run(Date.now() - 100 * CPU_QUEUE_MAX_WAIT_MS);
  db.query("UPDATE tickets SET since = ? WHERE seq = (SELECT MIN(seq) FROM tickets)").run(Date.now() - CPU_QUEUE_MAX_WAIT_MS);
  await engine.tickPipelines([], ports);
  expect(launches).toHaveLength(1);
  const rows = loadPipelines(), first = rows[0]!;
  first.cursor!.state = "committing";
  const attempt = first.runs[0]!.attempts.at(-1)!;
  attempt.state = "committing";
  attempt.verdict = { status: "pass", confidence: 1 };
  savePipelines(rows);
  return { ports, launches, db, age, release, abort, hookCode: () => hookCode,
    hookQueued: () => !!db.query("SELECT key FROM tickets WHERE owner IS NOT NULL").get(),
    close: () => db.close() };
}

test("expired pipeline heads start in FIFO with real spacing while their predecessor's commit hook waits", async () => {
  const h = await harness(["one", "two", "three"]);
  let finished = false;
  const pending = engine.tickPipelines([], h.ports).finally(() => { finished = true; });
  try {
    await until(h.hookQueued);
    h.age();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(finished).toBe(false);
    expect(h.launches.map(item => item.title)).toEqual(["one · build", "two · build", "three · build"]);
    expect(h.launches[2]!.at - h.launches[1]!.at).toBeGreaterThanOrEqual(CPU_QUEUE_SPACING_MS - 50);
    expect(h.db.query("SELECT key FROM tickets").all()).toEqual([]);
  } finally { h.abort.abort(); h.release(); await pending; h.close(); }
  expect(h.launches).toHaveLength(3);
}, 20_000);

test.each(["pause", "close", "update"] as const)("pipeline %s releases a head for its blocked real commit hook without finishing the tick", async action => {
  const h = await harness();
  let finished = false;
  const pending = engine.tickPipelines([], h.ports).finally(() => { finished = true; });
  try {
    await until(h.hookQueued);
    const second = loadPipelines()[1]!;
    if (action === "update") writeDrain(drainFile(), { id: "update", target: "candidate", since: new Date().toISOString(), until: 0, persistent: true });
    else expect((await engine.patchPipeline(second.id, { action }, h.ports)).error).toBeUndefined();
    h.age();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(finished).toBe(false);
    expect(h.launches).toHaveLength(1);
    if (action === "update") {
      releaseDrain(drainFile(), "update");
      await until(() => h.launches.length === 2);
      expect(finished).toBe(false);
    }
  } finally { h.abort.abort(); h.release(); await pending; h.close(); }
}, 20_000);

test.each(["failure", "snapshot"] as const)("pipeline admission retries a transient %s during a blocked real hook", async kind => {
  const h = await harness();
  const reconcile = h.ports.cpuAdmissionReconcile!;
  let refuse = false;
  h.ports.cpuAdmissionReconcile = () => {
    if (refuse) { refuse = false; throw kind === "snapshot" ? new StateSnapshotChangedError() : new Error("temporary queue read failure"); }
    return reconcile();
  };
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const pending = engine.tickPipelines([], h.ports);
  try {
    await until(h.hookQueued);
    refuse = true;
    h.age();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(h.launches).toHaveLength(2);
    expect(errors.mock.calls).toHaveLength(kind === "snapshot" ? 0 : 1);
  } finally { h.abort.abort(); h.release(); await pending; errors.mockRestore(); h.close(); }
}, 20_000);

test("a slow admitted launch leaves later CPU heads polling and their reserved activations dispatchable", async () => {
  const h = await harness(["one", "two", "three"]);
  const spawn = h.ports.spawnAgent;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  h.ports.spawnAgent = async (...args) => {
    const result = await spawn(...args);
    if (h.launches.length === 2) await held;
    return result;
  };
  let finished = false;
  const pending = engine.tickPipelines([], h.ports).finally(() => { finished = true; });
  try {
    await until(h.hookQueued);
    h.age();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(finished).toBe(false);
    expect(h.launches).toHaveLength(2);
    expect(loadPipelines()[2]!.runs[0]!.attempts.at(-1)!.activation?.phase).toBe("reserved");
    release();
    await until(() => h.launches.length === 3);
    expect(finished).toBe(false);
  } finally { release(); h.abort.abort(); h.release(); await pending; h.close(); }
}, 30_000);

test.each(["unbound", "rebinding"] as const)("a %s delivery controller suspends a pipeline head while its predecessor's real hook waits", async publication => {
  const h = await harness();
  const pending = engine.tickPipelines([], h.ports);
  try {
    await until(h.hookQueued);
    h.ports.structuredDeliveryPublication = () => publication;
    h.age();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(h.launches).toHaveLength(1);
    h.ports.structuredDeliveryPublication = () => "ready";
    await until(() => h.launches.length === 2);
  } finally { h.abort.abort(); h.release(); await pending; h.close(); }
}, 30_000);

test.each(["memory", "controller", "provider"] as const)("a future %s retry suspends the CPU head without spending its admission", async kind => {
  const h = await harness(["one", "two", "three"]);
  const pending = engine.tickPipelines([], h.ports);
  try {
    await until(h.hookQueued);
    const rows = loadPipelines(), second = rows[1]!, attempt = second.runs[0]!.attempts.at(-1)!;
    const future = new Date(Date.now() + 60_000).toISOString();
    const wait = { startedAt: new Date().toISOString(), rounds: 0, retryAfter: future, budgetMs: 120_000, retryMaxMs: 60_000 };
    if (kind === "memory") attempt.memoryWait = wait;
    else if (kind === "controller") attempt.controllerWait = wait;
    else attempt.providerWait = { condition: { kind: "usage_limit", scope: "usage", resetLabel: null, label: "limit" }, text: "waiting", accountId: null, turnTs: 0, tries: 0, startedAt: wait.startedAt, resumeAt: future, resetsAt: null };
    savePipelines(rows);
    await h.ports.cpuAdmissionReconcile?.(h.ports);
    const key = h.db.query<{ key: string; seq: number }, [string]>("SELECT key, seq FROM tickets WHERE key LIKE ?").get(`%:${second.id}:%`)!;
    expect(h.db.query("SELECT key FROM suspended WHERE key = ?").get(key.key)).not.toBeNull();
    h.age();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(h.launches.map(item => item.title)).toEqual(["one · build", "three · build"]);
    expect(h.db.query<{ seq: number }, [string]>("SELECT seq FROM tickets WHERE key = ?").get(key.key)?.seq).toBe(key.seq);
    const fresh = loadPipelines(), retry = fresh[1]!.runs[0]!.attempts.at(-1)!;
    delete retry.memoryWait; delete retry.controllerWait; delete retry.providerWait;
    savePipelines(fresh);
    await until(() => h.launches.length === 3);
    expect(h.launches[2]!.title).toBe("two · build");
  } finally { h.abort.abort(); h.release(); await pending; h.close(); }
}, 30_000);

test("an expired run head progresses while a pending review's Git observation is held", async () => {
  const h = await harness(["one", "two", "three"]);
  let releaseObservation!: () => void, observing = false;
  const heldObservation = new Promise<void>(resolve => { releaseObservation = resolve; });
  const exec = h.ports.exec;
  h.ports.exec = async (command, args, cwd, ...rest) => {
    const review = loadPipelines()[1]!;
    if (cwd === review.worktreeDir && review.stages[0]!.kind === "review-loop" && args[0] === "status") {
      observing = true;
      await heldObservation;
    }
    return await exec(command, args, cwd, ...rest);
  };
  const pending = engine.tickPipelines([], h.ports);
  try {
    await until(h.hookQueued);
    const rows = loadPipelines(), stage = rows[1]!.stages[0]!;
    stage.kind = "review-loop"; stage.access = "read-only"; stage.effectiveRole.access = "read-only";
    savePipelines(rows);
    await until(() => observing);
    h.age();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(h.launches.map(item => item.title)).toEqual(["one · build", "three · build"]);
    expect((await engine.patchPipeline(rows[1]!.id, { action: "close" }, h.ports)).error).toBeUndefined();
  } finally { releaseObservation(); h.abort.abort(); h.release(); await pending; h.close(); }
}, 30_000);

test("an ineligible review releases its CPU ticket without waiting for expiry", async () => {
  const h = await harness();
  const pending = engine.tickPipelines([], h.ports);
  try {
    await until(h.hookQueued);
    const rows = loadPipelines(), stage = rows[1]!.stages[0]!;
    stage.kind = "review-loop"; stage.access = "read-only"; stage.effectiveRole.access = "read-only";
    savePipelines(rows);
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(loadPipelines()[1]!.state).toBe("needs_decision");
    expect(h.launches).toHaveLength(1);
  } finally { h.abort.abort(); h.release(); await pending; h.close(); }
}, 20_000);

test.each(["expiry", "pause", "close", "update"] as const)("the scanner services workflow %s while a pipeline's real commit hook waits behind it", async action => {
  const h = await harness(["one"]);
  const wf = buildWorkflow({ id: "workflow-one", name: "CPU queue", task: "Build", project: "fixture",
    repoDir: path.join(directory, "workflow"), mode: "auto", now: new Date().toISOString(),
    template: { name: "CPU queue", setup: "bun install", finish: "pr", stages: [
      { kind: "implement", agent: { engine: "codex", model: null, effort: "high" }, scope: "Build" },
      { kind: "review-loop", fixer: { engine: "codex", model: null, effort: "high" },
        reviewer: { engine: "codex", model: null, effort: "high" }, roundLimit: 3, reviewerMode: "headless" },
    ] } });
  wf.baseRef = "base";
  wf.baseBranch = "main";
  saveWorkflows([wf]);
  let starts = 0, finished = false;
  const wfPorts = { ...workflowEngine.defaultPorts(),
    startSetup: () => { starts++; return { pid: 123 }; },
    setupStatus: () => ({ status: "running" as const, detail: "" }),
  };
  await workflowEngine.tickWorkflows([], wfPorts);
  expect(starts).toBe(0);
  const originalPipelineTick = engine.tickPipelines, originalWorkflowTick = workflowEngine.tickWorkflows;
  const pipelineTick = spyOn(engine, "tickPipelines").mockImplementation(entries => originalPipelineTick(entries, h.ports));
  const workflowTick = spyOn(workflowEngine, "tickWorkflows").mockImplementation(entries => originalWorkflowTick(entries, wfPorts));
  const { reconcileFileControllers } = await import("../scanner/index");
  const pending = reconcileFileControllers([]).finally(() => { finished = true; });
  try {
    await until(h.hookQueued);
    if (action === "expiry") h.age();
    else if (action === "update") writeDrain(drainFile(), { id: "update", target: "candidate", since: new Date().toISOString(), until: 0, persistent: true });
    else expect((await workflowEngine.patchWorkflow(wf.id, { action }, wfPorts)).error).toBeUndefined();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(starts).toBe(action === "expiry" ? 1 : 0);
    expect(loadWorkflows()[0]!.setupPid).toBe(action === "expiry" ? 123 : null);
    expect(finished).toBe(false);
  } finally {
    h.abort.abort(); h.release(); await pending;
    pipelineTick.mockRestore(); workflowTick.mockRestore(); h.close();
  }
}, 20_000);

test("the scanner services a pipeline head after its pass ends while a workflow finish command waits", async () => {
  const h = await harness();
  const rows = loadPipelines(), first = rows[0]!;
  first.cursor!.state = "running";
  const attempt = first.runs[0]!.attempts.at(-1)!;
  attempt.state = "running";
  attempt.verdict = null;
  savePipelines(rows);
  const role = { engine: "codex" as const, model: null, effort: "high" as const };
  const wf = buildWorkflow({ id: "workflow-one", name: "CPU queue", task: "Build", project: "fixture",
    repoDir: path.join(directory, "workflow"), mode: "auto", now: new Date().toISOString(),
    template: { name: "CPU queue", setup: "bun install", finish: "pr", stages: [
      { kind: "implement", agent: role, scope: "Build" },
      { kind: "review-loop", fixer: role, reviewer: role, roundLimit: 3, reviewerMode: "headless" },
    ] } });
  wf.state = "finishing";
  saveWorkflows([wf]);
  const wfPorts = { ...workflowEngine.defaultPorts(), exec: () => h.ports.exec("git", ["commit"], wf.worktreeDir) };
  const originalPipelineTick = engine.tickPipelines, originalWorkflowTick = workflowEngine.tickWorkflows;
  const pipelineTick = spyOn(engine, "tickPipelines").mockImplementation(entries => originalPipelineTick(entries, h.ports));
  const workflowTick = spyOn(workflowEngine, "tickWorkflows").mockImplementation(entries => originalWorkflowTick(entries, wfPorts));
  const { reconcileFileControllers } = await import("../scanner/index");
  let finished = false;
  const pending = reconcileFileControllers([]).finally(() => { finished = true; });
  try {
    await until(h.hookQueued);
    h.age();
    await until(() => h.hookCode() !== undefined);
    expect(h.hookCode()).toBe(0);
    expect(h.launches).toHaveLength(2);
    expect(finished).toBe(false);
  } finally {
    h.abort.abort(); h.release(); await pending;
    pipelineTick.mockRestore(); workflowTick.mockRestore(); h.close();
  }
}, 20_000);


test("a CPU snapshot change preserves every queued ticket until the next observation", async () => {
  const h = await harness();
  const ports = engine.defaultPipelinePorts();
  const db = new Database(cpuAdmissionFile(),{ readonly: true });
  const before = db.query("SELECT key,seq,since FROM tickets ORDER BY seq").all();
  expect(before.length).toBeGreaterThan(0);
  const selection = spyOn(SqliteStateCollection.prototype,"pipelineControllerSelection").mockRejectedValueOnce(new StateSnapshotChangedError());
  try {
    await expect(Promise.resolve(ports.cpuAdmissionReconcile?.(ports))).resolves.toBeUndefined();
    expect(db.query("SELECT key,seq,since FROM tickets ORDER BY seq").all()).toEqual(before);
  } finally { selection.mockRestore(); db.close(); h.close(); }
});
