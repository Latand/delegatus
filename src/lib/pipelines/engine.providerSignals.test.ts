import { expect, test, tickPipelines, loadPipelines, savePipelines, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, stampPipelinePrompt, providerRecoveryHarness, cutChainKit, CHAIN_RESET, otherKindCut, largeToolResult } from "./engine.fixture";


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
  }, 30_000);
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
      else records.push({ type: "event_msg", timestamp: at, payload: { type: "user_message", message: await (await import("@/lib/runtime/codexStructuredUserText.server")).encodeCodexStructuredUserText(text, undefined, null, { kind: "agent", role: "pipeline" }) } },
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
