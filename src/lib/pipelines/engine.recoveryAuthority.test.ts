import { expect, test, crypto, spawn, fs, path, IDLE_TURN_QUIET_MS, defaultPipelinePorts, tickPipelines, AgentRegistry, loadPipelines, savePipelines, durableStageTurnEvidence, patchPipeline, withRuntimeSnapshot, LIMITED_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, recoveryReport, providerRecoveryHarness, BASE_NOTIFICATION_CANCELLATIONS, SAVED_NOTIFICATION_SCENARIOS } from "./engine.fixture";

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
    : encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" });
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
        encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } },
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
      encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } },
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

test("a parked retry survives temporarily unreadable operator-stop authority", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  const before = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry;
  expect(before).toBeDefined();
  f.h.ports.conversationOperatorStopped = async () => { throw new Error("temporary journal read failure"); };
  f.advance(181_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("waiting for durable operator-stop evidence");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toEqual(before);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.h.ports.conversationOperatorStopped = async () => false;
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: LIMITED_ACCOUNT,
    kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});

test("a delayed automatic host-death kill keeps recovery custody after compaction and restart", async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const f = await providerRecoveryHarness("codex", "host_death", "stage host died without output");
  // A confirmed host-death wait uses the relaunch path independently of turn interruption.
  f.h.ports.conversationTurnInterrupted = async () => null;
  const lane = loadPipelines()[0]!;
  const conversationId = lane.runs[0]!.attempts[0]!.conversationId!;
  lane.runs[0]!.attempts[0]!.providerWait = { condition: { kind: "host_death", label: "stage host died without output", scope: null, resetLabel: null },
    accountId: null, text: "stage host died without output", turnTs: f.now(), tries: 0, startedAt: f.h.ports.now(), resumeAt: f.h.ports.now(), resetsAt: null };
  savePipelines([lane]);
  const filename = path.join(process.env.LLV_STATE_DIR!, "delayed-auto-stop.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: "delayed-stage" }, host: "hosted", turn: "running", activeTurnId: "old-turn", attentionIds: [],
  } });
  f.h.ports.conversationOperatorStopped = (id, since) => hasRuntimeSwitchKill({
    effectBatch: async (kinds, cursor) => journal.effectBatch(100, kinds, cursor), operationStatus: async id => journal.operationResult(id),
  } as import("@/lib/runtime/client").RuntimeHostClient, id, since, [], true);
  let calls = 0;
  f.h.ports.stopStageAgent = async (_target, options) => {
    expect(options?.automatic).toBe(true);
    if (++calls === 1) {
      journal.executeOperation({ kind: "kill", operationId: "delayed-recovery-kill", idempotencyKey: "delayed-recovery-kill", conversationId,
        sessionKey: { engine: "codex", sessionId: "delayed-stage" }, origin: { kind: "agent", role: "pipeline" } });
      return { outcome: "unconfirmed", operationId: "delayed-recovery-kill", detail: "waiting for host confirmation" };
    }
    return { outcome: "not-running" };
  };
  try {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    journal.transitionOperation("delayed-recovery-kill", "delivering");
    journal.transitionOperation("delayed-recovery-kill", "delivered");
    journal.append({ scope: { type: "session", id: conversationId }, kind: "delta", payload: { text: "later history" } });
    journal.compact(1);
    expect(journal.operationResult("delayed-recovery-kill")).toBeNull();
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
    f.advance(31_000);
    await tickPipelines([], { ...f.h.ports, restartRecoveryBootId: () => "next-boot" });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.sends).toHaveLength(0);
  } finally { journal.close(); }
});

test.each([false, true])("post-stop authority lookup fences a delivered prompt (operator=%s)", async operator => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const file = stageTranscript("post-authority-prompt", [
    { type: "event_msg", timestamp: new Date(at - 1000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "turn_aborted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(3000);
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let stopped = false;
  let appended = false;
  f.h.ports.stopInterruptedStageAgent = async () => { stopped = true; return { outcome: "stopped" }; };
  f.h.ports.conversationOperatorStopped = async () => {
    if (stopped && !appended) {
      appended = true;
      fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message: operator
        ? "Wait for my review" : encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } }) + "\n");
    }
    return false;
  };
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(operator ? 1 : 2);
  expect(f.sends).toHaveLength(0);
  if (operator) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
});

test.each(["unavailable", "incomplete"].flatMap(evidence => ["busy", "abort"].flatMap(turn => [false, true].flatMap(operator =>
  (operator ? [0, 1000] : [0]).map(skew => ({ evidence, turn, operator, skew }))))))
("restart recovery retains its boundary until post-stop evidence is verified ($evidence, $turn, operator=$operator, skew=$skew)", async ({ evidence, turn, operator, skew }) => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript("restart-post-stop-evidence", [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    ...(turn === "abort" ? [{ type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "turn_aborted" } }] : []),
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  if (turn === "abort") await tickPipelines([], f.h.ports);
  const wait = structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait);
  f.advance(3000);
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  const read = f.h.ports.durableTurnEvidence;
  let unverified = false;
  let stops = 0;
  f.h.ports.durableTurnEvidence = async (...args) => {
    const durable = await read(...args);
    return !unverified ? durable : evidence === "unavailable" ? null
      : { ...durable!, promptHistoryComplete: false, externalPromptAfterCut: undefined, prompts: [], promptCount: undefined, lastExternalPromptIndex: undefined };
  };
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (++stops === 1) {
      if (operator) fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: new Date(Date.parse(recordedAt) + skew).toISOString(),
        payload: { type: "user_message", message: "Wait for my review" } }) + "\n");
      unverified = true;
    }
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  const held = loadPipelines()[0]!.runs[0]!.attempts;
  expect(stops).toBe(1);
  expect(held).toHaveLength(1);
  expect(held[0]!.state).toBe("running");
  expect(held[0]!.providerWait).toEqual(wait);
  expect(held[0]!.restartRecovery?.stopped).toMatchObject({ restarted: true });
  expect(held[0]!.restartRecovery?.promptBoundary).toBe(0);
  expect(f.sends).toHaveLength(0);
  // Recovery retries the read without losing the wait or the confirmed stop.
  unverified = false;
  f.h.ports.restartRecoveryBootId = () => "boot-after-uncertain-evidence";
  f.h.ports.conversationTurnInterrupted = async () => "dead";
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(operator ? 1 : 2);
  expect(f.h.spawnInputs).toHaveLength(operator ? 1 : 2);
  expect(f.sends).toHaveLength(0);
});

test.each((["codex", "claude"] as const).flatMap(engine => (["busy", "abort"] as const).flatMap(turn =>
  [200_000, 9 * 1024 * 1024].flatMap(bytes => [false, true].map(operator => ({ engine, turn, bytes, operator }))))))
("restart recovery verifies long native history without a saved wait ($engine, $turn, bytes=$bytes, operator=$operator)", async ({ engine, turn, bytes, operator }) => {
  const f = await providerRecoveryHarness(engine, "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const records: Record<string, unknown>[] = engine === "codex" ? [
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
  ] : [{ type: "assistant", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Checking the stage" }] } }];
  records.unshift(engine === "codex"
    ? { type: "event_msg", timestamp: new Date(at - 1000).toISOString(), payload: { type: "user_message", message: "Review the earlier change" } }
    : { type: "user", timestamp: new Date(at - 1000).toISOString(), message: { role: "user", content: "Review the earlier change" } });
  records.push({ type: "queue-operation", timestamp: new Date(at).toISOString(), padding: "x".repeat(bytes) });
  if (turn === "abort") records.push(engine === "codex"
    ? { type: "event_msg", timestamp: new Date(at + 1000).toISOString(), payload: { type: "turn_aborted" } }
    : { type: "user", timestamp: new Date(at + 1000).toISOString(), interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } });
  const file = stageTranscript("long-restart-history", records);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.advance(3000);
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (++stops === 1 && operator) fs.appendFileSync(file, JSON.stringify(engine === "codex"
      ? { type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message: "Wait for my review" } }
      : { type: "user", timestamp: recordedAt, message: { role: "user", content: "Wait for my review" } }) + "\n");
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(operator ? 1 : 2);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(operator ? 1 : 2);
  expect(f.h.spawnInputs).toHaveLength(operator ? 1 : 2);
  expect(f.sends).toHaveLength(0);
  if (operator && turn === "busy") expect(loadPipelines()[0]!.stateDetail).toContain("cancelled after newer stage activity");
});

test.each(["codex", "claude"] as const)("%s work after an old restart keeps provider recovery after a large historical prefix", async engine => {
  const f = await providerRecoveryHarness(engine, "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const file = stageTranscript("restart-streamed-progress", [
    { type: "queue-operation", timestamp: new Date(at).toISOString(), padding: "x".repeat(9 * 1024 * 1024) },
    engine === "codex"
      ? { type: "event_msg", timestamp: new Date(at + 2000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } }
      : { type: "assistant", timestamp: new Date(at + 2000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Checking the stage" }] } },
    engine === "codex"
      ? { type: "event_msg", timestamp: new Date(at + 3000).toISOString(), payload: { type: "turn_aborted" } }
      : { type: "user", timestamp: new Date(at + 3000).toISOString(), interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.h.ports.conversationRestartCut = () => ({ recordedAt: new Date(at + 1000).toISOString() });
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => { stops++; return { outcome: "stopped" }; };
  f.advance(5000);
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.condition.kind).toBe("turn_cut");
  f.advance(31_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a reviewer completion notice after a deploy abort keeps provider recovery automatic", async () => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript("deploy-reviewer-notice", [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "turn_aborted", reason: "interrupted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.condition.kind).toBe("turn_cut");
  f.advance(52_000);
  const text = encodeCodexStructuredUserText("Agent finished: review interrupted", undefined, null, { kind: "agent", role: "reviewer" });
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } },
    { type: "response_item", timestamp: f.h.ports.now(), payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  f.h.setConversationActive(true);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).not.toBe(true);
  expect(loadPipelines()[0]!.state).toBe("running");
  // The notice resumed the turn; its eventual stage report still settles it.
  f.advance(1000);
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "agent_message", message: "```json\n{\"status\":\"pass\"}\n```" } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
});

test.each(["automatic", "operator-before", "operator-during", "operator-stop", "report", "newer-work"] as const)
("a recorded deploy cut owns a genuinely parked provider retry (%s)", async activity => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  f.h.ports.conversationOperatorStopped = async () => false;
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  const quotaAt = f.now();
  const file = stageTranscript("parked-deploy-cut", [providerQuotaRecord("codex", quotaAt)]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.runs[0]!.attempts[0]!.state).toBe("needs_decision");
  expect(parked.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
  f.advance(1_000);
  const automatic = encodeCodexStructuredUserText("Review completed", undefined, null, { kind: "agent", role: "reviewer" });
  const append = (type: string, extra: Record<string, unknown> = {}) => fs.appendFileSync(file,
    JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(), payload: { type, ...extra } }) + "\n");
  append("user_message", { message: automatic });
  append("task_started");
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  if (activity === "operator-before") append("user_message", { message: "Wait for my review" });
  if (activity === "newer-work") { f.advance(1_000); append("agent_message", { message: "Continuing the stage" }); }
  append("turn_aborted");
  if (activity === "operator-stop") f.h.ports.conversationOperatorStopped = async () => true;
  if (activity === "report") {
    parked.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
    savePipelines([parked]);
  }
  f.h.setConversationActive(false);
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (activity === "operator-during") append("user_message", { message: "Wait for my review" });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  const after = loadPipelines()[0]!;
  if (activity === "report") expect(after.runs[0]!.attempts[0]!.state).toBe("passed");
  else expect(after.runs[0]!.attempts).toHaveLength(activity === "automatic" ? 2 : 1);
  if (activity === "automatic") {
    expect(after.runs[0]!.attempts[1]!.restartContext?.cause).toBe("restart");
    expect(f.now()).toBeLessThan(f.resetsAt! * 1_000);
  }
  expect(f.sends).toHaveLength(0);
});

test.each(["turn_cut", "auth_required", "quota-fallback", "transient"].flatMap(kind =>
  ["automatic", "work", "operator", "operator-work", "operator-during", "stop", "pause", "report", "unreadable", "late-message"].map(activity => ({ kind, activity }))))
("a recorded deploy cut recovers an unscheduled provider park ($kind, $activity)", async ({ kind, activity }) => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const code = kind === "auth_required" ? "unauthorized" : kind === "quota-fallback" ? "usage_limit_exceeded" : kind === "transient" ? "other" : "turn_aborted";
  const text = kind === "auth_required" ? "Authentication required" : kind === "quota-fallback" ? "You've hit your usage limit"
    : kind === "transient" ? "Selected model is at capacity. Please try a different model." : "stage turn aborted before completion";
  const f = await providerRecoveryHarness("codex", code, text, null, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  if (kind === "quota-fallback") lane.runs[0]!.attempts[0]!.providerFallbackRetries = 1;
  savePipelines([lane]);
  const file = stageTranscript("unscheduled-park-deploy", [{ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "task_complete", error: { message: text, codex_error_info: code } } }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  f.advance(1_000);
  const prompt = activity.startsWith("operator") && activity !== "operator-during" ? "Wait for my review"
    : encodeCodexStructuredUserText("Review completed", undefined, null, { kind: "agent", role: "reviewer" });
  const append = (type: string, extra: Record<string, unknown> = {}) => fs.appendFileSync(file,
    JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(), payload: { type, ...extra } }) + "\n");
  append("user_message", { message: prompt });
  append("task_started");
  if (activity.endsWith("work")) { f.advance(1_000); append("agent_message", { message: "Working on the stage" }); }
  f.advance(1_000);
  const recordedAt = f.h.ports.now();
  append("turn_aborted");
  if (activity === "report") { parked.runs[0]!.attempts[0]!.report = recoveryReport(recordedAt); savePipelines([parked]); }
  if (activity === "pause") {
    await patchPipeline(parked.id, { action: "pause" }, f.h.ports);
    await patchPipeline(parked.id, { action: "resume" }, f.h.ports);
  }
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let unreadable = activity === "unreadable";
  let readBoundary = false;
  let late = activity === "late-message";
  const read = f.h.ports.durableTurnEvidence;
  f.h.ports.durableTurnEvidence = async (...args) => { const evidence = await read(...args); readBoundary = true; return evidence; };
  f.h.ports.conversationOperatorStopped = async () => {
    if (unreadable) throw new Error("operator-stop journal unavailable");
    if (late && readBoundary) { late = false; append("user_message", { message: "Wait for my review" }); }
    return activity === "stop";
  };
  f.h.setConversationActive(false);
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (activity === "operator-during") append("user_message", { message: "Wait for my review" });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  if (unreadable) { expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1); unreadable = false; }
  for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  const after = loadPipelines()[0]!;
  if (activity === "report") expect(after.runs[0]!.attempts[0]!.state).toBe("passed");
  else expect(after.runs[0]!.attempts).toHaveLength(["automatic", "work", "unreadable"].includes(activity) ? 2 : 1);
  expect(f.sends).toHaveLength(0);
});

test.each(["turn_cut", "host_death", "transient", "usage_limit", "auth_required"] as const)("a recorded restart owns its replacement over a persisted %s wait", async kind => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.providerWait!.condition.kind = kind;
  savePipelines([lane]);
  const recordedAt = f.h.ports.now();
  const beforeCut = f.now() - 1;
  f.h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: null, lastRecordAt: beforeCut,
    lastAgentEventAt: beforeCut, terminalProviderMessage: { text: "stage turn aborted before completion", errorClass: "turn_aborted", ts: beforeCut } });
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  await tickPipelines([], f.h.ports);
  const recovered = loadPipelines()[0]!;
  expect(recovered.state).toBe("running");
  expect(recovered.runs[0]!.attempts).toHaveLength(2);
  expect(recovered.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "restart", previousAttempt: 1 });
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});
