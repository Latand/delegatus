import { expect, spyOn, test, crypto, spawn, fs, os, path, ProjectAccountRefusedError, worktreeDiskWait, engineModule, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, createPipelineFromRequest, loadPipelines, savePipelines, pipelineRevision, durableStageTurnEvidence, pipelineCompletedUnreviewed, loadTasks, saveTasks, interruptionObligationDirectory, interruptionObligationStore, patchPipeline, RUN_STAGES, entry, harness, create, withRuntimeSnapshot, boardTask, provisionRetryClock, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, stampPipelinePrompt, BUDGET_STAGES, REVIEW_HEADS, movingHeadHarness, driveWithController, driveLegacyTerminalRecheck, restartCutStage, cutByRestart, providerRecoveryHarness, parkedAccountCases, parkedAccountHarness, cutChainKit, CHAIN_RESET, otherKindCut, largeToolResult, publicationInterruptedReview } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";


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

// The closed chain's confirmation wait goes with it.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["held-fails", "held-lasting", "held-reply", "three-held-fails"] as const)(`${engine} a moved retry starts its own confirmation wait (pool=${pool}, %s)`, async activity => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      let reset = CHAIN_RESET["10pm"];
      const allowed = pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
      f.h.ports.allowedAccountIds = () => allowed;
      f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
        ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: reset, allowedAccountIds: allowed };
      let held = false;
      f.h.ports.conversationDeliveryOutstanding = () => held;
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(), ...(pool ? { triedAccounts: allowed } : {}) };
      savePipelines([lane]);
      const records: Record<string, unknown>[] = [];
      const file = stageTranscript(`chain-confirm-${engine}-${pool}-${activity}`, []);
      const k = cutChainKit(f, engine, () => file, records);
      k.notice("10pm", reset);
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      await tick();
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
      // A harness wake is written just before the retry time; its answer is not yet.
      f.h.setConversationActive(true);
      f.advance(Date.parse("2026-10-05T19:00:58Z") - f.now());
      await k.harnessWake();
      k.write();
      f.advance(2_000);
      await tick();
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait?.startedAt).toBe("2026-10-05T19:01:00.000Z");
      // The agent answers and works for hours.
      f.advance(30_000);
      k.output(true);
      k.write();
      while (f.now() < Date.parse("2026-10-05T21:29:00Z")) { f.advance(f.now() < Date.parse("2026-10-05T19:05:00Z") ? 30_000 : 10 * 60_000); await tick(); }
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      f.advance(Date.parse("2026-10-05T21:30:00Z") - f.now());
      k.finishTool();
      reset = CHAIN_RESET["2am"];
      k.notice("2am", reset);
      if (activity === "three-held-fails") {
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
      const due = reset * 1000 + 60_000;
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toMatchObject({ resumeAt: new Date(due).toISOString(), stageRetry: {} });
      while (f.now() < due - 30_000) { f.advance(due - f.now() > 10 * 60_000 ? 10 * 60_000 : 30_000); await tick(); }
      // A held delivery is outstanding at the retry time.
      f.advance(due - f.now());
      held = true;
      await tick();
      if (activity === "held-reply") {
        f.advance(15_000);
        k.operator("Wait for my review");
        f.advance(500);
        k.notice(reset === CHAIN_RESET["3am"] ? "3am" : "2am", reset);
        k.write();
        held = false;
      }
      const lasting = activity === "held-lasting";
      for (let n = 0; n < 10 && f.h.spawnInputs.length < 2; n++) {
        f.advance(30_000);
        if (!lasting && activity !== "held-reply") held = false;
        await tick();
      }
      if (lasting) {
        // Five minutes of real uncertainty spend the new chain's own budget only.
        expect(f.h.spawnInputs).toHaveLength(1);
        expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
        while (f.now() < due + 12 * 60_000) { f.advance(30_000); await tick(); }
        expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
        expect(loadPipelines()[0]!.stateDetail).toMatch(/could not confirm unchanged cut evidence/);
        expect(f.h.spawnInputs).toHaveLength(1);
        return;
      }
      const owed = activity !== "held-reply";
      expect({ spawns: f.h.spawnInputs.length, state: loadPipelines()[0]!.state })
        .toEqual(owed ? { spawns: 2, state: "running" } : { spawns: 1, state: "needs_decision" });
    });
  }
}

// One record over the bound before the open chain leaves that chain owed.
for (const engine of ["claude", "codex"] as const) {
  test.each([false, true])(`${engine} a large closed-history record leaves the next cut owed (pool=%p)`, async pool => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
    f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
    let reset = CHAIN_RESET["10pm"];
    if (pool) {
      f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
      f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
        ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: reset, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
    }
    const records: Record<string, unknown>[] = [];
    const file = stageTranscript(`chain-large-closed-${engine}-${pool}`, []);
    const k = cutChainKit(f, engine, () => file, records);
    k.notice("10pm", reset);
    k.write();
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
    await tick();
    f.advance(Date.parse("2026-10-05T19:01:30Z") - f.now());
    await tick();
    expect(f.sends).toHaveLength(1);
    f.advance(1_000);
    await k.harnessWake();
    k.output(true);
    f.advance(1_000);
    largeToolResult(f, engine, records, 9 * 1024 * 1024);
    f.advance(1_000);
    k.output();
    k.write();
    await tick();
    f.advance(Date.parse("2026-10-05T21:30:00Z") - f.now());
    reset = CHAIN_RESET["2am"];
    k.notice("2am", reset);
    k.write();
    f.h.setConversationActive(false);
    await tick();
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.turnTs).toBe(f.now());
    // Each tick scans the whole 9 MiB history: tick past the bounded wait, then around the reset.
    for (const at of ["2026-10-05T21:45:00Z", "2026-10-05T23:00:30Z"]) { f.advance(Date.parse(at) - f.now()); await tick(); }
    expect({ sends: f.sends.length, state: loadPipelines()[0]!.state }).toEqual({ sends: 1, state: "running" });
    f.advance(Date.parse("2026-10-05T23:01:30Z") - f.now());
    await tick();
    expect({ sends: f.sends.length, state: loadPipelines()[0]!.state, spawns: f.h.spawnInputs.length })
      .toEqual({ sends: 2, state: "running", spawns: 1 });
  });
}

// A running chain closed by agent output leaves no confirmation wait to the next one.
for (const engine of ["claude", "codex"] as const) {
  test.each([false, true])(`${engine} a closed running chain's confirmation wait never binds the next cut (pool=%p)`, async pool => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
    f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
    let reset = CHAIN_RESET["10pm"];
    if (pool) {
      f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
      f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
        ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: reset, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
    }
    let refused = true;
    f.h.ports.resumeSeveredTurn = async (input) => {
      if (refused) return false;
      f.sends.push(input.clientMessageId);
      f.h.setConversationActive(true);
      return true;
    };
    const records: Record<string, unknown>[] = [];
    const file = stageTranscript(`chain-confirmation-${engine}-${pool}`, []);
    const k = cutChainKit(f, engine, () => file, records);
    k.notice("10pm", reset);
    k.write();
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
    const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
    await tick();
    // The continuation is refused after the reset: the chain opens its bounded wait.
    f.advance(Date.parse("2026-10-05T19:01:00Z") - f.now());
    await tick();
    expect(attempt().controllerWait?.startedAt).toBe("2026-10-05T19:01:00.000Z");
    refused = false;
    f.advance(30_000);
    await k.harnessWake();
    k.output();
    k.write();
    await tick();
    expect({ wait: attempt().providerWait, confirmation: attempt().controllerWait, state: loadPipelines()[0]!.state })
      .toEqual({ wait: undefined, confirmation: undefined, state: "running" });
    // Two and a half hours later a new chain opens over history past the read bound.
    f.advance(Date.parse("2026-10-05T21:30:00Z") - f.now());
    reset = CHAIN_RESET["2am"];
    k.notice("2am", reset);
    const work = { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(1100) };
    for (let row = 0; row < 8500; row++) records.push(work);
    f.advance(1_000);
    k.notice("2am", reset);
    k.write();
    f.h.setConversationActive(false);
    await tick();
    expect({ state: loadPipelines()[0]!.state, startedAt: attempt().controllerWait?.startedAt })
      .toEqual({ state: "running", startedAt: "2026-10-05T21:30:01.000Z" });
    // Output closes the large chain; the next cut recovers after its reset.
    f.advance(30_000);
    k.output();
    f.advance(30_000);
    k.notice("2am", reset);
    k.write();
    await tick();
    expect(attempt().providerWait?.turnTs).toBe(f.now());
    for (const at of ["2026-10-05T21:45:00Z", "2026-10-05T23:00:30Z", "2026-10-05T23:01:30Z"]) { f.advance(Date.parse(at) - f.now()); await tick(); }
    expect({ sends: f.sends.length, state: loadPipelines()[0]!.state, spawns: f.h.spawnInputs.length })
      .toEqual({ sends: 1, state: "running", spawns: 1 });
  });
}

// With no tick between the output and the new chain, the closed chain's
// confirmation wait still goes with it when the new chain is over the read bound.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["hours-later", "same-wait"] as const)(`${engine} an unticked closed chain's confirmation wait never binds a new chain over the read bound (pool=${pool}, %s)`, async shape => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      let reset = CHAIN_RESET["10pm"];
      if (pool) {
        f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
        f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
          ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
          : { kind: "exhausted", resetsAt: reset, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
      }
      let refused = true;
      f.h.ports.resumeSeveredTurn = async (input) => {
        if (refused) return false;
        f.sends.push(input.clientMessageId);
        f.h.setConversationActive(true);
        return true;
      };
      const records: Record<string, unknown>[] = [];
      const file = stageTranscript(`chain-unticked-${engine}-${pool}-${shape}`, []);
      const k = cutChainKit(f, engine, () => file, records);
      k.notice("10pm", reset);
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
      await tick();
      // The continuation is refused after the reset: chain 1 opens its bounded wait.
      f.advance(Date.parse("2026-10-05T19:01:00Z") - f.now());
      await tick();
      expect(attempt().controllerWait?.startedAt).toBe("2026-10-05T19:01:00.000Z");
      refused = false;
      f.advance(30_000);
      await k.harnessWake();
      k.output();
      // No tick reads that output before chain 2 opens over the read bound.
      f.advance(Date.parse(shape === "hours-later" ? "2026-10-05T21:30:00Z" : "2026-10-05T19:01:50Z") - f.now());
      reset = CHAIN_RESET["2am"];
      k.notice("2am", reset);
      const work = { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(1100) };
      for (let row = 0; row < 8500; row++) records.push(work);
      f.advance(1_000);
      k.notice("2am", reset);
      k.write();
      f.h.setConversationActive(false);
      await tick();
      const opened = f.h.ports.now();
      expect({ state: loadPipelines()[0]!.state, startedAt: attempt().controllerWait?.startedAt })
        .toEqual({ state: "running", startedAt: opened });
      // Chain 2's own ten minutes run from its first confirmation tick.
      f.advance(Date.parse(opened) + 9 * 60_000 + 19_000 - f.now());
      await tick();
      expect({ state: loadPipelines()[0]!.state, startedAt: attempt().controllerWait?.startedAt })
        .toEqual({ state: "running", startedAt: opened });
      // Output closes chain 2; chain 3 recovers after its reset.
      f.advance(10_000);
      k.output();
      f.advance(10_000);
      k.notice("2am", reset);
      k.write();
      await tick();
      expect({ turnTs: attempt().providerWait?.turnTs, confirmation: attempt().controllerWait }).toEqual({ turnTs: f.now(), confirmation: undefined });
      for (const at of ["2026-10-05T21:45:00Z", "2026-10-05T23:00:30Z", "2026-10-05T23:01:30Z"]) { f.advance(Date.parse(at) - f.now()); await tick(); }
      expect({ sends: f.sends.length, state: loadPipelines()[0]!.state, spawns: f.h.spawnInputs.length })
        .toEqual({ sends: 1, state: "running", spawns: 1 });
    });
  }
}

// Incomplete history can open confirmation before any provider wait exists.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["hours-later", "same-wait", "closure-tick", "same-chain"] as const)(`${engine} first-tick incomplete chain owns its confirmation window (pool=${pool}, %s)`, async shape => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      f.h.ports.allowedAccountIds = () => pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
      const records: Record<string, unknown>[] = [];
      const file = stageTranscript(`chain-first-incomplete-${engine}-${pool}-${shape}`, []);
      const k = cutChainKit(f, engine, () => file, records);
      const oversized = () => records.push({ type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(9 * 1024 * 1024) });
      k.notice("10pm", CHAIN_RESET["10pm"]);
      oversized();
      f.advance(1_000);
      k.notice("10pm", CHAIN_RESET["10pm"]);
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      // Fresh ports on each tick read the persisted wait and the real transcript.
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
      await tick();
      const firstStartedAt = f.h.ports.now();
      expect(attempt().providerWait).toBeUndefined();
      expect(attempt().controllerWait?.startedAt).toBe(firstStartedAt);
      expect(loadPipelines()[0]!.state).toBe("running");

      f.advance(20_000);
      await k.harnessWake();
      if (shape !== "same-chain") k.output();
      if (shape === "closure-tick") {
        k.write();
        await tick();
        expect(attempt().controllerWait).toBeUndefined();
      }
      f.advance(Date.parse(shape === "hours-later" ? "2026-10-05T21:30:00Z" : "2026-10-05T17:22:50Z") - f.now());
      k.notice("2am", CHAIN_RESET["2am"]);
      oversized();
      f.advance(1_000);
      k.notice("2am", CHAIN_RESET["2am"]);
      k.write();
      await tick();
      const startedAt = shape === "same-chain" ? firstStartedAt : f.h.ports.now();
      expect({ state: loadPipelines()[0]!.state, startedAt: attempt().controllerWait?.startedAt })
        .toEqual({ state: "running", startedAt });
      expect(attempt().providerWait).toBeUndefined();
      expect(f.sends).toHaveLength(0);
      expect(f.h.spawnInputs).toHaveLength(1);

      // The new chain gets the full ten minutes; repeated cuts cannot extend it.
      f.advance(Date.parse(startedAt) + 9 * 60_000 + 59_000 - f.now());
      await tick();
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(attempt().controllerWait?.startedAt).toBe(startedAt);
      f.advance(1_000);
      await tick();
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain("provider transport recovery exhausted after 10 minutes");
      expect(attempt().providerWait?.stageRetry).toBeUndefined();
      expect(f.sends).toHaveLength(0);
      expect(f.h.spawnInputs).toHaveLength(1);
    });
  }
}

// A parked retry's confirmation wait goes with its chain when the next chain,
// read with no tick between, runs past the read bound.
for (const engine of ["claude", "codex"] as const) {
  test.each([false, true])(`${engine} an unticked closed parked chain's confirmation wait never binds a new chain over the read bound (pool=%p)`, async pool => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
    f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
    let reset = CHAIN_RESET["10pm"];
    const allowed = pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
    f.h.ports.allowedAccountIds = () => allowed;
    f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
      ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: reset, allowedAccountIds: allowed };
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(), ...(pool ? { triedAccounts: allowed } : {}) };
    savePipelines([lane]);
    const records: Record<string, unknown>[] = [];
    const file = stageTranscript(`chain-unticked-parked-${engine}-${pool}`, []);
    const k = cutChainKit(f, engine, () => file, records);
    k.notice("10pm", reset);
    k.write();
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
    const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
    await tick();
    expect(attempt().providerWait?.stageRetry).toBeDefined();
    // A harness wake is written just before the retry time; its answer is not yet.
    f.h.setConversationActive(true);
    f.advance(Date.parse("2026-10-05T19:00:58Z") - f.now());
    await k.harnessWake();
    k.write();
    f.advance(2_000);
    await tick();
    expect(attempt().controllerWait?.startedAt).toBe("2026-10-05T19:01:00.000Z");
    // The answer and a new chain over the read bound land before the next tick.
    f.advance(30_000);
    k.output();
    f.advance(20_000);
    reset = CHAIN_RESET["2am"];
    k.notice("2am", reset);
    const work = { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(1100) };
    for (let row = 0; row < 8500; row++) records.push(work);
    f.advance(1_000);
    k.notice("2am", reset);
    k.write();
    f.h.setConversationActive(false);
    await tick();
    expect({ state: loadPipelines()[0]!.state, resumeAt: attempt().providerWait?.resumeAt, retry: !!attempt().providerWait?.stageRetry, confirmation: attempt().controllerWait })
      .toEqual({ state: "needs_decision", resumeAt: new Date(reset * 1000 + 60_000).toISOString(), retry: true, confirmation: undefined });
    // Past the old chain's ten minutes the moved retry still holds.
    f.advance(Date.parse("2026-10-05T19:11:10Z") - f.now());
    await tick();
    expect(attempt().providerWait?.stageRetry).toBeDefined();
    // Output closes chain 2; chain 3 retries the stage at its reset.
    f.advance(10_000);
    k.output();
    f.advance(10_000);
    k.notice("2am", reset);
    k.write();
    await tick();
    expect(attempt().providerWait).toMatchObject({ turnTs: f.now(), stageRetry: {} });
    while (f.now() < reset * 1000 + 30_000) { f.advance(reset * 1000 - f.now() > 10 * 60_000 ? 10 * 60_000 : 30_000); await tick(); }
    expect(f.h.spawnInputs).toHaveLength(1);
    while (f.now() < reset * 1000 + 5 * 60_000 && f.h.spawnInputs.length < 2) { f.advance(30_000); await tick(); }
    expect({ spawns: f.h.spawnInputs.length, sends: f.sends.length }).toEqual({ spawns: 2, sends: 0 });
  });
}

// Tool or reasoning output closes a chain as text does; its budget goes with it.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["tool-closed", "reasoning-closed", "tool-same-tick", "open"] as const)(`${engine} agent output without a text message frees the closed chain's budget (pool=${pool}, %s)`, async shape => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      const reset = CHAIN_RESET["10pm"];
      if (pool) {
        f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
        f.h.ports.resolveProjectSpawn = () => f.now() >= reset * 1000 + 60_000
          ? { kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
          : { kind: "exhausted", resetsAt: reset, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
      }
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 2, startedAt: f.h.ports.now() };
      savePipelines([lane]);
      const records: Record<string, unknown>[] = [];
      const file = stageTranscript(`chain-budget-${engine}-${pool}-${shape}`, []);
      const k = cutChainKit(f, engine, () => file, records);
      k.notice("10pm", reset);
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      await tick();
      f.advance(Date.parse("2026-10-05T19:01:30Z") - f.now());
      await tick();
      expect(f.sends).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(3);
      // The engine's continuation, then work that writes no text message.
      f.advance(1_000);
      const text = "Continue the same stage";
      const at = f.h.ports.now();
      if (engine === "claude") records.push({ type: "user", uuid: `continued-${shape}`, timestamp: at, message: { content: text } });
      else records.push({ type: "event_msg", timestamp: at, payload: { type: "user_message", message: (await import("@/lib/runtime/codexStructuredUserText.server")).encodeCodexStructuredUserText(text, undefined, null, { kind: "agent", role: "pipeline" }) } },
        { type: "event_msg", timestamp: at, payload: { type: "task_started" } });
      if (shape !== "open") {
        f.advance(1_000);
        if (shape === "reasoning-closed") {
          records.push(engine === "claude"
            ? { type: "assistant", timestamp: f.h.ports.now(), message: { model: "claude-opus", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "Nothing left to change" }] } }
            : { type: "response_item", timestamp: f.h.ports.now(), payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Nothing left to change" }] } });
        } else {
          k.output(true);
          f.advance(1_000);
          largeToolResult(f, engine, records, 100);
        }
        f.advance(1_000);
        records.push(engine === "claude" ? { type: "result", subtype: "success", timestamp: f.h.ports.now() }
          : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete" } });
      }
      k.write();
      if (engine === "claude") await stampPipelinePrompt(file, `continued-${shape}`, text);
      if (shape !== "tool-same-tick") {
        f.advance(5_000);
        await tick();
        expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(shape === "open" ? 3 : undefined);
      }
      f.advance(Date.parse("2026-10-05T21:30:00Z") - f.now());
      otherKindCut(f, engine, records, "capacity");
      k.write();
      f.h.setConversationActive(false);
      await tick();
      const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait;
      if (shape === "open") {
        // The chain the continuation entered is still open: its spent budget parks.
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.stateDetail).toContain("after 3 tries");
        return;
      }
      expect(wait).toMatchObject({ condition: { kind: "transient" }, tries: 0, resumeAt: new Date(f.now() + 60_000).toISOString() });
      f.advance(60_000);
      await tick();
      expect({ sends: f.sends.length, state: loadPipelines()[0]!.state, spawns: f.h.spawnInputs.length })
        .toEqual({ sends: 2, state: "running", spawns: 1 });
    });
  }
}

// A closing Claude API error opens its own recovery read on the first tick.
for (const engine of ["claude", "codex"] as const) {
  for (const pool of [false, true]) {
    test.each(["cut", "reply-after"] as const)(`${engine} a closing capacity cut after large work owes its first backoff (pool=${pool}, %s)`, async activity => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", null, !pool);
      f.advance(Date.parse("2026-10-05T17:22:09Z") - f.now());
      if (pool) {
        f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
        f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
      }
      const records: Record<string, unknown>[] = [];
      const file = stageTranscript(`closing-capacity-${engine}-${pool}-${activity}`, []);
      const k = cutChainKit(f, engine, () => file, records);
      k.operator("run the stage");
      f.advance(1_000);
      k.output(true);
      f.advance(1_000);
      largeToolResult(f, engine, records, 150_000);
      f.advance(1_000);
      otherKindCut(f, engine, records, "capacity");
      k.write();
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      const tick = async () => { await tickPipelines([], { ...f.h.ports }); };
      await tick();
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toMatchObject({ condition: { kind: "transient" }, tries: 0 });
      if (activity === "reply-after") {
        f.advance(1_000);
        k.operator("Wait for my review");
        k.write();
      }
      for (let n = 0; n < 4; n++) { f.advance(30_000); await tick(); }
      if (activity === "cut") {
        expect({ sends: f.sends.length, state: loadPipelines()[0]!.state }).toEqual({ sends: 1, state: "running" });
      } else expect(f.sends).toHaveLength(0);
      expect(f.h.spawnInputs).toHaveLength(1);
    });
  }
}

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
