import "./engineEnvironment.fixture";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { AgentRegistry, defaultPipelinePorts, loadPipelines, reserveActivationOnly,
  setAgentRegistryForTests, tickPipelines } from "./engine.fixture";
import { RoleMemoryChanged } from "@/lib/memory/privacy";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { supervisedRuntimeHostUnavailableReason } from "@/lib/runtime/flags";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); setSystemTime(); setAgentRegistryForTests(null); });

async function fixture(name: string, sqliteWriterDeadlineMs?: number, engine: "codex" | "claude" = "codex") {
  setSystemTime(new Date("2026-11-03T12:00:00Z"));
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  cleanups.push(() => ids.mockRestore());
  const h = await reserveActivationOnly([{ id: "plan", kind: "run", role: { roleId: "builder" }, engine,
    ...(engine === "claude" ? { model: "fable" } : {}),
    access: "read-only", prompt: "Build safely", next: null }] as never);
  h.advanceWallClock(Date.parse("2026-11-03T12:00:00Z") - Date.parse(h.ports.now()));
  const registryFile = path.join(process.env.LLV_STATE_DIR!, `memory-dispatch-${name}.json`);
  const registry = new AgentRegistry(registryFile, undefined, undefined, sqliteWriterDeadlineMs === undefined ? {} : {
    sqliteMode: "sqlite", sqliteWriterDeadlineMs,
  });
  cleanups.push(() => registry.close());
  setAgentRegistryForTests(registry);
  const production = defaultPipelinePorts();
  h.ports.spawnReceipt = production.spawnReceipt;
  h.ports.claimSpawnRetry = production.claimSpawnRetry;
  h.ports.sourcePathAllowed = pathname => pathname.startsWith(process.env.LLV_STATE_DIR! + path.sep);
  h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  const launches: string[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    const begun = registry.beginSpawnRequest({ engine: input.role.engine, cwd: input.cwd,
      transport: "structured", clientAttemptId: input.clientAttemptId, launchProfile: { title: input.title } });
    expect(begun.kind).toBe("created");
    launches.push(begun.receipt.launchId);
    await onReserved(begun.receipt);
    throw new RoleMemoryChanged();
  };
  await tickPipelines([], h.ports);
  const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
  const stage = (status: "unhosted" | "live" = "unhosted", launchId = launches[0]!) => {
    const key = { engine, sessionId: crypto.randomUUID() };
    const artifactPath = path.join(process.env.LLV_STATE_DIR!, `${name}-${key.sessionId}.jsonl`);
    fs.writeFileSync(artifactPath, JSON.stringify({ type: "session_meta", payload: { id: key.sessionId } }) + "\n");
    const entry = { key, artifactPath, cwd: loadPipelines()[0]!.worktreeDir!, accountId: null,
      launchProfile: emptyLaunchProfile(), status, host: null, pendingAction: null, claimEpoch: 0, claimOwner: null };
    expect(registry.stageStructuredSpawn(launchId, entry).kind).toBe("settled");
    return entry;
  };
  const replacements: string[] = [];
  const normalSpawn: typeof h.ports.spawnAgent = async (input, onReserved) => {
    const begun = registry.beginSpawnRequest({ engine: input.role.engine, cwd: input.cwd,
      transport: "structured", clientAttemptId: input.clientAttemptId, launchProfile: { title: input.title } });
    expect(begun.kind).toBe("created");
    replacements.push(begun.receipt.launchId);
    await onReserved(begun.receipt);
    const entry = stage("live", begun.receipt.launchId);
    registry.completeSpawn(begun.receipt.launchId, entry);
    return { launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId,
      sessionId: entry.key.sessionId, transcript: entry.artifactPath, paneId: null, accountId: null };
  };
  return { h, registry, registryFile, production, normalSpawn, launches, replacements, attempt, stage };
}

function holdRegistryWriter(f: Awaited<ReturnType<typeof fixture>>) {
  const holder = new Database(f.registryFile.replace(/\.json$/, ".sqlite"));
  holder.exec("PRAGMA busy_timeout = 0");
  holder.exec("BEGIN IMMEDIATE");
  return holder;
}

test.each(["neverBegan", "roleMemoryRetrySafe"] as const)("a role-memory conflict waits before retiring its %s receipt once", async proof => {
    const { h, registry, production, normalSpawn, launches, replacements, stage, attempt: current } = await fixture(`retry-${proof}`);
    const waiting = loadPipelines()[0]!;
    expect(waiting.state, waiting.stateDetail ?? "").toBe("running");
    expect(waiting.runs[0]!.attempts[0]!).toMatchObject({ state: "spawning", launchId: launches[0] });
    expect(waiting.stateDetail).toContain("role-memory");
    expect(waiting.runs[0]!.attempts[0]!.controllerWait).toBeDefined();
    await tickPipelines([], h.ports);
    expect(launches).toHaveLength(1);
    expect(loadPipelines()[0]!.state).toBe("running");
    if (proof === "roleMemoryRetrySafe") stage();
    registry.failSpawn(launches[0]!, proof === "roleMemoryRetrySafe" ? new RoleMemoryChanged().message
      : supervisedRuntimeHostUnavailableReason("pipeline structured runtime host"));
    expect(production.spawnReceipt(launches[0]!)?.[proof]).toBe(true);
    h.ports.spawnAgent = normalSpawn;
    for (let i = 0; i < 5; i++) { h.advanceWallClock(1_000); await tickPipelines([], h.ports); }
    const attempt = current();
    expect(attempt.state).toBe("running");
    expect(attempt.retiredLaunches?.map(row => row.launchId)).toEqual(launches);
    expect(replacements).toHaveLength(1);
    expect(registry.spawnReceipt(launches[0]!)?.retryClaim?.claimId).toBe(`${waiting.id}:plan:${launches[0]}`);
});

test("a confirmed unstarted Claude original launches exactly one replacement", async () => {
  const f = await fixture("claude-unstarted", undefined, "claude");
  f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  f.h.ports.spawnAgent = f.normalSpawn;
  for (let i = 0; i < 6; i++) { await tickPipelines([], f.h.ports); f.h.advanceWallClock(1_000); }
  expect(f.replacements).toHaveLength(1);
  expect(f.attempt().state).toBe("running");
});

test("registry writer contention before the role-memory deadline waits, then releases one replacement", async () => {
  const f = await fixture("writer-before-deadline", 20);
  f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const wait = f.attempt().roleMemoryDispatchWait!;
  const holder = holdRegistryWriter(f);
  try {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "running" });
    expect(loadPipelines()[0]!.stateDetail).toContain("receipt failed");
    expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0], roleMemoryDispatchWait: wait });
    expect(f.attempt().controllerWait?.retryAfter).toBeDefined();
    expect(f.replacements).toHaveLength(0);
  } finally { holder.exec("ROLLBACK"); holder.close(); }
  f.h.advanceWallClock(2_000);
  f.h.ports.spawnAgent = f.normalSpawn;
  await tickPipelines([], f.h.ports);
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "pending", launchId: null });
  for (let i = 0; i < 5; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(f.attempt().retiredLaunches?.map(row => row.launchId)).toEqual(f.launches);
  expect(f.replacements).toHaveLength(1);
  expect(f.registry.spawnReceipt(f.launches[0]!)?.retryClaim?.claimId).toBe(`${loadPipelines()[0]!.id}:plan:${f.launches[0]}`);
  await tickPipelines([], f.h.ports);
  expect(f.replacements).toHaveLength(1);
});

test("registry writer contention past the role-memory deadline parks with the current receipt state", async () => {
  const f = await fixture("writer-after-deadline", 20);
  f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const wait = f.attempt().roleMemoryDispatchWait!;
  const holder = holdRegistryWriter(f);
  try {
    const expired = new Date(Date.parse(wait.deadline) + 1);
    setSystemTime(expired);
    f.h.advanceWallClock(expired.getTime() - Date.parse(f.h.ports.now()));
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });
    expect(loadPipelines()[0]!.stateDetail).toContain("receipt failed");
    expect(loadPipelines()[0]!.stateDetail).toContain(wait.deadline);
    expect(f.attempt()).toMatchObject({ launchId: f.launches[0], roleMemoryDispatchWait: wait });
    expect(f.replacements).toHaveLength(0);
  } finally { holder.exec("ROLLBACK"); holder.close(); }
});

test.each(["completed", "first-message"] as const)("a role-memory wait adopts %s evidence without another launch", async mode => {
  const f = await fixture(mode);
  const entry = f.stage("live");
  if (mode === "completed") f.registry.completeSpawn(f.launches[0]!, entry);
  else {
    fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: { type: "user_message", message: "Build safely" } }) + "\n");
    f.h.ports.sourcePathAllowed = pathname => pathname === entry.artifactPath;
    f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
    f.h.ports.originalLaunchOperations = async () => "matched";
  }
  f.h.ports.conversationAgentActive = async () => true;
  await tickPipelines([], f.h.ports);
  expect(f.attempt()).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: entry.artifactPath });
  expect(f.attempt().roleMemoryDispatchWait).toBeUndefined();
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.launches).toHaveLength(1);
  expect(f.registry.spawnReceipt(f.launches[0]!)!.retryClaim).toBeUndefined();
});

test.each(["foreign-claim", "changed-after-claim", "pause-after-claim"] as const)("a role-memory retry retains its launch on %s", async mode => {
  const f = await fixture(mode);
  const staged = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  if (mode === "foreign-claim") f.registry.claimFailedSpawnForRetry(f.launches[0]!, "another-recovery");
  else {
    f.h.ports.claimSpawnRetry = async (...args) => {
      const claim = await f.production.claimSpawnRetry(...args);
      if (mode === "changed-after-claim") f.registry.upsert({ ...staged, status: "live", claimOwner: "retained-host" });
      else {
        const { savePipelines } = await import("./store");
        const lane = loadPipelines()[0]!;
        lane.state = "paused";
        savePipelines([lane]);
      }
      return claim;
    };
  }
  await tickPipelines([], f.h.ports);
  expect(f.attempt().launchId).toBe(f.launches[0]!);
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.launches).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe(mode === "pause-after-claim" ? "paused" : "running");
});

test.each(["task_started", "user_message"] as const)("a late %s receipt after the retry claim adopts the original launch", async event => {
  const f = await fixture(`late-${event}`);
  const staged = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const pathname = staged.artifactPath;
  f.h.ports.sourcePathAllowed = candidate => candidate === pathname;
  f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  const claim = f.h.ports.claimSpawnRetry;
  f.h.ports.claimSpawnRetry = async (...args) => {
    const result = await claim(...args);
    expect(result).toBe("claimed");
    fs.appendFileSync(pathname, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: event === "task_started" ? { type: "task_started" } : { type: "user_message", message: "Build safely" } }) + "\n");
    const evidence = await f.h.ports.durableTurnEvidence("codex", pathname);
    expect(evidence).toMatchObject({ launchOnly: false, turn: "busy" });
    return result;
  };

  await tickPipelines([], f.h.ports);

  expect(f.attempt()).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: pathname });
  expect(f.attempt().roleMemoryDispatchWait).toBeUndefined();
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.replacements).toHaveLength(0);
  expect(f.launches).toHaveLength(1);
  for (let i = 0; i < 5; i++) {
    f.h.advanceWallClock(1_000);
    await tickPipelines([], f.h.ports);
    expect(f.attempt()).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: pathname });
  }
  expect(await childTick(f, f.h.ports.now(), pathname, "unknown")).toMatchObject({
    state: "running", attemptState: "running", launchId: f.launches[0], spawns: 0,
  });
  const { reportStageCompletion } = await import("./engine");
  const reported = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Original completed" },
    { kind: "agent", role: "builder", conversationId: f.attempt().conversationId! }, f.h.ports);
  expect(reported.error).toBeUndefined();
  fs.appendFileSync(pathname, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "task_complete", last_agent_message: "Original completed" } }) + "\n");
  await tickPipelines([], f.h.ports);
  expect(f.attempt().verdict?.status).toBe("pass");
  expect(f.attempt().state).toBe("passed");
  expect(f.replacements).toHaveLength(0);
});

test.each(["before-claim", "during-claim"] as const)("unknown operations retain a native start %s", async timing => {
  const f = await fixture(`unknown-${timing}`);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  const start = () => fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "task_started" } }) + "\n");
  if (timing === "before-claim") start();
  else {
    const claim = f.h.ports.claimSpawnRetry;
    f.h.ports.claimSpawnRetry = async (...args) => {
      const result = await claim(...args);
      expect(result).toBe("claimed");
      start();
      return result;
    };
  }
  for (let i = 0; i < 6; i++) {
    await tickPipelines([], f.h.ports);
    f.h.advanceWallClock(1_000);
  }
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.registry.spawnReceipt(f.launches[0]!)?.retryClaim?.claimId).toBe(timing === "before-claim"
    ? undefined : `${loadPipelines()[0]!.id}:plan:${f.launches[0]}`);
  expect(await childTick(f, f.h.ports.now(), entry.artifactPath, "unknown")).toMatchObject({
    state: "running", attemptState: "spawning", launchId: f.launches[0], spawns: 0,
  });
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  await tickPipelines([], f.h.ports);
  expect(f.attempt()).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: entry.artifactPath });
  expect(f.replacements).toHaveLength(0);
});

test.each(["missing", "unknown", "changed-during-read", "changed-during-claimed-read"] as const)(
  "role-memory retirement requires unchanged positive no-turn evidence: %s", async mode => {
  const f = await fixture(`no-turn-${mode}`);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  const evidence = f.h.ports.durableTurnEvidence;
  if (mode === "missing") fs.unlinkSync(entry.artifactPath);
  else if (mode === "unknown") fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg",
    payload: { type: "task_started" } }) + "\n");
  else {
    let reads = 0;
    f.h.ports.durableTurnEvidence = async (...args) => {
      const result = await evidence(...args);
      if (++reads === (mode === "changed-during-read" ? 1 : 2)) {
        expect(result?.launchOnly).toBe(true);
        fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
          payload: { type: "task_started" } }) + "\n");
      }
      return result;
    };
  }
  for (let i = 0; i < 6; i++) { await tickPipelines([], f.h.ports); f.h.advanceWallClock(1_000); }
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().retiredLaunches).toBeUndefined();
});

test("late delivery with a mismatched claimed generation cannot adopt or retire the launch", async () => {
  const f = await fixture("mismatched-claimed-generation");
  const staged = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const pathname = staged.artifactPath;
  f.h.ports.sourcePathAllowed = candidate => candidate === pathname;
  f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  f.h.ports.originalLaunchOperations = async () => "matched";
  const claim = f.h.ports.claimSpawnRetry;
  f.h.ports.claimSpawnRetry = async (...args) => {
    const result = await claim(...args);
    f.registry.upsert({ ...staged, artifactPath: `${pathname}.other-generation` });
    fs.appendFileSync(pathname, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: { type: "user_message", message: "Build safely" } }) + "\n");
    return result;
  };

  await tickPipelines([], f.h.ports);

  expect(f.production.spawnReceipt(f.launches[0]!)?.generationMatches).toBe(false);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().agentPath).toBeNull();
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(f.replacements).toHaveLength(0);
});

async function childTick(f: Awaited<ReturnType<typeof fixture>>, now: string, transcriptPath?: string, operations = "matched") {
    const child = Bun.spawn([process.execPath, "-e", `
      const { setMachineCpuPressureForTests } = await import("./src/lib/runtime/cpuPressure");
      setMachineCpuPressureForTests(null);
      const { tickPipelines, defaultPipelinePorts } = await import("./src/lib/pipelines/engine");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal");
      const { loadPipelines } = await import("./src/lib/pipelines/store");
      const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry");
      const registry = new AgentRegistry(process.env.LLV_MEMORY_DISPATCH_REGISTRY);
      setAgentRegistryForTests(registry); registerPipelineTick(async () => {});
      let spawns = 0;
      await tickPipelines([], { ...defaultPipelinePorts(), now: () => process.env.LLV_MEMORY_DISPATCH_NOW,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }), scheduleTick: () => {},
        cpuPressureHold: () => null, drainHold: () => null, worktreePresent: () => true,
        conversationAgentActive: async () => true,
        ...(process.env.LLV_MEMORY_DISPATCH_TRANSCRIPT_PATH ? {
          sourcePathAllowed: (candidate) => candidate === process.env.LLV_MEMORY_DISPATCH_TRANSCRIPT_PATH,
          originalLaunchOperations: async () => process.env.LLV_MEMORY_DISPATCH_OPERATIONS,
        } : {}),
        spawnAgent: async () => { spawns++; throw new Error("unexpected launch"); },
        recoverStagedLaunch: async () => { throw new Error("privacy wait must not replay its launch"); },
      });
      const lane = loadPipelines()[0];
      const attempt = lane.runs[0].attempts[0];
      console.log(JSON.stringify({ state: lane.state, attemptState: attempt.state, detail: lane.stateDetail, wait: attempt.roleMemoryDispatchWait,
        launchId: attempt.launchId, agentPath: attempt.agentPath, retiredLaunches: attempt.retiredLaunches, spawns }));
      registry.close();
    `], { env: { ...process.env, LLV_MEMORY_DISPATCH_REGISTRY: f.registryFile, LLV_MEMORY_DISPATCH_NOW: now,
      LLV_MEMORY_DISPATCH_OPERATIONS: operations,
      ...(transcriptPath ? { LLV_MEMORY_DISPATCH_TRANSCRIPT_PATH: transcriptPath } : {}) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, errors).toBe(0);
    return JSON.parse(output);
}

test.each(["starting", "failed"] as const)("a fresh controller retains the role-memory deadline for a %s receipt", async state => {
  const f = await fixture(`restart-${state}`);
  if (state === "failed") {
    const entry = f.stage();
    f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
    f.registry.upsert({ ...entry, structuredTerminationSurvivors: [{ pid: process.pid, startIdentity: null }] });
    expect(f.production.spawnReceipt(f.launches[0]!)?.roleMemoryRetrySafe).toBe(false);
  }
  const wait = f.attempt().roleMemoryDispatchWait!;
  expect(wait).toBeDefined();
  expect(await childTick(f, new Date(Date.parse(wait.deadline) - 1).toISOString())).toMatchObject({ state: "running", wait, spawns: 0 });
  const parked = await childTick(f, wait.deadline);
  expect(parked).toMatchObject({ state: "needs_decision", wait, spawns: 0 });
  expect(parked.detail).toContain(`receipt ${state}`);
  expect(parked.detail).toContain(wait.deadline);
});

test.each(["foreign-claim", "changed-generation"] as const)("a persisted role-memory delivery cannot excuse %s", async mode => {
  const f = await fixture(`delivery-${mode}`);
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "task_started" } }) + "\n");
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  await tickPipelines([], f.h.ports);
  expect(f.attempt().state).toBe("running");
  const delivery = f.attempt().roleMemoryDelivery!;
  expect(delivery).toEqual({ launchId: f.launches[0], conversationId: f.attempt().conversationId!,
    "transcript": entry.artifactPath, retryClaimId: null });
  const { savePipelines } = await import("./store");
  const lane = loadPipelines()[0]!;
  for (const invalid of [null, [], {}, { ...delivery, launchId: "" }, { ...delivery, retryClaimId: "" }]) {
    lane.runs[0]!.attempts[0]!.roleMemoryDelivery = invalid as never;
    expect(() => savePipelines([lane])).toThrow("malformed pipeline record");
    expect(f.attempt().roleMemoryDelivery).toEqual(delivery);
  }
  if (mode === "foreign-claim") expect(f.registry.claimFailedSpawnForRetry(f.launches[0]!, "foreign-recovery").kind).toBe("claimed");
  else f.registry.upsert({ ...entry, artifactPath: `${entry.artifactPath}.another-generation` });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(f.attempt().launchId).toBe(f.launches[0]);
  expect(f.replacements).toHaveLength(0);
});

test("a fresh controller finishes a claimed role-memory retirement and launches one replacement", async () => {
  const f = await fixture("claimed-restart");
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const claimId = `${loadPipelines()[0]!.id}:plan:${f.launches[0]}`;
  expect(await f.production.claimSpawnRetry(f.launches[0]!, claimId)).toBe("claimed");
  const recovered = await childTick(f, f.h.ports.now(), entry.artifactPath);
  expect(recovered).toMatchObject({ state: "running", launchId: null, spawns: 0 });
  expect(recovered.retiredLaunches.map((row: { launchId: string }) => row.launchId)).toEqual(f.launches);
  f.h.ports.spawnAgent = f.normalSpawn;
  for (let i = 0; i < 6; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(f.attempt().state).toBe("running");
  expect(f.replacements).toHaveLength(1);
  expect(f.attempt().retiredLaunches?.map(row => row.launchId)).toEqual(f.launches);
});

test("a fresh controller adopts a delivered original after its own retry claim", async () => {
  const f = await fixture("claimed-restart-delivered");
  const entry = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const claimId = `${loadPipelines()[0]!.id}:plan:${f.launches[0]}`;
  expect(await f.production.claimSpawnRetry(f.launches[0]!, claimId)).toBe("claimed");
  expect(f.production.spawnReceipt(f.launches[0]!)).toMatchObject({
    generationMatches: true, currentGeneration: false, retryClaimId: claimId,
  });
  f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "user_message", message: "Build safely" } }) + "\n");
  expect(await f.h.ports.durableTurnEvidence("codex", entry.artifactPath)).toMatchObject({ launchOnly: false, turn: "busy" });

  const recovered = await childTick(f, f.h.ports.now(), entry.artifactPath);

  expect(recovered).toMatchObject({ state: "running", launchId: f.launches[0], agentPath: entry.artifactPath, spawns: 0 });
  expect(recovered.retiredLaunches).toBeUndefined();
  expect(f.registry.spawnReceipt(f.launches[0]!)?.retryClaim?.claimId).toBe(claimId);
  expect(f.launches).toHaveLength(1);
});

test("role-memory dispatch deadlines round-trip and malformed waits are refused", async () => {
  const f = await fixture("validation");
  const { savePipelines } = await import("./store");
  const lane = loadPipelines()[0]!;
  const wait = f.attempt().roleMemoryDispatchWait!;
  for (const invalid of [null, [], {}, { ...wait, launchId: "" }, { ...wait, deadline: "invalid" }]) {
    lane.runs[0]!.attempts[0]!.roleMemoryDispatchWait = invalid as never;
    expect(() => savePipelines([lane])).toThrow("malformed pipeline record");
    expect(f.attempt().roleMemoryDispatchWait).toEqual(wait);
  }
});
