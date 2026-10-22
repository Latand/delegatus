import { expect, test, tickPipelines, loadPipelines, savePipelines, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerRecoveryHarness, cutChainKit, CHAIN_RESET } from "./engine.fixture";

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
