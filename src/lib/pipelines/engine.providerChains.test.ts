import { expect, test, tickPipelines, loadPipelines, savePipelines, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerRecoveryHarness, cutChainKit, CHAIN_RESET, largeToolResult } from "./engine.fixture";


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
