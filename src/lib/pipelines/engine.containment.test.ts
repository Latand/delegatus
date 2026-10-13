import { expect, spyOn, test, crypto, spawn, fs, os, path, ProjectAccountRefusedError, worktreeDiskWait, engineModule, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, createPipelineFromRequest, loadPipelines, savePipelines, pipelineRevision, durableStageTurnEvidence, pipelineCompletedUnreviewed, loadTasks, saveTasks, interruptionObligationDirectory, interruptionObligationStore, RUN_STAGES, entry, harness, create, withRuntimeSnapshot, boardTask, provisionRetryClock, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, BUDGET_STAGES, REVIEW_HEADS, movingHeadHarness, driveWithController, driveLegacyTerminalRecheck, restartCutStage, cutByRestart, providerRecoveryHarness, parkedAccountCases, parkedAccountHarness, publicationInterruptedReview } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";


test("Codex quota pressure relaunches the stage on the next permitted account", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  const switches: string[] = [];
  f.h.ports.requestConversationReseat = async (_id, account) => { switches.push(account); };
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  // A reseat request acknowledges intent only; a fresh host binds the account.
  expect(switches).toEqual([]);
  expect(f.sends).toHaveLength(0);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
});

test("a persisted Codex migration retry stays fenced after its target account is revoked", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT];
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  const switches: string[] = [];
  f.h.ports.requestConversationReseat = async (_id, account) => { switches.push(account); };
  // An account switch recorded a migration to a target that policy has since revoked.
  f.h.ports.conversationMigration = () => ({ phase: "failed-recoverable", targetId: SPARE_ACCOUNT, retry: true, sourceFailure: false, error: "retry pending" }) as never;
  await tickPipelines([], f.h.ports);
  expect(switches).toEqual([]);
  expect(loadPipelines()[0]!.stateDetail).toContain("target is no longer allowed");
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("critical disk pressure defers new provisioning without parking and automatically resumes", async () => {
  const h = harness();
  savePipelines([]);
  const { scheduled, advance } = provisionRetryClock(h);
  let low = true;
  h.ports.worktreeDiskWait = () => low ? "waiting for disk space: worktrees has 0.50 GiB free; retries automatically" : null;
  await createPipelineFromRequest({ task: "Disk admission", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "provisioning", stateDetail: expect.stringContaining("waiting for disk space:") });
  expect(h.calls.some(call => call.includes("worktree add"))).toBe(false);
  expect(scheduled).toContain(60_000);
  // The wait has no exhausted retry budget, even after days of pressure.
  advance(7 * 24 * 60 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("provisioning");
  low = false;
  advance(60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
  expect(h.calls.some(call => call.includes("worktree add"))).toBe(true);
});

test.each(["codex", "claude"].flatMap(engine => ["full", "restricted"].map(sandbox => [engine, sandbox] as const)))("provisioning selects actual %s/%s stage temp destinations at both admission boundaries", async (engine, sandbox) => {
  const h = harness();
  savePipelines([]);
  const stages = RUN_STAGES.map(stage => ({ ...stage, engine, sandbox, model: engine === "codex" ? "gpt-6.1-sol" : "fable" }));
  const source = { NODE_ENV: "test" as const, TMPDIR: "/srv/agent-temp", CLAUDE_CODE_TMPDIR: "/srv/claude-temp" };
  const observed: boolean[] = [];
  h.ports.worktreeDiskWait = (repo, worktree, usesClaude) => {
    observed.push(usesClaude);
    return worktreeDiskWait(repo, worktree, directory => ({ volume: directory === source.CLAUDE_CODE_TMPDIR ? "claude" : "writer",
      freeBytes: directory === source.CLAUDE_CODE_TMPDIR ? 1024 ** 3 : 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }), source, [], usesClaude);
  };
  const created = await createPipelineFromRequest({ task: "Stage volume admission", repoDir: "/repo", stages: stages as never }, h.ports);
  expect(created.error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(observed.every(value => value === (engine === "claude"))).toBeTrue();
  if (engine === "codex") {
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(h.calls.some(call => call.includes("worktree add"))).toBeTrue();
    expect(loadPipelines()[0]!.state).toBe("running");
  } else {
    expect(observed).toHaveLength(1);
    expect(h.calls.some(call => call.includes("worktree add"))).toBeFalse();
    expect(loadPipelines()[0]).toMatchObject({ state: "provisioning", stateDetail: expect.stringContaining("1.00 GiB free") });
  }
});


test.each([false, true])("stored default-advance terminal budget park fixes retained findings once across restart (metadata: %s)", async (metadata) => {
  const h = movingHeadHarness();
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1 }, null) as never);
  const parked = (await driveLegacyTerminalRecheck(h)).pipeline;
  const { needsYouEntries } = await import("@/lib/attention/needsYouRead");
  expect(needsYouEntries({ files: [], pipelines: [parked], tasks: [] }, null, Date.now() / 1000, parked.project)).toHaveLength(1);
  if (!metadata) delete parked.reviewPending;
  if (metadata) parked.reviewGrants = [{ clientRequestId: "historical-grant", expectedRevision: pipelineRevision(parked), stageId: "critique", terminalAttempt: 1,
    rounds: 1, reviewedHead: REVIEW_HEADS[0], currentHead: parked.lastPassedCommit, actor: { kind: "operator" }, at: parked.createdAt }];
  const task = { ...boardTask("task-budget-restart"), project: parked.project,
    note: { text: "Budget wait", author: { kind: "orchestrator" as const }, updatedAt: parked.createdAt } };
  saveTasks([task]);
  parked.taskIds = [task.id];
  savePipelines([parked]);
  await tickPipelines([], h.ports);
  expect(loadTasks().find(row => row.id === task.id)?.note ?? null).toBeNull();
  const resumed = loadPipelines()[0]!;
  expect(resumed.state).toBe("running");
  expect(resumed.reviewPending).toBeUndefined();
  expect(needsYouEntries({ files: [], pipelines: [resumed], tasks: loadTasks() }, null, Date.now() / 1000, resumed.project)).toEqual([]);
  const { pipeline } = await driveWithController(h);
  expect(pipeline.state).toBe("completed");
  expect(pipeline.runs.find(run => run.stageId === "critique")!.attempts).toHaveLength(2);
  const fixes = pipeline.runs.find(run => run.stageId === "build")!.attempts;
  expect(fixes).toHaveLength(3);
  expect(fixes.at(-1)!.input).toContain("P2 evidence gap 2");
  expect(pipelineCompletedUnreviewed(pipeline)?.findings).toBe(1);
  expect(needsYouEntries({ files: [], pipelines: [pipeline], tasks: loadTasks() }, null, Date.now() / 1000, pipeline.project)).toEqual([]);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("completed");
  expect(loadPipelines()[0]!.runs.find(run => run.stageId === "build")!.attempts).toHaveLength(3);
});


test.each(["park", "stop-after-fix", "operator-choice"])("stored terminal budget recovery preserves %s", async (policy) => {
  const h = movingHeadHarness();
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1 }, null) as never);
  const parked = (await driveLegacyTerminalRecheck(h)).pipeline;
  if (policy === "operator-choice") {
    const attempt = parked.runs.find(run => run.stageId === "critique")!.attempts.at(-1)!;
    attempt.state = "needs_decision";
    attempt.verdict = { status: "needs_decision", findings: [] };
    attempt.output = "Select the release window";
    delete parked.reviewPending;
  } else parked.stages.find(stage => stage.id === "critique")!.onFail!.onExhausted = policy as "park" | "stop-after-fix";
  savePipelines([parked]);
  await tickPipelines([], h.ports);
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.runs.find(run => run.stageId === "build")!.attempts).toHaveLength(2);
});

test("stored default-advance needs_review resumes after its already passed final fix", async () => {
  const h = movingHeadHarness();
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1, onExhausted: "stop-after-fix" }, null) as never);
  const parked = (await driveWithController(h)).pipeline;
  expect(parked.state).toBe("needs_review");
  delete parked.stages.find(stage => stage.id === "critique")!.onFail!.onExhausted;
  savePipelines([parked]);
  await tickPipelines([], h.ports);
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("completed");
  expect(current.reviewPending).toBeUndefined();
  expect(current.runs.find(run => run.stageId === "build")!.attempts).toHaveLength(2);
});

test("a restart-cut stage continues the same conversation after a second native abort leaves its host unhosted", async () => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const initial = f.now();
  const file = stageTranscript("restart-continuation", [
    { type: "event_msg", timestamp: new Date(initial - 2000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(initial).toISOString(), payload: { type: "turn_aborted", reason: "interrupted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "restart-continuation-registry.json"));
  registry.reconcileConversations([{ engine: "codex", path: file, accountId: LIMITED_ACCOUNT,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: loadPipelines()[0]!.project }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: f.h.ports.now() }, observedAt: f.h.ports.now() }]);
  const conversation = registry.conversationForPath(file)!;
  const generation = conversation.generations.at(-1)!;
  registry.upsert({ key: { engine: "codex", sessionId: generation.id }, artifactPath: file, cwd: "/repo", accountId: LIMITED_ACCOUNT,
    launchProfile: generation.launchProfile, status: "idle", host: null, pendingAction: null, claimEpoch: 1, claimOwner: "fixture:1",
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:fixture", process: null, eventCursor: 1, protocolVersion: "v2",
      writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.conversationId = conversation.id;
  savePipelines([lane]);
  f.h.ports.pathForConversation = () => "/codex/stage-1.jsonl";
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, "restart-continuation.sqlite"), { structuredHosts: true });
  const session = { conversationId: conversation.id, sessionKey: { engine: "codex", sessionId: generation.id },
    artifactPath: file, hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null,
    writerClaim: "fixture:1" as string | null, attentionIds: [], capabilities: { steer: true, structuredAttention: true } };
  const publish = () => journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: { ...session } });
  publish();
  let recoveries = 0;
  let deliveries = 0;
  let available = true;
  const client = {
    readSession: async () => journal.readSession({ conversationId: conversation.id }),
    operationStatus: async (id: string) => journal.operationResult(id),
    command: async (command: Parameters<import("@/lib/runtime/client").RuntimeHostClient["command"]>[0]) => {
      let result = journal.executeOperation(command);
      if (result.receipt.status === "queued") {
        result = journal.transitionOperation(result.operationId, "delivering");
        expect(result.receipt.status).toBe("delivering");
        deliveries++;
        f.h.setConversationActive(true);
        result = journal.transitionOperation(result.operationId, "delivered");
      }
      return result;
    },
  } as unknown as import("@/lib/runtime/client").RuntimeHostClient;
  f.h.ports.resumeSeveredTurn = async input => {
    const result = await enqueueStructuredMessage({ path: file, conversationId: input.conversationId,
      clientMessageId: input.clientMessageId, text: input.text, origin: { kind: "agent", role: "pipeline" } }, {
      enabled: () => true, client: () => available ? client : null, registry: () => registry,
      idleContinuationAllowed: input.continuationAllowed, kick: () => {}, republish: async () => false,
      recover: async () => {
        recoveries++;
        session.host = "hosted"; session.writerClaim = "fixture:2"; publish();
        return { target: null, path: file, conversationId: conversation.id, spawned: true };
      },
    });
    if (result?.ok !== true) input.onRefused?.(result?.error ?? "delivery unavailable");
    return result?.ok === true;
  };
  f.h.ports.conversationDeliveryCompleted = (_id, key) => registry.deliveryAdmissionForKey(conversation.id, key).outcome === "admitted";
  try {
    await tickPipelines([], f.h.ports);
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
    expect(deliveries).toBe(1);
    // A continuation produced output, then the next Viewer release cut it.
    f.advance(5000);
    fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "agent_message", message: "Continuing the stage" } }) + "\n");
    f.advance(1000);
    fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "turn_aborted", reason: "interrupted" } }) + "\n");
    session.host = "unhosted"; session.writerClaim = null; publish();
    f.h.setConversationActive(false);
    await tickPipelines([], { ...f.h.ports });
    available = false;
    f.advance(30_000);
    await tickPipelines([], { ...f.h.ports });
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait).toBeDefined();
    expect(recoveries).toBe(0);
    available = true;
    f.advance(60_000);
    await tickPipelines([], { ...f.h.ports });
    await tickPipelines([], { ...f.h.ports });
    const after = loadPipelines()[0]!;
    expect(after.state).toBe("running");
    expect(after.runs[0]!.attempts).toHaveLength(1);
    expect(after.runs[0]!.attempts[0]!.conversationId).toBe(conversation.id);
    expect(after.runs[0]!.attempts[0]!.providerWait?.actionAt).toBeDefined();
    expect(after.runs[0]!.attempts[0]!.controllerWait).toBeUndefined();
    expect(recoveries).toBe(1);
    expect(deliveries).toBe(2);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { journal.close(); registry.close(); }
});



test.each(["operator", "agent"].flatMap(origin => ["queued", "failed"].map(status => ({ origin, status }))))
("provider continuation honors a kill during its final transcript read ($origin, $status)", async ({ origin, status }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  await tickPipelines([], f.h.ports);
  const conversationId = loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId!;
  const sessionKey = { engine: "codex" as const, sessionId: "late-stop-session" };
  const journal = new RuntimeJournal(path.join(fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "late-stop-")), "journal.sqlite"), { structuredHosts: true, now: f.now });
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey, host: "hosted", turn: "idle", activeTurnId: null, writerClaim: "late-stop-writer", attentionIds: [],
  } });
  const revision = journal.readSession({ conversationId })!.revision;
  const client = { effectBatch: async (kinds, cursor) => journal.effectBatch(100, kinds, cursor),
    operationStatus: async id => journal.operationResult(id) } as import("@/lib/runtime/client").RuntimeHostClient;
  f.h.ports.conversationOperatorStopped = (id, since, ignored) => hasRuntimeSwitchKill(client, id, since, ignored, true);
  const readEvidence = f.h.ports.durableTurnEvidence;
  let finalRead = false;
  f.h.ports.durableTurnEvidence = async (...args) => {
    const evidence = await readEvidence(...args);
    if (finalRead) {
      finalRead = false;
      journal.executeOperation({ kind: "kill", conversationId, sessionKey, operationId: "late-stop", idempotencyKey: "late-stop",
        origin: { kind: origin as "operator" | "agent" } });
      if (status === "failed") journal.transitionOperation("late-stop", "failed", { reason: "termination unavailable" });
      expect(journal.readSession({ conversationId })!.turn).toBe("idle");
      if (origin === "agent") expect(journal.readSession({ conversationId })!.revision).toBe(revision);
    }
    return evidence;
  };
  f.h.ports.resumeSeveredTurn = async input => {
    finalRead = true;
    if (!await input.continuationAllowed!()) return false;
    f.sends.push(input.clientMessageId);
    return true;
  };
  try {
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(origin === "operator" ? 0 : 1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled ?? false).toBe(origin === "operator");
  } finally { journal.close(); }
});

test.each([
  ["unreadable", "stage transcript evidence could not be read"],
  ["history", "delivered prompt history is incomplete"],
  ["busy", "stage turn is busy"],
  ["different-cut", "terminal provider record no longer matches the cut"],
  ["external", "newer external stage activity was recorded"],
] as const)("provider continuation records the guard that changed during admission: %s", async (change, reason) => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cutAt = f.now();
  await tickPipelines([], f.h.ports);
  f.advance(30_000);
  f.h.ports.resumeSeveredTurn = async input => {
    if (change === "unreadable") f.h.durableTurns.delete("/codex/stage-1.jsonl");
    else {
      const latest = f.h.durableTurns.get("/codex/stage-1.jsonl")!;
      if (change === "history") latest.promptHistoryComplete = false;
      if (change === "busy") latest.turn = "busy";
      if (change === "different-cut") latest.terminalProviderMessage!.ts++;
      if (change === "external") latest.prompts = [{ ts: cutAt + 1, origin: "external" }];
    }
    expect(await input.continuationAllowed!()).toBe(false);
    input.onRefused?.("stage eligibility changed");
    return false;
  };
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain(reason);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.tries).toBe(0);
});

test.each([
  ["read-only", false], ["read-only", true], ["read-write", false], ["read-write", true],
] as const)("a pre-publication review replacement/2 retries once across ticks and reopen (%s, parked=%s)", async (access, parked) => {
  const { h, box, callIds, claims, stops, evidence, advance } = await publicationInterruptedReview(access, parked);
  const publication = [...box.order];
  await tickPipelines([], h.ports);
  let current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[1]!.attempts[1]).toMatchObject({ n: 2, state: "pending", launchId: null,
    retiredLaunches: [{ launchId: "launch-publication-cut" }] });
  expect(claims).toEqual(["launch-publication-cut"]);
  expect(stops).toEqual(["launch-publication-cut"]);
  expect(evidence.length).toBeGreaterThanOrEqual(2);
  await tickPipelines([], h.ports);
  savePipelines(loadPipelines());
  advance(5_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[1]!.attempts).toHaveLength(2);
  expect(current.runs[1]!.attempts[1]).toMatchObject({ n: 2, state: "running", launchId: "launch-2" });
  expect(h.spawnInputs).toHaveLength(2); // one builder prompt and one reviewer prompt
  expect(callIds).toHaveLength(parked ? 1 : 2);
  expect(new Set(callIds).size).toBe(callIds.length);
  expect(callIds.at(-1)).toStartWith("handshake_retry_");
  expect(claims).toHaveLength(1);
  expect(box.order).toEqual(publication);
});

test.each([false, true])("pre-publication recovery retains uncertain delivery evidence (parked=%s)", async (parked) => {
  const { h, box, claims, stops } = await publicationInterruptedReview("read-only", parked);
  const publication = [...box.order];
  Object.assign(h.ports, { unpublishedLaunchRetrySafe: async () => { throw new Error("runtime host request timed out"); } });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.runs[1]!.attempts[1]!.retiredLaunches).toBeUndefined();
  expect(claims).toHaveLength(0);
  expect(stops).toHaveLength(0);
  expect(h.spawnInputs).toHaveLength(1);
  expect(box.order).toEqual(publication);
});

test.each([
  [false, false], [false, true], [true, false], [true, true],
] as const)("pre-publication journal outage is rechecked after reopen (parked=%s, safe=%s)", async (parked, safe) => {
  const { h, box, claims, stops, callIds, advance } = await publicationInterruptedReview("read-only", parked);
  const publication = [...box.order];
  let available = false;
  let reads = 0;
  Object.assign(h.ports, { unpublishedLaunchRetrySafe: async () => {
    reads++;
    if (!available) throw new Error("runtime host request timed out");
    return safe;
  } });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  const outageReads = reads;
  expect(outageReads).toBeGreaterThan(0);
  expect(claims).toHaveLength(0);
  expect(stops).toHaveLength(0);

  available = true;
  savePipelines(loadPipelines());
  advance(5_000);
  await tickPipelines([], h.ports);
  expect(reads).toBeGreaterThan(outageReads);
  if (safe) {
    expect(loadPipelines()[0]!.runs[1]!.attempts[1]).toMatchObject({ state: "pending", launchId: null,
      retiredLaunches: [{ launchId: "launch-publication-cut" }] });
  }
  advance(5_000);
  await tickPipelines([], h.ports);
  savePipelines(loadPipelines());
  await tickPipelines([], h.ports);
  const current = loadPipelines()[0]!;
  const attempt = current.runs[1]!.attempts[1]!;
  expect(current.runs[1]!.attempts).toHaveLength(2);
  if (safe) {
    expect(current.state).toBe("running");
    expect(attempt).toMatchObject({ n: 2, state: "running", launchId: "launch-2" });
    expect(attempt.retiredLaunches).toHaveLength(1);
    expect(claims).toEqual(["launch-publication-cut"]);
    expect(stops).toEqual(["launch-publication-cut"]);
    expect(h.spawnInputs).toHaveLength(2); // builder and exactly one replacement reviewer prompt
    expect(callIds).toHaveLength(parked ? 1 : 2);
    expect(new Set(callIds).size).toBe(callIds.length);
    expect(callIds.at(-1)).toStartWith("handshake_retry_1_");
  } else {
    expect(current.state).toBe("needs_decision");
    expect(attempt.launchId).toBe("launch-publication-cut");
    expect(attempt.retiredLaunches).toBeUndefined();
    expect(claims).toHaveLength(0);
    expect(stops).toHaveLength(0);
    expect(h.spawnInputs).toHaveLength(1);
  }
  expect(box.order).toEqual(publication);
});

test("a pre-publication reviewer whose identity-fenced stop failed is never replaced", async () => {
  const { h, claims } = await publicationInterruptedReview("read-only", false);
  h.ports.stopStageAgent = async () => ({ outcome: "failed", error: "recorded process could not be stopped" });
  await tickPipelines([], h.ports);
  const attempt = loadPipelines()[0]!.runs[1]!.attempts[1]!;
  expect(attempt.launchId).toBe("launch-publication-cut");
  expect(attempt.retiredLaunches).toBeUndefined();
  expect(claims).toHaveLength(1);
  expect(h.spawnInputs).toHaveLength(1);
});

test("pre-publication recovery rechecks the original message after stopping its host", async () => {
  const { h, stops } = await publicationInterruptedReview("read-only", false);
  let reads = 0;
  Object.assign(h.ports, { unpublishedLaunchRetrySafe: async () => ++reads === 1 });
  await tickPipelines([], h.ports);
  expect(stops).toEqual(["launch-publication-cut"]);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.runs[1]!.attempts[1]!.retiredLaunches).toBeUndefined();
  expect(h.spawnInputs).toHaveLength(1);
});

test("the production pre-publication retry gate requires original launch and message journal evidence", async () => {
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepublication-evidence-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: root, transport: "structured",
    launchProfile: emptyLaunchProfile({ cwd: root }) });
  if (begun.kind !== "created") throw new Error("fixture admission failed");
  const { launchId, conversationId } = begun.receipt;
  const reason = `structured spawn interrupted before identity staging: ${launchId}`;
  journal.executeOperation({ kind: "spawn", operationId: launchId, idempotencyKey: launchId,
    conversationId, engine: "codex", cwd: root, prompt: "Review" });
  registry.failStructuredSpawn(launchId, reason);
  let unavailable = false;
  const reads: string[] = [];
  const client = {
    snapshot: async () => journal.snapshot(),
    events: async (after: number) => journal.replay(after),
    operationStatus: async (id: string) => {
      reads.push(id);
      if (unavailable) throw new Error("runtime host request timed out");
      return journal.operationResult(id);
    },
  } as import("@/lib/runtime/client").RuntimeHostClient;
  setAgentRegistryForTests(registry);
  try {
    const ports = defaultPipelinePorts({ spawnRecoveryClient: () => client });
    expect(await ports.unpublishedLaunchRetrySafe!(launchId)).toBe(false); // queued original spawn
    journal.transitionOperation(launchId, "failed", { reason }, { awaitProjection: true });
    expect(await ports.unpublishedLaunchRetrySafe!(launchId)).toBe(true);
    const replay = client.events;
    client.events = async () => ({ reset: true, floorSeq: 1, events: [] });
    expect(await ports.unpublishedLaunchRetrySafe!(launchId)).toBe(false);
    client.events = replay;
    expect(reads).toEqual(Array.from({ length: 3 }, () => [launchId, `spawn_message_${launchId}`]).flat());
    unavailable = true;
    await expect(ports.unpublishedLaunchRetrySafe!(launchId)).rejects.toThrow("timed out");
    unavailable = false;
    journal.executeOperation({ kind: "send", operationId: `spawn_message_${launchId}`,
      idempotencyKey: `spawn_message_${launchId}`, conversationId, text: "Review", policy: "queue" });
    expect(await ports.unpublishedLaunchRetrySafe!(launchId)).toBe(false);
    for (let index = 0; index < 4; index += 1) {
      journal.append({ scope: { type: "operation", id: "fixture-marker" }, kind: "fixture-marker", payload: { index } });
    }
    journal.compact(1);
    expect(journal.operationResult(launchId)).not.toBeNull();
    expect(journal.operationResult(`spawn_message_${launchId}`)).toBeNull();
    expect(await ports.unpublishedLaunchRetrySafe!(launchId)).toBe(false); // compacted absence stays unknown
  } finally {
    setAgentRegistryForTests(null);
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("pre-publication replacement persists one new activation across reopen (parked=%s)", async (parked) => {
  const { h, box, advance, claims } = await publicationInterruptedReview("read-only", parked);
  h.ports.deferStageGit = true;
  const publication = [...box.order];
  await tickPipelines([], h.ports);
  await engineModule.drainStageActivations(h.ports);
  expect(loadPipelines()[0]!.runs[1]!.attempts[1]).toMatchObject({ state: "pending", launchId: null,
    retiredLaunches: [{ launchId: "launch-publication-cut" }] });
  let persistedActivations = 0;
  const spawnAgent = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    const reserved = loadPipelines();
    const attempt = reserved[0]!.runs[1]!.attempts[1]!;
    expect(attempt.activation?.phase).toBe("reserving");
    expect(typeof attempt.activation?.fence).toBe("string");
    expect(attempt.activation?.clientAttemptId).toBe(input.clientAttemptId);
    expect(attempt.spawnCalls).toBe(2);
    persistedActivations += 1;
    const reopened = loadPipelines()[0]!.runs[1]!.attempts[1]!;
    expect(reopened.activation).toEqual(attempt.activation);
    expect(reopened.spawnCalls).toBe(2);
    return spawnAgent(input, onReserved);
  };
  advance(5_000);
  await tickPipelines([], h.ports);
  await engineModule.drainStageActivations(h.ports);
  await engineModule.drainStageActivations(h.ports);
  expect(loadPipelines()[0]!.runs[1]!.attempts[1]).toMatchObject({ n: 2, state: "running", launchId: "launch-2", spawnCalls: 2 });
  expect(claims).toEqual(["launch-publication-cut"]);
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs.at(-1)!.clientAttemptId).toStartWith("handshake_retry_1_");
  expect(persistedActivations).toBe(1);
  expect(box.order).toEqual(publication);
});


test.each(parkedAccountCases)("recovery admission: target quota changes after selection for $engine $kind", async ({ engine, kind }) => {
  const f = await parkedAccountHarness(engine, kind);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  let usedPercent = 100;
  const spawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved) => {
    // A concurrent lane consumes the target's last subscription capacity
    // after controller selection and before the actual spawn admission.
    f.observations.push({ ...f.observations[0]!, accountId: SPARE_ACCOUNT, authenticated: true,
      observedAt: f.h.ports.now(), authCheckedAt: f.h.ports.now(),
      limits: { session: { usedPercent, resetsAt: f.resetsAt }, weekly: null, plan: "pro", capturedAt: f.now() } });
    const selected = f.h.ports.resolveProjectSpawn!(engine, { project: loadPipelines()[0]!.project, model: input.role.model,
      requestedId: input.requestedAccountId, unavailableIds: input.unavailableAccountIds,
      ...{ requireCapacity: input.requireAccountCapacity } });
    // This is the same requested-id admission used by spawnPipelineAgent.
    if (selected.kind !== "available") throw new ProjectAccountRefusedError(selected, engine, loadPipelines()[0]!.project);
    return spawn({ ...input, requestedAccountId: selected.account.accountId }, reserved);
  };
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.launchId).toBeNull();
  usedPercent = 25;
  f.advance(1000);
  f.observations[1]!.limits!.session!.usedPercent = usedPercent;
  f.h.ports.accountRecovered = (_engine, id) => id === SPARE_ACCOUNT;
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(SPARE_ACCOUNT);
});


test.each((["claude", "codex"] as const).flatMap(engine => (["headroom", "reset"] as const).map(event => ({ engine, event }))))
("recovery admission: $engine exhausted target stays fenced across later signout until $event", async ({ engine, event }) => {
  const f = await parkedAccountHarness(engine, "usage_limit");
  await tickPipelines([], f.h.ports);
  const targetReset = f.resetsAt! - 3600;
  const spawn = f.h.ports.spawnAgent;
  let refused = false;
  f.h.ports.spawnAgent = async (input, reserved) => {
    if (input.requestedAccountId === SPARE_ACCOUNT && !refused) {
      refused = true;
      f.observations.push({ ...f.observations[0]!, accountId: SPARE_ACCOUNT, authenticated: true });
      throw new ProjectAccountRefusedError({ kind: "exhausted", resetsAt: targetReset,
        allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] }, engine, loadPipelines()[0]!.project);
    }
    return spawn(input, reserved);
  };
  f.advance(1000);
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  f.accounts.push({ id: "account-c", authPresent: true });
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT, "account-c"]);
  f.h.ports.engineReadiness = () => {
    if (loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerWait?.switchedAccountId === "account-c") {
      f.accounts[2]!.authPresent = false;
      return "signed-out";
    }
    return "connected";
  };
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerWait!.condition.kind).toBe("auth_required");
  f.advance(1000);
  f.observations[1]!.limits = null;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `review-real-recovery-${crypto.randomUUID()}.json`));
  setAgentRegistryForTests(registry);
  const clock = spyOn(Date, "now").mockImplementation(f.now);
  try {
    registry.recordQuotaObservation({ ...f.observations[1]!, authenticated: true,
      observedAt: f.h.ports.now(), authCheckedAt: f.h.ports.now(),
      provenance: { source: "unavailable", reason: null, staleSince: null } });
    f.h.ports.accountRecovered = defaultPipelinePorts().accountRecovered;
    for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(1);
    const limited = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.usageLimitedAccounts!
      .find(item => item.accountId === SPARE_ACCOUNT)!;
    expect(limited.engine).toBe(engine);
    expect(limited.limitedAt).toBeGreaterThan(0);
    expect(limited.resetsAt).toBe(targetReset);
    if (event === "headroom") {
      f.advance(1000);
      f.observations[1]!.limits = { session: { usedPercent: 25, resetsAt: targetReset },
        weekly: null, plan: "pro", capturedAt: f.now() };
      registry.recordQuotaObservation({ ...f.observations[1]!, authenticated: true,
        observedAt: f.h.ports.now(), authCheckedAt: f.h.ports.now(),
        provenance: { source: "live", reason: null, staleSince: null } });
    } else f.advance(targetReset * 1000 + 60_000 - f.now());
    for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(SPARE_ACCOUNT);
  } finally { clock.mockRestore(); setAgentRegistryForTests(null); }
});

test.each(["completed", "open"] as const)("a held restart proposal waits for ledger repair (%s turn)", async (ending) => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { statePath } = await import("@/lib/configDir");
  const { adoptStructuredHostsAtStartup, structuredStartupDeferral } = await import("@/lib/runtime/startup");
  const { restartCutEvidenceHolds, setRestartCutHeldRows } = await import("@/lib/runtime/restartCutHold");
  const h = harness();
  h.advanceWallClock(Date.now());
  await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  const directory = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "held-stage-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = crypto.randomUUID();
  const transcriptPath = path.join(directory, `${sessionId}.jsonl`);
  const workAt = new Date().toISOString();
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: "event_msg", timestamp: workAt, payload: { type: "task_started", turn_id: "T1" },
  }) + "\n");
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex", path: transcriptPath, accountId: null, launchProfile,
    turn: { state: "busy", source: "lifecycle", terminalAt: null }, observedAt: workAt,
  }]);
  const conversationId = registry.conversationForPath(transcriptPath)!.id;
  const hostKey = `codex:${sessionId}`;
  registry.upsert({
    key: { engine: "codex", sessionId }, artifactPath: transcriptPath, cwd: directory,
    accountId: null, launchProfile, status: "live", host: null,
    structuredHost: {
      kind: "codex-app-server", endpoint: "stdio:predecessor",
      process: { pid: 2_000_007_001, startIdentity: "gone-engine" }, eventCursor: 1,
      protocolVersion: "test", writerClaimEpoch: 1, activeTurnRef: "T1", pendingAttention: [], activeFlags: [],
    },
    claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  const lane = loadPipelines()[0]!;
  Object.assign(lane.runs[0]!.attempts[0]!, {
    conversationId, agentPath: transcriptPath, startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  savePipelines([lane]);
  registry.rememberMembership(conversationId, {
    kind: "pipeline", containerId: lane.id, role: "builder", slot: "build:1", stageId: "build",
    stageOrder: 0, round: 1, parentConversationId: null,
  });
  const ledgerFile = path.join(statePath("structured-host-events"), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const started = JSON.stringify({ kind: "turn-started", turnId: "T1", seq: 1 }) + "\n";
  const completed = JSON.stringify({ kind: "turn-ended", turnId: "T1", status: "completed", seq: 2 }) + "\n";
  fs.writeFileSync(ledgerFile, started);
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const startup = (next: InstanceType<typeof AgentRegistry>) => adoptStructuredHostsAtStartup({
    registry: next, client: null, orchestratorSeats: () => [],
    schedule: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return { unref() {} }; },
    adopt: async () => [], adoptClaude: async () => [],
  });
  const reachReprobeCap = async () => {
    /* Drive the current boot's real callbacks through the cap pass, waiting
       for each asynchronous probe to schedule its successor. */
    for (let probe = 0; probe < 10; probe += 1) {
      const timer = scheduled.shift()!;
      expect(timer).toBeDefined();
      timer.callback();
      for (let wait = 0; wait < 400 && scheduled.length === 0; wait += 1) await Bun.sleep(5);
      expect(scheduled).toHaveLength(1);
      if (timer.delayMs === 30_000) return;
    }
    throw new Error("restart evidence re-probe never reached its cap");
  };
  try {
    await startup(registry).catch(() => {});
    const store = interruptionObligationStore(interruptionObligationDirectory(registry.filename));
    expect(store.list()).toMatchObject([{ state: "discharged", turnRef: "T1" }]);
    fs.appendFileSync(ledgerFile, (ending === "completed" ? completed : "") + '{"kind":"delta",BROKEN}\n');
    const next = new AgentRegistry(registry.filename);
    setAgentRegistryForTests(next);
    await startup(next).catch(() => {});
    expect(structuredStartupDeferral()?.hostKeys).toContain(hostKey);
    expect(restartCutEvidenceHolds(hostKey)).toBe(true);
    await reachReprobeCap();
    expect(structuredStartupDeferral()?.hostKeys).toContain(hostKey);
    expect(restartCutEvidenceHolds(hostKey)).toBe(false);
    h.advanceWallClock(6 * 60_000);
    await withRuntimeSnapshot({ runtime: { hostEpoch: 7 }, sessions: [{ conversationId, host: "dead", turn: "idle", attentionIds: [] }] }, async () => {
      const production = defaultPipelinePorts();
      let stops = 0;
      const ports: PipelinePorts = {
        ...h.ports, sourcePathAllowed: () => true, pathForConversation: () => transcriptPath,
        durableTurnEvidence: (engine, file, reportAt, startedAt) => durableStageTurnEvidence(engine, file, reportAt, startedAt),
        conversationTurnInterrupted: production.conversationTurnInterrupted,
        conversationAgentActive: production.conversationAgentActive,
        conversationInterruption: production.conversationInterruption,
        conversationRestartCut: production.conversationRestartCut,
        conversationRestartCutHeld: production.conversationRestartCutHeld,
        stopInterruptedStageAgent: async (...args) => { stops += 1; return production.stopInterruptedStageAgent!(...args); },
        conversationHostUnavailableSince: async () => new Date(Date.now() - 5 * 60_000).toISOString(),
      };
      for (let tick = 0; tick < 3; tick += 1) await tickPipelines([entry(transcriptPath)], ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(h.spawnInputs).toHaveLength(1);
      expect(stops).toBe(0);
      /* Reopening startup on the same unreadable evidence grants no retry. */
      scheduled.length = 0;
      await startup(new AgentRegistry(registry.filename)).catch(() => {});
      await reachReprobeCap();
      for (let tick = 0; tick < 3; tick += 1) await tickPipelines([entry(transcriptPath)], defaultPorts());
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(stops).toBe(0);

      fs.writeFileSync(ledgerFile, started + (ending === "completed" ? completed : ""));
      await startup(new AgentRegistry(registry.filename)).catch(() => {});
      expect(restartCutEvidenceHolds(hostKey)).toBe(false);
      for (let tick = 0; tick < 3; tick += 1) await tickPipelines([entry(transcriptPath)], defaultPorts());
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(ending === "completed" ? 1 : 2);
      expect(h.spawnInputs).toHaveLength(ending === "completed" ? 1 : 2);
      expect(stops).toBe(ending === "completed" ? 0 : 1);
      if (ending === "completed") {
        expect(store.list()).toEqual([]);
        expect(defaultPipelinePorts().conversationRestartCut!(conversationId)).toBeNull();
        /* The host's completion is authoritative before its rollout echo. */
        fs.appendFileSync(transcriptPath, JSON.stringify({
          type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_complete", turn_id: "T1" },
        }) + "\n");
        for (let tick = 0; tick < 3; tick += 1) await tickPipelines([entry(transcriptPath)], defaultPorts());
        expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
        expect(h.spawnInputs).toHaveLength(1);
      }
      function defaultPorts(): PipelinePorts {
        /* Refresh the production readers after each boot; each pass owns
           its snapshot, while the hold remains a fresh process-wide read. */
        const refreshed = defaultPipelinePorts();
        return { ...ports,
          conversationInterruption: refreshed.conversationInterruption,
          conversationRestartCut: refreshed.conversationRestartCut,
          conversationRestartCutHeld: refreshed.conversationRestartCutHeld,
        };
      }
    });
  } finally {
    setAgentRegistryForTests(null);
    setRestartCutHeldRows([]);
  }
});

test("a restart evidence hold arriving during termination prevents replacement reservation", async () => {
  const h = harness();
  const attempt = await restartCutStage(h);
  cutByRestart(h, h.ports, attempt, h.ports.now(), "Finished the committed changes; waiting for a tool.");
  let held = false;
  let stops = 0;
  h.ports.conversationRestartCutHeld = () => held;
  h.ports.stopInterruptedStageAgent = async () => { held = true; stops += 1; return { outcome: "not-running" }; };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(stops).toBe(1);
  held = false;
  h.ports.stopInterruptedStageAgent = async () => ({ outcome: "not-running" });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
});
