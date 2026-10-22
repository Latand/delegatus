import { expect, test, fs, tickPipelines, loadPipelines, savePipelines, patchPipeline, PASS_TEXT, LIMITED_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, recoveryReport, providerRecoveryHarness } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";

test.each([false, true])("provider waiting schedules one wake per horizon, parked=%s", async parked => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 6 * 60 * 60_000, true);
  const scheduled: number[] = [];
  f.h.ports.scheduleTick = delay => { scheduled.push(delay); };
  if (parked) {
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
  }
  await tickPipelines([], f.h.ports);
  for (let tick = 0; tick < 10; tick++) {
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
  }
  expect(scheduled).toEqual([15 * 60_000]);
  f.advance(10 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(scheduled).toEqual([15 * 60_000, 15 * 60_000]);
});


test("parked provider waiting keeps controller cycles within watchdog plus horizon wakes", async () => {
  const { FlowPipelineController } = await import("./controller");
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 6 * 60 * 60_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  const wakeups: number[] = [];
  let scheduled = 0;
  let cycles = 0;
  let passes = 0;
  f.h.ports.scheduleTick = delay => { scheduled++; wakeups.push(f.now() + delay); };
  const controller = new FlowPipelineController({
    now: f.now,
    tickPipelines: async entries => { passes++; return await tickPipelines(entries, f.h.ports); },
    tickFlows: async () => ({ changed: false }),
    publishHeartbeat: heartbeat => { cycles = Math.max(cycles, heartbeat.cycle); },
  });
  await controller.tick("startup");
  const until = f.now() + 5.5 * 60 * 60_000;
  let watchdog = f.now() + 30_000;
  while (f.now() < until) {
    wakeups.sort((a, b) => a - b);
    const next = Math.min(watchdog, wakeups[0] ?? Infinity);
    f.advance(next - f.now());
    if (next === watchdog) {
      watchdog += 30_000;
      await controller.tick("watchdog");
    } else {
      wakeups.shift();
      await controller.tick("signal");
    }
  }
  expect(scheduled).toBeLessThanOrEqual(24);
  expect(cycles).toBeLessThanOrEqual(660 + 30);
  expect(passes).toBeLessThanOrEqual(2 * (660 + 30) + 8);
  expect(f.h.spawnInputs).toHaveLength(1);
  // Restart has no in-memory timers. Its watchdog still retries durably on time.
  wakeups.length = 0;
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT,
    kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
  const restarted = { ...f.h.ports, scheduleTick: () => {} };
  f.advance(f.resetsAt! * 1_000 + 59_000 - f.now());
  await tickPipelines([], restarted);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.advance(30_000);
  await tickPipelines([], restarted);
  await tickPipelines([], restarted);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(f.now()).toBeLessThanOrEqual(f.resetsAt! * 1_000 + 90_000);
}, 60_000);


test.each([false, true])("a newer native operator turn cancels running reset continuation, tool=%s", async tool => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", null, true);
  f.advance(Date.parse("2026-10-05T18:30:00Z") - f.now());
  const records = [{ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your session limit · resets 10pm (Europe/Kyiv)" }] } }];
  const transcript = stageTranscript("running-reset-operator-answer", records);
  readFixtures(f.h, { "/codex/stage-1.jsonl": transcript });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.resumeAt).toBe("2026-10-05T19:01:00.000Z");
  fs.appendFileSync(transcript, JSON.stringify({ type: "user", timestamp: "2026-10-05T19:00:20Z",
    message: { role: "user", content: "Continue the stage" } }) + "\n");
  if (tool) fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: "2026-10-05T19:00:25Z",
    message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id: "operator-tool", name: "Read", input: {} }] } }) + "\n");
  f.h.setConversationActive(true);
  f.advance(Date.parse("2026-10-05T19:01:05Z") - f.now());
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
  fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: f.h.ports.now(),
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] } }) + "\n");
  f.h.setConversationActive(false);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
});


test.each(["none", "failed", "delivered", "pending"] as const)("an exhausted provider limit retries the stage after its native reset across a Viewer restart (delivery=%s)", async delivery => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", null, true);
  f.advance(Date.parse("2026-10-05T18:30:00Z") - f.now());
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  const file = stageTranscript("exhausted-native-reset", [{
    type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your session limit · resets 10pm (Europe/Kyiv)" }] },
  }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("Автоповтор");
  // Fresh port object and a reloaded durable store have no process-local timer.
  const restarted: PipelinePorts = { ...f.h.ports,
    resolveProjectSpawn: (_engine, input) =>
      input.requestedId === LIMITED_ACCOUNT && !input.unavailableIds?.includes(LIMITED_ACCOUNT)
        ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed",
          home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] },
  };
  f.advance(Date.parse("2026-10-05T19:00:59Z") - f.now());
  await tickPipelines([], restarted);
  expect(f.h.spawnInputs).toHaveLength(1);
  let outstanding = delivery !== "none";
  restarted.conversationDeliveryOutstanding = () => outstanding;
  f.advance(1_000);
  await tickPipelines([], restarted);
  if (outstanding) {
    for (let tick = 0; tick < 4; tick++) {
      f.advance(30_000);
      await tickPipelines([], restarted);
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    }
    if (delivery === "delivered") {
      fs.appendFileSync(file, JSON.stringify({ type: "user", timestamp: f.h.ports.now(),
        message: { content: "Wait for my review" } }) + "\n");
    }
    if (delivery === "pending") f.advance(11 * 60_000);
    else outstanding = false;
    f.advance(30_000);
    await tickPipelines([], restarted);
    if (delivery === "delivered" || delivery === "pending") {
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
      return;
    }
  }
  await tickPipelines([], restarted);
  const retried = loadPipelines()[0]!;
  expect(retried.runs[0]!.attempts).toHaveLength(2);
  expect(retried.runs[0]!.attempts[1]!.providerRecoveryBudget).toMatchObject({ tries: 0, triedAccounts: [LIMITED_ACCOUNT] });
  expect(retried.runs[0]!.attempts[1]!.input).toBe(lane.runs[0]!.attempts[0]!.input);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(f.sends).toHaveLength(0);
  expect(f.h.calls.some(call => /reset --hard|clean -/.test(call))).toBe(false);
});


test.each(["close", "pause", "pause-resume", "reply", "report", "retry-stage", "skip-stage"] as const)("operator %s cancels a parked quota retry", async (action) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
  if (action === "reply") {
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
    f.h.setConversationActive(true);
  } else if (action === "report") {
    const reported = loadPipelines()[0]!;
    reported.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
    savePipelines([reported]);
  } else {
    if (action === "retry-stage") {
      f.h.ports.spawnReceiptState = () => "completed";
      f.h.ports.spawnReceipt = id => ({ state: "completed", launchId: id, conversationId: "conversation_stage_1" }) as NonNullable<ReturnType<PipelinePorts["spawnReceipt"]>>;
    }
    const result = await patchPipeline(lane.id, { action: action === "pause-resume" ? "pause" : action }, f.h.ports);
    expect(result.error).toBeUndefined();
    if (action === "pause-resume") expect((await patchPipeline(lane.id, { action: "resume" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
  }
  const before = f.h.spawnInputs.length;
  f.advance(180_000);
  await tickPipelines([], { ...f.h.ports });
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(before);
  expect(f.sends).toHaveLength(0);
});


test.each(["provider-notice", "empty-completion"] as const)("an operator reply ending on a newer native %s cancels the old quota retry", async (ending) => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  f.advance(1_000);
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript("operator-reply-native-quota", [
    providerQuotaRecord("codex", loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.turnTs),
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message: "Continue with the answer" } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started", turn_id: "answered-turn" } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", turn_id: "answered-turn",
      ...(ending === "provider-notice" ? { error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } : {}) } },
  ]) });
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
});
