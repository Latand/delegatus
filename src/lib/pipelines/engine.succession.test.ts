import { expect, test, tickPipelines, loadPipelines, savePipelines, entry, harness, runningStructuredStage, stageTranscript, readFixtures, expectProviderParkAt, providerRecoveryHarness } from "./engine.fixture";
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


/* #3811: a Viewer restart left the agent working. Startup kept holding its row
   because every record the agent wrote moved the restart cut evidence, so the
   row read unhosted for as long as the agent worked. */
test.each(["alive", "gone"] as const)("a row held for its restart cut evidence over a process that is %s", async (process) => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  h.ports.conversationRestartCutHeld = () => true;
  h.ports.conversationHostProcess = async () => ({ state: process, pid: 4242 });
  h.ports.conversationHostUnavailableSince = async () => new Date(now - 10 * 60_000).toISOString();
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, launchOnly: false });
  const stops: unknown[] = [];
  h.ports.stopStageAgent = async (target) => { stops.push(target.launchId); return { outcome: "not-running" }; };
  for (let pass = 0; pass < 3; pass++) { await tickPipelines([], h.ports); now += 60_000; }
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  if (process === "alive") {
    expect(lane.state).toBe("running");
    expect(attempt.state).toBe("running");
    expect(attempt.providerWait).toBeUndefined();
    expect(stops).toEqual([]);
    expect(h.spawnInputs).toHaveLength(1);
  } else {
    expect(attempt.state === "running" && !attempt.providerWait && lane.state === "running").toBe(false);
  }
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
