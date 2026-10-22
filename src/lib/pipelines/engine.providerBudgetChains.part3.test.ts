import { expect, test, path, tickPipelines, loadPipelines, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerRecoveryHarness, cutChainKit, CHAIN_RESET } from "./engine.fixture";

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
      f.h.setConversationActive(false); // The provider ended the native turn at this limit.
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
