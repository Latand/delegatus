import { expect, test, fs, path, tickPipelines, loadPipelines, savePipelines, patchPipeline, LIMITED_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, recoveryReport, providerRecoveryHarness } from "./engine.fixture";

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
        ? "Wait for my review" : await encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } }) + "\n");
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
  const appendOperator = () => fs.appendFileSync(file, JSON.stringify(engine === "codex"
    ? { type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message: "Wait for my review" } }
    : { type: "user", timestamp: recordedAt, message: { role: "user", content: "Wait for my review" } }) + "\n");
  const continuations: string[] = [];
  f.h.ports.resumeSeveredTurn = async input => {
    if (operator) appendOperator();
    if (!await input.continuationAllowed!()) return false;
    continuations.push(input.clientMessageId);
    return true;
  };
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (++stops === 1 && operator) appendOperator();
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(engine === "claude" ? 0 : 1);
  expect(continuations).toHaveLength(engine === "claude" && !operator ? 1 : 0);
  const attempts = engine === "claude" || operator ? 1 : 2;
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(attempts);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(attempts);
  expect(f.h.spawnInputs).toHaveLength(attempts);
  expect(f.sends).toHaveLength(0);
  if (operator && turn === "busy" && engine === "codex") expect(loadPipelines()[0]!.stateDetail).toContain("cancelled after newer stage activity");
  if (operator && engine === "claude") expect(loadPipelines()[0]!.state).toBe("needs_decision");
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
  const text = await encodeCodexStructuredUserText("Agent finished: review interrupted", undefined, null, { kind: "agent", role: "reviewer" });
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
  const automatic = await encodeCodexStructuredUserText("Review completed", undefined, null, { kind: "agent", role: "reviewer" });
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
    : await encodeCodexStructuredUserText("Review completed", undefined, null, { kind: "agent", role: "reviewer" });
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
