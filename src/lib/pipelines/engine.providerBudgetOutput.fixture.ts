import { expect, test, fs, path, tickPipelines, loadPipelines, savePipelines, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, providerRecoveryHarness } from "./engine.fixture";

// Each pool gets its own file within the unchanged per-file gate budget.
export function registerProviderOutputBudgetCases(pools: readonly boolean[]) {
  for (const engine of ["claude", "codex"] as const) {
    for (const pool of pools) {
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
}
