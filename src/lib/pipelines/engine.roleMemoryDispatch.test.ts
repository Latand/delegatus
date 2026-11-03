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

async function fixture(name: string, sqliteWriterDeadlineMs?: number) {
  setSystemTime(new Date("2026-11-03T12:00:00Z"));
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  cleanups.push(() => ids.mockRestore());
  const h = await reserveActivationOnly([{ id: "plan", kind: "run", role: { roleId: "builder" }, engine: "codex",
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
    const key = { engine: "codex" as const, sessionId: crypto.randomUUID() };
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

async function childTick(f: Awaited<ReturnType<typeof fixture>>, now: string) {
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
        spawnAgent: async () => { spawns++; throw new Error("unexpected launch"); },
        recoverStagedLaunch: async () => { throw new Error("privacy wait must not replay its launch"); },
      });
      const lane = loadPipelines()[0];
      const attempt = lane.runs[0].attempts[0];
      console.log(JSON.stringify({ state: lane.state, detail: lane.stateDetail, wait: attempt.roleMemoryDispatchWait,
        launchId: attempt.launchId, retiredLaunches: attempt.retiredLaunches, spawns }));
      registry.close();
    `], { env: { ...process.env, LLV_MEMORY_DISPATCH_REGISTRY: f.registryFile, LLV_MEMORY_DISPATCH_NOW: now },
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

test("a fresh controller finishes a claimed role-memory retirement and launches one replacement", async () => {
  const f = await fixture("claimed-restart");
  f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const claimId = `${loadPipelines()[0]!.id}:plan:${f.launches[0]}`;
  expect(await f.production.claimSpawnRetry(f.launches[0]!, claimId)).toBe("claimed");
  const recovered = await childTick(f, f.h.ports.now());
  expect(recovered).toMatchObject({ state: "running", launchId: null, spawns: 0 });
  expect(recovered.retiredLaunches.map((row: { launchId: string }) => row.launchId)).toEqual(f.launches);
  f.h.ports.spawnAgent = f.normalSpawn;
  for (let i = 0; i < 6; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(f.attempt().state).toBe("running");
  expect(f.replacements).toHaveLength(1);
  expect(f.attempt().retiredLaunches?.map(row => row.launchId)).toEqual(f.launches);
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
