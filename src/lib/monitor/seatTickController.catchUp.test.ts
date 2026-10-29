import { seatTickWakeCommit } from "./seatTick";
import { recordSeatDeployment, seatDeploymentsFor } from "@/lib/orchestrator/seatDeployments";
import { expect, test, fs, path, SANDBOX, harness, childFixture, childRig, runSeatTickCheck, NOW, MINUTE, PROJECT, CONVERSATION, OVERDUE, outstandingWake, terminalEvent, spawn, SeatTickAccounting, FileRuntimeEventStore, statePath, defaultSeatTickSettings, writeSeatTickState, emptySeatTickState, hostedSeat, realTransport, reportPort, setAgentRegistryForTests, emptyLaunchProfile } from "./seatTickController.fixture";
import { readLivenessTranscriptEvidence } from "@/lib/lifecycle/transcript";
import { agentLivenessSnapshot } from "@/lib/lifecycle/liveness";
import type { AgentLivenessSources } from "@/lib/lifecycle/liveness";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

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
  expect(text).toContain(`backlog window ${FROM} through ${new Date(NOW).toISOString()}`);
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

test.each(["completed", "open", "split-open"] as const)("native tail without opening boundary reaches tick admission safely (%s)", async scenario => {
  const f = childFixture("native-completed-tail", false, "off");
  const at = new Date(NOW - 13 * 60 * MINUTE).toISOString();
  // More than the native tail budget, with no retained opening prompt.
  const padding = Array.from({ length: 1000 }, () => JSON.stringify({ type: "progress", timestamp: at, data: "x".repeat(1000) })).join("\n");
  const records = scenario === "split-open"
    ? [
      { type: "assistant", timestamp: at, apiBlockIndex: 0, message: { id: "msg-split", role: "assistant", model: "fixture", stop_reason: "end_turn", content: [{ type: "tool_use", id: "toolu-open", name: "Read", input: { file_path: "src/example.ts" } }] } },
      { type: "assistant", timestamp: at, apiBlockIndex: 1, message: { id: "msg-split", role: "assistant", model: "fixture", stop_reason: "end_turn", content: [{ type: "text", text: "finished" }] } },
    ]
    : [{ type: "assistant", timestamp: at, message: { role: "assistant", model: "fixture", stop_reason: scenario === "completed" ? "end_turn" : null, content: [{ type: "text", text: "finished" }] } }];
  fs.writeFileSync(f.seat.path!, `${padding}\n${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  f.registry.upsert({ key: { engine: "claude", sessionId: path.basename(f.seat.path!, ".jsonl") }, artifactPath: f.seat.path!, cwd: f.cwd,
    accountId: null, status: "dead", host: null, structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null });
  f.seed({ unreachableSince: at, lastWakeAt: FROM, lastProposalAt: AT });
  const evidence = (await readLivenessTranscriptEvidence("claude", f.seat.path!))!;
  if (evidence.nativeTail?.integrity !== "complete") throw new Error("native tail unreadable");
  expect(evidence.nativeTail.prefixTruncated).toBe(true);
  const completed = scenario === "completed";
  const deploymentId = `native-tail-${scenario}`;
  // This durable attribution is what deploy_exact_sha persists before returning
  // wakeOnSettle:true. A replacement tick reads it after succession.
  await recordSeatDeployment({ conversationId: f.seat.conversationId, deploymentId, project: f.project, revision: "a".repeat(40), requestedAt: at });
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
  expect(next.sent[0]!.text).not.toContain("backlog window");
});

test("500 UUID outcomes and a mixed lane manifest fit transport and credit only after delivery", async () => {
  const f = childFixture("catch-up-real-transport");
  const from = new Date(f.now - 13 * 60 * MINUTE).toISOString();
  const pipelineId = (value: number) => ["00000000", "0000", "4000", "8000", String(value).padStart(12, "0")].join("-");
  const events = Array.from({ length: 500 }, (_, i) => ({ ...terminalEvent(i + 1), project: PROJECT, type: "pipeline_merged" as const,
    pipelineId: pipelineId(i + 1), at: new Date(f.now - 12 * 60 * MINUTE + i * 1000).toISOString(), summary: `merged outcome ${i + 1} — ${"я界🙂".repeat(45)}` }));
  const lane = { id: pipelineId(501), state: "completed", src: f.seat.conversationId,
    createdAt: from, movedAt: new Date(f.now - 11 * 60 * MINUTE).toISOString() };
  const priorReport = { key: "lane:prior:completed", label: "earlier outcome", receivedAt: from };
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, lastCheckAt: from, lastWakeAt: from,
    lastProposalAt: AT, unreachableSince: from, eventsThrough: 0, reportsOwed: [priorReport], accounting: undefined }, f.stateFile);
  setAgentRegistryForTests(f.registry);
  await f.registry.prepareRecoveryIndexes();
  const hosted = hostedSeat(f);
  const rig = harness({ seat: f.seat, registry: f.registry, stateFile: f.stateFile, now: f.now, events, pipelines: [lane],
    realWakeState: true, journal: { client: hosted.client },
    deliverWith: realTransport(f, hosted.client) });
  rig.deps.sources!.reports = reportPort(() => []);
  expect(rig.deps.readState!(PROJECT).unreachableSince).toBe(from);
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record?.delivery?.outcome).toBe("queued");
  expect(rig.sent).toHaveLength(1);
  const text = rig.sent[0]!.text;
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES);
  expect(text).toContain(`backlog window ${from} through ${new Date(f.now).toISOString()}`);
  expect(text).toContain(`manifest catch-up:7:${from}`);
  expect(text).toContain(`key catch-up:7:${from}`);
  const base = Date.parse(events[0]!.at);
  expect(text).toContain(`milliseconds relative to ${new Date(base).toISOString()}`);
  for (const event of events) {
    expect(text).toContain(event.pipelineId);
    expect(text).toContain(`+${Date.parse(event.at) - base}ms`);
  }
  expect(text).toContain(lane.id);
  expect(text).toContain(`+${Date.parse(lane.movedAt) - base}ms`);
  expect(rig.deps.readState!(PROJECT).eventsThrough).toBe(0);
  expect(rig.deps.readState!(PROJECT).announcedLanes ?? []).toHaveLength(0);
  expect(rig.deps.readState!(PROJECT).reportsOwed).toEqual([priorReport]);
  expect(rig.deps.readState!(PROJECT).unreachableSince).toBe(from);
  const queued = rig.deps.readState!(PROJECT).outstandingWake!;
  expect(queued.operationId).toBeTruthy();
  hosted.journal.transitionOperation(queued.operationId!, "delivered");
  expect(await rig.deps.sources!.wakeState(queued)).toMatchObject({ state: "landed" });
  const credited = await runSeatTickCheck(PROJECT, rig.deps);
  const row = rig.deps.readState!(PROJECT);
  expect({ eventsThrough: row.eventsThrough, result: credited, journal: rig.journal.slice(-2) }).toMatchObject({ eventsThrough: 500 });
  expect(row.itemsShown).toHaveLength(501);
  expect(row.announcedLanes).toEqual([`${lane.id}:completed`]);
  expect(row.reportsOwed?.map(report => report.key)).toEqual([`catch-up:7:${from}`]);
  expect(row.unreachableSince).toBeNull();
  const later = harness({ seat: f.seat, registry: f.registry, stateFile: f.stateFile, now: f.now + 61 * MINUTE,
    events, pipelines: [lane], realWakeState: true, journal: { client: hosted.client },
    deliverWith: realTransport(f, hosted.client) });
  await runSeatTickCheck(PROJECT, later.deps);
  expect(later.sent.every(message => !message.text.includes("manifest catch-up:7:")
    && !message.text.includes(lane.id) && !message.text.includes(events[0]!.pipelineId))).toBe(true);
});

test("a landed catch-up stays acknowledged after a real process restart", async () => {
  const directory = fs.mkdtempSync(path.join(SANDBOX, "catch-up-process-"));
  const stateFile = path.join(directory, "tick.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, unreachableSince: new Date(NOW).toISOString(), unreachableBacklogSince: FROM }, stateFile);
  const script = path.join(directory, "restart.test.ts");
  const resultFile = path.join(directory, "result.json");
  fs.writeFileSync(script, `import { test } from "bun:test";
    const { harness, runSeatTickCheck, PROJECT, NOW } = await import(${JSON.stringify(path.join(import.meta.dir, "seatTickController.fixture.ts"))});
    test("restart", async () => {
      const rig = harness({ stateFile: ${JSON.stringify(stateFile)}, pipelines: ${JSON.stringify(lanes)}, now: NOW });
      rig.deps.sources.reports = { log: () => [], enabled: () => true, operatorLocale: () => "uk" };
      const before = rig.deps.readState(PROJECT);
      await runSeatTickCheck(PROJECT, rig.deps);
      await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ sent: rig.sent.length, before, state: rig.deps.readState(PROJECT) }));
    });`);
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["test", script], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(output)));
  });
  await run();
  const first = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  expect(first.sent).toBe(1);
  expect(first.before.unreachableSince).toBe(new Date(NOW).toISOString());
  expect(first.before.unreachableBacklogSince).toBe(FROM);
  expect(first.state.unreachableSince).toBeNull();
  expect(first.state.unreachableBacklogSince).toBeNull();
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
  for (let pass = 0; pass < 5 && rig.sent.length === 0; pass++) await runSeatTickCheck(f.project, rig.deps);
  expect(rig.sent).toHaveLength(1);
  for (const child of children) expect(rig.sent[0]!.text).toContain(child.id);
  expect(f.acknowledged()).toHaveLength(70);
  const later = childRig(f, { now: NOW + 61 * MINUTE });
  await runSeatTickCheck(f.project, later.deps);
  expect(later.sent).toHaveLength(0);
}, 60_000);

test("one child ledger gap cannot release a partial catch-up while other snapshot tickets remain", async () => {
  const Clock = Date;
  globalThis.Date = new Proxy(Clock, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
    get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
  });
  const f = childFixture("catch-up-cold-ledgers");
  const children = Array.from({ length: 70 }, (_, i) => {
    const child = f.spawn({ title: `cold held worker ${String(i).padStart(2, "0")}`, turn: "busy" });
    const generation = f.registry.conversation(child.id as never)!.generations[0]!.id;
    const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
    const offset = i === 0 ? 1 : 0;
    ledger.append(generation, { kind: "turn-started", turnId: `first-${i}`, seq: 1 + offset });
    ledger.append(generation, { kind: "turn-ended", turnId: `first-${i}`, status: "completed", seq: 2 + offset });
    ledger.append(generation, { kind: "turn-started", turnId: `second-${i}`, seq: 3 + offset });
    ledger.append(generation, { kind: "turn-ended", turnId: `second-${i}`, status: "completed", seq: 4 + offset });
    f.registry.reconcileConversations([{
      engine: "claude", path: child.path, accountId: null,
      launchProfile: emptyLaunchProfile({ title: `cold held worker ${String(i).padStart(2, "0")}`, cwd: f.cwd }),
      turn: { state: "terminal", source: "assistant", terminalAt: AT }, observedAt: AT,
    }]);
    return child;
  });
  f.seed({ lastCheckAt: FROM, lastWakeAt: FROM, lastProposalAt: AT, unreachableSince: FROM });
  const rig = childRig(f);
  let deliveredAt = 0;
  let persistedPollCutoff: number | null = null;
  for (let pass = 0; pass < 20 && rig.sent.length === 0; pass++) {
    const result = await runSeatTickCheck(f.project, rig.deps);
    if (result?.delivery?.outcome === "delivered") deliveredAt = pass + 1;
    persistedPollCutoff = new SeatTickAccounting(f.row().accounting!.filename, f.project).row()?.catchUpPollThrough ?? persistedPollCutoff;
  }
  expect(deliveredAt).toBeGreaterThan(1);
  expect(persistedPollCutoff).not.toBeNull();
  expect(rig.sent).toHaveLength(1);
  const text = rig.sent[0]!.text;
  expect(text).toContain(`Catch-up manifest catch-up:7:${FROM}`);
  for (const child of children) expect(text).toContain(child.id);
  const accounting = new SeatTickAccounting(f.row().accounting!.filename, f.project);
  const acknowledged = accounting.collection.snapshot().flatMap(row => row.kind === "outcome" && row.status === "acknowledged" ? [row] : []);
  expect(acknowledged).toHaveLength(140);
  expect(acknowledged.filter(row => row.tuple.some(value => value.startsWith("second-")))).toHaveLength(70);
  expect(deliveredAt).toBeGreaterThan(5);
  expect(f.row().unreachableSince).toBeNull();
  const later = childRig(f, { now: NOW + 61 * MINUTE });
  await runSeatTickCheck(f.project, later.deps);
  expect(later.sent).toHaveLength(1);
  expect(later.sent[0]!.text).not.toContain("first-");
  expect(later.sent[0]!.text).not.toContain("second-");
  expect(later.sent[0]!.text).not.toContain(`Catch-up manifest catch-up:7:${FROM}`);
}, 60_000);

test.each(["dead", "healthy"] as const)("a legacy dead-seat row catches up its entire pre-upgrade backlog window with %s MCP", async health => {
  const rig = recoveryRig({ state: { ...OVERDUE, lastWakeAt: FROM },
    seatActivity: { conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", host: { state: "gone", kind: "structured", pid: null } } });
  rig.deps.mcpHealth = () => ({ status: health, detail: "independent MCP health" });
  expect(rig.deps.readState!(PROJECT).unreachableSince ?? null).toBeNull();
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  for (const lane of lanes) expect(rig.sent[0]!.text).toContain(lane.id);
  expect(rig.sent[0]!.text).toContain(`backlog window ${FROM} through ${new Date(NOW).toISOString()}`);
  expect(rig.deps.readState!(PROJECT).announcedLanes).toHaveLength(35);
  const observed = rig.written.find(row => row.unreachableSince);
  expect(observed?.unreachableSince).toBe(new Date(NOW).toISOString());
  expect(observed?.unreachableBacklogSince).toBe(FROM);
  expect(rig.deps.readState!(PROJECT).unreachableBacklogSince).toBeNull();
  const next = recoveryRig({ pipelines: lanes, stateFile: rig.deps.readState!(PROJECT).accounting!.filename.replace(/\.sqlite$/, ""),
    now: NOW + 5 * MINUTE });
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent).toHaveLength(0);
});

test("an old frozen wake landing after the outage preserves one fresh catch-up", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "delayed-old-wake-")), "state.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, unreachableSince: FROM,
    outstandingWake: outstandingWake({ text: "old frozen wake", preparedAt: FROM }) }, stateFile);
  const first = recoveryRig({ stateFile, wakeState: "landed" });
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.sent).toHaveLength(0);
  expect(first.deps.readState!(PROJECT).unreachableSince).toBe(FROM);
  const next = recoveryRig({ stateFile, now: NOW + 61 * MINUTE });
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent).toHaveLength(1);
  for (const lane of lanes) expect(next.sent[0]!.text).toContain(lane.id);
  expect(next.deps.readState!(PROJECT).reportsOwed).toHaveLength(1);
  expect(next.deps.readState!(PROJECT).unreachableSince).toBeNull();
});

test("an ordinary wake received within the interval closes its gap even if confirmation arrives later", () => {
  const receivedAt = new Date(Date.parse(FROM) + 5 * MINUTE).toISOString();
  const state = seatTickWakeCommit({ ...emptySeatTickState(), unreachableSince: FROM }, {
    proposal: false, reasons: ["interval"], fingerprint: "received-quickly", eventsThrough: 0, children: [], wakeIntervalMs: 60 * MINUTE,
  }, NOW, receivedAt);
  expect(state.lastWakeAt).toBe(receivedAt);
  expect(state.unreachableSince).toBeNull();
});

test.each(["idle", "busy"] as const)("MCP failure with a live %s host never opens a backlog window", async turn => {
  const rig = recoveryRig({ pipelines: [], turn, state: { ...OVERDUE, lastWakeAt: FROM },
    seatActivity: { conversationId: CONVERSATION, lifecycle: turn === "idle" ? "waiting" : "running",
      reason: "host_alive_turn_active", host: { state: "alive", kind: "structured", pid: 123 } } });
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "MCP pipe unavailable" });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.deps.readState!(PROJECT).unreachableSince ?? null).toBeNull();
  expect(rig.sent).toHaveLength(0);
  expect(rig.cards.some(row => row.card.kind === "mcp-unavailable")).toBe(true);
});

test.each(["queued", "delivering", "pending", "held", "refused", "unreturned"] as const)("%s delivery keeps its fence without opening an outage", async delivery => {
  const rig = recoveryRig({ pipelines: lanes.slice(0, 1), state: { ...OVERDUE, lastWakeAt: FROM },
    deliveryThrows: delivery === "unreturned",
    delivery: delivery === "refused" ? { ok: false, outcome: "failed", status: 409, error: "busy", admission: "refused" }
      : { ok: true, target: null, outcome: delivery, operationId: "pending-wake" } as never });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  const row = rig.deps.readState!(PROJECT);
  expect(row.unreachableSince ?? null).toBeNull();
  expect(row.announcedLanes ?? []).toHaveLength(0);
  expect(row.outstandingWake).not.toBeNull();
  const next = recoveryRig({ pipelines: lanes.slice(0, 1), stateFile: row.accounting!.filename.replace(/\.sqlite$/, ""),
    now: NOW + 5 * MINUTE, wakeState: "retained" });
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent).toHaveLength(0);
  expect(next.deps.readState!(PROJECT).unreachableSince ?? null).toBeNull();
});

test.each(["absent", "unreadable", "foreign", "unverified", "rotated", "replaced"] as const)("%s host evidence cannot open an outage", async scenario => {
  const rig = recoveryRig({ pipelines: [], turn: "busy", state: { ...OVERDUE, lastWakeAt: FROM } });
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "MCP unavailable" });
  let generation = 0;
  const registry = rig.deps.sources!.registry;
  rig.deps.sources!.registry = () => ({ ...registry(), seatMcpReceipt: () => ({ generation }) }) as never;
  rig.deps.sources!.liveness = async () => {
    if (scenario === "unreadable") throw new Error("probe unavailable");
    if (scenario === "absent") return [];
    if (scenario === "rotated") rig.seat = { conversationId: CONVERSATION, seatEpoch: 8, path: null };
    if (scenario === "replaced") generation++;
    return [{ conversationId: scenario === "foreign" ? "other-seat" : CONVERSATION,
      lifecycle: "gone", reason: scenario === "unverified" ? "host_gone_turn_unverified" : "host_gone_turn_settled",
      host: { state: "gone", kind: "structured", pid: null } }] as never;
  };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written.every(row => !row.unreachableSince)).toBe(true);
  expect(rig.sent.every(message => !message.text.includes("Catch-up manifest"))).toBe(true);
});

test("a recent host-loss observation retains an older backlog across a normal landing", () => {
  const observedAt = new Date(NOW).toISOString();
  const row = seatTickWakeCommit({ ...emptySeatTickState(), unreachableSince: observedAt, unreachableBacklogSince: FROM }, {
    proposal: false, reasons: [], fingerprint: "old", eventsThrough: 0, children: [], wakeIntervalMs: 60 * MINUTE,
  }, NOW + MINUTE);
  expect(row.unreachableSince).toBe(observedAt);
  expect(row.unreachableBacklogSince).toBe(FROM);
});

test("quiet idle host probe reads only its designated registry rows", async () => {
  let unrelatedEntryReads = 0;
  const f = childFixture("idle-keyed-host-probe", false, "sqlite", (collection, count) => {
    if (collection === "entries") unrelatedEntryReads += count;
  });
  f.seed({ lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString(), lastProposalAt: new Date(NOW - MINUTE).toISOString() });
  for (let index = 0; index < 160; index += 1) {
    f.registry.upsert({ key: { engine: "claude", sessionId: `unrelated-${index}` },
      artifactPath: path.join(f.dir, `unrelated-${index}.jsonl`), cwd: f.cwd, accountId: null,
      status: "dead", host: null, structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null });
  }
  setAgentRegistryForTests(f.registry);
  const rig = childRig(f);
  const production = (await import("./seatTickSources")).defaultSeatTickSources();
  rig.deps.sources!.liveness = production.liveness;
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "MCP unavailable" });
  unrelatedEntryReads = 0;

  await runSeatTickCheck(f.project, rig.deps);

  expect(unrelatedEntryReads).toBeLessThanOrEqual(2);
  expect(rig.sent).toHaveLength(0);
  expect(f.row().unreachableSince ?? null).toBeNull();
});

test("targeted production liveness keeps a live alternate owner of the seat transcript", async () => {
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  let unrelatedEntryReads = 0;
  const f = childFixture("idle-alternate-transcript-owner", false, "sqlite", (collection, count) => {
    if (collection === "entries") unrelatedEntryReads += count;
  });
  f.seed({ lastWakeAt: new Date(f.now - 5 * MINUTE).toISOString(), lastProposalAt: new Date(f.now - MINUTE).toISOString() });
  const conversation = f.registry.conversation(f.seat.conversationId as never)!;
  const generation = conversation.generations.at(-1)!;
  const resumedPath = path.join(f.dir, `resumed-${path.basename(f.seat.path!)}`);
  f.registry.reconcileConversations([{ engine: "claude", path: resumedPath, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.cwd }), turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: new Date(f.now).toISOString() }]);
  const resumed = f.registry.conversation(f.seat.conversationId as never)!;
  expect(resumed.continuityPaths).toContain(f.seat.path!);
  const currentGeneration = resumed.generations.at(-1)!;
  f.registry.upsert({ key: { engine: "claude", sessionId: currentGeneration.id }, artifactPath: resumedPath, cwd: f.cwd,
    accountId: null, status: "dead", host: null, structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null });
  const owner = captureProcessIdentity(process.pid);
  f.registry.upsert({ key: { engine: "claude", sessionId: "alternate-live-seat-owner" }, artifactPath: resumedPath, cwd: f.cwd,
    accountId: null, status: "idle", host: null,
    structuredHost: { kind: "claude-broker", endpoint: "stdio:fixture", process: owner, eventCursor: 1,
      protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: null, pendingAction: null });
  const selected = f.registry.livenessConversationSnapshot(f.seat.conversationId);
  expect(selected.entries["claude:alternate-live-seat-owner"]?.artifactPath).toBe(resumedPath);
  expect(selected.entries[`claude:${currentGeneration.id}`]?.artifactPath).toBe(resumedPath);
  for (let index = 0; index < 160; index += 1) {
    f.registry.upsert({ key: { engine: "claude", sessionId: `unrelated-owner-${index}` },
      artifactPath: path.join(f.dir, `unrelated-owner-${index}.jsonl`), cwd: f.cwd, accountId: null,
      status: "dead", host: null, structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null });
  }
  const rig = childRig(f);
  const { productionLivenessSources } = await import("@/lib/lifecycle/liveness");
  const production = productionLivenessSources();
  const liveness = await agentLivenessSnapshot({ conversationId: f.seat.conversationId }, {
    ...production,
    registrySnapshot: () => f.registry.readOnlySnapshot(),
    registrySnapshotForConversation: id => f.registry.livenessConversationSnapshot(id),
    describeTranscript: async transcriptPath => ({ path: transcriptPath, project: f.project, title: "seat", engine: "claude",
      mtimeMs: f.now - MINUTE, sizeBytes: 0, conversationId: f.seat.conversationId, activity: "idle", activityReason: "fixture" }),
    transcriptEvidence: async () => ({ turn: "idle", lastRecordTs: f.now - MINUTE, providerProgressAt: null }),
    probe: { now: () => f.now, pidAlive: pid => pid === owner.pid, processIdentity: pid => pid === owner.pid ? owner.startIdentity : null },
    listFiles: async () => [], pipelines: () => [], flows: () => [],
  });
  rig.deps.sources!.liveness = async () => liveness.conversations;
  rig.deps.mcpHealth = () => ({ status: "healthy", detail: "fixture" });
  unrelatedEntryReads = 0;

  await runSeatTickCheck(f.project, rig.deps);

  expect(liveness.conversations[0]).toMatchObject({ lifecycle: "waiting", reason: "host_alive_turn_idle", host: { state: "alive" } });
  expect(unrelatedEntryReads).toBeLessThanOrEqual(2);
  expect(f.row().unreachableSince ?? null).toBeNull();
  expect(rig.sent.every(message => !message.text.includes("Catch-up manifest"))).toBe(true);
});

test("oversized catch-up pages resume their durable cursor and owe a report only after the final landing", async () => {
  const many = Array.from({ length: 600 }, (_, index) => ({ ...lanes[0]!,
    id: `lane-${String(index).padStart(4, "0")}-${"x".repeat(60)}`,
    movedAt: new Date(Date.parse(AT) + index * 1000).toISOString(),
  }));
  const first = recoveryRig({ pipelines: many });
  const firstResult = await runSeatTickCheck(PROJECT, first.deps);
  expect(firstResult?.verdict).toBe("wake");
  expect(firstResult!.deferred).toBeGreaterThan(0);
  expect(first.sent).toHaveLength(1);
  expect(Buffer.byteLength(first.sent[0]!.text)).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES - 2_000);
  let row = first.deps.readState!(PROJECT);
  expect(row.catchUpProgress?.after).toBeTruthy();
  expect(row.unreachableSince).toBe(FROM);
  expect(row.reportsOwed?.some(entry => entry.key.startsWith("catch-up:"))).toBe(false);
  const file = `${row.accounting!.filename.slice(0, -7)}`;
  const agendaText = (text: string) => text.split("\nItems:\n")[1]!.split("\nWhy you were woken:")[0]!;
  const seen = new Set(many.filter(lane => agendaText(first.sent[0]!.text).includes(lane.id)).map(lane => lane.id));
  expect(row.announcedLanes).toHaveLength(seen.size);
  for (let page = 1; page < 10 && row.catchUpProgress; page++) {
    // Every page is read by a fresh process, including the persisted cursor
    // and snapshot that keep page identity stable across a release change.
    const directory = path.dirname(file);
    const script = path.join(directory, `page-${page}.test.ts`), resultFile = path.join(directory, `page-${page}.json`);
    fs.writeFileSync(script, `import { test } from "bun:test";
      const { harness, runSeatTickCheck, PROJECT } = await import(${JSON.stringify(path.join(import.meta.dir, "seatTickController.fixture.ts"))});
      test("resume page", async () => {
        const rig = harness({ stateFile: ${JSON.stringify(file)}, pipelines: ${JSON.stringify(many)}, now: ${NOW + page * 61 * MINUTE} });
        rig.deps.sources.reports = { log: () => [], enabled: () => true, operatorLocale: () => "uk" };
        await runSeatTickCheck(PROJECT, rig.deps);
        await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ sent: rig.sent, row: rig.deps.readState(PROJECT) }));
      });`);
    const child = spawn(process.execPath, ["test", script], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-16_000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-16_000); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try { expect({ code: await exited, output }).toMatchObject({ code: 0 }); }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await exited; }
    const next = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    expect(next.sent).toHaveLength(1);
    const text = next.sent[0]!.text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES - 2_000);
    for (const lane of many.filter(lane => agendaText(text).includes(lane.id))) {
      expect(seen.has(lane.id)).toBe(false);
      seen.add(lane.id);
    }
    row = next.row;
  }
  expect(seen.size).toBe(600);
  expect(row.catchUpProgress).toBeNull();
  expect(row.unreachableSince).toBeNull();
  expect(row.reportsOwed?.filter(entry => entry.key.startsWith("catch-up:"))).toEqual([
    { key: `catch-up:7:${FROM}`, label: `catch-up ${FROM} through ${new Date(NOW).toISOString()}`, receivedAt: row.lastWakeAt! },
  ]);
});


const pagedLanes = () => Array.from({ length: 600 }, (_, index) => ({ ...lanes[0]!,
  id: `pending-lane-${String(index).padStart(4, "0")}-${"x".repeat(60)}`,
  movedAt: new Date(Date.parse(AT) + index * 1000).toISOString(),
}));

test("a priority deployment preserves unfinished catch-up until the remaining pages land", async () => {
  const many = pagedLanes();
  const first = recoveryRig({ pipelines: many });
  await runSeatTickCheck(PROJECT, first.deps);
  const before = first.deps.readState!(PROJECT);
  expect(before.catchUpProgress?.after).toBeTruthy();
  const file = before.accounting!.filename.slice(0, -7);
  const deploymentId = "priority-during-catch-up";
  const deploy = recoveryRig({ stateFile: file, pipelines: many, now: NOW + MINUTE,
    seatDeployments: [{ conversationId: CONVERSATION, deploymentId }],
    deployments: { [deploymentId]: { phase: "succeeded", terminal: true, revision: "a".repeat(40) } } });
  await runSeatTickCheck(PROJECT, deploy.deps);
  expect(deploy.sent).toHaveLength(1);
  expect(deploy.sent[0]!.text).toContain(deploymentId);
  const afterDeploy = deploy.deps.readState!(PROJECT);
  expect(afterDeploy.catchUpProgress).toEqual(before.catchUpProgress);
  expect(afterDeploy.unreachableSince).toBe(FROM);
  expect(afterDeploy.announcedLanes).toEqual(before.announcedLanes);
  expect(afterDeploy.announcedDeploys).toEqual([deploymentId]);
  expect(afterDeploy.reportsOwed?.some(entry => entry.key === before.catchUpProgress!.key)).toBe(false);
  let row = afterDeploy;
  for (let page = 1; page <= 4 && row.catchUpProgress; page++) {
    const next = recoveryRig({ stateFile: file, pipelines: many, now: NOW + page * 61 * MINUTE });
    await runSeatTickCheck(PROJECT, next.deps);
    expect(next.sent).toHaveLength(1);
    row = next.deps.readState!(PROJECT);
  }
  expect(row.announcedLanes).toHaveLength(many.length);
  expect(row.catchUpProgress).toBeNull();
  expect(row.unreachableSince).toBeNull();
  expect(row.reportsOwed?.filter(entry => entry.key === before.catchUpProgress!.key)).toHaveLength(1);
});

test.each(["delivered", "refused", "unreadable"] as const)("an empty remaining agenda completes catch-up only after a readable landing (%s)", async outcome => {
  const first = recoveryRig({ pipelines: pagedLanes(), state: { ...OVERDUE, unreachableSince: FROM } });
  await runSeatTickCheck(PROJECT, first.deps);
  const before = first.deps.readState!(PROJECT);
  expect(before.catchUpProgress?.after).toBeTruthy();
  const file = before.accounting!.filename.slice(0, -7);
  const final = recoveryRig({ stateFile: file, pipelines: [], now: NOW + 61 * MINUTE,
    ...(outcome === "refused" ? { delivery: { ok: false, outcome: "failed", status: 503, error: "host unavailable", admission: "refused" } as const } : {}),
  });
  if (outcome === "unreadable") final.deps.sources!.tasks = () => { throw new Error("remaining agenda unavailable"); };
  const result = await runSeatTickCheck(PROJECT, final.deps);
  if (outcome === "unreadable") {
    expect(result?.verdict).toBe("error");
    expect(final.sent).toHaveLength(0);
  } else {
    expect(result?.verdict).toBe("wake");
    expect(final.sent).toHaveLength(1);
  }
  const row = final.deps.readState!(PROJECT);
  if (outcome !== "delivered") {
    expect(row.catchUpProgress).toEqual(before.catchUpProgress);
    if (outcome === "refused") expect(row.outstandingWake?.commit.catchUp?.key).toBe(before.catchUpProgress!.key);
    expect(row.unreachableSince).toBe(FROM);
    expect(row.reportsOwed?.some(entry => entry.key === before.catchUpProgress!.key)).toBe(false);
    const retry = recoveryRig({ stateFile: file, pipelines: [], now: NOW + 122 * MINUTE, wakeState: "dropped" });
    expect((await runSeatTickCheck(PROJECT, retry.deps))?.verdict).toBe("wake");
    expect(retry.sent).toHaveLength(1);
  }
  const completed = final.deps.readState!(PROJECT);
  expect(completed.catchUpProgress).toBeNull();
  expect(completed.unreachableSince).toBeNull();
  expect(completed.reportsOwed?.filter(entry => entry.key === before.catchUpProgress!.key)).toHaveLength(1);
  const next = recoveryRig({ stateFile: file, pipelines: [], now: Date.parse(completed.lastWakeAt!) + MINUTE });
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent).toHaveLength(0);
  expect(next.deps.readState!(PROJECT).reportsOwed).toEqual(completed.reportsOwed);
});


test.each(["failure", "admission", "timeout"] as const)("an unreadable worker-ask agenda preserves partial catch-up through %s and recovery", async failure => {
  for (const knownWork of [false, true]) {
    const asks = Array.from({ length: 600 }, (_, index) => ({ key: `ask-${String(index).padStart(4, "0")}-${"k".repeat(100)}`,
      id: `worker-${String(index).padStart(4, "0")}-${"w".repeat(100)}`, label: `waiting worker ${index}`, sinceMs: Date.parse(FROM) + index }));
    const first = recoveryRig({ pipelines: [], state: { ...OVERDUE, unreachableSince: FROM } });
    first.deps.sources!.workerAsks = async () => asks;
    await runSeatTickCheck(PROJECT, first.deps);
    const before = first.deps.readState!(PROJECT);
    expect(before.catchUpProgress?.after).toBeTruthy();
    const file = before.accounting!.filename.slice(0, -7);
    const failed = recoveryRig({ stateFile: file, pipelines: knownWork ? [{ ...lanes[0]!, id: "known-outcome",
      movedAt: new Date(NOW + 60 * MINUTE).toISOString() }] : [], now: NOW + 61 * MINUTE });
    let clock = 0;
    failed.deps.workBudgetMs = 800;
    failed.deps.workClock = () => clock;
    failed.deps.sources!.workerAsks = async () => {
      if (failure === "admission") {
        const { StateLockDeferredError } = await import("@/lib/state/lockWait");
        throw new StateLockDeferredError("fixture.worker-asks");
      }
      if (failure === "timeout") { clock += 101; return asks; }
      throw new Error("fixture worker asks unreadable");
    };
    await runSeatTickCheck(PROJECT, failed.deps);
    const afterFailure = failed.deps.readState!(PROJECT);
    expect(afterFailure.catchUpProgress).toEqual(before.catchUpProgress);
    expect(afterFailure.unreachableSince).toBe(FROM);
    expect(afterFailure.reportsOwed?.some(report => report.key === before.catchUpProgress!.key)).toBe(false);
    expect(failed.sent).toHaveLength(knownWork ? 1 : 0);
    if (knownWork) {
      expect(failed.sent[0]!.text).toContain("known-outcome");
      expect(afterFailure.announcedLanes).toContain("known-outcome:completed");
    }
    let row = afterFailure;
    const messages = [...first.sent, ...failed.sent];
    for (let page = 1; page <= 8 && row.catchUpProgress; page++) {
      const next = recoveryRig({ stateFile: file, pipelines: [], now: NOW + (page + 1) * 61 * MINUTE });
      next.deps.sources!.workerAsks = async () => asks;
      await runSeatTickCheck(PROJECT, next.deps);
      messages.push(...next.sent);
      row = next.deps.readState!(PROJECT);
    }
    expect(row.catchUpProgress).toBeNull();
    expect(row.unreachableSince).toBeNull();
    expect(row.reportsOwed?.filter(report => report.key === before.catchUpProgress!.key)).toHaveLength(1);
    for (const ask of asks) expect(messages.filter(message => message.text.includes(ask.id))).toHaveLength(1);
  }
});
