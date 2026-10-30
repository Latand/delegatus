import { expect, test, path, tickPipelines, loadPipelines, savePipelines, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerRecoveryHarness, cutChainKit, CHAIN_RESET, otherKindCut } from "./engine.fixture";

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
