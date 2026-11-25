import { childTick, cleanupRoleMemoryDispatch, fixture, nativeStart } from "./engine.roleMemoryDispatch.fixture";
import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { RoleMemoryChanged } from "@/lib/memory/privacy";
import { defaultPipelinePorts, loadPipelines, savePipelines, tickPipelines } from "./engine.fixture";

afterEach(cleanupRoleMemoryDispatch);

for (const timing of ["before-claim", "during-claim"] as const) test.each(["task_started", "user_message"] as const)(
  `a ${timing} %s receipt adopts the original launch through later controllers`, async event => {
  const f = await fixture(`late-${timing}-${event}`);
  const staged = f.stage();
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  const pathname = staged.artifactPath;
  f.h.ports.durableTurnEvidence = (await import("./durableEvidence")).durableStageTurnEvidence;
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  const claim = f.h.ports.claimSpawnRetry;
  const start = async () => {
    fs.appendFileSync(pathname, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(),
      payload: event === "task_started" ? { type: "task_started" } : { type: "user_message", message: "Build safely" } }) + "\n");
    const evidence = await f.h.ports.durableTurnEvidence("codex", pathname);
    expect(evidence).toMatchObject({ launchOnly: false, turn: "busy" });
  };
  if (timing === "before-claim") await start();
  else f.h.ports.claimSpawnRetry = async (...args) => {
    const result = await claim(...args);
    expect(result).toBe("claimed");
    await start();
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
  for (let i = 0; i < 2; i++) {
    expect(await childTick(f, f.h.ports.now(), pathname, "unknown")).toMatchObject({
      state: "running", attemptState: "running", launchId: f.launches[0], spawns: 0,
    });
  }
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

for (const engine of ["codex", "claude"] as const) test.each(["native", "partial", "unreadable"] as const)(
  `${engine} retains its original when an absent artifact becomes %s during the retry claim`, async artifact => {
  const f = await fixture(`${engine}-appearing-${artifact}`, undefined, engine);
  const entry = f.stage();
  expect(fs.existsSync(entry.artifactPath)).toBe(false);
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  expect(f.production.spawnReceipt(f.launches[0]!)?.roleMemoryRetrySafe).toBe(true);
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  let claims = 0;
  const claim = f.h.ports.claimSpawnRetry;
  f.h.ports.claimSpawnRetry = async (...args) => {
    const result = await claim(...args);
    expect(result).toBe("claimed");
    claims++;
    expect(fs.existsSync(entry.artifactPath)).toBe(false);
    if (artifact === "unreadable") fs.symlinkSync(path.basename(entry.artifactPath), entry.artifactPath);
    else fs.writeFileSync(entry.artifactPath, artifact === "partial" ? '{"type":"user"' : JSON.stringify(engine === "codex"
      ? { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } }
      : { type: "user", timestamp: f.h.ports.now(), message: { role: "user", content: "Build safely" } }) + "\n");
    return result;
  };
  for (let i = 0; i < 6; i++) { await tickPipelines([], f.h.ports); f.h.advanceWallClock(1_000); }
  expect(claims).toBe(1);
  expect(f.replacements).toHaveLength(0);
  expect(f.attempt()).toMatchObject({ state: "spawning", launchId: f.launches[0] });
  expect(f.attempt().retiredLaunches).toBeUndefined();
  expect(await childTick(f, f.h.ports.now(), entry.artifactPath, "unknown")).toMatchObject({
    state: "running", attemptState: "spawning", launchId: f.launches[0], spawns: 0,
  });
});

test.each(["unreadable", "partial", "unknown", "changed-during-read", "changed-during-claimed-read",
  "appeared-during-read", "appeared-during-claimed-read"] as const)(
  "role-memory retirement requires unchanged positive no-turn evidence: %s", async mode => {
  const f = await fixture(`no-turn-${mode}`);
  const entry = f.stage("unhosted", f.launches[0]!, "metadata");
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  f.h.ports.originalLaunchOperations = async () => "unknown";
  f.h.ports.spawnAgent = f.normalSpawn;
  const evidence = f.h.ports.durableTurnEvidence;
  if (mode === "unreadable") {
    fs.unlinkSync(entry.artifactPath);
    fs.mkdirSync(entry.artifactPath);
  } else if (mode === "partial") fs.appendFileSync(entry.artifactPath, '{"type":"event_msg"');
  else if (mode === "unknown") fs.appendFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg",
    payload: { type: "task_started" } }) + "\n");
  else {
    const absent = mode.startsWith("appeared-");
    if (absent) fs.unlinkSync(entry.artifactPath);
    let reads = 0;
    f.h.ports.durableTurnEvidence = async (...args) => {
      const result = await evidence(...args);
      if (++reads === (mode.endsWith("claimed-read") ? 2 : 1)) {
        if (absent) expect(result).toBeNull();
        else expect(result?.launchOnly).toBe(true);
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

for (const engine of ["codex", "claude"] as const) test.each([false, true])(
  `${engine} keeps an adopted delivery through committed succession (foreign claim=%s)`, async foreignClaim => {
  const f = await fixture(`${engine}-committed-${foreignClaim}`, undefined, engine);
  const entry = f.stage("unhosted", f.launches[0]!, "absent", undefined, true, crypto.randomUUID());
  const conversationId = f.registry.spawnReceipt(f.launches[0]!)!.conversationId;
  expect(f.registry.conversation(conversationId)!.generations.at(-1)!.id).not.toBe(entry.key.sessionId);
  f.registry.failSpawn(f.launches[0]!, new RoleMemoryChanged().message);
  nativeStart(engine, entry.artifactPath, f.h.ports.now());
  f.h.ports.originalLaunchOperations = async () => "matched";
  f.h.ports.conversationAgentActive = async () => true;
  f.h.ports.pathForConversation = id => defaultPipelinePorts().pathForConversation(id);
  f.h.ports.spawnAgent = f.normalSpawn;
  await tickPipelines([], f.h.ports);
  expect(f.attempt().state).toBe("running");
  const successorId = crypto.randomUUID();
  const successor = { id: successorId, path: path.join(path.dirname(entry.artifactPath), `${successorId}.jsonl`), accountId: "account-b" };
  nativeStart(engine, successor.path, f.h.ports.now());
  f.registry.setConversationMigration(conversationId, { intentId: `${engine}-move`, phase: "verifying", targetId: "account-b",
    revision: 1, error: null, updatedAt: f.h.ports.now() });
  f.registry.recordConversationContinuityPath(conversationId, successor.path);
  const operationId = f.registry.conversation(conversationId)!.migration!.operationId;
  const receipt = { operationId, nativeId: successor.id, path: successor.path, continuityPaths: [], historyHash: "fixture-history",
    host: { kind: engine === "codex" ? "codex-app-server" as const : "claude-stream" as const,
      identity: successor.id, epoch: 1, verifiedAt: f.h.ports.now() } };
  f.registry.transitionConversationMigration(conversationId, 1, ["verifying"], { providerReceipt: receipt });
  f.registry.commitSuccessor(conversationId, successor, 1, operationId, receipt);
  if (foreignClaim) expect(f.registry.claimFailedSpawnForRetry(f.launches[0]!, "foreign-recovery").kind).toBe("claimed");
  for (let i = 0; i < 3; i++) { f.h.advanceWallClock(1_000); await tickPipelines([], f.h.ports); }
  expect(loadPipelines()[0]!.state).toBe(foreignClaim ? "needs_decision" : "running");
  expect(f.replacements).toHaveLength(0);
  expect(await childTick(f, f.h.ports.now(), successor.path)).toMatchObject({
    state: foreignClaim ? "needs_decision" : "running", launchId: f.launches[0], spawns: 0,
  });
  if (!foreignClaim) {
    const { reportStageCompletion } = await import("./engine");
    const result = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Original completed" },
      { kind: "agent", role: "builder", conversationId }, f.h.ports);
    expect(result.error).toBeUndefined();
    expect(f.attempt().report?.verdict.status).toBe("pass");
    f.h.ports.conversationAgentActive = async () => false;
    await tickPipelines([], f.h.ports);
    expect(f.attempt().verdict?.status).toBe("pass");
    expect(f.replacements).toHaveLength(0);
  }
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
