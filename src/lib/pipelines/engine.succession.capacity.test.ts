import { expect, test, fs, tickPipelines, loadPipelines, savePipelines, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerRecoveryHarness } from "./engine.fixture";


for (const pool of [false, true]) {
  test.each(["10pm", "11pm"] as const)(`parked harness quota notice persists its named %s reset (pool=${pool})`, async resetClock => {
    const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", null, !pool);
    f.advance(Date.parse("2026-10-05T16:54:09Z") - f.now());
    const originalReset = Date.parse("2026-10-05T19:00:00Z") / 1_000;
    const expectedReset = Date.parse(resetClock === "10pm" ? "2026-10-05T19:00:00Z" : "2026-10-05T20:00:00Z") / 1_000;
    f.h.ports.claudeAccountReset = () => originalReset;
    f.h.ports.allowedAccountIds = () => pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
    f.h.ports.resolveProjectSpawn = () => f.now() >= expectedReset * 1_000 + 60_000
      ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: expectedReset, allowedAccountIds: pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT] };
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(), ...(pool ? { triedAccounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT] } : {}) };
    if (pool) {
      attempt.accountId = SPARE_ACCOUNT;
      attempt.usageLimitedAccounts = [{ accountId: LIMITED_ACCOUNT, engine: "claude", resetsAt: originalReset, limitedAt: f.now() - 1_000 }];
    }
    savePipelines([lane]);
    const notice = (clock: string) => ({ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: `You've hit your session limit · resets ${clock} (Europe/Kyiv)` }] } });
    const records: Record<string, unknown>[] = [notice("10pm")];
    const file = stageTranscript("named-harness-reset", records);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
    f.advance(116_000);
    records.push({ type: "user", timestamp: f.h.ports.now(), origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptSource: "system",
      message: { role: "user", content: "<task-notification><task-id>background</task-id><status>completed</status></task-notification>" } });
    f.advance(500);
    records.push(notice(resetClock));
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await tickPipelines([], f.h.ports);
    const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!;
    expect(wait.turnTs).toBe(f.now());
    // The pool can retry the source's earlier window while the spare still waits.
    const due = pool ? originalReset : expectedReset;
    expect(wait.resumeAt).toBe(new Date(due * 1_000 + 60_000).toISOString());
    expect(wait.stageRetry?.detail).toBe(loadPipelines()[0]!.stateDetail!);
    // Source selection sees its own reset even if the spare named a later one.
    f.h.ports.resolveProjectSpawn = () => f.now() >= due * 1_000 + 60_000
      ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: due, allowedAccountIds: pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT] };
    while (f.now() < due * 1_000 + 120_000) { f.advance(30_000); await tickPipelines([], f.h.ports); }
    expect(f.h.spawnInputs).toHaveLength(2);
    // Several hundred controller passes cover the full reset window; let them
    // finish before the next fixture replaces their shared isolated store.
  }, 60_000);
}
