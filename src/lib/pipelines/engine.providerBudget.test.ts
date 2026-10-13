import { expect, test, fs, path, tickPipelines, loadPipelines, savePipelines, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, stampPipelinePrompt, providerRecoveryHarness, cutChainKit, CHAIN_RESET, otherKindCut } from "./engine.fixture";



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
        ? (await import("@/lib/runtime/codexStructuredUserText.server")).encodeCodexStructuredUserText("Continue the same stage", undefined, null, { kind: "agent", role: "pipeline" })
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
      : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message: (await import("@/lib/runtime/codexStructuredUserText.server")).encodeCodexStructuredUserText(text, undefined, null, { kind: "agent", role: "pipeline" }) } };
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
      await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, f.h.ports);
      await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, f.h.ports);
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
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["operator", "orchestrator", "harness-control", "busy-operator", "same-tick", "reply-after", "control-after", "operator-refused"] as const)(`${engine} a provider cut after agent output owes its own recovery (pool=${pool}, %s)`, async activity => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      const firstReset = Date.parse("2026-10-05T19:00:00Z") / 1000;
      const secondReset = Date.parse("2026-10-05T23:00:00Z") / 1000;
      let reset = firstReset;
      if (pool) {
        f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
        f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
          ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
          : { kind: "exhausted", resetsAt: reset, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
      }
      const notice = (at: number, label: string) => engine === "claude"
        ? { ...providerQuotaRecord(engine, at), message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: `You've hit your session limit · resets ${label} (Europe/Kyiv)` }] } }
        : providerQuotaRecord(engine, at);
      const quota = (at: number, r: number) => ({ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, resets_at: r } } } });
      const records: Record<string, unknown>[] = engine === "claude" ? [notice(f.now(), "10pm")] : [quota(f.now(), firstReset), notice(f.now(), "10pm")];
      const file = stageTranscript(`chain-r12-${engine}-${pool}-${activity}`, records);
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      const write = () => fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.turnTs).toBe(Date.parse("2026-10-05T17:22:09Z"));
      f.advance(Date.parse("2026-10-05T19:00:20Z") - f.now());
      const at = () => f.h.ports.now();
      const external = async (text: string, role?: string) => {
        if (engine === "claude") {
          const uuid = `chain-${role ?? "operator"}-${f.now()}`;
          records.push({ type: "user", uuid, timestamp: at(), promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: text } });
          if (role) {
            write();
            const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
            const ledger = new FileClaudeDeliveryLedger();
            const session = path.basename(file, ".jsonl");
            ledger.recordQueued(session, { id: `send-${uuid}`, text, origin: { kind: "agent", role } as never }, "turn-started");
            ledger.confirmDelivered(session, `send-${uuid}`, uuid);
          }
        } else {
          const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
          records.push({ type: "event_msg", timestamp: at(), payload: { type: "user_message", message: role ? encodeCodexStructuredUserText(text, undefined, null, { kind: "agent", role } as never) : text } },
            { type: "event_msg", timestamp: at(), payload: { type: "task_started" } });
        }
      };
      const harnessWake = async () => {
        if (engine === "claude") records.push({ type: "user", timestamp: at(), origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptSource: "system", message: { content: "<task-notification>done</task-notification>" } });
        else await external("Continue the interrupted turn from the transcript.", "startup-recovery");
      };
      const reply = (end: boolean) => {
        if (engine === "claude") records.push(end
          ? { type: "assistant", timestamp: at(), message: { model: "claude-opus", stop_reason: "end_turn", content: [{ type: "text", text: "Reviewed; continuing the stage." }] } }
          : { type: "assistant", timestamp: at(), message: { model: "claude-opus", stop_reason: "tool_use", content: [{ type: "tool_use", id: "chain-tool", name: "Read", input: {} }] } });
        else records.push(...(end
          ? [{ type: "event_msg", timestamp: at(), payload: { type: "agent_message", message: "Reviewed; continuing the stage." } },
            { type: "event_msg", timestamp: at(), payload: { type: "task_complete", last_agent_message: "Reviewed; continuing the stage." } }]
          : [{ type: "event_msg", timestamp: at(), payload: { type: "agent_message", message: "Reading the file" } },
            { type: "response_item", timestamp: at(), payload: { type: "function_call", call_id: "chain-call", name: "shell", arguments: "{}" } }]));
      };
      if (activity === "harness-control") await harnessWake();
      else if (activity === "orchestrator") await external("Continue reviewing", "orchestrator");
      else await external("Continue reviewing");
      if (activity !== "operator-refused") { f.advance(5_000); reply(activity !== "busy-operator"); }
      write();
      if (activity !== "same-tick" && activity !== "operator-refused") { f.h.setConversationActive(true); f.advance(10_000); await tickPipelines([], { ...f.h.ports }); }
      if (activity === "harness-control") {
        f.advance(Date.parse("2026-10-05T20:00:00Z") - f.now());
        await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, f.h.ports);
        await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, f.h.ports);
      }
      if (activity === "busy-operator" && engine === "codex") records.push({ type: "response_item", timestamp: at(), payload: { type: "function_call_output", call_id: "chain-call", output: "ok" } });
      if (activity !== "operator-refused") f.advance(Date.parse("2026-10-05T21:30:00Z") - f.now()); else f.advance(500);
      reset = secondReset;
      if (engine === "codex") records.push(quota(f.now(), secondReset));
      records.push(notice(f.now(), "2am"));
      write();
      f.h.setConversationActive(false);
      await tickPipelines([], { ...f.h.ports });
      f.advance(1_000);
      if (activity === "reply-after") { await external("Wait for my review"); write(); }
      if (activity === "control-after") {
        await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, f.h.ports);
        await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, f.h.ports);
      }
      while (f.now() < Date.parse("2026-10-05T23:05:00Z")) { f.advance(30_000); await tickPipelines([], { ...f.h.ports }); }
      const owed = !["reply-after", "control-after", "operator-refused"].includes(activity);
      expect({ sends: f.sends.length, state: loadPipelines()[0]!.state, detail: loadPipelines()[0]!.stateDetail?.split("\n")[0] ?? null })
        .toMatchObject(owed ? { sends: 1, state: "running" } : activity === "reply-after" ? { sends: 0 } : { sends: 0, state: "needs_decision" });
      expect(f.h.spawnInputs).toHaveLength(1);
    });
  }
}

// A parked retry holds while its stage works and follows the chain the turn ends in.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["harness", "harness-fresh", "harness-three", "harness-busy", "operator-busy", "reply-after", "control-after", "harness-no-output", "operator-refused"] as const)(`${engine} a parked retry follows the open cut chain (pool=${pool}, %s)`, async activity => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      let reset = CHAIN_RESET["10pm"];
      const allowed = pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
      f.h.ports.allowedAccountIds = () => allowed;
      if (activity === "harness-fresh") f.h.ports.accountRecovered = (_engine, id, cutAt) => {
        const sampledAt = reset * 1000 + 60_000;
        return id === LIMITED_ACCOUNT && sampledAt > cutAt && f.now() >= sampledAt && f.now() - sampledAt <= 5 * 60_000;
      };
      f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
        ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: reset, allowedAccountIds: allowed };
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(), ...(pool ? { triedAccounts: allowed } : {}) };
      savePipelines([lane]);
      const records: Record<string, unknown>[] = [];
      const file = stageTranscript(`chain-parked-${engine}-${pool}-${activity}`, []);
      const k = cutChainKit(f, engine, () => file, records);
      k.notice("10pm", reset);
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      let due = reset;
      if (activity === "harness-no-output" || activity === "operator-refused") {
        // Before the reset the provider refuses the wake or the reply at once.
        f.advance(Date.parse("2026-10-05T17:24:05Z") - f.now());
        if (activity === "harness-no-output") await k.harnessWake(); else k.operator("Wait for my review");
        f.advance(500);
        k.notice("10pm", reset);
        k.write();
        await tick();
      } else {
        // After the reset the stage's host wakes and the provider accepts the turn.
        f.h.setConversationActive(true);
        f.advance(Date.parse("2026-10-05T19:00:20Z") - f.now());
        if (activity === "operator-busy") k.operator("Continue reviewing"); else await k.harnessWake();
        f.advance(5_000);
        k.output(activity.endsWith("busy"));
        k.write();
        if (activity.endsWith("busy")) {
          // The turn stays busy across the first chain's retry time.
          while (f.now() < Date.parse("2026-10-05T21:29:00Z")) { f.advance(f.now() < Date.parse("2026-10-05T19:05:00Z") ? 30_000 : 10 * 60_000); await tick(); }
          expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
          f.advance(Date.parse("2026-10-05T21:30:00Z") - f.now());
          k.finishTool();
        } else f.advance(15_000);
        reset = CHAIN_RESET["2am"];
        k.notice("2am", reset);
        if (activity === "harness-three") {
          f.advance(5_000);
          await k.harnessWake();
          f.advance(5_000);
          k.output();
          f.advance(5_000);
          reset = CHAIN_RESET["3am"];
          k.notice("3am", reset);
        }
        k.write();
        f.h.setConversationActive(false);
        f.advance(3_000);
        await tick();
        due = reset;
        f.advance(1_000);
        if (activity === "reply-after") {
          k.operator("Wait for my review");
          f.advance(500);
          k.notice("2am", reset);
          k.write();
        }
        if (activity === "control-after") {
          await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, f.h.ports);
          await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, f.h.ports);
        }
        await tick();
      }
      while (f.now() < due * 1000 + 30_000) { f.advance(due * 1000 - f.now() > 10 * 60_000 ? 10 * 60_000 : 30_000); await tick(); }
      expect(f.h.spawnInputs).toHaveLength(1);
      while (f.now() < due * 1000 + 5 * 60_000) { f.advance(30_000); await tick(); }
      const owed = !["reply-after", "control-after", "operator-refused"].includes(activity);
      // An owed chain retries the stage at its own reset, never at the parked cut's.
      expect({ spawns: f.h.spawnInputs.length, sends: f.sends.length })
        .toEqual(owed ? { spawns: 2, sends: 0 } : { spawns: 1, sends: 0 });
      if (!owed) expect(loadPipelines()[0]!.state).toBe("needs_decision");
    });
  }
}

// A zero-time successor inherits a chain that its own first output closes.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each((pool ? ["harness", "operator", "pause-harness", "pause-operator", "three"] : ["harness", "operator", "pause-harness", "pause-operator", "three", "three-ticked", "reply-after", "control-after"]) as Array<"harness" | "operator" | "pause-harness" | "pause-operator" | "three" | "three-ticked" | "reply-after" | "control-after">)(`${engine} a zero-time successor owes the chain its own output opened (pool=${pool}, %s)`, async activity => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      const third = "fixture-account-c";
      let reset = CHAIN_RESET["10pm"];
      if (pool) {
        f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT, third];
        f.h.ports.accountForTranscript = (_engine, pathname) => ({ accountId: pathname.includes("stage-1") ? LIMITED_ACCOUNT : pathname.includes("stage-2") ? SPARE_ACCOUNT : third, label: "selected account" });
        f.h.ports.resolveProjectSpawn = (_engine, request) => ({ kind: "available", account: { engine,
          accountId: request.unavailableIds?.includes(SPARE_ACCOUNT) ? third : SPARE_ACCOUNT,
          kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
      } else {
        // A pane-less host relaunches on its pinned account at the reset.
        f.h.ports.resumeSeveredTurn = undefined;
        f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT];
        f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
          ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
          : { kind: "exhausted", resetsAt: reset, allowedAccountIds: [LIMITED_ACCOUNT] };
      }
      const first: Record<string, unknown>[] = [];
      const firstFile = stageTranscript(`chain-zero-first-${engine}-${pool}-${activity}`, []);
      const k1 = cutChainKit(f, engine, () => firstFile, first);
      k1.notice("10pm", reset);
      k1.write();
      const records: Record<string, unknown>[] = [];
      const file = path.join(process.env.LLV_STATE_DIR!, `chain-zero-successor-${engine}-${pool}-${activity}.jsonl`);
      readFixtures(f.h, { "/codex/stage-1.jsonl": firstFile, "/codex/stage-2.jsonl": file });
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      await tick();
      if (!pool) f.advance(Date.parse("2026-10-05T19:01:05Z") - f.now());
      for (let n = 0; n < 3 && f.h.spawnInputs.length < 2; n++) await tick();
      expect(f.h.spawnInputs).toHaveLength(2);
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerWait?.turnTs).toBe(0);
      // The successor's own transcript, all of it before its first recovery tick.
      const k = cutChainKit(f, engine, () => file, records);
      f.advance(60_000);
      reset = CHAIN_RESET["2am"];
      k.notice("2am", reset);
      if (activity.startsWith("pause") || activity === "three" || activity === "three-ticked") {
        f.advance(300);
        await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, f.h.ports);
        f.advance(300);
        await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, f.h.ports);
      }
      f.advance(400);
      if (activity.endsWith("operator") || activity === "three-ticked") k.operator("Continue reviewing"); else await k.harnessWake();
      f.advance(1_000);
      k.output();
      f.advance(pool ? 1_000 : Date.parse("2026-10-05T21:30:00Z") - f.now());
      reset = CHAIN_RESET[pool ? "2am" : "3am"];
      k.notice(pool ? "2am" : "3am", reset);
      if (activity === "three" || activity === "three-ticked") {
        if (activity === "three-ticked") { k.write(); await tick(); }
        f.advance(1_000);
        await k.harnessWake();
        f.advance(1_000);
        k.output();
        f.advance(pool ? 1_000 : 10 * 60_000);
        if (!pool) reset = CHAIN_RESET["3am"] + 3600;
        k.notice(pool ? "2am" : "4am", reset);
      }
      k.write();
      await tick();
      if (pool) for (let n = 0; n < 3 && f.h.spawnInputs.length < 3; n++) { f.advance(1_000); await tick(); }
      if (!pool) {
        f.advance(1_000);
        if (activity === "reply-after") { k.operator("Wait for my review"); f.advance(500); k.notice("3am", reset); k.write(); }
        if (activity === "control-after") {
          await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, f.h.ports);
          await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, f.h.ports);
        }
        while (f.now() < reset * 1000 + 30_000) { f.advance(reset * 1000 - f.now() > 10 * 60_000 ? 10 * 60_000 : 30_000); await tick(); }
        expect(f.h.spawnInputs).toHaveLength(2);
        // Stop at the relaunch: the fixture gives the third attempt no transcript.
        while (f.now() < reset * 1000 + 5 * 60_000 && f.h.spawnInputs.length < 3) { f.advance(30_000); await tick(); }
      }
      const owed = !["reply-after", "control-after"].includes(activity);
      const lane = loadPipelines()[0]!;
      expect({ spawns: f.h.spawnInputs.length, sends: f.sends.length, state: lane.state,
        tries: owed ? lane.runs[0]!.attempts.at(-1)!.providerRecoveryBudget?.tries : null })
        .toEqual(owed ? { spawns: 3, sends: 0, state: "running", tries: 1 } : { spawns: 2, sends: 0, state: "needs_decision", tries: null });
    });
  }
}

// A moved retry takes the new chain's kind, reset and budget.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each((pool ? ["capacity-then-quota", "auth-then-quota", "quota-then-capacity", "quota-quota-capacity", "capacity-reply-after", "capacity-control-after", "same-chain-capacity", "same-chain-capacity-reply"]
      : ["quota-then-capacity", "quota-quota-capacity", "capacity-reply-after", "capacity-control-after", "same-chain-capacity", "same-chain-capacity-reply"]) as Array<"capacity-then-quota" | "auth-then-quota" | "quota-then-capacity" | "quota-quota-capacity" | "capacity-reply-after" | "capacity-control-after" | "same-chain-capacity" | "same-chain-capacity-reply">)(`${engine} a parked retry moves to a newer chain of another kind (pool=${pool}, %s)`, async activity => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      const reset = CHAIN_RESET["10pm"];
      const allowed = pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      const records: Record<string, unknown>[] = [];
      f.h.ports.allowedAccountIds = () => allowed;
      let k: ReturnType<typeof cutChainKit>;
      const sourceCut = activity === "capacity-then-quota" || activity === "auth-then-quota";
      if (sourceCut) {
        // A successor on the spare, cut by capacity or authentication, parks
        // until the source account's reset.
        const limitedReset = reset;
        f.h.ports.accountForTranscript = (_engine, pathname) => ({ accountId: pathname.includes("stage-1") ? LIMITED_ACCOUNT : SPARE_ACCOUNT, label: "selected account" });
        f.h.ports.resolveProjectSpawn = (_engine, request) => {
          const id = [SPARE_ACCOUNT, LIMITED_ACCOUNT].find(candidate => !request.unavailableIds?.includes(candidate)
            && (candidate !== LIMITED_ACCOUNT || f.now() >= limitedReset * 1000 + 60_000));
          return id ? { kind: "available", account: { engine, accountId: id, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
            : { kind: "exhausted", resetsAt: limitedReset, allowedAccountIds: allowed };
        };
        const first: Record<string, unknown>[] = [];
        const firstFile = stageTranscript(`chain-kind-first-${engine}-${pool}-${activity}`, []);
        const k1 = cutChainKit(f, engine, () => firstFile, first);
        k1.notice("10pm", reset);
        k1.write();
        const file = path.join(process.env.LLV_STATE_DIR!, `chain-kind-successor-${engine}-${pool}-${activity}.jsonl`);
        readFixtures(f.h, { "/codex/stage-1.jsonl": firstFile, "/codex/stage-2.jsonl": file });
        for (let n = 0; n < 3 && f.h.spawnInputs.length < 2; n++) await tick();
        expect(f.h.spawnInputs).toHaveLength(2);
        const lane = loadPipelines()[0]!;
        // Exhaust the successor's bounded continuations.
        lane.runs[0]!.attempts.at(-1)!.providerRecoveryBudget!.tries = 3;
        savePipelines([lane]);
        k = cutChainKit(f, engine, () => file, records);
        f.advance(50_000);
        otherKindCut(f, engine, records, activity === "auth-then-quota" ? "auth" : "capacity");
        k.write();
        await tick();
        const parked = loadPipelines()[0]!;
        expect(parked.state).toBe("needs_decision");
        expect(parked.runs[0]!.attempts.at(-1)!.providerWait).toMatchObject({
          resumeAt: new Date(limitedReset * 1000 + 60_000).toISOString(), stageRetry: { fallback: false } });
        // Before the source's reset the spare's host wakes, works, and hits its own quota.
        f.h.setConversationActive(true);
        f.advance(Date.parse("2026-10-05T17:30:00Z") - f.now());
        await k.harnessWake();
        f.advance(5_000);
        k.output();
        f.advance(Date.parse("2026-10-05T17:40:00Z") - f.now());
        k.notice("2am", CHAIN_RESET["2am"]);
        k.write();
        f.h.setConversationActive(false);
        f.advance(3_000);
        await tick();
        const moved = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerWait;
        expect(moved).toMatchObject({ condition: { kind: "usage_limit" }, accountId: SPARE_ACCOUNT,
          resumeAt: new Date(limitedReset * 1000 + 60_000).toISOString(), stageRetry: { fallback: false } });
        while (f.now() < limitedReset * 1000 + 5 * 60_000 && f.h.spawnInputs.length < 3) { f.advance(f.now() < limitedReset * 1000 - 10 * 60_000 ? 10 * 60_000 : 30_000); await tick(); }
        expect(f.h.spawnInputs).toHaveLength(3);
        expect(f.h.spawnInputs[2]!.unavailableAccountIds).toContain(SPARE_ACCOUNT);
        expect(loadPipelines()[0]!.state).toBe("running");
        return;
      }
      f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
        ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: reset, allowedAccountIds: allowed };
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(), ...(pool ? { triedAccounts: allowed } : {}) };
      savePipelines([lane]);
      const file = stageTranscript(`chain-kind-parked-${engine}-${pool}-${activity}`, []);
      k = cutChainKit(f, engine, () => file, records);
      k.notice("10pm", reset);
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      await tick();
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
      if (activity.startsWith("same-chain")) {
        // After the reset the provider refuses the wake or the reply by capacity, with no output.
        f.h.setConversationActive(true);
        f.advance(Date.parse("2026-10-05T19:00:20Z") - f.now());
        if (activity === "same-chain-capacity") await k.harnessWake(); else k.operator("Wait for my review");
        f.advance(500);
        otherKindCut(f, engine, records, "capacity");
        k.write();
        f.h.setConversationActive(false);
        f.advance(3_000);
        await tick();
        const kept = activity === "same-chain-capacity";
        const witness = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait;
        if (kept) expect(witness).toMatchObject({ condition: { kind: "usage_limit" }, turnTs: Date.parse("2026-10-05T19:00:20.500Z"),
          resumeAt: new Date(reset * 1000 + 60_000).toISOString(), stageRetry: {} });
        else expect(witness?.stageRetry).toBeUndefined();
        while (f.now() < reset * 1000 + 5 * 60_000 && f.h.spawnInputs.length < 2) { f.advance(30_000); await tick(); }
        expect(f.h.spawnInputs).toHaveLength(kept ? 2 : 1);
        expect(loadPipelines()[0]!.state).toBe(kept ? "running" : "needs_decision");
        return;
      }
      // After the reset the host wakes and works; the turn ends on capacity.
      f.h.setConversationActive(true);
      f.advance(Date.parse("2026-10-05T19:00:20Z") - f.now());
      await k.harnessWake();
      f.advance(5_000);
      k.output();
      f.advance(15_000);
      if (activity === "quota-quota-capacity") {
        k.notice("2am", CHAIN_RESET["2am"]);
        f.advance(5_000);
        await k.harnessWake();
        f.advance(5_000);
        k.output();
        f.advance(5_000);
      }
      otherKindCut(f, engine, records, "capacity");
      k.write();
      f.h.setConversationActive(false);
      f.advance(3_000);
      await tick();
      const tickedAt = f.now();
      const owed = !activity.endsWith("-after");
      const moved = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait;
      // Capacity takes the running path's first backoff, a minute.
      expect(moved).toMatchObject({ condition: { kind: "transient" }, resumeAt: new Date(tickedAt + 60_000).toISOString(), stageRetry: { fallback: false } });
      f.advance(1_000);
      if (activity === "capacity-reply-after") { k.operator("Wait for my review"); f.advance(500); otherKindCut(f, engine, records, "capacity"); k.write(); }
      if (activity === "capacity-control-after") {
        await patchPipeline(loadPipelines()[0]!.id, { action: "pause" }, f.h.ports);
        await patchPipeline(loadPipelines()[0]!.id, { action: "resume" }, f.h.ports);
      }
      while (f.now() < tickedAt + 5 * 60_000 && f.h.spawnInputs.length < 2) { f.advance(30_000); await tick(); }
      expect({ spawns: f.h.spawnInputs.length, sends: f.sends.length })
        .toEqual(owed ? { spawns: 2, sends: 0 } : { spawns: 1, sends: 0 });
      expect(loadPipelines()[0]!.state).toBe(owed ? "running" : "needs_decision");
    });
  }
}
