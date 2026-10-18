import { recordSeatDeployment, seatDeploymentsFor } from "@/lib/orchestrator/seatDeployments";
import { expect, test, fs, path, SANDBOX, harness, childFixture, childRig, runSeatTickCheck, NOW, MINUTE, PROJECT, CONVERSATION, OVERDUE, terminalEvent, spawn, SeatTickAccounting, defaultSeatTickSettings, writeSeatTickState, emptySeatTickState } from "./seatTickController.fixture";
import { readLivenessTranscriptEvidence } from "@/lib/lifecycle/transcript";
import { agentLivenessSnapshot } from "@/lib/lifecycle/liveness";
import type { AgentLivenessSources } from "@/lib/lifecycle/liveness";

const FROM = new Date(NOW - 13 * 60 * MINUTE).toISOString();
const AT = new Date(NOW - 8 * 60 * MINUTE).toISOString();
const lanes = Array.from({ length: 35 }, (_, index) => ({ id: `outage-lane-${String(index).padStart(3, "0")}`, state: "completed", src: CONVERSATION,
  createdAt: FROM, movedAt: new Date(Date.parse(AT) + index * MINUTE).toISOString() }));

function recoveryRig(over: Parameters<typeof harness>[0] = {}) {
  const rig = harness({ pipelines: lanes, state: { ...OVERDUE, unreachableSince: FROM,
    reportsOwed: [{ key: "lane:earlier:completed", label: "earlier outcome", receivedAt: FROM }] }, ...over });
  rig.deps.sources!.reports = { log: () => [], enabled: () => true, operatorLocale: () => "uk" };
  return rig;
}

test("one catch-up carries all 35 held outcomes and original times, then owes one report", async () => {
  const rig = recoveryRig();
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  expect(result?.deferred).toBe(0);
  expect(rig.sent).toHaveLength(1);
  const text = rig.sent[0]!.text;
  expect(text).toContain(`unreachable window ${FROM} through ${new Date(NOW).toISOString()}`);
  for (const lane of lanes) { expect(text).toContain(lane.id); expect(text).toContain(lane.movedAt); }
  expect(text).not.toContain("held back for the next wake");
  const row = rig.deps.readState!(PROJECT);
  expect(row.announcedLanes).toHaveLength(35);
  expect(row.reportsOwed).toEqual([{ key: `catch-up:7:${FROM}`, label: `catch-up ${FROM} through ${new Date(NOW).toISOString()}`, receivedAt: new Date(NOW).toISOString() }]);
  expect(row.unreachableSince).toBeNull();
  const next = recoveryRig({ stateFile: row.accounting!.filename.replace(/\.sqlite$/, "") });
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent).toHaveLength(0);
});

test("a refused catch-up credits nothing and the same catch-up key survives a fresh controller", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "catch-up-retry-")), "state.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, unreachableSince: FROM }, stateFile);
  const first = recoveryRig({ stateFile, delivery: { ok: false, outcome: "failed", status: 503, error: "host unavailable", admission: "refused" } });
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.deps.readState!(PROJECT).announcedLanes ?? []).toHaveLength(0);
  expect(first.deps.readState!(PROJECT).unreachableSince).toBe(FROM);
  const second = recoveryRig({ stateFile, now: NOW + 10 * MINUTE, wakeState: "dropped" });
  await runSeatTickCheck(PROJECT, second.deps);
  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]!.text).toContain(`key catch-up:7:${FROM}`);
  expect(second.deps.readState!(PROJECT).announcedLanes).toHaveLength(35);
});

test.each([true, false])("native completed tail without opening boundary reaches tick admission (completed: %s)", async completed => {
  const f = childFixture("native-completed-tail", false, "off");
  const at = new Date(NOW - 13 * 60 * MINUTE).toISOString();
  // More than the native tail budget, with no retained opening prompt.
  const padding = Array.from({ length: 1000 }, () => JSON.stringify({ type: "progress", timestamp: at, data: "x".repeat(1000) })).join("\n");
  const record = { type: "assistant", timestamp: at, message: { role: "assistant", model: "fixture", stop_reason: completed ? "end_turn" : null, content: [{ type: "text", text: "finished" }] } };
  fs.writeFileSync(f.seat.path!, `${padding}\n${JSON.stringify(record)}\n`);
  f.registry.upsert({ key: { engine: "claude", sessionId: path.basename(f.seat.path!, ".jsonl") }, artifactPath: f.seat.path!, cwd: f.cwd,
    accountId: null, status: "dead", host: null, structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null });
  f.seed({ unreachableSince: at, lastWakeAt: FROM, lastProposalAt: AT });
  const evidence = (await readLivenessTranscriptEvidence("claude", f.seat.path!))!;
  if (evidence.nativeTail?.integrity !== "complete") throw new Error("native tail unreadable");
  expect(evidence.nativeTail.prefixTruncated).toBe(true);
  const deploymentId = `native-tail-${completed ? "completed" : "open"}`;
  // This durable attribution is what deploy_exact_sha persists before returning
  // wakeOnSettle:true. A replacement tick reads it after succession.
  recordSeatDeployment({ conversationId: f.seat.conversationId, deploymentId, project: f.project, revision: "a".repeat(40), requestedAt: at });
  const rig = childRig(f, { now: NOW,
    deployments: { [deploymentId]: { phase: "succeeded", terminal: true, revision: "a".repeat(40) } } });
  rig.deps.sources!.seatDeployments = seatDeploymentsFor;
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "predecessor MCP ended at succession" });
  const livenessSources: AgentLivenessSources = {
    now: () => NOW, pipelines: () => [], flows: () => [], listFiles: async () => [],
    registrySnapshot: () => f.registry.readOnlySnapshot(),
    describeTranscript: async () => ({ path: f.seat.path!, engine: "claude", project: f.project, title: "seat", mtimeMs: Date.parse(at), sizeBytes: fs.statSync(f.seat.path!).size, conversationId: f.seat.conversationId, activity: "idle", activityReason: "fixture" }),
    transcriptEvidence: readLivenessTranscriptEvidence,
    probe: { now: () => NOW, pidAlive: () => false, processIdentity: () => null },
  };
  rig.deps.sources!.liveness = async request => (await agentLivenessSnapshot(request, livenessSources)).conversations;
  const result = await runSeatTickCheck(f.project, rig.deps);
  if (completed) {
    expect(rig.sent).toHaveLength(1);
    expect(evidence.activityFacts!.turnBoundaryVerified).toBe(true);
    expect(result?.reasons).toContain("deploy-settled");
    expect(f.row().announcedDeploys).toEqual([deploymentId]);
    await runSeatTickCheck(f.project, rig.deps);
    expect(rig.sent).toHaveLength(1);
  } else {
    expect(rig.sent).toHaveLength(0);
    expect(evidence.activityFacts!.turnBoundaryVerified).toBe(false);
    expect(result?.delivery?.outcome).toBe("seat-mcp-unavailable");
    expect(f.row().announcedDeploys ?? []).toHaveLength(0);
  }
});

test("catch-up crosses the event page boundary and leaves later events for later wakes", async () => {
  const events = Array.from({ length: 225 }, (_, i) => ({ ...terminalEvent(i + 1), type: "pipeline_merged" as const,
    pipelineId: `merged-${i + 1}`, at: new Date(Date.parse(AT) + i * 1000).toISOString(), summary: `merged outcome ${i + 1}` }));
  const rig = recoveryRig({ pipelines: [], events, state: { ...OVERDUE, eventsThrough: 0, unreachableSince: FROM } });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  for (const event of events) { expect(rig.sent[0]!.text).toContain(event.pipelineId); expect(rig.sent[0]!.text).toContain(event.at); }
  expect(rig.deps.readState!(PROJECT).eventsThrough).toBe(225);
  const after = { ...terminalEvent(226), type: "pipeline_merged" as const, pipelineId: "after-recovery", at: new Date(NOW + 61 * MINUTE).toISOString() };
  const next = recoveryRig({ pipelines: [], stateFile: rig.deps.readState!(PROJECT).accounting!.filename.replace(/\.sqlite$/, ""),
    events: [...events, after], now: NOW + 61 * MINUTE });
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(next.sent[0]!.text).toContain("after-recovery");
  expect(next.sent[0]!.text).not.toContain("merged-225");
  expect(next.sent[0]!.text).not.toContain("unreachable window");
});

test("a landed catch-up stays acknowledged after a real process restart", async () => {
  const directory = fs.mkdtempSync(path.join(SANDBOX, "catch-up-process-"));
  const stateFile = path.join(directory, "tick.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, unreachableSince: FROM }, stateFile);
  const script = path.join(directory, "restart.test.ts");
  const resultFile = path.join(directory, "result.json");
  fs.writeFileSync(script, `import { test } from "bun:test";
    const { harness, runSeatTickCheck, PROJECT, NOW } = await import(${JSON.stringify(path.join(import.meta.dir, "seatTickController.fixture.ts"))});
    test("restart", async () => {
      const rig = harness({ stateFile: ${JSON.stringify(stateFile)}, pipelines: ${JSON.stringify(lanes)}, now: NOW });
      rig.deps.sources.reports = { log: () => [], enabled: () => true, operatorLocale: () => "uk" };
      await runSeatTickCheck(PROJECT, rig.deps);
      await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ sent: rig.sent.length, state: rig.deps.readState(PROJECT) }));
    });`);
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["test", script], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(output)));
  });
  await run();
  expect(JSON.parse(fs.readFileSync(resultFile, "utf8")).sent).toBe(1);
  await run();
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  expect(result.sent).toBe(0);
  expect(result.state.reportsOwed).toHaveLength(1);
  expect(result.state.reportsOwed[0].key).toBe(`catch-up:7:${FROM}`);
  expect(result.state.announcedLanes).toHaveLength(35);
});

test("one catch-up crosses the ready-child page and projection limits", async () => {
  const Clock = Date;
  globalThis.Date = new Proxy(Clock, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
    get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
  });
  const f = childFixture("catch-up-ready-pages");
  const children = Array.from({ length: 70 }, (_, i) => f.spawn({ title: `held worker ${i}`, turn: "terminal", terminalAt: AT }));
  f.seed({ lastWakeAt: FROM, lastProposalAt: AT });
  const collect = childRig(f, { settings: { ...defaultSeatTickSettings(f.project), enabled: false } });
  for (let pass = 0; pass < 10; pass++) await runSeatTickCheck(f.project, collect.deps);
  expect(collect.sent).toHaveLength(0);
  const accounting = new SeatTickAccounting(f.row().accounting!.filename, f.project);
  expect(accounting.ready(100)).toHaveLength(70);
  writeSeatTickState(f.project, { ...f.row(), unreachableSince: FROM }, f.stateFile);
  const rig = childRig(f);
  await runSeatTickCheck(f.project, rig.deps);
  expect(rig.sent).toHaveLength(1);
  for (const child of children) expect(rig.sent[0]!.text).toContain(child.id);
  expect(f.acknowledged()).toHaveLength(70);
  await runSeatTickCheck(f.project, rig.deps);
  expect(rig.sent).toHaveLength(1);
}, 60_000);

test("a legacy dead-seat row catches up its entire pre-upgrade delivery gap", async () => {
  const rig = recoveryRig({ state: { ...OVERDUE, lastWakeAt: FROM },
    seatActivity: { conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", host: { state: "gone", kind: "structured", pid: null } } });
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "predecessor MCP unavailable" });
  expect(rig.deps.readState!(PROJECT).unreachableSince ?? null).toBeNull();
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  for (const lane of lanes) expect(rig.sent[0]!.text).toContain(lane.id);
  expect(rig.sent[0]!.text).toContain("host loss may have occurred later");
  expect(rig.deps.readState!(PROJECT).announcedLanes).toHaveLength(35);
});
