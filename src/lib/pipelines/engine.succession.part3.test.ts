import { expect, test, spawnSync, fs, path, AccountAuthenticationRequiredError, selectProjectAccount, IDLE_TURN_QUIET_MS, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, loadPipelines, savePipelines, pipelineIdentity, pipelineRevision, durableStageTurnEvidence, patchPipeline, ORIGIN_MAIN_SHA, entry, harness, create, withRuntimeSnapshot, PASS_TEXT, pinStageHead, runningStructuredStage, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, stampPipelinePrompt, BUDGET_STAGES, movingHeadHarness, continueReview, movingHead, driveLegacyTerminalRecheck, stagedRecoveryHarness, recoveryReport, expectProviderParkAt, providerRecoveryHarness } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";

test.each(["en", "uk"] as const)("a parked provider retry names its automatic resume time in %s", async (locale) => {
  const { updateOperatorSettings, resetOperatorSettingsForTests } = await import("@/lib/operator/settings");
  const settings = path.join(process.env.LLV_STATE_DIR!, "operator-settings.json");
  const previous = fs.existsSync(settings) ? fs.readFileSync(settings) : null;
  try {
    updateOperatorSettings({ locale, source: "chosen", timeZone: "Europe/Kyiv" });
    const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
    // An explicit pin must never consult the automatic account pool.
    let selections = 0;
    f.h.ports.resolveProjectSpawn = () => { selections += 1; throw new Error("pinned account was substituted"); };
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    await tickPipelines([], f.h.ports);
    const parked = loadPipelines()[0]!;
    expect(parked.stateDetail).toContain(locale === "en" ? "Automatic retry" : "Автоповтор");
    expect(parked.stateDetail).not.toContain(new Date(f.resetsAt! * 1_000 + 60_000).toISOString());
    expect(selections).toBe(0);
  } finally {
    if (previous) fs.writeFileSync(settings, previous);
    else fs.rmSync(settings, { force: true });
    resetOperatorSettingsForTests();
  }
});


for (const engine of ["claude", "codex"] as const) {
  for (const pinned of [false, true]) {
    test(`${engine} weekly limit keeps running until reset, pinned=${pinned}`, async () => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your weekly limit · resets 2:30pm", 120_000, pinned);
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(loadPipelines()[0]!.stateDetail).toContain("weekly limit");
      expect(loadPipelines()[0]!.stateDetail).toContain(new Date(f.resetsAt! * 1_000).toISOString());
      f.advance(120_000);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(0);
      f.advance(60_000);
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    });
  }
}


test.each(["session", "weekly"] as const)("native Claude %s reset waits without spending unknown-reset budget and retains real WIP", async (scope) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", `You've hit your ${scope} limit`);
  f.advance(Date.parse("2026-10-02T00:16:00Z") - f.now());
  const resetsAt = Date.parse("2026-10-02T14:30:00Z");
  const transcript = stageTranscript(`native-claude-${scope}-reset`, [{
    type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: `You've hit your ${scope} limit · resets 2:30pm (UTC)` }] },
  }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": transcript });
  const container = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "native-reset-wip-"));
  const lane = loadPipelines()[0]!;
  lane.repoDir = path.join(container, "repo");
  const root = lane.worktreeDir = path.join(container, `repo-pipeline-${lane.id}`);
  fs.mkdirSync(root);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  (await git("init", "-b", "main"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  (await git("add", "tracked.txt"));
  (await git("-c", "user.name=Recovery Fixture", "-c", "user.email=noreply", "commit", "-m", "fixture"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "staged work\n");
  (await git("add", "tracked.txt"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "unstaged work\n");
  fs.writeFileSync(path.join(root, "untracked.txt"), "untracked work\n");
  const head = (await git("rev-parse", "HEAD"));
  const index = fs.readFileSync(path.join(root, ".git", "index"));
  savePipelines([lane]);
  const baseExec = f.h.ports.exec;
  f.h.ports.exec = (command, args, cwd, options) => command === "git" && args[0] === "-C" && args[1] === root
    ? (() => { const result = spawnSync(command, args, { encoding: "utf8" }); return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }; })()
    : baseExec(command, args, cwd, options);
  try {
    for (const at of [f.now(), f.now() + 30 * 60_000, f.now() + 6 * 60 * 60_000, resetsAt, resetsAt + 59_000]) {
      f.advance(at - f.now());
      await tickPipelines([], f.h.ports);
      const waiting = loadPipelines()[0]!;
      expect(waiting.state).toBe("running");
      expect(waiting.stateDetail).toContain("2026-10-02T14:30:00.000Z");
      expect(waiting.runs[0]!.attempts[0]!.providerWait).toMatchObject({ tries: 0, resetsAt: resetsAt / 1_000 });
      expect(f.sends).toHaveLength(0);
    }
    f.advance(1_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("unstaged work\n");
    expect(fs.readFileSync(path.join(root, "untracked.txt"), "utf8")).toBe("untracked work\n");
    expect(fs.readFileSync(path.join(root, ".git", "index"))).toEqual(index);
    expect((await git("rev-parse", "HEAD"))).toBe(head);
  } finally { fs.rmSync(container, { recursive: true, force: true }); }
});


test.each([false, true])("known native reset waiting does not exhaust a subsequent unknown-reset backoff, reopened=%s", async (reopened) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit");
  f.advance(Date.parse("2026-10-02T00:16:00Z") - f.now());
  const transcript = stageTranscript("native-reset-then-unknown", [{
    type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit · resets 2:30pm (UTC)" }] },
  }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": transcript });
  await tickPipelines([], f.h.ports);
  f.advance(Date.parse("2026-10-02T14:31:00Z") - f.now());
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  if (reopened) {
    f.advance(1_000);
    fs.appendFileSync(transcript, JSON.stringify({ type: "user", uuid: "unknown-reset-controller", promptSource: "sdk", timestamp: f.h.ports.now(), message: { role: "user", content: "Continue the same stage" } }) + "\n");
    await stampPipelinePrompt(transcript, "unknown-reset-controller", "Continue the same stage");
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.actionAt).toBeDefined();
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(1);
  }
  f.h.setConversationActive(false);
  f.advance(1_000);
  fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit" }] } }) + "\n");
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toMatchObject({ tries: 1, resetsAt: null });
  f.advance(30 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(2);
  f.advance(6 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("weekly limit");
});


test("unknown usage reset probes at 30 minutes and parks at six hours with its cause", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've reached your Fable limit");
  await tickPipelines([], f.h.ports);
  f.advance(30 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  f.advance(6 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("fable limit");
});


test("a staged unpublished report bypasses the recovery probe and follows the pass edge", async () => {
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.report = recoveryReport(f.h.ports.now());
  savePipelines([pipeline]);
  f.h.ports.conversationAgentActive = async () => false;
  pinStageHead(f.h);
  f.advance(3 * 60_000);
  const probes = f.lookups.length;
  await tickPipelines([], f.h.ports);
  expect(f.attempt().state).toBe("passed");
  expect(f.lookups).toHaveLength(probes);
});


test("four limit-cut lanes wait without parking and continue independently once reset", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000);
  const source = loadPipelines()[0]!;
  const lanes = Array.from({ length: 4 }, (_, n) => {
    const lane = structuredClone(source);
    lane.id = `${source.id.slice(0, 7)}${n}`;
    Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir));
    if (lane.delivery) {
      lane.delivery.ownerId = lane.id;
      lane.delivery.target.branch = `refs/heads/${lane.branch}`;
    }
    return lane;
  });
  savePipelines(lanes);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines().map((lane) => lane.state)).toEqual(["running", "running", "running", "running"]);
  expect(loadPipelines().every((lane) => lane.stateDetail?.includes(new Date(f.resetsAt! * 1_000).toISOString()))).toBe(true);
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(4);
  expect(new Set(f.sends).size).toBe(4);
});


for (const reason of ["structured stage ended before its session was discovered", "stage agent exited before its session was discovered"]) {
  test(`a parked discovery failure settles its report: ${reason}`, async () => {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    lane.state = "needs_decision";
    lane.stateDetail = reason;
    attempt.state = "needs_decision";
    attempt.error = reason;
    attempt.report = recoveryReport(h.ports.now());
    savePipelines([lane]);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
  });
}



test("a pending Codex failover returns to the recovered source when its target is unavailable", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  // The automatic target lost its project binding before admission. Use the
  // production selector: requestedId is fixed, so forwarding B would refuse A.
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT];
  f.h.ports.resolveProjectSpawn = (engine, input) => {
    const selection = selectProjectAccount({ engine, project: loadPipelines()[0]!.project,
      accounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT].map(id => ({ id, authPresent: true })), observations: [], now: f.now(),
      bindings: [{ project: loadPipelines()[0]!.project, engine: "codex", accountId: LIMITED_ACCOUNT, createdAt: f.h.ports.now() }],
      requestedId: input.requestedId, unavailableIds: input.unavailableIds });
    return selection.kind === "available" ? { kind: "available", account: { engine, accountId: selection.accountId!, kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } }
      : selection.kind === "not_allowed" ? selection
      : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] };
  };
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(loadPipelines()[0]!.cursor?.state).toBe("running");
  expect(loadPipelines()[0]!.state).toBe("running");
});


test.each([120_000, 24 * 60 * 60_000, null])("pending capacity recovery exhausts due probes after reset=%s", async (resetDelay) => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", resetDelay);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] });
  await tickPipelines([], f.h.ports);
  if (resetDelay !== null) {
    f.advance(resetDelay - 1);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    f.advance(60_001);
  } else f.advance(6 * 60 * 60_000);
  let parkedAt: string | null = null;
  for (let probe = 0; probe < 4; probe += 1) {
    await tickPipelines([], f.h.ports);
    if (loadPipelines()[0]!.state === "needs_decision") { parkedAt = f.h.ports.now(); break; }
    f.advance(30 * 60_000);
  }
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toMatch(/usage limit.*capacity/);
  expectProviderParkAt(parked, parkedAt!);
  expect(parked.runs[0]!.attempts.at(-1)!.providerWait!.stageRetry).toBeDefined();
  for (let tick = 0; tick < 32; tick += 1) {
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
  }
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(f.h.spawnInputs).toHaveLength(1);
  const retryAt = Date.parse(parked.runs[0]!.attempts.at(-1)!.providerWait!.resumeAt);
  f.advance(retryAt - f.now());
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
});


test("pending capacity ignores an elapsed historical reset when the pool names a future reset", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  const futureReset = Math.floor(f.now() / 1_000) + 7 * 24 * 60 * 60;
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: futureReset, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] });
  f.advance(180_000);
  for (let probe = 0; probe < 32; probe += 1) {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    f.advance(30 * 60_000);
  }
  const waiting = loadPipelines()[0]!;
  expect(waiting.runs[0]!.attempts[1]!.providerWait!.capacityProbes ?? 0).toBe(0);
  expect(waiting.runs[0]!.attempts[1]!.providerWait!.resetsAt).toBe(futureReset);
  expect(waiting.stateDetail).toContain(new Date(futureReset * 1_000).toISOString());
  f.advance(futureReset * 1_000 + 60_000 - f.now());
  for (let probe = 0; probe < 3; probe += 1) {
    await tickPipelines([], f.h.ports);
    f.advance(30 * 60_000);
  }
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("capacity recovery exhausted after 3 due probes");
  expect(f.h.spawnInputs).toHaveLength(1);
});


test("a freshly recorded report waits for its live turn when the transcript still shows an older completed turn", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.report = recoveryReport(h.ports.now());
  savePipelines([lane]);
  const oldTurnAt = Date.parse(attempt.report.at) - 1_000;
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", lastRecordAt: oldTurnAt,
    message: { text: PASS_TEXT, ts: oldTurnAt } });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("plan");
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", lastRecordAt: Date.parse(attempt.report.at) + 1_000,
    message: { text: PASS_TEXT, ts: Date.parse(attempt.report.at) + 1_000 } });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
});


test.each(["nonfatal", "older"] as const)("a %s memory notice leaves restart recovery authoritative", async (notice) => {
  const h = harness();
  await runningStructuredStage(h);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null,
    lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  await tickPipelines([], { ...h.ports,
    conversationTurnInterrupted: async () => "dead",
    conversationOutOfMemory: async () => ({ at: notice === "older"
      ? new Date(Date.parse(attempt.startedAt!) - 1).toISOString() : h.ports.now(),
      limitBytes: 15 * 2 ** 30, limit: "agent", fatal: notice !== "nonfatal", process: null }),
  });
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.outOfMemory).toBeUndefined();
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery!.replacementAttempt).toBe(2);
});



test("restart recovers a newer interrupted turn after a provider continuation even with an open scan projection", async () => {
  const f = await providerRecoveryHarness("codex", "stream_disconnected", "stream disconnected");
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  f.h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
  f.advance(IDLE_TURN_QUIET_MS + 1);
  f.h.setConversationActive(null);
  const restarted: PipelinePorts = { ...f.h.ports,
    restartRecoveryBootId: () => "new-turn-boot",
    conversationTurnInterrupted: async () => "idle",
  };
  const open = { ...entry(attempt.agentPath!), activity: "live" as const, activityReason: "jsonl_turn_open" as const };
  await tickPipelines([open], restarted);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery!.replacementAttempt).toBe(2);
  await tickPipelines([open], restarted);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(1);
});


test.each(["codex", "claude"] as const)("a persisted provider cut recovers once behind a restored idle open scan (%s)", async (engine) => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const h = harness();
  await runningStructuredStage(h);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  const timestamp = new Date(Date.parse(attempt.startedAt!) + 1).toISOString();
  const transcript = stageTranscript(`provider-idle-${engine}`, engine === "codex" ? [
    { type: "event_msg", timestamp, payload: { type: "task_started", turn_id: "open-before-crash" } },
    { type: "response_item", timestamp, payload: { type: "function_call", name: "exec_command", call_id: "unfinished", arguments: "{}" } },
  ] : [
    { type: "user", timestamp, message: { role: "user", content: "run this stage" } },
    { type: "assistant", timestamp, message: { role: "assistant", stop_reason: null,
      content: [{ type: "tool_use", id: "unfinished", name: "Bash", input: { command: "build" } }] } },
  ]);
  expect(await durableStageTurnEvidence(engine, transcript)).toMatchObject({ turn: "busy", message: null });
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `provider-idle-${engine}-registry.json`));
  const launchProfile = emptyLaunchProfile({ cwd: "/repo", project: "viewer" });
  registry.reconcileConversations([{ engine, path: transcript, accountId: "account-a", launchProfile,
    turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: timestamp }]);
  const conversation = registry.conversationForPath(transcript)!;
  const generation = conversation.generations.at(-1)!;
  registry.upsert({ key: { engine, sessionId: generation.id }, artifactPath: transcript, cwd: "/repo",
    accountId: "account-a", launchProfile, status: "idle", host: null,
    structuredHost: { kind: engine === "codex" ? "codex-app-server" : "claude-broker", endpoint: "stdio:fixture",
      process: null, eventCursor: 1, protocolVersion: "v2", writerClaimEpoch: 1,
      activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "fixture", pendingAction: null });
  attempt.agentPath = transcript;
  attempt.conversationId = conversation.id;
  attempt.sessionId = generation.id;
  attempt.hostEpoch = 1;
  attempt.effectiveRole.engine = engine;
  attempt.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
  lane.stages[0]!.effectiveRole = { ...attempt.effectiveRole };
  savePipelines([lane]);
  const originalPaths = h.ports.pathForConversation;
  h.ports.pathForConversation = (id) => id === conversation.id ? transcript : originalPaths(id);
  const originalAllowed = h.ports.sourcePathAllowed;
  h.ports.sourcePathAllowed = (file) => file === transcript || originalAllowed(file);
  h.ports.durableTurnEvidence = async (kind, file) => file === transcript
    ? await durableStageTurnEvidence(kind, file) : h.durableTurns.get(file) ?? null;
  h.setConversationActive(false);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.condition.kind).toBe("host_death");
  h.advanceWallClock(60_000);
  const open = { ...entry(transcript), activity: "live" as const, activityReason: "jsonl_turn_open" as const };
  // Reload the registry as startup does, retaining the persisted cut in the pipeline store.
  setAgentRegistryForTests(new AgentRegistry(registry.filename));
  try {
    await withRuntimeSnapshot(() => ({ runtime: { hostEpoch: 2 }, sessions: [
      { conversationId: conversation.id, host: "hosted", turn: "idle", attentionIds: [] },
    ] }), async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        const production = defaultPipelinePorts();
        expect(await production.conversationTurnInterrupted!(conversation.id)).toBe("idle");
        expect(await production.conversationAgentActive(conversation.id)).toBeNull();
        const recovered: PipelinePorts = { ...h.ports,
          conversationAgentActive: production.conversationAgentActive,
          conversationTurnInterrupted: production.conversationTurnInterrupted,
          conversationHostUnavailableSince: production.conversationHostUnavailableSince,
          runtimeHostEpoch: production.runtimeHostEpoch,
          restartRecoveryBootId: () => "provider-idle-restoration",
        };
        await tickPipelines([open], recovered);
        h.advanceWallClock(5 * 60_000);
      }
    });
    const attempts = loadPipelines()[0]!.runs[0]!.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.providerRecoveries?.filter((item) => item.action === "relaunch")).toHaveLength(1);
    expect(attempts[0]!.restartRecovery).toBeUndefined();
    expect(attempts[0]!.severedTurn).toBeUndefined();
    expect(h.spawnInputs).toHaveLength(2);
    expect(h.calls.filter((call) => call.startsWith("stop-host:"))).toHaveLength(1);
  } finally {
    setAgentRegistryForTests(null);
  }
});



test("review budget notes explain the fixed budget in both languages", async () => {
  const { parkedTaskNote } = await import("./taskStatusNote");
  for (const locale of ["en", "uk"] as const) {
    const note = parkedTaskNote("private diagnostics", locale, true, { kind: "review-budget" });
    expect(note).not.toContain("continue-review");
    expect(note).not.toContain("addRounds");
    expect(note).not.toContain("private diagnostics");
  }
});


test.each([false, true])("board actions refuse terminal budget extensions (legacy park: %s)", async (legacy) => {
  const { pipelineActionOptions } = await import("@/components/kanban/stagesModel");
  const { pipelineAnswers } = await import("@/components/pipelines/pipelineBlockModel");
  const h = movingHeadHarness(() => ORIGIN_MAIN_SHA);
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1 }, null) as never);
  const parked = (await driveLegacyTerminalRecheck(h)).pipeline;
  if (legacy) { delete parked.reviewPending; savePipelines([parked]); }
  expect(pipelineActionOptions(parked).find(option => option.action === "continue-review")?.refusal).toBe("budget-fixed");
  expect(pipelineAnswers(parked, stage => stage.id)).toBeNull();
  const revision = pipelineRevision(loadPipelines()[0]!);
  expect((await continueReview(parked, "legacy-extension", 2)).status).toBe(409);
  expect(pipelineRevision(loadPipelines()[0]!)).toBe(revision);
});



test.each(["en", "uk"] as const)("provider retry card gives operator-local time in %s", async locale => {
  const { parkedTaskNote } = await import("./taskStatusNote");
  const note = parkedTaskNote("", locale, false, { kind: "provider-retry", resumeAt: "2026-10-05T19:01:00.000Z", timeZone: "Europe/Kyiv" });
  expect(note).toContain("22:01");
  expect(note).toContain("Kyiv");
  expect(note).not.toContain("2026-10-05T19:01:00.000Z");
});



test("a large spare pool tries each allowed account once in the cut chain", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 2 * 60 * 60_000);
  const accounts = [LIMITED_ACCOUNT, ...Array.from({ length: 7 }, (_, n) => `spare-${n}`)];
  f.h.ports.allowedAccountIds = () => accounts;
  f.h.ports.resolveProjectSpawn = (_engine, request) => {
    const target = accounts.find(id => !request.unavailableIds?.includes(id));
    return target ? { kind: "available", account: { engine: "codex", accountId: target, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: accounts };
  };
  for (let n = 0; n < 12; n++) {
    const a = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    if (a.agentPath && loadPipelines()[0]!.state === "running") f.h.durableTurns.set(a.agentPath, { turn: "terminal", message: null,
      terminalProviderMessage: { text: "You've hit your usage limit", errorClass: "usage_limit_exceeded", ts: f.now(), usageLimit: { resetsAt: f.resetsAt } } });
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    f.advance(15_000);
  }
  expect(f.h.spawnInputs).toHaveLength(accounts.length);
  expect(f.h.spawnInputs.slice(1).map(input => input.requestedAccountId)).toEqual(accounts.slice(1));
  const attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(accounts.length);
  expect(attempts.at(-1)!.providerRecoveryBudget?.triedAccounts).toEqual(accounts);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});



test.each(["parked-retry", "fresh-failover"] as const)("provider recovery retains missing host ownership on %s", async path => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, path === "parked-retry");
  if (path === "parked-retry") {
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    await tickPipelines([], f.h.ports);
    f.advance(180_000);
  } else {
    f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: "/account-b", transcriptRoot: "/account-b/sessions", env: { NODE_ENV: "test" } } });
  }
  f.h.ports.conversationRegistered = () => false;
  f.h.ports.stopStageAgent = async () => ({ outcome: "not-running" });
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(lane.runs[0]!.attempts).toHaveLength(1);
  expect(lane.state).toBe("needs_decision");
  expect(lane.stateDetail).toContain("ownership");
  expect(lane.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
});


for (const engine of ["claude", "codex"] as const) {
  test(`${engine} account preflight fallback keeps the cut-chain budget with a large allowed pool`, async () => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
      "You've hit your session limit", 120_000);
    const spares = Array.from({ length: 8 }, (_, index) => `test-spare-${index}`);
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, ...spares];
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      const target = spares.find(id => !request.unavailableIds?.includes(id));
      return target ? { kind: "available", account: { engine, accountId: target, kind: "managed",
        home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, ...spares] };
    };
    const targets: (string | null | undefined)[] = [];
    f.h.ports.spawnAgent = async input => {
      targets.push(input.requestedAccountId);
      throw new (await import("@/lib/accounts/manager")).AccountAuthenticationRequiredError(engine, input.requestedAccountId!);
    };
    for (let tick = 0; tick < 12; tick++) await tickPipelines([], f.h.ports);
    expect(targets).toEqual(spares);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerRecoveryBudget?.tries).toBe(spares.length);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerRecoveryBudget?.failedAccounts).toEqual(spares);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerWait?.stageRetry).toBeDefined();
    expect(f.h.spawnInputs).toHaveLength(1);
  });
  test.each([{ cause: "auth", tries: 0 }, { cause: "tier", tries: 0 }, { cause: "auth", tries: 3 }, { cause: "tier", tries: 3 }] as const)(`${engine} account-specific preflight failure tries a third allowed account before parking ($cause, budget=$tries)`, async ({ cause, tries }) => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
      "You've hit your session limit", 120_000);
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    const third = "test-third-account";
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT, third];
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      const target = [SPARE_ACCOUNT, third].find(id => !request.unavailableIds?.includes(id));
      return target ? { kind: "available", account: { engine, accountId: target, kind: "managed",
        home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT, third] };
    };
    const baseSpawn = f.h.ports.spawnAgent;
    const targets: (string | null | undefined)[] = [];
    f.h.ports.spawnAgent = async (input, reserved) => {
      targets.push(input.requestedAccountId);
      if (input.requestedAccountId === SPARE_ACCOUNT) {
        if (cause === "tier") throw new (await import("@/lib/accounts/codexServiceTiers")).CodexServiceTierUnavailableError("required tier unavailable");
        throw new (await import("@/lib/accounts/manager")).AccountAuthenticationRequiredError(engine, SPARE_ACCOUNT);
      }
      return baseSpawn(input, reserved);
    };
    for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
    expect(targets).toEqual([SPARE_ACCOUNT, third]);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerRecoveryBudget?.tries).toBe(tries + 2);
    expect(loadPipelines()[0]!.cursor?.state).toBe("running");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(third);
    expect(f.h.spawnInputs).toHaveLength(2);
  });
}



for (const engine of ["claude", "codex"] as const) {
  test.each(["pipeline", "startup-recovery", "operator"] as const)(`${engine} quota continuation trusts delivered %s authorship`, async author => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const cutAt = f.now();
    await tickPipelines([], f.h.ports);
    f.advance(180_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(1);
    const text = "This stage was cut by session limit. Continue the same stage from its current worktree, keeping uncommitted work, and report when complete.";
    f.advance(1_000);
    const promptAt = f.h.ports.now();
    const origin = author !== "operator" ? { kind: "agent" as const, role: author } : { kind: "operator" as const };
    let records: Record<string, unknown>[];
    if (engine === "claude") {
      records = [{ type: "user", uuid: "continued-prompt", timestamp: promptAt, promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: text } }];
    } else {
      const { persistStructuredUserMetadata } = await import("@/lib/selection/structuredUserMetadata");
      const { structuredContentDigest } = await import("@/lib/runtime/structuredContent");
      const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText");
      const ref = await persistStructuredUserMetadata({ version: 1, contentDigest: structuredContentDigest({ text, images: [] }), selectedContext: null, origin });
      records = [{ type: "event_msg", timestamp: promptAt, payload: { type: "user_message", message: encodeCodexStructuredUserText(text, ref) } },
        { type: "event_msg", timestamp: promptAt, payload: { type: "task_started" } }];
    }
    f.advance(500);
    records.push(engine === "claude" ? { type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", error: { message: "You've hit your session limit", codex_error_info: "usage_limit_exceeded" } } });
    records.unshift(providerQuotaRecord(engine, cutAt));
    const file = stageTranscript(`own-provider-continuation-${engine}-${author}`, records);
    if (engine === "claude") {
      const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
      const ledger = new FileClaudeDeliveryLedger();
      const session = path.basename(file, ".jsonl");
      ledger.recordQueued(session, { id: f.sends[0]!, text, origin }, "turn-started");
      ledger.confirmDelivered(session, f.sends[0]!, "continued-prompt");
    }
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(30 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(author !== "operator" ? 2 : 1);
    if (author === "operator") expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
    else expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.tries).toBe(2);
  });
}



test.each(["image", "large-tail", "human-before-harness"] as const)("a quota reply remains external through %s evidence", async shape => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  await tickPipelines([], f.h.ports);
  const oldCutAt = f.h.ports.now();
  f.advance(1_000);
  const records: Record<string, unknown>[] = [
    { type: "assistant", timestamp: oldCutAt, isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } },
    { type: "user", timestamp: f.h.ports.now(), promptSource: "sdk", message: { content: shape === "image" ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] : "Wait for my answer" } },
  ];
  if (shape !== "image") records.push({ type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(150_000) });
  if (shape === "human-before-harness") {
    f.advance(500);
    records.push({ type: "user", timestamp: f.h.ports.now(), origin: { kind: "task-notification" }, promptSource: "system", message: { content: "<task-notification>done</task-notification>" } });
  }
  f.advance(500);
  records.push({ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } });
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript("quota-reply-evidence", records) });
  await tickPipelines([], f.h.ports);
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
});



test.each(["claude", "codex"] as const)("%s reply racing continuation admission prevents automatic delivery", async engine => {
  const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
  await tickPipelines([], f.h.ports);
  f.advance(180_000);
  let policy: string | undefined;
  f.h.ports.resumeSeveredTurn = async input => {
    policy = input.policy;
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1,
      prompts: [{ ts: f.now() + 1, origin: "external" }] });
    f.h.setConversationActive(true);
    if (input.continuationAllowed && !await input.continuationAllowed()) return false;
    f.sends.push(input.clientMessageId);
    return true;
  };
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(policy).toBe("queue");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.tries).toBe(0);
});


test.each([
  ["pause", "acknowledged"], ["close", "acknowledged"], ["pause", "lost-acknowledgment"], ["close", "lost-acknowledgment"],
  ["pause", "transport-error"], ["close", "transport-error"],
] as const)("%s invalidates an admitted provider continuation before dispatch with %s", async (action, acknowledgment) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { invalidateProviderContinuation } = await import("./engine");
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, `continuation-${action}-${acknowledgment}.sqlite`), { structuredHosts: true });
  const conversationId = loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId!;
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: "continuation-generation" }, hostKind: "codex-app-server",
    host: "hosted", turn: "idle", activeTurnId: null, writerClaim: "fixture:1", attentionIds: [],
    capabilities: { steer: true, structuredAttention: true },
  } });
  let operationId = "";
  f.h.ports.resumeSeveredTurn = async input => {
    if (input.continuationAllowed && !await input.continuationAllowed()) return false;
    const session = journal.readSession({ conversationId })!;
    operationId = input.clientMessageId;
    journal.executeOperation({ kind: "send", conversationId, operationId, idempotencyKey: operationId, text: input.text,
      policy: "queue", turnId: null, onlyIfIdle: { revision: session.revision, writerClaim: session.writerClaim! } });
    if (acknowledgment === "transport-error") throw new Error("runtime acknowledgment lost");
    return acknowledgment === "acknowledged";
  };
  f.h.ports.invalidateProviderContinuation = id => invalidateProviderContinuation(id, {
    append: async event => journal.append(event),
  } as import("@/lib/runtime/client").RuntimeHostClient);
  try {
    await tickPipelines([], f.h.ports);
    f.advance(180_000);
    await tickPipelines([], f.h.ports);
    // A new Viewer reads the pending intent before applying operator control.
    const requestedAt = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.continuationRequestedAt;
    expect((await patchPipeline(loadPipelines()[0]!.id, { action }, { ...f.h.ports })).error).toBeUndefined();
    expect(journal.transitionOperation(operationId, "delivering").receipt).toMatchObject({ status: "failed", reason: "idle-continuation-pre-execution-refused" });
    expect(requestedAt).toBeDefined();
  } finally { journal.close(); }
});



for (const engine of ["claude", "codex"] as const) {
  for (const largeTail of [false, true]) {
    test.each(engine === "claude" ? ["operator", "pipeline", "initial", "harness"] as const : ["operator", "pipeline", "initial"] as const)(`${engine} first recovery tick respects a prior %s prompt (large tail=${largeTail})`, async author => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
      const initial = f.now();
      const nativeNotice = (at: number) => engine === "claude"
        ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
          message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
        : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } };
      f.advance(1_000);
      const promptTime = author === "initial" ? initial - 1_000 : f.now();
      const text = "Continue work on this stage";
      let prompt: Record<string, unknown>;
      if (engine === "claude") prompt = { type: "user", uuid: "first-tick-prompt", timestamp: new Date(promptTime).toISOString(),
        ...(author === "harness" ? { origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptSource: "system" } : { turnOrigin: "sdk", promptSource: "sdk" }), message: { content: text } };
      else {
        const { persistStructuredUserMetadata } = await import("@/lib/selection/structuredUserMetadata");
        const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText");
        const { structuredContentDigest } = await import("@/lib/runtime/structuredContent");
        const ref = await persistStructuredUserMetadata({ version: 1, contentDigest: structuredContentDigest({ text, images: [] }), selectedContext: null,
          origin: author === "pipeline" ? { kind: "agent", role: "pipeline" } : { kind: "operator" } });
        prompt = { type: "event_msg", timestamp: new Date(promptTime).toISOString(), payload: { type: "user_message", message: encodeCodexStructuredUserText(text, ref) } };
      }
      f.advance(500);
      const records: Record<string, unknown>[] = author === "initial" ? [prompt, nativeNotice(initial)] : [nativeNotice(initial), prompt];
      if (largeTail) records.push({ type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(150_000) });
      records.push(nativeNotice(f.now()));
      const file = stageTranscript(`first-provider-tick-${engine}-${author}-${largeTail}`, records);
      if (engine === "claude" && author === "pipeline") await stampPipelinePrompt(file, "first-tick-prompt", text);
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
      await tickPipelines([], f.h.ports);
      f.advance(31 * 60_000);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(author === "operator" ? 0 : 1);
      expect(f.h.spawnInputs).toHaveLength(1);
      if (author === "operator") {
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
      }
    });
  }
  test(`${engine} first recovery tick bounds incomplete prompt history`, async () => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const notice = (at: number) => engine === "claude"
      ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } };
    const first = notice(f.now());
    f.advance(1_000);
    const file = stageTranscript(`first-tick-history-bound-${engine}`, [first,
      { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(9 * 1024 * 1024) }, notice(f.now())]);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(11 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(0);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("prompt history is incomplete");
  });
}



for (const engine of ["claude", "codex"] as const) {
  test.each([3, 5])(`${engine} an untried allowed account remains eligible in a %i account pool after the retry budget`, async count => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 2 * 60 * 60_000);
    const pool = [LIMITED_ACCOUNT, SPARE_ACCOUNT, "fixture-account-c", "fixture-account-d", "fixture-account-e"].slice(0, count);
    const tried = pool.slice(0, -1);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.accountId = tried.at(-1)!;
    attempt.providerRecoveryBudget = { tries: 4, startedAt: f.h.ports.now(), engine, triedAccounts: tried };
    attempt.usageLimitedAccounts = tried.map(accountId => ({ accountId, engine, limitedAt: f.now() - 1_000, resetsAt: f.resetsAt }));
    savePipelines([lane]);
    f.h.ports.accountForTranscript = () => ({ accountId: tried.at(-1)!, label: "current account" });
    f.h.ports.allowedAccountIds = () => pool;
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      const selected = selectProjectAccount({ ...request, engine, now: f.now(),
        accounts: pool.map(id => ({ id, authPresent: true })), observations: [],
        bindings: pool.map(accountId => ({ engine, accountId, project: lane.project, createdAt: f.h.ports.now() })),
      });
      return selected.kind === "available" ? { kind: "available", account: { engine, accountId: selected.accountId!, kind: "managed",
        home: "/fixture-account", transcriptRoot: "/fixture-account/sessions", env: { NODE_ENV: "test" } } } : selected;
    };
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(pool.at(-1)!);
    const successor = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(successor.providerRecoveryBudget?.tries).toBe(5);
    expect(successor.providerRecoveryBudget?.triedAccounts).toEqual(pool);
    f.advance(1_000);
    f.h.setConversationActive(false);
    f.h.ports.accountForTranscript = () => ({ accountId: pool.at(-1)!, label: "last account" });
    f.h.durableTurns.set(successor.agentPath!, { turn: "terminal", message: null, terminalProviderMessage: {
      text: "You've hit your session limit", errorClass: engine === "claude" ? "rate_limit" : "usage_limit_exceeded", ts: f.now(), usageLimit: { resetsAt: f.resetsAt },
    } });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("every allowed account was tried");
    expect(f.h.spawnInputs).toHaveLength(2);
  });

}


for (const parked of [false, true]) {
  for (const shape of ["UserMessage", "userMessage", "user_message", "response_item"] as const) {
    test.each(["operator", "pipeline", "startup-recovery"] as const)(`native Codex ${shape} %s authorship controls quota recovery (parked=${parked})`, async author => {
      const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
      if (parked) {
        const lane = loadPipelines()[0]!;
        lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
        savePipelines([lane]);
      }
      await tickPipelines([], f.h.ports);
      const oldCut = f.now();
      f.h.ports.resolveProjectSpawn = () => f.now() >= f.resetsAt! * 1_000 + 60_000
        ? { kind: "available", account: { engine: "codex", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] };
      f.advance(1_000);
      const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
      const automatic = author === "pipeline" || author === "startup-recovery";
      const wire = await encodeCodexStructuredUserText("Continue the same stage", undefined, null,
        { kind: "agent", role: author === "startup-recovery" ? author : "pipeline" });
      const text = author === "operator" ? "Wait for my answer" : wire;
      const prompt = shape === "user_message" ? { type: "event_msg", payload: { type: "user_message", message: text } }
        : shape === "response_item" ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }
        : { type: "event_msg", payload: { type: "item_completed", item: { type: shape, content: [{ type: "text", text: text.slice(0, 20) }, { type: "text", text: text.slice(20) }] } } };
      const notice = (at: number) => ({ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } });
      const file = stageTranscript(`native-codex-author-${shape}-${author}-${parked}`, [notice(oldCut),
        { ...prompt, timestamp: f.h.ports.now() }, { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } },
        { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "token_count", info: { rate_limits: { primary: { used_percent: 100, resets_at: f.resetsAt } } } } }, notice(f.now() + 500)]);
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      await tickPipelines([], f.h.ports);
      if (parked && automatic) expect(loadPipelines()[0]!.stateDetail).toMatch(/Automatic retry|Автоповтор/);
      f.advance(31 * 60_000);
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(!parked && automatic ? 1 : 0);
      expect(f.h.spawnInputs).toHaveLength(parked && automatic ? 2 : 1);
      if (!automatic) expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
    });
  }
}
