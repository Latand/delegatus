import { FileRuntimeEventStore } from "@/lib/runtime/eventStore";
import { statePath } from "@/lib/configDir";
import fs from "node:fs";
import { expect, test, harness, create, tickPipelines, loadPipelines, savePipelines, finishReported, BUILD_ONLY, createPipelineFromRequest, patchPipeline, providerRecoveryHarness, LIMITED_ACCOUNT } from "./engine.fixture";
import { isStoredPipeline } from "./store";
import { REPEAT_REASONS } from "./accounting";

test("controller persists admission before launch and keeps an exact unknown remainder on completion", async () => {
  const h = harness();
  let now = 1_000_000;
  h.ports.now = () => new Date(now).toISOString();
  const lane = await create(h.ports, BUILD_ONLY as never);
  now += 1000;
  await tickPipelines([], h.ports);
  now += 2000;
  await tickPipelines([], h.ports);
  let stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  expect(attempt.accounting).toMatchObject({ admittedAt: lane.createdAt, startedAt: new Date(now).toISOString(), repeatReason: null });
  now += 5000;
  await tickPipelines([finishReported(h, attempt.agentPath!, "pass", "Change delivered")], h.ports);
  stored = loadPipelines()[0]!;
  const ended = stored.runs[0]!.attempts[0]!;
  expect(ended.completedAt).not.toBeNull();
  expect(ended.accounting!.time).toMatchObject({ intervalMs: 5000, unknownMs: 5000, modelMs: null, toolsMs: null, toleranceMs: 0 });
  expect(isStoredPipeline(JSON.parse(JSON.stringify(stored)))).toBe(true);
  savePipelines([stored]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting).toEqual(ended.accounting);
});
test("lane class is captured before effects and malformed declarations refuse without spawning", async () => {
  const h = harness();
  savePipelines([]);
  const request = { task: "Deliver change", spec: "Example succeeds", repoDir: "/repo", stages: BUILD_ONLY, src: "/codex/creator.jsonl", autoStart: false };
  const result = await createPipelineFromRequest({ ...request, taskClass: { size: "small", money: false, access: true, dataMigration: null } } as never, h.ports);
  expect(result.pipeline?.taskClass).toEqual({ project: "viewer", size: "small", money: false, access: true, dataMigration: null });
  const before = h.calls.length;
  expect((await createPipelineFromRequest({ ...request, taskClass: { access: "yes" } } as never, h.ports)).status).toBe(400);
  expect(h.calls).toHaveLength(before);
});
test("unknown and declared operator repeat causes persist through the real retry action", async () => {
  for (const repeatReason of [undefined, ...REPEAT_REASONS]) {
    const h = harness();
    await create(h.ports, BUILD_ONLY as never);
    await tickPipelines([], h.ports); await tickPipelines([], h.ports);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.state = "failed"; attempt.completedAt = h.ports.now();
    lane.state = "needs_decision"; lane.cursor!.state = "running";
    h.ports.paneAgentAlive = async () => false;
    savePipelines([lane]);
    const result = await patchPipeline(lane.id, { action: "retry-stage", repeatReason }, h.ports);
    expect(result.error).toBeUndefined();
    await tickPipelines([], h.ports);
    const next = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(next.n).toBe(2);
    expect(next.accounting!.repeatReason).toBe(repeatReason ?? "unknown");
    expect(isStoredPipeline(loadPipelines()[0])).toBe(true);
  }
});


test("reopening an attempt clears its old split and a later completion records its new interval", async () => {
  const h = harness();
  h.ports.now = () => new Date(1_000_000).toISOString();
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  let lane = loadPipelines()[0]!;
  let attempt = lane.runs[0]!.attempts[0]!;
  attempt.sessionId = "retained-clock-session";
  const events = new FileRuntimeEventStore();
  events.append(attempt.sessionId, { kind: "turn-started", turnId: "known", seq: 1, accountingAt: new Date(1_000_000).toISOString() });
  events.append(attempt.sessionId, { kind: "turn-ended", turnId: "known", seq: 2, status: "completed", accountingAt: new Date(1_000_500).toISOString() });
  attempt.state = "failed"; attempt.completedAt = new Date(1_001_000).toISOString();
  lane.state = "needs_decision";
  savePipelines([lane]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.time).toMatchObject({ intervalMs: 1000, modelMs: 500, unknownMs: 500 });
  const native = statePath("structured-host-events", "timing.sqlite"); fs.renameSync(native, native + ".retained");
  lane = loadPipelines()[0]!; attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = "running"; attempt.completedAt = null; lane.state = "running";
  savePipelines([lane]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.time).toBeNull();
  lane = loadPipelines()[0]!; attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = "failed"; attempt.completedAt = new Date(1_003_000).toISOString(); lane.state = "needs_decision";
  savePipelines([lane]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.time).toMatchObject({ intervalMs: 3000, modelMs: 500, unknownMs: 2500 });
  lane = loadPipelines()[0]!; attempt = lane.runs[0]!.attempts[0]!;
  attempt.completedAt = new Date(1_004_000).toISOString(); savePipelines([lane]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.time!.intervalMs).toBe(4000);
});

for (const [finding, interrupted] of [[true, false], [false, false], [true, true]]) test(`first fix preserves the review cause: finding=${finding}, OOM=${interrupted}`, async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, engine: "codex", access: "read-only", prompt: "review", next: null, onFail: { to: "fix", maxRounds: 2 } },
    { id: "fix", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "fix", next: "review" },
  ] as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  const build = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  await tickPipelines([finishReported(h, build.agentPath!, "pass", "built")], h.ports);
  await tickPipelines([], h.ports);
  const review = loadPipelines()[0]!.runs[1]!.attempts[0]!;
  const failed = finishReported(h, review.agentPath!, "fail", "Review completed");
  const findings = finding ? ["P2 defect"] : [];
  h.messages.get(review.agentPath!)!.text = `Review completed\n\n\`\`\`json\n${JSON.stringify({ status: "fail", findings })}\n\`\`\``;
  await tickPipelines([failed], h.ports); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.verdict!.findings).toEqual(findings);
  let fix = loadPipelines()[0]!.runs[2]!.attempts[0]!;
  expect(fix.accounting!.repeatReason).toBeNull();
  if (interrupted) {
    h.setConversationActive(false);
    const killAt = h.ports.now();
    h.ports.conversationHostUnavailableSince = async () => killAt;
    h.ports.conversationOutOfMemory = async () => ({ at: killAt, limitBytes: 15 * 2 ** 30, limit: "agent", fatal: true, process: null });
    h.ports.memoryHeadroom = () => ({ availableBytes: 20 * 2 ** 30, requiredBytes: 15 * 2 ** 30 });
    await tickPipelines([], h.ports);
    const attempts = loadPipelines()[0]!.runs[2]!.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.accounting!.repeatReason).toBe("unknown");
    h.ports.conversationHostUnavailableSince = async () => null;
    h.ports.conversationOutOfMemory = async () => null;
    h.advanceWallClock(60_001); h.setConversationActive(true);
    await tickPipelines([], h.ports); await tickPipelines([], h.ports);
    fix = loadPipelines()[0]!.runs[2]!.attempts[1]!;
    expect(fix.state).toBe("running");
  }
  await tickPipelines([finishReported(h, fix.agentPath!, "pass", "fixed")], h.ports);
  await tickPipelines([], h.ports);
  const attempts = loadPipelines()[0]!.runs[1]!.attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.accounting!.repeatReason).toBe(finding ? "review-finding" : "unknown");
});

test("automatic retry after provider quota retains its known account-limit reason", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(parked.providerWait?.stageRetry).toBeDefined();
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/fixture", transcriptRoot: "/fixture/sessions", env: { NODE_ENV: "test" } } });
  f.advance(210000);
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  const attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.accounting!.repeatReason).toBe("account-limit");
});
