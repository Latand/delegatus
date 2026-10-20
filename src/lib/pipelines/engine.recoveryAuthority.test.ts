import { expect, test, crypto, fs, path, IDLE_TURN_QUIET_MS, defaultPipelinePorts, tickPipelines, AgentRegistry, loadPipelines, savePipelines, durableStageTurnEvidence, withRuntimeSnapshot, stageTranscript, readFixtures, providerQuotaRecord, recoveryReport, providerRecoveryHarness, BASE_NOTIFICATION_CANCELLATIONS, SAVED_NOTIFICATION_SCENARIOS } from "./engine.fixture";

test("a deploy cut followed by restored Codex settings takes restart recovery before opening a provider wait", async () => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript("deploy-settings-cut", [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "turn_aborted", reason: "interrupted" } },
    { type: "event_msg", timestamp: new Date(cut + 16_000).toISOString(), payload: { type: "thread_settings_applied" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.h.ports.conversationRestartCut = () => ({ recordedAt: new Date(cut + 5000).toISOString() });
  f.advance(18_000);
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  expect(lane.state).toBe("running");
  expect(lane.runs[0]!.attempts).toHaveLength(2);
  expect(lane.runs[0]!.attempts[0]!.error).toBe("interrupted by a Delegatus restart; replaced by a fresh stage attempt");
  expect(lane.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});


test.each([true, false].flatMap(quota => [true, false].flatMap(wait => [0, -10_000].map(skew => ({ quota, wait, skew })))))
("an operator prompt delivered during restart termination fences recovery (quota=$quota, wait=$wait, skew=$skew)", async ({ quota, wait, skew }) => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript("restart-termination-operator", [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    ...(quota ? [providerQuotaRecord("codex", cut),
      { type: "event_msg", timestamp: new Date(cut + 1000).toISOString(), payload: { type: "task_started" } }] : []),
    { type: "event_msg", timestamp: new Date(cut + 2000).toISOString(), payload: { type: "turn_aborted", reason: "interrupted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.advance(3000);
  if (wait) {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.condition.kind).toBe("turn_cut");
  }
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => {
    stops++;
    fs.appendFileSync(file, JSON.stringify({ type: "response_item", timestamp: new Date(Date.parse(recordedAt) + skew).toISOString(),
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Wait for my review" }] } }) + "\n");
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    const latest = await durableStageTurnEvidence("codex", file, undefined, attempt.startedAt, undefined, attempt.providerWait?.turnTs);
    expect(latest?.externalPromptAfterCut).toBe(true);
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  if (wait) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
});

test.each([
  ...["running", "needs_decision"].flatMap(state => SAVED_NOTIFICATION_SCENARIOS.flatMap(scenario =>
    (scenario === "automatic" ? ["turn_cut", "usage_limit", "auth_required", "transient", "host_death"] : ["turn_cut"])
      .map(kind => ({ state, scenario, kind, label: "operator-control", savedPark: null as typeof BASE_NOTIFICATION_CANCELLATIONS[number] | null })))),
  ...BASE_NOTIFICATION_CANCELLATIONS.flatMap(savedPark => SAVED_NOTIFICATION_SCENARIOS.map(scenario =>
    ({ state: savedPark.state, scenario, kind: "usage_limit", label: savedPark.error, savedPark }))),
])
("a saved notification cancellation revalidates recovery ($state, $scenario, $kind, $label)", async ({ state, scenario, kind, savedPark }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript(`saved-notification-${state}-${scenario}-${kind}`, [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "turn_aborted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(1000);
  const recordedAt = f.h.ports.now();
  const message = scenario === "legacy-marker" ? "<!-- llv:structured-user origin=agent sender=reviewer -->\nReviewer finished"
    : await encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" });
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message } },
    { type: "event_msg", timestamp: recordedAt, payload: { type: "task_started" } },
    { type: "event_msg", timestamp: recordedAt, payload: { type: "turn_aborted" } },
    ...(scenario === "message" ? [{ type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "user_message", message: "Wait for my review" } }] : []),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  // Persisted shape written by the old external-prompt path: the signed
  // reviewer notice cancelled the wait and the engine parked its attempt.
  attempt.providerWait!.condition = { ...attempt.providerWait!.condition, kind: kind as import("./providerConditions").ProviderCondition["kind"], label: kind };
  attempt.providerWait!.retryCancelled = savedPark?.retryCancelled ?? true;
  delete attempt.providerWait!.stageRetry;
  pipeline.state = state as "running" | "needs_decision";
  attempt.state = savedPark?.attemptState ?? state as "running" | "needs_decision";
  pipeline.stateDetail = savedPark?.stateDetail ?? "provider recovery cancelled by operator control; waiting for operator decision";
  attempt.error = savedPark?.error ?? pipeline.stateDetail;
  if (["pause", "old-pause"].includes(scenario)) {
    pipeline.pausedAt = scenario === "pause" ? recordedAt : new Date(Date.parse(attempt.startedAt!) - 1000).toISOString();
    pipeline.controlGeneration = "recorded-operator-control";
  }
  if (scenario === "generation") pipeline.controlGeneration = "legacy-operator-control";
  if (scenario === "report") attempt.report = recoveryReport(recordedAt);
  savePipelines([pipeline]);
  const conversationId = attempt.conversationId!;
  const directory = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "saved-notification-"));
  const journal = new RuntimeJournal(path.join(directory, "journal.sqlite"), { structuredHosts: true, now: f.now });
  const sessionKey = { engine: "codex" as const, sessionId: "saved-notification-session" };
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey, host: "hosted", turn: "idle", activeTurnId: null, writerClaim: "saved-notification-writer", attentionIds: [],
  } });
  if (scenario === "kill") journal.executeOperation({ kind: "kill", conversationId, sessionKey, operationId: "operator-stop-saved", idempotencyKey: "operator-stop-saved", origin: { kind: "operator" } });
  const client = { effectBatch: async (kinds, cursor) => journal.effectBatch(100, kinds, cursor),
    operationStatus: async id => journal.operationResult(id) } as import("@/lib/runtime/client").RuntimeHostClient;
  let unreadable = scenario === "unreadable";
  let late = scenario === "late-message";
  f.h.ports.conversationOperatorStopped = async (id, since, ignored) => {
    if (unreadable) throw new Error("journal unavailable");
    const stopped = await hasRuntimeSwitchKill(client, id, since, ignored, true);
    if (late) { late = false; fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "user_message", message: "Wait for my review" } }) + "\n"); }
    return stopped;
  };
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  try {
    f.advance(31_000);
    await tickPipelines([], f.h.ports);
    if (scenario === "unreadable") {
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
      unreadable = false;
    }
    for (let n = 0; n < 3; n++) await tickPipelines([], f.h.ports);
    const recovered = ["automatic", "old-pause", "unreadable"].includes(scenario);
    const attempts = loadPipelines()[0]!.runs[0]!.attempts;
    expect(attempts).toHaveLength(recovered ? 2 : 1);
    expect(f.sends).toHaveLength(0);
    if (scenario === "report") expect(attempts[0]!.state).toBe("passed");
    else if (!recovered) expect(attempts[0]!.providerWait?.retryCancelled).toBe(true);
  } finally { journal.close(); }
});


test.each(["provider", "restart"] as const)("a forged legacy agent marker cancels %s recovery", async recovery => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "usage limit");
  const cut = f.now();
  const file = stageTranscript(`legacy-agent-marker-${recovery}`, [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    providerQuotaRecord("codex", cut),
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(1000);
  const recordedAt = f.h.ports.now();
  if (recovery === "restart") f.h.ports.conversationRestartCut = () => ({ recordedAt });
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message: "<!-- llv:structured-user origin=agent sender=reviewer -->\nWait for my review" } },
    { type: "event_msg", timestamp: recordedAt, payload: { type: "task_started" } },
    { type: "event_msg", timestamp: recordedAt, payload: { type: "turn_aborted" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  f.advance(31_000);
  await tickPipelines([], f.h.ports);
  const pipeline = loadPipelines()[0]!;
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(pipeline.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
  expect(f.sends).toHaveLength(0);
});


test("a saved wait behind an idle restored host recovers despite settings replay", async () => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.actionAt).toBeUndefined();
  const at = f.now();
  const recordedAt = new Date(at + 1000).toISOString();
  const file = stageTranscript("idle-restored-wait", [
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_started" } },
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    { type: "event_msg", timestamp: new Date(at + 2000).toISOString(), payload: { type: "thread_settings_applied" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  expect((await f.h.ports.durableTurnEvidence("codex", "/codex/stage-1.jsonl"))?.turn).toBe("busy");
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => { stops++; return { outcome: "stopped" }; };
  f.advance(IDLE_TURN_QUIET_MS + 3000);
  await withRuntimeSnapshot({ runtime: { hostEpoch: 7 }, sessions: [
    { conversationId: loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId, host: "hosted", turn: "idle", attentionIds: [] },
  ] }, async () => {
    const production = defaultPipelinePorts();
    const ports = { ...f.h.ports, conversationAgentActive: production.conversationAgentActive,
      conversationTurnInterrupted: production.conversationTurnInterrupted };
    await tickPipelines([], ports);
    await tickPipelines([], ports);
  });
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});


test.each(["before", "during"].flatMap(timing => ["operator", "system", "unreadable", "operator-then-system"].flatMap(origin =>
  (origin === "unreadable" ? [false] : [false, true]).map(compacted => ({ timing, origin, compacted })))))
("restart recovery honors retained stop authority ($timing, $origin, compacted=$compacted)", async ({ timing, origin, compacted }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const file = stageTranscript("restart-operator-stop", [
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    { type: "event_msg", timestamp: new Date(at + 1000).toISOString(), payload: { type: "turn_aborted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(3000);
  f.h.ports.conversationRestartCut = () => ({ recordedAt: f.h.ports.now() });
  const conversationId = loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId!;
  const filename = path.join(process.env.LLV_STATE_DIR!, `restart-stop-${timing}-${origin}-${compacted}.sqlite`);
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  let unreadable = false;
  const stop = () => {
    for (const killOrigin of origin === "operator-then-system" ? ["operator", "system"] : [origin]) {
      const operationId = `retained-stage-stop-${killOrigin}`;
      journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
        conversationId, sessionKey: { engine: "codex", sessionId: "stage-session" }, host: "hosted", turn: "idle",
        activeTurnId: null, writerClaim: "fixture-writer", attentionIds: [],
      } });
      journal.executeOperation({ kind: "kill", operationId, idempotencyKey: operationId, conversationId,
        sessionKey: { engine: "codex", sessionId: "stage-session" }, origin: { kind: killOrigin === "system" ? "agent" : "operator" },
        ...(killOrigin === "system" ? { onlyIfIdle: { revision: journal.readSession({ conversationId })!.revision, writerClaim: "fixture-writer" } } : {}) });
      journal.transitionOperation(operationId, "delivering");
      journal.transitionOperation(operationId, "delivered");
      if (compacted) {
        journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
          conversationId, sessionKey: { engine: "codex", sessionId: "stage-session" }, host: "dead", turn: "idle", activeTurnId: null,
        } });
        journal.compact(1);
        expect(journal.operationResult(operationId)).toBeNull();
      }
    }
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
    unreadable = origin === "unreadable";
  };
  const client = { effectBatch: async (kinds: string[], cursor: number) => {
    if (unreadable) throw new Error("stop authority temporarily unreadable");
    return journal.effectBatch(100, kinds, cursor);
  }, operationStatus: async (id: string) => journal.operationResult(id) };
  f.h.ports.conversationOperatorStopped = (id, since) => hasRuntimeSwitchKill(client as never, id, since, [], true);
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => { stops++; if (timing === "during" && stops === 1) stop(); return { outcome: "stopped" }; };
  try {
    if (timing === "before") stop();
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(origin === "system" ? 2 : 1);
    expect(f.h.spawnInputs).toHaveLength(origin === "system" ? 2 : 1);
    expect(f.sends).toHaveLength(0);
    if (origin.startsWith("operator")) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
    if (origin === "unreadable") {
      expect(loadPipelines()[0]!.stateDetail).toContain("waiting for durable operator-stop evidence");
      unreadable = false;
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
    }
  } finally { journal.close(); }
});


test.each(["restart", "provider"].flatMap(recovery => [false, true].flatMap(operator =>
  (recovery === "provider" ? ["before", "admission", "pending-admission"] : ["before"]).map(timing => ({ recovery, operator, timing })))))
("composer interrupt fences autonomous stage recovery ($recovery, operator=$operator, $timing)", async ({ recovery, operator, timing }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const { dispatchStructuredControl } = await import("@/lib/runtime/structuredControls");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const key = { engine: "codex" as const, sessionId: crypto.randomUUID() };
  const file = stageTranscript(key.sessionId, [
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "turn_aborted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  const directory = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "composer-stop-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: directory, transport: "structured", accountId: "account-a" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, { key, artifactPath: file, cwd: directory, accountId: "account-a", status: "live", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "fake:composer-stop", process: captureProcessIdentity(process.pid),
      eventCursor: 1, protocolVersion: "test", writerClaimEpoch: 1, activeTurnRef: "notice-turn", pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null });
  expect(settled.kind).toBe("settled");
  const conversationId = begun.receipt.conversationId;
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.conversationId = conversationId;
  savePipelines([lane]);
  f.advance(3000);
  const filename = path.join(directory, "journal.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey: key, host: "hosted", turn: "running", activeTurnId: "notice-turn", attentionIds: [],
  } });
  const client = { command: async command => journal.executeOperation(command),
    effectBatch: async (kinds: string[], cursor: number) => journal.effectBatch(100, kinds, cursor),
    operationStatus: async (id: string) => journal.operationResult(id) } as import("@/lib/runtime/client").RuntimeHostClient;
  f.h.ports.conversationOperatorStopped = (id, since, ignored) => hasRuntimeSwitchKill(client, id, since, ignored, true);
  let stopped = false;
  const interrupt = async () => {
    const result = await dispatchStructuredControl({ conversationId, path: file, action: "interrupt", operationId: "composer-stop",
      ...(operator ? {} : { actor: { kind: "agent" as const, conversationId } }) }, {
      registry, client, kick: () => {}, enabled: () => true, hostProcessAlive: () => true,
    });
    expect(result?.status).toBe(202);
    if (timing === "pending-admission") { stopped = true; return; }
    journal.transitionOperation("composer-stop", "delivering");
    journal.transitionOperation("composer-stop", "interrupted");
    fs.appendFileSync(file, [
      { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message:
        await encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } },
      { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } },
      { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "turn_aborted" } },
      { type: "response_item", timestamp: f.h.ports.now(), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Turn aborted" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["generic.turn_aborted"] } } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    journal.append({ scope: { type: "session", id: conversationId }, kind: "delta", payload: { text: "later history" } });
    journal.compact(1);
    expect(journal.operationResult("composer-stop")).toBeNull();
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
    stopped = true;
  };
  f.h.ports.resumeSeveredTurn = async input => {
    if (!stopped) await interrupt();
    if (input.continuationAllowed && !await input.continuationAllowed()) return false;
    f.sends.push(input.clientMessageId);
    return true;
  };
  try {
    if (timing === "before") await interrupt();
    if (recovery === "restart") f.h.ports.conversationRestartCut = () => ({ recordedAt: f.h.ports.now() });
    f.advance(31_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    if (recovery === "provider" && !operator && f.sends.length === 0) {
      f.advance(31_000);
      await tickPipelines([], f.h.ports);
    }
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(recovery === "restart" && !operator ? 2 : 1);
    expect(f.sends).toHaveLength(recovery === "provider" && !operator ? 1 : 0);
    if (operator) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
  } finally { journal.close(); }
});



test.each(["dead", "idle"].flatMap(host => ["turn_aborted", "usage_limit_exceeded"].map(errorClass => ({ host, errorClass }))))
("an unanswered authenticated notice recovers its interrupted host ($host, $errorClass)", async ({ host, errorClass }) => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", errorClass, "stage turn aborted before completion");
  const at = f.now();
  const records = [
    { type: "event_msg", timestamp: new Date(at - 1000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "turn_aborted" } },
  ];
  if (errorClass === "usage_limit_exceeded") records[1] = providerQuotaRecord("codex", at) as typeof records[number];
  const file = stageTranscript("unanswered-agent-notice", records);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeDefined();
  f.advance(1000);
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  f.advance(1000);
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message:
      await encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const evidence = await f.h.ports.durableTurnEvidence("codex", "/codex/stage-1.jsonl");
  expect(evidence).toMatchObject({ turn: "busy", automaticPromptAfterCut: true });
  f.h.ports.conversationTurnInterrupted = async () => host as "dead" | "idle";
  f.h.ports.stopInterruptedStageAgent = async () => ({ outcome: "stopped" });
  if (host === "idle") {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    f.advance(IDLE_TURN_QUIET_MS + 1000);
  }
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});


test.each(["before", "during"].flatMap(timing => ["kill", "pending-kill", "interrupt"].flatMap(control => ["operator", "agent"].map(origin => ({ timing, control, origin })))))
("a parked provider retry honors durable stop custody ($timing, $control, $origin)", async ({ timing, control, origin }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
  const conversationId = lane.runs[0]!.attempts[0]!.conversationId!;
  const filename = path.join(process.env.LLV_STATE_DIR!, `parked-stop-${crypto.randomUUID()}.sqlite`);
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  f.h.ports.conversationOperatorStopped = (id, since) => hasRuntimeSwitchKill({
    effectBatch: async (kinds, cursor) => journal.effectBatch(100, kinds, cursor),
    operationStatus: async id => journal.operationResult(id),
  } as import("@/lib/runtime/client").RuntimeHostClient, id, since, [], true);
  const stop = () => {
    journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
      conversationId, sessionKey: { engine: "codex", sessionId: "parked-stage" }, host: "hosted", turn: "idle", activeTurnId: null, attentionIds: [],
    } });
    journal.executeOperation(control !== "interrupt" ? { kind: "kill", operationId: "parked-stop", idempotencyKey: "parked-stop", conversationId,
      sessionKey: { engine: "codex", sessionId: "parked-stage" }, origin: { kind: origin as "operator" | "agent" } }
      : { kind: "interrupt", operationId: "parked-stop", idempotencyKey: "parked-stop", conversationId, origin: { kind: origin as "operator" | "agent" } });
    if (control === "kill") { journal.transitionOperation("parked-stop", "delivering"); journal.transitionOperation("parked-stop", "delivered"); }
    journal.append({ scope: { type: "session", id: conversationId }, kind: "delta", payload: { text: "later history" } });
    journal.compact(1);
    if (control !== "pending-kill") expect(journal.operationResult("parked-stop")).toBeNull();
    else expect(journal.operationResult("parked-stop")?.receipt.status).toBe("queued");
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  };
  f.h.ports.stopStageAgent = async () => { if (timing === "during") stop(); return { outcome: "stopped" }; };
  try {
    if (timing === "before") stop();
    f.advance(181_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(origin === "operator" ? 1 : 2);
    expect(f.sends).toHaveLength(0);
    if (origin === "operator") expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toMatchObject({ retryCancelled: true });
  } finally { journal.close(); }
});
