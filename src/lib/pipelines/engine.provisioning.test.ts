import { expect, test, spawn, fs, path, ACCOUNT_STORE_BUSY_MESSAGE, AccountMutationBusyError, defaultPipelinePorts, tickPipelines, registerPipelineTick, loadPipelines, savePipelines, interruptionObligationDirectory, patchPipeline, closeAndDrain, ORIGIN_MAIN_SHA, entry, harness, create, exhaustVerdictRecovery, withRuntimeSnapshot, DEPLOY_WINDOW_MS, forbiddenSleep, frozenWallClock, HISTORICAL_VERDICT_MISS, DEPLOY_CUT_HOLD, READ_ONLY_RERUN, deployCutObligations, structuredLatest, reviewParkedAfterRestart, STAGE_HEAD, PASS_TEXT, makeStructuredAttempt, stalledEntry, countDurableReads, runningStructuredStage } from "./engine.fixture";
import type { FileEntry } from "./engine.fixture";
import { assertStateChildSuccess } from "@/lib/state/stateChildResult.fixture";


test("a busy account mutation waits between ticks and claims one host on the same attempt (#1433)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  let launchClaims = 0;
  let hostClaims = 0;
  const scheduled: number[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    if (spawnCalls <= 2) {
      throw new AccountMutationBusyError("account mutation is busy in this process; retry shortly");
    }
    const spawned = await baseSpawn(input, (reservation) => {
      launchClaims += 1;
      onReserved(reservation);
    });
    hostClaims += 1;
    return spawned;
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(launchClaims).toBe(0);
  expect(hostClaims).toBe(0);
  expect(pipeline).toMatchObject({
    state: "running",
    stateDetail: expect.stringMatching(/^stage spawn deferred: The account store is temporarily busy; try again shortly\.; retry at /),
    cursor: { stageId: "plan", state: "pending" },
  });
  const waitingAttempt = pipeline.runs[0]!.attempts.at(-1)!;
  expect(waitingAttempt).toMatchObject({ n: 1, state: "pending", launchId: null, conversationId: null });
  expect(waitingAttempt.controllerWait).toMatchObject({ rounds: 1 });

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(launchClaims).toBe(0);
  expect(hostClaims).toBe(0);
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(pipeline.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "pending", launchId: null });

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(spawnCalls).toBe(3);
  expect(launchClaims).toBe(1);
  expect(hostClaims).toBe(1);
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(pipeline).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  expect(pipeline.runs[0]!.attempts[0]).toMatchObject({
    n: 1,
    state: "running",
    launchId: "launch-1",
    conversationId: "conversation_stage_1",
  });
  expect(scheduled).toEqual([1_000, 2_000]);
});

test("a busy account mutation rides out a deploy-length outage and parks naming the class and the count (#1750)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const startedAt = Date.parse(h.ports.now());
  let spawnCalls = 0;
  let stillRunningAfterTheDeploy = false;
  const scheduled: number[] = [];
  h.ports.spawnAgent = async () => {
    spawnCalls += 1;
    advance(50_000);
    throw new Error("account mutation is busy; retry shortly");
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  for (let round = 0; round < 40 && loadPipelines()[0]!.state === "running"; round += 1) {
    const scheduledBefore = scheduled.length;
    await tickPipelines([], h.ports);
    if (loadPipelines()[0]!.state !== "running") break;
    expect(scheduled.length).toBe(scheduledBefore + 1);
    if (Date.parse(h.ports.now()) - startedAt >= DEPLOY_WINDOW_MS) stillRunningAfterTheDeploy = true;
    advance(scheduled.at(-1)!);
  }

  const parked = loadPipelines()[0]!;
  const attempt = parked.runs[0]!.attempts[0]!;
  /* The lane was still retrying when the deploy window had passed. */
  expect(stillRunningAfterTheDeploy).toBe(true);
  expect(Date.parse(h.ports.now()) - startedAt).toBeGreaterThan(DEPLOY_WINDOW_MS);
  expect(attempt.controllerWait).toMatchObject({ budgetMs: 600_000, retryMaxMs: 60_000 });
  expect(Math.max(...scheduled)).toBe(60_000);
  expect(spawnCalls).toBe(attempt.controllerWait!.rounds + 1);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: `stage spawn failed after ${spawnCalls - 1} retries over 600s: spawn admission budget exhausted; last observed failure: account mutation is busy`,
    cursor: { stageId: "plan", state: "spawning" },
  });
  expect(parked.runs[0]!.attempts).toHaveLength(1);
  expect(attempt).toMatchObject({ n: 1, state: "needs_decision", launchId: null, conversationId: null });
  expect(attempt.error).toBe(parked.stateDetail);
  expect(attempt.spawnAdmissionBudget?.spent.writer).toBe(600_000);
});

test("mixed controller waits publish only the current busy retry time", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    if (spawnCalls === 1) throw new AccountMutationBusyError("account mutation is busy in this process; retry shortly");
    if (spawnCalls === 2) throw new Error("structured delivery controller is unavailable");
    if (spawnCalls === 3) throw new Error("account mutation is busy; retry shortly");
    return baseSpawn(input, onReserved);
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);
  let pipeline = loadPipelines()[0]!;
  const firstRetryAfter = pipeline.runs[0]!.attempts[0]!.controllerWait!.retryAfter;
  expect(pipeline.stateDetail).toContain(firstRetryAfter);

  Object.assign(h.ports, { structuredDeliveryPublication: () => "rebinding" as const });
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  const rebindingRetryAfter = pipeline.runs[0]!.attempts[0]!.controllerWait!.retryAfter;
  expect(rebindingRetryAfter).not.toBe(firstRetryAfter);
  expect(pipeline.stateDetail).toBe(`stage spawn deferred: waiting for the delivery controller (rebinding); retry at ${rebindingRetryAfter}`);
  expect(pipeline.stateDetail).not.toContain(firstRetryAfter);
  expect(spawnCalls).toBe(1);

  Object.assign(h.ports, { structuredDeliveryPublication: () => "ready" as const });
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  const controllerRetryAfter = pipeline.runs[0]!.attempts[0]!.controllerWait!.retryAfter;
  expect(controllerRetryAfter).not.toBe(rebindingRetryAfter);
  expect(pipeline.stateDetail).toBeNull();

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  const latestRetryAfter = pipeline.runs[0]!.attempts[0]!.controllerWait!.retryAfter;
  expect(latestRetryAfter).not.toBe(controllerRetryAfter);
  expect(pipeline.stateDetail).toBe(`stage spawn deferred: account mutation is busy; retry at ${latestRetryAfter}`);
  expect(spawnCalls).toBe(3);
});

test("a due busy wait survives a restarted controller race with one fresh host claim", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  h.ports.spawnAgent = async () => {
    throw new AccountMutationBusyError("account mutation is busy in this process; retry shortly");
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);
  const pending = loadPipelines()[0]!;
  const retryAfter = pending.runs[0]!.attempts[0]!.controllerWait?.retryAfter;
  if (!retryAfter) throw new Error("busy contention did not persist a retry time");
  advance(Date.parse(retryAfter) - Date.parse(h.ports.now()) + 1);

  const state = process.env.LLV_STATE_DIR!;
  const enginePath = path.join(import.meta.dir, "engine.ts");
  const claimsPath = path.join(state, "busy-race-claims.jsonl");
  const startedPath = path.join(state, "busy-race-second-started");
  const releasePath = path.join(state, "busy-race-release");
  const childScript = (marksSecond: boolean) => `
    process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
    const fs = await import("node:fs");
    const { defaultPipelinePorts, tickPipelines } = await import(${JSON.stringify(enginePath)});
    const { registerPipelineTick } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerSignal.ts"))});
    registerPipelineTick(async () => {});
    const ports = defaultPipelinePorts();
    ports.now = () => ${JSON.stringify(h.ports.now())};
    // This child models admission and a fake spawn, just like the parent harness.
    ports.worktreePresent = () => true;
    ports.engineReadiness = () => "connected";
    ports.structuredDeliveryPublication = () => "ready";
    // bun -e is not recognized as a test by the machine scheduler. Keep this
    // account-contention fixture out of the shared CPU admission queue.
    ports.cpuPressureHold = () => null;
    ports.cpuAdmissionReconcile = () => {};
    ports.cpuAdmissionSuspend = () => {};
    ports.conversationAgentActive = async () => true;
    ports.spawnAgent = async (input, onReserved) => {
      fs.appendFileSync(${JSON.stringify(claimsPath)}, JSON.stringify({ pid: process.pid, clientAttemptId: input.clientAttemptId }) + "\\n");
      onReserved({ launchId: "race-launch-" + process.pid, conversationId: "race-conversation-" + process.pid, accountId: "race-account" });
      while (!fs.existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(5);
      return { launchId: "race-launch-" + process.pid, conversationId: "race-conversation-" + process.pid, sessionId: "race-session-" + process.pid, transcript: null, paneId: null, accountId: "race-account" };
    };
    ${marksSecond ? `fs.writeFileSync(${JSON.stringify(startedPath)}, "started");` : ""}
    await tickPipelines([], ports);
  `;
  const childEnv = { ...process.env, LLV_STATE_DIR: state };
  let first: ReturnType<typeof Bun.spawn> | null = null;
  let second: ReturnType<typeof Bun.spawn> | null = null;
  const waitFor = async (filename: string): Promise<void> => {
    const deadline = performance.now() + 10_000;
    while (!fs.existsSync(filename)) {
      if (performance.now() >= deadline) {
        const childError = first?.exitCode !== null && first?.stderr ? await new Response(first.stderr as ReadableStream<Uint8Array>).text() : "";
        throw new Error(`timed out waiting for ${path.basename(filename)}: ${childError || JSON.stringify(loadPipelines().map((pipeline) => ({ state: pipeline.state, detail: pipeline.stateDetail })))}`);
      }
      await Bun.sleep(5);
    }
  };
  try {
    first = Bun.spawn({ cmd: [process.execPath, "-e", childScript(false)], env: childEnv, stdout: "ignore", stderr: "pipe" });
    await waitFor(claimsPath);
    second = Bun.spawn({ cmd: [process.execPath, "-e", childScript(true)], env: childEnv, stdout: "ignore", stderr: "pipe" });
    await waitFor(startedPath);
    fs.writeFileSync(releasePath, "release");
    const [firstExit, secondExit, firstError, secondError] = await Promise.all([
      first.exited,
      second.exited,
      new Response(first.stderr as ReadableStream<Uint8Array>).text(),
      new Response(second.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    assertStateChildSuccess(firstExit, firstError);
    assertStateChildSuccess(secondExit, secondError);
  } finally {
    fs.writeFileSync(releasePath, "release");
    for (const child of [first, second]) {
      if (!child) continue;
      const finished = await Promise.race([child.exited.then(() => true), Bun.sleep(100).then(() => false)]);
      if (!finished) { child.kill(); await child.exited; }
    }
  }

  expect(scheduled).toEqual([1_000]);
  expect(fs.readFileSync(claimsPath, "utf8").trim().split("\n")).toHaveLength(1);
  const raced = loadPipelines()[0]!;
  expect(raced).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  expect(raced.runs[0]!.attempts).toHaveLength(1);
  expect(raced.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: expect.stringMatching(/^race-launch-/), conversationId: expect.stringMatching(/^race-conversation-/) });
});

test("a busy-looking failure after reservation stays in unknown receipt recovery", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let spawnCalls = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    spawnCalls += 1;
    onReserved({ launchId: "launch-unknown-busy", conversationId: "conversation-unknown-busy" });
    throw new AccountMutationBusyError("account mutation is busy in this process; retry shortly");
  };

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(1);
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: ACCOUNT_STORE_BUSY_MESSAGE });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    launchId: "launch-unknown-busy",
    conversationId: "conversation-unknown-busy",
  });
  expect(parked.runs[0]!.attempts[0]!.controllerWait).toBeUndefined();
});

test("stage activation rides out a controller that is unavailable for a few seconds (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  const scheduled: number[] = [];
  const slept: number[] = [];
  const attemptIds: string[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    attemptIds.push(input.clientAttemptId);
    if (spawnCalls <= 3) throw new Error("structured delivery controller is unavailable");
    return baseSpawn(input, onReserved);
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: async (milliseconds: number) => { slept.push(milliseconds); },
  });

  /* Each tick makes exactly one attempt and hands the wait to a scheduled
     tick; nothing sleeps inside the pipelines phase. */
  for (let round = 0; round < 4; round += 1) {
    await tickPipelines([], h.ports);
    if (round === 3) break;
    const waiting = loadPipelines()[0]!;
    expect(waiting.state).toBe("running");
    expect(waiting.stateDetail).toBeNull();
    expect(waiting.cursor).toMatchObject({ stageId: "plan", state: "pending" });
    expect(waiting.runs[0]!.attempts.at(-1)!.state).toBe("pending");
    advance(scheduled.at(-1)!);
  }

  expect(spawnCalls).toBe(4);
  expect(scheduled).toEqual([1_000, 2_000, 4_000]);
  expect(slept).toEqual([]);
  /* Each retry keeps a launch identity of its own even though the wait now
     spans ticks, so no attempt collides with the receipt of the one before. */
  expect(new Set(attemptIds).size).toBe(4);
  expect(attemptIds.slice(1).map((id) => id.split("_pipeline_")[0])).toEqual([
    "handshake_retry_1",
    "handshake_retry_2",
    "handshake_retry_3",
  ]);
  const running = loadPipelines()[0]!;
  expect(running).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  /* The wait record is spent, so a later stall starts its own budget. */
  expect(running.runs[0]!.attempts.at(-1)!.controllerWait).toBeUndefined();
});

test("a stage waiting on the controller does not spin the pipelines phase (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  frozenWallClock(h);
  h.ports.spawnAgent = async () => { throw new Error("structured delivery controller is unavailable"); };
  Object.assign(h.ports, { scheduleTick: () => {}, sleep: forbiddenSleep });
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  try {
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.cursor).toMatchObject({ stageId: "plan", state: "pending" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    /* The pending cursor belongs to a wait that is not due; re-ticking it at
       once would loop the controller through passes that can only defer it. */
    expect(ticks).toBe(0);
  } finally {
    unregister();
  }
});

test.each([[400, 60], [60, 400]])("default scheduleTick preserves both deadlines: %s then %s", async (first, second) => {
  const schedule = defaultPipelinePorts().scheduleTick!;
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  try {
    schedule(first);
    schedule(second);
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(ticks).toBe(2);
  } finally {
    unregister();
  }
});

test.each([[true], [false]])("another lane's earlier wake preserves the controller retry deadline (earlier first=%s)", async (earlierFirst) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const schedule = defaultPipelinePorts().scheduleTick!;
  const callbacks: ReturnType<typeof tickPipelines>[] = [];
  let ticks = 0;
  Object.assign(h.ports, {
    structuredDeliveryPublication: () => "rebinding" as const,
    scheduleTick: (delayMs: number) => schedule(delayMs / 10),
    sleep: forbiddenSleep,
  });
  const unregister = registerPipelineTick(async () => {
    ticks += 1;
    const work = tickPipelines([], h.ports);
    callbacks.push(work);
    await work;
    if (ticks === 1) {
      // The unrelated wake observes this lane before its booked retryAfter.
      // Publication and the fake wall clock become ready for the later wake.
      advance(1_000);
      h.ports.structuredDeliveryPublication = () => "ready";
    }
  });
  try {
    if (earlierFirst) schedule(20);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait?.rounds).toBe(1);
    if (!earlierFirst) schedule(20);
    await new Promise(resolve => setTimeout(resolve, 400));
    await Promise.all(callbacks);
    expect(h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.cursor?.state).toBe("running");
  } finally {
    unregister();
    await Promise.all(callbacks);
  }
});

test("a controller that is between publications is never spawned into (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  const scheduled: number[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    return baseSpawn(input, onReserved);
  };
  Object.assign(h.ports, {
    structuredDeliveryPublication: () => "rebinding" as const,
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);

  /* The spawn only fails at durable host publication, so an attempt issued
     against a rebinding controller burns a real engine launch first. */
  expect(spawnCalls).toBe(0);
  expect(scheduled).toEqual([1_000]);
  expect(loadPipelines()[0]!).toMatchObject({
    state: "running",
    stateDetail: expect.stringContaining("waiting for the delivery controller (rebinding)"),
    cursor: { stageId: "plan", state: "pending" },
  });

  /* Before the booked wait falls due nothing is retried. */
  await tickPipelines([], h.ports);
  expect(scheduled).toEqual([1_000]);

  advance(1_000);
  Object.assign(h.ports, { structuredDeliveryPublication: () => "ready" as const });
  await tickPipelines([], h.ports);

  expect(spawnCalls).toBe(1);
  /* A fresh attempt keeps its base id through the wait (#1678 review 3). */
  expect(h.calls.find((call) => call.startsWith("spawn:"))).not.toContain("handshake_retry_");
  expect(loadPipelines()[0]!).toMatchObject({
    state: "running",
    cursor: { stageId: "plan", state: "running" },
  });
});

test("a controller that never returns parks the stage with the wait it spent (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  let spawnCalls = 0;
  const scheduled: number[] = [];
  const slept: number[] = [];
  h.ports.spawnAgent = async () => {
    spawnCalls += 1;
    throw new Error("structured delivery controller is unavailable");
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: async (milliseconds: number) => { slept.push(milliseconds); },
  });

  for (let round = 0; round < 8 && loadPipelines()[0]!.state === "running"; round += 1) {
    await tickPipelines([], h.ports);
    if (scheduled.length > 0) advance(scheduled.at(-1)!);
  }

  const parked = loadPipelines()[0]!;
  /* The budget is wall-clock, so the schedule stops exactly on it. */
  expect(scheduled).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 7_000]);
  expect(scheduled.reduce((total, delay) => total + delay, 0)).toBe(30_000);
  // Exhaustion parks before a new spawn can be admitted at the cutoff.
  expect(spawnCalls).toBe(scheduled.length);
  /* Nothing was slept through inside the pipelines phase. */
  expect(slept).toEqual([]);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("structured delivery controller is unavailable");
  expect(parked.stateDetail).toContain("5 retries over 30s: spawn admission budget exhausted");
  expect(parked.runs[0]!.attempts[0]!.controllerWait).toMatchObject({ budgetMs: 30_000, retryMaxMs: 8_000 });
});

test("the controller wait counts the time a failing spawn attempt spent (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  let spawnCalls = 0;
  const scheduled: number[] = [];
  h.ports.spawnAgent = async () => {
    spawnCalls += 1;
    /* Durable host setup runs for 20s before it reaches host publication. */
    advance(20_000);
    throw new Error("structured delivery controller is unavailable");
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);

  /* Two attempts have burned 40s of wall clock between them, so the budget is
     spent even though the booked backoff only came to 1s. */
  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(2);
  expect(scheduled).toEqual([1_000]);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("1 retries over 41s");
});

test("a process without a delivery controller publication defers stage activation (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let spawnCalls = 0;
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    return baseSpawn(input, onReserved);
  };
  Object.assign(h.ports, { structuredDeliveryPublication: () => "unbound" as const });

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const deferred = loadPipelines()[0]!;
  expect(spawnCalls).toBe(0);
  expect(deferred.state).toBe("running");
  expect(deferred.stateDetail).toBe("stage spawn deferred: waiting for the delivery controller (unbound)");
  expect(deferred.cursor).toMatchObject({ stageId: "plan", state: "pending" });
  expect(deferred.runs[0]!.attempts).toHaveLength(1);
  expect(deferred.runs[0]!.attempts.at(-1)!.state).toBe("pending");

  /* The process that owns the publication activates the same attempt. */
  Object.assign(h.ports, { structuredDeliveryPublication: () => "ready" as const });
  await tickPipelines([], h.ports);

  expect(spawnCalls).toBe(1);
  expect(loadPipelines()[0]!).toMatchObject({
    state: "running",
    cursor: { stageId: "plan", state: "running" },
  });
});

test("a transient structured spawn handshake can recover on retry (#1056)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  const clientAttemptIds: string[] = [];
  Object.assign(h.ports, { sleep: async () => {} });
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    clientAttemptIds.push(input.clientAttemptId);
    if (spawnCalls < 3) throw new Error("runtime host request timed out");
    return baseSpawn(input, onReserved);
  };

  await tickPipelines([], h.ports);

  expect(spawnCalls).toBe(3);
  expect(new Set(clientAttemptIds).size).toBe(3);
  const current = loadPipelines()[0]!;
  expect(current).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
});

test("durable conversation identity never adopts a competing cwd session", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: "running",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-known",
    conversationId: "conversation_known",
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt: h.ports.now(),
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.cursor = { stageId: "plan", state: "running", input: null, activatedBy: null };
  savePipelines([pipeline]);

  await tickPipelines([h.finish("/codex/competing.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.agentPath).toBeNull();
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("plan");
});

test("a stage with an unwritten transcript parks on its first-message drain failure", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, onReserved) => {
    onReserved({ launchId: "launch-drain-timeout", conversationId: "conversation_drain_timeout" });
    return {
      launchId: "launch-drain-timeout",
      conversationId: "conversation_drain_timeout",
      sessionId: "session-drain-timeout",
      "transcript": "/codex/unwritten-stage.jsonl",
      paneId: null,
    };
  };
  await tickPipelines([], h.ports);
  h.setConversationActive(false);
  const reason = "first message never drained: runtime host request timed out";
  h.ports.spawnReceipt = () => ({
    state: "failed",
    launchId: "launch-drain-timeout",
    conversationId: "conversation_drain_timeout",
    sessionId: "session-drain-timeout",
    "transcript": "/codex/unwritten-stage.jsonl",
    paneId: null,
    error: reason,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: reason });
  expect(parked.runs[0]!.attempts[0]!.error).toBe(reason);
});

test("a runtime-host outage does not hide a terminal spawn receipt's drain cause (#1314, #1326)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, onReserved) => {
    onReserved({ launchId: "launch-drain-outage", conversationId: "conversation_drain_outage" });
    return {
      launchId: "launch-drain-outage",
      conversationId: "conversation_drain_outage",
      sessionId: "session-drain-outage",
      "transcript": "/codex/unwritten-outage-stage.jsonl",
      paneId: null,
    };
  };
  await tickPipelines([], h.ports);
  /* The runtime host is unreachable: liveness answers null, not false. */
  h.setConversationActive(null);
  const reason = "first message never drained: runtime host request timed out";
  h.ports.spawnReceipt = () => ({
    state: "failed",
    launchId: "launch-drain-outage",
    conversationId: "conversation_drain_outage",
    sessionId: "session-drain-outage",
    "transcript": "/codex/unwritten-outage-stage.jsonl",
    paneId: null,
    error: reason,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: reason });
  expect(parked.runs[0]!.attempts[0]!.error).toBe(reason);
});

test("a terminal spawn receipt parks while runtime liveness still reports active (#1326)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, onReserved) => {
    onReserved({ launchId: "launch-drain-stale-live", conversationId: "conversation_drain_stale_live" });
    return {
      launchId: "launch-drain-stale-live",
      conversationId: "conversation_drain_stale_live",
      sessionId: "session-drain-stale-live",
      "transcript": "/codex/unwritten-stale-live-stage.jsonl",
      paneId: null,
    };
  };
  await tickPipelines([], h.ports);
  h.setConversationActive(true);
  const reason = "first message never drained: runtime host request timed out";
  h.ports.spawnReceipt = () => ({
    state: "failed",
    launchId: "launch-drain-stale-live",
    conversationId: "conversation_drain_stale_live",
    sessionId: "session-drain-stale-live",
    "transcript": "/codex/unwritten-stale-live-stage.jsonl",
    paneId: null,
    error: reason,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: reason });
  expect(parked.runs[0]!.attempts[0]!.error).toBe(reason);
});

test("an unregistered stage with only its launch record relaunches and the lane closes (#1325)", async () => {
  const h = harness();
  const pipeline = await runningStructuredStage(h);
  h.setConversationActive(null);
  h.ports.conversationRegistered = () => false;
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "busy",
    message: null,
    launchOnly: true,
  });

  for (let check = 0; check < 3; check += 1) {
    if (check > 0) h.advanceWallClock(30_000);
    await tickPipelines([], h.ports);
  }

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({
    state: "running",
    stateDetail: expect.stringContaining("relaunching after stage host died without output"),
  });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    completedAt: expect.any(String),
    error: "stage host died without output",
  });

  h.setHostsResident(false);
  h.setStageHost("conversation_stage_1", {
    outcome: "failed",
    error: "structured runtime host is unavailable",
  });
  const closed = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stillRunning).toEqual([]);
  expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  expect(closed.close?.notes).toMatchObject([{
    stageId: "plan",
    attempt: 1,
    detail: expect.stringContaining("the stage host died before its session registered"),
  }]);
  expect(loadPipelines()[0]!.state).toBe("closed");
});

test("an unregistered launch-only stage with a resident host still remains visible after close (#1325)", async () => {
  const h = harness();
  const pipeline = await runningStructuredStage(h);
  h.ports.conversationRegistered = () => false;
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "busy",
    message: null,
    launchOnly: true,
  });
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", {
    outcome: "failed",
    error: "structured runtime host is unavailable",
  });

  const refused = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);

  expect(refused.error).toBeUndefined();
  expect(refused.close?.stillRunning).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", hiddenAt: null });
});

test("an unregistered stage with agent transcript progress keeps running (#1325)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(null);
  h.ports.conversationRegistered = () => false;
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "busy",
    message: { text: "working through the stage", ts: 5_000_000 },
    launchOnly: false,
  });

  for (let check = 0; check < 4; check += 1) {
    if (check > 0) h.advanceWallClock(30_000);
    await tickPipelines([], h.ports);
  }

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null });
  expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
});

test("an unregistered launch-only stage stays running with affirmative runtime activity (#1325)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  h.ports.conversationRegistered = () => false;
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "unknown",
    message: null,
    launchOnly: true,
  });

  for (let check = 0; check < 4; check += 1) {
    if (check > 0) h.advanceWallClock(30_000);
    await tickPipelines([], h.ports);
  }

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null });
  expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
});

test("a worker that dies after transcript discovery enters bounded verdict recovery", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(false);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRecovery).toMatchObject({ state: "pending", checks: 1 });
  await exhaustVerdictRecovery(h);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("canonical stage transcript is not yet readable");
});

test("an unindexed rollout stays running while its structured host is alive and idle (#1109)", async () => {
  await withRuntimeSnapshot({
    sessions: [{
      conversationId: "conversation_stage_1",
      host: "hosted",
      turn: "idle",
      attentionIds: [],
    }],
  }, async () => {
    const h = harness();
    await runningStructuredStage(h);
    h.ports.conversationAgentActive = defaultPipelinePorts().conversationAgentActive;

    for (let tick = 0; tick < 4; tick += 1) {
      if (tick > 0) h.advanceWallClock(30_000);
      await tickPipelines([], h.ports);
    }

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]).toMatchObject({
      state: "running",
      verdict: null,
    });
    expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
  });
});

test("a dead runtime snapshot cannot poison later hosted idle evidence in the same tick (#1109)", async () => {
  let snapshotReads = 0;
  await withRuntimeSnapshot((requestNumber) => {
    snapshotReads += 1;
    return {
      sessions: [{
        conversationId: "conversation_stage_1",
        host: requestNumber === 0 ? "dead" : "hosted",
        turn: "idle",
        attentionIds: [],
      }],
    };
  }, async () => {
    const h = harness();
    await runningStructuredStage(h);
    const runtimePorts = defaultPipelinePorts();
    let primedDeadProjection = false;
    h.ports.conversationAgentActive = async (conversationId) => {
      if (!primedDeadProjection) {
        primedDeadProjection = true;
        expect(await runtimePorts.conversationAgentActive(conversationId)).toBe(false);
      }
      return runtimePorts.conversationAgentActive(conversationId);
    };

    await tickPipelines([], h.ports);

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
    expect(snapshotReads).toBe(2);
  });
});

test("a phase-budget overrun cannot spend an unindexed transcript recovery check (#1109)", async () => {
  for (const overrun of ["before-read", "during-read"] as const) {
    const h = harness();
    await runningStructuredStage(h);
    let monotonicMs = 0;
    let durableReads = 0;
    h.setMonotonicClock(() => monotonicMs);
    h.ports.conversationAgentActive = async () => {
      if (overrun === "before-read") monotonicMs = 15_000;
      return false;
    };
    h.ports.durableTurnEvidence = async () => {
      durableReads += 1;
      if (overrun === "during-read") monotonicMs = 15_000;
      return null;
    };

    await tickPipelines([], h.ports);

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
    expect(durableReads).toBe(overrun === "before-read" ? 0 : 1);
  }
});

test("an unindexed rollout parks once its structured host is dead past grace (#1109)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  const unavailableSince = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => unavailableSince;
  h.advanceWallClock(5 * 60_000);

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current).toMatchObject({
    state: "needs_decision",
    stateDetail: "historical attempt completed without a valid final JSON verdict",
  });
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: null,
    error: "historical attempt completed without a valid final JSON verdict",
  });
});

test("a stage whose host is proven dead becomes retryable without closing the pipeline (#1282)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  const unavailableSince = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => unavailableSince;
  h.advanceWallClock(5 * 60_000);

  await tickPipelines([], h.ports);

  /* Before #1282 the stage stayed `running` while its host sat there doing
     nothing, so retry-stage answered "pipeline does not have a stage awaiting
     retry" and the only way out was closing the pipeline.

     What this case pins is the engine's own behaviour once a host is proven
     dead: the liveness port is stubbed here, so it says nothing about whether
     that port ever reports the incident's host. The whole sequence — a live but
     severed child, the runtime kill, the registry retirement, this tick and
     `retry-stage` — runs through the production seams in
     `src/lib/pipelines/severedStageRetry.test.ts`. */
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  const failedAttempt = parked.runs[0]!.attempts[0]!;
  h.ports.spawnReceipt = (candidate) => candidate === failedAttempt.launchId ? {
    state: "completed",
    launchId: failedAttempt.launchId!,
    conversationId: failedAttempt.conversationId!,
    sessionId: failedAttempt.sessionId,
    "transcript": failedAttempt.agentPath,
    paneId: failedAttempt.paneId,
  } : null;
  const retried = await patchPipeline(parked.id, { action: "retry-stage" }, h.ports);

  expect(retried.error).toBeUndefined();
  expect(retried.pipeline?.state).not.toBe("closed");
  expect(loadPipelines()[0]!.state).not.toBe("needs_decision");
});

test("a stage stays non-retryable while automatic host retirement is unconfirmed (#1296)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  const unavailableSince = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => unavailableSince;
  h.ports.stopStageAgent = async () => ({
    outcome: "unconfirmed",
    operationId: "fixture-kill",
    detail: "fixture termination remains in flight",
  });
  h.advanceWallClock(5 * 60_000);

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current).toMatchObject({
    state: "running",
    stateDetail: "automatic recovery is waiting for the unavailable stage host to terminate",
  });
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null });
  const retry = await patchPipeline(current.id, { action: "retry-stage" }, h.ports);
  expect(retry).toMatchObject({ error: "pipeline does not have a stage awaiting retry", status: 409 });
});

test("an exhausted false park ingests its live host's late verdict without a duplicate attempt (#1109)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  const stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  const parkedAt = h.ports.now();
  attempt.state = "needs_decision";
  attempt.completedAt = parkedAt;
  attempt.error = "stage verdict recovery exhausted after 3 checks: canonical stage transcript is not yet readable after structured stage termination";
  attempt.verdictRecovery = {
    state: "exhausted",
    checks: 3,
    maxChecks: 3,
    startedAt: parkedAt,
    lastCheckedAt: parkedAt,
    nextCheckAt: null,
    reason: "canonical stage transcript is not yet readable after structured stage termination",
    messageTs: null,
  };
  stored.state = "needs_decision";
  stored.stateDetail = attempt.error;
  savePipelines([stored]);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
  // Settlement releases the lease before the next scheduled activation.
  await tickPipelines([], h.ports);

  const recovered = loadPipelines()[0]!;
  expect(recovered.cursor).toEqual({
    stageId: "build",
    state: "running",
    input: "integration complete",
    activatedBy: { stageId: "plan", attempt: 1, edge: "pass" },
  });
  expect(recovered.runs[0]!.attempts).toHaveLength(1);
  expect(recovered.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", confidence: 0.9 },
    verdictRecovery: { state: "recovered", checks: 3, messageTs: 5_000_000 },
  });
  expect(recovered.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
});

test("a dead structured host past grace fails through the stage fail edge (#973)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  const unavailableSince = h.ports.now();
  Object.assign(h.ports, {
    conversationHostUnavailableSince: async () => unavailableSince,
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: null,
    error: "historical attempt completed without a valid final JSON verdict",
  });
  expect(current.cursor).toEqual({
    stageId: "recover",
    state: "pending",
    input: "historical attempt completed without a valid final JSON verdict",
    activatedBy: { stageId: "build", attempt: 1, edge: "fail" },
  });
});

test("a stage turn a deploy cut stays open past the host grace while its continuation is owed (#1835)", async () => {
  const h = harness();
  const cut = deployCutObligations(h, "owed-cut");
  try {
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const cutAt = h.ports.now();
    h.ports.conversationHostUnavailableSince = async () => cutAt;
    const obligation = cut.record("conversation_stage_1", cutAt);
    /* The incident's order: the controller looks at 11:20, four minutes after
       the 11:16 cut, while the successor has not yet delivered anything. */
    h.advanceWallClock(4 * 60_000);

    await tickPipelines([], h.ports);

    const held = loadPipelines()[0]!;
    expect(held).toMatchObject({ state: "running", stateDetail: DEPLOY_CUT_HOLD });
    expect(held.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null, error: null });
    expect(held.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
    expect(h.calls.some((call) => call.startsWith("stop-host:"))).toBe(false);

    /* The successor delivered the continuation: the host is judged from that
       moment, so a minute later it is still inside its grace. */
    cut.store.update(obligation.id, { state: "delivered", resolvedAt: h.ports.now(), resolution: "delivered" });
    h.advanceWallClock(60_000);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    expect(loadPipelines()[0]!.stateDetail).not.toBe(DEPLOY_CUT_HOLD);

    /* A host that stays gone after its continuation is judged as before. */
    h.advanceWallClock(5 * 60_000);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: HISTORICAL_VERDICT_MISS });
  } finally {
    cut.restore();
  }
});

test("a stage turn an orderly release cut is held until the successor hands it to the controller, then retried once", async () => {
  const h = harness();
  const cut = deployCutObligations(h, "released-stage");
  try {
    await runningStructuredStage(h);
    h.ports.conversationRestartCut = (conversationId) => defaultPipelinePorts().conversationRestartCut!(conversationId);
    h.setConversationActive(false);
    const cutAt = h.ports.now();
    const lastWork = Date.parse(cutAt) - 1_000;
    h.ports.conversationHostUnavailableSince = async () => cutAt;
    h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: { text: "Running the suite.", ts: lastWork },
      lastRecordAt: lastWork, lastAgentEventAt: lastWork });
    const obligation = cut.record("conversation_stage_1", cutAt);
    h.advanceWallClock(60_000);

    /* The release recorded the cut and the successor has not booted. */
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: DEPLOY_CUT_HOLD });
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);

    /* The successor's startup gives the cut to the stage's controller. */
    cut.store.update(obligation.id, { state: "discharged", resolvedAt: h.ports.now(), resolution: "a pipeline stage: its controller retries the attempt" });
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);

    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts).toHaveLength(2);
    expect(lane.runs[0]!.attempts[0]!.error).toBe("interrupted by a Delegatus restart; replaced by a fresh stage attempt");
    expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "restart", lastReport: "Running the suite." });
  } finally {
    /* The store is shared by this file's cases; the next one records the same
       conversation and must not read this cut as its newest. */
    for (const obligation of cut.store.list()) {
      if (obligation.hostKey === "codex:released-stage") {
        fs.rmSync(path.join(interruptionObligationDirectory(cut.registry.filename), `${obligation.id}.json`), { force: true });
      }
    }
    cut.restore();
  }
});

test("a continuation that arrived while its obligation still reads submitted starts the host grace from its arrival (#1835 review)", async () => {
  const h = harness();
  const cut = deployCutObligations(h, "submitted-cut");
  try {
    /* The registry stamps an arrival with the real time, so the stage runs
       on a harness clock three minutes behind it: the cut is recorded at the
       harness's now and the continuation arrives about three minutes later. */
    h.advanceWallClock(Date.now() - 3 * 60_000 - Date.parse(h.ports.now()));
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const cutAt = h.ports.now();
    h.ports.conversationHostUnavailableSince = async () => cutAt;
    const obligation = cut.record("conversation_stage_1", cutAt);

    /* The successor's startup admits the continuation under the obligation's
       id and records `submitted`, which is all the queue told it; the delivery
       arrives in the registry and the obligation is left as it was. */
    const registry = cut.registry;
    const reservation = registry.holdDelivery(obligation.conversationId, "A Viewer deployment interrupted your turn", obligation.id);
    cut.store.update(obligation.id, { state: "submitted", operationId: reservation.command.operationId, attempts: 1 });
    const arrived = registry.recordDeliveryOutcome(reservation.id, "delivered");
    const arrivedAt = Date.parse(arrived.deliveredAt!);
    expect(cut.store.list()[0]).toMatchObject({ state: "submitted", resolvedAt: null });

    /* A minute after the arrival the host is inside its grace, and the stage
       no longer says it waits for a continuation. */
    h.advanceWallClock(arrivedAt + 60_000 - Date.parse(h.ports.now()));
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
    expect(loadPipelines()[0]!.stateDetail).not.toBe(DEPLOY_CUT_HOLD);

    /* The resumed host is lost again: it is judged once its grace from the
       arrival has passed, by whichever of the ordinary verdicts its paced
       recovery checks reach first, well before the thirty-minute hold ends. */
    for (let tick = 0; tick < 4 && loadPipelines()[0]!.runs[0]!.attempts[0]!.state === "running"; tick += 1) {
      h.advanceWallClock(tick === 0 ? 3 * 60_000 : 30_000);
      await tickPipelines([], h.ports);
    }
    const judged = loadPipelines()[0]!;
    expect(["failed", "needs_decision"]).toContain(judged.runs[0]!.attempts[0]!.state);
    expect(judged.stateDetail).not.toBe(DEPLOY_CUT_HOLD);
    expect(Date.parse(h.ports.now()) - arrivedAt).toBeLessThanOrEqual(5 * 60_000);
  } finally {
    cut.restore();
  }
});

test("a re-hosted stage whose deploy cut is still owed gets no verdict request ahead of its continuation (#1835 review)", async () => {
  const h = harness();
  const cut = deployCutObligations(h, "rehosted-cut");
  try {
    await runningStructuredStage(h);
    /* The successor adopted the host: it reports hosted and idle, and the
       durable turn ends in the no-response record written after the cut. */
    h.setConversationActive(false);
    h.ports.conversationHostUnavailableSince = async () => null;
    const asked: string[] = [];
    h.ports.resumeSeveredTurn = async (input) => {
      asked.push(input.clientMessageId);
      return true;
    };
    const cutAt = h.ports.now();
    cut.record("conversation_stage_1", cutAt);
    h.advanceWallClock(60_000);
    h.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "terminal",
      message: { text: "turn aborted", ts: Date.parse(h.ports.now()) },
    });
    h.advanceWallClock(60_000);

    await tickPipelines([], h.ports);

    const held = loadPipelines()[0]!;
    expect(asked).toEqual([]);
    expect(held).toMatchObject({ state: "running", stateDetail: DEPLOY_CUT_HOLD });
    expect(held.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null, error: null });
    expect(held.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
    expect(held.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
  } finally {
    cut.restore();
  }
});

test("a held deploy cut still settles on the stage's own verdict, and an owed cut stops holding past its bound (#1835)", async () => {
  const h = harness();
  const cut = deployCutObligations(h, "bounded-cut");
  try {
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const cutAt = h.ports.now();
    h.ports.conversationHostUnavailableSince = async () => cutAt;
    cut.record("conversation_stage_1", cutAt);
    h.advanceWallClock(31 * 60_000);

    await tickPipelines([], h.ports);

    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: HISTORICAL_VERDICT_MISS });
  } finally {
    cut.restore();
  }

  const reported = harness();
  const reportedCut = deployCutObligations(reported, "reported-cut");
  try {
    await runningStructuredStage(reported);
    reported.setConversationActive(false);
    const cutAt = reported.ports.now();
    reported.ports.conversationHostUnavailableSince = async () => cutAt;
    reportedCut.record("conversation_stage_1", cutAt);
    reported.advanceWallClock(4 * 60_000);
    reported.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "terminal",
      message: { text: PASS_TEXT, ts: Date.parse(reported.ports.now()) },
    });

    await tickPipelines([], reported.ports);

    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "passed", verdict: { status: "pass" } });
  } finally {
    reportedCut.restore();
  }
});

test("a read-only stage whose host was lost re-runs on the same head instead of firing its fail edge (#1835)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "review", kind: "run", role: { roleId: "reviewer" }, engine: "codex", access: "read-only", prompt: "Review {{task}}", next: null, onFail: { to: "fix", maxRounds: 1 } },
    { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const loseHost = async () => {
    structuredLatest(0);
    h.setConversationActive(false);
    const lostAt = h.ports.now();
    h.ports.conversationHostUnavailableSince = async () => lostAt;
    h.advanceWallClock(5 * 60_000);
    await tickPipelines([], h.ports);
  };

  await loseHost();

  const rerun = loadPipelines()[0]!;
  expect(rerun.state).toBe("running");
  expect(rerun.cursor).toMatchObject({ stageId: "review", state: "pending" });
  const rerunError = `${READ_ONLY_RERUN}; exit: status unavailable; no Delegatus stop recorded`;
  expect(rerun.runs[0]!.attempts[0]).toMatchObject({ state: "failed", verdict: null, error: rerunError });
  expect(rerun.stateDetail).toBe(rerunError);
  expect(rerun.runs[1]!.attempts).toHaveLength(0);

  await tickPipelines([], h.ports);
  const second = loadPipelines()[0]!;
  expect(second.runs[0]!.attempts).toHaveLength(2);
  expect(second.runs[0]!.attempts[1]).toMatchObject({ n: 2, state: "running", input: second.runs[0]!.attempts[0]!.input });
  expect(second.runs[1]!.attempts).toHaveLength(0);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);

  /* Bounded: a host that keeps dying is not a deploy. After two re-runs the
     ordinary routing applies again. */
  await loseHost();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(3);
  await loseHost();
  const routed = loadPipelines()[0]!;
  expect(routed.runs[0]!.attempts[2]).toMatchObject({ state: "failed", error: HISTORICAL_VERDICT_MISS });
  expect(routed.cursor).toMatchObject({ stageId: "fix", activatedBy: { stageId: "review", attempt: 3, edge: "fail" } });
});

test("skip-stage over a lost host's pushed head carries it without resetting (#1871)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  const lostAt = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => lostAt;
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  const base = parked.lastPassedCommit;
  expect(base).not.toBe(STAGE_HEAD);

  const skipped = await patchPipeline(parked.id, { action: "skip-stage" }, h.ports);

  expect(skipped.error).toBeUndefined();
  expect(loadPipelines()[0]!.lastPassedCommit).toBe(STAGE_HEAD);
  expect(h.calls).not.toContain(`git reset --hard ${base}`);
  expect(h.calls).not.toContain(`git reset --hard ${STAGE_HEAD}`);
});

test("a review cut by a restart retries from the completed launch the card names (#1871)", async () => {
  const h = harness();
  const { pipeline, launchId } = await reviewParkedAfterRestart(h);

  const retried = await patchPipeline(pipeline.id, { action: "retry-stage", stageId: "review", launchId }, h.ports);

  expect(retried.error).toBeUndefined();
  expect(loadPipelines()[0]).toMatchObject({ state: "running", cursor: { stageId: "review", state: "pending" } });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
});

test("a dead structured host with an invalid terminal verdict still takes the fail edge (#973)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "Finished without a structured verdict", ts: 5_000_000 },
  });
  const unavailableSince = h.ports.now();
  Object.assign(h.ports, {
    conversationHostUnavailableSince: async () => unavailableSince,
  });

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: null,
    error: "historical attempt completed without a valid final JSON verdict",
  });
  expect(current.cursor).toEqual({
    stageId: "recover",
    state: "pending",
    input: "historical attempt completed without a valid final JSON verdict",
    activatedBy: { stageId: "build", attempt: 1, edge: "fail" },
  });
});

test("a dead structured host with a contradictory verdict still takes the fail edge (#973)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: "VERDICT: REQUEST_CHANGES\n\n```json\n{\"status\":\"pass\"}\n```",
      ts: 5_000_000,
    },
  });
  const unavailableSince = h.ports.now();
  Object.assign(h.ports, {
    conversationHostUnavailableSince: async () => unavailableSince,
  });

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: null,
    error: "historical attempt completed without a valid final JSON verdict",
  });
  expect(current.cursor).toEqual({
    stageId: "recover",
    state: "pending",
    input: "historical attempt completed without a valid final JSON verdict",
    activatedBy: { stageId: "build", attempt: 1, edge: "fail" },
  });
});

test("a dead structured host past grace still accepts a valid terminal verdict (#973)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: "Completed\n\n```json\n{\"status\":\"pass\"}\n```",
      ts: 5_000_000,
    },
  });
  const unavailableSince = h.ports.now();
  Object.assign(h.ports, {
    conversationHostUnavailableSince: async () => unavailableSince,
  });

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    output: "Completed",
    verdict: { status: "pass" },
    error: null,
  });
  expect(current.cursor).toEqual({
    stageId: "build",
    state: "pending",
    input: "Completed",
    activatedBy: { stageId: "plan", attempt: 1, edge: "pass" },
  });
});

test("an inactive transcript with no verdict exhausts bounded recovery after its worker exits", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(false);
  const entries = [entry("/codex/stage-1.jsonl")];
  await tickPipelines(entries, h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  await exhaustVerdictRecovery(h, entries);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("completed assistant turn has not been ingested");
});

test("an ended structured stage overrides a stale live marker with bounded transcript recovery", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([pipeline]);
  h.setConversationActive(false);

  const entries: FileEntry[] = [{
    ...entry("/codex/stage-1.jsonl"),
    activity: "live",
    activityReason: "jsonl_turn_open",
  }];
  await tickPipelines(entries, h.ports);

  expect(loadPipelines()[0]!.state).toBe("running");
  await exhaustVerdictRecovery(h, entries);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("completed assistant turn has not been ingested");
});

test("a terminal parser miss receives three spaced evaluations before an auditable terminal state", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "Completion summary without a fenced verdict.", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  let current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: {
      state: "pending",
      checks: 1,
      maxChecks: 3,
      reason: "canonical completed assistant turn is missing a fenced JSON verdict",
    },
  });

  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: { state: "pending", checks: 1 },
  });

  h.advanceWallClock(30_000);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: { state: "pending", checks: 2 },
  });

  h.advanceWallClock(30_000);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toBe(
    "stage verdict recovery exhausted after 3 checks: canonical completed assistant turn is missing a fenced JSON verdict",
  );
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    verdictRecovery: { state: "exhausted", checks: 3 },
    error: current.stateDetail,
  });
  expect(h.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
});

test("a later completed turn in the same conversation supersedes the parser miss after restart (#515)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "The first completed turn was interrupted before its verdict.", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  let current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: { state: "pending", checks: 1, messageTs: 5_000_000 },
  });

  /* A fresh controller process would reconstruct exclusively from this store
     record and the conversation's latest durable transcript. */
  savePipelines(loadPipelines());
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_100_000 },
  });
  await tickPipelines([], h.ports);

  current = loadPipelines()[0]!;
  expect(current.cursor).toEqual({
    stageId: "build",
    state: "pending",
    input: "integration complete",
    activatedBy: { stageId: "plan", attempt: 1, edge: "pass" },
  });
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", confidence: 0.9 },
    verdictRecovery: { state: "recovered", checks: 1, messageTs: 5_100_000 },
  });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
});

test("newer same-conversation evidence supersedes an exhausted recovery exactly once (#515)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "No fenced verdict was produced.", ts: 5_000_000 },
  });
  await tickPipelines([], h.ports);
  await exhaustVerdictRecovery(h);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRecovery).toMatchObject({
    state: "exhausted",
    checks: 3,
    messageTs: 5_000_000,
  });

  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_100_000 },
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", confidence: 0.9 },
    verdictRecovery: { state: "recovered", checks: 3, messageTs: 5_100_000 },
  });
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
});

test("verdict recovery normalizes object findings and still rejects a missing core status (#879)", async () => {
  const accepted = harness();
  await runningStructuredStage(accepted);
  accepted.setConversationActive(false);
  accepted.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: [
        "The review found one defect.",
        "",
        "```json",
        JSON.stringify({
          status: "fail",
          findings: [{ severity: "medium", file: "src/lib/example.ts", line: 57, summary: "Preserve the accepted revision." }],
          confidence: 0.87,
        }),
        "```",
      ].join("\n"),
      ts: 5_000_000,
    },
  });

  await tickPipelines([], accepted.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: {
      status: "fail",
      findings: ["medium — src/lib/example.ts:57 — Preserve the accepted revision."],
      confidence: 0.87,
    },
  });

  const rejected = harness();
  await runningStructuredStage(rejected);
  rejected.setConversationActive(false);
  rejected.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: `\`\`\`json\n${JSON.stringify({ findings: [{ severity: "medium", summary: "Missing status." }], confidence: 0.87 })}\n\`\`\``,
      ts: 5_000_000,
    },
  });

  await tickPipelines([], rejected.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdict: null,
    verdictRecovery: {
      state: "pending",
      /* #1756: the reason names the block it was read from, so a park detail
         can be told apart from a reader that was looking at the wrong text. */
      reason: "canonical completed assistant turn is missing a valid status, findings, or confidence field, at the fenced block on line 1",
    },
  });
});

test("terminal ingestion after process exit advances a trailing-marker verdict once after restart (#707)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "Process exit became visible before terminal transcript ingestion.", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: { state: "pending", checks: 1 },
  });

  savePipelines(loadPipelines());
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: `${PASS_TEXT}\nREVIEW_READY: published branch`,
      ts: 5_100_000,
    },
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdictRecovery: { state: "recovered", checks: 1 },
  });
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
});

test("paused verdict recovery accepts canonical evidence after resume without resetting work", async () => {
  const h = harness();
  const pipeline = await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "No fenced verdict was produced.", ts: 5_000_000 },
  });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRecovery).toMatchObject({ state: "pending", checks: 1 });

  expect((await patchPipeline(pipeline.id, { action: "pause" }, h.ports)).pipeline?.state).toBe("paused");
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_100_000 },
  });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("paused");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict).toBeNull();

  expect((await patchPipeline(pipeline.id, { action: "resume" }, h.ports)).pipeline?.state).toBe("running");
  await tickPipelines([], h.ports);
  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdictRecovery: { state: "recovered", checks: 1, messageTs: 5_100_000 },
  });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(h.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
});

test("verdict recovery follows conversation generation rollover after transcript compaction", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "No fenced verdict was produced.", ts: 5_000_000 },
  });
  await tickPipelines([], h.ports);

  const compactedPath = "/codex/stage-1-compacted.jsonl";
  const stageConversation = loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId;
  h.ports.pathForConversation = (id) => id === stageConversation ? compactedPath : null;
  h.durableTurns.set(compactedPath, {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_100_000 },
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    agentPath: compactedPath,
    state: "passed",
    verdictRecovery: { state: "recovered", checks: 1 },
  });
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
});

test("a durable terminal pass verdict settles a stage despite a stale running runtime ledger (#337, pipeline 0ec6eab0)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* The runtime session ledger never observed the end of the turn. */
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.stateDetail).toBeNull();
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  /* The actual clean stage HEAD advances, not the pipeline base. */
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    output: "integration complete",
    verdict: { status: "pass", confidence: 0.9 },
  });
  expect(current.runs[0]!.attempts[0]!.completedAt).toBeTruthy();
});

test("scanner projection loss cannot park a durably completed stage (#337, pipelines fdbea289/4dd0e775)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* Host already terminal; the transcript vanished from the scan projection
     while still existing at its durable agentPath. */
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(current.runs[0]!.attempts[0]!.state).toBe("passed");
  /* No reset happened on the way through: the committed work survives. */
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);
});

test("projection loss over a readable mid-turn artifact keeps waiting instead of parking", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null });

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a mid-work message on a recovered idle host never terminalizes the attempt (#337 restart invariant)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* Recovered idle broker: the ledger reports not-running while the durable
     transcript still shows an open turn with a mid-work trailing message. */
  h.setConversationActive(false);
  h.messages.set("/codex/stage-1.jsonl", { text: "midway through applying the fix", ts: 5_000_000 });
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "busy",
    message: { text: "midway through applying the fix", ts: 5_000_000 },
  });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a durable busy turn blocks scanner-message settlement even for a parseable verdict (#337 seam)", async () => {
  for (const status of ["pass", "fail"] as const) {
    const h = harness();
    await runningStructuredStage(h);
    /* Recovered idle broker over a still-open turn whose trailing scanner
       message happens to be a syntactically valid fenced verdict. */
    h.setConversationActive(false);
    const scanEntry = h.finish("/codex/stage-1.jsonl", status);
    h.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "busy",
      message: h.messages.get("/codex/stage-1.jsonl")!,
    });

    await tickPipelines([scanEntry], h.ports);

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.verdict).toBeNull();
  }
});

test("a pane-less stalled projection with a stuck running runtime ledger settles from durable terminal evidence (#337 production shape)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* Production shape: the transcript ended in a fenced verdict plus trailing
     bookkeeping records, the scan projects jsonl_turn_stalled at the final
     size, and the runtime session ledger stays stuck `running` forever. */
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    output: "integration complete",
    verdict: { status: "pass", confidence: 0.9 },
  });

  /* Settles exactly once: the frozen stalled projection on later wake-ups
     neither re-settles nor appends attempts — history stays append-only. */
  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);
  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(2);
});

test("a restart-primed stalled cache at final size settles without a runtime session (#337)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* Restart: the scan cache re-primes busy at the final size and the fresh
     runtime host has no session for the conversation (ledger answers null). */
  h.setConversationActive(null);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(current.runs[0]!.attempts[0]!.state).toBe("passed");
});

test("a genuinely busy durable turn keeps a stalled pane-less attempt running (#337)", async () => {
  for (const active of [true, null] as const) {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(active);
    /* The trailing scanner message even parses as a verdict; the durable open
       turn (open tool call or a later user follow-up) still blocks settlement. */
    h.finish("/codex/stage-1.jsonl", "pass");
    h.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "busy",
      message: h.messages.get("/codex/stage-1.jsonl")!,
    });

    await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.verdict).toBeNull();
  }
});

test("live and open-turn projections never consult the durable read (#337 cheap path)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(null);
  const reads = countDurableReads(h);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([{ ...entry("/codex/stage-1.jsonl"), activity: "live", activityReason: "jsonl_turn_open" }], h.ports);
  await tickPipelines([{ ...entry("/codex/stage-1.jsonl"), activity: "live", activityReason: "mtime_fresh" }], h.ports);

  expect(reads()).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a pane-hosted stalled attempt keeps the cheap return without a durable read", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const reads = countDurableReads(h);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);

  expect(reads()).toBe(0);
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
  expect(current.runs[0]!.attempts[0]!.verdict).toBeNull();
});

test("a genuinely terminal turn without a valid verdict exhausts recovery and preserves the attempt receipt", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "should I proceed with plan A or plan B?", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  await exhaustVerdictRecovery(h);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("recovery exhausted after 3 checks");
  const attempt = parked.runs[0]!.attempts[0]!;
  expect(attempt.state).toBe("needs_decision");
  expect(attempt.verdictRecovery).toMatchObject({ state: "exhausted", checks: 3 });
  expect(attempt.launchId).toBeTruthy();
  expect(attempt.conversationId).toBeTruthy();
  expect(attempt.agentPath).toBe("/codex/stage-1.jsonl");
});

test("a durable fail verdict parks with the verdict receipt preserved", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "blocked\n\n```json\n{\"status\":\"fail\",\"findings\":[\"tests are red\"]}\n```", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toBe("tests are red");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: { status: "fail", findings: ["tests are red"] },
  });
});

test("a contradictory durable pass verdict parks with the parser failure reason", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: [
        "VERDICT: REQUEST_CHANGES",
        "",
        "- [P1] Preserve the failed review",
        "",
        "```json",
        '{"status":"pass","findings":["Preserve the failed review"]}',
        "```",
      ].join("\n"),
      ts: 5_000_000,
    },
  });

  await tickPipelines([], h.ports);

  const reason = 'contradictory stage verdict: status "pass" cannot include findings';
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toBe(reason);
  expect(current.cursor).toEqual({ stageId: "plan", state: "pending", input: null, activatedBy: null });
  expect(current.lastPassedCommit).toBe(ORIGIN_MAIN_SHA);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    output: "VERDICT: REQUEST_CHANGES\n\n- [P1] Preserve the failed review",
    verdict: null,
    error: reason,
  });
});

test("durable settlement is idempotent across repeated wake-up ticks", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  /* The next wake-up materializes the build attempt; further wake-ups with the
     same durable evidence neither re-settle nor duplicate anything. */
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]!.state).toBe("passed");
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(2);
});

test("a pass that advances to a pending stage schedules its own follow-up tick (#337, pipeline a91b4562)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  try {
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    expect(loadPipelines()[0]!.cursor).toEqual({ stageId: "build", state: "pending", input: "done", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(1);

    /* A pass that leaves no pending cursor does not wake the controller. */
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.cursor).toEqual({ stageId: "build", state: "running", input: "done", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(1);
  } finally {
    unregister();
  }
});

test("role-less run stages persist the Builder registry runtime", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "research", kind: "run", prompt: "research", next: "summarize" },
    { id: "summarize", kind: "run", prompt: "summarize", next: null },
  ] as never);
  h.setBuilderEffort("low");
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.effectiveRole).toEqual({
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    access: "read-write",
    promptScaffold: null,
  });
});

test("an unbound sidecar signals the Viewer before any local pipeline preparation", async () => {
  const h = harness();
  await create(h.ports);
  const child = Bun.spawn([process.execPath, "-e", `
    const { tickPipelines, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
    let requests = 0, effects = 0;
    globalThis.fetch = async () => { requests++; return new Response("{}", { status: 202 }); };
    const ports = { ...defaultPipelinePorts(), structuredDeliveryPublication: () => "unbound",
      exec: async () => { effects++; throw new Error("sidecar must hand preparation to the Viewer"); } };
    const result = await tickPipelines([], ports);
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ requests, effects, changed: result.changed }));
  `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout.trim())).toEqual({ requests: 1, effects: 0, changed: false });
});
