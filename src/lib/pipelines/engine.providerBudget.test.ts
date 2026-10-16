import { expect, test, fs, path, tickPipelines, loadPipelines, savePipelines, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, stampPipelinePrompt, providerRecoveryHarness } from "./engine.fixture";



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
        // Restore the historical control boundary: current pause stops this
        // active host, so only older records can continue its next quota cut.
        const prior = loadPipelines()[0]!;
        prior.pausedAt = prior.resumedAt = f.h.ports.now();
        prior.controlGeneration = "legacy-harness-control-before-cut";
        savePipelines([prior]);
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
    }, 30_000);
  }
}
