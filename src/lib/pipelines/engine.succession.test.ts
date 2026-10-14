import { expect, test, spawnSync, fs, path, AccountAuthenticationRequiredError, selectProjectAccount, IDLE_TURN_QUIET_MS, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, registerPipelineTick, engineModule, loadPipelines, savePipelines, pipelineIdentity, pipelineRevision, durableStageTurnEvidence, loadTasks, saveTasks, patchPipeline, ORIGIN_MAIN_SHA, entry, harness, create, withRuntimeSnapshot, forbiddenSleep, PASS_TEXT, pinStageHead, runningStructuredStage, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, stampPipelinePrompt, BUDGET_STAGES, movingHeadHarness, critiqueRound, buildRound, continueReview, movingHead, seedLegacyTerminalRecheck, driveLegacyTerminalRecheck, HOST_UNAVAILABLE, failedReceipt, stagedRecoveryHarness, recoveryReport, expectProviderParkAt, providerRecoveryHarness } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";


test.each(["continuation", "capacity"] as const)("a legacy %s quota park whose stated reset passed retries without operator input", async (cause) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  const legacy = loadPipelines()[0]!;
  const attempt = legacy.runs[0]!.attempts[0]!;
  delete attempt.providerWait!.stageRetry;
  const recovery = attempt.providerRecoveries!.at(-1)!;
  if (cause === "capacity") {
    recovery.summary = "account capacity recovery exhausted";
    attempt.providerWait!.capacityProbes = 3;
    legacy.stateDetail = attempt.error = `stage cut by ${attempt.providerWait!.condition.label}: no account capacity returned; capacity recovery exhausted after 3 due probes`;
  } else legacy.stateDetail = attempt.error = recovery.summary;
  savePipelines([legacy]);
  f.advance(180_000);
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(2);
});

test.each(["en", "uk"] as const)("a parked provider retry names its automatic resume time in %s", async (locale) => {
  const { updateOperatorSettings, resetOperatorSettingsForTests } = await import("@/lib/operator/settings");
  const settings = path.join(process.env.LLV_STATE_DIR!, "operator-settings.json");
  const previous = fs.existsSync(settings) ? fs.readFileSync(settings) : null;
  try {
    updateOperatorSettings({ locale, source: "chosen", timeZone: "Europe/Kyiv" });
    const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
    // An explicit pin must never consult the automatic account pool.
    let selections = 0;
    f.h.ports.resolveProjectSpawn = () => { selections += 1; throw new Error("pinned account was substituted"); };
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    await tickPipelines([], f.h.ports);
    const parked = loadPipelines()[0]!;
    expect(parked.stateDetail).toContain(locale === "en" ? "Automatic retry" : "Автоповтор");
    expect(parked.stateDetail).not.toContain(new Date(f.resetsAt! * 1_000 + 60_000).toISOString());
    expect(selections).toBe(0);
  } finally {
    if (previous) fs.writeFileSync(settings, previous);
    else fs.rmSync(settings, { force: true });
    resetOperatorSettingsForTests();
  }
});

for (const engine of ["claude", "codex"] as const) {
  for (const pinned of [false, true]) {
    test(`${engine} weekly limit keeps running until reset, pinned=${pinned}`, async () => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your weekly limit · resets 2:30pm", 120_000, pinned);
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(loadPipelines()[0]!.stateDetail).toContain("weekly limit");
      expect(loadPipelines()[0]!.stateDetail).toContain(new Date(f.resetsAt! * 1_000).toISOString());
      f.advance(120_000);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(0);
      f.advance(60_000);
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    });
  }
}

test.each(["session", "weekly"] as const)("native Claude %s reset waits without spending unknown-reset budget and retains real WIP", async (scope) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", `You've hit your ${scope} limit`);
  f.advance(Date.parse("2026-10-02T00:16:00Z") - f.now());
  const resetsAt = Date.parse("2026-10-02T14:30:00Z");
  const transcript = stageTranscript(`native-claude-${scope}-reset`, [{
    type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: `You've hit your ${scope} limit · resets 2:30pm (UTC)` }] },
  }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": transcript });
  const container = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "native-reset-wip-"));
  const lane = loadPipelines()[0]!;
  lane.repoDir = path.join(container, "repo");
  const root = lane.worktreeDir = path.join(container, `repo-pipeline-${lane.id}`);
  fs.mkdirSync(root);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  (await git("init", "-b", "main"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  (await git("add", "tracked.txt"));
  (await git("-c", "user.name=Recovery Fixture", "-c", "user.email=noreply", "commit", "-m", "fixture"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "staged work\n");
  (await git("add", "tracked.txt"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "unstaged work\n");
  fs.writeFileSync(path.join(root, "untracked.txt"), "untracked work\n");
  const head = (await git("rev-parse", "HEAD"));
  const index = fs.readFileSync(path.join(root, ".git", "index"));
  savePipelines([lane]);
  const baseExec = f.h.ports.exec;
  f.h.ports.exec = (command, args, cwd, options) => command === "git" && args[0] === "-C" && args[1] === root
    ? (() => { const result = spawnSync(command, args, { encoding: "utf8" }); return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }; })()
    : baseExec(command, args, cwd, options);
  try {
    for (const at of [f.now(), f.now() + 30 * 60_000, f.now() + 6 * 60 * 60_000, resetsAt, resetsAt + 59_000]) {
      f.advance(at - f.now());
      await tickPipelines([], f.h.ports);
      const waiting = loadPipelines()[0]!;
      expect(waiting.state).toBe("running");
      expect(waiting.stateDetail).toContain("2026-10-02T14:30:00.000Z");
      expect(waiting.runs[0]!.attempts[0]!.providerWait).toMatchObject({ tries: 0, resetsAt: resetsAt / 1_000 });
      expect(f.sends).toHaveLength(0);
    }
    f.advance(1_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("unstaged work\n");
    expect(fs.readFileSync(path.join(root, "untracked.txt"), "utf8")).toBe("untracked work\n");
    expect(fs.readFileSync(path.join(root, ".git", "index"))).toEqual(index);
    expect((await git("rev-parse", "HEAD"))).toBe(head);
  } finally { fs.rmSync(container, { recursive: true, force: true }); }
});

test("a native Claude weekly reset remains authoritative over an earlier cached session reset", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit");
  f.advance(Date.parse("2026-10-02T00:16:00Z") - f.now());
  const earlyReset = f.now() + 60 * 60_000;
  f.h.ports.claudeAccountReset = () => earlyReset / 1_000;
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript("native-weekly-cached-session-reset", [{
    type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit · resets Oct 9 at 2:30pm (UTC)" }] },
  }]) });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.resetsAt).toBe(Date.parse("2026-10-09T14:30:00Z") / 1_000);
  f.advance(earlyReset + 60_000 - f.now());
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("running");
});

test.each([false, true])("known native reset waiting does not exhaust a subsequent unknown-reset backoff, reopened=%s", async (reopened) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit");
  f.advance(Date.parse("2026-10-02T00:16:00Z") - f.now());
  const transcript = stageTranscript("native-reset-then-unknown", [{
    type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit · resets 2:30pm (UTC)" }] },
  }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": transcript });
  await tickPipelines([], f.h.ports);
  f.advance(Date.parse("2026-10-02T14:31:00Z") - f.now());
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  if (reopened) {
    f.advance(1_000);
    fs.appendFileSync(transcript, JSON.stringify({ type: "user", uuid: "unknown-reset-controller", promptSource: "sdk", timestamp: f.h.ports.now(), message: { role: "user", content: "Continue the same stage" } }) + "\n");
    await stampPipelinePrompt(transcript, "unknown-reset-controller", "Continue the same stage");
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.actionAt).toBeDefined();
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(1);
  }
  f.h.setConversationActive(false);
  f.advance(1_000);
  fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit" }] } }) + "\n");
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toMatchObject({ tries: 1, resetsAt: null });
  f.advance(30 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(2);
  f.advance(6 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("weekly limit");
});

test("a report wins over a terminal limit without sending a continuation", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit");
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.report = recoveryReport(f.h.ports.now());
  savePipelines([pipeline]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
  expect(f.sends).toHaveLength(0);
});

test("unknown usage reset probes at 30 minutes and parks at six hours with its cause", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've reached your Fable limit");
  await tickPipelines([], f.h.ports);
  f.advance(30 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  f.advance(6 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("fable limit");
});

test("three delayed auth race continuations exhaust with the provider cause", async () => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  for (let n = 0; n < 3; n += 1) {
    f.cut();
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n);
    f.advance(60_000 * 2 ** n);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n + 1);
    f.advance(1_000);
  }
  f.cut();
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("auth refresh race after 3 tries");
});

test("native model capacity cuts retry with bounded backoff before parking", async () => {
  const text = "Selected model is at capacity. Please try a different model.";
  const f = await providerRecoveryHarness("codex", "other", text);
  const scheduled: number[] = [];
  f.h.ports.scheduleTick = ms => { scheduled.push(ms); };
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript("native-capacity", [{
    type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", error: { message: text } },
  }]) });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(f.sends).toHaveLength(0);
  // Continue through the fake evidence seam after the first native cut.
  f.h.ports.durableTurnEvidence = async (_engine, pathname) => f.h.durableTurns.get(pathname) ?? null;
  for (let n = 0; n < 3; n += 1) {
    if (n > 0) { f.cut(); f.h.setConversationActive(false); await tickPipelines([], f.h.ports); }
    f.advance(60_000 * 2 ** n - 1);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n);
    f.advance(1);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n + 1);
    f.advance(1_000);
  }
  f.cut();
  f.h.setConversationActive(false);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("model at capacity after 3 tries");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  expect(new Set(f.sends).size).toBe(3);
  expect(scheduled).toContain(60_000);
  expect(scheduled).toContain(120_000);
  expect(scheduled).toContain(240_000);
});

test.each([false, true])("a silent dead read-write host relaunches with WIP and parks on its second death, inherited=%s", async (inherited) => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  const inheritedMessage = inherited ? { text: "Earlier stage output", ts: now - 60_000 } : null;
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: inheritedMessage, launchOnly: !inherited });
  const launchId = loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId;
  const stoppedLaunches: Array<string | null | undefined> = [];
  h.ports.stopStageAgent = async (target) => {
    stoppedLaunches.push(target.launchId);
    return target.launchId ? { outcome: "not-running" } : { outcome: "failed", error: "missing launch identity" };
  };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("stage host died without output");
  now += 30_000;
  await tickPipelines([], h.ports);
  expect(stoppedLaunches).toEqual([launchId]);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.prompt).toContain("Its changes remain in this worktree");
  expect(h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts[1]!.paneId = null;
  savePipelines([pipeline]);
  h.durableTurns.set("/codex/stage-2.jsonl", { turn: "busy", message: null, launchOnly: true });
  await tickPipelines([], h.ports);
  now += 30_000;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("died without output twice");
  expectProviderParkAt(loadPipelines()[0]!, h.ports.now());
  expect(h.spawnInputs).toHaveLength(2);
});

test("a staged unpublished report bypasses the recovery probe and follows the pass edge", async () => {
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.report = recoveryReport(f.h.ports.now());
  savePipelines([pipeline]);
  f.h.ports.conversationAgentActive = async () => false;
  pinStageHead(f.h);
  f.advance(3 * 60_000);
  const probes = f.lookups.length;
  await tickPipelines([], f.h.ports);
  expect(f.attempt().state).toBe("passed");
  expect(f.lookups).toHaveLength(probes);
});

test("a silent dead pane-hosted stage relaunches with WIP after the bounded wait", async () => {
  const h = harness();
  await runningStructuredStage(h);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.paneId = "%cut-stage";
  savePipelines([lane]);
  h.setPaneAlive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, launchOnly: true });
  await tickPipelines([{ ...entry("/codex/stage-1.jsonl"), activity: "live" }], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("stage host died without output");
  h.advanceWallClock(30_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.prompt).toContain("keeping uncommitted work");
  expect(h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
});

test("audit item B: a Codex turn_aborted resumes with WIP and never requests a verdict or spends a fix round", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  const cutAt = now;
  const artifact = stageTranscript("aborted-stage", [
    { timestamp: new Date(now - 1_000).toISOString(), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "turn_aborted" } },
  ]);
  readFixtures(h, { "/codex/stage-1.jsonl": artifact });
  const sent: Parameters<NonNullable<PipelinePorts["resumeSeveredTurn"]>>[0][] = [];
  h.ports.resumeSeveredTurn = async (input) => { sent.push(input); return true; };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("aborted stage turn");
  now = cutAt + 30_000;
  await tickPipelines([], h.ports);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain("keeping uncommitted work");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("plan");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict).toBeNull();
  expect(h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
});

test("unknown resets retain the three-continuation bound across repeated limit turns", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit");
  for (let n = 0; n < 3; n += 1) {
    f.cut();
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    f.advance(30 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n + 1);
    f.advance(1_000);
  }
  f.cut();
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("weekly limit");
});

test.each([false, true])("a busy resumed turn retires the old unknown-reset wait, assistant progress=%s", async (assistantProgress) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit");
  await tickPipelines([], f.h.ports);
  f.advance(30 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  f.advance(1_000);
  f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", lastRecordAt: f.now(),
    message: assistantProgress ? { text: "Working on the current stage", ts: f.now() } : null });
  f.advance(6 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  const active = loadPipelines()[0]!;
  expect(active.state).toBe("running");
  expect(active.stateDetail).toBeNull();
  expect(active.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
  // A started turn retires its old cut; only agent output clears expenditure.
  expect(active.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(assistantProgress ? undefined : 1);
  expect(f.sends).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test.each([false, true])("an active unknown limit adopts a newly known future reset before expiry, pinned=%s", async (pinned) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit", null, pinned);
  await tickPipelines([], f.h.ports);
  const futureReset = Math.floor((f.now() + 7 * 24 * 60 * 60_000) / 1_000);
  if (pinned) f.h.ports.claudeAccountReset = () => futureReset;
  else f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: futureReset, allowedAccountIds: [LIMITED_ACCOUNT] });
  f.advance(6 * 60 * 60_000);
  for (let n = 0; n < 20; n += 1) {
    await tickPipelines([], f.h.ports);
    const waiting = loadPipelines()[0]!;
    expect(waiting.state).toBe("running");
    expect(waiting.runs[0]!.attempts[0]!.providerWait!.resetsAt).toBe(futureReset);
    expect(waiting.stateDetail).toContain(new Date(futureReset * 1_000).toISOString());
    expect(f.sends).toHaveLength(0);
    f.advance(30 * 60_000);
  }
  f.advance(futureReset * 1_000 + 60_000 - f.now());
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

for (const pinned of [false, true]) {
  test(`authentication required with no permitted switch parks with its condition, pinned=${pinned}`, async () => {
    const f = await providerRecoveryHarness("claude", "authentication_failed", "OAuth session expired and could not be refreshed", null, pinned);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("authentication required");
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
    expect(f.sends).toHaveLength(0);
  });
}

test("authentication required switches an unpinned Claude stage to an allowed account", async () => {
  const f = await providerRecoveryHarness("claude", "authentication_failed", "expired");
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  const switches: string[] = [];
  f.h.ports.requestConversationReseat = async (_id, account) => { switches.push(account); };
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(switches).toEqual([]);
  expect(f.sends).toHaveLength(0);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  expect(loadPipelines()[0]!.state).toBe("running");
});

test("four limit-cut lanes wait without parking and continue independently once reset", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000);
  const source = loadPipelines()[0]!;
  const lanes = Array.from({ length: 4 }, (_, n) => {
    const lane = structuredClone(source);
    lane.id = `${source.id.slice(0, 7)}${n}`;
    Object.assign(lane, pipelineIdentity(lane.id, lane.task, lane.repoDir));
    if (lane.delivery) {
      lane.delivery.ownerId = lane.id;
      lane.delivery.target.branch = `refs/heads/${lane.branch}`;
    }
    return lane;
  });
  savePipelines(lanes);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines().map((lane) => lane.state)).toEqual(["running", "running", "running", "running"]);
  expect(loadPipelines().every((lane) => lane.stateDetail?.includes(new Date(f.resetsAt! * 1_000).toISOString()))).toBe(true);
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(4);
  expect(new Set(f.sends).size).toBe(4);
});

test.each([false, true])("a resumed provider-cut host that dies before new output relaunches with WIP, timestamp=%s", async (timestamp) => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  if (timestamp) f.h.ports.conversationHostUnavailableSince = async () => new Date(f.now() - 5 * 60_000).toISOString();
  else f.h.setConversationActive(false);
  await tickPipelines([], f.h.ports);
  f.advance(30_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.prompt).toContain("keeping uncommitted work");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
});

test.each([false, true])("accepted provider continuations fence relaunch until delivery, delivered=%s", async (delivered) => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  let settled = false;
  const keys: string[] = [];
  f.h.ports.conversationDeliveryOutstanding = () => !settled;
  f.h.ports.conversationDeliveryCompleted = (_id, key) => { keys.push(key); return settled; };
  f.h.ports.resumeSeveredTurn = async (input) => { f.sends.push(input.clientMessageId); return true; };
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  const key = f.sends[0]!;
  for (let tick = 0; tick < 3; tick += 1) {
    f.advance(60_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(f.sends).toEqual([key]);
  }
  if (delivered) {
    settled = true;
    f.advance(60_000);
    await tickPipelines([], f.h.ports);
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(keys.every(candidate => candidate === key)).toBe(true);
  } else {
    f.advance(10 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("accepted continuation delivery is still pending");
    expect(f.h.spawnInputs).toHaveLength(1);
  }
  expect(f.sends).toEqual([key]);
});

test("a relaunched stage observes its next provider cut before checking continuation delivery", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const retry = lane.runs[0]!.attempts[1]!;
  retry.paneId = null;
  savePipelines([lane]);
  f.advance(1_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] });
  const queriedKeys: string[] = [];
  // The fresh host has no provider continuation delivery at all yet.
  f.h.ports.conversationDeliveryCompleted = (_id, key) => { queriedKeys.push(key); return false; };
  f.h.durableTurns.set(retry.agentPath!, { turn: "terminal", message: null,
    terminalProviderMessage: { text: "You've hit your usage limit", ts: f.now(), errorClass: "usage_limit_exceeded", usageLimit: { resetsAt: f.resetsAt } } });
  await tickPipelines([], f.h.ports);
  const waiting = loadPipelines()[0]!.runs[0]!.attempts[1]!;
  expect(waiting.providerWait!.turnTs).toBe(f.now());
  expect(waiting.providerWait!.actionAt).toBeUndefined();
  expect(waiting.providerWait!.tries).toBe(1);
  expect(queriedKeys).toEqual([]);
  expect(loadPipelines()[0]!.stateDetail).toContain("usage limit");
  expect(f.h.spawnInputs).toHaveLength(2);
});

test("a newer completed verdict wins over host loss after a provider continuation", async () => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  f.advance(1_000);
  f.h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal", message: { text: PASS_TEXT, ts: f.now() }, lastRecordAt: f.now(),
  });
  f.h.ports.conversationHostUnavailableSince = async () => new Date(f.now() - 5 * 60_000).toISOString();
  await tickPipelines([], f.h.ports);
  const settled = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(settled.state).toBe("passed");
  expect(settled.providerWait).toBeUndefined();
  expect(settled.verdictRequest).toBeUndefined();
  expect(f.h.spawnInputs).toHaveLength(1);
});

for (const reason of ["structured stage ended before its session was discovered", "stage agent exited before its session was discovered"]) {
  test(`a parked discovery failure settles its report: ${reason}`, async () => {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    lane.state = "needs_decision";
    lane.stateDetail = reason;
    attempt.state = "needs_decision";
    attempt.error = reason;
    attempt.report = recoveryReport(h.ports.now());
    savePipelines([lane]);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
  });
}

test("Codex auth failover launches the selected allowed account and excludes failed credentials", async () => {
  const f = await providerRecoveryHarness("codex", "unauthorized", "expired");
  f.h.ports.resolveProjectSpawn = (_engine, input) => input.unavailableIds?.includes(SPARE_ACCOUNT)
    ? { kind: "unavailable", allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] }
    : { kind: "available", account: { engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } };
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[1]!;
  attempt.accountId = SPARE_ACCOUNT;
  attempt.paneId = null;
  savePipelines([lane]);
  f.h.durableTurns.set("/codex/stage-2.jsonl", { turn: "terminal", message: null,
    terminalProviderMessage: { errorClass: "unauthorized", text: "expired", ts: f.now() + 1_000 } });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("authentication required");
  expect(f.h.spawnInputs).toHaveLength(2);
});


test("a pending Codex failover returns to the recovered source when its target is unavailable", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  // The automatic target lost its project binding before admission. Use the
  // production selector: requestedId is fixed, so forwarding B would refuse A.
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT];
  f.h.ports.resolveProjectSpawn = (engine, input) => {
    const selection = selectProjectAccount({ engine, project: loadPipelines()[0]!.project,
      accounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT].map(id => ({ id, authPresent: true })), observations: [], now: f.now(),
      bindings: [{ project: loadPipelines()[0]!.project, engine: "codex", accountId: LIMITED_ACCOUNT, createdAt: f.h.ports.now() }],
      requestedId: input.requestedId, unavailableIds: input.unavailableIds });
    return selection.kind === "available" ? { kind: "available", account: { engine, accountId: selection.accountId!, kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } }
      : selection.kind === "not_allowed" ? selection
      : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] };
  };
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(loadPipelines()[0]!.cursor?.state).toBe("running");
  expect(loadPipelines()[0]!.state).toBe("running");
});

test("a pending provider capacity wait does not spin the pipelines controller", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] });
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  try {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(0);
    f.advance(300_000);
    await tickPipelines([], f.h.ports);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(0);
  } finally {
    unregister();
  }
});

test.each([120_000, 24 * 60 * 60_000, null])("pending capacity recovery exhausts due probes after reset=%s", async (resetDelay) => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", resetDelay);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] });
  await tickPipelines([], f.h.ports);
  if (resetDelay !== null) {
    f.advance(resetDelay - 1);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    f.advance(60_001);
  } else f.advance(6 * 60 * 60_000);
  let parkedAt: string | null = null;
  for (let probe = 0; probe < 4; probe += 1) {
    await tickPipelines([], f.h.ports);
    if (loadPipelines()[0]!.state === "needs_decision") { parkedAt = f.h.ports.now(); break; }
    f.advance(30 * 60_000);
  }
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toMatch(/usage limit.*capacity/);
  expectProviderParkAt(parked, parkedAt!);
  expect(parked.runs[0]!.attempts.at(-1)!.providerWait!.stageRetry).toBeDefined();
  for (let tick = 0; tick < 32; tick += 1) {
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
  }
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(f.h.spawnInputs).toHaveLength(1);
  const retryAt = Date.parse(parked.runs[0]!.attempts.at(-1)!.providerWait!.resumeAt);
  f.advance(retryAt - f.now());
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
});

test("mixed provider cuts retain recovery expenditure until stage progress", async () => {
  const f = await providerRecoveryHarness("codex", "stream_disconnected", "stream disconnected");
  for (let cut = 0; cut < 12; cut += 1) {
    const errorClass = cut % 2 === 0 ? "stream_disconnected" : "turn_aborted";
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", message: null,
      terminalProviderMessage: { text: errorClass, errorClass, ts: f.now() } });
    await tickPipelines([], f.h.ports);
    const lane = loadPipelines()[0]!;
    if (lane.state === "needs_decision") break;
    const wait = lane.runs[0]!.attempts[0]!.providerWait!;
    f.advance(Math.max(0, Date.parse(wait.resumeAt) - f.now()));
    await tickPipelines([], f.h.ports);
    f.advance(1_000);
  }
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toMatch(/stage cut by (transient provider error|aborted stage turn).*tries/);
  expect(f.sends.length).toBeLessThanOrEqual(3);
  const spent = f.sends.length;
  f.advance(24 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(spent);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
});

test("pending capacity ignores an elapsed historical reset when the pool names a future reset", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  const futureReset = Math.floor(f.now() / 1_000) + 7 * 24 * 60 * 60;
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: futureReset, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] });
  f.advance(180_000);
  for (let probe = 0; probe < 32; probe += 1) {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    f.advance(30 * 60_000);
  }
  const waiting = loadPipelines()[0]!;
  expect(waiting.runs[0]!.attempts[1]!.providerWait!.capacityProbes ?? 0).toBe(0);
  expect(waiting.runs[0]!.attempts[1]!.providerWait!.resetsAt).toBe(futureReset);
  expect(waiting.stateDetail).toContain(new Date(futureReset * 1_000).toISOString());
  f.advance(futureReset * 1_000 + 60_000 - f.now());
  for (let probe = 0; probe < 3; probe += 1) {
    await tickPipelines([], f.h.ports);
    f.advance(30 * 60_000);
  }
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("capacity recovery exhausted after 3 due probes");
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a legacy parked hostless failover returns to pending capacity recovery", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const retry = lane.runs[0]!.attempts[1]!;
  lane.state = "needs_decision";
  lane.stateDetail = `rate limited until ${new Date(f.resetsAt! * 1_000).toISOString()}, account B`;
  retry.state = "needs_decision";
  retry.error = lane.stateDetail;
  delete retry.providerWait;
  savePipelines([lane]);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] });
  await tickPipelines([], f.h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("running");
  expect(waiting.cursor?.state).toBe("pending");
  expect(waiting.stateDetail).toContain("waiting for codex usage limit");
  f.advance(180_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: LIMITED_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(loadPipelines()[0]!.cursor?.state).toBe("running");
});

test("a failover account lookup failure retains its named park and original timestamp", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  let lookups = 0;
  f.h.ports.resolveProjectSpawn = () => { lookups += 1; throw new Error("project account bindings are unreadable"); };
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  const at = parked.runs[0]!.attempts[1]!.completedAt!;
  for (let tick = 0; tick < 32; tick += 1) {
    f.advance(30 * 60_000);
    await tickPipelines([], f.h.ports);
  }
  expect(lookups).toBe(1);
  expect(parked.stateDetail).toContain("usage limit: account capacity lookup unavailable");
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.completedAt).toBe(at);
  expectProviderParkAt(loadPipelines()[0]!, at);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a failed host teardown has a bounded recovery wait without spending a fix round", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  h.ports.stopStageAgent = async () => ({ outcome: "failed", error: "recorded host ownership cannot be verified" });
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, launchOnly: true });
  await tickPipelines([], h.ports);
  now += 30_000;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  now += 11 * 60_000;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("stage host died without output");
  expect(loadPipelines()[0]!.stateDetail).toContain("ownership cannot be verified");
  expectProviderParkAt(loadPipelines()[0]!, h.ports.now());
  expect(h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("plan");
});

for (const startup of [false, true]) {
  test.each(["stopped", "not-running", "unknown", "failed"] as const)(`recovery confirms a recorded pane after registry absence, startup=${startup}, pane=%s`, async (outcome) => {
    const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.paneId = "%recorded-stage";
    if (startup) {
      attempt.state = "spawning";
      attempt.effectiveRole.access = "read-write";
      lane.stages[0]!.effectiveRole.access = "read-write";
      f.h.ports.spawnReceipt = id => id === attempt.launchId
        ? { ...failedReceipt(id, attempt.conversationId!, HOST_UNAVAILABLE), staged: true, paneId: attempt.paneId, transcript: attempt.agentPath }
        : null;
    }
    savePipelines([lane]);
    f.h.ports.stopStageAgent = async target => {
      f.h.calls.push(`stop-host:${target.stageId}:${target.attempt}`);
      return { outcome: "not-running" };
    };
    f.h.setPaneStop(outcome === "unknown" ? { outcome, detail: "recorded pane identity changed" }
      : outcome === "failed" ? { outcome, error: "pane termination unavailable" } : { outcome });
    if (outcome === "not-running") f.h.setPaneAlive(false);
    await tickPipelines([], f.h.ports);
    f.advance(60_000);
    await tickPipelines([], f.h.ports);
    if (!startup) {
      // A transient provider cut cannot retire a live legacy pane: its
      // identity alone cannot exclude newer operator work.
      expect(f.h.calls).not.toContain("stop-pane:plan:1:%recorded-stage");
      if (outcome === "not-running") {
        await tickPipelines([], f.h.ports);
        expect(f.h.spawnInputs).toHaveLength(2);
        expect(f.h.spawnInputs[1]!.prompt).toContain("keeping uncommitted work");
      } else {
        f.advance(11 * 60_000);
        await tickPipelines([], f.h.ports);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.stateDetail).toContain("auth refresh race");
        expect(f.h.spawnInputs).toHaveLength(1);
      }
      expect(f.h.killedPanes).toEqual([]);
    } else {
      expect(f.h.calls).toContain("stop-pane:plan:1:%recorded-stage");
      if (outcome === "stopped" || outcome === "not-running") {
        await tickPipelines([], f.h.ports);
        expect(f.h.spawnInputs).toHaveLength(2);
        const paneCheck = f.h.calls.indexOf("stop-pane:plan:1:%recorded-stage");
        const retrySpawn = f.h.calls.findIndex((call, index) => index > paneCheck && call.startsWith("spawn:"));
        expect(retrySpawn).toBeGreaterThan(paneCheck);
        expect(f.h.spawnInputs[1]!.prompt).toContain("keeping uncommitted work");
      } else {
        expect(f.h.spawnInputs).toHaveLength(1);
        f.advance(11 * 60_000);
        await tickPipelines([], f.h.ports);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.stateDetail).toContain(startup ? "runtime host" : "auth refresh race");
        expect(f.h.spawnInputs).toHaveLength(1);
        expect(f.h.killedPanes).toEqual([]);
      }
    }
    expect(f.h.calls.some(call => /reset|clean/.test(call))).toBe(false);
  });
}

test("a freshly recorded report waits for its live turn when the transcript still shows an older completed turn", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.report = recoveryReport(h.ports.now());
  savePipelines([lane]);
  const oldTurnAt = Date.parse(attempt.report.at) - 1_000;
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", lastRecordAt: oldTurnAt,
    message: { text: PASS_TEXT, ts: oldTurnAt } });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("plan");
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", lastRecordAt: Date.parse(attempt.report.at) + 1_000,
    message: { text: PASS_TEXT, ts: Date.parse(attempt.report.at) + 1_000 } });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
});

test("a failed staged read-write receipt that settled before retry is never stopped", async () => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, reserved) => {
    await reserved({ launchId: "launch-recovered", conversationId: "conversation_recovered" });
    throw new Error(HOST_UNAVAILABLE);
  };
  h.ports.spawnReceipt = () => ({ ...failedReceipt("launch-recovered", "conversation_recovered", HOST_UNAVAILABLE), staged: true });
  let stopped = 0;
  h.ports.stopStageAgent = async () => { stopped += 1; return { outcome: "stopped" }; };
  h.ports.claimSpawnRetry = () => "settled";
  h.ports.sleep = forbiddenSleep;
  await tickPipelines([], h.ports);
  expect(stopped).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.retiredLaunches).toBeUndefined();
});

test.each([false, true])("refused provider continuations keep their delivery key and exhaust a bounded transport wait, throws=%s", async (throws) => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  const keys: string[] = [];
  f.h.ports.resumeSeveredTurn = async (input) => {
    keys.push(input.clientMessageId);
    if (throws) throw new Error("transport unavailable");
    input.onRefused?.("recipient host is unhosted and has no writer claim");
    return false;
  };
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(keys).toHaveLength(1);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(new Set(keys).size).toBe(1);
  f.advance(11 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("auth refresh race");
  expect(loadPipelines()[0]!.stateDetail).toContain(throws ? "continuation transport failed: Error: transport unavailable" : "recipient host is unhosted and has no writer claim");
  expectProviderParkAt(loadPipelines()[0]!, f.h.ports.now());
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.tries).toBe(0);
});


test.each(["codex", "claude"] as const)("memory kill owns one fresh %s attempt when restart and provider recovery overlap", async (engine) => {
  for (const providerFirst of [false, true]) {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.hostEpoch = 1;
    attempt.effectiveRole.engine = engine;
    attempt.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
    lane.stages[0]!.effectiveRole = { ...attempt.effectiveRole };
    savePipelines([lane]);
    h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null,
      lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
    if (providerFirst) {
      await tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.condition.kind).toBe("host_death");
    }
    const at = h.ports.now();
    const restarted: PipelinePorts = { ...h.ports,
      conversationOutOfMemory: async (id) => id === attempt.conversationId
        ? { at, limitBytes: 15 * 2 ** 30, limit: "agent", fatal: true, process: null } : null,
      memoryHeadroom: () => ({ availableBytes: 20 * 2 ** 30, requiredBytes: 15 * 2 ** 30 }),
      restartRecoveryBootId: () => "memory-loss-boot",
      runtimeHostEpoch: async () => 2,
      conversationTurnInterrupted: async (id) => id === attempt.conversationId ? "dead" : null,
    };
    await tickPipelines([entry(attempt.agentPath!)], restarted);
    const recovered = loadPipelines()[0]!;
    expect(recovered.runs[0]!.attempts).toHaveLength(2);
    expect(recovered.runs[0]!.attempts[0]).toMatchObject({ state: "failed", outOfMemory: { at, limit: "agent" } });
    expect(recovered.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();
    expect(recovered.runs[0]!.attempts[0]!.providerRecoveries?.some(item => item.action === "relaunch") ?? false).toBe(false);
    expect(recovered.runs[0]!.attempts[1]!.memoryWait).toBeDefined();
    await tickPipelines([], restarted);
    expect(h.spawnInputs).toHaveLength(1);
    h.advanceWallClock(60_001);
    h.setConversationActive(true);
    await tickPipelines([], restarted);
    await tickPipelines([], restarted);
    expect(h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(1);
    expect(loadPipelines()[0]!.worktreeDir).toBe(lane.worktreeDir);
  }
});

test.each(["nonfatal", "older"] as const)("a %s memory notice leaves restart recovery authoritative", async (notice) => {
  const h = harness();
  await runningStructuredStage(h);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null,
    lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  await tickPipelines([], { ...h.ports,
    conversationTurnInterrupted: async () => "dead",
    conversationOutOfMemory: async () => ({ at: notice === "older"
      ? new Date(Date.parse(attempt.startedAt!) - 1).toISOString() : h.ports.now(),
      limitBytes: 15 * 2 ** 30, limit: "agent", fatal: notice !== "nonfatal", process: null }),
  });
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.outOfMemory).toBeUndefined();
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery!.replacementAttempt).toBe(2);
});

// Both recovery controllers can observe the same open turn after a restart.
test.each(["codex", "claude"] as const)("restart and provider recovery reserve one fresh %s attempt for the same host loss", async (engine) => {
  for (const providerFirst of [false, true]) {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.hostEpoch = 1;
    attempt.effectiveRole.engine = engine;
    attempt.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
    lane.stages[0]!.effectiveRole = { ...attempt.effectiveRole };
    savePipelines([lane]);
    h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null,
      lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
    h.advanceWallClock(3 * 60_000);
    if (providerFirst) {
      await tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.condition.kind).toBe("host_death");
    }
    const restarted: PipelinePorts = { ...h.ports,
      restartRecoveryBootId: () => "shared-loss-boot",
      runtimeHostEpoch: async () => 2,
      conversationTurnInterrupted: async () => "dead",
    };
    await tickPipelines([], restarted);
    if (providerFirst) {
      // A reserved provider retry retains its existing backoff and ownership.
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.severedTurn).toBeUndefined();
      h.advanceWallClock(30_000);
      await tickPipelines([], restarted);
    }
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    const old = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(Boolean(old.restartRecovery?.replacementAttempt)).toBe(!providerFirst);
    expect(old.providerRecoveries?.some(item => item.action === "relaunch") ?? false).toBe(providerFirst);
    await tickPipelines([], restarted);
    await tickPipelines([], restarted);
    expect(h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(1);
  }
});


test("restart recovers a newer interrupted turn after a provider continuation even with an open scan projection", async () => {
  const f = await providerRecoveryHarness("codex", "stream_disconnected", "stream disconnected");
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  f.h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
  f.advance(IDLE_TURN_QUIET_MS + 1);
  f.h.setConversationActive(null);
  const restarted: PipelinePorts = { ...f.h.ports,
    restartRecoveryBootId: () => "new-turn-boot",
    conversationTurnInterrupted: async () => "idle",
  };
  const open = { ...entry(attempt.agentPath!), activity: "live" as const, activityReason: "jsonl_turn_open" as const };
  await tickPipelines([open], restarted);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery!.replacementAttempt).toBe(2);
  await tickPipelines([open], restarted);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(1);
});

test.each(["codex", "claude"] as const)("a persisted provider cut recovers once behind a restored idle open scan (%s)", async (engine) => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const h = harness();
  await runningStructuredStage(h);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  const timestamp = new Date(Date.parse(attempt.startedAt!) + 1).toISOString();
  const transcript = stageTranscript(`provider-idle-${engine}`, engine === "codex" ? [
    { type: "event_msg", timestamp, payload: { type: "task_started", turn_id: "open-before-crash" } },
    { type: "response_item", timestamp, payload: { type: "function_call", name: "exec_command", call_id: "unfinished", arguments: "{}" } },
  ] : [
    { type: "user", timestamp, message: { role: "user", content: "run this stage" } },
    { type: "assistant", timestamp, message: { role: "assistant", stop_reason: null,
      content: [{ type: "tool_use", id: "unfinished", name: "Bash", input: { command: "build" } }] } },
  ]);
  expect(await durableStageTurnEvidence(engine, transcript)).toMatchObject({ turn: "busy", message: null });
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `provider-idle-${engine}-registry.json`));
  const launchProfile = emptyLaunchProfile({ cwd: "/repo", project: "viewer" });
  registry.reconcileConversations([{ engine, path: transcript, accountId: "account-a", launchProfile,
    turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: timestamp }]);
  const conversation = registry.conversationForPath(transcript)!;
  const generation = conversation.generations.at(-1)!;
  registry.upsert({ key: { engine, sessionId: generation.id }, artifactPath: transcript, cwd: "/repo",
    accountId: "account-a", launchProfile, status: "idle", host: null,
    structuredHost: { kind: engine === "codex" ? "codex-app-server" : "claude-broker", endpoint: "stdio:fixture",
      process: null, eventCursor: 1, protocolVersion: "v2", writerClaimEpoch: 1,
      activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "fixture", pendingAction: null });
  attempt.agentPath = transcript;
  attempt.conversationId = conversation.id;
  attempt.sessionId = generation.id;
  attempt.hostEpoch = 1;
  attempt.effectiveRole.engine = engine;
  attempt.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
  lane.stages[0]!.effectiveRole = { ...attempt.effectiveRole };
  savePipelines([lane]);
  const originalPaths = h.ports.pathForConversation;
  h.ports.pathForConversation = (id) => id === conversation.id ? transcript : originalPaths(id);
  const originalAllowed = h.ports.sourcePathAllowed;
  h.ports.sourcePathAllowed = (file) => file === transcript || originalAllowed(file);
  h.ports.durableTurnEvidence = async (kind, file) => file === transcript
    ? await durableStageTurnEvidence(kind, file) : h.durableTurns.get(file) ?? null;
  h.setConversationActive(false);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.condition.kind).toBe("host_death");
  h.advanceWallClock(60_000);
  const open = { ...entry(transcript), activity: "live" as const, activityReason: "jsonl_turn_open" as const };
  // Reload the registry as startup does, retaining the persisted cut in the pipeline store.
  setAgentRegistryForTests(new AgentRegistry(registry.filename));
  try {
    await withRuntimeSnapshot(() => ({ runtime: { hostEpoch: 2 }, sessions: [
      { conversationId: conversation.id, host: "alive", turn: "idle", attentionIds: [] },
    ] }), async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        const production = defaultPipelinePorts();
        expect(await production.conversationTurnInterrupted!(conversation.id)).toBe("idle");
        expect(await production.conversationAgentActive(conversation.id)).toBeNull();
        const recovered: PipelinePorts = { ...h.ports,
          conversationAgentActive: production.conversationAgentActive,
          conversationTurnInterrupted: production.conversationTurnInterrupted,
          conversationHostUnavailableSince: production.conversationHostUnavailableSince,
          runtimeHostEpoch: production.runtimeHostEpoch,
          restartRecoveryBootId: () => "provider-idle-restoration",
        };
        await tickPipelines([open], recovered);
        h.advanceWallClock(5 * 60_000);
      }
    });
    const attempts = loadPipelines()[0]!.runs[0]!.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.providerRecoveries?.filter((item) => item.action === "relaunch")).toHaveLength(1);
    expect(attempts[0]!.restartRecovery).toBeUndefined();
    expect(attempts[0]!.severedTurn).toBeUndefined();
    expect(h.spawnInputs).toHaveLength(2);
    expect(h.calls.filter((call) => call.startsWith("stop-host:"))).toHaveLength(1);
  } finally {
    setAgentRegistryForTests(null);
  }
});

test.each(["codex", "claude"] as const)("an open scan keeps a provider continuation fenced by pending delivery (%s)", async (engine) => {
  const f = await providerRecoveryHarness(engine, "stream_disconnected", "stream disconnected");
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  f.h.setConversationActive(null);
  const recovered: PipelinePorts = { ...f.h.ports,
    restartRecoveryBootId: () => "pending-provider",
    conversationTurnInterrupted: async () => "idle",
    conversationDeliveryOutstanding: () => true,
    conversationDeliveryCompleted: () => false,
  };
  const open = { ...entry(attempt.agentPath!), activity: "live" as const, activityReason: "jsonl_turn_open" as const };
  for (let tick = 0; tick < 3; tick += 1) {
    await tickPipelines([open], recovered);
    f.advance(60_000);
  }
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.actionAt).toBeDefined();
});


test("review budget notes explain the fixed budget in both languages", async () => {
  const { parkedTaskNote } = await import("./taskStatusNote");
  for (const locale of ["en", "uk"] as const) {
    const note = parkedTaskNote("private diagnostics", locale, true, { kind: "review-budget" });
    expect(note).not.toContain("continue-review");
    expect(note).not.toContain("addRounds");
    expect(note).not.toContain("private diagnostics");
  }
});

test.each([false, true])("board actions refuse terminal budget extensions (legacy park: %s)", async (legacy) => {
  const { pipelineActionOptions } = await import("@/components/kanban/stagesModel");
  const { pipelineAnswers } = await import("@/components/pipelines/pipelineBlockModel");
  const h = movingHeadHarness(() => ORIGIN_MAIN_SHA);
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1 }, null) as never);
  const parked = (await driveLegacyTerminalRecheck(h)).pipeline;
  if (legacy) { delete parked.reviewPending; savePipelines([parked]); }
  expect(pipelineActionOptions(parked).find(option => option.action === "continue-review")?.refusal).toBe("budget-fixed");
  expect(pipelineAnswers(parked, stage => stage.id)).toBeNull();
  const revision = pipelineRevision(loadPipelines()[0]!);
  expect((await continueReview(parked, "legacy-extension", 2)).status).toBe(409);
  expect(pipelineRevision(loadPipelines()[0]!)).toBe(revision);
});

test("a blocked historical terminal reviewer retries its unspent activation", async () => {
  const h = movingHeadHarness(() => ORIGIN_MAIN_SHA);
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1 }, null) as never);
  await tickPipelines([], h.ports);
  await buildRound(h, "initial build");
  await critiqueRound(h, "fail", "initial finding");
  await buildRound(h, "last budget fix");
  seedLegacyTerminalRecheck();
  await tickPipelines([], h.ports);
  const review = loadPipelines()[0]!.runs.find(run => run.stageId === "critique")!.attempts.at(-1)!;
  expect(review.activatedBy?.budgetRecheck).toBe(true);
  h.messages.set(review.agentPath!, { text: 'Review unavailable\n\n```json\n{"status":"fail","blocked":true,"blockedReason":"Review environment unavailable","findings":["P1 review blocked"]}\n```', ts: Date.now() + 100_000_000 });
  await tickPipelines([entry(review.agentPath!)], h.ports);
  const blocked = loadPipelines()[0]!;
  expect(blocked.reviewPending).toBeUndefined();
  const { pipelineActionOptions } = await import("@/components/kanban/stagesModel");
  const { pipelineAnswers } = await import("@/components/pipelines/pipelineBlockModel");
  expect(pipelineActionOptions(blocked).find((option) => option.action === "retry-stage")?.refusal).toBeNull();
  expect(pipelineActionOptions(blocked).find((option) => option.action === "skip-stage")?.refusal).not.toBeNull();
  expect(pipelineAnswers(blocked, (stage) => stage.id)?.choices.map((choice) => choice.action)).toEqual(["retry-stage"]);
  expect((await patchPipeline(blocked.id, { action: "skip-stage" }, h.ports)).status).toBe(409);
  expect((await patchPipeline(blocked.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await critiqueRound(h, "pass", "environment restored; independent review passes");
  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.runs.find(run => run.stageId === "critique")!.attempts.at(-1)!.activatedBy).toEqual(review.activatedBy);
});


test.each(["en", "uk"] as const)("provider retry card gives operator-local time in %s", async locale => {
  const { parkedTaskNote } = await import("./taskStatusNote");
  const note = parkedTaskNote("", locale, false, { kind: "provider-retry", resumeAt: "2026-10-05T19:01:00.000Z", timeZone: "Europe/Kyiv" });
  expect(note).toContain("22:01");
  expect(note).toContain("Kyiv");
  expect(note).not.toContain("2026-10-05T19:01:00.000Z");
});


test.each(["before-stop", "after-stop"] as const)("quota retry requires readable unchanged cut evidence %s", async boundary => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  let stopped = false;
  const original = f.h.ports.durableTurnEvidence;
  f.h.ports.durableTurnEvidence = (...args) => boundary === "before-stop" || stopped ? Promise.resolve(null) : original(...args);
  f.h.ports.stopStageAgent = async () => { stopped = true; return { outcome: "not-running" }; };
  f.advance(180_000);
  for (let round = 0; round < 22; round++) {
    await tickPipelines([], f.h.ports);
    f.advance(30_000);
  }
  const parked = loadPipelines()[0]!;
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(parked.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  expect(parked.stateDetail).toContain("evidence");
});


test("a large spare pool tries each allowed account once in the cut chain", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 2 * 60 * 60_000);
  const accounts = [LIMITED_ACCOUNT, ...Array.from({ length: 7 }, (_, n) => `spare-${n}`)];
  f.h.ports.allowedAccountIds = () => accounts;
  f.h.ports.resolveProjectSpawn = (_engine, request) => {
    const target = accounts.find(id => !request.unavailableIds?.includes(id));
    return target ? { kind: "available", account: { engine: "codex", accountId: target, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: accounts };
  };
  for (let n = 0; n < 12; n++) {
    const a = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    if (a.agentPath && loadPipelines()[0]!.state === "running") f.h.durableTurns.set(a.agentPath, { turn: "terminal", message: null,
      terminalProviderMessage: { text: "You've hit your usage limit", errorClass: "usage_limit_exceeded", ts: f.now(), usageLimit: { resetsAt: f.resetsAt } } });
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    f.advance(15_000);
  }
  expect(f.h.spawnInputs).toHaveLength(accounts.length);
  expect(f.h.spawnInputs.slice(1).map(input => input.requestedAccountId)).toEqual(accounts.slice(1));
  const attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(accounts.length);
  expect(attempts.at(-1)!.providerRecoveryBudget?.triedAccounts).toEqual(accounts);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});


test("a reply withdraws the quota retry card promise before a far-future reset", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 2 * 60 * 60_000, true);
  const lane = loadPipelines()[0]!;
  lane.taskIds = ["answered-retry-task"];
  saveTasks([{ id: "answered-retry-task", project: lane.project, text: "Recover stage", status: "assigned", placement: "unplaced", assignments: [], createdAt: lane.createdAt, updatedAt: lane.createdAt }]);
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  f.advance(1_000);
  f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() });
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  expect(parked.runs[0]!.attempts[0]!.error).not.toMatch(/Automatic retry|Автоповтор/);
  expect(loadTasks()[0]!.note?.text).not.toMatch(/Automatic retry|Автоповтор/);
  expect(f.h.spawnInputs).toHaveLength(1);
});


test.each(["parked-retry", "fresh-failover"] as const)("provider recovery retains missing host ownership on %s", async path => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, path === "parked-retry");
  if (path === "parked-retry") {
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    await tickPipelines([], f.h.ports);
    f.advance(180_000);
  } else {
    f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: "/account-b", transcriptRoot: "/account-b/sessions", env: { NODE_ENV: "test" } } });
  }
  f.h.ports.conversationRegistered = () => false;
  f.h.ports.stopStageAgent = async () => ({ outcome: "not-running" });
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(lane.runs[0]!.attempts).toHaveLength(1);
  expect(lane.state).toBe("needs_decision");
  expect(lane.stateDetail).toContain("ownership");
  expect(lane.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
});

test("a reply during fresh target termination cancels failover before replacement", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: "/account-b", transcriptRoot: "/account-b/sessions", env: { NODE_ENV: "test" } } });
  const options: unknown[] = [];
  f.h.ports.stopStageAgent = async (_target, option) => {
    options.push(option);
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(options).toEqual([{ onlyIfIdle: true, providerRecovery: { pipelineId: loadPipelines()[0]!.id, stageId: loadPipelines()[0]!.cursor!.stageId, attempt: 1, turnTs: f.now(), controlGeneration: loadPipelines()[0]!.controlGeneration ?? null } }]);
  expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
});


for (const engine of ["claude", "codex"] as const) {
  for (const paneAlive of [false, null]) {
    test(`${engine} idle-only provider failover observes pane liveness=${paneAlive} without killing it`, async () => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
        "You've hit your session limit", 120_000);
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.paneId = "%recorded-stage";
      savePipelines([lane]);
      f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: SPARE_ACCOUNT,
        kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
      const providerCutAt = f.now();
      let idleStopProbe = false;
      f.h.ports.stopStageAgent = async (_target, options) => {
        expect(options).toEqual({ onlyIfIdle: true, providerRecovery: { pipelineId: lane.id, stageId: lane.cursor!.stageId, attempt: 1, turnTs: providerCutAt, controlGeneration: lane.controlGeneration ?? null } });
        idleStopProbe = true;
        return { outcome: "not-running" };
      };
      f.h.ports.paneAgentAlive = async () => {
        if (!idleStopProbe) return true;
        idleStopProbe = false;
        if (paneAlive === null) throw new Error("pane snapshot unavailable");
        return paneAlive;
      };
      let paneStops = 0;
      f.h.ports.stopStagePane = async () => { paneStops++; return { outcome: "stopped" }; };
      await tickPipelines([], f.h.ports);
      if (paneAlive === false) {
        await tickPipelines([], f.h.ports);
        expect(f.h.spawnInputs).toHaveLength(2);
      } else {
        expect(f.h.spawnInputs).toHaveLength(1);
        expect(loadPipelines()[0]!.stateDetail).toContain("pane liveness could not be verified");
        f.advance(11 * 60_000);
        await tickPipelines([], f.h.ports);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(f.h.spawnInputs).toHaveLength(1);
      }
      expect(paneStops).toBe(0);
    });
  }
  test(`${engine} provider failover preserves an answered pane after registry absence`, async () => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
      "You've hit your session limit", 120_000);
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.paneId = "%recorded-stage";
    savePipelines([lane]);
    f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: SPARE_ACCOUNT,
      kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
    const providerCutAt = f.now();
    f.h.ports.stopStageAgent = async (_target, options) => {
      expect(options).toEqual({ onlyIfIdle: true, providerRecovery: { pipelineId: lane.id, stageId: lane.cursor!.stageId, attempt: 1, turnTs: providerCutAt, controlGeneration: lane.controlGeneration ?? null } });
      // A reply starts while the host lookup finds no registry resident.
      f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
      return { outcome: "not-running" };
    };
    let paneStops = 0;
    f.h.ports.stopStagePane = async () => { paneStops++; return { outcome: "stopped" }; };
    await tickPipelines([], f.h.ports);
    expect(paneStops).toBe(0);
    expect(f.h.spawnInputs).toHaveLength(1);
    f.advance(1_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(f.sends).toHaveLength(0);
    expect(paneStops).toBe(0);
    expect(f.h.spawnInputs).toHaveLength(1);
  });
}

for (const engine of ["claude", "codex"] as const) {
  test(`${engine} account preflight fallback keeps the cut-chain budget with a large allowed pool`, async () => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
      "You've hit your session limit", 120_000);
    const spares = Array.from({ length: 8 }, (_, index) => `test-spare-${index}`);
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, ...spares];
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      const target = spares.find(id => !request.unavailableIds?.includes(id));
      return target ? { kind: "available", account: { engine, accountId: target, kind: "managed",
        home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, ...spares] };
    };
    const targets: (string | null | undefined)[] = [];
    f.h.ports.spawnAgent = async input => {
      targets.push(input.requestedAccountId);
      throw new (await import("@/lib/accounts/manager")).AccountAuthenticationRequiredError(engine, input.requestedAccountId!);
    };
    for (let tick = 0; tick < 12; tick++) await tickPipelines([], f.h.ports);
    expect(targets).toEqual(spares);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerRecoveryBudget?.tries).toBe(spares.length);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerRecoveryBudget?.failedAccounts).toEqual(spares);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerWait?.stageRetry).toBeDefined();
    expect(f.h.spawnInputs).toHaveLength(1);
  });
  test.each([{ cause: "auth", tries: 0 }, { cause: "tier", tries: 0 }, { cause: "auth", tries: 3 }, { cause: "tier", tries: 3 }] as const)(`${engine} account-specific preflight failure tries a third allowed account before parking ($cause, budget=$tries)`, async ({ cause, tries }) => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
      "You've hit your session limit", 120_000);
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    const third = "test-third-account";
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT, third];
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      const target = [SPARE_ACCOUNT, third].find(id => !request.unavailableIds?.includes(id));
      return target ? { kind: "available", account: { engine, accountId: target, kind: "managed",
        home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT, third] };
    };
    const baseSpawn = f.h.ports.spawnAgent;
    const targets: (string | null | undefined)[] = [];
    f.h.ports.spawnAgent = async (input, reserved) => {
      targets.push(input.requestedAccountId);
      if (input.requestedAccountId === SPARE_ACCOUNT) {
        if (cause === "tier") throw new (await import("@/lib/accounts/codexServiceTiers")).CodexServiceTierUnavailableError("required tier unavailable");
        throw new (await import("@/lib/accounts/manager")).AccountAuthenticationRequiredError(engine, SPARE_ACCOUNT);
      }
      return baseSpawn(input, reserved);
    };
    for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
    expect(targets).toEqual([SPARE_ACCOUNT, third]);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.providerRecoveryBudget?.tries).toBe(tries + 2);
    expect(loadPipelines()[0]!.cursor?.state).toBe("running");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(third);
    expect(f.h.spawnInputs).toHaveLength(2);
  });
}

for (const engine of ["claude", "codex"] as const) {
  test.each(["tier", "prompt", "host"] as const)(`${engine} unreserved target %s failure preserves the source reset`, async cause => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000);
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      const target = [LIMITED_ACCOUNT, SPARE_ACCOUNT].find(id => !request.unavailableIds?.includes(id));
      return target ? { kind: "available", account: { engine, accountId: target, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
    };
    const baseSpawn = f.h.ports.spawnAgent;
    f.h.ports.spawnAgent = async (input, reserved) => {
      if (input.requestedAccountId !== SPARE_ACCOUNT) return baseSpawn(input, reserved);
      if (cause === "tier") throw new (await import("@/lib/accounts/codexServiceTiers")).CodexServiceTierUnavailableError("required tier unavailable");
      throw new Error(cause === "prompt" ? "stage prompt could not be prepared" : "host startup failed");
    };
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    const lane = loadPipelines()[0]!;
    const wait = lane.runs[0]!.attempts.at(-1)!.providerWait!;
    expect(lane.stateDetail).toContain("target preflight failed:");
    expect(wait.failedAccounts?.includes(SPARE_ACCOUNT) ?? false).toBe(cause === "tier");
    expect(wait.stageRetry).toBeDefined();
    expect(wait.resumeAt).toBe(new Date(f.resetsAt! * 1_000 + 60_000).toISOString());
    for (let tick = 0; tick < 8; tick++) { f.advance(30_000); await tickPipelines([], f.h.ports); }
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(LIMITED_ACCOUNT);
  });
}

test.each([false, true])("fresh quota target preflight failure retains reset retry only before reservation=%s", async reserved => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: "/account-b", transcriptRoot: "/account-b/sessions", env: { NODE_ENV: "test" } } });
  const baseSpawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, onReserved) => {
    if (reserved) await baseSpawn(input, onReserved);
    throw new (await import("@/lib/accounts/manager")).AccountAuthenticationRequiredError("claude", SPARE_ACCOUNT);
  };
  for (let n = 0; n < 3; n++) await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts.at(-1)!;
  expect(lane.state).toBe("needs_decision");
  if (reserved) {
    expect(attempt.providerWait?.stageRetry).toBeUndefined();
  } else {
    expect(attempt.providerWait?.stageRetry).toBeDefined();
    expect(attempt.providerWait?.failedAccounts).toContain(SPARE_ACCOUNT);
    expect(attempt.providerWait?.resumeAt).toBe(new Date(f.resetsAt! * 1_000 + 60_000).toISOString());
  }
  expect(f.sends).toHaveLength(0);
});


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


for (const engine of ["claude", "codex"] as const) {
  test.each(["pipeline", "startup-recovery", "operator"] as const)(`${engine} quota continuation trusts delivered %s authorship`, async author => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const cutAt = f.now();
    await tickPipelines([], f.h.ports);
    f.advance(180_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(1);
    const text = "This stage was cut by session limit. Continue the same stage from its current worktree, keeping uncommitted work, and report when complete.";
    f.advance(1_000);
    const promptAt = f.h.ports.now();
    const origin = author !== "operator" ? { kind: "agent" as const, role: author } : { kind: "operator" as const };
    let records: Record<string, unknown>[];
    if (engine === "claude") {
      records = [{ type: "user", uuid: "continued-prompt", timestamp: promptAt, promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: text } }];
    } else {
      const { persistStructuredUserMetadata } = await import("@/lib/selection/structuredUserMetadata");
      const { structuredContentDigest } = await import("@/lib/runtime/structuredContent");
      const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText");
      const ref = persistStructuredUserMetadata({ version: 1, contentDigest: structuredContentDigest({ text, images: [] }), selectedContext: null, origin });
      records = [{ type: "event_msg", timestamp: promptAt, payload: { type: "user_message", message: encodeCodexStructuredUserText(text, ref) } },
        { type: "event_msg", timestamp: promptAt, payload: { type: "task_started" } }];
    }
    f.advance(500);
    records.push(engine === "claude" ? { type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", error: { message: "You've hit your session limit", codex_error_info: "usage_limit_exceeded" } } });
    records.unshift(providerQuotaRecord(engine, cutAt));
    const file = stageTranscript(`own-provider-continuation-${engine}-${author}`, records);
    if (engine === "claude") {
      const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
      const ledger = new FileClaudeDeliveryLedger();
      const session = path.basename(file, ".jsonl");
      ledger.recordQueued(session, { id: f.sends[0]!, text, origin }, "turn-started");
      ledger.confirmDelivered(session, f.sends[0]!, "continued-prompt");
    }
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(30 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(author !== "operator" ? 2 : 1);
    if (author === "operator") expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
    else expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.tries).toBe(2);
  });
}


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
  });
}


test.each(["image", "large-tail", "human-before-harness"] as const)("a quota reply remains external through %s evidence", async shape => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  await tickPipelines([], f.h.ports);
  const oldCutAt = f.h.ports.now();
  f.advance(1_000);
  const records: Record<string, unknown>[] = [
    { type: "assistant", timestamp: oldCutAt, isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } },
    { type: "user", timestamp: f.h.ports.now(), promptSource: "sdk", message: { content: shape === "image" ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] : "Wait for my answer" } },
  ];
  if (shape !== "image") records.push({ type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(150_000) });
  if (shape === "human-before-harness") {
    f.advance(500);
    records.push({ type: "user", timestamp: f.h.ports.now(), origin: { kind: "task-notification" }, promptSource: "system", message: { content: "<task-notification>done</task-notification>" } });
  }
  f.advance(500);
  records.push({ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } });
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript("quota-reply-evidence", records) });
  await tickPipelines([], f.h.ports);
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
});


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
      const ref = persistStructuredUserMetadata({ version: 1, contentDigest: structuredContentDigest({ text, images: [] }), selectedContext: null, origin });
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


test.each(["claude", "codex"] as const)("%s reply racing continuation admission prevents automatic delivery", async engine => {
  const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
  await tickPipelines([], f.h.ports);
  f.advance(180_000);
  let policy: string | undefined;
  f.h.ports.resumeSeveredTurn = async input => {
    policy = input.policy;
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1,
      prompts: [{ ts: f.now() + 1, origin: "external" }] });
    f.h.setConversationActive(true);
    if (input.continuationAllowed && !await input.continuationAllowed()) return false;
    f.sends.push(input.clientMessageId);
    return true;
  };
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(policy).toBe("queue");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.tries).toBe(0);
});

test.each(["running", "parked"] as const)("%s quota wait retains a human prompt removed by shutdown normalization", async mode => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  if (mode === "parked") {
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
  }
  await tickPipelines([], f.h.ports);
  const cutAt = f.h.ports.now();
  f.advance(1_000);
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript(`shutdown-human-${mode}`, [
    { type: "assistant", timestamp: cutAt, isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } },
    { type: "user", timestamp: f.h.ports.now(), origin: { kind: "human" }, promptSource: "typed", isMeta: true, message: { role: "user", content: "Wait for my answer" } },
    { type: "user", timestamp: new Date(f.now() + 1).toISOString(), interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } },
    { type: "assistant", timestamp: new Date(f.now() + 2).toISOString(), message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
  ]) });
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
});


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

test.each([
  ["pause", "acknowledged"], ["close", "acknowledged"], ["pause", "lost-acknowledgment"], ["close", "lost-acknowledgment"],
  ["pause", "transport-error"], ["close", "transport-error"],
] as const)("%s invalidates an admitted provider continuation before dispatch with %s", async (action, acknowledgment) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { invalidateProviderContinuation } = await import("./engine");
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, `continuation-${action}-${acknowledgment}.sqlite`), { structuredHosts: true });
  const conversationId = loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId!;
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: "continuation-generation" }, hostKind: "codex-app-server",
    host: "hosted", turn: "idle", activeTurnId: null, writerClaim: "fixture:1", attentionIds: [],
    capabilities: { steer: true, structuredAttention: true },
  } });
  let operationId = "";
  f.h.ports.resumeSeveredTurn = async input => {
    if (input.continuationAllowed && !await input.continuationAllowed()) return false;
    const session = journal.readSession({ conversationId })!;
    operationId = input.clientMessageId;
    journal.executeOperation({ kind: "send", conversationId, operationId, idempotencyKey: operationId, text: input.text,
      policy: "queue", turnId: null, onlyIfIdle: { revision: session.revision, writerClaim: session.writerClaim! } });
    if (acknowledgment === "transport-error") throw new Error("runtime acknowledgment lost");
    return acknowledgment === "acknowledged";
  };
  f.h.ports.invalidateProviderContinuation = id => invalidateProviderContinuation(id, {
    append: async event => journal.append(event),
  } as import("@/lib/runtime/client").RuntimeHostClient);
  try {
    await tickPipelines([], f.h.ports);
    f.advance(180_000);
    await tickPipelines([], f.h.ports);
    // A new Viewer reads the pending intent before applying operator control.
    const requestedAt = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.continuationRequestedAt;
    expect((await patchPipeline(loadPipelines()[0]!.id, { action }, { ...f.h.ports })).error).toBeUndefined();
    if (action === "close") {
      f.h.ports.stageHostResident = async () => true;
      await engineModule.drainStageActivations(f.h.ports);
    }
    expect(journal.transitionOperation(operationId, "delivering").receipt).toMatchObject({ status: "failed", reason: "idle-continuation-pre-execution-refused" });
    expect(requestedAt).toBeDefined();
  } finally { journal.close(); }
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


for (const engine of ["claude", "codex"] as const) {
  for (const largeTail of [false, true]) {
    test.each(engine === "claude" ? ["operator", "pipeline", "initial", "harness"] as const : ["operator", "pipeline", "initial"] as const)(`${engine} first recovery tick respects a prior %s prompt (large tail=${largeTail})`, async author => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
      const initial = f.now();
      const nativeNotice = (at: number) => engine === "claude"
        ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
          message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
        : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } };
      f.advance(1_000);
      const promptTime = author === "initial" ? initial - 1_000 : f.now();
      const text = "Continue work on this stage";
      let prompt: Record<string, unknown>;
      if (engine === "claude") prompt = { type: "user", uuid: "first-tick-prompt", timestamp: new Date(promptTime).toISOString(),
        ...(author === "harness" ? { origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptSource: "system" } : { turnOrigin: "sdk", promptSource: "sdk" }), message: { content: text } };
      else {
        const { persistStructuredUserMetadata } = await import("@/lib/selection/structuredUserMetadata");
        const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText");
        const { structuredContentDigest } = await import("@/lib/runtime/structuredContent");
        const ref = persistStructuredUserMetadata({ version: 1, contentDigest: structuredContentDigest({ text, images: [] }), selectedContext: null,
          origin: author === "pipeline" ? { kind: "agent", role: "pipeline" } : { kind: "operator" } });
        prompt = { type: "event_msg", timestamp: new Date(promptTime).toISOString(), payload: { type: "user_message", message: encodeCodexStructuredUserText(text, ref) } };
      }
      f.advance(500);
      const records: Record<string, unknown>[] = author === "initial" ? [prompt, nativeNotice(initial)] : [nativeNotice(initial), prompt];
      if (largeTail) records.push({ type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(150_000) });
      records.push(nativeNotice(f.now()));
      const file = stageTranscript(`first-provider-tick-${engine}-${author}-${largeTail}`, records);
      if (engine === "claude" && author === "pipeline") await stampPipelinePrompt(file, "first-tick-prompt", text);
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
      await tickPipelines([], f.h.ports);
      f.advance(31 * 60_000);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(author === "operator" ? 0 : 1);
      expect(f.h.spawnInputs).toHaveLength(1);
      if (author === "operator") {
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
      }
    });
  }
  test(`${engine} first recovery tick bounds incomplete prompt history`, async () => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const notice = (at: number) => engine === "claude"
      ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } };
    const first = notice(f.now());
    f.advance(1_000);
    const file = stageTranscript(`first-tick-history-bound-${engine}`, [first,
      { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(9 * 1024 * 1024) }, notice(f.now())]);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(11 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(0);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("prompt history is incomplete");
  });
}


for (const engine of ["claude", "codex"] as const) {
  test.each(["after-cut", "before-cut"] as const)(`${engine} first recovery tick respects pause and resume %s`, async timing => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const initial = f.now();
    f.advance(1_000);
    const lane = loadPipelines()[0]!;
    await patchPipeline(lane.id, { action: "pause" }, f.h.ports);
    f.advance(1_000);
    await patchPipeline(lane.id, { action: "resume" }, f.h.ports);
    f.advance(1_000);
    const cut = timing === "after-cut" ? initial : f.now();
    const file = stageTranscript(`first-tick-control-${engine}-${timing}`, engine === "claude" ? [
      { type: "assistant", timestamp: new Date(cut).toISOString(), isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } },
    ] : [
      { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "task_complete", error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } },
    ]);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(31 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(timing === "after-cut" ? 0 : 1);
    if (timing === "after-cut") {
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain("operator control");
    }
  });
}


for (const engine of ["claude", "codex"] as const) {
  test.each([3, 5])(`${engine} an untried allowed account remains eligible in a %i account pool after the retry budget`, async count => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 2 * 60 * 60_000);
    const pool = [LIMITED_ACCOUNT, SPARE_ACCOUNT, "fixture-account-c", "fixture-account-d", "fixture-account-e"].slice(0, count);
    const tried = pool.slice(0, -1);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.accountId = tried.at(-1)!;
    attempt.providerRecoveryBudget = { tries: 4, startedAt: f.h.ports.now(), engine, triedAccounts: tried };
    attempt.usageLimitedAccounts = tried.map(accountId => ({ accountId, engine, limitedAt: f.now() - 1_000, resetsAt: f.resetsAt }));
    savePipelines([lane]);
    f.h.ports.accountForTranscript = () => ({ accountId: tried.at(-1)!, label: "current account" });
    f.h.ports.allowedAccountIds = () => pool;
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      const selected = selectProjectAccount({ ...request, engine, now: f.now(),
        accounts: pool.map(id => ({ id, authPresent: true })), observations: [],
        bindings: pool.map(accountId => ({ engine, accountId, project: lane.project, createdAt: f.h.ports.now() })),
      });
      return selected.kind === "available" ? { kind: "available", account: { engine, accountId: selected.accountId!, kind: "managed",
        home: "/fixture-account", transcriptRoot: "/fixture-account/sessions", env: { NODE_ENV: "test" } } } : selected;
    };
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(pool.at(-1)!);
    const successor = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(successor.providerRecoveryBudget?.tries).toBe(5);
    expect(successor.providerRecoveryBudget?.triedAccounts).toEqual(pool);
    f.advance(1_000);
    f.h.setConversationActive(false);
    f.h.ports.accountForTranscript = () => ({ accountId: pool.at(-1)!, label: "last account" });
    f.h.durableTurns.set(successor.agentPath!, { turn: "terminal", message: null, terminalProviderMessage: {
      text: "You've hit your session limit", errorClass: engine === "claude" ? "rate_limit" : "usage_limit_exceeded", ts: f.now(), usageLimit: { resetsAt: f.resetsAt },
    } });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("every allowed account was tried");
    expect(f.h.spawnInputs).toHaveLength(2);
  });

}

for (const parked of [false, true]) {
  for (const shape of ["UserMessage", "userMessage", "user_message", "response_item"] as const) {
    test.each(["operator", "pipeline", "startup-recovery"] as const)(`native Codex ${shape} %s authorship controls quota recovery (parked=${parked})`, async author => {
      const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
      if (parked) {
        const lane = loadPipelines()[0]!;
        lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
        savePipelines([lane]);
      }
      await tickPipelines([], f.h.ports);
      const oldCut = f.now();
      f.h.ports.resolveProjectSpawn = () => f.now() >= f.resetsAt! * 1_000 + 60_000
        ? { kind: "available", account: { engine: "codex", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] };
      f.advance(1_000);
      const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
      const automatic = author === "pipeline" || author === "startup-recovery";
      const wire = encodeCodexStructuredUserText("Continue the same stage", undefined, null,
        { kind: "agent", role: author === "startup-recovery" ? author : "pipeline" });
      const text = author === "operator" ? "Wait for my answer" : wire;
      const prompt = shape === "user_message" ? { type: "event_msg", payload: { type: "user_message", message: text } }
        : shape === "response_item" ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }
        : { type: "event_msg", payload: { type: "item_completed", item: { type: shape, content: [{ type: "text", text: text.slice(0, 20) }, { type: "text", text: text.slice(20) }] } } };
      const notice = (at: number) => ({ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } });
      const file = stageTranscript(`native-codex-author-${shape}-${author}-${parked}`, [notice(oldCut),
        { ...prompt, timestamp: f.h.ports.now() }, { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } },
        { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "token_count", info: { rate_limits: { primary: { used_percent: 100, resets_at: f.resetsAt } } } } }, notice(f.now() + 500)]);
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      await tickPipelines([], f.h.ports);
      if (parked && automatic) expect(loadPipelines()[0]!.stateDetail).toMatch(/Automatic retry|Автоповтор/);
      f.advance(31 * 60_000);
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(!parked && automatic ? 1 : 0);
      expect(f.h.spawnInputs).toHaveLength(parked && automatic ? 2 : 1);
      if (!automatic) expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
    });
  }
}

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
