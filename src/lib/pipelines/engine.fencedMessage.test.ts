import { expect, test, harness, create, tickPipelines, loadPipelines, savePipelines, failedReceipt, frozenWallClock, forbiddenSleep, fs, path } from "./engine.fixture";
import { SEND_LOST_REASON, SEND_UNVERIFIED_REASON } from "@/lib/runtime/sendSettlement";

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
    return "claimed";
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
