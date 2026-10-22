import { expect, test, tickPipelines, loadPipelines, savePipelines, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerRecoveryHarness, cutChainKit, CHAIN_RESET } from "./engine.fixture";

export function registerParkedRetryChainCases(engines: readonly ("claude" | "codex")[]) {


// A parked retry holds while its stage works and follows the chain the turn ends in.
for (const engine of engines) {
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
}
