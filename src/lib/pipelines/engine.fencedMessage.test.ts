import { expect, test, harness, create, tickPipelines, loadPipelines, savePipelines, failedReceipt, frozenWallClock, forbiddenSleep, fs, path, defaultPipelinePorts, AgentRegistry, setAgentRegistryForTests, crypto } from "./engine.fixture";
import { SEND_LOST_REASON, SEND_UNVERIFIED_REASON } from "@/lib/runtime/sendSettlement";
import { RuntimeJournal } from "@/runtime-host/journal";

test("a fenced first message relaunches automatically and succeeds", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const spawn = h.ports.spawnAgent;
  let calls = 0;
  const keys: string[] = [];
  h.ports.spawnAgent = async (input, onReserved, prepare) => {
    calls++;
    keys.push(input.clientAttemptId);
    if (calls === 1) {
      await onReserved({ launchId: "launch-fenced", conversationId: "conversation_fenced" });
      throw new Error(SEND_LOST_REASON);
    }
    return spawn(input, onReserved, prepare);
  };
  h.ports.spawnReceipt = id => id === "launch-fenced"
    ? { ...failedReceipt(id, "conversation_fenced", SEND_LOST_REASON), staged: true, currentGeneration: true }
    : null;
  Object.assign(h.ports, { fencedFirstMessageRetrySafe: async () => true, sleep: forbiddenSleep });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", cursor: { state: "pending" } });
  expect(calls).toBe(1);
  advance(999);
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  advance(1);
  await tickPipelines([], h.ports);
  expect(calls).toBe(2);
  expect(new Set(keys).size).toBe(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running",
    retiredLaunches: [{ launchId: "launch-fenced", error: SEND_LOST_REASON }] });
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
});

test("production adapters resume their persisted retry claim after a controller restart", async () => {
  const inheritedRoot = process.env.LLV_FENCED_PROD_RESTART_ROOT;
  if (inheritedRoot) {
    const root = inheritedRoot;
    const lane = JSON.parse(fs.readFileSync(path.join(root, "lane.json"), "utf8"));
    savePipelines([lane]);
    const h = harness();
    const registry = new AgentRegistry(path.join(root, "agent-registry.json"));
    const journal = new RuntimeJournal(path.join(root, "runtime-journal.sqlite"), {
      structuredHosts: true, now: () => Date.parse("2026-10-20T12:00:00Z"),
    });
    try {
      setAgentRegistryForTests(registry);
      const production = defaultPipelinePorts({ spawnRecoveryClient: () => ({
        operationStatus: async (id: string) => journal.currentRetryResult(id),
      } as never) });
      h.ports.spawnReceipt = production.spawnReceipt;
      h.ports.claimSpawnRetry = production.claimSpawnRetry;
      h.ports.fencedFirstMessageRetrySafe = production.fencedFirstMessageRetrySafe;
      h.ports.stopStageAgent = async () => ({ outcome: "not-running" });
      h.ports.scheduleTick = () => {};
      h.ports.now = () => "2026-10-20T12:00:00.000Z";

      await tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "pending", fencedMessageRetries: 1 });
      h.ports.now = () => "2026-10-20T12:00:01.000Z";
      await tickPipelines([], h.ports);
      const recovered = loadPipelines()[0]!;
      expect(h.spawnInputs).toHaveLength(1);
      expect(recovered.runs[0]!.attempts[0]).toMatchObject({ state: "running", launchId: "launch-1",
        retiredLaunches: [{ error: SEND_LOST_REASON }] });
      fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ state: recovered.state,
        attempt: recovered.runs[0]!.attempts[0], spawnCount: h.spawnInputs.length,
        retryClaim: registry.spawnReceipt(recovered.runs[0]!.attempts[0]!.retiredLaunches![0]!.launchId!)?.retryClaim }));
      console.log("production retry claim recovered after controller process restart");
    } finally {
      journal.close();
      registry.close();
      setAgentRegistryForTests(null);
    }
    return;
  }

  const h = harness();
  const stages = [{ id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build", next: null }] as const;
  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const root = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "fenced-production-"));
  const registryPath = path.join(root, "agent-registry.json");
  const journalPath = path.join(root, "runtime-journal.sqlite");
  const registry = new AgentRegistry(registryPath);
  const journal = new RuntimeJournal(journalPath, { structuredHosts: true, now: () => Date.parse("2026-10-20T12:00:00Z") });
  let storesOpen = true;
  try {
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, transport: "structured", role: "builder",
      launchProfile: { title: "Fenced production fixture" },
      clientAttemptId: "fenced-production-launch", conversationId: `conversation_${crypto.randomUUID()}` });
    if (begun.kind !== "created") throw new Error("failed to reserve the production-adapter fixture launch");
    const artifactPath = path.join(root, "stage.jsonl");
    fs.writeFileSync(artifactPath, "");
    const key = { engine: "codex" as const, sessionId: crypto.randomUUID() };
    expect(registry.stageStructuredSpawn(begun.receipt.launchId, { key, artifactPath, cwd: root,
      accountId: "account-a", launchProfile: begun.receipt.launchProfile, status: "dead", host: null,
      structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null }).kind).toBe("settled");
    expect(registry.failStructuredSpawn(begun.receipt.launchId, SEND_LOST_REASON).claimed).toBe(true);

    const operationId = `spawn_message_${begun.receipt.launchId}`;
    journal.append({ scope: { type: "session", id: begun.receipt.conversationId }, kind: "session-status", payload: {
      conversationId: begun.receipt.conversationId, sessionKey: key, hostKind: "codex-app-server", host: "hosted",
      turn: "idle", provenance: "structured", capabilities: { steer: true, structuredAttention: true },
    } });
    journal.executeOperation({ kind: "send", operationId, idempotencyKey: `spawn_${begun.receipt.launchId}`,
      conversationId: begun.receipt.conversationId, text: "Build", policy: "queue" });
    journal.transitionOperation(operationId, "failed", { reason: SEND_LOST_REASON }, { fromStatuses: ["queued"] });
    const lane = loadPipelines().find(item => item.id === pipeline.id)!;
    const attempt = lane.runs[0]!.attempts[0]!;
    const stageId = lane.cursor!.stageId!;
    attempt.state = "spawning";
    attempt.error = null;
    attempt.launchId = begun.receipt.launchId;
    attempt.conversationId = begun.receipt.conversationId;
    attempt.sessionId = null;
    attempt.agentPath = null;
    attempt.paneId = null;
    lane.state = "running";
    lane.stateDetail = null;
    lane.cursor!.state = "spawning";
    savePipelines([lane]);

    const claimId = `${pipeline.id}:${stageId}:${begun.receipt.launchId}`;
    expect(registry.claimFailedSpawnForRetry(begun.receipt.launchId, claimId).kind).toBe("claimed");
    fs.writeFileSync(path.join(root, "lane.json"), JSON.stringify(lane));
    registry.close();
    journal.close();
    storesOpen = false;
    const childRoot = path.join(root, "child");
    for (const name of ["home", "config", "tmp", "state"]) fs.mkdirSync(path.join(childRoot, name), { recursive: true });
    const child = Bun.spawn([process.execPath, "test", import.meta.filename, "--test-name-pattern",
      "production adapters resume their persisted retry claim after a controller restart"], {
      env: { ...process.env, HOME: path.join(childRoot, "home"), XDG_CONFIG_HOME: path.join(childRoot, "config"),
        TMPDIR: path.join(childRoot, "tmp"), LLV_STATE_DIR: path.join(childRoot, "state"),
        LLV_FENCED_PROD_RESTART_ROOT: root },
      stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(60_000),
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(stdout).toContain("production retry claim recovered after controller process restart");
    const result = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
    expect(result).toMatchObject({ state: "running", spawnCount: 1,
      attempt: { state: "running", fencedMessageRetries: 1, retiredLaunches: [{ launchId: begun.receipt.launchId }] },
      retryClaim: { claimId } });
  } finally {
    if (storesOpen) { journal.close(); registry.close(); }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("fenced first-message retries exhaust their persisted bound", async () => {
  const inherited = process.env.LLV_FENCED_CAP_INPUT;
  if (inherited) {
    const lane = JSON.parse(fs.readFileSync(inherited, "utf8"));
    const a = lane.runs[0].attempts[0];
    lane.state = "running"; lane.cursor.state = "spawning";
    a.state = "spawning"; a.error = null;
    savePipelines([lane]);
    const h = harness();
    h.ports.now = () => "2026-10-20T12:02:00Z";
    h.ports.spawnReceipt = id => ({ ...failedReceipt(id, a.conversationId, SEND_LOST_REASON), staged: true });
    Object.assign(h.ports, { fencedFirstMessageRetrySafe: async () => true });
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
    expect(loadPipelines()[0]!.stateDetail).toContain("3 automatic retries");
    console.log("fenced retry bound survived restart");
    return;
  }
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  let calls = 0;
  const keys: string[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    keys.push(input.clientAttemptId);
    const id = `fenced-${++calls}`;
    await onReserved({ launchId: id, conversationId: `conversation_${id}` });
    throw new Error(SEND_LOST_REASON);
  };
  h.ports.spawnReceipt = id => ({ ...failedReceipt(id, `conversation_${id}`, SEND_LOST_REASON), staged: true });
  Object.assign(h.ports, { fencedFirstMessageRetrySafe: async () => true, sleep: forbiddenSleep });
  for (const delay of [1_000, 5_000, 15_000]) {
    await tickPipelines([], h.ports);
    const a = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(Date.parse(a.controllerWait!.retryAfter) - Date.parse(h.ports.now())).toBe(delay);
    advance(delay);
  }
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(calls).toBe(4);
  expect(new Set(keys).size).toBe(4);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("3 automatic retries");
  expect(parked.stateDetail).toContain(SEND_LOST_REASON);
  expect(parked.runs[0]!.attempts[0]!.retiredLaunches).toHaveLength(3);
  for (let i = 0; i < 3; i++) { advance(60_000); await tickPipelines([], h.ports); }
  expect(calls).toBe(4);
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "fenced-cap-"));
  try {
    const input = path.join(root, "lane.json");
    fs.writeFileSync(input, JSON.stringify(loadPipelines()[0]));
    const child = Bun.spawn([process.execPath, "test", import.meta.filename, "--test-name-pattern",
      "fenced first-message retries exhaust their persisted bound"], {
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root,
        LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_FENCED_CAP_INPUT: input },
      stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(60_000),
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(stdout).toContain("fenced retry bound survived restart");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test.each(["spawning", "running", "needs_decision"] as const)("a fenced first-message receipt recovers from %s", async state => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const lane = loadPipelines()[0]!;
  const a = lane.runs[0]!.attempts[0]!;
  const original = a.launchId!;
  const conversation = a.conversationId!;
  a.paneId = null; a.agentPath = null; a.state = state;
  lane.state = state === "needs_decision" ? state : "running";
  lane.cursor!.state = state === "needs_decision" ? "spawning" : state;
  a.error = lane.stateDetail = state === "needs_decision" ? SEND_LOST_REASON : null;
  savePipelines([lane]);
  h.ports.spawnReceipt = id => id === original ? { ...failedReceipt(id, conversation, SEND_LOST_REASON), staged: true } : null;
  Object.assign(h.ports, { fencedFirstMessageRetrySafe: async () => true });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor!.state).toBe("pending");
  advance(1_000);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId).not.toBe(original);
});

test.each([SEND_UNVERIFIED_REASON, SEND_LOST_REASON])("missing journal proof never resends: %s", async reason => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  let calls = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    calls++;
    await onReserved({ launchId: "launch-unknown", conversationId: "conversation_unknown" });
    throw new Error(reason);
  };
  h.ports.spawnReceipt = id => failedReceipt(id, "conversation_unknown", reason);
  Object.assign(h.ports, { fencedFirstMessageRetrySafe: async () => false, sleep: forbiddenSleep });
  await tickPipelines([], h.ports);
  advance(60_000);
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});

test("a safe-looking error without a reserved launch never authorizes a retry", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let calls = 0;
  h.ports.spawnAgent = async () => { calls++; throw new Error(SEND_LOST_REASON); };
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait).toBeUndefined();
});

test.each(["journal-read", "retry-claim", "host-stop"] as const)("new ownership or delivery evidence at %s withdraws a fenced retry", async seam => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let calls = 0;
  const receipt = { ...failedReceipt("launch-fenced", "conversation_fenced", SEND_LOST_REASON), staged: true, currentGeneration: true };
  h.ports.spawnAgent = async (_input, onReserved) => {
    calls++;
    await onReserved(receipt);
    throw new Error(SEND_LOST_REASON);
  };
  h.ports.spawnReceipt = () => ({ ...receipt });
  Object.assign(h.ports, { fencedFirstMessageRetrySafe: async () => {
    if (seam === "journal-read") receipt.conversationId = "conversation_other";
    return true;
  } });
  h.ports.claimSpawnRetry = async () => {
    if (seam === "retry-claim") receipt.currentGeneration = false;
    return "claimed" as const;
  };
  h.ports.stopStageAgent = async () => {
    if (seam === "host-stop") receipt.error = SEND_UNVERIFIED_REASON;
    return { outcome: "not-running" };
  };
  await tickPipelines([], h.ports);
  const a = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(calls).toBe(1);
  expect(a.launchId).toBe("launch-fenced");
  expect(a.retiredLaunches).toBeUndefined();
});

test("fenced retry delivers once across controller processes before and after dispatch", async () => {
  const inherited = process.env.LLV_FENCED_RESTART_ROOT;
  if (inherited) {
    const laneFile = path.join(inherited, "lane.json");
    const transportFile = path.join(inherited, "transport.json");
    const lane = JSON.parse(fs.readFileSync(laneFile, "utf8"));
    savePipelines([lane]);
    const h = harness();
    h.ports.now = () => "2026-10-20T12:01:00Z";
    const delivered = { launchId: "launch-success", conversationId: "conversation_success", state: "completed" as const,
      "transcript": "/codex/stage-1.jsonl", sessionId: "session-success", paneId: null, staged: true, currentGeneration: true };
    h.ports.spawnReceipt = id => id === delivered.launchId ? delivered : null;
    h.ports.spawnAgent = async (input, onReserved) => {
      const transport = JSON.parse(fs.readFileSync(transportFile, "utf8"));
      expect(transport.keys).not.toContain(input.clientAttemptId);
      transport.keys.push(input.clientAttemptId);
      transport.deliveries++;
      fs.writeFileSync(transportFile, JSON.stringify(transport));
      await onReserved(delivered);
      // The receipt and dispatch checkpoint committed; the controller exits
      // before receiving the spawn answer. The successor must adopt that key.
      fs.writeFileSync(laneFile, JSON.stringify(loadPipelines()[0]));
      process.exit(0);
    };
    await tickPipelines([], h.ports);
    const recovered = loadPipelines()[0]!;
    expect(recovered.runs[0]!.attempts[0]).toMatchObject({ state: "running", launchId: delivered.launchId });
    expect(JSON.parse(fs.readFileSync(transportFile, "utf8"))).toMatchObject({ deliveries: 1 });
    console.log("original dispatch adopted once");
    return;
  }
  const h = harness();
  h.ports.now = () => "2026-10-20T12:00:00Z";
  await create(h.ports);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, onReserved) => {
    await onReserved({ launchId: "launch-fenced", conversationId: "conversation_fenced" });
    throw new Error(SEND_LOST_REASON);
  };
  h.ports.spawnReceipt = id => failedReceipt(id, "conversation_fenced", SEND_LOST_REASON);
  Object.assign(h.ports, { fencedFirstMessageRetrySafe: async () => true });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor!.state).toBe("pending");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "fenced-controller-"));
  try {
    fs.writeFileSync(path.join(root, "lane.json"), JSON.stringify(loadPipelines()[0]));
    fs.writeFileSync(path.join(root, "transport.json"), JSON.stringify({ keys: [], deliveries: 0 }));
    for (const phase of ["dispatch", "adopt"]) {
      const childRoot = path.join(root, phase);
      fs.mkdirSync(childRoot);
      const child = Bun.spawn([process.execPath, "test", import.meta.filename, "--test-name-pattern",
        "fenced retry delivers once across controller processes"], {
        env: { ...process.env, HOME: childRoot, XDG_CONFIG_HOME: path.join(childRoot, "config"), TMPDIR: childRoot,
          LLV_STATE_DIR: path.join(childRoot, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_FENCED_RESTART_ROOT: root },
        stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(60_000),
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      if (phase === "adopt") expect(stdout).toContain("original dispatch adopted once");
    }
    expect(JSON.parse(fs.readFileSync(path.join(root, "transport.json"), "utf8"))).toMatchObject({ deliveries: 1 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);
