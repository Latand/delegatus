import { expect, test, harness, create, BUILD_ONLY, loadPipelines, tickPipelines } from "./engine.fixture";
import { initializeStateCollections, SqliteStateCollection, StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { spyOn } from "bun:test";

async function scenario(name: string) {
  const h = harness();
  const clock = h.ports.now;
  const offset = Date.parse("2026-11-01T00:00:00.000Z") - Date.parse(clock());
  h.ports.now = () => new Date(Date.parse(clock()) + offset).toISOString();
  const prefix = crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
  let serial = 0;
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `${prefix}-0000-4000-8000-${(++serial).toString(16).padStart(12, "0")}` as ReturnType<typeof crypto.randomUUID>);
  try { await create(h.ports, BUILD_ONLY as never); }
  finally { uuid.mockRestore(); }
  return h;
}

function restartSnapshot(mode: string, requestKey?: string) {
  const reader = process.env.LLV_SNAPSHOT_READER_ROOT ?? process.cwd();
  const child = spawnSync(process.execPath, [path.join(reader, "src/lib/pipelines/fixtures/snapshotLaunchRetry.ts"), mode, ...(requestKey ? [requestKey] : [])],
    { env: { ...process.env, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, encoding: "utf8", timeout: 45_000 });
  expect({ status: child.status, error: child.error, stderr: child.status === 0 ? "" : child.stderr })
    .toEqual({ status: 0, error: undefined, stderr: "" });
  return JSON.parse(child.stdout.trim().split("\n").findLast(line => line.startsWith("{\"dispatches\""))!);
}

function movingInputSnapshot() {
  const filename = path.join(process.env.LLV_STATE_DIR!, "launch-input.sqlite");
  type Row = { id: string };
  initializeStateCollections(filename, [{ collection: "fixture", schemaVersion: 1,
    migrationId: "fixture", key: (row: Row) => row.id, loadRecords: () => [{ id: "input" }] }]);
  let authority = 0;
  return new SqliteStateCollection<Row>(filename, { collection: "fixture", schemaVersion: 1,
    busyMessage: "fixture busy", key: row => row.id, clone: row => structuredClone(row),
    decode: value => { authority++; return value as Row; }, decodeAuthority: () => authority });
}

test("snapshot launch refusal retries the same attempt on the next pass", async () => {
  const h = await scenario("primary");
  const input = movingInputSnapshot();
  const now = h.ports.now;
  let refuse = true;
  h.ports.now = () => {
    if (refuse && loadPipelines()[0]!.cursor?.state === "spawning"
      && !loadPipelines()[0]!.runs[0]!.attempts[0]?.snapshotLaunchRetry?.receiptPending) {
      refuse = false;
      try { input.snapshot(); }
      catch (error) { expect(error).toBeInstanceOf(StateSnapshotChangedError); throw error; }
      throw new Error("the input authority must have moved");
    }
    return now();
  };
  for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
  expect(refuse).toBe(false);
  const refused = loadPipelines()[0]!;
  console.log("REFUSED_SNAPSHOT", refused.state, refused.cursor?.state, refused.stateDetail);
  expect(h.spawnInputs).toHaveLength(0);
  expect(refused.state).toBe("running");
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(1);
  const launched = loadPipelines()[0]!;
  expect(launched.runs[0]!.attempts).toHaveLength(1);
  expect(launched.runs[0]!.attempts[0]!.state).toBe("running");
});

test("snapshot retry count and launch survive a fresh Viewer process", async () => {
  const h = await scenario("restart");
  const now = h.ports.now;
  let refused = false;
  h.ports.now = () => {
    if (!refused && loadPipelines()[0]!.cursor?.state === "spawning"
      && !loadPipelines()[0]!.runs[0]!.attempts[0]?.snapshotLaunchRetry?.receiptPending) {
      refused = true;
      throw new StateSnapshotChangedError();
    }
    return now();
  };
  for (let pass = 0; !refused && pass < 3; pass++) await tickPipelines([], h.ports);
  expect(refused).toBe(true);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.snapshotLaunchRetry?.failures).toBe(1);
  const second = restartSnapshot("refuse");
  expect(second.dispatches).toBe(0);
  expect(second.attempt.snapshotLaunchRetry.failures).toBe(2);
  const launched = restartSnapshot("launch");
  expect(launched.dispatches).toBe(1);
  expect(launched.attempt.n).toBe(1);
  expect(launched.attempt.state).toBe("running");
  expect(launched.attempt.snapshotLaunchRetry.failures).toBe(2);
});

test("snapshot launch retries exhaust durably without a decision or task note", async () => {
  const h = await scenario("exhaustion");
  const { loadTasks } = await import("./engine.fixture");
  const notes = () => loadTasks().map(task => ({ id: task.id, note: task.note }));
  const before = notes();
  const now = h.ports.now;
  let refuse = false;
  h.ports.now = () => {
    if (refuse && loadPipelines()[0]!.cursor?.state === "spawning"
      && !loadPipelines()[0]!.runs[0]!.attempts[0]?.snapshotLaunchRetry?.receiptPending) {
      refuse = false;
      throw new StateSnapshotChangedError();
    }
    return now();
  };
  for (let failures = 1; failures <= 4; failures++) {
    refuse = true;
    if (failures === 1) {
      for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
      expect(refuse).toBe(false);
    } else {
      const observed = restartSnapshot("refuse");
      expect(observed.dispatches).toBe(0);
      expect(observed.refused).toBe(true);
    }
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts).toHaveLength(1);
    expect(lane.runs[0]!.attempts[0]!.snapshotLaunchRetry?.failures).toBe(failures);
    expect(lane.state).toBe(failures < 4 ? "running" : "paused");
    expect(h.spawnInputs).toHaveLength(0);
    expect(notes()).toEqual(before);
  }
  expect(loadPipelines()[0]!.stateDetail).toContain("exhausted after 3 automatic retries");
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(0);
});

test("a controller refusal before the spawn port reuses its counted request", async () => {
  const { controllerSnapshotPorts } = await import("./controllerSnapshot");
  const h = await scenario("before-port");
  const spawn = h.ports.spawnAgent;
  let refuse = true;
  h.ports.spawnAgent = controllerSnapshotPorts({ spawnAgent: spawn }, () => {
    if (refuse) { refuse = false; throw new StateSnapshotChangedError(); }
  }).spawnAgent;
  for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
  expect(refuse).toBe(false);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.spawnCalls).toBe(1);
  expect(attempt.snapshotLaunchRetry?.receiptPending).toBe(true);
  expect(attempt.snapshotLaunchRetry?.failures).toBe(1);
  expect(h.spawnInputs).toHaveLength(0);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(1);
  expect(h.spawnInputs[0]!.clientAttemptId).toBe(`pipeline_${loadPipelines()[0]!.id}_build_1`);
});

test.each(["lost-reply", "moved-row"] as const)("a %s after dispatch reconciles the original receipt without a second launch", async mode => {
  const { failedReceipt } = await import("./engine.fixture");
  const { withPipelineMutation } = await import("./store");
  const h = await scenario(`unknown-${mode}`);
  const spawn = h.ports.spawnAgent;
  let completed = false, receiptReads = 0;
  h.ports.spawnReceipt = launchId => {
    receiptReads++;
    return { ...failedReceipt(launchId, "conversation_stage_1", ""), state: completed ? "completed" : "starting",
      "transcript": completed ? "/codex/stage-1.jsonl" : null, sessionId: completed ? "session-1" : null };
  };
  h.ports.spawnAgent = async (...args) => {
    const result = await spawn(...args);
    if (mode === "lost-reply") throw new StateSnapshotChangedError();
    await withPipelineMutation(async (rows, persist) => {
      rows[0]!.stateDetail = "concurrent controller observation";
      await persist([rows[0]!]);
    });
    return result;
  };
  for (let pass = 0; !h.spawnInputs.length && pass < 3; pass++) await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(1);
  const reserved = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(reserved.launchId).toBe("launch-1");
  expect(reserved.snapshotLaunchRetry).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(receiptReads).toBeGreaterThan(0);
  expect(h.spawnInputs).toHaveLength(1);
  completed = true;
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(1);
  const recovered = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(recovered.launchId).toBe("launch-1");
  expect(recovered.state).toBe("running");
});

test.each(["pause", "close", "replace", "generation"] as const)("snapshot retry preserves a concurrent %s", async action => {
  const { savePipelines } = await import("./store");
  const h = await scenario(`controls-${action}`);
  const now = h.ports.now;
  let refuse = true;
  h.ports.now = () => {
    const rows = loadPipelines(), lane = rows[0]!;
    if (refuse && lane.cursor?.state === "spawning") {
      refuse = false;
      if (action === "replace") {
        const first = lane.runs[0]!.attempts[0]!;
        first.state = "failed";
        first.completedAt = now();
        const replacement = structuredClone(first);
        Object.assign(replacement, { n: 2, state: "pending", startedAt: null, completedAt: null, spawnCalls: 0 });
        if (replacement.accounting) replacement.accounting.repeatReason = "unknown";
        lane.runs[0]!.attempts.push(replacement);
        lane.cursor!.state = "pending";
      } else if (action === "generation") lane.controlGeneration = "fixture-control-successor";
      else if (action === "close") {
        lane.state = "closed";
        lane.cursor = null;
        lane.closedAt = now();
        Object.assign(lane.runs[0]!.attempts[0]!, { state: "skipped", startedAt: null, completedAt: now(), spawnCalls: 0 });
      } else { lane.state = "paused"; lane.pausedState = "running"; }
      savePipelines(rows);
      expect(loadPipelines()[0]!.state).toBe(lane.state);
      throw new StateSnapshotChangedError();
    }
    return now();
  };
  for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
  expect(refuse).toBe(false);
  const lane = loadPipelines()[0]!;
  expect(h.spawnInputs).toHaveLength(0);
  expect(lane.runs[0]!.attempts[0]!.snapshotLaunchRetry).toBeUndefined();
  if (action === "replace") expect(lane.runs[0]!.attempts.at(-1)!.n).toBe(2);
  else if (action === "generation") expect(lane.controlGeneration).toBe("fixture-control-successor");
  else expect(lane.state).toBe(action === "pause" ? "paused" : "closed");
});

test("the real controller pass retries a refused deferred activation", async () => {
  const { tickPipelinesController } = await import("./controllerPass");
  const { settlePipelineControllerJobs } = await import("./controllerJobs");
  const h = await scenario("controller");
  const input = movingInputSnapshot(), now = h.ports.now;
  let refuse = true;
  h.ports.now = () => {
    if (refuse && loadPipelines()[0]!.cursor?.state === "spawning"
      && !loadPipelines()[0]!.runs[0]!.attempts[0]?.snapshotLaunchRetry?.receiptPending) {
      refuse = false;
      input.snapshot();
      throw new Error("the input authority must have moved");
    }
    return now();
  };
  for (let pass = 0; refuse && pass < 6; pass++) {
    await tickPipelinesController([], h.ports);
    await settlePipelineControllerJobs();
  }
  expect(refuse).toBe(false);
  expect(h.spawnInputs).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("running");
  await tickPipelinesController([], h.ports);
  await settlePipelineControllerJobs();
  expect(h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
});

test("unreadable original receipt spends the retry bound, preserves cause and recovers after resume", async () => {
  const { agentRegistry } = await import("@/lib/agent/registry");
  const { patchPipeline } = await import("./engine.fixture");
  const h = await scenario("unreadable-proof");
  const now = h.ports.now;
  let refuse = true;
  h.ports.now = () => {
    if (refuse && loadPipelines()[0]!.cursor?.state === "spawning"
      && !loadPipelines()[0]!.runs[0]!.attempts[0]?.snapshotLaunchRetry?.receiptPending) {
      refuse = false;
      throw new StateSnapshotChangedError();
    }
    return now();
  };
  for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
  const read = spyOn(agentRegistry(), "spawnReceiptForClientAttempt").mockImplementation(() => { throw new Error("fixture receipt reader unavailable"); });
  try {
    for (let pass = 0; pass < 3; pass++) await tickPipelines([], h.ports);
    const lane = loadPipelines()[0]!;
    expect(lane.state).toBe("paused");
    expect(lane.runs[0]!.attempts[0]!.snapshotLaunchRetry?.failures).toBe(4);
    expect(lane.stateDetail).toContain("fixture receipt reader unavailable");
    h.advanceWallClock(60 * 60_000);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
  } finally { read.mockRestore(); }
  expect((await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
});

test.each(["matching", "engine", "worktree", "role"] as const)("a %s receipt before retry is reconciled without another dispatch", async kind => {
  const { AgentRegistry, setAgentRegistryForTests } = await import("./engine.fixture");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const h = await scenario(`admitted-receipt-${kind}`);
  const now = h.ports.now;
  let refuse = true;
  h.ports.now = () => {
    if (refuse && loadPipelines()[0]!.cursor?.state === "spawning"
      && !loadPipelines()[0]!.runs[0]!.attempts[0]?.snapshotLaunchRetry?.receiptPending) {
      refuse = false;
      throw new StateSnapshotChangedError();
    }
    return now();
  };
  for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "snapshot-receipt.json"));
  setAgentRegistryForTests(registry);
  try {
    const begun = beginLegacySpawnFixture(registry, { engine: kind === "engine" ? "claude" : "codex",
      cwd: kind === "worktree" ? "/fixture/other-checkout" : lane.worktreeDir!, transport: "structured",
      clientAttemptId: attempt.snapshotLaunchRetry!.requestKey!,
      memberships: [{ kind: "pipeline", containerId: lane.id, stageId: "build", slot: "build:1", round: 1,
        role: kind === "role" ? "reviewer" : attempt.effectiveRole.roleId ?? "agent", stageOrder: 0, parentConversationId: null }] });
    expect(begun.kind).toBe("created");
    await tickPipelines([], h.ports);
    if (kind !== "matching") {
      for (let pass = 0; pass < 2; pass++) await tickPipelines([], h.ports);
      const held = loadPipelines()[0]!;
      expect(held.state).toBe("paused");
      expect(held.runs[0]!.attempts[0]!.launchId).toBeNull();
      expect(held.stateDetail).toContain("identity conflicts");
      expect(h.spawnInputs).toHaveLength(0);
      return;
    }
    const adopted = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(adopted.launchId).toBe(begun.receipt.launchId);
    expect(adopted.conversationId).toBe(begun.receipt.conversationId);
    expect(adopted.state).toBe("spawning");
    expect(h.spawnInputs).toHaveLength(0);
    expect(registry.pipelineSpawnHistory(attempt.snapshotLaunchRetry!.requestKey!)).toHaveLength(1);
  } finally { registry.close(); setAgentRegistryForTests(null); }
});


test("a reader without retry metadata retains the original counted launch custody", async () => {
  const { controllerSnapshotPorts } = await import("./controllerSnapshot");
  const { agentRegistry } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const h = await scenario("legacy-custody");
  let refuse = true;
  h.ports.spawnAgent = controllerSnapshotPorts({ spawnAgent: h.ports.spawnAgent }, () => {
    if (refuse) { refuse = false; throw new StateSnapshotChangedError(); }
  }).spawnAgent;
  for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
  expect(refuse).toBe(false);
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  const requestKey = attempt.snapshotLaunchRetry!.requestKey!;
  expect(attempt.spawnCalls).toBe(1);
  const begun = beginLegacySpawnFixture(agentRegistry(), { engine: attempt.effectiveRole.engine,
    cwd: lane.worktreeDir!, transport: "structured", clientAttemptId: requestKey,
    memberships: [{ kind: "pipeline", containerId: lane.id, stageId: "build", slot: "build:1", round: 1,
      role: attempt.effectiveRole.roleId ?? "agent", stageOrder: 0, parentConversationId: null }] });
  expect(begun.kind).toBe("created");
  const observed = restartSnapshot("legacy-read", requestKey);
  console.log("LEGACY_CUSTODY", JSON.stringify({ dispatches: observed.dispatches, launchCount: observed.launchCount }));
  expect(observed.dispatches).toBe(0);
  expect(observed.launchCount).toBe(1);
});

test("a real controller row change after admission retries on the next pass", async () => {
  const { savePipelines, controllerPipelineVersionNow } = await import("./store");
  const { controllerSnapshotPorts } = await import("./controllerSnapshot");
  const h = await scenario("row-revision");
  const spawn = h.ports.spawnAgent;
  let refuse = true;
  // The counted admission checkpoint has completed when the dispatch port is
  // read. A concurrent writer changes the real row before its authority check.
  Object.defineProperty(h.ports, "spawnAgent", { enumerable: true, configurable: true, get() {
    if (refuse) {
      const rows = loadPipelines(), lane = rows[0]!;
      const attempt = lane.runs[0]!.attempts[0];
      if (lane.cursor?.state === "spawning" && attempt?.spawnCalls === 1 && !attempt.snapshotLaunchRetry?.receiptPending) {
        refuse = false;
        const version = controllerPipelineVersionNow(lane.id);
        lane.stateDetail = "concurrent launch admission checkpoint";
        savePipelines(rows);
        expect(controllerPipelineVersionNow(lane.id)).not.toBe(version);
        return controllerSnapshotPorts({ spawnAgent: spawn }, () => {
          if (controllerPipelineVersionNow(lane.id) !== version) throw new StateSnapshotChangedError();
        }).spawnAgent;
      }
    }
    return spawn;
  } });
  for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
  expect(refuse).toBe(false);
  expect(h.spawnInputs).toHaveLength(0);
  await tickPipelines([], h.ports);
  console.log("ROW_REVISION_RECOVERY", loadPipelines()[0]!.state, h.spawnInputs.length);
  expect(h.spawnInputs).toHaveLength(1);
  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(1);
  expect(lane.runs[0]!.attempts[0]!.n).toBe(1);
  expect(lane.runs[0]!.attempts[0]!.state).toBe("running");
});

test.each(["terminal", "counter", "request-key"] as const)("receipt recovery preserves a %s checkpoint without dispatch", async kind => {
  const { controllerSnapshotPorts } = await import("./controllerSnapshot");
  const { withPipelineMutation } = await import("./store");
  const h = await scenario(`proof-checkpoint-${kind}`);
  let refuse = true;
  h.ports.spawnAgent = controllerSnapshotPorts({ spawnAgent: h.ports.spawnAgent }, () => {
    if (refuse) { refuse = false; throw new StateSnapshotChangedError(); }
  }).spawnAgent;
  for (let pass = 0; refuse && pass < 3; pass++) await tickPipelines([], h.ports);
  expect(refuse).toBe(false);
  await withPipelineMutation(async (rows, persist) => {
    const attempt = rows[0]!.runs[0]!.attempts[0]!;
    if (kind === "terminal") {
      Object.assign(attempt, { state: "failed", completedAt: h.ports.now(), error: "accepted terminal fixture result" });
      rows[0]!.state = "needs_decision";
      rows[0]!.stateDetail = attempt.error;
    } else if (kind === "counter") attempt.snapshotLaunchRetry!.failures = -1;
    else attempt.snapshotLaunchRetry!.requestKey = "pipeline_other_build_1";
    await persist(rows);
  });
  for (let pass = 0; pass < 3; pass++) await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  expect(h.spawnInputs).toHaveLength(0);
  if (kind === "terminal") {
    expect(attempt.state).toBe("failed");
    expect(attempt.error).toBe("accepted terminal fixture result");
  } else {
    expect(lane.state).toBe("paused");
    expect(attempt.snapshotLaunchRetry!.failures).toBe(4);
    expect(lane.stateDetail).toContain(kind === "counter" ? "counter is invalid" : "request key no longer matches");
  }
});
