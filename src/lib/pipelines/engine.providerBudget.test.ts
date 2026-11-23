import { expect, test, fs, tickPipelines, loadPipelines, savePipelines, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, stampPipelinePrompt, providerRecoveryHarness, pipelineRevision, engineModule } from "./engine.fixture";

async function parkedProviderErrorFixture(name: string, receiptState: "completed" | "path-pending" = "completed") {
  const f = await providerRecoveryHarness("codex", "cyber_policy", "Provider refused the turn");
  const transcript = stageTranscript(`provider-cut-${name}`, [{ type: "event_msg", timestamp: new Date(f.now()).toISOString(),
    payload: { type: "task_complete", error: { message: "Provider refused the turn", codex_error_info: "cyber_policy" } } }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": transcript });
  let resident = true;
  let stop: Awaited<ReturnType<typeof f.h.ports.stopStageAgent>> = { outcome: "stopped" };
  let stopped = () => { resident = false; };
  let pending = false;
  f.h.ports.conversationHostProcess = async () => ({ state: resident ? "alive" : "gone", pid: 1234 });
  f.h.ports.stageHostResident = async () => resident;
  f.h.ports.conversationDeliveryOutstanding = () => pending;
  const stops: Parameters<typeof f.h.ports.stopStageAgent>[] = [];
  f.h.ports.stopStageAgent = async (target, options) => {
    stops.push([target, options]);
    if (stop.outcome === "stopped") stopped();
    return stop;
  };

  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(lane.state).toBe("needs_decision");
  expect(attempt.verdict).toBeNull();
  expect(attempt.error).toContain("stage cut by provider error after 0 tries");
  if (!attempt.conversationId || !attempt.launchId) throw new Error("expected a bound stage launch");
  const { conversationId } = attempt;
  f.h.ports.spawnReceipt = launchId => launchId === attempt.launchId ? {
    launchId, state: receiptState, conversationId,
    sessionId: receiptState === "completed" ? attempt.sessionId : null,
    "transcript": receiptState === "completed" ? attempt.agentPath : null, paneId: null,
  } : null;
  const recover = (action: "retry-stage" | "resolve-decision") => patchPipeline(lane.id, {
    action, expectedStageId: "plan", expectedAttempt: 1,
    ...(action === "resolve-decision" ? { expectedRevision: pipelineRevision(lane), clientRequestId: "answer-provider-cut",
      answer: "Resume the stage with these instructions." } : {}),
  }, f.h.ports);
  return { f, lane, attempt, transcript, stops, recover, resident: () => resident,
    setPending: () => { pending = true; },
    setStop: (result: typeof stop) => { stop = result; },
    afterStop: (callback: () => void) => { const prior = stopped; stopped = () => { prior(); callback(); }; },
  };
}

for (const action of ["retry-stage", "resolve-decision"] as const) {
  test(`${action} releases an idle host after a terminal provider error`, async () => {
    const fixture = await parkedProviderErrorFixture(action);
    const result = await fixture.recover(action);
    expect(result.error).toBeUndefined();
    expect(result.pipeline?.cursor).toMatchObject({ stageId: "plan", state: "pending" });
    expect(fixture.stops).toEqual([[
      { stageId: "plan", attempt: 1, conversationId: "conversation_stage_1", launchId: "launch-1", agentPath: "/codex/stage-1.jsonl", paneId: null },
      expect.objectContaining({ onlyIfIdle: true, requireIdleEvidence: true, providerRecovery: {
        pipelineId: fixture.lane.id, stageId: "plan", attempt: 1, turnTs: fixture.f.now(), controlGeneration: null,
      } }),
    ]]);
    expect(fixture.resident()).toBe(false);
    if (action === "resolve-decision") {
      expect(result.decisionAnswer).toMatchObject({ stageId: "plan", attempt: 1, nextAttempt: 2, question: fixture.attempt.error,
        answer: "Resume the stage with these instructions." });
      const replay = await fixture.recover(action);
      expect(replay).toMatchObject({ decisionAnswer: result.decisionAnswer, replayed: true });
      expect(fixture.stops).toHaveLength(1);
    }
    delete fixture.f.h.ports.resolveProjectSpawn;
    await tickPipelines([], fixture.f.h.ports);
    await tickPipelines([], fixture.f.h.ports);
    expect(fixture.f.h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts.map(({ n, state, verdict }) => ({ n, state, verdict }))).toEqual([
      { n: 1, state: "needs_decision", verdict: null }, { n: 2, state: "running", verdict: null },
    ]);
  });

  test.each(["busy", "unconfirmed", "queued-delivery", "delivery-after-stop", "prompt-after-stop"] as const)(
    `${action} keeps the provider park when its stop is unsafe (%s)`, async scenario => {
      const fixture = await parkedProviderErrorFixture(`${action}-${scenario}`);
      if (scenario === "busy") fixture.setStop({ outcome: "deferred" });
      if (scenario === "unconfirmed") fixture.setStop({ outcome: "unconfirmed", operationId: "fixture-stop", detail: "queued" });
      if (scenario === "queued-delivery") fixture.setPending();
      if (scenario === "delivery-after-stop") fixture.afterStop(fixture.setPending);
      if (scenario === "prompt-after-stop") fixture.afterStop(() => {
        fs.appendFileSync(fixture.transcript, JSON.stringify({ type: "event_msg", timestamp: new Date(fixture.f.now() + 1).toISOString(),
          payload: { type: "user_message", message: "Continue the previous attempt" } }) + "\n");
      });
      const result = await fixture.recover(action);
      expect(result).toEqual({ status: 409, error: expect.stringContaining(action) });
      expect(fixture.stops).toHaveLength(scenario === "queued-delivery" ? 0 : 1);
      const current = loadPipelines()[0]!;
      expect(pipelineRevision(current)).toBe(pipelineRevision(fixture.lane));
      expect(current.runs[0]!.attempts).toHaveLength(1);
      expect(current.decisionAnswers).toBeUndefined();
    },
  );
}

test("a report from a settled provider cut directs the seat to retry", async () => {
  const { f, lane, attempt } = await parkedProviderErrorFixture("report");
  const report = await engineModule.reportStageCompletion({ verdict: "pass", summary: "Stage finished" },
    { kind: "agent", role: "builder", conversationId: attempt.conversationId }, f.h.ports);
  expect(report).toMatchObject({ status: 409, code: "STAGE_REPORT_SETTLED", error: expect.stringContaining("retry-stage") });
  expect(pipelineRevision(loadPipelines()[0]!)).toBe(pipelineRevision(lane));
});

test("an explicit launch retry uses the idle fence for a provider-cut attempt with a path-pending receipt", async () => {
  const { f, lane, stops } = await parkedProviderErrorFixture("path-pending", "path-pending");
  f.h.ports.claimSpawnRetry = () => { throw new Error("the cut already proves this launch ran"); };
  const result = await patchPipeline(lane.id, { action: "retry-stage", stageId: "plan", launchId: "launch-1" }, f.h.ports);
  expect(result.pipeline?.cursor).toMatchObject({ stageId: "plan", state: "pending" });
  expect(stops).toHaveLength(1);
  expect(stops[0]?.[1]).toMatchObject({ onlyIfIdle: true, requireIdleEvidence: true });
});


for (const engine of ["claude", "codex"] as const) {
  test.each(["first-tick", "running", "parked"] as const)(`${engine} %s backdated context after a large native record retains human cancellation`, async mode => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    if (mode === "parked") {
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
      savePipelines([lane]);
    }
    const cutAt = f.now();
    if (mode !== "first-tick") await tickPipelines([], f.h.ports);
    const notice = (at: number) => engine === "claude" ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
      message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } };
    const prompt = engine === "claude" ? { type: "user", timestamp: new Date(cutAt + 1000).toISOString(), message: { content: "Wait for my review" } }
      : { type: "event_msg", timestamp: new Date(cutAt + 1000).toISOString(), payload: { type: "user_message", message: "Wait for my review" } };
    const file = stageTranscript(`backdated-engine-${engine}-${mode}`, [notice(cutAt), prompt,
      { type: "queue-operation", timestamp: new Date(cutAt + 1500).toISOString(), padding: "x".repeat(150_000) },
      { type: "turn_context", timestamp: new Date(cutAt - 1000).toISOString() }, notice(cutAt + 2000)]);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    f.advance(3000);
    await tickPipelines([], f.h.ports);
    f.advance(31 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(0);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
  });
}
for (const engine of ["claude", "codex"] as const) {
  test.each([false, true])(`${engine} large historical prefix permits named reset recovery (parked=%s)`, async parked => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const cutAt = Date.parse("2026-10-05T10:00:00Z");
    f.advance(cutAt - f.now());
    const reset = cutAt / 1000 + 3600;
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.startedAt = new Date(cutAt - 1000).toISOString();
    if (parked) lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    f.h.ports.claudeAccountReset = () => reset;
    f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: reset, allowedAccountIds: [LIMITED_ACCOUNT] });
    f.h.setStageHost("conversation_stage_1", { outcome: "stopped" });
    const notice = engine === "claude" ? { type: "assistant", timestamp: new Date(cutAt).toISOString(), isApiErrorMessage: true, error: "rate_limit",
      message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit · resets 11am (UTC)" }] } }
      : providerQuotaRecord(engine, cutAt);
    const observation = { type: "event_msg", timestamp: new Date(cutAt).toISOString(), payload: { type: "token_count",
      rate_limits: { primary: { used_percent: 100, resets_at: reset } } } };
    const file = stageTranscript(`large-prefix-engine-${engine}-${parked}`, engine === "claude" ? [notice] : [observation, notice]);
    const recent = fs.readFileSync(file);
    const old = JSON.stringify({ type: "turn_context", timestamp: new Date(cutAt - 86400000).toISOString(), padding: "x".repeat(1100) }) + "\n";
    fs.writeFileSync(file, old.repeat(8500));
    fs.appendFileSync(file, recent);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    f.advance(1000);
    await tickPipelines([], f.h.ports);
    const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!;
    expect(wait.resumeAt).toBe(new Date(reset * 1000 + 60000).toISOString());
    if (parked) expect(wait.stageRetry).toBeDefined();
    f.advance(reset * 1000 + 61000 - f.now());
    f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: LIMITED_ACCOUNT,
      kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(parked ? 0 : 1);
    expect(f.h.spawnInputs).toHaveLength(parked ? 2 : 1);
  });
}

for (const engine of ["claude", "codex"] as const) {
  test.each(["before-cut", "after-cut", "after-later-cut", "hostless", "human-before-later-cut"] as const)(`${engine} legacy quota upgrade respects operator control (%s)`, async shape => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const cutAt = f.now();
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    await tickPipelines([], f.h.ports);
    const legacy = loadPipelines()[0]!;
    const attempt = legacy.runs[0]!.attempts[0]!;
    delete attempt.providerWait!.stageRetry;
    attempt.startedAt = new Date(cutAt - 60_000).toISOString();
    attempt.completedAt = new Date(cutAt + 20_000).toISOString();
    legacy.stateDetail = attempt.error = attempt.providerRecoveries!.at(-1)!.summary;
    legacy.controlGeneration = "operator-resumed-legacy";
    const controlAt = cutAt + (shape === "before-cut" ? -10_000 : 5_000);
    legacy.pausedAt = new Date(controlAt).toISOString();
    legacy.resumedAt = new Date(controlAt + 1_000).toISOString();
    if (shape === "human-before-later-cut") { delete legacy.pausedAt; delete legacy.resumedAt; }
    if (shape === "hostless") {
      attempt.providerWait!.turnTs = 0;
      attempt.agentPath = null;
      attempt.conversationId = null;
      attempt.paneId = null;
      attempt.providerWait!.capacityProbes = 3;
      attempt.providerRecoveries!.at(-1)!.summary = "account capacity recovery exhausted";
      legacy.stateDetail = attempt.error = `stage cut by ${attempt.providerWait!.condition.label}: no account capacity returned; capacity recovery exhausted after 3 due probes`;
    } else {
      const cut = providerQuotaRecord(engine, cutAt);
      const records = [cut];
      if (shape === "after-later-cut" || shape === "human-before-later-cut") {
        records.push(engine === "claude" ? { type: "user", timestamp: new Date(cutAt + 12_000).toISOString(), ...(shape === "after-later-cut" ? { origin: { kind: "task-notification" } } : { promptSource: "sdk" }), message: { content: "<task-notification>done</task-notification>" } }
          : { type: "event_msg", timestamp: new Date(cutAt + 12_000).toISOString(), payload: { type: "user_message", message: "Continue the same stage" } });
        records.push(providerQuotaRecord(engine, cutAt + 15_000));
        attempt.providerWait!.turnTs = cutAt + 15_000;
      }
      const file = stageTranscript(`legacy-control-${engine}-${shape}`, records);
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    }
    savePipelines([legacy]);
    f.advance(180_000);
    await tickPipelines([], { ...f.h.ports });
    await tickPipelines([], { ...f.h.ports });
    expect(f.h.spawnInputs).toHaveLength(shape === "before-cut" ? 2 : 1);
    if (shape !== "before-cut") expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  });
}

for (const engine of ["claude", "codex"] as const) {
  test.each(["human", "operator-control", "automatic"] as const)(`${engine} zero-time successor preserves its first cut across %s activity`, async author => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000);
    const third = "fixture-account-c";
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT, third];
    f.h.ports.accountForTranscript = (_engine, pathname) => ({ accountId: pathname.includes("stage-1") ? LIMITED_ACCOUNT : pathname.includes("stage-2") ? SPARE_ACCOUNT : third, label: "selected account" });
    f.h.ports.resolveProjectSpawn = (_engine, request) => ({ kind: "available", account: { engine,
      accountId: request.unavailableIds?.includes(SPARE_ACCOUNT) ? third : SPARE_ACCOUNT,
      kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    const lane = loadPipelines()[0]!;
    const successor = lane.runs[0]!.attempts.at(-1)!;
    expect(successor.providerWait?.turnTs).toBe(0);
    const stops = f.h.calls.filter(call => call.startsWith("stop-host:")).length;
    f.advance(1_000);
    const firstAt = f.now();
    const automatic = author === "automatic" || author === "operator-control";
    const first = providerQuotaRecord(engine, firstAt);
    const latest = providerQuotaRecord(engine, firstAt + 2_000);
    const prompt = engine === "claude" ? { type: "user", timestamp: new Date(firstAt + 1_000).toISOString(),
      ...(automatic ? { origin: { kind: "task-notification" }, promptSource: "system" } : { promptSource: "sdk" }), message: { content: "Continue the same stage" } }
      : { type: "event_msg", timestamp: new Date(firstAt + 1_000).toISOString(), payload: { type: "user_message", message: automatic
        ? await (await import("@/lib/runtime/codexStructuredUserText.server")).encodeCodexStructuredUserText("Continue the same stage", undefined, null, { kind: "agent", role: "pipeline" })
        : "Continue the same stage" } };
    const file = stageTranscript(`successor-first-cut-${engine}-${author}`, [first, prompt, latest]);
    readFixtures(f.h, { "/codex/stage-2.jsonl": file });
    if (author === "operator-control") {
      // Restored controls from an older controller have no cancellation marker.
      lane.pausedAt = new Date(firstAt + 500).toISOString();
      lane.resumedAt = new Date(firstAt + 1_500).toISOString();
      lane.controlGeneration = "restored-successor-control";
      savePipelines([lane]);
    }
    f.advance(3_000);
    await tickPipelines([], { ...f.h.ports });
    await tickPipelines([], { ...f.h.ports });
    f.advance(180_000);
    await tickPipelines([], { ...f.h.ports });
    expect(f.sends).toHaveLength(0);
    expect(f.h.spawnInputs).toHaveLength(author === "automatic" ? 3 : 2);
    expect(f.h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(stops + (author === "automatic" ? 1 : 0));
    if (author !== "automatic") {
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerWait?.stageRetry).toBeUndefined();
    }
  });
}

for (const engine of ["claude", "codex"] as const) {
  test.each(["proved", "human", "unknown"] as const)(`${engine} an accepted continuation retains recovery after %s execution refusal`, async outcome => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 60_000, true);
    let sends = 0;
    let completed = false;
    let retryable = outcome !== "unknown";
    f.h.ports.resumeSeveredTurn = async input => {
      expect(await input.continuationAllowed!()).toBe(true);
      sends++;
      if (sends === 2) { completed = true; retryable = false; f.h.setConversationActive(true); }
      return true;
    };
    f.h.ports.conversationDeliveryOutstanding = () => false;
    f.h.ports.conversationDeliveryCompleted = () => completed;
    f.h.ports.conversationDeliveryRetryable = async () => retryable;
    await tickPipelines([], f.h.ports);
    f.advance(120_000);
    await tickPipelines([], f.h.ports);
    expect(sends).toBe(1);
    if (outcome === "human") {
      const cutAt = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.turnTs;
      const file = stageTranscript(`accepted-refusal-human-${engine}`, [providerQuotaRecord(engine, cutAt),
        engine === "claude" ? { type: "user", timestamp: f.h.ports.now(), message: { content: "Wait for review" } }
          : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message: "Wait for review" } },
        providerQuotaRecord(engine, f.now() + 1_000)]);
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    }
    await tickPipelines([], f.h.ports);
    f.advance(11 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(sends).toBe(outcome === "proved" ? 2 : 1);
    expect(f.h.spawnInputs).toHaveLength(1);
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    if (outcome === "proved") {
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(attempt.providerRecoveryBudget?.tries).toBe(1);
    } else expect(loadPipelines()[0]!.state).toBe("needs_decision");
  });
}

for (const engine of ["claude", "codex"] as const) {
  test.each(["reply-before", "control-before", "large-work", "reply-after", "control-after"] as const)(`${engine} stage progress makes the next provider cut own cancellation (%s)`, async activity => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, true);
    f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
    const firstAt = f.now();
    const notice = (at: number, reset: string) => engine === "claude"
      ? { ...providerQuotaRecord(engine, at), message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: `You've hit your session limit · resets ${reset} (Europe/Kyiv)` }] } }
      : providerQuotaRecord(engine, at);
    const firstReset = Date.parse("2026-10-05T19:00:00Z") / 1000;
    const secondReset = Date.parse("2026-10-05T23:00:00Z") / 1000;
    const quota = (at: number, reset: number) => ({ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, resets_at: reset } } } });
    const records: Record<string, unknown>[] = engine === "claude" ? [notice(firstAt, "10pm")] : [quota(firstAt, firstReset), notice(firstAt, "10pm")];
    const file = stageTranscript(`next-provider-cut-${engine}-${activity}`, records);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(Date.parse("2026-10-05T19:01:30Z") - f.now());
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(1);
    f.advance(1000);
    const text = "Continue the same stage";
    const prompt = engine === "claude" ? { type: "user", uuid: "continued-stage", timestamp: f.h.ports.now(), message: { content: text } }
      : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message: await (await import("@/lib/runtime/codexStructuredUserText.server")).encodeCodexStructuredUserText(text, undefined, null, { kind: "agent", role: "pipeline" }) } };
    records.push(prompt, engine === "claude" ? { type: "assistant", timestamp: f.h.ports.now(), message: { stop_reason: null, content: [{ type: "text", text: "Working on the stage" }] } }
      : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "agent_message", message: "Working on the stage" } });
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    if (engine === "claude") await stampPipelinePrompt(file, "continued-stage", text);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
    f.advance(Date.parse("2026-10-05T20:02:00Z") - f.now());
    if (activity === "reply-before") records.push(engine === "claude" ? { type: "user", timestamp: f.h.ports.now(), message: { content: "Continue reviewing" } }
      : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message: "Continue reviewing" } });
    if (activity === "control-before") {
      // Restore a control from before pause interrupted active hosts. Its
      // historical continuation remains evidence for the next cut's boundary.
      const prior = loadPipelines()[0]!;
      prior.pausedAt = prior.resumedAt = f.h.ports.now();
      prior.controlGeneration = "legacy-control-before-cut";
      savePipelines([prior]);
    }
    if (activity === "large-work") {
      const work = { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(1100) };
      for (let row = 0; row < 8500; row++) records.push(work);
    }
    f.advance(Date.parse("2026-10-05T21:30:00Z") - f.now());
    if (engine === "codex") records.push(quota(f.now(), secondReset));
    records.push(notice(f.now(), "2am"));
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    f.h.setConversationActive(false);
    await tickPipelines([], { ...f.h.ports });
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.turnTs).toBe(f.now());
    f.advance(1000);
    if (activity === "reply-after") {
      fs.appendFileSync(file, JSON.stringify(engine === "claude" ? { type: "user", timestamp: f.h.ports.now(), message: { content: "Wait for my review" } }
        : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message: "Wait for my review" } }) + "\n");
    }
    if (activity === "control-after") {
      await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, f.h.ports);
      await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, f.h.ports);
    }
    f.advance(secondReset * 1000 + 60000 - f.now());
    await tickPipelines([], { ...f.h.ports });
    expect(f.sends).toHaveLength(activity.endsWith("after") ? 1 : 2);
    expect(f.h.spawnInputs).toHaveLength(1);
  });
}

// A cut after agent output opens a new chain: activity before it cancels nothing.
