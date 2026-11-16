import { expect, test, crypto, spyOn, harness, create, tickPipelines, patchPipeline, loadPipelines,
  savePipelines, IDLE_TURN_QUIET_MS, fs, path } from "./engine.fixture";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { attemptAccountPin } from "./runtimeSwitch";

const cases = (["resume", "retry-stage", "host-lost"] as const).flatMap(action =>
  (["engine", "same-engine", "unpin", "unchanged", "revoked"] as const).map(change => ({ action, change })));

test.each(cases)(
  "a configured runtime reaches the attempt reserved by $action ($change)", async ({ action, change }) => {
    let sequence = 0;
    const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
      `95000001-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`);
    try {
      for (const account of listCodexAccounts()) {
        fs.mkdirSync(account.home, { recursive: true });
        fs.writeFileSync(path.join(account.home, "models_cache.json"), JSON.stringify({
          models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "ultrafast" }] }],
        }));
      }
      const h = harness();
      const sourceEngine = change === "same-engine" ? "codex" : "claude";
      const sourceModel = sourceEngine === "codex" ? "gpt-6.1-sol" : "opus";
      const account = change === "unpin" ? null : "default";
      h.ports.roleLookup = () => ({ engine: sourceEngine, model: sourceModel, effort: "high", promptScaffold: "Build" });
      let allowed = ["account-a", "default"];
      h.ports.allowedAccountIds = () => allowed;
      h.ports.accountExhausted = () => false;
      h.ports.resolveProjectSpawn = (engine, request) => ({ kind: "available", account: {
        engine, accountId: request.requestedId ?? request.preferredId ?? "default", kind: "managed",
        home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
      } });
      const spawn = h.ports.spawnAgent;
      h.ports.spawnAgent = async (input, reserved) => ({ ...await spawn(input, reserved),
        accountId: input.requestedAccountId ?? "default" });
      const lane = await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" },
        account: "account-a", prompt: "Build", next: null }] as never);
      await tickPipelines([], h.ports); await tickPipelines([], h.ports);
      const current = () => loadPipelines().find(row => row.id === lane.id)!;
      const original = current().runs[0]!.attempts[0]!;
      expect(original).toMatchObject({ effectiveRole: { engine: sourceEngine, model: sourceModel, effort: "high" },
        definition: { account: "account-a" } });
      h.durableTurns.set(original.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
      if (action !== "host-lost") expect((await patchPipeline(lane.id, { action: "pause" }, h.ports)).error).toBeUndefined();
      if (change !== "unchanged") {
        const overridden = await patchPipeline(lane.id, { action: "override-stage", stageId: "build",
          engine: "codex", model: "gpt-6-astra", effort: "xhigh", serviceTier: "ultrafast", account }, h.ports);
        expect(overridden).toMatchObject({ graphEdit: { effect: "pending-next-attempt", appliesFromAttempt: 2 } });
      }
      if (change === "revoked") allowed = [];
      if (action === "host-lost") {
        const saved = current();
        saved.runs[0]!.attempts[0]!.paneId = null;
        savePipelines([saved]);
        h.ports.conversationTurnInterrupted = async () => "dead";
        h.ports.restartRecoveryBootId = () => "fixture-boot";
        h.ports.restartRecoveryBootStartedAt = () => Date.parse(original.startedAt!) - 60_000;
        h.advanceWallClock(IDLE_TURN_QUIET_MS);
      } else {
        expect((await patchPipeline(lane.id, { action: "resume" }, h.ports)).error).toBeUndefined();
        if (action === "retry-stage") expect((await patchPipeline(lane.id, {
          action: "retry-stage", expectedStageId: "build", expectedAttempt: 1,
        }, h.ports)).error).toBeUndefined();
      }
      if (change === "revoked") {
        await tickPipelines([], h.ports);
        expect(h.spawnInputs).toHaveLength(1);
        allowed = ["account-a", "default"];
        h.advanceWallClock(60_000);
      }
      for (let tick = 0; tick < 3; tick++) await tickPipelines([], h.ports);
      const attempts = current().runs[0]!.attempts;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.effectiveRole.engine).toBe(sourceEngine);
      expect(attempts[0]!.definition!.account).toBe("account-a");
      if (change === "unchanged") {
        expect(attempts[1]!.effectiveRole).toEqual(original.effectiveRole);
        expect(attemptAccountPin(current().stages[0]!, attempts[1]!)).toBe("account-a");
        return;
      }
      expect(attempts[1]).toMatchObject({ state: "running", effectiveRole: { engine: "codex", model: "gpt-6-astra",
        effort: "xhigh", serviceTier: "ultrafast" }, definition: { account }, accountId: "default" });
      expect(attemptAccountPin(current().stages[0]!, attempts[1]!)).toBe(account);
      expect(h.spawnInputs[1]).toMatchObject({ role: { engine: "codex", model: "gpt-6-astra", effort: "xhigh",
        serviceTier: "ultrafast" }, requestedAccountId: account, cwd: lane.worktreeDir });
      expect(current().worktreeDir).toBe(lane.worktreeDir);
      expect(h.calls.some(call => /reset --hard|clean -/.test(call))).toBe(false);
    } finally { ids.mockRestore(); }
  });
