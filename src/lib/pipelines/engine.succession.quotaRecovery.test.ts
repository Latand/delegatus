import { expect, test, fs, path, tickPipelines, loadPipelines, savePipelines, durableStageTurnEvidence, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, providerRecoveryHarness } from "./engine.fixture";

for (const mode of ["running", "pinned-park", "pool-park"] as const) {
  test.each(["operator", "task-notification", "scheduled"] as const)(`${mode} quota cut distinguishes a newer %s turn`, async origin => {
    const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, mode !== "pool-park");
    const lane = loadPipelines()[0]!;
    if (mode !== "running") lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(),
      ...(mode === "pool-park" ? { triedAccounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT] } : {}) };
    if (mode === "pool-park") f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
    savePipelines([lane]);
    f.h.ports.resolveProjectSpawn = () => f.now() >= f.resetsAt! * 1_000 + 60_000
      ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: mode === "pool-park" ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT] };
    const notice = (ts: string) => ({ type: "assistant", timestamp: ts, isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } });
    const records: Record<string, unknown>[] = [notice(f.h.ports.now())];
    const file = stageTranscript("newer-quota-turn", records);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(1_000);
    records.push({ type: "queue-operation", operation: "enqueue", timestamp: f.h.ports.now() });
    records.push({ type: "user", timestamp: f.h.ports.now(),
      ...(origin === "operator" ? { turnOrigin: "sdk", promptSource: "sdk" }
        : origin === "scheduled" ? { isMeta: true, turnOrigin: "scheduled", promptSource: "system" }
        : { origin: { kind: origin }, turnOrigin: "task_notification", promptSource: "system" }),
      message: { role: "user", content: origin === "operator" ? "Please continue" : `<${origin}>background work ended</${origin}>` } });
    // Tick in the gap between native prompt publication and its limit notice.
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await tickPipelines([], f.h.ports);
    if (origin !== "operator") expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeDefined();
    f.advance(500);
    records.push(notice(f.h.ports.now()));
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await tickPipelines([], f.h.ports);
    if (mode !== "running" && origin !== "operator") expect(loadPipelines()[0]!.stateDetail).toMatch(/Automatic retry|Автоповтор/);
    for (let tick = 0; tick < 8; tick++) { f.advance(30_000); await tickPipelines([], f.h.ports); }
    expect(f.sends.length).toBe(mode === "running" && origin !== "operator" ? 1 : 0);
    expect(f.h.spawnInputs.length).toBe(mode !== "running" && origin !== "operator" ? 2 : 1);
    if (origin === "operator") {
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
    }
  });
}



test("quota continuation waits for a decision when prompt history exceeds the read bound", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  await tickPipelines([], f.h.ports);
  const cutAt = f.now();
  f.advance(1_000);
  // The saved cut opens the chain the 9 MiB record and the reply fall inside.
  const file = stageTranscript("quota-history-bound", [
    providerQuotaRecord("claude", cutAt),
    { type: "user", timestamp: f.h.ports.now(), promptSource: "sdk", message: { content: "Wait for my answer" } },
    { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(9 * 1024 * 1024) },
    { type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } },
  ]);
  const evidence = await durableStageTurnEvidence("claude", file, undefined, undefined, undefined, cutAt);
  expect(evidence?.promptHistoryComplete).toBe(false);
  f.h.durableTurns.set("/codex/stage-1.jsonl", evidence!);
  await tickPipelines([], f.h.ports);
  f.advance(11 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("prompt history is incomplete");
});



for (const engine of ["claude", "codex"] as const) {
  test.each(["pipeline", "startup-recovery"] as const)(`${engine} parked retry retains a delivered %s continuation`, async role => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const cutAt = f.now();
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    await tickPipelines([], f.h.ports);
    f.advance(1_000);
    const promptAt = f.h.ports.now();
    const origin = { kind: "agent" as const, role };
    const text = "Continue the interrupted turn from the transcript.";
    let records: Record<string, unknown>[];
    if (engine === "claude") records = [{ type: "user", uuid: "automatic-prompt", timestamp: promptAt, promptSource: "sdk", message: { content: text } }];
    else {
      const { persistStructuredUserMetadata } = await import("@/lib/selection/structuredUserMetadata");
      const { structuredContentDigest } = await import("@/lib/runtime/structuredContent");
      const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText");
      const ref = await persistStructuredUserMetadata({ version: 1, contentDigest: structuredContentDigest({ text, images: [] }), selectedContext: null, origin });
      records = [{ type: "event_msg", timestamp: promptAt, payload: { type: "user_message", message: encodeCodexStructuredUserText(text, ref) } },
        { type: "event_msg", timestamp: promptAt, payload: { type: "task_started" } }];
    }
    f.advance(500);
    records.push(engine === "claude" ? { type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
      message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", error: { message: "You've hit your session limit", codex_error_info: "usage_limit_exceeded" } } });
    records.unshift(providerQuotaRecord(engine, cutAt));
    const file = stageTranscript(`parked-controller-${engine}-${role}`, records);
    if (engine === "claude") {
      const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
      const ledger = new FileClaudeDeliveryLedger();
      const session = path.basename(file, ".jsonl");
      ledger.recordQueued(session, { id: "parked-automatic-prompt", text, origin }, "turn-started");
      ledger.confirmDelivered(session, "parked-automatic-prompt", "automatic-prompt");
    }
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
    for (let tick = 0; tick < 8; tick++) { f.advance(30_000); await tickPipelines([], f.h.ports); }
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.sends).toHaveLength(0);
  });
}



test.each(["claude", "codex"] as const)("%s pause and resume withdraws a running provider reset obligation", async engine => {
  const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
  await tickPipelines([], f.h.ports);
  const id = loadPipelines()[0]!.id;
  expect((await patchPipeline(id, { action: "pause" }, f.h.ports)).error).toBeUndefined();
  expect((await patchPipeline(id, { action: "resume" }, f.h.ports)).error).toBeUndefined();
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});


test("capacity relaunch preserves idle-only retirement and rechecks operator input after termination", async () => {
  const f = await providerRecoveryHarness("codex", "other", "Selected model is at capacity. Please try a different model.");
  f.h.ports.resumeSeveredTurn = undefined;
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  let stopOptions: unknown;
  f.h.ports.stopStageAgent = async (_target, options) => {
    stopOptions = options;
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1,
      prompts: [{ ts: f.now() + 1, origin: "external" }] });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(stopOptions).toEqual({ onlyIfIdle: true, providerRecovery: { pipelineId: loadPipelines()[0]!.id, stageId: loadPipelines()[0]!.cursor!.stageId, attempt: 1, turnTs: f.now() - 60_000, controlGeneration: loadPipelines()[0]!.controlGeneration ?? null } });
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
});


for (const mode of ["running", "pinned-park", "pool-park"] as const) {
  for (const wrapper of ["task-notification", "scheduled-trigger", "task", "bare-task"] as const) {
    test.each(["native-human", "ledger-human", "harness"] as const)(`Claude ${mode} ${wrapper} %s authorship controls quota recovery`, async author => {
      const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, mode !== "pool-park");
      const lane = loadPipelines()[0]!;
      if (mode !== "running") lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(),
        ...(mode === "pool-park" ? { triedAccounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT] } : {}) };
      if (mode === "pool-park") f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
      savePipelines([lane]);
      f.h.ports.resolveProjectSpawn = () => f.now() >= f.resetsAt! * 1_000 + 60_000
        ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: mode === "pool-park" ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT] };
      await tickPipelines([], f.h.ports);
      const initial = f.now();
      f.advance(1_000);
      const tag = wrapper === "task" || wrapper === "bare-task" ? "task-notification" : wrapper;
      const text = `<${tag}>Please wait for my review before continuing.</${tag}>`;
      const notice = (at: number) => ({ type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
        message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } });
      const file = stageTranscript(`claude-native-wrapper-${mode}-${wrapper}-${author}`, [notice(initial),
        { type: "user", uuid: "wrapper-user", isMeta: false, timestamp: f.h.ports.now(), message: { content: text },
          ...(author === "native-human" ? {} : { origin: wrapper === "bare-task" ? "task" : { kind: wrapper }, promptSource: "system" }) }, notice(f.now() + 500)]);
      if (author === "ledger-human") {
        const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
        const ledger = new FileClaudeDeliveryLedger();
        const session = path.basename(file, ".jsonl");
        ledger.recordQueued(session, { id: "wrapper-human-delivery", text, origin: { kind: "operator" } }, "turn-started");
        ledger.confirmDelivered(session, "wrapper-human-delivery", "wrapper-user");
      }
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      await tickPipelines([], f.h.ports);
      if (mode !== "running" && author === "harness") expect(loadPipelines()[0]!.stateDetail).toMatch(/Automatic retry|Автоповтор/);
      f.advance(180_000);
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(mode === "running" && author === "harness" ? 1 : 0);
      expect(f.h.spawnInputs).toHaveLength(mode !== "running" && author === "harness" ? 2 : 1);
      if (author !== "harness") expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
    });
  }
}
